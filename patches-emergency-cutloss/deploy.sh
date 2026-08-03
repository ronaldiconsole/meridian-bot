#!/bin/bash
# Deploy emergency cutloss patch to VPS Meridian bot
# Run from local machine. Requires SSH key auth to root@103.180.165.240
set -euo pipefail
VPS=root@103.180.165.240
REMOTE=/root/meridian
TS=$(date +%Y%m%d_%H%M%S)

echo "==> 1/6 Backup ke $REMOTE/backup-20260803-emergency-cutloss-$TS"
ssh -o ConnectTimeout=10 $VPS "cd $REMOTE && mkdir -p backup-20260803-emergency-cutloss-$TS && cp state.js tools/dlmm.js tools/pnl.js tools/executor.js index.js config.js user-config.json backup-20260803-emergency-cutloss-$TS/"

echo "==> 2/6 Upload patch scripts"
scp -o ConnectTimeout=10 \
  /tmp/meridian-edit/apply_state.py \
  /tmp/meridian-edit/apply_dlmm_track.py \
  /tmp/meridian-edit/apply_pnl_virtual.py \
  /tmp/meridian-edit/apply_dlmm_merge.py \
  /tmp/meridian-edit/apply_dlmm_close.py \
  $VPS:$REMOTE/

echo "==> 3/6 Apply patches"
ssh -o ConnectTimeout=10 $VPS "cd $REMOTE && \
  python3 apply_state.py && \
  python3 apply_dlmm_track.py && \
  python3 apply_pnl_virtual.py && \
  python3 apply_dlmm_merge.py && \
  python3 apply_dlmm_close.py"

echo "==> 4/6 Syntax check"
ssh -o ConnectTimeout=10 $VPS "cd $REMOTE && \
  node --check state.js && echo 'state.js OK' && \
  node --check tools/pnl.js && echo 'pnl.js OK' && \
  node --check tools/dlmm.js && echo 'dlmm.js OK'"

echo "==> 5/6 Cleanup patch scripts"
ssh -o ConnectTimeout=10 $VPS "cd $REMOTE && rm -f apply_state.py apply_dlmm_track.py apply_pnl_virtual.py apply_dlmm_merge.py apply_dlmm_close.py"

echo "==> 6/6 Restart bot (PM2) — verify"
ssh -o ConnectTimeout=10 $VPS "cd $REMOTE && pm2 restart meridian 2>&1 | tail -3 && sleep 4 && pm2 logs meridian --lines 15 --nostream 2>&1 | tail -20"

echo "==> DONE"
