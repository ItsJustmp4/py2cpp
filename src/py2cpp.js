/* ============================================================
 * Python → C++
 * Разбор по отступам в дерево блоков + разбор выражений (Pratt),
 * вывод типов, объявление переменных один раз, прототипы функций.
 * ============================================================ */
const PyToCpp = (() => {

  /* ---------- Токенизатор выражений Python ---------- */
  const PY_OPS = ['**=', '//=', '>>=', '<<=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '->', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}',
    ',', ':', '.', '&', '|', '^', '~', ';'];

  function decodePyString(body, raw) {
    if (raw) return body;
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== '\\') { out += c; continue; }
      const n = body[++i];
      const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
      if (n in map) out += map[n];
      else if (n === 'x') { out += String.fromCharCode(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
      else if (n === 'u') { out += String.fromCharCode(parseInt(body.substr(i + 1, 4), 16)); i += 4; }
      else if (n === '\n') { /* продолжение строки */ }
      else out += '\\' + n;
    }
    return out;
  }

  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\\') { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      // строки с префиксами (f, r, b, rf, fr ...)
      const pm = /^([rRbBfFuU]{0,2})("""|'''|"|')/.exec(src.slice(i));
      if (pm && (pm[1] === '' || /^[a-zA-Z]+$/.test(pm[1]))) {
        const prefix = pm[1].toLowerCase();
        const q = pm[2];
        let j = i + pm[0].length;
        let body = '';
        while (j < src.length && src.substr(j, q.length) !== q) {
          if (src[j] === '\\' && !prefix.includes('r')) { body += src[j] + src[j + 1]; j += 2; continue; }
          if (src[j] === '\\') { body += src[j] + (src[j + 1] || ''); j += 2; continue; }
          body += src[j++];
        }
        if (j >= src.length) throw new Error('незакрытая строка');
        j += q.length;
        toks.push({ t: prefix.includes('f') ? 'fstr' : 'str', v: prefix.includes('f') ? body : decodePyString(body, prefix.includes('r')), raw: prefix.includes('r') });
        i = j; continue;
      }
      const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?|\d[\d_]*\.)/.exec(src.slice(i));
      if (num && /[\d.]/.test(c) && num[0] !== '.') {
        const v = num[0].replace(/_/g, '');
        const isFloat = /[.eE]/.test(v) && !/^0[xX]/.test(v);
        toks.push({ t: 'num', v, isFloat });
        i += num[0].length; continue;
      }
      const id = /^[A-Za-z_\u0400-\u04FF][\w\u0400-\u04FF]*/.exec(src.slice(i));
      if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      const op = PY_OPS.find(o => src.startsWith(o, i));
      if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
      throw new Error('неизвестный символ «' + c + '»');
    }
    toks.push({ t: 'eof', v: '' });
    return toks;
  }

  /* ---------- Парсер выражений (Pratt) ---------- */
  class ExprParser {
    constructor(toks) { this.toks = toks; this.p = 0; }
    peek(o = 0) { return this.toks[this.p + o]; }
    next() { return this.toks[this.p++]; }
    is(v, o = 0) { const t = this.peek(o); return t && (t.t === 'op' || t.t === 'id') && t.v === v; }
    accept(v) { if (this.is(v)) { this.p++; return true; } return false; }
    expect(v) { if (!this.accept(v)) throw new Error('ожидалось «' + v + '», найдено «' + (this.peek().v || 'конец строки') + '»'); }
    atEnd() { return this.peek().t === 'eof'; }

    // список через запятую; одиночное выражение без запятой → само выражение
    exprList() {
      const first = this.expr();
      if (!this.is(',')) return first;
      const items = [first];
      while (this.accept(',')) { if (this.atEnd() || this.is(')') || this.is('=') || this.is(':')) break; items.push(this.expr()); }
      return { k: 'tuple', items };
    }
    expr() { return this.ternary(); }
    ternary() {
      if (this.is('lambda')) throw new Error('lambda не поддерживается');
      const a = this.or();
      if (this.is('if') ) {
        this.next();
        const c = this.or();
        this.expect('else');
        const b = this.ternary();
        return { k: 'ifexp', c, a, b };
      }
      return a;
    }
    or() { let l = this.and(); while (this.accept('or')) l = { k: 'logic', op: 'or', l, r: this.and() }; return l; }
    and() { let l = this.not(); while (this.accept('and')) l = { k: 'logic', op: 'and', l, r: this.not() }; return l; }
    not() { if (this.accept('not')) return { k: 'not', x: this.not() }; return this.cmp(); }
    cmp() {
      const first = this.bitor();
      const ops = [], items = [first];
      for (;;) {
        let op = null;
        const t = this.peek();
        if (t.t === 'op' && ['<', '>', '==', '!=', '<=', '>='].includes(t.v)) { op = t.v; this.next(); }
        else if (this.is('in')) { op = 'in'; this.next(); }
        else if (this.is('not') && this.is('in', 1)) { op = 'not in'; this.p += 2; }
        else if (this.is('is')) { this.next(); op = this.accept('not') ? '!=' : '=='; }
        if (!op) break;
        ops.push(op); items.push(this.bitor());
      }
      return ops.length ? { k: 'cmp', ops, items } : first;
    }
    binLevel(next, ops) {
      let l = next();
      for (;;) {
        const t = this.peek();
        if (t.t === 'op' && ops.includes(t.v)) { this.next(); l = { k: 'bin', op: t.v, l, r: next() }; }
        else return l;
      }
    }
    bitor() { return this.binLevel(() => this.bitxor(), ['|']); }
    bitxor() { return this.binLevel(() => this.bitand(), ['^']); }
    bitand() { return this.binLevel(() => this.shift(), ['&']); }
    shift() { return this.binLevel(() => this.arith(), ['<<', '>>']); }
    arith() { return this.binLevel(() => this.term(), ['+', '-']); }
    term() { return this.binLevel(() => this.unary(), ['*', '/', '//', '%']); }
    unary() {
      const t = this.peek();
      if (t.t === 'op' && ['-', '+', '~'].includes(t.v)) { this.next(); return { k: 'un', op: t.v, x: this.unary() }; }
      return this.power();
    }
    power() {
      const base = this.postfix();
      if (this.accept('**')) return { k: 'bin', op: '**', l: base, r: this.unary() };
      return base;
    }
    postfix() {
      let x = this.atom();
      for (;;) {
        if (this.accept('(')) {
          const args = [], kwargs = {};
          while (!this.is(')')) {
            if (this.peek().t === 'id' && this.is('=', 1)) { const n = this.next().v; this.next(); kwargs[n] = this.expr(); }
            else if (this.is('*')) throw new Error('распаковка *args не поддерживается');
            else args.push(this.expr());
            if (!this.accept(',')) break;
          }
          this.expect(')');
          x = { k: 'call', fn: x, args, kwargs };
        } else if (this.accept('[')) {
          if (this.is(':') || this.slicey()) {
            const part = () => (this.is(':') || this.is(']')) ? null : this.expr();
            const a = part(); this.expect(':');
            const b = part();
            let c = null;
            if (this.accept(':')) c = part();
            this.expect(']');
            x = { k: 'slice', obj: x, a, b, c };
            continue;
          }
          const idx = this.expr();
          this.expect(']');
          x = { k: 'index', obj: x, idx };
        } else if (this.accept('.')) {
          const n = this.next();
          if (n.t !== 'id') throw new Error('ожидалось имя после точки');
          x = { k: 'attr', obj: x, name: n.v };
        } else return x;
      }
    }
    slicey() { // есть ли ':' на верхнем уровне до ']'
      let d = 0;
      for (let i = this.p; i < this.toks.length; i++) {
        const t = this.toks[i];
        if (t.t !== 'op') continue;
        if ('([{'.includes(t.v)) d++;
        else if (')}'.includes(t.v)) d--;
        else if (t.v === ']') { if (d === 0) return false; d--; }
        else if (t.v === ':' && d === 0) return true;
      }
      return false;
    }
    atom() {
      const t = this.next();
      if (t.t === 'num') return { k: 'num', v: t.v, isFloat: t.isFloat };
      if (t.t === 'str' || t.t === 'fstr') {
        // склейка соседних строковых литералов
        let node = t.t === 'str' ? { k: 'str', v: t.v } : { k: 'fstr', parts: parseFString(t.v) };
        while (this.peek().t === 'str' || this.peek().t === 'fstr') {
          const n = this.next();
          const parts = (node.k === 'str' ? [node.v] : node.parts).concat(n.t === 'str' ? [n.v] : parseFString(n.v));
          node = parts.every(p => typeof p === 'string') ? { k: 'str', v: parts.join('') } : { k: 'fstr', parts };
        }
        return node;
      }
      if (t.t === 'id') {
        if (t.v === 'True' || t.v === 'False') return { k: 'bool', v: t.v === 'True' };
        if (t.v === 'None') return { k: 'none' };
        if (['lambda', 'yield', 'await'].includes(t.v)) throw new Error('«' + t.v + '» не поддерживается');
        return { k: 'name', v: t.v };
      }
      if (t.v === '(') {
        if (this.accept(')')) return { k: 'tuple', items: [] };
        const e = this.exprList();
        this.expect(')');
        return e.k === 'tuple' ? e : { k: 'paren', x: e };
      }
      if (t.v === '[') {
        const items = [];
        while (!this.is(']')) {
          items.push(this.expr());
          if (this.is('for')) throw new Error('генераторы списков не поддерживаются');
          if (!this.accept(',')) break;
        }
        this.expect(']');
        return { k: 'list', items };
      }
      if (t.v === '{') throw new Error('словари и множества не поддерживаются');
      throw new Error('неожиданный токен «' + (t.v || 'конец строки') + '»');
    }
  }

  function parseExpr(src) {
    const p = new ExprParser(tokenize(src));
    const e = p.exprList();
    if (!p.atEnd()) throw new Error('лишний текст: «' + p.peek().v + '»');
    return e;
  }

  // f"Привет, {name}! {x + 1:.2f}" → ['Привет, ', {expr, fmt}, '! ', ...]
  function parseFString(body) {
    const parts = [];
    let lit = '', i = 0;
    while (i < body.length) {
      const c = body[i];
      if (c === '{' && body[i + 1] === '{') { lit += '{'; i += 2; continue; }
      if (c === '}' && body[i + 1] === '}') { lit += '}'; i += 2; continue; }
      if (c === '{') {
        let d = 1, j = i + 1, inner = '';
        let q = null;
        while (j < body.length && d > 0) {
          const ch = body[j];
          if (q) { if (ch === q) q = null; }
          else if (ch === '"' || ch === "'") q = ch;
          else if (ch === '{' || ch === '[' || ch === '(') d++;
          else if (ch === '}' || ch === ']' || ch === ')') { d--; if (d === 0 && ch === '}') break; }
          inner += ch; j++;
        }
        if (lit) parts.push(decodePyString(lit)), lit = '';
        // формат-спецификатор после ':' на верхнем уровне
        let fmt = null, exprSrc = inner;
        let dd = 0;
        for (let k = 0; k < inner.length; k++) {
          const ch = inner[k];
          if ('([{'.includes(ch)) dd++; else if (')]}'.includes(ch)) dd--;
          else if (ch === '!' && dd === 0 && inner[k + 1] !== '=') { exprSrc = inner.slice(0, k); break; }
          else if (ch === ':' && dd === 0) { exprSrc = inner.slice(0, k); fmt = inner.slice(k + 1); break; }
        }
        if (exprSrc.trim().endsWith('=')) throw new Error('f-строки вида {x=} не поддерживаются');
        parts.push({ expr: parseExpr(exprSrc.trim()), fmt });
        i = j + 1; continue;
      }
      lit += c; i++;
    }
    if (lit) parts.push(decodePyString(lit));
    return parts;
  }

  /* ---------- Разбор строк в дерево блоков ---------- */
  function logicalLines(code) {
    // склеиваем строки внутри скобок/тройных кавычек и с переносом "\"
    const raw = code.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let buf = '', startLine = 0, depth = 0, inTriple = null;
    for (let n = 0; n < raw.length; n++) {
      const line = raw[n];
      if (!buf) startLine = n + 1;
      buf += (buf ? '\n' : '') + line;
      // обновляем глубину скобок по строке
      let q = inTriple ? inTriple : null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (q.length === 3 && line.startsWith(q, i)) { q = null; i += 2; }
          else if (q.length === 1 && c === '\\') i++;
          else if (q.length === 1 && c === q) q = null;
          continue;
        }
        if (c === '#') break;
        if (line.startsWith('"""', i) || line.startsWith("'''", i)) { q = line.substr(i, 3); i += 2; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
      }
      inTriple = q && q.length === 3 ? q : null;
      if (depth > 0 || inTriple || /\\\s*$/.test(line)) continue;
      out.push({ text: buf, line: startLine });
      buf = ''; depth = 0;
    }
    if (buf) out.push({ text: buf, line: startLine });
    return out;
  }

  // отделяет комментарий в конце строки (вне строк)
  function splitComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (q.length === 3 ? s.startsWith(q, i) : c === q) { if (q.length === 3) i += 2; q = null; }
        continue;
      }
      if (s.startsWith('"""', i) || s.startsWith("'''", i)) { q = s.substr(i, 3); i += 2; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '#') return [s.slice(0, i).trimEnd(), s.slice(i + 1).trim()];
    }
    return [s, null];
  }

  // ищет ':' блока на верхнем уровне (не внутри скобок/строк/лямбд/срезов)
  function findBlockColon(s) {
    let q = null, d = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === ':' && d === 0) return i;
    }
    return -1;
  }

  const BLOCK_KW = /^(def|if|elif|else|while|for|class|try|except|finally|with)\b/;

  function buildTreeShared(code) {
    const lines = logicalLines(code);
    const root = { body: [], indent: -1 };
    const stack = [root];
    const SEMI = /;(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/;
    for (const L of lines) {
      const [codePart, comment] = splitComment(L.text);
      const stripped = codePart.trim();
      const indent = L.text.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      if (!stripped) {
        if (comment !== null) {
          while (stack.length > 1 && indent <= stack[stack.length - 1].indent && stack[stack.length - 1].body.length) stack.pop();
          stack[stack.length - 1].body.push({ kind: 'comment', text: comment, line: L.line });
        } else {
          const top = stack[stack.length - 1];
          if (top.body.length && top.body[top.body.length - 1].kind !== 'blank') top.body.push({ kind: 'blank', line: L.line });
        }
        continue;
      }
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const parent = stack[stack.length - 1];
      if (BLOCK_KW.test(stripped)) {
        const ci = findBlockColon(stripped);
        if (ci < 0) { parent.body.push({ kind: 'stmt', text: stripped, line: L.line, comment, error: 'в конце строки пропущено двоеточие «:»' }); continue; }
        const node = { kind: 'block', head: stripped.slice(0, ci).trim(), body: [], line: L.line, indent, comment };
        const rest = stripped.slice(ci + 1).trim();
        parent.body.push(node);
        if (rest) {
          for (const part of rest.split(SEMI)) if (part.trim()) node.body.push({ kind: 'stmt', text: part.trim(), line: L.line });
        } else stack.push(node);
        continue;
      }
      const parts = stripped.split(SEMI).filter(p => p.trim());
      parts.forEach((part, idx) => parent.body.push({ kind: 'stmt', text: part.trim(), line: L.line, comment: idx === parts.length - 1 ? comment : null }));
    }
    return root.body;
  }

  /* ---------- Типы ---------- */
  const isNum = t => t === 'int' || t === 'double' || t === 'bool' || t === 'char';
  const isVec = t => /^vector<.*>$/.test(t || '');
  const elemOf = t => isVec(t) ? t.slice(7, -1) : (t === 'string' ? 'char' : 'auto');
  function unify(a, b) {
    if (!a || a === 'auto') return b || 'auto';
    if (!b || b === 'auto' || a === b) return a;
    if (isNum(a) && isNum(b)) return (a === 'double' || b === 'double') ? 'double' : 'int';
    if ((a === 'string' && b === 'char') || (a === 'char' && b === 'string')) return 'string';
    return a;
  }
  function annToType(a) {
    if (!a) return null;
    a = a.replace(/\s+/g, '');
    const m = /^(?:list|List)\[(.+)\]$/.exec(a);
    if (m) return 'vector<' + (annToType(m[1]) || 'int') + '>';
    return { int: 'int', float: 'double', str: 'string', bool: 'bool', list: 'vector<int>', None: 'void' }[a] || null;
  }

  /* ---------- Кодирование строк C++ ---------- */
  function cppStr(s) {
    let o = '"';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '"') o += '\\"';
      else if (ch === '\\') o += '\\\\';
      else if (ch === '\n') o += '\\n';
      else if (ch === '\t') o += '\\t';
      else if (ch === '\r') o += '\\r';
      else if (c < 32) o += '\\x' + c.toString(16).padStart(2, '0') + '""';
      else o += ch;
    }
    return o + '"';
  }
  function cppChar(s) {
    const m = { "'": "\\'", '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\0': '\\0' };
    return "'" + (m[s] || s) + "'";
  }

  /* ---------- Генератор ---------- */
  // приоритеты C++: чем больше, тем сильнее связывание
  const P = { assign: 1, tern: 2, or: 3, and: 4, bor: 5, bxor: 6, band: 7, eq: 8, rel: 9, shift: 10, add: 11, mul: 12, un: 13, post: 14, atom: 15 };
  const BIN_P = { '|': P.bor, '^': P.bxor, '&': P.band, '<<': P.shift, '>>': P.shift, '+': P.add, '-': P.add, '*': P.mul, '/': P.mul, '//': P.mul, '%': P.mul };
  const MATH_FN = { sqrt: 'sqrt', floor: 'floor', ceil: 'ceil', sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', log2: 'log2', log10: 'log10', exp: 'exp', fabs: 'fabs', pow: 'pow', atan: 'atan', atan2: 'atan2', asin: 'asin', acos: 'acos', hypot: 'hypot', trunc: 'trunc' };
  const MATH_CONST = { pi: 'M_PI', e: 'M_E', inf: 'INFINITY' };

  class Gen {
    constructor(passInfo) {
      this.warnings = [];
      this.helpers = new Set();
      this.includes = new Set(['iostream', 'string']);
      this.fnSigs = passInfo.fnSigs;          // name → {params:[{name,type}], ret}
      this.callTypes = passInfo.callTypes;    // name → [types по позициям]
      this.newCallTypes = {};
      this.newRet = {};
      this.globals = passInfo.globals;        // name → type (глобальные переменные)
      this.tmp = 0;
    }
    warn(line, msg) { const w = (line ? 'Строка ' + line + ': ' : '') + msg; if (!this.warnings.includes(w)) this.warnings.push(w); }
    need(inc) { this.includes.add(inc); }

    /* --- вывод типа выражения --- */
    typeOf(e, env) {
      switch (e.k) {
        case 'num': return e.isFloat ? 'double' : 'int';
        case 'str': return e.v.length === 1 && e.asChar ? 'char' : 'string';
        case 'fstr': return 'string';
        case 'bool': return 'bool';
        case 'none': return 'auto';
        case 'paren': return this.typeOf(e.x, env);
        case 'name': return env.vars[e.v] || this.globals[e.v] || 'auto';
        case 'list': {
          let t = 'auto';
          for (const it of e.items) t = unify(t, this.typeOf(it, env));
          return 'vector<' + (t === 'auto' ? 'int' : t) + '>';
        }
        case 'index': return elemOf(this.typeOf(e.obj, env));
        case 'slice': return this.typeOf(e.obj, env);
        case 'un': return this.typeOf(e.x, env) === 'double' ? 'double' : 'int';
        case 'not': case 'cmp': case 'logic': return e.k === 'logic' ? unify(this.typeOf(e.l, env), this.typeOf(e.r, env)) === 'bool' ? 'bool' : 'bool' : 'bool';
        case 'ifexp': return unify(this.typeOf(e.a, env), this.typeOf(e.b, env));
        case 'bin': {
          const a = this.typeOf(e.l, env), b = this.typeOf(e.r, env);
          if (e.op === '+' && (a === 'string' || b === 'string')) return 'string';
          if (e.op === '+' && isVec(a)) return a;
          if (e.op === '*' && (a === 'string' || b === 'string')) return 'string';
          if (e.op === '*' && (isVec(a) || isVec(b))) return isVec(a) ? a : b;
          if (e.op === '/') return 'double';
          if (e.op === '**') return (a === 'double' || b === 'double') ? 'double' : (a === 'auto' || b === 'auto' ? 'double' : 'int');
          if (a === 'double' || b === 'double') return 'double';
          if (a === 'auto' && b === 'auto') return 'auto';
          return 'int';
        }
        case 'tuple': return 'auto';
        case 'call': return this.callType(e, env);
        case 'attr': {
          if (e.obj.k === 'name' && e.obj.v === 'math' && MATH_CONST[e.name]) return 'double';
          return 'auto';
        }
      }
      return 'auto';
    }
    callType(e, env) {
      const f = e.fn;
      if (f.k === 'name') {
        const n = f.v;
        if (this.fnSigs[n]) return this.fnSigs[n].ret === 'void' ? 'void' : this.fnSigs[n].ret;
        const a0 = e.args[0] ? this.typeOf(e.args[0], env) : 'auto';
        switch (n) {
          case 'len': case 'int': case 'ord': return 'int';
          case 'float': return 'double';
          case 'str': case 'input': case 'chr': return n === 'chr' ? 'char' : 'string';
          case 'bool': return 'bool';
          case 'abs': return a0 === 'double' ? 'double' : 'int';
          case 'round': return e.args.length > 1 ? 'double' : 'int';
          case 'max': case 'min': {
            if (e.args.length === 1) return elemOf(a0);
            let t = 'auto'; for (const a of e.args) t = unify(t, this.typeOf(a, env)); return t;
          }
          case 'sum': return elemOf(a0) === 'double' ? 'double' : 'int';
          case 'sorted': case 'list': {
            if (e.args[0] && e.args[0].k === 'call' && e.args[0].fn.k === 'name' && e.args[0].fn.v === 'map') return this.mapType(e.args[0]);
            if (e.args[0] && e.args[0].k === 'call' && e.args[0].fn.k === 'name' && e.args[0].fn.v === 'range') return 'vector<int>';
            return a0 === 'string' ? 'vector<char>' : a0;
          }
          case 'pow': return 'double';
          case 'map': return this.mapType(e);
        }
        return 'auto';
      }
      if (f.k === 'attr') {
        const ot = this.typeOf(f.obj, env);
        if (f.obj.k === 'name' && f.obj.v === 'math') return ['floor', 'ceil', 'trunc'].includes(f.name) ? 'int' : 'double';
        if (ot === 'string') {
          if (['upper', 'lower', 'strip', 'lstrip', 'rstrip', 'replace', 'join', 'capitalize'].includes(f.name)) return 'string';
          if (['find', 'count', 'index'].includes(f.name)) return 'int';
          if (['isdigit', 'isalpha', 'startswith', 'endswith', 'isupper', 'islower', 'isspace'].includes(f.name)) return 'bool';
          if (f.name === 'split') return 'vector<string>';
        }
        if (ot === 'char' && ['isdigit', 'isalpha', 'isupper', 'islower', 'isspace'].includes(f.name)) return 'bool';
        if (ot === 'char' && ['upper', 'lower'].includes(f.name)) return 'char';
        if (f.obj.k === 'str' && f.name === 'join') return 'string';
        if (isVec(ot)) {
          if (f.name === 'pop') return elemOf(ot);
          if (['index', 'count'].includes(f.name)) return 'int';
        }
      }
      return 'auto';
    }
    mapType(m) {
      const fn = m.args[0];
      if (fn && fn.k === 'name') return 'vector<' + ({ int: 'int', float: 'double', str: 'string' }[fn.v] || 'int') + '>';
      return 'vector<int>';
    }

    /* --- генерация выражения: возвращает {c, p} --- */
    // можно ли доказать, что значение неотрицательно (тогда % и // совпадают с C++)
    nonNeg(e, env) {
      if (e.k === 'num') return true;
      if (e.k === 'paren') return this.nonNeg(e.x, env);
      if (e.k === 'name') return env.nonneg && env.nonneg.has(e.v);
      if (e.k === 'call' && e.fn.k === 'name' && e.fn.v === 'len') return true;
      if (e.k === 'bin' && ['+', '*', '//', '%'].includes(e.op)) return this.nonNeg(e.l, env) && this.nonNeg(e.r, env);
      return false;
    }
    wrap(r, minP) { return r.p < minP ? '(' + r.c + ')' : r.c; }
    ex(e, env, line) {
      const self = this;
      const E = (x, minP) => self.wrap(self.ex(x, env, line), minP);
      switch (e.k) {
        case 'num': {
          let v = e.v;
          if (/^0[oO]/.test(v)) v = '0' + v.slice(2);
          return { c: v, p: P.atom };
        }
        case 'str': return { c: e.asChar ? cppChar(e.v) : cppStr(e.v), p: P.atom };
        case 'fstr': return this.fstrConcat(e, env, line);
        case 'bool': return { c: e.v ? 'true' : 'false', p: P.atom };
        case 'none': this.warn(line, 'None заменён на 0'); return { c: '0', p: P.atom };
        case 'paren': return this.ex(e.x, env, line);
        case 'name': {
          if (e.v === 'math') { this.warn(line, 'модуль math используется как значение'); }
          else if (!(e.v in env.vars) && !(e.v in this.globals) && !env.declared.has(e.v) && !env.hoisted.has(e.v) && !this.fnSigs[e.v])
            this.warn(line, 'переменная «' + e.v + '» не определена');
          return { c: e.v, p: P.atom };
        }
        case 'list': {
          const lt = this.typeOf(e, env);
          if (!e.items.length) return { c: e.bare ? '{}' : lt + '{}', p: P.atom };
          return { c: (e.bare ? '' : lt) + '{' + e.items.map(x => E(x, P.assign + 1)).join(', ') + '}', p: P.atom };
        }
        case 'tuple': {
          this.warn(line, 'кортежи поддерживаются только в присваивании и for');
          return { c: '{' + e.items.map(x => E(x, P.assign + 1)).join(', ') + '}', p: P.atom };
        }
        case 'index': {
          const ot = this.typeOf(e.obj, env);
          const obj = E(e.obj, P.post);
          // отрицательный индекс a[-k] → a[a.size() - k]
          if (e.idx.k === 'un' && e.idx.op === '-' && e.idx.x.k === 'num') {
            if (e.idx.x.v === '1' && (isVec(ot) || ot === 'string')) return { c: obj + '.back()', p: P.post };
            return { c: obj + '[' + obj + '.size() - ' + e.idx.x.v + ']', p: P.post };
          }
          return { c: obj + '[' + E(e.idx, P.assign) + ']', p: P.post };
        }
        case 'slice': {
          this.helpers.add('slice');
          const ot = this.typeOf(e.obj, env);
          if (ot === 'auto') this.warn(line, 'срез объекта неизвестного типа');
          const o = e.obj.k === 'str' ? 'string(' + E(e.obj, P.assign) + ')' : E(e.obj, P.assign + 1);
          const part = x => x ? E(x, P.assign + 1) : 'PY_NONE';
          const args = [o, part(e.a), part(e.b)];
          if (e.c) args.push(E(e.c, P.assign + 1));
          return { c: 'py_slice(' + args.join(', ') + ')', p: P.post };
        }
        case 'un': return { c: e.op + E(e.x, P.un), p: P.un };
        case 'not': {
          const t = this.typeOf(e.x, env);
          if (t === 'string' || isVec(t)) return { c: E(e.x, P.post) + '.empty()', p: P.post };
          return { c: '!' + E(e.x, P.un), p: P.un };
        }
        case 'logic': {
          const op = e.op === 'and' ? '&&' : '||';
          const pp = e.op === 'and' ? P.and : P.or;
          return { c: this.wrap(this.truthy(e.l, env, line), pp) + ' ' + op + ' ' + this.wrap(this.truthy(e.r, env, line), pp + 1), p: pp };
        }
        case 'ifexp': return { c: this.wrap(this.truthy(e.c, env, line), P.tern + 1) + ' ? ' + E(e.a, P.tern + 1) + ' : ' + E(e.b, P.tern), p: P.tern };
        case 'cmp': {
          const parts = [];
          for (let i = 0; i < e.ops.length; i++) parts.push(this.cmpOne(e.ops[i], e.items[i], e.items[i + 1], env, line));
          if (parts.length === 1) return parts[0];
          return { c: parts.map(r => this.wrap(r, P.and + 1)).join(' && '), p: P.and };
        }
        case 'bin': return this.binary(e, env, line);
        case 'call': return this.call(e, env, line);
        case 'attr': {
          if (e.obj.k === 'name' && e.obj.v === 'math') {
            if (MATH_CONST[e.name]) { this.need('cmath'); return { c: MATH_CONST[e.name], p: P.atom }; }
            if (MATH_FN[e.name]) { this.need('cmath'); return { c: MATH_FN[e.name], p: P.atom }; }
          }
          this.warn(line, 'атрибут «.' + e.name + '» перенесён как есть');
          return { c: E(e.obj, P.post) + '.' + e.name, p: P.post };
        }
      }
      throw new Error('неподдерживаемое выражение');
    }

    // строковый литерал из одного символа рядом с char → символьный литерал
    charify(a, b, env) {
      if (a.k === 'str' && a.v.length === 1 && this.typeOf(b, env) === 'char') a = { ...a, asChar: true };
      return a;
    }
    cmpOne(op, l, r, env, line) {
      l = this.charify(l, r, env); r = this.charify(r, l, env);
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      if (op === 'in' || op === 'not in') {
        const rt = this.typeOf(r, env);
        const neg = op === 'not in';
        if (rt === 'string' || r.k === 'str') {
          const lhs = l.k === 'str' && l.v.length === 1 ? { ...l, asChar: true } : l;
          return { c: E(r, P.post) + '.find(' + E(lhs, P.assign) + ') ' + (neg ? '==' : '!=') + ' string::npos', p: P.eq };
        }
        this.need('algorithm');
        let coll = E(r, P.post);
        if (r.k === 'list' || r.k === 'tuple') {
          const t = this.typeOf({ k: 'list', items: r.items }, env);
          coll = t + '{' + r.items.map(x => E(x, P.assign + 1)).join(', ') + '}';
          const v = '_v' + (++this.tmp);
          // встроенный литерал: используем лямбду, чтобы не дублировать
          return { c: '[&]{ ' + t + ' ' + v + coll.slice(t.length) + '; return find(' + v + '.begin(), ' + v + '.end(), ' + E(l, P.assign) + ') ' + (neg ? '==' : '!=') + ' ' + v + '.end(); }()', p: P.post };
        }
        return { c: 'find(' + coll + '.begin(), ' + coll + '.end(), ' + E(l, P.assign) + ') ' + (neg ? '==' : '!=') + ' ' + coll + '.end()', p: P.eq };
      }
      const pp = (op === '==' || op === '!=') ? P.eq : P.rel;
      // x % k == 0 даёт одинаковый результат в C++ и Python — можно обычный %
      if ((op === '==' || op === '!=') && r.k === 'num' && r.v === '0' && l.k === 'bin' && l.op === '%') l = { ...l, plain: true };
      if ((op === '==' || op === '!=') && l.k === 'num' && l.v === '0' && r.k === 'bin' && r.op === '%') r = { ...r, plain: true };
      // сравнение двух строковых литералов
      let lc = E(l, pp), rc = E(r, pp + 1);
      if (l.k === 'str' && !l.asChar && (r.k === 'str' && !r.asChar)) lc = 'string(' + lc + ')';
      return { c: lc + ' ' + op + ' ' + rc, p: pp };
    }
    binary(e, env, line) {
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      const lt = this.typeOf(e.l, env), rt = this.typeOf(e.r, env);
      const op = e.op;
      if (op === '**') {
        this.need('cmath');
        const c = 'pow(' + E(e.l, P.assign) + ', ' + E(e.r, P.assign) + ')';
        if (lt !== 'double' && rt !== 'double' && lt !== 'auto' && rt !== 'auto') return { c: '(long long)' + c, p: P.un };
        return { c, p: P.post };
      }
      if (op === '/') {
        // в Python "/" всегда даёт дробное число
        if (lt !== 'double' && rt !== 'double') return { c: '(double)' + E(e.l, P.un) + ' / ' + E(e.r, P.mul + 1), p: P.mul };
        return { c: E(e.l, P.mul) + ' / ' + E(e.r, P.mul + 1), p: P.mul };
      }
      const nonneg = this.nonNeg(e.l, env) && this.nonNeg(e.r, env);
      if (op === '//') {
        if (lt === 'double' || rt === 'double') { this.need('cmath'); return { c: 'floor(' + E(e.l, P.assign) + ' / ' + E(e.r, P.mul + 1) + ')', p: P.post }; }
        if (nonneg) return { c: E(e.l, P.mul) + ' / ' + E(e.r, P.mul + 1), p: P.mul };
        this.helpers.add('floordiv');
        return { c: 'py_floordiv(' + E(e.l, P.assign) + ', ' + E(e.r, P.assign) + ')', p: P.post };
      }
      if (op === '%') {
        if (lt === 'double' || rt === 'double') { this.need('cmath'); return { c: 'fmod(' + E(e.l, P.assign) + ', ' + E(e.r, P.assign) + ')', p: P.post }; }
        if (nonneg || e.plain) return { c: E(e.l, P.mul) + ' % ' + E(e.r, P.mul + 1), p: P.mul };
        this.helpers.add('mod');
        return { c: 'py_mod(' + E(e.l, P.assign) + ', ' + E(e.r, P.assign) + ')', p: P.post };
      }
      if (op === '*' && (lt === 'string' || rt === 'string')) {
        this.helpers.add('strmul');
        const [s, n] = lt === 'string' ? [e.l, e.r] : [e.r, e.l];
        return { c: 'py_repeat(' + E(s, P.assign) + ', ' + E(n, P.assign) + ')', p: P.post };
      }
      if (op === '*' && (isVec(lt) || isVec(rt))) {
        const [v, n] = isVec(lt) ? [e.l, e.r] : [e.r, e.l];
        const vt = isVec(lt) ? lt : rt;
        if (v.k === 'list' && v.items.length === 1) return { c: vt + '(' + E(n, P.assign) + ', ' + E(v.items[0], P.assign) + ')', p: P.post };
        this.warn(line, 'умножение списка поддерживается только для [x] * n');
      }
      if (op === '+' && (lt === 'string' || rt === 'string')) {
        // "a" + "b" — оба литерала: оборачиваем левый в string(...)
        let l = this.charify(e.l, e.r, env), r = e.r;
        let lc = E(l, P.add), rc = E(r, P.add + 1);
        if (isNum(lt) && lt !== 'char') { this.helpers.add('str'); lc = 'py_str(' + lc + ')'; this.warn(line, 'число + строка: в Python это ошибка, добавлено преобразование'); }
        if (isNum(rt) && rt !== 'char') { this.helpers.add('str'); rc = 'py_str(' + rc + ')'; this.warn(line, 'строка + число: в Python это ошибка, добавлено преобразование'); }
        if ((e.l.k === 'str' || e.l.k === 'fstr' && false) && (e.r.k === 'str' || lt !== 'string')) lc = 'string(' + lc + ')';
        else if (e.l.k === 'str' && e.r.k === 'str') lc = 'string(' + lc + ')';
        return { c: lc + ' + ' + rc, p: P.add };
      }
      if (op === '+' && isVec(lt)) {
        this.helpers.add('vecadd');
        return { c: 'py_concat(' + E(e.l, P.assign) + ', ' + E(e.r, P.assign) + ')', p: P.post };
      }
      const pp = BIN_P[op];
      return { c: E(e.l, pp) + ' ' + op + ' ' + E(e.r, pp + 1), p: pp };
    }

    fstrConcat(e, env, line) {
      // f-строка вне print → конкатенация строк
      this.helpers.add('str');
      const pieces = e.parts.map(p => typeof p === 'string' ? cppStr(p) : this.fmtPiece(p, env, line, true));
      if (!pieces.length) return { c: 'string("")', p: P.post };
      if (typeof e.parts[0] === 'string') pieces[0] = 'string(' + pieces[0] + ')';
      return { c: pieces.join(' + '), p: pieces.length > 1 ? P.add : P.post };
    }
    fmtPiece(p, env, line, asString) {
      const t = this.typeOf(p.expr, env);
      const code = this.wrap(this.ex(p.expr, env, line), asString ? P.assign : P.shift + 1);
      if (p.fmt) {
        const m = /^([<>^]?)(\d*)(?:\.(\d+))?([fdsx%]?)$/.exec(p.fmt);
        if (m && m[3] !== undefined && (m[4] === 'f' || m[4] === '')) {
          this.helpers.add('fmt');
          return 'py_fixed(' + code + ', ' + m[3] + ')';
        }
        this.warn(line, 'формат «:' + p.fmt + '» в f-строке не поддерживается и пропущен');
      }
      if (asString) {
        if (t === 'string') return code;
        return 'py_str(' + code + ')';
      }
      if (t === 'bool') return '(' + code + ' ? "True" : "False")';
      if (t === 'double') { this.helpers.add('str'); return 'py_str(' + code + ')'; }
      if (isVec(t)) { this.helpers.add('printvec'); this.helpers.add('str'); }
      return code;
    }

    call(e, env, line) {
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      const A = () => e.args.map(a => E(a, P.assign + 1)).join(', ');
      const f = e.fn;
      if (f.k === 'name') {
        const n = f.v;
        const a0 = e.args[0];
        const t0 = a0 ? this.typeOf(a0, env) : 'auto';
        if (this.fnSigs[n]) {
          // запоминаем типы аргументов на месте вызова
          const types = e.args.map(a => this.typeOf(a, env));
          const prev = this.newCallTypes[n] || [];
          types.forEach((t, i) => { if (prev[i] && prev[i] !== 'auto' && t !== 'auto' && prev[i] !== t) this.warn(line, 'функция ' + n + '() вызывается с аргументами разных типов (' + prev[i] + ' и ' + t + ') — выбран общий тип'); });
          this.newCallTypes[n] = types.map((t, i) => unify(prev[i], t));
          return { c: this.fnSigs[n].cname + '(' + A() + ')', p: P.post };
        }
        switch (n) {
          case 'print': throw new Error('print() можно использовать только как отдельную инструкцию');
          case 'len': return { c: '(int)' + E(a0, P.post) + '.size()', p: P.un };
          case 'input': this.helpers.add('input'); return { c: 'py_input(' + (a0 ? E(a0, P.assign + 1) : '') + ')', p: P.post };
          case 'int':
            if (!a0) return { c: '0', p: P.atom };
            if (t0 === 'string') return { c: 'stoi(' + E(a0, P.assign + 1) + (e.args[1] ? ', nullptr, ' + E(e.args[1], P.assign + 1) : '') + ')', p: P.post };
            if (t0 === 'char') return { c: '(' + E(a0, P.add) + " - '0')", p: P.atom };
            if (t0 === 'auto') { this.helpers.add('toint'); return { c: 'py_int(' + E(a0, P.assign + 1) + ')', p: P.post }; }
            return { c: '(int)' + E(a0, P.un), p: P.un };
          case 'float':
            if (!a0) return { c: '0.0', p: P.atom };
            if (t0 === 'string') return { c: 'stod(' + E(a0, P.assign + 1) + ')', p: P.post };
            return { c: '(double)' + E(a0, P.un), p: P.un };
          case 'str':
            if (!a0) return { c: 'string()', p: P.post };
            if (t0 === 'string') return this.ex(a0, env, line);
            if (t0 === 'char') return { c: 'string(1, ' + E(a0, P.assign + 1) + ')', p: P.post };
            this.helpers.add('str'); return { c: 'py_str(' + E(a0, P.assign + 1) + ')', p: P.post };
          case 'bool': return { c: '(bool)' + E(a0, P.un), p: P.un };
          case 'abs': this.need('cmath'); return { c: 'abs(' + A() + ')', p: P.post };
          case 'round':
            this.need('cmath');
            if (e.args.length > 1) { this.warn(line, 'round(x, n) округляет по-другому, чем Python'); return { c: 'round(' + E(a0, P.assign) + ' * pow(10, ' + E(e.args[1], P.assign) + ')) / pow(10, ' + E(e.args[1], P.assign) + ')', p: P.mul }; }
            return { c: '(int)nearbyint(' + E(a0, P.assign) + ')', p: P.un };
          case 'ord': return { c: '(int)' + E(a0.k === 'str' ? { ...a0, asChar: true } : a0, P.un), p: P.un };
          case 'chr': return { c: '(char)' + E(a0, P.un), p: P.un };
          case 'pow': this.need('cmath'); return { c: 'pow(' + A() + ')', p: P.post };
          case 'max': case 'min': {
            this.need('algorithm');
            if (e.args.length === 1) return { c: '*' + n + '_element(' + E(a0, P.post) + '.begin(), ' + E(a0, P.post) + '.end())', p: P.un };
            const types = e.args.map(a => this.typeOf(a, env));
            let t = 'auto'; for (const x of types) t = unify(t, x);
            const args = e.args.map((a, i) => (t === 'double' && types[i] !== 'double') ? '(double)' + E(a, P.un) : E(a, P.assign + 1));
            if (args.length === 2) return { c: n + '(' + args.join(', ') + ')', p: P.post };
            return { c: n + '({' + args.join(', ') + '})', p: P.post };
          }
          case 'sum': {
            this.need('numeric');
            const zero = elemOf(t0) === 'double' ? '0.0' : '0';
            return { c: 'accumulate(' + E(a0, P.post) + '.begin(), ' + E(a0, P.post) + '.end(), ' + zero + ')', p: P.post };
          }
          case 'sorted': {
            this.helpers.add('sorted'); this.need('algorithm');
            const rev = e.kwargs.reverse ? ', ' + E(e.kwargs.reverse, P.assign + 1) : '';
            return { c: 'py_sorted(' + E(a0, P.assign + 1) + rev + ')', p: P.post };
          }
          case 'list': {
            if (a0 && a0.k === 'call' && a0.fn.k === 'name' && a0.fn.v === 'map') return this.ex(a0, env, line);
            if (a0 && a0.k === 'call' && a0.fn.k === 'name' && a0.fn.v === 'range') {
              this.helpers.add('range');
              return { c: 'py_range(' + a0.args.map(a => E(a, P.assign + 1)).join(', ') + ')', p: P.post };
            }
            if (t0 === 'string') return { c: 'vector<char>(' + E(a0, P.post) + '.begin(), ' + E(a0, P.post) + '.end())', p: P.post };
            return this.ex(a0, env, line);
          }
          case 'map': {
            // map(int, input().split()) → py_map_int(py_split(...))
            const fn = a0 && a0.k === 'name' ? a0.v : null;
            const src = e.args[1];
            if (fn && src) {
              this.helpers.add('split');
              const st = this.typeOf(src, env);
              const s = E(src, P.assign + 1);
              if (st !== 'vector<string>') this.warn(line, 'map() поддерживается для списка строк');
              if (fn === 'int') { this.helpers.add('mapint'); return { c: 'py_map_int(' + s + ')', p: P.post }; }
              if (fn === 'float') { this.helpers.add('mapfloat'); return { c: 'py_map_float(' + s + ')', p: P.post }; }
              if (fn === 'str') return { c: s, p: P.post };
            }
            throw new Error('map() поддерживается только как map(int, ...)');
          }
          case 'range': throw new Error('range() поддерживается только в for или list(range(...))');
          case 'enumerate': case 'zip': throw new Error(n + '() поддерживается только в цикле for');
          case 'isinstance': case 'type': case 'open': case 'dict': case 'set': case 'tuple':
            throw new Error(n + '() не поддерживается');
        }
        this.warn(line, 'неизвестная функция «' + n + '» перенесена как есть');
        return { c: n + '(' + A() + ')', p: P.post };
      }
      if (f.k === 'attr') {
        const obj = f.obj;
        if (obj.k === 'name' && obj.v === 'math') {
          this.need('cmath');
          if (MATH_FN[f.name]) {
            const c = MATH_FN[f.name] + '(' + A() + ')';
            if (['floor', 'ceil', 'trunc'].includes(f.name)) return { c: '(int)' + c, p: P.un };
            return { c, p: P.post };
          }
          if (f.name === 'gcd') { this.need('numeric'); return { c: 'gcd(' + A() + ')', p: P.post }; }
          if (f.name === 'factorial') { this.helpers.add('factorial'); return { c: 'py_factorial(' + A() + ')', p: P.post }; }
          if (f.name === 'isqrt') return { c: '(int)sqrt(' + A() + ')', p: P.un };
          throw new Error('math.' + f.name + ' не поддерживается');
        }
        const ot = this.typeOf(obj, env);
        const o = E(obj, P.post);
        const m = f.name;
        if (isVec(ot) || (ot === 'auto' && ['append', 'pop', 'insert', 'extend', 'sort', 'reverse', 'clear'].includes(m))) {
          if (ot === 'auto') this.warn(line, 'тип «' + o + '» неизвестен, считаю его списком');
          switch (m) {
            case 'append': return { c: o + '.push_back(' + A() + ')', p: P.post };
            case 'pop':
              if (!e.args.length) { this.helpers.add('pop'); return { c: 'py_pop(' + o + ')', p: P.post }; }
              this.helpers.add('popi'); return { c: 'py_pop(' + o + ', ' + A() + ')', p: P.post };
            case 'insert': return { c: o + '.insert(' + o + '.begin() + ' + E(e.args[0], P.add + 1) + ', ' + E(e.args[1], P.assign + 1) + ')', p: P.post };
            case 'extend': return { c: o + '.insert(' + o + '.end(), ' + E(e.args[0], P.post) + '.begin(), ' + E(e.args[0], P.post) + '.end())', p: P.post };
            case 'sort':
              this.need('algorithm');
              if (e.kwargs.reverse) return { c: 'sort(' + o + '.rbegin(), ' + o + '.rend())', p: P.post };
              return { c: 'sort(' + o + '.begin(), ' + o + '.end())', p: P.post };
            case 'reverse': this.need('algorithm'); return { c: 'reverse(' + o + '.begin(), ' + o + '.end())', p: P.post };
            case 'clear': return { c: o + '.clear()', p: P.post };
            case 'index': this.need('algorithm'); return { c: '(int)(find(' + o + '.begin(), ' + o + '.end(), ' + A() + ') - ' + o + '.begin())', p: P.un };
            case 'count': this.need('algorithm'); return { c: '(int)count(' + o + '.begin(), ' + o + '.end(), ' + A() + ')', p: P.un };
            case 'remove': this.need('algorithm'); return { c: o + '.erase(find(' + o + '.begin(), ' + o + '.end(), ' + A() + '))', p: P.post };
          }
        }
        if (ot === 'string' || ot === 'char' || obj.k === 'str') {
          const arg0 = e.args[0];
          switch (m) {
            case 'upper': case 'lower':
              if (ot === 'char') { this.need('cctype'); return { c: '(char)to' + m + '(' + o + ')', p: P.un }; }
              this.helpers.add(m); return { c: 'py_' + m + '(' + o + ')', p: P.post };
            case 'strip': case 'lstrip': case 'rstrip': this.helpers.add('strip'); return { c: 'py_' + m + '(' + o + ')', p: P.post };
            case 'split':
              this.helpers.add('split');
              return { c: 'py_split(' + o + (arg0 ? ', ' + E(arg0, P.assign + 1) : '') + ')', p: P.post };
            case 'join': this.helpers.add('join'); return { c: 'py_join(' + o + ', ' + E(arg0, P.assign + 1) + ')', p: P.post };
            case 'replace': this.helpers.add('replace'); return { c: 'py_replace(' + o + ', ' + A() + ')', p: P.post };
            case 'find': return { c: '(int)' + o + '.find(' + A() + ')', p: P.un };
            case 'startswith': return { c: o + '.rfind(' + A() + ', 0) == 0', p: P.eq };
            case 'endswith': this.helpers.add('endswith'); return { c: 'py_endswith(' + o + ', ' + A() + ')', p: P.post };
            case 'count': this.helpers.add('strcount'); return { c: 'py_count(' + o + ', ' + A() + ')', p: P.post };
            case 'isdigit': case 'isalpha': case 'isupper': case 'islower': case 'isspace':
              if (ot === 'char') { this.need('cctype'); return { c: '(bool)' + m + '((unsigned char)' + o + ')', p: P.un }; }
              this.helpers.add('strpred'); return { c: 'py_all(' + o + ', ' + m + ')', p: P.post };
          }
        }
        this.warn(line, 'метод «.' + m + '()» перенесён как есть');
        return { c: o + '.' + m + '(' + A() + ')', p: P.post };
      }
      this.warn(line, 'сложный вызов перенесён как есть');
      return { c: E(f, P.post) + '(' + A() + ')', p: P.post };
    }

    /* --- инструкции --- */
    // env: {vars: {name: type}, declared: Set, fn: {name, ret}|null, hoist: Map}
    block(nodes, env, ind) {
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.kind === 'blank') { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
        if (n.kind === 'comment') { out.push(ind + '// ' + n.text); continue; }
        try {
          if (n.kind === 'block') {
            const head = n.head;
            if (/^if\b/.test(head)) {
              // собираем цепочку if/elif/else
              let chain = [n];
              while (i + 1 < nodes.length) {
                let j = i + 1;
                while (j < nodes.length && (nodes[j].kind === 'blank' || nodes[j].kind === 'comment')) j++;
                if (j < nodes.length && nodes[j].kind === 'block' && /^(elif\b|else$)/.test(nodes[j].head)) { chain.push(nodes[j]); i = j; } else break;
              }
              out.push(...this.ifChain(chain, env, ind));
              continue;
            }
            if (/^(elif\b|else$)/.test(head)) throw new Error('«' + head.split(' ')[0] + '» без if');
            if (/^while\b/.test(head)) {
              const cond = this.cond(parseExpr(head.slice(5)), env, n.line);
              out.push(ind + 'while (' + cond + ') {' + this.tail(n));
              out.push(...this.body(n.body, env, ind + '    '));
              out.push(ind + '}');
              continue;
            }
            if (/^for\b/.test(head)) { out.push(...this.forLoop(n, env, ind)); continue; }
            if (/^def\b/.test(head)) throw new Error('вложенные функции не поддерживаются');
            const kw = head.split(/\s/)[0];
            throw new Error('конструкция «' + kw + '» не поддерживается');
          }
          out.push(...this.stmt(n, env, ind));
        } catch (err) {
          this.warn(n.line, err.message);
          const src = n.kind === 'block' ? n.head + ':' : n.text;
          out.push(ind + '// TODO (не сконвертировано): ' + src.split('\n').join(' '));
          if (n.kind === 'block') out.push(...this.commentOut(n.body, ind));
        }
      }
      return out;
    }
    commentOut(nodes, ind, depth = 1) {
      const out = [];
      const pad = ind + '// ' + '    '.repeat(depth);
      for (const n of nodes) {
        if (n.kind === 'blank') continue;
        if (n.kind === 'comment') { out.push(pad + '# ' + n.text); continue; }
        out.push(pad + (n.kind === 'block' ? n.head + ':' : n.text));
        if (n.kind === 'block') out.push(...this.commentOut(n.body, ind, depth + 1));
      }
      return out;
    }
    body(nodes, env, ind) {
      const b = this.block(nodes, env, ind);
      while (b.length && b[b.length - 1] === '') b.pop();
      return b;
    }
    tail(n) { return n.comment ? ' // ' + n.comment : ''; }
    cond(e, env, line) { return this.truthy(e, env, line).c; }
    // значение в логическом контексте: пустые строки/списки — ложь
    truthy(e, env, line) {
      const t = this.typeOf(e, env);
      if (t === 'string' || isVec(t)) return { c: '!' + this.wrap(this.ex(e, env, line), P.post) + '.empty()', p: P.un };
      return this.ex(e, env, line);
    }
    ifChain(chain, env, ind) {
      const out = [];
      chain.forEach((n, idx) => {
        let line;
        if (idx === 0) line = ind + 'if (' + this.cond(parseExpr(n.head.slice(2)), env, n.line) + ') {';
        else if (n.head === 'else') line = ind + '} else {';
        else line = ind + '} else if (' + this.cond(parseExpr(n.head.slice(4)), env, n.line) + ') {';
        out.push(line + this.tail(n));
        out.push(...this.body(n.body, env, ind + '    '));
      });
      out.push(ind + '}');
      return out;
    }
    loopVar(name, type, env) {
      // если переменная уже объявлена — используем её
      if (env.declared.has(name) || this.isGlobal(name, env)) return name;
      env.vars[name] = type;
      env.loopVars.add(name);
      return type + ' ' + name;
    }
    forLoop(n, env, ind) {
      const m = /^for\s+(.+?)\s+in\s+(.+)$/s.exec(n.head);
      if (!m) throw new Error('не удалось разобрать for');
      const target = m[1].trim();
      const it = parseExpr(m[2]);
      const out = [];
      const saved = { ...env.vars };
      const wasDeclared = new Set(env.declared);
      if (it.k === 'call' && it.fn.k === 'name' && it.fn.v === 'range') {
        if (!/^\w+$/.test(target)) throw new Error('в range() ожидается одна переменная');
        const a = it.args.map(x => this.ex(x, env, n.line));
        let start = '0', end, step = null;
        if (a.length === 1) end = a[0];
        else if (a.length === 2) { start = a[0].c; end = a[1]; }
        else { start = a[0].c; end = a[1]; step = it.args[2]; }
        const v = this.loopVar(target, 'int', env);
        const name = target;
        if (!env.nonneg) env.nonneg = new Set();
        const stepOk = !it.args[2] || it.args[2].k === 'num';
        const startOk = it.args.length === 1 || this.nonNeg(it.args[0], env);
        if (stepOk && startOk && !assignsTo(n.body, target)) env.nonneg.add(target); else env.nonneg.delete(target);
        let cmp = '<', inc = '++' + name;
        if (step) {
          const neg = step.k === 'un' && step.op === '-';
          const sc = this.ex(step, env, n.line).c;
          if (neg) { cmp = '>'; inc = name + ' -= ' + this.ex(step.x, env, n.line).c; }
          else if (step.k === 'num') inc = name + ' += ' + sc;
          else { this.warn(n.line, 'шаг range() не литерал — считаю его положительным'); inc = name + ' += ' + sc; }
        }
        out.push(ind + 'for (' + v + ' = ' + start + '; ' + name + ' ' + cmp + ' ' + this.wrap(end, P.rel + 1) + '; ' + inc + ') {' + this.tail(n));
      } else if (it.k === 'call' && it.fn.k === 'name' && it.fn.v === 'enumerate') {
        const tm = /^\(?\s*(\w+)\s*,\s*(\w+)\s*\)?$/.exec(target);
        if (!tm) throw new Error('enumerate: ожидается «for i, x in enumerate(...)»');
        const coll = this.ex(it.args[0], env, n.line);
        const ct = this.typeOf(it.args[0], env);
        const startV = it.args[1] ? this.ex(it.args[1], env, n.line).c : null;
        const iv = '_i' + (++this.tmp);
        const c = this.wrap(coll, P.post);
        out.push(ind + 'for (int ' + iv + ' = 0; ' + iv + ' < (int)' + c + '.size(); ++' + iv + ') {' + this.tail(n));
        const idx = this.loopVar(tm[1], 'int', env);
        out.push(ind + '    ' + idx + ' = ' + iv + (startV ? ' + ' + startV : '') + ';');
        const el = this.loopVar(tm[2], elemOf(ct) === 'auto' ? 'auto' : elemOf(ct), env);
        out.push(ind + '    ' + el + ' = ' + c + '[' + iv + '];');
      } else {
        if (!/^\w+$/.test(target)) throw new Error('распаковка в for поддерживается только для enumerate()');
        const ct = this.typeOf(it, env);
        let et = elemOf(ct);
        if (it.k === 'str') et = 'char';
        const coll = this.ex(it, env, n.line).c;
        if (env.declared.has(target)) {
          const tv = '_x' + (++this.tmp);
          out.push(ind + 'for (auto ' + tv + ' : ' + coll + ') {' + this.tail(n));
          out.push(ind + '    ' + target + ' = ' + tv + ';');
        } else {
          env.vars[target] = et;
          env.loopVars.add(target);
          out.push(ind + 'for (' + (et === 'auto' || et === 'string' ? 'auto' : et) + (et === 'string' ? '&' : '') + ' ' + target + ' : ' + (it.k === 'list' ? (ct + coll) : it.k === 'str' ? 'string(' + coll + ')' : coll) + ') {' + this.tail(n));
        }
      }
      out.push(...this.body(n.body, env, ind + '    '));
      out.push(ind + '}');
      // переменные цикла видны только внутри цикла C++
      for (const k of Object.keys(env.vars)) if (!(k in saved) && !env.declared.has(k)) delete env.vars[k];
      if (env.nonneg) env.nonneg.delete(target);
      for (const k of [...env.loopVars]) if (!(k in saved)) { delete env.vars[k]; env.loopVars.delete(k); }
      return out;
    }
    isGlobal(name, env) { return env.fn && env.fn.globals.has(name) || (!env.fn && name in this.globals); }

    // объявление или присваивание
    assignTo(name, valueCode, t, env, ind, line) {
      if (env.declared.has(name) || this.isGlobal(name, env) || env.loopVars.has(name)) {
        const old = env.vars[name] || this.globals[name];
        if (old && old !== 'auto' && t !== 'auto' && old !== t && unify(old, t) !== old) this.warn(line, 'переменная «' + name + '» меняет тип (' + old + ' → ' + t + ')');
        return ind + name + ' = ' + valueCode + ';';
      }
      if (env.hoisted.has(name)) {
        env.declared.add(name);
        env.vars[name] = unify(env.hoisted.get(name).type, t);
        env.hoisted.get(name).type = env.vars[name];
        return ind + name + ' = ' + valueCode + ';';
      }
      env.declared.add(name);
      env.vars[name] = t;
      if (t === 'void') throw new Error('функция ничего не возвращает');
      if (valueCode === '{}' && isVec(t)) return ind + t + ' ' + name + ';';
      return ind + (t === 'auto' ? 'auto' : t) + ' ' + name + ' = ' + valueCode + ';';
    }

    stmt(n, env, ind) {
      const s = n.text;
      if (n.error) throw new Error(n.error);
      const tail = n.comment ? ' // ' + n.comment : '';
      const L = n.line;
      const one = x => [x + tail];
      if (s === 'pass') return n.comment ? [ind + '// ' + n.comment] : [];
      if (s === 'break' || s === 'continue') return one(ind + s + ';');
      if (/^(import|from)\b/.test(s)) {
        if (/\bmath\b/.test(s)) { this.need('cmath'); return []; }
        this.warn(L, 'импорт «' + s + '» пропущен');
        return [ind + '// ' + s];
      }
      if (/^global\b/.test(s) || /^nonlocal\b/.test(s)) return [];
      if (/^(class|try|with|raise|assert|del|yield|async|lambda)\b/.test(s)) throw new Error('«' + s.split(/\s/)[0] + '» не поддерживается');
      if (/^return\b/.test(s)) {
        const rest = s.slice(6).trim();
        if (!env.fn) throw new Error('return вне функции');
        if (!rest) return one(ind + (env.fn.isMain ? 'return 0;' : 'return;'));
        const e = parseExpr(rest);
        if (e.k === 'tuple') throw new Error('возврат нескольких значений не поддерживается');
        const t = this.typeOf(e, env);
        env.fn.retTypes.push(t);
        return one(ind + 'return ' + this.ex(e, env, L).c + ';');
      }
      if (/^print\s*\(/.test(s)) {
        const e = parseExpr(s);
        if (e.k === 'call' && e.fn.k === 'name' && e.fn.v === 'print') return one(ind + this.print(e, env, L));
      }

      // присваивание: ищем '=' / '+=' на верхнем уровне
      const toks = tokenize(s);
      let d = 0, eqIdx = -1, augOp = null, annIdx = -1;
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.t !== 'op') continue;
        if ('([{'.includes(t.v)) d++;
        else if (')]}'.includes(t.v)) d--;
        else if (d === 0 && t.v === '=' && eqIdx < 0) { eqIdx = i; }
        else if (d === 0 && /^(\+|-|\*|\/|\/\/|%|\*\*|&|\||\^|<<|>>)=$/.test(t.v) && eqIdx < 0) { eqIdx = i; augOp = t.v.slice(0, -1); }
        else if (d === 0 && t.v === ':' && eqIdx < 0 && annIdx < 0) annIdx = i;
      }
      if (eqIdx >= 0 || annIdx >= 0) {
        const srcOf = (from, to) => toksToSrc(toks.slice(from, to));
        let targetSrc, ann = null;
        if (annIdx >= 0 && (eqIdx < 0 || annIdx < eqIdx)) { targetSrc = srcOf(0, annIdx); ann = srcOf(annIdx + 1, eqIdx < 0 ? toks.length - 1 : eqIdx); }
        else targetSrc = srcOf(0, eqIdx);
        if (eqIdx < 0) {
          // x: int  (без значения)
          const t = annToType(ann) || 'int';
          const name = targetSrc.trim();
          env.declared.add(name); env.vars[name] = t;
          return one(ind + t + ' ' + name + '{};');
        }
        // цепочка a = b = 0
        const rhsToks = toks.slice(eqIdx + 1);
        const chainEq = (() => { let dd = 0; for (let i = 0; i < rhsToks.length; i++) { const t = rhsToks[i]; if (t.t !== 'op') continue; if ('([{'.includes(t.v)) dd++; else if (')]}'.includes(t.v)) dd--; else if (dd === 0 && t.v === '=') return i; } return -1; })();
        if (chainEq >= 0 && !augOp) {
          const targets = [targetSrc];
          let rest = rhsToks;
          let ci = chainEq;
          while (ci >= 0) {
            targets.push(toksToSrc(rest.slice(0, ci)));
            rest = rest.slice(ci + 1);
            ci = (() => { let dd = 0; for (let i = 0; i < rest.length; i++) { const t = rest[i]; if (t.t !== 'op') continue; if ('([{'.includes(t.v)) dd++; else if (')]}'.includes(t.v)) dd--; else if (dd === 0 && t.v === '=') return i; } return -1; })();
          }
          const valSrc = toksToSrc(rest);
          const out = [];
          const first = targets[targets.length - 1];
          out.push(...this.stmt({ text: first + ' = ' + valSrc, line: L }, env, ind));
          for (let i = targets.length - 2; i >= 0; i--) out.push(...this.stmt({ text: targets[i] + ' = ' + first, line: L }, env, ind));
          if (tail) out[out.length - 1] += tail;
          return out;
        }
        const rhs = parseExpr(toksToSrc(rhsToks));
        const target = parseExpr(targetSrc);
        if (augOp) {
          if (target.k !== 'name' && target.k !== 'index' && target.k !== 'attr') throw new Error('неподдерживаемая цель присваивания');
          const tc = this.ex(target, env, L).c;
          if (target.k === 'name' && !env.declared.has(target.v) && !this.isGlobal(target.v, env) && !env.loopVars.has(target.v) && !env.hoisted.has(target.v))
            this.warn(L, 'переменная «' + target.v + '» изменяется до объявления');
          // для специальных операторов раскрываем в обычное присваивание
          if (['//', '%', '**', '/'].includes(augOp) || (augOp === '*' && this.typeOf(target, env) === 'string')) {
            const val = this.ex({ k: 'bin', op: augOp, l: target, r: rhs }, env, L).c;
            if (target.k === 'name' && augOp === '/' && env.vars[target.v] === 'int') { this.warn(L, '«' + target.v + '» становится дробным: в C++ тип int — результат будет усечён'); }
            return one(ind + tc + ' = ' + val + ';');
          }
          if (augOp === '+' && isVec(this.typeOf(target, env))) {
            const r = this.wrap(this.ex(rhs, env, L), P.post);
            const rc = rhs.k === 'list' ? this.typeOf(target, env) + r : r;
            if (rhs.k === 'list') { const tmpv = '_e' + (++this.tmp); return [ind + 'for (auto ' + tmpv + ' : ' + rc + ') ' + tc + '.push_back(' + tmpv + ');' + tail]; }
            return one(ind + tc + '.insert(' + tc + '.end(), ' + rc + '.begin(), ' + rc + '.end());');
          }
          let rc = this.ex(this.charify(rhs, target, env), env, L).c;
          if (augOp === '+' && this.typeOf(target, env) === 'string' && isNum(this.typeOf(rhs, env)) && this.typeOf(rhs, env) !== 'char') { this.helpers.add('str'); rc = 'py_str(' + rc + ')'; }
          if (target.k === 'name' && env.vars[target.v] === 'int' && this.typeOf(rhs, env) === 'double') this.warn(L, '«' + target.v + '» имеет тип int, дробная часть будет потеряна');
          return one(ind + tc + ' ' + augOp + '= ' + rc + ';');
        }
        // множественное присваивание a, b = b, a
        if (target.k === 'tuple') {
          const names = target.items;
          let values;
          const out = [];
          if (rhs.k === 'tuple') {
            if (rhs.items.length !== names.length) throw new Error('число значений не совпадает');
            values = rhs.items.map(v => ({ c: this.ex(v, env, L).c, t: this.typeOf(v, env) }));
          } else {
            // a, b = map(int, input().split())  /  a, b = s.split()
            const rt = this.typeOf(rhs, env);
            if (!isVec(rt)) throw new Error('распаковка поддерживается для кортежей и списков');
            const tv = '_t' + (++this.tmp);
            out.push(ind + 'auto ' + tv + ' = ' + this.ex(rhs, env, L).c + ';');
            values = names.map((_, i) => ({ c: tv + '[' + i + ']', t: elemOf(rt) }));
            names.forEach((nm, i) => out.push(this.assignOne(nm, values[i], env, ind, L)));
            if (tail) out[out.length - 1] += tail;
            return out;
          }
          // сначала вычисляем все значения во временные переменные
          const simple = names.every(nm => nm.k === 'name');
          if (simple && names.length === 2 && rhs.items.length === 2 && rhs.items[0].k === 'name' && rhs.items[1].k === 'name'
            && rhs.items[0].v === names[1].v && rhs.items[1].v === names[0].v && env.declared.has(names[0].v) || false) {
            this.need('utility');
            return one(ind + 'swap(' + names[0].v + ', ' + names[1].v + ');');
          }
          const dependsOnTargets = names.some(nm => rhs.items.some(v => mentions(v, nm.k === 'name' ? nm.v : null)));
          if (!dependsOnTargets) {
            names.forEach((nm, i) => out.push(this.assignOne(nm, values[i], env, ind, L)));
          } else {
            const tmps = values.map(v => { const tv = '_t' + (++this.tmp); out.push(ind + (v.t === 'auto' ? 'auto' : v.t) + ' ' + tv + ' = ' + v.c + ';'); return { c: tv, t: v.t }; });
            names.forEach((nm, i) => out.push(this.assignOne(nm, tmps[i], env, ind, L)));
          }
          if (tail) out[out.length - 1] += tail;
          return out;
        }
        if (target.k === 'index' || target.k === 'attr') {
          return one(ind + this.ex(target, env, L).c + ' = ' + this.ex(this.charify(rhs, target, env), env, L).c + ';');
        }
        if (target.k !== 'name') throw new Error('неподдерживаемая цель присваивания');
        let t = annToType(ann) || this.typeOf(rhs, env);
        // пустой список: пробуем понять тип по последующим append
        if (rhs.k === 'list' && !rhs.items.length && !ann) t = this.guessListType(target.v, env) || 'vector<int>';
        if (rhs.k === 'none') { t = 'int'; this.warn(L, '«' + target.v + ' = None» заменено на 0'); }
        let vc = this.ex(rhs.k === 'list' ? { ...rhs, bare: true } : rhs, env, L).c;
        if (rhs.k === 'list' && !rhs.items.length) vc = '{}';
        if (t === 'double' && this.typeOf(rhs, env) === 'int') vc = vc; // неявное преобразование ok
        const declaredType = env.vars[target.v] || this.globals[target.v];
        if (declaredType === 'double' && this.typeOf(rhs, env) === 'int') { /* ok */ }
        if (declaredType === 'string' && rhs.k === 'str') { /* ok */ }
        return one(this.assignTo(target.v, vc, t, env, ind, L));
      }
      // выражение-инструкция
      const e = parseExpr(s);
      if (e.k === 'str') return [ind + '/* ' + e.v.replace(/\*\//g, '* /').split('\n').join('\n' + ind + '   ') + ' */'];
      if (e.k !== 'call') this.warn(L, 'выражение без эффекта');
      return one(ind + this.ex(e, env, L).c + ';');
    }
    assignOne(nm, v, env, ind, L) {
      if (nm.k === 'name') return this.assignTo(nm.v, v.c, v.t, env, ind, L);
      return ind + this.ex(nm, env, L).c + ' = ' + v.c + ';';
    }
    guessListType(name, env) {
      const src = env.fnSource || '';
      const re = new RegExp('\\b' + name + '\\.append\\((.+)\\)');
      const m = re.exec(src);
      if (!m) return null;
      try {
        const t = this.typeOf(parseExpr(m[1]), env);
        if (t && t !== 'auto') return 'vector<' + t + '>';
      } catch (e) { }
      return null;
    }

    print(e, env, L) {
      const sepE = e.kwargs.sep, endE = e.kwargs.end;
      const sep = sepE ? this.ex(sepE, env, L).c : '" "';
      const parts = [];
      e.args.forEach((a, i) => {
        if (i > 0 && !(sepE && sepE.k === 'str' && sepE.v === '')) parts.push(sep);
        if (a.k === 'fstr') {
          for (const p of a.parts) parts.push(typeof p === 'string' ? cppStr(p) : this.fmtPiece(p, env, L, false));
        } else if (a.k === 'str') parts.push(cppStr(a.v));
        else parts.push(this.fmtPiece({ expr: a, fmt: null }, env, L, false));
      });
      let end;
      if (!endE) end = 'endl';
      else if (endE.k === 'str') end = endE.v === '' ? null : endE.v === '\n' ? 'endl' : cppStr(endE.v);
      else end = this.ex(endE, env, L).c;
      if (end) parts.push(end);
      // склеиваем соседние строковые литералы
      const merged = [];
      for (const p of parts) {
        const last = merged[merged.length - 1];
        if (last && /^".*"$/.test(last) && /^".*"$/.test(p) && !last.endsWith('""')) merged[merged.length - 1] = last.slice(0, -1) + p.slice(1);
        else merged.push(p);
      }
      if (!merged.length) return '// print()';
      return 'cout << ' + merged.join(' << ') + ';';
    }

    /* --- функции --- */
    func(n, ind) {
      const m = /^def\s+(\w+)\s*\(([\s\S]*)\)\s*(?:->\s*(.+))?$/.exec(n.head);
      if (!m) throw new Error('не удалось разобрать def');
      const name = m[1];
      const sig = this.fnSigs[name];
      const env = { vars: {}, declared: new Set(), loopVars: new Set(), hoisted: new Map(), fn: { name, retTypes: [], globals: new Set(), isMain: false }, fnSource: nodesToSrc(n.body) };
      for (const p of sig.params) { env.vars[p.name] = p.type; env.declared.add(p.name); }
      // глобальные: явно объявленные global + используемые, но не присваиваемые локально
      const assigned = collectAssigned(n.body);
      for (const g of collectGlobalDecl(n.body)) env.fn.globals.add(g);
      for (const g of Object.keys(this.globals)) if (!assigned.has(g) && !env.declared.has(g)) env.fn.globals.add(g);
      for (const g of env.fn.globals) env.vars[g] = this.globals[g] || 'auto';
      this.hoist(n.body, env);
      const body = this.body(n.body, env, ind + '    ');
      // тип возврата
      let ret = sig.annRet;
      if (!ret) {
        ret = 'void';
        for (const t of env.fn.retTypes) ret = ret === 'void' ? t : unify(ret, t);
        if (ret === 'void' && env.fn.retTypes.length) ret = 'auto';
      }
      this.newRet[name] = ret;
      const decls = this.hoistDecls(env, ind + '    ');
      const params = sig.params.map(p => paramDecl(p)).join(', ');
      return { proto: retName(ret) + ' ' + sig.cname + '(' + params + ');', code: [ind + retName(ret) + ' ' + sig.cname + '(' + params + ') {' + this.tail(n), ...decls, ...body, ind + '}'] };
    }
    // переменные, впервые присвоенные внутри вложенного блока, но используемые снаружи → объявляем в начале
    hoist(nodes, env) {
      const top = new Set();
      const nested = new Map();
      for (const n of nodes) {
        if (n.kind === 'stmt') { for (const v of assignedNames(n.text)) if (!nested.has(v)) top.add(v); }
        else if (n.kind === 'block') {
          const inner = collectAssigned(n.body);
          for (const v of inner) if (!top.has(v) && !env.declared.has(v)) nested.set(v, n);
        }
      }
      // нужно поднять, если используется вне блока, где присвоено (после него или в другом блоке)
      for (const [v, blk] of nested) {
        const idx = nodes.indexOf(blk);
        const after = nodes.slice(idx + 1);
        const usedAfter = after.some(x => nodeMentions(x, v));
        // либо присвоено в нескольких ветках if/elif/else
        const branches = nodes.filter(x => x.kind === 'block' && collectAssigned(x.body).has(v)).length;
        if (usedAfter || branches > 1) env.hoisted.set(v, { type: 'auto' });
        else this.hoistInner(blk.body, env);
      }
      for (const n of nodes) if (n.kind === 'block' && !/^def\b/.test(n.head)) this.hoistInner(n.body, env);
    }
    hoistInner(nodes, env) {
      // для простоты: внутренние блоки — тот же алгоритм (результат общий для функции)
      const saved = env.declared;
      env.declared = new Set([...saved, ...env.hoisted.keys()]);
      const nestedEnv = env;
      const top = new Set();
      for (const n of nodes) if (n.kind === 'stmt') for (const v of assignedNames(n.text)) top.add(v);
      for (const n of nodes) {
        if (n.kind !== 'block') continue;
        for (const v of collectAssigned(n.body)) {
          if (top.has(v) || nestedEnv.declared.has(v) || env.hoisted.has(v)) continue;
          const idx = nodes.indexOf(n);
          const usedAfter = nodes.slice(idx + 1).some(x => nodeMentions(x, v));
          const branches = nodes.filter(x => x.kind === 'block' && collectAssigned(x.body).has(v)).length;
          if (usedAfter || branches > 1) env.hoisted.set(v, { type: 'auto' });
        }
      }
      env.declared = saved;
    }
    hoistDecls(env, ind) {
      const out = [];
      for (const [v, info] of env.hoisted) {
        let t = env.vars[v] || info.type;
        if (t === 'auto' || t === 'void') { t = 'int'; this.warn(null, 'не удалось определить тип «' + v + '», выбран int'); }
        const init = t === 'int' || t === 'char' ? ' = 0' : t === 'double' ? ' = 0.0' : t === 'bool' ? ' = false' : '';
        out.push(ind + t + ' ' + v + init + ';');
      }
      return out;
    }
  }

  function retName(t) { return t === 'auto' ? 'auto' : t; }
  function paramDecl(p) {
    const t = p.type === 'auto' ? 'int' : p.type;
    const byRef = t === 'string' || isVec(t);
    let s = (byRef ? (p.mutated ? t + '& ' : 'const ' + t + '& ') : t + ' ') + p.name;
    if (p.def) s += ' = ' + p.def;
    return s;
  }
  function toksToSrc(toks) {
    return toks.filter(t => t.t !== 'eof').map(t => {
      if (t.t === 'str') return JSON.stringify(t.v);
      if (t.t === 'fstr') return 'f"' + t.v.replace(/"/g, '\\"') + '"';
      return t.v;
    }).join(' ').replace(/ \. /g, '.').replace(/ \( /g, '(').replace(/ \(/g, '(').replace(/ \)/g, ')');
  }
  function mentions(e, name) {
    if (!name || !e || typeof e !== 'object') return false;
    if (e.k === 'name' && e.v === name) return true;
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) { if (v.some(x => typeof x === 'object' && (mentions(x, name) || (x && x.expr && mentions(x.expr, name))))) return true; }
      else if (v && typeof v === 'object' && mentions(v, name)) return true;
    }
    return false;
  }
  function nodesToSrc(nodes) {
    let s = '';
    for (const n of nodes) {
      if (n.kind === 'stmt') s += n.text + '\n';
      else if (n.kind === 'block') s += n.head + ':\n' + nodesToSrc(n.body);
    }
    return s;
  }
  function wordIn(src, v) { return new RegExp('(^|[^\\w.])' + v + '(?!\\w)').test(src.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')); }
  function nodeMentions(n, v) {
    if (n.kind === 'stmt') return wordIn(n.text, v);
    if (n.kind === 'block') return wordIn(n.head, v) || n.body.some(x => nodeMentions(x, v));
    return false;
  }
  function assignedNames(text) {
    const res = [];
    let m = /^([\w\s,()]+?)\s*(?:\+|-|\*|\/|\/\/|%|\*\*)?=(?!=)/.exec(text);
    if (m && !/^(if|while|return|print)\b/.test(text)) {
      for (const p of m[1].replace(/[()]/g, '').split(',')) if (/^\s*[A-Za-z_]\w*\s*$/.test(p)) res.push(p.trim());
    }
    const a = /^([A-Za-z_]\w*)\s*:\s*[^=]+=/.exec(text);
    if (a) res.push(a[1]);
    return res;
  }
  function collectAssigned(nodes, set = new Set()) {
    for (const n of nodes) {
      if (n.kind === 'stmt') for (const v of assignedNames(n.text)) set.add(v);
      else if (n.kind === 'block') {
        if (/^def\b/.test(n.head)) continue;
        const fm = /^for\s+(.+?)\s+in\b/.exec(n.head);
        if (fm) { /* переменные цикла не поднимаем */ }
        collectAssigned(n.body, set);
      }
    }
    return set;
  }
  function assignsTo(nodes, v) { return collectAssigned(nodes).has(v); }
  function collectGlobalDecl(nodes, set = new Set()) {
    for (const n of nodes) {
      if (n.kind === 'stmt' && /^global\s+/.test(n.text)) n.text.slice(6).split(',').forEach(v => set.add(v.trim()));
      else if (n.kind === 'block') collectGlobalDecl(n.body, set);
    }
    return set;
  }

  /* ---------- Хелперы (добавляются только при использовании) ---------- */
  const HELPERS = {
    str: { inc: ['sstream'], code: `template <typename T>
string py_str(const T& x) {
    ostringstream out;
    out << x;
    return out.str();
}
string py_str(bool b) { return b ? "True" : "False"; }
string py_str(double x) {
    if (x == (long long)x && x < 1e16 && x > -1e16) return to_string((long long)x) + ".0";
    ostringstream out;
    out.precision(15);
    out << x;
    return out.str();
}
string py_str(const string& s) { return s; }` },
    fmt: { inc: ['sstream', 'iomanip'], code: `string py_fixed(double x, int digits) {
    ostringstream out;
    out << fixed << setprecision(digits) << x;
    return out.str();
}` },
    input: { inc: [], code: `string py_input(const string& prompt = "") {
    cout << prompt;
    string line;
    getline(cin, line);
    return line;
}` },
    floordiv: { inc: [], code: `long long py_floordiv(long long a, long long b) {
    long long q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
    return q;
}` },
    mod: { inc: [], code: `long long py_mod(long long a, long long b) {
    long long r = a % b;
    if (r != 0 && ((r < 0) != (b < 0))) r += b;
    return r;
}` },
    strmul: { inc: [], code: `string py_repeat(const string& s, int n) {
    string out;
    for (int i = 0; i < n; ++i) out += s;
    return out;
}` },
    vecadd: { inc: [], code: `template <typename T>
vector<T> py_concat(vector<T> a, const vector<T>& b) {
    a.insert(a.end(), b.begin(), b.end());
    return a;
}` },
    split: { inc: ['sstream'], code: `vector<string> py_split(const string& s) {
    vector<string> parts;
    istringstream in(s);
    string word;
    while (in >> word) parts.push_back(word);
    return parts;
}
vector<string> py_split(const string& s, const string& sep) {
    vector<string> parts;
    size_t start = 0, pos;
    while ((pos = s.find(sep, start)) != string::npos) {
        parts.push_back(s.substr(start, pos - start));
        start = pos + sep.size();
    }
    parts.push_back(s.substr(start));
    return parts;
}` },
    mapint: { inc: [], code: `vector<int> py_map_int(const vector<string>& v) {
    vector<int> out;
    for (const auto& s : v) out.push_back(stoi(s));
    return out;
}` },
    mapfloat: { inc: [], code: `vector<double> py_map_float(const vector<string>& v) {
    vector<double> out;
    for (const auto& s : v) out.push_back(stod(s));
    return out;
}` },
    toint: { inc: [], code: `int py_int(const string& s) { return stoi(s); }
template <typename T>
int py_int(T x) { return (int)x; }` },
    printvec: { inc: [], code: `template <typename T>
string py_repr(const T& x) { return py_str(x); }
string py_repr(const string& s) { return "'" + s + "'"; }
string py_repr(char c) { return string("'") + c + "'"; }
template <typename T>
ostream& operator<<(ostream& out, const vector<T>& v) {
    out << "[";
    for (size_t i = 0; i < v.size(); ++i) {
        if (i) out << ", ";
        out << py_repr(v[i]);
    }
    return out << "]";
}` },
    slice: { inc: ['climits'], code: `const long long PY_NONE = LLONG_MIN;
template <typename S>
S py_slice(const S& s, long long a, long long b, long long step = 1) {
    long long n = s.size();
    S out;
    if (step > 0) {
        if (a == PY_NONE) a = 0; else if (a < 0) a = max(0LL, a + n);
        if (b == PY_NONE) b = n; else if (b < 0) b = max(0LL, b + n);
        a = min(a, n); b = min(b, n);
        for (long long i = a; i < b; i += step) out.push_back(s[i]);
    } else {
        if (a == PY_NONE) a = n - 1; else if (a < 0) a += n;
        if (b == PY_NONE) b = -1; else if (b < 0) b = max(-1LL, b + n);
        a = min(a, n - 1);
        for (long long i = a; i > b; i += step) out.push_back(s[i]);
    }
    return out;
}` },
    sorted: { inc: ['algorithm'], code: `template <typename T>
T py_sorted(T v, bool reverse = false) {
    sort(v.begin(), v.end());
    if (reverse) std::reverse(v.begin(), v.end());
    return v;
}` },
    range: { inc: [], code: `vector<int> py_range(int a, int b = INT32_MIN, int step = 1) {
    if (b == INT32_MIN) { b = a; a = 0; }
    vector<int> v;
    for (int i = a; step > 0 ? i < b : i > b; i += step) v.push_back(i);
    return v;
}` },
    pop: { inc: [], code: `template <typename T>
T py_pop(vector<T>& v) {
    T x = v.back();
    v.pop_back();
    return x;
}` },
    popi: { inc: [], code: `template <typename T>
T py_pop(vector<T>& v, int i) {
    if (i < 0) i += v.size();
    T x = v[i];
    v.erase(v.begin() + i);
    return x;
}` },
    upper: { inc: ['cctype'], code: `string py_upper(string s) {
    for (auto& c : s) c = toupper((unsigned char)c);
    return s;
}` },
    lower: { inc: ['cctype'], code: `string py_lower(string s) {
    for (auto& c : s) c = tolower((unsigned char)c);
    return s;
}` },
    strip: { inc: [], code: `string py_strip(const string& s) {
    size_t a = s.find_first_not_of(" \\t\\n\\r");
    if (a == string::npos) return "";
    size_t b = s.find_last_not_of(" \\t\\n\\r");
    return s.substr(a, b - a + 1);
}
string py_lstrip(const string& s) {
    size_t a = s.find_first_not_of(" \\t\\n\\r");
    return a == string::npos ? "" : s.substr(a);
}
string py_rstrip(const string& s) {
    size_t b = s.find_last_not_of(" \\t\\n\\r");
    return b == string::npos ? "" : s.substr(0, b + 1);
}` },
    join: { inc: [], code: `string py_join(const string& sep, const vector<string>& parts) {
    string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out += sep;
        out += parts[i];
    }
    return out;
}` },
    replace: { inc: [], code: `string py_replace(string s, const string& from, const string& to) {
    if (from.empty()) return s;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != string::npos) {
        s.replace(pos, from.size(), to);
        pos += to.size();
    }
    return s;
}` },
    endswith: { inc: [], code: `bool py_endswith(const string& s, const string& suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}` },
    strcount: { inc: [], code: `int py_count(const string& s, const string& sub) {
    if (sub.empty()) return s.size() + 1;
    int n = 0;
    for (size_t pos = s.find(sub); pos != string::npos; pos = s.find(sub, pos + sub.size())) n++;
    return n;
}` },
    strpred: { inc: ['cctype'], code: `bool py_all(const string& s, int (*pred)(int)) {
    if (s.empty()) return false;
    for (unsigned char c : s) if (!pred(c)) return false;
    return true;
}` },
    factorial: { inc: [], code: `long long py_factorial(int n) {
    long long r = 1;
    for (int i = 2; i <= n; ++i) r *= i;
    return r;
}` },
  };
  const HELPER_ORDER = Object.keys(HELPERS);

  /* ---------- Главная функция ---------- */
  function convert(code) {
    const tree = buildTreeShared(code);
    const funcs = [], topLevel = [];
    let mainGuard = null;
    for (const n of tree) {
      if (n.kind === 'block' && /^def\b/.test(n.head)) funcs.push(n);
      else if (n.kind === 'block' && /^if\s+__name__\s*==\s*["']__main__["']$/.test(n.head)) mainGuard = n;
      else topLevel.push(n);
    }
    // комментарии/пустые строки прямо перед def относятся к функции
    // сигнатуры
    const fnSigs = {};
    const hasUserMain = funcs.some(f => /^def\s+main\b/.test(f.head));
    const badFuncs = [];
    for (const f of funcs) {
      const m = /^def\s+(\w+)\s*\(([\s\S]*)\)\s*(?:->\s*(.+))?$/.exec(f.head);
      if (!m) { badFuncs.push({ f, msg: 'не удалось разобрать заголовок функции' }); continue; }
      try {
      const params = splitTop(m[2]).filter(p => p.trim()).map(p => {
        let [left, def] = splitOnce(p, '=');
        let [name, ann] = splitOnce(left, ':');
        name = name.trim();
        if (name.startsWith('*')) throw new Error('*args/**kwargs не поддерживаются');
        let type = annToType(ann && ann.trim());
        let defC = null;
        if (def !== null) {
          try {
            const de = parseExpr(def.trim());
            if (!type) type = de.k === 'num' ? (de.isFloat ? 'double' : 'int') : de.k === 'str' ? 'string' : de.k === 'bool' ? 'bool' : null;
            defC = de.k === 'str' ? cppStr(de.v) : de.k === 'bool' ? (de.v ? 'true' : 'false') : de.k === 'none' ? '0' : toksToSrc(tokenize(def.trim()));
          } catch (e) { defC = def.trim(); }
        }
        const mutated = new RegExp('\\b' + name + '\\s*(\\.(append|pop|insert|extend|sort|reverse|clear|remove)\\(|\\[[^\\]]*\\]\\s*=(?!=))').test(nodesToSrc(f.body));
        return { name, type: type || 'auto', annotated: !!type, def: defC, mutated };
      });
      fnSigs[m[1]] = { params, annRet: annToType(m[3] && m[3].trim()), ret: annToType(m[3] && m[3].trim()) || 'auto', cname: m[1] === 'main' ? 'py_main' : m[1] };
      } catch (err) { badFuncs.push({ f, msg: err.message }); }
    }

    // глобальные переменные: присвоены на верхнем уровне и упоминаются в функциях
    const topAssigned = collectAssigned(topLevel.filter(n => n.kind !== 'block' || !/^def\b/.test(n.head)));
    const fnSrc = funcs.map(f => nodesToSrc(f.body)).join('\n');
    const globalNames = [...topAssigned].filter(v => wordIn(fnSrc, v));

    // итеративно уточняем типы параметров и возвращаемых значений
    let result = null;
    let callTypes = {};
    let globals = {};
    for (const g of globalNames) globals[g] = 'auto';
    for (let pass = 0; pass < 4; pass++) {
      const gen = new Gen({ fnSigs, callTypes, globals });
      // сначала main-блок (собирает типы аргументов вызовов и глобальных переменных)
      const mainEnv = { vars: {}, declared: new Set(), loopVars: new Set(), hoisted: new Map(), fn: null, fnSource: nodesToSrc(topLevel) + (mainGuard ? nodesToSrc(mainGuard.body) : '') };
      mainEnv.fn = { name: 'main', retTypes: [], globals: new Set(globalNames), isMain: true };
      for (const g of globalNames) mainEnv.vars[g] = globals[g];
      const mainNodes = [...topLevel];
      if (mainGuard) {
        // если guard просто вызывает main() — вызываем py_main
        mainNodes.push(...mainGuard.body);
      }
      gen.hoist(mainNodes, mainEnv);
      const mainBody = gen.body(mainNodes, mainEnv, '    ');
      // типы глобальных переменных
      for (const g of globalNames) {
        globals[g] = unify(globals[g], mainEnv.vars[g]);
      }
      const fnOut = funcs.map(f => {
        const bad = badFuncs.find(b => b.f === f);
        try { if (bad) throw new Error(bad.msg); return gen.func(f, ''); }
        catch (err) { gen.warn(f.line, err.message); return { proto: null, code: ['// TODO (не сконвертировано): ' + f.head + ':', ...gen.commentOut(f.body, '')] }; }
      });
      // обновляем сигнатуры
      let changed = false;
      for (const [name, sig] of Object.entries(fnSigs)) {
        const ct = gen.newCallTypes[name] || [];
        sig.params.forEach((p, i) => {
          if (p.annotated) return;
          const nt = ct[i] && ct[i] !== 'auto' && ct[i] !== 'void' ? ct[i] : p.type;
          if (nt !== p.type) { p.type = nt; changed = true; }
        });
        const nr = gen.newRet[name];
        if (nr && nr !== sig.ret) { sig.ret = nr; changed = true; }
      }
      const mainDecls = gen.hoistDecls(mainEnv, '    ');
      result = { gen, mainBody: [...mainDecls, ...mainBody], fnOut, mainEnv };
      if (!changed && pass > 0) break;
    }

    const { gen, mainBody, fnOut } = result;
    for (const [name, sig] of Object.entries(fnSigs)) {
      sig.params.forEach(p => { if (p.type === 'auto') gen.warn(null, 'тип параметра «' + p.name + '» функции ' + name + '() не определён — выбран int'); });
    }
    // включения
    const inc = new Set(gen.includes);
    if (/vector</.test(mainBody.join('\n') + fnOut.map(f => f.code.join('\n')).join('\n')) || [...gen.helpers].some(h => ['split', 'mapint', 'mapfloat', 'printvec', 'vecadd', 'range', 'pop', 'popi', 'join'].includes(h))) inc.add('vector');
    for (const h of gen.helpers) for (const i of HELPERS[h].inc) inc.add(i);
    if (gen.helpers.has('range')) inc.add('cstdint');
    if (gen.helpers.has('slice')) inc.add('algorithm');
    const order = ['iostream', 'string', 'vector', 'cmath', 'algorithm', 'numeric', 'sstream', 'iomanip', 'cctype', 'climits', 'cstdint', 'utility'];
    const lines = [];
    for (const i of order) if (inc.has(i)) lines.push('#include <' + i + '>');
    lines.push('using namespace std;', '');
    // хелперы
    const hs = HELPER_ORDER.filter(h => gen.helpers.has(h));
    if (hs.length) {
      lines.push('// --- вспомогательные функции (поведение как в Python) ---');
      for (const h of hs) lines.push(HELPERS[h].code, '');
    }
    // глобальные
    const globalDecls = Object.entries(globals).map(([g, t]) => (t === 'auto' || t === 'void' ? 'int' : t) + ' ' + g + (t === 'int' || t === 'auto' ? ' = 0' : t === 'double' ? ' = 0.0' : t === 'bool' ? ' = false' : '') + ';');
    if (globalDecls.length) lines.push(...globalDecls, '');
    // прототипы (чтобы функции можно было вызывать в любом порядке)
    const protos = fnOut.map(f => f.proto).filter(Boolean);
    if (protos.length > 1) lines.push(...protos, '');
    for (const f of fnOut) lines.push(...f.code, '');
    // main
    lines.push('int main() {');
    lines.push(...mainBody);
    lines.push('    return 0;', '}');
    const out = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
    return { code: out, warnings: gen.warnings };
  }

  function splitTop(s) {
    const parts = []; let d = 0, q = null, cur = '';
    for (const c of s) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
      if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }
  function splitOnce(s, ch) {
    const i = s.indexOf(ch);
    return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
  }

  return { convert };
})();

if (typeof module !== 'undefined') module.exports = PyToCpp;
