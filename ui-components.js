/* ==========================================================================
   OKWESIWA CO LTD POS — Shared UI Components (ui-components.js)
   Number cards, data tables (search/filter/export Excel & PDF/print),
   date-range picker, status badges, forms, toasts & confirmation modals.
   ========================================================================== */
(function (global) {
    'use strict';

    const escapeHtml = (val) => {
        if (val === null || val === undefined) return '';
        return String(val)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    // Toast container
    function ensureToastRoot() {
        let root = document.getElementById('okw-toast-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'okw-toast-root';
            root.setAttribute('role', 'status');
            root.setAttribute('aria-live', 'polite');
            root.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:360px;';
            document.body.appendChild(root);
        }
        return root;
    }

    function toast(message, type = 'info', duration = 3600) {
        const root = ensureToastRoot();
        const colors = {
            success: 'var(--color-success)',
            warning: 'var(--color-warning)',
            danger: 'var(--color-danger)',
            error: 'var(--color-danger)',
            info: 'var(--color-info)'
        };
        const el = document.createElement('div');
        el.style.cssText = `
            background: var(--color-surface);
            color: var(--color-text);
            border: 1px solid var(--color-border);
            border-left: 4px solid ${colors[type] || colors.info};
            border-radius: var(--radius-md);
            padding: 12px 16px;
            box-shadow: var(--shadow-lg);
            font-size: 13.5px;
            font-weight: 500;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            animation: okwSlideIn 0.18s ease-out;
        `;
        el.innerHTML = `<span>${escapeHtml(message)}</span><button type="button" aria-label="Close" style="background:none;border:none;color:var(--color-text-muted);cursor:pointer;font-size:16px;line-height:1;">&times;</button>`;
        el.querySelector('button').onclick = () => el.remove();
        root.appendChild(el);
        if (duration > 0) {
            setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
        }
    }

    function confirm(title, message, opts = {}) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
            const toneClass = opts.danger ? 'okw-btn-danger' : 'okw-btn-primary';
            backdrop.innerHTML = `
                <div class="okw-card" style="max-width:440px;width:100%;box-shadow:var(--shadow-lg);">
                    <h3 style="margin:0 0 8px;font-size:18px;">${escapeHtml(title)}</h3>
                    <p style="margin:0 0 20px;color:var(--color-text-muted);font-size:14px;">${escapeHtml(message)}</p>
                    <div style="display:flex;justify-content:flex-end;gap:10px;">
                        <button type="button" class="okw-btn okw-btn-outline" data-act="cancel">${escapeHtml(opts.cancelText || 'Cancel')}</button>
                        <button type="button" class="okw-btn ${toneClass}" data-act="ok">${escapeHtml(opts.confirmText || 'Confirm')}</button>
                    </div>
                </div>
            `;
            const close = (val) => { backdrop.remove(); resolve(val); };
            backdrop.querySelector('[data-act="cancel"]').onclick = () => close(false);
            backdrop.querySelector('[data-act="ok"]').onclick = () => close(true);
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
            document.body.appendChild(backdrop);
        });
    }

    function badge(text, tone = 'neutral') {
        return `<span class="okw-badge okw-badge-${escapeHtml(tone)}">${escapeHtml(text)}</span>`;
    }

    function kpiCard({ label, value, subtext = '', tone = 'primary' }) {
        // Flat figure, no coloured top rule. Colour is reserved for a figure that needs attention.
        const subColour = { danger: 'var(--color-danger)', warning: 'var(--color-warning)' }[tone] || 'var(--color-text-muted)';
        return `
            <div class="okw-card okw-kpi">
                <div class="okw-kpi-label">${escapeHtml(label)}</div>
                <div class="kpi-value okw-kpi-value">${escapeHtml(value)}</div>
                ${subtext ? `<div class="okw-kpi-sub" style="color:${subColour};">${escapeHtml(subtext)}</div>` : ''}
            </div>
        `;
    }

    function dateRangePicker(container, onChange) {
        const el = typeof container === 'string' ? document.querySelector(container) : container;
        if (!el) return;
        const today = new Date().toISOString().slice(0, 10);
        el.innerHTML = `
            <div class="okw-date-row">
                <select class="okw-select" data-preset aria-label="Date Range Preset">
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="last_7_days">Last 7 Days</option>
                    <option value="last_30_days">Last 30 Days</option>
                    <option value="month" selected>This Month</option>
                    <option value="last_month">Last Month</option>
                    <option value="this_month_last_year">This month last year</option>
                    <option value="this_year">This Year</option>
                    <option value="last_year">Last Year</option>
                    <option value="current_fy">Current financial year</option>
                    <option value="last_fy">Last financial year</option>
                    <option value="custom">Custom Range</option>
                </select>
                <input type="date" class="okw-input" data-from value="${today.slice(0, 8)}01" aria-label="From Date">
                <span style="color:var(--color-text-muted);font-size:12px;">to</span>
                <input type="date" class="okw-input" data-to value="${today}" aria-label="To Date">
            </div>
        `;
        const preset = el.querySelector('[data-preset]');
        const fromIn = el.querySelector('[data-from]');
        const toIn = el.querySelector('[data-to]');
        const emit = () => onChange && onChange({ from: fromIn.value, to: toIn.value, preset: preset.value });

        preset.addEventListener('change', () => {
            const now = new Date();
            const fmt = (d) => {
                const yr = d.getFullYear();
                const mo = String(d.getMonth() + 1).padStart(2, '0');
                const dy = String(d.getDate()).padStart(2, '0');
                return `${yr}-${mo}-${dy}`;
            };
            const y = now.getFullYear();
            const m = now.getMonth();
            const p = preset.value;
            if (p === 'today') {
                fromIn.value = fmt(now); toIn.value = fmt(now);
            } else if (p === 'yesterday') {
                const d = new Date(now); d.setDate(d.getDate() - 1);
                fromIn.value = fmt(d); toIn.value = fmt(d);
            } else if (p === 'last_7_days') {
                const d = new Date(now); d.setDate(d.getDate() - 6);
                fromIn.value = fmt(d); toIn.value = fmt(now);
            } else if (p === 'last_30_days') {
                const d = new Date(now); d.setDate(d.getDate() - 29);
                fromIn.value = fmt(d); toIn.value = fmt(now);
            } else if (p === 'month') {
                fromIn.value = fmt(new Date(y, m, 1)); toIn.value = fmt(now);
            } else if (p === 'last_month') {
                fromIn.value = fmt(new Date(y, m - 1, 1));
                toIn.value = fmt(new Date(y, m, 0));
            } else if (p === 'this_month_last_year') {
                fromIn.value = fmt(new Date(y - 1, m, 1));
                toIn.value = fmt(new Date(y - 1, m + 1, 0));
            } else if (p === 'this_year' || p === 'current_fy') {
                fromIn.value = `${y}-01-01`;
                toIn.value = p === 'current_fy' ? `${y}-12-31` : fmt(now);
            } else if (p === 'last_year' || p === 'last_fy') {
                fromIn.value = `${y - 1}-01-01`;
                toIn.value = `${y - 1}-12-31`;
            }
            emit();
        });
        fromIn.addEventListener('change', () => { preset.value = 'custom'; emit(); });
        toIn.addEventListener('change', () => { preset.value = 'custom'; emit(); });
    }

    let _companyProfileCache = null;
    let _companyFetchStarted = false;
    let _companyFetchPromise = null;

    function getCompanyProfile() {
        if (!_companyProfileCache) {
            try {
                const raw = JSON.parse(localStorage.getItem('posSettings') || '{}');
                _companyProfileCache = {
                    name: raw.store_name || 'OKWESIWA CO LTD',
                    address: raw.address || raw.location || '',
                    phone: raw.phone || '',
                    email: raw.email || '',
                    taxId: raw.tax_id || '',
                    logoUrl: raw.logo_url || '/okwesiwa-logo.svg'
                };
            } catch (_) {
                _companyProfileCache = { name: 'OKWESIWA CO LTD', address: '', phone: '', email: '', taxId: '', logoUrl: '/okwesiwa-logo.svg' };
            }
        }
        if (!_companyFetchStarted && typeof fetch === 'function') {
            _companyFetchStarted = true;
            const token = localStorage.getItem('authToken') || localStorage.getItem('companyToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
            if (token) {
                _companyFetchPromise = fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
                    .then(r => r.ok ? r.json() : null)
                    .then(s => {
                        if (!s || typeof s !== 'object') return _companyProfileCache;
                        _companyProfileCache = {
                            name: s.store_name || _companyProfileCache.name || 'OKWESIWA CO LTD',
                            address: s.address || s.location || _companyProfileCache.address || '',
                            phone: s.phone || _companyProfileCache.phone || '',
                            email: s.email || _companyProfileCache.email || '',
                            taxId: s.tax_id || _companyProfileCache.taxId || '',
                            logoUrl: s.logo_url || _companyProfileCache.logoUrl || '/okwesiwa-logo.svg'
                        };
                        try {
                            const prev = JSON.parse(localStorage.getItem('posSettings') || '{}');
                            localStorage.setItem('posSettings', JSON.stringify({ ...prev, ...s }));
                        } catch (_) {}
                        return _companyProfileCache;
                    })
                    .catch(() => _companyProfileCache);
            }
        }
        return _companyProfileCache;
    }

    async function getCompanyProfileAsync() {
        getCompanyProfile();
        if (_companyFetchPromise) {
            try { await _companyFetchPromise; } catch (_) {}
        }
        return _companyProfileCache;
    }

    // Warm cache on load
    getCompanyProfile();

    function formatCompanyDetailsLine(p) {
        const parts = [];
        if (p.address) parts.push(p.address);
        if (p.phone) parts.push(`Tel: ${p.phone}`);
        if (p.email) parts.push(`Email: ${p.email}`);
        if (p.taxId) parts.push(`TIN: ${p.taxId}`);
        return parts.join('  |  ');
    }

    function formatCompanyDetailsStackedHtml(p) {
        const lines = [];
        if (p.address) lines.push(p.address);
        if (p.phone) lines.push(`Tel: ${p.phone}`);
        if (p.email) lines.push(`Email: ${p.email}`);
        if (p.taxId) lines.push(`TIN: ${p.taxId}`);
        return lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
    }

    function exportRowsToExcel(columns, rows, filename = 'okwesiwa-export.xlsx', reportTitle = '') {
        const profile = getCompanyProfile();
        const title = reportTitle || filename.replace(/\.(xlsx|csv)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const headers = columns.map(c => c.label);
        const data = rows.map(r => columns.map(c => {
            const v = typeof c.exportValue === 'function' ? c.exportValue(r) : r[c.key];
            return v === null || v === undefined ? '' : v;
        }));
        const detailsLine = formatCompanyDetailsLine(profile);
        const bannerRow1 = [`★  ${String(profile.name || 'OKWESIWA CO LTD').toUpperCase()}`];
        const bannerRow2 = [detailsLine || 'Official Business Report'];
        const bannerRow3 = [`Report: ${title}   |   Generated: ${new Date().toLocaleString()}   |   Total Records: ${rows.length}`];
        const sheetRows = [bannerRow1, bannerRow2, bannerRow3, [], headers, ...data];

        if (global.XLSX) {
            const ws = global.XLSX.utils.aoa_to_sheet(sheetRows);
            const lastCol = Math.max(0, headers.length - 1);
            ws['!merges'] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
                { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
                { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } }
            ];
            ws['!cols'] = headers.map((h, colIdx) => {
                let maxLen = String(h || '').length;
                for (const row of data) {
                    const len = String(row[colIdx] ?? '').length;
                    if (len > maxLen) maxLen = len;
                }
                return { wch: Math.min(48, Math.max(12, maxLen + 4)) };
            });
            const wb = global.XLSX.utils.book_new();
            global.XLSX.utils.book_append_sheet(wb, ws, 'Report');
            global.XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : filename + '.xlsx');
            return;
        }
        // Fallback CSV download if SheetJS not loaded on page
        const csv = sheetRows
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename.replace(/\.xlsx$/i, '') + '.csv';
        a.click();
    }

    function exportRowsToCsv(columns, rows, filename = 'okwesiwa-export.csv') {
        const headers = columns.map(c => c.label);
        const data = rows.map(r => columns.map(c => {
            const v = typeof c.exportValue === 'function' ? c.exportValue(r) : r[c.key];
            return v === null || v === undefined ? '' : v;
        }));
        const csv = [headers, ...data]
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename.replace(/\.(xlsx|csv)$/i, '') + '.csv';
        a.click();
    }

    function printRowsList(columns, rows, title = 'Report', orientation = 'portrait') {
        const profile = getCompanyProfile();
        const detailsStackedHtml = formatCompanyDetailsStackedHtml(profile);
        const pageOrient = orientation === 'landscape' ? 'landscape' : 'portrait';
        const printableCols = columns.filter(c => !/^(action|actions|receipt)$/i.test(String(c.label || '').trim()) || typeof c.exportValue === 'function');
        const colsToUse = printableCols.length ? printableCols : columns;
        const headerHtml = colsToUse.map(c => `<th style="text-align:${c.numeric ? 'right' : 'left'};">${escapeHtml(c.label)}</th>`).join('');
        const bodyHtml = rows.length
            ? rows.map(r => `<tr>${colsToUse.map(c => {
                const raw = typeof c.exportValue === 'function' ? c.exportValue(r) : r[c.key];
                return `<td style="text-align:${c.numeric ? 'right' : 'left'};">${escapeHtml(raw === null || raw === undefined ? '' : raw)}</td>`;
            }).join('')}</tr>`).join('')
            : `<tr><td colspan="${colsToUse.length}" style="text-align:center;padding:20px;color:#64748b;">No records to print.</td></tr>`;

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(profile.name)} — ${escapeHtml(title)}</title><style>
            @page { size: ${pageOrient}; margin: 12mm; }
            * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 0; padding: 0; font-size: 12px; background: #ffffff; }
            .doc-banner { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 3px solid #1F3A60; padding-bottom: 12px; margin-bottom: 16px; position: relative; }
            .doc-banner::after { content: ""; position: absolute; left: 0; bottom: -3px; width: 120px; height: 3px; background: #F9A51A; }
            .brand-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; }
            .brand-logo { height: 46px; max-width: 150px; object-fit: contain; margin-bottom: 4px; }
            .brand-name { font-size: 16px; font-weight: 800; color: #1F3A60; margin: 0; letter-spacing: 0.02em; text-transform: uppercase; line-height: 1.25; }
            .brand-details { font-size: 11px; color: #334155; margin: 2px 0 0; line-height: 1.45; }
            .report-meta { text-align: right; padding-top: 4px; }
            .report-title { font-size: 18px; font-weight: 800; color: #1F3A60; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.03em; }
            .meta-pill { display: inline-block; background: #EFF4FB; color: #1F3A60; border: 1px solid #BFDBFE; border-radius: 4px; padding: 3px 9px; font-size: 10.5px; font-weight: 600; }
            table { width: 100%; border-collapse: collapse; font-size: 11.5px; border: 1px solid #CBD5E1; }
            thead th { background: #1F3A60 !important; color: #FFFFFF !important; font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; padding: 8px 9px; border: 1px solid #1F3A60; }
            tbody td { padding: 7px 9px; border: 1px solid #E2E8F0; color: #0f172a; background: #FFFFFF; }
            tbody tr:nth-child(even) td { background: #F4F7FC !important; }
            .doc-footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #CBD5E1; display: flex; justify-content: space-between; font-size: 10.5px; color: #64748b; }
        </style></head><body>
            <div class="doc-banner">
                <div class="brand-wrap">
                    <img class="brand-logo" src="${escapeHtml(profile.logoUrl)}" alt="${escapeHtml(profile.name)}">
                    <p class="brand-name">${escapeHtml(profile.name)}</p>
                    ${detailsStackedHtml ? `<div class="brand-details">${detailsStackedHtml}</div>` : ''}
                </div>
                <div class="report-meta">
                    <p class="report-title">${escapeHtml(title)}</p>
                    <span class="meta-pill">${rows.length} Record(s) &bull; ${escapeHtml(new Date().toLocaleString())}</span>
                </div>
            </div>
            <table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
            <div class="doc-footer">
                <span>${escapeHtml(profile.name)} — Official Document</span>
                <span>Printed: ${escapeHtml(new Date().toLocaleString())}</span>
            </div>
        </body></html>`;

        let iframe = document.getElementById('okw-print-frame');
        if (iframe) iframe.remove();
        iframe = document.createElement('iframe');
        iframe.id = 'okw-print-frame';
        iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
        document.body.appendChild(iframe);
        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
        // a logo that fails to load is hidden (done here: the print document runs no scripts of its own)
        const logoImg = doc.querySelector('.brand-logo');
        if (logoImg) {
            const hideLogo = () => { logoImg.style.display = 'none'; };
            logoImg.addEventListener('error', hideLogo);
            if (logoImg.complete && logoImg.naturalWidth === 0) hideLogo();
        }
        iframe.contentWindow.focus();
        setTimeout(() => { iframe.contentWindow.print(); }, 100);
    }

    // One "Export" menu instead of a row of six buttons. The buttons keep their data attributes
    // and handlers; they are only moved into a menu.
    function compactExportMenu(root, sel) {
        const csv = root.querySelector(sel.csv);
        if (!csv || root.querySelector('details.okw-export-menu')) return;
        const excel = root.querySelector(sel.excel), print = root.querySelector(sel.print);
        const orient = root.querySelector(sel.orient), pdf = root.querySelector(sel.pdf);
        if (!excel || !print || !orient || !pdf) return;
        const menu = document.createElement('details');
        menu.className = 'okw-menu okw-export-menu';
        menu.innerHTML = '<summary class="okw-btn okw-btn-outline"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export</summary><div class="okw-menu-list"></div>';
        const list = menu.querySelector('.okw-menu-list');
        const row = document.createElement('div');
        row.className = 'okw-menu-row';
        [csv, excel, print, pdf].forEach(b => { b.removeAttribute('style'); b.className = 'okw-menu-item'; });
        orient.removeAttribute('style'); orient.className = 'okw-select';
        const pdfWrap = pdf.parentNode;
        row.append(pdf, orient);
        csv.parentNode.insertBefore(menu, csv);
        list.append(csv, excel, print, row);
        if (pdfWrap && pdfWrap !== list && !pdfWrap.children.length) pdfWrap.remove();
        bindMenuOutsideClose();
    }

    function bindMenuOutsideClose() {
        if (document.documentElement.dataset.okwMenuClose) return;
        document.documentElement.dataset.okwMenuClose = '1';
        document.addEventListener('click', (e) => {
            document.querySelectorAll('details.okw-menu[open]').forEach(d => {
                if (!d.contains(e.target)) d.removeAttribute('open');
            });
        });
    }

    /**
     * Builds a right-aligned "Filters" dropdown popover (<details class="okw-menu okw-filter-menu">).
     * Returns HTML string ready to inject into any toolbar.
     */
    function filterDropdown({ label = 'Filters', contentHtml = '', id = '' } = {}) {
        bindMenuOutsideClose();
        const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
        return `
            <details class="okw-menu okw-filter-menu"${idAttr}>
                <summary class="okw-btn okw-btn-outline">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:6px;"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                    <span>${escapeHtml(label)}</span>
                </summary>
                <div class="okw-menu-list okw-filter-popover">
                    ${contentHtml}
                </div>
            </details>`;
    }

    /**
     * Opens a clean, branded printable detail modal for any clicked item/record
     * (Purchase Order, Draft, Sale, Quotation, or any table row).
     */
    async function openPrintableRecord(opts = {}) {
        const prev = document.getElementById('okw-printable-record-modal');
        if (prev) prev.remove();
        const profile = await getCompanyProfileAsync();
        const fmtC = (n) => (typeof window.formatCurrency === 'function'
            ? window.formatCurrency(n)
            : 'GH₵ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

        const {
            title = 'Document Details',
            refNumber = '',
            date = '',
            status = '',
            paymentStatus = '',
            partyLabel = '',
            partyName = '',
            branch = '',
            metaRows = [],
            items = [],
            subtotal = null,
            discount = null,
            tax = null,
            shipping = null,
            netTotal = null,
            paidAmount = null,
            balanceDue = null,
            notes = '',
            extraHtml = ''
        } = opts;

        // 1. Deduplicate fields & keep the record's own Date in ONE dedicated section (never show 2 dates)
        const isDateLabel = (lbl) => /^(date|date\s*\/\s*time|time|timestamp|created(\s*at)?|transaction date|deleted on)$/i.test(String(lbl || '').trim());
        let resolvedDate = '';
        let resolvedRef = refNumber || '';
        let parsedItemsList = [];

        const rawCombined = [
            ...(partyName ? [[partyLabel || 'Name', partyName]] : []),
            ...(branch ? [['Branch', branch]] : []),
            ...(status ? [['Status', status]] : []),
            ...(paymentStatus ? [['Payment Status', paymentStatus]] : []),
            ...metaRows
        ];

        const seenKeys = new Set();
        const summaryFields = [];
        for (const pair of rawCombined) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const label = String(pair[0] || '').trim();
            const val = pair[1] === null || pair[1] === undefined ? '' : String(pair[1]).trim();
            if (!label) continue;
            const normKey = label.toLowerCase();

            // Capture the record's own date into the single dedicated Date section
            if (isDateLabel(label)) {
                if (!resolvedDate && val && val !== '—' && val !== '-') resolvedDate = val;
                continue;
            }
            // Capture reference number for the top badge if not already set, while keeping it in the table too
            if (!resolvedRef && /^(receipt\s*#|invoice\s*(#|no\.?)|ref(\.|erence)?\s*(#|no\.?)?|po\s*#|order\s*#)$/i.test(label) && val && val !== '—') {
                resolvedRef = val;
            }
            // If there is a comma-separated "Items" text field and no structured items[] array, turn it into a proper Itemized table
            if (!items.length && /^items?$/i.test(label) && val && val !== '—' && val !== '-') {
                parsedItemsList = val.split(/\s*,\s*/).filter(Boolean).map(entry => {
                    const m = entry.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\)\s*$/);
                    return m ? { name: m[1].trim(), qty: m[2] } : { name: entry.trim(), qty: '—' };
                });
                continue;
            }
            if (seenKeys.has(normKey)) continue;
            seenKeys.add(normKey);
            summaryFields.push([label, val || '—']);
        }

        if (!resolvedDate) {
            resolvedDate = date || new Date().toLocaleString();
        }

        // 2. Render Document Summary as ONE clean 2-pair specification table (Field | Value | Field | Value), never injecting table-tools
        const summaryPairs = [];
        for (let i = 0; i < summaryFields.length; i += 2) {
            const left = summaryFields[i];
            const right = summaryFields[i + 1];
            if (right) {
                summaryPairs.push(`
                    <tr>
                        <td class="pr-meta-lbl">${escapeHtml(left[0])}</td>
                        <td class="pr-meta-val">${escapeHtml(left[1])}</td>
                        <td class="pr-meta-lbl">${escapeHtml(right[0])}</td>
                        <td class="pr-meta-val">${escapeHtml(right[1])}</td>
                    </tr>`);
            } else {
                summaryPairs.push(`
                    <tr>
                        <td class="pr-meta-lbl">${escapeHtml(left[0])}</td>
                        <td class="pr-meta-val" colspan="3">${escapeHtml(left[1])}</td>
                    </tr>`);
            }
        }
        const metaTableHtml = summaryPairs.length ? `
            <div class="pr-section-bar">Document Summary</div>
            <table class="pr-meta-tbl" data-no-table-tools="1">
                <tbody>${summaryPairs.join('')}</tbody>
            </table>` : '';

        const isStockTakeItems = items.length > 0 && items.some(it => it && (it.old_qty !== undefined || it.new_qty !== undefined || it.variance !== undefined));
        const itemsHtml = items.length ? (isStockTakeItems ? `
            <div class="pr-section-bar" style="margin-top:16px;">Stock Count Adjustments</div>
            <table class="pr-items-tbl" data-no-table-tools="1">
                <thead>
                    <tr>
                        <th style="width:36px;">#</th>
                        <th>Product</th>
                        <th>Barcode / SKU</th>
                        <th class="okw-num" style="width:90px;">Previous Qty</th>
                        <th class="okw-num" style="width:90px;">New Qty</th>
                        <th class="okw-num" style="width:95px;">Change</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map((it, idx) => {
                        const v = Number(it.variance ?? 0);
                        const vText = (v > 0 ? '+' : '') + v;
                        return `<tr>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(it.name || it.product_name || 'Item')}</strong></td>
                            <td>${escapeHtml(it.barcode || it.product_barcode || '—')}</td>
                            <td class="okw-num">${escapeHtml(it.old_qty ?? '—')}</td>
                            <td class="okw-num"><strong>${escapeHtml(it.new_qty ?? it.qty ?? '—')}</strong></td>
                            <td class="okw-num" style="font-weight:700;color:${v > 0 ? '#15803d' : (v < 0 ? '#dc2626' : '#475569')};">${escapeHtml(vText)}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>` : `
            <div class="pr-section-bar" style="margin-top:16px;">Itemized Breakdown</div>
            <table class="pr-items-tbl" data-no-table-tools="1">
                <thead>
                    <tr>
                        <th style="width:36px;">#</th>
                        <th>Item Description</th>
                        <th>Barcode / SKU</th>
                        <th class="okw-num" style="width:70px;">Qty</th>
                        <th class="okw-num" style="width:120px;">Unit Price / Cost</th>
                        <th class="okw-num" style="width:125px;">Line Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map((it, idx) => {
                        const qty = Number(it.qty ?? it.quantity ?? 1);
                        const unit = Number(it.price ?? it.unit_cost ?? it.cost ?? 0);
                        const line = Number(it.line_total ?? (qty * unit));
                        return `<tr>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(it.name || it.product_name || it.product_barcode || it.barcode || 'Item')}</strong></td>
                            <td>${escapeHtml(it.barcode || it.product_barcode || '—')}</td>
                            <td class="okw-num">${escapeHtml(qty)}</td>
                            <td class="okw-num">${fmtC(unit)}</td>
                            <td class="okw-num"><strong>${fmtC(line)}</strong></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>`) : (parsedItemsList.length ? `
            <div class="pr-section-bar" style="margin-top:16px;">Itemized Breakdown</div>
            <table class="pr-items-tbl">
                <thead>
                    <tr>
                        <th style="width:42px;">#</th>
                        <th>Item Description</th>
                        <th class="okw-num" style="width:90px;">Qty</th>
                    </tr>
                </thead>
                <tbody>
                    ${parsedItemsList.map((it, idx) => `<tr>
                        <td>${idx + 1}</td>
                        <td><strong>${escapeHtml(it.name)}</strong></td>
                        <td class="okw-num">${escapeHtml(it.qty)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>` : '');

        const totalRows = [];
        if (items.length) totalRows.push(['Total Items', `${items.length} (${items.reduce((s, i) => s + Number(i.qty ?? i.quantity ?? 1), 0)} units)`]);
        if (subtotal !== null) totalRows.push(['Subtotal', fmtC(subtotal)]);
        if (discount !== null && Number(discount) > 0) totalRows.push(['Discount', '-' + fmtC(discount)]);
        if (tax !== null && Number(tax) > 0) totalRows.push(['Tax', fmtC(tax)]);
        if (shipping !== null && Number(shipping) > 0) totalRows.push(['Shipping', fmtC(shipping)]);
        if (netTotal !== null) totalRows.push(['Net Total Amount', fmtC(netTotal), true]);
        if (paidAmount !== null) totalRows.push(['Amount Paid', fmtC(paidAmount)]);
        if (balanceDue !== null) totalRows.push(['Balance Due', fmtC(balanceDue)]);

        const totalsHtml = totalRows.length ? `
            <div style="margin-top:16px;display:flex;justify-content:flex-end;">
                <table class="pr-totals-tbl" data-no-table-tools="1">
                    <tbody>
                    ${totalRows.map(([k, v, bold]) => `
                        <tr class="${bold ? 'pr-net-row' : ''}">
                            <td class="pr-tot-lbl">${escapeHtml(k)}</td>
                            <td class="pr-tot-val">${escapeHtml(v)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>` : '';

        const sharedDocStyles = `
            * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            .pr-banner { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; border-bottom:3px solid #1F3A60; padding-bottom:12px; margin-bottom:16px; position:relative; }
            .pr-banner::after { content:""; position:absolute; left:0; bottom:-3px; width:130px; height:3px; background:#F9A51A; }
            .pr-brand { display:flex; flex-direction:column; align-items:flex-start; gap:3px; text-align:left; }
            .pr-brand img { height:46px; max-width:150px; object-fit:contain; margin-bottom:4px; }
            .pr-company { font-size:16px; font-weight:800; color:#1F3A60; text-transform:uppercase; letter-spacing:0.02em; line-height:1.25; }
            .pr-company-sub { font-size:11px; color:#334155; margin-top:2px; line-height:1.45; }
            .pr-doc-right { text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
            .pr-doc-title { font-size:17px; font-weight:800; color:#1F3A60; text-transform:uppercase; letter-spacing:0.03em; }
            .pr-ref-pill { display:inline-block; padding:3px 10px; border-radius:4px; background:#EFF4FB; border:1px solid #BFDBFE; color:#1F3A60; font-size:11.5px; font-weight:700; }
            .pr-date-pill { display:inline-block; padding:3px 10px; border-radius:4px; background:#F8FAFC; border:1px solid #CBD5E1; color:#334155; font-size:11px; font-weight:600; }
            .pr-section-bar { background:#1F3A60; color:#FFFFFF; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; padding:6px 10px; border-radius:4px 4px 0 0; }
            .pr-col-tbl, .pr-meta-tbl, .pr-items-tbl { width:100%; border-collapse:collapse; font-size:12.5px; border:1px solid #CBD5E1; }
            .pr-col-tbl thead th { background:#EFF4FB; color:#1F3A60; font-weight:700; font-size:10.5px; text-transform:uppercase; letter-spacing:0.04em; padding:7px 10px; border:1px solid #CBD5E1; text-align:left; }
            .pr-col-tbl tbody td { background:#FFFFFF; color:#0f172a; font-weight:600; padding:8px 10px; border:1px solid #CBD5E1; vertical-align:top; word-break:break-word; }
            .pr-meta-lbl { background:#EFF4FB; color:#1F3A60; font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:0.03em; padding:7px 10px; border:1px solid #CBD5E1; width:18%; }
            .pr-meta-val { background:#FFFFFF; color:#0f172a; font-weight:600; padding:7px 10px; border:1px solid #CBD5E1; width:32%; }
            .pr-items-tbl thead th { background:#273990; color:#FFFFFF; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; padding:8px 9px; border:1px solid #273990; text-align:left; }
            .pr-items-tbl tbody td { padding:7px 9px; border:1px solid #E2E8F0; background:#FFFFFF; color:#0f172a; }
            .pr-items-tbl tbody tr:nth-child(even) td { background:#F4F7FC; }
            .okw-num { text-align:right !important; }
            .pr-totals-tbl { min-width:300px; border-collapse:collapse; border:1px solid #CBD5E1; font-size:12.5px; }
            .pr-tot-lbl { background:#EFF4FB; color:#1F3A60; font-weight:600; padding:7px 12px; border:1px solid #CBD5E1; }
            .pr-tot-val { background:#FFFFFF; color:#0f172a; font-weight:700; text-align:right; padding:7px 12px; border:1px solid #CBD5E1; }
            .pr-net-row .pr-tot-lbl, .pr-net-row .pr-tot-val { background:#1F3A60 !important; color:#FFFFFF !important; font-size:14px; font-weight:800; border-color:#1F3A60; }
            .pr-notes-box { margin-top:14px; padding:10px 12px; border-left:4px solid #1F3A60; background:#EFF4FB; color:#0f172a; font-size:12px; border-radius:0 6px 6px 0; }
        `;

        const detailsStackedHtml = formatCompanyDetailsStackedHtml(profile);
        const bodyHtml = `
            <div class="pr-banner">
                <div class="pr-brand">
                    <img class="pr-brand-logo" src="${escapeHtml(profile.logoUrl)}" alt="${escapeHtml(profile.name)}">
                    <div class="pr-company">${escapeHtml(profile.name)}</div>
                    ${detailsStackedHtml ? `<div class="pr-company-sub">${detailsStackedHtml}</div>` : ''}
                </div>
                <div class="pr-doc-right">
                    <div class="pr-doc-title">${escapeHtml(title)}</div>
                    ${resolvedRef ? `<div class="pr-ref-pill">${escapeHtml(resolvedRef)}</div>` : ''}
                    ${resolvedDate ? `<div class="pr-date-pill">Date: ${escapeHtml(resolvedDate)}</div>` : ''}
                </div>
            </div>
            ${metaTableHtml}
            ${itemsHtml}
            ${extraHtml}
            ${totalsHtml}
            ${notes ? `<div class="pr-notes-box"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
        `;

        const backdrop = document.createElement('div');
        backdrop.id = 'okw-printable-record-modal';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        backdrop.setAttribute('aria-label', title);
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10060;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="okw-card" style="width:100%;max-width:860px;max-height:90vh;overflow-y:auto;padding:22px 26px;box-shadow:0 20px 50px rgba(0,0,0,0.3);background:#fff;color:#0f172a;">
                <style>${sharedDocStyles}</style>
                <div id="okw-print-record-body">${bodyHtml}</div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid #e2e8f0;">
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-pr-close">Close</button>
                    <button type="button" class="okw-btn okw-btn-primary" id="okw-pr-print">Print Form</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        const modalLogo = backdrop.querySelector('.pr-brand-logo');
        if (modalLogo) {
            modalLogo.addEventListener('error', () => { modalLogo.style.display = 'none'; });
        }
        const closeRecordModal = () => {
            document.removeEventListener('keydown', onEscRecord);
            backdrop.remove();
        };
        const onEscRecord = (ev) => { if (ev.key === 'Escape') closeRecordModal(); };
        document.addEventListener('keydown', onEscRecord);
        backdrop.querySelector('#okw-pr-close').onclick = closeRecordModal;
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeRecordModal(); });
        backdrop.querySelector('#okw-pr-print').onclick = () => {
            const printDoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(profile.name)} — ${escapeHtml(title)}</title><style>
                @page{size:A4 portrait;margin:13mm;}
                body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#0f172a;margin:0;padding:0;font-size:12px;background:#ffffff;}
                ${sharedDocStyles}
                .sig-row{display:flex;justify-content:space-between;margin-top:38px;font-size:11px;color:#475569;}
                .sig-box{width:42%;border-top:1.5px solid #1F3A60;padding-top:6px;font-weight:600;color:#1F3A60;}
                .pr-print-foot{margin-top:18px;padding-top:8px;border-top:1px solid #CBD5E1;display:flex;justify-content:space-between;font-size:10px;color:#64748b;}
            </style></head><body>${bodyHtml}
                <div class="sig-row"><div class="sig-box">Prepared By / Signature</div><div class="sig-box">Approved / Received By</div></div>
                <div class="pr-print-foot"><span>${escapeHtml(profile.name)} — Official Document</span><span>Printed: ${escapeHtml(new Date().toLocaleString())}</span></div>
            </body></html>`;
            let iframe = document.getElementById('okw-print-frame');
            if (iframe) iframe.remove();
            iframe = document.createElement('iframe');
            iframe.id = 'okw-print-frame';
            iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
            document.body.appendChild(iframe);
            const doc = iframe.contentWindow.document;
            doc.open(); doc.write(printDoc); doc.close();
            iframe.contentWindow.focus();
            setTimeout(() => { iframe.contentWindow.print(); }, 120);
        };
    }

    function humanizeAction(action) {
        return String(action || 'Activity')
            .replace(/_/g, ' ')
            .toLowerCase()
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    function formatAuditSummary(action, raw) {
        let d = raw;
        if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch (_) { return d; }
        }
        if (!d || typeof d !== 'object') return humanizeAction(action);

        const fmtC = (n) => (typeof window.formatCurrency === 'function'
            ? window.formatCurrency(n)
            : 'GH₵ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

        const parts = [];
        if (d.receipt_number || d.receiptNumber) parts.push(`Receipt #${d.receipt_number || d.receiptNumber}`);
        if (d.return_receipt) parts.push(`Return #${d.return_receipt}`);
        if (d.original_receipt) parts.push(`Orig #${d.original_receipt}`);
        if (d.quote_number) parts.push(`Quote ${d.quote_number}`);
        if (d.reference_no) parts.push(d.reference_no);
        if (d.po_id || d.poId) parts.push(`PO #${d.po_id || d.poId}`);
        if (d.label) parts.push(d.label);
        if (d.supplier_name) parts.push(`Supplier: ${d.supplier_name}`);
        if (d.customer_name) parts.push(`Customer: ${d.customer_name}`);
        if (d.name && !d.customer_name && !d.supplier_name) parts.push(d.name);
        if (d.category && !d.changes) parts.push(d.category);

        if (d.total !== undefined) parts.push(fmtC(d.total));
        else if (d.total_amount !== undefined) parts.push(fmtC(d.total_amount));
        else if (d.refund_total !== undefined) parts.push(`Refund ${fmtC(d.refund_total)}`);
        else if (d.amount !== undefined) parts.push(fmtC(d.amount));

        if (Array.isArray(d.items) && d.items.length) {
            const preview = d.items.slice(0, 2).map(it => {
                const nm = it.name || it.product_name || it.barcode || 'Item';
                if (it.old_qty !== undefined && it.new_qty !== undefined) {
                    const v = Number(it.variance ?? (Number(it.new_qty) - Number(it.old_qty)));
                    return `${nm} (${it.old_qty} → ${it.new_qty}, ${v >= 0 ? '+' : ''}${v})`;
                }
                return `${nm} ×${it.qty ?? it.quantity ?? 1}`;
            }).join(', ');
            parts.push(`${d.items.length} item${d.items.length === 1 ? '' : 's'} (${preview}${d.items.length > 2 ? ', …' : ''})`);
        } else if (d.product || d.product_name) {
            const nm = d.product || d.product_name;
            if (d.previousQty !== undefined && d.newQty !== undefined) {
                parts.push(`${nm} (${d.previousQty} → ${d.newQty}${d.change ? ', ' + d.change : ''})`);
            } else if (d.stock !== undefined) {
                parts.push(`${nm} (Qty: ${d.stock})`);
            } else {
                parts.push(nm);
            }
        }
        if (Array.isArray(d.items_removed) && d.items_removed.length) {
            const preview = d.items_removed.slice(0, 2).map(it => `${it.name || it.barcode} ×${it.qty}`).join(', ');
            parts.push(`Removed ${d.items_removed.length} (${preview}${d.items_removed.length > 2 ? ', …' : ''})`);
        }
        if (d.changes && typeof d.changes === 'object' && Object.keys(d.changes).length) {
            const diffStr = Object.entries(d.changes).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.from} → ${v.to}`).join(', ');
            parts.push(`Amended (${diffStr})`);
        }
        if (d.quantity_adjusted !== undefined && !(Array.isArray(d.items) && d.items.length)) {
            parts.push(`${d.product_name || d.product_barcode || ''} (${Number(d.quantity_adjusted) >= 0 ? '+' : ''}${d.quantity_adjusted})`);
        }
        if (d.reason) parts.push(`Reason: ${d.reason}`);

        if (!parts.length) {
            const branch = d.store_location || d.branch || '';
            const actor = d.actor_name || '';
            const role = d.actor_role ? String(d.actor_role).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
            const summary = [humanizeAction(action)];
            if (branch) summary.push(branch);
            else if (actor) summary.push(role ? `${actor} (${role})` : actor);
            return summary.join(' · ');
        }
        const branch = d.store_location || d.branch;
        if (branch && !parts.includes(branch)) parts.push(branch);
        return parts.join(' · ');
    }

    async function openAuditDetailModal(log = {}) {
        const prev = document.getElementById('okw-audit-detail-modal');
        if (prev) prev.remove();

        let d = log.rawDetails !== undefined ? log.rawDetails : log.details;
        if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch (_) { d = d ? { note: d } : {}; }
        }
        d = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};

        const fmtC = (n) => (typeof window.formatCurrency === 'function'
            ? window.formatCurrency(n)
            : 'GH₵ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

        const itemsAdded = Array.isArray(d.items) ? d.items : [];
        const itemsRemoved = Array.isArray(d.items_removed) ? d.items_removed : [];
        const changes = (d.changes && typeof d.changes === 'object') ? Object.entries(d.changes) : [];
        const payments = Array.isArray(d.payments) ? d.payments : [];
        const staffName = log.user || log.user_name || d.actor_name || 'Staff';
        const roleLabel = String(log.role || log.user_role || d.actor_role || 'Staff').replace(/_/g, ' ').toUpperCase();
        const timeStr = log.time || (log.created_at ? new Date(log.created_at).toLocaleString() : '—');
        const branchStr = d.store_location || d.branch || '—';
        const refNo = d.receipt_number || d.receiptNumber || d.return_receipt || d.quote_number || d.reference_no || (d.po_id ? `PO-${d.po_id}` : '');
        const totalVal = d.total ?? d.total_amount ?? d.refund_total ?? d.amount ?? null;

        const SKIP_KEYS = new Set([
            'actor_name', 'actor_role', 'branch', 'store_location', 'items', 'items_removed',
            'changes', 'payments', 'receipt_number', 'receiptNumber', 'quote_number', 'reference_no',
            'po_id', 'total', 'total_amount', 'refund_total', 'amount', 'subtotal', 'discount_amount',
            'paid_amount', 'balance_due', 'change_amount', 'customer_name', 'supplier_name', 'reason', 'notes'
        ]);
        const extraMeta = Object.entries(d)
            .filter(([k, v]) => !SKIP_KEYS.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object')
            .map(([k, v]) => [k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), String(v)]);

        const metaRows = [
            ['Action', `${humanizeAction(log.action)} (${log.action || ''})`],
            ['Staff', staffName],
            ['Role', roleLabel],
            ['Branch / Location', branchStr],
            ['Timestamp', timeStr],
            ...(log.ip || log.ip_address ? [['IP Address', log.ip || log.ip_address]] : []),
            ...(d.customer_name ? [['Customer', d.customer_name]] : []),
            ...(d.supplier_name ? [['Supplier', d.supplier_name]] : []),
            ...(payments.length ? [['Payments', payments.map(p => `${p.method}: ${fmtC(p.amount)}`).join(', ')]] : []),
            ...extraMeta
        ];

        const extraSections = [];
        if (Object.keys(d).length) {
            extraSections.push(`
                <details style="margin-top:16px;border:1px solid var(--edge,#e2e8f0);border-radius:8px;padding:10px 12px;background:var(--frame,#f8fafc);">
                    <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--muted,#64748b);user-select:none;">Technical Event Payload (Raw Audit Data)</summary>
                    <pre style="margin:10px 0 0;padding:10px;border-radius:6px;background:var(--sheet,#fff);border:1px solid var(--edge,#e2e8f0);font-size:11.5px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;color:var(--ink-2,#334155);">${escapeHtml(JSON.stringify(d, null, 2))}</pre>
                </details>`);
        }

        if (itemsRemoved.length) {
            extraSections.push(`
                <div style="margin-top:16px;">
                    <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#b91c1c;margin-bottom:6px;">Items Removed / Returned / Deleted (${itemsRemoved.length})</div>
                    <table class="okw-table" style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr><th>Item</th><th>Barcode</th><th class="okw-num">Qty</th><th class="okw-num">Unit Price</th><th class="okw-num">Total</th></tr></thead>
                        <tbody>${itemsRemoved.map(it => `<tr>
                            <td><strong>${escapeHtml(it.name || it.barcode || 'Item')}</strong></td>
                            <td>${escapeHtml(it.barcode || '—')}</td>
                            <td class="okw-num">${escapeHtml(it.qty ?? 1)}</td>
                            <td class="okw-num">${it.price !== undefined ? fmtC(it.price) : '—'}</td>
                            <td class="okw-num"><strong>${it.line_total !== undefined ? fmtC(it.line_total) : (it.price !== undefined ? fmtC(Number(it.price) * Number(it.qty || 1)) : '—')}</strong></td>
                        </tr>`).join('')}</tbody>
                    </table>
                </div>`);
        }
        if (changes.length) {
            extraSections.push(`
                <div style="margin-top:16px;">
                    <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#b45309;margin-bottom:6px;">Amended Fields (Before → After)</div>
                    <table class="okw-table" style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                        <tbody>${changes.map(([k, v]) => `<tr>
                            <td><strong>${escapeHtml(k.replace(/_/g, ' '))}</strong></td>
                            <td>${escapeHtml(v && v.from !== undefined ? v.from : '—')}</td>
                            <td><strong>${escapeHtml(v && v.to !== undefined ? v.to : '—')}</strong></td>
                        </tr>`).join('')}</tbody>
                    </table>
                </div>`);
        }

        await openPrintableRecord({
            title: `Activity Log — ${humanizeAction(log.action)}`,
            refNumber: refNo,
            date: timeStr,
            partyLabel: d.supplier_name ? 'Supplier' : (d.customer_name ? 'Customer' : 'Performed By'),
            partyName: d.supplier_name || d.customer_name || staffName,
            branch: branchStr,
            status: d.status ? String(d.status).toUpperCase() : '',
            paymentStatus: d.payment_status || '',
            metaRows,
            items: itemsAdded,
            subtotal: d.subtotal !== undefined ? Number(d.subtotal) : null,
            discount: d.discount_amount !== undefined ? Number(d.discount_amount) : null,
            netTotal: totalVal !== null ? Number(totalVal) : null,
            paidAmount: d.paid_amount !== undefined ? Number(d.paid_amount) : null,
            balanceDue: d.balance_due !== undefined ? Number(d.balance_due) : null,
            notes: [d.reason, d.notes].filter(Boolean).join(' · '),
            extraHtml: extraSections.join('')
        });
    }

    function ensureRowExpandStyles() {
        if (document.getElementById('okw-row-expand-styles')) return;
        const st = document.createElement('style');
        st.id = 'okw-row-expand-styles';
        st.textContent = `
            table tbody tr.okw-expandable-row { cursor: pointer; transition: background-color 0.14s ease; }
            table tbody tr.okw-expandable-row:hover td { background: rgba(39, 57, 144, 0.045) !important; }
            table tbody tr.okw-row-expanded td { background: #EFF4FB !important; border-bottom-color: #BFDBFE !important; }
            table tbody tr.okw-row-expand-detail td { padding: 0 !important; background: #F8FAFC !important; border-bottom: 2px solid #273990 !important; }
            .okw-expand-card { padding: 14px 18px; border-left: 4px solid #273990; background: #F8FAFC; }
            .okw-expand-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #E2E8F0; }
            .okw-expand-title { font-size: 12.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: #1F3A60; }
            .okw-expand-actions { display: inline-flex; gap: 8px; align-items: center; }
            .okw-expand-btn { padding: 4px 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; cursor: pointer; border: 1px solid #CBD5E1; background: #FFFFFF; color: #1F3A60; }
            .okw-expand-btn:hover { border-color: #273990; background: #EFF4FB; }
            .okw-expand-btn-primary { background: #1F3A60; border-color: #1F3A60; color: #FFFFFF; }
            .okw-expand-btn-primary:hover { background: #273990; color: #FFFFFF; }
            .okw-expand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 16px; }
            .okw-expand-item { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 7px; padding: 8px 11px; min-width: 0; }
            .okw-expand-lbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #64748B; margin-bottom: 3px; }
            .okw-expand-val { font-size: 13px; font-weight: 600; color: #0F172A; word-break: break-word; }
        `;
        document.head.appendChild(st);
    }

    function toggleExpandTableRow(tr, { title = 'Record Details', fields = [], colSpan = 1, onFullDetails = null } = {}) {
        ensureRowExpandStyles();
        if (!tr || !tr.parentNode) return;
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('okw-row-expand-detail')) {
            next.remove();
            tr.classList.remove('okw-row-expanded');
            return;
        }
        tr.classList.add('okw-row-expanded');
        const detailTr = document.createElement('tr');
        detailTr.className = 'okw-row-expand-detail';
        const safeFields = (fields || []).filter(([k]) => k && !/^(action|actions|inspect)$/i.test(String(k).trim()));
        const td = document.createElement('td');
        td.colSpan = Math.max(1, colSpan);
        td.innerHTML = `
            <div class="okw-expand-card">
                <div class="okw-expand-head">
                    <span class="okw-expand-title">${escapeHtml(title)}</span>
                    <div class="okw-expand-actions">
                        ${typeof onFullDetails === 'function' ? '<button type="button" class="okw-expand-btn okw-expand-btn-primary" data-exp-full>Full Details</button>' : ''}
                        <button type="button" class="okw-expand-btn ${typeof onFullDetails === 'function' ? '' : 'okw-expand-btn-primary'}" data-exp-print>Print Record</button>
                        <button type="button" class="okw-expand-btn" data-exp-close>Collapse</button>
                    </div>
                </div>
                <div class="okw-expand-grid">
                    ${safeFields.map(([k, v]) => `
                        <div class="okw-expand-item">
                            <div class="okw-expand-lbl">${escapeHtml(k)}</div>
                            <div class="okw-expand-val">${escapeHtml(v === null || v === undefined || v === '' ? '—' : v)}</div>
                        </div>`).join('')}
                </div>
            </div>
        `;
        detailTr.appendChild(td);
        tr.insertAdjacentElement('afterend', detailTr);

        const closeBtn = detailTr.querySelector('[data-exp-close]');
        if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); detailTr.remove(); tr.classList.remove('okw-row-expanded'); });
        const printBtn = detailTr.querySelector('[data-exp-print]');
        if (printBtn) printBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openPrintableRecord({ title, metaRows: safeFields });
        });
        const fullBtn = detailTr.querySelector('[data-exp-full]');
        if (fullBtn && typeof onFullDetails === 'function') {
            fullBtn.addEventListener('click', (e) => { e.stopPropagation(); onFullDetails(); });
        }
    }

    function dataTable(container, opts) {
        const el = typeof container === 'string' ? document.querySelector(container) : container;
        if (!el) return;
        const {
            columns = [],
            rows = [],
            searchPlaceholder = 'Search...',
            exportFilename = 'okwesiwa-report.xlsx',
            printTitle = '',
            pageSize = 25,
            emptyText = 'No matching records found.'
        } = opts;

        let query = '';
        let sortKey = null;
        let sortDir = 1;
        let page = 1;
        const hiddenKeys = new Set();

        const getVisibleCols = () => columns.filter(c => !hiddenKeys.has(c.key));

        el.innerHTML = `
            <div class="okw-dt-bar" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;">
                <input type="search" class="okw-input" data-search placeholder="${escapeHtml(searchPlaceholder)}" style="min-width:220px;flex:1;max-width:340px;height:36px;">
                <div class="okw-dt-actions" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;position:relative;">
                    <button type="button" class="okw-btn okw-btn-outline" data-export-csv style="height:36px;">Export CSV</button>
                    <button type="button" class="okw-btn okw-btn-outline" data-export-excel style="height:36px;">Export Excel</button>
                    <button type="button" class="okw-btn okw-btn-outline" data-print style="height:36px;">Print</button>
                    <div style="display:inline-flex;align-items:center;gap:4px;">
                        <select class="okw-select" data-pdf-orientation aria-label="PDF Orientation" style="height:36px;padding:0 8px;font-size:12px;">
                            <option value="portrait">PDF Portrait</option>
                            <option value="landscape">PDF Landscape</option>
                        </select>
                        <button type="button" class="okw-btn okw-btn-outline" data-export-pdf style="height:36px;">Export PDF</button>
                    </div>
                    <div style="position:relative;">
                        <button type="button" class="okw-btn okw-btn-outline" data-col-vis style="height:36px;">Columns &#9662;</button>
                        <div data-col-menu style="display:none;position:absolute;right:0;top:40px;min-width:190px;max-height:260px;overflow-y:auto;background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgba(15,23,42,0.12);z-index:50;">
                            ${columns.map(c => `
                                <label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:13px;cursor:pointer;color:var(--color-text,#1e293b);">
                                    <input type="checkbox" data-col-toggle="${escapeHtml(c.key)}" checked>
                                    <span>${escapeHtml(c.label)}</span>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
            <div class="table-card">
                <table data-okw-managed="1" style="width:100%;border-collapse:collapse;">
                    <thead><tr></tr></thead>
                    <tbody></tbody>
                </table>
            </div>
            <div data-pager style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;font-size:13px;color:var(--color-text-muted);"></div>
        `;

        const dtBar = el.querySelector('.okw-dt-bar');
        const dtActions = el.querySelector('.okw-dt-actions');
        const searchIn = el.querySelector('[data-search]');
        const theadRow = el.querySelector('thead tr');
        const tbody = el.querySelector('tbody');
        const pager = el.querySelector('[data-pager]');
        const colBtn = el.querySelector('[data-col-vis]');
        const colMenu = el.querySelector('[data-col-menu]');
        compactExportMenu(el, { csv: '[data-export-csv]', excel: '[data-export-excel]', print: '[data-print]', orient: '[data-pdf-orientation]', pdf: '[data-export-pdf]' });
        const pdfOrient = el.querySelector('[data-pdf-orientation]');

        // Merge into the page's single-row filter/action bar when one exists right above this table
        const pageWrap = el.closest('.page-wrap');
        const dockBar = pageWrap
            ? (pageWrap.querySelector('.okw-hub-bar .okw-hub-toolbar') || pageWrap.querySelector('.okw-action-bar'))
            : null;
        if (dockBar && dockBar.querySelector('details.okw-filter-menu')) {
            const outerBar = dockBar.closest('.okw-hub-bar') || dockBar;
            if (outerBar.style.display !== 'none') {
                outerBar.classList.add('okw-bar-unified');
                dockBar.querySelectorAll('[data-dt-docked="1"]').forEach(n => n.remove());
                searchIn.dataset.dtDocked = '1';
                searchIn.classList.add('okw-dt-docked-search');
                dtActions.dataset.dtDocked = '1';
                dtActions.classList.add('okw-dt-docked-actions');
                dockBar.insertBefore(searchIn, dockBar.firstChild);
                const filterNode = dockBar.querySelector('details.okw-filter-menu');
                const insertAnchor = filterNode && filterNode.parentNode === dockBar
                    ? filterNode.nextSibling
                    : (filterNode && filterNode.parentNode && filterNode.parentNode.parentNode === dockBar ? filterNode.parentNode.nextSibling : null);
                dockBar.insertBefore(dtActions, insertAnchor);
                if (dtBar) dtBar.style.display = 'none';
            }
        }

        function getFiltered() {
            const q = query.trim().toLowerCase();
            const visCols = getVisibleCols();
            let list = !q ? [...rows] : rows.filter(r =>
                visCols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q))
            );
            if (sortKey) {
                list.sort((a, b) => {
                    const av = a[sortKey] ?? '';
                    const bv = b[sortKey] ?? '';
                    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
                    return String(av).localeCompare(String(bv)) * sortDir;
                });
            }
            return list;
        }

        function render() {
            const visCols = getVisibleCols();
            theadRow.innerHTML = visCols.map(c => {
                const arrow = sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
                return `<th data-sort="${escapeHtml(c.key)}" class="${c.numeric ? 'numeric' : ''}" style="cursor:pointer;user-select:none;">${escapeHtml(c.label)}<span style="opacity:0.65;font-size:10px;">${arrow}</span></th>`;
            }).join('');
            theadRow.querySelectorAll('th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    const key = th.dataset.sort;
                    if (sortKey === key) sortDir *= -1;
                    else { sortKey = key; sortDir = 1; }
                    render();
                });
            });

            const filtered = getFiltered();
            const effPageSize = pageSize === 'all' ? Math.max(1, filtered.length) : Number(pageSize || 25);
            const totalPages = Math.max(1, Math.ceil(filtered.length / effPageSize));
            if (page > totalPages) page = totalPages;
            const startIdx = (page - 1) * effPageSize;
            const slice = filtered.slice(startIdx, startIdx + effPageSize);

            if (!visCols.length) {
                tbody.innerHTML = `<tr><td style="text-align:center;padding:28px;color:var(--color-text-muted);">No columns selected.</td></tr>`;
            } else if (slice.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${visCols.length}" style="text-align:center;padding:28px;color:var(--color-text-muted);">${escapeHtml(emptyText)}</td></tr>`;
            } else {
                tbody.innerHTML = slice.map((r, rIdx) => `<tr data-row-idx="${rIdx}" class="okw-expandable-row" style="cursor:pointer;">${visCols.map(c => {
                    const content = typeof c.render === 'function' ? c.render(r[c.key], r) : escapeHtml(r[c.key] ?? '');
                    return `<td class="${c.numeric ? 'numeric' : ''}">${content}</td>`;
                }).join('')}</tr>`).join('');
                tbody.querySelectorAll('tr[data-row-idx]').forEach(tr => {
                    tr.addEventListener('click', (e) => {
                        if (e.target.closest('button, a, input, select, textarea, label, details, summary, [role="menu"], [role="menuitem"], .dropdown, .dropdown-menu, [data-onclick], [onclick]')) return;
                        const td = e.target.closest('td');
                        if (td && /^(action|actions)$/i.test(String(td.getAttribute('data-label') || '').trim())) return;
                        const row = slice[Number(tr.dataset.rowIdx)];
                        if (!row) return;
                        if (typeof opts.onRowClick === 'function') {
                            opts.onRowClick(row);
                            return;
                        }
                        const viewBtn = Array.from(tr.querySelectorAll('button')).find(b => /^(view|view details|view purchase|inspect)$/i.test((b.textContent || '').trim()) || /^view\b/i.test(String(b.getAttribute('title') || '').trim()));
                        if (viewBtn) {
                            viewBtn.click();
                            return;
                        }
                        const allMetaRows = columns
                            .filter(c => !/^(action|actions|inspect)$/i.test(String(c.label || '').trim()))
                            .map(c => {
                                const rawVal = typeof c.exportValue === 'function'
                                    ? c.exportValue(row)
                                    : (row[c.key] ?? '');
                                const textVal = (rawVal && typeof rawVal === 'object')
                                    ? Object.entries(rawVal).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')
                                    : String(rawVal);
                                return [c.label, textVal || '—'];
                            });
                        openPrintableRecord({
                            title: getTitle(),
                            metaRows: allMetaRows
                        });
                    });
                });
            }
            const fromN = filtered.length ? startIdx + 1 : 0;
            const toN = startIdx + slice.length;
            pager.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <span>Showing ${fromN}–${toN} of ${filtered.length}</span>
                    <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--color-text-muted,#64748b);">
                        Rows:
                        <select data-pagesize class="okw-select" style="height:30px;padding:0 8px;font-size:12.5px;width:auto;">
                            <option value="25"${String(pageSize) === '25' ? ' selected' : ''}>25</option>
                            <option value="50"${String(pageSize) === '50' ? ' selected' : ''}>50</option>
                            <option value="100"${String(pageSize) === '100' ? ' selected' : ''}>100</option>
                            <option value="all"${String(pageSize) === 'all' ? ' selected' : ''}>All</option>
                        </select>
                    </label>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button type="button" class="okw-btn okw-btn-outline" data-prev ${page <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${page} / ${totalPages}</span>
                    <button type="button" class="okw-btn okw-btn-outline" data-next ${page >= totalPages ? 'disabled' : ''}>Next</button>
                </div>
            `;
            pager.querySelector('[data-prev]').onclick = () => { if (page > 1) { page--; render(); } };
            pager.querySelector('[data-next]').onclick = () => { if (page < totalPages) { page++; render(); } };
            const psSel = pager.querySelector('[data-pagesize]');
            if (psSel) psSel.onchange = () => { pageSize = psSel.value === 'all' ? 'all' : Number(psSel.value); page = 1; render(); };
        }

        searchIn.addEventListener('input', () => { query = searchIn.value; page = 1; render(); });

        colBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            colMenu.style.display = colMenu.style.display === 'none' ? 'block' : 'none';
        });
        colMenu.addEventListener('click', (e) => e.stopPropagation());
        if (!document.documentElement.dataset.okwColMenuClose) {
            document.documentElement.dataset.okwColMenuClose = '1';
            document.addEventListener('click', () => {
                document.querySelectorAll('[data-t-colmenu]').forEach(m => { m.style.display = 'none'; });
            });
        }
        colMenu.querySelectorAll('[data-col-toggle]').forEach(cb => {
            cb.addEventListener('change', () => {
                const k = cb.getAttribute('data-col-toggle');
                if (cb.checked) hiddenKeys.delete(k);
                else hiddenKeys.add(k);
                render();
            });
        });

        const getExportCols = () => {
            const vis = getVisibleCols();
            const printable = vis.filter(c => !/^(action|receipt)$/i.test(String(c.label || '').trim()) || typeof c.exportValue === 'function');
            return printable.length ? printable : vis;
        };
        const getTitle = () => printTitle || exportFilename.replace(/\.(xlsx|csv)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        dtActions.querySelector('[data-export-csv]').onclick = () => {
            exportRowsToCsv(getExportCols(), getFiltered(), exportFilename);
        };
        dtActions.querySelector('[data-export-excel]').onclick = () => {
            exportRowsToExcel(getExportCols(), getFiltered(), exportFilename, getTitle());
        };
        dtActions.querySelector('[data-print]').onclick = () => {
            printRowsList(getExportCols(), getFiltered(), getTitle(), 'portrait');
        };
        dtActions.querySelector('[data-export-pdf]').onclick = () => {
            const orient = pdfOrient ? pdfOrient.value : 'portrait';
            printRowsList(getExportCols(), getFiltered(), getTitle(), orient);
        };
        render();
    }

    function attachTableTools(table, opts = {}) {
        if (!table || table.dataset.okwManaged === '1' || table.dataset.okwToolsAttached === '1') return;
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        if (!thead || !tbody) return;
        const ths = Array.from(thead.querySelectorAll('th'));
        if (ths.length < 2) return;
        if (table.closest('#okw-today-profit-modal, #okw-cmd-modal, .modal, .modal-content')) return;

        table.dataset.okwToolsAttached = '1';
        const hiddenIdx = new Set();

        // Universal click-to-sort (ascending / descending / alphabetical / numeric / date) on every native table
        if (table.dataset.okwSortable !== '1') {
            table.dataset.okwSortable = '1';
            let activeSortCol = -1;
            let activeSortDir = 1;
            const parseCellVal = (str) => {
                const s = String(str || '').trim();
                if (!s || s === '—' || s === '-') return { kind: 'empty', val: '' };
                const cleaned = s.replace(/^(GH₵|GHS|¢|\$|€|£)\s*/i, '').replace(/,/g, '').replace(/%$/, '').trim();
                if (/^-?\d+(\.\d+)?$/.test(cleaned)) return { kind: 'num', val: parseFloat(cleaned) };
                if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) {
                    const ts = Date.parse(s);
                    if (!Number.isNaN(ts)) return { kind: 'num', val: ts };
                }
                return { kind: 'str', val: s.toLowerCase() };
            };
            ths.forEach((th, colIdx) => {
                if (th.querySelector('input[type="checkbox"]')) return;
                const labelText = (th.textContent || '').trim();
                if (!labelText || /^(action|actions|inspect)$/i.test(labelText)) return;
                th.style.cursor = 'pointer';
                th.style.userSelect = 'none';
                th.title = 'Click to sort';
                th.addEventListener('click', (e) => {
                    if (e.target.closest('input, button, select, a')) return;
                    if (activeSortCol === colIdx) activeSortDir *= -1;
                    else { activeSortCol = colIdx; activeSortDir = 1; }
                    ths.forEach((h, i) => {
                        let ind = h.querySelector('.okw-sort-ind');
                        if (!ind) {
                            ind = document.createElement('span');
                            ind.className = 'okw-sort-ind';
                            ind.style.cssText = 'margin-left:4px;font-size:10px;opacity:0.65;';
                            h.appendChild(ind);
                        }
                        ind.textContent = i === activeSortCol ? (activeSortDir === 1 ? '▲' : '▼') : '';
                    });
                    tbody.querySelectorAll('tr.okw-row-expand-detail').forEach(d => d.remove());
                    tbody.querySelectorAll('tr.okw-row-expanded').forEach(r => r.classList.remove('okw-row-expanded'));
                    const trs = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
                        if (tr.classList.contains('okw-row-expand-detail')) return false;
                        const cells = tr.querySelectorAll('td');
                        return cells.length > 1 || (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) <= 1);
                    });
                    trs.sort((ra, rb) => {
                        const a = parseCellVal(ra.cells[colIdx]?.innerText);
                        const b = parseCellVal(rb.cells[colIdx]?.innerText);
                        if (a.kind === 'empty' && b.kind !== 'empty') return 1;
                        if (b.kind === 'empty' && a.kind !== 'empty') return -1;
                        if (a.kind === 'num' && b.kind === 'num') return (a.val - b.val) * activeSortDir;
                        return String(a.val).localeCompare(String(b.val), undefined, { numeric: true, sensitivity: 'base' }) * activeSortDir;
                    });
                    trs.forEach(tr => tbody.appendChild(tr));
                });
            });
        }
        function resolveTableDocumentTitle() {
            if (opts.title) return String(opts.title).trim();
            if (table.dataset.printTitle) return String(table.dataset.printTitle).trim();
            const cleanHeading = (el) => {
                if (!el) return '';
                const t = String(el.textContent || '').replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim();
                return t && !/^loading/i.test(t) ? t : '';
            };
            const tabContainer = table.closest('.tab-content, section, .modal-content');
            if (tabContainer) {
                const h = cleanHeading(tabContainer.querySelector('.page-header h1, .page-header h2, .page-header h3, .section-title, h2, h3'));
                if (h) return h;
            }
            const cardContainer = table.closest('.inventory-card, .card, .table-card');
            if (cardContainer && cardContainer.previousElementSibling) {
                const h = cleanHeading(cardContainer.previousElementSibling.querySelector('h1, h2, h3') || (cardContainer.previousElementSibling.matches('h1, h2, h3') ? cardContainer.previousElementSibling : null));
                if (h) return h;
            }
            const topHeading = cleanHeading(document.querySelector('#pageTitle, .topbar-title, .okw-topbar-title, main h1, .main-content .page-header h2, .main-content .page-header h3'));
            if (topHeading) return topHeading;
            return (document.title || 'Report').replace(/OKWESIWA CO LTD\s*\|\s*/i, '').replace(/\s*-\s*OKWESIWA CO LTD/i, '').trim() || 'Report';
        }
        function resolveFilename(docTitle) {
            if (opts.filename) return opts.filename;
            const slug = String(docTitle || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
            return `okwesiwa-${slug}.xlsx`;
        }

        const bar = document.createElement('div');
        bar.className = 'okw-table-tools-bar';
        bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;margin-bottom:10px;position:relative;';
        bar.innerHTML = `
            <button type="button" class="okw-btn okw-btn-outline" data-t-csv style="height:34px;font-size:12px;">Export CSV</button>
            <button type="button" class="okw-btn okw-btn-outline" data-t-excel style="height:34px;font-size:12px;">Export Excel</button>
            <button type="button" class="okw-btn okw-btn-outline" data-t-print style="height:34px;font-size:12px;">Print</button>
            <select class="okw-select" data-t-orient aria-label="PDF Orientation" style="height:34px;padding:0 8px;font-size:12px;">
                <option value="portrait">PDF Portrait</option>
                <option value="landscape">PDF Landscape</option>
            </select>
            <button type="button" class="okw-btn okw-btn-outline" data-t-pdf style="height:34px;font-size:12px;">Export PDF</button>
            <div style="position:relative;">
                <button type="button" class="okw-btn okw-btn-outline" data-t-colbtn style="height:34px;font-size:12px;">Columns &#9662;</button>
                <div data-t-colmenu style="display:none;position:absolute;right:0;top:38px;min-width:190px;max-height:260px;overflow-y:auto;background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgba(15,23,42,0.12);z-index:50;text-align:left;">
                    ${ths.map((th, idx) => `
                        <label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:13px;cursor:pointer;color:var(--color-text,#1e293b);">
                            <input type="checkbox" data-t-colidx="${idx}" checked>
                            <span>${escapeHtml(th.textContent.trim() || `Column ${idx + 1}`)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;

        const anchor = table.closest('.table-card, .table-scroll-wrapper') || table;
        if (anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
        compactExportMenu(bar, { csv: '[data-t-csv]', excel: '[data-t-excel]', print: '[data-t-print]', orient: '[data-t-orient]', pdf: '[data-t-pdf]' });

        if (!document.getElementById('okw-auto-pager-style')) {
            const ps = document.createElement('style');
            ps.id = 'okw-auto-pager-style';
            ps.textContent = `tr[data-okw-page-hidden="1"]{display:none !important;}.okw-auto-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-top:1px solid var(--edge,#e2e8f0);font-size:13px;color:var(--muted,#64748b);background:var(--sheet,#fff);}`;
            document.head.appendChild(ps);
        }

        const hostSection = anchor.parentNode;
        const hasNativePager = Boolean(
            table.dataset.noPagination === '1'
            || table.closest('.modal, .okw-dt, #okw-printable-record-modal')
            || (hostSection && hostSection.querySelector('.pagination-controls, .okw-table-pager, .okw-auto-pager'))
        );

        let autoPager = null;
        let autoPage = 1;
        let autoPageSize = 25;
        let autoUpdating = false;

        if (!hasNativePager && anchor.parentNode) {
            autoPager = document.createElement('div');
            autoPager.className = 'okw-auto-pager';
            autoPager.style.display = 'none';
            if (anchor.nextSibling) anchor.parentNode.insertBefore(autoPager, anchor.nextSibling);
            else anchor.parentNode.appendChild(autoPager);
        }

        function applyAutoPagination() {
            if (!autoPager || autoUpdating) return;
            autoUpdating = true;
            try {
                const allTrs = Array.from(tbody.children).filter(el => el.tagName === 'TR');
                const dataRows = allTrs.filter(tr => {
                    if (tr.classList.contains('okw-sk-tr') || tr.classList.contains('okw-row-expand-detail')) return false;
                    if (tr.style.display === 'none') return false;
                    const cells = tr.querySelectorAll('td');
                    if (!cells.length || (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1)) return false;
                    return true;
                });
                if (dataRows.length === 0) {
                    allTrs.forEach(tr => tr.removeAttribute('data-okw-page-hidden'));
                    autoPager.style.display = 'none';
                    return;
                }
                const effSize = autoPageSize === 'all' ? dataRows.length : Number(autoPageSize || 25);
                const totalPages = Math.max(1, Math.ceil(dataRows.length / effSize));
                if (autoPage > totalPages) autoPage = totalPages;
                const start = (autoPage - 1) * effSize;
                const end = start + effSize;

                dataRows.forEach((tr, idx) => {
                    const hide = idx < start || idx >= end;
                    if (hide) {
                        tr.setAttribute('data-okw-page-hidden', '1');
                        const next = tr.nextElementSibling;
                        if (next && next.classList.contains('okw-row-expand-detail')) {
                            next.setAttribute('data-okw-page-hidden', '1');
                        }
                    } else {
                        tr.removeAttribute('data-okw-page-hidden');
                        const next = tr.nextElementSibling;
                        if (next && next.classList.contains('okw-row-expand-detail')) {
                            next.removeAttribute('data-okw-page-hidden');
                        }
                    }
                });

                autoPager.style.display = 'flex';
                const fromN = start + 1;
                const toN = Math.min(end, dataRows.length);
                autoPager.innerHTML = `
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <span>Showing ${fromN}–${toN} of ${dataRows.length}</span>
                        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;">
                            Rows:
                            <select data-ap-size class="okw-select" style="height:30px;padding:0 8px;font-size:12.5px;width:auto;">
                                <option value="25"${String(autoPageSize) === '25' ? ' selected' : ''}>25</option>
                                <option value="50"${String(autoPageSize) === '50' ? ' selected' : ''}>50</option>
                                <option value="100"${String(autoPageSize) === '100' ? ' selected' : ''}>100</option>
                                <option value="all"${String(autoPageSize) === 'all' ? ' selected' : ''}>All</option>
                            </select>
                        </label>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <button type="button" class="okw-btn okw-btn-outline" data-ap-prev style="height:32px;padding:0 12px;font-size:12.5px;" ${autoPage <= 1 ? 'disabled' : ''}>Prev</button>
                        <span style="font-size:12.5px;font-weight:600;color:var(--ink,#0f172a);">Page ${autoPage} / ${totalPages}</span>
                        <button type="button" class="okw-btn okw-btn-outline" data-ap-next style="height:32px;padding:0 12px;font-size:12.5px;" ${autoPage >= totalPages ? 'disabled' : ''}>Next</button>
                    </div>
                `;
                autoPager.querySelector('[data-ap-prev]').onclick = () => { if (autoPage > 1) { autoPage--; applyAutoPagination(); } };
                autoPager.querySelector('[data-ap-next]').onclick = () => { if (autoPage < totalPages) { autoPage++; applyAutoPagination(); } };
                const szSel = autoPager.querySelector('[data-ap-size]');
                if (szSel) szSel.onchange = () => { autoPageSize = szSel.value === 'all' ? 'all' : Number(szSel.value); autoPage = 1; applyAutoPagination(); };
            } finally {
                autoUpdating = false;
            }
        }

        function applyColumnVisibility() {
            const headCells = table.querySelectorAll('thead th');
            headCells.forEach((th, idx) => { th.style.display = hiddenIdx.has(idx) ? 'none' : ''; });
            tbody.querySelectorAll('tr').forEach(tr => {
                if (tr.classList.contains('okw-row-expand-detail')) return;
                const cells = tr.querySelectorAll('td');
                if (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1) return;
                tr.classList.add('okw-expandable-row');
                cells.forEach((td, idx) => { td.style.display = hiddenIdx.has(idx) ? 'none' : ''; });
            });
        }

        ensureRowExpandStyles();
        applyColumnVisibility();
        applyAutoPagination();
        if (!tbody.dataset.okwExpandBound) {
            tbody.dataset.okwExpandBound = '1';
            tbody.addEventListener('click', (e) => {
                if (table.dataset.okwCustomRowClick === '1' || tbody.dataset.okwCustomRowClick === '1') return;
                if (e.target.closest('button, a, input, select, textarea, label, details, summary, [role="menu"], [role="menuitem"], .dropdown, .dropdown-menu, [data-onclick], [onclick], .okw-row-expand-detail')) return;
                const tr = e.target.closest('tr');
                if (!tr || tr.parentNode !== tbody || tr.classList.contains('okw-row-expand-detail')) return;
                const cells = Array.from(tr.querySelectorAll('td'));
                if (!cells.length || (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1)) return;
                const clickedTd = e.target.closest('td');
                const headCells = Array.from(table.querySelectorAll('thead th'));
                if (clickedTd) {
                    const tdIdx = cells.indexOf(clickedTd);
                    const hdrLbl = headCells[tdIdx] ? headCells[tdIdx].textContent.replace(/[▲▼]/g, '').trim() : '';
                    if (/^(action|actions)$/i.test(hdrLbl) || /^(action|actions)$/i.test(String(clickedTd.getAttribute('data-label') || '').trim())) return;
                }
                const viewBtn = Array.from(tr.querySelectorAll('button')).find(b => /^(view|view details|view purchase|inspect)$/i.test((b.textContent || '').trim()) || /^view\b/i.test(String(b.getAttribute('title') || '').trim()));
                if (viewBtn) {
                    viewBtn.click();
                    return;
                }
                const fields = headCells
                    .map((th, idx) => {
                        const lbl = th.textContent.replace(/[▲▼]/g, '').trim();
                        if (!lbl || /^(action|actions|inspect)$/i.test(lbl)) return null;
                        const val = cells[idx] ? cells[idx].innerText.trim().replace(/\s+/g, ' ') : '';
                        return [lbl, val || '—'];
                    })
                    .filter(Boolean);
                if (!fields.length) return;
                openPrintableRecord({
                    title: resolveTableDocumentTitle(),
                    metaRows: fields
                });
            });
        }

        const obs = new MutationObserver(() => {
            if (!table.isConnected) { obs.disconnect(); return; }
            applyColumnVisibility();
            applyAutoPagination();
        });
        obs.observe(tbody, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

        const colBtn = bar.querySelector('[data-t-colbtn]');
        const colMenu = bar.querySelector('[data-t-colmenu]');
        colBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            colMenu.style.display = colMenu.style.display === 'none' ? 'block' : 'none';
        });
        colMenu.addEventListener('click', (e) => e.stopPropagation());
        if (!document.documentElement.dataset.okwColMenuClose) {
            document.documentElement.dataset.okwColMenuClose = '1';
            document.addEventListener('click', () => {
                document.querySelectorAll('[data-t-colmenu]').forEach(m => { m.style.display = 'none'; });
            });
        }
        colMenu.querySelectorAll('[data-t-colidx]').forEach(cb => {
            cb.addEventListener('change', () => {
                const idx = Number(cb.getAttribute('data-t-colidx'));
                if (cb.checked) hiddenIdx.delete(idx);
                else hiddenIdx.add(idx);
                applyColumnVisibility();
            });
        });

        function snapshotTableData() {
            const headCells = Array.from(table.querySelectorAll('thead th'));
            const activeIndices = headCells
                .map((th, idx) => ({ idx, label: th.textContent.replace(/[▲▼]/g, '').trim(), numeric: th.classList.contains('numeric') }))
                .filter(c => !hiddenIdx.has(c.idx) && !/^(action|actions)$/i.test(c.label));
            const cols = activeIndices.map(c => ({ key: `c${c.idx}`, label: c.label || `Col ${c.idx + 1}`, numeric: c.numeric }));
            const rows = [];
            tbody.querySelectorAll('tr').forEach(tr => {
                if (tr.style.display === 'none' || tr.classList.contains('okw-row-expand-detail')) return;
                const cells = Array.from(tr.querySelectorAll('td'));
                if (!cells.length || (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1)) return;
                const obj = {};
                for (const c of activeIndices) {
                    obj[`c${c.idx}`] = cells[c.idx] ? cells[c.idx].innerText.trim().replace(/\s+/g, ' ') : '';
                }
                rows.push(obj);
            });
            return { cols, rows };
        }

        bar.querySelector('[data-t-csv]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            const docTitle = resolveTableDocumentTitle();
            exportRowsToCsv(cols, rows, resolveFilename(docTitle));
        };
        bar.querySelector('[data-t-excel]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            const docTitle = resolveTableDocumentTitle();
            exportRowsToExcel(cols, rows, resolveFilename(docTitle), docTitle);
        };
        bar.querySelector('[data-t-print]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            printRowsList(cols, rows, resolveTableDocumentTitle(), 'portrait');
        };
        bar.querySelector('[data-t-pdf]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            const orient = bar.querySelector('[data-t-orient]')?.value || 'portrait';
            printRowsList(cols, rows, resolveTableDocumentTitle(), orient);
        };
    }

    function enhanceAllTables() {
        const path = (window.location.pathname || '').toLowerCase();
        if (/\/(pos|login|receipt|customer-display|forgot-password|reset-password)/.test(path)) return;
        document.querySelectorAll('.modal').forEach(m => {
            if (!m.getAttribute('role')) m.setAttribute('role', 'dialog');
            if (!m.getAttribute('aria-modal')) m.setAttribute('aria-modal', 'true');
        });
        // Auto-label icon-only buttons & unlabeled form controls for WCAG accessibility
        const iconLabels = {
            'fa-times': 'Close', 'fa-close': 'Close', 'fa-bars': 'Toggle Menu', 'fa-search': 'Search',
            'fa-sync': 'Refresh', 'fa-sync-alt': 'Refresh', 'fa-edit': 'Edit', 'fa-pen': 'Edit',
            'fa-trash': 'Delete', 'fa-trash-alt': 'Delete', 'fa-print': 'Print', 'fa-plus': 'Add',
            'fa-chevron-left': 'Previous', 'fa-chevron-right': 'Next', 'fa-sign-out-alt': 'Logout',
            'fa-eye': 'View', 'fa-download': 'Download', 'fa-camera': 'Scan Camera', 'fa-keyboard': 'Keyboard Mode'
        };
        document.querySelectorAll('button:not([aria-label])').forEach(btn => {
            if ((btn.textContent || '').trim()) return;
            const t = btn.getAttribute('title');
            if (t) { btn.setAttribute('aria-label', t); return; }
            const icon = btn.querySelector('i');
            if (icon) {
                for (const [cls, lbl] of Object.entries(iconLabels)) {
                    if (icon.classList.contains(cls)) { btn.setAttribute('aria-label', lbl); return; }
                }
            }
        });
        document.querySelectorAll('input:not([type="hidden"]):not([aria-label]):not([aria-labelledby]), select:not([aria-label]):not([aria-labelledby]), textarea:not([aria-label]):not([aria-labelledby])').forEach(ctrl => {
            if (ctrl.id && document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`)) return;
            const grp = ctrl.closest('.form-group, div');
            const lbl = grp ? grp.querySelector('label') : null;
            if (lbl && lbl.textContent.trim()) {
                ctrl.setAttribute('aria-label', lbl.textContent.replace(/\s+/g, ' ').trim());
            } else if (ctrl.placeholder) {
                ctrl.setAttribute('aria-label', ctrl.placeholder.trim());
            }
        });
        if (!document.documentElement.dataset.okwModalEscBound) {
            document.documentElement.dataset.okwModalEscBound = '1';
            document.addEventListener('keydown', (ev) => {
                const activeModal = document.getElementById('okw-printable-record-modal')
                    || Array.from(document.querySelectorAll('.modal.active')).pop();
                if (!activeModal) return;
                if (ev.key === 'Escape' && activeModal.classList.contains('modal')) {
                    activeModal.classList.remove('active');
                    return;
                }
                if (ev.key === 'Tab') {
                    const focusables = Array.from(activeModal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
                        .filter(el => el.offsetParent !== null);
                    if (!focusables.length) return;
                    const first = focusables[0];
                    const last = focusables[focusables.length - 1];
                    if (ev.shiftKey && document.activeElement === first) {
                        ev.preventDefault();
                        last.focus();
                    } else if (!ev.shiftKey && document.activeElement === last) {
                        ev.preventDefault();
                        first.focus();
                    }
                }
            });
        }
        document.querySelectorAll('table').forEach(tbl => {
            if (tbl.dataset.noTableTools === '1' || tbl.closest('#okw-printable-record-modal')) return;
            attachTableTools(tbl);
        });
    }

    if (typeof document !== 'undefined') {
        const runEnhance = () => {
            enhanceAllTables();
            let timer = null;
            const rootObs = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(enhanceAllTables, 150);
            });
            if (document.body) rootObs.observe(document.body, { childList: true, subtree: true });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runEnhance);
        else runEnhance();
    }

    function productTypeahead(inputOrSelector, onSelect) {
        const input = typeof inputOrSelector === 'string' ? document.querySelector(inputOrSelector) : inputOrSelector;
        if (!input || input.dataset.okwTypeahead === '1') return;
        input.dataset.okwTypeahead = '1';
        input.setAttribute('autocomplete', 'off');

        const menu = document.createElement('div');
        menu.className = 'okw-typeahead-menu';
        menu.style.cssText = 'display:none;position:fixed;min-width:280px;max-width:440px;max-height:280px;overflow-y:auto;background:var(--color-surface,#ffffff);color:var(--color-text,#0f172a);border:1px solid var(--color-border-strong,#cbd5e1);border-radius:8px;box-shadow:0 12px 30px rgba(15,23,42,0.16);z-index:10060;';
        document.body.appendChild(menu);

        let items = [];
        let activeIdx = -1;
        let timer = null;

        function positionMenu() {
            const r = input.getBoundingClientRect();
            menu.style.left = `${Math.max(8, r.left)}px`;
            menu.style.top = `${r.bottom + 4}px`;
            menu.style.width = `${Math.max(280, r.width)}px`;
        }

        function hide() {
            menu.style.display = 'none';
            activeIdx = -1;
        }

        function choose(prod) {
            if (!prod) return;
            input.value = prod.barcode || prod.name || '';
            input.dataset.selectedBarcode = prod.barcode || '';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            hide();
            if (typeof onSelect === 'function') onSelect(prod);
        }

        function renderList() {
            if (!items.length) {
                menu.innerHTML = `<div style="padding:10px 12px;font-size:12.5px;color:var(--color-text-muted,#64748b);">No matching products</div>`;
                positionMenu();
                menu.style.display = 'block';
                return;
            }
            menu.innerHTML = items.map((p, idx) => `
                <div data-ta-idx="${idx}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--color-border,#e2e8f0);background:${idx === activeIdx ? 'var(--color-primary-soft,#eef2ff)' : 'transparent'};">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                        <strong style="font-size:13px;">${escapeHtml(p.name)}</strong>
                        <span style="font-size:12px;font-weight:700;color:#273990;white-space:nowrap;">GH₵ ${Number(p.price || 0).toFixed(2)}</span>
                    </div>
                    <div style="font-size:11.5px;color:var(--color-text-muted,#64748b);margin-top:2px;">
                        Barcode: ${escapeHtml(p.barcode)} &bull; Stock: ${Number(p.stock || 0)} ${escapeHtml(p.selling_unit || 'Unit')}
                    </div>
                </div>
            `).join('');
            positionMenu();
            menu.style.display = 'block';
        }

        menu.addEventListener('pointerdown', (e) => {
            const row = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-ta-idx]') : null;
            if (!row) return;
            e.preventDefault();
            e.stopPropagation();
            choose(items[Number(row.getAttribute('data-ta-idx'))]);
        });
        menu.addEventListener('click', (e) => {
            const row = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-ta-idx]') : null;
            if (!row) return;
            e.preventDefault();
            e.stopPropagation();
            choose(items[Number(row.getAttribute('data-ta-idx'))]);
        });

        async function search(q) {
            const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token');
            try {
                const res = await fetch(`/api/pos/search?q=${encodeURIComponent(q)}&limit=8`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                    credentials: 'include'
                });
                const d = await res.json().catch(() => ({}));
                items = Array.isArray(d.products) ? d.products : [];
                activeIdx = items.length ? 0 : -1;
                renderList();
            } catch (_) {
                hide();
            }
        }

        input.addEventListener('input', () => {
            delete input.dataset.selectedBarcode;
            const q = input.value.trim();
            clearTimeout(timer);
            if (!q) { hide(); return; }
            timer = setTimeout(() => search(q), 160);
        });

        input.addEventListener('keydown', (e) => {
            if (menu.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (items.length) { activeIdx = (activeIdx + 1) % items.length; renderList(); }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (items.length) { activeIdx = (activeIdx - 1 + items.length) % items.length; renderList(); }
            } else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
                e.preventDefault();
                choose(items[activeIdx]);
            } else if (e.key === 'Escape') {
                hide();
            }
        });

        input.addEventListener('blur', () => setTimeout(() => {
            if (!menu.matches(':hover')) hide();
        }, 180));
        window.addEventListener('scroll', (e) => {
            if (menu.style.display === 'none') return;
            if (e.target === menu || menu.contains(e.target)) return;
            positionMenu();
        }, true);
    }

    // Report endpoints return `warnings` when a query failed. Say so, instead of showing an
    // empty table that looks like "no data". Returns true when a warning was shown.
    function warnIfPartial(data) {
        const list = data && Array.isArray(data.warnings) ? data.warnings : [];
        if (!list.length) return false;
        toast(`Some figures could not be loaded (${list.length} database ${list.length === 1 ? 'query' : 'queries'} failed). Totals may be incomplete. Ask your administrator to check the server log.`, 'warning', 9000);
        return true;
    }

    /**
     * Section page: open, unboxed workspace shell (no iframes).
     * Layout order:
     *   1. Page heading (.okw-hub-head)
     *   2. Top KPI strip (.okw-hub-kpis — optional, populated via ctx.kpis)
     *   3. Right-aligned action & filter toolbar (.okw-hub-bar — shown only when populated)
     *   4. Open content workspace (.okw-hub-panel)
     */
    function sectionPage({ mount, title, subtitle = '', sections = [], defaultId } = {}) {
        const root = typeof mount === 'string' ? document.querySelector(mount) : mount;
        if (!root) return null;

        let role = '';
        try {
            const raw = localStorage.getItem('currentUser') || localStorage.getItem('companyUser') || localStorage.getItem('user') || '{}';
            role = String((JSON.parse(raw) || {}).role || '').toLowerCase();
        }
        catch (_) { role = ''; }
        const allowed = sections.filter(s => !s.roles || s.roles.includes(role));
        if (!allowed.length) {
            root.innerHTML = '<div class="okw-card">You do not have access to any section of this page.</div>';
            return null;
        }

        const ids = allowed.map(s => s.id);
        const fromUrl = new URLSearchParams(window.location.search).get('tab');
        let current = ids.includes(fromUrl) ? fromUrl : (ids.includes(defaultId) ? defaultId : ids[0]);

        root.innerHTML = `
            <div class="okw-hub-head">
                <div>
                    <h1>${escapeHtml(title)}</h1>
                    ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
                </div>
            </div>
            <div class="okw-hub-kpis" style="display:none;"></div>
            <div class="okw-hub-bar" style="display:none;">
                <div class="okw-hub-toolbar"></div>
            </div>
            <div class="okw-hub-panel"><div class="okw-hub-render">Loading...</div></div>
        `;

        const head = root.querySelector('.okw-hub-head');
        const headTitle = head ? head.querySelector('h1') : null;
        const kpis = root.querySelector('.okw-hub-kpis');
        const bar = root.querySelector('.okw-hub-bar');
        const toolbar = root.querySelector('.okw-hub-toolbar');
        const panel = root.querySelector('.okw-hub-render');

        function syncBarVisibility() {
            if (bar) {
                const hasControls = toolbar.children.length > 0 || toolbar.textContent.trim().length > 0;
                bar.style.display = hasControls ? '' : 'none';
            }
            if (kpis) {
                const hasKpis = kpis.children.length > 0 || kpis.textContent.trim().length > 0;
                kpis.style.display = hasKpis ? '' : 'none';
            }
        }

        let shown = null;
        async function show(id) {
            const section = allowed.find(s => s.id === id) || allowed[0];
            if (shown && shown !== section && typeof shown.leave === 'function') {
                try { shown.leave(); } catch (_) { /* never block navigation */ }
            }
            shown = section;
            current = section.id;
            if (section.embed) {
                window.location.replace(section.embed);
                return;
            }
            if (headTitle && section.label) headTitle.textContent = section.label;
            const topTitle = document.querySelector('.okw-topbar-title');
            if (topTitle && section.label && !new URLSearchParams(window.location.search).get('report') && !new URLSearchParams(window.location.search).get('view')) {
                topTitle.textContent = section.label;
            }
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('tab', current);
                window.history.replaceState(null, '', url);
            } catch (_) { /* history is a nicety, never required */ }
            toolbar.innerHTML = '';
            kpis.innerHTML = '';
            syncBarVisibility();
            try {
                panel.innerHTML = 'Loading...';
                await section.render(panel, { toolbar, kpis, show, current, syncBarVisibility });
                syncBarVisibility();
            } catch (err) {
                panel.innerHTML = '<div>This section could not be loaded.</div>';
                toast((err && err.message) || 'This section could not be loaded.', 'danger');
            }
        }

        show(current);
        return { show, get current() { return current; } };
    }

    global.OkwUI = {
        escapeHtml,
        toast,
        confirm,
        badge,
        kpiCard,
        dateRangePicker,
        filterDropdown,
        getCompanyProfile,
        getCompanyProfileAsync,
        exportRowsToExcel,
        exportRowsToCsv,
        printRowsList,
        attachTableTools,
        enhanceAllTables,
        productTypeahead,
        dataTable,
        openPrintableRecord,
        formatAuditSummary,
        openAuditDetailModal,
        warnIfPartial,
        sectionPage
    };
})(window);

