// Phase 1 for the 2021-01-01 ~ 2023-12-30 collection (output: 자체감사파일2).
// Enumerates every report row and resolves each 조치사항 attachment's metadata
// (fileId/fileSn/fileName/fileSize) WITHOUT downloading bodies, so that final
// file names — including (1),(2)... numbering — can be assigned once, up front.
// This avoids the on-disk rename dance in full_scrape.js, which breaks when
// earlier batch files have already been committed and dropped from the worktree.
process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const YMD_BGNG = '20210101';
const YMD_END = '20231230';
const PAGE_SIZE = 100;
const CHECKPOINT_FILE = path.join(__dirname, 'manifest_checkpoint.json');
const MANIFEST_FILE = path.join(__dirname, 'manifest2.json');
const LOG_FILE = path.join(__dirname, 'progress2.log');

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
  return { nextPage: 0, groups: {}, totalReports: 0 };
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
  log(`Manifest pass resuming from page ${cp.nextPage}. Reports so far: ${cp.totalReports}`);
  const instCdLookup = await buildInstCdLookup();
  // groups: base -> [{ key, fileId, fileSn, fileName, fileSize, regDt }]
  // key = fileName::fileSize (same rule as the v1 collection: identical
  // name+size under the same base is treated as the same document and kept once).
  const groups = cp.groups;

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

    // Resolve every row's attachment metadata in parallel (bounded globally),
    // then register into name groups strictly in row order so that (1),(2)...
    // numbering stays deterministic regardless of network completion order.
    const limit = pLimit(40);
    const resolvedRows = await Promise.all(rows.map(async (row) => {
      const details = await Promise.all((row.subList || []).map((sub) => limit(async () => {
        if (!sub.rlsDocAtchFileUuid) return null;
        const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
        const d = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
        if (!d) return null;
        return { fileId: d.fileId, fileSn: d.fileSn, fileName: d.fileName, fileSize: d.fileSize };
      })));
      return { row, details };
    }));
    for (const { row, details } of resolvedRows) {
      const instNm = row.instCdNm || instCdLookup.get(row.instCd) || row.instCd || '기관명미상';
      const base = sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);
      // Within-row dedup: same attachment record (fileId::fileSn) or same
      // fileName+fileSize means the same document shared by multiple 조치사항.
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
      if (!groups[base]) groups[base] = [];
      const group = groups[base];
      let added = 0;
      for (const d of rowFiles) {
        const key = `${d.fileName}::${d.fileSize}`;
        if (group.some((g) => g.key === key)) continue; // duplicate content under same base
        group.push({ key, fileId: d.fileId, fileSn: d.fileSn, fileName: d.fileName, fileSize: d.fileSize, regDt: row.frstRegDt });
        added++;
      }
      cp.totalReports++;
      log(`Meta: ${base} | 조치사항 ${(row.subList || []).length} | distinct files +${added} (group=${group.length})`);
    }

    cp.nextPage = page + 1;
    cp.groups = groups;
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
    log(`Page ${page} done. Reports: ${cp.totalReports}/${totalElements}`);
    page++;
    if (page * PAGE_SIZE >= totalElements) { log(`All ${totalElements} rows enumerated.`); break; }
  }

  // Finalize names: single-entry groups get no number; multi-entry groups get (1),(2)...
  // in enumeration order (API returns newest-registered first, matching the v1 convention).
  const manifest = [];
  for (const [base, group] of Object.entries(groups)) {
    group.forEach((g, i) => {
      const finalName = group.length > 1 ? `${base}(${i + 1})` : base;
      const ext = (g.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
      manifest.push({ name: finalName, ext, fileId: g.fileId, fileSn: g.fileSn, fileSize: g.fileSize });
    });
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 1));
  const totalBytes = manifest.reduce((a, m) => a + (m.fileSize || 0), 0);
  log(`MANIFEST DONE: ${manifest.length} files, ~${(totalBytes / 1e9).toFixed(2)} GB expected`);
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
