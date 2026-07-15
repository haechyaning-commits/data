#!/usr/bin/env python3
import re, csv, json
from collections import defaultdict
SC="/tmp/claude-0/-home-user-data/20e89fc1-55ac-5630-9066-4bd07f23dcd2/scratchpad"

# 1) 실제 파일명 파싱 → (folder, base, filename)
data=open(f"{SC}/files_main.z","rb").read()
re_part=re.compile(r"^(?P<base>.*)\(\d+\)_조각\(\d+\)\..+\.part$")
re_norm=re.compile(r"^(?P<base>.*)\(\d+\)\.[^.]+$")
files=[]  # (folder, base, name)
for rec in data.split(b"\x00"):
    if not rec: continue
    meta,path=rec.split(b"\t",1)
    p=path.decode("utf-8","surrogateescape")
    folder,name=p.split("/",1)
    m=re_part.match(name) or re_norm.match(name)
    if m: base=m.group("base")
    else: base=name.rsplit(".",1)[0]  # 번호 없는 단일첨부
    files.append((folder,base,name))
print("파일 수:",len(files))

# 2) 카탈로그(보고서) 로드 → (folder,base) -> [reports]
lab={"자체감사결과":"자체감사결과","자체감사파일2":"자체감사파일2"}
reps=defaultdict(list)
for r in csv.DictReader(open(f"{SC}/catalog.csv",encoding="utf-8-sig")):
    reps[(r["폴더"], r["파일명패턴"])].append(r)

# 3) 다중성 분석
multi=sum(1 for k,v in reps.items() if len({x["감사사항명"] for x in v})>1)
print("보고서 그룹(고유 기관_연도_분야):",len(reps))
print("  그 중 서로 다른 감사가 2건 이상인 그룹:",multi)
# 파일이 어느 그룹에도 매칭 안되는 경우
nomatch=sum(1 for f,b,n in files if (f,b) not in reps)
print("카탈로그 매칭 실패 파일:",nomatch)

# 4) 파일-레벨 행 생성: 그룹 내 보고서들의 메타 병합
def merge(reports):
    subj=" / ".join(sorted({x["감사사항명"] for x in reports if x["감사사항명"]}))
    kinds=set()
    for x in reports:
        for k in x["처분종류"].split("; "):
            if k.strip(): kinds.add(k.strip())
    model="Y" if any(x["모범사례포함"]=="Y" for x in reports) else "N"
    r0=reports[0]
    return r0["기관"], r0["연도"], r0["감사분야"], subj, "; ".join(sorted(kinds)), model, len(reports)

REPO="https://github.com/haechyaning-commits/data/blob/main"
from urllib.parse import quote
rows=[]
for folder,base,name in files:
    reports=reps.get((folder,base))
    if reports:
        inst,yr,fld,subj,kinds,model,ncnt=merge(reports)
    else:
        inst,yr,fld,subj,kinds,model,ncnt="","","","","","N",0
    url=f"{REPO}/{quote(folder)}/{quote(name)}"
    rows.append([folder,name,inst,yr,fld,subj,kinds,model,url,ncnt])

# 정렬: 폴더, 파일명
rows.sort(key=lambda r:(r[0],r[1]))
print("파일-레벨 행:",len(rows))
print("  모범사례 파일:",sum(1 for r in rows if r[7]=="Y"))
print("  감사중복(2건+) 그룹의 파일:",sum(1 for r in rows if r[9]>1))

# 5) CSV
import io
with open(f"{SC}/catalog_files.csv","w",encoding="utf-8",newline="") as f:
    f.write("﻿")
    w=csv.writer(f)
    w.writerow(["폴더","파일명","기관","연도","감사분야","감사사항명","처분종류","모범사례포함","GitHub링크","감사중복수"])
    for r in rows: w.writerow(r)
print("CSV 저장:", f"{SC}/catalog_files.csv")

# 6) 뷰어용 컴팩트 JSON (링크는 folder+name으로 클라이언트서 조립)
lab2={"자체감사결과":"결과","자체감사파일2":"파일2"}
out=[[lab2[r[0]], r[1], r[2], r[3], r[4], r[5], r[6], 1 if r[7]=="Y" else 0] for r in rows]
json.dump(out, open(f"{SC}/files_data.json","w"), ensure_ascii=False, separators=(",",":"))
import os
print("뷰어 JSON:", round(os.path.getsize(f"{SC}/files_data.json")/1024/1024,2),"MB")
