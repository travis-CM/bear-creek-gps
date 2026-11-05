# Run in CI from repo root: builds app icons + the Watch's bundled course data.
import json, shutil
from PIL import Image, ImageDraw
def icon(path):
    im = Image.new('RGB', (1024, 1024), (15, 42, 29)); d = ImageDraw.Draw(im)
    d.ellipse((262, 560, 762, 860), fill=(76, 194, 122))
    d.rectangle((452, 150, 482, 720), fill=(255, 255, 255))
    d.polygon([(482, 160), (790, 260), (482, 360)], fill=(239, 106, 90))
    im.save(path)
for p in ['ios/iOS/Assets.xcassets/AppIcon.appiconset/icon.png', 'ios/Watch/Assets.xcassets/AppIcon.appiconset/icon.png']:
    icon(p)
c = json.load(open('course.json'))
def cen(poly): return [round(sum(p[0] for p in poly) / len(poly), 6), round(sum(p[1] for p in poly) / len(poly), 6)]
out = {k: [{'n': h['n'], 'par': h['par'], 'g': cen(h['green']), 'hz': [{'t': z['t'], 'p': [[round(q[0], 6), round(q[1], 6)] for q in z['p']]} for z in h['hz']]} for h in v['holes']] for k, v in c['courses'].items()}
out['dem'] = c['dem']
json.dump(out, open('ios/Watch/course_watch.json', 'w'))
shutil.copy('dem.bin', 'ios/Watch/dem.bin')
print('assets ok')
