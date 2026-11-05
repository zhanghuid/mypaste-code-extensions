package ferry

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.ferry/src/internal/relayproto"
)

// relayClient speaks relay protocol v1 through the host's network service.
// It signs every request with the device key; the relay verifies the same
// canonical bytes (internal/relay owns that string, so client and server
// cannot drift).
type relayClient struct {
	origin  string // https://host, no trailing slash
	device  *device
	network Network
	now     func() time.Time
}

func newRelayClient(origin string, device *device, network Network, now func() time.Time) *relayClient {
	return &relayClient{
		origin: strings.TrimSuffix(origin, "/"), device: device, network: network, now: now,
	}
}

// relayError is a relay refusal with its machine-readable code. The message is
// the relay's one actionable sentence and never contains a body, key or path.
type relayError struct {
	Status  int
	Code    string
	Message string
}

func (e *relayError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return e.Code + "：" + e.Message
}

type relayMessage struct {
	MessageID  string `json:"messageId"`
	SenderID   string `json:"senderId"`
	Ciphertext []byte `json:"ciphertext"`
}

// do signs and sends one request and returns its body and status.
func (c *relayClient) do(ctx context.Context, method, target string, body []byte) ([]byte, int, error) {
	timestamp := c.now().Unix()
	signature := c.device.sign(relayproto.CanonicalRequest(method, target, c.device.DeviceID, timestamp, body))
	headers := map[string]string{
		"accept":                   "application/json",
		relayproto.HeaderDevice:    c.device.DeviceID,
		relayproto.HeaderTimestamp: strconv.FormatInt(timestamp, 10),
		relayproto.HeaderSignature: base64.RawURLEncoding.EncodeToString(signature),
	}
	if len(body) > 0 {
		headers["content-type"] = "application/json"
	}
	response, err := c.network.Do(ctx, Request{
		Method: method, URL: c.origin + target, Headers: headers, Body: body,
	})
	if err != nil {
		return nil, 0, errors.New("网络请求失败")
	}
	if response.Status >= 200 && response.Status < 300 {
		return response.Body, response.Status, nil
	}
	return nil, response.Status, parseRelayError(response.Status, response.Body)
}

func parseRelayError(status int, body []byte) error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Code != "" {
		return &relayError{Status: status, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	return &relayError{Status: status, Code: "http_" + strconv.Itoa(status), Message: "中继拒绝了这次请求"}
}

func (c *relayClient) register(ctx context.Context, name string) error {
	payload, err := json.Marshal(struct {
		DeviceID    string `json:"deviceId"`
		SigningKey  []byte `json:"signingKey"`
		ExchangeKey []byte `json:"exchangeKey"`
		Name        string `json:"name"`
	}{c.device.DeviceID, c.device.SigningPublic, c.device.ExchangePublic, name})
	if err != nil {
		return errors.New("无法编码注册请求")
	}
	_, _, err = c.do(ctx, http.MethodPost, "/v1/devices", payload)
	return err
}

func (c *relayClient) createPairing(ctx context.Context) (string, time.Time, error) {
	body, _, err := c.do(ctx, http.MethodPost, "/v1/pairings",
		[]byte(`{"ttlSeconds":600}`))
	if err != nil {
		return "", time.Time{}, err
	}
	var response struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(body, &response); err != nil || response.Code == "" {
		return "", time.Time{}, errors.New("中继返回的配对邀请无法读取")
	}
	return response.Code, response.ExpiresAt, nil
}

func (c *relayClient) redeemPairing(ctx context.Context, code string) (peerRecord, error) {
	body, _, err := c.do(ctx, http.MethodGet, "/v1/pairings/"+url.PathEscape(code), nil)
	if err != nil {
		return peerRecord{}, err
	}
	var response struct {
		Device struct {
			DeviceID    string `json:"deviceId"`
			SigningKey  []byte `json:"signingKey"`
			ExchangeKey []byte `json:"exchangeKey"`
			Name        string `json:"name"`
		} `json:"device"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return peerRecord{}, errors.New("中继返回的设备记录无法读取")
	}
	peer := peerRecord{
		DeviceID:    response.Device.DeviceID,
		Name:        response.Device.Name,
		SigningKey:  response.Device.SigningKey,
		ExchangeKey: response.Device.ExchangeKey,
	}
	if !peer.valid() {
		return peerRecord{}, errors.New("中继返回的设备记录无效")
	}
	peer.Fingerprint = Fingerprint(c.device.DeviceID, c.device.ExchangePublic,
		peer.DeviceID, peer.ExchangeKey)
	return peer, nil
}

func (c *relayClient) deliver(ctx context.Context, recipientID, messageID string, ciphertext []byte) error {
	payload, err := json.Marshal(struct {
		MessageID  string `json:"messageId"`
		Ciphertext []byte `json:"ciphertext"`
	}{messageID, ciphertext})
	if err != nil {
		return errors.New("无法编码投递请求")
	}
	if len(payload) > 256<<10 {
		return errors.New("消息超过单次请求上限")
	}
	_, _, err = c.do(ctx, http.MethodPost,
		"/v1/mailbox/"+url.PathEscape(recipientID), payload)
	return err
}

func (c *relayClient) list(ctx context.Context, limit int) ([]relayMessage, bool, error) {
	target := fmt.Sprintf("/v1/mailbox/%s?limit=%d", url.PathEscape(c.device.DeviceID), limit)
	body, _, err := c.do(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, false, err
	}
	var response struct {
		Messages []relayMessage `json:"messages"`
		More     bool           `json:"more"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&response); err != nil {
		return nil, false, errors.New("中继返回的信箱内容无法读取")
	}
	return response.Messages, response.More, nil
}

func (c *relayClient) delete(ctx context.Context, messageID string) error {
	_, status, err := c.do(ctx, http.MethodDelete,
		"/v1/mailbox/"+url.PathEscape(c.device.DeviceID)+"/"+url.PathEscape(messageID), nil)
	if err != nil {
		var refused *relayError
		if errors.As(err, &refused) && refused.Status == http.StatusNotFound {
			// Already gone (a retry after a lost response): that is success.
			return nil
		}
		return err
	}
	_ = status
	return nil
}
