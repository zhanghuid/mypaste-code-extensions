// Package archive rebuilds one .mypaste-backup archive from the host's
// read-only services.
//
// The host hands an extension bounded rows and asset bytes, never a database
// file (D-1089). This package therefore recreates a real SQLite database in a
// temporary directory — schema, rows, indexes and triggers — copies the
// referenced image payloads, and writes the same ZIP the host's export wrote
// before 0.30.0. The output must pass the host's own validation on restore:
// identical manifest fields, identical counts and an integrity-checked
// database.
package archive

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/hook"
)

const (
	// FormatVersion is the host's backup format version.
	FormatVersion = 1
	// MaxPlaintextBytes bounds the archive before encryption. AES-GCM needs the
	// whole message in memory on both sides, so a larger archive is refused with
	// an actionable message instead of exhausting the process.
	MaxPlaintextBytes = 512 << 20
	// maxAssetBytes mirrors the host's per-asset ceiling.
	maxAssetBytes = 64 << 20
	// maxAssetCount mirrors the host's declared-asset ceiling.
	maxAssetCount = 20_000
	// pageRows is the first row page size; a page that is too large for the
	// host's 2 MiB line is halved down to one row.
	pageRows = 512
)

// Counts is the host's manifest count block.
type Counts struct {
	Items                int64 `json:"items"`
	Pinboards            int64 `json:"pinboards"`
	SavedSearches        int64 `json:"savedSearches"`
	IgnoreRules          int64 `json:"ignoreRules"`
	SourceRetentionRules int64 `json:"sourceRetentionRules"`
	SourcePauseRules     int64 `json:"sourcePauseRules,omitempty"`
	ExtensionsEnabled    int64 `json:"extensionsEnabled"`
}

// File describes one hashed archive member.
type File struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// AssetEntry is one referenced image in the manifest.
type AssetEntry struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is the host's manifest.json.
type Manifest struct {
	FormatVersion int          `json:"formatVersion"`
	CreatedAt     int64        `json:"createdAt"`
	AppVersion    string       `json:"appVersion"`
	SchemaVersion int64        `json:"schemaVersion"`
	Database      File         `json:"database"`
	Counts        Counts       `json:"counts"`
	Assets        []AssetEntry `json:"assets"`
	Referenced    []string     `json:"referencedAssets"`
}

// Info is what an upload reports about the archive it just built.
type Info struct {
	Path    string
	Bytes   int64
	Items   int64
	Assets  int64
	Created time.Time
}

// Client is the host surface this package needs. *hook.Client is the real
// one; tests supply the same calls over a local database.
type Client interface {
	Begin(ctx context.Context) error
	End(ctx context.Context, commit bool) error
	Query(ctx context.Context, sql string, params []any, limit int) ([][]any, []string, bool, error)
	AssetInfo(ctx context.Context, entryID int64) (hook.AssetInfo, error)
	AssetChunk(ctx context.Context, entryID, offset, length int64) ([]byte, bool, error)
}

// Builder owns one invocation's host client.
type Builder struct {
	Client Client
	// AppVersion is written to manifest.json; the host records it but does not
	// validate it.
	AppVersion string
	// Now is the archive timestamp; tests pin it.
	Now func() time.Time
}

type schemaObject struct {
	kind string
	name string
	sql  string
}

// Build reads one consistent snapshot and writes a verified archive under dir.
// The caller removes dir.
func (b *Builder) Build(ctx context.Context, dir string) (Info, error) {
	if b.Client == nil {
		return Info{}, errors.New("宿主服务不可用")
	}
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	created := now().UTC()
	if err := b.Client.Begin(ctx); err != nil {
		return Info{}, err
	}
	defer func() { _ = b.Client.End(ctx, false) }()

	objects, err := b.schema(ctx)
	if err != nil {
		return Info{}, err
	}
	dbPath := filepath.Join(dir, "mypaste.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return Info{}, errors.New("无法创建本地数据库")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode = OFF"); err != nil {
		return Info{}, errors.New("无法准备本地数据库")
	}
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return Info{}, errors.New("无法准备本地数据库")
	}
	virtual := map[string]bool{}
	for _, object := range objects {
		if object.kind == "table" && strings.HasPrefix(strings.ToUpper(strings.TrimSpace(object.sql)), "CREATE VIRTUAL TABLE") {
			virtual[object.name] = true
		}
	}
	assetsDir := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assetsDir, 0o700); err != nil {
		return Info{}, errors.New("无法创建归档目录")
	}
	referenced := make([]string, 0)
	assetSources := make(map[string]int64)
	for _, object := range objects {
		if object.kind != "table" {
			continue
		}
		shadow := false
		for name := range virtual {
			if strings.HasPrefix(object.name, name+"_") {
				shadow = true
				break
			}
		}
		if strings.HasPrefix(object.name, "sqlite_") {
			continue
		}
		if shadow {
			// A virtual table's shadow tables hold its derived index; the
			// virtual table's own rows rebuild them when inserted below.
			continue
		}
		if _, err := db.ExecContext(ctx, object.sql); err != nil {
			return Info{}, fmt.Errorf("无法重建数据表 %s：%w", object.name, err)
		}
		if err := b.copyTable(ctx, db, object.name, func(row []any, columns []string) error {
			if object.name == "clipboard_items" {
				ids := columnIndex(columns, "id")
				images := columnIndex(columns, "image_path")
				if ids >= 0 && images >= 0 {
					name, entryID, err := assetReference(row[ids], row[images])
					if err != nil {
						return err
					}
					if name != "" {
						row[images] = name
						if _, seen := assetSources[name]; !seen {
							assetSources[name] = entryID
							referenced = append(referenced, name)
						}
					}
				}
			}
			return nil
		}); err != nil {
			return Info{}, err
		}
	}
	// sqlite_sequence exists only when the schema declares AUTOINCREMENT; its
	// rows keep new inserts from reusing an id. It cannot be created directly.
	if hasObject(objects, "sqlite_sequence") {
		if err := b.copyTableInto(ctx, db, "sqlite_sequence"); err != nil {
			return Info{}, err
		}
	}
	for _, kind := range []string{"index", "view", "trigger"} {
		for _, object := range objects {
			if object.kind != kind {
				continue
			}
			if _, err := db.ExecContext(ctx, object.sql); err != nil {
				return Info{}, fmt.Errorf("无法重建 %s %s：%w", kind, object.name, err)
			}
		}
	}
	if err := verifyDatabase(ctx, db); err != nil {
		return Info{}, err
	}
	counts, schemaVersion, err := databaseInfo(ctx, db)
	if err != nil {
		return Info{}, err
	}
	sort.Strings(referenced)
	if len(referenced) > maxAssetCount {
		return Info{}, errors.New("被引用图片数量超过备份上限")
	}
	actualPaths, err := imagePaths(ctx, db)
	if err != nil {
		return Info{}, err
	}
	if !equalStrings(actualPaths, referenced) {
		return Info{}, errors.New("本地归档的图片引用与数据表不一致")
	}
	assets := make([]AssetEntry, 0, len(referenced))
	for _, name := range referenced {
		entryID := assetSources[name]
		asset, err := b.copyAsset(ctx, entryID, name, assetsDir)
		if err != nil {
			return Info{}, fmt.Errorf("读取图片 %s：%w", name, err)
		}
		assets = append(assets, asset)
	}
	// Close before hashing so every page and the header are on disk; the
	// deferred close then has nothing left to flush.
	if err := db.Close(); err != nil {
		return Info{}, errors.New("无法关闭本地数据库")
	}
	dbFile, err := hashFile(dbPath)
	if err != nil {
		return Info{}, err
	}
	manifest := Manifest{
		FormatVersion: FormatVersion,
		CreatedAt:     created.UnixMilli(),
		AppVersion:    b.AppVersion,
		SchemaVersion: schemaVersion,
		Database:      dbFile,
		Counts:        counts,
		Assets:        assets,
		Referenced:    referenced,
	}
	archivePath := filepath.Join(dir, "mypaste-backup.zip")
	if err := writeArchive(ctx, archivePath, manifest, dbPath, assetsDir, created); err != nil {
		return Info{}, err
	}
	info, err := os.Stat(archivePath)
	if err != nil {
		return Info{}, errors.New("无法读取归档文件")
	}
	if info.Size() > MaxPlaintextBytes {
		return Info{}, fmt.Errorf("备份归档为 %d MiB，超过同步上限 %d MiB",
			info.Size()>>20, MaxPlaintextBytes>>20)
	}
	return Info{Path: archivePath, Bytes: info.Size(), Items: counts.Items,
		Assets: int64(len(assets)), Created: created}, nil
}

// schema reads every object definition from the host's database. sqlite_master
// is the only schema source data.read exposes, and it never returns a path.
func (b *Builder) schema(ctx context.Context) ([]schemaObject, error) {
	rows, _, _, err := b.Client.Query(ctx,
		`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`, nil, 2048)
	if err != nil {
		return nil, err
	}
	out := make([]schemaObject, 0, len(rows))
	for _, row := range rows {
		if len(row) < 3 {
			return nil, errors.New("数据库结构行不完整")
		}
		kind, _ := row[0].(string)
		name, _ := row[1].(string)
		statement, _ := row[2].(string)
		if kind == "" || name == "" || statement == "" {
			continue
		}
		if strings.HasPrefix(name, "sqlite_autoindex_") ||
			strings.HasPrefix(name, "sqlite_stat") {
			continue
		}
		out = append(out, schemaObject{kind: kind, name: name, sql: statement})
	}
	return out, nil
}

// copyTable pages one table by rowid and inserts every row.
func (b *Builder) copyTable(ctx context.Context, db *sql.DB, table string, adjust func([]any, []string) error) error {
	columns, err := tableColumns(ctx, db, table)
	if err != nil {
		return err
	}
	return b.copyTableRows(ctx, db, table, columns, adjust)
}

func (b *Builder) copyTableInto(ctx context.Context, db *sql.DB, table string) error {
	columns, err := tableColumns(ctx, db, table)
	if err != nil {
		return err
	}
	return b.copyTableRows(ctx, db, table, columns, nil)
}

func (b *Builder) copyTableRows(
	ctx context.Context, db *sql.DB, table string, columns []string, adjust func([]any, []string) error,
) error {
	quotedTable := quoteIdent(table)
	sourceColumns := append([]string{"rowid"}, columns...)
	selectSQL := "SELECT rowid AS __mypaste_rowid, * FROM " + quotedTable +
		" WHERE rowid > ? ORDER BY rowid LIMIT ?"
	placeholders := make([]string, len(columns))
	for index := range placeholders {
		placeholders[index] = "?"
	}
	insertSQL := "INSERT INTO " + quotedTable + " (" + strings.Join(quoteAll(columns), ", ") +
		") VALUES (" + strings.Join(placeholders, ", ") + ")"
	_ = sourceColumns
	var last int64
	limit := pageRows
	for {
		rows, gotColumns, _, err := b.Client.Query(ctx, selectSQL, []any{last, limit}, limit)
		if err != nil {
			if limit > 1 && strings.Contains(err.Error(), "超过单行上限") {
				limit /= 2
				continue
			}
			return fmt.Errorf("读取数据表 %s：%w", table, err)
		}
		if len(gotColumns) != len(columns)+1 {
			return fmt.Errorf("数据表 %s 的列与结构不一致", table)
		}
		if len(rows) == 0 {
			return nil
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return errors.New("无法写入本地数据库")
		}
		statement, err := tx.PrepareContext(ctx, insertSQL)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("无法写入数据表 %s", table)
		}
		for _, row := range rows {
			if len(row) != len(columns)+1 {
				_ = statement.Close()
				_ = tx.Rollback()
				return fmt.Errorf("数据表 %s 的行不完整", table)
			}
			id, err := intValue(row[0])
			if err != nil {
				_ = statement.Close()
				_ = tx.Rollback()
				return fmt.Errorf("数据表 %s 的 rowid 无效", table)
			}
			values := append([]any(nil), row[1:]...)
			if adjust != nil {
				if err := adjust(values, columns); err != nil {
					_ = statement.Close()
					_ = tx.Rollback()
					return err
				}
			}
			converted := make([]any, len(values))
			for index, value := range values {
				cell, err := cellValue(value)
				if err != nil {
					_ = statement.Close()
					_ = tx.Rollback()
					return fmt.Errorf("数据表 %s 的列值无法写入", table)
				}
				converted[index] = cell
			}
			if _, err := statement.ExecContext(ctx, converted...); err != nil {
				_ = statement.Close()
				_ = tx.Rollback()
				return fmt.Errorf("写入数据表 %s 失败", table)
			}
			if id > last {
				last = id
			}
		}
		_ = statement.Close()
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交数据表 %s 失败", table)
		}
		if len(rows) < limit {
			return nil
		}
	}
}

// assetReference turns one clipboard row's image path into the archive name
// and the entry id whose payload carries the bytes.
func assetReference(idValue, pathValue any) (string, int64, error) {
	raw, ok := pathValue.(string)
	if !ok || raw == "" {
		return "", 0, nil
	}
	name := path.Base(strings.ReplaceAll(raw, "\\", "/"))
	if name == "" || name == "." || name == ".." || !strings.HasSuffix(name, ".png") ||
		len(name) > 128 || strings.ContainsAny(name, "/\\") {
		return "", 0, errors.New("历史中的图片引用不是受管资产")
	}
	id, err := intValue(idValue)
	if err != nil || id <= 0 {
		return "", 0, errors.New("历史中的图片条目缺少有效 ID")
	}
	return name, id, nil
}

// copyAsset reads one image by entry id and writes it under assets/.
func (b *Builder) copyAsset(ctx context.Context, entryID int64, name, assetsDir string) (AssetEntry, error) {
	info, err := b.Client.AssetInfo(ctx, entryID)
	if err != nil {
		return AssetEntry{}, err
	}
	if info.Kind != "image" {
		return AssetEntry{}, errors.New("条目载荷不是图片")
	}
	if info.Bytes < 0 || info.Bytes > maxAssetBytes {
		return AssetEntry{}, errors.New("图片超过备份上限")
	}
	file, err := os.OpenFile(filepath.Join(assetsDir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return AssetEntry{}, errors.New("无法写入本地图片文件")
	}
	hasher := sha256.New()
	var offset int64
	for offset < info.Bytes {
		length := int64(1 << 20)
		if remaining := info.Bytes - offset; remaining < length {
			length = remaining
		}
		data, eof, err := b.Client.AssetChunk(ctx, entryID, offset, length)
		if err != nil {
			_ = file.Close()
			return AssetEntry{}, err
		}
		if int64(len(data)) != length {
			_ = file.Close()
			return AssetEntry{}, errors.New("图片分块长度不一致")
		}
		if _, err := file.Write(data); err != nil {
			_ = file.Close()
			return AssetEntry{}, errors.New("无法写入本地图片文件")
		}
		_, _ = hasher.Write(data)
		offset += int64(len(data))
		if eof && offset < info.Bytes {
			_ = file.Close()
			return AssetEntry{}, errors.New("图片载荷提前结束")
		}
	}
	if err := file.Close(); err != nil {
		return AssetEntry{}, errors.New("关闭本地图片文件失败")
	}
	return AssetEntry{Name: name, Size: info.Bytes, SHA256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

func writeArchive(
	ctx context.Context, output string, manifest Manifest, dbPath, assetsDir string, created time.Time,
) error {
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("无法创建归档文件")
	}
	defer file.Close()
	writer := zip.NewWriter(file)
	writeJSON := func(name string, value any) error {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: created}
		header.SetMode(0o600)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return errors.New("无法编码归档清单")
		}
		_, err = entry.Write(encoded)
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := writeJSON("manifest.json", manifest); err != nil {
		return errors.New("无法写入归档清单")
	}
	if err := writeFile(writer, "mypaste.db", dbPath, manifest.Database, created); err != nil {
		return err
	}
	for _, asset := range manifest.Assets {
		file := File{Size: asset.Size, SHA256: asset.SHA256}
		if err := writeFile(writer, "assets/"+asset.Name, filepath.Join(assetsDir, asset.Name), file, created); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return errors.New("无法完成归档文件")
	}
	if err := file.Sync(); err != nil {
		return errors.New("无法同步归档文件")
	}
	return nil
}

func writeFile(writer *zip.Writer, name, source string, expected File, created time.Time) error {
	file, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("无法读取归档成员 %s", name)
	}
	defer file.Close()
	header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: created}
	header.SetMode(0o600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("无法写入归档成员 %s", name)
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(entry, hasher), file)
	if err != nil {
		return fmt.Errorf("无法写入归档成员 %s", name)
	}
	if written != expected.Size || hex.EncodeToString(hasher.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("归档成员 %s 的大小或哈希不一致", name)
	}
	return nil
}

func verifyDatabase(ctx context.Context, db *sql.DB) error {
	var result string
	if err := db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil {
		return errors.New("无法校验本地数据库")
	}
	if result != "ok" {
		return errors.New("本地数据库未通过完整性检查")
	}
	return nil
}

func databaseInfo(ctx context.Context, db *sql.DB) (Counts, int64, error) {
	var schema int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&schema); err != nil {
		return Counts{}, 0, errors.New("无法读取本地数据库版本")
	}
	counts := Counts{}
	tables := []struct {
		name string
		dest *int64
	}{
		{"clipboard_items", &counts.Items},
		{"pinboards", &counts.Pinboards},
		{"saved_searches", &counts.SavedSearches},
		{"ignore_rules", &counts.IgnoreRules},
		{"source_pause_rules", &counts.SourcePauseRules},
		{"source_retention_rules", &counts.SourceRetentionRules},
		{"extension_enabled", &counts.ExtensionsEnabled},
	}
	for _, table := range tables {
		var exists int
		err := db.QueryRowContext(ctx,
			`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, table.name).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return Counts{}, 0, errors.New("无法检查本地数据库结构")
		}
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quoteIdent(table.name)).Scan(table.dest); err != nil {
			return Counts{}, 0, errors.New("无法统计本地数据库")
		}
	}
	return counts, schema, nil
}

func imagePaths(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT DISTINCT image_path FROM clipboard_items WHERE image_path <> '' ORDER BY image_path`)
	if err != nil {
		return nil, errors.New("无法读取本地数据库的图片引用")
	}
	defer rows.Close()
	paths := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, errors.New("无法读取本地数据库的图片引用")
		}
		paths = append(paths, value)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("无法读取本地数据库的图片引用")
	}
	return paths, nil
}

func tableColumns(ctx context.Context, db *sql.DB, table string) ([]string, error) {
	rows, err := db.QueryContext(ctx, "SELECT * FROM "+quoteIdent(table)+" LIMIT 0")
	if err != nil {
		return nil, fmt.Errorf("无法读取数据表 %s 的列", table)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("无法读取数据表 %s 的列", table)
	}
	return columns, nil
}

func hashFile(path string) (File, error) {
	file, err := os.Open(path)
	if err != nil {
		return File{}, errors.New("无法读取本地数据库")
	}
	defer file.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, file)
	if err != nil {
		return File{}, errors.New("无法读取本地数据库")
	}
	return File{Size: size, SHA256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

// cellValue decodes one data.read cell for SQLite.
func cellValue(value any) (any, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return typed, nil
	case bool:
		if typed {
			return int64(1), nil
		}
		return int64(0), nil
	case json.Number:
		if integer, err := typed.Int64(); err == nil {
			return integer, nil
		}
		float, err := typed.Float64()
		if err != nil {
			return nil, errors.New("数值无法读取")
		}
		return float, nil
	case float64:
		return typed, nil
	case map[string]any:
		encoded, ok := typed["base64"].(string)
		if !ok {
			return nil, errors.New("不支持的单元格类型")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, errors.New("二进制单元格无法解码")
		}
		return data, nil
	}
	return nil, errors.New("不支持的单元格类型")
}

func intValue(value any) (int64, error) {
	switch typed := value.(type) {
	case int64:
		return typed, nil
	case json.Number:
		return typed.Int64()
	case float64:
		return int64(typed), nil
	case string:
		return strconv.ParseInt(typed, 10, 64)
	}
	return 0, errors.New("不是整数")
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func quoteAll(names []string) []string {
	out := make([]string, len(names))
	for index, name := range names {
		out[index] = quoteIdent(name)
	}
	return out
}

func columnIndex(columns []string, name string) int {
	for index, column := range columns {
		if column == name {
			return index
		}
	}
	return -1
}

func hasObject(objects []schemaObject, name string) bool {
	for _, object := range objects {
		if object.name == name {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
