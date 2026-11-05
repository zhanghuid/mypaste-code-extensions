package ferry

import (
	"testing"
	"time"
)

func TestEnqueueDropsWholeGroupsAtBothCaps(t *testing.T) {
	value := newState()
	for group := 0; group < (QueueMaxItems/2)+4; group++ {
		groupID := "group-" + string(rune('a'+group%26)) + string(rune('a'+group/26))
		for index := 0; index < 2; index++ {
			value.enqueue([]outboundMessage{{
				MessageID: groupID + "-" + string(rune('0'+index)),
				GroupID:   groupID, Index: index, Total: 2,
				Ciphertext: []byte("payload"),
			}})
		}
	}
	if len(value.Queue) > QueueMaxItems {
		t.Fatalf("queue kept %d messages", len(value.Queue))
	}
	if value.Dropped == 0 {
		t.Fatal("no drop was recorded")
	}
	groups := map[string]int{}
	for _, message := range value.Queue {
		groups[message.GroupID]++
	}
	for group, count := range groups {
		if count != 2 {
			t.Fatalf("group %q kept %d of 2 messages", group, count)
		}
	}

	big := newState()
	big.enqueue([]outboundMessage{{
		MessageID: "large", GroupID: "large",
		Ciphertext: make([]byte, QueueMaxBytes+1),
	}})
	if len(big.Queue) != 0 {
		t.Fatal("an oversized group stayed in the queue")
	}
}

func TestDueQueueRespectsBackoff(t *testing.T) {
	now := time.Unix(1762267200, 0)
	value := newState()
	value.enqueue([]outboundMessage{
		{MessageID: "ready", GroupID: "g1", NextAttemptAt: now.Add(-time.Second).Unix()},
		{MessageID: "later", GroupID: "g2", NextAttemptAt: now.Add(30 * time.Second).Unix()},
	})
	due := value.dueQueue(now)
	if len(due) != 1 || value.Queue[due[0]].MessageID != "ready" {
		t.Fatalf("due = %#v", due)
	}
	if backoff(1) != 5*time.Second || backoff(2) != 10*time.Second {
		t.Fatalf("backoff(1)=%v backoff(2)=%v", backoff(1), backoff(2))
	}
	if backoff(200) != 5*time.Minute {
		t.Fatalf("backoff(200) = %v", backoff(200))
	}
}

func TestAppliedMemoryIsBounded(t *testing.T) {
	value := newState()
	for index := 0; index < MaxAppliedIDs+50; index++ {
		value.markApplied([]string{"message-" + string(rune('a'+index%26)) +
			string(rune('a'+index/26))}, "")
	}
	if len(value.Applied) > MaxAppliedIDs {
		t.Fatalf("applied kept %d ids", len(value.Applied))
	}
	value.markApplied([]string{"group-message"}, "group-1")
	if !value.isApplied("group-message") || !value.isGroupApplied("group-1") {
		t.Fatal("applied memory did not record the message and group")
	}
}

func TestStateRoundTripKeepsQueueAndDevice(t *testing.T) {
	value := newState()
	device, err := newDevice("test", time.Unix(1762267200, 0))
	if err != nil {
		t.Fatal(err)
	}
	value.Device = device
	value.enqueue([]outboundMessage{{MessageID: "m", GroupID: "g",
		Ciphertext: []byte("ciphertext")}})
	encoded, err := value.encode()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeState(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Device == nil || decoded.Device.DeviceID != device.DeviceID ||
		len(decoded.Queue) != 1 || !decoded.Device.valid() {
		t.Fatalf("decoded state = %#v", decoded)
	}
	if _, err := decodeState([]byte(`{"version":99}`)); err == nil {
		t.Fatal("an unknown state version was accepted")
	}
}

func TestRemovePeerForgetsItsInboundChunks(t *testing.T) {
	value := newState()
	value.Peers = []peerRecord{{DeviceID: "device-1", Trusted: true}}
	value.Inbound = []inboundChunk{
		{Header: chunkHeader{GroupID: "g1", Index: 0, Total: 2}, SenderID: "device-1"},
		{Header: chunkHeader{GroupID: "g2", Index: 0, Total: 1}, SenderID: "device-2"},
		{Header: chunkHeader{GroupID: "g1", Index: 1, Total: 2}, SenderID: "device-1"},
	}

	value.removePeer("device-1")
	if len(value.Peers) != 0 {
		t.Fatalf("the peer survived: %#v", value.Peers)
	}
	if len(value.Inbound) != 1 || value.Inbound[0].SenderID != "device-2" {
		t.Fatalf("the peer's inbound chunks survived: %#v", value.Inbound)
	}

	// An unknown device ID removes nothing.
	value.removePeer("device-1")
	if len(value.Peers) != 0 || len(value.Inbound) != 1 {
		t.Fatalf("an unknown removal changed state: %#v", value)
	}
}
