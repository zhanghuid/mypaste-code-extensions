package ferry

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// device is this installation's private identity. It is stored only inside
// storage.plugin; no host service ever sees the private halves.
type device struct {
	DeviceID        string `json:"deviceId"`
	Name            string `json:"name"`
	SigningPublic   []byte `json:"signingPublic"`
	SigningPrivate  []byte `json:"signingPrivate"`
	ExchangePublic  []byte `json:"exchangePublic"`
	ExchangePrivate []byte `json:"exchangePrivate"`
	CreatedAt       int64  `json:"createdAt"`
}

// newDevice creates one Ed25519 signing key (relay authentication) and one
// X25519 exchange key (end-to-end encryption).
func newDevice(name string, now time.Time) (*device, error) {
	signingPublic, signingPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("无法生成签名密钥")
	}
	exchangePrivate, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("无法生成交换密钥")
	}
	return &device{
		DeviceID:        deviceIDFor(signingPublic),
		Name:            name,
		SigningPublic:   append([]byte(nil), signingPublic...),
		SigningPrivate:  append([]byte(nil), signingPrivate...),
		ExchangePublic:  append([]byte(nil), exchangePrivate.PublicKey().Bytes()...),
		ExchangePrivate: append([]byte(nil), exchangePrivate.Bytes()...),
		CreatedAt:       now.Unix(),
	}, nil
}

// valid reports whether every key has the one length the protocol allows.
func (d *device) valid() bool {
	if d == nil {
		return false
	}
	return len(d.SigningPublic) == ed25519.PublicKeySize &&
		len(d.SigningPrivate) == ed25519.PrivateKeySize &&
		len(d.ExchangePublic) == 32 &&
		len(d.ExchangePrivate) == 32 &&
		deviceIDFor(d.SigningPublic) == d.DeviceID
}

// sign produces the relay request signature.
func (d *device) sign(message []byte) []byte {
	return ed25519.Sign(ed25519.PrivateKey(d.SigningPrivate), message)
}

// deviceIDFor is base64url(SHA-256(signingKey)) without padding, exactly as
// the relay computes it (SYNC.md 3.4.1).
func deviceIDFor(signingPublic []byte) string {
	sum := sha256.Sum256(signingPublic)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// messageID generates one 32-byte identifier in the relay's 43-character form.
func messageID() (string, error) {
	return randomID()
}

func randomID() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", errors.New("无法生成随机标识")
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// groupID identifies one payload split across chunks.
func groupID() (string, error) { return randomID() }

// fingerprint alphabet is Crockford base32: no I, L, O or U, so the eight
// groups the user compares cannot be confused with letters.
var fingerprintEncoding = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").
	WithPadding(base32.NoPadding)

// Fingerprint derives the short fingerprint both devices show after pairing.
// Ordering by device ID makes the two sides compute the same value without a
// round trip.
func Fingerprint(idA string, exchangeA []byte, idB string, exchangeB []byte) string {
	// Ordering by device ID makes both sides hash the same pair without a
	// round trip.
	if idB < idA {
		exchangeA, exchangeB = exchangeB, exchangeA
	}
	sum := sha256.New()
	sum.Write([]byte("mypaste-ferry-fingerprint-v1\n"))
	sum.Write(exchangeA)
	sum.Write(exchangeB)
	digest := sum.Sum(nil)[:20]
	encoded := fingerprintEncoding.EncodeToString(digest)
	var groups []string
	for start := 0; start+4 <= len(encoded); start += 4 {
		groups = append(groups, encoded[start:start+4])
	}
	return joinGroups(groups)
}

func joinGroups(groups []string) string {
	out := ""
	for index, group := range groups {
		if index > 0 {
			out += "-"
		}
		out += group
	}
	return out
}

// sharedSecret is X25519 this-device-private × peer-public. crypto/ecdh
// rejects low-order points, so an all-zero shared secret never becomes a key.
func sharedSecret(private, public []byte) ([]byte, error) {
	curve := ecdh.X25519()
	priv, err := curve.NewPrivateKey(private)
	if err != nil {
		return nil, errors.New("本机交换密钥无效")
	}
	pub, err := curve.NewPublicKey(public)
	if err != nil {
		return nil, errors.New("对端交换密钥无效")
	}
	secret, err := priv.ECDH(pub)
	if err != nil {
		return nil, errors.New("无法建立会话密钥")
	}
	return secret, nil
}

// sessionKey is HKDF-SHA256 over the X25519 secret. The salt binds the two
// device IDs in sorted order; the info string binds the direction, so each
// direction has its own key. The derivation is part of the wire contract.
func sessionKey(secret []byte, senderID, recipientID string) ([]byte, error) {
	first, second := senderID, recipientID
	if second < first {
		first, second = second, first
	}
	saltInput := fmt.Sprintf("mypaste-ferry-v1 salt\n%s\n%s", first, second)
	salt := sha256.Sum256([]byte(saltInput))
	info := fmt.Sprintf("mypaste-ferry-v1 %s %s", senderID, recipientID)
	key, err := hkdf.Key(sha256.New, secret, salt[:], info, 32)
	if err != nil {
		return nil, errors.New("无法派生会话密钥")
	}
	return key, nil
}
