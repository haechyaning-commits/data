#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""공공감사 통합 대시보드 생성기.
   입력:
     - 감사지적_마스터인덱스.csv  (자체감사결과 10,830 파일, 본문에서 뽑은 지적제목·처분키워드)
     - 카탈로그_보고서목록.csv     (두 폴더 15,898 보고서, 포털 API 공식 처분종류·모범사례)
   출력: 감사_통합대시보드.html  (자기완결형, 탭: 현황·지적탐색·보고서탐색·기관프로파일·모범사례·벤치마크)
   원칙: 지적제목=본문추출(자체감사결과), 처분·모범사례·집계=공식 API값(보고서목록).
"""
import csv, os, json, html
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDX = os.path.join(ROOT, "감사지적_마스터인덱스.csv")
REP = "/tmp/claude-0/-home-user-data/bb83659f-d124-5afc-a049-316386e196b5/scratchpad/카탈로그_보고서목록.csv"
# 전체 첨부파일 목록(자체감사결과 r1 / 자체감사파일2 r2). git ls-tree 로 생성:
#   git ls-tree --name-only <main> 자체감사결과/ , 자체감사파일2/
FILELIST = "/tmp/claude-0/-home-user-data/bb83659f-d124-5afc-a049-316386e196b5/scratchpad/filelist.json"
OUT = os.path.join(ROOT, "감사_통합대시보드.html")

DISPO_CHIPS = ["주의", "통보-일반", "개선요구", "시정(기타)", "회수", "권고",
               "징계·문책요구", "경고", "현지주의", "현지시정", "환수", "고발"]
ENV = ["환경","수자원","발전","에너지","기후","대기","가스","전력","수력원자력",
       "매립지","원자력환경","핵융합","석유","광해","전기안전"]
THEMES = [
 ("시설·공사·안전", ["공사","시설","안전","점검","유지관리","설비","감리","준공","하자","재난","방재"]),
 ("정보·개인정보·보안", ["개인정보","정보보호","보안","전산","시스템","유출","데이터","정보화"]),
 ("계약·용역 관리", ["계약","수의계약","입찰","용역","발주","과업","낙찰","위탁"]),
 ("수당·여비·경비", ["수당","여비","출장","초과근무","시간외","업무추진비","경비","법인카드","카드"]),
 ("예산·회계 집행", ["예산","회계","집행","전용","이월","정산","세출","세입","불용","자금","보조금","기금","출연금"]),
 ("자산·물품·재고", ["자산","물품","재고","재물","구매","취득","불용품","저장품"]),
 ("성과·평가 관리", ["성과","평가","실적","지표","경영평가"]),
 ("인사·복무 관리", ["인사","채용","임용","복무","근태","징계","승진","겸직"]),
]
CHECK = {
 "시설·공사·안전": ["설계변경·과업변경의 근거문서 구비","정기 안전점검 실시·기록","준공·하자보수 이행 확인"],
 "정보·개인정보·보안": ["개인정보 보유기간·파기 관리","시스템 접근권한 최소화·로그 점검","위탁사 정보보안 점검"],
 "계약·용역 관리": ["수의계약 사유·연간 횟수 한도 준수","용역 과업이행 검사·정산","손해배상보험 가입·정산 확인"],
 "수당·여비·경비": ["초과근무 사전승인·실적 일치","출장 목적·정산 적정성","업무추진비·법인카드 증빙"],
 "예산·회계 집행": ["예산 전용·이월 절차 준수","보조·출연금 목적 외 사용 여부","정산 잔액 회수 이행"],
 "자산·물품·재고": ["정기 재물조사 실시","불용품 처리 절차 적정","자산 등재 누락 점검"],
 "성과·평가 관리": ["성과지표 산정근거·실적 검증","경영평가 대응 지표 관리"],
 "인사·복무 관리": ["채용 절차 공정성·규정 준수","복무관리지침 준수","겸직·영리행위 신고 관리"],
}
GENERIC = ("결과보고","특별 복무","명절","휴가철","연말연시","동절기","하계","을지연")


def load():
    findings = []
    for r in csv.DictReader(open(IDX, encoding="utf-8-sig")):
        findings.append([r["기관명"], r["연도"], r["감사분야"], r["순번"],
                         r["지적제목"], r["처분키워드"], r["파일형식"], r["파일명"]])
    reports = []
    for r in csv.DictReader(open(REP, encoding="utf-8-sig")):
        reports.append([r["폴더"], r["기관"], r["연도"], r["감사분야"], r["감사사항명"],
                        r["처분종류"], r["모범사례포함"], r["조치사항수"]])
    return findings, reports


def benchmark(findings):
    cohort = [f for f in findings if any(w in f[0] for w in ENV)]
    def classify(t): return [n for n, kws in THEMES if any(k in t for k in kws)]
    theme = Counter(); ex = defaultdict(list); exo = defaultdict(set)
    for f in cohort:
        t = f[4].strip()
        for n in classify(t):
            theme[n] += 1
            if len(ex[n]) < 3 and 8 <= len(t) <= 42 and f[0] not in exo[n] and not any(g in t for g in GENERIC):
                ex[n].append({"org": f[0], "title": t, "dispo": f[5]}); exo[n].add(f[0])
    cards = []
    for name, cnt in theme.most_common():
        pts = "".join(f"<li>{html.escape(p)}</li>" for p in CHECK.get(name, []))
        exs = "".join(f'<div class="ex"><span class="exorg">{html.escape(e["org"])}</span> {html.escape(e["title"])}</div>'
                      for e in ex.get(name, []))
        cards.append(f'<div class="card"><div class="chead"><span class="cnt">{cnt:,}건</span>'
                     f'<h3>{html.escape(name)}</h3></div><div class="csub">사전점검 포인트</div>'
                     f'<ul>{pts}</ul><div class="csub">동종기관 실제 지적</div>{exs}</div>')
    return len(set(f[0] for f in cohort)), len(cohort), "".join(cards)


def build():
    findings, reports = load()
    fpayload = json.dumps(findings, ensure_ascii=False, separators=(",", ":"))
    rpayload = json.dumps(reports, ensure_ascii=False, separators=(",", ":"))
    fl = json.load(open(FILELIST, encoding="utf-8"))
    rf1payload = json.dumps(fl["r1"], ensure_ascii=False, separators=(",", ":"))
    rf2payload = json.dumps(fl["r2"], ensure_ascii=False, separators=(",", ":"))
    cohort_orgs, cohort_n, bench_cards = benchmark(findings)
    dispo_chips = "".join(f'<button class="chip" data-d="{html.escape(d)}">{html.escape(d)}</button>' for d in DISPO_CHIPS)
    total_att = 56681

    page = f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>공공감사 통합 대시보드</title>
<style>
  :root{{color-scheme:light;--plane:#f4f5f3;--surface:#fcfcfb;--surface2:#f1f2ef;--ink:#0b0b0b;
    --ink2:#52514e;--muted:#8a8880;--grid:#e4e3dd;--line:#d7d8d1;--accent:#2a6fbf;--accent2:#0a7f52;
    --soft:#e7f0fa;--track:#e7e8e2;--border:rgba(11,11,11,.10);--good:#0ca30c;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}}
  @media (prefers-color-scheme:dark){{:root:where(:not([data-theme="light"])){{
    color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;--surface2:#232322;--ink:#fff;--ink2:#c3c2b7;
    --muted:#8f8e86;--grid:#2c2c2a;--line:#333;--accent:#3987e5;--accent2:#19a56b;--soft:#15304d;
    --track:#2c2c2a;--border:rgba(255,255,255,.12);--good:#0ca30c;}}}}
  :root[data-theme="dark"]{{color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;--surface2:#232322;
    --ink:#fff;--ink2:#c3c2b7;--muted:#8f8e86;--grid:#2c2c2a;--line:#333;--accent:#3987e5;
    --accent2:#19a56b;--soft:#15304d;--track:#2c2c2a;--border:rgba(255,255,255,.12);}}
  *{{box-sizing:border-box;}}
  body{{margin:0;background:var(--plane);color:var(--ink);line-height:1.5;}}
  .wrap{{max-width:1160px;margin:0 auto;padding:22px 18px 70px;}}
  header h1{{font-size:1.4rem;margin:0 0 3px;letter-spacing:-.01em;}}
  header p{{color:var(--ink2);font-size:.86rem;margin:0;}}
  .tabs{{display:flex;flex-wrap:wrap;gap:4px;margin:16px 0 18px;border-bottom:1px solid var(--line);}}
  .tab{{font:inherit;font-size:.9rem;padding:9px 15px;border:none;background:none;color:var(--ink2);
    cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}}
  .tab:hover{{color:var(--ink);}}
  .tab[aria-selected=true]{{color:var(--accent);border-bottom-color:var(--accent);font-weight:600;}}
  .view{{display:none;}} .view.on{{display:block;}}
  .tiles{{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px;}}
  @media(max-width:720px){{.tiles{{grid-template-columns:repeat(2,1fr);}}}}
  .tile{{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:13px 15px;}}
  .tile .n{{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;}}
  .tile .l{{color:var(--ink2);font-size:.75rem;margin-top:1px;}}
  .tile .n.good{{color:var(--good);}}
  .panel{{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin-bottom:16px;}}
  .panel h2{{font-size:1rem;margin:0 0 12px;}}
  .grid2{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
  @media(max-width:760px){{.grid2{{grid-template-columns:1fr;}}}}
  .bars .row{{display:grid;grid-template-columns:120px 1fr 52px;align-items:center;gap:8px;padding:3px 0;font-size:.82rem;}}
  .bars .lab{{color:var(--ink2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
  .bars .track{{background:var(--track);border-radius:5px;height:15px;overflow:hidden;}}
  .bars .fill{{height:100%;border-radius:5px;background:var(--accent);}}
  .bars .val{{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;}}
  .filters{{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin-bottom:12px;}}
  .fg{{display:flex;flex-direction:column;gap:4px;}}
  .fg label{{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}}
  input[type=search],select{{font:inherit;font-size:.88rem;padding:8px 10px;border:1px solid var(--line);
    border-radius:9px;background:var(--surface2);color:var(--ink);min-width:140px;}}
  input[type=search]{{min-width:220px;}}
  input:focus,select:focus,button:focus-visible{{outline:2px solid var(--accent);outline-offset:1px;}}
  .chips{{display:flex;flex-wrap:wrap;gap:6px;}}
  .chip{{font:inherit;font-size:.78rem;padding:4px 10px;border:1px solid var(--line);border-radius:20px;
    background:var(--surface2);color:var(--ink2);cursor:pointer;}}
  .chip:hover{{border-color:var(--accent);}}
  .chip[aria-pressed=true]{{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}}
  .chipwrap{{margin:8px 0;}}
  .chipwrap>span{{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-right:6px;}}
  .reset{{font:inherit;font-size:.8rem;padding:6px 12px;border:1px solid var(--line);border-radius:8px;
    background:var(--surface2);color:var(--ink2);cursor:pointer;}}
  .resbar{{display:flex;justify-content:space-between;align-items:baseline;margin:6px 2px 8px;}}
  .resbar .count b{{color:var(--accent);font-variant-numeric:tabular-nums;}}
  .resbar .hint{{font-size:.78rem;color:var(--muted);}}
  .tblwrap{{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);}}
  table{{width:100%;border-collapse:collapse;font-size:.83rem;}}
  thead th{{position:sticky;top:0;background:var(--surface2);color:var(--muted);font-weight:600;font-size:.71rem;
    text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);white-space:nowrap;}}
  tbody td{{padding:8px 11px;border-bottom:1px solid var(--grid);vertical-align:top;}}
  tbody tr:hover{{background:var(--soft);}}
  td.org{{white-space:nowrap;font-weight:600;}} td.c{{white-space:nowrap;color:var(--ink2);}}
  .dtag{{display:inline-block;font-size:.69rem;background:var(--surface2);color:var(--ink2);border:1px solid var(--line);
    padding:1px 6px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap;}}
  .best{{display:inline-block;font-size:.69rem;background:var(--good);color:#fff;padding:1px 7px;border-radius:10px;font-weight:600;}}
  a.open{{color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap;}} a.open:hover{{text-decoration:underline;}}
  .empty{{padding:36px;text-align:center;color:var(--muted);}}
  .cards{{display:grid;grid-template-columns:1fr 1fr;gap:14px;}} @media(max-width:760px){{.cards{{grid-template-columns:1fr;}}}}
  .card{{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}}
  .chead{{display:flex;align-items:baseline;gap:9px;margin-bottom:8px;}} .chead h3{{font-size:.98rem;margin:0;}}
  .chead .cnt{{font-size:.75rem;font-weight:700;color:#fff;background:var(--accent);padding:2px 8px;border-radius:20px;white-space:nowrap;}}
  .csub{{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 5px;}}
  .card ul{{margin:0;padding-left:17px;font-size:.84rem;}} .card ul li{{margin:3px 0;}}
  .ex{{font-size:.8rem;color:var(--ink2);padding:3px 0;border-top:1px solid var(--grid);}} .ex:first-of-type{{border-top:none;}}
  .exorg{{color:var(--ink);font-weight:600;}}
  svg .axis{{stroke:var(--line);stroke-width:1;}} svg .gl{{stroke:var(--grid);stroke-width:1;}}
  svg text{{fill:var(--muted);font-size:11px;}} svg .lbl{{fill:var(--ink2);font-size:11px;font-weight:600;}}
  .legend{{display:flex;gap:16px;font-size:.8rem;color:var(--ink2);margin:6px 0 2px;}}
  .legend i{{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px;}}
  .foot{{margin-top:22px;color:var(--muted);font-size:.76rem;border-top:1px solid var(--grid);padding-top:14px;}}
  .note{{font-size:.82rem;color:var(--ink2);margin:0 0 12px;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>공공감사 통합 대시보드</h1>
    <p>공공감사포털(pap.go.kr) 자체감사결과 · 보고서 15,898건 · 첨부 {total_att:,}개 · 2021~2026. 지적제목은 문서 본문 추출(자체감사결과), 처분·모범사례는 포털 공식값.</p>
  </header>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-v="overview" aria-selected="true">현황</button>
    <button class="tab" role="tab" data-v="findings" aria-selected="false">지적 탐색</button>
    <button class="tab" role="tab" data-v="reports" aria-selected="false">보고서 탐색</button>
    <button class="tab" role="tab" data-v="files" aria-selected="false">파일 탐색</button>
    <button class="tab" role="tab" data-v="org" aria-selected="false">기관 프로파일</button>
    <button class="tab" role="tab" data-v="best" aria-selected="false">모범사례</button>
    <button class="tab" role="tab" data-v="bench" aria-selected="false">벤치마크</button>
  </div>

  <!-- 현황 -->
  <div class="view on" id="v-overview">
    <div class="tiles">
      <div class="tile"><div class="n">15,898</div><div class="l">보고서</div></div>
      <div class="tile"><div class="n">{total_att:,}</div><div class="l">첨부파일</div></div>
      <div class="tile"><div class="n" id="ov-orgs">0</div><div class="l">기관</div></div>
      <div class="tile"><div class="n good" id="ov-best">0</div><div class="l">모범사례 보고서</div></div>
      <div class="tile"><div class="n">2021–26</div><div class="l">수집 기간</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>감사분야 분포</h2><div class="bars" id="ov-field"></div></div>
      <div class="panel"><h2>처분종류 분포 (공식)</h2><div class="bars" id="ov-dispo"></div></div>
    </div>
  </div>

  <!-- 지적 탐색 (자체감사결과, 본문 지적제목) -->
  <div class="view" id="v-findings">
    <p class="note">자체감사결과(2025~2026) 첨부 10,830개를 <b>문서 본문에서 뽑은 지적제목</b>으로 검색합니다. (처분키워드는 본문 신호로 참고용)</p>
    <div class="panel">
      <div class="filters">
        <div class="fg" style="flex:1 1 240px"><label>검색 (기관·지적제목·파일명)</label><input type="search" id="f-q" placeholder="예: 수의계약, 초과근무…" autocomplete="off"></div>
        <div class="fg"><label>기관</label><select id="f-org"><option value="">전체</option></select></div>
        <div class="fg"><label>연도</label><select id="f-year"><option value="">전체</option></select></div>
        <div class="fg"><label>감사분야</label><select id="f-field"><option value="">전체</option></select></div>
      </div>
      <div class="chipwrap"><span>처분키워드</span><div class="chips" id="f-dispo"></div></div>
      <button class="reset" id="f-reset">필터 초기화</button>
    </div>
    <div class="resbar"><div class="count"><b id="f-n">0</b>건</div><div class="hint" id="f-hint"></div></div>
    <div class="tblwrap"><table><thead><tr><th>기관</th><th>연도</th><th>분야</th><th>지적제목</th><th>처분키워드</th><th>원문</th></tr></thead><tbody id="f-body"></tbody></table></div>
  </div>

  <!-- 보고서 탐색 (두 폴더, 공식 처분/모범사례) -->
  <div class="view" id="v-reports">
    <p class="note">두 폴더 보고서 15,898건을 <b>포털 공식 메타데이터</b>(감사사항명·처분종류·모범사례)로 검색합니다.</p>
    <div class="panel">
      <div class="filters">
        <div class="fg" style="flex:1 1 240px"><label>검색 (기관·감사사항명)</label><input type="search" id="r-q" placeholder="예: 계약, 개인정보…" autocomplete="off"></div>
        <div class="fg"><label>데이터셋</label><select id="r-ds"><option value="">전체</option><option value="자체감사결과">자체감사결과(25~26)</option><option value="자체감사파일2">자체감사파일2(21~25)</option></select></div>
        <div class="fg"><label>기관</label><select id="r-org"><option value="">전체</option></select></div>
        <div class="fg"><label>연도</label><select id="r-year"><option value="">전체</option></select></div>
        <div class="fg"><label>감사분야</label><select id="r-field"><option value="">전체</option></select></div>
        <div class="fg"><label>모범사례</label><select id="r-best"><option value="">전체</option><option value="Y">포함만</option><option value="N">제외</option></select></div>
      </div>
      <div class="chipwrap"><span>처분종류</span><div class="chips" id="r-dispo"></div></div>
      <button class="reset" id="r-reset">필터 초기화</button>
    </div>
    <div class="resbar"><div class="count"><b id="r-n">0</b>건</div><div class="hint" id="r-hint"></div></div>
    <div class="tblwrap"><table><thead><tr><th>기관</th><th>연도</th><th>분야</th><th>감사사항명</th><th>처분종류</th><th>모범</th></tr></thead><tbody id="r-body"></tbody></table></div>
  </div>

  <!-- 파일 탐색 (전체 첨부파일, 각 파일 바로 열기) -->
  <div class="view" id="v-files">
    <p class="note">전체 첨부파일 <b>56,686개</b>를 파일명(기관·연도·분야 포함)으로 검색하고 <b>각 파일을 바로 엽니다</b>. (온라인=GitHub 원문, 로컬=폴더)</p>
    <div class="panel">
      <div class="filters">
        <div class="fg" style="flex:1 1 260px"><label>검색 (파일명·기관)</label><input type="search" id="x-q" placeholder="예: 한국환경공단, 종합감사, 계약…" autocomplete="off"></div>
        <div class="fg"><label>데이터셋</label><select id="x-ds"><option value="">전체</option><option value="0">자체감사결과(25~26)</option><option value="1">자체감사파일2(21~25)</option></select></div>
        <div class="fg"><label>연도</label><select id="x-year"><option value="">전체</option></select></div>
        <div class="fg"><label>감사분야</label><select id="x-field"><option value="">전체</option></select></div>
        <div class="fg"><label>형식</label><select id="x-ext"><option value="">전체</option></select></div>
      </div>
      <button class="reset" id="x-reset">필터 초기화</button>
    </div>
    <div class="resbar"><div class="count"><b id="x-n">0</b>개 파일</div><div class="hint" id="x-hint"></div></div>
    <div class="tblwrap"><table><thead><tr><th>기관</th><th>연도</th><th>분야</th><th>파일명</th><th>형식</th><th>열기</th></tr></thead><tbody id="x-body"></tbody></table></div>
  </div>

  <!-- 기관 프로파일 -->
  <div class="view" id="v-org">
    <div class="filters"><div class="fg" style="flex:1 1 300px"><label>기관 선택</label><select id="o-sel"><option value="">기관을 선택하세요</option></select></div></div>
    <div id="o-body"></div>
  </div>

  <!-- 모범사례 -->
  <div class="view" id="v-best">
    <p class="note"><b>모범사례 포함 보고서 4,046건</b> (포털 공식 분류). 동종기관의 잘한 사례를 벤치마킹하세요.</p>
    <div class="panel">
      <div class="filters">
        <div class="fg" style="flex:1 1 240px"><label>검색 (기관·감사사항명)</label><input type="search" id="b-q" placeholder="예: 청렴, 안전…" autocomplete="off"></div>
        <div class="fg"><label>기관</label><select id="b-org"><option value="">전체</option></select></div>
        <div class="fg"><label>연도</label><select id="b-year"><option value="">전체</option></select></div>
        <div class="fg"><label>감사분야</label><select id="b-field"><option value="">전체</option></select></div>
      </div>
    </div>
    <div class="resbar"><div class="count"><b id="b-n">0</b>건</div><div class="hint" id="b-hint"></div></div>
    <div class="tblwrap"><table><thead><tr><th>기관</th><th>연도</th><th>분야</th><th>감사사항명</th><th>함께 부과된 처분</th></tr></thead><tbody id="b-body"></tbody></table></div>
  </div>

  <!-- 벤치마크 -->
  <div class="view" id="v-bench">
    <p class="note">환경·에너지 {cohort_orgs}개 기관 {cohort_n:,}건(자체감사결과)의 반복 지적 주제와 한국환경공단 사전점검 체크리스트.</p>
    <div class="cards">{bench_cards}</div>
  </div>

  <div class="foot">
    처분·모범사례·집계는 포털 목록 API 공식값(보고서 단위), 지적제목은 자체감사결과 문서 본문 추출(파일 단위)입니다. 원문 '열기'는 온라인=GitHub, 로컬=폴더로 연결(비공개 저장소는 GitHub 로그인 필요). 표는 성능상 상위 400건까지 표시합니다.
  </div>
</div>

<script>
const F = {fpayload};   // [기관,연도,분야,순번,지적제목,처분키워드,형식,파일명]
const R = {rpayload};   // [폴더,기관,연도,분야,감사사항명,처분종류,모범사례,조치수]
const RF1 = {rf1payload};  // 자체감사결과 파일명
const RF2 = {rf2payload};  // 자체감사파일2 파일명
const FOLDERS = ["자체감사결과","자체감사파일2"];
const CAP=400;
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>(s||"").replace(/[&<>"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
const GH="https://github.com/haechyaning-commits/data/blob/main/자체감사결과/";
const FILE_BASE=(location.protocol==="file:")?"자체감사결과/":GH;
const uniq=(arr)=>[...new Set(arr)].filter(Boolean);
function opts(sel,vals,sort){{ let v=uniq(vals); if(sort==='num') v.sort((a,b)=>b-a); else v.sort();
  sel.insertAdjacentHTML('beforeend', v.map(x=>`<option value="${{esc(x)}}">${{esc(x)}}</option>`).join('')); }}
function toks(s){{return s?s.replace(/,/g,';').split(';').map(x=>x.trim()).filter(Boolean):[];}}

// ---- 탭 ----
$$('.tab').forEach(t=>t.addEventListener('click',()=>{{
  $$('.tab').forEach(x=>x.setAttribute('aria-selected','false'));
  t.setAttribute('aria-selected','true');
  $$('.view').forEach(v=>v.classList.remove('on'));
  $('#v-'+t.dataset.v).classList.add('on');
  if(t.dataset.v==='files') initFiles();
}}));

// ---- 공용 막대 ----
function bars(el,counts,accent){{
  const e=Object.entries(counts).sort((a,b)=>b[1]-a[1]); const mx=e.length?e[0][1]:1;
  el.innerHTML = e.length? e.map(([k,v])=>{{const p=Math.max(2,v/mx*100);
    return `<div class="row"><div class="lab">${{esc(k)}}</div><div class="track"><div class="fill" style="width:${{p.toFixed(1)}}%${{accent?';background:'+accent:''}}"></div></div><div class="val">${{v.toLocaleString()}}</div></div>`;}}).join('')
    : '<div style="color:var(--muted);font-size:.82rem">결과 없음</div>';
}}

// ---- 현황 ----
(function(){{
  $('#ov-orgs').textContent=uniq(R.map(r=>r[1])).length.toLocaleString();
  $('#ov-best').textContent=R.filter(r=>r[6]==='Y').length.toLocaleString();
  const fc={{}},dc={{}};
  for(const r of R){{ fc[r[3]]=(fc[r[3]]||0)+1; for(const t of toks(r[5])){{if(t!=='모범사례')dc[t]=(dc[t]||0)+1;}} }}
  bars($('#ov-field'),fc);
  const top=Object.entries(dc).sort((a,b)=>b[1]-a[1]).slice(0,12); bars($('#ov-dispo'),Object.fromEntries(top));
}})();
function lineChart(labels,series){{
  const W=1080,H=240,padL=44,padR=16,padT=14,padB=28, iw=W-padL-padR, ih=H-padT-padB;
  const mx=Math.max(1,...series.flatMap(s=>s.d));
  const X=i=>padL+ (labels.length>1? i*iw/(labels.length-1):iw/2);
  const Y=v=>padT+ih-(v/mx*ih);
  let g='';
  for(let k=0;k<=4;k++){{const y=padT+ih-k*ih/4; const val=Math.round(mx*k/4);
    g+=`<line class="gl" x1="${{padL}}" y1="${{y}}" x2="${{W-padR}}" y2="${{y}}"/><text x="${{padL-6}}" y="${{y+3}}" text-anchor="end">${{val.toLocaleString()}}</text>`;}}
  labels.forEach((l,i)=>{{g+=`<text x="${{X(i)}}" y="${{H-8}}" text-anchor="middle">${{l}}</text>`;}});
  let paths='';
  series.forEach(s=>{{
    const pts=s.d.map((v,i)=>`${{X(i)}},${{Y(v)}}`).join(' ');
    paths+=`<polyline fill="none" stroke="${{s.c}}" stroke-width="2.5" points="${{pts}}"/>`;
    s.d.forEach((v,i)=>{{paths+=`<circle cx="${{X(i)}}" cy="${{Y(v)}}" r="4" fill="${{s.c}}"><title>${{labels[i]}}: ${{v.toLocaleString()}}</title></circle>`;
      if(v)paths+=`<text class="lbl" x="${{X(i)}}" y="${{Y(v)-9}}" text-anchor="middle">${{v.toLocaleString()}}</text>`;}});
  }});
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${{W}} ${{H}}" width="100%" style="min-width:640px">${{g}}${{paths}}</svg></div>`;
}}

// ---- 지적 탐색 (findings) ----
(function(){{
  opts($('#f-org'),F.map(f=>f[0])); opts($('#f-year'),F.map(f=>f[1]),'num'); opts($('#f-field'),F.map(f=>f[2]));
  $('#f-dispo').innerHTML=["징계","주의","통보","시정","개선","회수","경고","권고"].map(d=>`<button class="chip" data-d="${{d}}">${{d}}</button>`).join('');
  const st={{q:'',org:'',year:'',field:'',dispos:new Set()}};
  let t=null;
  const render=()=>{{
    let res=F.filter(f=>{{
      if(st.org&&f[0]!==st.org)return false; if(st.year&&f[1]!==st.year)return false; if(st.field&&f[2]!==st.field)return false;
      if(st.dispos.size){{const dp=toks(f[5]);let ok=false;for(const x of st.dispos)if(dp.includes(x)){{ok=true;break;}}if(!ok)return false;}}
      if(st.q){{const q=st.q.toLowerCase();if(!((f[0]+' '+f[4]+' '+f[7]).toLowerCase().includes(q)))return false;}}
      return true;}});
    $('#f-n').textContent=res.length.toLocaleString();
    $('#f-hint').textContent=res.length>CAP?`상위 ${{CAP}}건 표시`:'';
    const sh=res.slice(0,CAP);
    $('#f-body').innerHTML = sh.length? sh.map(f=>{{
      const href=FILE_BASE+encodeURIComponent(f[7]);
      const dt=toks(f[5]).map(x=>`<span class="dtag">${{esc(x)}}</span>`).join('');
      return `<tr><td class="org">${{esc(f[0])}}</td><td class="c">${{esc(f[1])}}</td><td class="c">${{esc(f[2])}}</td><td>${{esc(f[4])}}</td><td>${{dt}}</td><td><a class="open" href="${{href}}" target="_blank" rel="noopener">열기</a></td></tr>`;
    }}).join('') : '<tr><td colspan="6"><div class="empty">결과가 없습니다.</div></td></tr>';
  }};
  $('#f-q').addEventListener('input',e=>{{st.q=e.target.value.trim();clearTimeout(t);t=setTimeout(render,140);}});
  $('#f-org').addEventListener('change',e=>{{st.org=e.target.value;render();}});
  $('#f-year').addEventListener('change',e=>{{st.year=e.target.value;render();}});
  $('#f-field').addEventListener('change',e=>{{st.field=e.target.value;render();}});
  $('#f-dispo').addEventListener('click',e=>{{const b=e.target.closest('.chip');if(!b)return;const v=b.dataset.d;
    if(st.dispos.has(v)){{st.dispos.delete(v);b.setAttribute('aria-pressed','false');}}else{{st.dispos.add(v);b.setAttribute('aria-pressed','true');}}render();}});
  $('#f-reset').addEventListener('click',()=>{{st.q='';st.org='';st.year='';st.field='';st.dispos.clear();
    $('#f-q').value='';$('#f-org').value='';$('#f-year').value='';$('#f-field').value='';
    $$('#f-dispo .chip[aria-pressed=true]').forEach(c=>c.setAttribute('aria-pressed','false'));render();}});
  render();
}})();

// ---- 보고서 탐색 (reports) ----
function reportRow(r){{
  const best=r[6]==='Y'?'<span class="best">모범</span>':'';
  const dt=toks(r[5]).filter(x=>x!=='모범사례').map(x=>`<span class="dtag">${{esc(x)}}</span>`).join('');
  return `<tr><td class="org">${{esc(r[1])}}</td><td class="c">${{esc(r[2])}}</td><td class="c">${{esc(r[3])}}</td><td>${{esc(r[4])}}</td><td>${{dt}}</td><td>${{best}}</td></tr>`;
}}
(function(){{
  opts($('#r-org'),R.map(r=>r[1])); opts($('#r-year'),R.map(r=>r[2]),'num'); opts($('#r-field'),R.map(r=>r[3]));
  $('#r-dispo').innerHTML={json.dumps(DISPO_CHIPS,ensure_ascii=False)}.map(d=>`<button class="chip" data-d="${{d}}">${{d}}</button>`).join('');
  const st={{q:'',ds:'',org:'',year:'',field:'',best:'',dispos:new Set()}};let t=null;
  const render=()=>{{
    let res=R.filter(r=>{{
      if(st.ds&&r[0]!==st.ds)return false; if(st.org&&r[1]!==st.org)return false; if(st.year&&r[2]!==st.year)return false;
      if(st.field&&r[3]!==st.field)return false; if(st.best&&r[6]!==st.best)return false;
      if(st.dispos.size){{const dp=toks(r[5]);let ok=false;for(const x of st.dispos)if(dp.includes(x)){{ok=true;break;}}if(!ok)return false;}}
      if(st.q){{const q=st.q.toLowerCase();if(!((r[1]+' '+r[4]).toLowerCase().includes(q)))return false;}}
      return true;}});
    $('#r-n').textContent=res.length.toLocaleString();
    $('#r-hint').textContent=res.length>CAP?`상위 ${{CAP}}건 표시`:'';
    const sh=res.slice(0,CAP);
    $('#r-body').innerHTML= sh.length? sh.map(reportRow).join('') : '<tr><td colspan="6"><div class="empty">결과가 없습니다.</div></td></tr>';
  }};
  $('#r-q').addEventListener('input',e=>{{st.q=e.target.value.trim();clearTimeout(t);t=setTimeout(render,140);}});
  ['ds','org','year','field','best'].forEach(k=>$('#r-'+k).addEventListener('change',e=>{{st[k]=e.target.value;render();}}));
  $('#r-dispo').addEventListener('click',e=>{{const b=e.target.closest('.chip');if(!b)return;const v=b.dataset.d;
    if(st.dispos.has(v)){{st.dispos.delete(v);b.setAttribute('aria-pressed','false');}}else{{st.dispos.add(v);b.setAttribute('aria-pressed','true');}}render();}});
  $('#r-reset').addEventListener('click',()=>{{Object.assign(st,{{q:'',ds:'',org:'',year:'',field:'',best:''}});st.dispos.clear();
    ['q','ds','org','year','field','best'].forEach(k=>$('#r-'+k).value='');
    $$('#r-dispo .chip[aria-pressed=true]').forEach(c=>c.setAttribute('aria-pressed','false'));render();}});
  render();
}})();

// ---- 파일 탐색 (전체 첨부파일) ----
let filesInit=false, FILES=null;
function parseFn(fn){{
  const ext=(fn.match(/\.([^.]+)$/)||['',''])[1];
  let base=fn.replace(/\.[^.]+$/,'').replace(/\((\d+)\)$/,'');
  const m=base.match(/^(.*)_(\d{{4}})년\s*(.*)$/);
  if(m) return [m[1], m[2], (m[3].trim()||'기타'), ext];
  return [base, '', '', ext];
}}
function initFiles(){{
  if(filesInit) return; filesInit=true;
  FILES=[];
  RF1.forEach(fn=>{{const p=parseFn(fn);FILES.push([0,fn,p[0],p[1],p[2],p[3]]);}});
  RF2.forEach(fn=>{{const p=parseFn(fn);FILES.push([1,fn,p[0],p[1],p[2],p[3]]);}});
  opts($('#x-year'),FILES.map(f=>f[3]),'num'); opts($('#x-field'),FILES.map(f=>f[4])); opts($('#x-ext'),FILES.map(f=>f[5]));
  const st={{q:'',ds:'',year:'',field:'',ext:''}};let t=null;
  const render=()=>{{
    let res=FILES.filter(f=>{{
      if(st.ds!==''&&String(f[0])!==st.ds)return false;
      if(st.year&&f[3]!==st.year)return false; if(st.field&&f[4]!==st.field)return false; if(st.ext&&f[5]!==st.ext)return false;
      if(st.q){{const q=st.q.toLowerCase();if(!(f[1].toLowerCase().includes(q)))return false;}}
      return true;}});
    $('#x-n').textContent=res.length.toLocaleString(); $('#x-hint').textContent=res.length>CAP?`상위 ${{CAP}}개 표시`:'';
    const sh=res.slice(0,CAP);
    $('#x-body').innerHTML= sh.length? sh.map(f=>{{
      const base=(location.protocol==="file:")?FOLDERS[f[0]]+"/":("https://github.com/haechyaning-commits/data/blob/main/"+FOLDERS[f[0]]+"/");
      const href=base+encodeURIComponent(f[1]);
      return `<tr><td class="org">${{esc(f[2])}}</td><td class="c">${{esc(f[3])}}</td><td class="c">${{esc(f[4])}}</td><td>${{esc(f[1])}}</td><td class="c">${{esc(f[5])}}</td><td><a class="open" href="${{href}}" target="_blank" rel="noopener">열기</a></td></tr>`;
    }}).join('') : '<tr><td colspan="6"><div class="empty">결과가 없습니다.</div></td></tr>';
  }};
  $('#x-q').addEventListener('input',e=>{{st.q=e.target.value.trim();clearTimeout(t);t=setTimeout(render,160);}});
  ['ds','year','field','ext'].forEach(k=>$('#x-'+k).addEventListener('change',e=>{{st[k]=e.target.value;render();}}));
  $('#x-reset').addEventListener('click',()=>{{Object.assign(st,{{q:'',ds:'',year:'',field:'',ext:''}});['q','ds','year','field','ext'].forEach(k=>$('#x-'+k).value='');render();}});
  render();
}}

// ---- 기관 프로파일 ----
(function(){{
  opts($('#o-sel'),R.map(r=>r[1]));
  $('#o-sel').addEventListener('change',e=>{{
    const org=e.target.value; const box=$('#o-body'); if(!org){{box.innerHTML='';return;}}
    const rs=R.filter(r=>r[1]===org);
    const best=rs.filter(r=>r[6]==='Y').length;
    const fc={{}},dc={{}},yc={{}};
    for(const r of rs){{fc[r[3]]=(fc[r[3]]||0)+1; yc[r[2]]=(yc[r[2]]||0)+1; for(const x of toks(r[5]))if(x!=='모범사례')dc[x]=(dc[x]||0)+1;}}
    const years=['2021','2022','2023','2024','2025','2026'];
    const trend=lineChart(years,[{{d:years.map(y=>yc[y]||0),c:'var(--accent)'}}]);
    const rows=rs.slice(0,200).map(reportRow).join('');
    box.innerHTML=`
      <div class="tiles">
        <div class="tile"><div class="n">${{rs.length.toLocaleString()}}</div><div class="l">보고서</div></div>
        <div class="tile"><div class="n good">${{best.toLocaleString()}}</div><div class="l">모범사례</div></div>
        <div class="tile"><div class="n">${{Object.keys(fc).length}}</div><div class="l">감사분야 수</div></div>
        <div class="tile"><div class="n">${{rs.reduce((a,r)=>a+(parseInt(r[7])||0),0).toLocaleString()}}</div><div class="l">조치사항 수 합계</div></div>
      </div>
      <div class="panel"><h2>연도별 보고서</h2>${{trend}}</div>
      <div class="grid2">
        <div class="panel"><h2>감사분야</h2><div class="bars" id="o-f"></div></div>
        <div class="panel"><h2>처분종류</h2><div class="bars" id="o-d"></div></div>
      </div>
      <div class="panel"><h2>보고서 목록 (${{rs.length>200?'상위 200':rs.length}})</h2>
        <div class="tblwrap"><table><thead><tr><th>기관</th><th>연도</th><th>분야</th><th>감사사항명</th><th>처분종류</th><th>모범</th></tr></thead><tbody>${{rows}}</tbody></table></div></div>`;
    bars($('#o-f'),fc); bars($('#o-d'),Object.fromEntries(Object.entries(dc).sort((a,b)=>b[1]-a[1]).slice(0,10)));
  }});
}})();

// ---- 모범사례 ----
(function(){{
  const BEST=R.filter(r=>r[6]==='Y');
  opts($('#b-org'),BEST.map(r=>r[1])); opts($('#b-year'),BEST.map(r=>r[2]),'num'); opts($('#b-field'),BEST.map(r=>r[3]));
  const st={{q:'',org:'',year:'',field:''}};let t=null;
  const render=()=>{{
    let res=BEST.filter(r=>{{
      if(st.org&&r[1]!==st.org)return false; if(st.year&&r[2]!==st.year)return false; if(st.field&&r[3]!==st.field)return false;
      if(st.q){{const q=st.q.toLowerCase();if(!((r[1]+' '+r[4]).toLowerCase().includes(q)))return false;}} return true;}});
    $('#b-n').textContent=res.length.toLocaleString(); $('#b-hint').textContent=res.length>CAP?`상위 ${{CAP}}건 표시`:'';
    const sh=res.slice(0,CAP);
    $('#b-body').innerHTML= sh.length? sh.map(r=>{{
      const dt=toks(r[5]).filter(x=>x!=='모범사례').map(x=>`<span class="dtag">${{esc(x)}}</span>`).join('');
      return `<tr><td class="org">${{esc(r[1])}}</td><td class="c">${{esc(r[2])}}</td><td class="c">${{esc(r[3])}}</td><td>${{esc(r[4])}}</td><td>${{dt}}</td></tr>`;
    }}).join('') : '<tr><td colspan="5"><div class="empty">결과가 없습니다.</div></td></tr>';
  }};
  $('#b-q').addEventListener('input',e=>{{st.q=e.target.value.trim();clearTimeout(t);t=setTimeout(render,140);}});
  ['org','year','field'].forEach(k=>$('#b-'+k).addEventListener('change',e=>{{st[k]=e.target.value;render();}}));
  render();
}})();
</script>
</body>
</html>'''
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"완료: {OUT}  ({os.path.getsize(OUT)//1024}KB)  findings={len(findings):,} reports={len(reports):,}")


if __name__ == "__main__":
    build()
