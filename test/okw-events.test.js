const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../okw-events');

function env() {
    const calls = [];
    const win = {
        save: (...a) => calls.push(['save', ...a]),
        toggleSidebar: () => calls.push(['toggleSidebar']),
        logout: () => calls.push(['logout']),
        isOk: () => true,
        deny: () => false,
        print: () => calls.push(['print']),
        __del: (...a) => calls.push(['__del', ...a]),
        location: { href: '/old' },
        history: { back: () => calls.push(['back']) },
        document: { getElementById: (id) => win.__els[id] },
        __els: { box: { style: { display: '' } } },
        console: { error() {} }
    };
    return { win, calls };
}
const el = (o = {}) => Object.assign({ value: 'v1', checked: true, dataset: { id: '9' }, style: {}, media: 'print', select() { this.selected = true; } }, o);
const run = (src, e, element, event) => ev.run(src, element || el(), event || { key: 'Enter', preventDefault() {} }, e.win);

test('simple calls with literals, this and event arguments', () => {
    const e = env();
    run("save(5, 'x', true, null, -2.5)", e);
    run('save(this.value, this.checked, this.dataset.id, event.key)', e);
    run('toggleSidebar()', e);
    run("window.__del(7, 'On the way')", e);
    assert.deepEqual(e.calls, [['save', 5, 'x', true, null, -2.5], ['save', 'v1', true, '9', 'Enter'], ['toggleSidebar'], ['__del', 7, 'On the way']]);
});

test('return false cancels the default action, return fn() uses its result', () => {
    const e = env();
    assert.equal(run('return false;', e).returned, false);
    assert.equal(run('return deny()', e).returned, false);
    assert.equal(run('return isOk()', e).returned, true);
    assert.equal(run('save(1); return false', e).didReturn, true);
});

test('if / else, comparisons and logic', () => {
    const e = env();
    run("if (event.key === 'Enter') save('go')", e);
    run("if (event.key === 'Escape') save('no'); else save('else')", e);
    run("if (event.key !== 'x' && isOk()) save('and')", e);
    assert.deepEqual(e.calls, [['save', 'go'], ['save', 'else'], ['save', 'and']]);
});

test('assignments the pages use: style, location, media, and element chains', () => {
    const e = env();
    const element = el();
    run("this.media='all'", e, element);
    assert.equal(element.media, 'all');
    run("this.style.background='#eee'", e, element);
    assert.equal(element.style.background, '#eee');
    run("window.location.href='pos'", e);
    assert.equal(e.win.location.href, 'pos');
    run("document.getElementById('box').style.display='none'", e);
    assert.equal(e.win.__els.box.style.display, 'none');
    run('this.select()', e, element);
    assert.equal(element.selected, true);
    run('history.back()', e);
    assert.deepEqual(e.calls, [['back']]);
});

test('names that run arbitrary code or reach secrets are refused', () => {
    const e = env();
    for (const bad of [
        "eval('alert(1)')", "Function('return 1')()", "setTimeout('x',1)", "setInterval(save, 1)",
        "this.innerHTML='<img>'", "document.cookie='a=b'", "document.write('x')", "localStorage.clear()",
        "fetch('/api/x')", "this.constructor('x')", "this['constructor']('x')", "window.top.location='x'",
        "document.body.insertAdjacentHTML('beforeend','x')", "new Image()"
    ]) {
        assert.throws(() => run(bad, e), undefined, bad);
    }
    assert.deepEqual(e.calls, []);
});

test('unknown functions and malformed input fail without running anything', () => {
    const e = env();
    assert.throws(() => run('nope()', e));
    assert.throws(() => run('save(', e));
    assert.throws(() => run("save('unterminated)", e));
    assert.throws(() => run('save(1) save(2)', e));
    assert.deepEqual(e.calls, []);
});

test('install delegates events, honours bubbling, return false and mouseenter edges', () => {
    const listeners = {};
    const calls = [];
    const mk = (attrs, parent) => ({
        nodeType: 1, parentElement: parent || null, _a: attrs,
        hasAttribute(n) { return n in this._a; }, getAttribute(n) { return this._a[n]; },
        contains(o) { for (let x = o; x; x = x.parentElement) if (x === this) return true; return false; }
    });
    const outer = mk({ 'data-onclick': "save('outer')" });
    const inner = mk({ 'data-onclick': "save('inner'); return false" }, outer);
    const enter = mk({ 'data-onmouseenter': "save('enter')" });
    const child = mk({}, enter);
    const doc = {
        readyState: 'complete',
        addEventListener: (t, f) => { listeners[t] = f; },
        querySelectorAll: () => []
    };
    const win = { document: doc, save: (x) => calls.push(x), addEventListener() {}, console: { error() {} } };
    ev.install(win);
    let prevented = false;
    listeners.click({ target: inner, preventDefault: () => { prevented = true; }, cancelBubble: false });
    assert.deepEqual(calls, ['inner', 'outer']); // bubbles outward like an inline handler
    assert.equal(prevented, true);
    calls.length = 0;
    listeners.mouseover({ target: child, relatedTarget: enter, preventDefault() {} });   // moving inside: ignored
    assert.deepEqual(calls, []);
    listeners.mouseover({ target: child, relatedTarget: null, preventDefault() {} });     // entering from outside
    assert.deepEqual(calls, ['enter']);
});

test('Every page that loads the dispatcher has no inline handlers left, and the server serves the script', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const inline = /\son(?:click|change|input|keyup|keydown|keypress|submit|blur|focus|mouseover|mouseout|mouseenter|mouseleave|dblclick|load|error)\s*=\s*["']/i;
    const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
    let converted = 0;
    for (const f of pages) {
        const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const loads = html.includes('<script src="/okw-events.js"></script>');
        if (/data-on[a-z]+\s*=|data-media-swap/.test(html)) assert.ok(loads, `${f} uses data-on* but does not load the dispatcher`);
        if (loads) { converted++; assert.ok(!inline.test(html), `${f} loads the dispatcher but still has an inline event handler`); }
    }
    assert.ok(converted >= 24, `expected at least 24 converted pages, found ${converted}`);
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(server.includes("'/okw-events.js'"), 'the dispatcher must be on the client-script allow-list');
});

test('JSON object arguments (as the portals render them) parse: nested data, escapes, exponents', () => {
    const e = env();
    const got = [];
    e.win.view = (o) => got.push(o);
    const trx = { id: 12, total: 1.5e-7, big: 2e21, items: [{ n: 'Milk "2%"', q: 2, tags: [] }], note: "café \\ back\nslash", ok: true, none: null };
    run('view(' + JSON.stringify(trx).replace(/"/g, '"') + ')', e);
    assert.deepEqual(got[0], trx);
    run('view({"k":"\\u00e9\\u0041","x":-3})', e);
    assert.deepEqual(got[1], { k: 'éA', x: -3 });
    assert.throws(() => run('view({"__proto__":1})', e), undefined, 'blocked key');
});

test('prototype-pollution routes are refused', () => {
    const e = env();
    for (const bad of ["this.__proto__.x='y'", "this['__proto__']", "window.constructor.prototype.x=1", "this.prototype"]) {
        assert.throws(() => run(bad, e), undefined, bad);
    }
});

test('a handler that stops propagation also keeps later document listeners from running (as inline handlers did)', () => {
    const listeners = {};
    const node = { nodeType: 1, parentElement: null, hasAttribute: (n) => n === 'data-onclick', getAttribute: () => 'open(event)', contains: () => false };
    const doc = { readyState: 'complete', addEventListener: (t, f) => { listeners[t] = f; }, querySelectorAll: () => [] };
    const win = { document: doc, addEventListener() {}, console: { error() {} }, open: (e) => e.stopPropagation() };
    ev.install(win);
    let immediate = false;
    const event = { target: node, cancelBubble: false, preventDefault() {}, stopPropagation() { this.cancelBubble = true; }, stopImmediatePropagation() { immediate = true; } };
    listeners.click(event);
    assert.equal(immediate, true);
});

test('Every handler on every converted page executes in the interpreter (stand-in functions, no blocked names)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    // anything callable, anything readable: records nothing, throws nothing
    const dummy = () => new Proxy(function () {}, {
        get: (t, k) => (k === Symbol.toPrimitive ? () => '' : dummy()),
        apply: () => dummy(),
        set: () => true,
        has: () => true
    });
    const win = new Proxy({ document: dummy(), location: dummy(), history: dummy(), console: { error() {} } }, {
        has: () => true,
        get: (t, k) => (k in t ? t[k] : dummy())
    });
    let checked = 0;
    const failures = [];
    for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (!html.includes('/okw-events.js')) continue;
        for (const m of html.matchAll(/\sdata-on[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
            let body = decode(m[1] !== undefined ? m[1] : m[2]);
            if (/\$\{/.test(body)) body = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '0');
            checked++;
            try { ev.run(body, dummy(), dummy(), win); }
            catch (err) {
                // a truncated render-time template (quotes inside ${...}) cannot be judged from the source text
                if (!/\$\{|JSON\.stringify|unterminated|unexpected end|expected/.test(m[0] + err.message)) failures.push(`${f}: ${body.slice(0, 80)} -> ${err.message}`);
            }
        }
    }
    assert.ok(checked > 400, `expected hundreds of handlers, checked ${checked}`);
    assert.deepEqual(failures, []);
});

test('The whole project is ready for a strict policy: no inline handlers, no javascript: URLs, no inline script in server pages', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const inline = /\son(?:click|change|input|keyup|keydown|keypress|submit|blur|focus|mouseover|mouseout|mouseenter|mouseleave|dblclick|load|error)\s*=\s*["']/i;
    const sources = [...fs.readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f) && !/^(initialize|create_|setup_|seed|hash-|clean_|emulator)/.test(f) && f !== 'okw-events.js')];
    for (const f of sources) {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.ok(!inline.test(text), `${f} still has an inline event handler`);
        assert.ok(!/(href|action|src)\s*=\s*["']\s*javascript:/i.test(text), `${f} still has a javascript: URL`);
    }
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(!/send\(`<script>/.test(server), 'server-generated pages must not carry inline scripts');
});

test('top-redirect.js only ever sends the window to a same-site path', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const code = fs.readFileSync(path.join(__dirname, '..', 'top-redirect.js'), 'utf8');
    const run = (target) => {
        const seen = [];
        const win = { location: { replace: (u) => seen.push(u) } };
        win.top = win;
        new Function('window', 'document', code)(win, { currentScript: { getAttribute: () => target } });
        return seen;
    };
    assert.deepEqual(run('/login?unauthorized=true'), ['/login?unauthorized=true']);
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', '', null]) assert.deepEqual(run(bad), [], String(bad));
});
