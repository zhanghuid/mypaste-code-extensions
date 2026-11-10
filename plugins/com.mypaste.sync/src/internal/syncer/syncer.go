// Package syncer owns the sync extension's settings, its schedule and the two
// transfers. It is the only place that holds the S3 credentials and the
// encryption passphrase; both live in the extension's own private storage
// (storage.plugin, 0600) and never reach a page, a log or an error message.
package syncer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/archive"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/crypt"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/hook"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/s3"
)

const (
	settingsKey    = "settings.json"
	defaultHours   = 24
	maxBackoff     = 24 * time.Hour
	initialBackoff = 15 * time.Minute
	// minPassphraseRunes is the host's old rule; keeping it means a passphrase
	// set here still opens objects written before 0.30.0.
	minPassphraseRunes = 12
	// maxDownloadBytes bounds one download before decryption; the header costs
	// a few dozen bytes.
	maxDownloadBytes = archive.MaxPlaintextBytes + 1<<20
	// chunkBytes is the largest payload one backup.sync call carries.
	chunkBytes = 1 << 20
	// maxListPages bounds one listing at 20 000 objects.
	maxListPages = 20
)

// IntervalChoices is the closed set of upload intervals, in hours.
var IntervalChoices = []Choice{
	{Value: 6, Label: "每 6 小时"},
	{Value: 12, Label: "每 12 小时"},
	{Value: 24, Label: "每天"},
	{Value: 72, Label: "每 3 天"},
	{Value: 168, Label: "每 7 天"},
}

// Choice is one closed number choice.
type Choice struct {
	Value int    `json:"value"`
	Label string `json:"label"`
}

// Word is one page action's wording.
type Word struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Done string `json:"done"`
}

// Words is the page's action vocabulary.
type Words struct {
	Actions []Word `json:"actions"`
}

var words = Words{Actions: []Word{
	{Key: "save", Name: "保存 S3 连接", Done: "S3 连接已保存到本机"},
	{Key: "test", Name: "测试 S3 连接", Done: "S3 连接测试通过"},
	{Key: "upload", Name: "立即上传", Done: "已加密上传 %s 字节"},
	{Key: "restore", Name: "从远端恢复", Done: "已从远端快照恢复"},
}}

// settings is the private file. It is never serialized to a page.
type settings struct {
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix"`
	AccessKey       string `json:"accessKey"`
	SecretKey       string `json:"secretKey"`
	Passphrase      string `json:"passphrase"`
	ScheduleEnabled bool   `json:"scheduleEnabled"`
	IntervalHours   int    `json:"intervalHours"`
	LastSuccessAt   int64  `json:"lastSuccessAt"`
	LastFailureAt   int64  `json:"lastFailureAt"`
	FailureCount    int    `json:"failureCount"`
	LastError       string `json:"lastError"`
	LastObject      string `json:"lastObject"`
	LastBytes       int64  `json:"lastBytes"`
}

// PageSettings is the credential-free half the page renders.
type PageSettings struct {
	Endpoint      string `json:"endpoint"`
	Region        string `json:"region"`
	Bucket        string `json:"bucket"`
	Prefix        string `json:"prefix"`
	Configured    bool   `json:"configured"`
	PassphraseSet bool   `json:"passphraseSet"`
}

// Schedule is the automatic upload plan.
type Schedule struct {
	Enabled       bool `json:"enabled"`
	IntervalHours int  `json:"intervalHours"`
}

// Status is the page-safe scheduling state.
type Status struct {
	Enabled       bool   `json:"enabled"`
	Running       bool   `json:"running"`
	IntervalHours int    `json:"intervalHours"`
	LastSuccessAt int64  `json:"lastSuccessAt,omitempty"`
	LastFailureAt int64  `json:"lastFailureAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	NextAttemptAt int64  `json:"nextAttemptAt,omitempty"`
	LastObject    string `json:"lastObject,omitempty"`
	LastBytes     int64  `json:"lastBytes,omitempty"`
}

// State is everything the page may render.
type State struct {
	Settings        PageSettings `json:"settings"`
	Schedule        Schedule     `json:"schedule"`
	Status          Status       `json:"status"`
	IntervalChoices []Choice     `json:"intervalChoices"`
	Words           Words        `json:"words"`
}

// UploadResult is one successful upload.
type UploadResult struct {
	Object   string `json:"object"`
	Bytes    int64  `json:"bytes"`
	Uploaded bool   `json:"uploaded"`
	Items    int64  `json:"items"`
	Assets   int64  `json:"assets"`
}

// RestoreResult is the host's outcome for one remote restore.
type RestoreResult struct {
	Cancelled bool  `json:"cancelled"`
	Items     int64 `json:"items"`
	Assets    int64 `json:"assets"`
	Bytes     int64 `json:"bytes"`
}

type saveRequest struct {
	Endpoint   string `json:"endpoint"`
	Region     string `json:"region"`
	Bucket     string `json:"bucket"`
	Prefix     string `json:"prefix"`
	AccessKey  string `json:"accessKey"`
	SecretKey  string `json:"secretKey"`
	Passphrase string `json:"passphrase"`
}

type scheduleRequest struct {
	Enabled       bool `json:"enabled"`
	IntervalHours int  `json:"intervalHours"`
}

type request struct {
	Action     string           `json:"action"`
	Connection *saveRequest     `json:"connection,omitempty"`
	Schedule   *scheduleRequest `json:"schedule,omitempty"`
}

// Host is the slice of the line protocol this engine uses. *hook.Client is
// the real one; tests answer the same calls locally.
type Host interface {
	archive.Client
	StorageRead(ctx context.Context, key string) ([]byte, bool, error)
	StorageWrite(ctx context.Context, key string, data []byte) error
	BackupWrite(ctx context.Context, handle string, offset *int64, data []byte) (hook.BackupWriteResult, error)
	BackupRequest(ctx context.Context, request hook.BackupRequest) (hook.BackupResponse, error)
	BackupRestore(ctx context.Context, handle string) (hook.BackupRestoreResult, error)
}

// Syncer is one invocation's engine.
type Syncer struct {
	Client  Host
	Version string
	Now     func() time.Time
}

func (s *Syncer) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Handle runs one page request and returns the JSON the page reads.
func (s *Syncer) Handle(ctx context.Context, raw string) (string, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	var call request
	if err := decoder.Decode(&call); err != nil {
		return "", errors.New("同步请求无法解析")
	}
	switch call.Action {
	case "state":
		state, err := s.State(ctx)
		return encode(state, err)
	case "save":
		if call.Connection == nil {
			return "", errors.New("缺少连接设置")
		}
		state, err := s.save(ctx, *call.Connection)
		return encode(state, err)
	case "schedule":
		if call.Schedule == nil {
			return "", errors.New("缺少自动上传设置")
		}
		state, err := s.saveSchedule(ctx, *call.Schedule)
		return encode(state, err)
	case "test":
		state, err := s.test(ctx)
		return encode(state, err)
	case "run":
		result, state, err := s.upload(ctx)
		return encode(map[string]any{"result": result, "state": state}, err)
	case "restore":
		result, state, err := s.restore(ctx)
		return encode(map[string]any{"result": result, "state": state}, err)
	}
	return "", errors.New("未知的同步操作")
}

// Auto is the interval trigger's entry: it uploads only when the stored plan
// is due, and stays silent otherwise.
func (s *Syncer) Auto(ctx context.Context) (string, error) {
	current, err := s.load(ctx)
	if err != nil {
		return "", err
	}
	if !current.ScheduleEnabled {
		return `{"skipped":"off"}`, nil
	}
	if !current.configured() || strings.TrimSpace(current.Passphrase) == "" {
		return `{"skipped":"setup"}`, nil
	}
	if s.now().Before(s.nextAttempt(current)) {
		return `{"skipped":"not-due"}`, nil
	}
	result, _, err := s.upload(ctx)
	if err != nil {
		return "", err
	}
	return encode(map[string]any{"result": result}, nil)
}

func encode(value any, err error) (string, error) {
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("无法编码同步结果")
	}
	return string(encoded), nil
}

// State loads the private file and projects the page-safe half.
func (s *Syncer) State(ctx context.Context) (State, error) {
	current, err := s.load(ctx)
	if err != nil {
		return State{}, err
	}
	status := Status{
		Enabled:       current.ScheduleEnabled,
		IntervalHours: intervalHours(current.IntervalHours),
		LastSuccessAt: current.LastSuccessAt,
		LastFailureAt: current.LastFailureAt,
		LastError:     current.LastError,
		LastObject:    current.LastObject,
		LastBytes:     current.LastBytes,
	}
	if current.ScheduleEnabled {
		status.NextAttemptAt = s.nextAttempt(current).UnixMilli()
	}
	return State{
		Settings: PageSettings{
			Endpoint: current.Endpoint, Region: current.Region, Bucket: current.Bucket,
			Prefix: current.Prefix, Configured: current.configured(),
			PassphraseSet: strings.TrimSpace(current.Passphrase) != "",
		},
		Schedule: Schedule{Enabled: current.ScheduleEnabled,
			IntervalHours: intervalHours(current.IntervalHours)},
		Status:          status,
		IntervalChoices: append([]Choice(nil), IntervalChoices...),
		Words:           Words{Actions: append([]Word(nil), words.Actions...)},
	}, nil
}

func (s *Syncer) save(ctx context.Context, call saveRequest) (State, error) {
	current, err := s.load(ctx)
	if err != nil {
		return State{}, err
	}
	next := current
	next.Endpoint = strings.TrimSpace(call.Endpoint)
	next.Region = strings.TrimSpace(call.Region)
	next.Bucket = strings.TrimSpace(call.Bucket)
	next.Prefix = strings.Trim(strings.TrimSpace(call.Prefix), "/")
	if accessKey := strings.TrimSpace(call.AccessKey); accessKey != "" {
		next.AccessKey = accessKey
	}
	if secretKey := strings.TrimSpace(call.SecretKey); secretKey != "" {
		next.SecretKey = secretKey
	}
	config := next.config()
	if err := config.Validate(); err != nil {
		return State{}, err
	}
	if passphrase := strings.TrimSpace(call.Passphrase); passphrase != "" {
		if utf8.RuneCountInString(passphrase) < minPassphraseRunes {
			return State{}, fmt.Errorf("同步密码至少需要 %d 个字符", minPassphraseRunes)
		}
		next.Passphrase = passphrase
	}
	if err := s.store(ctx, next); err != nil {
		return State{}, err
	}
	return s.State(ctx)
}

func (s *Syncer) saveSchedule(ctx context.Context, call scheduleRequest) (State, error) {
	if !validHours(call.IntervalHours) {
		return State{}, errors.New("自动上传间隔不在允许范围内")
	}
	current, err := s.load(ctx)
	if err != nil {
		return State{}, err
	}
	current.ScheduleEnabled = call.Enabled
	current.IntervalHours = call.IntervalHours
	if err := s.store(ctx, current); err != nil {
		return State{}, err
	}
	return s.State(ctx)
}

func (s *Syncer) test(ctx context.Context) (State, error) {
	current, err := s.load(ctx)
	if err != nil {
		return State{}, err
	}
	config := current.config()
	if err := config.Validate(); err != nil {
		return State{}, err
	}
	if _, err := s.list(ctx, config, 1); err != nil {
		return State{}, err
	}
	return s.State(ctx)
}

func (s *Syncer) upload(ctx context.Context) (UploadResult, State, error) {
	current, err := s.load(ctx)
	if err != nil {
		return UploadResult{}, State{}, err
	}
	config := current.config()
	if err := config.Validate(); err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	if strings.TrimSpace(current.Passphrase) == "" {
		err := errors.New("请先设置同步密码")
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	dir, err := os.MkdirTemp("", "mypaste-sync-")
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, errors.New("无法创建同步临时目录"))
	}
	defer os.RemoveAll(dir)
	builder := archive.Builder{Client: s.Client, AppVersion: s.Version, Now: s.Now}
	info, err := builder.Build(ctx, dir)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	plain, err := os.ReadFile(info.Path)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, errors.New("无法读取同步归档"))
	}
	sealed, err := crypt.EncryptArchive(plain, current.Passphrase)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	object := s3.ObjectName(info.Path, s.now())
	handle, err := s.writeHandle(ctx, sealed)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	digest := s3.PayloadHash(sealed)
	target, err := config.ObjectURL(object)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	req, err := http.NewRequest(http.MethodPut, target.String(), nil)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, errors.New("无法创建上传请求"))
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Amz-Meta-Format", "mypaste-sync")
	req.Header.Set("X-Amz-Meta-Version", strconv.Itoa(s3.FormatVersion))
	// A conditional PUT turns a same-second collision into a readable
	// failure instead of silently replacing another upload.
	req.Header.Set("If-None-Match", "*")
	response, err := s.send(ctx, config, req, digest, handle, digest)
	if err != nil {
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	if response.Status < 200 || response.Status >= 300 {
		err := s3Error("上传", response.Status)
		return UploadResult{}, State{}, s.failure(ctx, current, err)
	}
	now := s.now().UnixMilli()
	current.LastSuccessAt = now
	current.LastFailureAt = 0
	current.FailureCount = 0
	current.LastError = ""
	current.LastObject = object
	current.LastBytes = int64(len(sealed))
	if err := s.store(ctx, current); err != nil {
		return UploadResult{}, State{}, err
	}
	state, err := s.State(ctx)
	if err != nil {
		return UploadResult{}, State{}, err
	}
	return UploadResult{Object: object, Bytes: int64(len(sealed)), Uploaded: true,
		Items: info.Items, Assets: info.Assets}, state, nil
}

func (s *Syncer) restore(ctx context.Context) (RestoreResult, State, error) {
	current, err := s.load(ctx)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	config := current.config()
	if err := config.Validate(); err != nil {
		return RestoreResult{}, State{}, err
	}
	if strings.TrimSpace(current.Passphrase) == "" {
		return RestoreResult{}, State{}, errors.New("请先设置同步密码")
	}
	entries, err := s.list(ctx, config, 0)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	latest, ok := s3.Latest(entries)
	if !ok {
		return RestoreResult{}, State{}, errors.New("远端还没有可恢复的同步快照")
	}
	if latest.Size <= 0 || latest.Size > maxDownloadBytes {
		return RestoreResult{}, State{}, errors.New("远端快照大小超出同步上限")
	}
	sealed, err := s.download(ctx, config, latest.Key, latest.Size)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	plain, err := crypt.DecryptArchive(sealed, current.Passphrase)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	handle, err := s.writeHandle(ctx, plain)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	result, err := s.Client.BackupRestore(ctx, handle)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	state, err := s.State(ctx)
	if err != nil {
		return RestoreResult{}, State{}, err
	}
	return RestoreResult{Cancelled: result.Cancelled, Items: result.Items,
		Assets: result.Assets, Bytes: result.Bytes}, state, nil
}

// writeHandle writes bytes through backup.sync in one-MiB appends.
func (s *Syncer) writeHandle(ctx context.Context, data []byte) (string, error) {
	handle := ""
	var offset int64
	for offset < int64(len(data)) {
		end := offset + chunkBytes
		if end > int64(len(data)) {
			end = int64(len(data))
		}
		var position *int64
		if handle != "" {
			value := offset
			position = &value
		}
		written, err := s.Client.BackupWrite(ctx, handle, position, data[offset:end])
		if err != nil {
			return "", err
		}
		if handle == "" {
			handle = written.Handle
		}
		if written.Bytes != end-offset {
			return "", errors.New("同步写入长度不一致")
		}
		offset = end
	}
	if handle == "" {
		return "", errors.New("同步数据为空")
	}
	return handle, nil
}

// list pages ListObjectsV2 under the configured prefix. maxKeys 0 lists every
// page; a positive value asks for one tiny page (the connection test).
func (s *Syncer) list(ctx context.Context, config s3.Config, maxKeys int) ([]s3.ListEntry, error) {
	entries := make([]s3.ListEntry, 0)
	token := ""
	pages := 0
	for {
		pageSize := 1000
		if maxKeys > 0 {
			pageSize = maxKeys
		}
		target, err := config.ListURL(pageSize, token)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequest(http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, errors.New("无法创建列表请求")
		}
		response, err := s.send(ctx, config, req, s3.EmptyPayloadHash, "", "")
		if err != nil {
			return nil, err
		}
		if response.Status < 200 || response.Status >= 300 {
			return nil, s3Error("读取远端对象列表", response.Status)
		}
		body, err := decodeBody(response)
		if err != nil {
			return nil, err
		}
		page, next, err := s3.ParseList(body)
		if err != nil {
			return nil, err
		}
		entries = append(entries, page...)
		if next == "" || maxKeys > 0 {
			break
		}
		token = next
		pages++
		if pages >= maxListPages {
			break
		}
	}
	return entries, nil
}

// download reads one object in ranged, inline-sized chunks. A ranged request
// keeps every backup.sync answer under its one-MiB inline ceiling.
func (s *Syncer) download(ctx context.Context, config s3.Config, key string, size int64) ([]byte, error) {
	target, err := config.ObjectURL(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, size)
	var offset int64
	for offset < size {
		length := int64(chunkBytes)
		if remaining := size - offset; remaining < length {
			length = remaining
		}
		req, err := http.NewRequest(http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, errors.New("无法创建下载请求")
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
		response, err := s.send(ctx, config, req, s3.EmptyPayloadHash, "", "")
		if err != nil {
			return nil, err
		}
		full := offset == 0 && size <= chunkBytes
		if response.Status == http.StatusOK && !full {
			return nil, errors.New("远端存储不支持分段下载")
		}
		if response.Status != http.StatusPartialContent && response.Status != http.StatusOK {
			return nil, s3Error("下载", response.Status)
		}
		chunk, err := decodeBody(response)
		if err != nil {
			return nil, err
		}
		if int64(len(chunk)) == 0 || int64(len(chunk)) > length {
			return nil, errors.New("远端快照分块长度不一致")
		}
		out = append(out, chunk...)
		offset += int64(len(chunk))
	}
	if int64(len(out)) != size {
		return nil, errors.New("远端快照大小与对象列表不一致")
	}
	return out, nil
}

// send signs one request and performs it through backup.sync. Only the signed
// headers cross to the host; Host and Content-Length belong to its transport.
func (s *Syncer) send(
	ctx context.Context, config s3.Config, req *http.Request,
	payloadHash, bodyHandle, bodySHA string,
) (hook.BackupResponse, error) {
	signer := s3.Signer{Now: s.Now}
	signer.Sign(req, config, payloadHash)
	request := hook.BackupRequest{
		URL: req.URL.String(), Method: req.Method, Headers: s3.Headers(req),
		BodyHandle: bodyHandle, BodySHA256: bodySHA, ResponseMode: "inline",
	}
	response, err := s.Client.BackupRequest(ctx, request)
	if err != nil {
		return hook.BackupResponse{}, err
	}
	return response, nil
}

func decodeBody(response hook.BackupResponse) ([]byte, error) {
	if response.Body == nil {
		return nil, errors.New("远端响应没有正文")
	}
	data, err := base64.StdEncoding.DecodeString(*response.Body)
	if err != nil {
		return nil, errors.New("远端响应正文无法解码")
	}
	return data, nil
}

func s3Error(action string, status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%s失败：S3 认证或存储桶权限失败", action)
	case http.StatusNotFound:
		return fmt.Errorf("%s失败：存储桶或对象不存在", action)
	case http.StatusConflict, http.StatusPreconditionFailed:
		return fmt.Errorf("%s失败：同名对象已存在", action)
	case http.StatusRequestedRangeNotSatisfiable:
		return fmt.Errorf("%s失败：远端对象不支持分段读取", action)
	}
	return s3.StatusError(action, status)
}

func (s *Syncer) load(ctx context.Context) (settings, error) {
	data, ok, err := s.Client.StorageRead(ctx, settingsKey)
	if err != nil {
		return settings{}, errors.New("无法读取同步设置")
	}
	current := settings{IntervalHours: defaultHours}
	if !ok {
		return current, nil
	}
	if err := json.Unmarshal(data, &current); err != nil {
		return settings{}, errors.New("同步设置无法解析")
	}
	if !validHours(current.IntervalHours) {
		current.IntervalHours = defaultHours
	}
	return current, nil
}

func (s *Syncer) store(ctx context.Context, current settings) error {
	encoded, err := json.Marshal(current)
	if err != nil {
		return errors.New("无法编码同步设置")
	}
	if err := s.Client.StorageWrite(ctx, settingsKey, encoded); err != nil {
		return errors.New("无法保存同步设置")
	}
	return nil
}

// failure records a failed attempt and returns the same error to the caller.
// Only our own sentences are stored; they never carry a credential.
func (s *Syncer) failure(ctx context.Context, current settings, cause error) error {
	message := failureMessage(cause)
	current.LastFailureAt = s.now().UnixMilli()
	current.LastError = message
	if current.FailureCount < 8 {
		current.FailureCount++
	}
	_ = s.store(ctx, current)
	return cause
}

func failureMessage(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, context.Canceled):
		return "同步已取消"
	case errors.Is(err, context.DeadlineExceeded):
		return "同步超时，请检查网络"
	}
	message := err.Error()
	if utf8.RuneCountInString(message) > 160 {
		message = string([]rune(message)[:160])
	}
	return message
}

func (s *Syncer) nextAttempt(current settings) time.Time {
	now := s.now()
	if current.LastFailureAt > 0 {
		return time.UnixMilli(current.LastFailureAt).Add(backoff(current.FailureCount))
	}
	if current.LastSuccessAt > 0 {
		return time.UnixMilli(current.LastSuccessAt).
			Add(time.Duration(intervalHours(current.IntervalHours)) * time.Hour)
	}
	return now
}

func backoff(failures int) time.Duration {
	delay := initialBackoff
	for index := 1; index < failures && delay < maxBackoff; index++ {
		delay *= 2
	}
	if delay > maxBackoff {
		return maxBackoff
	}
	return delay
}

func (current settings) config() s3.Config {
	return s3.Config{
		Endpoint: current.Endpoint, Region: current.Region, Bucket: current.Bucket,
		Prefix: current.Prefix, AccessKeyID: current.AccessKey,
		SecretAccessKey: current.SecretKey,
	}
}

func (current settings) configured() bool {
	return strings.TrimSpace(current.AccessKey) != "" &&
		strings.TrimSpace(current.SecretKey) != "" &&
		strings.TrimSpace(current.Bucket) != ""
}

func intervalHours(hours int) int {
	if validHours(hours) {
		return hours
	}
	return defaultHours
}

func validHours(hours int) bool {
	for _, choice := range IntervalChoices {
		if choice.Value == hours {
			return true
		}
	}
	return false
}
