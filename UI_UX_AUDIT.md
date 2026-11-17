# UI/UX audit and redesign: CEO, company, manager and teller portals

Date: 2026-11-15. Method: pages rendered in headless Chrome against a **mock API** (the real server was never started, because `.env` points at the live Supabase database). Data shapes in the mock are guesses, so anything that depended on a guessed shape is marked "mock artefact" and is not listed as a bug.

Backups of every file touched: scratchpad `backup-all/` (session only). Nothing is committed; the working tree already had 55 uncommitted files before this work.

## A. Bugs found

### High
| ID | Where | Problem | Status |
|---|---|---|---|
| B-01 | `pos.html` + `pos-upgrade.js` | **F2 and F4 fire twice.** The till binds F2 to MoMo payment and F4 to credit payment; `pos-upgrade.js` binds the same keys to "focus search". Pressing F2 to search starts a MoMo payment. | Fixed: F1 to F5 left to the till only |
| B-02 | `pos-upgrade.js` | A **second full register** (own tabs, cart, "Pay (F9)") was injected above the till header. Two carts, two pay buttons. | Mitigated: now a closed panel under the header; F6/F8/F9/F10 only act while it is open. **Open decision:** the two carts are still separate |
| B-03 | `layout.js` | **Company users get the cashier menu.** Login stores `companyUser`, layout reads only `currentUser`, so the role defaults to `cashier` and the company nav is replaced with POS Till, Open Shift, etc. (which `auth-guard` then blocks). | Fixed |
| B-04 | `dashboard.html` | Low-stock alert was a blocking pop-up, and dismissing it stored `'true'` forever. **After one click the manager is never warned again.** | Fixed: inline notice; a dismissal covers today and today's counts only |
| B-05 | `company-portal.html` | **Invented figures shown as real:** "up 14.2% vs last month", "down 2.1% improvement" and sparkline paths are static HTML. | Removed |
| B-06 | `ceo-portal.html` | "Sales Forecast" insight is hard-coded (`// Mock Forecast`): "projected ₵62,000, exceeding the target by 24%", contradicting the target card. | Replaced with a computed target-progress line |
| B-07 | `ceo-portal.html` | One `try/catch` around all dashboard loaders: a null `payment_method` (`.toUpperCase()`) stopped the trend chart, branches and people from loading. | Fixed: guard + each widget isolated |
| B-08 | `layout.js` | Top-bar branch switcher saves `okwesiwa_active_branch` and fires `okw:branch-changed`; **nothing in the project reads either.** Dead control (and a duplicate of the CEO "All Branches" filter). | Removed from the top bar. Re-add when pages support it |

### Medium
| ID | Where | Problem | Status |
|---|---|---|---|
| B-09 | `ceo-portal.html` | Duplicate IDs `newTaxName`, `newTaxRate`, `taxList` (a dead tax modal duplicated the tab; `openTaxModal` has no caller). | Dead modal removed |
| B-10 | `ceo-portal.html` | Card titled "Monthly Revenue Target" showed revenue as the big figure. | Relabelled "Revenue this month" |
| B-11 | `ceo-portal.html` | Target fell back to a hard-coded `50000` (3 places). | Fixed: shows "No target set" instead |
| B-12 | `ceo-portal.html` | "Expenses are 31.000000000000004% ..." (`toFixed(2) * 100`) and an unsourced "industry standard ~20%" claim. | Fixed |
| B-13 | `layout.js` | On phones the top-bar menu button toggled `.collapsed`, which does nothing off-canvas, so pages showed **two hamburgers** and only the page one worked. | Fixed |
| B-14 | `layout.js` | `defaultLogout` left `companyToken` / `companyUser` in storage. | Fixed |
| B-15 | `company-portal.html` | Activity log rendered "Invalid Date" and "#undefined" when fields were missing; tax report `.map` on a non-array. | Fixed with fallbacks |
| B-16 | `ceo-portal.html` | Chart.js loaded from an **unpinned** CDN URL (`npm/chart.js`). | Pinned to 4.4.1 (no SRI added) |
| B-17 | CEO, company, till at 390px | Content clipped on the right; search icon over the placeholder. | Fixed |
| B-18 | `customers.html` at 390px | Table wider than the screen. | Fixed by the skin's scroll rule; re-check |

### Low (all handled)
- Script lookups of IDs that don't exist on the page (`riskTableBody`, `peopleTableBody`, `kr-*`, `salesSubtotal`, `productGrid`, `shelf*`): each calling function now returns early if its section is absent.
- Company PDF export loaded a missing `logo.png`: now rasterises `okwesiwa-logo.svg` onto a canvas for jsPDF.
- `Times New Roman` removed from the Google Fonts URL; duplicate `preconnect` removed from `dashboard.html`; placeholder email replaced.
- CEO charts: rainbow/amber palettes replaced with one steel hue plus greys (cost grey, operating expenses brick).
- Shared `kpiCard()` in `ui-components.js` (live CEO, reports, backups) no longer draws coloured top rules or uppercase labels.
- Nav items had different heights per page (34 to 46px): now 34px everywhere. Settings sheet was capped at 900px: now full width.
- Fixed regression I introduced: the company-nav exemption in `layout.js` also stopped the manager inventory page from getting the shared nav; it now applies to company users only.

### Closed in the final round
- **Two carts on the till:** the two registers have different data models (unit conversion, price groups, delivery, PIN discounts, split payments), so they were not merged. They are now mutually exclusive: the advanced panel will not open while the till holds a sale, and the till refuses new items while the panel holds one. Merging them remains a possible future feature.
- Stray colours `#f9a51a`, `#273990` and related hexes replaced with the token colours in `sidebar.css` and `pos.html`.
- 27 `transition: all` rules now name their properties; 90 resting shadows removed from page CSS (menus, modals and pop-ups keep theirs); backdrop blur and monospace type removed; the last gradient (sidebar avatar) flattened.
- Promotional text removed from the till's scrolling footer.

## B. Redesign: "framed sheet"

Direction (dealt with the design skill, seed 381332258): one stone-tinted frame (`#F4F2EE`) holds the sidebar and a 48px top bar; the work sits on a white sheet inset 8px, 1px edge, 16px corners, no shadow. IBM Plex Sans. Steel `#1F3A60` for the one primary action, brick `#B4531A` only for focus and small marks, one chart hue `#2B5C9E`. Dark mode supported.

- `portal-skin.css` (new, 34 pages): shell, flat KPI strip (one container, equal cells, no icon chips, no sparklines), quiet tables, pale status pills, flat buttons, modals without blur, phone layout (frame disappears, KPI strip becomes 2 columns).
- Teller: light header, closed advanced panel, search field fixed.
- Nav labels shortened and set in sentence case; group labels no longer uppercase.
- Gradients flattened (27) and UI emoji removed (29) on the portal pages.

Lint on the 7 main portal pages: **60 FAIL to 0 FAIL, 219 WARN to 89 WARN**.

## C. Final sweep (all shell pages)
Rendered every page that carries the skin in light at 1440 and 390 (no horizontal overflow), key pages in dark mode, and checked for hard-coded white panels in dark mode.

Additional bugs found and fixed in the sweep:
- `profile.html`: any role other than admin, cashier or teller was redirected to login, so managers, store managers and the CEO could not open "My profile"; the back button sent a CEO through the cashier shift check. Now any signed-in role may open it and Back goes to the role's own home.
- `transactions.html`: "Back to Register" link was invisible on the new light header; "Started at Invalid Date" when the shift had no start time.
- `negative-stock.html`: crashed with "Cannot read properties of undefined (reading 'negative_items')" when the API returned no summary.
- `bulk-upload.html`: emoji in title and messages, amber button with black text, file box wider than its card.
- Dark mode: logo wordmark vanished on the dark frame, CEO insight cards stayed white, target card lost contrast, several pages hard-coded white panels (settings, locations, promotions, categories, profitability, tax management). All fixed.
- Regression I introduced and fixed: a standalone-page rule shrank the manager dashboard's figures to 13px.
- Print: the app frame (sidebar, top bar, sheet border) is hidden when printing.
- `suppliers.html` and `purchase-orders.html` are redirect stubs to `/inventory`, not bugs.

## D. Final round: accessibility and remaining pages
- Automated scan (names, labels, alt text, headings, targets) across about 25 pages; fixed: unlabeled date and branch filters (CEO), till search/promo fields, pagination buttons (transactions, promotions), logo `alt` missing on 11 pages, and unlabeled report filters.
- `layout.js` now gives every page one level-1 heading (pages titled with an h2 get `role="heading" aria-level="1"`) and names any unlabeled form control from its placeholder, title or id.
- Real Tab-key test on the till, dashboard and CEO portal: every control shows the 2px focus outline; no positive tabindex values.
- Tables in narrow CEO cards were clipped on the right; they now scroll inside the card.
- Pages `login`, `forgot-password`, `reset-password`, `customer-display`, `receipt` and `payment` keep their own designs on purpose (public, customer-facing or print/checkout screens). Their gradients were flattened; they render correctly.

## E. Real-data and screen-reader pass
Method: a throwaway local Postgres 18 cluster (separate data directory) and the real `server.js` run from a copy of the project **with no `.env`**, so the live Supabase credentials could not load. Seeded 3,003 products, 600 customers, 8,000 transactions over 90 days, plus hostile rows (`<script>` and `<img onerror>` names, 250-character names, Unicode, negative and zero stock). Driven with a real login and real tokens.

Held up: transactions page (2,617 rows, paged), till product search over 3,000 products, all HTML escaped (no `alert()` fired from any hostile row), no horizontal overflow, 0 console errors and 0 HTTP errors on 10 pages.

Found and fixed with real data:
- `customers.html` was a placeholder: one hard-coded "Walk-in Customer" row with the literal text `${formatCurrency(1250)}`, never loaded the 600 customers. Now loads `/api/customers` with search, 50-per-page paging and escaped output.
- `GET /api/transfers` returned 500 on databases built by `init_db_and_users.js` (`transfer_date` column missing; `stock_transfers` is defined three different ways across setup scripts). Server start now adds the column.
- **My regression:** the "section not on this page" guard in `loadPeople` ran before the headcount update, so headcount stayed 0. Fixed.
- **My regression:** a standalone-page CSS rule turned the till's Cash, Card and Credit buttons all navy. Scoped away from the till.
- The till scrolled sideways because the footer ticker was wider than the screen.
- "Company Revenue" on the CEO page is the all-time total of trade-account invoices, not company revenue. Relabelled.
- The CEO target silently defaulted to 50,000 server-side (progress read 100%, "passed target by 1.5M"). The server fallback is now 0; **the database column default is still 50,000, so set the real target via Edit.**
- Net profit assumes COGS = 70% of revenue (`server.js`, fixed constant). Now labelled as an estimate. **Open:** compute from real `cost_price`.
- Error states (database stopped under the running server): the manager dashboard showed zeros that looked like a quiet day; the CEO page kept a green "Live Sync" and "Analyzing Data... Please wait" forever and showed "0 branches". Now dashes, a visible error with "Try again", "Sync failed / figures not current", and honest insight text. The sync timestamp no longer advances on failure.
- A fresh install fails at startup ("relation users does not exist") until `init_db_and_users.js` is run; `initialize_complete_database.js` forces SSL and fails against a local database.

Screen reader (browser accessibility tree; no spoken-output test was possible here):
- No page had a `main` or `navigation` landmark; added both, a banner, and a "Skip to main content" link.
- KPI figures were exposed as headings and card titles were not headings; fixed (card titles are level-2 headings, figures plain text). The CEO page now has a proper h1 and nine h2 sections.
- Modals now announce as dialogs, move focus in, keep Tab inside, close on Esc and return focus. Toasts and notifications are live regions.

Still open: a listening test with VoiceOver or NVDA; the inventory page's in-page tabs; dynamic modals built in `pos-upgrade.js` (no dialog role or focus trap); computing net profit from real costs; and the `.env` credentials (left out at your request).
