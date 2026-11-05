// Package relay implements the storage-forwarding relay for MyPaste's
// cross-device sync (D-1028). It stores opaque ciphertext in per-device
// mailboxes and never holds a device's private keys; the wire protocol is
// documented in docs/SYNC.md.
//
// The relay is an independent program (cmd/mypaste-relay), not part of the
// desktop host. It uses only the standard library and the file system.
package relay

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Wire limits and lifetimes. They are part of the protocol (docs/SYNC.md) and
// are deliberately constants: the sync extension is written against them.
const (
	protocolName = "mypaste-relay-v1"

	maxCiphertextBytes    = 200 << 10
	maxMessagesPerMailbox = 1000
	maxMailboxBytes       = 100 << 20

	minMessageTTL     = time.Minute
	defaultMessageTTL = 72 * time.Hour
	maxMessageTTL     = 7 * 24 * time.Hour

	minPairingTTL     = time.Minute
	defaultPairingTTL = 10 * time.Minute
	maxPairingTTL     = 10 * time.Minute

	clockSkew = 5 * time.Minute

	maxRequestBody = 320 << 10

	defaultPullLimit = 50
	maxPullLimit     = 100

	pairingFailureLimit  = 5
	pairingFailureWindow = time.Hour

	maxDeviceNameBytes = 64
	maxPairingAttempts = 8
)

var (
	// deviceIDPattern is base64url(SHA-256(signingKey)) without padding.
	deviceIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	messageIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pairingCodePattern = regexp.MustCompile(`^[0-9]{6}$`)
)

// Device is the public identity record the relay keeps for one device. Both
// keys are public: Ed25519 authenticates requests, X25519 derives the
// end-to-end encryption keys on the two devices.
type Device struct {
	DeviceID    string    `json:"deviceId"`
	SigningKey  []byte    `json:"signingKey"`
	ExchangeKey []byte    `json:"exchangeKey"`
	Name        string    `json:"name,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Message is one opaque envelope in a mailbox. Sequence is assigned by the
// relay and persists across restarts so pull order is arrival order even when
// two messages share a timestamp.
type Message struct {
	MessageID  string    `json:"messageId"`
	SenderID   string    `json:"senderId"`
	ReceivedAt time.Time `json:"receivedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Sequence   int64     `json:"sequence"`
	Ciphertext []byte    `json:"ciphertext"`
}

type pairing struct {
	CreatorID  string     `json:"creatorId"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	RedeemedBy string     `json:"redeemedBy,omitempty"`
	RedeemedAt *time.Time `json:"redeemedAt,omitempty"`
}

type registerRequest struct {
	DeviceID    string `json:"deviceId"`
	SigningKey  []byte `json:"signingKey"`
	ExchangeKey []byte `json:"exchangeKey"`
	Name        string `json:"name"`
}

type registerResponse struct {
	DeviceID string `json:"deviceId"`
	Created  bool   `json:"created"`
}

type pairingRequest struct {
	TTLSeconds int `json:"ttlSeconds"`
}

type pairingResponse struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type redeemResponse struct {
	Device    deviceView `json:"device"`
	ExpiresAt time.Time  `json:"expiresAt"`
}

type deviceView struct {
	DeviceID    string `json:"deviceId"`
	SigningKey  []byte `json:"signingKey"`
	ExchangeKey []byte `json:"exchangeKey"`
	Name        string `json:"name,omitempty"`
}

type deliverRequest struct {
	MessageID  string `json:"messageId"`
	TTLSeconds int    `json:"ttlSeconds"`
	Ciphertext []byte `json:"ciphertext"`
}

type deliverResponse struct {
	MessageID  string    `json:"messageId"`
	ReceivedAt time.Time `json:"receivedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Duplicate  bool      `json:"duplicate"`
}

type messageView struct {
	MessageID  string    `json:"messageId"`
	SenderID   string    `json:"senderId"`
	ReceivedAt time.Time `json:"receivedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Size       int       `json:"size"`
	Ciphertext []byte    `json:"ciphertext"`
}

type listResponse struct {
	Messages []messageView `json:"messages"`
	More     bool          `json:"more"`
}

type errorEnvelope struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// apiError is a failure with an HTTP status and a stable machine-readable
// code. Its message is safe to return to clients: it never contains bodies,
// keys, pairing codes, or file-system paths.
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

var errStorage = &apiError{
	Status:  http.StatusInternalServerError,
	Code:    "storage_failure",
	Message: "the relay could not access its storage; retry later",
}

func badRequest(message string) *apiError {
	return &apiError{Status: http.StatusBadRequest, Code: "bad_request", Message: message}
}

func unauthorized(message string) *apiError {
	return &apiError{Status: http.StatusUnauthorized, Code: "unauthorized", Message: message}
}

func forbidden(message string) *apiError {
	return &apiError{Status: http.StatusForbidden, Code: "forbidden", Message: message}
}

func notFound(code, message string) *apiError {
	return &apiError{Status: http.StatusNotFound, Code: code, Message: message}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err *apiError) {
	writeJSON(w, err.Status, errorEnvelope{Error: errorDetail{Code: err.Code, Message: err.Message}})
}

func readBody(r *http.Request) ([]byte, *apiError) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		return nil, badRequest("the request body could not be read")
	}
	if len(body) > maxRequestBody {
		return nil, &apiError{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    "payload_too_large",
			Message: fmt.Sprintf("request body exceeds %d bytes", maxRequestBody),
		}
	}
	return body, nil
}

func decodeJSON(body []byte, dst any) *apiError {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return badRequest("request body is not valid JSON for this endpoint")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return badRequest("request body must contain exactly one JSON object")
	}
	return nil
}

func decodeKey(value []byte) bool { return len(value) == 32 }

func deviceIDFor(signingKey []byte) string {
	sum := sha256.Sum256(signingKey)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func validMessageID(id string) bool { return messageIDPattern.MatchString(id) }

func normalizeDeviceName(name string) (string, *apiError) {
	name = strings.TrimSpace(name)
	if len(name) > maxDeviceNameBytes || !utf8.ValidString(name) {
		return "", badRequest(fmt.Sprintf("name must be at most %d valid UTF-8 bytes", maxDeviceNameBytes))
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", badRequest("name must not contain control characters")
		}
	}
	return name, nil
}

func messageTTL(seconds int) (time.Duration, *apiError) {
	if seconds == 0 {
		return defaultMessageTTL, nil
	}
	ttl := time.Duration(seconds) * time.Second
	if ttl < minMessageTTL || ttl > maxMessageTTL {
		return 0, badRequest(fmt.Sprintf("ttlSeconds must be between %d and %d",
			int(minMessageTTL.Seconds()), int(maxMessageTTL.Seconds())))
	}
	return ttl, nil
}

func pairingTTL(seconds int) (time.Duration, *apiError) {
	if seconds == 0 {
		return defaultPairingTTL, nil
	}
	ttl := time.Duration(seconds) * time.Second
	if ttl < minPairingTTL || ttl > maxPairingTTL {
		return 0, badRequest(fmt.Sprintf("ttlSeconds must be between %d and %d",
			int(minPairingTTL.Seconds()), int(maxPairingTTL.Seconds())))
	}
	return ttl, nil
}
