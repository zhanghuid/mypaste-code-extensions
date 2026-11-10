package crypt

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

const fixturePassphrase = "legacy-fixture-passphrase"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	plain := []byte("archive bytes: 0.30.0")
	sealed, err := EncryptArchive(plain, "a passphrase of length")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(sealed, []byte("MYPaste-Sync/1\n")) {
		t.Fatalf("missing format magic: %q", sealed[:16])
	}
	if len(sealed) != len(magic)+SaltBytes+NonceBytes+len(plain)+16 {
		t.Fatalf("unexpected sealed length %d", len(sealed))
	}
	opened, err := DecryptArchive(sealed, "a passphrase of length")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, plain) {
		t.Fatalf("round trip changed bytes: %q", opened)
	}
}

// TestDecryptLegacyObject proves rollback compatibility: the fixture was
// written by the host's pre-0.30.0 EncryptArchive.
func TestDecryptLegacyObject(t *testing.T) {
	sealed, err := os.ReadFile(filepath.Join("testdata", "legacy-mypaste-sync1.bin"))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := DecryptArchive(sealed, fixturePassphrase)
	if err != nil {
		t.Fatal(err)
	}
	want := "MyPaste 0.29.0 legacy sync fixture\n"
	if string(opened) != want {
		t.Fatalf("legacy fixture opened as %q", opened)
	}
}

func TestDecryptRejects(t *testing.T) {
	sealed, err := EncryptArchive([]byte("payload"), "a passphrase of length")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name       string
		payload    []byte
		passphrase string
	}{
		{"wrong passphrase", sealed, "another passphrase"},
		{"empty passphrase", sealed, ""},
		{"truncated", sealed[:len(sealed)-1], "a passphrase of length"},
		{"foreign magic", append([]byte("MYPaste-Sync/2\n"), sealed[len(magic):]...), "a passphrase of length"},
		{"edited header", flipByte(sealed, len(magic)), "a passphrase of length"},
		{"edited ciphertext", flipByte(sealed, len(sealed)-1), "a passphrase of length"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			opened, err := DecryptArchive(testCase.payload, testCase.passphrase)
			if err == nil {
				t.Fatalf("decrypted %q", opened)
			}
			if len(opened) != 0 {
				t.Fatalf("failure leaked %d plaintext bytes", len(opened))
			}
		})
	}
}

func TestEncryptRejectsEmptyPassphrase(t *testing.T) {
	if _, err := EncryptArchive([]byte("x"), ""); err == nil {
		t.Fatal("empty passphrase was accepted")
	}
}

func flipByte(payload []byte, index int) []byte {
	out := append([]byte(nil), payload...)
	out[index] ^= 0x01
	return out
}
