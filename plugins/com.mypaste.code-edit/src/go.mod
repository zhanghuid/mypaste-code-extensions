module github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.code-edit/src

go 1.27.1

require github.com/alecthomas/chroma/v2 v2.27.0

require github.com/dlclark/regexp2/v2 v2.2.1 // indirect

// This package owns every engine it ships: internal/sqlkit is its SQL
// scanner and formatter, and nothing here is imported from another extension.
