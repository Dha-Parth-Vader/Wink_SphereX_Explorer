"""Shared pieces for steps 4 to 7: the stack.fits layout, the field geometry, targets and SPHEREx bands.

stack.fits (written by step 4, read by steps 5 to 7 and the live server), one file per target in
cache/<id>/stack.fits. Arrays are in FITS order: row 0 = south, x grows to the west (east left).

    PRIMARY        header only: TARGET, RA, DEC (grid centre at EPOCH), EPOCH = 2026.0, PIXSCALE (arcsec),
                   NX, NY, PIPEVER
    Vnn_b          one image per visit nn (00, 01, ...) and band b (ALL, D1 .. D6), MJy/sr, smooth background
                   removed, NaN where nothing covered the pixel. Header: VISIT, MJD, MJDMIN, MJDMAX, NFRAMES,
                   WAVEMIN, WAVEMAX (um), COVERAGE (0-1 share of the field with data), SATUR (T/F),
                   SKY, NOISE (MJy/sr, MAD-based), FB_<FLAGNAME> = pixel counts from the display mask
    Vnn_b_ERR      optional 1-sigma map, MJy/sr (else NOISE is used everywhere)
    Vnn_b_FLAGS    optional uint8 display mask, 1 = flagged (R7)
    Vnn_CUBE       optional float32 (102, 32, 32) central tiles per SPHEREx band for the Sky Dome, NaN where
                   a band wasn't measured in that visit

out/clean/<id>.csv (step 3) holds per-exposure target photometry with columns
obs_id, mjd, visit, detector, wavelength_um, flux_ujy, err_ujy, flagged, saturated.
"""
import csv
import json
import math
import os
from pathlib import Path

import numpy as np

PIPELINE_VERSION = "2"

PIPE = Path(__file__).resolve().parent
ROOT = PIPE.parent
OUT = PIPE / "out"
CACHE = PIPE / "cache"
SITE = ROOT / "public" / "data"

SCALE = 6.15
SR_PER_PX = (SCALE / 206264.806) ** 2
EPOCH = 2026.0
SURVEY_START_MJD = 60796

BANDS = ["ALL", "D1", "D2", "D3", "D4", "D5", "D6"]
DETECTOR_RANGE = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82),
                  5: (3.83, 4.41), 6: (4.42, 5.00)}
DETECTOR_R = {1: 39, 2: 41, 3: 41, 4: 35, 5: 112, 6: 128}
CHANNELS = 17

FLAG_BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "PHANTOM": 4, "REFERENCE": 5, "NONFUNC": 6,
             "DICHROIC": 7, "MISSING_DATA": 9, "HOT": 10, "COLD": 11, "FULLSAMPLE": 12, "PHANMISS": 14,
             "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "CROSSTALK": 20, "SOURCE": 21, "GHOST": 22,
             "GHOST_FPA": 23, "GHOST_EXT": 24, "STREAK": 25, "BLOOM": 26, "SNOWBALL": 27, "HALO": 28,
             "SATELLITE_HALO": 29}


def band_table():
    """The 102 SPHEREx bands: 17 channels per detector, evenly spaced in log wavelength."""
    rows = []
    for det in range(1, 7):
        lo, hi = DETECTOR_RANGE[det]
        for ch in range(CHANNELS):
            centre = lo * (hi / lo) ** ((ch + 0.5) / CHANNELS)
            rows.append({"index": len(rows), "detector": det, "channel": ch, "center_um": round(centre, 4),
                         "width_um": round(centre / DETECTOR_R[det], 4), "resolving_power": DETECTOR_R[det]})
    return rows


def band_index(wavelength_um):
    """Index 0-101 of the band containing this wavelength, or None outside 0.75-5.0 um."""
    for det, (lo, hi) in DETECTOR_RANGE.items():
        if lo <= wavelength_um <= hi:
            ch = int(CHANNELS * math.log(wavelength_um / lo) / math.log(hi / lo))
            return (det - 1) * CHANNELS + min(ch, CHANNELS - 1)
    return None


def band_name(det):
    return "ALL" if det in ("all", "ALL", None) else f"D{int(det)}"


def det_value(band):
    """'ALL' -> 'all', 'D3' -> 3 (the form the site uses)."""
    return "all" if band == "ALL" else int(band[1:])


def mjd_to_year(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25


def mjd_to_date(mjd):
    return str(np.datetime64("1970-01-01") + np.timedelta64(int(mjd) - 40587, "D"))


def survey_number(mjd):
    return int((mjd - SURVEY_START_MJD) // 182.6) + 1


def propagate(ra, dec, pmra_mas, pmdec_mas, from_epoch, to_epoch):
    """Move a position by its proper motion (pmra includes cos dec, as in Gaia and CatWISE)."""
    dt = to_epoch - from_epoch
    dec2 = dec + (pmdec_mas or 0) * dt / 3.6e6
    ra2 = ra + (pmra_mas or 0) * dt / 3.6e6 / math.cos(math.radians((dec + dec2) / 2))
    return ra2 % 360, dec2


def separation_arcsec(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    s = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(s)))) * 3600


class Grid:
    """TAN grid centred on (ra0, dec0). Pixel (0, 0) is the south-east corner in FITS order."""

    def __init__(self, ra0, dec0, nx, ny, scale=SCALE):
        self.ra0, self.dec0, self.nx, self.ny, self.scale = ra0, dec0, nx, ny, scale
        self.cx, self.cy = (nx - 1) / 2, (ny - 1) / 2

    def to_pix(self, ra, dec):
        a, d = np.radians(ra), np.radians(dec)
        a0, d0 = math.radians(self.ra0), math.radians(self.dec0)
        cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
        xi = np.cos(d) * np.sin(a - a0) / cosc
        eta = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / cosc
        k = 206264.806 / self.scale
        return self.cx - xi * k, self.cy + eta * k

    def to_radec(self, x, y):
        k = self.scale / 206264.806
        xi, eta = -(np.asarray(x, float) - self.cx) * k, (np.asarray(y, float) - self.cy) * k
        a0, d0 = math.radians(self.ra0), math.radians(self.dec0)
        rho = np.hypot(xi, eta)
        c = np.arctan(rho)
        with np.errstate(invalid="ignore", divide="ignore"):
            dec = np.arcsin(np.cos(c) * np.sin(d0) + np.where(rho > 0, eta * np.sin(c) * np.cos(d0) / rho, 0))
        ra = a0 + np.arctan2(xi * np.sin(c), rho * np.cos(d0) * np.cos(c) - eta * np.sin(d0) * np.sin(c))
        return np.degrees(ra) % 360, np.degrees(dec)

    def tan_header(self):
        return {"CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN", "CRVAL1": self.ra0, "CRVAL2": self.dec0,
                "CRPIX1": self.cx + 1, "CRPIX2": self.cy + 1, "CDELT1": -self.scale / 3600,
                "CDELT2": self.scale / 3600, "CUNIT1": "deg", "CUNIT2": "deg"}


class Stack:
    """Everything in one stack.fits, as plain numpy arrays and dicts."""

    def __init__(self, header, images, extras, cubes):
        self.header = header
        self.images = images      # {(visit, band): (data, header)}
        self.extras = extras      # {(visit, band, "ERR" | "FLAGS"): array}
        self.cubes = cubes        # {visit: (102, 32, 32) array}
        self.grid = Grid(header["RA"], header["DEC"], header["NX"], header["NY"], header.get("PIXSCALE", SCALE))

    @property
    def visits(self):
        return sorted({v for v, _ in self.images})

    def bands(self, visit):
        return [b for b in BANDS if (visit, b) in self.images]

    def image(self, visit, band):
        return self.images[(visit, band)][0] if (visit, band) in self.images else None

    def meta(self, visit, band="ALL"):
        if (visit, band) in self.images:
            return self.images[(visit, band)][1]
        for b in BANDS:
            if (visit, b) in self.images:
                return self.images[(visit, b)][1]
        return {}

    def error(self, visit, band):
        err = self.extras.get((visit, band, "ERR"))
        if err is not None:
            return err
        data, hdr = self.images[(visit, band)]
        noise = hdr.get("NOISE") or robust_noise(data)
        return np.full(data.shape, noise, float)

    def flags(self, visit, band):
        flags = self.extras.get((visit, band, "FLAGS"))
        data = self.image(visit, band)
        return flags.astype(bool) if flags is not None else np.zeros(data.shape, bool)

    def mjd(self, visit):
        hdr = self.meta(visit)
        return hdr.get("MJD") or (hdr["MJDMIN"] + hdr["MJDMAX"]) / 2


def stack_path(target_id):
    return CACHE / target_id / "stack.fits"


def read_stack(path):
    from astropy.io import fits

    images, extras, cubes = {}, {}, {}
    with fits.open(path, memmap=False) as hdul:
        if "STACK" in hdul:
            return _read_cube_stack(Path(path), hdul)
        header = dict(hdul[0].header)
        for hdu in hdul[1:]:
            name = hdu.name.upper()
            parts = name.split("_")
            if not parts[0].startswith("V") or not parts[0][1:].isdigit():
                continue
            visit = int(parts[0][1:])
            data = np.asarray(hdu.data, dtype=float)
            if parts[1] == "CUBE":
                cubes[visit] = data
            elif len(parts) == 2:
                images[(visit, parts[1])] = (data, dict(hdu.header))
            else:
                extras[(visit, parts[1], parts[2])] = data
    return Stack(header, images, extras, cubes)


def _read_cube_stack(path, hdul):
    """Step 4's layout: STACK, NFRAMES, SATFRAC and FLAGFRAC cubes [visit, band, y, x] with band 0 = all,
    1-6 = detectors, 7 = cold. Per-visit details come from out/stack/<id>.json."""
    target_id = path.parent.name
    info = read_json(OUT / "stack" / f"{target_id}.json", {}) or {}
    h0 = hdul[0].header
    stack, flagfrac = hdul["STACK"].data, hdul["FLAGFRAC"].data
    ny, nx = stack.shape[-2:]
    header = {"TARGET": target_id, "RA": float(h0["CRVAL1"]), "DEC": float(h0["CRVAL2"]), "EPOCH": EPOCH,
              "PIXSCALE": abs(float(h0["CDELT2"])) * 3600, "NX": nx, "NY": ny, "PIPEVER": PIPELINE_VERSION}
    images, extras = {}, {}
    for i, meta in enumerate(info.get("visits", [])):
        if i >= stack.shape[0]:
            break
        visit = int(meta["visit"])
        dets = meta.get("detectors", {})
        for b, band in enumerate(BANDS):
            data = np.asarray(stack[i, b], dtype=float)
            if not np.isfinite(data).any():
                continue
            if band == "ALL":
                used = list(dets.values())
                lams = [w for d in used if d.get("wavelength_um") for w in d["wavelength_um"]]
                nfr = sum(d["n_frames"] for d in used)
                coverage = meta.get("coverage_all", float(np.isfinite(data).mean()))
                sat = any(d.get("target_saturated_frac", 0) >= 0.5 for d in used)
                bits = {}
                for d in used:
                    for k, v in d.get("flag_bits", {}).items():
                        bits[k] = bits.get(k, 0) + v
            else:
                d = dets.get(band[1:])
                if not d:
                    continue
                lams = d.get("wavelength_um") or []
                nfr, coverage = d["n_frames"], d.get("coverage", float(np.isfinite(data).mean()))
                sat, bits = d.get("target_saturated_frac", 0) >= 0.5, d.get("flag_bits", {})
            hdr = {"VISIT": visit, "MJD": meta.get("mjd_mean"), "MJDMIN": meta.get("mjd_min"),
                   "MJDMAX": meta.get("mjd_max"), "NFRAMES": nfr, "COVERAGE": coverage, "SATUR": bool(sat),
                   "NOISE": robust_noise(data)}
            if lams:
                hdr["WAVEMIN"], hdr["WAVEMAX"] = min(lams), max(lams)
            hdr.update({f"FB_{k}": v for k, v in bits.items()})
            images[(visit, band)] = (data, hdr)
            # step 4 keeps the share of frames the science mask dropped; flag pixels most frames dropped
            extras[(visit, band, "FLAGS")] = np.asarray(flagfrac[i, b] >= 0.5, np.uint8)
    return Stack(header, images, extras, {})


def write_stack(path, grid, target_id, images, extras=None, cubes=None):
    """images: {(visit, band): (array, header dict)}; extras: {(visit, band, "ERR"|"FLAGS"): array}."""
    from astropy.io import fits

    primary = fits.PrimaryHDU()
    for key, value in {"TARGET": target_id, "RA": grid.ra0, "DEC": grid.dec0, "EPOCH": EPOCH,
                       "PIXSCALE": grid.scale, "NX": grid.nx, "NY": grid.ny, "PIPEVER": PIPELINE_VERSION}.items():
        primary.header[key] = value
    hdus = [primary]
    for (visit, band), (data, hdr) in sorted(images.items()):
        hdu = fits.ImageHDU(np.asarray(data, np.float32), name=f"V{visit:02d}_{band}")
        for key, value in {**grid.tan_header(), **hdr}.items():
            hdu.header[key] = value
        hdus.append(hdu)
    for (visit, band, kind), data in sorted((extras or {}).items()):
        dtype = np.uint8 if kind == "FLAGS" else np.float32
        hdus.append(fits.ImageHDU(np.asarray(data, dtype), name=f"V{visit:02d}_{band}_{kind}"))
    for visit, cube in sorted((cubes or {}).items()):
        hdus.append(fits.ImageHDU(np.asarray(cube, np.float32), name=f"V{visit:02d}_CUBE"))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.fits")
    fits.HDUList(hdus).writeto(tmp, overwrite=True)
    os.replace(tmp, path)


def robust_noise(data):
    """MAD noise of the finite pixels, never NaN or zero (R8)."""
    vals = data[np.isfinite(data)]
    if vals.size < 10:
        return 1.0
    for _ in range(3):
        med = np.median(vals)
        mad = 1.4826 * np.median(np.abs(vals - med))
        keep = np.abs(vals - med) < 3 * mad if mad > 0 else np.ones(vals.size, bool)
        if keep.sum() < 10:
            break
        vals = vals[keep]
    mad = 1.4826 * np.median(np.abs(vals - np.median(vals)))
    return float(mad) if mad > 0 else float(np.std(vals) or 1.0)


def fill_holes(data, max_iter=60):
    """Fill NaN holes that don't touch the edge (saturated cores) by repeated 3x3 grey dilation (R19)."""
    from scipy import ndimage

    nan = ~np.isfinite(data)
    if not nan.any():
        return data.copy()
    labels, n = ndimage.label(nan)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    holes = nan & ~np.isin(labels, list(edge))
    out = data.copy()
    for _ in range(max_iter):
        if not holes.any():
            break
        work = np.where(np.isfinite(out), out, -np.inf)
        grown = ndimage.grey_dilation(work, size=(3, 3))
        fill = holes & np.isfinite(grown)
        out[fill] = grown[fill]
        holes &= ~fill
    return out


def aperture_sum(data, x, y, radius=2.0):
    """Sum of pixels within radius of (x, y); returns (sum, n_pixels, any_nan)."""
    ny, nx = data.shape
    x0, x1 = max(0, int(x - radius - 1)), min(nx, int(x + radius + 2))
    y0, y1 = max(0, int(y - radius - 1)), min(ny, int(y + radius + 2))
    if x0 >= x1 or y0 >= y1:
        return float("nan"), 0, True
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
    vals = data[y0:y1, x0:x1][inside]
    return float(np.nansum(vals)), int(inside.sum()), bool(np.isnan(vals).any())


def load_targets():
    return json.loads((OUT / "targets.json").read_text(encoding="utf-8"))


def target_map():
    return {t["id"]: t for t in load_targets()}


def target_xy(target, grid, mjd):
    """Predicted pixel position of a target at a date (R1)."""
    ra, dec = propagate(target["ra"], target["dec"], target.get("pmra_mas"), target.get("pmdec_mas"),
                        target.get("epoch", EPOCH), mjd_to_year(mjd))
    return grid.to_pix(ra, dec)


def read_clean_csv(target_id):
    path = OUT / "clean" / f"{target_id}.csv"
    if not path.exists():
        return []
    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            try:
                row = {"obs_id": r.get("obs_id", ""), "mjd": float(r["mjd"]),
                       "detector": int(float(r["detector"])), "wavelength_um": float(r["wavelength_um"]),
                       "flux_ujy": float(r["flux_ujy"]),
                       "err_ujy": float(r.get("err_ujy") or r.get("flux_err_ujy") or "nan"),
                       "flagged": str(r.get("flagged", "")).lower() in ("1", "true", "yes"),
                       "saturated": str(r.get("saturated", "")).lower() in ("1", "true", "yes"),
                       "visit": int(float(r["visit"])) if r.get("visit") not in (None, "") else None}
                # step 3's names: flux_err_ujy, and aperture_bad_frac for a flagged measurement
                if "flagged" not in r and r.get("aperture_bad_frac") not in (None, ""):
                    row["flagged"] = float(r["aperture_bad_frac"]) >= 0.3
                # the science mask removes saturated cores; keep the display-mask flux, marked saturated
                if not math.isfinite(row["flux_ujy"]) and row["saturated"]:
                    row["flux_ujy"] = float(r.get("flux_display_ujy") or "nan")
                    row["err_ujy"], row["flagged"] = float("nan"), False
            except (KeyError, ValueError):
                continue
            if math.isfinite(row["flux_ujy"]) and math.isfinite(row["wavelength_um"]):
                rows.append(row)
    rows.sort(key=lambda r: r["mjd"])
    if rows and any(r["visit"] is None for r in rows):
        visit = 0
        for i, r in enumerate(rows):
            if i and r["mjd"] - rows[i - 1]["mjd"] > 20:
                visit += 1
            r["visit"] = visit
    return rows


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, obj, indent=1):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=indent, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def clean_float(x, digits=4):
    """Round for JSON; NaN and inf become None."""
    if x is None:
        return None
    x = float(x)
    return round(x, digits) if math.isfinite(x) else None


def parse_only(value, default_ids):
    if not value:
        return list(default_ids)
    return [s.strip() for s in value.split(",") if s.strip()]


def run_many(fn, ids, workers, processes=False):
    """Run fn(id) for every id, printing one line each; failures are reported, not fatal."""
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed

    results, failed = {}, []
    if workers <= 1:
        for i in ids:
            try:
                results[i] = fn(i)
            except Exception as exc:  # one bad target must not stop the batch
                failed.append(i)
                print(f"  {i}: FAILED {type(exc).__name__}: {exc}", flush=True)
        return results, failed
    pool_cls = ProcessPoolExecutor if processes else ThreadPoolExecutor
    with pool_cls(max_workers=workers) as pool:
        futures = {pool.submit(fn, i): i for i in ids}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                results[i] = fut.result()
            except Exception as exc:
                failed.append(i)
                print(f"  {i}: FAILED {type(exc).__name__}: {exc}", flush=True)
    return results, failed
