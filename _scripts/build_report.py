#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""환경·에너지 공공기관 자체감사 지적 벤치마크 HTML 리포트 생성기.
   감사지적_마스터인덱스.csv → agg.json(집계) → 환경부문_감사지적_벤치마크.html
   (집계는 build_report.py 실행 시 CSV에서 직접 계산)"""
import csv, os, json, html
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV = os.path.join(ROOT, "감사지적_마스터인덱스.csv")
OUT = os.path.join(ROOT, "환경부문_감사지적_벤치마크.html")

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
# 주제별 사전점검 포인트(큐레이션)
CHECK = {
 "시설·공사·안전": ["설계변경·과업변경의 근거문서 구비 여부","정기 안전점검 실시 및 기록 관리","준공·하자보수 이행 확인"],
 "정보·개인정보·보안": ["개인정보 보유기간·파기 관리","시스템 접근권한 최소화 및 로그 점검","위탁사 정보보안 점검"],
 "계약·용역 관리": ["수의계약 사유·연간 횟수 한도 준수","용역 과업이행 검사·정산 적정성","손해배상보험(공제) 가입·정산 확인"],
 "수당·여비·경비": ["초과근무 사전승인과 실적 일치","출장 목적·정산의 적정성","업무추진비·법인카드 집행목적·증빙"],
 "예산·회계 집행": ["예산 전용·이월 절차 준수","보조·출연금 목적 외 사용 여부","정산 잔액 회수 이행"],
 "자산·물품·재고": ["정기 재물조사 실시 여부","불용품 처리 절차 적정성","자산 등재 누락 점검"],
 "성과·평가 관리": ["성과지표 산정근거·실적 검증","경영평가 대응 지표 관리"],
 "인사·복무 관리": ["채용 절차 공정성·규정 준수","복무관리지침 준수(출장·근태)","겸직·영리행위 신고 관리"],
}
GENERIC = ("결과보고","특별 복무","명절","휴가철","연말연시","동절기","하계","을지연")


def aggregate():
    rows = list(csv.DictReader(open(CSV, encoding="utf-8-sig")))
    cohort = [r for r in rows if any(w in r["기관명"] for w in ENV)]
    def classify(t): return [n for n, kws in THEMES if any(k in t for k in kws)]
    theme = Counter(); dispo = Counter(); field = Counter(); org = Counter()
    ex = defaultdict(list); ex_orgs = defaultdict(set)
    for r in cohort:
        field[r["감사분야"]] += 1; org[r["기관명"]] += 1
        for k in r["처분키워드"].split(";"):
            if k: dispo[k] += 1
        t = r["지적제목"].strip()
        for n in classify(t):
            theme[n] += 1
            # 예시는 기관별로 분산(기관당 1건)해 벤치마크 성격을 살림
            if (len(ex[n]) < 3 and 8 <= len(t) <= 42
                    and r["기관명"] not in ex_orgs[n]
                    and not any(g in t for g in GENERIC)):
                ex[n].append({"org": r["기관명"], "title": t, "dispo": r["처분키워드"]})
                ex_orgs[n].add(r["기관명"])
    keco = [r for r in cohort if r["기관명"] == "한국환경공단"]
    keco_f = [{"year": r["연도"], "field": r["감사분야"], "title": r["지적제목"].strip(), "dispo": r["처분키워드"]}
              for r in keco if 8 <= len(r["지적제목"]) <= 60 and not any(g in r["지적제목"] for g in GENERIC)]
    return {"orgs": len(set(r["기관명"] for r in cohort)), "files": len(cohort),
            "field": field.most_common(), "dispo": dispo.most_common(9),
            "theme": theme.most_common(), "org_top": org.most_common(15),
            "ex": ex, "keco_count": len(keco), "keco_f": keco_f[:14]}


def bars(items, unit="건", accent="var(--series-1)"):
    mx = max(v for _, v in items) if items else 1
    out = ['<div class="bars">']
    for label, v in items:
        pct = max(2.0, v / mx * 100)
        out.append(
            f'<div class="row" title="{html.escape(str(label))}: {v}{unit}">'
            f'<div class="lab">{html.escape(str(label))}</div>'
            f'<div class="track"><div class="fill" style="width:{pct:.1f}%;background:{accent}"></div></div>'
            f'<div class="val">{v:,}</div></div>')
    out.append('</div>')
    return "\n".join(out)


def esc(s): return html.escape(str(s))


def build():
    d = aggregate()
    theme_names = [n for n, _ in d["theme"]]

    # 체크리스트 섹션
    checklist = []
    for name, cnt in d["theme"]:
        pts = CHECK.get(name, [])
        exs = d["ex"].get(name, [])
        li_pts = "".join(f"<li>{esc(p)}</li>" for p in pts)
        li_ex = "".join(
            f'<div class="ex"><span class="exorg">{esc(e["org"])}</span> {esc(e["title"])}'
            + (f' <span class="tag">{esc(e["dispo"].split(";")[0])}</span>' if e["dispo"] else "")
            + "</div>" for e in exs[:3])
        checklist.append(f'''
      <div class="card">
        <div class="chead"><span class="cnt">{cnt:,}건</span><h3>{esc(name)}</h3></div>
        <div class="csub">사전점검 포인트</div>
        <ul>{li_pts}</ul>
        <div class="csub">동종기관 실제 지적 예시</div>
        {li_ex}
      </div>''')

    keco_rows = "".join(
        f'<tr><td>{esc(f["year"])}</td><td>{esc(f["field"])}</td>'
        f'<td>{esc(f["title"])}</td><td>{esc(f["dispo"])}</td></tr>' for f in d["keco_f"])

    field_map = {"종합감사": "종합", "특정감사": "특정", "복무감사": "복무", "성과감사": "성과", "재무감사": "재무"}
    field_items = [(field_map.get(k, k), v) for k, v in d["field"]]

    tpl = f'''<div class="viz-root">
<style>
  .viz-root{{color-scheme:light;--surface-1:#fcfcfb;--plane:#f9f9f7;--text-primary:#0b0b0b;
    --text-secondary:#52514e;--muted:#898781;--grid:#e1e0d9;--series-1:#2a78d6;
    --border:rgba(11,11,11,.10);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
    color:var(--text-primary);background:var(--plane);line-height:1.5;}}
  @media (prefers-color-scheme:dark){{:root:where(:not([data-theme="light"])) .viz-root{{
    color-scheme:dark;--surface-1:#1a1a19;--plane:#0d0d0d;--text-primary:#fff;
    --text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--series-1:#3987e5;
    --border:rgba(255,255,255,.10);}}}}
  :root[data-theme="dark"] .viz-root{{color-scheme:dark;--surface-1:#1a1a19;--plane:#0d0d0d;
    --text-primary:#fff;--text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;
    --series-1:#3987e5;--border:rgba(255,255,255,.10);}}
  .viz-root *{{box-sizing:border-box;}}
  .wrap{{max-width:960px;margin:0 auto;padding:32px 20px 64px;}}
  header h1{{font-size:1.7rem;margin:0 0 6px;letter-spacing:-.01em;}}
  header .sub{{color:var(--text-secondary);font-size:.95rem;margin-bottom:4px;}}
  header .meta{{color:var(--muted);font-size:.82rem;}}
  .tiles{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0 8px;}}
  @media(max-width:640px){{.tiles{{grid-template-columns:repeat(2,1fr);}}}}
  .tile{{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px;}}
  .tile .n{{font-size:1.9rem;font-weight:700;letter-spacing:-.02em;}}
  .tile .l{{color:var(--text-secondary);font-size:.8rem;margin-top:2px;}}
  section{{margin-top:36px;}}
  section>h2{{font-size:1.15rem;margin:0 0 4px;}}
  section>.note{{color:var(--text-secondary);font-size:.85rem;margin:0 0 16px;}}
  .panel{{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:20px;}}
  .bars .row{{display:grid;grid-template-columns:150px 1fr 52px;align-items:center;gap:10px;
    padding:5px 0;font-size:.86rem;}}
  .bars .lab{{color:var(--text-secondary);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
  .bars .track{{background:var(--grid);border-radius:5px;height:16px;overflow:hidden;}}
  .bars .fill{{height:100%;border-radius:5px;}}
  .bars .val{{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;}}
  @media(max-width:640px){{.bars .row{{grid-template-columns:110px 1fr 44px;font-size:.8rem;}}}}
  .grid2{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
  @media(max-width:720px){{.grid2{{grid-template-columns:1fr;}}}}
  .cards{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
  @media(max-width:720px){{.cards{{grid-template-columns:1fr;}}}}
  .card{{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:18px;}}
  .chead{{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;}}
  .chead h3{{font-size:1rem;margin:0;}}
  .chead .cnt{{font-size:.78rem;font-weight:700;color:#fff;background:var(--series-1);
    padding:2px 8px;border-radius:20px;white-space:nowrap;}}
  .csub{{font-size:.74rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px;}}
  .card ul{{margin:0;padding-left:18px;font-size:.86rem;color:var(--text-primary);}}
  .card ul li{{margin:3px 0;}}
  .ex{{font-size:.82rem;color:var(--text-secondary);padding:4px 0;border-top:1px solid var(--grid);}}
  .ex:first-of-type{{border-top:none;}}
  .exorg{{color:var(--text-primary);font-weight:600;}}
  .tag{{font-size:.7rem;background:var(--grid);color:var(--text-secondary);padding:1px 6px;border-radius:10px;margin-left:4px;}}
  table{{width:100%;border-collapse:collapse;font-size:.84rem;}}
  th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--grid);vertical-align:top;}}
  th{{color:var(--muted);font-weight:600;font-size:.76rem;text-transform:uppercase;letter-spacing:.03em;}}
  td:first-child,td:nth-child(2){{white-space:nowrap;color:var(--text-secondary);}}
  .foot{{margin-top:40px;color:var(--muted);font-size:.78rem;border-top:1px solid var(--grid);padding-top:16px;}}
</style>
<div class="wrap">
  <header>
    <h1>환경·에너지 공공기관 자체감사 지적 벤치마크</h1>
    <div class="sub">동종기관의 반복 지적을 근거로 한국환경공단이 미리 점검할 항목을 정리한 리포트</div>
    <div class="meta">데이터: 공공감사포털(pap.go.kr) 자체감사결과 · 수집기간 2025.7~2026.7 · 환경/에너지 {d["orgs"]}개 기관</div>
  </header>

  <div class="tiles">
    <div class="tile"><div class="n">{d["orgs"]}</div><div class="l">환경·에너지 기관</div></div>
    <div class="tile"><div class="n">{d["files"]:,}</div><div class="l">지적·첨부 건수</div></div>
    <div class="tile"><div class="n">{len(d["theme"])}</div><div class="l">반복 지적 주제</div></div>
    <div class="tile"><div class="n">{d["keco_count"]}</div><div class="l">한국환경공단 자체 지적</div></div>
  </div>

  <section>
    <h2>1. 어떤 주제가 반복해서 지적되나</h2>
    <p class="note">지적제목을 주제별로 분류한 건수(중복 주제 허용). 시설·공사·안전이 압도적으로 많습니다.</p>
    <div class="panel">{bars(d["theme"])}</div>
  </section>

  <section>
    <div class="grid2">
      <div>
        <h2 style="font-size:1.05rem">2. 처분 유형 분포</h2>
        <p class="note">통보·개선·주의 중심. 실제 징계로 이어진 건도 상당수.</p>
        <div class="panel">{bars(d["dispo"])}</div>
      </div>
      <div>
        <h2 style="font-size:1.05rem">3. 감사분야 분포</h2>
        <p class="note">종합감사에서 대부분의 지적이 나옵니다.</p>
        <div class="panel">{bars(field_items)}</div>
      </div>
    </div>
  </section>

  <section>
    <h2>4. 기관별 지적 건수 (상위 15)</h2>
    <p class="note">규모가 큰 기관일수록 지적 건수도 많습니다. 절대 건수이므로 규모 보정 없이 참고용.</p>
    <div class="panel">{bars(d["org_top"])}</div>
  </section>

  <section>
    <h2>5. 사전점검 체크리스트 (주제별)</h2>
    <p class="note">각 주제의 동종기관 실제 지적을 근거로, 한국환경공단이 미리 확인하면 좋을 점검 포인트입니다.</p>
    <div class="cards">{"".join(checklist)}</div>
  </section>

  <section>
    <h2>6. 한국환경공단 자체 지적 이력</h2>
    <p class="note">본 데이터에 포함된 한국환경공단 자체감사 지적 {d["keco_count"]}건 중 주요 항목.</p>
    <div class="panel" style="overflow-x:auto">
      <table>
        <thead><tr><th>연도</th><th>분야</th><th>지적제목</th><th>처분</th></tr></thead>
        <tbody>{keco_rows}</tbody>
      </table>
    </div>
  </section>

  <div class="foot">
    <b>방법론</b> · 마스터 인덱스(감사지적_마스터인덱스.csv)에서 기관명에 환경·에너지 키워드가 포함된 {d["orgs"]}개 기관을 추출.
    지적제목을 키워드 규칙으로 주제 분류(문서마다 여러 주제에 중복 집계 가능). 처분유형은 본문에서 추출한 키워드 기준.<br>
    <b>한계</b> · 지적제목 추출 커버리지 약 96%, 처분키워드 83% — 일부 서술형 보고서는 제목이 근사치일 수 있습니다. 기관별 건수는 규모 보정 없는 절대값입니다. 원문 확인은 자체감사결과 폴더의 해당 파일 참조.
  </div>
</div>
</div>'''
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(tpl)
    print(f"완료: {OUT}")
    print(f"  기관 {d['orgs']} · 건수 {d['files']} · 주제 {len(d['theme'])} · 환경공단 {d['keco_count']}")


if __name__ == "__main__":
    build()
