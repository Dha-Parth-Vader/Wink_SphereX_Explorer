"""Step 2: download a small cutout of every selected SPHEREx image of each target.

Reads out/inventory/<id>.csv, keeps at most --cap images per (visit, detector) spread evenly in wavelength,
looks up file paths in IRSA's CAOM tables, then reads only the cutout's bytes from NASA's public AWS copy
(--source s3, default) or asks IRSA's cutout service (--source irsa, slower). Keeps IMAGE, FLAGS, VARIANCE,
ZODI and WCS-WAVE; the PSF cube is never fetched. Files already in the cache are skipped.

Writes cache/<id>/<obs_id>_D<n>.fits, cache/<id>/manifest.csv and out/step2_timing.json.

    python pipeline/step2_download.py --only barnard --source s3 --workers 16 --cap 20 --fov 0.25
"""
import argparse
import csv
import io
import json
import logging
import os
import sys
import time
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import IRSA_BASE, ArchiveBusy, caom_paths, did_of, file_path, retry, s3_url, session  # noqa: E402

warnings.simplefilter("ignore", FITSFixedWarning)
logging.getLogger("astropy").setLevel(logging.ERROR)

OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
PIX_ARCSEC = 6.15
CUTOUT_PAD = 1.5   # cutout is 1.5x the field so frames rotated to north-up still fill it
LAYERS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
CRPIX_KEYS = ("CRPIX1", "CRPIX2", "CRPIX1A", "CRPIX2A", "CRPIX1W", "CRPIX2W")


def load_targets(only):
    targets = json.load(open(os.path.join(OUT, "targets.json"), encoding="utf-8"))
    if only:
        keep = only.split(",")
        missing = set(keep) - {t["id"] for t in targets}
        if missing:
            sys.exit("not in targets.json: " + ",".join(sorted(missing)))
        targets = [t for t in targets if t["id"] in keep]
    return targets


def cap_rows(rows, cap):
    if cap <= 0:
        return rows
    groups = defaultdict(list)
    for r in rows:
        groups[(r["visit"], r["detector"])].append(r)
    keep = []
    for g in groups.values():
        g.sort(key=lambda r: float(r["em_min_um"]))
        if len(g) > cap:
            step = len(g) / cap
            g = [g[int((i + 0.5) * step)] for i in range(cap)]
        keep += g
    return sorted(keep, key=lambda r: float(r["mjd"]))


def write_slim(hdus, dest):
    fits.HDUList(hdus).writeto(dest + ".part", overwrite=True)
    os.replace(dest + ".part", dest)
    return os.path.getsize(dest)


def fetch_s3(uri, ra, dec, size_deg, dest):
    url = s3_url(uri)
    with fits.open(url, use_fsspec=True, fsspec_kwargs={"block_size": 262144}) as h:
        hd = h["IMAGE"].header
        x, y = WCS(hd).world_to_pixel_values(ra, dec)
        ny, nx = hd["NAXIS2"], hd["NAXIS1"]
        half = int(round(size_deg * 3600 / PIX_ARCSEC / 2))
        xc, yc = int(round(float(x))), int(round(float(y)))
        x0, y0 = max(0, xc - half), max(0, yc - half)
        x1, y1 = min(nx, xc + half + 1), min(ny, yc + half + 1)
        if x1 - x0 < 5 or y1 - y0 < 5:
            raise RuntimeError("target is off this image")
        hdus = [fits.PrimaryHDU(header=h[0].header)]
        for name in LAYERS:
            if name not in h:
                continue
            sh = h[name].header.copy()
            for key, off in zip(CRPIX_KEYS, (x0, y0) * 3):
                if key in sh:
                    sh[key] = sh[key] - off
            hdus.append(fits.ImageHDU(np.asarray(h[name].section[y0:y1, x0:x1]), header=sh, name=name))
        hdus.append(h["WCS-WAVE"].copy())
    return write_slim(hdus, dest)


def fetch_irsa(uri, ra, dec, size_deg, dest):
    url = f"{IRSA_BASE}{uri}?center={ra:.6f},{dec:.6f}&size={size_deg:.5f}&gzip=false"

    def get():
        r = session.get(url, timeout=300)
        if r.status_code >= 500 or not r.content.startswith(b"SIMPLE"):
            raise ArchiveBusy(r.content[:80].decode(errors="replace"))
        return r.content
    raw = retry(get)
    with fits.open(io.BytesIO(raw)) as h:
        hdus = [fits.PrimaryHDU(header=h[0].header)] + [h[k].copy() for k in LAYERS + ("WCS-WAVE",) if k in h]
        return write_slim(hdus, dest)


def fetch(fn, *args, tries=3):
    for attempt in range(tries):
        try:
            return fn(*args)
        except Exception:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            time.sleep(2 * 2 ** attempt)


def key_of(r):
    return file_path(r["access_url"]) or did_of(r["access_url"])


def resolve(t, rows, d):
    """access URL key -> file path. SIA rows carry the path; TAP rows need IRSA's CAOM tables, cached in
    cache/<id>/paths.json so a restart doesn't query IRSA again."""
    pf = os.path.join(d, "paths.json")
    paths = json.load(open(pf)) if os.path.exists(pf) else {}
    for r in rows:
        if file_path(r["access_url"]):
            paths[key_of(r)] = file_path(r["access_url"])
    need = [key_of(r) for r in rows if key_of(r) not in paths]
    if need:
        paths.update(caom_paths(need))
    with open(pf, "w") as fh:
        json.dump(paths, fh)
    return paths


def run_target(t, a):
    t0 = time.time()
    inv = os.path.join(OUT, "inventory", t["id"] + ".csv")
    if not os.path.exists(inv):
        print(f"{t['id']}: no inventory, run step1_inventory.py first", flush=True)
        return dict(id=t["id"], error="no inventory")
    with open(inv, newline="", encoding="utf-8") as fh:
        listed = list(csv.DictReader(fh))
    rows = cap_rows(listed, a.cap)
    d = os.path.join(CACHE, t["id"])
    os.makedirs(d, exist_ok=True)
    fname = lambda r: f"{r['obs_id']}_D{r['detector']}.fits"
    todo = [r for r in rows if not os.path.exists(os.path.join(d, fname(r)))]
    paths = resolve(t, todo, d) if todo else {}
    t_lookup = time.time() - t0

    fn = fetch_s3 if a.source == "s3" else fetch_irsa
    size = a.fov * CUTOUT_PAD
    moved, failed = 0, {}
    for attempt in (1, 2):   # missing or failed files get one more try, then are listed
        batch = [r for r in todo if not os.path.exists(os.path.join(d, fname(r)))]
        if not batch:
            break
        failed = {}
        with ThreadPoolExecutor(a.workers) as ex:
            jobs = {}
            for r in batch:
                uri = paths.get(key_of(r))
                if not uri:
                    failed[r["obs_id"]] = "no file path in CAOM"
                    continue
                jobs[ex.submit(fetch, fn, uri, t["ra"], t["dec"], size, os.path.join(d, fname(r)))] = r
            for j in as_completed(jobs):
                try:
                    moved += j.result()
                except Exception as e:  # noqa: BLE001
                    failed[jobs[j]["obs_id"]] = str(e)[:100]

    have = [r for r in rows if os.path.exists(os.path.join(d, fname(r)))]
    with open(os.path.join(d, "manifest.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) + ["file"] if rows else ["file"])
        w.writeheader()
        for r in have:
            w.writerow({**r, "file": fname(r)})
    res = dict(id=t["id"], images_listed=len(listed), images_selected=len(rows), in_cache=len(have),
               downloaded_now=len(todo) - len([r for r in todo if r not in have]), failed=len(failed),
               failed_ids=sorted(failed)[:50], source=a.source, cap=a.cap, fov=a.fov,
               lookup_s=round(t_lookup, 1), total_s=round(time.time() - t0, 1), stored_mb=round(moved / 1e6, 1))
    print(f"{t['id']:18s} {len(have)}/{len(rows)} in cache, {len(failed)} failed, "
          f"{res['total_s']} s, {res['stored_mb']} MB new", flush=True)
    for k, v in list(failed.items())[:5]:
        print(f"    failed {k}: {v}", flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--fov", type=float, default=0.25, help="field of view in degrees (cutout is 1.5x)")
    ap.add_argument("--cap", type=int, default=20, help="max images per (visit, detector); 0 = all")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--source", choices=["s3", "irsa"], default="s3")
    a = ap.parse_args()
    results = []
    for t in load_targets(a.only):
        try:
            results.append(run_target(t, a))
        except Exception as e:  # noqa: BLE001
            print(f"{t['id']:18s} FAILED: {str(e)[:150]} (run the same command again)", flush=True)
            results.append(dict(id=t["id"], error=str(e)[:150]))
    tf = os.path.join(OUT, "step2_timing.json")
    old = json.load(open(tf)) if os.path.exists(tf) else []
    done = {r["id"] for r in results}
    with open(tf, "w") as fh:
        json.dump([o for o in old if o["id"] not in done] + results, fh, indent=1)


if __name__ == "__main__":
    main()
