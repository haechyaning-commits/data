#!/bin/bash
# Orchestrates phase 2: download batch -> commit -> push -> free local copies,
# looping until manifest2.json is exhausted. Designed to survive interruption:
# done2.log is committed with every batch, so a fresh container can resume.
set -u
cd /home/user/data
BRANCH=claude/code-startup-error-ol0g7y
SCRIPTS=/home/user/data/_scripts
OUT=자체감사파일2
BATCH_BYTES=${BATCH_BYTES:-1300000000}
PREV_REMAINING=-1
STALL=0

while true; do
  node "$SCRIPTS/download_batch.js" "/home/user/data/$OUT" "$BATCH_BYTES"
  rc=$?
  if [ $rc -ne 0 ] && [ $rc -ne 2 ]; then
    echo "download_batch.js exited rc=$rc; aborting" >&2
    exit $rc
  fi
  remaining=$(cat "$SCRIPTS/remaining2.txt" 2>/dev/null || echo -1)

  git add "$OUT" "$SCRIPTS/done2.log" "$SCRIPTS/manifest2.json" \
      "$SCRIPTS/build_manifest.js" "$SCRIPTS/download_batch.js" "$SCRIPTS/orchestrate2.sh" 2>/dev/null
  n_staged=$(git diff --cached --numstat | wc -l)
  if [ "$n_staged" -gt 0 ]; then
    n_files=$(git diff --cached --numstat -- "$OUT" | wc -l)
    git commit -q -m "자체감사파일2: 2021~2023 자체감사결과 배치 추가 (${n_files}개 파일, 남은 항목 ${remaining}건)

Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011VkHsMpw986EvcbcGSvFhy"

    pushed=0
    for delay in 0 2 4 8 16; do
      [ "$delay" -gt 0 ] && sleep "$delay"
      if git push -u origin "$BRANCH"; then pushed=1; break; fi
      echo "push failed; retrying in next backoff step" >&2
    done
    if [ "$pushed" -ne 1 ]; then
      echo "git push failed after retries; aborting (files remain committed locally)" >&2
      exit 3
    fi

    # Free disk: keep this batch's blobs only in .git, drop worktree copies.
    git ls-files -z "$OUT" | xargs -0 -r -n 500 git update-index --skip-worktree
    git ls-files -z "$OUT" | while IFS= read -r -d '' f; do [ -f "$f" ] && rm -f "$f"; done
  fi

  if [ "$remaining" = "0" ]; then
    echo "ALL DONE"
    break
  fi
  if [ "$remaining" = "$PREV_REMAINING" ]; then
    STALL=$((STALL + 1))
    if [ "$STALL" -ge 3 ]; then
      echo "No progress across 3 consecutive batches (remaining=$remaining); aborting" >&2
      exit 4
    fi
  else
    STALL=0
  fi
  PREV_REMAINING=$remaining
done
