/**
 * Event dispatcher: replaces inline event-handler attributes (onclick="...") so the page can run under a
 * Content-Security-Policy with no 'unsafe-inline'.
 *
 *   <button onclick="save(5, 'x')">   becomes   <button data-onclick="save(5, 'x')">
 *
 * It is NOT eval. The attribute is parsed by a small interpreter that understands only: literals, this/event,
 * property access, calls, ! && || == === != !==, assignment, `return`, and `if (...) stmt`. Names that could run
 * arbitrary code or reach secrets (eval, Function, setTimeout, innerHTML, cookie, localStorage, fetch, ...) are
 * refused, so injected markup carrying a data-on* attribute cannot do more than the page's own functions allow.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // A null-prototype table: in an object literal, "__proto__: 1" would set the prototype instead of adding a key.
    var BLOCKED = Object.create(null);
    ('eval Function constructor __proto__ prototype __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ ' +
     'setTimeout setInterval setImmediate execScript importScripts import write writeln srcdoc innerHTML outerHTML ' +
     'insertAdjacentHTML createContextualFragment cookie localStorage sessionStorage indexedDB fetch XMLHttpRequest ' +
     'sendBeacon WebSocket Worker SharedWorker Proxy Reflect globalThis self top parent frames').split(' ')
        .forEach(function (n) { BLOCKED[n] = 1; });

    // ---------- tokenizer ----------
    function tokenize(src) {
        var t = [], i = 0, n = src.length, c;
        while (i < n) {
            c = src[i];
            if (/\s/.test(c)) { i++; continue; }
            if (c === '"' || c === "'") {
                var q = c, s = '';
                i++;
                while (i < n && src[i] !== q) {
                    if (src[i] === '\\' && i + 1 < n) {
                        i++;
                        var e = src[i];
                        if (e === 'u' && /^[0-9a-fA-F]{4}/.test(src.substr(i + 1, 4))) { s += String.fromCharCode(parseInt(src.substr(i + 1, 4), 16)); i += 4; }
                        else if (e === 'x' && /^[0-9a-fA-F]{2}/.test(src.substr(i + 1, 2))) { s += String.fromCharCode(parseInt(src.substr(i + 1, 2), 16)); i += 2; }
                        else s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
                    } else s += src[i];
                    i++;
                }
                if (i >= n) throw new Error('unterminated string');
                i++;
                t.push({ k: 'str', v: s });
                continue;
            }
            if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || '') && (!t.length || /^(op|punc)$/.test(t[t.length - 1].k) && t[t.length - 1].v !== ')' && t[t.length - 1].v !== ']'))) {
                var m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
                t.push({ k: 'num', v: parseFloat(m[0]) });
                i += m[0].length;
                continue;
            }
            if (/[A-Za-z_$]/.test(c)) {
                var m2 = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
                t.push({ k: 'id', v: m2[0] });
                i += m2[0].length;
                continue;
            }
            var three = src.substr(i, 3), two = src.substr(i, 2);
            if (three === '===' || three === '!==') { t.push({ k: 'op', v: three }); i += 3; continue; }
            if (two === '==' || two === '!=' || two === '&&' || two === '||') { t.push({ k: 'op', v: two }); i += 2; continue; }
            if ('!='.indexOf(c) > -1) { t.push({ k: 'op', v: c }); i++; continue; }
            if ('(),.;[]{}?:'.indexOf(c) > -1) { t.push({ k: 'punc', v: c }); i++; continue; }
            throw new Error('unsupported character ' + c);
        }
        return t;
    }

    // ---------- parser (to a tiny AST) ----------
    function parse(src) {
        var tok = tokenize(src), p = 0;
        function peek() { return tok[p]; }
        function eat(v) { var x = tok[p]; if (!x || (v !== undefined && x.v !== v)) throw new Error('expected ' + v); p++; return x; }
        function is(v) { return tok[p] && tok[p].v === v && tok[p].k !== 'str'; }

        function statement() {
            if (peek() && peek().k === 'id' && peek().v === 'return') {
                p++;
                if (!peek() || is(';')) return { t: 'return', e: null };
                return { t: 'return', e: expression() };
            }
            if (peek() && peek().k === 'id' && peek().v === 'if') {
                p++; eat('(');
                var cond = expression(); eat(')');
                var yes = statement(), no = null;
                if (is(';') && tok[p + 1] && tok[p + 1].k === 'id' && tok[p + 1].v === 'else') p++;
                if (peek() && peek().k === 'id' && peek().v === 'else') { p++; no = statement(); }
                return { t: 'if', c: cond, y: yes, n: no };
            }
            return { t: 'expr', e: expression() };
        }
        function expression() {
            var left = ternary();
            if (is('=') && tok[p].k === 'op') {
                if (left.t !== 'member') throw new Error('bad assignment target');
                p++;
                return { t: 'assign', l: left, r: expression() };
            }
            return left;
        }
        function ternary() {
            var c = or();
            if (is('?')) { p++; var a = expression(); eat(':'); var b = expression(); return { t: 'cond', c: c, a: a, b: b }; }
            return c;
        }
        function or() { var l = and(); while (is('||')) { p++; l = { t: 'or', l: l, r: and() }; } return l; }
        function and() { var l = equality(); while (is('&&')) { p++; l = { t: 'and', l: l, r: equality() }; } return l; }
        function equality() {
            var l = unary();
            while (peek() && peek().k === 'op' && /^(===|!==|==|!=)$/.test(peek().v)) {
                var op = tok[p++].v; l = { t: 'eq', op: op, l: l, r: unary() };
            }
            return l;
        }
        function unary() {
            if (is('!') && tok[p].k === 'op') { p++; return { t: 'not', e: unary() }; }
            return postfix();
        }
        function postfix() {
            var node = primary();
            for (;;) {
                if (is('.')) {
                    p++;
                    var name = eat();
                    if (name.k !== 'id') throw new Error('bad property');
                    node = { t: 'member', o: node, p: { t: 'lit', v: name.v } };
                } else if (is('[')) {
                    p++; var idx = expression(); eat(']');
                    node = { t: 'member', o: node, p: idx };
                } else if (is('(')) {
                    p++;
                    var args = [];
                    if (!is(')')) { args.push(expression()); while (is(',')) { p++; args.push(expression()); } }
                    eat(')');
                    node = { t: 'call', f: node, a: args };
                } else break;
            }
            return node;
        }
        function primary() {
            var x = tok[p];
            if (!x) throw new Error('unexpected end');
            if (x.k === 'str' || x.k === 'num') { p++; return { t: 'lit', v: x.v }; }
            if (x.k === 'id') {
                p++;
                if (x.v === 'true') return { t: 'lit', v: true };
                if (x.v === 'false') return { t: 'lit', v: false };
                if (x.v === 'null') return { t: 'lit', v: null };
                if (x.v === 'undefined') return { t: 'lit', v: undefined };
                return { t: 'id', n: x.v };
            }
            if (is('(')) { p++; var e = expression(); eat(')'); return e; }
            if (is('[')) {
                p++;
                var items = [];
                if (!is(']')) { items.push(expression()); while (is(',')) { p++; if (is(']')) break; items.push(expression()); } }
                eat(']');
                return { t: 'arr', i: items };
            }
            if (is('{')) {
                p++;
                var pairs = [];
                while (!is('}')) {
                    var kt = tok[p++];
                    if (!kt || (kt.k !== 'str' && kt.k !== 'id' && kt.k !== 'num')) throw new Error('bad object key');
                    eat(':');
                    pairs.push([String(kt.v), expression()]);
                    if (is(',')) p++; else break;
                }
                eat('}');
                return { t: 'obj', p: pairs };
            }
            throw new Error('unexpected ' + x.v);
        }

        var stmts = [];
        while (p < tok.length) {
            if (is(';')) { p++; continue; }
            stmts.push(statement());
            if (p < tok.length && !is(';')) throw new Error('unexpected ' + tok[p].v);
        }
        return stmts;
    }

    // ---------- evaluator ----------
    var RETURN = {};
    function guardName(name) {
        if (BLOCKED[name] === 1) throw new Error('blocked name: ' + name);
    }
    function evalNode(n, env) {
        switch (n.t) {
            case 'lit': return n.v;
            case 'id':
                if (n.n === 'this') return env.el;
                if (n.n === 'event') return env.ev;
                if (n.n === 'window') return env.win;
                if (n.n === 'document') return env.win.document;
                guardName(n.n);
                if (!(n.n in env.win)) throw new Error('unknown name: ' + n.n);
                return env.win[n.n];
            case 'member':
                var o = evalNode(n.o, env), key = evalNode(n.p, env);
                guardName(String(key));
                if (o === null || o === undefined) throw new Error('cannot read ' + key);
                return o[key];
            case 'call':
                var f = n.f, self, fn;
                if (f.t === 'member') {
                    self = evalNode(f.o, env);
                    var k = evalNode(f.p, env);
                    guardName(String(k));
                    fn = self[k];
                } else {
                    fn = evalNode(f, env);
                    self = env.win;
                }
                if (typeof fn !== 'function') throw new Error('not a function');
                return fn.apply(self, n.a.map(function (a) { return evalNode(a, env); }));
            case 'assign':
                var target = evalNode(n.l.o, env), prop = evalNode(n.l.p, env);
                guardName(String(prop));
                if (target === null || target === undefined) throw new Error('cannot assign');
                return (target[prop] = evalNode(n.r, env));
            case 'arr': return n.i.map(function (x) { return evalNode(x, env); });
            case 'obj':
                var out = {};
                n.p.forEach(function (kv) { guardName(kv[0]); out[kv[0]] = evalNode(kv[1], env); });
                return out;
            case 'not': return !evalNode(n.e, env);
            case 'or': return evalNode(n.l, env) || evalNode(n.r, env);
            case 'and': return evalNode(n.l, env) && evalNode(n.r, env);
            case 'cond': return evalNode(n.c, env) ? evalNode(n.a, env) : evalNode(n.b, env);
            case 'eq':
                var a = evalNode(n.l, env), b = evalNode(n.r, env);
                return n.op === '===' ? a === b : n.op === '!==' ? a !== b : n.op === '==' ? a == b : a != b; // eslint-disable-line eqeqeq
        }
        throw new Error('unsupported');
    }
    function runStmt(s, env) {
        if (s.t === 'return') { env.returned = s.e ? evalNode(s.e, env) : undefined; env.didReturn = true; return; }
        if (s.t === 'if') {
            if (evalNode(s.c, env)) runStmt(s.y, env); else if (s.n) runStmt(s.n, env);
            return;
        }
        evalNode(s.e, env);
    }

    var cache = {};
    function run(src, el, ev, win) {
        var prog = cache[src] || (cache[src] = parse(src));
        var env = { el: el, ev: ev, win: win || root, returned: undefined, didReturn: false };
        for (var i = 0; i < prog.length && !env.didReturn; i++) runStmt(prog[i], env);
        return env;
    }

    // ---------- DOM wiring ----------
    // attribute event name -> DOM event that carries it (capture for events that do not bubble)
    var MAP = {
        click: 'click', dblclick: 'dblclick', change: 'change', input: 'input', keyup: 'keyup', keydown: 'keydown',
        keypress: 'keypress', submit: 'submit', blur: 'focusout', focus: 'focusin', mouseover: 'mouseover',
        mouseout: 'mouseout', mouseenter: 'mouseover', mouseleave: 'mouseout', scroll: 'scroll', drop: 'drop',
        dragover: 'dragover', load: 'load', error: 'error', toggle: 'toggle'
    };

    function install(win) {
        var doc = win.document;
        var domEvents = {};
        Object.keys(MAP).forEach(function (name) { (domEvents[MAP[name]] = domEvents[MAP[name]] || []).push(name); });

        Object.keys(domEvents).forEach(function (type) {
            var capture = /^(load|error|scroll|toggle)$/.test(type);
            doc.addEventListener(type, function (ev) {
                var names = domEvents[type];
                for (var node = ev.target; node && node.nodeType === 1; node = node.parentElement) {
                    for (var i = 0; i < names.length; i++) {
                        var attr = 'data-on' + names[i];
                        if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
                        // mouseenter / mouseleave only fire when the pointer crosses the element's own edge
                        if ((names[i] === 'mouseenter' || names[i] === 'mouseleave') && ev.relatedTarget && node.contains(ev.relatedTarget)) continue;
                        try {
                            var env = run(node.getAttribute(attr), node, ev, win);
                            if (env.didReturn && env.returned === false) ev.preventDefault();
                        } catch (err) {
                            if (win.console) win.console.error('[okw-events] ' + attr + ' failed:', err && err.message, node.getAttribute(attr));
                        }
                    }
                    if (ev.cancelBubble) break;
                    if (capture) break; // non-bubbling events only concern their own target
                }
                // An inline handler that called stopPropagation() kept document/window listeners (like "click outside
                // closes the menu") from seeing the click. Delegating from document must not change that.
                if (ev.cancelBubble && typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
            }, capture);
        });

        // Stylesheets loaded without blocking (media="print" then swapped to "all"): done here, not in onload="".
        function swapMedia() {
            var links = doc.querySelectorAll('link[data-media-swap]');
            for (var i = 0; i < links.length; i++) links[i].media = 'all';
        }
        swapMedia();
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', swapMedia);
        win.addEventListener('load', swapMedia);
    }

    return { parse: parse, run: run, install: install, BLOCKED: BLOCKED, MAP: MAP };
});
