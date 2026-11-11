"""读到的原文里有没有答案：对每条检索路线读到的文本，用同一个模型判断，并要求给出证据句。

段落级的标准（回答引用过的坐标、概念同现的段落）对「定位阅读」不公平：定位读到的往往是
正确却从未被引用过的章节。这里换成同一把尺子量所有路线：

- find：关键词检索（逐词 + 合并融合）读全文的前 3 段
- locate / choose：eval_navigate.py 两条路最终读的章节

判官看问题与读到的文本（带句子 id），回答能否据此作答、给出证据句 id。证据 id 必须真在给它的
文本里，否则按「不能作答」算——防止判官凭记忆放水。读得越多越容易有答案，所以同时报读的字符数；
单路最多给判官 MAX_CHARS 字符（超出截断，相当于 agent 的上下文预算）。

用法（在 agent-tuning/ 下）:
  python3 -I eval/recall/eval_judge.py data/raw/recall/nav_holdout.json data/raw/recall/judge_holdout.json \
      --dump data/raw/recall/dump_exp4.json
  调参集：第一个参数换成 nav_tuning.json，--dump 换成 eval_final_good.json（取其中现状的前 3 段）
"""
import concurrent.futures
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import eval_navigate as nav  # noqa: E402

MAX_CHARS = 60000
FULLTEXT = int(os.environ.get('FIND_TOP', 3))   # find 读几段全文（问藏快速模式 3、深度模式 6）
_pali_channel = None

JUDGE_SYSTEM = ('你是严格的巴利文献审校。只根据给你的巴利原文判断，不用你自己的知识补充。只输出 JSON。')

JUDGE_PROMPT = '''问题：{question}

下面是检索到的巴利原文，每句前面是句子 id。只根据这些原文判断：能不能据此回答问题的核心（不要求面面俱到，
但答案的关键信息——人名、地名、数目、所问的定义或经文——必须在原文里明确出现）。

{text}

输出：{{"answerable": true 或 false, "evidence": ["能直接支撑答案的句子 id，最多 3 个"]}}'''


def pali_channel():
    global _pali_channel
    if _pali_channel is None:
        rows = nav.api_get('v2/channel', view='system', limit=500)['data']['rows']
        _pali_channel = next(r['uid'] for r in rows if r['name'] == '_System_Pali_VRI_')
    return _pali_channel


def reading(**params):
    """v3/tipitaka-reading 取巴利原文，逐句 (sid, text)，翻完游标。"""
    out, query = [], {'unit': 'para', 'page_size': 200, 'format': 'text', 'include': 'sentences', **params}
    while True:
        url = f'{nav.API}/v3/tipitaka-reading/{pali_channel()}?' + urllib.parse.urlencode(query)
        with urllib.request.urlopen(url, timeout=120) as resp:
            body = json.load(resp)
        for row in body['data']:
            for s in row.get('sentences') or []:
                text = (s.get('html') or '').strip()
                if text:
                    out.append((s['sid'], text))
        cursor = body['meta'].get('next_cursor')
        if not cursor:
            return out
        query['after'] = cursor


def chapter_text(coords):
    """coords: ['book:para 标题 (字符)'...] → 逐句列表。"""
    sentences = []
    for item in coords:
        book, para = item.split()[0].split(':')
        sentences += reading(book=book, chapter=para)
    return sentences


def para_text(coords):
    """coords: ['book-para', ...]（find 的段落）"""
    sentences = []
    for c in coords:
        book, para = c.split('-')
        sentences += reading(book=book, para=para)
    return sentences


def judge(question, sentences):
    lines, size = [], 0
    for sid, text in sentences:
        line = f'{sid}  {text}'
        if size + len(line) > MAX_CHARS:
            break
        lines.append(line)
        size += len(line)
    if not lines:
        return {'answerable': False, 'evidence': [], 'chars': 0}
    answer = nav.ask(JUDGE_SYSTEM, JUDGE_PROMPT.format(question=question, text='\n'.join(lines)))
    shown = {line.split()[0] for line in lines}
    evidence = [e for e in (answer.get('evidence') or []) if str(e) in shown]
    ok = bool(answer.get('answerable')) and bool(evidence)
    return {'answerable': ok, 'evidence': evidence, 'chars': size}


def run_one(row, find_coords):
    result = {'question': row['question']}
    try:
        result['find'] = judge(row['question'], para_text(find_coords[:FULLTEXT]))
        for name in ('locate', 'choose'):
            result[name] = judge(row['question'], chapter_text(row[name]['read']))
    except Exception as exc:  # 单题失败不拖垮整轮
        result['error'] = repr(exc)
    return result


def report(results):
    rows = [r for r in results if 'error' not in r]
    n = len(rows)
    print(f'\n== 读到的原文里有没有答案（{n} 题，同一判官，证据句须在原文里）')
    for name in ('find', 'locate', 'choose'):
        chars = sorted(r[name]['chars'] for r in rows)
        print(f'{name:<7} 可作答 {sum(r[name]["answerable"] for r in rows):>3} 题   读的字符 中位 {chars[n // 2]}')
    f = [r['find']['answerable'] for r in rows]
    for name in ('locate', 'choose'):
        v = [r[name]['answerable'] for r in rows]
        print(f'find + {name}：可作答 {sum(a or b for a, b in zip(f, v)):>3} 题（新增 {sum(b and not a for a, b in zip(f, v))}，'
              f'{name} 不如 find 的 {sum(a and not b for a, b in zip(f, v))}）')
    both = [r['locate']['answerable'] or r['choose']['answerable'] for r in rows]
    print(f'find + 两条路：可作答 {sum(a or b for a, b in zip(f, both)):>3} 题（新增 {sum(b and not a for a, b in zip(f, both))}）')
    errors = [r for r in results if 'error' in r]
    if errors:
        print(f'（{len(errors)} 题出错跳过：{errors[0]["error"][:120]}）')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dump_path = sys.argv[sys.argv.index('--dump') + 1]
    args.remove(dump_path)
    nav_path, out_path = args[0], args[1]

    nav.ENV.update(nav.load_env())
    if os.path.exists(nav.CACHE_FILE):
        nav._cache.update(json.load(open(nav.CACHE_FILE, encoding='utf-8')))

    rows = json.load(open(nav_path, encoding='utf-8'))
    dump = {r['question']: (r.get('window') or r.get('base_top') or []) for r in json.load(open(dump_path, encoding='utf-8'))}
    if any(isinstance(v, int) for v in dump.values()):  # eval_questions 的输出：window 是数字，顺序在 base_top
        dump = {r['question']: r['base_top'] for r in json.load(open(dump_path, encoding='utf-8'))}
    rows = [r for r in rows if r['question'] in dump]

    results = [None] * len(rows)
    try:
        with concurrent.futures.ThreadPoolExecutor(nav.WORKERS) as pool:
            futures = {pool.submit(run_one, r, dump[r['question']]): i for i, r in enumerate(rows)}
            for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                results[futures[fut]] = fut.result()
                if done % 20 == 0:
                    print(f'  {done}/{len(rows)}', file=sys.stderr)
    finally:
        with nav._cache_lock:
            json.dump(nav._cache, open(nav.CACHE_FILE, 'w', encoding='utf-8'), ensure_ascii=False)

    json.dump(results, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    report(results)


if __name__ == '__main__':
    main()
