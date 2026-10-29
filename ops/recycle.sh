#!/bin/bash
# Restart openseo container between batch audits when memory exceeds threshold (upstream #408 leak).
# Usage: recycle.sh [--force]  ; THRESH_MB default 2800
set -u
C=openseo-open-seo-1; THRESH_MB=${THRESH_MB:-2800}; LOG=~/apps/openseo/ops/recycle.log
B=~/apps/openseo/batch
exec 9>/tmp/openseo-recycle.lock; flock -n 9 || exit 0
mem=$(docker stats --no-stream --format '{{.MemUsage}}' $C | awk '{v=$1; if(v~/GiB/){sub("GiB","",v);print int(v*1024)} else {sub("MiB","",v);print int(v)}}')
[ -z "$mem" ] && exit 0
if [ "${1:-}" != "--force" ] && [ "$mem" -lt "$THRESH_MB" ]; then exit 0; fi
. /home/ubuntu/apps/openseo/ops/gate.sh
pause_batch || { echo "$(date -Is) no gap between audits in 30m; skip" >> $LOG; exit 0; }
trap resume_batch EXIT
echo "$(date -Is) recycle mem=${mem}MB last='$(tail -1 $B/run.log|cut -c1-120)'" >> $LOG
docker restart -t 30 $C >> $LOG 2>&1
for i in $(seq 1 60); do curl -sf -m5 http://127.0.0.1:3001/api/health >/dev/null && { echo "$(date -Is) healthy" >>$LOG; exit 0; }; sleep 5; done
echo "$(date -Is) NOT healthy after restart" >> $LOG
