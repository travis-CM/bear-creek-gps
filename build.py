import json, math, concurrent.futures as cf, urllib.request, os, sys

d = json.load(open('osm.json'))
els = d['elements']
if os.path.exists('water.json'):  # OSM waterways (creeks/streams), fetched best-effort by the workflow
    els = els + json.load(open('water.json')).get('elements', [])

def P(e, n=6):
    g = e.get('geometry')
    if g is None:  # multipolygon relation: use its largest outer ring
        outs = [m['geometry'] for m in e.get('members', []) if m.get('role') == 'outer' and m.get('geometry')]
        g = max(outs, key=len) if outs else []
    return [[round(p['lat'], n), round(p['lon'], n)] for p in g]

LAT0, LON0 = 32.86, -97.06
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def set_origin(lat, lon):
    global LAT0, LON0, KX
    LAT0, LON0 = lat, lon; KX = 111320 * math.cos(math.radians(LAT0))
def xy(p): return ((p[1] - LON0) * KX, (p[0] - LAT0) * KY)
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
# Bunkers visible in Esri World Imagery but missing from OpenStreetMap (hazard audit, Nov 2026):
EXTRA_BUNKERS = [
    # East 18, left of the green (~127 m2), traced from satellite imagery
    [[32.86191, -97.056803], [32.86191, -97.056777], [32.861896, -97.05676], [32.861883, -97.05675], [32.861865, -97.056739], [32.861833, -97.056739], [32.861819, -97.056755], [32.861797, -97.056862], [32.861797, -97.056868], [32.861801, -97.056879], [32.861806, -97.056884], [32.861815, -97.056889], [32.861824, -97.056889], [32.861842, -97.056884], [32.861869, -97.056868], [32.861887, -97.056852], [32.861892, -97.056846]],
]
bunkers += EXTRA_BUNKERS
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
 'Hogan': {'hcp': [1, 5, 13, 7, 15, 3, 11, 17, 9, 4, 8, 18, 12, 6, 14, 2, 16, 10],
          'par': [5, 4, 4, 4, 3, 5, 4, 3, 4, 5, 4, 3, 4, 4, 4, 5, 3, 4],
          'tees': {"Blue": [521, 404, 414, 379, 194, 526, 441, 210, 425, 588, 400, 194, 418, 400, 448, 525, 194, 379], "Copper": [521, 377, 378, 379, 174, 526, 409, 163, 392, 526, 361, 168, 381, 400, 414, 525, 175, 379], "White": [494, 377, 351, 350, 148, 492, 409, 163, 392, 526, 361, 168, 362, 372, 339, 491, 175, 348], "Gold": [444, 325, 351, 316, 148, 492, 328, 110, 338, 496, 315, 152, 362, 372, 339, 491, 153, 348], "Silver": [444, 325, 286, 316, 119, 423, 328, 110, 338, 496, 315, 152, 339, 343, 318, 404, 153, 332]},
          'rating': {"Blue": "74.1 / 133", "Copper": "72.3 / 130", "White": "71.1 / 128", "Gold": "68.4 / 125", "Silver": "66.9 / 122"},
          'notes': {},
          'blurb': "Ben Hogan's only course design (with Joe Lee, 1975). Strategic lines, elevated back-to-front greens, creek and ponds in play; par 5s at 1, 6, 10 and 16."},
 'Whitworth': {'hcp': [12, 8, 16, 14, 4, 6, 2, 18, 10, 3, 7, 5, 15, 9, 1, 11, 17, 13],
          'par': [4, 4, 3, 4, 5, 4, 5, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4],
          'tees': {"Blue": [394, 402, 158, 403, 610, 388, 520, 212, 362, 517, 408, 419, 205, 560, 370, 427, 177, 460], "Copper": [394, 370, 127, 387, 557, 388, 520, 174, 336, 517, 375, 370, 167, 560, 339, 393, 177, 396], "White": [364, 370, 117, 372, 557, 343, 488, 149, 305, 487, 375, 349, 167, 528, 320, 393, 125, 396], "Gold": [364, 304, 117, 348, 512, 343, 488, 134, 305, 487, 276, 318, 130, 528, 296, 335, 125, 327], "Silver": [289, 304, 95, 348, 463, 306, 436, 134, 277, 419, 276, 286, 130, 447, 276, 335, 92, 327], "Junior": [224, 208, 84, 199, 370, 190, 309, 107, 188, 298, 224, 172, 99, 270, 65, 237, 89, 202]},
          'rating': {"Blue": "74.0 / 135", "Copper": "72.0 / 130", "White": "70.4 / 126", "Gold": "68.3 / 122", "Silver": "66.3 / 115", "Junior": "59.8 / 100"},
          'notes': {},
          'blurb': "Arthur Hills design (1975), named in 2008 for LPGA legend Kathy Whitworth. Tree-lined fairways, bunkered greens, natural water; the par-5 5th is the longest hole (610 from the Blue)."},
}


# ---- creeks / streams (OSM waterway lines) -> corridor polygons clipped to the stretch near each hole ----
def inv(x, y): return [round(y / KY + LAT0, 6), round(x / KX + LON0, 6)]
def densify(l, step=8.0):
    out = [l[0]]
    for a, b in zip(l, l[1:]):
        n = max(1, int(dist(a, b) // step))
        for k in range(1, n + 1): out.append([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n])
    return out
def corridor(run, hw=3.5):
    m = [xy(p) for p in run]; L_, R_ = [], []
    for i in range(len(m)):
        a = m[max(0, i - 1)]; b = m[min(len(m) - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]; n = math.hypot(tx, ty) or 1
        nx, ny = -ty / n, tx / n
        L_.append(inv(m[i][0] + hw * nx, m[i][1] + hw * ny)); R_.append(inv(m[i][0] - hw * nx, m[i][1] - hw * ny))
    return L_ + R_[::-1]
WATERWAYS = ('stream', 'river', 'canal', 'drain', 'ditch')
waterlines = [densify(P(e)) for e in els if e['tags'].get('waterway') in WATERWAYS and not e['tags'].get('tunnel') and not e['tags'].get('culvert') and 'geometry' in e]
print('waterway lines', len(waterlines), file=sys.stderr)
wl_types = [e['tags'].get('waterway') for e in els if e['tags'].get('waterway') in WATERWAYS and not e['tags'].get('tunnel') and not e['tags'].get('culvert') and 'geometry' in e]
def covered_by_water(pt):
    return any(inside(pt, w) or min(dist(pt, q) for q in w) < 6 for w in water)

out = {'courses': {}}
used_bunk = set()
def build_course(cname, hs, club):
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
            # shared hazards: a bunker between two holes is listed on every hole it is near (no exclusive owner)
            dline = poly_d(b, l); dg = min(dist(p, p2) for p in b for p2 in g)
            # greenside bunkers of a *different* green don't play on this hole unless they are right on its line/green
            oth = min(dist(p, p2) for og in greens if og is not g for p in b for p2 in og)
            if (dline < 45 or dg < 40) and not (oth < 35 and dline >= 25 and dg >= 25):
                hz.append({'t': 'b', 'p': b})
        for w in water:
            if poly_d(w, l) < 45: hz.append({'t': 'w', 'p': w})
        # creek corridors: runs of waterway vertices within 55 m of this hole's line that no mapped water polygon already covers
        cr_full = []
        for wi, wl in enumerate(waterlines):
            run = []; touched = any(line_d(pt, l) < 55 for pt in wl)  # creek is a hazard on this hole
            for pt in wl + [None]:
                if pt is not None and line_d(pt, l) < 55 and not covered_by_water(pt): run.append(pt); continue
                if len(run) >= 3: hz.append({'t': 'w', 'p': corridor(run), 'creek': 1})
                run = []
            if touched:  # draw only the stretch that fills this hole's map view (~220 m around the hole), not the whole creek
                run = []; hw = 6.0 if wl_types[wi] == 'river' else 3.5
                for pt in wl + [None]:
                    if pt is not None and line_d(pt, l) < 220: run.append(pt); continue
                    if len(run) >= 2: cr_full.append(corridor(run, hw))
                    run = []
        fw = [f for f in fairways if poly_d(f, l) < 15]
        arr.append({'n': r, 'par': SC[cname]['par'][r-1], 'hcp': SC[cname]['hcp'][r-1],
                    'yds': {t: SC[cname]['tees'][t][r-1] for t in SC[cname]['tees']},
                    'line': l, 'green': g, 'tees': tb, 'hz': hz, 'fw': fw, 'cr': cr_full,
                    'note': SC[cname]['notes'].get(r, ''),
                    'osmPar': int(h['tags'].get('par', 0))})
        if arr[-1]['osmPar'] != arr[-1]['par']: print('PAR MISMATCH', cname, r, file=sys.stderr)
    out['courses'][cname] = {'holes': arr, 'rating': SC[cname]['rating'], 'blurb': SC[cname]['blurb'], 'club': club, 'tees': list(SC[cname]['tees'])}

for cname in ('West', 'East'):
    build_course(cname, sorted([h for h in holes if h['tags'].get('golf:course:name') == cname], key=lambda h: int(h['tags']['ref'])), 'bc')

# ---- Trophy Club Country Club (Hogan from OpenStreetMap, Whitworth hole lines traced from imagery + the club's hole maps) ----
HOGAN_IDS = [708515891, 708516593, 708519481, 708523428, 708530350, 708576043, 708577948, 708577955, 708580485,
             708896890, 708896900, 708924910, 708968843, 708968849, 708968858, 709004809, 709004814]  # holes 1-17
if os.path.exists('tcc_osm.json'):
    els = json.load(open('tcc_osm.json'))['elements']
    try: els = els + json.load(open('tcc_water.json')).get('elements', [])
    except Exception: print('no tcc waterways', file=sys.stderr)
    set_origin(33.0, -97.19)
    holes = [e for e in els if e['tags'].get('golf') == 'hole']
    greens = [P(e) for e in els if e['tags'].get('golf') == 'green' and P(e)]
    tees = [P(e, 6) for e in els if e['tags'].get('golf') == 'tee' and P(e)]
    bunkers = [P(e) for e in els if e['tags'].get('golf') == 'bunker' and P(e)]
    water = [P(e, 6) for e in els if (e['tags'].get('golf') in ('water_hazard', 'lateral_water_hazard') or e['tags'].get('natural') == 'water') and P(e)]
    water.append([[33.003195, -97.176844], [33.003388, -97.176568], [33.003465, -97.17631], [33.003205, -97.176327], [33.002819, -97.176431], [33.002434, -97.176534], [33.00212, -97.17658], [33.002039, -97.176672], [33.002337, -97.176729], [33.002713, -97.176786], [33.002916, -97.176763]])  # Whitworth 15 greenside pond, missing from OSM; traced from Esri imagery
    fairways = [P(e, 5) for e in els if e['tags'].get('golf') == 'fairway' and P(e)]
    wl = [e for e in els if e['tags'].get('waterway') in WATERWAYS and not e['tags'].get('tunnel') and not e['tags'].get('culvert') and 'geometry' in e]
    waterlines = [densify(P(e)) for e in wl]; wl_types = [e['tags'].get('waterway') for e in wl]
    byid = {e['id']: e for e in els if e['tags'].get('golf') == 'hole'}
    # traced hole lines (back tee -> dogleg points -> green centre) for holes OpenStreetMap lacks: Hogan 18, all of Whitworth
    tr = json.load(open('tcc_traced.json')) if os.path.exists('tcc_traced.json') else {}
    def traced(cname, n):
        return {'tags': {'ref': str(n), 'par': str(SC[cname]['par'][n - 1])}, 'geometry': [{'lat': p[0], 'lon': p[1]} for p in tr[cname][str(n)]]}
    hog = []
    for i, hid in enumerate(HOGAN_IDS):
        e = dict(byid[hid]); e['tags'] = dict(e['tags'], ref=str(i + 1), par=str(SC['Hogan']['par'][i])); hog.append(e)
    if '18' in tr.get('Hogan', {}): hog.append(traced('Hogan', 18))
    if len(hog) == 18: build_course('Hogan', hog, 'tcc')
    if len(tr.get('Whitworth', {})) == 18: build_course('Whitworth', [traced('Whitworth', n) for n in range(1, 19)], 'tcc')

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
out['clubs'] = {
  'bc': {'name': 'Bear Creek Golf Club', 'short': 'Bear Creek', 'place': 'DFW Airport, TX', 'addr': '3500 Bear Creek Ct, DFW Airport, TX',
         'phone': '972-456-3200', 'courses': ['West', 'East'], 'dem': dict(out['dem'], file='dem.bin')}}
TCC_DEM = {'n': 33.016, 's': 32.988, 'w': -97.210, 'e': -97.165, 'cols': 840, 'rows': 620, 'base': 150.0, 'scale': 0.01, 'units': 'm'}
if 'Hogan' in out['courses'] and (os.path.exists('dem_tcc.tif') or os.path.exists('dem_tcc.bin')):
    if os.path.exists('dem_tcc.tif'):  # fresh lidar; otherwise keep the committed dem_tcc.bin
        a = np.array(Image.open('dem_tcc.tif'), dtype=np.float32)
        b = np.array(Image.fromarray(a).resize((TCC_DEM['cols'], TCC_DEM['rows']), Image.BILINEAR), dtype=np.float32)
        np.clip(np.round((b - TCC_DEM['base']) * 100), 0, 65535).astype('<u2').tofile('dem_tcc.bin')
        print('dem tcc', b.min(), b.max(), file=sys.stderr)
    out['clubs']['tcc'] = {'name': 'Trophy Club Country Club', 'short': 'Trophy Club', 'place': 'Trophy Club, TX',
                           'addr': '500 Trophy Club Dr, Trophy Club, TX 76262', 'phone': '817-837-1900',
                           'courses': [c for c in ('Hogan', 'Whitworth') if c in out['courses']], 'dem': dict(TCC_DEM, file='dem_tcc.bin')}
for cn in list(out['courses']):
    if out['courses'][cn]['club'] not in out['clubs']: del out['courses'][cn]

# ---- per-green 1 m lidar grids (USGS 3DEP) for the green-slope view ----
import urllib.request, io, time
def green_grid(g):
    lats = [p[0] for p in g]; lons = [p[1] for p in g]
    m = 6.0
    n, s_ = max(lats) + m / KY, min(lats) - m / KY
    e, w = max(lons) + m / KX, min(lons) - m / KX
    cols = max(8, int(round((e - w) * KX))); rows = max(8, int(round((n - s_) * KY)))
    u = ('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
         f'?bbox={w},{s_},{e},{n}&bboxSR=4326&imageSR=4326&size={cols},{rows}&format=tiff&pixelType=F32'
         '&interpolation=RSP_BilinearInterpolation&f=image')
    for _ in range(4):
        try:
            data = urllib.request.urlopen(u, timeout=60).read()
            a = np.array(Image.open(io.BytesIO(data)), dtype=np.float32)
            if a.shape != (rows, cols) or a.min() < 50: raise ValueError('bad grid')
            base = float(np.floor(a.min() * 100) / 100)
            return {'n': n, 's': s_, 'w': w, 'e': e, 'rows': rows, 'cols': cols, 'base': base,
                    'cm': [int(round((v - base) * 100)) for v in a.flatten().tolist()]}
        except Exception as ex:
            time.sleep(3)
    return None
ok = 0
for cname, cdata in out['courses'].items():
    for h in cdata['holes']:
        gz = green_grid(h['green'])
        if gz: h['gz'] = gz; ok += 1
print('green grids', ok, file=sys.stderr)
json.dump(out, open('course.json', 'w'), separators=(',', ':'))
print('course.json', os.path.getsize('course.json'), file=sys.stderr)
