package ferry

import (
	"encoding/json"
	"errors"
	"sort"
	"time"
)

// peerRecord is one device this installation knows. A peer is usable for
// sending only after Trusted becomes true, which happens through
// sync.pair.confirm after the user compared the fingerprint.
type peerRecord struct {
	DeviceID    string `json:"deviceId"`
	Name        string `json:"name,omitempty"`
	SigningKey  []byte `json:"signingKey"`
	ExchangeKey []byte `json:"exchangeKey"`
	Fingerprint string `json:"fingerprint"`
	Trusted     bool   `json:"trusted"`
	PairedAt    int64  `json:"pairedAt"`
}

func (p peerRecord) valid() bool {
	return len(p.SigningKey) == 32 && len(p.ExchangeKey) == 32 &&
		deviceIDFor(p.SigningKey) == p.DeviceID
}

// pairingInvite is the code this device created and is waiting to have
// redeemed. The code itself is stored because the user must read it; it is
// never logged and expires within ten minutes (relay-enforced).
type pairingInvite struct {
	Code      string `json:"code"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// outboundMessage is one encrypted chunk waiting for delivery to one peer.
type outboundMessage struct {
	MessageID     string `json:"messageId"`
	PeerID        string `json:"peerId"`
	GroupID       string `json:"groupId"`
	Index         int    `json:"index"`
	Total         int    `json:"total"`
	Kind          string `json:"kind"`
	MIME          string `json:"mime"`
	Name          string `json:"name,omitempty"`
	PayloadSHA256 string `json:"payloadSha256"`
	Ciphertext    []byte `json:"ciphertext"`
	CreatedAt     int64  `json:"createdAt"`
	Attempts      int    `json:"attempts"`
	NextAttemptAt int64  `json:"nextAttemptAt"`
}

// transferRecord is one line of the bounded "recent transfers" list in the
// status JSON. It never carries content.
type transferRecord struct {
	Direction string `json:"direction"` // "in" or "out"
	Kind      string `json:"kind,omitempty"`
	Bytes     int    `json:"bytes,omitempty"`
	At        int64  `json:"at"`
	Peer      string `json:"peer,omitempty"`
	Result    string `json:"result,omitempty"` // "ok", "failed" or "dropped"
}

// relayState remembers the last relay outcome and registration. LastError is
// a short host-level phrase (for example "网络请求失败"), never a body.
type relayState struct {
	Origin         string `json:"origin,omitempty"`
	RegisteredAt   int64  `json:"registeredAt,omitempty"`
	RegisteredName string `json:"registeredName,omitempty"`
	Reachable      bool   `json:"reachable"`
	LastAttemptAt  int64  `json:"lastAttemptAt,omitempty"`
	LastError      string `json:"lastError,omitempty"`
}

// state is the single storage object (StateKey). Everything the extension
// needs between invocations lives here.
type state struct {
	Version       int               `json:"version"`
	Device        *device           `json:"device,omitempty"`
	Peers         []peerRecord      `json:"peers,omitempty"`
	Invite        *pairingInvite    `json:"invite,omitempty"`
	Queue         []outboundMessage `json:"queue,omitempty"`
	Inbound       []inboundChunk    `json:"inbound,omitempty"`
	Applied       []string          `json:"applied,omitempty"`
	AppliedGroups []string          `json:"appliedGroups,omitempty"`
	Recent        []transferRecord  `json:"recent,omitempty"`
	Relay         relayState        `json:"relay"`
	Dropped       int               `json:"dropped,omitempty"`
	// AutoSyncPaused is the pause switch the menu's own command owns (0.14.0).
	// It is not a manifest setting: settings belong to the host and the
	// extension has no write path to them, so the switch lives here — the one
	// place the engine already owns.
	AutoSyncPaused bool  `json:"autoSyncPaused,omitempty"`
	UpdatedAt      int64 `json:"updatedAt,omitempty"`
}

func newState() *state { return &state{Version: ProtocolVersion} }

func decodeState(data []byte) (*state, error) {
	if len(data) == 0 {
		return newState(), nil
	}
	var value state
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, errors.New("同步状态无法读取")
	}
	if value.Version != ProtocolVersion {
		return nil, errors.New("同步状态版本不受支持")
	}
	return &value, nil
}

func (s *state) encode() ([]byte, error) {
	s.Version = ProtocolVersion
	return json.Marshal(s)
}

func (s *state) peer(id string) *peerRecord {
	for index := range s.Peers {
		if s.Peers[index].DeviceID == id {
			return &s.Peers[index]
		}
	}
	return nil
}

// trustedPeers returns usable peers sorted by name for stable status output.
func (s *state) trustedPeers() []peerRecord {
	var peers []peerRecord
	for _, peer := range s.Peers {
		if peer.Trusted && peer.valid() {
			peers = append(peers, peer)
		}
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].DeviceID < peers[j].DeviceID })
	return peers
}

func (s *state) upsertPeer(peer peerRecord) {
	if existing := s.peer(peer.DeviceID); existing != nil {
		*existing = peer
		return
	}
	s.Peers = append(s.Peers, peer)
}

// removePeer forgets one device and everything it was still sending: its
// inbound chunks would otherwise complete into history for a device this side
// no longer trusts.
func (s *state) removePeer(deviceID string) {
	kept := s.Inbound[:0]
	for _, chunk := range s.Inbound {
		if chunk.SenderID != deviceID {
			kept = append(kept, chunk)
		}
	}
	s.Inbound = kept
	for index := range s.Peers {
		if s.Peers[index].DeviceID == deviceID {
			s.Peers = append(s.Peers[:index], s.Peers[index+1:]...)
			return
		}
	}
}

func (s *state) record(entry transferRecord) {
	s.Recent = append([]transferRecord{entry}, s.Recent...)
	if len(s.Recent) > RecentTransfers {
		s.Recent = s.Recent[:RecentTransfers]
	}
}

func (s *state) isApplied(messageID string) bool {
	for _, id := range s.Applied {
		if id == messageID {
			return true
		}
	}
	return false
}

func (s *state) isGroupApplied(groupID string) bool {
	for _, id := range s.AppliedGroups {
		if id == groupID {
			return true
		}
	}
	return false
}

func (s *state) markApplied(messageIDs []string, groupID string) {
	for _, id := range messageIDs {
		if !s.isApplied(id) {
			s.Applied = append(s.Applied, id)
		}
	}
	if len(s.Applied) > MaxAppliedIDs {
		s.Applied = s.Applied[len(s.Applied)-MaxAppliedIDs:]
	}
	if groupID != "" && !s.isGroupApplied(groupID) {
		s.AppliedGroups = append(s.AppliedGroups, groupID)
		if len(s.AppliedGroups) > MaxAppliedGroups {
			s.AppliedGroups = s.AppliedGroups[len(s.AppliedGroups)-MaxAppliedGroups:]
		}
	}
}

func (s *state) queueBytes() int {
	total := 0
	for _, message := range s.Queue {
		total += len(message.Ciphertext)
	}
	return total
}

// enqueue appends messages and keeps the queue inside both caps. Dropping is
// whole-group so a receiver never sees half of one payload: a partial group
// would sit in its inbound area until the TTL expired.
func (s *state) enqueue(messages []outboundMessage) {
	s.Queue = append(s.Queue, messages...)
	for len(s.Queue) > QueueMaxItems || s.queueBytes() > QueueMaxBytes {
		oldest := s.Queue[0]
		s.dropGroup(oldest.GroupID)
		s.Dropped++
	}
}

func (s *state) dropGroup(group string) {
	kept := s.Queue[:0]
	for _, message := range s.Queue {
		if message.GroupID != group {
			kept = append(kept, message)
		}
	}
	s.Queue = kept
}

// dueQueue returns the messages allowed to be sent now, oldest first.
func (s *state) dueQueue(now time.Time) []int {
	var indexes []int
	for index, message := range s.Queue {
		if message.NextAttemptAt <= now.Unix() {
			indexes = append(indexes, index)
		}
	}
	return indexes
}

func (s *state) removeQueued(messageID string) {
	kept := s.Queue[:0]
	for _, message := range s.Queue {
		if message.MessageID != messageID {
			kept = append(kept, message)
		}
	}
	s.Queue = kept
}

// backoff is the retry delay after attempt n (1-based): 5s, 10s, 20s, ... up
// to five minutes. The next interval trigger retries once it has passed.
func backoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	delay := 5 * time.Second << (attempts - 1)
	if delay > 5*time.Minute || delay <= 0 {
		delay = 5 * time.Minute
	}
	return delay
}

// inboundBytes is the memory the partially assembled groups occupy.
func (s *state) inboundBytes() int {
	total := 0
	for _, chunk := range s.Inbound {
		total += len(chunk.Data)
	}
	return total
}

// addInbound stores one decrypted chunk and prunes complete groups and the
// oldest groups beyond the caps. A group keeps the SeenAt of its first chunk,
// so its age is measured from when it started, not from the latest arrival.
func (s *state) addInbound(chunk inboundChunk) {
	if existing := s.groupSeenAt(chunk.Header.GroupID); existing != 0 {
		chunk.SeenAt = existing
	}
	s.Inbound = append(s.Inbound, chunk)
	groups := make(map[string]int)
	for _, item := range s.Inbound {
		groups[item.Header.GroupID]++
	}
	for len(s.Inbound) > 0 && (len(groups) > InboundMaxGroups || s.inboundBytes() > InboundMaxBytes) {
		oldest := s.Inbound[0].Header.GroupID
		kept := s.Inbound[:0]
		for _, item := range s.Inbound {
			if item.Header.GroupID != oldest {
				kept = append(kept, item)
			}
		}
		s.Inbound = kept
		groups = make(map[string]int)
		for _, item := range s.Inbound {
			groups[item.Header.GroupID]++
		}
	}
}

// groupSeenAt is the first-seen timestamp recorded for the group, or zero
// when the group is not stored (or predates the field).
func (s *state) groupSeenAt(group string) int64 {
	for _, item := range s.Inbound {
		if item.Header.GroupID == group && item.SeenAt != 0 {
			return item.SeenAt
		}
	}
	return 0
}

// voidExpiredInbound drops every incomplete group whose first chunk is older
// than the TTL and reports the voided group ids. Complete groups wait for
// their apply; they are bounded by the caps instead.
func (s *state) voidExpiredInbound(now time.Time) []string {
	cutoff := now.Add(-InboundGroupTTL).Unix()
	counts := make(map[string]int)
	totals := make(map[string]int)
	seenAt := make(map[string]int64)
	for _, chunk := range s.Inbound {
		group := chunk.Header.GroupID
		counts[group]++
		totals[group] = chunk.Header.Total
		if chunk.SeenAt != 0 && (seenAt[group] == 0 || chunk.SeenAt < seenAt[group]) {
			seenAt[group] = chunk.SeenAt
		}
	}
	var voided []string
	for group, count := range counts {
		if count < totals[group] && seenAt[group] != 0 && seenAt[group] < cutoff {
			voided = append(voided, group)
		}
	}
	sort.Strings(voided)
	for _, group := range voided {
		s.dropInbound(group)
	}
	return voided
}

// groupChunks returns the stored chunks of one group in index order.
func (s *state) groupChunks(group string) []inboundChunk {
	var chunks []inboundChunk
	for _, chunk := range s.Inbound {
		if chunk.Header.GroupID == group {
			chunks = append(chunks, chunk)
		}
	}
	sort.Slice(chunks, func(i, j int) bool {
		return chunks[i].Header.Index < chunks[j].Header.Index
	})
	return chunks
}

func (s *state) dropInbound(group string) {
	kept := s.Inbound[:0]
	for _, chunk := range s.Inbound {
		if chunk.Header.GroupID != group {
			kept = append(kept, chunk)
		}
	}
	s.Inbound = kept
}
