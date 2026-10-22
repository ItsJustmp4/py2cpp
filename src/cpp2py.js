/* ============================================================
 * C++ → Python
 * Токенизатор + рекурсивный разбор инструкций и выражений,
 * отступы по вложенности блоков, cout/cin, for → range().
 * ============================================================ */
const CppToPy = (() => {

  /* ---------- Токенизатор C++ ---------- */
  const OPS = ['<<=', '>>=', '...', '->', '::', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}'];

  function tokenize(src) {
    const toks = [];
    let i = 0, line = 1;
    const push = (t, v, extra) => toks.push({ t, v, line, ...extra });
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '#') { // препроцессор
        let j = i; while (j < src.length && src[j] !== '\n') { if (src[j] === '\\' && src[j + 1] === '\n') { j++; line++; } j++; }
        push('pp', src.slice(i, j));
        i = j; continue;
      }
      if (src.startsWith('//', i)) {
        let j = i + 2; while (j < src.length && src[j] !== '\n') j++;
        const own = !toks.length || toks[toks.length - 1].line !== line;
        push('comment', src.slice(i + 2, j).trim(), { own });
        i = j; continue;
      }
      if (src.startsWith('/*', i)) {
        const j = src.indexOf('*/', i + 2);
        const end = j < 0 ? src.length : j;
        const body = src.slice(i + 2, end);
        const own = !toks.length || toks[toks.length - 1].line !== line;
        push('comment', body.split('\n').map(s => s.replace(/^\s*\*?\s?/, '').trimEnd()).join('\n').trim(), { own, block: true });
        line += (body.match(/\n/g) || []).length;
        i = end + 2; continue;
      }
      if (c === '"' || (c === 'R' && src[i + 1] === '"') || (/[uUL]/.test(c) && src[i + 1] === '"')) {
        if (c !== '"' && c !== 'R') i++;
        if (src[i] === 'R') { // raw string R"(...)"
          const m = /^R"([^(]*)\(/.exec(src.slice(i));
          const close = ')' + m[1] + '"';
          const j = src.indexOf(close, i + m[0].length);
          const v = src.slice(i + m[0].length, j);
          line += (v.match(/\n/g) || []).length;
          push('str', v); i = j + close.length; continue;
        }
        let j = i + 1, v = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\') { v += unescape(src[j + 1]); j += 2; continue; }
          if (src[j] === '\n') break;
          v += src[j++];
        }
        if (src[j] !== '"') throw new SyntaxError('строка ' + line + ': незакрытая строка');
        // склейка соседних литералов "a" "b"
        const prev = toks[toks.length - 1];
        if (prev && prev.t === 'str') prev.v += v; else push('str', v);
        i = j + 1; continue;
      }
      if (c === "'") {
        let j = i + 1, v = '';
        if (src[j] === '\\') { v = unescape(src[j + 1]); j += 2; } else { v = src[j]; j++; }
        if (src[j] !== "'") throw new SyntaxError('строка ' + line + ': неверный символьный литерал');
        push('char', v); i = j + 1; continue;
      }
      const num = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|(\d[\d']*\.?[\d']*|\.\d[\d']*)([eE][+-]?\d+)?)([uUlLfF]*)/.exec(src.slice(i));
      if (num && /[\d.]/.test(c) && num[0] !== '.') {
        let v = num[1].replace(/'/g, '');
        const isFloat = /[.eE]/.test(v) && !/^0[xX]/.test(v) || /[fF]/.test(num[4]) && /[.eE]/.test(v);
        if (/^0\d+$/.test(v)) v = '0o' + v.slice(1);
        if (v.endsWith('.')) v += '0';
        if (v.startsWith('.')) v = '0' + v;
        push('num', v, { isFloat });
        i += num[0].length; continue;
      }
      const id = /^[A-Za-z_]\w*/.exec(src.slice(i));
      if (id) { push('id', id[0]); i += id[0].length; continue; }
      const op = OPS.find(o => src.startsWith(o, i));
      if (op) { push('op', op); i += op.length; continue; }
      throw new SyntaxError('строка ' + line + ': неизвестный символ «' + c + '»');
    }
    push('eof', '');
    return toks;
  }
  function unescape(ch) { return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' })[ch] ?? ch; }

  /* ---------- Парсер ---------- */
  const BASE_TYPES = new Set(['int', 'long', 'short', 'unsigned', 'signed', 'double', 'float', 'char', 'bool', 'void', 'string', 'auto', 'size_t',
    'vector', 'int64_t', 'int32_t', 'uint64_t', 'uint32_t', 'long long', 'pair', 'map', 'set', 'unordered_map', 'unordered_set', 'array', 'deque', 'stack', 'queue', 'wchar_t']);
  const QUALS = new Set(['const', 'static', 'constexpr', 'inline', 'volatile', 'register', 'mutable', 'extern']);

  class Parser {
    constructor(toks) {
      this.toks = toks.filter(t => t.t !== 'pp');
      this.p = 0;
    }
    peek(o = 0) {
      // комментарии пропускаем при заглядывании внутри выражений
      let i = this.p, n = 0;
      for (; i < this.toks.length; i++) { if (this.toks[i].t === 'comment') continue; if (n === o) return this.toks[i]; n++; }
      return this.toks[this.toks.length - 1];
    }
    next() { while (this.toks[this.p].t === 'comment') this.p++; return this.toks[this.p++]; }
    is(v, o = 0) { const t = this.peek(o); return (t.t === 'op' || t.t === 'id') && t.v === v; }
    accept(v) { if (this.is(v)) { this.next(); return true; } return false; }
    expect(v) {
      if (!this.accept(v)) { const t = this.peek(); throw new SyntaxError('строка ' + t.line + ': ожидалось «' + v + '», найдено «' + (t.v || 'конец файла') + '»'); }
    }
    line() { return this.peek().line; }
    takeComments() {
      const out = [];
      while (this.toks[this.p] && this.toks[this.p].t === 'comment') out.push(this.toks[this.p++]);
      return out;
    }

    // std:: и прочие квалификаторы имён
    qualName() {
      let t = this.next();
      let name = t.v;
      while (this.is('::')) { this.next(); name += '::' + this.next().v; }
      return name.replace(/^std::/, '');
    }

    /* --- типы --- */
    looksLikeType(o = 0) {
      let i = o;
      while (this.peek(i).t === 'id' && QUALS.has(this.peek(i).v)) i++;
      const t = this.peek(i);
      if (t.t !== 'id') return false;
      let name = t.v;
      let j = i + 1;
      if (name === 'std' && this.is('::', j - i + o - o)) { /* handled below */ }
      if (name === 'std') { if (this.peek(i + 1).v !== '::') return false; name = this.peek(i + 2).v; j = i + 3; }
      if (BASE_TYPES.has(name)) return true;
      // пользовательский тип: Name ident ...
      const n1 = this.peek(j);
      return false && n1;
    }
    type() {
      const quals = [];
      while (this.peek().t === 'id' && QUALS.has(this.peek().v)) quals.push(this.next().v);
      let name = this.qualName();
      // составные: unsigned long long, long long int ...
      while (this.peek().t === 'id' && ['long', 'int', 'short', 'unsigned', 'signed', 'double', 'char'].includes(this.peek().v) && ['long', 'unsigned', 'signed', 'short'].includes(name.split(' ').pop())) name += ' ' + this.next().v;
      let args = null;
      if (this.is('<')) {
        this.next();
        args = [];
        let depth = 1;
        let cur = [];
        // аргументы шаблона
        while (depth > 0) {
          if (this.is('>>')) { // vector<vector<int>>
            const t = this.next();
            this.toks.splice(this.p, 0, { t: 'op', v: '>', line: t.line });
            depth--;
            if (depth === 0) break;
            continue;
          }
          if (this.is('>')) { this.next(); depth--; if (depth === 0) break; continue; }
          if (this.is('<')) { this.next(); depth++; continue; }
          if (this.is(',') && depth === 1) { this.next(); continue; }
          if (depth === 1 && this.peek().t === 'id') { args.push(this.type()); continue; }
          if (this.peek().t === 'num') { args.push({ name: this.next().v }); continue; }
          this.next();
        }
      }
      while (this.is('const')) this.next();
      let ref = false, ptr = 0;
      for (;;) {
        if (this.accept('&') || this.accept('&&')) ref = true;
        else if (this.accept('*')) ptr++;
        else if (this.accept('const')) { }
        else break;
      }
      return { name, args, ref, ptr, quals };
    }

    /* --- верхний уровень --- */
    program() {
      const items = [];
      for (;;) {
        const cs = this.takeComments();
        for (const c of cs) items.push({ k: 'comment', v: c.v, line: c.line });
        if (this.peek().t === 'eof') break;
        const line = this.line();
        if (this.accept(';')) continue;
        if (this.is('using') || this.is('typedef')) { this.skipTo(';'); continue; }
        if (this.is('namespace')) { this.skipBalanced(); items.push({ k: 'unsupported', what: 'namespace', line }); continue; }
        if (this.is('struct') || this.is('class') || this.is('enum') || this.is('union') || this.is('template')) {
          const what = this.peek().v;
          this.skipBalanced();
          this.accept(';');
          items.push({ k: 'unsupported', what, line });
          continue;
        }
        const start = this.p;
        try {
          const ty = this.type();
          const nameTok = this.peek();
          if (nameTok.t !== 'id') throw new SyntaxError('строка ' + line + ': ожидалось имя');
          if (this.is('(', 1)) {
            const name = this.qualName();
            this.expect('(');
            const params = this.params();
            this.expect(')');
            while (this.is('const') || this.is('noexcept') || this.is('override')) this.next();
            if (this.accept(';')) continue; // прототип
            const body = this.block();
            items.push({ k: 'func', ret: ty, name, params, body, line });
            continue;
          }
          items.push(this.declRest(ty, line));
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          // фрагмент без функции: пробуем как обычную инструкцию
          this.p = start;
          const st = this.stmtSafe();
          if (st.k === 'error' && this.p === start) this.skipStatement();
          items.push({ k: 'topstmt', s: st, line });
        }
      }
      return items;
    }
    skipTo(v) { while (this.peek().t !== 'eof' && !this.is(v)) this.next(); this.accept(v); }
    skipBalanced() {
      while (this.peek().t !== 'eof' && !this.is('{') && !this.is(';')) this.next();
      if (this.accept(';')) return;
      let d = 0;
      do {
        const t = this.next();
        if (t.v === '{') d++; else if (t.v === '}') d--;
      } while (d > 0 && this.peek().t !== 'eof');
    }
    skipStatement() {
      let d = 0;
      while (this.peek().t !== 'eof') {
        const t = this.next();
        if (t.v === '{' || t.v === '(') d++;
        else if (t.v === '}' || t.v === ')') { d--; if (d <= 0 && t.v === '}') return; }
        else if (t.v === ';' && d <= 0) return;
      }
    }
    params() {
      const ps = [];
      if (this.is(')')) return ps;
      if (this.is('void') && this.is(')', 1)) { this.next(); return ps; }
      do {
        const ty = this.type();
        let name = this.peek().t === 'id' ? this.next().v : '_';
        let arr = false;
        while (this.accept('[')) { while (!this.is(']')) this.next(); this.expect(']'); arr = true; }
        let def = null;
        if (this.accept('=')) def = this.assignExpr();
        if (arr) ty.args = [{ name: ty.name }], ty.name = 'vector';
        ps.push({ ty, name, def });
      } while (this.accept(','));
      return ps;
    }
    // после типа: имя [= init] {, имя [= init]} ;
    declRest(ty, line, noSemi) {
      const decls = [];
      do {
        while (this.accept('*') || this.accept('&')) { }
        const name = this.next().v;
        const dims = [];
        while (this.accept('[')) { dims.push(this.is(']') ? null : this.expr()); this.expect(']'); }
        let init = null, ctor = null;
        if (this.accept('=')) init = this.is('{') ? this.initList() : this.assignExpr();
        else if (this.is('{')) init = this.initList();
        else if (this.is('(')) { this.next(); ctor = []; if (!this.is(')')) do ctor.push(this.assignExpr()); while (this.accept(',')); this.expect(')'); }
        decls.push({ name, dims, init, ctor });
      } while (this.accept(','));
      if (!noSemi) this.expect(';');
      return { k: 'decl', ty, decls, line };
    }
    initList() {
      this.expect('{');
      const items = [];
      while (!this.is('}')) {
        items.push(this.is('{') ? this.initList() : this.assignExpr());
        if (!this.accept(',')) break;
      }
      this.expect('}');
      return { k: 'list', items };
    }

    /* --- инструкции --- */
    block() {
      this.expect('{');
      const body = [];
      for (;;) {
        for (const c of this.takeComments()) body.push({ k: 'comment', v: c.v, line: c.line, own: c.own });
        if (this.is('}') || this.peek().t === 'eof') break;
        body.push(this.stmtSafe());
      }
      this.expect('}');
      // комментарий в конце строки с закрывающей скобкой
      return body;
    }
    stmtSafe() {
      const start = this.p, line = this.line();
      try { return this.stmt(); }
      catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        this.p = start;
        this.skipStatement();
        const src = this.toks.slice(start, this.p).filter(t => t.t !== 'comment').map(t => t.t === 'str' ? JSON.stringify(t.v) : t.t === 'char' ? "'" + t.v + "'" : t.v).join(' ');
        return { k: 'error', msg: e.message, src, line };
      }
    }
    stmt() {
      const line = this.line();
      const t = this.peek();
      if (this.is('{')) return { k: 'block', body: this.block(), line };
      if (this.accept(';')) return { k: 'empty', line };
      if (t.t === 'id') {
        switch (t.v) {
          case 'if': {
            this.next(); this.expect('(');
            const c = this.condExpr();
            this.expect(')');
            const then = this.stmtSafe();
            let els = null;
            this.takeTrailing(then);
            if (this.accept('else')) els = this.stmtSafe();
            return { k: 'if', c, then, els, line };
          }
          case 'while': {
            this.next(); this.expect('(');
            const c = this.condExpr();
            this.expect(')');
            return { k: 'while', c, body: this.stmtSafe(), line };
          }
          case 'do': {
            this.next();
            const body = this.stmtSafe();
            this.expect('while'); this.expect('(');
            const c = this.expr();
            this.expect(')'); this.expect(';');
            return { k: 'dowhile', c, body, line };
          }
          case 'for': {
            this.next(); this.expect('(');
            // range-for: for (auto x : v)
            const save = this.p;
            if (this.looksLikeType()) {
              const ty = this.type();
              const name = this.peek().t === 'id' ? this.peek().v : null;
              if (name && this.is(':', 1)) {
                this.next(); this.next();
                const coll = this.expr();
                this.expect(')');
                return { k: 'foreach', ty, name, coll, body: this.stmtSafe(), line };
              }
              this.p = save;
            }
            let init = null;
            if (!this.is(';')) {
              if (this.looksLikeType()) init = this.declRest(this.type(), line, true);
              else init = { k: 'expr', e: this.expr(), line };
            }
            this.expect(';');
            const c = this.is(';') ? null : this.expr();
            this.expect(';');
            const step = this.is(')') ? null : this.expr();
            this.expect(')');
            return { k: 'for', init, c, step, body: this.stmtSafe(), line };
          }
          case 'return': {
            this.next();
            const e = this.is(';') ? null : this.expr();
            this.expect(';');
            return { k: 'return', e, line };
          }
          case 'break': case 'continue': this.next(); this.expect(';'); return { k: t.v, line };
          case 'switch': return this.switchStmt();
          case 'goto': case 'try': case 'throw': case 'struct': case 'class': throw new SyntaxError('строка ' + line + ': «' + t.v + '» не поддерживается');
        }
        if (!this.looksLikeType() && this.peek(1).t === 'id' && !['else', 'case'].includes(t.v) && (this.is(';', 2) || this.is('=', 2) || this.is('(', 2) || this.is('{', 2)))
          throw new SyntaxError('строка ' + line + ': тип «' + t.v + '» не поддерживается');
        if (this.looksLikeType() && (this.peek(1).t === 'id' || this.is('<', 1) || this.is('::', 1) || this.is('&', 1) || this.is('*', 1) || QUALS.has(t.v))) {
          const save = this.p;
          try { return this.declRest(this.type(), line); }
          catch (e) { this.p = save; if (!(e instanceof SyntaxError)) throw e; }
        }
      }
      const e = this.expr();
      this.expect(';');
      return { k: 'expr', e, line };
    }
    takeTrailing() { }
    switchStmt() {
      const line = this.line();
      this.next(); this.expect('(');
      const subj = this.expr();
      this.expect(')'); this.expect('{');
      const cases = [];
      let cur = null;
      for (;;) {
        this.takeComments();
        if (this.is('}')) break;
        if (this.accept('case')) {
          const v = this.condExpr();
          this.expect(':');
          if (cur && !cur.body.length && !cur.isDefault) cur.vals.push(v);
          else { cur = { vals: [v], body: [] }; cases.push(cur); }
          continue;
        }
        if (this.accept('default')) { this.expect(':'); cur = { vals: [], isDefault: true, body: [] }; cases.push(cur); continue; }
        if (!cur) throw new SyntaxError('строка ' + this.line() + ': код вне case');
        cur.body.push(this.stmtSafe());
      }
      this.expect('}');
      return { k: 'switch', subj, cases, line };
    }

    /* --- выражения --- */
    expr() {
      let e = this.assignExpr();
      while (this.is(',')) { this.next(); e = { k: 'comma', l: e, r: this.assignExpr() }; }
      return e;
    }
    // условие без запятой (в if/while/case)
    condExpr() { return this.expr(); }
    assignExpr() {
      const l = this.ternary();
      const t = this.peek();
      if (t.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='].includes(t.v)) {
        this.next();
        return { k: 'assign', op: t.v, l, r: this.is('{') ? this.initList() : this.assignExpr() };
      }
      return l;
    }
    ternary() {
      const c = this.bin(0);
      if (this.accept('?')) {
        const a = this.assignExpr();
        this.expect(':');
        const b = this.assignExpr();
        return { k: 'tern', c, a, b };
      }
      return c;
    }
    bin(level) {
      const LV = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
      if (level >= LV.length) return this.unary();
      let l = this.bin(level + 1);
      for (;;) {
        const t = this.peek();
        if (t.t === 'op' && LV[level].includes(t.v)) { this.next(); l = { k: 'bin', op: t.v, l, r: this.bin(level + 1) }; }
        else return l;
      }
    }
    unary() {
      const t = this.peek();
      if (t.t === 'op') {
        if (['!', '-', '+', '~'].includes(t.v)) { this.next(); return { k: 'un', op: t.v, x: this.unary() }; }
        if (t.v === '++' || t.v === '--') { this.next(); return { k: 'preinc', op: t.v, x: this.unary() }; }
        if (t.v === '*' || t.v === '&') throw new SyntaxError('строка ' + t.line + ': указатели не поддерживаются');
        if (t.v === '(' && this.looksLikeType(1)) {
          // приведение (int)x
          const save = this.p;
          this.next();
          const ty = this.type();
          if (this.accept(')')) return { k: 'cast', ty, x: this.unary() };
          this.p = save;
        }
      }
      if (t.t === 'id' && t.v === 'sizeof') throw new SyntaxError('строка ' + t.line + ': sizeof не поддерживается');
      if (t.t === 'id' && t.v === 'new') throw new SyntaxError('строка ' + t.line + ': new не поддерживается');
      return this.postfix();
    }
    postfix() {
      let x = this.primary();
      for (;;) {
        if (this.is('(')) {
          this.next();
          const args = [];
          if (!this.is(')')) do args.push(this.is('{') ? this.initList() : this.assignExpr()); while (this.accept(','));
          this.expect(')');
          x = { k: 'call', fn: x, args };
        } else if (this.accept('[')) {
          const idx = this.expr();
          this.expect(']');
          x = { k: 'index', obj: x, idx };
        } else if (this.is('.') || this.is('->')) {
          this.next();
          x = { k: 'member', obj: x, name: this.next().v };
        } else if (this.is('++') || this.is('--')) {
          x = { k: 'postinc', op: this.next().v, x };
        } else return x;
      }
    }
    primary() {
      const t = this.peek();
      if (t.t === 'num') { this.next(); return { k: 'num', v: t.v, isFloat: t.isFloat }; }
      if (t.t === 'str') { this.next(); return { k: 'str', v: t.v }; }
      if (t.t === 'char') { this.next(); return { k: 'char', v: t.v }; }
      if (t.t === 'id') {
        if (t.v === 'true' || t.v === 'false') { this.next(); return { k: 'bool', v: t.v === 'true' }; }
        if (t.v === 'nullptr' || t.v === 'NULL') { this.next(); return { k: 'none' }; }
        if (['static_cast', 'int', 'double', 'float', 'long', 'char', 'bool', 'string'].includes(t.v) && (this.is('<', 1) || this.is('(', 1))) {
          // static_cast<T>(x) / int(x) / string(…)
          if (t.v === 'static_cast') {
            this.next(); this.expect('<'); const ty = this.type(); this.expect('>');
            this.expect('('); const x = this.expr(); this.expect(')');
            return { k: 'cast', ty, x };
          }
        }
        if (this.looksLikeType() && (this.is('<', 1) || (this.peek(1).v === '::' && this.peek(3).v === '<'))) {
          // vector<int>{...} / vector<int>(n, 0)
          const save = this.p;
          try {
            const ty = this.type();
            if (this.is('{')) return { k: 'construct', ty, list: this.initList() };
            if (this.is('(')) { this.next(); const args = []; if (!this.is(')')) do args.push(this.assignExpr()); while (this.accept(',')); this.expect(')'); return { k: 'construct', ty, args }; }
          } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
          this.p = save;
        }
        return { k: 'name', v: this.qualName() };
      }
      if (t.v === '(') { this.next(); const e = this.expr(); this.expect(')'); return { k: 'paren', x: e }; }
      if (t.v === '[') throw new SyntaxError('строка ' + t.line + ': лямбды не поддерживаются');
      if (t.v === '{') return this.initList();
      throw new SyntaxError('строка ' + t.line + ': неожиданный токен «' + (t.v || 'конец файла') + '»');
    }
  }

  /* ---------- Генерация Python ---------- */
  // приоритеты Python
  const P = { tern: 1, or: 2, and: 3, not: 4, cmp: 5, bor: 6, bxor: 7, band: 8, shift: 9, add: 10, mul: 11, un: 12, pow: 13, post: 14, atom: 15 };
  const BIN = {
    '||': ['or', P.or], '&&': ['and', P.and], '|': ['|', P.bor], '^': ['^', P.bxor], '&': ['&', P.band],
    '==': ['==', P.cmp], '!=': ['!=', P.cmp], '<': ['<', P.cmp], '>': ['>', P.cmp], '<=': ['<=', P.cmp], '>=': ['>=', P.cmp],
    '<<': ['<<', P.shift], '>>': ['>>', P.shift], '+': ['+', P.add], '-': ['-', P.add], '*': ['*', P.mul], '/': ['/', P.mul], '%': ['%', P.mul]
  };
  const MATH = new Set(['sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'log2', 'log10', 'floor', 'ceil', 'hypot', 'fabs', 'trunc', 'fmod']);

  function typeName(ty) {
    if (!ty) return 'auto';
    const n = ty.name.replace(/^const\s+/, '');
    if (/^(unsigned |signed )?(long long|long|int|short|size_t|int64_t|int32_t|uint64_t|uint32_t|unsigned|long int|long long int|unsigned int|unsigned long long)$/.test(n) || n === 'unsigned') return 'int';
    if (n === 'double' || n === 'float' || n === 'long double') return 'float';
    if (n === 'char' || n === 'wchar_t') return 'char';
    if (n === 'bool') return 'bool';
    if (n === 'string') return 'str';
    if (n === 'vector' || n === 'array' || n === 'deque') return 'list<' + (ty.args && ty.args[0] ? typeName(ty.args[0]) : 'auto') + '>';
    if (n === 'void') return 'void';
    if (n === 'auto') return 'auto';
    return 'other:' + n;
  }
  const isList = t => /^list</.test(t || '');
  const elemOf = t => isList(t) ? t.slice(5, -1) : (t === 'str' ? 'char' : 'auto');
  const isNumT = t => t === 'int' || t === 'float' || t === 'bool' || t === 'char';

  function pyStr(s, quote = '"') {
    let o = quote;
    for (const ch of s) {
      if (ch === quote) o += '\\' + quote;
      else if (ch === '\\') o += '\\\\';
      else if (ch === '\n') o += '\\n';
      else if (ch === '\t') o += '\\t';
      else if (ch === '\r') o += '\\r';
      else if (ch === '\0') o += '\\0';
      else if (ch.charCodeAt(0) < 32) o += '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
      else o += ch;
    }
    return o + quote;
  }

  class Gen {
    constructor() {
      this.warnings = [];
      this.imports = new Set();
      this.fnRet = {};
      this.globals = {};
      this.fmt = { fixed: false, prec: null };
      this.tmp = 0;
    }
    warn(line, msg) { const w = (line ? 'Строка ' + line + ': ' : '') + msg; if (!this.warnings.includes(w)) this.warnings.push(w); }
    wrap(r, minP) { return r.p < minP ? '(' + r.c + ')' : r.c; }

    typeOf(e, env) {
      switch (e.k) {
        case 'num': return e.isFloat ? 'float' : 'int';
        case 'str': return 'str';
        case 'char': return 'char';
        case 'bool': return 'bool';
        case 'paren': return this.typeOf(e.x, env);
        case 'name': return env.vars[e.v] || this.globals[e.v] || (e.v === 'M_PI' ? 'float' : 'auto');
        case 'index': return elemOf(this.typeOf(e.obj, env));
        case 'cast': return typeName(e.ty);
        case 'un': return e.op === '!' ? 'bool' : this.typeOf(e.x, env);
        case 'bin': {
          if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) return 'bool';
          const a = this.typeOf(e.l, env), b = this.typeOf(e.r, env);
          if (e.op === '+' && (a === 'str' || b === 'str')) return 'str';
          if (a === 'float' || b === 'float') return 'float';
          if (a === 'auto' || b === 'auto') return 'auto';
          return 'int';
        }
        case 'tern': { const a = this.typeOf(e.a, env); return a === 'auto' ? this.typeOf(e.b, env) : a; }
        case 'call': {
          if (e.fn.k === 'name') {
            const n = e.fn.v;
            if (this.fnRet[n]) return this.fnRet[n];
            if (MATH.has(n) || n === 'pow') return ['floor', 'ceil', 'trunc'].includes(n) ? 'float' : 'float';
            if (n === 'abs' || n === 'max' || n === 'min') return e.args[0] ? this.typeOf(e.args[0], env) : 'int';
            if (n === 'to_string' || n === 'string') return 'str';
            if (n === 'stoi' || n === 'stol' || n === 'stoll') return 'int';
            if (n === 'stod' || n === 'stof') return 'float';
            if (n === 'round') return 'float';
          }
          if (e.fn.k === 'member') {
            const m = e.fn.name;
            const ot = this.typeOf(e.fn.obj, env);
            if (m === 'size' || m === 'length' || m === 'find') return 'int';
            if (m === 'substr') return 'str';
            if (m === 'back' || m === 'front' || m === 'at') return elemOf(ot);
            if (m === 'empty') return 'bool';
          }
          return 'auto';
        }
        case 'construct': return typeName(e.ty);
        case 'assign': return this.typeOf(e.l, env);
      }
      return 'auto';
    }

    ex(e, env, line) {
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      switch (e.k) {
        case 'num': return { c: e.v, p: P.atom };
        case 'str': return { c: pyStr(e.v), p: P.atom };
        case 'char': return { c: pyStr(e.v), p: P.atom };
        case 'bool': return { c: e.v ? 'True' : 'False', p: P.atom };
        case 'none': return { c: 'None', p: P.atom };
        case 'paren': return this.ex(e.x, env, line);
        case 'name': {
          const n = e.v;
          if (n === 'M_PI') { this.imports.add('math'); return { c: 'math.pi', p: P.post }; }
          if (n === 'M_E') { this.imports.add('math'); return { c: 'math.e', p: P.post }; }
          if (n === 'INT_MAX' || n === 'LLONG_MAX') { this.imports.add('sys'); return { c: 'sys.maxsize', p: P.post }; }
          if (n === 'INT_MIN' || n === 'LLONG_MIN') { this.imports.add('sys'); return { c: '-sys.maxsize - 1', p: P.add }; }
          if (n === 'endl') return { c: '"\\n"', p: P.atom };
          return { c: n.replace(/::/g, '.'), p: P.atom };
        }
        case 'list': return { c: '[' + e.items.map(x => E(x, P.tern)).join(', ') + ']', p: P.atom };
        case 'index': return { c: E(e.obj, P.post) + '[' + E(e.idx, P.tern) + ']', p: P.post };
        case 'un': {
          if (e.op === '!') return { c: 'not ' + E(e.x, P.not), p: P.not };
          return { c: e.op + E(e.x, P.un), p: P.un };
        }
        case 'cast': {
          const t = typeName(e.ty);
          const xt = this.typeOf(e.x, env);
          if (t === 'int') { if (xt === 'char') return { c: 'ord(' + E(e.x, P.tern) + ')', p: P.post }; if (xt === 'int') return this.ex(e.x, env, line); return { c: 'int(' + E(e.x, P.tern) + ')', p: P.post }; }
          if (t === 'float') return { c: 'float(' + E(e.x, P.tern) + ')', p: P.post };
          if (t === 'char') return { c: 'chr(' + E(e.x, P.tern) + ')', p: P.post };
          if (t === 'bool') return { c: 'bool(' + E(e.x, P.tern) + ')', p: P.post };
          if (t === 'str') return { c: 'str(' + E(e.x, P.tern) + ')', p: P.post };
          return this.ex(e.x, env, line);
        }
        case 'tern': return { c: E(e.a, P.tern + 1) + ' if ' + E(e.c, P.tern + 1) + ' else ' + E(e.b, P.tern), p: P.tern };
        case 'bin': return this.binary(e, env, line);
        case 'call': return this.call(e, env, line);
        case 'member': {
          this.warn(line, 'поле «.' + e.name + '» перенесено как есть');
          return { c: E(e.obj, P.post) + '.' + e.name, p: P.post };
        }
        case 'construct': {
          const t = typeName(e.ty);
          if (isList(t)) {
            if (e.list) return this.ex(e.list, env, line);
            if (e.args.length === 0) return { c: '[]', p: P.atom };
            const fill = e.args[1] ? E(e.args[1], P.tern) : this.zero(elemOf(t));
            return { c: '[' + fill + '] * ' + E(e.args[0], P.mul + 1), p: P.mul };
          }
          if (t === 'str') {
            if (e.args && e.args.length === 2) return { c: E(e.args[1], P.mul) + ' * ' + E(e.args[0], P.mul + 1), p: P.mul };
            if (e.args && e.args.length === 1) return { c: 'str(' + E(e.args[0], P.tern) + ')', p: P.post };
            return { c: '""', p: P.atom };
          }
          throw new SyntaxError('строка ' + line + ': тип ' + e.ty.name + ' не поддерживается');
        }
        case 'preinc': case 'postinc':
          throw new SyntaxError('строка ' + line + ': ' + e.op + ' внутри выражения не поддерживается');
        case 'assign':
          throw new SyntaxError('строка ' + line + ': присваивание внутри выражения не поддерживается');
        case 'comma':
          throw new SyntaxError('строка ' + line + ': оператор «запятая» не поддерживается');
      }
      throw new SyntaxError('строка ' + line + ': неподдерживаемое выражение');
    }
    zero(t) { return t === 'float' ? '0.0' : t === 'str' ? '""' : t === 'bool' ? 'False' : t === 'char' ? '"\\0"' : isList(t) ? '[]' : '0'; }

    binary(e, env, line) {
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      const lt = this.typeOf(e.l, env), rt = this.typeOf(e.r, env);
      let [op, pp] = BIN[e.op];
      // символы в арифметике: c - '0' → ord(c) - ord("0")
      if (['+', '-', '*'].includes(e.op) && (lt === 'char' || rt === 'char') && !(e.op === '+' && (lt === 'str' || rt === 'str'))) {
        const side = (x, t) => t === 'char' ? 'ord(' + E(x, P.tern) + ')' : E(x, pp);
        return { c: side(e.l, lt) + ' ' + op + ' ' + (rt === 'char' ? 'ord(' + E(e.r, P.tern) + ')' : E(e.r, pp + 1)), p: pp };
      }
      if (e.op === '/') {
        if (lt !== 'float' && rt !== 'float') {
          if (lt === 'auto' || rt === 'auto') this.warn(line, 'не удалось определить типы при делении — используется «//» (целочисленное)');
          op = '//';
          // C++ округляет к нулю, Python — вниз: для отрицательных чисел результат может отличаться
        }
      }
      if (e.op === '%' && (lt === 'float' || rt === 'float')) { this.imports.add('math'); return { c: 'math.fmod(' + E(e.l, P.tern) + ', ' + E(e.r, P.tern) + ')', p: P.post }; }
      if (e.op === '+' && lt === 'str' && rt === 'char') { /* str + char → конкатенация */ }
      if (e.op === '+' && (lt === 'str') && isNumT(rt) && rt !== 'char') this.warn(line, 'строка + число: проверьте преобразование');
      // в Python сравнения — одного уровня и образуют цепочки, поэтому вложенные оборачиваем в скобки
      if (pp === P.cmp) return { c: E(e.l, P.cmp + 1) + ' ' + op + ' ' + E(e.r, P.cmp + 1), p: P.cmp };
      if (op === 'and' || op === 'or') return { c: E(e.l, pp) + ' ' + op + ' ' + E(e.r, pp + 1), p: pp };
      return { c: E(e.l, pp) + ' ' + op + ' ' + E(e.r, pp + 1), p: pp };
    }

    call(e, env, line) {
      const E = (x, minP) => this.wrap(this.ex(x, env, line), minP);
      const A = () => e.args.map(a => E(a, P.tern)).join(', ');
      if (e.fn.k === 'name') {
        const n = e.fn.v;
        switch (n) {
          case 'pow': return { c: E(e.args[0], P.pow + 1) + ' ** ' + E(e.args[1], P.un), p: P.pow };
          case 'abs': case 'fabs': return { c: 'abs(' + A() + ')', p: P.post };
          case 'max': case 'min': return { c: n + '(' + A() + ')', p: P.post };
          case 'to_string': return { c: 'str(' + A() + ')', p: P.post };
          case 'stoi': case 'stol': case 'stoll': case 'atoi': return { c: 'int(' + A() + ')', p: P.post };
          case 'stod': case 'stof': case 'atof': return { c: 'float(' + A() + ')', p: P.post };
          case 'round': return { c: 'round(' + A() + ')', p: P.post };
          case 'swap': throw new SyntaxError('строка ' + line + ': swap() поддерживается только как отдельная инструкция');
          case 'sort': case 'reverse': throw new SyntaxError('строка ' + line + ': ' + n + '() поддерживается только как отдельная инструкция');
          case 'isdigit': case 'isalpha': case 'isupper': case 'islower': case 'isspace': case 'isalnum':
            return { c: E(e.args[0], P.post) + '.' + n + '()', p: P.post };
          case 'toupper': case 'tolower':
            return { c: E(e.args[0], P.post) + '.' + (n === 'toupper' ? 'upper' : 'lower') + '()', p: P.post };
          case 'printf': case 'scanf': throw new SyntaxError('строка ' + line + ': ' + n + '() не поддерживается — используйте cout/cin');
          case 'accumulate':
            if (e.args.length >= 2 && e.args[0].k === 'call' && e.args[0].fn.k === 'member' && e.args[0].fn.name === 'begin')
              return { c: 'sum(' + E(e.args[0].fn.obj, P.tern) + ')', p: P.post };
            break;
          case 'max_element': case 'min_element':
            break;
          case 'gcd': case '__gcd': this.imports.add('math'); return { c: 'math.gcd(' + A() + ')', p: P.post };
        }
        if (MATH.has(n)) {
          this.imports.add('math');
          if (n === 'floor' || n === 'ceil' || n === 'trunc') return { c: 'math.' + n + '(' + A() + ')', p: P.post };
          return { c: 'math.' + n + '(' + A() + ')', p: P.post };
        }
        return { c: n.replace(/::/g, '.') + '(' + A() + ')', p: P.post };
      }
      if (e.fn.k === 'member') {
        const objE = e.fn.obj, m = e.fn.name;
        const ot = this.typeOf(objE, env);
        const o = E(objE, P.post);
        switch (m) {
          case 'size': case 'length': return { c: 'len(' + E(objE, P.tern) + ')', p: P.post };
          case 'push_back': case 'emplace_back': return { c: o + '.append(' + A() + ')', p: P.post };
          case 'pop_back': return { c: o + '.pop()', p: P.post };
          case 'back': return { c: o + '[-1]', p: P.post };
          case 'front': return { c: o + '[0]', p: P.post };
          case 'empty': return { c: 'len(' + E(objE, P.tern) + ') == 0', p: P.cmp };
          case 'clear': return { c: o + '.clear()', p: P.post };
          case 'at': return { c: o + '[' + A() + ']', p: P.post };
          case 'substr': {
            const a = E(e.args[0], P.tern);
            if (e.args.length === 1) return { c: o + '[' + a + ':]', p: P.post };
            const len = e.args[1];
            const aN = e.args[0].k === 'num' && e.args[0].v === '0';
            return { c: o + '[' + a + ':' + (aN ? E(len, P.tern) : E(e.args[0], P.add) + ' + ' + E(len, P.add + 1)) + ']', p: P.post };
          }
          case 'find': {
            this.warn(line, 'find(): в Python возвращает -1 вместо string::npos');
            return { c: o + '.find(' + A() + ')', p: P.post };
          }
          case 'insert':
            if (e.args.length === 2 && e.args[0].k === 'bin' && e.args[0].l.k === 'call' && e.args[0].l.fn.k === 'member' && e.args[0].l.fn.name === 'begin')
              return { c: o + '.insert(' + E(e.args[0].r, P.tern) + ', ' + E(e.args[1], P.tern) + ')', p: P.post };
            break;
        }
        this.warn(line, 'метод «.' + m + '()» перенесён как есть');
        return { c: o + '.' + m + '(' + A() + ')', p: P.post };
      }
      return { c: E(e.fn, P.post) + '(' + A() + ')', p: P.post };
    }

    /* --- инструкции --- */
    body(stmts, env, ind, loop) {
      const out = [];
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        // «int a, b; cin >> a >> b;» — объявление без значения перед cin не нужно
        if (s.k === 'decl' && s.decls.every(d => !d.init && !d.ctor && !d.dims.length)) {
          let j = i + 1;
          while (j < stmts.length && stmts[j].k === 'comment') j++;
          const nx = stmts[j];
          let chain = nx && nx.k === 'expr' ? flattenShift(nx.e, '>>') : null;
          if (!chain && nx && nx.k === 'expr' && nx.e.k === 'call' && nx.e.fn.k === 'name' && nx.e.fn.v === 'getline' && nx.e.args.length === 2) chain = [{ k: 'name', v: 'cin' }, nx.e.args[1]];
          if (chain && chain[0].k === 'name' && chain[0].v === 'cin') {
            const names = chain.slice(1).filter(x => x.k === 'name').map(x => x.v);
            if (s.decls.every(d => names.includes(d.name))) {
              for (const d of s.decls) env.vars[d.name] = typeName(s.ty);
              continue;
            }
          }
        }
        // комментарий в конце строки кода — оставляем на той же строке
        if (s.k === 'comment' && s.own === false && out.length && out[out.length - 1].trim() && !s.v.includes('\n')) { out[out.length - 1] += '  # ' + s.v; continue; }
        out.push(...this.stmt(s, env, ind, loop));
      }
      // убираем пустые строки в начале/конце блока
      while (out.length && out[0].trim() === '') out.shift();
      if (!out.some(l => l.trim() && !l.trim().startsWith('#'))) out.push(ind + 'pass');
      return out;
    }
    asList(s) { return s.k === 'block' ? s.body : [s]; }

    stmt(s, env, ind, loop) {
      try { return this.stmtInner(s, env, ind, loop); }
      catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        this.warn(s.line, err.message.replace(/^строка \d+: /, ''));
        return [ind + '# TODO (не сконвертировано, строка ' + s.line + ')'];
      }
    }
    stmtInner(s, env, ind, loop) {
      const L = s.line;
      const E = (x, minP = 0) => this.wrap(this.ex(x, env, L), minP);
      switch (s.k) {
        case 'comment': return s.v.split('\n').map(l => ind + '# ' + l);
        case 'empty': return [];
        case 'error':
          this.warn(L, s.msg.replace(/^строка \d+: /, ''));
          return [ind + '# TODO (не сконвертировано): ' + (s.src || '')];
        case 'block': return this.body(s.body, env, ind, loop).filter(l => l.trim() !== 'pass');
        case 'decl': return this.decl(s, env, ind);
        case 'return': {
          if (env.isMain) {
            if (!s.e || (s.e.k === 'num' && s.e.v === '0')) return env.topLevel ? [] : [ind + 'return'];
            this.imports.add('sys');
            return [ind + 'sys.exit(' + E(s.e) + ')'];
          }
          return [ind + 'return' + (s.e ? ' ' + E(s.e) : '')];
        }
        case 'break': return [ind + 'break'];
        case 'continue': return [...(loop && loop.step ? loop.step.map(l => ind + l) : []), ind + 'continue'];
        case 'if': {
          const out = [];
          let cur = s, first = true;
          while (cur) {
            out.push(ind + (first ? 'if ' : 'elif ') + this.cond(cur.c, env, L) + ':');
            out.push(...this.body(this.asList(cur.then), env, ind + '    ', loop));
            first = false;
            if (cur.els && cur.els.k === 'if') { cur = cur.els; continue; }
            if (cur.els) { out.push(ind + 'else:'); out.push(...this.body(this.asList(cur.els), env, ind + '    ', loop)); }
            cur = null;
          }
          return out;
        }
        case 'while': {
          // while (k--) { ... }
          if (s.c.k === 'postinc' && s.c.x.k === 'name') {
            const v = s.c.x.v;
            return [ind + 'while ' + v + ' != 0:', ind + '    ' + v + (s.c.op === '++' ? ' += 1' : ' -= 1'), ...this.body(this.asList(s.body), env, ind + '    ', null).filter(l => l.trim() !== 'pass')];
          }
          const c = s.c.k === 'num' && s.c.v === '1' ? 'True' : this.cond(s.c, env, L);
          return [ind + 'while ' + c + ':', ...this.body(this.asList(s.body), env, ind + '    ', null)];
        }
        case 'dowhile': {
          const lines = this.body(this.asList(s.body), env, ind + '    ', { step: null });
          if (JSON.stringify(s.body).includes('"k":"continue"')) this.warn(L, 'continue в do-while: в Python цикл пропустит проверку условия');
          return [ind + 'while True:', ...lines.filter(l => l.trim() !== 'pass'), ind + '    if not (' + this.cond(s.c, env, L) + '):', ind + '        break'];
        }
        case 'foreach': {
          const t = typeName(s.ty);
          const ct = this.typeOf(s.coll, env);
          env.vars[s.name] = t === 'auto' ? elemOf(ct) : t;
          if (s.ty.ref && !s.ty.quals.includes('const') && JSON.stringify(s.body).includes('"k":"assign"')) this.warn(L, 'изменение элементов через ссылку (auto&) в Python не работает');
          return [ind + 'for ' + s.name + ' in ' + E(s.coll, P.tern) + ':', ...this.body(this.asList(s.body), env, ind + '    ', null)];
        }
        case 'for': return this.forLoop(s, env, ind);
        case 'switch': return this.switchStmt(s, env, ind, loop);
        case 'expr': return this.exprStmt(s.e, env, ind, L);
      }
      throw new SyntaxError('строка ' + L + ': неподдерживаемая инструкция');
    }
    cond(c, env, L) { return this.ex(c, env, L).c; }

    decl(s, env, ind) {
      const out = [];
      const t = typeName(s.ty);
      if (t.startsWith('other:')) throw new SyntaxError('строка ' + s.line + ': тип «' + t.slice(6) + '» не поддерживается');
      for (const d of s.decls) {
        let vt = t;
        let val;
        if (d.dims.length) {
          // int a[10]; int a[] = {1,2}; int m[3][4];
          vt = 'list<' + t + '>';
          const emptyInit = d.init && d.init.k === 'list' && (d.init.items.length === 0 || (d.init.items.length === 1 && d.init.items[0].k === 'num' && d.init.items[0].v === '0'));
          if (d.init && !emptyInit) val = this.ex(d.init, env, s.line).c;
          else {
            val = this.zero(t);
            for (let i = d.dims.length - 1; i >= 0; i--) {
              const dim = d.dims[i] ? this.wrap(this.ex(d.dims[i], env, s.line), P.mul + 1) : '0';
              val = i === d.dims.length - 1 ? '[' + val + '] * ' + dim : '[' + val + ' for _ in range(' + dim + ')]';
            }
          }
          if (d.dims.length > 1) for (let i = 1; i < d.dims.length; i++) vt = 'list<' + vt + '>';
        } else if (d.init) {
          if (d.init.k === 'list' && !isList(t)) val = d.init.items.length ? this.ex(d.init.items[0], env, s.line).c : this.zero(t);
          else val = this.ex(d.init, env, s.line).c;
          if (t === 'auto') vt = this.typeOf(d.init, env);
          if (t === 'int' && this.typeOf(d.init, env) === 'float') val = 'int(' + val + ')';
          if (t === 'float' && d.init.k === 'num' && !d.init.isFloat) val = d.init.v + '.0';
          if (t === 'str' && d.init.k === 'char') { }
        } else if (d.ctor) {
          val = this.ex({ k: 'construct', ty: s.ty, args: d.ctor }, env, s.line).c;
        } else {
          val = this.zero(t);
        }
        if (isList(vt) && d.ctor && d.ctor.length === 2 && d.ctor[1].k === 'construct') {
          // vector<vector<int>> m(n, vector<int>(k, 0)) → списки без общих ссылок
          const inner = this.ex(d.ctor[1], env, s.line).c;
          val = '[' + inner + ' for _ in range(' + this.ex(d.ctor[0], env, s.line).c + ')]';
        }
        env.vars[d.name] = vt;
        out.push(ind + d.name + ' = ' + val);
      }
      return out;
    }

    exprStmt(e, env, ind, L) {
      const E = (x, minP = 0) => this.wrap(this.ex(x, env, L), minP);
      // cout << ...
      const chain = flattenShift(e, '<<');
      if (chain && chain[0].k === 'name' && (chain[0].v === 'cout' || chain[0].v === 'cerr')) return this.cout(chain.slice(1), env, ind, L, chain[0].v === 'cerr');
      const inChain = flattenShift(e, '>>');
      if (inChain && inChain[0].k === 'name' && inChain[0].v === 'cin') return this.cin(inChain.slice(1), env, ind, L);
      if (e.k === 'postinc' || e.k === 'preinc') {
        if (e.x.k === 'name' && !(e.x.v in env.vars) && e.x.v in this.globals && env.usedGlobals) env.usedGlobals.add(e.x.v);
        return [ind + E(e.x) + (e.op === '++' ? ' += 1' : ' -= 1')];
      }
      if (e.k === 'assign') {
        // цепочка a = b = 0
        if (e.op === '=' && e.r.k === 'assign' && e.r.op === '=') {
          const targets = [];
          let cur = e;
          while (cur.k === 'assign' && cur.op === '=') { targets.push(E(cur.l)); cur = cur.r; }
          return [ind + targets.join(' = ') + ' = ' + E(cur)];
        }
        const lt = this.typeOf(e.l, env), rt = this.typeOf(e.r, env);
        let op = e.op;
        if (op === '/=' && lt !== 'float' && rt !== 'float') op = '//=';
        let r = e.r.k === 'list' && !isList(lt) ? this.ex(e.r.items[0], env, L).c : E(e.r);
        if (op === '=' && lt === 'int' && rt === 'float') r = 'int(' + r + ')';
        if ((op === '+=' || op === '-=') && lt === 'char') return [ind + E(e.l) + ' = chr(ord(' + E(e.l) + ') ' + op[0] + ' ' + (rt === 'char' ? 'ord(' + r + ')' : r) + ')'];
        if (op === '%=' && (lt === 'float' || rt === 'float')) { this.imports.add('math'); return [ind + E(e.l) + ' = math.fmod(' + E(e.l) + ', ' + r + ')']; }
        if (e.l.k === 'index' && this.typeOf(e.l.obj, env) === 'str') this.warn(L, 'строки в Python неизменяемы: s[i] = ... вызовет ошибку');
        if (e.l.k === 'name' && !(e.l.v in env.vars) && e.l.v in this.globals && env.usedGlobals) env.usedGlobals.add(e.l.v);
        return [ind + E(e.l) + ' ' + op + ' ' + r];
      }
      if (e.k === 'call' && e.fn.k === 'name') {
        const n = e.fn.v;
        if (n === 'swap') return [ind + E(e.args[0]) + ', ' + E(e.args[1]) + ' = ' + E(e.args[1]) + ', ' + E(e.args[0])];
        if ((n === 'sort' || n === 'reverse') && e.args.length >= 2) {
          const a = e.args[0];
          if (a.k === 'call' && a.fn.k === 'member' && (a.fn.name === 'begin' || a.fn.name === 'rbegin')) {
            const o = E(a.fn.obj, P.post);
            if (n === 'reverse') return [ind + o + '.reverse()'];
            const desc = a.fn.name === 'rbegin' || (e.args[2] && /greater/.test(JSON.stringify(e.args[2])));
            return [ind + o + '.sort(' + (desc ? 'reverse=True' : '') + ')'];
          }
        }
        if (n === 'getline' && e.args[0] && e.args[0].k === 'name' && e.args[0].v === 'cin') return [ind + E(e.args[1]) + ' = input()'];
      }
      if (e.k === 'comma') return [...this.exprStmt(e.l, env, ind, L), ...this.exprStmt(e.r, env, ind, L)];
      return [ind + E(e)];
    }

    cout(parts, env, ind, L, isErr) {
      // разбиваем на «строки вывода» по endl / "\n"
      const lines = [];
      let cur = [];
      for (const p of parts) {
        if (p.k === 'name' && (p.v === 'endl')) { cur.push({ nl: true }); lines.push(cur); cur = []; continue; }
        if (p.k === 'name' && p.v === 'fixed') { this.fmt.fixed = true; continue; }
        if (p.k === 'call' && p.fn.k === 'name' && p.fn.v === 'setprecision') { this.fmt.prec = this.ex(p.args[0], env, L).c; continue; }
        if (p.k === 'name' && ['flush', 'boolalpha', 'noboolalpha'].includes(p.v)) continue;
        if ((p.k === 'str' || p.k === 'char') && p.v.includes('\n')) {
          const segs = p.v.split('\n');
          segs.forEach((sg, i) => {
            if (sg) cur.push({ e: { k: 'str', v: sg } });
            if (i < segs.length - 1) { cur.push({ nl: true }); lines.push(cur); cur = []; }
          });
          continue;
        }
        cur.push({ e: p });
      }
      if (cur.length) lines.push(cur);
      const out = [];
      for (const ln of lines) {
        const nl = ln.length && ln[ln.length - 1].nl;
        const items = ln.filter(x => !x.nl).map(x => x.e);
        out.push(ind + this.printCall(items, nl, env, L, isErr));
      }
      return out;
    }
    printCall(items, nl, env, L, isErr) {
      const extra = [];
      if (!nl) extra.push('end=""');
      if (isErr) { this.imports.add('sys'); extra.push('file=sys.stderr'); }
      if (!items.length) return 'print(' + extra.join(', ') + ')';
      const fmtF = this.fmt.fixed && this.fmt.prec;
      // f-строка, если есть и текст, и выражения
      const hasLit = items.some(i => i.k === 'str' || i.k === 'char');
      const exprs = items.filter(i => i.k !== 'str' && i.k !== 'char');
      const codeOf = x => {
        const t = this.typeOf(x, env);
        let c = this.ex(x, env, L).c;
        if (t === 'bool') c = 'int(' + c + ')';
        return { c, t };
      };
      if (items.length === 1 && !hasLit) {
        const { c, t } = codeOf(items[0]);
        if (fmtF && (t === 'float' || t === 'auto')) return 'print(f"{' + c + ':.' + this.fmt.prec + 'f}"' + (extra.length ? ', ' + extra.join(', ') : '') + ')';
        if (t === 'float' && !fmtF) this.warn(L, 'вещественные числа Python выводит иначе (например, 5.0 вместо 5)');
        return 'print(' + c + (extra.length ? ', ' + extra.join(', ') : '') + ')';
      }
      if (hasLit && exprs.length) {
        let s = '', ok = true;
        for (const it of items) {
          if (it.k === 'str' || it.k === 'char') s += pyStr(it.v).slice(1, -1).replace(/\{/g, '{{').replace(/\}/g, '}}');
          else {
            const { c, t } = codeOf(it);
            if (/["\\{}]/.test(c) || c.includes('\n')) ok = false;
            if (t === 'float' && !fmtF) this.warn(L, 'вещественные числа Python выводит иначе (например, 5.0 вместо 5)');
            s += '{' + c + (fmtF && (t === 'float' || t === 'auto') ? ':.' + this.fmt.prec + 'f' : '') + '}';
          }
        }
        if (ok) return 'print(f"' + s + '"' + (extra.length ? ', ' + extra.join(', ') : '') + ')';
      }
      const args = items.map(it => (it.k === 'str' || it.k === 'char') ? pyStr(it.v) : codeOf(it).c);
      if (args.length > 1) extra.unshift('sep=""');
      return 'print(' + args.join(', ') + (extra.length ? ', ' + extra.join(', ') : '') + ')';
    }
    cin(targets, env, ind, L) {
      const conv = (t, c) => t === 'int' ? 'int(' + c + ')' : t === 'float' ? 'float(' + c + ')' : c;
      const ts = targets.map(x => ({ c: this.ex(x, env, L).c, t: this.typeOf(x, env) }));
      if (ts.some(x => x.t === 'auto')) this.warn(L, 'тип переменной для cin неизвестен — читается строка');
      if (ts.length === 1) {
        const x = ts[0];
        if (x.t === 'char') return [ind + x.c + ' = input()[0]'];
        if (x.t === 'str') { this.warn(L, 'cin >> строка читает одно слово, input() — всю строку'); return [ind + x.c + ' = input().split()[0]']; }
        return [ind + x.c + ' = ' + conv(x.t, 'input()')];
      }
      this.warn(L, 'cin >> a >> b: значения ожидаются в одной строке через пробел');
      const same = ts.every(x => x.t === ts[0].t);
      if (same && (ts[0].t === 'int' || ts[0].t === 'float')) return [ind + ts.map(x => x.c).join(', ') + ' = map(' + ts[0].t + ', input().split())'];
      if (same && ts[0].t === 'str') return [ind + ts.map(x => x.c).join(', ') + ' = input().split()'];
      const v = '_parts' + (this.tmp ? this.tmp : '');
      this.tmp++;
      return [ind + v + ' = input().split()', ...ts.map((x, i) => ind + x.c + ' = ' + conv(x.t, v + '[' + i + ']'))];
    }

    forLoop(s, env, ind) {
      const L = s.line;
      const E = (x, minP = 0) => this.wrap(this.ex(x, env, L), minP);
      // пробуем распознать for (int i = a; i < b; i++)
      const r = this.rangeFor(s, env);
      if (r) return [ind + 'for ' + r.v + ' in ' + r.range + ':', ...this.body(this.asList(s.body), env, ind + '    ', null)];
      // общий случай → while
      const out = [];
      if (s.init) out.push(...(s.init.k === 'decl' ? this.decl(s.init, env, ind) : this.exprStmt(s.init.e, env, ind, L)));
      const stepLines = s.step ? this.exprStmt(s.step, env, '', L) : [];
      out.push(ind + 'while ' + (s.c ? this.cond(s.c, env, L) : 'True') + ':');
      const body = this.body(this.asList(s.body), env, ind + '    ', { step: stepLines }).filter(l => l.trim() !== 'pass');
      out.push(...body, ...stepLines.map(l => ind + '    ' + l));
      if (!body.length && !stepLines.length) out.push(ind + '    pass');
      return out;
    }
    rangeFor(s, env) {
      const L = s.line;
      let v, start;
      if (s.init && s.init.k === 'decl' && s.init.decls.length === 1 && s.init.decls[0].init && typeName(s.init.ty) === 'int') { v = s.init.decls[0].name; start = s.init.decls[0].init; }
      else if (s.init && s.init.k === 'expr' && s.init.e.k === 'assign' && s.init.e.op === '=' && s.init.e.l.k === 'name') { v = s.init.e.l.v; start = s.init.e.r; }
      else return null;
      if (!s.c || s.c.k !== 'bin' || !['<', '<=', '>', '>=', '!='].includes(s.c.op)) return null;
      let cop = s.c.op, bound;
      if (s.c.l.k === 'name' && s.c.l.v === v) bound = s.c.r;
      else if (s.c.r.k === 'name' && s.c.r.v === v) { bound = s.c.l; cop = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '!=': '!=' }[cop]; }
      else return null;
      // шаг
      let step = null;
      const st = s.step;
      if (!st) return null;
      if ((st.k === 'postinc' || st.k === 'preinc') && st.x.k === 'name' && st.x.v === v) step = st.op === '++' ? 1 : -1;
      else if (st.k === 'assign' && st.l.k === 'name' && st.l.v === v && (st.op === '+=' || st.op === '-=') && st.r.k === 'num' && !st.r.isFloat) step = (st.op === '+=' ? 1 : -1) * Number(st.r.v);
      else if (st.k === 'assign' && st.op === '=' && st.l.k === 'name' && st.l.v === v && st.r.k === 'bin' && st.r.l.k === 'name' && st.r.l.v === v && (st.r.op === '+' || st.r.op === '-') && st.r.r.k === 'num') step = (st.r.op === '+' ? 1 : -1) * Number(st.r.r.v);
      else return null;
      if (!step) return null;
      if (cop === '!=') { if (Math.abs(step) !== 1) return null; cop = step > 0 ? '<' : '>'; }
      if ((step > 0 && (cop === '>' || cop === '>=')) || (step < 0 && (cop === '<' || cop === '<='))) return null;
      // тело не должно менять счётчик или границу
      const bodyJ = JSON.stringify(s.body);
      const modifies = name => new RegExp('"k":"(assign|postinc|preinc)","op":"[^"]*",("l"|"x"):\\{"k":"name","v":"' + name + '"\\}').test(bodyJ);
      if (modifies(v)) return null;
      const boundNames = [];
      JSON.stringify(bound).replace(/"k":"name","v":"(\w+)"/g, (_, n) => boundNames.push(n));
      if (boundNames.some(modifies)) return null;
      if (/"name":"(push_back|pop_back|erase|insert|clear|emplace_back)"/.test(bodyJ) && /"name":"(size|length)"/.test(JSON.stringify(bound))) return null;
      env.vars[v] = 'int';
      const E = (x, minP = 0) => this.wrap(this.ex(x, env, L), minP);
      let a = E(start), b;
      // границы включительно: <= b → b + 1
      const adj = (bnd, d) => {
        if (bnd.k === 'num' && !bnd.isFloat) return String(Number(bnd.v) + d);
        if (bnd.k === 'bin' && (bnd.op === '-' || bnd.op === '+') && bnd.r.k === 'num' && Number(bnd.r.v) === Math.abs(d) && (bnd.op === '-') === (d > 0)) return E(bnd.l);
        return E(bnd, P.add) + (d > 0 ? ' + ' : ' - ') + Math.abs(d);
      };
      if (cop === '<' || cop === '>') b = E(bound);
      else if (cop === '<=') b = adj(bound, 1);
      else b = adj(bound, -1);
      if (this.typeOf(bound, env) === 'float') return null;
      let range;
      if (step === 1) range = a === '0' ? 'range(' + b + ')' : 'range(' + a + ', ' + b + ')';
      else range = 'range(' + a + ', ' + b + ', ' + step + ')';
      return { v, range };
    }
    switchStmt(s, env, ind, loop) {
      const out = [];
      const subj = this.ex(s.subj, env, s.line).c;
      let first = true;
      const simpleSubj = /^\w+$/.test(subj);
      let sv = subj;
      if (!simpleSubj) { sv = '_sw'; out.push(ind + sv + ' = ' + subj); }
      const defaults = s.cases.filter(c => c.isDefault);
      const cases = s.cases.filter(c => !c.isDefault);
      for (const c of [...cases, ...defaults]) {
        let body = c.body.slice();
        const last = body[body.length - 1];
        if (last && last.k === 'break') body = body.slice(0, -1);
        else if (last && last.k !== 'return' && c !== s.cases[s.cases.length - 1]) this.warn(c.body[0] ? c.body[0].line : s.line, 'case без break (проваливание) не поддерживается');
        if (body.some(b => b.k === 'break')) this.warn(s.line, 'break в середине case пропущен');
        if (c.isDefault) {
          if (first) { out.push(...this.body(body, env, ind, loop)); continue; }
          out.push(ind + 'else:');
        } else {
          const conds = c.vals.map(v => sv + ' == ' + this.ex(v, env, s.line).c);
          out.push(ind + (first ? 'if ' : 'elif ') + conds.join(' or ') + ':');
        }
        first = false;
        out.push(...this.body(body, env, ind + '    ', loop));
      }
      return out;
    }

    func(f) {
      const env = { vars: {}, isMain: f.name === 'main', usedGlobals: new Set(), topLevel: false };
      const params = f.params.map(p => {
        env.vars[p.name] = typeName(p.ty);
        let s = p.name;
        if (p.def) s += '=' + this.ex(p.def, env, f.line).c;
        if (p.ty.ref && !p.ty.quals.includes('const') && !isList(typeName(p.ty))) this.warn(f.line, 'параметр «' + p.name + '» передаётся по ссылке (&) — в Python изменения не вернутся в вызывающий код');
        return s;
      });
      const name = f.name === 'main' ? 'main' : f.name;
      let stmts = f.body;
      const last = stmts[stmts.length - 1];
      if (env.isMain && last && last.k === 'return' && (!last.e || (last.e.k === 'num' && last.e.v === '0'))) stmts = stmts.slice(0, -1);
      if (typeName(f.ret) === 'void' && last && last.k === 'return' && !last.e) stmts = stmts.slice(0, -1);
      const body = this.body(stmts, env, '    ', null);
      // global для изменяемых глобальных переменных
      const assignedGlobals = [...env.usedGlobals].filter(g => !(g in Object.fromEntries(f.params.map(p => [p.name, 1]))));
      const lines = ['def ' + name + '(' + params.join(', ') + '):'];
      if (assignedGlobals.length) lines.push('    global ' + assignedGlobals.join(', '));
      lines.push(...body);
      return lines;
    }
  }

  function flattenShift(e, op) {
    const parts = [];
    let cur = e;
    while (cur.k === 'bin' && cur.op === op) { parts.unshift(cur.r); cur = cur.l; }
    if (!parts.length) return null;
    parts.unshift(cur);
    return parts;
  }

  // ровно две пустые строки перед def / if __name__ (вместе с комментариями над ними)
  function pep8Blank(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const isTop = /^(def |if __name__)/.test(l);
      const startsBlock = isTop || (/^#/.test(l) && (() => { let j = i; while (j < lines.length && /^#/.test(lines[j])) j++; return /^(def |if __name__)/.test(lines[j] || ''); })());
      if (startsBlock) {
        const mark = out.length;
        while (out.length && out[out.length - 1].trim() === '') out.pop();
        const afterComment = isTop && out.length && /^#/.test(out[out.length - 1]) && mark - out.length <= 1;
        if (out.length && !afterComment) out.push('', '');
      }
      if (l.trim() === '' && out.length && out[out.length - 1].trim() === '' && out.length > 1 && out[out.length - 2].trim() === '') continue;
      out.push(l);
    }
    return out.join('\n').replace(/^\n+/, '').trimEnd() + '\n';
  }

  function convert(code) {
    const gen = new Gen();
    let items;
    try {
      items = new Parser(tokenize(code)).program();
    } catch (e) {
      if (e instanceof SyntaxError) return { code: '# Не удалось разобрать код: ' + e.message + '\n', warnings: [e.message] };
      throw e;
    }
    const out = [];
    // типы возвращаемых значений и глобальных переменных заранее
    for (const it of items) if (it.k === 'func') gen.fnRet[it.name] = typeName(it.ret);
    const globalEnv = { vars: gen.globals, isMain: false, usedGlobals: new Set(), topLevel: true };
    const bodyParts = [];
    let hasMain = false;
    for (const it of items) {
      if (it.k === 'comment') { bodyParts.push(['# ' + it.v.split('\n').join('\n# ')]); continue; }
      if (it.k === 'unsupported') { gen.warn(it.line, '«' + it.what + '» не поддерживается и пропущен'); bodyParts.push(['# TODO (не сконвертировано): ' + it.what + ' (строка ' + it.line + ')']); continue; }
      if (it.k === 'error') { gen.warn(it.line, it.msg.replace(/^строка \d+: /, '')); bodyParts.push(['# TODO (не сконвертировано, строка ' + it.line + ')']); continue; }
      if (it.k === 'decl') { bodyParts.push(gen.stmt(it, globalEnv, '', null)); continue; }
      if (it.k === 'topstmt') { bodyParts.push(gen.stmt(it.s, globalEnv, '', null)); continue; }
      if (it.k === 'func') {
        if (it.name === 'main') hasMain = true;
        bodyParts.push(['', ...gen.func(it), '']);
      }
    }
    for (const p of bodyParts) out.push(...p);
    if (hasMain) out.push('', 'if __name__ == "__main__":', '    main()');
    const header = [];
    if (gen.imports.size) header.push(...[...gen.imports].sort().map(m => 'import ' + m), '');
    let text = [...header, ...out].join('\n').replace(/\n{3,}/g, '\n\n\n').replace(/^\n+/, '').trimEnd() + '\n';
    // две пустые строки между функциями (PEP 8)
    text = pep8Blank(text);
    return { code: text, warnings: gen.warnings };
  }

  return { convert };
})();

if (typeof module !== 'undefined') module.exports = CppToPy;
