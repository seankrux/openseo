#!/bin/bash
# Source me. pause_batch: freeze the batch runner (SIGSTOP) at any point, then
# wait until no audit is pending/running in D1 (audits started in the last
# 50 min; older rows are orphans). The runner never starts an audit while it
# is frozen, and every audit it already started has finished server-side, so
# a restart cannot hit an in-flight audit. resume_batch sends SIGCONT; the
# runner then sees the finished audit and starts the next one.
B=/home/ubuntu/apps/openseo/batch
GLOG=/home/ubuntu/apps/openseo/ops/gate.log
RPID=$(cat $B/runner.pid 2>/dev/null)
D1F=state/v3/d1/miniflare-D1DatabaseObject/8776b4b8f1ef4325faa1c4edcc1d76726313abcd813c380a6b567bfe699b1f34.sqlite
inflight(){ # 2026-10-20 health check: openseo-backup-tool:1 was pruned; now ops/sqlite_tool.py in the running openseo image
  local IMG; IMG=$(docker inspect -f '{{.Image}}' openseo-open-seo-1 2>/dev/null || true); IMG=${IMG:-hermes-tokyo:latest}
  docker run --rm --network none -u 0 --entrypoint python3 -v openseo_open_seo_data:/d:ro \
    -v /home/ubuntu/apps/openseo/ops/sqlite_tool.py:/t.py:ro "$IMG" /t.py inflight "$D1F" 2>/dev/null || echo 1
}
pause_batch(){ # returns 0 when safe
  if ! kill -0 "$RPID" 2>/dev/null; then [ "$(inflight)" = 0 ] && return 0; fi
  kill -STOP "$RPID" 2>/dev/null && PAUSED=1
  echo "$(date -Is) gate: runner frozen, waiting for in-flight audits" >> $GLOG
  sleep 5
  for i in $(seq 1 ${GATE_TRIES:-200}); do
    n=$(inflight)
    if [ "$n" = 0 ]; then echo "$(date -Is) gate: no audit in flight, safe" >> $GLOG; return 0; fi
    sleep 15
  done
  echo "$(date -Is) gate: still in flight after wait; giving up" >> $GLOG
  resume_batch; return 1
}
resume_batch(){ [ "${PAUSED:-0}" = 1 ] && kill -CONT "$RPID" 2>/dev/null && echo "$(date -Is) gate: resumed runner" >> $GLOG; PAUSED=0; }
