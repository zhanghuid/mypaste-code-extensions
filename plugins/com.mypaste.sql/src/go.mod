module github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sql/src

go 1.27.1

require github.com/zhanghuid/mypaste-code-extensions/shared/sqlkit v0.0.0

require (
	github.com/alecthomas/chroma/v2 v2.27.0 // indirect
	github.com/dlclark/regexp2/v2 v2.2.1 // indirect
)

// All SQL work — analysis, formatting and compression — lives in the shared
// sqlkit module, which com.mypaste.code-edit's runtime imports too. The local
// replace keeps one owner without publishing a module.
replace github.com/zhanghuid/mypaste-code-extensions/shared/sqlkit => ../../../shared/sqlkit
