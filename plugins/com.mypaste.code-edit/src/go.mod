module github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.code-edit/src

go 1.27.1

require github.com/zhanghuid/mypaste-code-extensions/shared/sqlkit v0.0.0

require (
	github.com/alecthomas/chroma/v2 v2.27.0 // indirect
	github.com/dlclark/regexp2/v2 v2.2.1 // indirect
)

// The SQL engine is the shared sqlkit module, the same one com.mypaste.sql
// compiles, so the editor and the SQL package cannot drift apart.
replace github.com/zhanghuid/mypaste-code-extensions/shared/sqlkit => ../../../shared/sqlkit
