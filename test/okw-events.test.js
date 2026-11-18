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

test('Converted pages have no inline handlers, load the dispatcher, and the server serves it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const converted = ['bulk-upload', 'daily-close', 'negative-stock', 'purchase-orders', 'suppliers', 'team', 'expenses', 'extras', 'operations'];
    const inline = /\son(?:click|change|input|keyup|keydown|keypress|submit|blur|focus|mouseover|mouseout|mouseenter|mouseleave|dblclick|load|error)\s*=\s*["']/i;
    for (const name of converted) {
        const html = fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8');
        assert.ok(!inline.test(html), `${name}.html still has an inline event handler`);
        if (/data-on[a-z]+\s*=|data-media-swap/.test(html)) {
            assert.ok(html.includes('<script src="/okw-events.js"></script>'), `${name}.html must load the dispatcher`);
        }
    }
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(server.includes("'/okw-events.js'"), 'the dispatcher must be on the client-script allow-list');
});
