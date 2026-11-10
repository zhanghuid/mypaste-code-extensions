#!/bin/sh
# Bridges one saved-search control command to the host. The plugin chooses an
# action word and forwards the page's bounded arguments unchanged; the host
# owns the queries, the board scope and every write (D-1009).
set -eu

request=$(head -n 1)
request_id=$(printf '%s' "$request" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
action_arguments=$(printf '%s' "$request" | sed -n 's/.*"actionArguments":"\([^"]*\)".*/\1/p')

case "$request" in
  *'"commandId":"saved-searches.create"'*) action=create ;;
  *'"commandId":"saved-searches.update"'*) action=update ;;
  *'"commandId":"saved-searches.delete"'*) action=delete ;;
  *)
    printf '{"id":"%s","ok":false,"error":"未知的保存搜索命令"}\n' "$request_id"
    exit 0
    ;;
esac

printf '{"type":"hostCall","id":"control","service":"saved-searches.control","method":"run","params":{"action":"%s","arguments":"%s"}}\n' "$action" "$action_arguments"
head -n 1 >/dev/null
printf '{"id":"%s","ok":true,"result":{"output":""}}\n' "$request_id"
