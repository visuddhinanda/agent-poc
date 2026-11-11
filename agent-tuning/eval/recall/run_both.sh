#!/bin/sh
# 调参集：依次跑 agent 原词与选对的词两组。
# 用法: eval/recall/run_both.sh <标签> [输出目录，默认 data/raw/recall]
set -e
D=$(dirname "$0")
OUT=${2:-data/raw/recall}
mkdir -p "$OUT"
echo "##### $1 / agent 原词"; python3 -I "$D/eval_questions.py" "$OUT/eval_$1_agent.json"
echo "##### $1 / 选对的词"; python3 -I "$D/eval_questions.py" "$OUT/eval_$1_good.json" good
