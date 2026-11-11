"""留出集回归：问藏真实问题，标准 = agent 历次回答里实际引用过的段落坐标。

- 排除调参用的 12 个问题；只取有引用、关键词 ≥2 个的问题；随机抽样（固定种子）。
- 关键词用该问题出现最多的 pali_terms 前 3 个（agent 当时的选择）。
- 标准偏向现状（引用本来就是现有检索找到的），新方法在这里持平即说明不倒退。

用法: python3 -I eval_holdout.py qa_items.json out.json [样本数]
"""
import collections
import json
import random
import re
import sys

sys.path.insert(0, __import__('os').path.dirname(__file__))
from eval_questions import FULLTEXT, QUESTIONS, baseline, phrase, rrf

TUNING_PREFIXES = tuple(q[:8] for q, _, _ in QUESTIONS) + ('迦絺那',)
METHODS = ('base', 'definition', 'fuzzy', 'rrf')


def load_questions(path, sample):
    items = json.load(open(path, encoding='utf-8'))
    by_q = collections.defaultdict(list)
    for it in items:
        by_q[re.sub(r'\s+', ' ', it['question'].strip())].append(it)
    pool = []
    for q, rows in by_q.items():
        if q.startswith(TUNING_PREFIXES) or len(q) < 4:
            continue
        cited = collections.Counter(c.replace(':', '-') for r in rows
                                    for c in re.findall(r'\[(\d+:\d+)\]', r.get('answer') or ''))
        terms = collections.Counter(tuple((r.get('pali_terms') or [])[:3]) for r in rows).most_common(1)
        keywords = [t.lower() for t in (terms[0][0] if terms else ()) if t]
        if cited and len(keywords) >= 2:
            pool.append({'question': q, 'keywords': keywords, 'gold': sorted(cited)})
    random.Random(20261111).shuffle(pool)
    return pool[:sample]


def main():
    qa_path, out_path = sys.argv[1], sys.argv[2]
    sample = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    questions = load_questions(qa_path, sample)
    report, errors = [], 0
    for n, q in enumerate(questions, 1):
        gold = set(q['gold'])
        try:
            window, _, lists = baseline(q['keywords'])
            size = max(len(window), 1)
            orders = {'base': window}
            for mode in ('definition', 'fuzzy'):
                orders[mode] = phrase(q['keywords'], mode, max(size, 30))[0]
            orders['rrf'] = rrf(lists + [orders['fuzzy'], orders['definition']])
        except Exception as exc:  # 单题失败不影响整体，计数后跳过
            errors += 1
            print(f'[{n}] 跳过 {q["question"][:20]}：{exc}', flush=True)
            continue
        row = dict(q, window=size)
        for m in METHODS:
            row[f'{m}_win'] = sum(c in gold for c in orders[m][:size])
            row[f'{m}_top3'] = sum(c in gold for c in orders[m][:FULLTEXT])
        report.append(row)
        print(f"[{n}] 金{len(gold):>3} 窗{size:>3} " + ' '.join(f"{m} {row[m + '_win']}/{row[m + '_top3']}" for m in METHODS)
              + f"  {q['question'][:24]}", flush=True)

    print(f'\n共 {len(report)} 题（跳过 {errors}）；每格「窗内命中 / 前3命中」合计，及相对现状的 更好/持平/更差 题数')
    for m in METHODS:
        win = sum(r[f'{m}_win'] for r in report)
        top3 = sum(r[f'{m}_top3'] for r in report)
        line = f'{m:<10} 窗内 {win:>4}  前3 {top3:>3}'
        if m != 'base':
            for key in ('win', 'top3'):
                better = sum(r[f'{m}_{key}'] > r[f'base_{key}'] for r in report)
                equal = sum(r[f'{m}_{key}'] == r[f'base_{key}'] for r in report)
                worse = sum(r[f'{m}_{key}'] < r[f'base_{key}'] for r in report)
                line += f'   [{key}] 好{better} 平{equal} 差{worse}'
        print(line)
    json.dump(report, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
