package ferry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Command identifiers, all global so triggers and the menu can call them
// (D-1024, D-1029). The management commands (0.14.0) are local operations on
// the extension's own state; only push, pull, pair begin and pair redeem
// reach the relay.
const (
	CommandStatus      = "sync.status"
	CommandPush        = "sync.push"
	CommandPull        = "sync.pull"
	CommandPairBegin   = "sync.pair.begin"
	CommandPairRedeem  = "sync.pair.redeem"
	CommandPairConfirm = "sync.pair.confirm"
	CommandPairCancel  = "sync.pair.cancel"
	CommandUnpair      = "sync.unpair"
	CommandAutoSync    = "sync.autosync"
	CommandQueueClear  = "sync.queue.clear"
)

// DefaultDeviceName is used while the deviceName setting is empty.
const DefaultDeviceName = "MyPaste 设备"

var pairingCodePattern = regexp.MustCompile(`^[0-9]{6}$`)

// TriggerInfo is the entry a clipboard trigger carried.
type TriggerInfo struct {
	EntryID int64
	Kind    string
}

// Engine runs one command for one invocation. It is intentionally stateless
// between calls: everything it needs is in the host and the state object.
type Engine struct {
	Host      *Host
	Settings  Settings
	Trigger   *TriggerInfo
	Arguments []string
}

// Run dispatches one command and returns the plugin's output line.
func (e *Engine) Run(ctx context.Context, command string) (string, error) {
	state, err := e.load(ctx)
	if err != nil {
		return "", err
	}
	switch command {
	case CommandStatus:
		return e.status(state)
	case CommandPush:
		return e.push(ctx, state)
	case CommandPull:
		return e.pull(ctx, state)
	case CommandPairBegin:
		return e.pairBegin(ctx, state)
	case CommandPairRedeem:
		return e.pairRedeem(ctx, state)
	case CommandPairConfirm:
		return e.pairConfirm(ctx, state)
	case CommandPairCancel:
		return e.pairCancel(ctx, state)
	case CommandUnpair:
		return e.unpair(ctx, state)
	case CommandAutoSync:
		return e.autoSyncToggle(ctx, state)
	case CommandQueueClear:
		return e.queueClear(ctx, state)
	}
	return "", fmt.Errorf("未知的同步命令：%s", command)
}

// --- shared plumbing -------------------------------------------------------

func (e *Engine) load(ctx context.Context) (*state, error) {
	if err := e.Host.Budget.Take(); err != nil {
		return nil, err
	}
	data, ok, err := e.Host.Store.Read(ctx, StateKey)
	if err != nil {
		return nil, errors.New("同步状态读取失败")
	}
	if !ok {
		return newState(), nil
	}
	return decodeState(data)
}

// save writes the state without spending the reserved final host call, so a
// caller that still has work left (draining the queue, deleting messages) can
// persist its progress first.
func (e *Engine) save(ctx context.Context, state *state) error {
	if err := e.Host.Budget.Take(); err != nil {
		return err
	}
	return e.write(ctx, state)
}

// saveFinal is the last host call of an invocation. A failed write loses this
// invocation's progress but never content: relay messages stay until deleted,
// and the next trigger regenerates anything it could not persist.
func (e *Engine) saveFinal(ctx context.Context, state *state) error {
	if err := e.Host.Budget.Finish(); err != nil {
		return err
	}
	return e.write(ctx, state)
}

func (e *Engine) write(ctx context.Context, state *state) error {
	state.UpdatedAt = e.Host.NowTime().Unix()
	data, err := state.encode()
	if err != nil {
		return errors.New("同步状态无法编码")
	}
	if err := e.Host.Store.Write(ctx, StateKey, data); err != nil {
		return errors.New("同步状态写入失败")
	}
	return nil
}

func (e *Engine) deviceName() string {
	name := strings.TrimSpace(e.Settings.DeviceName)
	if name == "" {
		return DefaultDeviceName
	}
	if len(name) > 64 || strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 }) {
		return DefaultDeviceName
	}
	return name
}

func (e *Engine) ensureIdentity(state *state) error {
	name := e.deviceName()
	if state.Device == nil {
		device, err := newDevice(name, e.Host.NowTime())
		if err != nil {
			return err
		}
		state.Device = device
		return nil
	}
	if !state.Device.valid() {
		return errors.New("本机同步身份已损坏，请重置同步设置")
	}
	state.Device.Name = name
	return nil
}

// origin is the validated relay origin the host handed down in settings. An
// empty value is the normal "not configured yet" state (D-1031).
func (e *Engine) origin() string {
	return strings.TrimSuffix(strings.TrimSpace(e.Settings.RelayURL), "/")
}

func (e *Engine) client(state *state) *relayClient {
	return newRelayClient(e.origin(), state.Device,
		budgetNetwork{host: e.Host}, e.Host.NowTime)
}

// register makes this device known to the relay. Relay v1 refuses a repeated
// request signature, and the same registration sent twice in one second is
// byte-identical, so the engine registers only when the relay, the origin or
// the advertised name changed.
func (e *Engine) register(ctx context.Context, state *state, client *relayClient) error {
	name := e.deviceName()
	state.Relay.LastAttemptAt = e.Host.NowTime().Unix()
	if state.Relay.RegisteredAt != 0 && state.Relay.Origin == e.origin() &&
		state.Relay.RegisteredName == name {
		state.Relay.Reachable = true
		return nil
	}
	if err := client.register(ctx, name); err != nil {
		e.noteRelayFailure(state, err)
		return err
	}
	state.Relay.Origin = e.origin()
	state.Relay.RegisteredAt = e.Host.NowTime().Unix()
	state.Relay.RegisteredName = name
	state.Relay.Reachable = true
	state.Relay.LastError = ""
	return nil
}

func (e *Engine) noteRelayFailure(state *state, err error) {
	state.Relay.Reachable = false
	state.Relay.LastAttemptAt = e.Host.NowTime().Unix()
	if errors.Is(err, ErrBudget) {
		return
	}
	state.Relay.LastError = relayFailureText(err)
}

// relayFailureText keeps an actionable, content-free phrase for status.
func relayFailureText(err error) string {
	var refused *relayError
	if errors.As(err, &refused) {
		return refused.Error()
	}
	return err.Error()
}

// budgetNetwork charges one host call per request.
type budgetNetwork struct{ host *Host }

func (n budgetNetwork) Do(ctx context.Context, request Request) (Response, error) {
	if err := n.host.Budget.Take(); err != nil {
		return Response{}, err
	}
	return n.host.Network.Do(ctx, request)
}

func (e *Engine) payloadInfo(ctx context.Context) (PayloadInfo, error) {
	if err := e.Host.Budget.Take(); err != nil {
		return PayloadInfo{}, err
	}
	return e.Host.Payload.Info(ctx)
}

func (e *Engine) payloadRead(ctx context.Context, offset, length int64) ([]byte, error) {
	if err := e.Host.Budget.Take(); err != nil {
		return nil, err
	}
	return e.Host.Payload.Read(ctx, offset, length)
}

func (e *Engine) clipboardWrite(ctx context.Context, payload WritePayload) error {
	if err := e.Host.Budget.Take(); err != nil {
		return err
	}
	return e.Host.Clipboard.Write(ctx, payload)
}

func (e *Engine) clipboardStage(ctx context.Context, chunk StagedChunk) (int64, error) {
	if err := e.Host.Budget.Take(); err != nil {
		return 0, err
	}
	return e.Host.Clipboard.Stage(ctx, chunk)
}

func (e *Engine) clipboardCommit(ctx context.Context, commit Commit) (CommitResult, error) {
	if err := e.Host.Budget.Take(); err != nil {
		return CommitResult{}, err
	}
	return e.Host.Clipboard.Commit(ctx, commit)
}

// --- status ----------------------------------------------------------------

type statusDocument struct {
	Version   int              `json:"version"`
	Device    statusDevice     `json:"device"`
	Relay     statusRelay      `json:"relay"`
	Pairing   *statusPairing   `json:"pairing,omitempty"`
	Peers     []statusPeer     `json:"peers"`
	Queue     statusQueue      `json:"queue"`
	Transfers statusTransfers  `json:"transfers"`
	Recent    []transferRecord `json:"recent"`
	// AutoSyncPaused is the pause the menu's own switch controls. The flag
	// lives in the engine's state, so the menu panel and the status line read
	// the same one owner (0.14.0).
	AutoSyncPaused bool `json:"autoSyncPaused"`
}

type statusDevice struct {
	Name   string `json:"name"`
	ID     string `json:"id,omitempty"`
	Paired bool   `json:"paired"`
}

type statusRelay struct {
	Configured  bool   `json:"configured"`
	Host        string `json:"host,omitempty"`
	Reachable   bool   `json:"reachable"`
	LastError   string `json:"lastError,omitempty"`
	LastAttempt int64  `json:"lastAttempt,omitempty"`
}

type statusPairing struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

type statusPeer struct {
	// ID is the peer's device ID, the handle sync.unpair takes. It is the
	// same public identifier the relay already sees.
	ID          string `json:"id,omitempty"`
	Name        string `json:"name,omitempty"`
	Fingerprint string `json:"fingerprint"`
	Trusted     bool   `json:"trusted"`
}

type statusQueue struct {
	Pending int `json:"pending"`
	Bytes   int `json:"bytes"`
	Dropped int `json:"dropped"`
}

// statusTransfers is the read-only picture the menu consumes (0.14.0): groups
// still in flight in either direction and the recent failures. Names are the
// sender's display names, never paths; digests and ciphertext never appear.
type statusTransfers struct {
	Outbound []statusOutboundGroup `json:"outbound"`
	Inbound  []statusInboundGroup  `json:"inbound"`
	Failures []transferRecord      `json:"failures"`
}

type statusOutboundGroup struct {
	GroupID  string `json:"groupId"`
	Kind     string `json:"kind,omitempty"`
	Name     string `json:"name,omitempty"`
	Pending  int    `json:"pending"`
	Total    int    `json:"total"`
	Bytes    int    `json:"bytes"`
	Peers    int    `json:"peers"`
	QueuedAt int64  `json:"queuedAt,omitempty"`
}

type statusInboundGroup struct {
	GroupID      string `json:"groupId"`
	Kind         string `json:"kind,omitempty"`
	Name         string `json:"name,omitempty"`
	Received     int    `json:"received"`
	Total        int    `json:"total"`
	Bytes        int    `json:"bytes"`
	Peer         string `json:"peer,omitempty"`
	FirstSeen    int64  `json:"firstSeen,omitempty"`
	Complete     bool   `json:"complete"`
	PendingFiles int    `json:"pendingFiles,omitempty"`
}

// status is read-only: it never creates keys, never registers and never talks
// to the relay. The menu renders exactly this document (D-1023).
func (e *Engine) status(state *state) (string, error) {
	now := e.Host.NowTime()
	document := statusDocument{Version: ProtocolVersion, Recent: state.Recent}
	if document.Recent == nil {
		document.Recent = []transferRecord{}
	}
	document.Device.Name = e.deviceName()
	if state.Device != nil {
		document.Device.ID = state.Device.DeviceID
		document.Device.Name = state.Device.Name
	}
	document.Relay.Configured = e.origin() != ""
	document.Relay.Reachable = state.Relay.Reachable
	document.Relay.LastError = state.Relay.LastError
	document.Relay.LastAttempt = state.Relay.LastAttemptAt
	if document.Relay.Configured {
		document.Relay.Host = strings.TrimPrefix(e.origin(), "https://")
	}
	for _, peer := range state.Peers {
		if !peer.valid() {
			continue
		}
		document.Peers = append(document.Peers, statusPeer{
			ID:          peer.DeviceID,
			Name:        peer.Name,
			Fingerprint: peer.Fingerprint,
			Trusted:     peer.Trusted,
		})
		if peer.Trusted {
			document.Device.Paired = true
		}
	}
	if document.Peers == nil {
		document.Peers = []statusPeer{}
	}
	if invite := state.Invite; invite != nil && invite.ExpiresAt > now.Unix() {
		document.Pairing = &statusPairing{Code: invite.Code, ExpiresAt: invite.ExpiresAt}
	}
	document.Queue = statusQueue{
		Pending: len(state.Queue), Bytes: state.queueBytes(), Dropped: state.Dropped,
	}
	document.AutoSyncPaused = state.AutoSyncPaused
	document.Transfers = e.statusTransfers(state)
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", errors.New("状态无法编码")
	}
	return string(encoded), nil
}

// statusTransfers aggregates the queue and the inbound area into per-group
// lines. Both stay bounded by their caps, so the document cannot grow with
// history.
func (e *Engine) statusTransfers(state *state) statusTransfers {
	document := statusTransfers{
		Outbound: []statusOutboundGroup{},
		Inbound:  []statusInboundGroup{},
		Failures: []transferRecord{},
	}
	type outAggregate struct {
		group statusOutboundGroup
		peers map[string]bool
	}
	outbound := make(map[string]*outAggregate)
	var order []string
	for _, message := range state.Queue {
		aggregate := outbound[message.GroupID]
		if aggregate == nil {
			aggregate = &outAggregate{peers: map[string]bool{}, group: statusOutboundGroup{
				GroupID: message.GroupID, Kind: message.Kind, Name: message.Name,
				Total: message.Total, QueuedAt: message.CreatedAt,
			}}
			outbound[message.GroupID] = aggregate
			order = append(order, message.GroupID)
		}
		aggregate.group.Pending++
		aggregate.group.Bytes += len(message.Ciphertext)
		aggregate.peers[message.PeerID] = true
		if message.CreatedAt < aggregate.group.QueuedAt {
			aggregate.group.QueuedAt = message.CreatedAt
		}
	}
	sort.Strings(order)
	for _, groupID := range order {
		aggregate := outbound[groupID]
		aggregate.group.Peers = len(aggregate.peers)
		document.Outbound = append(document.Outbound, aggregate.group)
	}
	inbound := make(map[string]*statusInboundGroup)
	var inOrder []string
	for _, chunk := range state.Inbound {
		aggregate := inbound[chunk.Header.GroupID]
		if aggregate == nil {
			aggregate = &statusInboundGroup{
				GroupID: chunk.Header.GroupID, Kind: chunk.Header.Kind,
				Name: chunk.Header.Name, Total: chunk.Header.Total,
				Peer: chunk.SenderID, FirstSeen: chunk.SeenAt,
			}
			inbound[chunk.Header.GroupID] = aggregate
			inOrder = append(inOrder, chunk.Header.GroupID)
		}
		aggregate.Received++
		aggregate.Bytes += len(chunk.Data)
	}
	sort.Strings(inOrder)
	for _, groupID := range inOrder {
		aggregate := inbound[groupID]
		aggregate.Complete = aggregate.Received == aggregate.Total
		// A complete files group is waiting for the landing confirmation the
		// next pull will ask for.
		if aggregate.Complete && (aggregate.Kind == "file" || aggregate.Kind == "files") {
			aggregate.PendingFiles = 1
		}
		if peer := state.peer(aggregate.Peer); peer != nil {
			aggregate.Peer = peer.Name
		}
		document.Inbound = append(document.Inbound, *aggregate)
	}
	for _, entry := range state.Recent {
		if entry.Result == "failed" || entry.Result == "dropped" || entry.Result == "cancelled" {
			document.Failures = append(document.Failures, entry)
			if len(document.Failures) >= 10 {
				break
			}
		}
	}
	return document
}

// --- push ------------------------------------------------------------------

func (e *Engine) push(ctx context.Context, state *state) (string, error) {
	if state.AutoSyncPaused {
		return "同步已暂停", nil
	}
	if e.origin() == "" {
		return "还没有配置中继地址", nil
	}
	if e.Trigger == nil || e.Trigger.EntryID == 0 {
		return "本次触发没有条目", nil
	}
	if err := e.ensureIdentity(state); err != nil {
		return "", err
	}
	peers := state.trustedPeers()
	if len(peers) == 0 {
		return "没有已配对的设备", nil
	}

	info, err := e.payloadInfo(ctx)
	if err != nil {
		if errors.Is(err, ErrBudget) {
			return "本次同步预算不足，条目将在下次复制时发送", nil
		}
		return "", err
	}
	kind, supported := kindForEntry(e.Trigger.Kind, info.MIME)
	if !supported {
		state.record(transferRecord{Direction: "out", Kind: e.Trigger.Kind,
			Bytes: int(info.Total), At: e.Host.NowTime().Unix(), Result: "unsupported"})
		_ = e.saveFinal(ctx, state)
		return "该条目类型不支持同步", nil
	}
	limit := int64(MaxPayloadBytes)
	if kind == "image" || kind == "file" || kind == "files" {
		limit = MaxMediaPayloadBytes
	}
	if info.Total <= 0 || info.Total > limit {
		state.record(transferRecord{Direction: "out", Kind: kind,
			Bytes: int(info.Total), At: e.Host.NowTime().Unix(), Result: "skipped"})
		_ = e.saveFinal(ctx, state)
		if kind == "text" || kind == "rich_text" {
			return "该条目超过文本同步上限", nil
		}
		// entry.payload answers only for the entry this invocation carries
		// (D-1032), so a payload the budget cannot read has no second chance.
		return fmt.Sprintf("该条目超过当前版本约 %d MiB 的图片与文件同步上限，未发送",
			MaxMediaPayloadBytes>>20), nil
	}
	if kind == "image" || kind == "file" || kind == "files" {
		// One sealed chunk exists per peer; refuse before sealing when the
		// queue cannot hold the whole group, because enqueue drops whole
		// groups and the receiver must never see half of one.
		chunks := (info.Total + MaxPlaintextChunk - 1) / MaxPlaintextChunk
		if kind == "files" {
			chunks++ // the manifest is index 0
		}
		estimated := chunks * int64(len(peers)) * (MaxPlaintextChunk + 512)
		if estimated > int64(QueueMaxBytes-state.queueBytes()) {
			state.record(transferRecord{Direction: "out", Kind: kind,
				Bytes: int(info.Total), At: e.Host.NowTime().Unix(), Result: "skipped"})
			_ = e.saveFinal(ctx, state)
			return "离线队列容纳不下这份内容（设备多或队列已满），未发送", nil
		}
	}

	payload, err := e.readPayload(ctx, info)
	if err != nil {
		if errors.Is(err, ErrBudget) {
			if kind == "image" || kind == "file" || kind == "files" {
				state.record(transferRecord{Direction: "out", Kind: kind,
					Bytes: int(info.Total), At: e.Host.NowTime().Unix(), Result: "failed"})
				_ = e.saveFinal(ctx, state)
				return "条目过大，本次调用无法完成读取，未同步", nil
			}
			return "条目较大，本次调用预算不足", nil
		}
		return "", err
	}
	if info.SHA256 != "" {
		digest := sha256.Sum256(payload)
		if !strings.EqualFold(hex.EncodeToString(digest[:]), info.SHA256) {
			return "", errors.New("条目在读取过程中发生了变化")
		}
	}
	// A directory payload is a manifest line followed by the file bytes
	// (D-1032). The manifest is validated and its directory name becomes the
	// header name; the bytes travel as-is, manifest first, so chunk index 0
	// tells the receiver every file name and size.
	name := info.DisplayName
	if kind == "files" {
		manifest, err := parseMediaManifest(payload)
		if err != nil {
			return "", err
		}
		name = manifest.Name
	}
	group, err := groupID()
	if err != nil {
		return "", err
	}
	chunks := splitPayload(payload)
	messages := make([]outboundMessage, 0, len(chunks)*len(peers))
	for _, peer := range peers {
		for index, chunk := range chunks {
			id, err := messageID()
			if err != nil {
				return "", err
			}
			wire, err := state.Device.sealChunk(peer, id, group, index, len(chunks),
				kind, info.MIME, name, info.SHA256, chunk)
			if err != nil {
				return "", err
			}
			messages = append(messages, outboundMessage{
				MessageID: id, PeerID: peer.DeviceID, GroupID: group,
				Index: index, Total: len(chunks), Kind: kind, MIME: info.MIME,
				Name: name, PayloadSHA256: info.SHA256, Ciphertext: wire,
				CreatedAt: e.Host.NowTime().Unix(),
			})
		}
	}
	state.enqueue(messages)
	if err := e.save(ctx, state); err != nil {
		if errors.Is(err, ErrBudget) {
			return "本次同步预算不足，条目已留在队列", nil
		}
		return "", err
	}

	client := e.client(state)
	registerErr := e.register(ctx, state, client)
	sent := 0
	if registerErr == nil {
		sent = e.drain(ctx, state, client)
	}
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	if registerErr != nil && !errors.Is(registerErr, ErrBudget) {
		return "中继暂不可达，内容已排队", nil
	}
	if len(state.Queue) > 0 {
		if !state.Relay.Reachable {
			return "中继暂不可达，内容已排队", nil
		}
		return fmt.Sprintf("已同步 %d 条，队列剩余 %d 条", sent, len(state.Queue)), nil
	}
	return fmt.Sprintf("已同步 %d 条到 %d 台设备", sent, len(peers)), nil
}

func (e *Engine) readPayload(ctx context.Context, info PayloadInfo) ([]byte, error) {
	data := make([]byte, 0, info.Total)
	offset := int64(0)
	for offset < info.Total {
		length := int64(MaxEntryPayloadChunk)
		if remaining := info.Total - offset; remaining < length {
			length = remaining
		}
		chunk, err := e.payloadRead(ctx, offset, length)
		if err != nil {
			return nil, err
		}
		data = append(data, chunk...)
		if len(chunk) == 0 {
			return nil, errors.New("条目载荷读取不完整")
		}
		offset += int64(len(chunk))
	}
	return data, nil
}

// MaxEntryPayloadChunk mirrors the host's per-read ceiling. It is repeated
// here because the engine pages the payload itself; the host enforces it.
const MaxEntryPayloadChunk = 128 << 10

// drain sends due queued messages. It stops on the first network failure so a
// down relay does not burn the whole invocation budget.
func (e *Engine) drain(ctx context.Context, state *state, client *relayClient) int {
	now := e.Host.NowTime()
	var due []string
	for _, index := range state.dueQueue(now) {
		due = append(due, state.Queue[index].MessageID)
	}
	sent := 0
	for _, id := range due {
		if sent >= DrainBatch || e.Host.Budget.Remaining() < 2 {
			break
		}
		message := state.queued(id)
		if message == nil {
			continue
		}
		peer := state.peer(message.PeerID)
		if peer == nil || !peer.Trusted {
			state.removeQueued(id)
			continue
		}
		if err := client.deliver(ctx, peer.DeviceID, message.MessageID, message.Ciphertext); err != nil {
			if errors.Is(err, ErrBudget) {
				break
			}
			message.Attempts++
			message.NextAttemptAt = now.Add(backoff(message.Attempts)).Unix()
			e.noteRelayFailure(state, err)
			var refused *relayError
			if !errors.As(err, &refused) {
				break
			}
			continue
		}
		state.removeQueued(id)
		sent++
		state.record(transferRecord{Direction: "out", Kind: message.Kind,
			Bytes: len(message.Ciphertext), At: now.Unix(),
			Peer: peer.Name, Result: "ok"})
		state.Relay.Reachable = true
		state.Relay.LastError = ""
	}
	return sent
}

func (s *state) queued(id string) *outboundMessage {
	for index := range s.Queue {
		if s.Queue[index].MessageID == id {
			return &s.Queue[index]
		}
	}
	return nil
}

// --- pull ------------------------------------------------------------------

func (e *Engine) pull(ctx context.Context, state *state) (string, error) {
	if state.AutoSyncPaused {
		return "同步已暂停", nil
	}
	if e.origin() == "" {
		return "还没有配置中继地址", nil
	}
	if err := e.ensureIdentity(state); err != nil {
		return "", err
	}
	client := e.client(state)
	if err := e.register(ctx, state, client); err != nil {
		if errors.Is(err, ErrBudget) {
			return "本次同步预算不足", nil
		}
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "中继暂不可达：" + relayFailureText(err), nil
	}
	sent := e.drain(ctx, state, client)
	messages, more, err := client.list(ctx, PullBatch)
	if err != nil {
		e.noteRelayFailure(state, err)
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "中继暂不可达：" + relayFailureText(err), nil
	}

	now := e.Host.NowTime()
	var remove []string
	applied := 0
	received := 0
	// Partial groups that outlived the TTL are voided whole: the relay keeps
	// undelivered messages for days, so a group still incomplete after an
	// hour is not going to complete, and applying half of one is worse than
	// applying nothing.
	for range state.voidExpiredInbound(now) {
		state.record(transferRecord{Direction: "in", At: now.Unix(),
			Result: "dropped"})
	}
	for _, message := range messages {
		if e.Host.Budget.Remaining() < 2 {
			break
		}
		if state.isApplied(message.MessageID) {
			remove = append(remove, message.MessageID)
			continue
		}
		peer := state.peer(message.SenderID)
		switch {
		case peer != nil && peer.Trusted:
			header, data, err := state.Device.openChunk(*peer, message.MessageID, message.Ciphertext)
			if err != nil {
				// Corrupt or forged message from a trusted peer: drop it from
				// the mailbox and record a failure without content.
				state.record(transferRecord{Direction: "in", At: now.Unix(),
					Peer: peer.Name, Result: "failed"})
				remove = append(remove, message.MessageID)
				continue
			}
			if state.isGroupApplied(header.GroupID) {
				remove = append(remove, message.MessageID)
				continue
			}
			if state.hasInbound(message.MessageID) {
				remove = append(remove, message.MessageID)
				continue
			}
			state.addInbound(inboundChunk{Header: header, Data: data,
				MessageID: message.MessageID, SenderID: message.SenderID,
				SeenAt: now.Unix()})
			remove = append(remove, message.MessageID)
			received++
			if chunks := state.groupChunks(header.GroupID); len(chunks) == header.Total {
				if applied >= ApplyBatch || e.Host.Budget.Remaining() < 2 {
					continue
				}
				group, err := assembleChunks(chunks)
				if err != nil {
					state.dropInbound(header.GroupID)
					state.record(transferRecord{Direction: "in", At: now.Unix(),
						Peer: peer.Name, Result: "failed"})
					continue
				}
				switch e.applyGroup(ctx, state, group, peer.Name, now) {
				case applyDone:
					state.dropInbound(header.GroupID)
					state.markApplied(chunkMessageIDs(chunks), header.GroupID)
					state.record(transferRecord{Direction: "in", Kind: group.Kind,
						Bytes: len(group.Data), At: now.Unix(),
						Peer: peer.Name, Result: "ok"})
					applied++
				case applyCancelled:
					// The user declined the landing; voiding the group keeps a
					// cancelled transfer from prompting again every minute.
					state.dropInbound(header.GroupID)
					state.markApplied(chunkMessageIDs(chunks), header.GroupID)
					state.record(transferRecord{Direction: "in", Kind: group.Kind,
						Bytes: len(group.Data), At: now.Unix(),
						Peer: peer.Name, Result: "cancelled"})
					applied++
				case applyFailed:
					state.dropInbound(header.GroupID)
					state.record(transferRecord{Direction: "in", Kind: group.Kind,
						Bytes: len(group.Data), At: now.Unix(),
						Peer: peer.Name, Result: "failed"})
				case applyRetry:
					// Budget exhausted mid-write or mid-staging: the chunks
					// stay assembled in the inbound area and the next pull
					// continues from a fresh staging buffer.
				}
			}
		case peer != nil:
			// A known but unconfirmed peer may still be completing pairing.
			if handled, err := e.pairingChunk(state, message, now); handled {
				remove = append(remove, message.MessageID)
				if err != nil {
					state.record(transferRecord{Direction: "in", At: now.Unix(),
						Peer: peer.Name, Result: "failed"})
				}
				continue
			}
			remove = append(remove, message.MessageID)
		default:
			if handled, _ := e.pairingChunk(state, message, now); handled {
				remove = append(remove, message.MessageID)
				continue
			}
			// Unknown sender, not a pairing message: it can never be applied.
			remove = append(remove, message.MessageID)
		}
	}

	if err := e.save(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	// Deletions happen after the state that records the chunks is durable. A
	// crash between save and delete only causes a redelivery, which the
	// message-ID checks above discard.
	for _, id := range remove {
		if e.Host.Budget.Remaining() < 1 {
			break
		}
		if err := client.delete(ctx, id); err != nil {
			if errors.Is(err, ErrBudget) {
				break
			}
			e.noteRelayFailure(state, err)
			break
		}
	}
	_ = more
	switch {
	case applied > 0:
		return fmt.Sprintf("已接收 %d 条内容", applied), nil
	case received > 0:
		return "已接收部分内容，等待剩余分块", nil
	case sent > 0:
		return fmt.Sprintf("已发送队列中的 %d 条", sent), nil
	default:
		return "没有新的同步内容", nil
	}
}

// applyOutcome says what a complete group's apply left behind: applyRetry
// keeps the chunks for the next pull, the others are final.
type applyOutcome int

const (
	applyDone applyOutcome = iota
	applyCancelled
	applyRetry
	applyFailed
)

// applyGroup writes one complete group back through the host. Text and rich
// text use the one-call write; images, files and directories go through the
// staged write (D-1033). A cancelled or failed landing is final — retrying
// every minute would prompt the user over and over — while a budget outcome
// keeps the group for the next invocation.
func (e *Engine) applyGroup(
	ctx context.Context, state *state, group assembledGroup, peerName string, now time.Time,
) applyOutcome {
	switch group.Kind {
	case "text":
		if err := e.clipboardWrite(ctx, WritePayload{Kind: "text", Text: string(group.Data)}); err != nil {
			if errors.Is(err, ErrBudget) {
				return applyRetry
			}
			state.record(transferRecord{Direction: "in", At: now.Unix(),
				Peer: peerName, Result: "failed"})
			return applyRetry
		}
		return applyDone
	case "rich_text":
		if err := e.clipboardWrite(ctx, WritePayload{Kind: "rich_text", HTML: string(group.Data)}); err != nil {
			if errors.Is(err, ErrBudget) {
				return applyRetry
			}
			state.record(transferRecord{Direction: "in", At: now.Unix(),
				Peer: peerName, Result: "failed"})
			return applyRetry
		}
		return applyDone
	default:
		return e.applyStagedGroup(ctx, state, group, peerName, now)
	}
}

// applyStagedGroup hands one image, file or directory to the host's staged
// write: bounded stage calls, then one commit that verifies the digest and
// applies through the same path as a direct write. The commit is idempotent
// per group id, so an invocation that died waiting for the user's answer
// picks the recorded outcome up instead of landing twice.
func (e *Engine) applyStagedGroup(
	ctx context.Context, state *state, group assembledGroup, peerName string, now time.Time,
) applyOutcome {
	digest := sha256.Sum256(group.Data)
	hexDigest := hex.EncodeToString(digest[:])
	commit := Commit{}
	switch group.Kind {
	case "image":
		commit.Image = &CommitImage{ID: group.GroupID, SHA256: hexDigest}
	case "file":
		commit.Files = &CommitFiles{ID: group.GroupID, SHA256: hexDigest,
			Files: []CommitFile{{Name: group.Name, Size: int64(len(group.Data))}}}
	case "files":
		manifest, err := parseMediaManifest(group.Data)
		if err != nil {
			state.record(transferRecord{Direction: "in", Kind: group.Kind,
				At: now.Unix(), Peer: peerName, Result: "failed"})
			return applyFailed
		}
		files := make([]CommitFile, 0, len(manifest.Files))
		for _, file := range manifest.Files {
			files = append(files, CommitFile{Name: file.Name, Size: file.Size})
		}
		commit.Files = &CommitFiles{ID: group.GroupID, SHA256: hexDigest, Files: files}
	default:
		return applyFailed
	}

	offset := int64(0)
	for offset < int64(len(group.Data)) {
		end := offset + MaxPlaintextChunk
		if end > int64(len(group.Data)) {
			end = int64(len(group.Data))
		}
		size, err := e.clipboardStage(ctx, StagedChunk{
			ID: group.GroupID, Offset: offset, Data: group.Data[offset:end],
		})
		if err != nil {
			if errors.Is(err, ErrBudget) {
				return applyRetry
			}
			state.record(transferRecord{Direction: "in", Kind: group.Kind,
				At: now.Unix(), Peer: peerName, Result: "failed"})
			return applyFailed
		}
		offset = size
	}
	result, err := e.clipboardCommit(ctx, commit)
	if err != nil {
		if errors.Is(err, ErrBudget) {
			return applyRetry
		}
		state.record(transferRecord{Direction: "in", Kind: group.Kind,
			At: now.Unix(), Peer: peerName, Result: "failed"})
		return applyFailed
	}
	if result.Cancelled {
		return applyCancelled
	}
	return applyDone
}

// pairingChunk handles one control message. It reports whether the message was
// consumed. A code that does not match this device's live invite is consumed
// and ignored: the relay already limits guessing, and the fingerprint is the
// real authentication.
func (e *Engine) pairingChunk(state *state, message relayMessage, now time.Time) (bool, error) {
	if len(message.Ciphertext) == 0 || message.Ciphertext[0] != wirePairing {
		return false, nil
	}
	invite := state.Invite
	if invite == nil || invite.ExpiresAt <= now.Unix() {
		return true, nil
	}
	decoded, err := state.Device.openPairingMessage(message.MessageID, message.Ciphertext)
	if err != nil {
		return true, err
	}
	if decoded.Code != invite.Code {
		return true, errors.New("配对码不匹配")
	}
	peer := peerRecord{
		DeviceID:    decoded.SenderID,
		Name:        decoded.Name,
		SigningKey:  decoded.SigningKey,
		ExchangeKey: decoded.ExchangeKey,
		Fingerprint: Fingerprint(state.Device.DeviceID, state.Device.ExchangePublic,
			decoded.SenderID, decoded.ExchangeKey),
		Trusted:  false,
		PairedAt: now.Unix(),
	}
	if !peer.valid() {
		return true, errors.New("配对设备记录无效")
	}
	state.upsertPeer(peer)
	state.Invite = nil
	state.record(transferRecord{Direction: "in", At: now.Unix(),
		Peer: peer.Name, Result: "pairing"})
	return true, nil
}

func (s *state) hasInbound(messageID string) bool {
	for _, chunk := range s.Inbound {
		if chunk.MessageID == messageID {
			return true
		}
	}
	return false
}

func chunkMessageIDs(chunks []inboundChunk) []string {
	ids := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		ids = append(ids, chunk.MessageID)
	}
	return ids
}

// --- pairing ---------------------------------------------------------------

func (e *Engine) pairBegin(ctx context.Context, state *state) (string, error) {
	if e.origin() == "" {
		return "", ErrNoRelay
	}
	if err := e.ensureIdentity(state); err != nil {
		return "", err
	}
	client := e.client(state)
	if err := e.register(ctx, state, client); err != nil {
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "中继暂不可达：" + relayFailureText(err), nil
	}
	code, expiresAt, err := client.createPairing(ctx)
	if err != nil {
		e.noteRelayFailure(state, err)
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "中继拒绝了配对邀请：" + relayFailureText(err), nil
	}
	state.Invite = &pairingInvite{
		Code: code, CreatedAt: e.Host.NowTime().Unix(), ExpiresAt: expiresAt.Unix(),
	}
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	return fmt.Sprintf("配对码 %s，%d 分钟内有效；在另一台设备上兑换后核对指纹", code,
		max(1, (expiresAt.Unix()-e.Host.NowTime().Unix())/60)), nil
}

func (e *Engine) pairRedeem(ctx context.Context, state *state) (string, error) {
	if e.origin() == "" {
		return "", ErrNoRelay
	}
	if len(e.Arguments) == 0 || !pairingCodePattern.MatchString(strings.TrimSpace(e.Arguments[0])) {
		return "", errors.New("请提供 6 位配对码")
	}
	code := strings.TrimSpace(e.Arguments[0])
	if err := e.ensureIdentity(state); err != nil {
		return "", err
	}
	client := e.client(state)
	if err := e.register(ctx, state, client); err != nil {
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "中继暂不可达：" + relayFailureText(err), nil
	}
	peer, err := client.redeemPairing(ctx, code)
	if err != nil {
		e.noteRelayFailure(state, err)
		if saveErr := e.saveFinal(ctx, state); saveErr != nil && !errors.Is(saveErr, ErrBudget) {
			return "", saveErr
		}
		return "配对码无效或已过期", nil
	}
	peer.Trusted = false
	peer.PairedAt = e.Host.NowTime().Unix()
	state.upsertPeer(peer)
	id, err := messageID()
	if err != nil {
		return "", err
	}
	control, err := state.Device.sealPairingMessage(peer.DeviceID, peer.ExchangeKey,
		id, code, e.deviceName())
	if err != nil {
		return "", err
	}
	deliverErr := client.deliver(ctx, peer.DeviceID, id, control)
	if deliverErr != nil && !errors.Is(deliverErr, ErrBudget) {
		e.noteRelayFailure(state, deliverErr)
	}
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	if deliverErr != nil && !errors.Is(deliverErr, ErrBudget) {
		return "已兑换配对码，但通知对端失败：" + relayFailureText(deliverErr), nil
	}
	return fmt.Sprintf("已兑换配对码；请在两台设备上核对指纹 %s，再用 sync.pair.confirm 确认",
		peer.Fingerprint), nil
}

func (e *Engine) pairConfirm(ctx context.Context, state *state) (string, error) {
	argument := ""
	if len(e.Arguments) > 0 {
		argument = strings.TrimSpace(e.Arguments[0])
	}
	if argument == "" {
		// The menu's confirm button runs without an argument after the user
		// compared the fingerprints both panels show. One waiting peer is the
		// normal two-device case; with several, the fingerprint names which
		// one to trust.
		var waiting []peerRecord
		for _, peer := range state.Peers {
			if peer.valid() && !peer.Trusted {
				waiting = append(waiting, peer)
			}
		}
		if len(waiting) == 1 {
			argument = waiting[0].Fingerprint
		}
	}
	if argument == "" {
		return "", errors.New("请提供要确认的设备指纹")
	}
	target := normalizeFingerprint(argument)
	for index := range state.Peers {
		peer := &state.Peers[index]
		if peer.Trusted || normalizeFingerprint(peer.Fingerprint) != target {
			continue
		}
		peer.Trusted = true
		peer.PairedAt = e.Host.NowTime().Unix()
		if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
			return "", err
		}
		return "已配对设备：" + peer.Name, nil
	}
	return "", errors.New("没有等待确认的设备；请先核对两台设备上的指纹")
}

func normalizeFingerprint(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	return strings.ReplaceAll(value, "-", "")
}

// --- management (0.14.0) ----------------------------------------------------

// pairCancel withdraws this side of a pairing that has not completed: the
// outstanding invite and every peer that is still waiting for a fingerprint
// confirmation. The relay keeps no cancellation endpoint, so the invite only
// expires there; the code is dead once the local invite is gone.
func (e *Engine) pairCancel(ctx context.Context, state *state) (string, error) {
	invite := state.Invite
	if invite != nil {
		state.Invite = nil
	}
	var waiting int
	for index := len(state.Peers) - 1; index >= 0; index-- {
		if state.Peers[index].valid() && !state.Peers[index].Trusted {
			state.Peers = append(state.Peers[:index], state.Peers[index+1:]...)
			waiting++
		}
	}
	if invite == nil && waiting == 0 {
		return "", errors.New("当前没有待完成的配对")
	}
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	if invite != nil && waiting > 0 {
		return "已取消配对：配对码作废，1 台等待确认的设备已移除", nil
	}
	if invite != nil {
		return "已取消配对：配对码作废", nil
	}
	return fmt.Sprintf("已取消配对：%d 台等待确认的设备已移除", waiting), nil
}

// unpair removes one trusted device. Without an argument it answers the
// normal two-device case; with several peers it refuses rather than guess,
// and the device ID from the status JSON names the one to unbind.
func (e *Engine) unpair(ctx context.Context, state *state) (string, error) {
	target := ""
	if len(e.Arguments) > 0 {
		target = strings.TrimSpace(e.Arguments[0])
	}
	trusted := state.trustedPeers()
	if target == "" {
		switch len(trusted) {
		case 0:
			return "", errors.New("没有已配对的设备")
		case 1:
			target = trusted[0].DeviceID
		default:
			return "", fmt.Errorf(
				"已配对 %d 台设备；请提供要解绑的设备 ID（见设备列表）", len(trusted))
		}
	}
	peer := state.peer(target)
	if peer == nil || !peer.Trusted {
		return "", errors.New("没有这个已配对的设备")
	}
	name := peer.Name
	state.removePeer(target)
	state.record(transferRecord{Direction: "out", At: e.Host.NowTime().Unix(),
		Peer: name, Result: "unbound"})
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	return "已解绑设备：" + name + "；重新配对前它不会再收到你的内容", nil
}

// autoSyncToggle flips the one pause switch the menu owns. Triggers keep
// firing either way — the engine answers them with the same pause line, so
// the queue and the relay state stay untouched.
func (e *Engine) autoSyncToggle(ctx context.Context, state *state) (string, error) {
	state.AutoSyncPaused = !state.AutoSyncPaused
	paused := state.AutoSyncPaused
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	if paused {
		return "已暂停自动同步；离线队列保留", nil
	}
	return "已恢复自动同步", nil
}

// queueClear drops every chunk waiting for delivery. Confirmed-but-undelivered
// relay messages are not touched: the recipients already have them, and the
// queue only holds this side's unsent copies.
func (e *Engine) queueClear(ctx context.Context, state *state) (string, error) {
	if len(state.Queue) == 0 {
		return "", errors.New("离线队列已经是空的")
	}
	dropped := len(state.Queue)
	bytes := state.queueBytes()
	state.Queue = nil
	state.record(transferRecord{Direction: "out", At: e.Host.NowTime().Unix(),
		Result: "dropped"})
	if err := e.saveFinal(ctx, state); err != nil && !errors.Is(err, ErrBudget) {
		return "", err
	}
	return fmt.Sprintf("已清空离线队列（丢弃 %d 条消息，%.1f KiB）", dropped,
		float64(bytes)/1024), nil
}
