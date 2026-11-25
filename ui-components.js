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

    function getCompanyProfile() {
        if (!_companyProfileCache) {
            try {
                const raw = JSON.parse(localStorage.getItem('posSettings') || '{}');
                _companyProfileCache = {
                    name: raw.store_name || 'OKWESIWA CO LTD',
                    address: raw.address || '',
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
                fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
                    .then(r => r.ok ? r.json() : null)
                    .then(s => {
                        if (!s || typeof s !== 'object') return;
                        _companyProfileCache = {
                            name: s.store_name || _companyProfileCache.name || 'OKWESIWA CO LTD',
                            address: s.address || _companyProfileCache.address || '',
                            phone: s.phone || _companyProfileCache.phone || '',
                            email: s.email || _companyProfileCache.email || '',
                            taxId: s.tax_id || _companyProfileCache.taxId || '',
                            logoUrl: s.logo_url || _companyProfileCache.logoUrl || '/okwesiwa-logo.svg'
                        };
                        try {
                            const prev = JSON.parse(localStorage.getItem('posSettings') || '{}');
                            localStorage.setItem('posSettings', JSON.stringify({ ...prev, ...s }));
                        } catch (_) {}
                    })
                    .catch(() => {});
            }
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
        const detailsLine = formatCompanyDetailsLine(profile);
        const pageOrient = orientation === 'landscape' ? 'landscape' : 'portrait';
        const printableCols = columns.filter(c => !/^(action|receipt)$/i.test(String(c.label || '').trim()) || typeof c.exportValue === 'function');
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
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 16px; }
            .hdr { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 3px solid #273990; padding-bottom: 12px; margin-bottom: 16px; }
            .brand-wrap { display: flex; align-items: center; gap: 12px; }
            .brand-logo { height: 44px; max-width: 140px; object-fit: contain; }
            .brand-name { font-size: 18px; font-weight: 800; color: #273990; margin: 0 0 2px; letter-spacing: 0.02em; }
            .brand-details { font-size: 11px; color: #475569; margin: 0; }
            .report-meta { text-align: right; }
            .report-title { font-size: 15px; font-weight: 700; color: #0f172a; margin: 0 0 3px; }
            .meta { font-size: 11px; color: #64748b; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border-bottom: 1px solid #e2e8f0; padding: 7px 8px; }
            th { background: #f8fafc; color: #334155; font-weight: 600; text-transform: uppercase; font-size: 11px; }
        </style></head><body>
            <div class="hdr">
                <div class="brand-wrap">
                    <img class="brand-logo" src="${escapeHtml(profile.logoUrl)}" alt="${escapeHtml(profile.name)}">
                    <div>
                        <p class="brand-name">${escapeHtml(profile.name)}</p>
                        ${detailsLine ? `<p class="brand-details">${escapeHtml(detailsLine)}</p>` : ''}
                    </div>
                </div>
                <div class="report-meta">
                    <p class="report-title">${escapeHtml(title)}</p>
                    <span class="meta">${rows.length} item(s) &bull; ${escapeHtml(new Date().toLocaleString())}</span>
                </div>
            </div>
            <table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
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
        const profile = await getCompanyProfile();
        const fmtC = (n) => (typeof window.formatCurrency === 'function'
            ? window.formatCurrency(n)
            : 'GH₵ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

        const {
            title = 'Document Details',
            refNumber = '',
            date = new Date().toLocaleString(),
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
            notes = ''
        } = opts;

        const detailsLine = [profile.address, profile.phone, profile.email].filter(Boolean).join('  •  ');
        const allMeta = [
            ...(refNumber ? [['Reference #', refNumber]] : []),
            ...(date ? [['Date', date]] : []),
            ...(partyName ? [[partyLabel || 'Name', partyName]] : []),
            ...(branch ? [['Branch', branch]] : []),
            ...(status ? [['Status', status]] : []),
            ...(paymentStatus ? [['Payment Status', paymentStatus]] : []),
            ...metaRows
        ];

        const itemsHtml = items.length ? `
            <div style="margin-top:16px;">
                <table class="okw-table" style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Item</th>
                            <th>Barcode</th>
                            <th class="okw-num">Qty</th>
                            <th class="okw-num">Unit Price / Cost</th>
                            <th class="okw-num">Total</th>
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
                </table>
            </div>` : '';

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
                <table style="min-width:280px;border-collapse:collapse;font-size:13px;">
                    ${totalRows.map(([k, v, bold]) => `
                        <tr style="${bold ? 'border-top:2px solid #1e293b;font-size:15px;font-weight:700;' : 'border-bottom:1px solid #e2e8f0;'}">
                            <td style="padding:6px 10px;color:${bold ? 'inherit' : 'var(--color-text-muted,#64748b)'};">${escapeHtml(k)}</td>
                            <td style="padding:6px 10px;text-align:right;font-weight:${bold ? '700' : '600'};">${escapeHtml(v)}</td>
                        </tr>`).join('')}
                </table>
            </div>` : '';

        const bodyHtml = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #273990;padding-bottom:12px;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <img src="${escapeHtml(profile.logoUrl)}" alt="${escapeHtml(profile.name)}" style="height:40px;max-width:110px;object-fit:contain;" onerror="this.style.display='none'">
                    <div>
                        <div style="font-size:16px;font-weight:700;color:#273990;">${escapeHtml(profile.name)}</div>
                        ${detailsLine ? `<div style="font-size:11.5px;color:var(--color-text-muted,#64748b);margin-top:2px;">${escapeHtml(detailsLine)}</div>` : ''}
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:16px;font-weight:700;">${escapeHtml(title)}</div>
                    ${refNumber ? `<div style="font-size:12px;color:var(--color-text-muted,#64748b);margin-top:2px;">${escapeHtml(refNumber)}</div>` : ''}
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 14px;padding:12px 14px;border-radius:8px;background:var(--color-surface-muted,#f8fafc);border:1px solid var(--color-border,#e2e8f0);font-size:13px;">
                ${allMeta.map(([k, v]) => `<div><div style="font-size:11px;text-transform:uppercase;color:var(--color-text-muted,#64748b);font-weight:600;">${escapeHtml(k)}</div><div style="font-weight:600;margin-top:2px;">${escapeHtml(v)}</div></div>`).join('')}
            </div>
            ${itemsHtml}
            ${totalsHtml}
            ${notes ? `<div style="margin-top:14px;padding:10px 12px;border-radius:8px;background:var(--color-surface-muted,#f8fafc);border:1px solid var(--color-border,#e2e8f0);font-size:12.5px;"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
        `;

        const backdrop = document.createElement('div');
        backdrop.id = 'okw-printable-record-modal';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.62);z-index:10060;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="okw-card" style="width:100%;max-width:820px;max-height:90vh;overflow-y:auto;padding:22px 26px;box-shadow:0 20px 50px rgba(0,0,0,0.3);">
                <div id="okw-print-record-body">${bodyHtml}</div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--color-border,#e2e8f0);">
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-pr-close">Close</button>
                    <button type="button" class="okw-btn okw-btn-primary" id="okw-pr-print">Print Form</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.querySelector('#okw-pr-close').onclick = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
        backdrop.querySelector('#okw-pr-print').onclick = () => {
            const printDoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
                @page{size:A4 portrait;margin:14mm;}
                body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#0f172a;margin:0;padding:0;font-size:12.5px;}
                table{width:100%;border-collapse:collapse;}
                th,td{padding:7px 8px;border-bottom:1px solid #cbd5e1;text-align:left;}
                th{background:#f1f5f9;font-size:11px;text-transform:uppercase;color:#334155;}
                .okw-num{text-align:right;}
                .sig-row{display:flex;justify-content:space-between;margin-top:36px;font-size:11.5px;color:#475569;}
                .sig-box{width:42%;border-top:1px solid #94a3b8;padding-top:6px;}
            </style></head><body>${bodyHtml}<div class="sig-row"><div class="sig-box">Prepared By / Signature</div><div class="sig-box">Approved / Received By</div></div></body></html>`;
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
            theadRow.innerHTML = visCols.map(c => `<th data-sort="${escapeHtml(c.key)}" class="${c.numeric ? 'numeric' : ''}" style="cursor:pointer;">${escapeHtml(c.label)}</th>`).join('');
            theadRow.querySelectorAll('th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    const key = th.dataset.sort;
                    if (sortKey === key) sortDir *= -1;
                    else { sortKey = key; sortDir = 1; }
                    render();
                });
            });

            const filtered = getFiltered();
            const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
            if (page > totalPages) page = totalPages;
            const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

            if (!visCols.length) {
                tbody.innerHTML = `<tr><td style="text-align:center;padding:28px;color:var(--color-text-muted);">No columns selected.</td></tr>`;
            } else if (slice.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${visCols.length}" style="text-align:center;padding:28px;color:var(--color-text-muted);">${escapeHtml(emptyText)}</td></tr>`;
            } else {
                tbody.innerHTML = slice.map((r, rIdx) => `<tr data-row-idx="${rIdx}" style="cursor:pointer;">${visCols.map(c => {
                    const content = typeof c.render === 'function' ? c.render(r[c.key], r) : escapeHtml(r[c.key] ?? '');
                    return `<td class="${c.numeric ? 'numeric' : ''}">${content}</td>`;
                }).join('')}</tr>`).join('');
                tbody.querySelectorAll('tr[data-row-idx]').forEach(tr => {
                    tr.addEventListener('click', (e) => {
                        if (e.target.closest('button, a, input, select, label, details')) return;
                        const row = slice[Number(tr.dataset.rowIdx)];
                        if (!row) return;
                        if (typeof opts.onRowClick === 'function') {
                            opts.onRowClick(row);
                        } else if (opts.printableRow !== false) {
                            const metaRows = visCols
                                .filter(c => !/^(action|actions|inspect)$/i.test(String(c.label || '').trim()))
                                .map(c => {
                                    const rawVal = typeof c.exportValue === 'function'
                                        ? c.exportValue(row)
                                        : (row[c.key] ?? '');
                                    return [c.label, String(rawVal)];
                                });
                            openPrintableRecord({
                                title: getTitle(),
                                metaRows
                            });
                        }
                    });
                });
            }
            pager.innerHTML = `
                <span>Showing ${slice.length} of ${filtered.length}</span>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button type="button" class="okw-btn okw-btn-outline" data-prev ${page <= 1 ? 'disabled' : ''}>Prev</button>
                    <span>Page ${page} / ${totalPages}</span>
                    <button type="button" class="okw-btn okw-btn-outline" data-next ${page >= totalPages ? 'disabled' : ''}>Next</button>
                </div>
            `;
            pager.querySelector('[data-prev]').onclick = () => { if (page > 1) { page--; render(); } };
            pager.querySelector('[data-next]').onclick = () => { if (page < totalPages) { page++; render(); } };
        }

        searchIn.addEventListener('input', () => { query = searchIn.value; page = 1; render(); });

        colBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            colMenu.style.display = colMenu.style.display === 'none' ? 'block' : 'none';
        });
        colMenu.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { colMenu.style.display = 'none'; });
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
        const pageTitle = opts.title || (document.title || 'Report').replace(/OKWESIWA CO LTD\s*\|\s*/i, '').replace(/\s*-\s*OKWESIWA CO LTD/i, '').trim() || 'Report';
        const baseSlug = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
        const filename = opts.filename || `okwesiwa-${baseSlug}.xlsx`;

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

        function applyColumnVisibility() {
            const headCells = table.querySelectorAll('thead th');
            headCells.forEach((th, idx) => { th.style.display = hiddenIdx.has(idx) ? 'none' : ''; });
            tbody.querySelectorAll('tr').forEach(tr => {
                const cells = tr.querySelectorAll('td');
                if (cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1) return;
                cells.forEach((td, idx) => { td.style.display = hiddenIdx.has(idx) ? 'none' : ''; });
            });
        }

        const obs = new MutationObserver(() => applyColumnVisibility());
        obs.observe(tbody, { childList: true });

        const colBtn = bar.querySelector('[data-t-colbtn]');
        const colMenu = bar.querySelector('[data-t-colmenu]');
        colBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            colMenu.style.display = colMenu.style.display === 'none' ? 'block' : 'none';
        });
        colMenu.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { colMenu.style.display = 'none'; });
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
                .map((th, idx) => ({ idx, label: th.textContent.trim(), numeric: th.classList.contains('numeric') }))
                .filter(c => !hiddenIdx.has(c.idx) && !/^(action|actions)$/i.test(c.label));
            const cols = activeIndices.map(c => ({ key: `c${c.idx}`, label: c.label || `Col ${c.idx + 1}`, numeric: c.numeric }));
            const rows = [];
            tbody.querySelectorAll('tr').forEach(tr => {
                if (tr.style.display === 'none') return;
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
            exportRowsToCsv(cols, rows, filename);
        };
        bar.querySelector('[data-t-excel]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            exportRowsToExcel(cols, rows, filename, pageTitle);
        };
        bar.querySelector('[data-t-print]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            printRowsList(cols, rows, pageTitle, 'portrait');
        };
        bar.querySelector('[data-t-pdf]').onclick = () => {
            const { cols, rows } = snapshotTableData();
            const orient = bar.querySelector('[data-t-orient]')?.value || 'portrait';
            printRowsList(cols, rows, pageTitle, orient);
        };
    }

    function enhanceAllTables() {
        const path = (window.location.pathname || '').toLowerCase();
        if (/\/(pos|login|receipt|customer-display|forgot-password|reset-password)/.test(path)) return;
        document.querySelectorAll('table').forEach(tbl => {
            if (tbl.dataset.noTableTools === '1') return;
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
        exportRowsToExcel,
        attachTableTools,
        enhanceAllTables,
        productTypeahead,
        dataTable,
        openPrintableRecord,
        warnIfPartial,
        sectionPage
    };
})(window);

