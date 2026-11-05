package relay

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	headerDevice    = "X-MyPaste-Device"
	headerTimestamp = "X-MyPaste-Timestamp"
	headerSignature = "X-MyPaste-Signature"
)

// Exported header names and the canonical-request builder are the protocol's
// one owner. The sync extension's relay client signs the same bytes the relay
// verifies; a second copy would be a second protocol definition.
const (
	HeaderDevice    = headerDevice
	HeaderTimestamp = headerTimestamp
	HeaderSignature = headerSignature
)

// CanonicalRequest is the exact byte string a client signs. Its shape is part
// of the protocol: changing it requires a new protocol name. The body digest
// is lowercase hex SHA-256; the target is path plus "?" plus raw query, as
// sent on the request line.
func CanonicalRequest(method, target, deviceID string, timestamp int64, body []byte) []byte {
	return canonicalRequest(method, target, deviceID, timestamp, body)
}

// canonicalRequest is the exact byte string a client signs. Its shape is part
// of the protocol: changing it requires a new protocol name. The body digest
// is lowercase hex SHA-256; the target is path plus "?" plus raw query, as
// sent on the request line.
func canonicalRequest(method, target, deviceID string, timestamp int64, body []byte) []byte {
	digest := sha256.Sum256(body)
	var builder []byte
	builder = append(builder, protocolName...)
	builder = append(builder, '\n')
	builder = append(builder, method...)
	builder = append(builder, '\n')
	builder = append(builder, target...)
	builder = append(builder, '\n')
	builder = append(builder, strconv.FormatInt(timestamp, 10)...)
	builder = append(builder, '\n')
	builder = append(builder, deviceID...)
	builder = append(builder, '\n')
	builder = append(builder, hex.EncodeToString(digest[:])...)
	return builder
}

// replayCache remembers accepted signatures until their timestamp leaves the
// clock-skew window. It is in memory: after a relay restart, a signature that
// is still inside the window could be replayed once. Clients also make
// delivery idempotent with messageId, which bounds that window's impact; the
// residual risk is documented in docs/SYNC.md.
type replayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newReplayCache() *replayCache {
	return &replayCache{seen: make(map[string]time.Time)}
}

func (c *replayCache) claim(signature []byte, expires, now time.Time) bool {
	key := string(signature)
	c.mu.Lock()
	defer c.mu.Unlock()
	for seen, expiry := range c.seen {
		if !expiry.After(now) {
			delete(c.seen, seen)
		}
	}
	if _, exists := c.seen[key]; exists {
		return false
	}
	c.seen[key] = expires
	return true
}

// failureLimiter counts failed pairing redemptions per peer address in a
// sliding window. Successful redemptions do not reset the window: the limit
// bounds guessing, not use.
type failureLimiter struct {
	mu       sync.Mutex
	limit    int
	window   time.Duration
	failures map[string][]time.Time
}

func newFailureLimiter(limit int, window time.Duration) *failureLimiter {
	return &failureLimiter{limit: limit, window: window, failures: make(map[string][]time.Time)}
}

func (l *failureLimiter) prune(key string, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	kept := l.failures[key][:0]
	for _, at := range l.failures[key] {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, key)
		return nil
	}
	l.failures[key] = kept
	return kept
}

func (l *failureLimiter) blocked(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.prune(key, now)) >= l.limit
}

func (l *failureLimiter) record(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[key] = append(l.prune(key, now), now)
}

// verifyRequest checks the three authentication headers against publicKey and
// returns the device ID the client claimed. It rejects timestamps outside the
// five-minute window, bad signatures, and signatures already accepted.
func (s *Server) verifyRequest(r *http.Request, body []byte, publicKey ed25519.PublicKey) (string, *apiError) {
	deviceID := r.Header.Get(headerDevice)
	if !deviceIDPattern.MatchString(deviceID) {
		return "", unauthorized("missing or invalid " + headerDevice + " header")
	}
	timestampHeader := r.Header.Get(headerTimestamp)
	if timestampHeader == "" {
		return "", unauthorized("missing " + headerTimestamp + " header")
	}
	timestamp, err := strconv.ParseInt(timestampHeader, 10, 64)
	if err != nil || timestamp <= 0 {
		return "", unauthorized("invalid " + headerTimestamp + " header")
	}
	now := s.now()
	signedAt := time.Unix(timestamp, 0)
	if signedAt.Before(now.Add(-clockSkew)) || signedAt.After(now.Add(clockSkew)) {
		return "", unauthorized("request timestamp is outside the allowed 300 second window")
	}
	signatureHeader := r.Header.Get(headerSignature)
	signature, err := base64.RawURLEncoding.DecodeString(signatureHeader)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return "", unauthorized("missing or invalid " + headerSignature + " header")
	}
	canonical := canonicalRequest(r.Method, r.URL.RequestURI(), deviceID, timestamp, body)
	if !ed25519.Verify(publicKey, canonical, signature) {
		return "", unauthorized("request signature is not valid for this device")
	}
	if !s.replay.claim(signature, signedAt.Add(clockSkew), now) {
		return "", unauthorized("request signature was already used")
	}
	return deviceID, nil
}

// authenticate accepts a request from a registered device.
func (s *Server) authenticate(r *http.Request, body []byte) (string, *apiError) {
	deviceID := r.Header.Get(headerDevice)
	if !deviceIDPattern.MatchString(deviceID) {
		return "", unauthorized("missing or invalid " + headerDevice + " header")
	}
	device, err := s.store.device(deviceID)
	if err != nil {
		if isNotExist(err) {
			return "", unauthorized("device is not registered")
		}
		return "", errStorage
	}
	return s.verifyRequest(r, body, ed25519.PublicKey(device.SigningKey))
}

func peerAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
