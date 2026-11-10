// Package s3 is the smallest SigV4 S3 client the sync extension needs:
// ListObjectsV2, PutObject and ranged GetObject. It never opens a connection;
// it signs the request and the host's backup.sync service performs the HTTPS
// transfer (D-1086 in the host repository).
package s3

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FormatVersion is the object metadata version the host has always written.
const FormatVersion = 1

// Config is one user-configured bucket. AccessKeyID and SecretAccessKey are
// never logged and never leave this process except inside a signature.
type Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// Validate rejects values that could escape the intended bucket prefix.
func (c Config) Validate() error {
	if strings.TrimSpace(c.Bucket) == "" {
		return errors.New("S3 Bucket 不能为空")
	}
	if strings.ContainsAny(c.Bucket, "/\\") {
		return errors.New("S3 Bucket 不能包含路径分隔符")
	}
	if strings.TrimSpace(c.AccessKeyID) == "" || strings.TrimSpace(c.SecretAccessKey) == "" {
		return errors.New("S3 Access Key 与 Secret 不能为空")
	}
	prefix := strings.Trim(strings.TrimSpace(c.Prefix), "/")
	if strings.Contains(prefix, "..") || strings.ContainsAny(prefix, "\\\x00") {
		return errors.New("S3 前缀不能包含路径穿越或控制字符")
	}
	if _, err := c.endpoint(); err != nil {
		return err
	}
	return nil
}

func (c Config) endpoint() (*url.URL, error) {
	raw := strings.TrimSpace(c.Endpoint)
	if raw == "" {
		raw = "https://s3." + strings.TrimSpace(c.Region) + ".amazonaws.com"
		if strings.TrimSpace(c.Region) == "" {
			raw = "https://s3.amazonaws.com"
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("S3 Endpoint 必须是 https URL")
	}
	return u, nil
}

// ObjectURL is the signed target for one object name. The bucket and prefix
// stay path segments, never host labels, so a custom endpoint works unchanged.
func (c Config) ObjectURL(name string) (*url.URL, error) {
	u, err := c.endpoint()
	if err != nil {
		return nil, err
	}
	u.Path = joinURLPath(u.Path, c.Bucket, c.objectKey(name))
	u.RawPath = sigV4Path(u.Path)
	u.RawQuery = ""
	return u, nil
}

// joinURLPath builds an absolute path under the endpoint's own base path. The
// leading slash is part of the canonical URI, so an endpoint without a path
// must still yield "/bucket/key".
func joinURLPath(base string, segments ...string) string {
	parts := append([]string{"/"}, strings.Split(strings.Trim(base, "/"), "/")...)
	parts = append(parts, segments...)
	return path.Join(parts...)
}

// objectKey is the same key shape the host engine wrote before 0.30.0, so a
// rollback still finds these objects under the configured prefix.
func (c Config) objectKey(name string) string {
	name = path.Base(strings.TrimSpace(name))
	if name == "." || name == "/" || name == "" {
		name = "mypaste-backup.mypaste-sync"
	}
	prefix := strings.Trim(strings.TrimSpace(c.Prefix), "/")
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}

// ListURL is ListObjectsV2 under the configured prefix.
func (c Config) ListURL(maxKeys int, continuation string) (*url.URL, error) {
	u, err := c.endpoint()
	if err != nil {
		return nil, err
	}
	u.Path = joinURLPath(u.Path, c.Bucket)
	u.RawPath = sigV4Path(u.Path)
	query := u.Query()
	query.Set("list-type", "2")
	query.Set("max-keys", strconv.Itoa(maxKeys))
	if prefix := strings.Trim(strings.TrimSpace(c.Prefix), "/"); prefix != "" {
		query.Set("prefix", prefix+"/")
	}
	if continuation != "" {
		query.Set("continuation-token", continuation)
	}
	u.RawQuery = canonicalQuery(query)
	return u, nil
}

// ObjectName is deterministic per archive while preserving the local
// basename, exactly like the host's old engine, so a rollback can still find
// objects written here.
func ObjectName(localName string, now time.Time) string {
	base := path.Base(filepath.ToSlash(localName))
	if base == "." || base == "/" || base == "" {
		base = "mypaste-backup"
	}
	return now.UTC().Format("20060102-150405") + "-" + base + ".mypaste-sync"
}

// Signer signs requests with a fixed clock in tests.
type Signer struct {
	Now func() time.Time
}

// Sign installs Host, X-Amz-Date, X-Amz-Content-Sha256 and Authorization on
// req. The body digest is the caller's, so a PUT signs the bytes it will send.
func (s *Signer) Sign(req *http.Request, config Config, payloadHash string) {
	now := time.Now
	if s != nil && s.Now != nil {
		now = s.Now
	}
	current := now()
	amzDate := current.Format("20060102T150405Z")
	date := current.Format("20060102")
	req.Header.Set("Host", req.URL.Host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if config.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", config.SessionToken)
	}
	canonical := canonicalRequest(req, payloadHash)
	// Authorization is not part of the signature, so the list is fixed here
	// before that header exists.
	signedHeaders := signedHeaderNames(req)
	scope := date + "/" + regionOrUS(config.Region) + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" +
		sha256Hex([]byte(canonical))
	key := hmacSHA256([]byte("AWS4"+config.SecretAccessKey), date)
	key = hmacSHA256(key, regionOrUS(config.Region))
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+config.AccessKeyID+"/"+
		scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

// Headers returns the signed request headers without Host, which the host
// owns. The map is what backup.sync accepts and signs.
func Headers(req *http.Request) map[string]string {
	out := make(map[string]string, len(req.Header))
	for name, values := range req.Header {
		if strings.EqualFold(name, "host") || len(values) == 0 {
			continue
		}
		out[name] = strings.Join(values, ",")
	}
	return out
}

// PayloadHash is the hex SHA-256 of a request body. An empty body uses the
// well-known empty digest.
func PayloadHash(body []byte) string { return sha256Hex(body) }

// EmptyPayloadHash is the digest of no body.
const EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// ListEntry is one object from ListObjectsV2.
type ListEntry struct {
	Key          string    `xml:"Key"`
	Size         int64     `xml:"Size"`
	LastModified time.Time `xml:"LastModified"`
}

type listResult struct {
	IsTruncated           bool        `xml:"IsTruncated"`
	NextContinuationToken string      `xml:"NextContinuationToken"`
	Contents              []ListEntry `xml:"Contents"`
}

// ParseList decodes one ListObjectsV2 response body.
func ParseList(body []byte) ([]ListEntry, string, error) {
	var result listResult
	decoder := xml.NewDecoder(strings.NewReader(string(body)))
	if err := decoder.Decode(&result); err != nil {
		return nil, "", errors.New("S3 列表响应无法解析")
	}
	if !result.IsTruncated {
		return result.Contents, "", nil
	}
	return result.Contents, result.NextContinuationToken, nil
}

// Latest picks the newest object. A zero LastModified (an endpoint that omits
// it) falls back to the timestamp prefix in the key, which the host's naming
// guarantees.
func Latest(entries []ListEntry) (ListEntry, bool) {
	if len(entries) == 0 {
		return ListEntry{}, false
	}
	best := entries[0]
	for _, entry := range entries[1:] {
		if newer(entry, best) {
			best = entry
		}
	}
	return best, true
}

func newer(a, b ListEntry) bool {
	if !a.LastModified.IsZero() && !b.LastModified.IsZero() &&
		!a.LastModified.Equal(b.LastModified) {
		return a.LastModified.After(b.LastModified)
	}
	return a.Key > b.Key
}

func canonicalRequest(req *http.Request, payloadHash string) string {
	names := signedHeaderList(req)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(strings.TrimSpace(req.Header.Get(name)))
		canonicalHeaders.WriteByte('\n')
	}
	return req.Method + "\n" + canonicalURI(req.URL) + "\n" +
		canonicalQuery(req.URL.Query()) + "\n" + canonicalHeaders.String() + "\n" +
		strings.Join(names, ";") + "\n" + payloadHash
}

func canonicalURI(u *url.URL) string {
	if u == nil {
		return "/"
	}
	escaped := u.EscapedPath()
	if escaped == "" {
		return "/"
	}
	return escaped
}

// canonicalQuery encodes parameters the way SigV4 expects: percent-encoded
// names and values, sorted by encoded name then value.
func canonicalQuery(values url.Values) string {
	type pair struct{ name, value string }
	pairs := make([]pair, 0, len(values))
	for name, items := range values {
		encoded := sigV4Escape(name)
		for _, item := range items {
			pairs = append(pairs, pair{encoded, sigV4Escape(item)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].name == pairs[j].name {
			return pairs[i].value < pairs[j].value
		}
		return pairs[i].name < pairs[j].name
	})
	var out strings.Builder
	for index, item := range pairs {
		if index > 0 {
			out.WriteByte('&')
		}
		out.WriteString(item.name)
		out.WriteByte('=')
		out.WriteString(item.value)
	}
	return out.String()
}

func sigV4Escape(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

// sigV4Path URI-encodes a path for SigV4: only unreserved bytes and the
// segment separator stay literal. The caller installs the result as
// url.RawPath, so the bytes on the wire and the canonical URI agree.
func sigV4Path(value string) string {
	const hexDigits = "0123456789ABCDEF"
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch {
		case 'A' <= character && character <= 'Z',
			'a' <= character && character <= 'z',
			'0' <= character && character <= '9',
			character == '-', character == '_', character == '.',
			character == '~', character == '/':
			out.WriteByte(character)
		default:
			out.WriteByte('%')
			out.WriteByte(hexDigits[character>>4])
			out.WriteByte(hexDigits[character&0x0f])
		}
	}
	return out.String()
}

func signedHeaderList(req *http.Request) []string {
	names := make([]string, 0, len(req.Header)+1)
	for name := range req.Header {
		names = append(names, strings.ToLower(name))
	}
	if !containsFold(names, "host") {
		names = append(names, "host")
	}
	sort.Strings(names)
	return names
}

func signedHeaderNames(req *http.Request) string {
	return strings.Join(signedHeaderList(req), ";")
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(value, needle) {
			return true
		}
	}
	return false
}

func regionOrUS(region string) string {
	if strings.TrimSpace(region) == "" {
		return "us-east-1"
	}
	return strings.TrimSpace(region)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

// StatusError turns a non-2xx status into a readable sentence without the
// response body, which could contain an endpoint's diagnostic output.
func StatusError(action string, status int) error {
	detail := ""
	switch status {
	case 401, 403:
		detail = "，请检查 Access Key、Secret、区域与系统时钟"
	case 404:
		detail = "，Bucket 或远端对象不存在"
	case 409:
		detail = "，远端对象已存在"
	case 416:
		detail = "，远端不接受该分段范围"
	}
	return fmt.Errorf("%s失败：HTTP %d%s", action, status, detail)
}
