#!/bin/sh
# Publish the official packages and the marketplace feed in one step.
#
# Signing needs the offline key, so this runs on the machine that holds it and
# nowhere else (D-1036 in the host repository). Everything else — testing the
# signed feed, folding dist/ into the release commit, publishing — follows from
# that one signature, which is why it lives behind one command.
#
#   sh scripts/release.sh ~/.mypaste/official-signing.key
#   sh scripts/release.sh ~/.mypaste/official-signing.key --no-push
#
# The script refuses to start unless the work tree is clean and the current
# branch is a release branch ahead of main. It stops at the first failure: a
# test failure leaves the signed dist/ in place but commits and pushes nothing.
set -eu

usage() {
  printf 'usage: sh scripts/release.sh <signing-key> [--no-push]\n' >&2
  printf '   or: MYPASTE_SIGNING_KEY=<key> sh scripts/release.sh [--no-push]\n' >&2
  exit 2
}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEY=
PUSH=1
for argument in "$@"; do
  case "$argument" in
    --no-push) PUSH=0 ;;
    -h|--help) usage ;;
    -*)
      printf 'error: unknown option %s\n' "$argument" >&2
      usage
      ;;
    *)
      if [ -n "$KEY" ]; then
        printf 'error: only one signing key may be given\n' >&2
        usage
      fi
      KEY=$argument
      ;;
  esac
done
[ -n "$KEY" ] || KEY=${MYPASTE_SIGNING_KEY:-}
[ -n "$KEY" ] || usage

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cd "$ROOT"

# The key is a 32-byte ed25519 seed. Check it is a file, outside the repository
# (so it can never be staged) and not readable by anyone else.
[ -f "$KEY" ] || fail "signing key not found: $KEY"
KEY_PATH=$(cd "$(dirname "$KEY")" && pwd)/$(basename "$KEY")
case "$KEY_PATH" in
  "$ROOT"/*) fail "signing key is inside the repository: $KEY_PATH" ;;
esac
KEY_MODE=$(stat -f '%Lp' "$KEY_PATH" 2>/dev/null || stat -c '%a' "$KEY_PATH" 2>/dev/null || true)
[ "$KEY_MODE" = "600" ] || fail "signing key must be mode 0600, found ${KEY_MODE:-unknown}"

# The release commit is the current tip: dist/ is folded into it, so anything
# else in the tree would ride along and any branch state would be rewritten.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
# Whatever happens next — a failing test, a rejected push — leave the developer
# on the branch they started from, not on main.
restore_branch() { git switch --quiet "$BRANCH" 2>/dev/null || true; }
trap restore_branch EXIT
[ "$BRANCH" != "main" ] || fail "release from a working branch, not main"
[ -z "$(git status --porcelain)" ] || fail "work tree is not clean"
git rev-parse --verify --quiet main >/dev/null || fail "no local main branch"
git merge-base --is-ancestor main HEAD || fail "main is not an ancestor of $BRANCH"

printf '==> signing official packages with %s\n' "$KEY_PATH"
python3 scripts/build-official.py --key-file "$KEY_PATH"

printf '==> running the package tests\n'
bun run test

printf '==> folding dist/ into %s\n' "$(git rev-parse --short HEAD)"
git add dist
if git diff --cached --quiet; then
  printf '    dist/ is unchanged\n'
else
  git commit --amend --no-edit --quiet
fi

printf '==> merging %s into main\n' "$BRANCH"
git switch --quiet main
git merge --ff-only --quiet "$BRANCH"

if [ "$PUSH" = "1" ]; then
  printf '==> pushing main to origin\n'
  git push origin main
else
  printf '==> main is ready; push it yourself with: git push origin main\n'
fi

printf 'done: %s is %s\n' "$BRANCH" "$(git rev-parse --short HEAD)"
