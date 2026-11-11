"""对比 v2 search-pali-wbw（词形 OR）与 v3 search definition 的召回与排序。

用法: python3 -I compare.py out.json lemma1 lemma2 ...
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = os.environ.get('WIKIPALI_API', 'http://127.0.0.1:8000/api')


def get(path, **params):
    url = f'{API}/{path}?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=300) as resp:
        return json.load(resp)


def forms_of(lemma):
    rows = (get(f'v2/case/{urllib.parse.quote(lemma)}').get('data') or {}).get('rows') or []
    rows = [r for r in rows if r.get('case')]
    if not rows:
        return []
    return [f['word'] for f in rows[0]['case'] if f.get('word')]


def old_set(forms, bold):
    params = {'key': ','.join(forms), 'limit': 20000, 'offset': 0}
    if bold:
        params['bold'] = 'on'
    data = get('v2/search-pali-wbw', **params)['data']
    return [f"{r['book']}-{r['paragraph']}" for r in data['rows']], data['count']


def new_list(query):
    out, page = [], 1
    while True:
        data = get('v3/search', q=query, search_mode='definition', resource_type='tipitaka',
                   granularity='paragraph', page_size=100, page=page)['data']
        hits = data['hits']['hits']
        total = data['hits']['total']['value']
        out += [(h['_source'].get('related_id'), h['_score']) for h in hits]
        if not hits or len(out) >= total or page * 100 >= 10000:
            return out, total
        page += 1


def main():
    out_path, lemmas = sys.argv[1], sys.argv[2:]
    report = []
    for lemma in lemmas:
        forms = forms_of(lemma)
        if not forms:
            print(f'{lemma}: 展不出词形，跳过')
            continue
        old_all, old_all_count = old_set(forms, bold=False)
        old_bold, old_bold_count = old_set(forms, bold=True)
        new, new_total = new_list(lemma)
        new_ids = [i for i, _ in new]
        new_set = set(new_ids)
        rank = {i: n for n, i in enumerate(new_ids)}
        r = len(old_bold)
        bold_in_top = sum(1 for p in old_bold if rank.get(p, 1 << 30) < r)
        row = {
            'lemma': lemma,
            'forms': len(forms),
            'old_all': len(old_all),
            'old_bold': len(old_bold),
            'new_total': new_total,
            'new_fetched': len(new_ids),
            'recall_all': len(set(old_all) & new_set) / max(1, len(old_all)),
            'recall_bold': len(set(old_bold) & new_set) / max(1, len(old_bold)),
            'bold_in_top_R': bold_in_top / max(1, r),
            'new_extra': len(new_set - set(old_all)),
            'missing_all': sorted(set(old_all) - new_set)[:15],
            'missing_bold': sorted(set(old_bold) - new_set)[:15],
            'bold_rank_positions': sorted(rank.get(p, -1) for p in old_bold)[:40],
            'new_top': new[:15],
            'old_bold_sample': old_bold[:15],
            'old_count_check': [old_all_count, old_bold_count],
        }
        report.append(row)
        print(f"{lemma:<14} 形{row['forms']:>4}  旧全部{row['old_all']:>6} 旧黑体{row['old_bold']:>5}"
              f"  新{row['new_total']:>6}  召回(全部){row['recall_all']:.1%}"
              f"  召回(黑体){row['recall_bold']:.1%}  黑体进前R {row['bold_in_top_R']:.1%}"
              f"  新多出{row['new_extra']}", flush=True)
    json.dump(report, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


main()
