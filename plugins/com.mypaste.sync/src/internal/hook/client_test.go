package hook

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// harness feeds one request line and one answer line, then exposes what the
// client wrote so the wire shape can be asserted.
func harness(requestLine, answer string) (*Client, *bytes.Buffer) {
	output := &bytes.Buffer{}
	client := NewClient(strings.NewReader(requestLine+"\n"+answer+"\n"), output)
	if _, err := client.ReadRequestLine(); err != nil {
		panic(err)
	}
	return client, output
}

func TestHostCallWireShape(t *testing.T) {
	client, output := harness(
		`{"protocolVersion":2,"id":"7","method":"invoke"}`,
		`{"type":"hostCallResult","id":"s1","ok":true,"result":{"data":"aGk="}}`,
	)
	data, ok, err := client.StorageRead(context.Background(), "settings.json")
	if err != nil || !ok || string(data) != "hi" {
		t.Fatalf("read: %q %v %v", data, ok, err)
	}
	var call map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &call); err != nil {
		t.Fatalf("host call is not one JSON line: %v", err)
	}
	if call["type"] != "hostCall" || call["id"] != "s1" ||
		call["service"] != "storage.plugin" || call["method"] != "read" {
		t.Fatalf("call: %v", call)
	}
	params, _ := call["params"].(map[string]any)
	if params["key"] != "settings.json" {
		t.Fatalf("params: %v", params)
	}
	if strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("host call must be exactly one line: %q", output.String())
	}
}

func TestStorageMissingIsNotAnError(t *testing.T) {
	client, _ := harness(
		`{}`,
		`{"type":"hostCallResult","id":"s1","ok":false,"error":"存储项不存在"}`,
	)
	data, ok, err := client.StorageRead(context.Background(), "settings.json")
	if err != nil || ok || data != nil {
		t.Fatalf("missing: %q %v %v", data, ok, err)
	}
}

func TestAssetChunkRejectsLengthMismatch(t *testing.T) {
	client, _ := harness(
		`{}`,
		`{"type":"hostCallResult","id":"s1","ok":true,"result":{"data":"`+
			base64.StdEncoding.EncodeToString([]byte("abc"))+`","bytes":4,"eof":true}}`,
	)
	if _, _, err := client.AssetChunk(context.Background(), 1, 0, 4); err == nil {
		t.Fatal("short chunk was accepted")
	}
}

func TestQueryKeepsNumbersExact(t *testing.T) {
	client, output := harness(
		`{}`,
		`{"type":"hostCallResult","id":"s1","ok":true,"result":{"columns":["n"],"rows":[[9007199254740993]]}}`,
	)
	rows, columns, truncated, err := client.Query(context.Background(), "SELECT n", nil, 1)
	if err != nil || truncated || len(columns) != 1 || len(rows) != 1 {
		t.Fatalf("query: %v %v %v %v", rows, columns, truncated, err)
	}
	number, ok := rows[0][0].(json.Number)
	if !ok || number.String() != "9007199254740993" {
		t.Fatalf("number: %#v", rows[0][0])
	}
	if !strings.Contains(output.String(), `"sql":"SELECT n"`) {
		t.Fatalf("query params: %s", output.String())
	}
}

func TestHostErrorIsReturned(t *testing.T) {
	client, _ := harness(
		`{}`,
		`{"type":"hostCallResult","id":"s1","ok":false,"error":"不允许设置同步请求头 x"}`,
	)
	_, err := client.BackupRequest(context.Background(), BackupRequest{URL: "https://e", Method: "GET"})
	if err == nil || !strings.Contains(err.Error(), "不允许") {
		t.Fatalf("error: %v", err)
	}
}

func TestUnexpectedMessageIsRejected(t *testing.T) {
	client, _ := harness(`{}`, `{"type":"somethingElse","id":"s1"}`)
	if _, err := client.Call(context.Background(), "storage.plugin", "read", map[string]string{"key": "k"}); err == nil {
		t.Fatal("unexpected message was accepted")
	}
}
