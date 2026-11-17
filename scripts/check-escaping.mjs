// Fails when a page template writes a user-controlled field (a name, note, address...) into HTML without
// escaping it. Parses each page's inline scripts with acorn. Run: node scripts/check-escaping.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import * as acorn from 'acorn';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = new Set(['name','customer_name','supplier_name','description','notes','note','reason','email','address','brand','category','cashier_name','cashier','teller','created_by_name','branch','store_location','location','contact_person','company_name','phone','title','message','label','username','full_name','employee_id','reference_no','barcode','unit','sku','display_name','customer','item','details','product_name','client_name','manager','staff_name','approver_name','receipt_number','selling_unit','supplier','payment_method_label']);
const mode = 'scan';
function walk(node, cb) { if (!node || typeof node.type !== 'string') return; cb(node); for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, cb)); else if (v && typeof v.type === 'string') walk(v, cb); } }
const isField = (e) => e.type === 'MemberExpression' && !e.computed && e.property.type === 'Identifier' && FIELDS.has(e.property.name);
const IDENT = /^(name|customerName|productName|supplierName|clientName|userName|staffName|description|desc|notes?|reason|email|address|brand|category|phone|title|message|label|username|cashier|teller|branch|location|customer|supplier|company|contact|manager|reference|barcode|unit|sku)$/i;
function candidate(e) {
  if (e.type === 'Identifier' && IDENT.test(e.name)) return true;
  if (isField(e)) return true;
  if (e.type === 'LogicalExpression' && (e.operator === '||' || e.operator === '??') && (isField(e.left) || (e.left.type === 'LogicalExpression' && isField(e.left.left)))) return e.right.type === 'Literal' || e.right.type === 'TemplateLiteral' || isField(e.right);
  return false;
}
const totals = {}; let all = 0;
for (const f of fs.readdirSync(ROOT).filter(x => x.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hasUi = /ui-components\.js/.test(html);
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m; let count = 0; const edits = [];
  while ((m = re.exec(html))) {
    const code = m[1]; const base = m.index + m[0].indexOf('>') + 1;
    if (!code.trim()) continue;
    let ast; try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); } catch (e) { continue; }
    walk(ast, (n) => {
      if (n.type !== 'TemplateLiteral') return;
      if (!n.quasis.some(q => q.value.raw.includes('<'))) return;
      for (const e of n.expressions) if (candidate(e)) { count++; edits.push({ start: base + e.start, end: base + e.end }); }
    });
  }
  if (count) { totals[f] = { count, hasUi }; all += count; }
  if (mode === 'apply' && edits.length && hasUi) {
    edits.sort((a, b) => b.start - a.start); let out = html;
    // drop nested edits (an edit inside another edit's range)
    const keep = []; for (const e of edits) if (!keep.some(k => e.start >= k.start && e.end <= k.end && !(e.start === k.start && e.end === k.end))) keep.push(e);
    for (const e of keep) { const src = out.slice(e.start, e.end); out = out.slice(0, e.start) + 'OkwUI.escapeHtml(' + src + ')' + out.slice(e.end); }
    fs.writeFileSync(path.join(ROOT, f), out); 
  }
}
if (all) {
  console.error('Unescaped data is written into page templates. Wrap each value in OkwUI.escapeHtml(...):');
  for (const [f, v] of Object.entries(totals)) console.error(`  ${f}: ${v.count}`);
  process.exit(1);
}
console.log('check-escaping: no unescaped name, note, address or similar fields in page templates.');
