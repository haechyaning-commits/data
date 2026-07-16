#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""통합형 감사데이터 대시보드 생성기.
   감사지적_마스터인덱스.csv를 임베드해, 검색·집계 + 파일 목록(열기 링크)을
   한 페이지에서 제공하는 자기완결형 HTML(감사데이터_대시보드.html)을 만든다.
   파일 '열기' 링크는 저장소 루트 기준 상대경로(자체감사결과/…)라, 저장소를
   내려받아 이 HTML을 브라우저로 열면 원문 문서가 바로 열린다."""
import csv, os, json, html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV = os.path.join(ROOT, "감사지적_마스터인덱스.csv")
OUT = os.path.join(ROOT, "감사데이터_대시보드.html")
DISPO_ORDER = ["통보","개선","주의","시정","현지조치","회수","경고","권고","모범사례","징계","재심의","환수","문책","고발","변상"]


def load():
    rows = list(csv.DictReader(open(CSV, encoding="utf-8-sig")))
    data = []
    for r in rows:
        data.append([
            r["기관명"], r["연도"], r["감사분야"], r["순번"],
            r["지적제목"], r["처분키워드"], r["파일형식"], r["파일명"],
        ])
    return data


def build():
    data = load()
    orgs = sorted(set(d[0] for d in data if d[0]))
    years = sorted(set(d[1] for d in data if d[1]), reverse=True)
    fields = ["종합감사","특정감사","복무감사","성과감사","재무감사","자치_위임사무감사"]
    fields = [f for f in fields if any(d[2] == f for d in data)]
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    org_opts = "".join(f'<option value="{html.escape(o)}">{html.escape(o)}</option>' for o in orgs)
    year_opts = "".join(f'<option value="{y}">{y}</option>' for y in years)
    field_chips = "".join(
        f'<button class="chip" data-field="{f}">{f}</button>' for f in fields)
    dispo_chips = "".join(
        f'<button class="chip" data-dispo="{d}">{d}</button>' for d in DISPO_ORDER)

    page = f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>공공감사 자체감사결과 통합 대시보드</title>
<style>
  :root{{color-scheme:light;--plane:#f4f5f3;--surface:#fcfcfb;--surface-2:#f1f2ef;
    --ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--line:#d7d8d1;
    --accent:#2a6fbf;--accent-soft:#e4eefa;--track:#e6e7e1;
    --border:rgba(11,11,11,.10);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}}
  @media (prefers-color-scheme:dark){{:root:where(:not([data-theme="light"])){{
    color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;--surface-2:#232322;
    --ink:#fff;--ink2:#c3c2b7;--muted:#8f8e86;--grid:#2c2c2a;--line:#333;
    --accent:#3987e5;--accent-soft:#16314f;--track:#2c2c2a;
    --border:rgba(255,255,255,.12);}}}}
  :root[data-theme="dark"]{{color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;
    --surface-2:#232322;--ink:#fff;--ink2:#c3c2b7;--muted:#8f8e86;--grid:#2c2c2a;
    --line:#333;--accent:#3987e5;--accent-soft:#16314f;--track:#2c2c2a;
    --border:rgba(255,255,255,.12);}}
  *{{box-sizing:border-box;}}
  body{{margin:0;background:var(--plane);color:var(--ink);line-height:1.5;}}
  .wrap{{max-width:1120px;margin:0 auto;padding:24px 18px 64px;}}
  header h1{{font-size:1.4rem;margin:0 0 4px;letter-spacing:-.01em;}}
  header p{{color:var(--ink2);font-size:.88rem;margin:0;}}
  .tiles{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0;}}
  @media(max-width:640px){{.tiles{{grid-template-columns:repeat(2,1fr);}}}}
  .tile{{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:13px 15px;}}
  .tile .n{{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;}}
  .tile .l{{color:var(--ink2);font-size:.76rem;margin-top:1px;}}
  .panel{{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:16px;}}
  .filters{{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-end;}}
  .fgroup{{display:flex;flex-direction:column;gap:4px;}}
  .fgroup label{{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}}
  input[type=search],select{{font:inherit;font-size:.9rem;padding:8px 10px;border:1px solid var(--line);
    border-radius:9px;background:var(--surface-2);color:var(--ink);min-width:150px;}}
  input[type=search]{{min-width:230px;}}
  input:focus,select:focus,button:focus-visible{{outline:2px solid var(--accent);outline-offset:1px;}}
  .chips{{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;}}
  .chip{{font:inherit;font-size:.8rem;padding:4px 11px;border:1px solid var(--line);border-radius:20px;
    background:var(--surface-2);color:var(--ink2);cursor:pointer;transition:.12s;}}
  .chip:hover{{border-color:var(--accent);}}
  .chip[aria-pressed=true]{{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}}
  .chiprow{{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;}}
  .chiprow>div>span{{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-right:6px;}}
  .btnbar{{display:flex;gap:8px;align-items:center;margin-top:12px;}}
  .reset{{font:inherit;font-size:.82rem;padding:6px 12px;border:1px solid var(--line);border-radius:8px;
    background:var(--surface-2);color:var(--ink2);cursor:pointer;}}
  .reset:hover{{border-color:var(--accent);color:var(--ink);}}
  .aggwrap{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
  @media(max-width:720px){{.aggwrap{{grid-template-columns:1fr;}}}}
  .agg h3{{font-size:.82rem;margin:0 0 8px;color:var(--ink2);text-transform:uppercase;letter-spacing:.03em;}}
  .bars .row{{display:grid;grid-template-columns:96px 1fr 46px;align-items:center;gap:8px;padding:3px 0;font-size:.8rem;}}
  .bars .lab{{color:var(--ink2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
  .bars .track{{background:var(--track);border-radius:5px;height:14px;overflow:hidden;}}
  .bars .fill{{height:100%;border-radius:5px;background:var(--accent);}}
  .bars .val{{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;}}
  .resbar{{display:flex;justify-content:space-between;align-items:baseline;margin:4px 2px 10px;}}
  .resbar .count{{font-size:.95rem;font-weight:600;}}
  .resbar .count b{{color:var(--accent);font-variant-numeric:tabular-nums;}}
  .resbar .hint{{font-size:.78rem;color:var(--muted);}}
  .tblwrap{{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);}}
  table{{width:100%;border-collapse:collapse;font-size:.84rem;}}
  thead th{{position:sticky;top:0;background:var(--surface-2);color:var(--muted);font-weight:600;
    font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:9px 12px;
    border-bottom:1px solid var(--line);white-space:nowrap;}}
  tbody td{{padding:9px 12px;border-bottom:1px solid var(--grid);vertical-align:top;}}
  tbody tr:hover{{background:var(--accent-soft);}}
  td.org{{white-space:nowrap;font-weight:600;}}
  td.yr,td.fld{{white-space:nowrap;color:var(--ink2);}}
  td.title{{min-width:260px;}}
  .dtag{{display:inline-block;font-size:.7rem;background:var(--surface-2);color:var(--ink2);
    border:1px solid var(--line);padding:1px 7px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap;}}
  .ext{{font-size:.68rem;color:var(--muted);text-transform:uppercase;}}
  a.open{{color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap;}}
  a.open:hover{{text-decoration:underline;}}
  .empty{{padding:40px;text-align:center;color:var(--muted);}}
  .foot{{margin-top:22px;color:var(--muted);font-size:.76rem;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>공공감사 자체감사결과 통합 대시보드</h1>
    <p>공공감사포털(pap.go.kr) 자체감사결과 · 2025.7~2026.7 수집. 지적사항을 검색·집계하고, 필터된 원문 파일을 바로 엽니다.</p>
  </header>

  <div class="tiles">
    <div class="tile"><div class="n" id="t-files">0</div><div class="l">전체 파일</div></div>
    <div class="tile"><div class="n" id="t-orgs">0</div><div class="l">기관</div></div>
    <div class="tile"><div class="n" id="t-shown">0</div><div class="l">현재 결과</div></div>
    <div class="tile"><div class="n" id="t-shownorg">0</div><div class="l">결과 내 기관</div></div>
  </div>

  <div class="panel">
    <div class="filters">
      <div class="fgroup" style="flex:1 1 260px">
        <label for="q">검색 (기관·지적제목·파일명)</label>
        <input type="search" id="q" placeholder="예: 수의계약, 초과근무, 개인정보…" autocomplete="off">
      </div>
      <div class="fgroup">
        <label for="org">기관</label>
        <select id="org"><option value="">전체 기관</option>{org_opts}</select>
      </div>
      <div class="fgroup">
        <label for="year">연도</label>
        <select id="year"><option value="">전체 연도</option>{year_opts}</select>
      </div>
    </div>
    <div class="chiprow">
      <div><span>감사분야</span><div class="chips" id="fieldChips" style="display:inline-flex">{field_chips}</div></div>
    </div>
    <div class="chiprow">
      <div><span>처분유형</span><div class="chips" id="dispoChips" style="display:inline-flex">{dispo_chips}</div></div>
    </div>
    <div class="btnbar"><button class="reset" id="reset">필터 초기화</button></div>
  </div>

  <div class="panel">
    <div class="aggwrap">
      <div class="agg"><h3>감사분야 분포 (현재 결과)</h3><div class="bars" id="aggField"></div></div>
      <div class="agg"><h3>처분유형 분포 (현재 결과)</h3><div class="bars" id="aggDispo"></div></div>
    </div>
  </div>

  <div class="resbar">
    <div class="count"><b id="resN">0</b>건 결과</div>
    <div class="hint" id="resHint"></div>
  </div>
  <div class="tblwrap">
    <table>
      <thead><tr><th>기관</th><th>연도</th><th>분야</th><th>지적제목</th><th>처분</th><th>파일</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <div class="foot">
    파일 '열기'는 저장소 루트 기준 상대경로(<code>자체감사결과/…</code>)입니다. 저장소를 내려받아 이 HTML을 같은 위치에서 열면 원문이 바로 열립니다.
    성능을 위해 표는 최대 <span id="cap">400</span>건까지 표시하며, 그 이상은 필터로 좁혀 보세요.
  </div>
</div>

<script>
const DATA = {payload};
// [org,year,field,seq,title,dispo,ext,file]
const CAP = 400;
const $ = s => document.querySelector(s);
const state = {{q:"", org:"", year:"", fields:new Set(), dispos:new Set()}};

const uniqOrgs = new Set(DATA.map(d=>d[0]).filter(Boolean));
$("#t-files").textContent = DATA.length.toLocaleString();
$("#t-orgs").textContent = uniqOrgs.size.toLocaleString();
$("#cap").textContent = CAP;

function matches(d){{
  if(state.org && d[0]!==state.org) return false;
  if(state.year && d[1]!==state.year) return false;
  if(state.fields.size && !state.fields.has(d[2])) return false;
  if(state.dispos.size){{
    const dp = d[5]?d[5].split(";"):[];
    let ok=false; for(const x of state.dispos) if(dp.includes(x)){{ok=true;break;}}
    if(!ok) return false;
  }}
  if(state.q){{
    const q=state.q.toLowerCase();
    if(!((d[0]+" "+d[4]+" "+d[7]).toLowerCase().includes(q))) return false;
  }}
  return true;
}}

function miniBars(el, counts){{
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const mx = entries.length?entries[0][1]:1;
  el.innerHTML = entries.length? entries.map(([k,v])=>{{
    const pct=Math.max(2,v/mx*100);
    return `<div class="row"><div class="lab">${{k}}</div><div class="track"><div class="fill" style="width:${{pct.toFixed(1)}}%"></div></div><div class="val">${{v.toLocaleString()}}</div></div>`;
  }}).join("") : '<div style="color:var(--muted);font-size:.82rem">결과 없음</div>';
}}

function esc(s){{return (s||"").replace(/[&<>"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));}}

function render(){{
  const res=[]; const fieldC={{}}; const dispoC={{}}; const orgSet=new Set();
  for(const d of DATA){{
    if(!matches(d)) continue;
    res.push(d); if(d[0]) orgSet.add(d[0]);
    fieldC[d[2]]=(fieldC[d[2]]||0)+1;
    if(d[5]) for(const x of d[5].split(";")) dispoC[x]=(dispoC[x]||0)+1;
  }}
  $("#resN").textContent=res.length.toLocaleString();
  $("#t-shown").textContent=res.length.toLocaleString();
  $("#t-shownorg").textContent=orgSet.size.toLocaleString();
  miniBars($("#aggField"), fieldC);
  miniBars($("#aggDispo"), dispoC);
  const shown=res.slice(0,CAP);
  $("#resHint").textContent = res.length>CAP ? `상위 ${{CAP}}건 표시 (필터로 좁히세요)` : "";
  const tb=$("#tbody");
  if(!shown.length){{ tb.innerHTML='<tr><td colspan="6"><div class="empty">조건에 맞는 결과가 없습니다.</div></td></tr>'; return; }}
  tb.innerHTML = shown.map(d=>{{
    const href="자체감사결과/"+encodeURIComponent(d[7]);
    const dtags = d[5]?d[5].split(";").map(x=>`<span class="dtag">${{esc(x)}}</span>`).join(""):"";
    const seq = d[3]?` <span class="ext">(${{esc(d[3])}})</span>`:"";
    return `<tr>
      <td class="org">${{esc(d[0])}}</td>
      <td class="yr">${{esc(d[1])}}</td>
      <td class="fld">${{esc(d[2])}}</td>
      <td class="title">${{esc(d[4])}}${{seq}}</td>
      <td>${{dtags}}</td>
      <td><a class="open" href="${{href}}" target="_blank" rel="noopener">열기</a> <span class="ext">${{esc(d[6])}}</span></td>
    </tr>`;
  }}).join("");
}}

// 이벤트
let t=null;
$("#q").addEventListener("input", e=>{{state.q=e.target.value.trim(); clearTimeout(t); t=setTimeout(render,140);}});
$("#org").addEventListener("change", e=>{{state.org=e.target.value; render();}});
$("#year").addEventListener("change", e=>{{state.year=e.target.value; render();}});
function chipHandler(container, set, attr){{
  container.addEventListener("click", e=>{{
    const b=e.target.closest(".chip"); if(!b) return;
    const v=b.dataset[attr];
    if(set.has(v)){{set.delete(v); b.setAttribute("aria-pressed","false");}}
    else{{set.add(v); b.setAttribute("aria-pressed","true");}}
    render();
  }});
}}
chipHandler($("#fieldChips"), state.fields, "field");
chipHandler($("#dispoChips"), state.dispos, "dispo");
$("#reset").addEventListener("click", ()=>{{
  state.q="";state.org="";state.year="";state.fields.clear();state.dispos.clear();
  $("#q").value="";$("#org").value="";$("#year").value="";
  document.querySelectorAll('.chip[aria-pressed=true]').forEach(c=>c.setAttribute("aria-pressed","false"));
  render();
}});
render();
</script>
</body>
</html>'''
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"완료: {OUT}  ({len(data):,}행 임베드, {os.path.getsize(OUT)//1024}KB)")


if __name__ == "__main__":
    build()
