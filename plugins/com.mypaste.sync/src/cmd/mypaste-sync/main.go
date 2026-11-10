// Command mypaste-sync is the bundled sync extension's runtime. The host
// starts it for one invocation, writes one request line, answers its host
// calls, and reads one response line (PLUGINS.md §4). S3 signing, archive
// assembly, encryption, credentials and scheduling all live here; the host
// owns only the transport handles and the read-only data view.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/hook"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sync/src/internal/syncer"
)

// Version is the extension version written into archive manifests.
const Version = "1.0.0"

const (
	commandRequest = "sync.request"
	commandAuto    = "sync.auto"
)

type invocation struct {
	ID        string `json:"id"`
	Method    string `json:"method"`
	CommandID string `json:"commandId"`
	Deadline  int64  `json:"deadlineUnixMs"`
	Input     *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"input,omitempty"`
	Trigger *struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	} `json:"trigger,omitempty"`
}

type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	ID     string   `json:"id"`
	OK     bool     `json:"ok"`
	Result *result  `json:"result,omitempty"`
	Error  *failure `json:"error,omitempty"`
}

type result struct {
	Output string `json:"output,omitempty"`
}

func main() {
	client := hook.NewClient(os.Stdin, os.Stdout)
	line, err := client.ReadRequestLine()
	if err != nil {
		os.Exit(1)
	}
	var call invocation
	if err := json.Unmarshal(line, &call); err != nil || call.ID == "" {
		os.Exit(1)
	}
	ctx, cancel := deadline(call.Deadline)
	defer cancel()
	output, runErr := run(ctx, client, call)
	if runErr != nil {
		write(client, response{ID: call.ID, OK: false,
			Error: &failure{Code: "failed", Message: runErr.Error()}})
		return
	}
	write(client, response{ID: call.ID, OK: true, Result: &result{Output: output}})
}

func run(ctx context.Context, client *hook.Client, call invocation) (string, error) {
	engine := &syncer.Syncer{Client: client, Version: Version}
	switch call.CommandID {
	case commandRequest:
		if call.Input == nil || call.Input.Type != "text/plain" || call.Input.Text == "" {
			return "", errors.New("同步请求缺少参数")
		}
		return engine.Handle(ctx, call.Input.Text)
	case commandAuto:
		if call.Trigger == nil || call.Trigger.Kind != "interval" {
			return "", errors.New("自动同步只接受定时触发")
		}
		return engine.Auto(ctx)
	}
	return "", errors.New("未知的同步命令")
}

// write emits the one response line. A write failure has nowhere left to go.
func write(client *hook.Client, value response) {
	encoded, err := json.Marshal(value)
	if err != nil {
		os.Exit(1)
	}
	if err := client.WriteLine(encoded); err != nil {
		os.Exit(1)
	}
}

// deadline keeps two seconds of the host's budget for the final line, which
// carries the outcome the page reads.
func deadline(ms int64) (context.Context, context.CancelFunc) {
	if ms <= 0 {
		return context.WithTimeout(context.Background(), 10*time.Minute)
	}
	limit := time.Until(time.UnixMilli(ms)) - 2*time.Second
	if limit < time.Second {
		limit = time.Second
	}
	return context.WithTimeout(context.Background(), limit)
}
