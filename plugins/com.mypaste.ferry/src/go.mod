module github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.ferry/src

go 1.27.1

// The engine's integration tests drive the real relay server over httptest.
// This is test-only: the shipped binary depends on nothing outside the
// standard library, and the wire protocol it speaks is relayproto above.
require github.com/zhanghuid/mypaste-code-extensions/servers/mypaste-relay v0.0.0

replace github.com/zhanghuid/mypaste-code-extensions/servers/mypaste-relay => ../../../servers/mypaste-relay
