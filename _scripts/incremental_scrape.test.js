// Tests for the incremental renumber + on-disk rename logic.
// Imports the real functions from incremental_scrape.js (no network involved).
const fs = require('fs');
const path = require('path');
const { computeRenumberPlan, renameStem } = require('./incremental_scrape.js');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok: ${msg}`); }
  else { fail++; console.log(`  FAIL: ${msg}\n     expected ${e}\n     actual   ${a}`); }
}

// ---------- computeRenumberPlan ----------

// C1: single unnumbered existing file + 1 new doc -> new (1), old (2)
{
  const base = '기관A_2025년 종합감사';
  const p = computeRenumberPlan(base, [base], 1);
  eq(p.newDocFinals, [`${base}(1)`], 'C1: new doc -> (1)');
  eq(p.existingRenames, [[base, `${base}(2)`]], 'C1: old unnumbered -> (2)');
  eq(p.allFinals, [`${base}(1)`, `${base}(2)`], 'C1: full order');
}

// C2: numbered group of 3 + 1 new -> shift all +1
{
  const base = '기관B_2025년 특정감사';
  const ex = [`${base}(1)`, `${base}(2)`, `${base}(3)`];
  const p = computeRenumberPlan(base, ex, 1);
  eq(p.newDocFinals, [`${base}(1)`], 'C2: new -> (1)');
  eq(p.existingRenames, [[`${base}(1)`, `${base}(2)`], [`${base}(2)`, `${base}(3)`], [`${base}(3)`, `${base}(4)`]], 'C2: 1->2,2->3,3->4');
}

// C3: batch — 2 new docs into a group of 2 at once -> existing shift +2
{
  const base = '기관C_2025년 복무감사';
  const ex = [`${base}(1)`, `${base}(2)`];
  const p = computeRenumberPlan(base, ex, 2);
  eq(p.newDocFinals, [`${base}(1)`, `${base}(2)`], 'C3: two new -> (1),(2)');
  eq(p.existingRenames, [[`${base}(1)`, `${base}(3)`], [`${base}(2)`, `${base}(4)`]], 'C3: existing shift +2');
}

// C4: brand-new group (no existing) -> no renames
{
  const base = '기관D_2026년 재무감사';
  const p1 = computeRenumberPlan(base, [], 1);
  eq(p1.newDocFinals, [base], 'C4a: lone new doc unnumbered');
  eq(p1.existingRenames, [], 'C4a: no renames');
  const p2 = computeRenumberPlan(base, [], 3);
  eq(p2.newDocFinals, [`${base}(1)`, `${base}(2)`, `${base}(3)`], 'C4b: 3 new -> numbered');
}

// ---------- renameStem (real files in a temp dir) ----------
const DIR = fs.mkdtempSync('/tmp/renum-');
function touch(n) { fs.writeFileSync(path.join(DIR, n), n); }
function clean() { for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f)); }
function ls() { return fs.readdirSync(DIR).sort(); }

// C5: (1)/(10) prefix hazard — renaming (1) must not touch (10)
{
  clean();
  touch('기관E_2025년 특정감사(1).pdf');
  touch('기관E_2025년 특정감사(10).pdf');
  const snap = fs.readdirSync(DIR);
  const done = renameStem(DIR, '기관E_2025년 특정감사(1)', '기관E_2025년 특정감사(2)', snap, false);
  eq(done.length, 1, 'C5: only one file renamed');
  eq(ls(), ['기관E_2025년 특정감사(10).pdf', '기관E_2025년 특정감사(2).pdf'], 'C5: (1)->(2), (10) untouched');
}

// C6: split _조각 chunks move together; unnumbered stem must NOT grab numbered sibling
{
  clean();
  touch('기관F_2026년 특정감사_조각(1).hwpx.part');
  touch('기관F_2026년 특정감사_조각(2).hwpx.part');
  touch('기관F_2026년 특정감사(5).pdf');
  const snap = fs.readdirSync(DIR);
  renameStem(DIR, '기관F_2026년 특정감사', '기관F_2026년 특정감사(3)', snap, false);
  eq(ls(), [
    '기관F_2026년 특정감사(3)_조각(1).hwpx.part',
    '기관F_2026년 특정감사(3)_조각(2).hwpx.part',
    '기관F_2026년 특정감사(5).pdf',
  ], 'C6: split chunks shifted, numbered sibling untouched');
}

// C7: end-to-end apply — group of 3 + 2 new, high->low, single snapshot
{
  clean();
  const base = '기관G_2025년 종합감사';
  ['(1).pdf', '(2).hwp', '(3).pdf'].forEach((s) => touch(base + s));
  const ex = [`${base}(1)`, `${base}(2)`, `${base}(3)`];
  const { newDocFinals, existingRenames } = computeRenumberPlan(base, ex, 2);
  const snap = fs.readdirSync(DIR);
  for (let k = existingRenames.length - 1; k >= 0; k--) {
    renameStem(DIR, existingRenames[k][0], existingRenames[k][1], snap, false);
  }
  newDocFinals.forEach((fn) => touch(`${fn}.pdf`));
  eq(ls(), [
    `${base}(1).pdf`, `${base}(2).pdf`,
    `${base}(3).pdf`, `${base}(4).hwp`, `${base}(5).pdf`,
  ].sort(), 'C7: batch apply keeps every file, no collision');
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
