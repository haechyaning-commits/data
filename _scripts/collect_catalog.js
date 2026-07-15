// 카탈로그(CSV용) 메타데이터 수집 — 보고서 단위, filelist/다운로드 없음(목록 API만).
// 두 기간 모두: 자체감사파일2(2021-01-01~2025-07-06) + 자체감사결과(2025-07-07~2026-07-07)
const { proxyRequest } = require('./lib.js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'catalog.csv');
const PAGE_SIZE = 100;

function sanitize(s){ return s.replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim().slice(0,150); }
async function getJson(p, retries=4){
  for (let i=0;i<retries;i++){
    try{ const r=await proxyRequest('www.pap.go.kr',p,{headers:{Accept:'application/hal+json'}});
      if(r.status!==200) throw new Error('HTTP '+r.status); return JSON.parse(r.body.toString()); }
    catch(e){ if(i===retries-1) throw e; await new Promise(r=>setTimeout(r,700*(i+1))); }
  }
}
async function buildInstLookup(){
  const map=new Map();
  const r=await getJson('/api/instCd?size=3000&palaw1InstClsfCd=30');
  const list=(r._embedded&&r._embedded.instCdListDtoes)||[];
  for(const it of list) map.set(it.instCd,it.instNm);
  return map;
}
function csvCell(v){ v=(v==null?'':String(v)); return '"'+v.replace(/"/g,'""')+'"'; }

const RANGES = [
  { folder:'자체감사파일2', bgng:'20210101', end:'20250706' },
  { folder:'자체감사결과',   bgng:'20250707', end:'20260707' },
];

function pLimit(n){let a=0;const q=[];const nx=()=>{if(a>=n||!q.length)return;a++;const{fn,res,rej}=q.shift();fn().then(res,rej).finally(()=>{a--;nx();});};return fn=>new Promise((res,rej)=>{q.push({fn,res,rej});nx();});}

async function fetchPage(R, page){
  const params=new URLSearchParams({searchYmdBgng:R.bgng,searchYmdEnd:R.end,instNm:'',palawInstClsfCd:'30',size:String(PAGE_SIZE),index:'0',page:String(page)});
  const j=await getJson('/api/fdadPlanRslt?'+params);
  return j._embedded&&j._embedded.fdadPlanRsltListDtoes||[];
}

(async () => {
  const instLookup = await buildInstLookup();
  const rows = [];
  const header = ['폴더','파일명패턴','기관','연도','감사분야','감사사항명','감사시작일','감사종료일','등록일','처분종류','모범사례포함','조치사항수'];
  const limit = pLimit(8);
  for (const R of RANGES){
    const first=await getJson('/api/fdadPlanRslt?'+new URLSearchParams({searchYmdBgng:R.bgng,searchYmdEnd:R.end,instNm:'',palawInstClsfCd:'30',size:String(PAGE_SIZE),index:'0',page:'0'}));
    const total=first.page.totalElements;
    const nPages=Math.ceil(total/PAGE_SIZE);
    console.error(`${R.folder}: total ${total}, pages ${nPages}`);
    let done=0;
    const pages=await Promise.all(Array.from({length:nPages},(_,p)=>limit(async()=>{
      const list=await fetchPage(R,p); done++;
      if(done%20===0) console.error(`  ${R.folder}: ${done}/${nPages} pages`);
      return list;
    })));
    let got=0;
    for(const list of pages) for(const row of list){
      const instNm=row.instCdNm||instLookup.get(row.instCd)||row.instCd||'기관명미상';
      const base=sanitize(`${instNm}_${row.adYr}년 ${row.adFldNm}`);
      const kinds=new Set();
      for(const s of (row.subList||[])) if(s.dsprqKindList) s.dsprqKindList.split('ㆍ').forEach(k=>kinds.add(k.trim()));
      rows.push([R.folder, base, instNm, row.adYr, row.adFldNm, row.adMttrNm||'',
                 row.adBgngYmd||'', row.adEndYmd||'', row.frstRegDt||'',
                 [...kinds].join('; '), kinds.has('모범사례')?'Y':'N', (row.subList||[]).length]);
      got++;
    }
    console.error(`DONE ${R.folder}: ${got} reports (portal total ${total})`);
  }
  const csv=[header.map(csvCell).join(',')].concat(rows.map(r=>r.map(csvCell).join(','))).join('\r\n');
  fs.writeFileSync(OUT,'﻿'+csv);  // BOM for Excel 한글
  console.error(`WROTE ${rows.length} rows -> ${OUT}`);
})().catch(e=>{console.error('FATAL',e.stack);process.exit(1);});
