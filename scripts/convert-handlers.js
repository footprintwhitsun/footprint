#!/usr/bin/env node
/**
 * Converts inline event-handler attributes to data-on* attributes for okw-events.js.
 *
 *   node scripts/convert-handlers.js --audit            all pages, change nothing
 *   node scripts/convert-handlers.js expenses.html ...  convert these files
 *
 * A file is only changed when EVERY handler in it can be parsed by the dispatcher and every function it
 * calls is reachable from the page (function declaration, var, or window assignment). Anything else is
 * reported and the file is left alone.
 */
const fs = require('fs');
const path = require('path');
const events = require('../okw-events');

const ROOT = path.resolve(__dirname, '..');
const EV = 'click|change|input|keyup|keydown|keypress|submit|blur|focus|mouseover|mouseout|mouseenter|mouseleave|dblclick|load|error|toggle|scroll|drop|dragover';
const ATTR = new RegExp('(\\s)on(' + EV + ')(\\s*=\\s*)("([^"]*)"|\'([^\']*)\')', 'gi');
const SHARED = ['layout.js', 'ui-components.js', 'auth-guard.js', 'pos-upgrade.js', 'currency.js', 'user-session.js', 'offline-queue.js', 'instant-nav.js', 'telemetry-guard.js', 'lazy-libs.js'];
const SPECIAL = new Set(['this', 'event', 'window', 'document', 'true', 'false', 'null', 'undefined', 'history', 'location']);

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function idsOf(ast) {
    const out = new Set();
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.t === 'id' && !SPECIAL.has(n.n)) out.add(n.n);
        if (n.t === 'member') { walk(n.o); walk(n.p); return; }
        Object.keys(n).forEach((k) => { if (k !== 'v') walk(n[k]); });
    })(ast);
    return out;
}

function reachable(name, corpus) {
    const e = name.replace(/[$]/g, '\\$');
    return new RegExp('(^|[^\\w$.])function\\s+' + e + '\\s*\\(|window\\.' + e + '\\s*=|(^|[^\\w$.])var\\s+' + e + '\\b|(^|\\n)\\s*async\\s+function\\s+' + e + '\\s*\\(').test(corpus);
}
function lexicalOnly(name, corpus) {
    const e = name.replace(/[$]/g, '\\$');
    return new RegExp('(^|\\n)\\s*(const|let)\\s+' + e + '\\b').test(corpus);
}

function analyse(file) {
    const text = read(file);
    const corpus = text + '\n' + SHARED.filter((f) => fs.existsSync(path.join(ROOT, f))).map(read).join('\n');
    const problems = [];
    const dynamic = [];
    const handlers = [];
    let m;
    ATTR.lastIndex = 0;
    while ((m = ATTR.exec(text))) {
        const event = m[2].toLowerCase();
        const body = decode(m[5] !== undefined ? m[5] : m[6]);
        const tagStart = text.lastIndexOf('<', m.index);
        const tag = text.slice(tagStart, text.indexOf('>', m.index) + 1);
        // stylesheet loaders: onload="this.media='all'" on a media="print" <link>
        if (event === 'load' && /^<link\b/i.test(tag) && body.replace(/\s/g, '') === "this.media='all'") {
            if (!/media\s*=\s*["']print["']/i.test(tag)) problems.push(`media swap on a link without media="print": ${tag.slice(0, 80)}`);
            handlers.push({ kind: 'media', index: m.index, length: m[0].length, lead: m[1] });
            continue;
        }
        // ${...} is a render-time placeholder: check the shape with a stand-in value, and list the handler for review.
        // A handler inside a separate document the page writes (print windows, receipts) never meets the dispatcher.
        if (m.index > 500 && /document\.write\(|<!doctype html>/i.test(text.slice(Math.max(0, m.index - 3000), m.index))) {
            problems.push(`on${event}="${body.slice(0, 50)}" sits inside a document the page writes (add the listener from the opener instead)`);
            continue;
        }
        const hasTemplate = /\$\{/.test(body);
        if (hasTemplate) dynamic.push(`on${event}="${body.slice(0, 90)}"`);
        const checkBody = hasTemplate ? body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '0') : body;
        let ast;
        try { ast = events.parse(checkBody); } catch (err) {
            if (hasTemplate) { handlers.push({ kind: 'attr', event, index: m.index, length: m[0].length, lead: m[1], eq: m[3], quoted: m[4], review: true }); continue; }
            problems.push(`cannot parse on${event}="${body.slice(0, 70)}" (${err.message})`); continue;
        }
        for (const name of idsOf(ast)) {
            if (/\$\{/.test(name)) continue;
            if (!reachable(name, corpus)) {
                problems.push(lexicalOnly(name, corpus)
                    ? `"${name}" is declared with const/let, so the dispatcher cannot see it (use function ${name} or window.${name} =)`
                    : `"${name}" is not defined anywhere the page can reach`);
            }
        }
        handlers.push({ kind: 'attr', event, index: m.index, length: m[0].length, lead: m[1], eq: m[3], quoted: m[4] });
    }
    return { text, handlers, problems: [...new Set(problems)], dynamic, review: handlers.filter((h) => h.review).length };
}

function convert(file, a) {
    let out = a.text;
    for (const h of a.handlers.slice().sort((x, y) => y.index - x.index)) {
        const rep = h.kind === 'media' ? `${h.lead}data-media-swap` : `${h.lead}data-on${h.event}${h.eq}${h.quoted}`;
        out = out.slice(0, h.index) + rep + out.slice(h.index + h.length);
    }
    if (a.handlers.length && !/okw-events\.js/.test(out)) {
        if (!/<\/head>/i.test(out)) throw new Error(`${file}: no </head> to add the dispatcher script to`);
        out = out.replace(/<\/head>/i, '    <script src="/okw-events.js"></script>\n</head>');
    }
    fs.writeFileSync(path.join(ROOT, file), out);
}

const args = process.argv.slice(2);
const audit = args.includes('--audit');
const files = audit
    ? fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))
    : args.filter((a) => !a.startsWith('--'));

let ok = 0, blocked = 0;
for (const f of files.sort()) {
    const a = analyse(f);
    if (!a.handlers.length && !a.problems.length) continue;
    const doc = /document\.write\(/.test(a.text) ? ' [writes other documents: check its strings by hand]' : '';
    if (audit) {
        console.log(`${f}: ${a.handlers.length} handlers, ${a.problems.length} problems, ${a.dynamic.length} with render-time values (${a.review} need a by-hand look)${doc}`);
        a.problems.slice(0, 6).forEach((p) => console.log('    - ' + p));
        continue;
    }
    if (a.problems.length) { blocked++; console.log(`SKIPPED ${f}`); a.problems.forEach((p) => console.log('    - ' + p)); continue; }
    convert(f, a); ok++;
    console.log(`converted ${f}: ${a.handlers.length} handlers${doc}`);
}
if (!audit) console.log(`${ok} converted, ${blocked} skipped`);
