import re
import sys
from collections import OrderedDict

with open('/home/user/data/_scripts/progress.log', encoding='utf-8') as f:
    lines = f.readlines()

page_done_idx = [i for i, l in enumerate(lines) if re.search(r'Page \d+ done', l)]
if not page_done_idx:
    print('no page done lines yet')
    sys.exit(0)

n = int(sys.argv[1]) if len(sys.argv) > 1 else 1  # how many recent pages to report
for offset in range(n, 0, -1):
    idx = len(page_done_idx) - offset
    if idx < 0:
        continue
    last = page_done_idx[idx]
    prev = page_done_idx[idx - 1] if idx >= 1 else -1
    segment = lines[prev + 1:last + 1]

    page_num_match = re.search(r'Page (\d+) done', segment[-1])
    page_num = page_num_match.group(1) if page_num_match else '?'

    insts = OrderedDict()
    cur = None
    for l in segment:
        m = re.search(r'Checking: (.+?) \| 조치사항 (\d+)건', l)
        if m:
            cur = m.group(1)
            insts.setdefault(cur, {'action_items': int(m.group(2)), 'files': []})
            continue
        m = re.search(r'SAVED: (.+?) \((\d+)B\) <- (.+?) \| (.+?) \| (\S+)', l)
        if m:
            fname, size, inst, subj, regdt = m.groups()
            key = f'{inst}_{subj}'
            if key not in insts:
                insts[key] = {'action_items': '?', 'files': []}
            insts[key]['files'].append(fname)
            insts[key]['regdt'] = regdt

    print(f'=== 페이지 {int(page_num)+1} 완료 ===')
    for key, v in insts.items():
        nfiles = len(v['files'])
        tag = f"{nfiles}개 파일" if nfiles else "파일 없음/스킵"
        regdt = v.get('regdt', '?')
        print(f"  - {key} [{regdt}] (조치사항 {v['action_items']}건) -> {tag}")
    print()
