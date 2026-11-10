#!/bin/sh
# Bridges one backup-scheduler command to the host. The plugin only chooses
# between a run and a status read; the host owns the schedule loop, rotation
# and every archive write, and answers with its own result or error.
set -eu

request=$(head -n 1)
request_id=$(printf '%s' "$request" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

case "$request" in
  *'"commandId":"backup.trigger"'*)
    service=backup.schedule
    params='{"trigger":"now"}'
    ;;
  *'"commandId":"backup.status"'*)
    service=backup.schedule
    params='{"status":true}'
    ;;
  *)
    printf '{"id":"%s","ok":false,"error":{"message":"未知的备份排程命令"}}\n' \
      "$request_id"
    exit 1
    ;;
esac

printf '{"type":"hostCall","id":"call","service":"%s","method":"run","params":%s}\n' \
  "$service" "$params"

reply=$(head -n 1)
case "$reply" in
  *'"ok":true'*)
    printf '{"id":"%s","ok":true,"result":{"output":""}}\n' "$request_id"
    ;;
  *)
    printf '{"id":"%s","ok":false,"error":{"message":"宿主未能完成备份排程请求"}}\n' \
      "$request_id"
    ;;
esac
