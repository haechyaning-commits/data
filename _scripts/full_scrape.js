process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.argv[2] || '/home/user/data/자체감사결과';
const PAGE_SIZE = 10;
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');
const LOG_FILE = path.join(__dirname, 'progress.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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
      // Resolve every subList item's actual file — never assume, always check.
      const seenInRow = new Map();
      for (const sub of row.subList || []) {
        if (!sub.rlsDocAtchFileUuid) continue;
        const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
        const detail = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
        if (!detail) continue;
        const key = `${detail.fileName}::${detail.fileSize}`;
        if (!seenInRow.has(key)) {
          seenInRow.set(key, { fileId: detail.fileId, fileSn: detail.fileSn, fileName: detail.fileName, fileSize: detail.fileSize });
        }
      }
      let distinctFiles = [...seenInRow.values()];
      if (distinctFiles.length === 0) distinctFiles = [null];

      if (!nameRegistry[base]) nameRegistry[base] = [];
      for (const fileInfo of distinctFiles) {
        const contentKey = fileInfo ? `${fileInfo.fileName}::${fileInfo.fileSize}` : `NOFILE::${row.fdadPlanUuid}`;
        const group = nameRegistry[base];
        const existing = group.find((g) => g.contentKey === contentKey);
        if (existing) {
          // Truly duplicate content already saved under this base name — reuse, no new download.
          continue;
        }
        group.push({ contentKey, order: group.length });
        const needsNumbering = group.length > 1;
        // Renumber all entries in this base group deterministically by their order.
        for (let i = 0; i < group.length; i++) {
          group[i].finalName = needsNumbering ? `${base}(${i + 1})` : base;
        }
        const finalName = group[group.length - 1].finalName;
        // If renumbering just flipped a single-entry group into a numbered one, rename its file on disk.
        if (needsNumbering && group.length === 2) {
          // find old single file (no suffix) and rename it to (1)
          const oldBase = base;
          const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(oldBase) && !f.match(/\(\d+\)/));
          for (const f of files) {
            const ext = path.extname(f);
            const stem = f.slice(0, -ext.length);
            if (stem === oldBase) {
              fs.renameSync(path.join(OUT_DIR, f), path.join(OUT_DIR, `${oldBase}(1)${ext}`));
            }
          }
        }

        if (!fileInfo) {
          log(`SKIP (no attachment): ${finalName} <- ${row.instCdNm} | ${row.adYr}년 ${row.adFldNm} | ${row.frstRegDt}`);
          continue;
        }
        const bodyBuf = await postDownload(fileInfo.fileId, fileInfo.fileSn);
        const srcExt = (fileInfo.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
        const outPath = path.join(OUT_DIR, `${finalName}${srcExt}`);
        fs.writeFileSync(outPath, bodyBuf);
        cp.totalFiles++;
        log(`SAVED: ${finalName}${srcExt} (${bodyBuf.length}B) <- ${row.instCdNm} | ${row.adYr}년 ${row.adFldNm} | ${row.frstRegDt}`);
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
