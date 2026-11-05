package ferry

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Wire markers. The relay treats ciphertext as opaque bytes, so one leading
// byte is all the receiver needs to separate data chunks from pairing
// control messages.
const (
	wireChunk   byte = 0x01
	wirePairing byte = 0x02
)

// chunkHeader travels encrypted inside every data message. The receiver can
// only read it after decryption, which is why group identity and the payload
// digest are also bound into the AAD.
type chunkHeader struct {
	Version       int    `json:"v"`
	Kind          string `json:"kind"` // "text" or "rich_text"
	MIME          string `json:"mime"`
	GroupID       string `json:"groupId"`
	Index         int    `json:"index"`
	Total         int    `json:"total"`
	PayloadSHA256 string `json:"payloadSha256"`
	ChunkSHA256   string `json:"chunkSha256"`
	Name          string `json:"name,omitempty"`
}

// sealedChunk is one outbound relay message before it reaches the queue.
type sealedChunk struct {
	GroupID       string
	Index         int
	Total         int
	Kind          string
	MIME          string
	PayloadSHA256 string
	Ciphertext    []byte
}

// chunkAAD binds a message to its sender, recipient and message identity.
// Group, index and total are authenticated by GCM as part of the encrypted
// header; putting them in the AAD would require sending them in the clear.
func chunkAAD(senderID, recipientID, messageID string) []byte {
	return []byte("mypaste-ferry-v1|" + senderID + "|" + recipientID + "|" + messageID)
}

func pairingAAD(senderID, recipientID, messageID string) []byte {
	return []byte("mypaste-ferry-pair-v1|" + senderID + "|" + recipientID + "|" + messageID)
}

// kindForMIME maps the two payload MIME types 0.12.0 transfers.
func kindForMIME(mime string) (string, bool) {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	switch base {
	case "text/plain":
		return "text", true
	case "text/html":
		return "rich_text", true
	}
	return "", false
}

// DirectoryMIME is the MIME type the host reports for a directory entry's
// composite payload stream (D-1032).
const DirectoryMIME = "application/x-mypaste-directory"

// mediaManifest is the first line of a directory payload stream: the
// directory's display name and every file's name, size and digest. The host
// builds it (D-1032); the engine parses it on both sides and the host
// re-validates every name at commit time, so the manifest is a routing
// document, not a trust boundary.
type mediaManifest struct {
	Name  string              `json:"name"`
	Files []mediaManifestFile `json:"files"`
}

type mediaManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// parseMediaManifest reads the manifest that heads a directory payload and
// checks the structural facts the engine depends on: bounded size, a
// non-empty directory name, between one and MaxClipboardFiles files, and
// sizes that exactly cover the bytes after the manifest line. Names are
// validated by the host when the files are offered for landing.
func parseMediaManifest(payload []byte) (mediaManifest, error) {
	var manifest mediaManifest
	newline := bytes.IndexByte(payload, '\n')
	if newline < 0 {
		return manifest, errors.New("目录清单缺少结束行")
	}
	if newline+1 > MaxManifestBytes {
		return manifest, errors.New("目录清单超过大小上限")
	}
	if err := json.Unmarshal(payload[:newline], &manifest); err != nil {
		return manifest, errors.New("目录清单无法读取")
	}
	if strings.TrimSpace(manifest.Name) == "" {
		return manifest, errors.New("目录清单缺少目录名")
	}
	count := len(manifest.Files)
	if count < 1 || count > MaxTransferFiles {
		return manifest, fmt.Errorf("目录清单需要 1–%d 个文件", MaxTransferFiles)
	}
	var total int64
	for _, file := range manifest.Files {
		if file.Size < 0 {
			return manifest, errors.New("目录清单的文件大小无效")
		}
		total += file.Size
	}
	if total != int64(len(payload)-newline-1) {
		return manifest, errors.New("目录清单与文件字节数不一致")
	}
	return manifest, nil
}

// kindForEntry maps the trigger's entry kind plus the payload MIME to the
// wire kind. Text and rich text stay keyed by MIME alone; images and files
// are keyed by the entry kind the trigger carried, because a file entry's
// payload MIME can be anything and a directory is a file entry whose payload
// stream announces itself with DirectoryMIME.
func kindForEntry(triggerKind, mime string) (string, bool) {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	switch triggerKind {
	case "image":
		return "image", true
	case "file":
		if base == DirectoryMIME {
			return "files", true
		}
		return "file", true
	}
	return kindForMIME(mime)
}

// splitPayload cuts one payload into plaintext chunks. Every chunk except the
// last is exactly MaxPlaintextChunk bytes.
func splitPayload(data []byte) [][]byte {
	if len(data) == 0 {
		return [][]byte{data}
	}
	var chunks [][]byte
	for start := 0; start < len(data); start += MaxPlaintextChunk {
		end := start + MaxPlaintextChunk
		if end > len(data) {
			end = len(data)
		}
		chunks = append(chunks, data[start:end])
	}
	return chunks
}

// sealMessage returns nonce||AES-256-GCM ciphertext.
func sealMessage(key, plaintext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("无法创建加密器")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("无法创建加密器")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, errors.New("无法生成随机数")
	}
	out := make([]byte, 0, len(nonce)+len(plaintext)+gcm.Overhead())
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, plaintext, aad), nil
}

func openMessage(key, envelope, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("无法创建解密器")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("无法创建解密器")
	}
	if len(envelope) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("消息长度无效")
	}
	nonce := envelope[:gcm.NonceSize()]
	plaintext, err := gcm.Open(nil, nonce, envelope[gcm.NonceSize():], aad)
	if err != nil {
		return nil, errors.New("消息无法解密或已被篡改")
	}
	return plaintext, nil
}

// sealChunk encrypts one chunk for one peer. The caller supplies the already
// generated message ID so the queue and the wire share one identity.
func (d *device) sealChunk(peer peerRecord, messageID string, group string,
	index, total int, kind, mime, name, payloadDigest string, chunk []byte,
) ([]byte, error) {
	secret, err := sharedSecret(d.ExchangePrivate, peer.ExchangeKey)
	if err != nil {
		return nil, err
	}
	key, err := sessionKey(secret, d.DeviceID, peer.DeviceID)
	if err != nil {
		return nil, err
	}
	chunkDigest := sha256.Sum256(chunk)
	header := chunkHeader{
		Version: ProtocolVersion, Kind: kind, MIME: mime, GroupID: group,
		Index: index, Total: total,
		PayloadSHA256: payloadDigest,
		ChunkSHA256:   hex.EncodeToString(chunkDigest[:]),
		Name:          name,
	}
	encoded, err := json.Marshal(header)
	if err != nil {
		return nil, errors.New("无法编码分块头")
	}
	plaintext := make([]byte, 0, len(encoded)+1+len(chunk))
	plaintext = append(plaintext, encoded...)
	plaintext = append(plaintext, '\n')
	plaintext = append(plaintext, chunk...)
	sealed, err := sealMessage(key, plaintext,
		chunkAAD(d.DeviceID, peer.DeviceID, messageID))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(sealed))
	out = append(out, wireChunk)
	return append(out, sealed...), nil
}

// openChunk decrypts one data message from a trusted peer.
func (d *device) openChunk(peer peerRecord, messageID string, wire []byte,
) (chunkHeader, []byte, error) {
	var header chunkHeader
	if len(wire) < 2 || wire[0] != wireChunk {
		return header, nil, errors.New("消息类型无效")
	}
	secret, err := sharedSecret(d.ExchangePrivate, peer.ExchangeKey)
	if err != nil {
		return header, nil, err
	}
	key, err := sessionKey(secret, peer.DeviceID, d.DeviceID)
	if err != nil {
		return header, nil, err
	}
	// The header (group, index, total, digests) is inside the ciphertext, so
	// GCM authenticates it; the AAD binds only the identities and message ID.
	plaintext, err := openMessage(key, wire[1:],
		chunkAAD(peer.DeviceID, d.DeviceID, messageID))
	if err != nil {
		return header, nil, err
	}
	newline := bytes.IndexByte(plaintext, '\n')
	if newline < 0 {
		return header, nil, errors.New("消息格式无效")
	}
	if err := json.Unmarshal(plaintext[:newline], &header); err != nil {
		return header, nil, errors.New("消息头无法读取")
	}
	if header.Version != ProtocolVersion || header.Index < 0 || header.Total < 1 ||
		header.Index >= header.Total || header.Total > 4096 {
		return header, nil, errors.New("消息头字段无效")
	}
	data := plaintext[newline+1:]
	digest := sha256.Sum256(data)
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(digest[:])), []byte(header.ChunkSHA256)) != 1 {
		return header, nil, errors.New("分块校验失败")
	}
	return header, data, nil
}

// sealPairingMessage builds the one control message a joining device sends to
// the device whose code it redeemed. The sender's public keys travel in the
// clear so the inviter can derive the same key; the pairing code and the name
// stay encrypted.
func (d *device) sealPairingMessage(recipientID string, recipientExchange []byte,
	messageID, code, name string,
) ([]byte, error) {
	secret, err := sharedSecret(d.ExchangePrivate, recipientExchange)
	if err != nil {
		return nil, err
	}
	key, err := sessionKey(secret, d.DeviceID, recipientID)
	if err != nil {
		return nil, err
	}
	payload := struct {
		Version  int    `json:"v"`
		Code     string `json:"code"`
		Name     string `json:"name"`
		DeviceID string `json:"deviceId"`
	}{Version: ProtocolVersion, Code: code, Name: name, DeviceID: d.DeviceID}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, errors.New("无法编码配对消息")
	}
	sealed, err := sealMessage(key, encoded, pairingAAD(d.DeviceID, recipientID, messageID))
	if err != nil {
		return nil, err
	}
	envelope := struct {
		SenderID    string `json:"senderId"`
		SigningKey  []byte `json:"signingKey"`
		ExchangeKey []byte `json:"exchangeKey"`
		Ciphertext  []byte `json:"ciphertext"`
	}{
		SenderID:    d.DeviceID,
		SigningKey:  d.SigningPublic,
		ExchangeKey: d.ExchangePublic,
		Ciphertext:  sealed,
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return nil, errors.New("无法编码配对信封")
	}
	out := make([]byte, 0, 1+len(body))
	out = append(out, wirePairing)
	return append(out, body...), nil
}

// pairingMessage is one decrypted pairing control message.
type pairingMessage struct {
	SenderID    string
	SigningKey  []byte
	ExchangeKey []byte
	Code        string
	Name        string
}

// openPairingMessage decrypts a pairing control message from any sender. The
// envelope is self-describing because the inviter does not know the joiner's
// keys yet; the user's fingerprint comparison is what authenticates them.
func (d *device) openPairingMessage(messageID string, wire []byte) (pairingMessage, error) {
	var message pairingMessage
	if len(wire) < 2 || wire[0] != wirePairing {
		return message, errors.New("消息类型无效")
	}
	var envelope struct {
		SenderID    string `json:"senderId"`
		SigningKey  []byte `json:"signingKey"`
		ExchangeKey []byte `json:"exchangeKey"`
		Ciphertext  []byte `json:"ciphertext"`
	}
	if err := json.Unmarshal(wire[1:], &envelope); err != nil {
		return message, errors.New("配对信封无法读取")
	}
	if len(envelope.SigningKey) != 32 || len(envelope.ExchangeKey) != 32 ||
		deviceIDFor(envelope.SigningKey) != envelope.SenderID {
		return message, errors.New("配对信封的设备身份无效")
	}
	secret, err := sharedSecret(d.ExchangePrivate, envelope.ExchangeKey)
	if err != nil {
		return message, err
	}
	key, err := sessionKey(secret, envelope.SenderID, d.DeviceID)
	if err != nil {
		return message, err
	}
	plaintext, err := openMessage(key, envelope.Ciphertext,
		pairingAAD(envelope.SenderID, d.DeviceID, messageID))
	if err != nil {
		return message, err
	}
	var payload struct {
		Version  int    `json:"v"`
		Code     string `json:"code"`
		Name     string `json:"name"`
		DeviceID string `json:"deviceId"`
	}
	if err := json.Unmarshal(plaintext, &payload); err != nil || payload.Version != ProtocolVersion {
		return message, errors.New("配对消息内容无效")
	}
	if payload.DeviceID != envelope.SenderID {
		return message, errors.New("配对消息的设备标识不一致")
	}
	message.SenderID = envelope.SenderID
	message.SigningKey = envelope.SigningKey
	message.ExchangeKey = envelope.ExchangeKey
	message.Code = payload.Code
	message.Name = payload.Name
	return message, nil
}

// assembledGroup is one complete group: the concatenated payload bytes with
// the identity every chunk's header agreed on. Name is the sender's display
// name for file and directory groups, empty for text and images.
type assembledGroup struct {
	GroupID string
	Kind    string
	MIME    string
	Name    string
	Data    []byte
}

// assembleChunks concatenates one complete group and verifies the payload
// digest. The data chunks are the exact payload bytes, so the payload is
// simply the concatenation; what it means is decided by the kind.
func assembleChunks(chunks []inboundChunk) (assembledGroup, error) {
	var group assembledGroup
	if len(chunks) == 0 {
		return group, errors.New("分组为空")
	}
	total := chunks[0].Header.Total
	if total != len(chunks) {
		return group, fmt.Errorf("分组缺少分块（%d/%d）", len(chunks), total)
	}
	seen := make(map[int]bool, total)
	ordered := make([][]byte, total)
	for _, chunk := range chunks {
		index := chunk.Header.Index
		if index < 0 || index >= total || seen[index] {
			return group, errors.New("分块索引重复或越界")
		}
		seen[index] = true
		if chunk.Header.GroupID != chunks[0].Header.GroupID {
			return group, errors.New("分块来自不同分组")
		}
		if group.Kind == "" {
			group.GroupID = chunk.Header.GroupID
			group.Kind, group.MIME, group.Name =
				chunk.Header.Kind, chunk.Header.MIME, chunk.Header.Name
		} else if chunk.Header.Kind != group.Kind || chunk.Header.MIME != group.MIME {
			return group, errors.New("分块类型不一致")
		}
		ordered[index] = chunk.Data
	}
	var data []byte
	for _, part := range ordered {
		data = append(data, part...)
	}
	digest := sha256.Sum256(data)
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(digest[:])), []byte(chunks[0].Header.PayloadSHA256)) != 1 {
		return group, errors.New("载荷校验失败")
	}
	group.Data = data
	switch group.Kind {
	case "text", "rich_text", "image", "file", "files":
		return group, nil
	}
	return group, errors.New("不支持的载荷类型")
}

// inboundChunk is one decrypted chunk waiting in the state object. SeenAt is
// when the first chunk of its group arrived; a group that stays incomplete
// past InboundGroupTTL is voided whole.
type inboundChunk struct {
	Header    chunkHeader `json:"header"`
	Data      []byte      `json:"data"`
	MessageID string      `json:"messageId"`
	SenderID  string      `json:"senderId"`
	SeenAt    int64       `json:"seenAt,omitempty"`
}
