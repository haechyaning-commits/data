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
//      as already-saved and skips them. This is what makes the boundary safe
//      when new reports land on the same day as the last collected one.
//   3. A genuinely new document is always newer than everything in its group
//      (its regDt >= watermark >= every existing entry's regDt), so it takes
//      slot (1) and pushes the existing files down by one. Only that one
//      group's files are renamed on disk.
//
// Reports with no attachment are skipped entirely in incremental mode (they
// contribute no file); we do not reserve phantom numbering slots for them.
//
// Usage:
//   node incremental_scrape.js [OUT_DIR]
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
const PAGE_SIZE = 10;
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');
const LOG_FILE = path.join(__dirname, 'progress.log');
const DRY = !!process.env.DRY_RUN;

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

const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // GitHub hard limit is 100MB; leave margin

function saveMaybeSplit(outDir, finalName, ext, buf) {
  if (buf.length <= MAX_CHUNK_BYTES) {
    const name = `${finalName}${ext}`;
    if (!DRY) fs.writeFileSync(path.join(outDir, name), buf);
    return name;
  }
  const parts = Math.ceil(buf.length / MAX_CHUNK_BYTES);
  const names = [];
  for (let i = 0; i < parts; i++) {
    const chunk = buf.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    const name = `${finalName}_조각(${i + 1})${ext}.part`;
    if (!DRY) fs.writeFileSync(path.join(outDir, name), chunk);
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

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
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
// derive it once from progress.log (the SAVED/SKIP lines end with "| <regDt>").
function deriveWatermark(cp) {
  if (cp.regDtWatermark) return cp.regDtWatermark;
  if (!fs.existsSync(LOG_FILE)) {
    throw new Error('No regDtWatermark in checkpoint and no progress.log to derive it from. ' +
      'Run full_scrape.js first, or set an explicit watermark.');
  }
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  let max = '';
  const re = /\|\s(\d{4}-\d{2}-\d{2})\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] > max) max = m[1];
  }
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

// Rename every on-disk file belonging to base-name `oldFinal` to `newFinal`.
// Handles both a plain "{oldFinal}{ext}" file and split "{oldFinal}_조각(n){ext}.part"
// chunks. Prefix matching is anchored so "base(1)" never matches "base(10)".
function renameOnDisk(outDir, oldFinal, newFinal) {
  if (oldFinal === newFinal) return;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.startsWith(oldFinal)) continue;
    const rest = f.slice(oldFinal.length);
    const isPlain = rest.startsWith('.');          // "{oldFinal}.ext"
    const isChunk = rest.startsWith('_조각(');       // "{oldFinal}_조각(n).ext.part"
    if (!isPlain && !isChunk) continue;
    const target = newFinal + rest;
    if (DRY) { log(`WOULD RENAME: ${f} -> ${target}`); continue; }
    fs.renameSync(path.join(outDir, f), path.join(outDir, target));
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cp = loadCheckpoint();
  const nameRegistry = cp.nameRegistry;
  const watermark = deriveWatermark(cp);
  log(`Incremental run. Watermark(regDt) = ${watermark}. Window ${SEARCH_BGNG}..${SEARCH_END}. ` +
    `Existing: ${cp.totalReports} reports / ${cp.totalFiles} files, ${Object.keys(nameRegistry).length} base groups.`);

  const instCdLookup = await buildInstCdLookup();

  // Per-run insertion cursor for each base group: new documents (delivered
  // newest-first by the API) are spliced in at this index so they land ahead
  // of every previously-stored (older) entry, newest at (1).
  const runInsertPos = new Map();

  // Splice a brand-new distinct document into its base group, renumber the
  // group, rename the shifted existing files on disk, and return the new
  // document's finalName. Does NOT write the new file itself.
  function integrateNewDoc(base, contentKey, regDt) {
    const group = nameRegistry[base] || (nameRegistry[base] = []);
    const oldFinals = group.map((g) => g.finalName);
    const pos = runInsertPos.get(base) || 0;
    group.splice(pos, 0, { contentKey, regDt });
    runInsertPos.set(base, pos + 1);

    const numbered = group.length > 1;
    const newFinals = group.map((g, i) => (numbered ? `${base}(${i + 1})` : base));

    // Rename shifted existing files, highest target number first to avoid
    // clobbering a slot that another file is about to move into.
    for (let j = oldFinals.length - 1; j >= 0; j--) {
      const newIndex = j >= pos ? j + 1 : j; // entries at/after pos shifted down by one
      renameOnDisk(OUT_DIR, oldFinals[j], newFinals[newIndex]);
    }
    group.forEach((g, i) => { g.finalName = newFinals[i]; });
    return newFinals[pos];
  }

  async function processRow(row) {
    const instNm = row.instCdNm || instCdLookup.get(row.instCd) || row.instCd || '기관명미상';
    const base = sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);
    const regDt = row.frstRegDt || '';

    // Resolve every subList item's actual file (same approach as full_scrape):
    // dedup attachment records by fileId::fileSn, then dedup by content hash.
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
          return { fileInfo: { fileName: detail.fileName }, bodyBuf, hash };
        })());
      }
      return seenAttachment.get(attKey);
    })));

    const rowFiles = [];
    for (const r of orderedResults) {
      if (r && !rowFiles.some((x) => x.hash === r.hash)) rowFiles.push(r);
    }
    if (rowFiles.length === 0) {
      log(`SKIP (no attachment): ${base} | ${regDt}`);
      return 0;
    }

    let newHere = 0;
    for (const resolved of rowFiles) {
      const contentKey = resolved.hash;
      const group = nameRegistry[base];
      if (group && group.some((g) => g.contentKey === contentKey)) {
        continue; // byte-identical content already collected -> nothing to do
      }
      const finalName = integrateNewDoc(base, contentKey, regDt);
      const srcExt = (resolved.fileInfo.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
      const savedAs = saveMaybeSplit(OUT_DIR, finalName, srcExt, resolved.bodyBuf);
      cp.totalFiles++;
      newHere++;
      log(`SAVED (incremental): ${savedAs} (${resolved.bodyBuf.length}B) <- ${instNm} | ${row.adYr}년 ${row.adFldNm} | ${regDt}`);
    }
    return newHere;
  }

  let page = 0;
  let reachedBelow = false;
  let totalElements = null;
  let newFiles = 0;
  let newReports = 0;
  let maxRegDt = watermark;

  while (true) {
    const params = new URLSearchParams({
      searchYmdBgng: SEARCH_BGNG, searchYmdEnd: SEARCH_END,
      instNm: '', palawInstClsfCd: '30',
      size: String(PAGE_SIZE), index: '0', page: String(page),
    });
    const search = await getJson('/api/fdadPlanRslt?' + params.toString());
    totalElements = search.page.totalElements;
    const rows = (search._embedded && search._embedded.fdadPlanRsltListDtoes) || [];
    if (rows.length === 0) {
      log(`Page ${page} empty. Stopping (totalElements=${totalElements}).`);
      break;
    }

    for (const row of rows) {
      const regDt = row.frstRegDt || '';
      if (regDt && regDt < watermark) { reachedBelow = true; continue; }
      if (regDt > maxRegDt) maxRegDt = regDt;
      const beforeFiles = cp.totalFiles;
      const added = await processRow(row);
      newFiles += added;
      if (added > 0) newReports++;
      void beforeFiles;
    }

    if (!DRY) {
      cp.nameRegistry = nameRegistry;
      cp.regDtWatermark = maxRegDt;
      saveCheckpoint(cp);
    }
    log(`Page ${page} scanned. New files so far this run: ${newFiles}.`);

    if (reachedBelow) break; // API is newest-first: everything past here is older
    page++;
    if (page * PAGE_SIZE >= totalElements) break;
  }

  cp.totalReports += newReports;
  if (!DRY) {
    cp.nameRegistry = nameRegistry;
    cp.regDtWatermark = maxRegDt;
    saveCheckpoint(cp);
  }
  log(`Incremental run done. New reports: ${newReports}, new files: ${newFiles}. ` +
    `New watermark: ${maxRegDt}. Totals: ${cp.totalReports} reports / ${cp.totalFiles} files.`);
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
