#!/bin/sh
# Run mcp-script.json through the REAL gateway (not --local) in $OC_HOME (default ~/oc-gw): config has the MCP server, tool policy, sbx ssh.
# Usage: mcp-run.sh <label>   (env: SCRIPT, AGENT=projA)
set -u
LABEL=${1:-run}; OC_HOME=${OC_HOME:-$HOME/oc-gw}; PORT=${PORT:-18791}; AGENT=${AGENT:-projA}
HERE=$(cd "$(dirname "$0")" && pwd)
. "$OC_HOME/env.sh"
export WORKSPACE=${WORKSPACE:-$OC_HOME/ws/projA} SCRIPT=${SCRIPT:-$HERE/mcp-script.json} RESULT_CHARS=${RESULT_CHARS:-400} PORT LOG=$OC_HOME/driver-$LABEL.jsonl
rm -rf "$WORKSPACE/mcp"; mkdir -p "$WORKSPACE"
pkill -f "[f]ake-model-driver" 2>/dev/null; sleep 0.5
node "$HERE/fake-model-driver.mjs" 2> "$OC_HOME/driver-$LABEL.err" &
DRV=$!; sleep 1; START=$(date +%s)
openclaw agent --agent "$AGENT" --session-id "mcp-$LABEL-$(date +%s)" -m "run the script" --json --timeout 600 > "$OC_HOME/agent-$LABEL.json" 2> "$OC_HOME/agent-$LABEL.err"
echo "agent exit: $? in $(( $(date +%s) - START )) s"
kill $DRV 2>/dev/null
node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
for (const r of rows) console.log(`${String(r.step).padStart(2)} ${r.isError?"ERR ":"ok  "} ${String(r.ms??"-").padStart(6)} ms  ${r.label.padEnd(44)} ${(r.result||"").slice(0,170)}`);
' "$LOG"
