"""定位阅读两条路的召回评测：让模型凭自己的三藏知识定位章节，再读那一节。

两条路（都只用 /v3/tipitaka-chapters）：

- locate：模型说出 1–3 个章节名（巴利名）→ 按名字找（容错）→ 取最像的一个。
- choose：模型从全部 281 部书里选 1–2 部 → 看这部书的全部标题 → 选 1–3 章。

两条路之后一样：选中的章节太长（> LEAF_CHARS）就给模型看它下面的小节再选，最多 NARROW_ROUNDS 轮。
最终读的范围里有没有标准段落 = 命中。

题目与标准同 eval_holdout.py（问藏真实问题，标准 = 历次回答引用过的段落）。这个标准偏向现有的
关键词检索——引用本来就是检索找到的；定位找到的别的正确段落算不上命中，所以这里的命中率是下限。

模型用问藏自己的（DeepSeek，OpenAI 兼容接口），凭据读 backend/.env；回复按提示词缓存，重跑不花钱。

用法（在 agent-tuning/ 下）:
  python3 -I eval/recall/eval_navigate.py data/raw/recall/qa_items.json data/raw/recall/nav.json [样本数]
可选：--dump data/raw/recall/dump_exp4.json  与关键词检索（find）逐题对比
      --tuning  改跑调参集 11 题（标准 = 答案概念同时出现的段落，不依赖任何检索方法），
                此时第一个参数是调参集结果（eval_questions.py 的输出，取其中现状的窗口作对比）
"""
import concurrent.futures
import hashlib
import json
import os
import sys
import threading
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from eval_holdout import load_questions  # noqa: E402
from eval_questions import QUESTIONS, gold_set  # noqa: E402

API = os.environ.get('WIKIPALI_API', 'http://127.0.0.1:8000/api')
ENV_FILE = os.environ.get('LLM_ENV', os.path.join(os.path.dirname(__file__), '../../../backend/.env'))
CACHE_FILE = os.environ.get('LLM_CACHE', 'data/raw/recall/llm_cache.json')

LEAF_CHARS = 8000        # 一章超过这么多字符就往下选小节
NARROW_ROUNDS = 3
MAX_LIST_LINES = 400     # 给模型看的标题清单最多几行（多了按层级收浅）
WORKERS = 8
MIN_LOCATE_SCORE = 0.7   # 拼写差太多的容错命中不读（agent 看到 ≈拼写不同 也会先核对）

_cache_lock = threading.Lock()
_cache = {}


# ---------------------------------------------------------------------------
# 接口
# ---------------------------------------------------------------------------

def api_get(path, **params):
    url = f'{API}/{path}?' + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.load(resp)


def chapters(**params):
    rows, page = [], 1
    while True:
        body = api_get('v3/tipitaka-chapters', page=page, per_page=1000, **params)
        rows += body['data']
        if page >= body['meta']['last_page']:
            return rows
        page += 1


def book_list():
    rows = api_get('v2/book-title')['data']
    return rows['rows'] if isinstance(rows, dict) else rows


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------

def load_env():
    env = {}
    for line in open(ENV_FILE, encoding='utf-8'):
        key, sep, value = line.strip().partition('=')
        if sep and not key.startswith('#'):
            env[key.strip()] = value.strip().strip('"\'')
    return env


ENV = {}


def ask(system, user):
    """返回模型的 JSON 回复（dict）。同一提示词只问一次。"""
    key = hashlib.sha256((system + '\n\n' + user).encode()).hexdigest()
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    body = json.dumps({
        'model': ENV.get('DEEPSEEK_MODEL', 'deepseek-chat'),
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'response_format': {'type': 'json_object'},
        'temperature': 0,
    }).encode()
    base = ENV.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').rstrip('/')
    req = urllib.request.Request(f'{base}/chat/completions', data=body, headers={
        'Content-Type': 'application/json', 'Authorization': f'Bearer {ENV["DEEPSEEK_API_KEY"]}'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        text = json.load(resp)['choices'][0]['message']['content']
    try:
        answer = json.loads(text)
    except ValueError:
        answer = {}
    with _cache_lock:
        _cache[key] = answer
    return answer


SYSTEM = ('你是熟悉巴利三藏（CST 第六次结集版：根本典 mūla、义注 aṭṭhakathā、复注 ṭīkā 及其他典籍）的研究助手。'
          '任务只是**定位**：判断答案原文最可能在哪里。不要回答问题本身。只输出 JSON。')

LOCATE_PROMPT = '''问题：{question}

根据你对巴利三藏的了解，给出最可能直接记载答案的 1–3 个章节：可以是经、品、偈、本生、律的章节、论的章节。
- 用 CST 的巴利罗马转写章节名（如经名、品名、偈名），不要用 DN 16 这类编号。
- layer 写这一章属于 mula（根本典）、atthakatha（义注）、tika（复注）还是 anna（其他）。
  问题问的细节（人名、因缘、数目、词义解释）在根本典里通常没有、只在义注里有时，给义注的章节。
- 最有把握的排最前。

输出：{{"sources": [{{"name": "章节名", "layer": "mula"}}]}}'''

CHOOSE_BOOK_PROMPT = '''问题：{question}

下面是 WikiPali 收录的全部典籍（坐标、书名、分类标签）。选出最可能记载答案的 1–2 部，最有把握的排前。
问题问的细节（人名、因缘、数目、词义解释）在根本典里通常没有、只在义注里有时，选义注。

{books}

输出：{{"books": ["坐标", …]}}'''

CHOOSE_TITLE_PROMPT = '''问题：{question}

下面是《{work}》的标题目录（坐标、标题、〔中文译名〕、字符数，缩进表示层级）。
选出最可能记载答案的 1–3 个标题，最有把握的排前。选得越具体（越小的小节）越好。

{titles}

输出：{{"titles": ["坐标", …]}}'''


# ---------------------------------------------------------------------------
# 两条路
# ---------------------------------------------------------------------------

def title_lines(rows):
    base = min(r['level'] for r in rows)
    out = []
    for r in rows:
        zh = next((t['title'] for t in r['translations'] if t['lang'].startswith('zh')), '')
        out.append(f"{'  ' * (r['level'] - base)}{r['book']}:{r['para']}  {r['title']}"
                   + (f'  〔{zh}〕' if zh else '') + f"  {r['chars']}")
    return out


def subtree(book, para, below=None):
    """一章下面的标题，清单太长就按层级收浅。below 给定时只要比它深的。"""
    rows = chapters(book=book, para=para)
    if below is not None:
        rows = [r for r in rows if r['level'] > below] or rows
    level = max((r['level'] for r in rows), default=1)
    while len(rows) > MAX_LIST_LINES and level > 1:
        level -= 1
        rows = [r for r in rows if r['level'] <= level or (r['book'], r['para']) == (book, para)]
    return rows


def pick(rows, coords, limit):
    by_coord = {f"{r['book']}:{r['para']}": r for r in rows}
    picked = []
    for c in coords or []:
        r = by_coord.get(str(c).strip())
        if r and r not in picked:
            picked.append(r)
    return picked[:limit]


def narrow(question, chosen, trace):
    """太长的章节往下选小节，直到每一节都 ≤ LEAF_CHARS 或没有小节。"""
    for _ in range(NARROW_ROUNDS):
        done, changed = [], False
        for ch in chosen:
            if ch['chars'] <= LEAF_CHARS:
                done.append(ch)
                continue
            rows = subtree(ch['book'], ch['para'], below=ch['level'])
            rows = [r for r in rows if (r['book'], r['para']) != (ch['book'], ch['para'])]
            if not rows:
                done.append(ch)
                continue
            answer = ask(SYSTEM, CHOOSE_TITLE_PROMPT.format(question=question, work=ch['title'],
                                                            titles='\n'.join(title_lines(rows))))
            sub = pick(rows, answer.get('titles'), 2)
            trace.append({'narrow': f"{ch['book']}:{ch['para']}", 'to': [f"{r['book']}:{r['para']}" for r in sub]})
            if sub:
                done += sub
                changed = True
            else:
                done.append(ch)
        chosen = done
        if not changed:
            break
    return dedupe(chosen)


def dedupe(rows):
    """去掉重复的、以及被另一个已选章节整个包住的小节（读大的就读到了小的）。"""
    out = []
    for r in sorted(rows, key=lambda r: -r['paragraphs']):
        inside = any(o['book'] == r['book'] and o['para'] <= r['para'] < o['para'] + max(1, o['paragraphs'])
                     for o in out)
        if not inside:
            out.append(r)
    return out


def route_locate(question, trace):
    answer = ask(SYSTEM, LOCATE_PROMPT.format(question=question))
    chosen = []
    for src in (answer.get('sources') or [])[:3]:
        name = str(src.get('name') or '').strip()
        if not name:
            continue
        layer = src.get('layer') if src.get('layer') in ('mula', 'atthakatha', 'tika', 'anna') else None
        hits = api_get('v3/tipitaka-chapters', q=name, layer=layer, per_page=1)['data']
        if not hits and layer:
            hits = api_get('v3/tipitaka-chapters', q=name, per_page=1)['data']
        hits = [h for h in hits if h.get('score', 0) >= MIN_LOCATE_SCORE]
        trace.append({'name': name, 'layer': layer,
                      'hit': f"{hits[0]['book']}:{hits[0]['para']} {hits[0]['title']} ({hits[0].get('score')})" if hits else None})
        if hits and hits[0] not in chosen:
            chosen.append(hits[0])
    return chosen


BOOKS_TEXT = None


def books_text():
    global BOOKS_TEXT
    if BOOKS_TEXT is None:
        lines = []
        for b in book_list():
            title = b.get('toc') or b.get('title')
            tags = [t for t in b.get('tags') or [] if t.lower() != str(b.get('title')).lower()]
            lines.append(f"{b['book']}:{b['paragraph']}  {title}  [{', '.join(tags)}]")
        BOOKS_TEXT = '\n'.join(lines)
    return BOOKS_TEXT


def route_choose(question, trace):
    answer = ask(SYSTEM, CHOOSE_BOOK_PROMPT.format(question=question, books=books_text()))
    chosen = []
    for coord in (answer.get('books') or [])[:2]:
        try:
            book, para = (int(x) for x in str(coord).split(':'))
        except ValueError:
            continue
        rows = subtree(book, para)
        if not rows:
            continue
        titles = ask(SYSTEM, CHOOSE_TITLE_PROMPT.format(question=question, work=rows[0]['title'],
                                                       titles='\n'.join(title_lines(rows))))
        sub = pick(rows, titles.get('titles'), 3)
        trace.append({'book': f'{book}:{para} {rows[0]["title"]}', 'titles': [f"{r['book']}:{r['para']} {r['title']}" for r in sub]})
        chosen += [r for r in sub if r not in chosen]
    return chosen


# ---------------------------------------------------------------------------
# 评分
# ---------------------------------------------------------------------------

def covers(ranges, coord):
    book, para = (int(x) for x in coord.split('-'))
    return any(r['book'] == book and r['para'] <= para < r['para'] + max(1, r['paragraphs']) for r in ranges)


def run_one(item, dump_row):
    result = {'question': item['question'], 'gold': item['gold']}
    for name, route in (('locate', route_locate), ('choose', route_choose)):
        trace = []
        try:
            first = route(item['question'], trace)
            final = narrow(item['question'], first, trace)
        except Exception as exc:  # 单题失败不拖垮整轮
            first, final = [], []
            trace.append({'error': repr(exc)})
        result[name] = {
            'chapter_hit': sum(covers(first, c) for c in item['gold']),
            'hit': sum(covers(final, c) for c in item['gold']),
            'chars': sum(r['chars'] for r in final),
            'read': [f"{r['book']}:{r['para']} {r['title']} ({r['chars']})" for r in final],
            'trace': trace,
        }
    if dump_row:
        gold = set(item['gold'])
        result['find_top3'] = sum(c in gold for c in dump_row['window'][:3])
        result['find_window'] = sum(c in gold for c in dump_row['window'])
    return result


def report(results):
    n = len(results)
    print(f'\n== 定位阅读（{n} 题；标准偏向关键词检索，命中率是下限）')
    for name in ('locate', 'choose'):
        rows = [r[name] for r in results]
        chars = sorted(r['chars'] for r in rows)
        print(f'{name:<7} 有命中的题 {sum(r["hit"] > 0 for r in rows):>3}   命中段 {sum(r["hit"] for r in rows):>4}'
              f'   （选章阶段就有命中的题 {sum(r["chapter_hit"] > 0 for r in rows):>3}）'
              f'   读的字符 中位 {chars[n // 2]}，90% {chars[int(n * 0.9)]}')
    paired = [r for r in results if 'find_top3' in r]
    if paired:
        if len(paired) < n:
            print(f'（与 find 对比的只有 {len(paired)} 题：其余题在 find 的结果里没有）')
        results = paired
        top3 = [r['find_top3'] > 0 for r in results]
        print(f'find    前 3 段有命中的题 {sum(top3):>3}；窗口内有命中的题 {sum(r["find_window"] > 0 for r in results):>3}')
        for name in ('locate', 'choose'):
            nav = [r[name]['hit'] > 0 for r in results]
            gain = sum(v and not t for v, t in zip(nav, top3))
            print(f'find 前 3 段 + {name}：有命中的题 {sum(v or t for v, t in zip(nav, top3)):>3}（新增 {gain}）')
        both = [r['locate']['hit'] > 0 or r['choose']['hit'] > 0 for r in results]
        print(f'find 前 3 段 + 两条路：有命中的题 {sum(b or t for b, t in zip(both, top3)):>3}')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dump_path = sys.argv[sys.argv.index('--dump') + 1] if '--dump' in sys.argv else None
    if dump_path in args:
        args.remove(dump_path)
    qa_path, out_path = args[0], args[1]
    sample = int(args[2]) if len(args) > 2 else 150

    ENV.update(load_env())
    if os.path.exists(CACHE_FILE):
        _cache.update(json.load(open(CACHE_FILE, encoding='utf-8')))

    if '--tuning' in sys.argv:
        # 调参集：标准现算；现状的窗口取自 eval_questions.py 的输出（base_top 是逐词检索合并后的顺序）
        prior = {r['question']: r for r in json.load(open(qa_path, encoding='utf-8'))}
        items, dump = [], {}
        for question, _keywords, groups in QUESTIONS:
            if question not in prior:
                continue
            items.append({'question': question, 'gold': sorted(gold_set(groups))})
            dump[question] = {'window': prior[question]['base_top']}
    else:
        items = load_questions(qa_path, sample)
        dump = {r['question']: r for r in json.load(open(dump_path, encoding='utf-8'))} if dump_path else {}
    books_text()

    results = [None] * len(items)
    try:
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            futures = {pool.submit(run_one, it, dump.get(it['question'])): i for i, it in enumerate(items)}
            for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                results[futures[fut]] = fut.result()
                if done % 20 == 0:
                    print(f'  {done}/{len(items)}', file=sys.stderr)
    finally:
        with _cache_lock:
            json.dump(_cache, open(CACHE_FILE, 'w', encoding='utf-8'), ensure_ascii=False)

    json.dump(results, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    report(results)


if __name__ == '__main__':
    main()
