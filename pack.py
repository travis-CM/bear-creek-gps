#!/usr/bin/env python3
"""Rebuild bundle.json from the app source files (or check that it is current).

    python3 pack.py          # rewrite bundle.json
    python3 pack.py --check  # exit 1 if bundle.json is stale (CI / pre-push check)

bundle.json is what the GitHub workflows unpack over the tree before building, so
any edit to a bundled file (app.js, index.html, sw.js, build.py, ios/...) must be
followed by `python3 pack.py` or the next workflow run silently reverts it.
Pushing a changed bundle.json starts the TestFlight build and the course rebuild.
"""
import json, sys

EXTRA = ['vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js', 'pack.py']

def read(k): return open(k, encoding='utf-8', newline='').read()

def main():
    old = json.load(open('bundle.json', encoding='utf-8'))['files']
    keys = sorted(set(old) | set(EXTRA))
    files = {k: read(k) for k in keys}
    if '--check' in sys.argv:
        stale = [k for k in keys if old.get(k) != files[k]]
        if stale:
            print('bundle.json is stale for:', *stale, sep='\n  '); sys.exit(1)
        print('bundle.json is current', len(keys), 'files'); return
    json.dump({'files': files}, open('bundle.json', 'w', encoding='utf-8'), indent=0, sort_keys=True, ensure_ascii=False)
    print('packed', len(keys), 'files')

if __name__ == '__main__':
    main()
