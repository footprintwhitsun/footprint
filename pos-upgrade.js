/* ==========================================================================
   OKWESIWA CO LTD POS — Phase 2 Till Upgrade (pos-upgrade.js)
   Clean uncrowded POS workspace:
   - True isolated multi-tab sale sheets (Sale 1..5 + "+ Tab")
   - Collapsible product search dropdown (collapsed until user types; no Camera button)
   - Compact single-row customer selector & optional delivery drawer
   - Multiple / Split Payment modal wired to the "Split" payment button
   - Dedicated POS views for Quotes, Discounts, and Splits history
   ========================================================================== */
(function (global) {
    'use strict';

    const token = () => localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });
    const fmt = (n) => 'GH₵ ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const MAX_TABS = 5;
    let tabs = [createEmptyTab(1)];
    let activeTabId = 1;
    let nextTabSeq = 2;
    let isSwitchingTabs = false;
    let currentView = 'till'; // 'till' | 'quotes' | 'discounts' | 'splits'

    const posViewCache = { quotes: null, discounts: null, splits: null };
    function readCachedView(key) {
        if (posViewCache[key]) return posViewCache[key];
        try {
            const raw = sessionStorage.getItem('okw_pos_cache_' + key);
            if (raw) {
                posViewCache[key] = JSON.parse(raw);
                return posViewCache[key];
            }
        } catch (_) {}
        return null;
    }
    function writeCachedView(key, data) {
        posViewCache[key] = data;
        try { sessionStorage.setItem('okw_pos_cache_' + key, JSON.stringify(data)); } catch (_) {}
    }
    async function fetchActivityData(key, url) {
        const res = await fetch(url, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok) writeCachedView(key, data);
        return data;
    }
    function prefetchPosViews() {
        if (!token()) return;
        setTimeout(() => {
            fetchActivityData('quotes', '/api/pos/quotations').catch(() => {});
            fetchActivityData('discounts', '/api/pos/discounts-history').catch(() => {});
            fetchActivityData('splits', '/api/pos/splits-history').catch(() => {});
        }, 400);
    }

    function createEmptyTab(id) {
        return {
            id,
            label: `Sale ${id}`,
            customer: null,
            priceGroup: 'retail',
            items: [],
            discountAmount: 0,
            discountRate: 0,
            promoCode: null,
            discountApprovedBy: null,
            approvalToken: null,
            quotationId: null,
            delivery: { enabled: false, site_address: '', truck: '', driver: '', fee: 0 }
        };
    }

    window.okwAdvancedCartCount = () => 0;

    function activeTab() {
        return tabs.find(t => t.id === activeTabId) || tabs[0];
    }

    // Save pos.html's live cart & discount state into the currently active tab
    function syncTabFromTillCart() {
        const t = activeTab();
        if (!t) return t;
        if (typeof window.okwGetTillState === 'function') {
            const st = window.okwGetTillState();
            t.items = (st.items || []).map(it => ({
                id: it.id || (it.rawProduct && it.rawProduct.id) || it.barcode,
                barcode: it.barcode,
                name: it.name,
                qty: Number(it.qty || 1),
                unit_name: it.unit_name || it.selling_unit || 'Unit',
                base_unit: it.base_unit || it.selling_unit || 'Unit',
                unit_factor: Number(it.unit_factor || 1),
                available_units: Array.isArray(it.available_units) ? it.available_units : [],
                price: Number(it.price || 0),
                promoCode: it.promoCode,
                promoType: it.promoType,
                promoValue: it.promoValue,
                rawProduct: it.rawProduct || it
            }));
            t.discountRate = Number(st.discountRate || 0);
            t.discountAmount = Number(st.flatDiscount || 0);
            t.promoCode = st.promoCode || null;
        } else if (typeof window.okwGetCart === 'function') {
            const tillCart = window.okwGetCart() || [];
            t.items = tillCart.map(it => ({
                id: it.id || (it.rawProduct && it.rawProduct.id) || it.barcode,
                barcode: it.barcode,
                name: it.name,
                qty: Number(it.qty || 1),
                unit_name: it.unit_name || it.selling_unit || 'Unit',
                base_unit: it.base_unit || it.selling_unit || 'Unit',
                unit_factor: Number(it.unit_factor || 1),
                available_units: Array.isArray(it.available_units) ? it.available_units : [],
                price: Number(it.price || 0),
                rawProduct: it.rawProduct || it
            }));
        }
        return t;
    }

    // Load a tab's state into pos.html's Current Sale sheet
    function pushTabStateToTill(tab) {
        const t = tab || activeTab();
        isSwitchingTabs = true;
        try {
            const mappedItems = (t.items || []).map(it => ({
                id: it.id || (it.rawProduct && it.rawProduct.id) || it.barcode,
                barcode: it.barcode,
                name: it.name,
                price: Number(it.price || 0),
                qty: Number(it.qty || 1),
                selling_unit: it.unit_name || it.selling_unit || 'Unit',
                unit_name: it.unit_name || it.selling_unit || 'Unit',
                unit_factor: Number(it.unit_factor || 1),
                stock: (it.rawProduct && it.rawProduct.stock) ?? it.stock ?? 0,
                promoCode: it.promoCode,
                promoType: it.promoType,
                promoValue: it.promoValue,
                rawProduct: it.rawProduct || it
            }));
            if (typeof window.okwSetTillState === 'function') {
                window.okwSetTillState({
                    items: mappedItems,
                    discountRate: Number(t.discountRate || 0),
                    flatDiscount: Number(t.discountAmount || 0),
                    promoCode: t.promoCode || null
                });
            } else if (typeof window.okwSetCart === 'function') {
                window.okwSetCart(mappedItems);
            }
        } finally {
            isSwitchingTabs = false;
        }
    }

    function pushItemsToTillCart(items) {
        const t = activeTab();
        t.items = Array.isArray(items) ? items : [];
        pushTabStateToTill(t);
    }

    // Hook called by pos.html whenever renderCart() runs so tab counts stay in sync
    window.okwOnTillCartChange = function () {
        if (isSwitchingTabs) return;
        syncTabFromTillCart();
        renderTabs();
    };

    function getUserRole() {
        try {
            const u = JSON.parse(localStorage.getItem('currentUser') || localStorage.getItem('user') || sessionStorage.getItem('user') || '{}');
            return (u.role || 'cashier').toLowerCase();
        } catch (e) { return 'cashier'; }
    }

    function resolveUnitPrice(product, priceGroup, unitFactor, qty) {
        let basePrice = Number(product.price || 0);
        const pg = product.price_groups || {};
        if (priceGroup === 'contractor' && Number(pg.contractor) > 0) basePrice = Number(pg.contractor);
        else if (priceGroup === 'wholesale' && Number(pg.wholesale) > 0) basePrice = Number(pg.wholesale);
        else if (priceGroup === 'retail' && Number(pg.retail) > 0) basePrice = Number(pg.retail);

        const breaks = Array.isArray(product.quantity_breaks) ? product.quantity_breaks : [];
        let bestBreak = null;
        for (const br of breaks) {
            if (Number(qty) >= Number(br.min_qty || 0) && Number(br.price) > 0) {
                if (!bestBreak || Number(br.min_qty) > Number(bestBreak.min_qty)) bestBreak = br;
            }
        }
        if (bestBreak) basePrice = Number(bestBreak.price);
        return Number((basePrice * Number(unitFactor || 1)).toFixed(2));
    }

    function stockBadgeHtml(product) {
        const stock = Number(product.stock || 0);
        const reorder = Number(product.reorder_level || 10);
        const tone = stock <= 0 ? 'danger' : (stock <= reorder ? 'warning' : 'success');
        const label = `${stock} ${product.selling_unit || 'Unit'}`;
        return `<button type="button" class="okw-badge okw-badge-${tone}" data-stock-loc="${product.barcode}" title="Tap to view stock in all locations" style="border:none;cursor:pointer;">${label}</button>`;
    }

    function showLocationsModal(product) {
        const levels = product.stock_levels && typeof product.stock_levels === 'object' ? product.stock_levels : {};
        const entries = Object.entries(levels);
        const summary = entries.length
            ? entries.map(([loc, qty]) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-border);"><span>${OkwUI.escapeHtml(loc)}</span><strong class="mono">${qty} ${OkwUI.escapeHtml(product.selling_unit || '')}</strong></div>`).join('')
            : `<div style="padding:12px 0;color:var(--color-text-muted);">Total on hand: <strong>${product.stock}</strong> ${OkwUI.escapeHtml(product.selling_unit || '')}</div>`;

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.6);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `
            <div class="okw-card" style="max-width:420px;width:100%;">
                <h3 style="margin:0 0 6px;">Stock by Location</h3>
                <div style="font-size:13px;color:var(--color-text-muted);margin-bottom:12px;">${OkwUI.escapeHtml(product.name)} ${product.brand ? '· ' + OkwUI.escapeHtml(product.brand) : ''}</div>
                ${summary}
                <div style="margin-top:16px;text-align:right;">
                    <button type="button" class="okw-btn okw-btn-primary" data-close>Close</button>
                </div>
            </div>
        `;
        modal.querySelector('[data-close]').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
    }

    function collapseSearchResults() {
        const box = document.getElementById('okw-search-results');
        if (box) {
            box.style.display = 'none';
            box.innerHTML = '';
        }
    }

    function mountUpgradeBar() {
        if (document.getElementById('okw-pos-upgrade-shell')) return;
        const posLayout = document.querySelector('.pos-layout');
        const cartSection = document.querySelector('.cart-section');
        const host = posLayout || document.querySelector('.pos-container') || document.querySelector('.main-content') || document.body;

        const shell = document.createElement('section');
        shell.id = 'okw-pos-upgrade-shell';
        shell.className = 'okw-card';
        shell.style.cssText = 'margin:0 0 12px 0;padding:12px 14px;background:var(--sheet, #ffffff) !important;border:1px solid var(--edge, #e2e8f0) !important;border-radius:12px !important;color:var(--ink, #0f172a);';
        shell.innerHTML = `
            <!-- Row 1: Sale Tabs on left, Quick Tools on right -->
            <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
                <div id="okw-pos-tabs" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;"></div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-hold" style="padding:5px 11px;min-height:30px;font-size:12.5px;" title="Park current sale (F8)">Hold</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-holds" style="padding:5px 11px;min-height:30px;font-size:12.5px;" title="View held sales">Held</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-quote" style="padding:5px 11px;min-height:30px;font-size:12.5px;" title="Save current cart as a quotation">+ Quote</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-discount" style="padding:5px 11px;min-height:30px;font-size:12.5px;" title="Apply discount (F6)">Discount</button>
                    <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:12.5px;font-weight:500;padding:4px 10px;border-radius:8px;border:1px solid var(--edge-strong, #cbd5e1);background:var(--sheet-2, #ffffff);color:var(--ink, #0f172a);min-height:30px;">
                        <input type="checkbox" id="okw-delivery-toggle" style="margin:0;"> Delivery
                    </label>
                </div>
            </div>

            <!-- Row 2: Product Search (Left) + Compact Customer Bar (Right) -->
            <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:10px;align-items:start;" id="okw-pos-grid">
                <!-- Left: Search + Price Tier + Receipt + Sync + Collapsible Results Overlay -->
                <div style="position:relative;" id="okw-search-container">
                    <div style="display:flex;flex-wrap:nowrap;gap:6px;align-items:center;">
                        <input type="search" id="okw-pos-search" aria-label="Search item or barcode" class="okw-input" placeholder="Search product or scan barcode…" style="flex:1;min-width:160px;height:38px;">
                        <button type="button" class="pos-btn-action" data-onclick="if(window.openReceiptSearch)openReceiptSearch()" title="Find Receipt" style="height:38px;padding:0 12px;font-size:12.5px;"><i class="fas fa-receipt"></i> <span>Receipt</span></button>
                        <button type="button" class="pos-btn-action" id="refreshProducts" title="Sync Catalog" style="height:38px;padding:0 12px;font-size:12.5px;"><i class="fas fa-sync-alt"></i> <span>Sync</span></button>
                    </div>
                    <!-- Collapsible dropdown: hidden by default until user types -->
                    <div id="okw-search-results" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:1200;max-height:260px;overflow-y:auto;background:var(--sheet, #ffffff);color:var(--ink, #0f172a);border:1px solid var(--edge-strong, #cbd5e1);border-radius:10px;box-shadow:0 10px 25px rgba(15,23,42,0.2);"></div>
                </div>

                <!-- Right: Single-line Customer Selector + Active Chip -->
                <div style="position:relative;display:flex;flex-direction:column;gap:6px;" id="okw-cust-container">
                    <div style="display:flex;gap:6px;align-items:center;">
                        <input type="search" id="okw-cust-search" aria-label="Customer" class="okw-input" placeholder="Customer name or phone…" style="flex:1;height:38px;">
                        <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-new-cust" style="height:38px;padding:0 12px;white-space:nowrap;">+ Add</button>
                        <div id="okw-cust-chip" style="display:inline-flex;align-items:center;padding:0 10px;height:38px;border-radius:8px;background:var(--sheet-2, #f8fafc);color:var(--ink, #0f172a);border:1px solid var(--edge, #e2e8f0);font-size:12.5px;white-space:nowrap;"></div>
                    </div>
                    <div id="okw-cust-results" style="display:none;position:absolute;top:42px;left:0;right:0;z-index:1200;max-height:180px;overflow-y:auto;border:1px solid var(--edge-strong, #cbd5e1);border-radius:8px;background:var(--sheet, #ffffff);color:var(--ink, #0f172a);box-shadow:0 8px 20px rgba(15,23,42,0.2);"></div>
                </div>
            </div>

            <!-- Optional Delivery Drawer (only visible when Delivery is checked) -->
            <div id="okw-delivery-box" style="display:none;grid-template-columns:repeat(4, 1fr);gap:8px;margin-top:10px;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                <input type="text" id="okw-del-site" class="okw-input" placeholder="Site / Delivery Address">
                <input type="text" id="okw-del-truck" class="okw-input" placeholder="Truck / Vehicle #">
                <input type="text" id="okw-del-driver" class="okw-input" placeholder="Driver Name">
                <input type="number" id="okw-del-fee" class="okw-input" placeholder="Delivery Fee (GH₵)" min="0" step="0.01">
            </div>
        `;

        if (posLayout && cartSection) {
            posLayout.insertBefore(shell, cartSection);
        } else {
            host.insertBefore(shell, host.firstChild);
        }

        // Create dedicated POS Activity View container (for Quotes, Discounts, Splits pages)
        if (posLayout && !document.getElementById('okw-pos-activity-view')) {
            const actView = document.createElement('section');
            actView.id = 'okw-pos-activity-view';
            actView.style.cssText = 'display:none;';
            posLayout.appendChild(actView);
        }

        bindEvents();
        renderAll();

        // Check URL query param ?view=quotes|discounts|splits
        const params = new URLSearchParams(window.location.search);
        const initialView = (params.get('view') || '').toLowerCase();
        if (['quotes', 'discounts', 'splits'].includes(initialView)) {
            switchPosView(initialView);
        }
        prefetchPosViews();
    }

    function renderTabs() {
        const el = document.getElementById('okw-pos-tabs');
        if (!el) return;
        el.innerHTML = tabs.map(t => {
            const count = (t.items || []).reduce((sum, i) => sum + Number(i.qty || 1), 0);
            const active = t.id === activeTabId;
            return `
                <button type="button" class="okw-btn ${active ? 'okw-btn-primary' : 'okw-btn-outline'}" data-tab="${t.id}" style="padding:5px 12px;min-height:30px;font-size:12.5px;">
                    <span>${OkwUI.escapeHtml(t.label)} (${ (t.items || []).length })</span>
                    ${tabs.length > 1 ? `<span data-close-tab="${t.id}" title="Close ${OkwUI.escapeHtml(t.label)}" style="margin-left:6px;opacity:0.85;font-weight:700;">&times;</span>` : ''}
                </button>
            `;
        }).join('') + (tabs.length < MAX_TABS ? `<button type="button" class="okw-btn okw-btn-outline" id="okw-add-tab" style="padding:5px 10px;min-height:30px;font-size:12.5px;">+ Tab</button>` : '');

        el.querySelectorAll('[data-tab]').forEach(btn => {
            btn.onclick = (e) => {
                // Save current tab's cart before changing or closing tabs
                syncTabFromTillCart();

                if (e.target && e.target.dataset && e.target.dataset.closeTab) {
                    e.stopPropagation();
                    const cid = Number(e.target.dataset.closeTab);
                    tabs = tabs.filter(t => t.id !== cid);
                    if (!tabs.length) tabs = [createEmptyTab(nextTabSeq++)];
                    if (activeTabId === cid) {
                        activeTabId = tabs[0].id;
                    }
                    pushTabStateToTill(activeTab());
                    renderAll();
                    return;
                }

                const nextId = Number(btn.dataset.tab);
                if (nextId === activeTabId) return;
                activeTabId = nextId;
                pushTabStateToTill(activeTab());
                renderAll();
            };
        });

        const addBtn = document.getElementById('okw-add-tab');
        if (addBtn) {
            addBtn.onclick = () => {
                if (tabs.length >= MAX_TABS) return;
                // 1. Save current tab's items & discounts
                syncTabFromTillCart();
                // 2. Create a clean, empty tab
                const nt = createEmptyTab(nextTabSeq++);
                tabs.push(nt);
                activeTabId = nt.id;
                // 3. Push the empty tab state into Current Sale so it is a fresh clean sale sheet
                pushTabStateToTill(nt);
                renderAll();
            };
        }
    }

    function renderCustomerChip() {
        const t = activeTab();
        window.selectedPosCustomer = t.customer || null;
        const chip = document.getElementById('okw-cust-chip');
        if (!chip) return;
        if (!t.customer) {
            chip.innerHTML = `<span style="color:#475569;">Customer: <strong style="color:#0f172a;">Walk-in</strong></span>`;
            return;
        }
        const c = t.customer;
        chip.innerHTML = `
            <div style="display:inline-flex;align-items:center;gap:6px;">
                <strong style="color:#273990;">${OkwUI.escapeHtml(c.name)}</strong>
                <span class="okw-badge okw-badge-info" style="font-size:10.5px;padding:1px 6px;">${OkwUI.escapeHtml(c.customer_type || 'Client')}</span>
                <button type="button" class="okw-btn okw-btn-outline" id="okw-btn-buy-again" style="padding:2px 7px;min-height:24px;font-size:11px;" title="Repeat earlier order">History</button>
                <button type="button" id="okw-btn-clear-cust" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;" title="Clear customer">&times;</button>
            </div>
        `;
        chip.querySelector('#okw-btn-clear-cust').onclick = () => {
            t.customer = null;
            t.label = `Sale ${t.id}`;
            window.selectedPosCustomer = null;
            renderAll();
        };
        chip.querySelector('#okw-btn-buy-again').onclick = () => openBuyAgainModal(c.id);
    }

    function renderCart() {
        const t = activeTab();
        if (typeof window.okwSetFlatDiscount === 'function') {
            isSwitchingTabs = true;
            try {
                window.okwSetFlatDiscount(Number(t.discountAmount || 0));
            } finally {
                isSwitchingTabs = false;
            }
        }
    }

    function renderAll() {
        const t = activeTab();
        const pgEl = document.getElementById('okw-price-group');
        const dtEl = document.getElementById('okw-delivery-toggle');
        const dbEl = document.getElementById('okw-delivery-box');
        if (pgEl) pgEl.value = t.priceGroup;
        if (dtEl) dtEl.checked = t.delivery.enabled;
        if (dbEl) dbEl.style.display = t.delivery.enabled ? 'grid' : 'none';
        ['site', 'truck', 'driver', 'fee'].forEach(k => {
            const el = document.getElementById(`okw-del-${k}`);
            const map = { site: 'site_address', truck: 'truck', driver: 'driver', fee: 'fee' };
            if (el) el.value = t.delivery[map[k]] || '';
        });
        renderTabs();
        renderCustomerChip();
    }

    async function searchProductsOffline(term) {
        const q = term.toLowerCase();
        let source = Array.isArray(window.products) && window.products.length ? window.products : [];
        if (!source.length && typeof OfflineQueue !== 'undefined' && OfflineQueue && typeof OfflineQueue.getAllCachedProducts === 'function') {
            source = await OfflineQueue.getAllCachedProducts();
        }
        if (!source.length) {
            try { source = JSON.parse(localStorage.getItem('okw_pos_catalog_cache') || '[]'); } catch (_) { source = []; }
        }
        return source.filter(p =>
            String(p.name || '').toLowerCase().includes(q) ||
            String(p.barcode || '').toLowerCase().includes(q) ||
            String(p.brand || '').toLowerCase().includes(q) ||
            String(p.category || '').toLowerCase().includes(q)
        ).slice(0, 25);
    }

    async function searchProducts(q) {
        const box = document.getElementById('okw-search-results');
        if (!box) return;
        const term = String(q || '').trim();
        if (!term) {
            collapseSearchResults();
            return;
        }
        let list = [];
        try {
            if (!navigator.onLine) throw new Error('offline');
            const res = await fetch(`/api/pos/search?q=${encodeURIComponent(term)}`, { headers: authHeaders(), credentials: 'include' });
            if (!res.ok) throw new Error('search failed');
            const data = await res.json();
            list = data.products || [];
        } catch (e) {
            list = await searchProductsOffline(term);
        }
        try {
            box.style.display = 'block';
            if (!list.length) {
                box.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11.5px;color:#64748b;">
                        <span>0 matches</span>
                        <button type="button" data-collapse-search style="background:none;border:none;color:#273990;cursor:pointer;font-weight:600;font-size:11.5px;">Close &times;</button>
                    </div>
                    <div style="padding:14px;text-align:center;color:var(--color-text-muted);font-size:13px;">No products match "${OkwUI.escapeHtml(term)}".</div>
                `;
                box.querySelector('[data-collapse-search]').onclick = collapseSearchResults;
                return;
            }
            const t = activeTab();
            box.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11.5px;color:#64748b;position:sticky;top:0;z-index:1;">
                    <span>${list.length} product${list.length === 1 ? '' : 's'} found — click to add</span>
                    <button type="button" data-collapse-search style="background:none;border:none;color:#273990;cursor:pointer;font-weight:600;font-size:11.5px;">Collapse &times;</button>
                </div>
            ` + list.map(p => {
                const price = resolveUnitPrice(p, t.priceGroup, 1, 1);
                const isOut = Number(p.stock || 0) <= 0;
                return `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-bottom:1px solid #f1f5f9;${isOut ? 'opacity:0.42;background:#f8fafc;cursor:not-allowed;' : ''}">
                        <div style="min-width:0;flex:1;${isOut ? 'cursor:not-allowed;' : 'cursor:pointer;'}" ${isOut ? '' : `data-add-prod="${p.barcode}"`}>
                            <div style="font-weight:600;font-size:13.5px;color:#0f172a;">${OkwUI.escapeHtml(p.name)}</div>
                            <div style="font-size:11.5px;color:#64748b;">
                                ${p.brand ? OkwUI.escapeHtml(p.brand) + ' · ' : ''}<span class="mono">${OkwUI.escapeHtml(p.barcode)}</span> · ${OkwUI.escapeHtml(p.selling_unit || 'Unit')}
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            ${stockBadgeHtml(p)}
                            ${isOut
                                ? `<button type="button" class="okw-btn okw-btn-outline" disabled style="padding:5px 11px;min-height:30px;font-size:12px;opacity:0.75;cursor:not-allowed;">Out of Stock</button>`
                                : `<button type="button" class="okw-btn okw-btn-primary" data-add-prod="${p.barcode}" style="padding:5px 11px;min-height:30px;font-size:12.5px;">${fmt(price)}</button>`
                            }
                        </div>
                    </div>
                `;
            }).join('');

            const colBtn = box.querySelector('[data-collapse-search]');
            if (colBtn) colBtn.onclick = collapseSearchResults;

            box.querySelectorAll('[data-stock-loc]').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const prod = list.find(p => p.barcode === btn.dataset.stockLoc);
                    if (prod) showLocationsModal(prod);
                };
            });
            box.querySelectorAll('[data-add-prod]').forEach(el => {
                el.onclick = () => {
                    const prod = list.find(p => p.barcode === el.dataset.addProd);
                    if (prod) {
                        addProductToCart(prod);
                        const sIn = document.getElementById('okw-pos-search');
                        if (sIn) sIn.value = '';
                        collapseSearchResults();
                    }
                };
            });
        } catch (e) { /* offline fallback handled gracefully */ }
    }

    function addProductToCart(product, qty = 1) {
        if (Number(product.stock || 0) <= 0) {
            OkwUI.toast(`${product.name || 'This item'} is out of stock and cannot be sold.`, 'danger');
            return;
        }
        const t = activeTab();
        const unitPrice = resolveUnitPrice(product, t.priceGroup, 1, qty);
        if (typeof window.addToCart === 'function') {
            window.addToCart({
                ...product,
                id: product.id || product.barcode,
                price: unitPrice,
                selling_unit: product.selling_unit || 'Unit'
            });
            syncTabFromTillCart();
        } else {
            const existing = t.items.find(i => i.barcode === product.barcode && i.unit_factor === 1);
            if (existing) {
                existing.qty = Number((existing.qty + qty).toFixed(3));
                existing.price = resolveUnitPrice(product, t.priceGroup, 1, existing.qty);
            } else {
                t.items.push({
                    barcode: product.barcode,
                    name: product.name,
                    qty,
                    unit_name: product.selling_unit || 'Unit',
                    base_unit: product.selling_unit || 'Unit',
                    unit_factor: 1,
                    available_units: Array.isArray(product.units) ? product.units : [],
                    price: unitPrice,
                    rawProduct: product
                });
            }
        }
        renderAll();
    }

    async function searchCustomers(q) {
        const box = document.getElementById('okw-cust-results');
        if (!box) return;
        if (!q.trim()) { box.style.display = 'none'; return; }
        const res = await fetch(`/api/pos/customers/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const list = data.customers || [];
        box.style.display = 'block';
        box.innerHTML = list.length
            ? list.map(c => `
                <div style="padding:8px 12px;border-bottom:1px solid var(--color-border);cursor:pointer;display:flex;justify-content:space-between;" data-pick-cust="${c.id}">
                    <span><strong>${OkwUI.escapeHtml(c.name)}</strong> (${OkwUI.escapeHtml(c.phone || 'No phone')})</span>
                    <span class="okw-badge okw-badge-neutral">${OkwUI.escapeHtml(c.customer_type || 'Walk-in')}</span>
                </div>
            `).join('')
            : '<div style="padding:10px;color:var(--color-text-muted);font-size:13px;">No customer found. Click + Add.</div>';

        box.querySelectorAll('[data-pick-cust]').forEach(row => {
            row.onclick = () => {
                const c = list.find(x => String(x.id) === row.dataset.pickCust);
                if (c) {
                    const t = activeTab();
                    t.customer = c;
                    t.priceGroup = c.price_group || 'retail';
                    t.label = c.name.split(' ')[0];
                    box.style.display = 'none';
                    document.getElementById('okw-cust-search').value = '';
                    renderAll();
                }
            };
        });
    }

    function openNewCustomerModal() {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.6);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `
            <div class="okw-card" style="max-width:440px;width:100%;">
                <h3 style="margin:0 0 12px;">Quick Add Customer</h3>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    <input type="text" id="nc-name" class="okw-input" placeholder="Full name *">
                    <input type="text" id="nc-phone" class="okw-input" placeholder="Phone number">
                    <input type="text" id="nc-company" class="okw-input" placeholder="Company (optional)">
                    <input type="text" id="nc-site" class="okw-input" placeholder="Site / Location (e.g. East Legon 4-bedroom)">
                    <select id="nc-type" class="okw-select">
                        <option value="Walk-in">Walk-in</option>
                        <option value="Contractor">Contractor</option>
                        <option value="Company">Company</option>
                    </select>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                    <button type="button" class="okw-btn okw-btn-outline" data-cancel>Cancel</button>
                    <button type="button" class="okw-btn okw-btn-primary" data-save>Save & Attach</button>
                </div>
            </div>
        `;
        modal.querySelector('[data-cancel]').onclick = () => modal.remove();
        modal.querySelector('[data-save]').onclick = async () => {
            const payload = {
                name: modal.querySelector('#nc-name').value.trim(),
                phone: modal.querySelector('#nc-phone').value.trim(),
                company_name: modal.querySelector('#nc-company').value.trim(),
                site_location: modal.querySelector('#nc-site').value.trim(),
                customer_type: modal.querySelector('#nc-type').value
            };
            if (!payload.name) return OkwUI.toast('Customer name is required', 'warning');
            const res = await fetch('/api/pos/customers/quick', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.customer) {
                const t = activeTab();
                t.customer = data.customer;
                t.priceGroup = data.customer.price_group || 'retail';
                t.label = data.customer.name.split(' ')[0];
                modal.remove();
                renderAll();
                OkwUI.toast('Customer saved and attached', 'success');
            } else {
                OkwUI.toast(data.message || 'Could not save customer', 'danger');
            }
        };
        document.body.appendChild(modal);
        modal.querySelector('#nc-name').focus();
    }

    async function openBuyAgainModal(customerId) {
        const res = await fetch(`/api/pos/customers/${customerId}/recent-orders`, { headers: authHeaders() });
        if (!res.ok) return OkwUI.toast('Could not load past orders', 'danger');
        const data = await res.json();
        const orders = data.orders || [];
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.6);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `
            <div class="okw-card" style="max-width:520px;width:100%;max-height:80vh;overflow-y:auto;">
                <h3 style="margin:0 0 12px;">Repeat Earlier Order</h3>
                ${orders.length ? orders.map((o, idx) => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--color-border);">
                        <div>
                            <div class="mono" style="font-weight:600;">${OkwUI.escapeHtml(o.receipt_number || ('Order #' + o.id))}</div>
                            <div style="font-size:12px;color:var(--color-text-muted);">${new Date(o.created_at).toLocaleDateString()} · ${(o.items || []).length} items · ${fmt(o.total_amount)}</div>
                        </div>
                        <button type="button" class="okw-btn okw-btn-primary" data-repeat="${idx}">Buy Again</button>
                    </div>
                `).join('') : '<p style="color:var(--color-text-muted);">No previous orders found.</p>'}
                <div style="margin-top:14px;text-align:right;"><button type="button" class="okw-btn okw-btn-outline" data-close>Close</button></div>
            </div>
        `;
        modal.querySelector('[data-close]').onclick = () => modal.remove();
        modal.querySelectorAll('[data-repeat]').forEach(btn => {
            btn.onclick = () => {
                const ord = orders[Number(btn.dataset.repeat)];
                const t = syncTabFromTillCart();
                (ord.items || []).forEach(it => t.items.push({ ...it, unit_factor: it.unit_factor || 1, unit_name: it.unit_name || 'Unit' }));
                modal.remove();
                pushItemsToTillCart(t.items);
                renderAll();
                OkwUI.toast('Order items added to cart', 'success');
            };
        });
        document.body.appendChild(modal);
    }

    async function applyDiscountWithPin() {
        const t = syncTabFromTillCart();
        const subtotal = t.items.reduce((s, i) => s + i.price * i.qty, 0);
        if (!subtotal) return OkwUI.toast('Add items before applying a discount', 'warning');
        const raw = prompt('Enter discount amount (GH₵):', String(t.discountAmount || 0));
        if (raw === null) return;
        const amt = Math.max(0, parseFloat(raw) || 0);
        const role = getUserRole();
        const pct = (amt / subtotal) * 100;
        const capPct = (role === 'ceo' || role === 'admin') ? 100 : (role === 'manager' || role === 'store_manager' ? 20 : 5);

        if (pct > capPct) {
            const pin = prompt(`Discount (${pct.toFixed(1)}%) exceeds your ${capPct}% role limit. Enter Manager PIN to approve:`);
            if (!pin) return;
            const res = await fetch('/api/pos/approve-pin', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ pin, discount_amount: amt, reason: `POS Discount ${fmt(amt)} (${pct.toFixed(1)}%)` })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return OkwUI.toast(data.message || 'Manager PIN rejected', 'danger');
            t.discountApprovedBy = data.approver.id;
            t.approvalToken = data.approval_token || null;
            OkwUI.toast(`Approved by ${data.approver.name}`, 'success');
        }
        t.discountAmount = amt;
        renderCart();
        OkwUI.toast(amt > 0 ? `Discount of ${fmt(amt)} applied` : 'Discount cleared', 'info');
    }

    function openSplitPaymentModal() {
        const t = syncTabFromTillCart();
        if (!t.items.length) return OkwUI.toast('Cart is empty — add items before splitting payment', 'warning');
        const subtotal = t.items.reduce((s, i) => s + i.price * i.qty, 0);
        const delFee = t.delivery.enabled ? Number(t.delivery.fee || 0) : 0;
        const pctDisc = subtotal * Number(t.discountRate || 0);
        const totalDisc = Math.min(subtotal, pctDisc + Number(t.discountAmount || 0));
        const grandTotal = Math.max(0, Number((subtotal - totalDisc + delFee).toFixed(2)));

        const half = Number((grandTotal / 2).toFixed(2));
        const rem = Number((grandTotal - half).toFixed(2));
        const splits = [
            { method: 'cash', amount: half, reference: '' },
            { method: 'momo_mtn', amount: rem, reference: '' }
        ];
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.65);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `
            <div class="okw-card" style="max-width:620px;width:100%;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <div>
                        <h3 style="margin:0;">Split / Multiple Payments</h3>
                        <div style="font-size:12px;color:var(--color-text-muted);">Combine Cash, Mobile Money, Card, Bank Transfer, Cheque, or Credit</div>
                    </div>
                    <span class="kpi-value" style="font-size:20px;font-weight:800;color:#273990;">Total: ${fmt(grandTotal)}</span>
                </div>
                <div id="sp-rows" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;"></div>
                <button type="button" class="okw-btn okw-btn-outline" id="sp-add" style="margin-bottom:12px;">+ Add Payment Method</button>
                <div id="sp-summary" style="padding:10px 12px;background:var(--color-surface-muted);border-radius:var(--radius-sm);display:flex;justify-content:space-between;font-size:14px;margin-bottom:14px;"></div>
                <div style="display:flex;justify-content:flex-end;gap:10px;">
                    <button type="button" class="okw-btn okw-btn-outline" id="sp-cancel">Cancel</button>
                    <button type="button" class="okw-btn okw-btn-primary" id="sp-complete">Complete Split Sale</button>
                </div>
            </div>
        `;

        const methods = [
            ['cash', 'Cash'],
            ['momo_mtn', 'Mobile Money (MTN)'],
            ['momo_telecel', 'Mobile Money (Telecel)'],
            ['momo_at', 'Mobile Money (AirtelTigo)'],
            ['card', 'Card'],
            ['bank_transfer', 'Bank Transfer'],
            ['cheque', 'Cheque'],
            ['customer_credit', 'Customer Credit'],
            ['store_credit', 'Store Credit']
        ];

        function renderSplits() {
            const rowsEl = modal.querySelector('#sp-rows');
            rowsEl.innerHTML = splits.map((s, idx) => `
                <div style="display:grid;grid-template-columns:1.2fr 120px 1fr 30px;gap:8px;align-items:center;">
                    <select class="okw-select" data-sp-m="${idx}">
                        ${methods.map(([v, l]) => `<option value="${v}" ${s.method === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                    <input type="number" class="okw-input" data-sp-a="${idx}" value="${s.amount}" min="0" step="0.01">
                    <input type="text" class="okw-input" data-sp-r="${idx}" value="${OkwUI.escapeHtml(s.reference)}" placeholder="Ref / MoMo ID / Cheque #">
                    <button type="button" data-sp-rm="${idx}" style="background:none;border:none;color:var(--color-danger);cursor:pointer;font-size:18px;" title="Remove payment leg">&times;</button>
                </div>
            `).join('');

            rowsEl.querySelectorAll('[data-sp-m]').forEach(el => el.onchange = () => { splits[el.dataset.spM].method = el.value; updateTotals(); });
            rowsEl.querySelectorAll('[data-sp-a]').forEach(el => el.oninput = () => { splits[el.dataset.spA].amount = parseFloat(el.value) || 0; updateTotals(); });
            rowsEl.querySelectorAll('[data-sp-r]').forEach(el => el.oninput = () => { splits[el.dataset.spR].reference = el.value; });
            rowsEl.querySelectorAll('[data-sp-rm]').forEach(el => el.onclick = () => { if (splits.length > 1) { splits.splice(Number(el.dataset.spRm), 1); renderSplits(); } });
            updateTotals();
        }

        function updateTotals() {
            const paid = splits.reduce((s, p) => s + Number(p.amount || 0), 0);
            const cashPaid = splits.filter(p => p.method === 'cash').reduce((s, p) => s + Number(p.amount || 0), 0);
            const nonCash = paid - cashPaid;
            const remAfterNonCash = Math.max(0, grandTotal - nonCash);
            const change = Math.max(0, cashPaid - remAfterNonCash);
            const balance = Math.max(0, grandTotal - paid);

            modal.querySelector('#sp-summary').innerHTML = `
                <span>Paid: <strong class="mono">${fmt(paid)}</strong></span>
                <span>Balance: <strong class="mono" style="color:${balance > 0 ? 'var(--color-warning)' : 'var(--color-success)'};">${fmt(balance)}</strong></span>
                <span>Change (Cash): <strong class="mono" style="color:#273990;">${fmt(change)}</strong></span>
            `;
        }

        modal.querySelector('#sp-add').onclick = () => {
            const paid = splits.reduce((s, p) => s + Number(p.amount || 0), 0);
            splits.push({ method: 'card', amount: Math.max(0, Number((grandTotal - paid).toFixed(2))), reference: '' });
            renderSplits();
        };
        modal.querySelector('#sp-cancel').onclick = () => modal.remove();

        const idempotencyKey = 'pos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        let submitting = false;
        modal.querySelector('#sp-complete').onclick = async () => {
            if (submitting) return;
            submitting = true;
            const btn = modal.querySelector('#sp-complete');
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Processing...';

            const payload = {
                items: t.items.map(({ rawProduct, available_units, ...rest }) => rest),
                payments: splits.filter(s => Number(s.amount) > 0),
                customer_id: t.customer ? t.customer.id : null,
                customer_name: t.customer ? t.customer.name : 'Walk-in',
                price_group: t.priceGroup,
                discount_amount: totalDisc,
                discount_approved_by: t.discountApprovedBy,
                approval_token: t.approvalToken || null,
                idempotency_key: idempotencyKey,
                quotation_id: t.quotationId || null,
                delivery: t.delivery
            };

            const queueOffline = () => {
                if (typeof OfflineQueue !== 'undefined' && OfflineQueue && typeof OfflineQueue.enqueue === 'function') {
                    OfflineQueue.enqueue('/api/pos/checkout', 'POST', payload);
                } else {
                    const q = JSON.parse(localStorage.getItem('offlineSalesQueue') || '[]');
                    q.push({ url: '/api/pos/checkout', method: 'POST', payload, queued_at: new Date().toISOString() });
                    localStorage.setItem('offlineSalesQueue', JSON.stringify(q));
                }
                modal.remove();
                OkwUI.toast('Offline: split sale queued and will sync when online', 'warning');
                tabs = tabs.filter(x => x.id !== t.id);
                if (!tabs.length) tabs = [createEmptyTab(nextTabSeq++)];
                activeTabId = tabs[0].id;
                pushTabStateToTill(activeTab());
                renderAll();
            };

            const idempKey = payload.idempotency_key || (`split-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
            payload.idempotency_key = idempKey;
            if (!navigator.onLine) {
                queueOffline();
                return;
            }

            try {
                const res = await fetch('/api/pos/checkout', { method: 'POST', headers: { ...authHeaders(), 'X-Idempotency-Key': idempKey }, body: JSON.stringify(payload) });
                const data = await res.json().catch(() => ({}));
                if (res.ok) {
                    modal.remove();
                    OkwUI.toast(`Split sale completed: ${data.receipt_number}`, 'success');
                    tabs = tabs.filter(x => x.id !== t.id);
                    if (!tabs.length) tabs = [createEmptyTab(nextTabSeq++)];
                    activeTabId = tabs[0].id;
                    pushTabStateToTill(activeTab());
                    renderAll();
                    if (data.receipt_number) {
                        localStorage.setItem('lastTransaction', JSON.stringify(data.transaction));
                    }
                } else {
                    OkwUI.toast(data.message || 'Checkout failed', 'danger');
                    submitting = false;
                    btn.disabled = false;
                    btn.textContent = origText;
                }
            } catch (err) {
                queueOffline();
                return;
            }
        };

        document.body.appendChild(modal);
        renderSplits();
    }

    // Expose globally so the Split button in pos.html's Current Sale payment grid invokes it directly
    window.okwOpenSplitPayment = openSplitPaymentModal;

    async function holdCurrentSale() {
        const t = syncTabFromTillCart();
        if (!t.items.length) return OkwUI.toast('Cart is empty', 'warning');
        const label = prompt('Hold label (e.g. "Kofi, 200 bags"):', t.customer ? t.customer.name : `Hold ${t.id}`);
        if (!label) return;
        const res = await fetch('/api/pos/holds', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                label,
                customer_id: t.customer ? t.customer.id : null,
                customer_name: t.customer ? t.customer.name : 'Walk-in',
                price_group: t.priceGroup,
                items: t.items.map(({ rawProduct, available_units, ...rest }) => rest),
                discount_amount: t.discountAmount
            })
        });
        if (res.ok) {
            OkwUI.toast(`Sale parked as "${label}"`, 'success');
            t.items = []; t.discountAmount = 0; t.discountRate = 0; t.promoCode = null; t.customer = null;
            pushTabStateToTill(t);
            renderAll();
        }
    }

    async function openHoldsModal() {
        const res = await fetch('/api/pos/holds', { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        const holds = data.holds || [];
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(11,16,23,0.6);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `
            <div class="okw-card" style="max-width:520px;width:100%;max-height:80vh;overflow-y:auto;">
                <h3 style="margin:0 0 12px;">Held Sales</h3>
                ${holds.length ? holds.map(h => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--color-border);">
                        <div>
                            <strong>${OkwUI.escapeHtml(h.label)}</strong>
                            <div style="font-size:12px;color:var(--color-text-muted);">${(h.items || []).length} items · ${new Date(h.created_at).toLocaleString()}</div>
                        </div>
                        <button type="button" class="okw-btn okw-btn-primary" data-resume="${h.id}">Resume</button>
                    </div>
                `).join('') : '<p style="color:var(--color-text-muted);">No parked sales.</p>'}
                <div style="margin-top:14px;text-align:right;"><button type="button" class="okw-btn okw-btn-outline" data-close>Close</button></div>
            </div>
        `;
        modal.querySelector('[data-close]').onclick = () => modal.remove();
        modal.querySelectorAll('[data-resume]').forEach(btn => {
            btn.onclick = async () => {
                const h = holds.find(x => String(x.id) === btn.dataset.resume);
                if (!h) return;
                const t = activeTab();
                t.items = h.items || [];
                t.priceGroup = h.price_group || 'retail';
                t.discountAmount = Number(h.discount_amount || 0);
                await fetch(`/api/pos/holds/${h.id}`, { method: 'DELETE', headers: authHeaders() });
                modal.remove();
                pushTabStateToTill(t);
                renderAll();
                OkwUI.toast(`Resumed "${h.label}"`, 'success');
            };
        });
        document.body.appendChild(modal);
    }

    async function saveAsQuotation() {
        const t = syncTabFromTillCart();
        if (!t.items.length) return OkwUI.toast('Add items to the cart before saving a quotation', 'warning');
        const validUntil = prompt('Quotation valid until (YYYY-MM-DD):', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
        if (!validUntil) return;
        const subtotal = t.items.reduce((s, i) => s + i.price * i.qty, 0);
        const total = Math.max(0, subtotal - Number(t.discountAmount || 0));
        const res = await fetch('/api/pos/quotations', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                customer_id: t.customer ? t.customer.id : null,
                customer_name: t.customer ? t.customer.name : 'Walk-in',
                customer_phone: t.customer ? t.customer.phone : '',
                price_group: t.priceGroup,
                items: t.items.map(({ rawProduct, available_units, ...rest }) => rest),
                subtotal,
                discount_amount: t.discountAmount,
                total_amount: total,
                valid_until: validUntil
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            OkwUI.toast(`Quotation ${data.quotation.quote_number} saved`, 'success');
            if (currentView === 'quotes') renderQuotesPage();
        } else {
            OkwUI.toast(data.message || 'Could not save quotation', 'danger');
        }
    }

    /* ==========================================================================
       POS ACTIVITY PAGES: QUOTES, DISCOUNTS, SPLITS
       ========================================================================== */
    function switchPosView(view) {
        currentView = view || 'till';
        const shell = document.getElementById('okw-pos-upgrade-shell');
        const cartSec = document.querySelector('.cart-section');
        const actView = document.getElementById('okw-pos-activity-view');

        // Highlight active nav pill in header
        document.querySelectorAll('#okw-pos-view-nav [data-pos-view]').forEach(btn => {
            const isAct = btn.dataset.posView === currentView;
            btn.classList.toggle('active', isAct);
            btn.style.background = isAct ? '#273990' : 'transparent';
            btn.style.color = isAct ? '#ffffff' : '#334155';
        });

        const url = new URL(window.location.href);
        if (currentView === 'till') {
            url.searchParams.delete('view');
        } else {
            url.searchParams.set('view', currentView);
        }
        window.history.replaceState({}, '', url.toString());

        if (currentView === 'till') {
            if (shell) shell.style.display = '';
            if (cartSec) cartSec.style.display = '';
            if (actView) actView.style.display = 'none';
            return;
        }

        if (shell) shell.style.display = 'none';
        if (cartSec) cartSec.style.display = 'none';
        if (actView) {
            actView.style.display = 'block';
            if (currentView === 'quotes') renderQuotesPage();
            else if (currentView === 'discounts') renderDiscountsPage();
            else if (currentView === 'splits') renderSplitsPage();
        }
    }

    window.okwSwitchPosView = switchPosView;

    async function renderQuotesPage() {
        const host = document.getElementById('okw-pos-activity-view');
        if (!host) return;
        const cached = readCachedView('quotes');
        if (cached) {
            paintQuotesPage(host, cached);
            fetchActivityData('quotes', '/api/pos/quotations').then(fresh => {
                if (currentView === 'quotes' && JSON.stringify(fresh) !== JSON.stringify(cached)) {
                    paintQuotesPage(host, fresh);
                }
            }).catch(() => {});
            return;
        }
        host.innerHTML = `<div class="okw-card" style="padding:24px;">Loading quotations history…</div>`;
        const data = await fetchActivityData('quotes', '/api/pos/quotations');
        paintQuotesPage(host, data);
    }

    function paintQuotesPage(host, data) {
        const quotes = data.quotations || [];

        const openCount = quotes.filter(q => q.status !== 'converted').length;
        const convCount = quotes.filter(q => q.status === 'converted').length;
        const totalValue = quotes.reduce((s, q) => s + Number(q.total_amount || 0), 0);

        host.innerHTML = `
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;">
                <div>
                    <h2 style="margin:0;font-size:20px;color:#0f172a;">Quotations History</h2>
                    <p style="margin:2px 0 0;font-size:13px;color:#64748b;">Create, track, and convert customer price quotations into POS sales.</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button type="button" class="okw-btn okw-btn-primary" id="pg-qt-new">+ Save Current Cart as Quote</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="pg-qt-back">&larr; Back to Till</button>
                </div>
            </div>

            <div class="kpi-grid" style="margin-bottom:16px;background:var(--sheet, #ffffff);">
                <div class="kpi-card"><div class="kpi-title">Total Quotations</div><div class="kpi-value">${quotes.length}</div></div>
                <div class="kpi-card"><div class="kpi-title">Open Quotes</div><div class="kpi-value">${openCount}</div></div>
                <div class="kpi-card"><div class="kpi-title">Converted to Sale</div><div class="kpi-value">${convCount}</div></div>
                <div class="kpi-card"><div class="kpi-title">Total Quoted Value</div><div class="kpi-value">${fmt(totalValue)}</div></div>
            </div>

            <div class="okw-card" id="pg-qt-table-host"></div>
        `;

        host.querySelector('#pg-qt-back').onclick = () => switchPosView('till');
        host.querySelector('#pg-qt-new').onclick = async () => {
            await saveAsQuotation();
        };

        const rows = quotes.map(q => ({
            id: q.id,
            quote_number: q.quote_number,
            date: new Date(q.created_at).toLocaleString(),
            customer: q.customer_name || 'Walk-in',
            tier: (q.price_group || 'retail').toUpperCase(),
            items_count: Array.isArray(q.items) ? q.items.length : 0,
            discount: Number(q.discount_amount || 0),
            total: Number(q.total_amount || 0),
            valid_until: q.valid_until ? String(q.valid_until).slice(0, 10) : '—',
            status: q.status || 'open'
        }));

        OkwUI.dataTable('#pg-qt-table-host', {
            columns: [
                { key: 'quote_number', label: 'Quote #', render: v => `<strong class="mono" style="color:#273990;">${OkwUI.escapeHtml(v)}</strong>` },
                { key: 'date', label: 'Created' },
                { key: 'customer', label: 'Customer' },
                { key: 'tier', label: 'Tier', render: v => `<span class="okw-badge okw-badge-neutral">${OkwUI.escapeHtml(v)}</span>` },
                { key: 'items_count', label: 'Items', numeric: true },
                { key: 'discount', label: 'Discount', numeric: true, render: v => fmt(v) },
                { key: 'total', label: 'Total', numeric: true, render: v => `<strong>${fmt(v)}</strong>` },
                { key: 'valid_until', label: 'Valid Until' },
                { key: 'status', label: 'Status', render: v => OkwUI.badge(v === 'converted' ? 'Converted' : 'Open', v === 'converted' ? 'success' : 'warning') },
                {
                    key: 'id',
                    label: 'Action',
                    render: (id, r) => r.status === 'converted'
                        ? '<span style="font-size:12px;color:#64748b;">Completed</span>'
                        : `<button type="button" class="okw-btn okw-btn-primary" data-load-quote="${id}" style="padding:4px 10px;min-height:28px;font-size:12px;">Load to Till</button>`
                }
            ],
            rows,
            searchPlaceholder: 'Search quote #, customer, or status…',
            exportFilename: 'okwesiwa-quotations.xlsx',
            emptyText: 'No quotations recorded yet.'
        });

        host.querySelectorAll('[data-load-quote]').forEach(btn => {
            btn.onclick = async () => {
                const r = await fetch(`/api/pos/quotations/${btn.dataset.loadQuote}/convert`, { method: 'POST', headers: authHeaders() });
                const d = await r.json().catch(() => ({}));
                if (r.ok && d.quotation) {
                    const t = activeTab();
                    t.items = d.quotation.items || [];
                    t.priceGroup = d.quotation.price_group || 'retail';
                    t.discountAmount = Number(d.quotation.discount_amount || 0);
                    t.quotationId = d.quotation.id;
                    pushTabStateToTill(t);
                    renderAll();
                    switchPosView('till');
                    OkwUI.toast(`Quotation ${d.quotation.quote_number} loaded into Current Sale`, 'success');
                } else {
                    OkwUI.toast(d.message || 'Could not load quotation', 'danger');
                }
            };
        });
    }

    async function renderDiscountsPage() {
        const host = document.getElementById('okw-pos-activity-view');
        if (!host) return;
        const cached = readCachedView('discounts');
        if (cached) {
            paintDiscountsPage(host, cached);
            fetchActivityData('discounts', '/api/pos/discounts-history').then(fresh => {
                if (currentView === 'discounts' && JSON.stringify(fresh) !== JSON.stringify(cached)) {
                    paintDiscountsPage(host, fresh);
                }
            }).catch(() => {});
            return;
        }
        host.innerHTML = `<div class="okw-card" style="padding:24px;">Loading discounts & approvals history…</div>`;
        const data = await fetchActivityData('discounts', '/api/pos/discounts-history');
        paintDiscountsPage(host, data);
    }

    function paintDiscountsPage(host, data) {
        const discounts = data.discounts || [];
        const approvals = data.approvals || [];

        const totalDiscGiven = discounts.reduce((s, d) => s + Number(d.discount_amount || 0), 0);
        const totalSalesVal = discounts.reduce((s, d) => s + Number(d.total_amount || 0), 0);

        host.innerHTML = `
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;">
                <div>
                    <h2 style="margin:0;font-size:20px;color:#0f172a;">Discounts & Approvals History</h2>
                    <p style="margin:2px 0 0;font-size:13px;color:#64748b;">Every discounted POS sale, promo redemption, and manager PIN approval.</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button type="button" class="okw-btn okw-btn-primary" id="pg-dc-apply">+ Apply Discount to Current Sale</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="pg-dc-back">&larr; Back to Till</button>
                </div>
            </div>

            <div class="kpi-grid" style="margin-bottom:16px;background:var(--sheet, #ffffff);">
                <div class="kpi-card"><div class="kpi-title">Discounted Sales</div><div class="kpi-value">${discounts.length}</div></div>
                <div class="kpi-card"><div class="kpi-title">Total Discount Given</div><div class="kpi-value">${fmt(totalDiscGiven)}</div></div>
                <div class="kpi-card"><div class="kpi-title">Net Sales After Discount</div><div class="kpi-value">${fmt(totalSalesVal)}</div></div>
                <div class="kpi-card"><div class="kpi-title">Manager PIN Approvals</div><div class="kpi-value">${approvals.length}</div></div>
            </div>

            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;">
                <span style="font-size:13px;font-weight:600;color:#475569;margin-right:4px;">Filter:</span>
                <button type="button" class="okw-btn okw-btn-primary" data-dc-filter="transactions">Discounted Transactions (${discounts.length})</button>
                <button type="button" class="okw-btn okw-btn-outline" data-dc-filter="approvals">Manager PIN Approval Log (${approvals.length})</button>
            </div>

            <div class="okw-card" id="pg-dc-transactions-panel">
                <h3 style="margin:0 0 12px;font-size:15px;">Discounted Transactions</h3>
                <div id="pg-dc-table-host"></div>
            </div>

            <div class="okw-card" id="pg-dc-approvals-panel" style="display:none;">
                <h3 style="margin:0 0 12px;font-size:15px;">Manager PIN Approval Log</h3>
                <div id="pg-dc-approvals-host"></div>
            </div>
        `;

        host.querySelector('#pg-dc-back').onclick = () => switchPosView('till');
        host.querySelector('#pg-dc-apply').onclick = async () => {
            switchPosView('till');
            await applyDiscountWithPin();
        };

        const txPanel = host.querySelector('#pg-dc-transactions-panel');
        const appPanel = host.querySelector('#pg-dc-approvals-panel');
        host.querySelectorAll('[data-dc-filter]').forEach(btn => {
            btn.onclick = () => {
                const sel = btn.dataset.dcFilter;
                host.querySelectorAll('[data-dc-filter]').forEach(b => {
                    const isAct = b.dataset.dcFilter === sel;
                    b.className = `okw-btn ${isAct ? 'okw-btn-primary' : 'okw-btn-outline'}`;
                });
                txPanel.style.display = sel === 'transactions' ? '' : 'none';
                appPanel.style.display = sel === 'approvals' ? '' : 'none';
            };
        });

        const discRows = discounts.map(d => ({
            receipt: d.receipt_number || ('#' + d.id),
            date: new Date(d.created_at).toLocaleString(),
            customer: d.customer_name || 'Walk-in',
            seller: d.seller_name || 'Staff',
            store: d.store_location || '—',
            promo: d.promo_code || (d.approver_name ? `PIN: ${d.approver_name}` : 'Manual'),
            discount: Number(d.discount_amount || 0),
            total: Number(d.total_amount || 0)
        }));

        OkwUI.dataTable('#pg-dc-table-host', {
            columns: [
                { key: 'receipt', label: 'Receipt #', render: v => `<strong class="mono" style="color:#273990;">${OkwUI.escapeHtml(v)}</strong>` },
                { key: 'date', label: 'Date / Time' },
                { key: 'customer', label: 'Customer' },
                { key: 'seller', label: 'Served By' },
                { key: 'store', label: 'Store' },
                { key: 'promo', label: 'Promo / Approval', render: v => `<span class="okw-badge okw-badge-info">${OkwUI.escapeHtml(v)}</span>` },
                { key: 'discount', label: 'Discount', numeric: true, render: v => `<strong style="color:#b45309;">-${fmt(v)}</strong>` },
                { key: 'total', label: 'Final Total', numeric: true, render: v => `<strong>${fmt(v)}</strong>` }
            ],
            rows: discRows,
            searchPlaceholder: 'Search receipt, customer, staff, or promo…',
            exportFilename: 'okwesiwa-pos-discounts.xlsx',
            printTitle: 'OKWESIWA CO LTD — Discounted Transactions',
            emptyText: 'No discounted sales recorded yet.'
        });

        const appRows = approvals.map(a => ({
            date: new Date(a.created_at).toLocaleString(),
            approver: a.approver_name || 'Manager',
            role: (a.approver_role || 'manager').toUpperCase(),
            reason: a.reason || 'POS Override',
            max_discount: a.max_discount !== null ? fmt(a.max_discount) : '—',
            status: a.used_at ? 'Used' : 'Issued'
        }));

        OkwUI.dataTable('#pg-dc-approvals-host', {
            columns: [
                { key: 'date', label: 'Timestamp' },
                { key: 'approver', label: 'Approved By' },
                { key: 'role', label: 'Role', render: v => `<span class="okw-badge okw-badge-neutral">${OkwUI.escapeHtml(v)}</span>` },
                { key: 'reason', label: 'Reason' },
                { key: 'max_discount', label: 'Approved Amount', numeric: true },
                { key: 'status', label: 'Status', render: v => OkwUI.badge(v, v === 'Used' ? 'success' : 'info') }
            ],
            rows: appRows,
            searchPlaceholder: 'Search approver or reason…',
            exportFilename: 'okwesiwa-manager-approvals.xlsx',
            printTitle: 'OKWESIWA CO LTD — Manager PIN Approval Log',
            emptyText: 'No manager PIN overrides logged yet.'
        });
    }

    async function renderSplitsPage() {
        const host = document.getElementById('okw-pos-activity-view');
        if (!host) return;
        const cached = readCachedView('splits');
        if (cached) {
            paintSplitsPage(host, cached);
            fetchActivityData('splits', '/api/pos/splits-history').then(fresh => {
                if (currentView === 'splits' && JSON.stringify(fresh) !== JSON.stringify(cached)) {
                    paintSplitsPage(host, fresh);
                }
            }).catch(() => {});
            return;
        }
        host.innerHTML = `<div class="okw-card" style="padding:24px;">Loading split payment transactions…</div>`;
        const data = await fetchActivityData('splits', '/api/pos/splits-history');
        paintSplitsPage(host, data);
    }

    function paintSplitsPage(host, data) {
        const splits = data.splits || [];

        const multiLegCount = splits.filter(s => Array.isArray(s.payment_splits) && s.payment_splits.length > 1).length;
        const totalVol = splits.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);

        host.innerHTML = `
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;">
                <div>
                    <h2 style="margin:0;font-size:20px;color:#0f172a;">Split & Multiple Payments History</h2>
                    <p style="margin:2px 0 0;font-size:13px;color:#64748b;">Transactions paid across multiple payment tenders (Cash, Mobile Money, Card, Bank Transfer, Cheque, Credit).</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button type="button" class="okw-btn okw-btn-primary" id="pg-sp-new">+ New Split Payment</button>
                    <button type="button" class="okw-btn okw-btn-outline" id="pg-sp-back">&larr; Back to Till</button>
                </div>
            </div>

            <div class="kpi-grid" style="margin-bottom:16px;background:var(--sheet, #ffffff);">
                <div class="kpi-card"><div class="kpi-title">Checkout Records</div><div class="kpi-value">${splits.length}</div></div>
                <div class="kpi-card"><div class="kpi-title">Multi-Method Splits</div><div class="kpi-value">${multiLegCount}</div></div>
                <div class="kpi-card"><div class="kpi-title">Total Volume</div><div class="kpi-value">${fmt(totalVol)}</div></div>
            </div>

            <div class="okw-card" id="pg-sp-table-host"></div>
        `;

        host.querySelector('#pg-sp-back').onclick = () => switchPosView('till');
        host.querySelector('#pg-sp-new').onclick = () => {
            switchPosView('till');
            openSplitPaymentModal();
        };

        const rows = splits.map(s => {
            const legs = Array.isArray(s.payment_splits) ? s.payment_splits : [];
            const breakdownText = legs.length
                ? legs.map(l => `${String(l.method || 'cash').toUpperCase()}: ${fmt(l.amount)}${l.reference ? ' (' + l.reference + ')' : ''}`).join(' + ')
                : String(s.payment_method || 'split').toUpperCase();
            return {
                id: s.id,
                receipt: s.receipt_number || ('#' + s.id),
                date: new Date(s.created_at).toLocaleString(),
                customer: s.customer_name || 'Walk-in',
                seller: s.seller_name || 'Staff',
                store: s.store_location || '—',
                legs_count: legs.length || 1,
                breakdown: breakdownText,
                total: Number(s.total_amount || 0),
                paid: Number(s.paid_amount || s.total_amount || 0),
                change: Number(s.change_amount || 0)
            };
        });

        OkwUI.dataTable('#pg-sp-table-host', {
            columns: [
                { key: 'receipt', label: 'Receipt #', render: v => `<strong class="mono" style="color:#273990;">${OkwUI.escapeHtml(v)}</strong>` },
                { key: 'date', label: 'Date / Time' },
                { key: 'customer', label: 'Customer' },
                { key: 'seller', label: 'Served By' },
                { key: 'legs_count', label: 'Methods', numeric: true, render: v => `<span class="okw-badge okw-badge-${v > 1 ? 'info' : 'neutral'}">${v} leg${v === 1 ? '' : 's'}</span>` },
                { key: 'breakdown', label: 'Payment Breakdown', render: v => `<span style="font-size:12.5px;">${OkwUI.escapeHtml(v)}</span>` },
                { key: 'total', label: 'Total', numeric: true, render: v => `<strong>${fmt(v)}</strong>` },
                { key: 'paid', label: 'Paid', numeric: true, render: v => fmt(v) },
                {
                    key: 'id',
                    label: 'Receipt',
                    render: (id) => `<a href="/receipt?id=${encodeURIComponent(id)}" class="okw-btn okw-btn-outline" style="padding:4px 10px;min-height:28px;font-size:12px;">View</a>`
                }
            ],
            rows,
            searchPlaceholder: 'Search receipt #, customer, or payment method…',
            exportFilename: 'okwesiwa-split-payments.xlsx',
            emptyText: 'No split payment sales recorded yet.'
        });
    }

    function bindEvents() {
        let timer = null;
        const posSearch = document.getElementById('okw-pos-search');
        posSearch.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => searchProducts(e.target.value), 140);
        });
        posSearch.addEventListener('focus', () => {
            if (posSearch.value.trim()) searchProducts(posSearch.value);
        });
        posSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                collapseSearchResults();
                return;
            }
            if (e.key === 'Enter' && posSearch.value.trim()) {
                e.preventDefault();
                if (typeof window.processScan === 'function') {
                    window.processScan(posSearch.value.trim());
                    posSearch.value = '';
                    collapseSearchResults();
                }
            }
        });

        // Collapse product search & customer dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            const searchWrap = document.getElementById('okw-search-container');
            if (searchWrap && !searchWrap.contains(e.target)) {
                collapseSearchResults();
            }
            const custWrap = document.getElementById('okw-cust-container');
            const custBox = document.getElementById('okw-cust-results');
            if (custWrap && custBox && !custWrap.contains(e.target)) {
                custBox.style.display = 'none';
            }
        });

        const pgSelEl = document.getElementById('okw-price-group');
        if (pgSelEl) pgSelEl.addEventListener('change', (e) => {
            const t = syncTabFromTillCart();
            t.priceGroup = e.target.value;
            t.items.forEach(it => {
                if (it.rawProduct) it.price = resolveUnitPrice(it.rawProduct, t.priceGroup, it.unit_factor, it.qty);
            });
            pushTabStateToTill(t);
            renderAll();
            if (posSearch.value.trim()) searchProducts(posSearch.value);
        });

        document.getElementById('okw-cust-search').addEventListener('input', (e) => searchCustomers(e.target.value));
        document.getElementById('okw-btn-new-cust').onclick = openNewCustomerModal;

        const discBtn = document.getElementById('okw-btn-discount');
        if (discBtn) discBtn.onclick = applyDiscountWithPin;
        const holdBtn = document.getElementById('okw-btn-hold');
        if (holdBtn) holdBtn.onclick = holdCurrentSale;
        const holdsBtn = document.getElementById('okw-btn-holds');
        if (holdsBtn) holdsBtn.onclick = openHoldsModal;
        const quoteBtn = document.getElementById('okw-btn-quote');
        if (quoteBtn) quoteBtn.onclick = saveAsQuotation;
        const syncBtn = document.getElementById('refreshProducts');
        if (syncBtn) syncBtn.addEventListener('click', () => {
            if (posSearch.value.trim()) searchProducts(posSearch.value);
            else OkwUI.toast('Catalog synced', 'success');
        });

        // Bind header POS view switcher (Till / Quotes / Discounts / Splits)
        document.querySelectorAll('#okw-pos-view-nav [data-pos-view]').forEach(btn => {
            btn.addEventListener('click', () => switchPosView(btn.dataset.posView));
        });

        document.getElementById('okw-delivery-toggle').onchange = (e) => {
            activeTab().delivery.enabled = e.target.checked;
            renderAll();
        };
        ['site', 'truck', 'driver', 'fee'].forEach(k => {
            document.getElementById(`okw-del-${k}`).oninput = (e) => {
                const map = { site: 'site_address', truck: 'truck', driver: 'driver', fee: 'fee' };
                activeTab().delivery[map[k]] = k === 'fee' ? (parseFloat(e.target.value) || 0) : e.target.value;
            };
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'F6') { e.preventDefault(); applyDiscountWithPin(); }
            else if (e.key === 'F8') { e.preventDefault(); holdCurrentSale(); }
            else if (e.key === 'F9') { e.preventDefault(); openSplitPaymentModal(); }
            else if (e.key === 'F10') { e.preventDefault(); switchPosView('quotes'); }
        });

        // If navigated from Drafts list ("POS" button: /pos?loadDraft=<id>), load draft directly into the cart
        const draftId = new URLSearchParams(window.location.search).get('loadDraft');
        if (draftId) {
            fetch('/api/pos/holds', { headers: authHeaders() })
                .then(r => (r.ok ? r.json() : {}))
                .then(data => {
                    const h = (data.holds || []).find(x => String(x.id) === String(draftId));
                    if (!h) return;
                    const items = Array.isArray(h.items) ? h.items : (typeof h.items === 'string' ? JSON.parse(h.items || '[]') : []);
                    const t = activeTab();
                    t.items = items.map(it => ({
                        barcode: it.barcode || '',
                        name: it.name || it.barcode || 'Item',
                        qty: Number(it.qty || 1),
                        price: Number(it.price || 0),
                        unit_name: it.unit_name || 'Unit',
                        unit_factor: Number(it.unit_factor || 1)
                    }));
                    t.priceGroup = h.price_group || 'retail';
                    t.discountAmount = Number(h.discount_amount || 0);
                    if (h.customer_name && h.customer_name !== 'Walk-in') {
                        t.customer = { id: h.customer_id || null, name: h.customer_name };
                    }
                    pushTabStateToTill(t);
                    renderAll();
                    OkwUI.toast(`Draft "${h.label || ('#' + h.id)}" loaded into POS`, 'success');
                    try {
                        const clean = new URL(window.location.href);
                        clean.searchParams.delete('loadDraft');
                        window.history.replaceState(null, '', clean);
                    } catch (_) { }
                })
                .catch(() => { });
        }
    }

    document.addEventListener('DOMContentLoaded', mountUpgradeBar);
})(window);
