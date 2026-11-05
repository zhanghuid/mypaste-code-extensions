package ferry

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/servers/mypaste-relay/relay"
)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock {
	return &testClock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(duration)
}

type memoryStore struct {
	mu     sync.Mutex
	data   map[string][]byte
	reads  int
	writes int
}

func newMemoryStore() *memoryStore { return &memoryStore{data: map[string][]byte{}} }

func (s *memoryStore) Read(_ context.Context, key string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	data, ok := s.data[key]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), data...), true, nil
}

func (s *memoryStore) Write(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	s.data[key] = append([]byte(nil), data...)
	return nil
}

func (s *memoryStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}

type memoryPayload struct {
	mu    sync.Mutex
	mime  string
	name  string
	data  []byte
	reads int
}

func (p *memoryPayload) Info(context.Context) (PayloadInfo, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	sum := sha256.Sum256(p.data)
	return PayloadInfo{MIME: p.mime, Total: int64(len(p.data)),
		SHA256: hex.EncodeToString(sum[:]), DisplayName: p.name}, nil
}

func (p *memoryPayload) Read(_ context.Context, offset, length int64) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads++
	if offset < 0 || offset > int64(len(p.data)) {
		return nil, errors.New("条目载荷读取不完整")
	}
	end := offset + length
	if end > int64(len(p.data)) {
		end = int64(len(p.data))
	}
	return append([]byte(nil), p.data[offset:end]...), nil
}

func (p *memoryPayload) set(mime string, data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.mime, p.data = mime, append([]byte(nil), data...)
}

// setFile gives the entry a display name, as file and image entries carry.
func (p *memoryPayload) setFile(mime, name string, data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.mime, p.name, p.data = mime, name, append([]byte(nil), data...)
}

type memoryClipboard struct {
	mu      sync.Mutex
	writes  []WritePayload
	staged  []StagedChunk
	commits []Commit
	// cancelNext makes the next commit answer like a declined landing.
	cancelNext bool
}

func (c *memoryClipboard) Write(_ context.Context, payload WritePayload) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writes = append(c.writes, payload)
	return nil
}

func (c *memoryClipboard) Stage(_ context.Context, chunk StagedChunk) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.staged = append(c.staged, chunk)
	return chunk.Offset + int64(len(chunk.Data)), nil
}

func (c *memoryClipboard) Commit(_ context.Context, commit Commit) (CommitResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancelNext {
		c.cancelNext = false
		return CommitResult{Cancelled: true}, nil
	}
	c.commits = append(c.commits, commit)
	return CommitResult{}, nil
}

// stagedBytes reassembles what the fake received for one buffer id.
func (c *memoryClipboard) stagedBytes(id string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	var data []byte
	for _, chunk := range c.staged {
		if chunk.ID == id {
			data = append(data, chunk.Data...)
		}
	}
	return data
}

func (c *memoryClipboard) writes_() []WritePayload {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]WritePayload(nil), c.writes...)
}

func (c *memoryClipboard) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.writes)
}

// testNetwork is the host proxy stand-in: it performs the request and applies
// the same 256 KiB request ceiling the host enforces, so an oversized chunk
// fails here the same way it would in the application.
type testNetwork struct {
	client *http.Client
	mu     sync.Mutex
	down   bool
	calls  int
}

func (n *testNetwork) Do(ctx context.Context, request Request) (Response, error) {
	n.mu.Lock()
	down := n.down
	n.calls++
	n.mu.Unlock()
	if down {
		return Response{}, errors.New("网络请求失败")
	}
	if len(request.Body) > 256<<10 {
		return Response{}, errors.New("请求正文超过大小上限")
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, request.URL,
		bytes.NewReader(request.Body))
	if err != nil {
		return Response{}, errors.New("网络请求失败")
	}
	for name, value := range request.Headers {
		httpRequest.Header.Set(name, value)
	}
	response, err := n.client.Do(httpRequest)
	if err != nil {
		return Response{}, errors.New("网络请求失败")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return Response{}, errors.New("网络请求失败")
	}
	return Response{Status: response.StatusCode, Body: body}, nil
}

func (n *testNetwork) setDown(down bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.down = down
}

type testInstall struct {
	t         *testing.T
	clock     *testClock
	name      string
	store     *memoryStore
	payload   *memoryPayload
	clipboard *memoryClipboard
	network   *testNetwork
	settings  Settings
	// triggerKind is the entry kind the next push trigger carries.
	triggerKind string
	// filter, when set, rewrites this install's mailbox list responses.
	filter *filteringNetwork
}

func newTestInstall(t *testing.T, clock *testClock, network *testNetwork, relayURL, name string) *testInstall {
	t.Helper()
	return &testInstall{
		t: t, clock: clock, name: name,
		store: newMemoryStore(), payload: &memoryPayload{}, clipboard: &memoryClipboard{},
		network:  network,
		settings: Settings{RelayURL: relayURL, DeviceName: name},
	}
}

func (i *testInstall) calls() int {
	i.store.mu.Lock()
	store := i.store.reads + i.store.writes
	i.store.mu.Unlock()
	i.payload.mu.Lock()
	payload := i.payload.reads
	i.payload.mu.Unlock()
	i.clipboard.mu.Lock()
	clipboard := len(i.clipboard.writes)
	i.clipboard.mu.Unlock()
	i.network.mu.Lock()
	network := i.network.calls
	i.network.mu.Unlock()
	return store + payload + clipboard + network
}

func (i *testInstall) run(command string, arguments ...string) (string, error) {
	i.t.Helper()
	clock := i.clock
	var trigger *TriggerInfo
	if command == CommandPush {
		kind := i.triggerKind
		if kind == "" {
			kind = "text"
		}
		trigger = &TriggerInfo{EntryID: 1, Kind: kind}
	}
	before := i.calls()
	network := Network(i.network)
	if i.filter != nil {
		network = i.filter
	}
	host := NewHost(i.store, i.payload, i.clipboard, network,
		clock.Now, time.Now().Add(2*time.Minute))
	engine := &Engine{Host: host, Settings: i.settings, Trigger: trigger, Arguments: arguments}
	output, err := engine.Run(context.Background(), command)
	if used := i.calls() - before; used > MaxHostCalls {
		i.t.Fatalf("%s used %d host calls", command, used)
	}
	return output, err
}

func (i *testInstall) state() *state {
	i.t.Helper()
	i.store.mu.Lock()
	data, ok := i.store.data[StateKey]
	i.store.mu.Unlock()
	if !ok {
		return newState()
	}
	value, err := decodeState(data)
	if err != nil {
		i.t.Fatal(err)
	}
	return value
}

func (i *testInstall) status() statusDocument {
	i.t.Helper()
	output, err := i.run(CommandStatus)
	if err != nil {
		i.t.Fatal(err)
	}
	var document statusDocument
	if err := json.Unmarshal([]byte(output), &document); err != nil {
		i.t.Fatalf("status is not JSON: %v (%q)", err, output)
	}
	return document
}

func (i *testInstall) step() { i.clock.Advance(time.Second) }

func newTestRelay(t *testing.T, clock *testClock) string {
	t.Helper()
	server, err := relay.Open(relay.Config{DataDir: t.TempDir(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		httpServer.Close()
		_ = server.Close()
	})
	return httpServer.URL
}

func newTestNetwork() *testNetwork { return &testNetwork{client: http.DefaultClient} }

// pair runs the whole handshake and returns the fingerprint both sides show.
func pair(t *testing.T, left, right *testInstall) string {
	t.Helper()
	if _, err := left.run(CommandPairBegin); err != nil {
		t.Fatal(err)
	}
	invite := left.state().Invite
	if invite == nil || invite.Code == "" {
		t.Fatal("no pairing invite was stored")
	}
	left.step()
	if _, err := right.run(CommandPairRedeem, invite.Code); err != nil {
		t.Fatal(err)
	}
	left.step()
	if _, err := left.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	leftStatus := left.status()
	if len(leftStatus.Peers) != 1 {
		t.Fatalf("left peers = %#v", leftStatus.Peers)
	}
	fingerprint := leftStatus.Peers[0].Fingerprint
	rightStatus := right.status()
	if len(rightStatus.Peers) != 1 || rightStatus.Peers[0].Fingerprint != fingerprint {
		t.Fatalf("right peers = %#v, left fingerprint = %q", rightStatus.Peers, fingerprint)
	}
	if leftStatus.Peers[0].Trusted || rightStatus.Peers[0].Trusted {
		t.Fatal("a peer is trusted before the fingerprint is confirmed")
	}
	left.step()
	if _, err := left.run(CommandPairConfirm, fingerprint); err != nil {
		t.Fatal(err)
	}
	right.step()
	if _, err := right.run(CommandPairConfirm, fingerprint); err != nil {
		t.Fatal(err)
	}
	if !left.status().Device.Paired || !right.status().Device.Paired {
		t.Fatal("a side did not become paired")
	}
	return fingerprint
}

func TestPairingAndTextSync(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")

	text := "跨设备同步的测试文本\nsecond line"
	pair(t, alice, bob)

	alice.payload.set("text/plain; charset=utf-8", []byte(text))
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatal("the small payload stayed queued")
	}
	if bob.clipboard.count() != 0 {
		t.Fatal("the receiver wrote the clipboard before pulling")
	}

	bob.step()
	output, err := bob.run(CommandPull)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "已接收 1 条内容") {
		t.Fatalf("pull output = %q", output)
	}
	bob.clipboard.mu.Lock()
	writes := append([]WritePayload(nil), bob.clipboard.writes...)
	bob.clipboard.mu.Unlock()
	if len(writes) != 1 || writes[0].Kind != "text" || writes[0].Text != text {
		t.Fatalf("clipboard writes = %#v", writes)
	}
	if bob.payload.reads != 0 {
		t.Fatal("the receiving side read its own entry payload")
	}
	if len(bob.state().Queue) != 0 {
		t.Fatal("a pull queued an outbound message")
	}

	bob.step()
	output, err = bob.run(CommandPull)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("second pull output = %q", output)
	}
	if bob.clipboard.count() != 1 {
		t.Fatalf("the same message was applied twice: %d writes", bob.clipboard.count())
	}
}

func TestLargePayloadCompletesOverTicks(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	payload := strings.Repeat("0123456789abcdef", (1<<20)/16)
	alice.payload.set("text/plain", []byte(payload))
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) == 0 {
		t.Fatal("the oversized payload was not queued for the next tick")
	}
	alice.step()
	if _, err := alice.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatalf("queue still holds %d messages after a drain tick", len(alice.state().Queue))
	}
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	bob.clipboard.mu.Lock()
	writes := append([]WritePayload(nil), bob.clipboard.writes...)
	bob.clipboard.mu.Unlock()
	if len(writes) != 1 {
		t.Fatalf("clipboard writes = %d", len(writes))
	}
	if writes[0].Text != payload {
		t.Fatalf("received %d bytes, want %d", len(writes[0].Text), len(payload))
	}
}

func TestOfflineQueueSurvivesAndRetries(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	// Each device has its own network path: taking alice offline must not
	// take the relay away from bob.
	aliceNetwork := newTestNetwork()
	alice := newTestInstall(t, clock, aliceNetwork, relayURL, "alice")
	bob := newTestInstall(t, clock, newTestNetwork(), relayURL, "bob")
	pair(t, alice, bob)

	alice.payload.set("text/plain", []byte("offline payload"))
	alice.network.setDown(true)
	output, err := alice.run(CommandPush)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "已排队") {
		t.Fatalf("push output = %q", output)
	}
	queued := alice.state()
	if len(queued.Queue) != 1 || queued.Relay.Reachable {
		t.Fatalf("state after an offline push = %#v", queued)
	}
	if queued.Relay.LastError == "" || strings.Contains(queued.Relay.LastError, "offline payload") {
		t.Fatalf("last error = %q", queued.Relay.LastError)
	}

	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("pull while offline output = %q err = %v", output, err)
	}

	alice.network.setDown(false)
	// The failed attempt schedules the next try five seconds out.
	clock.Advance(6 * time.Second)
	if _, err := alice.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatalf("queue still holds %d messages", len(alice.state().Queue))
	}
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	bob.clipboard.mu.Lock()
	defer bob.clipboard.mu.Unlock()
	if len(bob.clipboard.writes) != 1 || bob.clipboard.writes[0].Text != "offline payload" {
		t.Fatalf("clipboard writes = %#v", bob.clipboard.writes)
	}
}

func TestPairingCodeIsSingleUseAndExpires(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	carol := newTestInstall(t, clock, network, relayURL, "carol")

	if _, err := alice.run(CommandPairBegin); err != nil {
		t.Fatal(err)
	}
	code := alice.state().Invite.Code
	alice.step()
	if output, err := bob.run(CommandPairRedeem, code); err != nil ||
		!strings.Contains(output, "已兑换配对码") {
		t.Fatalf("first redeem output = %q err = %v", output, err)
	}
	alice.step()
	if output, err := carol.run(CommandPairRedeem, code); err != nil ||
		!strings.Contains(output, "无效或已过期") {
		t.Fatalf("second redeem output = %q err = %v", output, err)
	}

	alice.step()
	if _, err := alice.run(CommandPairBegin); err != nil {
		t.Fatal(err)
	}
	expired := alice.state().Invite.Code
	clock.Advance(11 * time.Minute)
	if output, err := carol.run(CommandPairRedeem, expired); err != nil ||
		!strings.Contains(output, "无效或已过期") {
		t.Fatalf("expired redeem output = %q err = %v", output, err)
	}
}

func TestStatusCarriesNoSecretsOrContent(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")

	secretText := "a very private clipboard sentence"
	alice.payload.set("text/plain", []byte(secretText))
	pair(t, alice, bob)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	document := alice.status()
	if !document.Device.Paired || len(document.Peers) != 1 || !document.Peers[0].Trusted {
		t.Fatalf("status = %#v", document)
	}
	if document.Relay.Host == "" || !document.Relay.Reachable {
		t.Fatalf("relay status = %#v", document.Relay)
	}

	output, err := alice.run(CommandStatus)
	if err != nil {
		t.Fatal(err)
	}
	device := alice.state().Device
	if strings.Contains(output, secretText) {
		t.Fatal("status contains clipboard content")
	}
	for _, secret := range [][]byte{device.SigningPrivate, device.ExchangePrivate} {
		if strings.Contains(output, hex.EncodeToString(secret)) ||
			strings.Contains(output, base64RawURL(secret)) {
			t.Fatal("status contains a private key")
		}
	}
	for _, field := range []string{`"device"`, `"relay"`, `"peers"`, `"queue"`, `"recent"`} {
		if !strings.Contains(output, field) {
			t.Fatalf("status is missing %s: %s", field, output)
		}
	}
}

func TestPushSkipsUnsupportedPayloads(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	// A MIME the engine cannot map is refused up front; images are supported
	// since 0.13.0, so use an opaque type instead.
	alice.payload.set("application/x-mypaste-unknown", []byte("\x00\x01opaque"))
	output, err := alice.run(CommandPush)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "不支持同步") {
		t.Fatalf("push output = %q", output)
	}
	state := alice.state()
	if len(state.Queue) != 0 {
		t.Fatalf("an unsupported payload was queued: %#v", state.Queue)
	}
	if len(state.Recent) == 0 || state.Recent[0].Result != "unsupported" {
		t.Fatalf("recent = %#v", state.Recent)
	}
}

func TestStatusWithoutRelayIsASetupState(t *testing.T) {
	clock := newTestClock()
	install := newTestInstall(t, clock, newTestNetwork(), "", "solo")
	document := install.status()
	if document.Relay.Configured || document.Device.Paired {
		t.Fatalf("status = %#v", document)
	}
	output, err := install.run(CommandPush)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "还没有配置中继地址") {
		t.Fatalf("push output = %q", output)
	}
	if _, err := install.run(CommandPairBegin); !errors.Is(err, ErrNoRelay) {
		t.Fatalf("pair begin error = %v", err)
	}
}

func TestPairConfirmRequiresTheExactFingerprint(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	fingerprint := pair(t, alice, bob)

	carol := newTestInstall(t, clock, network, relayURL, "carol")
	if _, err := carol.run(CommandPairConfirm, fingerprint); err == nil {
		t.Fatal("an unpaired device confirmed a fingerprint")
	}
	if _, err := alice.run(CommandPairConfirm, strings.ToLower(fingerprint)); err == nil {
		t.Fatal("confirming an already-trusted device reported success")
	}
}

func base64RawURL(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// beginInvite starts a pairing on one side and delivers the invite, so the
// other side can redeem it.
func beginInvite(t *testing.T, left *testInstall) string {
	t.Helper()
	if _, err := left.run(CommandPairBegin); err != nil {
		t.Fatal(err)
	}
	invite := left.state().Invite
	if invite == nil || invite.Code == "" {
		t.Fatal("no pairing invite was stored")
	}
	left.step()
	return invite.Code
}

func TestPairCancelWithdrawsUnfinishedPairings(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	alice := newTestInstall(t, clock, newTestNetwork(), relayURL, "alice")
	bob := newTestInstall(t, clock, newTestNetwork(), relayURL, "bob")
	carol := newTestInstall(t, clock, newTestNetwork(), relayURL, "carol")

	// An invite nobody redeemed: cancel voids the code and nothing else.
	code := beginInvite(t, alice)
	output, err := alice.run(CommandPairCancel)
	if err != nil {
		t.Fatal(err)
	}
	if output != "已取消配对：配对码作废" {
		t.Fatalf("cancel output = %q", output)
	}
	if alice.state().Invite != nil {
		t.Fatal("the invite survived the cancel")
	}

	// A redeemed pairing waiting on fingerprint confirmation: cancel drops
	// the waiting peer.
	code = beginInvite(t, alice)
	alice.step()
	if _, err := bob.run(CommandPairRedeem, code); err != nil {
		t.Fatal(err)
	}
	output, err = bob.run(CommandPairCancel)
	if err != nil {
		t.Fatal(err)
	}
	if output != "已取消配对：1 台等待确认的设备已移除" {
		t.Fatalf("cancel output = %q", output)
	}
	if peers := bob.state().Peers; len(peers) != 0 {
		t.Fatalf("the waiting peer survived the cancel: %#v", peers)
	}

	// The relay has no cancellation endpoint, so the stale code still
	// redeems there — but the holder ignores it: pulling never creates a
	// peer for it. A dedicated pair keeps alice's inbox ordering simple.
	dave := newTestInstall(t, clock, newTestNetwork(), relayURL, "dave")
	eve := newTestInstall(t, clock, newTestNetwork(), relayURL, "eve")
	stale := beginInvite(t, dave)
	if _, err := dave.run(CommandPairCancel); err != nil {
		t.Fatal(err)
	}
	if _, err := eve.run(CommandPairRedeem, stale); err != nil {
		t.Fatal(err)
	}
	dave.step()
	if _, err := dave.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	if peers := dave.state().Peers; len(peers) != 0 {
		t.Fatalf("the cancelled invite produced a peer: %#v", peers)
	}

	// Re-beginning while a confirmation still waits leaves both artifacts on
	// alice; one cancel withdraws both.
	code = beginInvite(t, alice)
	alice.step()
	if _, err := bob.run(CommandPairRedeem, code); err != nil {
		t.Fatal(err)
	}
	alice.step()
	if _, err := alice.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	peers := alice.state().Peers
	if len(peers) != 1 || peers[0].Trusted {
		t.Fatalf("alice should hold one waiting peer, got %#v", peers)
	}
	if alice.state().Invite != nil {
		t.Fatal("the redeemed invite was not cleared")
	}
	if _, err := alice.run(CommandPairBegin); err != nil {
		t.Fatal(err)
	}
	output, err = alice.run(CommandPairCancel)
	if err != nil {
		t.Fatal(err)
	}
	if output != "已取消配对：配对码作废，1 台等待确认的设备已移除" {
		t.Fatalf("cancel output = %q", output)
	}
	if alice.state().Invite != nil || len(alice.state().Peers) != 0 {
		t.Fatalf("cancel left state behind: %#v", alice.state())
	}

	// Nothing pending: the command refuses instead of reporting success.
	if _, err := carol.run(CommandPairCancel); err == nil ||
		err.Error() != "当前没有待完成的配对" {
		t.Fatalf("cancel without pending pairing err = %v", err)
	}
}

func TestUnpairRemovesOneTrustedDevice(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	alice := newTestInstall(t, clock, newTestNetwork(), relayURL, "alice")
	bob := newTestInstall(t, clock, newTestNetwork(), relayURL, "bob")
	carol := newTestInstall(t, clock, newTestNetwork(), relayURL, "carol")

	// With nothing paired the command refuses.
	if _, err := alice.run(CommandUnpair); err == nil ||
		err.Error() != "没有已配对的设备" {
		t.Fatalf("unpair without peers err = %v", err)
	}

	pair(t, alice, bob)
	status := alice.status()
	if len(status.Peers) != 1 || status.Peers[0].ID == "" {
		t.Fatalf("peer status carried no device ID: %#v", status.Peers)
	}

	// A waiting peer may never be unbound — only a trusted one.
	code := beginInvite(t, alice)
	if _, err := carol.run(CommandPairRedeem, code); err != nil {
		t.Fatal(err)
	}
	alice.step()
	if _, err := alice.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	var waitingID string
	for _, peer := range alice.status().Peers {
		if !peer.Trusted {
			waitingID = peer.ID
		}
	}
	if waitingID == "" {
		t.Fatal("carol never appeared as a waiting peer")
	}
	if _, err := alice.run(CommandUnpair, waitingID); err == nil ||
		err.Error() != "没有这个已配对的设备" {
		t.Fatalf("unpair of a waiting peer err = %v", err)
	}

	// Confirming carol makes two trusted peers; the argumentless form
	// refuses to guess and names the device list instead.
	carolFingerprint := ""
	for _, peer := range alice.status().Peers {
		if !peer.Trusted {
			carolFingerprint = peer.Fingerprint
		}
	}
	alice.step()
	if _, err := alice.run(CommandPairConfirm, carolFingerprint); err != nil {
		t.Fatal(err)
	}
	if _, err := alice.run(CommandUnpair); err == nil ||
		!strings.Contains(err.Error(), "已配对 2 台设备") {
		t.Fatalf("argumentless unpair with two peers err = %v", err)
	}

	// Unbind by the device ID the status JSON carried.
	bobID := ""
	for _, peer := range alice.status().Peers {
		if peer.Trusted && peer.ID != "" && peer.Name == "bob" {
			bobID = peer.ID
		}
	}
	if bobID == "" {
		t.Fatal("bob's device ID is missing from the status list")
	}
	output, err := alice.run(CommandUnpair, bobID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "已解绑设备：bob") {
		t.Fatalf("unpair output = %q", output)
	}
	peers := alice.status().Peers
	if len(peers) != 1 || peers[0].Name != "carol" || !peers[0].Trusted {
		t.Fatalf("peers after unbinding bob = %#v", peers)
	}
	recent := alice.status().Recent
	if len(recent) == 0 || recent[0].Result != "unbound" {
		t.Fatalf("no unbound record was kept: %#v", recent)
	}

	// One peer left: the argumentless form works again, and after it the
	// device reports unpaired.
	carolID := peers[0].ID
	if _, err := alice.run(CommandUnpair, carolID); err != nil {
		t.Fatal(err)
	}
	if _, err := alice.run(CommandUnpair); err == nil ||
		err.Error() != "没有已配对的设备" {
		t.Fatalf("unpair after the last removal err = %v", err)
	}
	if alice.status().Device.Paired {
		t.Fatal("the device still reports paired with no peers")
	}
}

func TestAutoSyncPauseStopsTransfersAndKeepsTheQueue(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	alice := newTestInstall(t, clock, newTestNetwork(), relayURL, "alice")
	bob := newTestInstall(t, clock, newTestNetwork(), relayURL, "bob")
	pair(t, alice, bob)

	output, err := alice.run(CommandAutoSync)
	if err != nil {
		t.Fatal(err)
	}
	if output != "已暂停自动同步；离线队列保留" {
		t.Fatalf("pause output = %q", output)
	}
	if !alice.status().AutoSyncPaused {
		t.Fatal("the status JSON does not report the pause")
	}

	// The pause is per device: bob must pause on its own side.
	if output, err := bob.run(CommandAutoSync); err != nil ||
		output != "已暂停自动同步；离线队列保留" {
		t.Fatalf("bob pause output = %q err = %v", output, err)
	}

	// Push and pull both answer with the pause line and touch nothing.
	alice.payload.set("text/plain", []byte("paused text"))
	output, err = alice.run(CommandPush)
	if err != nil {
		t.Fatal(err)
	}
	if output != "同步已暂停" {
		t.Fatalf("push while paused output = %q", output)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatal("a paused push queued a message")
	}
	bob.step()
	output, err = bob.run(CommandPull)
	if err != nil {
		t.Fatal(err)
	}
	if output != "同步已暂停" {
		t.Fatalf("pull while paused output = %q", output)
	}
	if bob.clipboard.count() != 0 {
		t.Fatal("a paused pull wrote the clipboard")
	}

	output, err = alice.run(CommandAutoSync)
	if err != nil {
		t.Fatal(err)
	}
	if output != "已恢复自动同步" {
		t.Fatalf("resume output = %q", output)
	}
	if alice.status().AutoSyncPaused {
		t.Fatal("the status JSON still reports the pause")
	}
	if _, err := bob.run(CommandAutoSync); err != nil {
		t.Fatal(err)
	}
	// The queued content goes out on the next push, unchanged.
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatalf("push after resume left %d messages queued", len(alice.state().Queue))
	}
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	bob.clipboard.mu.Lock()
	defer bob.clipboard.mu.Unlock()
	if len(bob.clipboard.writes) != 1 || bob.clipboard.writes[0].Text != "paused text" {
		t.Fatalf("clipboard writes = %#v", bob.clipboard.writes)
	}
}

func TestQueueClearDropsPendingMessages(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	aliceNetwork := newTestNetwork()
	alice := newTestInstall(t, clock, aliceNetwork, relayURL, "alice")
	bob := newTestInstall(t, clock, newTestNetwork(), relayURL, "bob")
	pair(t, alice, bob)

	alice.payload.set("text/plain", []byte("offline text"))
	alice.network.setDown(true)
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	if len(alice.state().Queue) != 1 {
		t.Fatal("the offline push did not queue a message")
	}

	output, err := alice.run(CommandQueueClear)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "已清空离线队列（丢弃 1 条消息") {
		t.Fatalf("clear output = %q", output)
	}
	if len(alice.state().Queue) != 0 {
		t.Fatal("the queue survived the clear")
	}
	recent := alice.status().Recent
	if len(recent) == 0 || recent[0].Result != "dropped" {
		t.Fatalf("no dropped record was kept: %#v", recent)
	}

	// An empty queue refuses rather than reporting success.
	if _, err := alice.run(CommandQueueClear); err == nil ||
		err.Error() != "离线队列已经是空的" {
		t.Fatalf("second clear err = %v", err)
	}

	// The dropped messages never reach the relay: bringing the network back
	// drains nothing and bob receives nothing.
	alice.network.setDown(false)
	bob.step()
	if _, err := alice.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	if bob.clipboard.count() != 0 {
		t.Fatalf("bob received %d writes after the queue was cleared",
			bob.clipboard.count())
	}
}
