#!/bin/bash
# Daily sqlite-safe backup of openseo_open_seo_data volume. Keeps 7 days. Output mode 600 under backups/daily.
# 2026-10-20 health check: the openseo-backup-tool:1 image was removed by a `docker image prune -a` (00:21 CEST),
# so this now runs ops/sqlite_tool.py (python3 sqlite3 backup API) inside the image of the running openseo
# container (can't be pruned while in use), falling back to hermes-tokyo:latest. Old script: backup.sh.bak-health-20261020-1806
set -euo pipefail
umask 077
OPS=/home/ubuntu/apps/openseo/ops
OUT=/home/ubuntu/apps/openseo/backups/daily; mkdir -p $OUT; chmod 700 $OUT
TS=$(date -u +%Y%m%dT%H%M%SZ)
IMG=$(docker inspect -f '{{.Image}}' openseo-open-seo-1 2>/dev/null || true); IMG=${IMG:-hermes-tokyo:latest}
nice -n19 ionice -c3 docker run --rm --network none -u 0 --entrypoint python3 \
  -v openseo_open_seo_data:/d -v $OUT:/o -v $OPS/sqlite_tool.py:/t.py:ro "$IMG" /t.py backup "$TS"
find $OUT -name 'openseo-*.tgz' -mtime +6 -delete
echo "$(date -Is) ok $(du -h $OUT/openseo-$TS.tgz|cut -f1) $OUT/openseo-$TS.tgz" >> /home/ubuntu/apps/openseo/ops/backup.log
