process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_DIR = process.argv[2] || '/home/user/data/자체감사결과';
const PAGE_SIZE = 10;
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');
const LOG_FILE = path.join(__dirname, 'progress.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // GitHub hard limit is 100MB; leave margin

function saveMaybeSplit(outDir, finalName, ext, buf) {
  if (buf.length <= MAX_CHUNK_BYTES) {
    fs.writeFileSync(path.join(outDir, `${finalName}${ext}`), buf);
    return `${finalName}${ext}`;
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
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cp = loadCheckpoint();
  log(`Resuming from page ${cp.nextPage}. Reports so far: ${cp.totalReports}, files so far: ${cp.totalFiles}`);

  // nameRegistry: base -> array of { contentKey, finalName }  (contentKey = fileName::fileSize or NOFILE::uuid)
  const nameRegistry = cp.nameRegistry;

  let page = cp.nextPage;
  let totalElements = null;

  while (true) {
    const params = new URLSearchParams({
      searchYmdBgng: '20250707', searchYmdEnd: '20260707',
      instNm: '', palawInstClsfCd: '30',
      size: String(PAGE_SIZE), index: '0', page: String(page),
    });
    const search = await getJson('/api/fdadPlanRslt?' + params.toString());
    totalElements = search.page.totalElements;
    const rows = search._embedded.fdadPlanRsltListDtoes;
    if (!rows || rows.length === 0) {
      log(`Page ${page} empty. Stopping (totalElements=${totalElements}).`);
      break;
    }

    for (const row of rows) {
      const base = sanitize(`${row.instCdNm}_${row.adYr}년 ${row.adFldNm}`);
      log(`Checking: ${base} | 조치사항 ${row.subList ? row.subList.length : 0}건...`);
      // Resolve every subList item's actual file — never assume, always check.
      // Pre-dedup by fileId+fileSn (same attachment record => definitely identical
      // bytes, safe to skip re-downloading), but the FINAL identity used for naming
      // is the actual content hash, since two different attachment records can
      // legitimately contain byte-identical content under different fileName metadata.
      const seenAttachment = new Map(); // fileId::fileSn -> { fileInfo, bodyBuf, hash }
      const rowFiles = []; // ordered list of { fileInfo, bodyBuf, hash } | null
      for (const sub of row.subList || []) {
        if (!sub.rlsDocAtchFileUuid) continue;
        const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
        const detail = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
        if (!detail) continue;
        const attKey = `${detail.fileId}::${detail.fileSn}`;
        let resolved = seenAttachment.get(attKey);
        if (!resolved) {
          const bodyBuf = await postDownload(detail.fileId, detail.fileSn);
          const hash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
          resolved = { fileInfo: { fileId: detail.fileId, fileSn: detail.fileSn, fileName: detail.fileName, fileSize: detail.fileSize }, bodyBuf, hash };
          seenAttachment.set(attKey, resolved);
        }
        if (!rowFiles.some((r) => r && r.hash === resolved.hash)) rowFiles.push(resolved);
      }
      let distinctFiles = rowFiles;
      if (distinctFiles.length === 0) distinctFiles = [null];

      if (!nameRegistry[base]) nameRegistry[base] = [];
      for (const resolved of distinctFiles) {
        const contentKey = resolved ? resolved.hash : `NOFILE::${row.fdadPlanUuid}`;
        const group = nameRegistry[base];
        const existing = group.find((g) => g.contentKey === contentKey);
        if (existing) {
          // Truly duplicate content (byte-identical) already saved under this base name.
          continue;
        }
        group.push({ contentKey, order: group.length });
        const needsNumbering = group.length > 1;
        // Renumber all entries in this base group deterministically by their order.
        for (let i = 0; i < group.length; i++) {
          group[i].finalName = needsNumbering ? `${base}(${i + 1})` : base;
        }
        const finalName = group[group.length - 1].finalName;
        // If renumbering just flipped a single-entry group into a numbered one, rename its file(s) on disk.
        if (needsNumbering && group.length === 2) {
          const oldBase = base;
          for (const f of fs.readdirSync(OUT_DIR)) {
            const isChunk = f.startsWith(`${oldBase}_조각(`);
            const ext = path.extname(f);
            const stem = f.slice(0, -ext.length);
            const isPlainMatch = stem === oldBase;
            if (isChunk) {
              fs.renameSync(path.join(OUT_DIR, f), path.join(OUT_DIR, f.replace(oldBase, `${oldBase}(1)`)));
            } else if (isPlainMatch) {
              fs.renameSync(path.join(OUT_DIR, f), path.join(OUT_DIR, `${oldBase}(1)${ext}`));
            }
          }
        }

        if (!resolved) {
          log(`SKIP (no attachment): ${finalName} <- ${row.instCdNm} | ${row.adYr}년 ${row.adFldNm} | ${row.frstRegDt}`);
          continue;
        }
        const srcExt = (resolved.fileInfo.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
        const savedAs = saveMaybeSplit(OUT_DIR, finalName, srcExt, resolved.bodyBuf);
        cp.totalFiles++;
        log(`SAVED: ${savedAs} (${resolved.bodyBuf.length}B) <- ${row.instCdNm} | ${row.adYr}년 ${row.adFldNm} | ${row.frstRegDt}`);
      }
      cp.totalReports++;
    }

    cp.nextPage = page + 1;
    cp.nameRegistry = nameRegistry;
    saveCheckpoint(cp);
    log(`Page ${page} done. Reports so far: ${cp.totalReports}/${totalElements}. Files so far: ${cp.totalFiles}.`);

    page++;
    if (page * PAGE_SIZE >= totalElements) {
      log(`All pages processed. Total reports: ${cp.totalReports}, total files: ${cp.totalFiles}, totalElements=${totalElements}`);
      break;
    }
  }
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
