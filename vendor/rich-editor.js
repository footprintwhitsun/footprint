// Self-hosted, CSP-compliant lightweight rich-text editor (compatible with tinymce.init/get API subset)
(function (global) {
    'use strict';
    if (global.tinymce) return;
    const editors = new Map();

    function createEditor(selector, opts) {
        const textarea = document.querySelector(selector);
        if (!textarea || !textarea.parentNode) return null;
        const id = textarea.id || ('rte-' + Math.random().toString(36).slice(2, 8));
        if (editors.has(id)) return editors.get(id);

        const wrap = document.createElement('div');
        wrap.className = 'okw-rte-wrap';
        wrap.style.cssText = 'border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff;';

        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;background:#f8fafc;border-bottom:1px solid #e2e8f0;align-items:center;';
        const cmds = [
            ['bold', 'B', 'font-weight:700;', 'Bold'],
            ['italic', 'I', 'font-style:italic;', 'Italic'],
            ['underline', 'U', 'text-decoration:underline;', 'Underline'],
            ['insertUnorderedList', '• List', '', 'Bullet list'],
            ['insertOrderedList', '1. List', '', 'Numbered list'],
            ['removeFormat', 'Clear', '', 'Clear formatting']
        ];

        const area = document.createElement('div');
        area.contentEditable = 'true';
        area.setAttribute('role', 'textbox');
        area.setAttribute('aria-multiline', 'true');
        area.setAttribute('aria-label', 'Product Description');
        area.style.cssText = 'min-height:130px;max-height:280px;overflow-y:auto;padding:10px 12px;font-size:13.5px;line-height:1.5;color:#0f172a;outline:none;';
        area.innerHTML = textarea.value || '';

        const status = document.createElement('div');
        status.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;';
        const wordSpan = document.createElement('span');
        const brandSpan = document.createElement('span');
        brandSpan.textContent = 'RICH TEXT EDITOR';
        brandSpan.style.cssText = 'font-weight:700;letter-spacing:0.04em;opacity:0.75;';
        status.append(wordSpan, brandSpan);

        const sync = () => {
            textarea.value = area.innerHTML;
            const txt = (area.textContent || '').trim();
            const words = txt ? txt.split(/\s+/).length : 0;
            wordSpan.textContent = words + (words === 1 ? ' WORD' : ' WORDS');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        cmds.forEach(([cmd, label, extraCss, title]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.title = title;
            btn.setAttribute('aria-label', title);
            btn.style.cssText = 'padding:4px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#1e293b;font-size:12px;cursor:pointer;' + extraCss;
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
                area.focus();
                document.execCommand(cmd, false, null);
                sync();
            });
            bar.appendChild(btn);
        });

        area.addEventListener('input', sync);
        wrap.append(bar, area, status);
        textarea.style.display = 'none';
        textarea.parentNode.insertBefore(wrap, textarea.nextSibling);
        sync();

        const api = {
            getContent: (o) => (o && o.format === 'text') ? (area.textContent || '') : area.innerHTML,
            setContent: (html) => { area.innerHTML = html || ''; sync(); },
            remove: () => { wrap.remove(); textarea.style.display = ''; editors.delete(id); }
        };
        editors.set(id, api);
        if (opts && typeof opts.setup === 'function') {
            try { opts.setup({ on: (ev, fn) => { if (/input|change|keyup/i.test(ev)) area.addEventListener('input', fn); } }); } catch (_) {}
        }
        return api;
    }

    global.tinymce = {
        init: (opts = {}) => {
            if (opts.selector) createEditor(opts.selector, opts);
            return Promise.resolve();
        },
        get: (id) => editors.get(id) || null
    };
})(window);
