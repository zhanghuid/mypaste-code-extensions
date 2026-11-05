package ferry

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// filteringNetwork wraps the shared test network and rewrites one install's
// mailbox list responses: it can keep only some messages or corrupt one, which
// is how the tests produce partial, incomplete and damaged deliveries without
// teaching the relay anything new.
type filteringNetwork struct {
	inner   *testNetwork
	corrupt bool
	keep    func(index int, id string) bool
}

func (n *filteringNetwork) Do(ctx context.Context, request Request) (Response, error) {
	response, err := n.inner.Do(ctx, request)
	if err != nil || request.Method != http.MethodGet ||
		!strings.Contains(request.URL, "/v1/mailbox/") {
		return response, err
	}
	var body struct {
		Messages []relayMessage `json:"messages"`
		More     bool           `json:"more"`
	}
	if json.Unmarshal(response.Body, &body) != nil {
		return response, nil
	}
	var kept []relayMessage
	for index, message := range body.Messages {
		if n.corrupt && index == 0 && len(message.Ciphertext) > 0 {
			message.Ciphertext[len(message.Ciphertext)-1] ^= 0x01
		}
		if n.keep == nil || n.keep(index, message.MessageID) {
			kept = append(kept, message)
		}
	}
	body.Messages = kept
	encoded, err := json.Marshal(body)
	if err != nil {
		return response, nil
	}
	response.Body = encoded
	return response, nil
}

// filterMailbox installs a list filter for the next pulls. Passing nil clears it.
func (i *testInstall) filterMailbox(corrupt bool, keep func(index int, id string) bool) {
	i.filter = &filteringNetwork{inner: i.network, corrupt: corrupt, keep: keep}
}

// imagePayload builds a stand-in PNG body of the given size.
func imagePayload(size int) []byte {
	data := make([]byte, size)
	copy(data, "\x89PNG\r\n\x1a\n")
	for index := 8; index < size; index++ {
		data[index] = byte('a' + index%26)
	}
	return data
}

// directoryStream builds a composite directory payload (D-1032): one manifest
// line, then every file's bytes back to back.
func directoryStream(name string, order []string, files map[string][]byte) []byte {
	manifest := mediaManifest{Name: name, Files: []mediaManifestFile{}}
	var body []byte
	for _, fileName := range order {
		content := files[fileName]
		manifest.Files = append(manifest.Files, mediaManifestFile{
			Name: fileName, Size: int64(len(content)), SHA256: sha256Hex(content)})
		body = append(body, content...)
	}
	head, err := json.Marshal(manifest)
	if err != nil {
		panic(err)
	}
	return append(append(head, '\n'), body...)
}

// commitImage returns the image commit the fake clipboard received, if any.
func commitImage(t *testing.T, clipboard *memoryClipboard) Commit {
	t.Helper()
	clipboard.mu.Lock()
	defer clipboard.mu.Unlock()
	for _, commit := range clipboard.commits {
		if commit.Image != nil {
			return commit
		}
	}
	t.Fatal("no image commit was recorded")
	return Commit{}
}

// commitFiles returns the files commit the fake clipboard received, if any.
func commitFiles(t *testing.T, clipboard *memoryClipboard) Commit {
	t.Helper()
	clipboard.mu.Lock()
	defer clipboard.mu.Unlock()
	for _, commit := range clipboard.commits {
		if commit.Files != nil {
			return commit
		}
	}
	t.Fatal("no files commit was recorded")
	return Commit{}
}

func TestImageRoundTripThroughRelay(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	// 300 KiB splits into two relay-sized chunks; both sides exercise the
	// staged write instead of the one-call text path.
	image := imagePayload(300 << 10)
	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "截图.png", image)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	if got := len(alice.state().Queue); got != 0 {
		t.Fatalf("the image stayed queued: %d messages", got)
	}

	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收 1 条内容") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	commit := commitImage(t, bob.clipboard)
	if commit.Image.SHA256 != sha256Hex(image) {
		t.Fatal("the committed image digest does not match the sender's payload")
	}
	if got := bob.clipboard.stagedBytes(commit.Image.ID); !bytes.Equal(got, image) {
		t.Fatalf("staged image = %d bytes, want %d", len(got), len(image))
	}
	if writes := bob.clipboard.writes_(); len(writes) != 0 {
		t.Fatalf("media went through the text write path: %#v", writes)
	}
	// A landed image must not loop back out: nothing is queued, and the
	// applied group never re-applies.
	if got := len(bob.state().Queue); got != 0 {
		t.Fatalf("the landing queued outbound traffic: %d messages", got)
	}
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("second pull output = %q err = %v", output, err)
	}
	if got := len(bob.clipboard.commits); got != 1 {
		t.Fatalf("the same image was committed %d times", got)
	}
	status := bob.status()
	if len(status.Transfers.Outbound) != 0 || len(status.Transfers.Inbound) != 0 ||
		len(status.Transfers.Failures) != 0 {
		t.Fatalf("transfers after a clean round trip = %#v", status.Transfers)
	}
}

func TestFileRoundTripLandsUnderItsDisplayName(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	document := []byte("%PDF-1.4 报告正文")
	alice.triggerKind = "file"
	alice.payload.setFile("application/pdf", "报告.pdf", document)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收 1 条内容") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	commit := commitFiles(t, bob.clipboard)
	if len(commit.Files.Files) != 1 {
		t.Fatalf("files = %#v", commit.Files.Files)
	}
	file := commit.Files.Files[0]
	if file.Name != "报告.pdf" || file.Size != int64(len(document)) {
		t.Fatalf("file = %#v, want 报告.pdf of %d bytes", file, len(document))
	}
	if got := bob.clipboard.stagedBytes(commit.Files.ID); !bytes.Equal(got, document) {
		t.Fatalf("staged file = %d bytes, want %d", len(got), len(document))
	}
}

func TestDirectoryRoundTripLandsEveryFile(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	order := []string{"a.txt", "图.png"}
	files := map[string][]byte{"a.txt": []byte("first file"), "图.png": imagePayload(1000)}
	stream := directoryStream("相册", order, files)
	alice.triggerKind = "file"
	alice.payload.setFile(DirectoryMIME, "相册", stream)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收 1 条内容") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	commit := commitFiles(t, bob.clipboard)
	if len(commit.Files.Files) != len(order) {
		t.Fatalf("files = %#v", commit.Files.Files)
	}
	for index, name := range order {
		file := commit.Files.Files[index]
		if file.Name != name || file.Size != int64(len(files[name])) {
			t.Fatalf("file %d = %#v, want %s of %d bytes", index, file, name, len(files[name]))
		}
	}
	if got := bob.clipboard.stagedBytes(commit.Files.ID); !bytes.Equal(got, stream) {
		t.Fatalf("staged stream = %d bytes, want %d", len(got), len(stream))
	}
}

func TestMediaOversizeIsRefusedWithoutSending(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "big.png", imagePayload(MaxMediaPayloadBytes+1))
	alice.step()
	output, err := alice.run(CommandPush)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "图片与文件同步上限") {
		t.Fatalf("push output = %q", output)
	}
	state := alice.state()
	if len(state.Queue) != 0 {
		t.Fatalf("an oversized image was queued: %#v", state.Queue)
	}
	if len(state.Recent) == 0 || state.Recent[0].Result != "skipped" {
		t.Fatalf("recent = %#v", state.Recent)
	}
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	if got := len(bob.clipboard.commits); got != 0 {
		t.Fatalf("the receiver committed %d images", got)
	}
}

func TestMissingChunkIsRefetchedOnNextPull(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	image := imagePayload(300 << 10)
	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "截图.png", image)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}

	// Only the first message reaches bob this pull.
	bob.filterMailbox(false, func(index int, _ string) bool { return index == 0 })
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收部分内容") {
		t.Fatalf("partial pull output = %q err = %v", output, err)
	}
	status := bob.status()
	if len(status.Transfers.Inbound) != 1 {
		t.Fatalf("inbound groups = %#v", status.Transfers.Inbound)
	}
	pending := status.Transfers.Inbound[0]
	if pending.Received != 1 || pending.Total != 2 || pending.Complete {
		t.Fatalf("pending group = %#v", pending)
	}
	if got := len(bob.clipboard.commits); got != 0 {
		t.Fatal("an incomplete group was committed")
	}

	bob.filterMailbox(false, nil)
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收 1 条内容") {
		t.Fatalf("completing pull output = %q err = %v", output, err)
	}
	commit := commitImage(t, bob.clipboard)
	if got := bob.clipboard.stagedBytes(commit.Image.ID); !bytes.Equal(got, image) {
		t.Fatalf("staged image = %d bytes, want %d", len(got), len(image))
	}
}

func TestPartialGroupExpiresWholeAfterTTL(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	image := imagePayload(300 << 10)
	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "截图.png", image)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}

	bob.filterMailbox(false, func(index int, _ string) bool { return index == 0 })
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}

	// After the TTL the half-received group is voided whole: nothing lands,
	// even if the missing chunk arrives later. (The leftover chunk still
	// arrives on this pull, so the output speaks of partial content — but the
	// voided group is gone and recorded.)
	clock.Advance(InboundGroupTTL + time.Minute)
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收部分内容") {
		t.Fatalf("pull after TTL output = %q err = %v", output, err)
	}
	if got := len(bob.clipboard.commits); got != 0 {
		t.Fatal("an expired group was committed")
	}
	failures := bob.status().Transfers.Failures
	if len(failures) == 0 || failures[0].Result != "dropped" {
		t.Fatalf("failures = %#v", failures)
	}

	// The other half is still on the relay; it may complete into a new group
	// record, but it can never apply as half of the old one.
	bob.filterMailbox(false, nil)
	bob.step()
	if _, err := bob.run(CommandPull); err != nil {
		t.Fatal(err)
	}
	if got := len(bob.clipboard.commits); got != 0 {
		t.Fatal("leftover chunks from a voided group landed anyway")
	}
}

func TestCancelledMediaLandingWritesNothing(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	image := imagePayload(300 << 10)
	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "截图.png", image)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}

	bob.clipboard.mu.Lock()
	bob.clipboard.cancelNext = true
	bob.clipboard.mu.Unlock()
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	bob.clipboard.mu.Lock()
	commits, writes := len(bob.clipboard.commits), len(bob.clipboard.writes)
	bob.clipboard.mu.Unlock()
	if commits != 0 || writes != 0 {
		t.Fatalf("a declined landing wrote to the clipboard: %d commits, %d writes",
			commits, writes)
	}
	failures := bob.status().Transfers.Failures
	if len(failures) == 0 || failures[0].Result != "cancelled" {
		t.Fatalf("failures = %#v", failures)
	}

	// The cancelled group is voided: the next pull must not prompt again.
	bob.clipboard.mu.Lock()
	bob.clipboard.cancelNext = true
	bob.clipboard.mu.Unlock()
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("second pull output = %q err = %v", output, err)
	}
	bob.clipboard.mu.Lock()
	commits, cancelArmed := len(bob.clipboard.commits), bob.clipboard.cancelNext
	bob.clipboard.mu.Unlock()
	if commits != 0 || !cancelArmed {
		t.Fatal("the cancelled group prompted for a landing again")
	}
}

func TestTamperedMediaMessageIsRejectedWithoutLanding(t *testing.T) {
	clock := newTestClock()
	relayURL := newTestRelay(t, clock)
	network := newTestNetwork()
	alice := newTestInstall(t, clock, network, relayURL, "alice")
	bob := newTestInstall(t, clock, network, relayURL, "bob")
	pair(t, alice, bob)

	image := imagePayload(300 << 10)
	alice.triggerKind = "image"
	alice.payload.setFile("image/png", "截图.png", image)
	alice.step()
	if _, err := alice.run(CommandPush); err != nil {
		t.Fatal(err)
	}

	bob.filterMailbox(true, nil)
	bob.step()
	// The corrupted chunk is refused; its clean sibling still arrives, so the
	// pull reports partial content.
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "已接收部分内容") {
		t.Fatalf("pull output = %q err = %v", output, err)
	}
	bob.clipboard.mu.Lock()
	commits, writes := len(bob.clipboard.commits), len(bob.clipboard.writes)
	staged := len(bob.clipboard.staged)
	bob.clipboard.mu.Unlock()
	if commits != 0 || writes != 0 || staged != 0 {
		t.Fatalf("a corrupted transfer reached the clipboard: %d commits, %d writes, %d staged",
			commits, writes, staged)
	}
	failures := bob.status().Transfers.Failures
	if len(failures) == 0 || failures[0].Result != "failed" {
		t.Fatalf("failures = %#v", failures)
	}
	// The corrupted message was removed, so nothing surfaces again.
	bob.step()
	if output, err := bob.run(CommandPull); err != nil ||
		!strings.Contains(output, "没有新的同步内容") {
		t.Fatalf("second pull output = %q err = %v", output, err)
	}
}

func TestParseMediaManifestGates(t *testing.T) {
	stream := directoryStream("相册", []string{"a.txt"},
		map[string][]byte{"a.txt": []byte("content")})
	manifest, err := parseMediaManifest(stream)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Name != "相册" || len(manifest.Files) != 1 ||
		manifest.Files[0].Name != "a.txt" || manifest.Files[0].Size != 7 {
		t.Fatalf("manifest = %#v", manifest)
	}

	cases := map[string][]byte{
		"缺少结束行": []byte(`{"name":"x","files":[]}`),
		"无法读取":  []byte("not json\n"),
		"缺少目录名": []byte(`{"name":"","files":[]}` + "\n"),
		"需要 1":  []byte(`{"name":"x","files":[]}` + "\n"),
	}
	cases["字节数不一致"] = func() []byte {
		// One byte short: the manifest promises 7, the body carries 6.
		broken := directoryStream("x", []string{"a.txt"},
			map[string][]byte{"a.txt": []byte("content")})
		return broken[:len(broken)-1]
	}()
	for name, payload := range cases {
		if _, err := parseMediaManifest(payload); err == nil ||
			!strings.Contains(err.Error(), name) {
			t.Fatalf("%s: error = %v", name, err)
		}
	}
}
