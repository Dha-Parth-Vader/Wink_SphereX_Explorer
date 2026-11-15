"""Step 5: compare visits. Finds movers (R14), checks the target for brightness changes (R15) and lists
sources seen in only one visit. Reads cache/<id>/stack.fits and out/clean/<id>.csv, writes
out/compare/<id>.json and difference-image previews in out/review/.

    python pipeline/step5_compare.py --only barnard,wise0855 [--workers 3] [--force]
"""
import argparse
import math
import sys
import warnings

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

from stackfile import (OUT, PIPELINE_VERSION, SCALE, SR_PER_PX, aperture_sum, clean_float, fill_holes, load_targets,
                       mjd_to_year, parse_only, read_clean_csv, read_json, read_stack, robust_noise, run_many,
                       stack_path, target_map, target_xy, write_json)

DETECT_SIGMA = 5.0
LINK_PX = 2.5
MIN_PM = 1.5            # arcsec/yr
MIN_PM_SIGNIFICANCE = 5.0
TRANSIENT_SIGMA = 7.0
VAR_WAVE_TOL = 0.01
VAR_CHANGE = 0.20
VAR_SIGMA = 5.0


def detect(img, err, flagged=None, sigma=DETECT_SIGMA, edge=2):
    """Point sources above sigma: positions in FITS pixels, peak S/N, flux and a centroid error.
    A saturated star (a NaN hole inside the field) counts once, at the centre of its hole."""
    filled = fill_holes(img)
    holes = ~np.isfinite(img) & np.isfinite(filled)
    work = np.where(np.isfinite(filled), filled, 0.0)
    good = (err > 0) & np.isfinite(err)
    err = np.where(good, err, np.median(err[good]) if good.any() else 1.0)
    snr = work / err
    valid = ndimage.binary_erosion(np.isfinite(filled), iterations=edge, border_value=0)
    sources = []
    labels, n_holes = ndimage.label(holes)
    for i, (sy, sx) in enumerate(ndimage.find_objects(labels), start=1):
        ys, xs = np.nonzero(labels[sy, sx] == i)
        cx, cy = float(xs.mean() + sx.start), float(ys.mean() + sy.start)
        if not valid[int(round(cy)), int(round(cx))]:
            continue
        flux, _, _ = aperture_sum(work, cx, cy, 2.0)
        sources.append({"x": cx, "y": cy, "snr": float(snr[sy, sx].max()), "flux": flux,
                        "err_px": 0.2 if len(xs) > 2 else 0.3, "saturated": True})
    near_hole = ndimage.binary_dilation(holes, iterations=2) if n_holes else np.zeros(img.shape, bool)
    peaks = (snr == ndimage.maximum_filter(snr, size=3)) & (snr > sigma) & valid & ~near_hole
    for y, x in zip(*np.nonzero(peaks)):
        if flagged is not None and flagged[y, x]:
            continue
        cx, cy = _centroid(work, x, y)
        flux, _, _ = aperture_sum(work, cx, cy, 2.0)
        s = float(snr[y, x])
        sources.append({"x": cx, "y": cy, "snr": s, "flux": flux, "err_px": max(0.04, 1.0 / s),
                        "saturated": False})
    return sources


def _centroid(img, x, y):
    """Sub-pixel peak: Gaussian 3-point fit per axis, falling back to a 3x3 weighted mean."""
    ny, nx = img.shape
    if 0 < x < nx - 1 and 0 < y < ny - 1:
        trio_x, trio_y = img[y, x - 1:x + 2], img[y - 1:y + 2, x]
        if (trio_x > 0).all() and (trio_y > 0).all():
            out = []
            for trio, c in ((trio_x, x), (trio_y, y)):
                lm, l0, lp = np.log(trio)
                den = lm - 2 * l0 + lp
                off = 0.5 * (lm - lp) / den if den < 0 else 0.0
                out.append(c + float(np.clip(off, -0.5, 0.5)))
            return out[0], out[1]
    y0, y1, x0, x1 = max(0, y - 1), min(ny, y + 2), max(0, x - 1), min(nx, x + 2)
    w = np.clip(img[y0:y1, x0:x1], 0, None)
    if w.sum() <= 0:
        return float(x), float(y)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    return float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())


def cold_stack(stack, visit):
    """Mean of detectors 5 and 6, where a Y dwarf like WISE 0855 is brightest."""
    imgs = [(stack.image(visit, b), stack.error(visit, b)) for b in ("D5", "D6") if stack.image(visit, b) is not None]
    if not imgs:
        return None, None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        data = np.nanmean(np.stack([i for i, _ in imgs]), axis=0) if len(imgs) > 1 else imgs[0][0]
    err = np.sqrt(sum(e ** 2 for _, e in imgs)) / len(imgs)
    return data, err


def visit_images(stack, kind):
    out = {}
    for v in stack.visits:
        if kind == "all":
            img = stack.image(v, "ALL")
            if img is not None:
                out[v] = (img, stack.error(v, "ALL"), stack.flags(v, "ALL"))
        else:
            img, err = cold_stack(stack, v)
            if img is not None:
                flags = np.zeros(img.shape, bool)
                for b in ("D5", "D6"):
                    if stack.image(v, b) is not None:
                        flags |= stack.flags(v, b)
                out[v] = (img, err, flags)
    return out


def pick_reference(stack, visits):
    """Lowest-noise visit with good coverage, so a noisy or striped first visit isn't the reference."""
    scored = []
    for v in visits:
        hdr = stack.meta(v)
        img = stack.image(v, "ALL")
        noise = hdr.get("NOISE") or (robust_noise(img) if img is not None else 1e9)
        cover = hdr.get("COVERAGE", 1.0)
        scored.append((cover < 0.8, noise, v))
    return min(scored)[2] if scored else None


def fit_track(points):
    """Weighted straight-line fit x(t), y(t); t in years. Returns position at t_ref, velocity and errors."""
    t = np.array([p["t"] for p in points])
    w = np.array([1 / p["err_px"] ** 2 for p in points])
    tbar = float((w * t).sum() / w.sum())
    out = {"t0": tbar}
    for axis in ("x", "y"):
        v = np.array([p[axis] for p in points])
        a = float((w * v).sum() / w.sum())
        sxx = float((w * (t - tbar) ** 2).sum())
        b = float((w * (t - tbar) * (v - a)).sum() / sxx) if sxx > 0 else 0.0
        out[axis] = a
        out["v" + axis] = b
        out["e" + axis] = 1 / math.sqrt(sxx) if sxx > 0 else float("inf")
    return out


def link_movers(per_visit, times, ref, band):
    """Follow every reference source through the other visits (R14) and keep fast, significant ones."""
    if ref not in per_visit or len(per_visit) < 2:
        return [], {}
    ref_src = per_visit[ref]
    trees = {v: (cKDTree([(s["x"], s["y"]) for s in src]) if src else None) for v, src in per_visit.items()}

    offsets = {ref: (0.0, 0.0)}
    for v, src in per_visit.items():
        if v == ref or trees[v] is None or not ref_src:
            continue
        d, j = trees[v].query([(s["x"], s["y"]) for s in ref_src], distance_upper_bound=LINK_PX)
        pairs = [(src[jj]["x"] - s["x"], src[jj]["y"] - s["y"]) for s, dd, jj in zip(ref_src, d, j)
                 if np.isfinite(dd) and s["snr"] > 10 and src[jj]["snr"] > 10]
        offsets[v] = tuple(np.median(pairs, axis=0)) if len(pairs) >= 3 else (0.0, 0.0)

    order = sorted((v for v in per_visit if v != ref), key=lambda v: abs(times[v] - times[ref]))
    movers = []
    for i, s in enumerate(ref_src):
        points = [{"visit": ref, "t": times[ref], "x": s["x"], "y": s["y"], "snr": s["snr"], "flux": s["flux"],
                   "err_px": s["err_px"], "saturated": s["saturated"]}]
        for v in order:
            if trees[v] is None:
                continue
            if len(points) >= 2:
                f = fit_track(points)
                px, py = f["x"] + f["vx"] * (times[v] - f["t0"]), f["y"] + f["vy"] * (times[v] - f["t0"])
            else:
                px, py = s["x"], s["y"]
            dx, dy = offsets.get(v, (0.0, 0.0))
            d, j = trees[v].query((px + dx, py + dy), distance_upper_bound=LINK_PX)
            if not np.isfinite(d):
                continue
            m = per_visit[v][j]
            points.append({"visit": v, "t": times[v], "x": m["x"] - dx, "y": m["y"] - dy, "snr": m["snr"],
                           "flux": m["flux"], "err_px": m["err_px"], "saturated": m["saturated"]})
        if len(points) < 2 or max(p["t"] for p in points) - min(p["t"] for p in points) < 0.25:
            continue
        f = fit_track(points)
        speed = math.hypot(f["vx"], f["vy"])
        pm = speed * SCALE
        pm_err = math.hypot(f["vx"] * f["ex"], f["vy"] * f["ey"]) / speed * SCALE if speed > 0 else float("inf")
        sig = pm / pm_err if pm_err > 0 else 0.0
        if pm < MIN_PM or sig < MIN_PM_SIGNIFICANCE:
            continue
        points.sort(key=lambda p: p["t"])
        movers.append({
            "band": band, "t0": round(f["t0"], 4), "x0": round(f["x"], 3), "y0": round(f["y"], 3),
            "vx_px_yr": round(f["vx"], 4), "vy_px_yr": round(f["vy"], 4),
            "pm_arcsec_yr": round(pm, 3), "pm_err": round(pm_err, 3), "significance": round(sig, 1),
            "pa_deg": round(math.degrees(math.atan2(-f["vx"], f["vy"])) % 360, 1),
            "snr": round(max(p["snr"] for p in points), 1), "n_visits": len(points),
            "saturated": any(p["saturated"] for p in points),
            "positions": [{"visit": p["visit"], "x": round(p["x"], 3), "y": round(p["y"], 3),
                           "snr": round(p["snr"], 1)} for p in points],
        })
    return movers, {v: [round(o, 3) for o in off] for v, off in offsets.items()}


def merge_movers(lists):
    """Same object found in 'all' and 'cold': keep the more significant fit, remember both bands."""
    out = []
    for m in sorted((m for lst in lists for m in lst), key=lambda m: -m["significance"]):
        twin = next((o for o in out if math.hypot(o["x0"] - m["x0"], o["y0"] - m["y0"]) < 2.0), None)
        if twin:
            twin["bands"] = sorted(set(twin["bands"]) | {m["band"]})
        else:
            out.append({**m, "bands": [m["band"]]})
    for i, m in enumerate(out):
        m["id"] = f"m{i + 1}"
        m.pop("band")
    return out


def find_transients(per_visit, images):
    """Bright sources in one visit with nothing at that spot in any other visit (asteroids, cosmic rays)."""
    found = []
    for v, src in per_visit.items():
        others = [(w, s) for w, s in per_visit.items() if w != v]
        for s in src:
            if s["snr"] < TRANSIENT_SIGMA or s["saturated"]:
                continue
            seen = any(math.hypot(o["x"] - s["x"], o["y"] - s["y"]) < LINK_PX for _, os_ in others for o in os_)
            if seen:
                continue
            absent = True
            for w, _ in others:
                img, err, _ = images[w]
                x, y = int(round(s["x"])), int(round(s["y"]))
                box = (img[max(0, y - 1):y + 2, max(0, x - 1):x + 2] / err[max(0, y - 1):y + 2, max(0, x - 1):x + 2])
                if np.isfinite(box).any() and np.nanmax(box) > 3:
                    absent = False
            if absent:
                found.append({"visit": v, "x": round(s["x"], 2), "y": round(s["y"], 2), "snr": round(s["snr"], 1)})
    return found


def target_check(target, stack, per_visit, movers):
    """How far the measured target is from its predicted position, per visit."""
    rows = []
    for v in stack.visits:
        px, py = target_xy(target, stack.grid, stack.mjd(v))
        best = min(per_visit.get(v, []), key=lambda s: math.hypot(s["x"] - px, s["y"] - py), default=None)
        if best is None or math.hypot(best["x"] - px, best["y"] - py) > 2.0:
            rows.append({"visit": v, "predicted": [round(float(px), 2), round(float(py), 2)], "found": False})
            continue
        off = math.hypot(best["x"] - px, best["y"] - py)
        rows.append({"visit": v, "predicted": [round(float(px), 2), round(float(py), 2)], "found": True,
                     "measured": [round(best["x"], 2), round(best["y"], 2)], "offset_px": round(off, 3),
                     "saturated": best["saturated"]})
    found = [r for r in rows if r["found"]]
    mean_off = float(np.mean([r["offset_px"] for r in found])) if found else None
    mover = None
    for m in movers:
        dists = []
        for p in m["positions"]:
            px, py = target_xy(target, stack.grid, stack.mjd(p["visit"]))
            dists.append(math.hypot(p["x"] - px, p["y"] - py))
        if np.mean(dists) < 1.5:
            mover = m["id"]
            m["is_target"] = True
            break
    return {"per_visit": rows, "mean_offset_px": clean_float(mean_off, 3),
            "within_third_px": mean_off is not None and mean_off < 1 / 3, "mover": mover,
            "saturated": any(r.get("saturated") for r in found)}


def _pairs(rows):
    """Late/early flux ratio and significance per detector, for frames within 1% in wavelength (R15)."""
    by_det = {}
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            if a["visit"] == b["visit"] or a["detector"] != b["detector"]:
                continue
            if abs(a["wavelength_um"] - b["wavelength_um"]) / a["wavelength_um"] > VAR_WAVE_TOL:
                continue
            early, late = (a, b) if a["mjd"] < b["mjd"] else (b, a)
            if min(early["flux_ujy"] / early["err_ujy"], late["flux_ujy"] / late["err_ujy"]) < VAR_SIGMA:
                continue    # not detected at this wavelength, the ratio means nothing
            err = math.hypot(early["err_ujy"], late["err_ujy"])
            sig = abs(late["flux_ujy"] - early["flux_ujy"]) / err if err > 0 else 0.0
            by_det.setdefault(a["detector"], []).append((late["flux_ujy"] / early["flux_ujy"], sig))
    return by_det


def variability(target_id, target, stack, saturated):
    """R15: compare frames within 1% in wavelength across visits; a change needs 2 detectors."""
    rows = [r for r in read_clean_csv(target_id) if not r["flagged"]]
    source = "exposures"
    if not rows:
        rows, source = _stack_photometry(target, stack), "detector stacks"
    visits = sorted({r["visit"] for r in rows})
    result = {"source": source, "n_points": len(rows), "visits": len(visits), "per_detector": {}}
    if len(visits) < 2:
        result["verdict"] = "only one visit"
        return result
    # compare unsaturated frames only when there are enough of them: RW Aur is saturated in D4 alone, and one
    # saturated frame anywhere used to cap its clear 4-detector change at "possible change"
    clean = [r for r in rows if not r["saturated"]]
    by_det = _pairs(clean)
    if by_det:
        saturated = False
    else:
        by_det = _pairs(rows)
        saturated = saturated or any(r["saturated"] for r in rows)
    if not by_det:
        result["verdict"] = "no same-wavelength comparison"
        return result
    changing = []
    for det, pairs in sorted(by_det.items()):
        ratio = float(np.median([p[0] for p in pairs]))
        sig = float(np.median([p[1] for p in pairs]))
        change = abs(ratio - 1) > VAR_CHANGE and sig > VAR_SIGMA
        result["per_detector"][str(det)] = {"pairs": len(pairs), "median_ratio": round(ratio, 3),
                                            "median_sigma": round(sig, 1), "change": change}
        if change:
            changing.append(det)
    if len(changing) >= 2:
        verdict = "changing"
    elif changing:
        verdict = "possible change"
    else:
        verdict = "steady"
    if saturated and verdict == "changing":
        verdict = "possible change"
    result["verdict"] = verdict
    result["saturated"] = saturated
    result["changing_detectors"] = changing
    return result


def _stack_photometry(target, stack):
    rows = []
    for v in stack.visits:
        px, py = target_xy(target, stack.grid, stack.mjd(v))
        for b in stack.bands(v):
            if b == "ALL":
                continue
            data, hdr = stack.images[(v, b)]
            flux, n, has_nan = aperture_sum(data, px, py, 2.0)
            if not math.isfinite(flux) or n == 0:
                continue
            noise = hdr.get("NOISE") or robust_noise(data)
            rows.append({"visit": v, "mjd": stack.mjd(v), "detector": int(b[1:]),
                         "wavelength_um": (hdr.get("WAVEMIN", 1) + hdr.get("WAVEMAX", 1)) / 2,
                         "flux_ujy": flux * SR_PER_PX * 1e12,
                         "err_ujy": noise * math.sqrt(n) * SR_PER_PX * 1e12,
                         "flagged": False, "saturated": has_nan or bool(hdr.get("SATUR", False))})
    return rows


def difference_preview(stack, kind_images, movers, title):
    """Earliest, latest and latest-minus-earliest (blue = was here, red = is here) for 'all' and 'cold'."""
    panels = []
    for kind, imgs in kind_images.items():
        if len(imgs) < 2:
            continue
        first, last = min(imgs), max(imgs)
        a, b = fill_holes(imgs[first][0]), fill_holes(imgs[last][0])
        noise = robust_noise(a)
        panels.append((f"{kind} first", _grey(a, noise)))
        panels.append((f"{kind} last", _grey(b, noise)))
        panels.append((f"{kind} last-first", _diverging(b - a, noise)))
    if not panels:
        return None
    zoom = 2
    h, w = panels[0][1].size[1] * zoom, panels[0][1].size[0] * zoom
    sheet = Image.new("RGB", (w * len(panels), h + 18), (20, 20, 28))
    draw = ImageDraw.Draw(sheet)
    draw.text((4, 3), title, fill=(230, 230, 230))
    ny = stack.grid.ny
    for i, (label, im) in enumerate(panels):
        im = im.resize((w, h), Image.NEAREST)
        sheet.paste(im, (i * w, 18))
        d = ImageDraw.Draw(sheet)
        d.text((i * w + 3, h + 4), label, fill=(200, 200, 200))
        for m in movers:
            for p in m["positions"]:
                x, y = p["x"] * zoom + i * w, (ny - 1 - p["y"]) * zoom + 18
                d.ellipse((x - 7, y - 7, x + 7, y + 7), outline=(80, 220, 120))
    return sheet


def _grey(img, noise):
    v = np.arcsinh(np.clip(np.nan_to_num(img), 0, None) / (4 * noise)) / np.arcsinh(50)
    return Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8)[::-1]).convert("RGB")


def _diverging(diff, noise):
    v = np.clip(np.nan_to_num(diff) / (10 * noise), -1, 1)[::-1]
    rgb = np.zeros(v.shape + (3,))
    rgb[..., 0] = np.where(v > 0, v, 0)
    rgb[..., 2] = np.where(v < 0, -v, 0)
    rgb += 0.12 * (1 - np.abs(v))[..., None]
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))


def compare_target(target_id, targets, force=False):
    out_path = OUT / "compare" / f"{target_id}.json"
    src = stack_path(target_id)
    if not src.exists():
        print(f"  {target_id}: no stack.fits yet (run step 4)", flush=True)
        return None
    old = read_json(out_path)
    if (not force and old and old.get("pipeline_version") == PIPELINE_VERSION
            and out_path.stat().st_mtime >= src.stat().st_mtime):
        print(f"  {target_id}: done already", flush=True)
        return old

    stack = read_stack(src)
    target = targets.get(target_id) or {"id": target_id, "ra": stack.grid.ra0, "dec": stack.grid.dec0}
    times = {v: mjd_to_year(stack.mjd(v)) for v in stack.visits}
    notes = []
    if len(stack.visits) < 2:
        notes.append("Only one usable visit, so nothing to compare yet.")

    kind_images = {"all": visit_images(stack, "all"), "cold": visit_images(stack, "cold")}
    ref = pick_reference(stack, list(kind_images["all"]) or stack.visits)
    if ref is not None and ref != min(stack.visits):
        notes.append(f"Visit {ref} is the reference because the first visit is noisier or less complete.")
    detections, mover_lists, offsets = {}, [], {}
    for kind, imgs in kind_images.items():
        detections[kind] = {v: detect(img, err, flags) for v, (img, err, flags) in imgs.items()}
        movers, offs = link_movers(detections[kind], times, ref, kind)
        mover_lists.append(movers)
        offsets[kind] = offs
    movers = merge_movers(mover_lists)
    tgt = target_check(target, stack, detections["all"], movers)
    # a Y dwarf like WISE 0855 only shows in D5+D6: if its track came from the cold stack, measure it there too,
    # or the all-detector check lands on whatever static source sits nearby
    cold_only = any(m["id"] == tgt["mover"] and "all" not in m.get("bands", ["all"]) for m in movers)
    if (not tgt["mover"] or cold_only) and kind_images["cold"]:
        cold = target_check(target, stack, detections["cold"], movers)
        if cold_only or cold["mover"] or (cold["mean_offset_px"] is not None and tgt["mean_offset_px"] is None):
            tgt = {**cold, "band": "cold"}
    var = variability(target_id, target, stack, tgt["saturated"])
    transients = find_transients(detections["all"], kind_images["all"]) if len(stack.visits) > 1 else []

    for m in movers:
        m.setdefault("is_target", False)
    target_pm = math.hypot(target.get("pmra_mas") or 0, target.get("pmdec_mas") or 0) / 1000
    result = {
        "id": target_id, "pipeline_version": PIPELINE_VERSION, "reference_visit": ref,
        "visits": [{"visit": v, "mjd": round(stack.mjd(v), 4), "year": round(times[v], 4),
                    "n_sources_all": len(detections["all"].get(v, [])),
                    "n_sources_cold": len(detections["cold"].get(v, [])),
                    "noise": clean_float(stack.meta(v).get("NOISE"), 6),
                    "coverage": clean_float(stack.meta(v).get("COVERAGE", 1.0), 3),
                    "offset_px": offsets["all"].get(v)} for v in stack.visits],
        "movers": movers,
        "target": {**tgt, "expected_pm_arcsec_yr": round(target_pm, 3),
                   "measured_pm_arcsec_yr": next((m["pm_arcsec_yr"] for m in movers if m["id"] == tgt["mover"]),
                                                 None)},
        "variability": var,
        "transients": transients,
        "notes": notes,
    }
    write_json(out_path, result)
    sheet = difference_preview(stack, kind_images, movers, f"{target_id}: {target.get('name', '')}")
    if sheet:
        (OUT / "review").mkdir(parents=True, exist_ok=True)
        sheet.save(OUT / "review" / f"{target_id}_difference.png")
    pm = result["target"]["measured_pm_arcsec_yr"]
    print(f"  {target_id}: {len(movers)} mover(s){f', target {pm}″/yr' if pm else ''}, "
          f"variability {var['verdict']}, {len(transients)} one-visit source(s)", flush=True)
    return result


def review_sheet(ids):
    rows = [Image.open(OUT / "review" / f"{i}_difference.png") for i in ids
            if (OUT / "review" / f"{i}_difference.png").exists()]
    if not rows:
        return
    sheet = Image.new("RGB", (max(r.width for r in rows), sum(r.height for r in rows)), (20, 20, 28))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height
    sheet.save(OUT / "review" / "step5_difference_images.png")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="comma-separated target ids (default: every target with a stack)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--force", action="store_true", help="redo targets that are already done")
    args = ap.parse_args(argv)
    targets = target_map()
    ids = parse_only(args.only, [t["id"] for t in load_targets() if stack_path(t["id"]).exists()])
    print(f"step 5: comparing {len(ids)} target(s)", flush=True)
    _, failed = run_many(lambda i: compare_target(i, targets, args.force), ids, args.workers)
    review_sheet(ids)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
