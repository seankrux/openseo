#!/bin/bash
# deploy.sh <newtag> : swap open-seo image with health check + automatic rollback.
set -u
NEW=$1; cd ~/apps/openseo; LOG=ops/deploy.log
log(){ echo "$(date -Is) $*" | tee -a $LOG; }
OLD=$(grep -o '^OPEN_SEO_IMAGE=.*' .env | cut -d= -f2)
docker image inspect open-seo-citythrive:$NEW >/dev/null || { log "image missing"; exit 1; }
docker tag "$OLD" open-seo-citythrive:rollback
TS=$(date +%Y%m%d%H%M%S); cp -p .env backups/env-pre-$NEW-$TS; cp -p compose.override.yaml backups/override-pre-$NEW-$TS; chmod 600 backups/*-pre-$NEW-$TS
ops/backup.sh || log "pre-deploy backup failed (continuing)"
. ops/gate.sh; pause_batch || { log "no gap between audits; abort"; exit 1; }; trap resume_batch EXIT
log "deploy $OLD -> open-seo-citythrive:$NEW (last: $(tail -1 batch/run.log | cut -c1-90))"
sed -i "s#^OPEN_SEO_IMAGE=.*#OPEN_SEO_IMAGE=open-seo-citythrive:$NEW#" .env
grep -q '^OPENROUTER_BASE_URL=' .env || echo 'OPENROUTER_BASE_URL=http://100.84.140.90:8317/v1' >> .env
printf 'services:\n  open-seo:\n    mem_limit: 4g\n    memswap_limit: 4g\n' > compose.override.yaml
docker compose up -d --no-deps open-seo >> $LOG 2>&1
ok=0; for i in $(seq 1 90); do curl -sf -m5 http://127.0.0.1:3001/api/health >/dev/null && { ok=1; break; }; sleep 10; done
sleep 5
if [ $ok = 1 ] && ops/health.sh >> $LOG 2>&1; then log "DEPLOY OK $NEW"; exit 0; fi
log "HEALTH FAILED -> rollback to $OLD"
cp -p backups/env-pre-$NEW-$TS .env; cp -p backups/override-pre-$NEW-$TS compose.override.yaml
docker compose up -d --no-deps open-seo >> $LOG 2>&1
for i in $(seq 1 90); do curl -sf -m5 http://127.0.0.1:3001/api/health >/dev/null && break; sleep 10; done
ops/health.sh >> $LOG 2>&1 && log "rollback healthy" || log "ROLLBACK UNHEALTHY"
exit 2
