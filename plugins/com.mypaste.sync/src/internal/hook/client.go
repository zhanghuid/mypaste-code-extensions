// Package hook is this extension's side of the host's line protocol
// (PLUGINS.md §4). It owns exactly the calls the sync engine needs: private
// storage, the read-only data view, asset bytes and the backup transport.
// Nothing here knows a host path, a SQLite handle or a credential store.
package hook

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// Client is one invocation's conversation with the host. Calls are serial:
// the protocol is one request line in, one answer line out, with host calls in
// between. The engine never shares a client between goroutines.
type Client struct {
	input  *bufio.Reader
	output *bufio.Writer
	calls  int
}

// NewClient wraps the invocation's streams.
func NewClient(input io.Reader, output io.Writer) *Client {
	return &Client{
		input:  bufio.NewReaderSize(input, 1<<20),
		output: bufio.NewWriterSize(output, 1<<20),
	}
}

// ReadRequestLine reads the invocation's one request line. It must use this
// reader: the buffered bytes belong to the same host conversation.
func (c *Client) ReadRequestLine() ([]byte, error) {
	line, err := c.input.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, errors.New("没有收到宿主请求")
	}
	return line, nil
}

// WriteLine writes one line and flushes it. The host reads the final response
// only after every host call has been answered.
func (c *Client) WriteLine(line []byte) error {
	if _, err := c.output.Write(append(line, '\n')); err != nil {
		return errors.New("无法写入宿主响应")
	}
	return c.output.Flush()
}

type hostCall struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Service string          `json:"service"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type hostCallResult struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Call performs one host call and returns its raw result.
func (c *Client) Call(ctx context.Context, service, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.New("同步操作已超时")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, errors.New("无法编码宿主调用")
	}
	c.calls++
	call := hostCall{Type: "hostCall", ID: "s" + strconv.Itoa(c.calls),
		Service: service, Method: method, Params: raw}
	line, err := json.Marshal(call)
	if err != nil {
		return nil, errors.New("无法编码宿主调用")
	}
	if _, err := c.output.Write(append(line, '\n')); err != nil {
		return nil, errors.New("无法写入宿主调用")
	}
	if err := c.output.Flush(); err != nil {
		return nil, errors.New("无法写入宿主调用")
	}
	for {
		response, err := c.input.ReadBytes('\n')
		if err != nil {
			return nil, errors.New("宿主调用没有响应")
		}
		var result hostCallResult
		if err := json.Unmarshal(response, &result); err != nil {
			return nil, errors.New("宿主调用响应无法读取")
		}
		if result.Type != "hostCallResult" {
			return nil, errors.New("宿主返回了意外的消息")
		}
		if result.ID != call.ID {
			continue
		}
		if !result.OK {
			if result.Error == "" {
				result.Error = "宿主调用失败"
			}
			return nil, errors.New(result.Error)
		}
		return result.Result, nil
	}
}

// --- storage.plugin -------------------------------------------------------

// ErrStorageMissing is the host's answer for an absent key, matched exactly.
var ErrStorageMissing = errors.New("存储项不存在")

// StorageRead returns nil, false for an absent key.
func (c *Client) StorageRead(ctx context.Context, key string) ([]byte, bool, error) {
	raw, err := c.Call(ctx, "storage.plugin", "read", map[string]string{"key": key})
	if err != nil {
		if err.Error() == ErrStorageMissing.Error() {
			return nil, false, nil
		}
		return nil, false, err
	}
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, false, errors.New("存储项响应无法读取")
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return nil, false, errors.New("存储项内容无法读取")
	}
	return data, true, nil
}

// StorageWrite stores one private value. The host owns the file mode and
// quota; the extension never sees the directory.
func (c *Client) StorageWrite(ctx context.Context, key string, data []byte) error {
	_, err := c.Call(ctx, "storage.plugin", "write", map[string]string{
		"key": key, "data": base64.StdEncoding.EncodeToString(data),
	})
	return err
}

// --- data.read ------------------------------------------------------------

// Query executes one SELECT/WITH through the host's read-only session. Values
// arrive as nil, string, json.Number or a {"base64": …} object for a BLOB.
func (c *Client) Query(ctx context.Context, sql string, params []any, limit int) ([][]any, []string, bool, error) {
	raw, err := c.Call(ctx, "data.read", "query", map[string]any{
		"sql": sql, "params": params, "limit": limit,
	})
	if err != nil {
		return nil, nil, false, err
	}
	var result struct {
		Columns   []string        `json:"columns"`
		Rows      [][]interface{} `json:"rows"`
		Truncated bool            `json:"truncated"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return nil, nil, false, errors.New("数据读取结果无法解析")
	}
	return result.Rows, result.Columns, result.Truncated, nil
}

// Begin pins one read snapshot for the rest of this invocation.
func (c *Client) Begin(ctx context.Context) error {
	_, err := c.Call(ctx, "data.read", "begin", struct{}{})
	return err
}

// End closes the pinned snapshot. Rollback is enough: every query is read-only.
func (c *Client) End(ctx context.Context, commit bool) error {
	method := "rollback"
	if commit {
		method = "commit"
	}
	_, err := c.Call(ctx, "data.read", method, struct{}{})
	return err
}

// --- asset.read -----------------------------------------------------------

// AssetInfo describes one entry's payload.
type AssetInfo struct {
	Kind  string `json:"kind"`
	MIME  string `json:"mime"`
	Bytes int64  `json:"bytes"`
}

// AssetInfo asks for one entry's kind, type and size.
func (c *Client) AssetInfo(ctx context.Context, entryID int64) (AssetInfo, error) {
	raw, err := c.Call(ctx, "asset.read", "info", map[string]any{"entryId": entryID})
	if err != nil {
		return AssetInfo{}, err
	}
	var result AssetInfo
	if err := json.Unmarshal(raw, &result); err != nil {
		return AssetInfo{}, errors.New("资产信息无法读取")
	}
	return result, nil
}

// AssetChunk returns one bounded byte range and whether it reached the end.
func (c *Client) AssetChunk(ctx context.Context, entryID, offset, length int64) ([]byte, bool, error) {
	raw, err := c.Call(ctx, "asset.read", "read", map[string]any{
		"entryId": entryID, "offset": offset, "length": length,
	})
	if err != nil {
		return nil, false, err
	}
	var result struct {
		Data  string `json:"data"`
		Bytes int    `json:"bytes"`
		EOF   bool   `json:"eof"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, false, errors.New("资产分块无法读取")
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return nil, false, errors.New("资产分块内容无法读取")
	}
	if len(data) != result.Bytes {
		return nil, false, errors.New("资产分块长度不一致")
	}
	return data, result.EOF, nil
}

// --- backup.sync ----------------------------------------------------------

// BackupWriteResult is one handle append's answer.
type BackupWriteResult struct {
	Handle string `json:"handle"`
	Bytes  int64  `json:"bytes"`
}

// BackupWrite appends one chunk to a handle. An empty handle creates one.
func (c *Client) BackupWrite(ctx context.Context, handle string, offset *int64, data []byte) (BackupWriteResult, error) {
	params := map[string]any{"data": base64.StdEncoding.EncodeToString(data)}
	if handle != "" {
		params["handle"] = handle
	}
	if offset != nil {
		params["offset"] = *offset
	}
	raw, err := c.Call(ctx, "backup.sync", "write", params)
	if err != nil {
		return BackupWriteResult{}, err
	}
	var result BackupWriteResult
	if err := json.Unmarshal(raw, &result); err != nil || result.Handle == "" {
		return BackupWriteResult{}, errors.New("同步写入响应无法读取")
	}
	return result, nil
}

// BackupRequest is one HTTPS transfer through the host.
type BackupRequest struct {
	URL          string            `json:"url"`
	Method       string            `json:"method"`
	Headers      map[string]string `json:"headers,omitempty"`
	BodyHandle   string            `json:"bodyHandle,omitempty"`
	BodySHA256   string            `json:"bodySha256,omitempty"`
	ResponseMode string            `json:"responseMode,omitempty"`
}

// BackupResponse is the page-safe half of one transfer.
type BackupResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers,omitempty"`
	Body    *string             `json:"body,omitempty"`
	Handle  string              `json:"handle,omitempty"`
	Bytes   *int64              `json:"bytes,omitempty"`
	SHA256  string              `json:"sha256,omitempty"`
}

// BackupRequest performs one transfer.
func (c *Client) BackupRequest(ctx context.Context, request BackupRequest) (BackupResponse, error) {
	raw, err := c.Call(ctx, "backup.sync", "request", request)
	if err != nil {
		return BackupResponse{}, err
	}
	var result BackupResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return BackupResponse{}, errors.New("同步请求响应无法读取")
	}
	return result, nil
}

// BackupRestoreResult is the host's confirmation-checked restore answer.
type BackupRestoreResult struct {
	Cancelled bool  `json:"cancelled"`
	Items     int64 `json:"items"`
	Assets    int64 `json:"assets"`
	Bytes     int64 `json:"bytes"`
}

// BackupRestore validates one archive handle and, after the host's own
// confirmation, replaces this installation's data.
func (c *Client) BackupRestore(ctx context.Context, handle string) (BackupRestoreResult, error) {
	raw, err := c.Call(ctx, "backup.sync", "restore", map[string]any{"handle": handle})
	if err != nil {
		return BackupRestoreResult{}, err
	}
	var result BackupRestoreResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return BackupRestoreResult{}, errors.New("同步恢复响应无法读取")
	}
	return result, nil
}
