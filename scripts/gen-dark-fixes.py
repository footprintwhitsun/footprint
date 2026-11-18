# Regenerates dark-fixes.css from the hard-coded light colours in the pages. Run: python3 scripts/gen-dark-fixes.py .
import re, glob, colorsys, os, sys
root = sys.argv[1]
os.chdir(root)

SKIP_PAGES = {'receipt.html', 'customer-display.html', 'login.html', 'forgot-password.html',
              'reset-password.html', 'privacy.html', 'terms.html', 'help.html'}
files_html = [f for f in sorted(glob.glob('*.html')) if f not in SKIP_PAGES]
files_js = ['layout.js', 'ui-components.js', 'pos-upgrade.js']
files_css = ['tokens.css', 'sidebar.css']

HEX = r'#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?'

def parse(c):
    c = c.strip().lower()
    if c == 'white':
        return (255, 255, 255)
    h = c[1:]
    if len(h) == 3:
        h = ''.join(x * 2 for x in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def lum(rgb):
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def hsv(rgb):
    return colorsys.rgb_to_hsv(*(v / 255 for v in rgb))

def bg_category(c):
    """None when the colour is not a light surface; else neutral/ok/bad/warn/info."""
    rgb = parse(c)
    if lum(rgb) < 0.62:
        return None
    h, s, v = hsv(rgb)
    if s < 0.10:
        return 'neutral'
    deg = h * 360
    if deg < 20 or deg >= 320:
        return 'bad'
    if deg < 70:
        return 'warn'
    if deg < 170:
        return 'ok'
    return 'info'

def text_category(c):
    """dark neutral text that vanishes on a dark surface."""
    rgb = parse(c)
    h, s, v = hsv(rgb)
    L = lum(rgb)
    if s > 0.45:
        return None
    if L < 0.06:
        return 'ink'
    if L < 0.40:
        return 'muted'
    return None

BG = {
    'neutral': ('var(--sheet-2)', 'var(--ink)'),
    'ok': ('var(--ok-bg)', 'var(--ok)'),
    'bad': ('var(--bad-bg)', 'var(--bad)'),
    'warn': ('var(--warn-bg)', 'var(--warn)'),
    'info': ('var(--info-bg)', 'var(--info)'),
}
TXT = {'ink': 'var(--ink)', 'muted': 'var(--muted)'}

texts = {}
for f in files_html + files_js + files_css:
    texts[f] = open(f, encoding='utf-8', errors='ignore').read()

# ---------- inline values (style="...") ----------
inline_bg = {}   # value(lower) -> category
inline_fg = {}
for f in files_html + files_js:
    for m in re.finditer(r'background(?:-color)?\s*:\s*(' + HEX + r'|white)\b', texts[f], re.I):
        c = m.group(1).lower()
        cat = bg_category(c)
        if cat:
            inline_bg[c] = cat
    for m in re.finditer(r'(?<![-\w])color\s*:\s*(' + HEX + r')\b', texts[f], re.I):
        c = m.group(1).lower()
        cat = text_category(c)
        if cat:
            inline_fg[c] = cat

def attr_bg(c):
    out = []
    for prop in ('background', 'background-color'):
        for sp in ('', ' '):
            out.append('[style*="%s:%s%s" i]' % (prop, sp, c))
    return out

def attr_fg(c):
    out = []
    for sp in ('', ' '):
        out.append('[style^="color:%s%s" i]' % (sp, c))
        out.append('[style*=";color:%s%s" i]' % (sp, c))
        out.append('[style*="; color:%s%s" i]' % (sp, c))
        out.append('[style*=" color:%s%s" i]' % (sp, c))
    return out

# ---------- class rules from <style> blocks and css files ----------
def strip_media_print(css):
    out, i = [], 0
    while True:
        j = css.find('@media print', i)
        if j < 0:
            out.append(css[i:])
            break
        out.append(css[i:j])
        k = css.find('{', j)
        depth, p = 1, k + 1
        while depth and p < len(css):
            if css[p] == '{':
                depth += 1
            elif css[p] == '}':
                depth -= 1
            p += 1
        i = p
    return ''.join(out)

def style_blocks(f):
    t = texts[f]
    if f.endswith('.css'):
        return [t]
    return re.findall(r'<style[^>]*>(.*?)</style>', t, re.S | re.I)

rule_bg = {}   # selector -> category
rule_fg = {}
BADSEL = re.compile(r'^\d+%|^(from|to)$|\.sidebar|\bimg\b|\.brand|:hover|:focus|:active|::|@|print|\[data-theme|^\s*(html|body|:root)\s*$|\bprint\b|\.receipt|invoice-print|\.okw-', re.I)
DECL_BG = re.compile(r'(?<![-\w])background(?:-color)?\s*:\s*(' + HEX + r'|white)\s*(?:!important)?\s*(?:;|$)', re.I)
DECL_FG = re.compile(r'(?<![-\w])color\s*:\s*(' + HEX + r')\s*(?:!important)?\s*(?:;|$)', re.I)

for f in files_html + files_css:
    for blk in style_blocks(f):
        blk = re.sub(r'/\*.*?\*/', '', blk, flags=re.S)
        blk = strip_media_print(blk)
        for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', blk):
            sel, body = m.group(1).strip(), m.group(2)
            if not sel or sel.startswith('@'):
                continue
            bgm = DECL_BG.search(body)
            fgm = DECL_FG.search(body)
            sels = [s.strip() for s in sel.split(',') if s.strip()]
            for s in sels:
                if BADSEL.search(s):
                    continue
                if bgm:
                    cat = bg_category(bgm.group(1))
                    if cat:
                        rule_bg[s] = cat
                if fgm:
                    cat = text_category(fgm.group(1))
                    if cat:
                        rule_fg[s] = cat

# ---------- emit ----------
P = '[data-theme="dark"] '
out = []
out.append('/* Generated dark-mode fixes. Loaded by layout.js only when the theme is dark.\n'
           '   Re-map hard-coded light surfaces and dark text (inline and in page styles) to the theme tokens. */\n')

def is_header_sel(s):
    last = re.split(r'[\s>+~]+', s.strip())[-1]
    return bool(re.match(r'^(thead|th)\b', last)) or 'thead' in s

# 1. dark text first, so surface rules (below) win on ties
for key, val in TXT.items():
    sels = []
    for c, cat in sorted(inline_fg.items()):
        if cat == key:
            sels += [P + a for a in attr_fg(c)]
    if sels:
        out.append(',\n'.join(sels) + ' { color: %s !important; }\n' % val)
    sels = sorted({P + s for s, cat in rule_fg.items() if cat == key})
    if sels:
        out.append(',\n'.join(sels) + ' { color: %s; }\n' % val)

# 2. surfaces
for cat, (bgv, fgv) in BG.items():
    sels = []
    for c, k in sorted(inline_bg.items()):
        if k == cat:
            sels += [P + a for a in attr_bg(c)]
    hdr = sorted({P + s for s, k in rule_bg.items() if k == cat and is_header_sel(s)})
    body = sorted({P + s for s, k in rule_bg.items() if k == cat and not is_header_sel(s)})
    if sels:
        out.append(',\n'.join(sels) + ' { background: %s !important; color: %s !important; border-color: var(--edge) !important; }\n' % (bgv, fgv))
    if body:
        out.append(',\n'.join(body) + ' { background: %s; color: %s; border-color: var(--edge); }\n' % (bgv, fgv))
    if hdr:
        out.append(',\n'.join(hdr) + ' { background: transparent; color: var(--muted); border-color: var(--edge); }\n')

# 3. table headers always readable
out.append('''
[data-theme="dark"] table thead,
[data-theme="dark"] table thead tr,
[data-theme="dark"] table thead th,
[data-theme="dark"] table th,
[data-theme="dark"] .table th,
[data-theme="dark"] .data-table th { background: transparent !important; color: var(--muted) !important; border-color: var(--edge) !important; }
[data-theme="dark"] table tfoot td, [data-theme="dark"] table tfoot th { background: var(--sheet-2) !important; color: var(--ink) !important; }
''')

open('dark-fixes.css', 'w').write('\n'.join(out))
print('inline bg colours:', len(inline_bg), 'inline fg:', len(inline_fg), 'rule bg selectors:', len(rule_bg), 'rule fg:', len(rule_fg))
print('bytes', os.path.getsize('dark-fixes.css'))
