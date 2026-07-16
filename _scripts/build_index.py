#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
공공감사포털 자체감사결과 마스터 인덱스 생성기.

전 파일에 대해 파일명 기반 메타데이터(기관/연도/감사분야/순번)를 100% 채우고,
가능한 경우 문서 본문에서 '지적제목'과 '처분키워드'를 추출해 덧붙인다.

지원 추출:
  - pdf  : PyMuPDF(fitz), 앞 2페이지
  - hwpx : zip + section XML의 <hp:t>
  - hwp  : olefile + BodyText 섹션 zlib 해제 + PARA_TEXT 레코드 디코딩
  - txt  : 그대로
결과: 저장소 루트에 감사지적_마스터인덱스.csv (UTF-8 with BOM, 엑셀 호환)
"""
import os, re, io, csv, sys, json, zlib, zipfile, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "자체감사결과")
OUT_CSV = os.path.join(ROOT, "감사지적_마스터인덱스.csv")
PROGRESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index_progress.log")

# ----- 파일명 파싱 -----
STEM_RE = re.compile(r"^(?P<org>.+?)_(?P<year>\d{4})년\s*(?P<field>[^(]+?)(?:\((?P<seq>\d+)\))?$")

def parse_stem(stem):
    part = None
    m_part = re.search(r"_조각\((\d+)\)$", stem)
    if m_part:
        part = int(m_part.group(1))
        stem = stem[: m_part.start()]
    m = STEM_RE.match(stem)
    if not m:
        return {"org": "", "year": "", "field": "", "seq": "", "part": part, "parsed": False}
    return {
        "org": m.group("org").strip(),
        "year": m.group("year"),
        "field": m.group("field").strip(),
        "seq": m.group("seq") or "",
        "part": part,
        "parsed": True,
    }

# ----- 처분키워드 분류 -----
DISPO_KEYWORDS = ["징계", "경징계", "중징계", "문책", "주의", "경고", "시정", "개선",
                  "권고", "통보", "고발", "수사의뢰", "변상", "환수", "회수", "재심의",
                  "인사자료", "현지조치", "모범사례"]

def classify_dispo(text):
    if not text:
        return ""
    found = [k for k in DISPO_KEYWORDS if k in text]
    # 중복 제거·순서 유지
    seen, out = set(), []
    for k in found:
        if k not in seen:
            seen.add(k); out.append(k)
    return ";".join(out)

# 정규화된 본문에서 "제 목 ... (다음 항목 라벨 전까지)"를 포착
STOP = r"소\s*관\s*부\s*서|조\s*치\s*부\s*서|관\s*련\s*부\s*서|소\s*관\s*팀|조\s*치\s*부\s*처|내\s*용|처\s*분\s*요\s*구|판\s*단\s*기\s*준|업\s*무\s*현\s*황"
TITLE_RE = re.compile(r"제\s*목\s*[:：]?\s*(.+?)\s*(?:" + STOP + r"|$)")
FINDING_SUFFIX = r"미흡|부적정|소홀|과다|누락|위반|지연|부당|미이행|불합리|부실|미비|초과|오류|불철저|방만|불투명"
FINDING_RE = re.compile(r"([가-힣A-Za-z0-9()\-·「」『』\s]{4,40}?(?:" + FINDING_SUFFIX + r"))")

def extract_title(text):
    if not text:
        return ""
    norm = re.sub(r"\s+", " ", text).strip()
    m = TITLE_RE.search(norm)
    if m:
        t = m.group(1).strip(" .:：]})")
        if 2 <= len(t) <= 200:
            return t
    # 지적제목 특유 어미로 핵심구 포착 (서술형 보고서 대응)
    m2 = FINDING_RE.search(norm)
    if m2:
        t = re.sub(r"^[가-힣]\.\s*|^\d+[).]\s*|^[□○◯▷▪·]\s*", "", m2.group(1)).strip()
        if 4 <= len(t) <= 60:
            return t
    # 제목 라벨이 없으면 첫 의미있는 줄
    for line in text.splitlines():
        s = re.sub(r"\s+", " ", line).strip(" .:：]}")
        if len(s) >= 4 and "목 차" not in s:
            return s[:60]
    return ""

# ----- PDF -----
def extract_pdf(path):
    import fitz
    doc = fitz.open(path)
    try:
        parts = []
        for i in range(min(2, doc.page_count)):
            parts.append(doc.load_page(i).get_text("text"))
        return "\n".join(parts)
    finally:
        doc.close()

# ----- HWPX -----
def extract_hwpx(path):
    out = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if re.search(r"Contents/section\d+\.xml$", n)]
        names.sort()
        for n in names[:2]:
            xml = z.read(n).decode("utf-8", "ignore")
            # <hp:t ...>텍스트</hp:t>
            for t in re.findall(r"<hp:t[^>]*>(.*?)</hp:t>", xml, re.S):
                t = re.sub(r"<[^>]+>", "", t)
                t = (t.replace("&lt;", "<").replace("&gt;", ">")
                       .replace("&amp;", "&").replace("&quot;", '"'))
                out.append(t)
            out.append("\n")
            if sum(len(x) for x in out) > 6000:
                break
    return "".join(out)

# ----- HWP (OLE binary) -----
INLINE_EXT_CTRL = set([1,2,3,4,5,6,7,8,9,11,12,14,15,16,17,18,19,20,21,22,23])

def _decode_para(rec):
    res = []; i = 0; n = len(rec)
    while i + 2 <= n:
        wc = rec[i] | (rec[i+1] << 8)
        if wc in (0, 10, 13):
            if wc in (10, 13):
                res.append("\n")
            i += 2
        elif wc < 32:
            i += 8 if wc in INLINE_EXT_CTRL else 2
        elif 0xD800 <= wc <= 0xDFFF:
            i += 2  # 잘못된 서로게이트 코드포인트 제거
        else:
            res.append(chr(wc)); i += 2
    return "".join(res)

def _section_text(data):
    out = []; i = 0; n = len(data)
    while i + 4 <= n:
        header = int.from_bytes(data[i:i+4], "little"); i += 4
        tag = header & 0x3FF
        size = (header >> 20) & 0xFFF
        if size == 0xFFF:
            size = int.from_bytes(data[i:i+4], "little"); i += 4
        rec = data[i:i+size]; i += size
        if tag == 67:  # HWPTAG_PARA_TEXT
            out.append(_decode_para(rec))
        if sum(len(x) for x in out) > 6000:
            break
    return "\n".join(out)

def extract_hwp(path):
    import olefile
    ole = olefile.OleFileIO(path)
    try:
        compressed = True
        if ole.exists("FileHeader"):
            fh = ole.openstream("FileHeader").read()
            if len(fh) > 37:
                compressed = bool(fh[36] & 0x01)
        secs = []
        for entry in ole.listdir():
            if len(entry) == 2 and entry[0] == "BodyText" and entry[1].startswith("Section"):
                secs.append(entry)
        secs.sort(key=lambda e: int(re.sub(r"\D", "", e[1]) or 0))
        texts = []
        for entry in secs[:2]:
            raw = ole.openstream(entry).read()
            if compressed:
                try:
                    raw = zlib.decompress(raw, -15)
                except Exception:
                    pass
            texts.append(_section_text(raw))
            if sum(len(t) for t in texts) > 6000:
                break
        return "\n".join(texts)
    finally:
        ole.close()

def extract_text(path, ext):
    try:
        if ext == "pdf":
            return extract_pdf(path)
        if ext == "hwpx":
            return extract_hwpx(path)
        if ext in ("hwp", "HWP"):
            return extract_hwp(path)
        if ext == "txt":
            with open(path, encoding="utf-8", errors="ignore") as f:
                return f.read(6000)
    except Exception as e:
        return f"__ERR__:{type(e).__name__}"
    return ""


def main():
    files = sorted(os.listdir(DATA_DIR))
    files = [f for f in files if not f.startswith(".")]
    total = len(files)
    rows = []
    err = 0
    with open(PROGRESS, "w") as pg:
        for idx, fname in enumerate(files, 1):
            path = os.path.join(DATA_DIR, fname)
            if not os.path.isfile(path):
                continue
            stem, dot, ext = fname.rpartition(".")
            if not dot:
                stem, ext = fname, ""
            meta = parse_stem(stem)
            size = os.path.getsize(path)
            title, dispo = "", ""
            is_part = meta["part"] is not None or ext == "part"
            if not is_part and ext.lower() in ("pdf", "hwpx", "hwp", "txt"):
                text = extract_text(path, ext.lower() if ext != "HWP" else "hwp")
                if text.startswith("__ERR__"):
                    err += 1
                else:
                    title = extract_title(text)
                    dispo = classify_dispo(text)
            rows.append({
                "기관명": meta["org"],
                "연도": meta["year"],
                "감사분야": meta["field"],
                "순번": meta["seq"],
                "지적제목": title,
                "처분키워드": dispo,
                "파일형식": ext,
                "파일크기(KB)": round(size / 1024, 1),
                "분할파일": "Y" if is_part else "",
                "파일명": fname,
            })
            if idx % 200 == 0 or idx == total:
                pg.write(f"{idx}/{total} 처리 (추출오류 {err})\n"); pg.flush()

    def clean(v):
        if isinstance(v, str):
            return v.encode("utf-8", "ignore").decode("utf-8")
        return v
    rows = [{k: clean(v) for k, v in r.items()} for r in rows]
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"완료: {len(rows)}행 -> {OUT_CSV} (추출오류 {err})")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--sample":
        # 샘플 검증: 각 형식 몇 개씩 추출 미리보기
        files = sorted(os.listdir(DATA_DIR))
        picks = {}
        for f in files:
            ext = f.rpartition(".")[2].lower()
            if ext in ("pdf", "hwpx", "hwp") and len(picks.get(ext, [])) < 2:
                picks.setdefault(ext, []).append(f)
        for ext, fs in picks.items():
            for f in fs:
                t = extract_text(os.path.join(DATA_DIR, f), ext)
                print(f"\n===== [{ext}] {f} =====")
                print(f"제목: {extract_title(t)!r}")
                print(f"처분: {classify_dispo(t)!r}")
                print("본문:", re.sub(r'\s+', ' ', t)[:200])
        sys.exit(0)
    main()
