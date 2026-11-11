package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHandleReturnsTheDetectorDocument(t *testing.T) {
	reply := handle(&invocation{
		ID:        "call-1",
		Method:    "invoke",
		CommandID: commandID,
		Input:     &input{Type: "link", Text: "https://example.com/a.png"},
	})
	if !reply.OK || reply.Error != nil || reply.Result == nil {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.ID != "call-1" {
		t.Fatalf("reply id = %q", reply.ID)
	}
	var document struct {
		Schema int    `json:"schema"`
		MIME   string `json:"mime"`
		Label  string `json:"label"`
	}
	if err := json.Unmarshal([]byte(reply.Result.Output), &document); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, reply.Result.Output)
	}
	if document.Schema != 1 || document.MIME != "image/png" || document.Label == "" {
		t.Fatalf("document = %#v", document)
	}
}

func TestHandleReadsTheSelectionWhenThereIsNoInput(t *testing.T) {
	reply := handle(&invocation{
		CommandID: commandID,
		Selection: &selection{Text: "https://example.com/a.zip"},
	})
	if !reply.OK || !strings.Contains(reply.Result.Output, "application/zip") {
		t.Fatalf("reply = %#v", reply)
	}
}

func TestHandleAcceptsAnOmittedCommandID(t *testing.T) {
	reply := handle(&invocation{
		Input: &input{Text: "https://example.com/a.txt"},
	})
	if !reply.OK {
		t.Fatalf("reply = %#v", reply)
	}
}

func TestHandleRefusesUnknownCommandsAndEmptyInput(t *testing.T) {
	reply := handle(&invocation{
		CommandID: "other",
		Input:     &input{Text: "https://example.com/a.png"},
	})
	if reply.OK || reply.Error == nil || reply.Error.Code != errorCode {
		t.Fatalf("unknown command reply = %#v", reply)
	}
	reply = handle(&invocation{CommandID: commandID})
	if reply.OK || reply.Error == nil {
		t.Fatalf("empty input reply = %#v", reply)
	}
}

func TestDecodeInvocationRejectsForeignMethods(t *testing.T) {
	if _, err := decodeInvocation(`{"method":"render","input":{"text":"x"}}`); err == nil {
		t.Fatal("render method was accepted")
	}
	if _, err := decodeInvocation("   "); err == nil {
		t.Fatal("blank request was accepted")
	}
	if request, err := decodeInvocation(`{"method":"invoke","commandId":"detect"}`); err != nil ||
		request.CommandID != commandID {
		t.Fatalf("valid request = %#v, %v", request, err)
	}
}
