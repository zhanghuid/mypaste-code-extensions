package relay

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	errMailboxFull     = errors.New("mailbox is full")
	errMessageConflict = errors.New("message id already exists with different content")
	errPairingUnusable = errors.New("pairing code is invalid, expired, or already used")
)

func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }

// store owns the relay's on-disk state. The file system is the source of
// truth: devices are read on demand, mailboxes are indexed on first use, and
// every write is atomic (temporary file, fsync, rename, directory fsync).
// One mutex serializes metadata changes; the relay is a small self-hosted
// service, and a held lock across a 200 KiB write is an acceptable trade for a
// single, auditable ownership boundary.
type store struct {
	dir string
	log *slog.Logger

	// Per-mailbox quotas. Production values come from protocol.go; tests
	// shrink them to exercise the refusal paths without writing 100 MiB.
	maxMessages int
	maxBytes    int

	mu        sync.Mutex
	pairings  map[string]*pairing
	mailboxes map[string]*mailbox
}

type storedMessage struct {
	Message
	digest [32]byte
}

type mailbox struct {
	dir          string
	messages     map[string]*storedMessage
	nextSequence int64
}

func openStore(dir string, log *slog.Logger, now time.Time) (*store, error) {
	for _, name := range []string{"", "devices", "mailboxes", "pairings"} {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			return nil, fmt.Errorf("prepare relay data directory: %w", err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			return nil, fmt.Errorf("restrict relay data directory: %w", err)
		}
	}
	s := &store{
		dir:         dir,
		log:         log,
		maxMessages: maxMessagesPerMailbox,
		maxBytes:    maxMailboxBytes,
		pairings:    make(map[string]*pairing),
		mailboxes:   make(map[string]*mailbox),
	}
	if err := s.loadPairings(now); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *store) devicesDir() string   { return filepath.Join(s.dir, "devices") }
func (s *store) mailboxesDir() string { return filepath.Join(s.dir, "mailboxes") }
func (s *store) pairingsDir() string  { return filepath.Join(s.dir, "pairings") }

func (s *store) device(id string) (Device, error) {
	data, err := os.ReadFile(filepath.Join(s.devicesDir(), id+".json"))
	if err != nil {
		return Device{}, err
	}
	var device Device
	if err := json.Unmarshal(data, &device); err != nil {
		return Device{}, fmt.Errorf("device record is unreadable: %w", err)
	}
	if device.DeviceID != id || len(device.SigningKey) != 32 || len(device.ExchangeKey) != 32 {
		return Device{}, errors.New("device record is invalid")
	}
	return device, nil
}

func (s *store) putDevice(device Device, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, err := s.device(device.DeviceID)
	created := isNotExist(err)
	if err != nil && !created {
		return false, err
	}
	if created {
		device.CreatedAt = now
	} else {
		if !bytes.Equal(existing.SigningKey, device.SigningKey) {
			return false, errors.New("a device signing key cannot change")
		}
		device.CreatedAt = existing.CreatedAt
	}
	device.UpdatedAt = now

	data, err := json.Marshal(device)
	if err != nil {
		return false, err
	}
	if err := writeFileAtomic(s.devicesDir(), device.DeviceID+".json", data); err != nil {
		return false, err
	}
	return created, nil
}

func (s *store) loadMailboxLocked(deviceID string, now time.Time) (*mailbox, error) {
	if existing, ok := s.mailboxes[deviceID]; ok {
		s.purgeMailboxLocked(existing, now)
		return existing, nil
	}
	dir := filepath.Join(s.mailboxesDir(), deviceID)
	box := &mailbox{dir: dir, messages: make(map[string]*storedMessage)}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !isNotExist(err) {
			return nil, err
		}
		s.mailboxes[deviceID] = box
		return box, nil
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		messageID := strings.TrimSuffix(name, ".json")
		if !validMessageID(messageID) {
			continue
		}
		message, digest, err := readMessageFile(filepath.Join(dir, name))
		if err != nil || message.MessageID != messageID {
			s.log.Warn("relay skipped an unreadable message file", "device", deviceID)
			continue
		}
		if !message.ExpiresAt.After(now) {
			_ = os.Remove(filepath.Join(dir, name))
			continue
		}
		box.messages[messageID] = &storedMessage{Message: message, digest: digest}
		if message.Sequence >= box.nextSequence {
			box.nextSequence = message.Sequence + 1
		}
	}
	s.mailboxes[deviceID] = box
	return box, nil
}

func (s *store) purgeMailboxLocked(box *mailbox, now time.Time) {
	for id, stored := range box.messages {
		if stored.ExpiresAt.After(now) {
			continue
		}
		_ = os.Remove(filepath.Join(box.dir, id+".json"))
		delete(box.messages, id)
	}
}

func (box *mailbox) totalBytes() int {
	total := 0
	for _, stored := range box.messages {
		total += len(stored.Ciphertext)
	}
	return total
}

// deliver stores one ciphertext envelope. Repeating a messageId with the same
// sender and bytes is idempotent and returns the stored message; reusing it
// for different content is a conflict.
func (s *store) deliver(recipient string, message Message, now time.Time) (Message, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	box, err := s.loadMailboxLocked(recipient, now)
	if err != nil {
		return Message{}, false, err
	}
	digest := sha256.Sum256(message.Ciphertext)
	if existing, ok := box.messages[message.MessageID]; ok {
		if existing.SenderID == message.SenderID && existing.digest == digest {
			return existing.Message, true, nil
		}
		return Message{}, false, errMessageConflict
	}
	if len(box.messages) >= s.maxMessages ||
		box.totalBytes()+len(message.Ciphertext) > s.maxBytes {
		return Message{}, false, errMailboxFull
	}

	message.ReceivedAt = now
	message.Sequence = box.nextSequence
	box.nextSequence++

	data, err := json.Marshal(message)
	if err != nil {
		return Message{}, false, err
	}
	if err := os.MkdirAll(box.dir, 0o700); err != nil {
		return Message{}, false, err
	}
	if err := writeFileAtomic(box.dir, message.MessageID+".json", data); err != nil {
		return Message{}, false, err
	}
	box.messages[message.MessageID] = &storedMessage{Message: message, digest: digest}
	return message, false, nil
}

// messages returns the oldest messages in arrival order. more reports whether
// the mailbox holds messages beyond limit.
func (s *store) messages(deviceID string, limit int, now time.Time) ([]Message, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	box, err := s.loadMailboxLocked(deviceID, now)
	if err != nil {
		return nil, false, err
	}
	ordered := make([]*storedMessage, 0, len(box.messages))
	for _, stored := range box.messages {
		ordered = append(ordered, stored)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Sequence != ordered[j].Sequence {
			return ordered[i].Sequence < ordered[j].Sequence
		}
		return ordered[i].MessageID < ordered[j].MessageID
	})

	more := len(ordered) > limit
	if more {
		ordered = ordered[:limit]
	}
	result := make([]Message, 0, len(ordered))
	for _, stored := range ordered {
		message, _, err := readMessageFile(filepath.Join(box.dir, stored.MessageID+".json"))
		if err != nil {
			s.log.Warn("relay skipped an unreadable message file", "device", deviceID)
			continue
		}
		message.Sequence = stored.Sequence
		result = append(result, message)
	}
	return result, more, nil
}

func (s *store) deleteMessage(deviceID, messageID string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	box, err := s.loadMailboxLocked(deviceID, now)
	if err != nil {
		return false, err
	}
	if _, ok := box.messages[messageID]; !ok {
		return false, nil
	}
	if err := os.Remove(filepath.Join(box.dir, messageID+".json")); err != nil && !isNotExist(err) {
		return false, err
	}
	delete(box.messages, messageID)
	return true, nil
}

func pairingHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func (s *store) loadPairings(now time.Time) error {
	entries, err := os.ReadDir(s.pairingsDir())
	if err != nil {
		if isNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		hash := strings.TrimSuffix(name, ".json")
		if len(hash) != 64 {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.pairingsDir(), name))
		if err != nil {
			return err
		}
		var value pairing
		if err := json.Unmarshal(data, &value); err != nil {
			s.log.Warn("relay skipped an unreadable pairing file")
			continue
		}
		if !value.ExpiresAt.After(now) {
			_ = os.Remove(filepath.Join(s.pairingsDir(), name))
			continue
		}
		s.pairings[hash] = &value
	}
	return nil
}

func (s *store) purgePairingsLocked(now time.Time) {
	for hash, value := range s.pairings {
		if value.ExpiresAt.After(now) {
			continue
		}
		_ = os.Remove(filepath.Join(s.pairingsDir(), hash+".json"))
		delete(s.pairings, hash)
	}
}

func (s *store) createPairing(creator string, ttl time.Duration, now time.Time) (string, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgePairingsLocked(now)

	var (
		code string
		hash string
	)
	for attempt := 0; attempt < maxPairingAttempts; attempt++ {
		candidate, err := randomPairingCode()
		if err != nil {
			return "", time.Time{}, err
		}
		if _, exists := s.pairings[pairingHash(candidate)]; exists {
			continue
		}
		code = candidate
		hash = pairingHash(candidate)
		break
	}
	if code == "" {
		return "", time.Time{}, errors.New("could not allocate a unique pairing code")
	}

	value := &pairing{CreatorID: creator, ExpiresAt: now.Add(ttl)}
	data, err := json.Marshal(value)
	if err != nil {
		return "", time.Time{}, err
	}
	if err := writeFileAtomic(s.pairingsDir(), hash+".json", data); err != nil {
		return "", time.Time{}, err
	}
	s.pairings[hash] = value
	return code, value.ExpiresAt, nil
}

// redeemPairing consumes a code exactly once. A redeemed or expired code is
// indistinguishable from an unknown one, so the caller cannot probe state.
func (s *store) redeemPairing(hash, redeemer string, now time.Time) (*pairing, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgePairingsLocked(now)

	value, ok := s.pairings[hash]
	if !ok || !value.ExpiresAt.After(now) || value.RedeemedBy != "" {
		return nil, errPairingUnusable
	}
	value.RedeemedBy = redeemer
	redeemedAt := now
	value.RedeemedAt = &redeemedAt

	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(s.pairingsDir(), hash+".json", data); err != nil {
		return nil, err
	}
	copied := *value
	return &copied, nil
}

// cleanup removes expired messages and pairings. It walks every mailbox, not
// just the ones already in memory, so an idle relay does not accumulate data.
func (s *store) cleanup(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgePairingsLocked(now)

	entries, err := os.ReadDir(s.mailboxesDir())
	if err != nil {
		if isNotExist(err) {
			return nil
		}
		return err
	}
	var firstErr error
	for _, entry := range entries {
		if !entry.IsDir() || !deviceIDPattern.MatchString(entry.Name()) {
			continue
		}
		if _, err := s.loadMailboxLocked(entry.Name(), now); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func randomPairingCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", value.Int64()), nil
}

func readMessageFile(path string) (Message, [32]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Message{}, [32]byte{}, err
	}
	var message Message
	if err := json.Unmarshal(data, &message); err != nil {
		return Message{}, [32]byte{}, err
	}
	if !validMessageID(message.MessageID) {
		return Message{}, [32]byte{}, errors.New("message id is invalid")
	}
	return message, sha256.Sum256(message.Ciphertext), nil
}

// writeFileAtomic writes data to dir/name so a reader never observes a partial
// file. The temporary file is created 0600 in the destination directory, then
// fsynced, renamed, and the directory itself is fsynced.
func writeFileAtomic(dir, name string, data []byte) error {
	if name == "" || strings.ContainsAny(name, `/\`) || name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return fmt.Errorf("refusing unsafe file name %q", name)
	}
	temp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}
	if err := temp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Rename(tempName, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
