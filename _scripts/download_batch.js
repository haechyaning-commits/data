// Phase 2 for the 2021-01-01 ~ 2023-12-30 collection: downloads the next slice
// of manifest2.json into the output dir, stopping once the batch byte budget is
// reached so the orchestrator can commit/push/free-disk between batches.
// Progress is tracked in done2.log (one manifest name per line), which is
// committed alongside each batch so a lost container can resume from GitHub.
process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.argv[2] || '/home/user/data/자체감사파일2';
const BATCH_BYTES = Number(process.argv[3] || 1300000000);
const MANIFEST_FILE = path.join(__dirname, 'manifest2.json');
const DONE_FILE = path.join(__dirname, 'done2.log');
const REMAINING_FILE = path.join(__dirname, 'remaining2.txt');
const LOG_FILE = path.join(__dirname, 'progress2.log');
const MAX_CHUNK_BYTES = 90 * 1024 * 1024;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function saveMaybeSplit(finalName, ext, buf) {
  if (buf.length <= MAX_CHUNK_BYTES) {
    fs.writeFileSync(path.join(OUT_DIR, `${finalName}${ext}`), buf);
    return `${finalName}${ext}`;
  }
  const parts = Math.ceil(buf.length / MAX_CHUNK_BYTES);
  const names = [];
  for (let i = 0; i < parts; i++) {
    const chunk = buf.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    const name = `${finalName}_조각(${i + 1})${ext}.part`;
    fs.writeFileSync(path.join(OUT_DIR, name), chunk);
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

async function postDownload(fileId, fileSn, retries = 4) {
  const body = JSON.stringify({ fileId, fileSn });
  for (let i = 0; i < retries; i++) {
    try {
      const r = await proxyRequest('www.pap.go.kr', '/api/files/download', {
        method: 'POST',
        headers: { Accept: 'application/hal+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
        timeoutMs: 180000,
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const done = new Set(fs.existsSync(DONE_FILE) ? fs.readFileSync(DONE_FILE, 'utf8').split('\n').filter(Boolean) : []);
  const todo = manifest.filter((m) => !done.has(m.name));
  log(`Batch start: ${todo.length} files remaining of ${manifest.length}, budget ${(BATCH_BYTES / 1e9).toFixed(2)} GB`);

  // Select this batch by expected size, then download with bounded concurrency.
  const batch = [];
  let planned = 0;
  for (const m of todo) {
    batch.push(m);
    planned += m.fileSize || 5 * 1024 * 1024;
    if (planned >= BATCH_BYTES) break;
  }

  const limit = pLimit(8);
  let failures = 0;
  await Promise.all(batch.map((m) => limit(async () => {
    try {
      const buf = await postDownload(m.fileId, m.fileSn);
      const savedAs = saveMaybeSplit(m.name, m.ext, buf);
      fs.appendFileSync(DONE_FILE, m.name + '\n');
      log(`SAVED: ${savedAs} (${buf.length}B)`);
    } catch (e) {
      failures++;
      log(`FAIL: ${m.name} :: ${e.message}`);
    }
  })));

  const remaining = todo.length - batch.length + failures;
  fs.writeFileSync(REMAINING_FILE, String(remaining));
  log(`Batch done: ${batch.length - failures} saved, ${failures} failed, ${remaining} remaining.`);
  // Failures stay out of done2.log and are retried on the next batch; if a file
  // fails persistently the orchestrator's stall guard stops the loop.
  if (failures > 0 && batch.length === failures) process.exit(2); // no progress at all
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
