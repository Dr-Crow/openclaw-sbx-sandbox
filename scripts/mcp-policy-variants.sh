#!/bin/bash
# Which tools does the model see under different tools.allow / sandbox alsoAllow / toolSearch settings?
# Runs `openclaw agent --local` per variant against a copy of $OC_HOME/openclaw.json and records the tool names in the
# first model request (fake-model-driver writes <LOG>.tools.json). Usage: mcp-policy-variants.sh
set -u
OC_HOME=${OC_HOME:-$HOME/oc-gw}; PORT=${PORT:-18791}; HERE=$(cd "$(dirname "$0")" && pwd)
. "$OC_HOME/env.sh"; BASE=$OC_HOME/openclaw.json; mkdir -p "$OC_HOME/variants"
echo '[{"label":"noop","tool":"tool_search","args":{"query":"echo"}}]' > "$OC_HOME/variants/noop.json"
variant() { # name, python-edit-expression on dict c
  local name=$1 expr=$2 cfg=$OC_HOME/variants/$1.json
  python3 - "$BASE" "$cfg" "$expr" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); exec(sys.argv[3]); json.dump(c,open(sys.argv[2],"w"),indent=1)
PY
  pkill -f "[f]ake-model-driver" 2>/dev/null; sleep 0.3
  SCRIPT=$OC_HOME/variants/noop.json LOG=$OC_HOME/variants/$name.jsonl WORKSPACE=$OC_HOME/ws/projA PORT=$PORT node "$HERE/fake-model-driver.mjs" 2>/dev/null &
  local drv=$!; sleep 0.8
  OPENCLAW_CONFIG_PATH=$cfg timeout 120 openclaw agent --local --agent projA --session-id "var-$name-$(date +%s)" -m x --json --timeout 100 >/dev/null 2>"$OC_HOME/variants/$name.err"
  kill $drv 2>/dev/null; sleep 0.3
  printf '%-34s %s\n' "$name" "$(python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1]))))' "$OC_HOME/variants/$name.jsonl.tools.json" 2>&1)"
}
TS='c.setdefault("tools",{})["toolSearch"]=False'
variant v0-baseline        'pass'
variant v1-direct          "$TS"
variant v2-direct-noglob   "$TS; c['agents']['entries']['projA']['tools']['allow']=['exec','read','write','edit','apply_patch']"
variant v3-direct-nobundle "$TS; c['tools']['sandbox']['tools']['alsoAllow']=[]"
variant v4-direct-srvglob  "$TS; c['tools']['sandbox']['tools']['alsoAllow']=['gw_projA__*']"
variant v5-direct-exact    "$TS; c['agents']['entries']['projA']['tools']['allow']=['exec','gw_projA__everything__echo']"
variant v6-direct-noagentallow "$TS; del c['agents']['entries']['projA']['tools']"
variant v7-direct-deny-group-plugins "$TS; c['tools']['deny']=['group:automation','group:plugins']"
