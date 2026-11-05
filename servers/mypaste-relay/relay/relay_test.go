package relay

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(duration)
}

type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

type testRelay struct {
	t      *testing.T
	clock  *fakeClock
	server *Server
	http   *httptest.Server
	logs   *syncBuffer
	dir    string

	closeOnce sync.Once
}

func newTestRelay(t *testing.T) *testRelay {
	t.Helper()
	return startRelay(t, t.TempDir(), newFakeClock())
}

func startRelay(t *testing.T, dir string, clock *fakeClock) *testRelay {
	t.Helper()
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	server, err := Open(Config{DataDir: dir, Logger: logger, Now: clock.Now})
	if err != nil {
		t.Fatalf("open relay: %v", err)
	}
	httpServer := httptest.NewServer(server.Handler())
	relay := &testRelay{t: t, clock: clock, server: server, http: httpServer, logs: logs, dir: dir}
	t.Cleanup(relay.close)
	return relay
}

func (r *testRelay) close() {
	r.closeOnce.Do(func() {
		r.http.Close()
		_ = r.server.Close()
	})
}

type testDevice struct {
	id       string
	private  ed25519.PrivateKey
	public   ed25519.PublicKey
	exchange []byte
	name     string
}

func newTestDevice(t *testing.T, name string) *testDevice {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	exchange := make([]byte, 32)
	if _, err := rand.Read(exchange); err != nil {
		t.Fatal(err)
	}
	return &testDevice{id: deviceIDFor(public), private: private, public: public, exchange: exchange, name: name}
}

func (d *testDevice) registration() registerRequest {
	return registerRequest{
		DeviceID:    d.id,
		SigningKey:  d.public,
		ExchangeKey: d.exchange,
		Name:        d.name,
	}
}

func (r *testRelay) signed(device *testDevice, method, target string, body []byte, timestamp int64) *http.Request {
	r.t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request := httptest.NewRequest(method, r.http.URL+target, reader)
	request.Header.Set(headerDevice, device.id)
	request.Header.Set(headerTimestamp, strconv.FormatInt(timestamp, 10))
	signature := ed25519.Sign(device.private,
		canonicalRequest(method, request.URL.RequestURI(), device.id, timestamp, body))
	request.Header.Set(headerSignature, base64.RawURLEncoding.EncodeToString(signature))
	request.RequestURI = ""
	return request
}

func (r *testRelay) send(request *http.Request) (*http.Response, []byte) {
	r.t.Helper()
	request.RequestURI = ""
	response, err := r.http.Client().Do(request)
	if err != nil {
		r.t.Fatalf("send request: %v", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		r.t.Fatalf("read response: %v", err)
	}
	return response, data
}

func (r *testRelay) doJSON(device *testDevice, method, target string, payload any) (*http.Response, []byte) {
	r.t.Helper()
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			r.t.Fatal(err)
		}
	}
	// Each request gets its own timestamp: a byte-identical request signed at
	// the same second is a replay, and the relay is right to refuse it.
	r.clock.Advance(time.Second)
	return r.send(r.signed(device, method, target, body, r.clock.Now().Unix()))
}

func (r *testRelay) register(device *testDevice) {
	r.t.Helper()
	response, data := r.doJSON(device, http.MethodPost, "/v1/devices", device.registration())
	if response.StatusCode != http.StatusCreated {
		r.t.Fatalf("register status = %d, body = %s", response.StatusCode, data)
	}
}

func decodeInto[T any](t *testing.T, data []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("decode %T: %v (body %s)", value, err, data)
	}
	return value
}

func expectStatus(t *testing.T, response *http.Response, data []byte, status int) {
	t.Helper()
	if response.StatusCode != status {
		t.Fatalf("status = %d, want %d; body = %s", response.StatusCode, status, data)
	}
}

func expectError(t *testing.T, response *http.Response, data []byte, status int, code string) {
	t.Helper()
	expectStatus(t, response, data, status)
	envelope := decodeInto[errorEnvelope](t, data)
	if envelope.Error.Code != code {
		t.Fatalf("error code = %q, want %q; body = %s", envelope.Error.Code, code, data)
	}
	if envelope.Error.Message == "" {
		t.Fatal("error message is empty")
	}
}

func newMessageID(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func deliverBody(messageID string, ciphertext []byte, ttlSeconds int) deliverRequest {
	return deliverRequest{MessageID: messageID, Ciphertext: ciphertext, TTLSeconds: ttlSeconds}
}

func TestRegisterDeviceIsIdempotentAndUpdatesExchangeKey(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")

	response, data := relay.doJSON(device, http.MethodPost, "/v1/devices", device.registration())
	expectStatus(t, response, data, http.StatusCreated)
	created := decodeInto[registerResponse](t, data)
	if !created.Created || created.DeviceID != device.id {
		t.Fatalf("registration response = %+v", created)
	}

	relay.clock.Advance(time.Second)
	response, data = relay.doJSON(device, http.MethodPost, "/v1/devices", device.registration())
	expectStatus(t, response, data, http.StatusOK)
	if decodeInto[registerResponse](t, data).Created {
		t.Fatal("second registration reported created")
	}

	relay.clock.Advance(time.Second)
	replacement := make([]byte, 32)
	if _, err := rand.Read(replacement); err != nil {
		t.Fatal(err)
	}
	request := device.registration()
	request.ExchangeKey = replacement
	response, data = relay.doJSON(device, http.MethodPost, "/v1/devices", request)
	expectStatus(t, response, data, http.StatusOK)

	stored, err := relay.server.store.device(device.id)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored.ExchangeKey, replacement) {
		t.Fatal("exchange key was not updated")
	}
}

func TestRegistrationRequiresProofOfPossession(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")
	body, err := json.Marshal(device.registration())
	if err != nil {
		t.Fatal(err)
	}

	response, data := relay.send(httptest.NewRequest(http.MethodPost, relay.http.URL+"/v1/devices",
		bytes.NewReader(body)))
	expectError(t, response, data, http.StatusUnauthorized, "unauthorized")

	other := newTestDevice(t, "Other")
	response, data = relay.send(relay.signed(other, http.MethodPost, "/v1/devices", body,
		relay.clock.Now().Unix()))
	expectError(t, response, data, http.StatusUnauthorized, "unauthorized")

	if _, err := relay.server.store.device(device.id); !isNotExist(err) {
		t.Fatalf("unauthenticated registration stored a device: %v", err)
	}
}

func TestRegistrationValidation(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")
	other := newTestDevice(t, "Other")

	cases := []struct {
		name    string
		request registerRequest
	}{
		{
			name: "device id does not match key",
			request: registerRequest{
				DeviceID:    other.id,
				SigningKey:  device.public,
				ExchangeKey: device.exchange,
			},
		},
		{
			name: "signing key wrong size",
			request: registerRequest{
				DeviceID:    device.id,
				SigningKey:  []byte("short"),
				ExchangeKey: device.exchange,
			},
		},
		{
			name: "exchange key wrong size",
			request: registerRequest{
				DeviceID:    device.id,
				SigningKey:  device.public,
				ExchangeKey: []byte("short"),
			},
		},
		{
			name: "name too long",
			request: registerRequest{
				DeviceID:    device.id,
				SigningKey:  device.public,
				ExchangeKey: device.exchange,
				Name:        strings.Repeat("a", 65),
			},
		},
		{
			name: "name contains control character",
			request: registerRequest{
				DeviceID:    device.id,
				SigningKey:  device.public,
				ExchangeKey: device.exchange,
				Name:        "Mac\x00Book",
			},
		},
		{
			name: "malformed device id",
			request: registerRequest{
				DeviceID:    "not-an-id",
				SigningKey:  device.public,
				ExchangeKey: device.exchange,
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			response, data := relay.doJSON(device, http.MethodPost, "/v1/devices", test.request)
			expectError(t, response, data, http.StatusBadRequest, "bad_request")
		})
	}
}

func TestRegistrationRejectsUnknownFieldsAndOversizedBody(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")

	unknown, err := json.Marshal(map[string]any{
		"deviceId":    device.id,
		"signingKey":  device.public,
		"exchangeKey": device.exchange,
		"unexpected":  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	response, data := relay.send(relay.signed(device, http.MethodPost, "/v1/devices", unknown, relay.clock.Now().Unix()))
	expectError(t, response, data, http.StatusBadRequest, "bad_request")

	oversized := append([]byte(`{"junk":"`), bytes.Repeat([]byte("x"), maxRequestBody+1)...)
	oversized = append(oversized, []byte(`"}`)...)
	response, data = relay.send(relay.signed(device, http.MethodPost, "/v1/devices", oversized, relay.clock.Now().Unix()))
	expectError(t, response, data, http.StatusRequestEntityTooLarge, "payload_too_large")
}

func TestAuthenticationFailures(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")
	relay.register(device)
	target := "/v1/mailbox/" + device.id

	t.Run("missing headers", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, relay.http.URL+target, nil)
		response, data := relay.send(request)
		expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
	})

	t.Run("unknown device", func(t *testing.T) {
		unknown := newTestDevice(t, "Ghost")
		response, data := relay.doJSON(unknown, http.MethodGet, target, nil)
		expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
	})

	t.Run("body changed after signing", func(t *testing.T) {
		recipient := newTestDevice(t, "Recipient")
		relay.register(recipient)
		body, _ := json.Marshal(deliverBody(newMessageID(t), []byte("original"), 0))
		request := relay.signed(device, http.MethodPost, "/v1/mailbox/"+recipient.id, body, relay.clock.Now().Unix())
		tampered := []byte(`{"messageId":"` + newMessageID(t) + `","ciphertext":"dGFtcGVyZWQ="}`)
		request.Body = io.NopCloser(bytes.NewReader(tampered))
		request.ContentLength = int64(len(tampered))
		response, data := relay.send(request)
		expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
	})

	t.Run("timestamp older than five minutes", func(t *testing.T) {
		request := relay.signed(device, http.MethodGet, target, nil, relay.clock.Now().Unix())
		relay.clock.Advance(clockSkew + time.Second)
		response, data := relay.send(request)
		expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
		if !strings.Contains(string(data), "timestamp") {
			t.Fatalf("clock skew error is not actionable: %s", data)
		}
	})

	t.Run("timestamp in the future", func(t *testing.T) {
		request := relay.signed(device, http.MethodGet, target, nil, relay.clock.Now().Unix()+int64(clockSkew.Seconds())+1)
		response, data := relay.send(request)
		expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
	})

	t.Run("signature replay", func(t *testing.T) {
		timestamp := relay.clock.Now().Unix()
		first, data := relay.send(relay.signed(device, http.MethodGet, target, nil, timestamp))
		expectStatus(t, first, data, http.StatusOK)

		second, data := relay.send(relay.signed(device, http.MethodGet, target, nil, timestamp))
		expectError(t, second, data, http.StatusUnauthorized, "unauthorized")
		if !strings.Contains(string(data), "already used") {
			t.Fatalf("replay error does not name the cause: %s", data)
		}
	})
}

func TestRoutingTable(t *testing.T) {
	relay := newTestRelay(t)
	device := newTestDevice(t, "MacBook")
	relay.register(device)

	cases := []struct {
		method string
		target string
		status int
		allow  string
	}{
		{http.MethodGet, "/v1/devices", http.StatusMethodNotAllowed, http.MethodPost},
		{http.MethodDelete, "/v1/pairings", http.StatusMethodNotAllowed, http.MethodPost},
		{http.MethodPost, "/v1/pairings/123456", http.StatusMethodNotAllowed, http.MethodGet},
		{http.MethodPut, "/v1/mailbox/" + device.id, http.StatusMethodNotAllowed, "POST, GET"},
		{http.MethodGet, "/v1/mailbox/" + device.id + "/" + newMessageID(t), http.StatusMethodNotAllowed, http.MethodDelete},
		{http.MethodGet, "/v1/nope", http.StatusNotFound, ""},
		{http.MethodGet, "/v1/devices/", http.StatusNotFound, ""},
		{http.MethodGet, "/v1//devices", http.StatusNotFound, ""},
	}
	for _, test := range cases {
		t.Run(test.method+" "+test.target, func(t *testing.T) {
			request := httptest.NewRequest(test.method, relay.http.URL+test.target, nil)
			response, data := relay.send(request)
			expectStatus(t, response, data, test.status)
			if test.allow != "" && response.Header.Get("Allow") != test.allow {
				t.Fatalf("Allow = %q, want %q", response.Header.Get("Allow"), test.allow)
			}
			if !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
				t.Fatalf("Content-Type = %q", response.Header.Get("Content-Type"))
			}
		})
	}

	response, data := relay.doJSON(device, http.MethodPost, "/v1/mailbox/"+device.id, nil)
	expectError(t, response, data, http.StatusBadRequest, "bad_request")

	noAuth := httptest.NewRequest(http.MethodPost, relay.http.URL+"/v1/mailbox/"+device.id,
		strings.NewReader(`{"messageId":"`+newMessageID(t)+`","ciphertext":"eA=="}`))
	response, data = relay.send(noAuth)
	expectError(t, response, data, http.StatusUnauthorized, "unauthorized")
}

func TestPairingLifecycle(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice's MacBook")
	bob := newTestDevice(t, "Bob's Laptop")
	relay.register(alice)
	relay.register(bob)

	response, data := relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	created := decodeInto[pairingResponse](t, data)
	if !pairingCodePattern.MatchString(created.Code) {
		t.Fatalf("pairing code = %q", created.Code)
	}
	wantExpiry := relay.clock.Now().Add(defaultPairingTTL)
	if !created.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("expiresAt = %v, want %v", created.ExpiresAt, wantExpiry)
	}

	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+created.Code, nil)
	expectStatus(t, response, data, http.StatusOK)
	redeemed := decodeInto[redeemResponse](t, data)
	if redeemed.Device.DeviceID != alice.id ||
		!bytes.Equal(redeemed.Device.SigningKey, alice.public) ||
		!bytes.Equal(redeemed.Device.ExchangeKey, alice.exchange) ||
		redeemed.Device.Name != alice.name {
		t.Fatalf("redeemed device = %+v", redeemed.Device)
	}

	relay.clock.Advance(time.Second)
	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+created.Code, nil)
	expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")

	carol := newTestDevice(t, "Carol")
	relay.register(carol)
	response, data = relay.doJSON(carol, http.MethodGet, "/v1/pairings/"+created.Code, nil)
	expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")
}

func TestPairingTTLAndExpiry(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	for _, ttl := range []int{59, 601} {
		response, data := relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{TTLSeconds: ttl})
		expectError(t, response, data, http.StatusBadRequest, "bad_request")
	}

	response, data := relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{TTLSeconds: 60})
	expectStatus(t, response, data, http.StatusCreated)
	code := decodeInto[pairingResponse](t, data).Code
	relay.clock.Advance(61 * time.Second)
	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+code, nil)
	expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")
}

func TestPairingRateLimitPerAddress(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	bob := newTestDevice(t, "Bob")
	relay.register(alice)
	relay.register(bob)

	response, data := relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	validCode := decodeInto[pairingResponse](t, data).Code

	for attempt := 0; attempt < pairingFailureLimit; attempt++ {
		response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/000000", nil)
		expectError(t, response, data, http.StatusNotFound, "pairing_unavailable")
		relay.clock.Advance(time.Second)
	}
	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+validCode, nil)
	expectError(t, response, data, http.StatusTooManyRequests, "rate_limited")

	relay.clock.Advance(pairingFailureWindow + time.Minute)
	response, data = relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	freshCode := decodeInto[pairingResponse](t, data).Code
	response, data = relay.doJSON(bob, http.MethodGet, "/v1/pairings/"+freshCode, nil)
	expectStatus(t, response, data, http.StatusOK)
}

func TestPairingCodeIsNotStoredInPlaintext(t *testing.T) {
	relay := newTestRelay(t)
	alice := newTestDevice(t, "Alice")
	relay.register(alice)

	response, data := relay.doJSON(alice, http.MethodPost, "/v1/pairings", pairingRequest{})
	expectStatus(t, response, data, http.StatusCreated)
	code := decodeInto[pairingResponse](t, data).Code

	entries, err := os.ReadDir(filepath.Join(relay.dir, "pairings"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("pairing files = %d", len(entries))
	}
	if strings.Contains(entries[0].Name(), code) {
		t.Fatal("pairing code appears in the file name")
	}
	contents, err := os.ReadFile(filepath.Join(relay.dir, "pairings", entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte(code)) {
		t.Fatal("pairing code appears in the stored pairing record")
	}
}
