package linkmime

import (
	"errors"
	"strings"
	"testing"
)

func detect(t *testing.T, text string) Result {
	t.Helper()
	result, err := Detect(text)
	if err != nil {
		t.Fatalf("Detect(%q) failed: %v", text, err)
	}
	if result.Schema != SchemaVersion {
		t.Fatalf("Detect(%q).Schema = %d", text, result.Schema)
	}
	if result.Label == "" || result.Category == "" || result.CategoryLabel == "" {
		t.Fatalf("Detect(%q) is missing a label or category: %#v", text, result)
	}
	if result.Confidence != ConfidenceHigh && result.Confidence != ConfidenceMedium &&
		result.Confidence != ConfidenceLow {
		t.Fatalf("Detect(%q).Confidence = %q", text, result.Confidence)
	}
	if len(result.Evidence) == 0 {
		t.Fatalf("Detect(%q) names no evidence", text)
	}
	for _, evidence := range result.Evidence {
		if evidence.Kind == "" || evidence.Detail == "" {
			t.Fatalf("Detect(%q) has an incomplete evidence: %#v", text, evidence)
		}
	}
	return result
}

func expect(t *testing.T, text, mime, source, confidence string) Result {
	t.Helper()
	result := detect(t, text)
	if result.MIME != mime || result.Source != source || result.Confidence != confidence {
		t.Fatalf("Detect(%q) = {mime:%q source:%q confidence:%q}, want {%q %q %q} (%#v)",
			text, result.MIME, result.Source, result.Confidence,
			mime, source, confidence, result.Evidence)
	}
	return result
}

func TestDetectReadsThePathExtension(t *testing.T) {
	result := expect(t, "https://example.com/media/photo.PNG", "image/png", SourceExtension, ConfidenceHigh)
	if result.Evidence[0].Value != ".png" || result.Label != "PNG 图像" {
		t.Fatalf("extension evidence = %#v", result.Evidence)
	}
	// A query or fragment is not part of the file name.
	expect(t, "https://example.com/a.pdf?token=1#page=2", "application/pdf", SourceExtension, ConfidenceHigh)
	// A dotfile counts as its extension.
	expect(t, "https://example.com/repo/.gitignore", "text/plain", SourceExtension, ConfidenceHigh)
	// A Unicode file name still ends in a plain extension.
	expect(t, "https://example.com/%E5%9B%BE%E7%89%87.png", "image/png", SourceExtension, ConfidenceHigh)
}

func TestDetectUsesKnownHostsOnlyWithoutAnExtension(t *testing.T) {
	result := expect(t, "https://youtu.be/dQw4w9WgXcQ", "video/mp4", SourceHost, ConfidenceMedium)
	if result.Host != "youtu.be" || result.CategoryLabel != "视频" {
		t.Fatalf("host result = %#v", result)
	}
	// A subdomain matches the suffix; a lookalike host does not.
	expect(t, "https://m.youtube.com/watch?v=x", "video/mp4", SourceHost, ConfidenceMedium)
	expect(t, "https://notyoutube.com/watch", "text/html", SourcePage, ConfidenceMedium)
	// An explicit extension is more specific than the host.
	expect(t, "https://raw.githubusercontent.com/u/r/main/a.py", "text/x-python", SourceExtension, ConfidenceHigh)
}

func TestDetectReadsDataURLs(t *testing.T) {
	result := expect(t, "data:image/png;base64,iVBORw0KGgo=", "image/png", SourceDataURL, ConfidenceHigh)
	if !strings.Contains(result.Evidence[0].Detail, "base64") {
		t.Fatalf("data evidence = %#v", result.Evidence)
	}
	expect(t, "data:,hello", "text/plain", SourceDataURL, ConfidenceHigh)
	expect(t, "DATA:application/pdf;base64,AAAA", "application/pdf", SourceDataURL, ConfidenceHigh)
	unknown := detect(t, "data:no-comma-here")
	if unknown.Source != SourceFallback || unknown.MIME != "" {
		t.Fatalf("malformed data URL = %#v", unknown)
	}
}

func TestDetectReadsSchemesThatCarryTheirOwnMeaning(t *testing.T) {
	expect(t, "mailto:someone@example.com", "message/rfc822", SourceScheme, ConfidenceMedium)
	expect(t, "magnet:?xt=urn:btih:abc", "application/x-bittorrent", SourceScheme, ConfidenceHigh)
	tel := expect(t, "tel:+8613800000000", "", SourceScheme, ConfidenceMedium)
	if tel.Label != "电话号码" {
		t.Fatalf("tel label = %q", tel.Label)
	}
	unknown := detect(t, "vscode://file/a.png")
	if unknown.MIME != "" || unknown.Category != "other" {
		t.Fatalf("unknown scheme = %#v", unknown)
	}
}

func TestDetectHandlesLinksWithoutAScheme(t *testing.T) {
	result := expect(t, "example.com/files/report.zip", "application/zip", SourceExtension, ConfidenceHigh)
	if result.Scheme != "https" || result.URL != "example.com/files/report.zip" {
		t.Fatalf("bare link = %#v", result)
	}
	// A host and port must not be read as a scheme.
	expect(t, "example.com:8080/a.txt", "text/plain", SourceExtension, ConfidenceHigh)
	result = detect(t, "example.com")
	if result.Scheme != "https" || result.Source != SourcePage {
		t.Fatalf("bare host = %#v", result)
	}
}

func TestDetectFallsBackToThePageDefault(t *testing.T) {
	result := expect(t, "https://example.com/download", "text/html", SourcePage, ConfidenceMedium)
	if result.Label != "网页" {
		t.Fatalf("page label = %q", result.Label)
	}
	// An unknown extension is named as evidence, then the page default wins.
	result = expect(t, "https://example.com/a.xyz", "text/html", SourcePage, ConfidenceMedium)
	if len(result.Evidence) < 2 || !strings.Contains(result.Evidence[0].Detail, ".xyz") {
		t.Fatalf("unknown extension evidence = %#v", result.Evidence)
	}
	// A non-web scheme with no extension is a binary download.
	expect(t, "ftp://example.com/download", "application/octet-stream", SourceFallback, ConfidenceLow)
	// A file URL keeps its extension.
	expect(t, "file:///Users/example/Movies/clip.mov", "video/quicktime", SourceExtension, ConfidenceHigh)
}

func TestDetectReadsQueryHintsWithLowConfidence(t *testing.T) {
	expect(t, "https://example.com/download?format=png", "image/png", SourceQuery, ConfidenceLow)
	expect(t, "https://example.com/get?filename=report.pdf", "application/pdf", SourceQuery, ConfidenceLow)
	expect(t, "https://example.com/render?type=image/webp", "image/webp", SourceQuery, ConfidenceLow)
}

func TestDetectKeepsAmbiguousExtensionsHonest(t *testing.T) {
	result := expect(t, "https://example.com/src/a.ts", "text/typescript", SourceExtension, ConfidenceMedium)
	if !strings.Contains(result.Evidence[0].Detail, "MPEG-2") {
		t.Fatalf(".ts evidence = %#v", result.Evidence)
	}
	expect(t, "https://example.com/deck.key", "application/vnd.apple.keynote", SourceExtension, ConfidenceHigh)
}

func TestDetectRefusesTextThatIsNotALink(t *testing.T) {
	for _, text := range []string{"hello world", "just some text", "/Users/example/a.png"} {
		result := detect(t, text)
		if result.Source != SourceFallback || result.MIME != "" || result.Label != "无法确定的链接" {
			t.Fatalf("Detect(%q) = %#v", text, result)
		}
	}
}

func TestDetectRefusesEmptyText(t *testing.T) {
	if _, err := Detect(" \n\t"); !errors.Is(err, ErrEmpty) {
		t.Fatalf("Detect(blank) error = %v", err)
	}
}

func TestTableIsConsistent(t *testing.T) {
	doc, err := loadTable()
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Types) < 80 || len(doc.Hosts) == 0 || len(doc.Schemes) == 0 {
		t.Fatalf("table is smaller than expected: %d types, %d hosts, %d schemes",
			len(doc.Types), len(doc.Hosts), len(doc.Schemes))
	}
	seen := map[string]bool{}
	for _, host := range doc.Hosts {
		if seen[host.Suffix] {
			t.Fatalf("duplicate host rule %q", host.Suffix)
		}
		seen[host.Suffix] = true
	}
	for name := range doc.CategoryLabels {
		if !categoryNames[name] {
			t.Fatalf("label for unknown category %q", name)
		}
	}
}

func TestExtensionOf(t *testing.T) {
	cases := map[string]string{
		"/a/b.PNG":      "png",
		"/a/.gitignore": "gitignore",
		"/a/b.tar.gz":   "gz",
		"/a/b":          "",
		"/a/":           "",
		"/a/b.c-d":      "",
		"/a/图片":         "",
	}
	for value, want := range cases {
		got, _ := extensionOf(value)
		if got != want {
			t.Fatalf("extensionOf(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestSplitSchemeDoesNotMistakeAHostForAScheme(t *testing.T) {
	cases := map[string]string{
		"https://example.com":        "https",
		"HTTPS://example.com":        "https",
		"example.com:8080/a":         "",
		"mailto:a@example.com":       "mailto",
		"data:image/png;base64,AAAA": "data",
		"no-colon-here":              "",
	}
	for value, want := range cases {
		got, _ := splitScheme(value)
		if got != want {
			t.Fatalf("splitScheme(%q) = %q, want %q", value, got, want)
		}
	}
}
