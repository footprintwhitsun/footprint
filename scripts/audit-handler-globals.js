#!/usr/bin/env node
/**
 * For every page that loads okw-events.js: parse its inline scripts (and the shared scripts it loads) with a real
 * JavaScript parser, work out which names are truly global (top-level function / var declarations and window.X =
 * assignments), and check every name a data-on* handler calls against them. Inline handlers could see top-level
 * let/const/class too; the dispatcher cannot, so those are reported.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const events = require('../okw-events');

const ROOT = path.resolve(__dirname, '..');
const BROWSER = new Set(['print', 'alert', 'confirm', 'prompt', 'open', 'close', 'history', 'location', 'navigator', 'console', 'Math', 'JSON', 'Date', 'Number', 'String', 'Array', 'Object', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Event', 'URL']);
const SPECIAL = new Set(['this', 'event', 'window', 'document', 'true', 'false', 'null', 'undefined']);

function globalsOf(code) {
    const globals = new Set(), lexical = new Set();
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
    catch (e) { return { globals, lexical, error: e.message }; }
    for (const n of ast.body) {
        if (n.type === 'FunctionDeclaration' && n.id) globals.add(n.id.name);
        if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') (n.kind === 'var' ? globals : lexical).add(d.id.name);
        if (n.type === 'ClassDeclaration' && n.id) lexical.add(n.id.name);
    }
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier' &&
            (n.left.object.name === 'window' || n.left.object.name === 'globalThis') && n.left.property && !n.left.computed) globals.add(n.left.property.name);
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier' &&
            n.left.object.name === 'global' && n.left.property) globals.add(n.left.property.name);
        for (const k of Object.keys(n)) if (k !== 'type') walk(n[k]);
    })(ast);
    return { globals, lexical };
}

function idsOf(ast, out) {
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.t === 'id' && !SPECIAL.has(n.n)) out.add(n.n);
        if (n.t === 'member') { walk(n.o); walk(n.p); return; }
        Object.keys(n).forEach((k) => { if (k !== 'v') walk(n[k]); });
    })(ast);
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
let bad = 0, pages = 0;
for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html')).sort()) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!html.includes('/okw-events.js')) continue;
    pages++;
    const globals = new Set(), lexical = new Set();
    const sources = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    for (const src of [...html.matchAll(/<script[^>]*\bsrc="\/([\w.-]+\.js)"/gi)].map((m) => m[1])) {
        if (fs.existsSync(path.join(ROOT, src))) sources.push(fs.readFileSync(path.join(ROOT, src), 'utf8'));
    }
    const notes = [];
    for (const code of sources) {
        const r = globalsOf(code);
        if (r.error) { notes.push('script not parsed: ' + r.error); continue; }
        r.globals.forEach((g) => globals.add(g)); r.lexical.forEach((g) => lexical.add(g));
    }
    const used = new Map();
    for (const m of html.matchAll(/\sdata-on[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const body = decode(m[1] !== undefined ? m[1] : m[2]).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '0');
        let ast; try { ast = events.parse(body); } catch (e) { continue; }
        const ids = new Set(); idsOf(ast, ids);
        ids.forEach((id) => used.set(id, (used.get(id) || 0) + 1));
    }
    const missing = [...used.keys()].filter((id) => !globals.has(id) && !BROWSER.has(id));
    const lexHits = missing.filter((id) => lexical.has(id));
    if (missing.length || notes.length) {
        bad++;
        console.log(`${f}: ${missing.length} name(s) the dispatcher cannot resolve${notes.length ? ' (' + notes[0] + ')' : ''}`);
        for (const id of missing) console.log(`    - ${id} (${used.get(id)}x)${lexHits.includes(id) ? '  declared with let/const/class' : '  not found as a top-level function, var or window.' + id}`);
    }
}
console.log(`${pages} pages checked, ${bad} with problems`);
process.exit(bad ? 1 : 0);
