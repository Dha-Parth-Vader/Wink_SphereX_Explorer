"""Rebuild the shared lists from per-target fragments (R43): patches.json, gallery.json, dome/poi.json and
dome/bands.json. Inputs are pipeline/out/web/results/<id>.json (from step 7) and the hand-made entries in
public/data/extra/*.json. Deterministic and safe to run again; a target whose frames exist is never dropped.

    python pipeline/merge_lists.py [--site public/data]
"""
import argparse
import sys
from pathlib import Path

from stackfile import OUT, SITE, band_table, load_targets, read_json, write_json

CATEGORIES = {
    "brown-dwarf": {"label": "Brown dwarfs", "color": "#e0794b", "shape": "diamond"},
    "star": {"label": "Nearby fast stars", "color": "#ffd166", "shape": "circle"},
    "variable": {"label": "Variable stars", "color": "#7bdff2", "shape": "star"},
    "nebula": {"label": "Nebulae", "color": "#c77dff", "shape": "cloud"},
    "galaxy": {"label": "Galaxies", "color": "#90be6d", "shape": "ellipse"},
    "asteroid": {"label": "Asteroids and comets", "color": "#adb5bd", "shape": "dot"},
}


def load_fragments(folder):
    out = {}
    for path in sorted(Path(folder).glob("*.json")):
        frag = read_json(path)
        ident = (frag.get("patch_entry") or frag.get("gallery_entry") or frag.get("poi_entry") or {}).get("id")
        if ident:
            out[ident] = frag
        else:
            print(f"  skipping {path.name}: no id in it", flush=True)
    return out


def merge(site):
    site = Path(site)
    fragments = load_fragments(OUT / "web" / "results")
    extras = load_fragments(site / "extra")
    old_patches = {e["id"]: e for e in read_json(site / "patches.json", [])}
    old_gallery = {e["id"]: e for e in read_json(site / "gallery.json", [])}
    old_poi = read_json(site / "dome" / "poi.json", {"categories": {}, "pois": []})
    old_pois = {e["id"]: e for e in old_poi.get("pois", [])}

    for ident in list(fragments):
        if not (site / "frames" / ident).is_dir() or not (site / f"{ident}.json").exists():
            print(f"  {ident}: fragment but no frames or {ident}.json in {site}, left out (run step 7)", flush=True)
            del fragments[ident]

    order = [t["id"] for t in load_targets() if t["id"] in fragments]
    order += sorted(set(fragments) - set(order))
    kept = []
    if (site / "frames").is_dir():
        for d in sorted(p.name for p in (site / "frames").iterdir() if p.is_dir()):
            if d not in fragments and d not in extras and d in old_patches:
                kept.append(d)
                print(f"  {d}: frames exist but no fragment, keeping its current entries", flush=True)

    patches, gallery, pois = [], [], []
    for ident in order:
        frag = fragments[ident]
        for lst, key in ((patches, "patch_entry"), (gallery, "gallery_entry"), (pois, "poi_entry")):
            if frag.get(key):
                lst.append(frag[key])
    for ident in kept:
        patches.append(old_patches[ident])
        if ident in old_gallery:
            gallery.append(old_gallery[ident])
        if ident in old_pois:
            pois.append(old_pois[ident])
    categories = {**CATEGORIES, **old_poi.get("categories", {})}
    for ident in sorted(extras):
        frag = extras[ident]
        for lst, key in ((patches, "patch_entry"), (gallery, "gallery_entry"), (pois, "poi_entry")):
            if frag.get(key):
                lst.append(frag[key])
        categories.update(frag.get("categories", {}))

    write_json(site / "patches.json", patches)
    write_json(site / "gallery.json", gallery)
    write_json(site / "dome" / "poi.json", {"categories": dict(sorted(categories.items())), "pois": pois})
    write_json(site / "dome" / "bands.json", band_table())
    real = sum(1 for p in patches if not p.get("simulated"))
    print(f"merged: {len(patches)} patches ({real} real, {len(patches) - real} simulated), "
          f"{len(gallery)} gallery cards, {len(pois)} dome objects", flush=True)
    return patches, gallery, pois


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--site", default=str(SITE))
    args = ap.parse_args(argv)
    merge(args.site)
    return 0


if __name__ == "__main__":
    sys.exit(main())
