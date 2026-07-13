// Applies the gap-pass outputs before downloading:
//  1. renames3.json — files already committed (worktree copies removed via
//     skip-worktree) whose base name gained new entries, so "base.ext" must
//     become "base(1).ext". Done purely in the git index via ls-files -s +
//     update-index --cacheinfo, since the blobs are not on disk anymore.
//  2. Updates manifest2.json entry names accordingly and marks the new names
//     done in done2.log so the downloader never re-fetches them.
//  3. Merges manifest3.json (new gap-period entries) into manifest2.json,
//     which orchestrate2.sh/download_batch.js already consume.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = '/home/user/data';
const OUT = '자체감사파일2';
const S = __dirname;

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

const renames = JSON.parse(fs.readFileSync(path.join(S, 'renames3.json'), 'utf8'));
const manifest2 = JSON.parse(fs.readFileSync(path.join(S, 'manifest2.json'), 'utf8'));
const manifest3 = JSON.parse(fs.readFileSync(path.join(S, 'manifest3.json'), 'utf8'));

const byName = new Map(manifest2.map((m) => [m.name, m]));
let renamed = 0, skipped = 0;
for (const r of renames) {
  const oldPath = `${OUT}/${r.from}`;
  const newPath = `${OUT}/${r.to}`;
  let entry;
  try {
    entry = git('ls-files', '-s', '--', oldPath).trim();
  } catch { entry = ''; }
  if (!entry) {
    console.log(`SKIP rename (not in index): ${oldPath}`);
    skipped++;
    continue;
  }
  const [mode, sha] = entry.split(/\s+/);
  git('update-index', '--add', '--cacheinfo', `${mode},${sha},${newPath}`);
  git('update-index', '--skip-worktree', '--', newPath);
  git('rm', '--cached', '-q', '--', oldPath);
  const m = byName.get(r.manifestName);
  if (m) m.name = r.newManifestName;
  fs.appendFileSync(path.join(S, 'done2.log'), r.newManifestName + '\n');
  renamed++;
}

const merged = manifest2.concat(manifest3);
fs.writeFileSync(path.join(S, 'manifest2.json'), JSON.stringify(merged, null, 1));
console.log(`renamed=${renamed} skipped=${skipped} merged_total=${merged.length} new=${manifest3.length}`);
