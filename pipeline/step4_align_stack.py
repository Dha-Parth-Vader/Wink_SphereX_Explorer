"""Step 4: put every cleaned frame on one north-up grid and stack each detector per visit.

Grid (R10): TAN projection on the target's 2026.0 position, 6.15"/px, north up, east left, FOV x FOV.
Arrays stay in FITS order (row 0 = south); step 7 flips them once for the web.
Stacks (R11, R12): 3-sigma-clipped mean per (visit, detector), at least 3 frames per detector and 12 per
visit. Pixels seen by fewer than 40% of the best-covered pixel's frames are blanked. A smooth background
is subtracted unless --no-flatten (nebulae).

cache/<id>/stack.fits uses the layout in stackfile.py, which steps 5 to 7 and the live server read:
one Vnn_<ALL|D1..D6> image per visit and band, a Vnn_<band>_FLAGS contamination mask (science mask drops
the pixel in most frames) and a Vnn_CUBE of 32 px centre tiles per SPHEREx band for the Sky Dome.
out/stack/<id>.json: per visit the dates, frames per detector, wavelengths, coverage, flag counts and the
target's measured vs predicted position.

    python pipeline/step4_align_stack.py --only barnard,wise0855 --fov 0.25 --workers 3
"""
import argparse
import csv
import json
import logging
import os
import sys
import warnings
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy.ndimage import grey_dilation, label, map_coordinates

warnings.simplefilter("ignore", FITSFixedWarning)
logging.getLogger("astropy").setLevel(logging.ERROR)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stackfile  # noqa: E402

OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
PIX_ARCSEC = 6.15
MIN_FRAMES = 3
MIN_VISIT_FRAMES = 12
MIN_COVER = 0.4
TILE = 32
FLAG_MAJORITY = 0.5
BANDS = ["all", 1, 2, 3, 4, 5, 6, "cold"]
COLD_BAND = 7


def load_targets(only):
    targets = json.load(open(os.path.join(OUT, "targets.json"), encoding="utf-8"))
    if only:
        keep = only.split(",")
        missing = set(keep) - {t["id"] for t in targets}
        if missing:
            sys.exit("not in targets.json: " + ",".join(sorted(missing)))
        targets = [t for t in targets if t["id"] in keep]
    return targets


def make_grid(ra, dec, fov):
    n = int(round(fov * 3600 / PIX_ARCSEC))
    n += (n + 1) % 2   # odd, so the target sits on the centre pixel
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    return w, n


def reproject(path, grid, n):
    with fits.open(path) as h:
        sci = h["SCI"].data.astype(np.float64)
        bad = h["BAD"].data.astype(bool)
        sat = h["SAT"].data.astype(bool)
        w_in = WCS(h["SCI"].header)
    yy, xx = np.mgrid[0:n, 0:n]
    ra, dec = grid.pixel_to_world_values(xx, yy)
    xi, yi = w_in.world_to_pixel_values(ra, dec)
    coords = np.array([yi, xi])
    valid = np.isfinite(sci)
    out = map_coordinates(np.where(valid, sci, 0.0), coords, order=1, mode="constant", cval=0.0)
    wgt = map_coordinates(valid.astype(float), coords, order=1, mode="constant", cval=0.0)
    out = np.where(wgt > 0.75, out / np.maximum(wgt, 1e-9), np.nan)
    badm = map_coordinates(bad.astype(float), coords, order=0, mode="constant", cval=0.0) > 0.5
    satm = map_coordinates(sat.astype(float), coords, order=0, mode="constant", cval=0.0) > 0.5
    return out.astype(np.float32), badm & np.isfinite(out), satm & np.isfinite(out)


def clipped_mean(cube, nsig=3.0, iters=3):
    c = cube.copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for _ in range(iters):
            med = np.nanmedian(c, axis=0)
            mad = 1.4826 * np.nanmedian(np.abs(c - med), axis=0)
            c = np.where(np.abs(c - med) <= nsig * np.maximum(mad, 1e-6), c, np.nan)
        return np.nanmean(c, axis=0), np.sum(np.isfinite(c), axis=0)


def stack_frames(imgs):
    m, k = clipped_mean(np.array(imgs))
    need = max(2, int(np.ceil(MIN_COVER * k.max())))
    return np.where(k >= need, m, np.nan).astype(np.float32), k.astype(np.int16)


def flatten(img):
    """Subtract a 2nd-order surface fitted to sky pixels only, so it can't leave boxes around stars."""
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n] / (n - 1) - 0.5
    A = np.stack([np.ones_like(xx), xx, yy, xx * yy, xx ** 2, yy ** 2], -1).reshape(-1, 6)
    z = img.reshape(-1)
    use = np.isfinite(z)
    if use.sum() < 100:
        return img
    coef = None
    for _ in range(5):
        coef, *_ = np.linalg.lstsq(A[use], z[use], rcond=None)
        r = z - A @ coef
        s = 1.4826 * np.nanmedian(np.abs(r[use]))
        new = np.isfinite(z) & (r < 2.5 * s) & (r > -4 * s)
        if new.sum() < 100 or (new == use).all():
            break
        use = new
    return (img - (A @ coef).reshape(n, n)).astype(np.float32)


def fill_holes(img):
    """Fill NaN holes that don't touch the edge by repeated 3x3 grey dilation (R19)."""
    nan = ~np.isfinite(img)
    if not nan.any():
        return img
    lab, nlab = label(nan)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    holes = nan & ~np.isin(lab, list(edge))
    out = img.copy()
    for _ in range(50):
        todo = holes & ~np.isfinite(out)
        if not todo.any():
            break
        grown = grey_dilation(np.where(np.isfinite(out), out, -np.inf), size=3)
        fill = todo & np.isfinite(grown)
        out[fill] = grown[fill]
    return out


def centroid(img, x0, y0, r=3):
    xi, yi = int(round(x0)), int(round(y0))
    if not (r <= xi < img.shape[1] - r and r <= yi < img.shape[0] - r):
        return np.nan, np.nan
    box = img[yi - r:yi + r + 1, xi - r:xi + r + 1]
    if not np.isfinite(box).any():
        return np.nan, np.nan
    # saturated cores are NaN; count them at the box peak so the centroid isn't pulled into the halo
    box = np.where(np.isfinite(box), box, np.nanmax(box))
    b = box - np.nanmedian(img)
    b[b < 0] = 0
    if b.sum() <= 0:
        return np.nan, np.nan
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return xi + (b * xx).sum() / b.sum(), yi + (b * yy).sum() / b.sum()


def predicted_px(t, mjd, n):
    c = (n - 1) / 2
    dt = 2000.0 + (mjd - 51544.5) / 365.25 - t["epoch"]
    return c - t.get("pmra_mas", 0) * dt / 1000 / PIX_ARCSEC, c + t.get("pmdec_mas", 0) * dt / 1000 / PIX_ARCSEC


def is_cold(t):
    return t["kind"] == "brown-dwarf" and t.get("w1", 0) - t.get("w2", 0) > 2.5


def run(t, fov, do_flatten, force):
    clean_csv = os.path.join(OUT, "clean", t["id"] + ".csv")
    stack_path = os.path.join(CACHE, t["id"], "stack.fits")
    out_json = os.path.join(OUT, "stack", t["id"] + ".json")
    if not os.path.exists(clean_csv):
        return f"{t['id']}: not cleaned yet (run step3_clean.py)"
    if (not force and os.path.exists(stack_path) and os.path.exists(out_json)
            and os.path.getmtime(stack_path) > os.path.getmtime(clean_csv)):
        return f"{t['id']}: already stacked"
    with open(clean_csv, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    grid, n = make_grid(t["ra"], t["dec"], fov)
    counts = Counter(int(r["visit"]) for r in rows)
    visits = sorted(v for v, k in counts.items() if k >= MIN_VISIT_FRAMES)
    skipped = sorted(v for v, k in counts.items() if k < MIN_VISIT_FRAMES)
    if not visits:
        return f"{t['id']}: no visit has {MIN_VISIT_FRAMES}+ cleaned frames, nothing stacked"
    nv, nb = len(visits), len(BANDS)
    stack = np.full((nv, nb, n, n), np.nan, np.float32)
    c0 = max(0, n // 2 - TILE // 2)
    cube = np.full((nv, 102, TILE, TILE), np.nan, np.float32)
    flagf = np.zeros((nv, nb, n, n), np.float32)
    cdir = os.path.join(CACHE, t["id"], "clean")
    meta = []
    for i, v in enumerate(visits):
        vrows = [r for r in rows if int(r["visit"]) == v]
        per_det = {}
        for det in range(1, 7):
            drows = [r for r in vrows if int(r["detector"]) == det]
            imgs, bads, used = [], [], []
            tiles = {}
            for r in drows:
                path = os.path.join(cdir, r["file"])
                if not os.path.exists(path):
                    continue
                im, bad, _ = reproject(path, grid, n)
                if np.isfinite(im).sum() < 0.05 * n * n:
                    continue
                imgs.append(im); bads.append(bad); used.append(r)
                bi = stackfile.band_index(float(r["wavelength_um"])) if r["wavelength_um"] not in ("", "nan") else None
                if bi is not None:
                    tiles.setdefault(bi, []).append(im[c0:c0 + TILE, c0:c0 + TILE])
            if len(imgs) < MIN_FRAMES:
                continue
            m, k = stack_frames(imgs)
            if do_flatten:
                m = flatten(m)
            stack[i, det] = m
            flagf[i, det] = np.mean(bads, axis=0)
            lams = [float(r["wavelength_um"]) for r in used if r["wavelength_um"] not in ("", "nan")]
            flag_counts = Counter()
            for r in used:
                flag_counts.update(json.loads(r["flag_counts"]))
            target_sat = [r["saturated"] == "True" for r in used]
            for bi, ts in tiles.items():
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    cube[i, bi] = np.nanmean(ts, axis=0)
            per_det[det] = dict(n_frames=len(imgs),
                                wavelength_um=[round(min(lams), 4), round(max(lams), 4)] if lams else None,
                                coverage=round(float(np.isfinite(m).mean()), 3),
                                target_saturated_frac=round(sum(target_sat) / len(target_sat), 2),
                                flag_bits=dict(sorted(flag_counts.items())),
                                obs_ids=[r["obs_id"] for r in used])
        dets = sorted(per_det)
        if dets:
            ncov = np.isfinite(stack[i, dets]).sum(axis=0)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                allb = np.nanmean(stack[i, dets], axis=0)
            stack[i, 0] = np.where(ncov >= max(1, (len(dets) + 1) // 2), allb, np.nan)
            flagf[i, 0] = flagf[i, dets].mean(axis=0)
            cold = [d for d in (5, 6) if d in per_det]
            if cold:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    stack[i, COLD_BAND] = np.nanmean(stack[i, cold], axis=0)
                flagf[i, COLD_BAND] = flagf[i, cold].mean(axis=0)
        mjds = [float(r["mjd"]) for r in vrows]
        meta.append(dict(visit=v, mjd_mean=round(float(np.mean(mjds)), 3), mjd_min=round(min(mjds), 3),
                         mjd_max=round(max(mjds), 3), n_frames=sum(d["n_frames"] for d in per_det.values()),
                         n_listed=len(vrows), detectors=per_det,
                         coverage_all=round(float(np.isfinite(stack[i, 0]).mean()), 3) if dets else 0.0))

    display = np.full_like(stack, np.nan)
    for i in range(nv):
        for b in range(nb):
            if np.isfinite(stack[i, b]).any():
                display[i, b] = fill_holes(stack[i, b])

    # alignment check on the all-detector stack, or the cold stack for very red brown dwarfs
    band = COLD_BAND if is_cold(t) else 0
    for i, m in enumerate(meta):
        px, py = predicted_px(t, m["mjd_mean"], n)
        cx, cy = centroid(display[i, band], px, py)
        m["check_band"] = BANDS[band]
        m["target_predicted_px"] = [round(px, 2), round(py, 2)]
        m["target_measured_px"] = [round(cx, 2), round(cy, 2)] if np.isfinite(cx) else None
        m["offset_px"] = round(float(np.hypot(cx - px, cy - py)), 2) if np.isfinite(cx) else None

    motion = None
    meas = [(m["mjd_mean"], m["target_measured_px"]) for m in meta if m["target_measured_px"]]
    if len(meas) >= 2:
        (m0, p0), (m1, p1) = meas[0], meas[-1]
        yrs = (m1 - m0) / 365.25
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        shift = float(np.hypot(dx, dy))
        motion = dict(first_mjd=m0, last_mjd=m1, years=round(yrs, 3), shift_px=round(shift, 2),
                      north_px=round(dy, 2), east_px=round(-dx, 2),
                      arcsec_per_yr=round(shift * PIX_ARCSEC / yrs, 2) if yrs > 0.05 else None,
                      catalogue_arcsec_per_yr=round(t.get("pm_mas", 0) / 1000, 2))

    sgrid = stackfile.Grid(t["ra"], t["dec"], n, n, PIX_ARCSEC)
    images, extras, cubes = {}, {}, {}
    for i, m in enumerate(meta):
        v = m["visit"]
        for b, name in enumerate(stackfile.BANDS):
            img = stack[i, b]
            if not np.isfinite(img).any():
                continue
            dets = [d for d in m["detectors"] if name == "ALL" or name == f"D{d}"]
            per = [m["detectors"][d] for d in dets]
            lams = [x for p in per if p["wavelength_um"] for x in p["wavelength_um"]]
            fb = Counter()
            for p in per:
                for k, c in p["flag_bits"].items():
                    fb[k] += c / max(p["n_frames"], 1)
            hdr = {"VISIT": v, "MJD": m["mjd_mean"], "MJDMIN": m["mjd_min"], "MJDMAX": m["mjd_max"],
                   "NFRAMES": sum(p["n_frames"] for p in per),
                   "COVERAGE": round(float(np.isfinite(img).mean()), 3),
                   "SATUR": any(p["target_saturated_frac"] >= 0.5 for p in per),
                   "SKY": 0.0, "NOISE": stackfile.robust_noise(img)}
            if lams:
                hdr["WAVEMIN"], hdr["WAVEMAX"] = min(lams), max(lams)
            hdr.update({f"FB_{k}": int(round(c / max(len(per), 1))) for k, c in fb.items() if round(c)})
            images[(v, name)] = (img, hdr)
            extras[(v, name, "FLAGS")] = flagf[i, b] > FLAG_MAJORITY
        if np.isfinite(cube[i]).any():
            cubes[v] = cube[i]
    stackfile.write_stack(stack_path, sgrid, t["id"], images, extras, cubes)
    info = dict(id=t["id"], name=t["name"], ra=t["ra"], dec=t["dec"], epoch=t["epoch"], fov_deg=fov, size_px=n,
                pixel_scale_arcsec=PIX_ARCSEC, bands=[str(b) for b in BANDS], flatten=do_flatten,
                visits_skipped=skipped, visits=meta, motion=motion)
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=1)
    offs = [m["offset_px"] for m in meta]
    extra = f"; moved {motion['shift_px']} px ({motion['arcsec_per_yr']}\"/yr)" if motion else ""
    return f"{t['id']}: {nv} visits stacked on a {n}x{n} grid, target offsets {offs} px{extra}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--fov", type=float, default=0.25)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-flatten", action="store_true", help="keep large-scale structure (nebulae)")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    targets = load_targets(a.only)
    with ProcessPoolExecutor(a.workers) as ex:
        futures = {ex.submit(run, t, a.fov, not a.no_flatten, a.force): t for t in targets}
        for f, t in futures.items():
            try:
                print(f.result(), flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"{t['id']}: FAILED {str(e)[:150]}", flush=True)


if __name__ == "__main__":
    main()
