"""把留出集每题各路检索的完整排序存下来，供离线比较融合方式。

逐词那一路（v2，不受后端计分改动影响）存进 base_cache.json，重跑时复用；
只重新请求 v3 的 fuzzy / definition。

用法: python3 -I holdout_dump.py qa_items.json base_cache.json out.json [样本数]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from eval_holdout import load_questions
from eval_questions import baseline, phrase

DEPTH = 30


def main():
    qa_path, cache_path, out_path = sys.argv[1:4]
    sample = int(sys.argv[4]) if len(sys.argv) > 4 else 150
    cache = json.load(open(cache_path, encoding='utf-8')) if os.path.exists(cache_path) else {}
    out = []
    for n, q in enumerate(load_questions(qa_path, sample), 1):
        key = q['question']
        try:
            if key not in cache:
                window, _, lists = baseline(q['keywords'])
                cache[key] = {'window': window, 'lists': lists}
            row = dict(q, **cache[key])
            for mode in ('fuzzy', 'definition'):
                row[mode] = phrase(q['keywords'], mode, DEPTH)[0]
        except Exception as exc:
            print(f'[{n}] 跳过：{exc}', flush=True)
            continue
        out.append(row)
        if n % 25 == 0:
            print(f'{n} 题', flush=True)
    json.dump(cache, open(cache_path, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(out, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'存了 {len(out)} 题 → {out_path}')


if __name__ == '__main__':
    main()
