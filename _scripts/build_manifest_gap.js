// Phase 1 for the gap period 2023-12-31 ~ 2025-07-06, appended into 자체감사파일2.
// Seeds the base-name registry from the 2021~2023 pass (manifest_checkpoint.json)
// so numbering continues after the files already in the folder, and duplicate
// content (same base + fileName + fileSize) already collected is skipped.
// Outputs:
//   manifest3.json  — NEW entries only (to merge into manifest2.json)
//   renames3.json   — existing unnumbered files that must become "(1)" because
//                     the gap pass added more entries under the same base name
process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const YMD_BGNG = '20231231';
const YMD_END = '20250706';
const PAGE_SIZE = 100;
const SEED_FILE = path.join(__dirname, 'manifest_checkpoint.json');
const CHECKPOINT_FILE = path.join(__dirname, 'manifest_checkpoint3.json');
const MANIFEST_FILE = path.join(__dirname, 'manifest3.json');
const RENAMES_FILE = path.join(__dirname, 'renames3.json');
const LOG_FILE = path.join(__dirname, 'progress3.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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

function extOf(fileName) {
  return (String(fileName).match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
}

async function getJson(pathStr, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await proxyRequest('www.pap.go.kr', pathStr, { headers: { Accept: 'application/hal+json' } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(r.body.toString());
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  // Fresh start: seed from the finished 2021~2023 registry and remember each
  // base's seeded length so finalize can tell old entries from new ones.
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const groups = seed.groups || {};
  const seedLens = {};
  for (const [base, group] of Object.entries(groups)) seedLens[base] = group.length;
  return { nextPage: 0, groups, seedLens, totalReports: 0 };
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
  const cp = loadCheckpoint();
  log(`Gap manifest pass resuming from page ${cp.nextPage}. Reports so far: ${cp.totalReports}`);
  const instCdLookup = await buildInstCdLookup();
  const groups = cp.groups;
  const seedLens = cp.seedLens;

  let page = cp.nextPage;
  while (true) {
    const params = new URLSearchParams({
      searchYmdBgng: YMD_BGNG, searchYmdEnd: YMD_END,
      instNm: '', palawInstClsfCd: '30',
      size: String(PAGE_SIZE), index: '0', page: String(page),
    });
    const search = await getJson('/api/fdadPlanRslt?' + params.toString());
    const totalElements = search.page.totalElements;
    const rows = (search._embedded && search._embedded.fdadPlanRsltListDtoes) || [];
    if (rows.length === 0) { log(`Page ${page} empty. Stopping (totalElements=${totalElements}).`); break; }

    const limit = pLimit(40);
    for (const row of rows) {
      const instNm = row.instCdNm || instCdLookup.get(row.instCd) || row.instCd || '기관명미상';
      const base = sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);
      const details = await Promise.all((row.subList || []).map((sub) => limit(async () => {
        if (!sub.rlsDocAtchFileUuid) return null;
        const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
        const d = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
        if (!d) return null;
        return { fileId: d.fileId, fileSn: d.fileSn, fileName: d.fileName, fileSize: d.fileSize };
      })));
      const rowFiles = [];
      const seen = new Set();
      for (const d of details) {
        if (!d) continue;
        const attKey = `${d.fileId}::${d.fileSn}`;
        const contentKey = `${d.fileName}::${d.fileSize}`;
        if (seen.has(attKey) || seen.has(contentKey)) continue;
        seen.add(attKey); seen.add(contentKey);
        rowFiles.push(d);
      }
      if (!groups[base]) { groups[base] = []; seedLens[base] = seedLens[base] || 0; }
      const group = groups[base];
      let added = 0;
      for (const d of rowFiles) {
        const key = `${d.fileName}::${d.fileSize}`;
        if (group.some((g) => g.key === key)) continue;
        group.push({ key, fileId: d.fileId, fileSn: d.fileSn, fileName: d.fileName, fileSize: d.fileSize, regDt: row.frstRegDt });
        added++;
      }
      cp.totalReports++;
      if (added > 0) log(`Meta: ${base} | +${added} (group=${group.length}, seeded=${seedLens[base] || 0})`);
    }

    cp.nextPage = page + 1;
    cp.groups = groups;
    cp.seedLens = seedLens;
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
    log(`Page ${page} done. Reports: ${cp.totalReports}/${totalElements}`);
    page++;
    if (page * PAGE_SIZE >= totalElements) { log(`All ${totalElements} rows enumerated.`); break; }
  }

  const manifest = [];
  const renames = [];
  for (const [base, group] of Object.entries(groups)) {
    const seedLen = seedLens[base] || 0;
    if (group.length <= seedLen) continue; // nothing new under this base
    if (seedLen === 1 && group.length > 1) {
      // Existing file was saved without a number; it must become "(1)".
      renames.push({ from: `${base}${extOf(group[0].fileName)}`, to: `${base}(1)${extOf(group[0].fileName)}`, manifestName: base, newManifestName: `${base}(1)` });
    }
    for (let i = seedLen; i < group.length; i++) {
      const g = group[i];
      const finalName = group.length > 1 ? `${base}(${i + 1})` : base;
      manifest.push({ name: finalName, ext: extOf(g.fileName), fileId: g.fileId, fileSn: g.fileSn, fileSize: g.fileSize });
    }
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 1));
  fs.writeFileSync(RENAMES_FILE, JSON.stringify(renames, null, 1));
  const totalBytes = manifest.reduce((a, m) => a + (m.fileSize || 0), 0);
  log(`GAP MANIFEST DONE: ${manifest.length} new files, ~${(totalBytes / 1e9).toFixed(2)} GB expected, ${renames.length} renames of existing files`);
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
