"""对比 agent 现状（逐词 search-pali-wbw）与 v3 phrase（合并查询）在真实问题上的召回。

金标准：答案必须同时出现的几个概念，各自用 v2/case 展开词形、search-pali-wbw 取全部命中段落，取交集。
（只用 v2 逐词表，不经 OpenSearch，避免拿新接口给自己判卷。）

用法: python3 -I eval_questions.py out.json
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = os.environ.get('WIKIPALI_API', 'http://127.0.0.1:8000/api')
PER_KEYWORD = 8          # routing.py QUESTION_SEARCH_LIMIT[快速]
FULLTEXT = 3             # top_coords(…, 3)：快速模式读全文的段数
TOO_MANY_HITS = 1000     # 超过就补一次 bold=on

QUESTIONS = [
    ('佛陀在哪里初转法轮', ['dhammacakkappavattana', 'isipatana', 'migadāya'], ['dhammacakka', 'isipatana']),
    ('阿难尊者做佛陀的侍者有多少年', ['ānanda', 'upaṭṭhāka', 'parinibbāna'], ['=pañcavīsativassāni,pañcavīsativassāni,pañcavīsati,pañcavīsatiyā', 'upaṭṭhāka|upaṭṭhahati|upaṭṭhāti']),
    ('大迦叶尊者为什么受持头陀行', ['dhutaṅga', 'paṃsukūla', 'araññaka'], ['mahākassapa', 'dhutaṅga|dhutavāda|dhuta']),
    ('第一次结集在哪里举行，有多少位比库参加', ['saṅgīti', 'rājagaha', 'bhikkhu'], ['saṅgīti|saṅgāyati|saṅgāyana', '=sattapaṇṇiguhādvāre,sattapaṇṇiguhāyaṃ,sattapaṇṇiguhā,sattapaṇṇiguhāya,sattapaṇṇiguhaṃ']),
    ('舍利弗尊者原名叫什么', ['sāriputta', 'nāma'], ['sāriputta', 'upatissa']),
    ('五盖是哪五个', ['nīvaraṇa', 'kāmacchanda', 'byāpāda'], ['nīvaraṇa', 'kāmacchanda', 'vicikicchā']),
    ('七觉支里的择法觉支是什么意思', ['dhammavicayasambojjhaṅga', 'bojjhaṅga'], ['dhammavicayasambojjhaṅga!bold']),
    ('佛陀般涅槃前最后的教诫是什么', ['parinibbāna', 'appamāda', 'ovāda'], ['vayadhamma', 'saṅkhāra', 'appamāda']),
    ('迦絺那衣是什么，什么时候受', ['kaṭhina', 'cīvara', 'pavāraṇā'], ['kaṭhina', '=vassaṃvutthānaṃ,vassaṃvutthā,vassaṃvutthehi,vassaṃvuttho,vassaṃvutthassa,vassaṃvutthena']),
    ('四词共同出现的经文', ['uṭṭhānasampadā', 'ārakkhasampadā', 'kalyāṇamittatā'],
     ['uṭṭhānasampadā', 'ārakkhasampadā', 'kalyāṇamittatā', 'samajīvitā']),
    ('祇树给孤独园是怎么来的', ['anāthapiṇḍika', 'jetavana', 'ārāma'], ['jeta|jetavana', '=hiraññakoṭīhi,hiraññakoṭisanthārena,koṭisantharena,koṭisanthārena,hiraññakoṭipariccāgena,koṭisanthāraṃ']),
    ('缘起的十二支按顺序是哪些', ['paṭiccasamuppāda', 'avijjā', 'saṅkhāra'],
     ['avijjā', 'saṅkhāra', 'nāmarūpa', 'saḷāyatana', 'upādāna', 'jāti']),
]

_forms = {}


def get(path, **params):
    url = f'{API}/{path}?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=300) as resp:
        return json.load(resp)


def forms_of(lemma):
    if lemma not in _forms:
        rows = (get(f'v2/case/{urllib.parse.quote(lemma)}').get('data') or {}).get('rows') or []
        rows = [r for r in rows if r.get('case')]
        _forms[lemma] = [f['word'] for f in rows[0]['case'] if f.get('word')] if rows else []
    return _forms[lemma]


def wbw(lemma, limit, bold=False):
    forms = forms_of(lemma)
    if not forms:
        return [], 0
    params = {'key': ','.join(forms), 'limit': limit, 'offset': 0}
    if bold:
        params['bold'] = 'on'
    data = get('v2/search-pali-wbw', **params)['data']
    return [f"{r['book']}-{r['paragraph']}" for r in data['rows']], data['count']


def wbw_forms(forms, bold=False):
    params = {'key': ','.join(forms), 'limit': 20000, 'offset': 0}
    if bold:
        params['bold'] = 'on'
    return {f"{r['book']}-{r['paragraph']}" for r in get('v2/search-pali-wbw', **params)['data']['rows']}


def gold_set(groups):
    """每组一个概念：'a|b' 词根取并集、'=x,y' 直接给词形、'!bold' 只要黑体。组间取交集。"""
    sets = []
    for g in groups:
        spec, _, flag = g.partition('!')
        forms = []
        for part in spec.split('|'):
            forms += part[1:].split(',') if part.startswith('=') else forms_of(part)
        sets.append(wbw_forms(sorted(set(forms)), bold=(flag == 'bold')))
    return set.intersection(*sets) if sets else set()


def baseline(keywords):
    """routing.question_node：逐词检索、命中过多补黑体、轮流取 top 段读全文。"""
    per = []
    for kw in keywords:
        coords, count = wbw(kw, PER_KEYWORD)
        per.append(coords)
        if count > TOO_MANY_HITS:
            per.append(wbw(kw, PER_KEYWORD, bold=True)[0])
    window, order = [], []
    for i in range(max((len(c) for c in per), default=0)):
        for coords in per:
            if i < len(coords) and coords[i] not in order:
                order.append(coords[i])
    return order, order[:FULLTEXT], per


def phrase(keywords, mode, n):
    data = get('v3/search', q=' '.join(keywords), search_mode=mode, resource_type='tipitaka',
               granularity='paragraph', page_size=min(100, n))['data']
    return [h['_source'].get('related_id') for h in data['hits']['hits']], data['hits']['total']['value']


def rrf(lists, k=60):
    """Reciprocal Rank Fusion：各列表按名次给 1/(k+rank)，相加排序。"""
    score = {}
    for lst in lists:
        for rank, c in enumerate(lst, 1):
            score[c] = score.get(c, 0) + 1 / (k + rank)
    return sorted(score, key=lambda c: -score[c])


def first_rank(order, gold):
    for n, c in enumerate(order, 1):
        if c in gold:
            return n
    return None


GOOD_KEYWORDS = {
    '佛陀在哪里初转法轮': ['dhammacakka', 'isipatana'],
    '阿难尊者做佛陀的侍者有多少年': ['ānanda', 'upaṭṭhāka', 'pañcavīsati'],
    '大迦叶尊者为什么受持头陀行': ['mahākassapa', 'dhutaṅga'],
    '第一次结集在哪里举行，有多少位比库参加': ['saṅgīti', 'rājagaha', 'pañcasata'],
    '舍利弗尊者原名叫什么': ['sāriputta', 'upatissa'],
    '五盖是哪五个': ['nīvaraṇa', 'kāmacchanda', 'vicikicchā'],
    '七觉支里的择法觉支是什么意思': ['dhammavicayasambojjhaṅga'],
    '佛陀般涅槃前最后的教诫是什么': ['vayadhamma', 'saṅkhāra', 'appamāda'],
    '四词共同出现的经文': ['uṭṭhānasampadā', 'ārakkhasampadā', 'kalyāṇamittatā', 'samajīvitā'],
    '祇树给孤独园是怎么来的': ['jetavana', 'anāthapiṇḍika', 'hiraññakoṭi'],
    '缘起的十二支按顺序是哪些': ['avijjā', 'saṅkhāra', 'nāmarūpa', 'saḷāyatana'],
}


def main():
    report = []
    good = len(sys.argv) > 2 and sys.argv[2] == 'good'
    for question, keywords, groups in QUESTIONS:
        if good:
            if question not in GOOD_KEYWORDS:
                continue
            keywords = GOOD_KEYWORDS[question]
        if question.startswith('迦絺那'):
            continue
        gold = gold_set(groups)
        base_window, base_full, base_lists = baseline(keywords)
        n = len(base_window)
        row = {'question': question, 'keywords': keywords, 'gold_def': groups, 'gold': len(gold),
               'window': n, 'base_win': sum(c in gold for c in base_window),
               'base_top3': sum(c in gold for c in base_full), 'base_first': first_rank(base_window, gold)}
        lists = {}
        for mode in ('definition', 'fuzzy'):
            order, total = phrase(keywords, mode, max(n, 30))
            lists[mode] = order
            row[f'{mode}_win'] = sum(c in gold for c in order[:n])
            row[f'{mode}_top3'] = sum(c in gold for c in order[:FULLTEXT])
            row[f'{mode}_first'] = first_rank(order[:n], gold)
            row[f'{mode}_total'] = total
            row[f'{mode}_top'] = order[:5]
        fused_rrf = rrf(base_lists + [lists['fuzzy']])
        fused = base_window[:FULLTEXT] + [c for c in fused_rrf if c not in base_window[:FULLTEXT]]
        row['rrf_win'] = sum(c in gold for c in fused[:n])
        row['rrf_top3'] = sum(c in gold for c in fused[:FULLTEXT])
        row['rrf_first'] = first_rank(fused[:n], gold)
        row['base_top'] = base_window[:5]
        row['gold_sample'] = sorted(gold)[:8]
        report.append(row)
        print(f"{question[:16]:<18} 金{row['gold']:>4} 窗{n:>3} | 现状 窗内{row['base_win']:>2} 前3 {row['base_top3']} 首{row['base_first']}"
              f" | definition 窗内{row['definition_win']:>2} 前3 {row['definition_top3']} 首{row['definition_first']}"
              f" | fuzzy 窗内{row['fuzzy_win']:>2} 前3 {row['fuzzy_top3']} 首{row['fuzzy_first']}"
              f" | RRF 窗内{row['rrf_win']:>2} 前3 {row['rrf_top3']} 首{row['rrf_first']}", flush=True)
    for key in ('base', 'definition', 'fuzzy', 'rrf'):
        win = sum(r[f'{key}_win'] for r in report)
        top3 = sum(r[f'{key}_top3'] for r in report)
        covered = sum(1 for r in report if r[f'{key}_win'])
        print(f'合计 {key:<10} 窗内 {win:>3}  前3 {top3:>2}  有命中的题 {covered}')
    json.dump(report, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
