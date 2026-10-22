#!/bin/bash
cd "$(dirname "$0")"
mkdir -p out
pass=0; fail=0
for f in cpp/${1:-*}.cpp; do
  b=$(basename $f .cpp); in=cpp/$b.in; [ -f $in ] || in=/dev/null
  g++ -std=c++17 -w -o out/c_$b $f || { echo "BAD TEST $b"; continue; }
  exp=$(./out/c_$b < $in 2>&1)
  node -e "
const C=require('../src/cpp2py.js');const fs=require('fs');
const r=C.convert(fs.readFileSync('$f','utf8'));
fs.writeFileSync('out/$b.py',r.code);fs.writeFileSync('out/$b.pwarn',r.warnings.join('\n'));" || { echo "FAIL $b (convert)"; fail=$((fail+1)); continue; }
  got=$(python3 out/$b.py < $in 2>&1)
  if [ "$exp" == "$got" ]; then echo "ok   $b"; pass=$((pass+1)); else echo "FAIL $b (output)"; diff <(echo "$exp") <(echo "$got") | head -10; fail=$((fail+1)); fi
  [ -s out/$b.pwarn ] && { sed "s/^/     warn: /" out/$b.pwarn; echo; }
done
echo "passed $pass, failed $fail"
