// Package crypt owns the MYPaste-Sync/1 object format.
//
// The format is the host's existing one and must stay byte-compatible: an
// object written by the host before 0.30.0 must decrypt here, and an object
// written here must decrypt with the host's old reader if the user rolls
// back. The header is authenticated as additional data, so a wrong passphrase
// and a truncated or edited object both fail closed.
package crypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// FormatVersion is the MYPaste-Sync format generation. It is part of the
	// magic prefix, never a separate field.
	FormatVersion = 1
	// Iterations is the PBKDF2-HMAC-SHA256 work factor the host has always
	// used. Changing it would make old objects undecryptable.
	Iterations = 210_000
	// SaltBytes and NonceBytes are fixed by the format.
	SaltBytes  = 16
	NonceBytes = 12
	// MinPassphraseRunes is the host's minimum for a new passphrase.
	MinPassphraseRunes = 12
)

var magic = []byte(fmt.Sprintf("MYPaste-Sync/%d\n", FormatVersion))

// EncryptArchive seals one plaintext archive. The returned bytes start with
// the magic, the salt and the nonce, followed by the GCM ciphertext and tag.
func EncryptArchive(plain []byte, passphrase string) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("加密口令不能为空")
	}
	salt := make([]byte, SaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, errors.New("无法生成加密盐")
	}
	key := pbkdf2SHA256([]byte(passphrase), salt, Iterations, 32)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("无法初始化加密算法")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("无法初始化加密算法")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, errors.New("无法生成加密随机数")
	}
	header := make([]byte, 0, len(magic)+SaltBytes+NonceBytes)
	header = append(header, magic...)
	header = append(header, salt...)
	header = append(header, nonce...)
	return gcm.Seal(header, nonce, plain, header), nil
}

// DecryptArchive opens one sealed object. It never returns plaintext for a
// wrong passphrase, a truncated object or one whose header was changed.
func DecryptArchive(sealed []byte, passphrase string) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("加密口令不能为空")
	}
	headerLen := len(magic) + SaltBytes + NonceBytes
	if len(sealed) < headerLen+16 {
		return nil, errors.New("远端备份不是有效的加密归档")
	}
	if !hmac.Equal(sealed[:len(magic)], magic) {
		return nil, errors.New("远端备份不是有效的加密归档")
	}
	salt := sealed[len(magic) : len(magic)+SaltBytes]
	nonce := sealed[len(magic)+SaltBytes : headerLen]
	ciphertext := sealed[headerLen:]
	key := pbkdf2SHA256([]byte(passphrase), salt, Iterations, 32)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("无法初始化解密算法")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("无法初始化解密算法")
	}
	header := sealed[:headerLen]
	plain, err := gcm.Open(nil, nonce, ciphertext, header)
	if err != nil {
		return nil, errors.New("解密失败：口令不正确或归档已损坏")
	}
	return plain, nil
}

// pbkdf2SHA256 is PBKDF2-HMAC-SHA256 with a single block, which is enough for
// a 32-byte key. It mirrors the host's implementation so both sides derive
// exactly the same bytes without an extra dependency.
func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	hashLen := sha256.Size
	blocks := (keyLen + hashLen - 1) / hashLen
	derived := make([]byte, 0, blocks*hashLen)
	var counter [4]byte
	for block := 1; block <= blocks; block++ {
		binary.BigEndian.PutUint32(counter[:], uint32(block))
		mac := hmac.New(sha256.New, password)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(counter[:])
		sum := mac.Sum(nil)
		accumulator := append([]byte(nil), sum...)
		for index := 1; index < iterations; index++ {
			mac = hmac.New(sha256.New, password)
			_, _ = mac.Write(sum)
			sum = mac.Sum(nil)
			for offset := range accumulator {
				accumulator[offset] ^= sum[offset]
			}
		}
		derived = append(derived, accumulator...)
	}
	return derived[:keyLen]
}
