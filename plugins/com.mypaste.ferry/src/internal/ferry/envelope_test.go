package ferry

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

func testDevice(t *testing.T, name string) *device {
	t.Helper()
	created, err := newDevice(name, time.Unix(1762267200, 0))
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func TestSessionKeyMatchesOnBothSidesAndDiffersByDirection(t *testing.T) {
	alice := testDevice(t, "alice")
	bob := testDevice(t, "bob")

	aliceSecret, err := sharedSecret(alice.ExchangePrivate, bob.ExchangePublic)
	if err != nil {
		t.Fatal(err)
	}
	bobSecret, err := sharedSecret(bob.ExchangePrivate, alice.ExchangePublic)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(aliceSecret, bobSecret) {
		t.Fatal("the two sides derived different X25519 secrets")
	}
	forward, err := sessionKey(aliceSecret, alice.DeviceID, bob.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	reverse, err := sessionKey(aliceSecret, bob.DeviceID, alice.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(forward, reverse) {
		t.Fatal("both directions share one key")
	}
	again, err := sessionKey(bobSecret, alice.DeviceID, bob.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(forward, again) {
		t.Fatal("the receiver cannot derive the sender's key")
	}
	if len(forward) != 32 {
		t.Fatalf("key length = %d", len(forward))
	}
}

func TestChunkRoundTripAndTamperRejection(t *testing.T) {
	alice := testDevice(t, "alice")
	bob := testDevice(t, "bob")
	peer := peerRecord{DeviceID: bob.DeviceID, SigningKey: bob.SigningPublic,
		ExchangeKey: bob.ExchangePublic}
	payload := bytes.Repeat([]byte("hello ferry "), 40)

	wire, err := alice.sealChunk(peer, "message-1", "group-1", 0, 1,
		"text", "text/plain; charset=utf-8", "", strings.Repeat("a", 64), payload)
	if err != nil {
		t.Fatal(err)
	}
	header, data, err := bob.openChunk(peerRecord{DeviceID: alice.DeviceID,
		SigningKey: alice.SigningPublic, ExchangeKey: alice.ExchangePublic},
		"message-1", wire)
	if err != nil {
		t.Fatal(err)
	}
	if header.GroupID != "group-1" || header.Total != 1 || header.Kind != "text" {
		t.Fatalf("header = %#v", header)
	}
	if !bytes.Equal(data, payload) {
		t.Fatal("payload changed in transit")
	}

	// A different message ID means different AAD, so the message must not open
	// even though the sender's keys are unchanged.
	if _, _, err := bob.openChunk(peerRecord{DeviceID: alice.DeviceID,
		SigningKey: alice.SigningPublic, ExchangeKey: alice.ExchangePublic},
		"message-2", wire); err == nil {
		t.Fatal("a message opened under a different message ID")
	}

	tampered := append([]byte(nil), wire...)
	tampered[len(tampered)-1] ^= 0x80
	_, _, tamperErr := bob.openChunk(peerRecord{DeviceID: alice.DeviceID,
		SigningKey: alice.SigningPublic, ExchangeKey: alice.ExchangePublic},
		"message-1", tampered)
	if tamperErr == nil {
		t.Fatal("a flipped ciphertext bit was accepted")
	}
	if strings.Contains(tamperErr.Error(), "hello ferry") {
		t.Fatal("error text leaked the payload")
	}

	other := testDevice(t, "mallory")
	if _, _, err := other.openChunk(peerRecord{DeviceID: alice.DeviceID,
		SigningKey: alice.SigningPublic, ExchangeKey: alice.ExchangePublic},
		"message-1", wire); err == nil {
		t.Fatal("a third device opened a message addressed to bob")
	}
}

func TestFingerprintIsStableOnBothSides(t *testing.T) {
	alice := testDevice(t, "alice")
	bob := testDevice(t, "bob")
	left := Fingerprint(alice.DeviceID, alice.ExchangePublic, bob.DeviceID, bob.ExchangePublic)
	right := Fingerprint(bob.DeviceID, bob.ExchangePublic, alice.DeviceID, alice.ExchangePublic)
	if left != right {
		t.Fatalf("fingerprints differ: %q vs %q", left, right)
	}
	groups := strings.Split(left, "-")
	if len(groups) != 8 {
		t.Fatalf("fingerprint = %q", left)
	}
	for _, group := range groups {
		if len(group) != 4 {
			t.Fatalf("group %q is not four characters", group)
		}
		if strings.ContainsAny(group, "ILOU") {
			t.Fatalf("group %q contains a confusable letter", group)
		}
	}
	carol := testDevice(t, "carol")
	if other := Fingerprint(alice.DeviceID, alice.ExchangePublic,
		carol.DeviceID, carol.ExchangePublic); other == left {
		t.Fatal("two different pairs share a fingerprint")
	}
}

func TestAssembleChunksRequiresEveryChunk(t *testing.T) {
	alice := testDevice(t, "alice")
	bob := testDevice(t, "bob")
	peer := peerRecord{DeviceID: bob.DeviceID, SigningKey: bob.SigningPublic,
		ExchangeKey: bob.ExchangePublic}
	receiver := peerRecord{DeviceID: alice.DeviceID, SigningKey: alice.SigningPublic,
		ExchangeKey: alice.ExchangePublic}

	payload := bytes.Repeat([]byte("chunked "), MaxPlaintextChunk/4)
	chunks := splitPayload(payload)
	if len(chunks) < 2 {
		t.Fatalf("payload split into %d chunks", len(chunks))
	}
	var inbound []inboundChunk
	for index, chunk := range chunks {
		id := "message-" + string(rune('a'+index))
		wire, err := alice.sealChunk(peer, id, "group-1", index, len(chunks),
			"text", "text/plain", "", sha256Hex(payload), chunk)
		if err != nil {
			t.Fatal(err)
		}
		header, data, err := bob.openChunk(receiver, id, wire)
		if err != nil {
			t.Fatal(err)
		}
		inbound = append(inbound, inboundChunk{Header: header, Data: data,
			MessageID: id, SenderID: alice.DeviceID})
	}

	partial := append([]inboundChunk(nil), inbound[1:]...)
	if _, err := assembleChunks(partial); err == nil ||
		!strings.Contains(err.Error(), "缺少分块") {
		t.Fatalf("partial assembly error = %v", err)
	}
	if assembled, err := assembleChunks(inbound); err != nil {
		t.Fatal(err)
	} else if !bytes.Equal(assembled.Data, payload) || assembled.Kind != "text" {
		t.Fatal("assembled payload does not match")
	}

	damaged := append([]inboundChunk(nil), inbound...)
	damaged[0].Data = append([]byte(nil), damaged[0].Data...)
	damaged[0].Data[0] ^= 0x01
	if _, err := assembleChunks(damaged); err == nil {
		t.Fatal("a modified chunk passed the payload digest")
	}
}

func TestPairingMessageRoundTrip(t *testing.T) {
	inviter := testDevice(t, "inviter")
	joiner := testDevice(t, "joiner")

	wire, err := joiner.sealPairingMessage(inviter.DeviceID, inviter.ExchangePublic,
		"pair-1", "123456", "joiner")
	if err != nil {
		t.Fatal(err)
	}
	message, err := inviter.openPairingMessage("pair-1", wire)
	if err != nil {
		t.Fatal(err)
	}
	if message.Code != "123456" || message.SenderID != joiner.DeviceID ||
		message.Name != "joiner" {
		t.Fatalf("message = %#v", message)
	}
	if !bytes.Equal(message.SigningKey, joiner.SigningPublic) ||
		!bytes.Equal(message.ExchangeKey, joiner.ExchangePublic) {
		t.Fatal("pairing message does not carry the joiner's keys")
	}
	if _, err := inviter.openPairingMessage("pair-2", wire); err == nil {
		t.Fatal("a pairing message opened under a different ID")
	}
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
