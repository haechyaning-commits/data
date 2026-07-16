#!/bin/bash
# Commits and pushes whatever is already downloaded in 자체감사파일2/ in small
# chunks (default 400MB) so each push stays under the proxy/GitHub request-size
# cap that rejected a ~1.3GB pack with HTTP 413. Undoes any unpushed oversized
# batch commit first (files stay on disk), then re-commits chunk by chunk.
set -u
cd /home/user/data
BRANCH=claude/code-startup-error-ol0g7y
CHUNK_BYTES=${CHUNK_BYTES:-400000000}
OUT=자체감사파일2

git fetch -q origin "$BRANCH" 2>/dev/null || true
if [ "$(git rev-list --count origin/$BRANCH..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
  echo "Resetting $(git rev-list --count origin/$BRANCH..HEAD) unpushed commit(s); files remain on disk"
  git reset -q "origin/$BRANCH"
fi

list=$(mktemp)
chunk=$(mktemp)
find "$OUT" -maxdepth 1 -type f | sort > "$list"
total=$(wc -l < "$list")
echo "Flushing $total on-disk files in <=$((CHUNK_BYTES / 1000000))MB chunks"

acc=0
push_chunk() {
  [ -s "$chunk" ] || return 0
  git add --pathspec-from-file="$chunk"
  git add _scripts/done2.log 2>/dev/null || true
  nf=$(git diff --cached --numstat | wc -l)
  [ "$nf" -eq 0 ] && { : > "$chunk"; acc=0; return 0; }
  git commit -q -m "자체감사파일2: 2021~2023 자체감사결과 분할 푸시 (${nf}개 파일)

Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011VkHsMpw986EvcbcGSvFhy"
  ok=0
  for d in 0 2 4 8 16; do
    [ "$d" -gt 0 ] && sleep "$d"
    if git push -u origin "$BRANCH"; then ok=1; break; fi
    echo "push failed; backing off" >&2
  done
  [ "$ok" -eq 1 ] || { echo "PUSH FAILED; aborting (commit kept locally)" >&2; exit 3; }
  xargs -a "$chunk" -d '\n' -r -n 400 git update-index --skip-worktree
  xargs -a "$chunk" -d '\n' -r -n 400 rm -f
  echo "CHUNK PUSHED: $nf files"
  : > "$chunk"; acc=0
}

while IFS= read -r f; do
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  printf '%s\n' "$f" >> "$chunk"
  acc=$((acc + sz))
  [ "$acc" -ge "$CHUNK_BYTES" ] && push_chunk
done < "$list"
push_chunk
rm -f "$list" "$chunk"
echo "FLUSH DONE"
