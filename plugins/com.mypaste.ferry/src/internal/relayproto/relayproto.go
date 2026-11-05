// Package relayproto is the sync extension's private copy of the relay wire
// protocol v1: the three authentication header names and the canonical
// request string a client signs. The protocol's owner is the relay server in
// servers/mypaste-relay; this copy exists because the extension ships as an
// independent module and the two repositories deliberately share no code.
//
// Protocol v1 is frozen: its shape is part of the protocol name
// ("mypaste-relay-v1"), so any change is a new protocol with a new name, not
// an edit here. If the relay ever ships v2, this package gains a v2 sibling
// rather than drifting.
package relayproto

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// ProtocolName is the v1 canonical-request domain separator.
const ProtocolName = "mypaste-relay-v1"

// The three authentication headers. The host forwards exactly these names
// from a trusted extension session; no other header is exempt from its
// per-host allowlist.
const (
	HeaderDevice    = "X-MyPaste-Device"
	HeaderTimestamp = "X-MyPaste-Timestamp"
	HeaderSignature = "X-MyPaste-Signature"
)

// CanonicalRequest is the exact byte string a client signs and the relay
// verifies. The body digest is lowercase hex SHA-256; the target is path plus
// "?" plus raw query, as sent on the request line.
func CanonicalRequest(method, target, deviceID string, timestamp int64, body []byte) []byte {
	digest := sha256.Sum256(body)
	var builder []byte
	builder = append(builder, ProtocolName...)
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
