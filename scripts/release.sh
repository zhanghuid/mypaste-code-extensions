#!/bin/sh
# Publish the official packages and the marketplace feed in one step.
#
# Installation is the trust decision (D-1039 in the host repository), so there
# is no signing key: the script builds the deterministic archives, tests the
# feed, folds dist/ into the release commit and publishes it.
#
#   sh scripts/release.sh
#   sh scripts/release.sh --no-push
#
# The script refuses to start unless the work tree is clean and the current
# branch is a release branch ahead of main. It stops at the first failure: a
# test failure leaves the rebuilt dist/ in place but commits and pushes
# nothing.
set -eu

usage() {
  printf 'usage: sh scripts/release.sh [--no-push]\n' >&2
  exit 2
}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PUSH=1
for argument in "$@"; do
  case "$argument" in
    --no-push) PUSH=0 ;;
    -h|--help) usage ;;
    *)
      printf 'error: unknown option %s\n' "$argument" >&2
      usage
      ;;
  esac
done

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cd "$ROOT"

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

printf '==> building official packages\n'
python3 scripts/build-official.py

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
