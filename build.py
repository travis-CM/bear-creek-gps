import json, math, concurrent.futures as cf, urllib.request, os, sys

d = json.load(open('osm.json'))
els = d['elements']

def P(e, n=6): return [[round(p['lat'], n), round(p['lon'], n)] for p in e['geometry']]

LAT0 = 32.86
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def xy(p): return ((p[1] + 97.06) * KX, (p[0] - LAT0) * KY)
def dist(a, b):
    ax, ay = xy(a); bx, by = xy(b); return math.hypot(ax - bx, ay - by)
def seg_d(p, a, b):
    px, py = xy(p); ax, ay = xy(a); bx, by = xy(b)
    dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)
def line_d(p, l): return min(seg_d(p, l[i], l[i + 1]) for i in range(len(l) - 1))
def poly_d(poly, l): return min(line_d(p, l) for p in poly)
def centroid(poly):
    return [sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)]
def inside(p, poly):
    x, y = p[1], p[0]; c = False; j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][1], poly[i][0]; xj, yj = poly[j][1], poly[j][0]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
        j = i
    return c

holes = [e for e in els if e['tags'].get('golf') == 'hole']
greens = [P(e) for e in els if e['tags'].get('golf') == 'green']
tees = [P(e, 6) for e in els if e['tags'].get('golf') == 'tee']
bunkers = [P(e) for e in els if e['tags'].get('golf') == 'bunker']
water = [P(e, 6) for e in els if e['tags'].get('golf') in ('water_hazard', 'lateral_water_hazard') or e['tags'].get('natural') == 'water']
fairways = [P(e, 5) for e in els if e['tags'].get('golf') == 'fairway']

SC = {
 'West': {'hcp': [17,5,3,7,15,9,1,13,11,8,4,16,2,14,10,12,18,6],
          'par': [4,4,4,5,3,5,4,3,4,5,4,4,4,3,5,4,3,4],
          'tees': {'Black': [370,385,430,505,185,525,390,190,380,526,420,377,372,180,503,358,178,403],
                   'Blue':  [350,350,409,490,170,505,366,170,358,500,399,346,349,144,485,338,160,382],
                   'Silver':[330,304,335,425,142,445,320,142,335,457,335,346,321,161,442,306,117,355],
                   'Red':   [330,304,335,425,142,445,320,142,335,457,335,325,321,134,442,306,117,355]},
          'rating': {'Black': '73.7 / 140', 'Blue': '71.5 / 137 · W 77.6 / 143', 'Silver': '67.9 / 123 · W 74.3 / 136', 'Red': '67.7 / 122 · W 73.9 / 135'},
          'notes': {6: 'Blind tee shot; approach over water.', 7: 'Often called the hardest hole: plays into the prevailing wind with water.', 17: 'Signature hole along the lake.'},
          'blurb': 'Ted Robinson design (1980). Demanding front nine (6 & 7 stand out); back nine opens up. Bermuda fairways.'},
 'East': {'hcp': [7,1,15,9,5,13,17,3,11,8,14,12,6,16,2,4,18,10],
          'par': [5,4,3,5,4,4,3,4,4,5,4,4,4,3,4,5,3,4],
          'tees': {'Black': [528,416,175,520,385,372,166,418,402,510,365,344,384,189,423,515,175,383],
                   'Blue':  [509,392,165,505,360,350,144,380,375,493,355,331,370,165,381,487,152,368],
                   'Silver':[461,340,143,441,360,300,123,348,347,449,338,304,320,137,344,444,126,368],
                   'Red':   [461,340,143,441,318,300,123,348,347,449,338,304,320,137,344,444,126,337]},
          'rating': {'Black': '73.6 / 139', 'Blue': '72.0 / 134 · W 78.6 / 143', 'Silver': '69.3 / 128 · W 75.1 / 132', 'Red': '69.0 / 126 · W 74.7 / 131'},
          'notes': {},
          'blurb': 'Ted Robinson design. Considered a touch harder than the West: tighter fairways, smaller greens, 14 of 18 holes dogleg — a target course.'},
}

out = {'courses': {}}
used_bunk = set()
for cname in ('West', 'East'):
    hs = sorted([h for h in holes if h['tags'].get('golf:course:name') == cname], key=lambda h: int(h['tags']['ref']))
    arr = []
    for h in hs:
        r = int(h['tags']['ref']); l = P(h)
        end = l[-1]; start = l[0]
        g = min(greens, key=lambda gp: 0 if inside(end, gp) else min(dist(end, p) for p in gp))
        tb = [t for t in tees if min(dist(start, p) for p in t) < 120 and line_d(centroid(t), l) < 60]
        # keep tees closer to this hole's start than to its green
        tb = [t for t in tb if dist(centroid(t), start) < dist(centroid(t), end)]
        hz = []
        def owner_ok(poly):
            # hazard belongs to the hole whose line/green it is closest to (ties within 8 m allowed)
            dmine = min(poly_d(poly, l), min(dist(p, centroid(g)) for p in poly))
            best = 1e9
            for oh in holes:
                ol = P(oh)
                og = min(greens, key=lambda gp: 0 if inside(ol[-1], gp) else min(dist(ol[-1], p) for p in gp))
                best = min(best, poly_d(poly, ol), min(dist(p, centroid(og)) for p in poly))
            return dmine <= best + 8
        for b in bunkers:
            if (poly_d(b, l) < 40 or min(dist(p, centroid(g)) for p in b) < 35) and owner_ok(b):
                hz.append({'t': 'b', 'p': b})
        for w in water:
            if poly_d(w, l) < 45: hz.append({'t': 'w', 'p': w})
        fw = [f for f in fairways if poly_d(f, l) < 15]
        arr.append({'n': r, 'par': SC[cname]['par'][r-1], 'hcp': SC[cname]['hcp'][r-1],
                    'yds': {t: SC[cname]['tees'][t][r-1] for t in SC[cname]['tees']},
                    'line': l, 'green': g, 'tees': tb, 'hz': hz, 'fw': fw,
                    'note': SC[cname]['notes'].get(r, ''),
                    'osmPar': int(h['tags'].get('par', 0))})
        if arr[-1]['osmPar'] != arr[-1]['par']: print('PAR MISMATCH', cname, r, file=sys.stderr)
    out['courses'][cname] = {'holes': arr, 'rating': SC[cname]['rating'], 'blurb': SC[cname]['blurb']}

# ---- elevation raster (USGS 3DEP) -> dem.bin (uint16 cm above 130 m, row 0 = north) ----
from PIL import Image
import numpy as np
W=660
a=np.array(Image.open('dem.tif'),dtype=np.float32)
im=Image.fromarray(a).resize((W,W),Image.BILINEAR)
b=np.array(im,dtype=np.float32)
cm=np.clip(np.round((b-130.0)*100),0,65535).astype('<u2')
cm.tofile('dem.bin')
out['dem']={'n':32.875,'s':32.845,'w':-97.075,'e':-97.040,'cols':W,'rows':W,'base':130.0,'scale':0.01,'units':'m'}
print('dem', b.min(), b.max(), file=sys.stderr)
json.dump(out, open('course.json', 'w'), separators=(',', ':'))
print('course.json', os.path.getsize('course.json'), file=sys.stderr)
