package relay

import (
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Config configures one relay instance.
type Config struct {
	// DataDir is the only writable directory the relay uses.
	DataDir string
	// Logger receives operational events. A nil Logger discards them.
	Logger *slog.Logger
	// Now overrides the clock (tests); nil means time.Now.
	Now func() time.Time
}

// Server is the relay HTTP handler plus its storage. It holds no device
// private keys and never interprets ciphertext.
type Server struct {
	store           *store
	log             *slog.Logger
	now             func() time.Time
	replay          *replayCache
	pairingFailures *failureLimiter
}

// Open prepares the data directory and loads persisted state.
func Open(cfg Config) (*Server, error) {
	if strings.TrimSpace(cfg.DataDir) == "" {
		return nil, errors.New("relay data directory is required")
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	storage, err := openStore(cfg.DataDir, cfg.Logger, cfg.Now())
	if err != nil {
		return nil, err
	}
	return &Server{
		store:           storage,
		log:             cfg.Logger,
		now:             cfg.Now,
		replay:          newReplayCache(),
		pairingFailures: newFailureLimiter(pairingFailureLimit, pairingFailureWindow),
	}, nil
}

// Handler returns the relay's HTTP handler.
func (s *Server) Handler() http.Handler { return s }

// Cleanup removes expired messages and pairings.
func (s *Server) Cleanup(now time.Time) error { return s.store.cleanup(now) }

// Close releases relay state. The relay keeps no background goroutines, so
// this only exists to make ownership explicit.
func (s *Server) Close() error { return nil }

type endpoint int

const (
	endpointUnknown endpoint = iota
	endpointDevices
	endpointPairings
	endpointPairing
	endpointMailbox
	endpointMessage
)

type route struct {
	endpoint endpoint
	name     string
	params   []string
}

func classify(path string) route {
	if !strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return route{name: "unknown"}
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for _, part := range parts {
		if part == "" {
			return route{name: "unknown"}
		}
	}
	switch {
	case len(parts) == 2 && parts[0] == "v1" && parts[1] == "devices":
		return route{endpoint: endpointDevices, name: "devices"}
	case len(parts) == 2 && parts[0] == "v1" && parts[1] == "pairings":
		return route{endpoint: endpointPairings, name: "pairings"}
	case len(parts) == 3 && parts[0] == "v1" && parts[1] == "pairings":
		return route{endpoint: endpointPairing, name: "pairings.code", params: []string{parts[2]}}
	case len(parts) == 3 && parts[0] == "v1" && parts[1] == "mailbox":
		return route{endpoint: endpointMailbox, name: "mailbox", params: []string{parts[2]}}
	case len(parts) == 4 && parts[0] == "v1" && parts[1] == "mailbox":
		return route{endpoint: endpointMessage, name: "mailbox.message", params: []string{parts[2], parts[3]}}
	}
	return route{name: "unknown"}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	started := time.Now()
	recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	match := classify(r.URL.Path)
	name := match.name

	switch match.endpoint {
	case endpointDevices:
		if r.Method != http.MethodPost {
			s.methodNotAllowed(recorder, http.MethodPost)
			break
		}
		name = "devices.register"
		s.handleRegister(recorder, r)
	case endpointPairings:
		if r.Method != http.MethodPost {
			s.methodNotAllowed(recorder, http.MethodPost)
			break
		}
		name = "pairings.create"
		s.handleCreatePairing(recorder, r)
	case endpointPairing:
		if r.Method != http.MethodGet {
			s.methodNotAllowed(recorder, http.MethodGet)
			break
		}
		name = "pairings.redeem"
		s.handleRedeemPairing(recorder, r, match.params[0])
	case endpointMailbox:
		switch r.Method {
		case http.MethodPost:
			name = "mailbox.deliver"
			s.handleDeliver(recorder, r, match.params[0])
		case http.MethodGet:
			name = "mailbox.list"
			s.handleListMessages(recorder, r, match.params[0])
		default:
			s.methodNotAllowed(recorder, http.MethodPost+", "+http.MethodGet)
		}
	case endpointMessage:
		if r.Method != http.MethodDelete {
			s.methodNotAllowed(recorder, http.MethodDelete)
			break
		}
		name = "mailbox.delete"
		s.handleDeleteMessage(recorder, r, match.params[0], match.params[1])
	default:
		writeError(recorder, notFound("not_found", "no such endpoint"))
	}

	s.log.Info("relay request",
		"method", r.Method,
		"route", name,
		"status", recorder.status,
		"duration_ms", time.Since(started).Milliseconds(),
		"peer", peerAddress(r),
	)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.wrote {
		return
	}
	r.wrote = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if !r.wrote {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(data)
}

func (s *Server) methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, &apiError{
		Status:  http.StatusMethodNotAllowed,
		Code:    "method_not_allowed",
		Message: "this endpoint does not support that method",
	})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	body, aerr := readBody(r)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	var request registerRequest
	if aerr := decodeJSON(body, &request); aerr != nil {
		writeError(w, aerr)
		return
	}
	if !deviceIDPattern.MatchString(request.DeviceID) {
		writeError(w, badRequest("deviceId must be 43 base64url characters (base64url SHA-256 of signingKey)"))
		return
	}
	if !decodeKey(request.SigningKey) || !decodeKey(request.ExchangeKey) {
		writeError(w, badRequest("signingKey and exchangeKey must each be 32 bytes encoded as base64"))
		return
	}
	name, aerr := normalizeDeviceName(request.Name)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if deviceIDFor(request.SigningKey) != request.DeviceID {
		writeError(w, badRequest("deviceId must be base64url(SHA-256(signingKey))"))
		return
	}
	claimed, aerr := s.verifyRequest(r, body, ed25519.PublicKey(request.SigningKey))
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if claimed != request.DeviceID {
		writeError(w, unauthorized("the signed device ID does not match the registration body"))
		return
	}

	now := s.now()
	created, err := s.store.putDevice(Device{
		DeviceID:    request.DeviceID,
		SigningKey:  request.SigningKey,
		ExchangeKey: request.ExchangeKey,
		Name:        name,
	}, now)
	if err != nil {
		s.log.Error("relay storage failed", "operation", "register_device", "error", err)
		writeError(w, errStorage)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, registerResponse{DeviceID: request.DeviceID, Created: created})
}

func (s *Server) handleCreatePairing(w http.ResponseWriter, r *http.Request) {
	body, aerr := readBody(r)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	creator, aerr := s.authenticate(r, body)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	var request pairingRequest
	if aerr := decodeJSON(body, &request); aerr != nil {
		writeError(w, aerr)
		return
	}
	ttl, aerr := pairingTTL(request.TTLSeconds)
	if aerr != nil {
		writeError(w, aerr)
		return
	}

	code, expiresAt, err := s.store.createPairing(creator, ttl, s.now())
	if err != nil {
		s.log.Error("relay storage failed", "operation", "create_pairing", "error", err)
		writeError(w, errStorage)
		return
	}
	writeJSON(w, http.StatusCreated, pairingResponse{Code: code, ExpiresAt: expiresAt})
}

func (s *Server) handleRedeemPairing(w http.ResponseWriter, r *http.Request, code string) {
	redeemer, aerr := s.authenticate(r, nil)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	now := s.now()
	peer := peerAddress(r)
	if s.pairingFailures.blocked(peer, now) {
		writeError(w, &apiError{
			Status:  http.StatusTooManyRequests,
			Code:    "rate_limited",
			Message: "too many failed pairing attempts from this address; retry within an hour",
		})
		return
	}
	if !pairingCodePattern.MatchString(code) {
		s.pairingFailures.record(peer, now)
		writeError(w, pairingUnavailable())
		return
	}

	value, err := s.store.redeemPairing(pairingHash(code), redeemer, now)
	if err != nil {
		if errors.Is(err, errPairingUnusable) {
			s.pairingFailures.record(peer, now)
			writeError(w, pairingUnavailable())
			return
		}
		s.log.Error("relay storage failed", "operation", "redeem_pairing", "error", err)
		writeError(w, errStorage)
		return
	}

	creator, err := s.store.device(value.CreatorID)
	if err != nil {
		s.log.Error("relay storage failed", "operation", "read_pairing_creator", "error", err)
		writeError(w, errStorage)
		return
	}
	writeJSON(w, http.StatusOK, redeemResponse{
		Device: deviceView{
			DeviceID:    creator.DeviceID,
			SigningKey:  creator.SigningKey,
			ExchangeKey: creator.ExchangeKey,
			Name:        creator.Name,
		},
		ExpiresAt: value.ExpiresAt,
	})
}

func pairingUnavailable() *apiError {
	return notFound("pairing_unavailable", "pairing code is invalid, expired, or already used")
}

func (s *Server) handleDeliver(w http.ResponseWriter, r *http.Request, recipient string) {
	body, aerr := readBody(r)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	sender, aerr := s.authenticate(r, body)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if !deviceIDPattern.MatchString(recipient) {
		writeError(w, notFound("unknown_recipient", "recipient device is not registered"))
		return
	}
	var request deliverRequest
	if aerr := decodeJSON(body, &request); aerr != nil {
		writeError(w, aerr)
		return
	}
	if !validMessageID(request.MessageID) {
		writeError(w, badRequest("messageId must be 43 base64url characters"))
		return
	}
	if len(request.Ciphertext) == 0 {
		writeError(w, badRequest("ciphertext must not be empty"))
		return
	}
	if len(request.Ciphertext) > maxCiphertextBytes {
		writeError(w, &apiError{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    "payload_too_large",
			Message: "ciphertext exceeds the 204800 byte limit",
		})
		return
	}
	ttl, aerr := messageTTL(request.TTLSeconds)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if _, err := s.store.device(recipient); err != nil {
		if isNotExist(err) {
			writeError(w, notFound("unknown_recipient", "recipient device is not registered"))
			return
		}
		s.log.Error("relay storage failed", "operation", "read_recipient", "error", err)
		writeError(w, errStorage)
		return
	}

	now := s.now()
	stored, duplicate, err := s.store.deliver(recipient, Message{
		MessageID:  request.MessageID,
		SenderID:   sender,
		ExpiresAt:  now.Add(ttl),
		Ciphertext: request.Ciphertext,
	}, now)
	if err != nil {
		switch {
		case errors.Is(err, errMessageConflict):
			writeError(w, &apiError{
				Status:  http.StatusConflict,
				Code:    "message_conflict",
				Message: "messageId is already stored with different content",
			})
		case errors.Is(err, errMailboxFull):
			writeError(w, &apiError{
				Status:  http.StatusInsufficientStorage,
				Code:    "mailbox_full",
				Message: "mailbox reached 1000 messages or 104857600 bytes; delete applied messages and retry",
			})
		default:
			s.log.Error("relay storage failed", "operation", "deliver", "error", err)
			writeError(w, errStorage)
		}
		return
	}

	status := http.StatusCreated
	if duplicate {
		status = http.StatusOK
	}
	writeJSON(w, status, deliverResponse{
		MessageID:  stored.MessageID,
		ReceivedAt: stored.ReceivedAt,
		ExpiresAt:  stored.ExpiresAt,
		Duplicate:  duplicate,
	})
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request, deviceID string) {
	if !deviceIDPattern.MatchString(deviceID) {
		writeError(w, notFound("not_found", "no such mailbox"))
		return
	}
	requester, aerr := s.authenticate(r, nil)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if requester != deviceID {
		writeError(w, forbidden("a device may only read its own mailbox"))
		return
	}
	limit, aerr := pullLimit(r)
	if aerr != nil {
		writeError(w, aerr)
		return
	}

	now := s.now()
	messages, more, err := s.store.messages(deviceID, limit, now)
	if err != nil {
		s.log.Error("relay storage failed", "operation", "list_messages", "error", err)
		writeError(w, errStorage)
		return
	}
	views := make([]messageView, 0, len(messages))
	for _, message := range messages {
		views = append(views, messageView{
			MessageID:  message.MessageID,
			SenderID:   message.SenderID,
			ReceivedAt: message.ReceivedAt,
			ExpiresAt:  message.ExpiresAt,
			Size:       len(message.Ciphertext),
			Ciphertext: message.Ciphertext,
		})
	}
	writeJSON(w, http.StatusOK, listResponse{Messages: views, More: more})
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request, deviceID, messageID string) {
	if !deviceIDPattern.MatchString(deviceID) || !validMessageID(messageID) {
		writeError(w, notFound("not_found", "no such message"))
		return
	}
	requester, aerr := s.authenticate(r, nil)
	if aerr != nil {
		writeError(w, aerr)
		return
	}
	if requester != deviceID {
		writeError(w, forbidden("a device may only delete messages from its own mailbox"))
		return
	}

	deleted, err := s.store.deleteMessage(deviceID, messageID, s.now())
	if err != nil {
		s.log.Error("relay storage failed", "operation", "delete_message", "error", err)
		writeError(w, errStorage)
		return
	}
	if !deleted {
		writeError(w, notFound("not_found", "message is not in the mailbox"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func pullLimit(r *http.Request) (int, *apiError) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultPullLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxPullLimit {
		return 0, badRequest("limit must be an integer between 1 and 100")
	}
	return limit, nil
}
