"""离线比较融合方式（不发请求）。

用法: python3 -I fusion_offline.py dump.json [dump2.json …]
每个 dump 是 holdout_dump.py 的输出；对每个 dump 打印各融合方式相对现状的指标。
"""
import json
import sys

FULLTEXT = 3
K = 60


def rrf(weighted_lists):
    score = {}
    for weight, coords in weighted_lists:
        for rank, c in enumerate(coords, 1):
            score[c] = score.get(c, 0) + weight / (K + rank)
    return sorted(score, key=lambda c: -score[c])


def keep_head(base, fused, head=FULLTEXT):
    """前 head 段沿用现状排序，其余按融合结果补。"""
    top = base[:head]
    return top + [c for c in fused if c not in top]


def variants(row):
    base, lists = row['window'], row['lists']
    fz, df = row['fuzzy'], row['definition']
    eq = rrf([(1, lst) for lst in lists] + [(1, fz), (1, df)])
    out = {
        'base': base,
        'rrf 等权': eq,
        'rrf 合并×0.5': rrf([(1, lst) for lst in lists] + [(0.5, fz), (0.5, df)]),
        'rrf 合并×0.3': rrf([(1, lst) for lst in lists] + [(0.3, fz), (0.3, df)]),
        'rrf 仅fuzzy': rrf([(1, lst) for lst in lists] + [(1, fz)]),
        '保头部+等权': keep_head(base, eq),
        '保头部+仅fuzzy': keep_head(base, rrf([(1, lst) for lst in lists] + [(1, fz)])),
        '保头部+×0.5': keep_head(base, rrf([(1, lst) for lst in lists] + [(0.5, fz), (0.5, df)])),
    }
    return out


def report(path):
    rows = json.load(open(path, encoding='utf-8'))
    stats = {}
    for row in rows:
        gold = set(row['gold'])
        size = max(len(row['window']), 1)
        for name, order in variants(row).items():
            s = stats.setdefault(name, {'win': [], 'top3': []})
            s['win'].append(sum(c in gold for c in order[:size]))
            s['top3'].append(sum(c in gold for c in order[:FULLTEXT]))
    print(f'== {path.rsplit("/", 1)[-1]}（{len(rows)} 题）')
    base = stats['base']
    for name, s in stats.items():
        line = f'{name:<12} 窗内 {sum(s["win"]):>4}  前3 {sum(s["top3"]):>3}'
        if name != 'base':
            for key in ('win', 'top3'):
                pairs = list(zip(s[key], base[key]))
                good = sum(a > b for a, b in pairs)
                same = sum(a == b for a, b in pairs)
                bad = sum(a < b for a, b in pairs)
                line += f'   [{key}] 好{good:>3} 平{same:>3} 差{bad:>3}  好或平 {100 * (good + same) // len(pairs)}%'
        print(line)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        report(p)
