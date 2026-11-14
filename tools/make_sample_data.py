"""Write a small simulated patch so the site can be built before real data exists.

3 dates x 7 bands (all, 1..6) of 147x147 PNGs: a field of fixed stars, one star that moves 2 px north per
date and one that doubles in brightness. Also the Sky Dome sample: dome/bands.json, dome/poi.json, cubes for
the sample field and 8 hand-made galaxies and nebulae in extra/. Everything is marked "simulated": true.

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
    (site / "extra").mkdir(exist_ok=True)

    # merge_lists.py rebuilds these later; until it exists we write the sample entry directly
    for fname, entry in (("patches.json", patch_entry), ("gallery.json", gallery_entry)):
        path = site / fname
        items = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        items = [e for e in items if e.get("id") != PATCH_ID] + [entry]
        path.write_text(json.dumps(items, indent=1) + "\n", encoding="utf-8")

    print(f"wrote {len(frames)} frames to {frame_dir}")

    poi_entry = write_dome_sample(site, fixed, patch_entry, gallery_entry)
    write_dome_lists(site)
    print(f"wrote Sky Dome sample: {poi_entry['id']} + {len(SIM_OBJECTS)} simulated objects")


# Sky Dome sample ------------------------------------------------------------------------------------
# Band layout follows the mission: 6 detectors x 17 channels, log-spaced, resolving power per detector.
BAND_R = {1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128}
TILE = 32
CATEGORIES = {
    "star": {"label": "Fast stars", "color": "#ffe28a", "shape": "circle"},
    "brown-dwarf": {"label": "Brown dwarfs", "color": "#ff9a5c", "shape": "diamond"},
    "variable": {"label": "Variable stars", "color": "#ff7ad9", "shape": "ring"},
    "galaxy": {"label": "Galaxies", "color": "#9fa8ff", "shape": "square"},
    "nebula": {"label": "Nebulae and clusters", "color": "#6fe3c5", "shape": "square"},
    "test": {"label": "Test field", "color": "#c99bff", "shape": "circle"},
}
# hand-made objects so the dome has something to show before real data; all marked simulated
SIM_OBJECTS = [
    ("sim_m31", "Andromeda Galaxy (M31)", "galaxy", 10.6847, 41.2690, 3.0, "spiral", "Our big neighbour galaxy, 2.5 million light years away."),
    ("sim_m51", "Whirlpool Galaxy (M51)", "galaxy", 202.4696, 47.1952, 0.2, "spiral", "A face-on spiral pulling on a small companion."),
    ("sim_lmc", "Large Magellanic Cloud", "galaxy", 80.8942, -69.7561, 8.0, "irregular", "A small galaxy orbiting the Milky Way, seen from the far south."),
    ("sim_m42", "Orion Nebula (M42)", "nebula", 83.8221, -5.3911, 1.0, "hii", "The nearest big star nursery, glowing in hydrogen and warm dust."),
    ("sim_carina", "Carina Nebula", "nebula", 161.2650, -59.8670, 2.0, "hii", "A huge cloud lit by some of the most massive stars known."),
    ("sim_crab", "Crab Nebula (M1)", "nebula", 83.6331, 22.0145, 0.12, "remnant", "What's left of a star that exploded in 1054."),
    ("sim_pleiades", "Pleiades (M45)", "nebula", 56.7500, 24.1167, 1.8, "cluster", "A young cluster of hot blue stars wrapped in dust."),
    ("sim_gc", "Galactic Centre", "nebula", 266.4168, -29.0078, 2.0, "dusty", "The crowded heart of our galaxy, hidden behind dust in visible light."),
]


def band_table():
    bands = []
    for det in range(1, 7):
        lo, hi = WAVE[det]
        for ch in range(17):
            centre = lo * (hi / lo) ** ((ch + 0.5) / 17)
            bands.append({"index": len(bands), "detector": det, "channel": ch, "center_um": round(centre, 4),
                          "width_um": round(centre / BAND_R[det], 4), "resolving_power": BAND_R[det]})
    return bands


def planck_at(lam, temp):
    return lam ** -3 / (math.exp(min(1.44e4 / (lam * temp), 700)) - 1)


def colour_at(lam, temp):
    # same normalisation as colour(), at any wavelength
    return planck(lam, temp) / (sum(planck(sum(WAVE[d]) / 2, temp) for d in range(1, 7)) / 6)


def gauss_line(lam, centre, width, amp):
    return amp * math.exp(-0.5 * ((lam - centre) / width) ** 2)


def sim_spectrum(kind, lams):
    out = []
    for lam in lams:
        if kind == "spiral":
            f = planck_at(lam, 4200) + gauss_line(lam, 3.3, 0.05, 0.25 * planck_at(1.6, 4200))
        elif kind == "irregular":
            f = planck_at(lam, 6000) + 0.015 * planck_at(lam, 700)
        elif kind == "hii":
            base = planck_at(1.0, 9000)
            f = (0.25 * planck_at(lam, 9000) + 0.6 * base * (lam / 5) ** 2
                 + sum(gauss_line(lam, c, w, a * base) for c, w, a in
                       ((1.282, 0.02, 0.5), (1.875, 0.03, 1.2), (2.166, 0.03, 0.4), (3.3, 0.05, 0.7), (4.05, 0.03, 0.9))))
        elif kind == "remnant":
            f = lam ** -0.6 + gauss_line(lam, 1.644, 0.03, 0.4)
        elif kind == "cluster":
            f = planck_at(lam, 11000) + 0.02 * planck_at(1.0, 11000) * (lam / 5) ** 2
        else:  # dusty
            f = planck_at(lam, 3500) * (1 - math.exp(-lam / 1.5)) + gauss_line(lam, 4.05, 0.03, 0.2 * planck_at(2.0, 3500))
        out.append(f)
    top = max(out)
    return [round(v / top, 4) for v in out]


def sim_shape(kind, rng):
    yy, xx = np.mgrid[0:TILE, 0:TILE] - (TILE - 1) / 2
    if kind in ("spiral", "irregular"):
        r = np.hypot(xx, yy * 1.6)
        theta = np.arctan2(yy * 1.6, xx)
        arms = 1 + (0.6 * np.cos(2 * theta - r / 3) if kind == "spiral" else 0.4 * np.cos(theta * 3 + r / 2))
        img = np.exp(-r / 4.5) * arms + 1.5 * np.exp(-r ** 2 / 4)
    elif kind == "cluster":
        img = 0.2 * np.exp(-np.hypot(xx, yy) / 10)
        for _ in range(9):
            x, y = rng.uniform(-11, 11, 2)
            img += np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / 1.5)
    elif kind == "remnant":
        r = np.hypot(xx * 1.3, yy)
        img = np.exp(-r / 5) * (1 + 0.5 * np.sin(xx * 1.7) * np.cos(yy * 1.3)) + np.exp(-r ** 2 / 2)
    else:
        img = np.zeros((TILE, TILE))
        for _ in range(6):
            x, y = rng.uniform(-8, 8, 2)
            s = rng.uniform(3, 8)
            img += rng.uniform(0.4, 1) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))
    return img / img.max()


def sim_tile(shape, rng, value):
    img = shape * (0.12 + 0.88 * value) + rng.normal(0, 0.006, shape.shape)
    return (np.clip(np.arcsinh(np.clip(img, 0, None) * 6) / np.arcsinh(6), 0, 1) * 255).astype(np.uint8)


def write_cube(path, tiles):
    cube = np.zeros((6 * TILE, 17 * TILE), np.uint8)
    for (det, ch), tile in tiles.items():
        cube[(det - 1) * TILE:det * TILE, ch * TILE:(ch + 1) * TILE] = tile
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(cube).save(path, optimize=True)


def write_dome_sample(site, fixed, patch_entry, gallery_entry):
    rng = np.random.default_rng(102)
    dome = site / "dome"
    bands = band_table()
    lams = [b["center_um"] for b in bands]

    # sample field: tiles centred on the brightening star, same simulated stars as the frames
    yy, xx = np.mgrid[0:TILE, 0:TILE]
    x0, y0 = VARIABLE_XY[0] - TILE, VARIABLE_XY[1] - TILE
    stars_px = fixed
    epochs = []
    for v, mjd in enumerate(MJDS):
        mover = (MOVER_START[0], MOVER_START[1] - MOVER_STEP * v)
        tiles = {}
        for b in bands:
            lam = b["center_um"]
            srcs = [(x, y, p * colour_at(lam, t)) for x, y, p, t in stars_px]
            srcs.append((mover[0], mover[1], 6.0 * colour_at(lam, 1200)))
            srcs.append((VARIABLE_XY[0], VARIABLE_XY[1], 3.0 * VARIABLE_GAIN[v] * colour_at(lam, 3500)))
            img = np.zeros((TILE, TILE))
            for x, y, p in srcs:
                # tile pixel = 2x2 frame pixels
                img += p * np.exp(-((x0 + 2 * xx + 0.5 - x) ** 2 + (y0 + 2 * yy + 0.5 - y) ** 2) / (2 * SIGMA_PX ** 2))
            img += 0.5 + rng.normal(0, 0.03, img.shape)
            tiles[(b["detector"], b["channel"])] = asinh_stretch(img, 0.5, 0.15, 8.0)
        write_cube(dome / "cubes" / PATCH_ID / f"e{v:02d}.png", tiles)
        epochs.append({"mjd": mjd, "cube": f"dome/cubes/{PATCH_ID}/e{v:02d}.png",
                       "brightness": round(VARIABLE_GAIN[v] / VARIABLE_GAIN[-1], 4)})
    spec = [planck(lam, 3500) for lam in lams]
    poi_entry = {"id": PATCH_ID, "name": "Simulated test field", "category": "test", "type": "star",
                 "ra": RA0, "dec": DEC0, "size": patch_entry["fov_deg"],
                 "blurb": "Made-up stars for testing. The spectrum is the star that brightens.",
                 "patch": PATCH_ID, "spectrum": [round(s / max(spec), 4) for s in spec], "bands_measured": 102,
                 "simulated": True, "epochs": epochs}
    extra = site / "extra"
    (extra / f"{PATCH_ID}.json").write_text(json.dumps(
        {"patch_entry": patch_entry, "gallery_entry": gallery_entry, "poi_entry": poi_entry}, indent=1) + "\n",
        encoding="utf-8")

    for oid, name, cat, ra, dec, size, kind, blurb in SIM_OBJECTS:
        spec = sim_spectrum(kind, lams)
        shape = sim_shape(kind, rng)
        tiles = {(b["detector"], b["channel"]): sim_tile(shape, rng, spec[b["index"]]) for b in bands}
        write_cube(dome / "cubes" / oid / "e00.png", tiles)
        poi = {"id": oid, "name": name, "category": cat, "type": cat, "ra": ra, "dec": dec, "size": size,
               "blurb": blurb, "patch": None, "spectrum": spec, "bands_measured": 102, "simulated": True,
               "epochs": [{"mjd": MJDS[-1], "cube": f"dome/cubes/{oid}/e00.png", "brightness": 1.0}]}
        (extra / f"{oid}.json").write_text(json.dumps({"poi_entry": poi}, indent=1) + "\n", encoding="utf-8")

    (dome / "bands.json").write_text(json.dumps(bands, indent=1) + "\n", encoding="utf-8")
    return poi_entry


def write_dome_lists(site):
    # stand-in for merge_lists.py: every poi_entry from extra/ and pipeline fragments already in poi.json
    path = site / "dome" / "poi.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"pois": []}
    pois = {p["id"]: p for p in current.get("pois", []) if not p.get("simulated")}
    for f in sorted((site / "extra").glob("*.json")):
        entry = json.loads(f.read_text(encoding="utf-8")).get("poi_entry")
        if entry:
            pois[entry["id"]] = entry
    ordered = sorted(pois.values(), key=lambda p: (bool(p.get("simulated")), p["id"]))
    path.write_text(json.dumps({"categories": CATEGORIES, "pois": ordered}, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
