// Incremental collector for 공공감사포털 자체감사결과 data.
//
// Unlike full_scrape.js (a resumable one-shot that walks every page and
// re-downloads everything), this script only picks up reports registered
// AFTER the newest one already collected, and only renumbers the specific
// base groups that actually receive a new document.
//
// How it stays cheap and correct:
//   1. Watermark = newest frstRegDt already collected (stored in checkpoint,
//      or derived once from progress.log). The portal API returns reports
//      newest-first, so we scan from page 0 and stop as soon as we cross
//      below the watermark. Old pages are never touched -> no re-downloads.
//   2. frstRegDt is date-only (YYYY-MM-DD), so reports registered on the
//      watermark date itself are re-checked (>= watermark). Those few files
//      get re-downloaded and hashed, but content-hash dedup recognizes them
//      as already-saved and skips them.
//   3. A genuinely new document is always newer than everything in its group
//      (its regDt >= watermark >= every existing entry's regDt), so it takes
//      the front of the group. Each affected group is renumbered ONCE, in a
//      batch: all its new docs are prepended newest-first and its existing
//      files are shifted down by that count with a single directory scan.
//
// Two phases:
//   Phase 1 (scan+stage): download each new distinct document to a temp file
//     keyed by content hash. Dedup against the registry and within the run.
//   Phase 2 (integrate): per affected base, renumber once, rename the shifted
//     existing files, move the staged new files into place, checkpoint.
//
// Reports with no attachment are skipped entirely (no phantom numbering slots).
//
// Usage:   node incremental_scrape.js [OUT_DIR]
// Env:
//   DRY_RUN=1        simulate: log planned saves/renames, touch nothing on disk
//   SEARCH_BGNG=...  search window begin (YYYYMMDD), default 20250707
//   SEARCH_END=...   search window end (YYYYMMDD), default = today

process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_DIR = process.argv[2] || '/home/user/data/자체감사결과';
const TMP_DIR = path.join(__dirname, '.incoming'); // outside OUT_DIR so it is never scanned
const PAGE_SIZE = 10;
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');
const LOG_FILE = path.join(__dirname, 'progress.log');
const DRY = !!process.env.DRY_RUN;
const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // GitHub hard limit is 100MB; leave margin

function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
const SEARCH_BGNG = process.env.SEARCH_BGNG || '20250707';
const SEARCH_END = process.env.SEARCH_END || todayYmd();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${DRY ? '[DRY] ' : ''}${msg}`;
  console.log(line);
  if (!DRY) fs.appendFileSync(LOG_FILE, line + '\n');
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
}

// Return the plan for adding `m` new documents to the front of a base group
// whose existing entries currently have `existingFinalNames`.
//   allFinals       final names for [new docs..., existing...] after renumber
//   newDocFinals    final names for the m new docs (indices 0..m-1)
//   existingRenames [oldFinalName, newFinalName] for each shifted existing
//                   entry whose name changes, in original order
function computeRenumberPlan(base, existingFinalNames, m) {
  const total = existingFinalNames.length + m;
  const numbered = total > 1;
  const allFinals = [];
  for (let i = 0; i < total; i++) allFinals.push(numbered ? `${base}(${i + 1})` : base);
  const newDocFinals = allFinals.slice(0, m);
  const existingRenames = [];
  for (let j = 0; j < existingFinalNames.length; j++) {
    const from = existingFinalNames[j];
    const to = allFinals[j + m];
    if (from !== to) existingRenames.push([from, to]);
  }
  return { allFinals, newDocFinals, existingRenames };
}

// Rename every file belonging to base-name `oldStem` to `newStem`, using a
// pre-computed directory listing `snapshot` (so we never re-scan the folder).
// Handles a plain "{stem}{ext}" file and split "{stem}_조각(n){ext}.part"
// chunks. Prefix matching is anchored on the char right after the stem so
// "base(1)" never matches "base(10)" and unnumbered "base" never matches
// numbered "base(1)". Returns the [from,to] pairs it (would) rename.
function renameStem(dir, oldStem, newStem, snapshot, dry) {
  const done = [];
  if (oldStem === newStem) return done;
  for (const f of snapshot) {
    if (!f.startsWith(oldStem)) continue;
    const rest = f.slice(oldStem.length);
    if (!(rest.startsWith('.') || rest.startsWith('_조각('))) continue;
    const target = newStem + rest;
    if (!dry) fs.renameSync(path.join(dir, f), path.join(dir, target));
    done.push([f, target]);
  }
  return done;
}

function saveMaybeSplit(outDir, finalName, ext, buf) {
  if (buf.length <= MAX_CHUNK_BYTES) {
    const name = `${finalName}${ext}`;
    fs.writeFileSync(path.join(outDir, name), buf);
    return name;
  }
  const parts = Math.ceil(buf.length / MAX_CHUNK_BYTES);
  const names = [];
  for (let i = 0; i < parts; i++) {
    const chunk = buf.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    const name = `${finalName}_조각(${i + 1})${ext}.part`;
    fs.writeFileSync(path.join(outDir, name), chunk);
    names.push(name);
  }
  return names.join(', ');
}

function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function getJson(pathStr, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await proxyRequest('www.pap.go.kr', pathStr, { headers: { Accept: 'application/hal+json' } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(r.body.toString());
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

async function postDownload(fileId, fileSn, retries = 3) {
  const body = JSON.stringify({ fileId, fileSn });
  for (let i = 0; i < retries; i++) {
    try {
      const r = await proxyRequest('www.pap.go.kr', '/api/files/download', {
        method: 'POST',
        headers: { Accept: 'application/hal+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  }
  return { nextPage: 0, nameRegistry: {}, totalReports: 0, totalFiles: 0 };
}

function saveCheckpoint(cp) {
  if (DRY) return;
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// Newest frstRegDt already collected. Prefer the stored value; otherwise
// derive it once from progress.log (SAVED/SKIP lines end with "| <regDt>").
function deriveWatermark(cp) {
  if (cp.regDtWatermark) return cp.regDtWatermark;
  if (!fs.existsSync(LOG_FILE)) {
    throw new Error('No regDtWatermark in checkpoint and no progress.log to derive it from.');
  }
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  let max = '';
  const re = /\|\s(\d{4}-\d{2}-\d{2})\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) if (m[1] > max) max = m[1];
  if (!max) throw new Error('Could not derive watermark from progress.log');
  return max;
}

async function buildInstCdLookup() {
  const map = new Map();
  const r = await getJson('/api/instCd?size=3000&palaw1InstClsfCd=30');
  const list = (r._embedded && r._embedded.instCdListDtoes) || [];
  for (const item of list) map.set(item.instCd, item.instNm);
  log(`Loaded instCd lookup: ${map.size} institutions`);
  return map;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!DRY) fs.mkdirSync(TMP_DIR, { recursive: true });
  const cp = loadCheckpoint();
  const nameRegistry = cp.nameRegistry;
  const watermark = deriveWatermark(cp);
  log(`Incremental run. Watermark(regDt) = ${watermark}. Window ${SEARCH_BGNG}..${SEARCH_END}. ` +
    `Existing: ${cp.totalReports} reports / ${cp.totalFiles} files, ${Object.keys(nameRegistry).length} base groups.`);

  const instCdLookup = await buildInstCdLookup();

  // ---- Phase 1: scan newest-first and stage new distinct documents ----
  const pending = new Map();     // base -> [{ contentKey, regDt, tmpPath, ext, size, srcName }]
  const stagedKeys = new Set();  // `${base}::${contentKey}` seen this run (dedup)
  let newFiles = 0;
  let newReports = 0;
  let maxRegDt = watermark;

  async function stageRow(row) {
    const instNm = row.instCdNm || instCdLookup.get(row.instCd) || row.instCd || '기관명미상';
    const base = sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);
    const regDt = row.frstRegDt || '';

    const limit = pLimit(6);
    const seenAttachment = new Map();
    const orderedResults = await Promise.all((row.subList || []).map((sub) => limit(async () => {
      if (!sub.rlsDocAtchFileUuid) return null;
      const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
      const detail = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
      if (!detail) return null;
      const attKey = `${detail.fileId}::${detail.fileSn}`;
      if (!seenAttachment.has(attKey)) {
        seenAttachment.set(attKey, (async () => {
          const bodyBuf = await postDownload(detail.fileId, detail.fileSn);
          const hash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
          return { fileName: detail.fileName, bodyBuf, hash };
        })());
      }
      return seenAttachment.get(attKey);
    })));

    const rowFiles = [];
    for (const r of orderedResults) {
      if (r && !rowFiles.some((x) => x.hash === r.hash)) rowFiles.push(r);
    }
    if (rowFiles.length === 0) return;

    let staged = 0;
    for (const resolved of rowFiles) {
      const contentKey = resolved.hash;
      const group = nameRegistry[base];
      if (group && group.some((g) => g.contentKey === contentKey)) continue; // already collected
      const dedupKey = `${base}::${contentKey}`;
      if (stagedKeys.has(dedupKey)) continue; // identical content already staged this run
      stagedKeys.add(dedupKey);

      const ext = (resolved.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
      let tmpPath = null;
      if (!DRY) {
        tmpPath = path.join(TMP_DIR, `${contentKey}${ext}`);
        fs.writeFileSync(tmpPath, resolved.bodyBuf);
      }
      if (!pending.has(base)) pending.set(base, []);
      pending.get(base).push({ contentKey, regDt, tmpPath, ext, size: resolved.bodyBuf.length, srcName: `${instNm} | ${row.adYr}년 ${row.adFldNm}` });
      staged++;
      newFiles++;
    }
    if (staged > 0) newReports++;
  }

  let page = 0;
  let reachedBelow = false;
  let totalElements = null;
  while (true) {
    const params = new URLSearchParams({
      searchYmdBgng: SEARCH_BGNG, searchYmdEnd: SEARCH_END,
      instNm: '', palawInstClsfCd: '30',
      size: String(PAGE_SIZE), index: '0', page: String(page),
    });
    const search = await getJson('/api/fdadPlanRslt?' + params.toString());
    totalElements = search.page.totalElements;
    const rows = (search._embedded && search._embedded.fdadPlanRsltListDtoes) || [];
    if (rows.length === 0) { log(`Page ${page} empty. Stopping.`); break; }

    for (const row of rows) {
      const regDt = row.frstRegDt || '';
      if (regDt && regDt < watermark) { reachedBelow = true; continue; }
      if (regDt > maxRegDt) maxRegDt = regDt;
      await stageRow(row);
    }
    log(`Page ${page} scanned. Staged new files so far: ${newFiles}.`);
    if (reachedBelow) break; // API is newest-first: everything past here is older
    page++;
    if (page * PAGE_SIZE >= totalElements) break;
  }

  log(`Scan done. ${newFiles} new files across ${pending.size} groups (${newReports} new reports). Integrating...`);

  // ---- Phase 2: integrate each affected group in one batch ----
  const snapshot = fs.readdirSync(OUT_DIR);
  for (const [base, newDocs] of pending) {
    const existing = nameRegistry[base] || [];
    const m = newDocs.length;
    const existingFinals = existing.map((g) => g.finalName);
    const { allFinals, newDocFinals, existingRenames } = computeRenumberPlan(base, existingFinals, m);

    // Shift existing files, highest target number first so (1)->(2) never
    // clobbers an existing (2). existingRenames is in ascending original order.
    for (let k = existingRenames.length - 1; k >= 0; k--) {
      const [from, to] = existingRenames[k];
      const pairs = renameStem(OUT_DIR, from, to, snapshot, DRY);
      if (DRY) for (const [a, b] of pairs) log(`WOULD RENAME: ${a} -> ${b}`);
    }

    // Place the new documents into the freed front slots.
    for (let i = 0; i < m; i++) {
      const d = newDocs[i];
      const finalName = newDocFinals[i];
      if (DRY) {
        log(`WOULD SAVE (incremental): ${finalName}${d.ext} (${d.size}B) <- ${d.srcName} | ${d.regDt}`);
      } else {
        const buf = fs.readFileSync(d.tmpPath);
        const savedAs = saveMaybeSplit(OUT_DIR, finalName, d.ext, buf);
        fs.unlinkSync(d.tmpPath);
        cp.totalFiles++;
        log(`SAVED (incremental): ${savedAs} (${d.size}B) <- ${d.srcName} | ${d.regDt}`);
      }
    }

    // Update the registry: new docs (newest-first) ahead of existing entries.
    const merged = [
      ...newDocs.map((d) => ({ contentKey: d.contentKey, regDt: d.regDt })),
      ...existing,
    ];
    merged.forEach((g, i) => { g.finalName = allFinals[i]; });
    nameRegistry[base] = merged;

    if (!DRY) {
      cp.nameRegistry = nameRegistry;
      cp.regDtWatermark = maxRegDt;
      saveCheckpoint(cp);
    }
  }

  cp.totalReports += newReports;
  if (!DRY) {
    cp.nameRegistry = nameRegistry;
    cp.regDtWatermark = maxRegDt;
    saveCheckpoint(cp);
    try { fs.rmdirSync(TMP_DIR); } catch (_) { /* not empty / already gone */ }
  }
  log(`Incremental run done. New reports: ${newReports}, new files: ${newFiles}. ` +
    `New watermark: ${maxRegDt}. Totals: ${cp.totalReports} reports / ${cp.totalFiles} files.`);
}

module.exports = { computeRenumberPlan, renameStem, sanitize };

if (require.main === module) {
  main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
}
