// Command mypaste-ferry is the out-of-process half of com.mypaste.ferry.
//
// It speaks the plugin v2 line protocol (PLUGINS.md section 4): it reads one
// invocation from stdin, performs host calls on stdout and prints one response
// line. All sync logic lives in internal/ferry; this file only translates
// between the line protocol and the engine's four interfaces. It is built into
// the extension package by scripts/build-ferry.sh.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.ferry/src/internal/ferry"
)

const invocationTimeout = 10 * time.Second

// errMissingStorage is the host's storage.plugin read result for an absent
// key. storage.Read maps exactly this phrase to (nil, false, nil).
var errMissingStorage = errors.New("存储项不存在")

type invocation struct {
	ProtocolVersion int            `json:"protocolVersion"`
	ID              string         `json:"id"`
	Method          string         `json:"method"`
	PluginID        string         `json:"pluginId"`
	ManifestDigest  string         `json:"manifestDigest"`
	CommandID       string         `json:"commandId"`
	Capabilities    []string       `json:"capabilities"`
	Settings        map[string]any `json:"settings"`
	Arguments       []string       `json:"arguments"`
	ActionArguments string         `json:"actionArguments,omitempty"`
	Trigger         *struct {
		ID    string `json:"id"`
		Kind  string `json:"kind"`
		Entry *struct {
			EntryID int64  `json:"entryId"`
			Kind    string `json:"kind"`
		} `json:"entry,omitempty"`
	} `json:"trigger,omitempty"`
	DeadlineUnixMs int64 `json:"deadlineUnixMs"`
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

// client owns the plugin's side of the line protocol.
type client struct {
	input  *bufio.Reader
	output *bufio.Writer
	entry  int64
	calls  int
}

func (c *client) call(ctx context.Context, service, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, ferry.ErrBudget
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, errors.New("无法编码宿主调用")
	}
	c.calls++
	call := hostCall{Type: "hostCall", ID: "f" + strconv.Itoa(c.calls),
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

// storage implements ferry.Storage.
type storage struct{ client *client }

func (s storage) Read(ctx context.Context, key string) ([]byte, bool, error) {
	raw, err := s.client.call(ctx, "storage.plugin", "read", map[string]string{"key": key})
	if err != nil {
		if err.Error() == errMissingStorage.Error() {
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

func (s storage) Write(ctx context.Context, key string, data []byte) error {
	_, err := s.client.call(ctx, "storage.plugin", "write", map[string]string{
		"key": key, "data": base64.StdEncoding.EncodeToString(data),
	})
	return err
}

func (s storage) Delete(ctx context.Context, key string) error {
	_, err := s.client.call(ctx, "storage.plugin", "delete", map[string]string{"key": key})
	return err
}

// payload implements ferry.Payload for the entry this invocation carries.
type payload struct{ client *client }

func (p payload) Info(ctx context.Context) (ferry.PayloadInfo, error) {
	raw, err := p.client.call(ctx, "entry.payload", "info",
		map[string]any{"entryId": p.client.entry})
	if err != nil {
		return ferry.PayloadInfo{}, err
	}
	var result struct {
		MIME        string `json:"mime"`
		Total       int64  `json:"total"`
		SHA256      string `json:"sha256"`
		DisplayName string `json:"displayName"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ferry.PayloadInfo{}, errors.New("条目信息无法读取")
	}
	return ferry.PayloadInfo{MIME: result.MIME, Total: result.Total,
		SHA256: result.SHA256, DisplayName: result.DisplayName}, nil
}

func (p payload) Read(ctx context.Context, offset, length int64) ([]byte, error) {
	raw, err := p.client.call(ctx, "entry.payload", "read", map[string]any{
		"entryId": p.client.entry, "offset": offset, "length": length,
	})
	if err != nil {
		return nil, err
	}
	var result struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, errors.New("条目内容无法读取")
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return nil, errors.New("条目内容无法读取")
	}
	return data, nil
}

// clipboard implements ferry.Clipboard.
type clipboard struct{ client *client }

func (c clipboard) Write(ctx context.Context, value ferry.WritePayload) error {
	var params any
	switch value.Kind {
	case "text":
		params = map[string]any{"text": value.Text}
	case "rich_text":
		params = map[string]any{"rich_text": map[string]any{"html": value.HTML}}
	default:
		return errors.New("不支持的剪贴板写入类型")
	}
	_, err := c.client.call(ctx, "clipboard.write", "write", params)
	return err
}

// Stage forwards one bounded chunk to the host's staging buffer (D-1033).
func (c clipboard) Stage(ctx context.Context, chunk ferry.StagedChunk) (int64, error) {
	raw, err := c.client.call(ctx, "clipboard.write", "stage", map[string]any{
		"id": chunk.ID, "offset": chunk.Offset,
		"data": base64.StdEncoding.EncodeToString(chunk.Data),
	})
	if err != nil {
		return 0, err
	}
	var result struct {
		Bytes int64 `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, errors.New("暂存响应无法读取")
	}
	return result.Bytes, nil
}

// Commit applies a staged buffer as one image or one file batch; the host
// re-verifies the digest before anything is written.
func (c clipboard) Commit(ctx context.Context, commit ferry.Commit) (ferry.CommitResult, error) {
	var params any
	switch {
	case commit.Image != nil:
		params = map[string]any{"image": map[string]any{
			"id": commit.Image.ID, "sha256": commit.Image.SHA256,
		}}
	case commit.Files != nil:
		files := make([]map[string]any, 0, len(commit.Files.Files))
		for _, file := range commit.Files.Files {
			files = append(files, map[string]any{"name": file.Name, "size": file.Size})
		}
		params = map[string]any{"files": map[string]any{
			"id": commit.Files.ID, "sha256": commit.Files.SHA256, "files": files,
		}}
	default:
		return ferry.CommitResult{}, errors.New("未知的暂存提交类型")
	}
	raw, err := c.client.call(ctx, "clipboard.write", "commit", params)
	if err != nil {
		return ferry.CommitResult{}, err
	}
	var result struct {
		Files     int  `json:"files"`
		Cancelled bool `json:"cancelled"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ferry.CommitResult{}, errors.New("提交响应无法读取")
	}
	return ferry.CommitResult{Files: result.Files, Cancelled: result.Cancelled}, nil
}

// network implements ferry.Network through the host proxy.
type network struct{ client *client }

func (n network) Do(ctx context.Context, request ferry.Request) (ferry.Response, error) {
	params := map[string]any{
		"url": request.URL, "method": request.Method, "headers": request.Headers,
	}
	if len(request.Body) > 0 {
		params["body"] = string(request.Body)
	}
	raw, err := n.client.call(ctx, "network.outbound", "request", params)
	if err != nil {
		return ferry.Response{}, err
	}
	var result struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ferry.Response{}, errors.New("网络响应无法读取")
	}
	return ferry.Response{Status: result.Status, Body: []byte(result.Body)}, nil
}

func main() {
	input := bufio.NewReaderSize(os.Stdin, 1<<20)
	output := bufio.NewWriter(os.Stdout)
	line, err := input.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		fmt.Fprintln(os.Stderr, "mypaste-ferry: 没有收到调用请求")
		os.Exit(1)
	}
	var request invocation
	if err := json.Unmarshal(line, &request); err != nil || request.ID == "" {
		fmt.Fprintln(os.Stderr, "mypaste-ferry: 调用请求无法读取")
		os.Exit(1)
	}
	text, runErr := run(input, output, request)
	output.WriteString(respond(request.ID, text, runErr))
	output.Flush()
}

func run(input *bufio.Reader, output *bufio.Writer, request invocation) (string, error) {
	if request.ProtocolVersion != 2 || request.Method != "invoke" {
		return "", errors.New("不支持的插件协议")
	}
	deadline := time.Now().Add(invocationTimeout)
	if request.DeadlineUnixMs > 0 {
		deadline = time.UnixMilli(request.DeadlineUnixMs)
	}
	client := &client{input: input, output: output}
	var trigger *ferry.TriggerInfo
	if request.Trigger != nil {
		client.entry = 0
		if request.Trigger.Entry != nil {
			client.entry = request.Trigger.Entry.EntryID
		}
		trigger = &ferry.TriggerInfo{EntryID: client.entry, Kind: request.Trigger.Kind}
	}
	arguments := request.Arguments
	if request.ActionArguments != "" {
		decoded, err := decodeArguments(request.ActionArguments)
		if err != nil {
			return "", err
		}
		arguments = decoded
	}
	host := ferry.NewHost(storage{client: client}, payload{client: client},
		clipboard{client: client}, network{client: client}, time.Now, deadline)
	engine := &ferry.Engine{
		Host:      host,
		Settings:  ferry.SettingsFrom(request.Settings),
		Trigger:   trigger,
		Arguments: arguments,
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	text, err := engine.Run(ctx, request.CommandID)
	if err != nil {
		return "", err
	}
	return text, nil
}

func decodeArguments(encoded string) ([]string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("动作参数无效")
	}
	var arguments []string
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	if err := decoder.Decode(&arguments); err != nil {
		return nil, errors.New("动作参数无效")
	}
	if len(arguments) > 8 {
		return nil, errors.New("动作参数过多")
	}
	return arguments, nil
}

func respond(id, output string, err error) string {
	response := map[string]any{"id": id, "ok": err == nil}
	if err != nil {
		response["error"] = map[string]string{"code": "failed", "message": err.Error()}
	} else {
		if !utf8Valid(output) {
			output = "同步结果不是有效文本"
		}
		response["result"] = map[string]any{"output": output}
	}
	line, err := json.Marshal(response)
	if err != nil {
		return `{"id":` + strconv.Quote(id) + `,"ok":false,"error":{"code":"failed","message":"无法编码响应"}}`
	}
	return string(line) + "\n"
}

func utf8Valid(text string) bool { return utf8.ValidString(text) }
