"""Step 3: clean each downloaded cutout and measure the target in it.

Subtracts ZODI (a missing ZODI layer is fine, the sky step removes it anyway), builds the SCIENCE and
DISPLAY masks from FLAGS (R5-R7), removes the sky level (R8), reads the wavelength at the target from
WCS-WAVE and measures the target's flux in microJy (R9).

Writes cache/<id>/clean/<file> (SCI with display-masked pixels as NaN, BAD = extra pixels the science mask
drops, SAT = saturation) and out/clean/<id>.csv (one row per frame).

    python pipeline/step3_clean.py --only barnard,wise0855 --workers 6
"""
import argparse
import csv
import json
import logging
import os
import sys
import warnings
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)
logging.getLogger("astropy").setLevel(logging.ERROR)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))

# FLAGS bits, SPHEREx Explanatory Supplement
BITS = dict(TRANSIENT=0, OVERFLOW=1, SUR_ERROR=2, PHANTOM=4, REFERENCE=5, NONFUNC=6, DICHROIC=7,
            MISSING_DATA=9, HOT=10, COLD=11, FULLSAMPLE=12, PHANMISS=14, NONLINEAR=15, PERSIST=17,
            OUTLIER=19, CROSSTALK=20, SOURCE=21, GHOST=22, GHOST_FPA=23, GHOST_EXT=24, STREAK=25,
            BLOOM=26, SNOWBALL=27, HALO=28, SATELLITE_HALO=29)
# IRSA's mosaic recipe. SOURCE, OVERFLOW and OUTLIER stay unmasked or real stars disappear.
SCIENCE_BAD = ["TRANSIENT", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS",
               "NONLINEAR", "PERSIST", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "BLOOM",
               "SNOWBALL", "HALO", "SATELLITE_HALO"]
DISPLAY_BAD = ["NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS"]
SAT_BITS = ["NONLINEAR", "BLOOM"]


def mask_of(names):
    return sum(1 << BITS[b] for b in names)


SCIENCE_MASK, DISPLAY_MASK, SAT_MASK = mask_of(SCIENCE_BAD), mask_of(DISPLAY_BAD), mask_of(SAT_BITS)
EARLY_SAT = mask_of(["TRANSIENT", "OVERFLOW"])
SUR_ERROR = mask_of(["SUR_ERROR"])
SOURCE = mask_of(["SOURCE"])
PIX_SR = (6.15 / 206264.806) ** 2
MJYSR_TO_UJY = PIX_SR * 1e12


def load_targets(only):
    targets = json.load(open(os.path.join(OUT, "targets.json"), encoding="utf-8"))
    if only:
        keep = only.split(",")
        missing = set(keep) - {t["id"] for t in targets}
        if missing:
            sys.exit("not in targets.json: " + ",".join(sorted(missing)))
        targets = [t for t in targets if t["id"] in keep]
    return targets


def position_at(t, mjd):
    """Target position at a frame's date, moved from its 2026.0 position by proper motion (R1)."""
    dt = 2000.0 + (mjd - 51544.5) / 365.25 - t["epoch"]
    dec = t["dec"] + t.get("pmdec_mas", 0) * dt / 3.6e6
    ra = t["ra"] + t.get("pmra_mas", 0) * dt / 3.6e6 / np.cos(np.radians(t["dec"]))
    return ra, dec


def sky_stats(v, nsig=3.0, iters=5):
    """Clipped median and MAD noise. Stops clipping before the sample empties, never returns NaN."""
    v = v[np.isfinite(v)]
    if v.size == 0:
        return 0.0, 0.0
    for _ in range(iters):
        if v.size < 10:
            break
        m = np.median(v)
        s = 1.4826 * np.median(np.abs(v - m))
        if s <= 0:
            break
        keep = v[np.abs(v - m) < nsig * s]
        if keep.size < 10:
            break
        v = keep
    m = np.median(v)
    return float(m), float(1.4826 * np.median(np.abs(v - m)))


def aperture(sci, err, bad, x, y, r=2.0, r_in=5.0, r_out=8.0):
    yy, xx = np.indices(sci.shape)
    d = np.hypot(xx - x, yy - y)
    ap = d <= r
    ann = (d >= r_in) & (d <= r_out) & ~bad & np.isfinite(sci)
    good = ap & ~bad & np.isfinite(sci)
    if not ap.any() or ann.sum() < 10 or not good.any():
        return np.nan, np.nan, 1.0
    sky = np.median(sci[ann])
    flux = np.sum((sci - sky)[good]) * ap.sum() / good.sum()
    e = np.sqrt(np.sum(err[good] ** 2)) * ap.sum() / good.sum()
    return flux * MJYSR_TO_UJY, e * MJYSR_TO_UJY, 1 - good.sum() / ap.sum()


def clean_one(job):
    path, dest, t, row = job
    with fits.open(path) as h:
        img = h["IMAGE"].data.astype(np.float32)
        hdr = h["IMAGE"].header
        if "ZODI" in h and h["ZODI"].data is not None and np.isfinite(h["ZODI"].data).any():
            zodi = np.nan_to_num(h["ZODI"].data.astype(np.float32))
            zodi_missing = False
        else:
            zodi, zodi_missing = 0.0, True
        var = h["VARIANCE"].data.astype(np.float32) if "VARIANCE" in h else np.full_like(img, np.nan)
        flags = h["FLAGS"].data.astype(np.int64)
        wcs = WCS(hdr)
        wwave = WCS(hdr, fobj=h, key="W")

    finite = np.isfinite(img)
    bad = ((flags & SCIENCE_MASK) != 0) | ~finite
    dbad = ((flags & DISPLAY_MASK) != 0) | ~finite
    sat = (flags & SAT_MASK) != 0
    sci = img - zodi

    # sky from unflagged, star-free pixels; early files flag every pixel SOURCE, some frames are mostly masked
    sky_pix = ~bad & ((flags & SOURCE) == 0)
    if sky_pix.sum() < 200:
        sky_pix = ~bad
    if sky_pix.sum() < 200:
        sky_pix = ~dbad
    sky, noise = sky_stats(sci[sky_pix])
    sci = sci - sky
    sci[dbad] = np.nan
    err = np.sqrt(np.clip(np.nan_to_num(var, nan=0.0), 0, None))

    ra, dec = position_at(t, float(row["mjd"]))
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    if 2 <= x < sci.shape[1] - 2 and 2 <= y < sci.shape[0] - 2:
        lam, bw = (float(v) for v in wwave.pixel_to_world_values(x, y))
        flux, ferr, fbad = aperture(sci, err, bad, x, y)
        # display-mask flux keeps saturated cores: good enough for relative changes of bright stars
        flux_d, _, _ = aperture(sci, err, dbad, x, y)
        xi, yi = int(round(x)), int(round(y))
        core = flags[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2]
        early = ((core & SUR_ERROR) != 0) & ((core & EARLY_SAT) != 0)
        saturated = bool(((core & SAT_MASK) != 0).any() or early.any())
    else:
        lam = bw = flux = ferr = flux_d = np.nan
        fbad, saturated = 1.0, False

    whdr = wcs.to_header(relax=True)
    for k in ("DETECTOR", "OBSID", "MJD-OBS", "DATE-OBS", "BUNIT", "EXPTIME"):
        if k in hdr:
            whdr[k] = hdr[k]
    fits.HDUList([fits.PrimaryHDU(),
                  fits.ImageHDU(sci.astype(np.float32), whdr, name="SCI"),
                  fits.ImageHDU((bad & ~dbad).astype(np.uint8), whdr, name="BAD"),
                  fits.ImageHDU(sat.astype(np.uint8), whdr, name="SAT")]).writeto(dest + ".part", overwrite=True)
    os.replace(dest + ".part", dest)

    counts = {b: int(((flags >> n) & 1).sum()) for b, n in BITS.items()}
    return dict(file=row["file"], obs_id=row["obs_id"], release=row.get("release", ""), mjd=row["mjd"],
                visit=row["visit"], detector=row["detector"], x=round(x, 2), y=round(y, 2),
                wavelength_um=round(lam, 4), bandwidth_um=round(bw, 4), zodi_missing=zodi_missing,
                sky_mjysr=round(sky, 4), noise_mjysr=round(noise, 4), flux_ujy=round(flux, 2),
                err_ujy=round(ferr, 2), flux_display_ujy=round(flux_d, 2),
                aperture_bad_frac=round(fbad, 2), flagged=bool(fbad >= 0.3 or not np.isfinite(flux)),
                saturated=saturated, bad_frac=round(float(bad.mean()), 4),
                flag_counts=json.dumps({k: v for k, v in counts.items() if v}))


def run(t, workers, force):
    d = os.path.join(CACHE, t["id"])
    manifest = os.path.join(d, "manifest.csv")
    out_csv = os.path.join(OUT, "clean", t["id"] + ".csv")
    if not os.path.exists(manifest):
        print(f"{t['id']}: nothing downloaded yet (run step2_download.py)", flush=True)
        return False
    if not force and os.path.exists(out_csv) and os.path.getmtime(out_csv) > os.path.getmtime(manifest):
        print(f"{t['id']}: already clean", flush=True)
        return True
    with open(manifest, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    os.makedirs(os.path.join(d, "clean"), exist_ok=True)
    jobs = [(os.path.join(d, r["file"]), os.path.join(d, "clean", r["file"]), t, r) for r in rows]
    recs, skipped = [], 0
    with ProcessPoolExecutor(workers) as ex:
        futures = [ex.submit(clean_one, j) for j in jobs]
        for j, f in zip(jobs, futures):
            try:
                recs.append(f.result())
            except Exception as e:  # noqa: BLE001
                skipped += 1
                print(f"  skip {os.path.basename(j[0])}: {str(e)[:100]}", flush=True)
    if not recs:
        print(f"{t['id']}: no frame could be cleaned", flush=True)
        return False
    os.makedirs(os.path.dirname(out_csv), exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(recs[0].keys()))
        w.writeheader()
        w.writerows(recs)
    good = sum(1 for r in recs if np.isfinite(r["flux_ujy"]) and r["aperture_bad_frac"] < 0.3)
    print(f"{t['id']}: {len(recs)} cleaned, {skipped} skipped, {good} good target measurements, "
          f"{sum(r['saturated'] for r in recs)} saturated, {sum(r['zodi_missing'] for r in recs)} without ZODI",
          flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    for t in load_targets(a.only):
        run(t, a.workers, a.force)


if __name__ == "__main__":
    main()
