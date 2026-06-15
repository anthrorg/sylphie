import json, glob, os, re

DATA='wiki/architecture/_data'
OUT='wiki/architecture'
DATE='2026-06-13'

def load_frag(f):
    raw=open(f,encoding='utf-8').read().strip()
    if raw.startswith('```'):
        raw=raw.strip('`'); raw=raw[raw.find('{'):raw.rfind('}')+1]
    try:
        return json.loads(raw)
    except Exception:
        # lenient: try to salvage minimal info
        return None

def dirof(p):
    # path relative to subsystem root-ish: group by parent dir
    parts=p.split('/')
    return '/'.join(parts[:-1]) if len(parts)>1 else '.'

def md_escape(s):
    return (s or '').replace('|','\|')

subs=sorted([d for d in os.listdir(DATA) if os.path.isdir(os.path.join(DATA,d))])
index_rows=[]
for sub in subs:
    frags=sorted(glob.glob(f'{DATA}/{sub}/*.json'))
    items=[]; bad=[]
    for f in frags:
        o=load_frag(f)
        if o is None:
            bad.append(os.path.basename(f)); continue
        items.append(o)
    items.sort(key=lambda o:o.get('path',''))
    # group by directory
    groups={}
    for o in items:
        groups.setdefault(dirof(o.get('path','')),[]).append(o)
    lines=[]
    lines.append(f'# {sub} — Architecture Reference')
    lines.append('')
    lines.append(f'> Living document. Last updated: {DATE}. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.')
    lines.append('')
    lines.append(f'**{len(items)} files** mapped' + (f' · {len(bad)} fragment(s) need re-read: {", ".join(bad)}' if bad else '') + '.')
    lines.append('')
    # risks collected
    risks=[(o.get('path',''),o.get('gotchas','')) for o in items if (o.get('gotchas') or '').strip()]
    lines.append('## File-by-file')
    lines.append('')
    for d in sorted(groups):
        lines.append(f'### `{d}/`')
        lines.append('')
        for o in groups[d]:
            p=o.get('path',''); base=p.split('/')[-1]
            lines.append(f'#### {base}')
            kind=o.get('kind','')
            role=o.get('role','')
            lines.append(f'*{kind}* — {role}' if kind else f'{role}')
            lines.append('')
            det=o.get('detail','')
            if det: lines.append(det); lines.append('')
            exp=o.get('exports') or []
            con=o.get('constants') or []
            dep=o.get('deps') or []
            got=(o.get('gotchas') or '').strip()
            if exp: lines.append(f'- **Exports:** {", ".join("`"+md_escape(e)+"`" for e in exp)}')
            if con: lines.append(f'- **Key constants:** {", ".join("`"+md_escape(c)+"`" for c in con)}')
            if dep: lines.append(f'- **Deps:** {", ".join("`"+md_escape(x)+"`" for x in dep)}')
            if got: lines.append(f'- **Gotchas:** {md_escape(got)}')
            lines.append('')
    lines.append('## Risks / stubs / TODOs')
    lines.append('')
    if risks:
        for p,g in risks:
            lines.append(f'- `{p}` — {md_escape(g)}')
    else:
        lines.append('- None flagged.')
    lines.append('')
    lines.append('## Change log')
    lines.append(f'- {DATE} — Initial auto-generated map ({len(items)} files read in full).')
    lines.append('')
    open(f'{OUT}/{sub}.md','w',encoding='utf-8').write('\n'.join(lines))
    index_rows.append((sub,len(items),len(bad),len(risks)))
    print(f'{sub:22} files={len(items):3} bad={len(bad)} risks={len(risks)}')

# add decision-making (already written separately) to index if present
dm=os.path.join(OUT,'decision-making.md')
print('\nINDEX rows:', len(index_rows))
