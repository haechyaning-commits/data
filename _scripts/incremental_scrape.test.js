// Standalone test of the incremental renumber + on-disk rename algorithm.
// Replicates renameOnDisk + integrateNewDoc verbatim from incremental_scrape.js
// and asserts filenames end up correct across the tricky cases.
const fs = require('fs');
const path = require('path');

const OUT_DIR = fs.mkdtempSync('/tmp/renum-');
let DRY = false;
function log(m) { /* quiet */ }

function renameOnDisk(outDir, oldFinal, newFinal) {
  if (oldFinal === newFinal) return;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.startsWith(oldFinal)) continue;
    const rest = f.slice(oldFinal.length);
    const isPlain = rest.startsWith('.');
    const isChunk = rest.startsWith('_조각(');
    if (!isPlain && !isChunk) continue;
    const target = newFinal + rest;
    fs.renameSync(path.join(outDir, f), path.join(outDir, target));
  }
}

function makeIntegrator(nameRegistry) {
  const runInsertPos = new Map();
  return function integrateNewDoc(base, contentKey, regDt) {
    const group = nameRegistry[base] || (nameRegistry[base] = []);
    const oldFinals = group.map((g) => g.finalName);
    const pos = runInsertPos.get(base) || 0;
    group.splice(pos, 0, { contentKey, regDt });
    runInsertPos.set(base, pos + 1);
    const numbered = group.length > 1;
    const newFinals = group.map((g, i) => (numbered ? `${base}(${i + 1})` : base));
    for (let j = oldFinals.length - 1; j >= 0; j--) {
      const newIndex = j >= pos ? j + 1 : j;
      renameOnDisk(OUT_DIR, oldFinals[j], newFinals[newIndex]);
    }
    group.forEach((g, i) => { g.finalName = newFinals[i]; });
    return newFinals[pos];
  };
}

function touch(name) { fs.writeFileSync(path.join(OUT_DIR, name), name); }
function ls() { return fs.readdirSync(OUT_DIR).sort(); }
function clean() { for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f)); }

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok: ${msg}`); }
  else { fail++; console.log(`  FAIL: ${msg}\n     expected ${e}\n     actual   ${a}`); }
}

// --- Case 1: existing single unnumbered file gets one new (newer) doc ---
{
  clean();
  const base = '기관A_2025년 종합감사';
  const reg = { [base]: [{ contentKey: 'old', finalName: base }] };
  touch(`${base}.pdf`);
  const integ = makeIntegrator(reg);
  const fn = integ(base, 'new1', '2026-07-10');
  const savedExt = '.hwp';
  touch(`${fn}${savedExt}`);
  eq(ls(), [`${base}(1).hwp`, `${base}(2).pdf`], 'C1: new doc -> (1), old -> (2)');
  eq(reg[base].map(g => g.finalName), [`${base}(1)`, `${base}(2)`], 'C1: registry order');
}

// --- Case 2: existing numbered group (3) gets one new doc -> shift all +1 ---
{
  clean();
  const base = '기관B_2025년 특정감사';
  const reg = { [base]: [
    { contentKey: 'a', finalName: `${base}(1)` },
    { contentKey: 'b', finalName: `${base}(2)` },
    { contentKey: 'c', finalName: `${base}(3)` },
  ] };
  touch(`${base}(1).pdf`); touch(`${base}(2).pdf`); touch(`${base}(3).hwp`);
  const integ = makeIntegrator(reg);
  const fn = integ(base, 'new1', '2026-07-11');
  touch(`${fn}.pdf`);
  eq(ls(), [`${base}(1).pdf`, `${base}(2).pdf`, `${base}(3).pdf`, `${base}(4).hwp`],
    'C2: new (1); a->(2) b->(3) c->(4)');
  eq(reg[base].map(g => g.contentKey), ['new1', 'a', 'b', 'c'], 'C2: registry order newest-first');
}

// --- Case 3: prefix hazard (1) vs (10) must not cross-rename ---
{
  clean();
  const base = '기관C_2025년 복무감사';
  const reg = { [base]: [] };
  for (let i = 1; i <= 10; i++) reg[base].push({ contentKey: 'x' + i, finalName: `${base}(${i})` });
  for (let i = 1; i <= 10; i++) touch(`${base}(${i}).pdf`);
  const integ = makeIntegrator(reg);
  const fn = integ(base, 'newX', '2026-07-12');
  touch(`${fn}.pdf`);
  const expect = [];
  for (let i = 1; i <= 11; i++) expect.push(`${base}(${i}).pdf`);
  eq(ls(), expect.sort(), 'C3: 10->11 shift, no (1)/(10) collision');
  eq(reg[base].map(g => g.contentKey)[0], 'newX', 'C3: new doc at front');
}

// --- Case 4: two new docs in same run+group (arriving newest-first) ---
{
  clean();
  const base = '기관D_2025년 재무감사';
  const reg = { [base]: [{ contentKey: 'old', finalName: base }] };
  touch(`${base}.pdf`);
  const integ = makeIntegrator(reg);
  const f1 = integ(base, 'newer', '2026-07-13'); touch(`${f1}.pdf`);   // arrives first (newest)
  const f2 = integ(base, 'older', '2026-07-13'); touch(`${f2}.pdf`);   // arrives second
  eq(reg[base].map(g => g.contentKey), ['newer', 'older', 'old'], 'C4: newest-first order preserved');
  eq(ls(), [`${base}(1).pdf`, `${base}(2).pdf`, `${base}(3).pdf`], 'C4: files (1)(2)(3)');
  eq([f1, f2], [`${base}(1)`, `${base}(2)`], 'C4: first arrival -> (1)');
}

// --- Case 5: split (_조각) files get renamed as a unit ---
{
  clean();
  const base = '기관E_2026년 특정감사';
  const reg = { [base]: [{ contentKey: 'big', finalName: base }] };
  touch(`${base}_조각(1).hwpx.part`); touch(`${base}_조각(2).hwpx.part`);
  const integ = makeIntegrator(reg);
  const fn = integ(base, 'new1', '2026-07-14'); touch(`${fn}.pdf`);
  eq(ls(), [`${base}(1).pdf`, `${base}(2)_조각(1).hwpx.part`, `${base}(2)_조각(2).hwpx.part`],
    'C5: split chunks shifted to (2) together');
}

// --- Case 6: duplicate content is a no-op (handled by caller, but verify order stable) ---
{
  clean();
  const base = '기관F_2025년 성과감사';
  const reg = { [base]: [
    { contentKey: 'a', finalName: `${base}(1)` },
    { contentKey: 'b', finalName: `${base}(2)` },
  ] };
  touch(`${base}(1).pdf`); touch(`${base}(2).pdf`);
  // caller would skip integrate when contentKey already present; simulate no call
  eq(reg[base].map(g => g.finalName), [`${base}(1)`, `${base}(2)`], 'C6: unchanged when dup');
  eq(ls(), [`${base}(1).pdf`, `${base}(2).pdf`], 'C6: files unchanged');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
