"""把 data/raw/mail/*/body.txt 里的问答条目抽成一个 JSON 列表，供留出集评测用。

输出含用户数据，放 data/raw/ 下（不提交）。
用法（在 agent-tuning/ 下）: python3 -I eval/recall/build_qa_items.py [输出路径，默认 data/raw/recall/qa_items.json]
"""
import glob
import json
import os
import sys


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'data/raw/recall/qa_items.json'
    items, bad = [], 0
    for path in sorted(glob.glob('data/raw/mail/*/body.txt')):
        try:
            report = json.load(open(path, encoding='utf-8'))
        except Exception:
            bad += 1
            continue
        for item in report.get('items', []):
            item['date'] = report.get('date')
            items.append(item)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(items, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
    questions = {i['question'].strip() for i in items}
    print(f'{len(items)} 条问答，{len(questions)} 个不同问题，跳过 {bad} 个无法解析的文件 → {out}')


if __name__ == '__main__':
    main()
