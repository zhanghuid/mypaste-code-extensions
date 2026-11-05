// Package ferry is the sync engine behind the bundled com.mypaste.ferry
// extension (D-1027, D-1028). It owns device identity, pairing, the encrypted
// envelope, the offline queue and the push/pull state machine.
//
// The engine never touches the file system, the clipboard or a socket. It asks
// the host through four narrow interfaces (Storage, Payload, Clipboard and
// Network); cmd/mypaste-ferry implements them on the plugin line protocol and
// tests implement them in memory. Keeping the boundary here is what lets the
// same code run as a plugin subprocess and under httptest against the real
// relay without a second implementation of the protocol.
package ferry

import (
	"context"
	"errors"
	"time"
)

// ProtocolVersion is the envelope version carried inside every encrypted
// chunk.
const ProtocolVersion = 1

const (
	// StateKey is the single storage object the engine owns. Keeping identity,
	// peers, queue and inbound chunks in one object keeps one invocation at one
	// read and one write, which matters against the 16-host-call budget.
	StateKey = "state.json"

	// MaxHostCalls is the host's per-invocation ceiling (PLUGINS.md 5.9). The
	// engine's own limit leaves one call for the final state write.
	MaxHostCalls = 16

	// MaxPayloadBytes is the text/HTML ceiling (D-1026). Text and rich text
	// stay bounded by it; images and files use MaxMediaPayloadBytes.
	MaxPayloadBytes = 1 << 20

	// MaxMediaPayloadBytes is the largest image or file one clipboard-trigger
	// invocation can transfer (0.13.0). entry.payload reads 128 KiB per call
	// and one invocation has MaxHostCalls calls; after the state load, the
	// info call, one interim save and the final write, twelve reads fit, so
	// 1.5 MiB is the largest payload that can always complete within budget.
	// entry.payload only answers for the entry the invocation carries, so a
	// larger payload cannot continue in a later trigger (D-1032 rationale);
	// the push refuses it with an actionable error instead of truncating.
	MaxMediaPayloadBytes = 1536 << 10

	// InboundGroupTTL is how long a partially received group is kept. Chunks
	// arrive on the one-minute pull cadence, and the relay keeps undelivered
	// messages for days, so one hour is generous; past it the group is voided
	// whole rather than applying a truncated payload.
	InboundGroupTTL = time.Hour

	// MaxManifestBytes bounds the directory manifest (D-1032). Sixty-four
	// files with 200-byte names and digests stay far below this.
	MaxManifestBytes = 32 << 10

	// MaxTransferFiles mirrors the host's files cap for one landing batch.
	// It is repeated here like MaxEntryPayloadChunk: the host enforces it,
	// the engine needs it to refuse impossible transfers early.
	MaxTransferFiles = 64

	// MaxStagedCommitRetry caps how many staging attempts one pull may start
	// so a persistently failing commit cannot consume the whole budget.
	MaxStagedCommits = ApplyBatch

	// MaxPlaintextChunk is the largest plaintext one relay message carries.
	// A chunk is sealed (+12 nonce, +16 tag), then base64 inside the relay
	// request: 190 KiB stays below the 256 KiB host request cap and the
	// 200 KiB relay ciphertext cap. 192 KiB does not fit either cap.
	MaxPlaintextChunk = 190 << 10

	// Queue bounds. The queue lives in the state object, so its cap also keeps
	// that object below the 8 MiB storage-file limit.
	QueueMaxBytes = 4 << 20
	QueueMaxItems = 32

	// Applied bounds the dedupe memory. A relay message older than this many
	// applied IDs is long past its three-day TTL.
	MaxAppliedIDs    = 1000
	MaxAppliedGroups = 500

	// RecentTransfers is how many transfer records the status JSON exposes.
	RecentTransfers = 20

	// Inbound bounds partially assembled groups.
	InboundMaxGroups = 8
	InboundMaxBytes  = 4 << 20

	// PullBatch is how many mailbox messages one invocation may inspect;
	// ApplyBatch is how many complete groups it may write back. Both keep the
	// per-invocation host-call budget under the host ceiling.
	PullBatch  = 8
	ApplyBatch = 4

	// DrainBatch is how many queued outbound messages one invocation sends.
	DrainBatch = 4
)

// ErrBudget means this invocation has used its host-call or time budget. The
// command persists what it has and returns; the next trigger continues.
var ErrBudget = errors.New("本次同步调用的预算已用完")

// ErrNoRelay means relayUrl is unset. It is a setup state, not a failure.
var ErrNoRelay = errors.New("还没有配置中继地址")

// Storage is the host's storage.plugin service. Missing keys are (nil, false,
// nil), not an error.
type Storage interface {
	Read(ctx context.Context, key string) ([]byte, bool, error)
	Write(ctx context.Context, key string, data []byte) error
	Delete(ctx context.Context, key string) error
}

// Payload is entry.payload for the entry this invocation carries.
type Payload interface {
	Info(ctx context.Context) (PayloadInfo, error)
	Read(ctx context.Context, offset, length int64) ([]byte, error)
}

// PayloadInfo mirrors the host's entry.payload info result.
type PayloadInfo struct {
	MIME        string
	Total       int64
	SHA256      string
	DisplayName string
}

// Clipboard is the structured clipboard write (D-1026, D-1033). The host
// applies every write through WriteAndBaseline, so a received write never
// loops back as a local copy. Write is the one-call path for text and rich
// text; Stage and Commit move a large image or file across the line protocol
// in bounded chunks before the host applies it once.
type Clipboard interface {
	Write(ctx context.Context, payload WritePayload) error
	Stage(ctx context.Context, chunk StagedChunk) (int64, error)
	Commit(ctx context.Context, commit Commit) (CommitResult, error)
}

// StagedChunk is one bounded piece of a staged payload. Offset zero resets
// the buffer, so an invocation that died mid-staging can start over under the
// same id.
type StagedChunk struct {
	ID     string
	Offset int64
	Data   []byte
}

// Commit names the staged buffer to apply and the digest the engine computed
// over its bytes. Exactly one branch is set.
type Commit struct {
	Image *CommitImage
	Files *CommitFiles
}

type CommitImage struct {
	ID     string
	SHA256 string
}

type CommitFiles struct {
	ID     string
	SHA256 string
	Files  []CommitFile
}

type CommitFile struct {
	Name string
	Size int64
}

// CommitResult mirrors the host's answer: Files counts landed files,
// Cancelled means the user declined and nothing was written.
type CommitResult struct {
	Files     int
	Cancelled bool
}

// WritePayload is the closed subset 0.12.0 uses.
type WritePayload struct {
	Kind string // "text" or "rich_text"
	Text string
	HTML string
}

// Request is one host-mediated HTTPS request.
type Request struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

// Response is the bounded result of one request.
type Response struct {
	Status int
	Body   []byte
}

// Network is the host's network.outbound service.
type Network interface {
	Do(ctx context.Context, request Request) (Response, error)
}

// Settings is the closed setting surface the manifest declares. Auto-sync's
// pause is not here: it is the engine's own state, toggled by the menu's
// sync.autosync command, because settings belong to the host and the
// extension has no write path to them (0.14.0).
type Settings struct {
	RelayURL   string
	DeviceName string
}

// SettingsFromProjects the host's decoded settings map into the engine's
// closed struct. Unknown keys are ignored; the host validated them already.
func SettingsFrom(values map[string]any) Settings {
	var settings Settings
	if value, ok := values["relayurl"].(string); ok {
		settings.RelayURL = value
	}
	if value, ok := values["devicename"].(string); ok {
		settings.DeviceName = value
	}
	return settings
}

// Host bundles the four services, the clock and the invocation budget.
type Host struct {
	Store     Storage
	Payload   Payload
	Clipboard Clipboard
	Network   Network

	Now    func() time.Time
	Budget *Budget
}

// NewHost builds a host with a fresh budget.
func NewHost(store Storage, payload Payload, clipboard Clipboard, network Network,
	now func() time.Time, deadline time.Time,
) *Host {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Host{
		Store: store, Payload: payload, Clipboard: clipboard, Network: network,
		Now: now, Budget: NewBudget(MaxHostCalls, deadline),
	}
}

// NowTime returns the host clock in UTC.
func (h *Host) NowTime() time.Time {
	if h == nil || h.Now == nil {
		return time.Now().UTC()
	}
	return h.Now().UTC()
}

// Budget tracks host calls and the invocation deadline.
type Budget struct {
	Limit    int
	Used     int
	Deadline time.Time
}

// NewBudget builds a budget. A zero limit means "no explicit limit"; the
// host's hard ceiling still applies.
func NewBudget(limit int, deadline time.Time) *Budget {
	if limit <= 0 {
		limit = MaxHostCalls
	}
	return &Budget{Limit: limit, Deadline: deadline}
}

// Take reserves one host call, keeping one call in reserve for the final
// state write. It refuses once the budget or the deadline is reached.
func (b *Budget) Take() error {
	if b == nil {
		return nil
	}
	if b.Used >= b.Limit-1 {
		return ErrBudget
	}
	if !b.Deadline.IsZero() && time.Until(b.Deadline) < 1200*time.Millisecond {
		return ErrBudget
	}
	b.Used++
	return nil
}

// Finish reserves the last host call (the final state write).
func (b *Budget) Finish() error {
	if b == nil {
		return nil
	}
	if b.Used >= b.Limit {
		return ErrBudget
	}
	if !b.Deadline.IsZero() && time.Until(b.Deadline) < 1200*time.Millisecond {
		return ErrBudget
	}
	b.Used++
	return nil
}

// Remaining reports how many ordinary calls are still available.
func (b *Budget) Remaining() int {
	if b == nil {
		return MaxHostCalls
	}
	remaining := b.Limit - 1 - b.Used
	if remaining < 0 {
		return 0
	}
	return remaining
}
