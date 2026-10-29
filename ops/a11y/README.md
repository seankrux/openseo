# OpenSEO accessibility gate
Run after every deploy (or against a candidate container) before switching `compose.override.yaml`:

    cd ~/apps/openseo/ops/a11y && npm ci --silent || npm i --silent
    BASE=http://127.0.0.1:3001 node check.js

Exit 0 = no axe WCAG 2.1 A/AA/best-practice violations and no 320px horizontal scroll on the routes in `routes.json`.
Baseline: 0 failures on 2026-10-20 (image tools-review-20261021). See /mnt/gdrive/tokyo/Reports/openseo-accessibility-audit-2026-10-20.md.
