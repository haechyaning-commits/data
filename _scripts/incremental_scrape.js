// 증분 수집 스크립트 (자체감사결과 최신화)
//
// full_scrape.js가 훑은 이후 포털에 "새로 등록/공개된" 자체감사결과 보고서만
// 골라 내려받아 자체감사결과/ 폴더에 이어 붙입니다. 이미 있는 파일은 건드리지
// 않는 append-only 방식이라 안전합니다.
//
// 사용법:
//   node incremental_scrape.js [OUT_DIR] [SINCE] [UNTIL] [--full]
//   - OUT_DIR : 저장 폴더 (기본 /home/user/data/자체감사결과)
//   - SINCE   : 시작일 YYYYMMDD (기본 20250707)
//   - UNTIL   : 종료일 YYYYMMDD (기본 오늘)
//   - --full  : 조기 종료 없이 기간 전체를 다시 훑음(정밀 점검용)
//
// 동작 원리:
//   포털 목록 API는 최신순이라 새 보고서가 앞 페이지에 옵니다. 페이지를 앞에서부터
//   훑으며, 각 첨부가 디스크에 "같은 이름·같은 크기"로 이미 있으면 건너뛰고, 없으면
//   내려받아 다음 번호로 저장합니다. 한 페이지가 통째로 "이미 있음"이면 (그 이후는
//   전부 수집된 구간이라 보고) 종료합니다. --full이면 끝까지 훑습니다.
//
//   * 중복 판정은 (기본이름 + 파일크기)로 합니다. 원본 full_scrape.js가 쓰는
//     SHA-256 내용 해시보다 느슨하지만, 기존 파일을 재다운로드/재계산하지 않기 위한
//     것이며 새 파일만 추가하는 데는 충분합니다. 정밀 재정렬이 필요하면 full_scrape.js를
//     쓰세요.

process.on('uncaughtException', (e) => { console.error('[ignored stray socket error]', e.message); });

const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/home/user/data/자체감사결과';
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SINCE = argv[1] || '20250707';
const today = new Date();
const UNTIL = argv[2] || `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
const FULL = process.argv.includes('--full');
const PAGE_SIZE = 10;
const MAX_CHUNK_BYTES = 90 * 1024 * 1024;
const LOG_FILE = path.join(__dirname, 'incremental.log');

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
      if (r.status === 204) return null; // 포털이 파일을 내주지 않음
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

async function buildInstCdLookup() {
  const map = new Map();
  try {
    const r = await getJson('/api/instCd?size=3000&palaw1InstClsfCd=30');
    for (const item of (r._embedded && r._embedded.instCdListDtoes) || []) map.set(item.instCd, item.instNm);
  } catch (e) { log('instCd lookup 실패(무시): ' + e.message); }
  return map;
}

// OUT_DIR의 파일명을 base -> [{name, num}] 로 인덱싱 (이름만 읽음, 빠름)
function indexExisting(outDir) {
  const map = new Map();
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  for (const f of files) {
    let name = f;
    if (name.endsWith('.part')) name = name.slice(0, -5);
    name = name.replace(/_조각\(\d+\)/, '');
    const extMatch = name.match(/\.[A-Za-z0-9]+$/);
    let stem = extMatch ? name.slice(0, -extMatch[0].length) : name;
    let num = 0;
    const numMatch = stem.match(/\((\d+)\)$/);
    if (numMatch) { num = parseInt(numMatch[1], 10); stem = stem.slice(0, numMatch[0].length * -1); }
    if (!map.has(stem)) map.set(stem, []);
    map.get(stem).push({ name: f, num });
  }
  return { map, files };
}

function saveMaybeSplit(outDir, finalName, ext, buf) {
  if (buf.length <= MAX_CHUNK_BYTES) {
    fs.writeFileSync(path.join(outDir, `${finalName}${ext}`), buf);
    return `${finalName}${ext}`;
  }
  const parts = Math.ceil(buf.length / MAX_CHUNK_BYTES);
  const names = [];
  for (let i = 0; i < parts; i++) {
    const chunk = buf.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    const nm = `${finalName}_조각(${i + 1})${ext}.part`;
    fs.writeFileSync(path.join(outDir, nm), chunk);
    names.push(nm);
  }
  return names.join(', ');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`증분 수집 시작 | 기간 ${SINCE}~${UNTIL} | OUT=${OUT_DIR} | full=${FULL}`);
  const instCdLookup = await buildInstCdLookup();
  const { map: existing } = indexExisting(OUT_DIR);
  log(`기존 파일 인덱스: base ${existing.size}개`);

  let page = 0, added = 0, skippedReports = 0, unavailable = 0, total = null;
  let allSeenStreak = 0; // 연속으로 "새 첨부 0" 인 페이지 수

  while (true) {
    const params = new URLSearchParams({
      searchYmdBgng: SINCE, searchYmdEnd: UNTIL, instNm: '', palawInstClsfCd: '30',
      size: String(PAGE_SIZE), index: '0', page: String(page),
    });
    const search = await getJson('/api/fdadPlanRslt?' + params.toString());
    total = search.page.totalElements;
    const rows = (search._embedded && search._embedded.fdadPlanRsltListDtoes) || [];
    if (rows.length === 0) { log(`page ${page} 비어있음. 종료 (total=${total}).`); break; }

    let pageNew = 0;
    for (const row of rows) {
      const instNm = row.instCdNm || instCdLookup.get(row.instCd) || row.instCd || '기관명미상';
      const base = sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);

      // 이 보고서의 첨부 목록 조회(다운로드 없이 메타만)
      const atts = [];
      for (const sub of row.subList || []) {
        if (!sub.rlsDocAtchFileUuid) continue;
        try {
          const fl = await getJson('/api/files/filelist/' + sub.rlsDocAtchFileUuid);
          const det = fl && fl._embedded && fl._embedded.commonFileDetailDtoes && fl._embedded.commonFileDetailDtoes[0];
          if (det) atts.push(det);
        } catch (e) { log(`filelist 실패: ${base} (${e.message})`); }
      }

      const group = existing.get(base) || [];
      let maxNum = group.reduce((m, g) => Math.max(m, g.num), group.length ? 1 : 0);

      for (const det of atts) {
        // 이미 있는가? base가 같은 기존 파일 중 같은 크기가 있으면 보유로 간주
        const already = group.some((g) => {
          try { return fs.statSync(path.join(OUT_DIR, g.name)).size === det.fileSize; }
          catch { return false; }
        });
        if (already) continue;

        const buf = await postDownload(det.fileId, det.fileSn);
        if (!buf) { unavailable++; log(`SKIP(204 미제공): ${base} <- ${det.fileName}`); continue; }

        // 번호 부여: 기존 최대 번호 다음. 기존이 번호 없는 1건뿐이면 새 파일은 (maxNum+1)이 되고
        // 기존 파일은 그대로 둡니다(비파괴적). base가 처음이면 번호 없이 저장.
        let finalName;
        if (group.length === 0 && maxNum === 0) { finalName = base; maxNum = 1; }
        else { maxNum = Math.max(maxNum, 1) + 1; finalName = `${base}(${maxNum})`; }
        const ext = (det.fileName.match(/\.[a-zA-Z0-9]+$/) || ['.pdf'])[0];
        const savedAs = saveMaybeSplit(OUT_DIR, finalName, ext, buf);
        group.push({ name: `${finalName}${ext}`, num: maxNum });
        existing.set(base, group);
        added++; pageNew++;
        log(`ADDED: ${savedAs} (${buf.length}B) <- ${instNm} | ${row.adYr}년 ${row.adFldNm} | 등록 ${row.frstRegDt}`);
      }
      if (atts.length && atts.every((det) => (existing.get(base) || []).some((g) => {
        try { return fs.statSync(path.join(OUT_DIR, g.name)).size === det.fileSize; } catch { return false; }
      }))) skippedReports++;
    }

    log(`page ${page} 완료 | 이 페이지 신규 ${pageNew}건 | 누적 신규 ${added}건 (total=${total})`);
    allSeenStreak = pageNew === 0 ? allSeenStreak + 1 : 0;
    if (!FULL && allSeenStreak >= 2) { log('연속 2페이지 신규 0건 → 이미 수집된 구간으로 보고 종료. (--full 로 전체 재검사 가능)'); break; }
    page++;
    if (page * PAGE_SIZE >= total) { log('마지막 페이지 도달. 종료.'); break; }
  }

  log(`완료: 신규 ${added}건 저장 | 미제공(204) ${unavailable}건 | 총 보고서 ${total}건`);
}

main().catch((e) => { log('FATAL: ' + e.stack); process.exit(1); });
