package main

import (
	"strings"
	"testing"
)

func TestLoopbackListen(t *testing.T) {
	cases := []struct {
		address string
		want    bool
	}{
		{"127.0.0.1:8080", true},
		{"localhost:8080", true},
		{"[::1]:8080", true},
		{":8080", false},
		{"0.0.0.0:8080", false},
		{"192.168.1.10:8080", false},
		{"not-an-address", false},
	}
	for _, test := range cases {
		if got := loopbackListen(test.address); got != test.want {
			t.Errorf("loopbackListen(%q) = %v, want %v", test.address, got, test.want)
		}
	}
}

func TestRunRefusesUnsafeTransportCombinations(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "TLS without certificate",
			args: []string{},
			want: "TLS is required",
		},
		{
			name: "plaintext on a public address",
			args: []string{"-allow-plaintext", "-listen", "0.0.0.0:8080"},
			want: "loopback",
		},
		{
			name: "plaintext together with TLS files",
			args: []string{"-allow-plaintext", "-listen", "127.0.0.1:8080", "-tls-cert", "cert.pem", "-tls-key", "key.pem"},
			want: "either TLS",
		},
		{
			name: "non-positive cleanup interval",
			args: []string{"-allow-plaintext", "-listen", "127.0.0.1:8080", "-cleanup-interval", "0s"},
			want: "cleanup-interval",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := run(test.args)
			if err == nil {
				t.Fatal("run succeeded")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestDefaultDataDir(t *testing.T) {
	if defaultDataDir() == "" {
		t.Fatal("default data directory is empty")
	}
}
