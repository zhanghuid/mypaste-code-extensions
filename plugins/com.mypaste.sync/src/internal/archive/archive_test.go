package archive

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/hook"
)

type fakeAsset struct {
	data []byte
	kind string
}

// fakeClient answers the builder's calls from a local database and a small
// in-memory asset table, converting values exactly the way data.read does.
type fakeClient struct {
	db     *sql.DB
	assets map[int64]fakeAsset
	begun  bool
}

func (f *fakeClient) Begin(context.Context) error { f.begun = true; return nil }
func (f *fakeClient) End(context.Context, bool) error {
	f.begun = false
	return nil
}

func (f *fakeClient) Query(ctx context.Context, statement string, params []any, limit int) ([][]any, []string, bool, error) {
	rows, err := f.db.QueryContext(ctx, statement, params...)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, false, err
	}
	out := make([][]any, 0)
	for rows.Next() {
		cells := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range cells {
			pointers[index] = &cells[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, false, err
		}
		for index, cell := range cells {
			switch typed := cell.(type) {
			case int64:
				cells[index] = json.Number(strconv.FormatInt(typed, 10))
			case float64:
				cells[index] = json.Number(strconv.FormatFloat(typed, 'g', -1, 64))
			case []byte:
				cells[index] = map[string]string{
					"base64": base64.StdEncoding.EncodeToString(typed),
				}
			}
		}
		out = append(out, cells)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	return out, columns, false, nil
}

func (f *fakeClient) AssetInfo(_ context.Context, entryID int64) (hook.AssetInfo, error) {
	asset, ok := f.assets[entryID]
	if !ok {
		return hook.AssetInfo{}, sql.ErrNoRows
	}
	return hook.AssetInfo{Kind: asset.kind, MIME: "image/png", Bytes: int64(len(asset.data))}, nil
}

func (f *fakeClient) AssetChunk(_ context.Context, entryID, offset, length int64) ([]byte, bool, error) {
	asset := f.assets[entryID].data
	if offset >= int64(len(asset)) {
		return nil, true, nil
	}
	end := offset + length
	if end > int64(len(asset)) {
		end = int64(len(asset))
	}
	return append([]byte(nil), asset[offset:end]...), end == int64(len(asset)), nil
}

const testSchema = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations (version) VALUES (7);
CREATE TABLE clipboard_items (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL DEFAULT '',
	form TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	preview TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL DEFAULT '',
	html TEXT NOT NULL DEFAULT '',
	file_path TEXT NOT NULL DEFAULT '',
	image_path TEXT NOT NULL DEFAULT '',
	color TEXT NOT NULL DEFAULT '',
	source_app TEXT NOT NULL DEFAULT '',
	content_key TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL DEFAULT 0,
	pinned INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER
);
CREATE TABLE pinboards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '');
CREATE TABLE saved_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '');
CREATE TABLE ignore_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL DEFAULT '');
CREATE TABLE source_retention_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT '');
CREATE TABLE source_pause_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT '');
CREATE TABLE extension_enabled (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
CREATE INDEX clipboard_items_created ON clipboard_items (created_at);
CREATE VIEW pinned_items AS SELECT id FROM clipboard_items WHERE pinned = 1;
CREATE TRIGGER clipboard_items_touch AFTER INSERT ON clipboard_items BEGIN
	UPDATE clipboard_items SET color = new.color WHERE id = new.id AND 0;
END;
INSERT INTO clipboard_items (form, title, text, image_path) VALUES
	('image', 'first', '', '/Users/someone/Library/Application Support/MyPaste-Go/v2/assets/a.png'),
	('text', 'second', 'hello', '');
INSERT INTO pinboards (name) VALUES ('board');
INSERT INTO extension_enabled (plugin_id, enabled) VALUES ('com.mypaste.code-edit', 1);
`

func newFakeClient(t *testing.T) *fakeClient {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(testSchema); err != nil {
		t.Fatal(err)
	}
	return &fakeClient{
		db: db,
		assets: map[int64]fakeAsset{
			1: {data: []byte("\x89PNG\r\n\x1a\nimage-bytes"), kind: "image"},
		},
	}
}

func TestBuildWritesHostCompatibleArchive(t *testing.T) {
	client := newFakeClient(t)
	defer client.db.Close()
	builder := &Builder{
		Client:     client,
		AppVersion: "0.30.0",
		Now: func() time.Time {
			return time.Date(2026, time.November, 10, 9, 8, 7, 0, time.UTC)
		},
	}
	dir := t.TempDir()
	info, err := builder.Build(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if client.begun {
		t.Fatal("snapshot ended without being closed")
	}
	if info.Items != 2 || info.Assets != 1 {
		t.Fatalf("info: %+v", info)
	}
	if !info.Created.Equal(time.Date(2026, time.November, 10, 9, 8, 7, 0, time.UTC)) {
		t.Fatalf("created: %s", info.Created)
	}
	if info.Bytes <= 0 {
		t.Fatalf("bytes: %d", info.Bytes)
	}

	reader, err := zip.OpenReader(info.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	names := map[string]*zip.File{}
	for _, file := range reader.File {
		names[file.Name] = file
	}
	for _, name := range []string{"manifest.json", "mypaste.db", "assets/a.png"} {
		if names[name] == nil {
			t.Fatalf("archive lacks %q: %v", name, names)
		}
	}
	if len(names) != 3 {
		t.Fatalf("unexpected archive members: %d", len(names))
	}

	var manifest Manifest
	decodeZipJSON(t, names["manifest.json"], &manifest)
	if manifest.FormatVersion != 1 || manifest.SchemaVersion != 7 || manifest.AppVersion != "0.30.0" {
		t.Fatalf("manifest: %+v", manifest)
	}
	if manifest.Counts.Items != 2 || manifest.Counts.Pinboards != 1 || manifest.Counts.ExtensionsEnabled != 1 {
		t.Fatalf("counts: %+v", manifest.Counts)
	}
	if len(manifest.Assets) != 1 || manifest.Assets[0].Name != "a.png" ||
		manifest.Assets[0].Size != int64(len(client.assets[1].data)) {
		t.Fatalf("assets: %+v", manifest.Assets)
	}
	if len(manifest.Referenced) != 1 || manifest.Referenced[0] != "a.png" {
		t.Fatalf("referenced: %v", manifest.Referenced)
	}
	asset := readZip(t, names["assets/a.png"])
	if string(asset) != string(client.assets[1].data) {
		t.Fatalf("asset bytes changed: %q", asset)
	}
	if manifest.CreatedAt != info.Created.UnixMilli() {
		t.Fatalf("createdAt: %d", manifest.CreatedAt)
	}

	databaseBytes := readZip(t, names["mypaste.db"])
	databasePath := filepath.Join(t.TempDir(), "mypaste.db")
	if err := os.WriteFile(databasePath, databaseBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(databaseBytes)
	if manifest.Database.Size != int64(len(databaseBytes)) ||
		manifest.Database.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("database hash: %+v", manifest.Database)
	}
	db := openReadOnly(t, databasePath)
	defer db.Close()
	assertQueryInt(t, db, "SELECT COUNT(*) FROM clipboard_items", 2)
	assertQueryInt(t, db, "SELECT COUNT(*) FROM pinboards", 1)
	assertQueryInt(t, db, "SELECT MAX(version) FROM schema_migrations", 7)
	assertQueryInt(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'clipboard_items_created'", 1)
	assertQueryInt(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'view' AND name = 'pinned_items'", 1)
	assertQueryInt(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'clipboard_items_touch'", 1)
	assertQueryInt(t, db, "SELECT seq FROM sqlite_sequence WHERE name = 'clipboard_items'", 2)
	var imagePath string
	if err := db.QueryRow("SELECT image_path FROM clipboard_items WHERE id = 1").Scan(&imagePath); err != nil {
		t.Fatal(err)
	}
	if imagePath != "a.png" {
		t.Fatalf("image path not rewritten: %q", imagePath)
	}
	var text string
	if err := db.QueryRow("SELECT text FROM clipboard_items WHERE id = 2").Scan(&text); err != nil {
		t.Fatal(err)
	}
	if text != "hello" {
		t.Fatalf("text changed: %q", text)
	}
}

func TestBuildRejectsUnmanagedImageReference(t *testing.T) {
	client := newFakeClient(t)
	defer client.db.Close()
	if _, err := client.db.Exec(`UPDATE clipboard_items SET image_path = '/tmp/notes.txt' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	builder := &Builder{Client: client, AppVersion: "0.30.0"}
	if _, err := builder.Build(context.Background(), t.TempDir()); err == nil {
		t.Fatal("unmanaged image reference was archived")
	}
}

func decodeZipJSON(t *testing.T, file *zip.File, target any) {
	t.Helper()
	content := readZip(t, file)
	if err := json.Unmarshal(content, target); err != nil {
		t.Fatal(err)
	}
}

func readZip(t *testing.T, file *zip.File) []byte {
	t.Helper()
	reader, err := file.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func openReadOnly(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func assertQueryInt(t *testing.T, db *sql.DB, query string, want int64) {
	t.Helper()
	var got int64
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	if got != want {
		t.Fatalf("%s = %d, want %d", query, got, want)
	}
}
