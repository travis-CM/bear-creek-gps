# Run in CI from repo root: builds app icons + the Watch's bundled course data.
import json, shutil
from PIL import Image, ImageDraw
def icon(path):
    from PIL import ImageFilter
    S = 2; N = 1024 * S
    im = Image.new('RGB', (N, N), (8, 8, 8))
    g = Image.new('L', (N, N), 0); ImageDraw.Draw(g).ellipse((N*0.1, N*0.05, N*0.9, N*0.85), fill=255); g = g.filter(ImageFilter.GaussianBlur(N*0.12))
    im = Image.composite(Image.new('RGB', (N, N), (40, 30, 18)), im, g); d = ImageDraw.Draw(im)
    cx, cy, R, W = 512*S, 540*S, 300*S, 112*S
    d.arc((cx-R, cy-R, cx+R, cy+R), 30, 330, fill=(255, 255, 255), width=W)
    d.rectangle((cx+20*S, cy-W//2+6*S, cx+R+W//2-4*S, cy+W//2-6*S), fill=(255, 255, 255))
    p = cx-75*S
    d.rectangle((p-9*S, cy-150*S, p+9*S, cy+150*S), fill=(255, 255, 255))
    d.polygon([(p+9*S, cy-150*S), (p+150*S, cy-100*S), (p+9*S, cy-50*S)], fill=(255, 153, 0))
    d.ellipse((p-85*S, cy+128*S, p+85*S, cy+180*S), fill=(255, 153, 0))
    im.resize((1024, 1024), Image.LANCZOS).save(path)
for p in ['ios/iOS/Assets.xcassets/AppIcon.appiconset/icon.png', 'ios/Watch/Assets.xcassets/AppIcon.appiconset/icon.png']:
    icon(p)
c = json.load(open('course.json'))
def cen(poly): return [round(sum(p[0] for p in poly) / len(poly), 6), round(sum(p[1] for p in poly) / len(poly), 6)]
out = {k: [{'n': h['n'], 'par': h['par'], 'g': cen(h['green']), 'gp': [[round(q[0], 6), round(q[1], 6)] for q in h['green']], 'hz': [{'t': z['t'], 'p': [[round(q[0], 6), round(q[1], 6)] for q in z['p']]} for z in h['hz']]} for h in v['holes']] for k, v in c['courses'].items()}
out['dem'] = c['dem']
json.dump(out, open('ios/Watch/course_watch.json', 'w'))
shutil.copy('dem.bin', 'ios/Watch/dem.bin')
print('assets ok')
