#!/bin/sh
# Start the OpenClaw gateway for $OC_HOME (default ~/oc-gw) on 127.0.0.1:18792, optionally under strace (STRACE=1).
OC_HOME=${OC_HOME:-$HOME/oc-gw}; . "$OC_HOME/env.sh"
pkill -f "[o]penclaw-gateway|[o]penclaw gateway" 2>/dev/null; sleep 1
if [ "${STRACE:-0}" = 1 ]; then
  nohup strace -f -tt -s 0 -e trace=connect -o "$OC_HOME/strace.gw" openclaw gateway run --port 18792 --bind loopback > "$OC_HOME/gateway.log" 2>&1 &
else
  nohup openclaw gateway run --port 18792 --bind loopback > "$OC_HOME/gateway.log" 2>&1 &
fi
for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:18792/ && break; sleep 1; done
echo started; tail -5 "$OC_HOME/gateway.log"
