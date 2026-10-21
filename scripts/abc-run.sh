#!/bin/sh
# Run the scripted tool sequence through `openclaw agent --local` against the current config and print a table.
# Usage: abc-run.sh <label> [session-key]   (env: OC_HOME=$HOME/oc-abc, PORT=18791)
set -u
LABEL=${1:-run}
SESSION=${2:-abc-$(echo "$LABEL" | tr A-Z a-z)-$(date +%s)}
OC_HOME=${OC_HOME:-$HOME/oc-abc}
PORT=${PORT:-18791}
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH=$HOME/.npm-global/bin:$PATH OPENCLAW_STATE_DIR=$OC_HOME/state OPENCLAW_CONFIG_PATH=$OC_HOME/openclaw.json
export WORKSPACE=${WORKSPACE:-$OC_HOME/ws} SCRIPT=${SCRIPT:-$HERE/abc-script.json} PORT LOG=$OC_HOME/driver-$LABEL.jsonl
rm -rf "$WORKSPACE/abc"; mkdir -p "$WORKSPACE"
pkill -f "[f]ake-model-driver" 2>/dev/null; sleep 0.5
node "$HERE/fake-model-driver.mjs" 2> "$OC_HOME/driver-$LABEL.err" &
DRV=$!
sleep 1
START=$(date +%s)
openclaw agent --local --session-key "agent:main:$SESSION" -m "run the script" --json --timeout 900 > "$OC_HOME/agent-$LABEL.json" 2> "$OC_HOME/agent-$LABEL.err"
echo "agent exit: $? in $(( $(date +%s) - START )) s"
kill $DRV 2>/dev/null
node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
for (const r of rows) console.log(`${String(r.step).padStart(2)} ${r.isError?"ERR ":"ok  "} ${String(r.ms??"-").padStart(6)} ms  ${r.label.padEnd(32)} ${(r.result||"").slice(0,150)}`);
' "$LOG"
