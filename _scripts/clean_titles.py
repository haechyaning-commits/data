#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""감사지적_마스터인덱스.csv의 '지적제목' 후처리 정리기.
   본문 규칙추출 과정에서 딸려온 처분·조치·양식 문구를 잘라내 제목을 깔끔하게 만든다.
   - 접두 처분라벨 제거: '현지시정 조치 사항 - …', '현지조치 사항 (1) …'
   - 꼬리 경계 제거: '…[신분상조치] 주의…', '… 소관부서/조치기관/관계부서 …'
   원본 문서 재파싱 없이 CSV 문자열만 다듬는다(마스킹 △☗ 등 원본 특성은 보존).
"""
import csv, re, os, sys

IDX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "감사지적_마스터인덱스.csv")

_LABELS = r"현지시정|현지조치|현지주의|현지처분|시정|주의|통보|개선|권고|경고|징계|문책|회수|환수"
PREFIX = re.compile(rf"^\s*(?:{_LABELS})(?:\s*조\s*치)?\s*사\s*항\s*(?:\(\s*\d+\s*\))?\s*[-–—:∼~]?\s*")
TAIL = re.compile(
    r"\s*(?:\[?\s*(?:신분상|행정상|재정상|경제상|기관경고|고발)\s*조\s*치|"
    r"소\s*관\s*부\s*서|소\s*관\s*기\s*관|소\s*관\s*팀|조\s*치\s*부\s*서|조\s*치\s*기\s*관|"
    r"조\s*치\s*기\s*한|처\s*분\s*요\s*구|판\s*단\s*기\s*준|관\s*계\s*부\s*서|관\s*련\s*부\s*서|주\s*관\s*부\s*서).*$")
BRK = re.compile(r"\[\s*(?:신분상|행정상|재정상|경제상)")


def clean_title(t):
    if not t:
        return t
    o = t
    t = PREFIX.sub("", t)
    t = BRK.split(t)[0]
    t = TAIL.sub("", t)
    t = re.sub(r"\s{3,}", " ", t).strip()
    t = re.sub(r"[\[\(\{,·:：\-\s]+$", "", t).strip()
    return t if len(t) >= 4 else o.strip()


def main():
    rows = list(csv.reader(open(IDX, encoding="utf-8-sig")))
    hdr = rows[0]
    ti = hdr.index("지적제목")
    n = 0
    for r in rows[1:]:
        c = clean_title(r[ti])
        if c != r[ti]:
            r[ti] = c
            n += 1
    with open(IDX, "w", encoding="utf-8-sig", newline="") as f:
        csv.writer(f).writerows(rows)
    print(f"지적제목 정리: {n}건 변경 / 전체 {len(rows)-1}")


if __name__ == "__main__":
    main()
