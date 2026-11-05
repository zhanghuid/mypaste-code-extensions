package main

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.ferry/src/internal/ferry"
)

// hostSim is the smallest thing that behaves like the host on the other end
// of the line protocol: it records each host call and answers storage reads
// with the host's absent-key result.
type hostSim struct {
	calls  []hostCall
	final  []string
	closed chan struct{}
}

func (h *hostSim) serve(input *bufio.Reader, output *bufio.Writer) {
	defer close(h.closed)
	for {
		line, err := input.ReadBytes('\n')
		if len(line) > 0 {
			var envelope struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(line, &envelope) != nil || envelope.Type != "hostCall" {
				h.final = append(h.final, string(line))
			} else {
				var call hostCall
				if json.Unmarshal(line, &call) != nil {
					return
				}
				h.calls = append(h.calls, call)
				result := hostCallResult{Type: "hostCallResult", ID: call.ID,
					OK: false, Error: errMissingStorage.Error()}
				encoded, _ := json.Marshal(result)
				output.Write(append(encoded, '\n'))
				output.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// runPlugin wires the plugin's stdin/stdout to a host simulator and returns
// the response line the host would read last.
func runPlugin(t *testing.T, request invocation) (string, *hostSim) {
	t.Helper()
	pluginInput, hostOutput := io.Pipe()
	hostInput, pluginOutput := io.Pipe()
	host := &hostSim{closed: make(chan struct{})}
	go host.serve(bufio.NewReader(hostInput), bufio.NewWriter(hostOutput))

	writer := bufio.NewWriter(pluginOutput)
	text, err := run(bufio.NewReader(pluginInput), writer, request)
	writer.WriteString(respond(request.ID, text, err))
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	pluginOutput.Close()
	<-host.closed
	if len(host.final) != 1 {
		t.Fatalf("final output lines = %#v", host.final)
	}
	return host.final[0], host
}

func TestPushWithoutRelayRoundTripsOverTheLineProtocol(t *testing.T) {
	response, host := runPlugin(t, invocation{
		ProtocolVersion: 2, ID: "r1", Method: "invoke", CommandID: ferry.CommandPush,
		DeadlineUnixMs: time.Now().Add(5 * time.Second).UnixMilli(),
	})
	var decoded struct {
		ID     string `json:"id"`
		OK     bool   `json:"ok"`
		Result struct {
			Output string `json:"output"`
		} `json:"result"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(response), &decoded); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, response)
	}
	if decoded.ID != "r1" || !decoded.OK {
		t.Fatalf("response = %q", response)
	}
	if !strings.Contains(decoded.Result.Output, "还没有配置中继地址") {
		t.Fatalf("output = %q", decoded.Result.Output)
	}
	if len(host.calls) != 1 || host.calls[0].Service != "storage.plugin" ||
		host.calls[0].Method != "read" {
		t.Fatalf("host calls = %#v", host.calls)
	}
	var params struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(host.calls[0].Params, &params); err != nil ||
		params.Key != ferry.StateKey {
		t.Fatalf("storage params = %s", host.calls[0].Params)
	}
}

func TestTheProcessRefusesABadInvocation(t *testing.T) {
	for _, request := range []invocation{
		{ProtocolVersion: 1, ID: "r1", Method: "invoke", CommandID: ferry.CommandStatus},
		{ProtocolVersion: 2, ID: "r2", Method: "run", CommandID: ferry.CommandStatus},
		{ProtocolVersion: 2, ID: "r3", Method: "invoke", CommandID: "sync.unknown"},
	} {
		request.DeadlineUnixMs = time.Now().Add(5 * time.Second).UnixMilli()
		response, _ := runPlugin(t, request)
		var decoded struct {
			OK    bool `json:"ok"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(response), &decoded); err != nil {
			t.Fatalf("response is not JSON: %v (%q)", err, response)
		}
		if decoded.OK || decoded.Error == nil {
			t.Fatalf("a bad invocation was accepted: %q", response)
		}
	}
}

func TestActionArgumentsDecodeTheSameWayEveryTime(t *testing.T) {
	encoded := "WyJhYmMiLCJkZWYiXQ" // ["abc","def"] without padding
	arguments, err := decodeArguments(encoded)
	if err != nil || len(arguments) != 2 || arguments[0] != "abc" || arguments[1] != "def" {
		t.Fatalf("arguments = %#v, err = %v", arguments, err)
	}
	for _, bad := range []string{
		"!!!",
		"e30",                        // {}
		"WzEsMl0",                    // [1,2]
		"WzEsMiwzLDQsNSw2LDcsOCw5XQ", // nine entries
	} {
		if _, err := decodeArguments(bad); err == nil {
			t.Fatalf("decodeArguments(%q) was accepted", bad)
		}
	}
}

func TestRespondNeverReturnsResultWithAnError(t *testing.T) {
	line := respond("r1", "ignored", io.ErrUnexpectedEOF)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(line), &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["result"]; ok {
		t.Fatalf("an error response carried a result: %s", line)
	}
	if decoded["ok"] != false || decoded["id"] != "r1" {
		t.Fatalf("response = %s", line)
	}
}
