#!/bin/bash
# использование: run_py.sh [фильтр]
cd "$(dirname "$0")"
mkdir -p out
pass=0; fail=0
for f in py/${1:-*}.py; do
  b=$(basename $f .py); in=py/$b.in; [ -f $in ] || in=/dev/null
  node -e "
const C=require('../src/py2cpp.js');const fs=require('fs');
const r=C.convert(fs.readFileSync('$f','utf8'));
fs.writeFileSync('out/$b.cpp',r.code);fs.writeFileSync('out/$b.warn',r.warnings.join('\n'));" || { echo "FAIL $b (convert)"; fail=$((fail+1)); continue; }
  exp=$(python3 $f < $in 2>&1)
  if ! g++ -std=c++17 -w -o out/$b out/$b.cpp 2> out/$b.err; then echo "FAIL $b (compile)"; head -5 out/$b.err; fail=$((fail+1)); continue; fi
  got=$(./out/$b < $in 2>&1)
  if [ "$exp" == "$got" ]; then echo "ok   $b"; pass=$((pass+1)); else echo "FAIL $b (output)"; diff <(echo "$exp") <(echo "$got") | head -10; fail=$((fail+1)); fi
  [ -s out/$b.warn ] && { sed "s/^/     warn: /" out/$b.warn; echo; }
done
echo "passed $pass, failed $fail"
