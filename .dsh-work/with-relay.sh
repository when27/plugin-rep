#!/usr/bin/env bash
# Start the loopback git smart-HTTP relay, run one git operation against it, and
# stop the relay. The relay lets git (whose schannel backend is broken in this
# sandbox) use Node's OpenSSL TLS for github.com.
#
# Usage: with-relay.sh <clone|push|ls> <portFileWin> <credFileWin> [args...]
#   clone <port> <cred> <dest>
#   push  <port> <cred> <repoDir> <branch>
#   ls    <port> <cred>
set -u
MODE=$1
PORT_FILE_WIN=$2
CRED_FILE_WIN=$3
shift 3
PORT_FILE_MSYS=$(cygpath -u "$PORT_FILE_WIN")
rm -f "$PORT_FILE_MSYS"

DSH_CRED_FILE="$CRED_FILE_WIN" DSH_PORT_FILE="$PORT_FILE_WIN" \
  node .dsh-work/git-http-relay.mjs >/tmp/dsh-relay.log 2>&1 &
RELAY_PID=$!
cleanup() { taskkill //F //PID "$RELAY_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 80); do
  [ -s "$PORT_FILE_MSYS" ] && break
  sleep 0.25
done
if [ ! -s "$PORT_FILE_MSYS" ]; then
  echo "relay failed to start" >&2
  head -5 /tmp/dsh-relay.log >&2
  exit 1
fi
PORT=$(cat "$PORT_FILE_MSYS")
RELAY_URL="http://127.0.0.1:$PORT/when27/plugin-rep.git"
echo "relay_ready port=$PORT"
export GIT_TERMINAL_PROMPT=0

case "$MODE" in
  clone) git clone "$RELAY_URL" "$1" ;;
  push) git -C "$1" push "$RELAY_URL" "$2" ;;
  ls) git ls-remote "$RELAY_URL" ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
