"""Write a small simulated patch so the site can be built before real data exists.

3 dates x 7 bands (all, 1..6) of 147x147 PNGs: a field of fixed stars, one star that moves 2 px north per
date and one that doubles in brightness. Everything is marked "simulated": true.

    python tools/make_sample_data.py [--site public/data]
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

PATCH_ID = "sample"
SIZE = 147
SCALE = 6.15
RA0, DEC0 = 150.1, 2.2
MJDS = [60810.4, 60995.6, 61180.3]
DETECTORS = ["all", 1, 2, 3, 4, 5, 6]
WAVE = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41),
        6: (4.42, 5.00), "all": (0.75, 5.00)}
SR_PER_PX = (SCALE / 206264.806) ** 2
SIGMA_PX = 1.1
FLAG_BITS = {"HOT": 10, "PERSIST": 17, "SOURCE": 21}

MOVER_START = (73.0, 80.0)
MOVER_STEP = 2.0
VARIABLE_XY = (40.0, 105.0)
VARIABLE_GAIN = [1.0, math.sqrt(2.0), 2.0]


def mjd_to_date(mjd):
    days = int(mjd) - 40587
    return str(np.datetime64("1970-01-01") + np.timedelta64(days, "D"))


def pix_to_radec(x, y):
    c = (SIZE - 1) / 2
    dec = DEC0 + (c - y) * SCALE / 3600
    ra = RA0 - (x - c) * SCALE / 3600 / math.cos(math.radians(DEC0))
    return round(ra, 6), round(dec, 6)


def star_image(stars):
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    img = np.zeros((SIZE, SIZE))
    for x, y, peak in stars:
        img += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * SIGMA_PX ** 2))
    return img


def planck(lam, temp):
    return lam ** -3 / (math.exp(1.44e4 / (lam * temp)) - 1)


def colour(det, temp):
    # blackbody slope relative to the mean over the six detectors, so cool objects brighten toward D6
    if det == "all":
        return 1.0
    mean = sum(planck(sum(WAVE[d]) / 2, temp) for d in range(1, 7)) / 6
    return planck(sum(WAVE[det]) / 2, temp) / mean


def asinh_stretch(img, black, knee, top):
    scaled = np.arcsinh(np.clip(img - black, 0, None) / knee) / np.arcsinh((top - black) / knee)
    return (np.clip(scaled, 0, 1) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="public/data")
    args = ap.parse_args()
    site = Path(args.site)
    frame_dir = site / "frames" / PATCH_ID
    frame_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(2026)

    fixed = [(rng.uniform(5, SIZE - 5), rng.uniform(5, SIZE - 5), rng.lognormal(1.0, 0.9), rng.uniform(2500, 9000))
             for _ in range(45)]
    noise = 0.08

    raw = {}
    for v, mjd in enumerate(MJDS):
        mover = (MOVER_START[0], MOVER_START[1] - MOVER_STEP * v)
        for det in DETECTORS:
            stars = [(x, y, p * colour(det, t)) for x, y, p, t in fixed]
            stars.append((mover[0], mover[1], 6.0 * colour(det, 1200)))
            stars.append((VARIABLE_XY[0], VARIABLE_XY[1], 3.0 * VARIABLE_GAIN[v] * colour(det, 3500)))
            sky = 0.4 + (0.1 * (det if det != "all" else 3))
            img = sky + star_image(stars) + rng.normal(0, noise, (SIZE, SIZE))
            raw[(v, det)] = img

    stretch = {}
    for det in DETECTORS:
        allpix = np.concatenate([raw[(v, det)].ravel() for v in range(len(MJDS))])
        black = float(np.median(allpix))
        mad = float(1.4826 * np.median(np.abs(allpix - black)))
        top = max(float(np.percentile(allpix, 99.95)), black + 200 * mad)
        stretch[det] = {"black": round(black, 4), "knee": round(4 * mad, 4), "top": round(top, 4)}

    frames = []
    for v, mjd in enumerate(MJDS):
        for det in DETECTORS:
            st = stretch[det]
            name = f"v{v:02d}_{det}"
            Image.fromarray(asinh_stretch(raw[(v, det)], **st)).save(frame_dir / f"{name}.png", optimize=True)

            flags = np.zeros((SIZE, SIZE), np.uint8)
            hx, hy = 20 + 30 * v, 25
            flags[hy:hy + 3, hx:hx + 3] = 255
            flags[120, 10 + 40 * v] = 255
            Image.fromarray(flags).save(frame_dir / f"{name}_flags.png", optimize=True)

            n_exp = 18 if det == "all" else 3
            frames.append({
                "file": f"frames/{PATCH_ID}/{name}.png",
                "flags_file": f"frames/{PATCH_ID}/{name}_flags.png",
                "mjd": mjd,
                "date": mjd_to_date(mjd),
                "visit": v,
                "band": str(det),
                "detector": det,
                "wavelength_um": list(WAVE[det]),
                "n_exposures": n_exp,
                "coverage": 1.0 if v != 1 else 0.98,
                "saturated": False,
                "stretch": st,
                "flags": ["simulated hot pixels and one persistence spot"],
                "flag_bits": {"HOT": 9, "PERSIST": 1},
            })

    light_curve = []
    for v, mjd in enumerate(MJDS):
        for det in DETECTORS[1:]:
            flux = 3.0 * VARIABLE_GAIN[v] * colour(det, 3500) * 2 * math.pi * SIGMA_PX ** 2 * SR_PER_PX * 1e12
            light_curve.append({
                "mjd": mjd, "flux_ujy": round(flux, 3), "err": round(0.03 * flux + 0.5, 3), "detector": det,
                "wavelength_um": list(WAVE[det]), "flagged": False, "approximate": False,
            })

    gaia, wise = [], []
    for i, (x, y, p, t) in enumerate(sorted(fixed, key=lambda s: -s[2])[:12]):
        ra, dec = pix_to_radec(x, y)
        gaia.append({"ra": ra, "dec": dec, "label": f"Simulated Gaia {i + 1}", "epoch": 2016.0,
                     "pmra": 0.0, "pmdec": 0.0, "mag": round(14 - 2.5 * math.log10(p + 0.1), 2)})
        if i < 8:
            wise.append({"ra": ra, "dec": dec, "label": f"Simulated WISE {i + 1}", "epoch": 2015.4,
                         "pmra": 0.0, "pmdec": 0.0, "mag": round(12 - 2.5 * math.log10(p + 0.1), 2)})

    years = (MJDS[-1] - MJDS[0]) / 365.25
    mover_pm = MOVER_STEP * (len(MJDS) - 1) * SCALE / years
    predictions = [
        {"id": "p1", "label": "Fast mover (simulated)", "kind": "mover", "confidence": 0.95,
         "pm_arcsec_yr": round(mover_pm, 1), "match": None,
         "track": [{"epoch": v, "x": MOVER_START[0], "y": MOVER_START[1] - MOVER_STEP * v} for v in range(len(MJDS))]},
        {"id": "p2", "label": "Brightening star (simulated)", "kind": "variable", "confidence": 0.9,
         "track": [{"epoch": v, "x": VARIABLE_XY[0], "y": VARIABLE_XY[1]} for v in range(len(MJDS))]},
    ]

    fov = round(SIZE * SCALE / 3600, 4)
    patch = {
        "patch": {"id": PATCH_ID, "name": "Simulated test field", "kind": "simulated", "width_px": SIZE,
                  "height_px": SIZE, "ra": RA0, "dec": DEC0, "epoch": 2026.0, "fov_deg": fov,
                  "pixel_scale_arcsec": SCALE, "simulated": True, "pipeline_version": "sample-1"},
        "frames": frames,
        "light_curve": light_curve,
        "overlays": {"gaia": gaia, "wise": wise},
        "predictions": predictions,
        "verdicts": {"motion": "moves", "variability": "changing",
                     "notes": ["Simulated data for building the site. One star moves 2 px north per date; "
                               "the one at lower left doubles in brightness."]},
    }
    (site / f"{PATCH_ID}.json").write_text(json.dumps(patch, indent=1) + "\n", encoding="utf-8")

    patch_entry = {"id": PATCH_ID, "title": "Simulated test field", "ra": RA0, "dec": DEC0, "fov_deg": fov,
                   "simulated": True}
    gallery_entry = {"id": PATCH_ID, "name": "Simulated test field", "type": "star", "ra": RA0, "dec": DEC0,
                     "fov": fov, "thumb": f"frames/{PATCH_ID}/v00_all.png", "status": "simulated",
                     "blurb": "Made-up stars for testing the viewer. One moves, one gets brighter.",
                     "simulated": True}
    extra = site / "extra"
    extra.mkdir(exist_ok=True)
    (extra / f"{PATCH_ID}.json").write_text(
        json.dumps({"patch_entry": patch_entry, "gallery_entry": gallery_entry}, indent=1) + "\n", encoding="utf-8")

    # merge_lists.py rebuilds these later; until it exists we write the sample entry directly
    for fname, entry in (("patches.json", patch_entry), ("gallery.json", gallery_entry)):
        path = site / fname
        items = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        items = [e for e in items if e.get("id") != PATCH_ID] + [entry]
        path.write_text(json.dumps(items, indent=1) + "\n", encoding="utf-8")

    print(f"wrote {len(frames)} frames to {frame_dir}")


if __name__ == "__main__":
    main()
