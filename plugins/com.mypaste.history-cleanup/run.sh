#!/bin/sh
# Bridges one history-cleanup command to the host. The plugin only chooses a
# closed scope; the native confirmation, the single transaction, pinned
# protection, asset cleanup and the operation log all stay in the host, which
# answers with its own result or error.
set -eu

request=$(head -n 1)
request_id=$(printf '%s' "$request" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

case "$request" in
  *'"commandId":"history.clear.pinned"'*)
    scope=pinned
    ;;
  *'"commandId":"history.clear"'*)
    scope=normal
    ;;
  *)
    printf '{"id":"%s","ok":false,"error":{"message":"未知的清空历史命令"}}\n' \
      "$request_id"
    exit 1
    ;;
esac

printf '{"type":"hostCall","id":"cleanup","service":"history.cleanup","method":"run","params":{"scope":"%s"}}\n' \
  "$scope"
reply=$(head -n 1)

case "$reply" in
  *'"ok":true'*)
    printf '{"id":"%s","ok":true,"result":{"output":""}}\n' "$request_id"
    ;;
  *)
    printf '{"id":"%s","ok":false,"error":{"message":"宿主未能完成清空历史"}}\n' \
      "$request_id"
    ;;
esac
