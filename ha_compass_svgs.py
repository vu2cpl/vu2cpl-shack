"""Generate the compass rose + 16 pre-rotated needle SVGs into HassPi's
config/www/rotator/ (served at /local/rotator/). GitHub-dark palette."""
import math, os

OUT = '/Volumes/config/www/rotator'
os.makedirs(OUT, exist_ok=True)

BG, CARD, BORDER, FG, DIM, RED = '#0d1117', '#161b22', '#30363d', '#e6edf3', '#8b949e', '#f85149'

def pol(r, deg):
    a = math.radians(deg)
    return 200 + r * math.sin(a), 200 - r * math.cos(a)

# ---------- rose ----------
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
         f'<circle cx="200" cy="200" r="196" fill="{BG}" stroke="{BORDER}" stroke-width="2"/>']
for deg in range(0, 360, 10):
    major = deg % 30 == 0
    r1, r2 = (170 if major else 180), 192
    x1, y1 = pol(r1, deg)
    x2, y2 = pol(r2, deg)
    col = DIM if major else BORDER
    w = 2.5 if major else 1.2
    parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                 f'stroke="{col}" stroke-width="{w}"/>')
WINDS8 = [('N', 0), ('NE', 45), ('E', 90), ('SE', 135), ('S', 180),
          ('SW', 225), ('W', 270), ('NW', 315)]
for name, deg in WINDS8:
    x, y = pol(142, deg)
    big = len(name) == 1
    parts.append(f'<text x="{x:.1f}" y="{y + 8:.1f}" text-anchor="middle" '
                 f'font-family="-apple-system,Helvetica,sans-serif" '
                 f'font-size="{26 if big else 17}" font-weight="{700 if big else 500}" '
                 f'fill="{FG if big else DIM}">{name}</text>')
parts.append('</svg>')
open(os.path.join(OUT, 'rose.svg'), 'w').write('\n'.join(parts))

# ---------- needles (16 sectors) ----------
DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
for i, name in enumerate(DIRS):
    deg = i * 22.5
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
<g transform="rotate({deg} 200 200)">
<polygon points="200,62 187,215 213,215" fill="{RED}"/>
<polygon points="200,238 187,215 213,215" fill="{DIM}"/>
</g>
<circle cx="200" cy="200" r="34" fill="{CARD}" stroke="{BORDER}" stroke-width="2"/>
</svg>'''
    open(os.path.join(OUT, f'needle_{name.lower()}.svg'), 'w').write(svg)

print('wrote', len(os.listdir(OUT)), 'files to', OUT)
