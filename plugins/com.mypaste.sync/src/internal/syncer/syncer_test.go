package syncer

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/crypt"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/hook"
)

const testPassphrase = "a passphrase of length"

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
INSERT INTO clipboard_items (form, title, text) VALUES ('text', 'one', 'hello');
`

// fakeHost answers the line-protocol calls from local state.
type fakeHost struct {
	db       *sql.DB
	storage  map[string][]byte
	handles  map[string][]byte
	nextID   int
	requests []hook.BackupRequest

	request  func(hook.BackupRequest) (hook.BackupResponse, error)
	restore  func(string) (hook.BackupRestoreResult, error)
	storageE []string
}

func newFakeHost(t *testing.T) *fakeHost {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(testSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return &fakeHost{db: db, storage: map[string][]byte{}, handles: map[string][]byte{}}
}

func (f *fakeHost) Begin(context.Context) error     { return nil }
func (f *fakeHost) End(context.Context, bool) error { return nil }

func (f *fakeHost) Query(ctx context.Context, statement string, params []any, limit int) ([][]any, []string, bool, error) {
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
			case []byte:
				cells[index] = map[string]string{
					"base64": base64.StdEncoding.EncodeToString(typed),
				}
			}
		}
		out = append(out, cells)
	}
	return out, columns, false, rows.Err()
}

func (f *fakeHost) AssetInfo(context.Context, int64) (hook.AssetInfo, error) {
	return hook.AssetInfo{}, sql.ErrNoRows
}

func (f *fakeHost) AssetChunk(context.Context, int64, int64, int64) ([]byte, bool, error) {
	return nil, true, nil
}

func (f *fakeHost) StorageRead(_ context.Context, key string) ([]byte, bool, error) {
	data, ok := f.storage[key]
	return data, ok, nil
}

func (f *fakeHost) StorageWrite(_ context.Context, key string, data []byte) error {
	f.storage[key] = append([]byte(nil), data...)
	f.storageE = append(f.storageE, key)
	return nil
}

func (f *fakeHost) BackupWrite(_ context.Context, handle string, offset *int64, data []byte) (hook.BackupWriteResult, error) {
	if handle == "" {
		f.nextID++
		handle = "h" + strconv.Itoa(f.nextID)
	}
	current := f.handles[handle]
	if offset != nil && *offset != int64(len(current)) {
		return hook.BackupWriteResult{}, fmt.Errorf("append offset %d at %d", *offset, len(current))
	}
	current = append(current, data...)
	f.handles[handle] = current
	return hook.BackupWriteResult{Handle: handle, Bytes: int64(len(current))}, nil
}

func (f *fakeHost) BackupRequest(_ context.Context, request hook.BackupRequest) (hook.BackupResponse, error) {
	f.requests = append(f.requests, request)
	if f.request == nil {
		return hook.BackupResponse{}, fmt.Errorf("unexpected request %s %s", request.Method, request.URL)
	}
	return f.request(request)
}

func (f *fakeHost) BackupRestore(_ context.Context, handle string) (hook.BackupRestoreResult, error) {
	if f.restore == nil {
		return hook.BackupRestoreResult{}, fmt.Errorf("unexpected restore")
	}
	return f.restore(handle)
}

func (f *fakeHost) settings(t *testing.T) settings {
	t.Helper()
	data, ok := f.storage[settingsKey]
	if !ok {
		return settings{}
	}
	var current settings
	if err := json.Unmarshal(data, &current); err != nil {
		t.Fatal(err)
	}
	return current
}

func (f *fakeHost) saveConnection(t *testing.T, syncer *Syncer) State {
	t.Helper()
	output, err := syncer.Handle(context.Background(), `{"action":"save","connection":{
		"endpoint":"","region":"us-east-1","bucket":"bucket-name","prefix":"/snapshots/",
		"accessKey":"ACCESS-KEY","secretKey":"SECRET-KEY","passphrase":"`+testPassphrase+`"}}`)
	if err != nil {
		t.Fatal(err)
	}
	var state State
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func newSyncer(host *fakeHost, now *time.Time) *Syncer {
	return &Syncer{Client: host, Version: "0.30.0", Now: func() time.Time { return *now }}
}

func TestStateOnEmptyStorage(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	output, err := syncer.Handle(context.Background(), `{"action":"state"}`)
	if err != nil {
		t.Fatal(err)
	}
	var state State
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		t.Fatal(err)
	}
	if state.Settings.Configured || state.Settings.PassphraseSet {
		t.Fatalf("empty storage looks configured: %+v", state.Settings)
	}
	if state.Schedule.IntervalHours != 24 || len(state.IntervalChoices) != 5 {
		t.Fatalf("defaults: %+v %+v", state.Schedule, state.IntervalChoices)
	}
	if len(state.Words.Actions) != 4 || state.Words.Actions[3].Key != "restore" {
		t.Fatalf("words: %+v", state.Words)
	}
}

func TestSaveKeepsSecretsOffThePageAndMergesBlanks(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	state := host.saveConnection(t, syncer)
	if !state.Settings.Configured || !state.Settings.PassphraseSet {
		t.Fatalf("save did not configure: %+v", state.Settings)
	}
	if state.Settings.Prefix != "snapshots" || state.Settings.Bucket != "bucket-name" {
		t.Fatalf("save normalized wrongly: %+v", state.Settings)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"ACCESS-KEY", "SECRET-KEY", testPassphrase} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("page state leaked a credential: %s", encoded)
		}
	}
	if got := host.settings(t); got.AccessKey != "ACCESS-KEY" || got.Passphrase != testPassphrase {
		t.Fatal("credentials were not stored privately")
	}

	output, err := syncer.Handle(context.Background(), `{"action":"save","connection":{
		"region":"us-west-2","bucket":"other-bucket","prefix":"","accessKey":"","secretKey":"","passphrase":""}}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		t.Fatal(err)
	}
	if state.Settings.Region != "us-west-2" || state.Settings.Bucket != "other-bucket" ||
		state.Settings.Prefix != "" || !state.Settings.PassphraseSet {
		t.Fatalf("blank merge: %+v", state.Settings)
	}
	if got := host.settings(t); got.AccessKey != "ACCESS-KEY" || got.SecretKey != "SECRET-KEY" {
		t.Fatal("blank fields erased stored credentials")
	}
	if got := host.settings(t); got.LastError != "" {
		t.Fatalf("save invented an error: %q", got.LastError)
	}
}

func TestSaveRejectsShortPassphraseAndBadConnection(t *testing.T) {
	host := newFakeHost(t)
	now := time.Now()
	syncer := newSyncer(host, &now)
	short := `{"action":"save","connection":{"bucket":"b","accessKey":"k","secretKey":"s","passphrase":"short"}}`
	if _, err := syncer.Handle(context.Background(), short); err == nil ||
		!strings.Contains(err.Error(), "12") {
		t.Fatalf("short passphrase: %v", err)
	}
	bad := `{"action":"save","connection":{"bucket":"b/c","accessKey":"k","secretKey":"s"}}`
	if _, err := syncer.Handle(context.Background(), bad); err == nil {
		t.Fatal("bucket with a slash was accepted")
	}
	if _, err := syncer.Handle(context.Background(), `{"action":"save"}`); err == nil {
		t.Fatal("missing connection was accepted")
	}
	if _, err := syncer.Handle(context.Background(), `{"action":"explode"}`); err == nil {
		t.Fatal("unknown action was accepted")
	}
}

func TestScheduleOnlyAcceptsKnownIntervals(t *testing.T) {
	host := newFakeHost(t)
	now := time.Now()
	syncer := newSyncer(host, &now)
	for _, hours := range []int{1, 5, 25, 169} {
		body := fmt.Sprintf(`{"action":"schedule","schedule":{"enabled":true,"intervalHours":%d}}`, hours)
		if _, err := syncer.Handle(context.Background(), body); err == nil {
			t.Fatalf("interval %d was accepted", hours)
		}
	}
	output, err := syncer.Handle(context.Background(),
		`{"action":"schedule","schedule":{"enabled":true,"intervalHours":6}}`)
	if err != nil {
		t.Fatal(err)
	}
	var state State
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		t.Fatal(err)
	}
	if !state.Schedule.Enabled || state.Schedule.IntervalHours != 6 ||
		!state.Status.Enabled || state.Status.NextAttemptAt == 0 {
		t.Fatalf("schedule: %+v %+v", state.Schedule, state.Status)
	}
}

func TestAutoSkipsUntilSetupAndSchedule(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	output, err := syncer.Auto(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `"off"`) {
		t.Fatalf("auto while disabled: %s", output)
	}
	if _, err := syncer.Handle(context.Background(),
		`{"action":"schedule","schedule":{"enabled":true,"intervalHours":24}}`); err != nil {
		t.Fatal(err)
	}
	output, err = syncer.Auto(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `"setup"`) {
		t.Fatalf("auto before connection: %s", output)
	}
	host.saveConnection(t, syncer)
	// Not due while an earlier failure is backing off.
	current := host.settings(t)
	current.LastFailureAt = now.Add(-14 * time.Minute).UnixMilli()
	current.FailureCount = 1
	if err := syncer.store(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	output, err = syncer.Auto(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "not-due") {
		t.Fatalf("auto ignored backoff: %s", output)
	}
	if len(host.requests) != 0 {
		t.Fatalf("auto contacted the network while backed off: %+v", host.requests)
	}
}

func TestAutoUploadsWhenDue(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	host.saveConnection(t, syncer)
	if _, err := syncer.Handle(context.Background(),
		`{"action":"schedule","schedule":{"enabled":true,"intervalHours":24}}`); err != nil {
		t.Fatal(err)
	}
	host.request = func(request hook.BackupRequest) (hook.BackupResponse, error) {
		if request.Method != "PUT" || !strings.Contains(request.URL, "/bucket-name/snapshots/") {
			t.Fatalf("unexpected upload %s %s", request.Method, request.URL)
		}
		if request.Headers["If-None-Match"] != "*" {
			t.Fatalf("upload is not conditional: %v", request.Headers)
		}
		if request.Headers["Authorization"] == "" || request.BodyHandle == "" {
			t.Fatal("upload was not signed or carried a handle")
		}
		if strings.Contains(request.URL, "SECRET-KEY") {
			t.Fatal("secret leaked into the URL")
		}
		return hook.BackupResponse{Status: 200}, nil
	}
	output, err := syncer.Auto(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `"uploaded":true`) {
		t.Fatalf("auto output: %s", output)
	}
	current := host.settings(t)
	if current.LastSuccessAt == 0 || current.LastObject == "" || current.LastBytes <= 0 {
		t.Fatalf("success not recorded: %+v", current)
	}
	if current.FailureCount != 0 || current.LastFailureAt != 0 {
		t.Fatalf("failure state survived success: %+v", current)
	}
	// The next attempt is one interval after this success.
	output, err = syncer.Auto(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "not-due") {
		t.Fatalf("auto ran twice: %s", output)
	}
}

func TestUploadFailureBacksOffAndStaysReadable(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	host.saveConnection(t, syncer)
	if _, err := syncer.Handle(context.Background(),
		`{"action":"schedule","schedule":{"enabled":true,"intervalHours":24}}`); err != nil {
		t.Fatal(err)
	}
	host.request = func(hook.BackupRequest) (hook.BackupResponse, error) {
		return hook.BackupResponse{Status: 403}, nil
	}
	if _, _, err := syncer.upload(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "认证") {
		t.Fatalf("403 mapped to %v", err)
	}
	current := host.settings(t)
	if current.FailureCount != 1 || current.LastFailureAt == 0 ||
		!strings.Contains(current.LastError, "认证") {
		t.Fatalf("failure not recorded: %+v", current)
	}
	if strings.Contains(current.LastError, "SECRET-KEY") {
		t.Fatalf("failure message leaked a secret: %q", current.LastError)
	}
	now = now.Add(14 * time.Minute)
	if next, err := syncer.Auto(context.Background()); err != nil ||
		!strings.Contains(next, "not-due") {
		t.Fatalf("backoff did not hold: %s %v", next, err)
	}
	now = now.Add(time.Minute)
	if _, err := syncer.Auto(context.Background()); err == nil {
		t.Fatal("due retry did not surface the failure")
	}
	current = host.settings(t)
	if current.FailureCount != 2 {
		t.Fatalf("second failure count: %d", current.FailureCount)
	}
	if got := backoff(current.FailureCount); got != 30*time.Minute {
		t.Fatalf("second backoff: %s", got)
	}
	current.FailureCount = 40
	if got := backoff(current.FailureCount); got != maxBackoff {
		t.Fatalf("backoff cap: %s", got)
	}
}

func TestUploadExistingObjectIsReadable(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	host.saveConnection(t, syncer)
	host.request = func(hook.BackupRequest) (hook.BackupResponse, error) {
		return hook.BackupResponse{Status: 412}, nil
	}
	_, _, err := syncer.upload(context.Background())
	if err == nil || !strings.Contains(err.Error(), "同名对象已存在") {
		t.Fatalf("precondition failed mapped to %v", err)
	}
}

func TestRestoreDownloadsDecryptsAndConfirms(t *testing.T) {
	host := newFakeHost(t)
	now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
	syncer := newSyncer(host, &now)
	host.saveConnection(t, syncer)
	plain := []byte("archive bytes restored")
	sealed, err := crypt.EncryptArchive(plain, testPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	host.request = restoreHandler(t, sealed)
	var restored []byte
	host.restore = func(handle string) (hook.BackupRestoreResult, error) {
		restored = append([]byte(nil), host.handles[handle]...)
		return hook.BackupRestoreResult{Items: 2, Assets: 1, Bytes: 99}, nil
	}
	output, err := syncer.Handle(context.Background(), `{"action":"restore"}`)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Result RestoreResult `json:"result"`
		State  State         `json:"state"`
	}
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Result.Items != 2 || envelope.Result.Assets != 1 || envelope.Result.Bytes != 99 {
		t.Fatalf("restore result: %+v", envelope.Result)
	}
	if string(restored) != string(plain) {
		t.Fatalf("restored bytes: %q", restored)
	}
	if envelope.State.Settings.Bucket != "bucket-name" {
		t.Fatalf("state after restore: %+v", envelope.State)
	}
}

func TestRestoreFailuresAreReadable(t *testing.T) {
	cases := []struct {
		name    string
		handler func(*testing.T, []byte) func(hook.BackupRequest) (hook.BackupResponse, error)
		want    string
	}{
		{"empty list", func(t *testing.T, _ []byte) func(hook.BackupRequest) (hook.BackupResponse, error) {
			return func(hook.BackupRequest) (hook.BackupResponse, error) {
				return listResponse(200, ""), nil
			}
		}, "没有可恢复"},
		{"bad ciphertext", func(t *testing.T, sealed []byte) func(hook.BackupRequest) (hook.BackupResponse, error) {
			return restoreHandler(t, sealed)
		}, "加密归档"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			host := newFakeHost(t)
			now := time.Date(2026, time.November, 10, 9, 0, 0, 0, time.UTC)
			syncer := newSyncer(host, &now)
			host.saveConnection(t, syncer)
			host.request = testCase.handler(t, []byte("not a sealed archive"))
			_, err := syncer.Handle(context.Background(), `{"action":"restore"}`)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("restore error: %v", err)
			}
			if strings.Contains(err.Error(), testPassphrase) {
				t.Fatalf("error leaked the passphrase: %v", err)
			}
		})
	}
}

func restoreHandler(t *testing.T, sealed []byte) func(hook.BackupRequest) (hook.BackupResponse, error) {
	t.Helper()
	return func(request hook.BackupRequest) (hook.BackupResponse, error) {
		if request.Method == "GET" && strings.Contains(request.URL, "list-type=2") {
			return listResponse(200, string(sealed)), nil
		}
		if request.Method == "GET" {
			body := request.Headers["Range"]
			start, end := parseRange(t, body)
			if end > int64(len(sealed)) {
				end = int64(len(sealed))
			}
			if start > int64(len(sealed)) {
				return hook.BackupResponse{Status: 416}, nil
			}
			encoded := base64.StdEncoding.EncodeToString(sealed[start:end])
			return hook.BackupResponse{Status: 206, Body: &encoded}, nil
		}
		t.Fatalf("unexpected request %s %s", request.Method, request.URL)
		return hook.BackupResponse{}, nil
	}
}

func listResponse(status int, object string) hook.BackupResponse {
	size := len(object)
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>snapshots/20261110-090000-mypaste-backup.zip.mypaste-sync</Key>
    <LastModified>2026-11-10T09:00:00.000Z</LastModified>
    <Size>` + strconv.Itoa(size) + `</Size>
  </Contents>
</ListBucketResult>`
	if size == 0 {
		body = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(body))
	return hook.BackupResponse{Status: status, Body: &encoded}
}

func parseRange(t *testing.T, value string) (int64, int64) {
	t.Helper()
	var start, end int64
	if _, err := fmt.Sscanf(value, "bytes=%d-%d", &start, &end); err != nil {
		t.Fatalf("range %q: %v", value, err)
	}
	return start, end + 1
}
