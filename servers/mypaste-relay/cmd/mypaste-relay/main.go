// Command mypaste-relay runs the storage-forwarding relay for MyPaste's
// cross-device sync (D-1028). It is an independent service the user runs on a
// LAN host, NAS, or public server; the desktop host never starts it.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/servers/mypaste-relay/relay"
)

const relayVersion = "0.11.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "mypaste-relay:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("mypaste-relay", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	listen := flags.String("listen", ":443", "listen address (for example :443 or 127.0.0.1:8443)")
	certFile := flags.String("tls-cert", "", "TLS certificate chain in PEM form")
	keyFile := flags.String("tls-key", "", "TLS private key in PEM form")
	dataDir := flags.String("data", defaultDataDir(), "data directory; created with mode 0700")
	allowPlaintext := flags.Bool("allow-plaintext", false,
		"serve plain HTTP on a loopback address for local testing only; never expose this")
	cleanupInterval := flags.Duration("cleanup-interval", 10*time.Minute, "expired message cleanup interval")
	showVersion := flags.Bool("version", false, "print the relay version and exit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if *showVersion {
		fmt.Println("mypaste-relay", relayVersion)
		return nil
	}
	if *cleanupInterval <= 0 {
		return errors.New("-cleanup-interval must be positive")
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	useTLS := !*allowPlaintext
	switch {
	case *allowPlaintext && (*certFile != "" || *keyFile != ""):
		return errors.New("choose either TLS (-tls-cert and -tls-key) or -allow-plaintext, not both")
	case *allowPlaintext && !loopbackListen(*listen):
		return errors.New("-allow-plaintext requires a loopback listen address such as 127.0.0.1:8080")
	case useTLS && (*certFile == "" || *keyFile == ""):
		return errors.New("TLS is required: pass -tls-cert and -tls-key, or -allow-plaintext for loopback testing")
	}

	directory := filepath.Clean(*dataDir)
	if info, err := os.Stat(directory); err == nil && info.Mode().Perm()&0o077 != 0 {
		logger.Warn("data directory is accessible by other users; restrict it with chmod 700",
			"path", directory, "mode", fmt.Sprintf("%04o", info.Mode().Perm()))
	}
	server, err := relay.Open(relay.Config{DataDir: directory, Logger: logger})
	if err != nil {
		return err
	}
	defer server.Close()

	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		ticker := time.NewTicker(*cleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := server.Cleanup(time.Now()); err != nil {
					logger.Error("relay cleanup failed", "error", err)
				}
			}
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()

	logger.Info("relay listening",
		"address", listener.Addr().String(),
		"tls", useTLS,
		"data", directory,
		"version", relayVersion,
	)
	if *allowPlaintext {
		logger.Warn("plaintext HTTP is enabled for local testing; never expose it to a network")
	}

	if useTLS {
		certificate, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		if err != nil {
			_ = listener.Close()
			return fmt.Errorf("load TLS certificate: %w", err)
		}
		httpServer.TLSConfig = &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{certificate},
		}
		err = httpServer.ServeTLS(listener, "", "")
	} else {
		err = httpServer.Serve(listener)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func loopbackListen(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil || host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func defaultDataDir() string {
	if directory, err := os.UserConfigDir(); err == nil {
		return filepath.Join(directory, "MyPaste-Relay")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".mypaste-relay")
	}
	return "mypaste-relay-data"
}
