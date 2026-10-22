#!/bin/bash
# Собирает index.html: вставляет движки из src/ в template.html
cd "$(dirname "$0")"
python3 - <<'P'
t = open('template.html', encoding='utf-8').read()
js = open('src/py2cpp.js', encoding='utf-8').read() + '\n' + open('src/cpp2py.js', encoding='utf-8').read()
js = js.replace("if (typeof module !== 'undefined') module.exports = PyToCpp;", '').replace("if (typeof module !== 'undefined') module.exports = CppToPy;", '')
assert '</script' not in js
open('index.html', 'w', encoding='utf-8').write(t.replace('/*__CONVERTERS__*/', js))
print('index.html собран')
P
