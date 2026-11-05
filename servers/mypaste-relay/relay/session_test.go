package relay

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func deliverMessage(t *testing.T, relay *testRelay, sender *testDevice, recipient, messageID string, ciphertext []byte, ttlSeconds int) (*http.Response, []byte) {
	t.Helper()
	return relay.doJSON(sender, http.MethodPost, "/v1/mailbox/"+recipient,
		deliverBody(messageID, ciphertext, ttlSeconds))
}

func listMessages(t *testing.T, relay *testRelay, device *testDevice, query string) listResponse {
	t.Helper()
	target := "/v1/mailbox/" + device.id
	if query != "" {
		target += "?" + query
	}
	response, data := relay.doJSON(device, http.MethodGet, target, nil)
	expectStatus(t, response, data, http.StatusOK)
	return decodeInto[listResponse](t, data)
}

func TestMailboxDeliverListAndDelete(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	carol := newTestDevice(t, "Carol")
	relay.register(alice)
	relay.register(bob)
	relay.register(carol)

	messageID := newMessageID(t)
	ciphertext := []byte("opaque end-to-end encrypted envelope")
	response, data := deliverMessage(t, relay, alice, bob.id, messageID, ciphertext, 0)
	expectStatus(t, response, data, http.StatusCreated)
	delivered := decodeInto[deliverResponse](t, data)
	if delivered.MessageID != messageID || delivered.Duplicate {
		t.Fatalf("delivery response = %+v", delivered)
	}
	if !delivered.ReceivedAt.Equal(relay.clock.Now()) {
		t.Fatalf("receivedAt = %v", delivered.ReceivedAt)
	}
	if delivered.ExpiresAt.Sub(delivered.ReceivedAt) != defaultMessageTTL {
		t.Fatalf("default expiry = %v", delivered.ExpiresAt.Sub(delivered.ReceivedAt))
	}

	list := listMessages(t, relay, bob, "")
	if len(list.Messages) != 1 || list.More {
		t.Fatalf("mailbox = %+v", list)
	}
	got := list.Messages[0]
	if got.MessageID != messageID || got.SenderID != alice.id ||
		!bytes.Equal(got.Ciphertext, ciphertext) || got.Size != len(ciphertext) {
		t.Fatalf("listed message = %+v", got)
	}
	if got.ExpiresAt.Sub(got.ReceivedAt) != defaultMessageTTL {
		t.Fatalf("listed expiry = %v", got.ExpiresAt.Sub(got.ReceivedAt))
	}

	response, data = relay.doJSON(alice, http.MethodGet, "/v1/mailbox/"+bob.id, nil)
	expectError(t, response, data, http.StatusForbidden, "forbidden")

	response, data = relay.doJSON(carol, http.MethodGet, "/v1/mailbox/"+bob.id, nil)
	expectError(t, response, data, http.StatusForbidden, "forbidden")

	response, data = relay.doJSON(alice, http.MethodDelete, "/v1/mailbox/"+bob.id+"/"+messageID, nil)
	expectError(t, response, data, http.StatusForbidden, "forbidden")

	response, data = relay.doJSON(bob, http.MethodDelete, "/v1/mailbox/"+bob.id+"/"+messageID, nil)
	expectStatus(t, response, data, http.StatusNoContent)
	if len(data) != 0 {
		t.Fatalf("204 response has a body: %s", data)
	}

	list = listMessages(t, relay, bob, "")
	if len(list.Messages) != 0 {
		t.Fatalf("mailbox after delete = %+v", list)
	}

	response, data = relay.doJSON(bob, http.MethodDelete, "/v1/mailbox/"+bob.id+"/"+messageID, nil)
	expectError(t, response, data, http.StatusNotFound, "not_found")

	if _, err := os.Stat(filepath.Join(relay.dir, "mailboxes", bob.id, messageID+".json")); !isNotExist(err) {
		t.Fatalf("message file still exists: %v", err)
	}
}

func TestDeliveryValidation(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	cases := []struct {
		name    string
		target  string
		payload deliverRequest
		status  int
		code    string
	}{
		{
			name:    "invalid message id",
			target:  "/v1/mailbox/" + bob.id,
			payload: deliverRequest{MessageID: "short", Ciphertext: []byte("x")},
			status:  http.StatusBadRequest,
			code:    "bad_request",
		},
		{
			name:    "empty ciphertext",
			target:  "/v1/mailbox/" + bob.id,
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: nil},
			status:  http.StatusBadRequest,
			code:    "bad_request",
		},
		{
			name:    "ciphertext too large",
			target:  "/v1/mailbox/" + bob.id,
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: make([]byte, maxCiphertextBytes+1)},
			status:  http.StatusRequestEntityTooLarge,
			code:    "payload_too_large",
		},
		{
			name:    "ttl below one minute",
			target:  "/v1/mailbox/" + bob.id,
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: []byte("x"), TTLSeconds: 30},
			status:  http.StatusBadRequest,
			code:    "bad_request",
		},
		{
			name:    "ttl above seven days",
			target:  "/v1/mailbox/" + bob.id,
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: []byte("x"), TTLSeconds: int(maxMessageTTL.Seconds()) + 1},
			status:  http.StatusBadRequest,
			code:    "bad_request",
		},
		{
			name:    "unknown recipient",
			target:  "/v1/mailbox/" + newTestDevice(t, "Ghost").id,
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: []byte("x")},
			status:  http.StatusNotFound,
			code:    "unknown_recipient",
		},
		{
			name:    "malformed recipient",
			target:  "/v1/mailbox/not-a-device",
			payload: deliverRequest{MessageID: newMessageID(t), Ciphertext: []byte("x")},
			status:  http.StatusNotFound,
			code:    "unknown_recipient",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			response, data := relay.doJSON(alice, http.MethodPost, test.target, test.payload)
			expectError(t, response, data, test.status, test.code)
		})
	}

	t.Run("largest allowed ciphertext", func(t *testing.T) {
		response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t),
			bytes.Repeat([]byte("a"), maxCiphertextBytes), 0)
		expectStatus(t, response, data, http.StatusCreated)
	})

	t.Run("largest allowed ttl", func(t *testing.T) {
		response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t), []byte("x"),
			int(maxMessageTTL.Seconds()))
		expectStatus(t, response, data, http.StatusCreated)
		delivered := decodeInto[deliverResponse](t, data)
		if delivered.ExpiresAt.Sub(delivered.ReceivedAt) != maxMessageTTL {
			t.Fatalf("expiry = %v", delivered.ExpiresAt.Sub(delivered.ReceivedAt))
		}
	})
}

func TestDeliveryIsIdempotentAndRejectsConflicts(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	messageID := newMessageID(t)
	ciphertext := []byte("same bytes")
	response, data := deliverMessage(t, relay, alice, bob.id, messageID, ciphertext, 0)
	expectStatus(t, response, data, http.StatusCreated)

	response, data = deliverMessage(t, relay, alice, bob.id, messageID, ciphertext, 0)
	expectStatus(t, response, data, http.StatusOK)
	if !decodeInto[deliverResponse](t, data).Duplicate {
		t.Fatal("repeat delivery did not report duplicate")
	}
	if list := listMessages(t, relay, bob, ""); len(list.Messages) != 1 {
		t.Fatalf("duplicate delivery stored %d messages", len(list.Messages))
	}

	response, data = deliverMessage(t, relay, alice, bob.id, messageID, []byte("different bytes"), 0)
	expectError(t, response, data, http.StatusConflict, "message_conflict")

	carol := newTestDevice(t, "Carol")
	relay.register(carol)
	response, data = deliverMessage(t, relay, carol, bob.id, messageID, ciphertext, 0)
	expectError(t, response, data, http.StatusConflict, "message_conflict")
}

func TestListLimitAndOrder(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	ids := make([]string, 3)
	for index := range ids {
		ids[index] = newMessageID(t)
		response, data := deliverMessage(t, relay, alice, bob.id, ids[index], []byte{byte(index)}, 0)
		expectStatus(t, response, data, http.StatusCreated)
	}

	list := listMessages(t, relay, bob, "limit=2")
	if len(list.Messages) != 2 || !list.More {
		t.Fatalf("limited list = %+v", list)
	}
	if list.Messages[0].MessageID != ids[0] || list.Messages[1].MessageID != ids[1] {
		t.Fatalf("order = %s, %s", list.Messages[0].MessageID, list.Messages[1].MessageID)
	}

	for _, id := range ids[:2] {
		response, data := relay.doJSON(bob, http.MethodDelete, "/v1/mailbox/"+bob.id+"/"+id, nil)
		expectStatus(t, response, data, http.StatusNoContent)
	}
	list = listMessages(t, relay, bob, "")
	if len(list.Messages) != 1 || list.More || list.Messages[0].MessageID != ids[2] {
		t.Fatalf("remaining list = %+v", list)
	}

	for _, query := range []string{"limit=0", "limit=101", "limit=abc"} {
		response, data := relay.doJSON(bob, http.MethodGet, "/v1/mailbox/"+bob.id+"?"+query, nil)
		expectError(t, response, data, http.StatusBadRequest, "bad_request")
	}
}

func TestMessageExpiryAndCleanup(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	messageID := newMessageID(t)
	response, data := deliverMessage(t, relay, alice, bob.id, messageID, []byte("short lived"), 60)
	expectStatus(t, response, data, http.StatusCreated)
	path := filepath.Join(relay.dir, "mailboxes", bob.id, messageID+".json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("message file missing: %v", err)
	}

	relay.clock.Advance(61 * time.Second)
	if list := listMessages(t, relay, bob, ""); len(list.Messages) != 0 {
		t.Fatalf("expired message was returned: %+v", list)
	}
	if _, err := os.Stat(path); !isNotExist(err) {
		t.Fatalf("expired message file still exists: %v", err)
	}

	second := newMessageID(t)
	response, data = deliverMessage(t, relay, alice, bob.id, second, []byte("cleanup"), 0)
	expectStatus(t, response, data, http.StatusCreated)
	relay.clock.Advance(defaultMessageTTL + time.Second)
	if err := relay.server.Cleanup(relay.clock.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(relay.dir, "mailboxes", bob.id, second+".json")); !isNotExist(err) {
		t.Fatalf("background cleanup left the file: %v", err)
	}

	response, data = relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	relay.clock.Advance(defaultPairingTTL + time.Second)
	if err := relay.server.Cleanup(relay.clock.Now()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(relay.dir, "pairings"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expired pairing files remain: %d", len(entries))
	}
}

func TestMailboxQuotas(t *testing.T) {
	t.Run("message count", func(t *testing.T) {
		relay := newTestRelay(t)
		alice := newTestDevice(t, "Alice")
		bob := newTestDevice(t, "Bob")
		relay.register(alice)
		relay.register(bob)
		relay.server.store.maxMessages = 2

		for index := 0; index < 2; index++ {
			response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t), []byte("x"), 0)
			expectStatus(t, response, data, http.StatusCreated)
		}
		response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t), []byte("x"), 0)
		expectError(t, response, data, http.StatusInsufficientStorage, "mailbox_full")
		if !strings.Contains(string(data), "delete") {
			t.Fatalf("quota error is not actionable: %s", data)
		}
	})

	t.Run("byte size", func(t *testing.T) {
		relay := newTestRelay(t)
		alice := newTestDevice(t, "Alice")
		bob := newTestDevice(t, "Bob")
		relay.register(alice)
		relay.register(bob)
		relay.server.store.maxBytes = 100

		response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t), make([]byte, 60), 0)
		expectStatus(t, response, data, http.StatusCreated)
		response, data = deliverMessage(t, relay, alice, bob.id, newMessageID(t), make([]byte, 41), 0)
		expectError(t, response, data, http.StatusInsufficientStorage, "mailbox_full")
	})
}

func TestRestartPreservesMailboxesPairingsAndOrder(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock()

	first := startRelay(t, dir, clock)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	first.register(alice)
	first.register(bob)

	firstID := newMessageID(t)
	response, data := deliverMessage(t, first, alice, bob.id, firstID, []byte("before restart"), 0)
	expectStatus(t, response, data, http.StatusCreated)

	response, data = first.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	code := decodeInto[pairingResponse](t, data).Code
	first.close()

	second := startRelay(t, dir, clock)
	list := listMessages(t, second, bob, "")
	if len(list.Messages) != 1 || list.Messages[0].MessageID != firstID ||
		!bytes.Equal(list.Messages[0].Ciphertext, []byte("before restart")) {
		t.Fatalf("mailbox after restart = %+v", list)
	}

	response, data = second.doJSON(bob, http.MethodGet, "/v1/pairings/"+code, nil)
	expectStatus(t, response, data, http.StatusOK)

	secondID := newMessageID(t)
	response, data = deliverMessage(t, second, alice, bob.id, secondID, []byte("after restart"), 0)
	expectStatus(t, response, data, http.StatusCreated)
	list = listMessages(t, second, bob, "")
	if len(list.Messages) != 2 || list.Messages[0].MessageID != firstID || list.Messages[1].MessageID != secondID {
		t.Fatalf("order after restart = %+v", list)
	}

	clock.Advance(time.Second)
	response, data = second.doJSON(bob, http.MethodGet, "/v1/pairings/"+code, nil)
	expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")
	second.close()

	third := startRelay(t, dir, clock)
	response, data = third.doJSON(alice, http.MethodGet, "/v1/pairings/"+code, nil)
	expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")
}

func TestConcurrentDeliverAndList(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	const deliveries = 24
	const readers = 4
	ids := make([]string, deliveries)
	for index := range ids {
		ids[index] = newMessageID(t)
	}

	errors := make(chan error, deliveries+readers)
	var wait sync.WaitGroup
	for index := 0; index < deliveries; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			body, err := json.Marshal(deliverBody(ids[index], []byte(fmt.Sprintf("message-%02d", index)), 0))
			if err != nil {
				errors <- err
				return
			}
			request := relay.signed(alice, http.MethodPost, "/v1/mailbox/"+bob.id, body, relay.clock.Now().Unix())
			response, err := relay.http.Client().Do(request)
			if err != nil {
				errors <- err
				return
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, response.Body)
			if response.StatusCode != http.StatusCreated {
				errors <- fmt.Errorf("deliver status %d", response.StatusCode)
			}
		}(index)
	}
	for reader := 0; reader < readers; reader++ {
		wait.Add(1)
		go func(reader int) {
			defer wait.Done()
			for attempt := 0; attempt < 6; attempt++ {
				timestamp := relay.clock.Now().Unix() + int64(reader*10+attempt+1)
				request := relay.signed(bob, http.MethodGet, "/v1/mailbox/"+bob.id+"?limit=100", nil, timestamp)
				response, err := relay.http.Client().Do(request)
				if err != nil {
					errors <- err
					return
				}
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				if response.StatusCode != http.StatusOK {
					errors <- fmt.Errorf("list status %d: %s", response.StatusCode, body)
					return
				}
			}
		}(reader)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}

	relay.clock.Advance(time.Minute)
	list := listMessages(t, relay, bob, "limit=100")
	if len(list.Messages) != deliveries {
		t.Fatalf("stored messages = %d, want %d", len(list.Messages), deliveries)
	}
	seen := make(map[string]bool, deliveries)
	for _, message := range list.Messages {
		if seen[message.MessageID] {
			t.Fatalf("duplicate message %s", message.MessageID)
		}
		seen[message.MessageID] = true
	}
}

func TestLogsNeverContainBodiesKeysOrPairingCodes(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	marker := "CLIPBOARD-BODY-MARKER-DO-NOT-LOG"
	response, data := deliverMessage(t, relay, alice, bob.id, newMessageID(t), []byte(marker), 0)
	expectStatus(t, response, data, http.StatusCreated)

	response, data = relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	code := decodeInto[pairingResponse](t, data).Code

	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+code, nil)
	expectStatus(t, response, data, http.StatusOK)
	listMessages(t, relay, bob, "")

	logs := relay.logs.String()
	if strings.Contains(logs, marker) {
		t.Fatal("log contains clipboard ciphertext")
	}
	if strings.Contains(logs, code) {
		t.Fatal("log contains a pairing code")
	}
	if strings.Contains(logs, base64Key(alice.public)) || strings.Contains(logs, alice.id) {
		t.Fatal("log contains device identity material")
	}
}

func base64Key(key []byte) string {
	return base64.StdEncoding.EncodeToString(key)
}

func TestStoragePermissions(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)
	messageID := newMessageID(t)
	response, data := deliverMessage(t, relay, alice, bob.id, messageID, []byte("x"), 0)
	expectStatus(t, response, data, http.StatusCreated)

	for _, path := range []string{
		relay.dir,
		filepath.Join(relay.dir, "devices"),
		filepath.Join(relay.dir, "mailboxes"),
		filepath.Join(relay.dir, "pairings"),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode = %04o, want 0700", path, info.Mode().Perm())
		}
	}

	for _, path := range []string{
		filepath.Join(relay.dir, "devices", alice.id+".json"),
		filepath.Join(relay.dir, "mailboxes", bob.id, messageID+".json"),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode = %04o, want 0600", path, info.Mode().Perm())
		}
	}
}
