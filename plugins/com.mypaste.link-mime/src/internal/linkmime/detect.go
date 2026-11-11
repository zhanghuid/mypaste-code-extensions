// Package linkmime infers the content type of a link from the link itself.
//
// The inference is local and offline: it reads the URL scheme, the path
// extension, the host and a few query parameters, and it never contacts the
// server. The vocabulary it can produce — MIME types, labels, categories,
// known hosts and scheme rules — lives in mime-types.json, loaded once here;
// this file only owns the decision order.
package linkmime

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
)

// SchemaVersion is the version of the result document this package emits.
const SchemaVersion = 1

// Confidence words are the closed set every result carries. A page may map
// them to its own wording; an unknown value is a bug here, not a page choice.
const (
	ConfidenceHigh   = "high"
	ConfidenceMedium = "medium"
	ConfidenceLow    = "low"
)

// Sources are the closed set of reasons a result was chosen.
const (
	SourceDataURL   = "data-url"
	SourceExtension = "extension"
	SourceHost      = "host"
	SourceScheme    = "scheme"
	SourceQuery     = "query"
	SourcePage      = "page"
	SourceFallback  = "fallback"
)

// EvidenceKind is the closed set of evidence words a page may render.
const (
	EvidenceDataURL   = "data-url"
	EvidenceExtension = "extension"
	EvidenceHost      = "host"
	EvidenceScheme    = "scheme"
	EvidenceQuery     = "query"
	EvidencePath      = "path"
	EvidenceFallback  = "fallback"
)

// ErrEmpty is returned when the caller hands over no link text at all.
var ErrEmpty = errors.New("链接内容为空")

var categoryNames = map[string]bool{
	"image": true, "video": true, "audio": true, "text": true,
	"document": true, "archive": true, "font": true, "page": true,
	"email": true, "torrent": true, "other": true,
}

var (
	mimePattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`)
	bareHostPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#]|$)`)
	schemePattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*$`)
)

// Evidence is one reason the result names. Detail is a complete sentence the
// page can show as-is; Value is the token the rule matched.
type Evidence struct {
	Kind   string `json:"kind"`
	Value  string `json:"value,omitempty"`
	Detail string `json:"detail"`
}

// Result is the one document this package returns. The page reads it as
// JSON; every field is optional except schema, url, label, category,
// confidence, source and evidence.
type Result struct {
	Schema        int        `json:"schema"`
	URL           string     `json:"url"`
	Scheme        string     `json:"scheme,omitempty"`
	Host          string     `json:"host,omitempty"`
	Path          string     `json:"path,omitempty"`
	MIME          string     `json:"mime,omitempty"`
	Label         string     `json:"label"`
	Category      string     `json:"category"`
	CategoryLabel string     `json:"categoryLabel"`
	Confidence    string     `json:"confidence"`
	Source        string     `json:"source"`
	Evidence      []Evidence `json:"evidence"`
	Note          string     `json:"note"`
}

// typeRule is one row of the type table.
type typeRule struct {
	MIME       string `json:"mime"`
	Label      string `json:"label"`
	Category   string `json:"category"`
	Confidence string `json:"confidence,omitempty"`
	Note       string `json:"note,omitempty"`
}

// hostRule is one known-site row. It only applies when the path names no
// file extension, so a direct file URL on the same host keeps its own type.
type hostRule struct {
	Suffix string `json:"suffix"`
	typeRule
}

// document mirrors mime-types.json.
type document struct {
	Schema         int                 `json:"schema"`
	Note           string              `json:"note"`
	CategoryLabels map[string]string   `json:"categoryLabels"`
	Types          map[string]typeRule `json:"types"`
	Hosts          []hostRule          `json:"hosts"`
	Schemes        map[string]typeRule `json:"schemes"`
	QueryKeys      []string            `json:"queryKeys"`
	PageDefault    typeRule            `json:"pageDefault"`
	BinaryDefault  typeRule            `json:"binaryDefault"`
	Unknown        typeRule            `json:"unknown"`

	byMIME map[string]typeRule
}

//go:embed mime-types.json
var tableJSON []byte

var (
	tableOnce sync.Once
	table     *document
	tableErr  error
)

// table loads and validates the one type table. The returned document is
// shared and must be treated as read-only.
func loadTable() (*document, error) {
	tableOnce.Do(func() {
		var doc document
		if err := json.Unmarshal(tableJSON, &doc); err != nil {
			tableErr = fmt.Errorf("类型表不是有效 JSON：%w", err)
			return
		}
		if err := doc.validate(); err != nil {
			tableErr = err
			return
		}
		table = &doc
	})
	return table, tableErr
}

func (d *document) validate() error {
	if d.Schema != SchemaVersion {
		return fmt.Errorf("类型表 schema 为 %d，期望 %d", d.Schema, SchemaVersion)
	}
	if strings.TrimSpace(d.Note) == "" {
		return errors.New("类型表缺少 note")
	}
	for name, label := range d.CategoryLabels {
		if !categoryNames[name] || strings.TrimSpace(label) == "" {
			return fmt.Errorf("类型表的类别 %q 无效", name)
		}
	}
	if len(d.Types) == 0 {
		return errors.New("类型表没有类型")
	}
	for ext, rule := range d.Types {
		if ext == "" || ext != strings.ToLower(ext) || strings.HasPrefix(ext, ".") {
			return fmt.Errorf("类型表的扩展名 %q 必须是不带点的小写形式", ext)
		}
		if err := rule.validate("类型 " + ext); err != nil {
			return err
		}
	}
	for _, rule := range d.Hosts {
		if rule.Suffix == "" || rule.Suffix != strings.ToLower(rule.Suffix) {
			return fmt.Errorf("类型表的主机 %q 必须是小写后缀", rule.Suffix)
		}
		if rule.Confidence == "" {
			return fmt.Errorf("主机 %q 缺少置信度", rule.Suffix)
		}
		if err := rule.typeRule.validate("主机 " + rule.Suffix); err != nil {
			return err
		}
	}
	for name, rule := range d.Schemes {
		if name == "" || name != strings.ToLower(name) {
			return fmt.Errorf("类型表的协议 %q 必须是小写形式", name)
		}
		if err := rule.validate("协议 " + name); err != nil {
			return err
		}
	}
	if len(d.QueryKeys) == 0 {
		return errors.New("类型表没有查询参数键")
	}
	for name, rule := range map[string]typeRule{
		"pageDefault": d.PageDefault, "binaryDefault": d.BinaryDefault,
		"unknown": d.Unknown,
	} {
		if err := rule.validate(name); err != nil {
			return err
		}
	}
	d.byMIME = make(map[string]typeRule, len(d.Types))
	for _, rule := range d.Types {
		if _, exists := d.byMIME[rule.MIME]; !exists {
			d.byMIME[rule.MIME] = rule
		}
	}
	return nil
}

func (r typeRule) validate(owner string) error {
	if strings.TrimSpace(r.Label) == "" {
		return fmt.Errorf("%s 缺少 label", owner)
	}
	if !categoryNames[r.Category] {
		return fmt.Errorf("%s 的类别 %q 无效", owner, r.Category)
	}
	// An omitted confidence means "high" for a type row (an explicit
	// extension is a direct statement); a present one must be a word the page
	// knows.
	if r.Confidence != "" && r.Confidence != ConfidenceHigh &&
		r.Confidence != ConfidenceMedium && r.Confidence != ConfidenceLow {
		return fmt.Errorf("%s 的置信度 %q 无效", owner, r.Confidence)
	}
	if r.MIME != "" && !mimePattern.MatchString(r.MIME) {
		return fmt.Errorf("%s 的 MIME %q 无效", owner, r.MIME)
	}
	return nil
}

// Detect returns the inferred type for one link. It fails only when the input
// is empty or the embedded table is broken; a link it cannot understand is a
// successful result whose category is "other" and whose label says so.
func Detect(text string) (Result, error) {
	doc, err := loadTable()
	if err != nil {
		return Result{}, err
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return Result{}, ErrEmpty
	}
	result := Result{Schema: SchemaVersion, URL: raw, Note: doc.Note}

	scheme, _ := splitScheme(raw)
	switch scheme {
	case "data":
		return detectData(doc, raw, result), nil
	case "http", "https", "ftp", "file":
		result.Scheme = scheme
	case "":
		if !bareHostPattern.MatchString(raw) || !strings.Contains(firstSegment(raw), ".") {
			return unknown(doc, result, EvidenceFallback, "", "链接既没有协议，也不像主机名"), nil
		}
		result.Scheme = "https"
		result.Evidence = append(result.Evidence, Evidence{
			Kind: EvidenceScheme, Value: "https",
			Detail: "链接没有写协议，按 https 解析",
		})
	default:
		if rule, ok := doc.Schemes[scheme]; ok {
			return apply(doc, result, rule, SourceScheme, Evidence{
				Kind: EvidenceScheme, Value: scheme,
				Detail: "链接使用 " + scheme + ": 协议",
			}), nil
		}
		return unknown(doc, result, EvidenceScheme, scheme, "无法从链接协议判断资源类型"), nil
	}

	target := raw
	if scheme == "" {
		target = "https://" + raw
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return unknown(doc, result, EvidenceFallback, "", "链接无法解析为 URL"), nil
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if scheme != "file" && host == "" {
		return unknown(doc, result, EvidenceFallback, "", "链接缺少主机名"), nil
	}
	result.Host = host
	result.Path = parsed.Path

	ext, _ := extensionOf(parsed.Path)
	if ext != "" {
		if rule, ok := doc.Types[ext]; ok {
			return apply(doc, result, rule, SourceExtension, Evidence{
				Kind: EvidenceExtension, Value: "." + ext,
				Detail: "URL 路径的扩展名是 ." + ext,
			}), nil
		}
		result.Evidence = append(result.Evidence, Evidence{
			Kind: EvidenceExtension, Value: "." + ext,
			Detail: "扩展名 ." + ext + " 不在已知类型表中",
		})
	}

	if rule, ok := hostRuleFor(doc, host); ok {
		return apply(doc, result, rule, SourceHost, Evidence{
			Kind: EvidenceHost, Value: host,
			Detail: "已知站点 " + host + "；路径没有可识别的扩展名",
		}), nil
	}

	if rule, evidence, ok := queryRule(doc, parsed.Query()); ok {
		return apply(doc, result, rule, SourceQuery, evidence), nil
	}

	if result.Scheme == "http" || result.Scheme == "https" {
		return apply(doc, result, doc.PageDefault, SourcePage, Evidence{
			Kind: EvidencePath, Value: parsed.Path,
			Detail: "路径没有可识别的扩展名，Web 地址通常返回网页",
		}), nil
	}
	return apply(doc, result, doc.BinaryDefault, SourceFallback, Evidence{
		Kind: EvidenceFallback, Value: parsed.Path,
		Detail: "无法从路径判断类型",
	}), nil
}

// detectData reads the media type a data: URL declares about itself.
func detectData(doc *document, raw string, result Result) Result {
	result.Scheme = "data"
	header, _, found := strings.Cut(raw[len("data:"):], ",")
	if !found {
		return unknown(doc, result, EvidenceDataURL, "", "data: 链接缺少逗号分隔的内容")
	}
	parts := strings.Split(header, ";")
	media := strings.ToLower(strings.TrimSpace(parts[0]))
	base64 := false
	for _, part := range parts[1:] {
		if strings.EqualFold(strings.TrimSpace(part), "base64") {
			base64 = true
		}
	}
	if media == "" {
		media = "text/plain"
	}
	if !mimePattern.MatchString(media) {
		return unknown(doc, result, EvidenceDataURL, header, "data: 链接声明的媒体类型无效")
	}
	rule, ok := doc.byMIME[media]
	if !ok {
		rule = genericType(media)
	}
	detail := "data: 链接直接声明了媒体类型"
	if base64 {
		detail += "，内容是 base64 编码"
	}
	result.Evidence = append(result.Evidence, Evidence{
		Kind: EvidenceDataURL, Value: truncate(header, 80), Detail: detail,
	})
	return apply(doc, result, rule, SourceDataURL, Evidence{})
}

// apply writes one rule into the result. An empty evidence is ignored so a
// caller that already appended its own reason does not repeat it.
func apply(doc *document, result Result, rule typeRule, source string, evidence Evidence) Result {
	result.MIME = rule.MIME
	result.Label = rule.Label
	result.Category = rule.Category
	result.CategoryLabel = doc.CategoryLabels[rule.Category]
	if rule.Confidence != "" {
		result.Confidence = rule.Confidence
	} else {
		result.Confidence = ConfidenceHigh
	}
	result.Source = source
	if evidence.Detail != "" {
		if rule.Note != "" {
			evidence.Detail += "；" + rule.Note
		}
		result.Evidence = append(result.Evidence, evidence)
	}
	return result
}

func unknown(doc *document, result Result, kind, value, detail string) Result {
	result.MIME = doc.Unknown.MIME
	result.Label = doc.Unknown.Label
	result.Category = doc.Unknown.Category
	result.CategoryLabel = doc.CategoryLabels[doc.Unknown.Category]
	result.Confidence = doc.Unknown.Confidence
	result.Source = SourceFallback
	result.Evidence = append(result.Evidence, Evidence{
		Kind: kind, Value: value, Detail: detail,
	})
	return result
}

func hostRuleFor(doc *document, host string) (typeRule, bool) {
	if host == "" {
		return typeRule{}, false
	}
	for _, rule := range doc.Hosts {
		if host == rule.Suffix || strings.HasSuffix(host, "."+rule.Suffix) {
			return rule.typeRule, true
		}
	}
	return typeRule{}, false
}

// queryRule reads the few parameters that commonly name a format. It is the
// last guess before the page default and always carries low confidence.
func queryRule(doc *document, values url.Values) (typeRule, Evidence, bool) {
	for _, key := range doc.QueryKeys {
		value := strings.TrimSpace(values.Get(key))
		if value == "" {
			continue
		}
		lower := strings.ToLower(value)
		if key == "filename" {
			if ext, _ := extensionOf("/" + lower); ext != "" {
				if rule, ok := doc.Types[ext]; ok {
					return withLowConfidence(rule), Evidence{
						Kind: EvidenceQuery, Value: key + "=..." + "." + ext,
						Detail: "查询参数 " + key + " 的文件名以 ." + ext + " 结尾",
					}, true
				}
			}
			continue
		}
		if media, _, _ := strings.Cut(lower, ";"); strings.Contains(media, "/") &&
			mimePattern.MatchString(media) {
			rule, ok := doc.byMIME[media]
			if !ok {
				rule = genericType(media)
			}
			return withLowConfidence(rule), Evidence{
				Kind: EvidenceQuery, Value: key + "=" + media,
				Detail: "查询参数 " + key + " 声明了 " + media,
			}, true
		}
		if rule, ok := doc.Types[strings.TrimPrefix(lower, ".")]; ok {
			return withLowConfidence(rule), Evidence{
				Kind: EvidenceQuery, Value: key + "=" + value,
				Detail: "查询参数 " + key + " 指向 " + value + " 格式",
			}, true
		}
	}
	return typeRule{}, Evidence{}, false
}

func withLowConfidence(rule typeRule) typeRule {
	rule.Confidence = ConfidenceLow
	return rule
}

func genericType(media string) typeRule {
	category := "other"
	top, _, _ := strings.Cut(media, "/")
	switch top {
	case "image":
		category = "image"
	case "video":
		category = "video"
	case "audio":
		category = "audio"
	case "text":
		category = "text"
	case "font":
		category = "font"
	case "message":
		category = "email"
	}
	return typeRule{
		MIME: media, Label: media, Category: category,
		Confidence: ConfidenceLow,
	}
}

// splitScheme returns a lowercase scheme only when the prefix really is one:
// a dotted first label such as `example.com:8080` is a host and port, not a
// scheme, so schemes with dots are deliberately not recognized.
func splitScheme(raw string) (string, string) {
	index := strings.Index(raw, ":")
	if index <= 0 {
		return "", raw
	}
	scheme := raw[:index]
	if !schemePattern.MatchString(scheme) || strings.Contains(scheme, ".") {
		return "", raw
	}
	return strings.ToLower(scheme), raw[index+1:]
}

// extensionOf returns the lowercase extension of the last path segment,
// without its dot. A dotfile such as `.gitignore` counts as an extension.
func extensionOf(value string) (string, string) {
	base := path.Base(value)
	if base == "/" || base == "." || base == "" {
		return "", base
	}
	ext := ""
	if strings.HasPrefix(base, ".") && !strings.Contains(base[1:], ".") {
		ext = base[1:]
	} else if index := strings.LastIndex(base, "."); index >= 0 {
		ext = base[index+1:]
	}
	ext = strings.ToLower(ext)
	if ext == "" || len(ext) > 12 {
		return "", base
	}
	for _, r := range ext {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return "", base
		}
	}
	return ext, base
}

func firstSegment(raw string) string {
	if index := strings.IndexAny(raw, "/?#"); index >= 0 {
		return raw[:index]
	}
	return raw
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
