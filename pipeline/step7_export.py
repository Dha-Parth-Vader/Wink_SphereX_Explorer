"""Step 7: export for the website. Per target writes frames/<id>/vNN_<all|1..6>.png (+ _flags.png),
<id>.json in the data-contract shape, Sky Dome cubes dome/cubes/<id>/eNN.png and the fragment
out/web/results/<id>.json that merge_lists.py turns into the shared lists. Never edits a shared list (R43).

    python pipeline/step7_export.py --only barnard,wise0855 --site public/data [--workers 3] [--force]
"""
import argparse
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from stackfile import (BANDS, DETECTOR_R, DETECTOR_RANGE, EPOCH, OUT, PIPELINE_VERSION, SITE, SR_PER_PX,
                       aperture_sum, band_index, band_table, clean_float, det_value, fill_holes, load_targets,
                       mjd_to_date, mjd_to_year, parse_only, read_clean_csv, read_json, read_stack, robust_noise,
                       run_many, stack_path, target_map, target_xy, write_json)

TILE = 32
FLAG_WORDS = {"HOT": "hot pixels", "COLD": "cold pixels", "NONFUNC": "dead pixels",
              "MISSING_DATA": "pixels with missing data", "DICHROIC": "pixels on the filter edge",
              "PHANMISS": "pixels with a bad phantom correction", "PERSIST": "pixels with afterglow from a bright star",
              "NONLINEAR": "saturated pixels", "BLOOM": "pixels bled into by a saturated star",
              "GHOST": "pixels in a reflection ghost", "STREAK": "pixels on a satellite streak",
              "CROSSTALK": "pixels with electronic crosstalk"}
KIND_WORDS = {"brown-dwarf": "brown dwarf", "star": "star", "variable": "variable star"}


def stretch_for(images):
    """R18: one asinh stretch per detector over all visits, so blinking compares like with like."""
    pix = np.concatenate([img[np.isfinite(img)].ravel() for img in images if img is not None])
    if pix.size < 10:
        return {"black": 0.0, "knee": 1.0, "top": 1.0}
    black = float(np.median(pix))
    noise = robust_noise(pix)
    top = max(float(np.percentile(pix, 99.95)), black + 200 * noise)
    return {"black": round(black, 6), "knee": round(4 * noise, 6), "top": round(top, 6)}


def to_8bit(img, st):
    data = np.nan_to_num(fill_holes(img), nan=st["black"])
    knee = st["knee"] or 1.0
    span = np.arcsinh(max(st["top"] - st["black"], knee) / knee)
    scaled = np.arcsinh(np.clip(data - st["black"], 0, None) / knee) / span
    return (np.clip(scaled, 0, 1) * 255).astype(np.uint8)


def flip(a):
    """FITS row 0 is south; PNG row 0 is north. This is the one flip (R10)."""
    return np.ascontiguousarray(a[::-1])


def frame_notes(hdr, saturated):
    notes = []
    for key, value in sorted(hdr.items()):
        if key.startswith("FB_") and value:
            word = FLAG_WORDS.get(key[3:])
            if word:
                notes.append(f"{int(value)} {word}")
    if saturated:
        notes.append("The target is saturated here, so its brightness is approximate.")
    return notes


def light_curve(rows, target, stack):
    if rows:
        out = []
        for r in rows:
            w = r["wavelength_um"] / DETECTOR_R.get(r["detector"], 40) / 2
            out.append({"mjd": round(r["mjd"], 5), "flux_ujy": clean_float(r["flux_ujy"], 3),
                        "err": clean_float(r["err_ujy"], 3), "detector": r["detector"],
                        "wavelength_um": [round(r["wavelength_um"] - w, 4), round(r["wavelength_um"] + w, 4)],
                        "flagged": r["flagged"], "approximate": r["saturated"]})
        return out
    out = []
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
            det = int(b[1:])
            out.append({"mjd": round(stack.mjd(v), 5), "flux_ujy": clean_float(flux * SR_PER_PX * 1e12, 3),
                        "err": clean_float(noise * math.sqrt(n) * SR_PER_PX * 1e12, 3), "detector": det,
                        "wavelength_um": list(DETECTOR_RANGE[det]), "flagged": False,
                        "approximate": has_nan or bool(hdr.get("SATUR", False))})
    return out


def spectrum_102(rows, stack, target):
    """Normalised 102-band spectrum (max = 1, gaps interpolated) and how many bands were measured."""
    bands = band_table()
    centres = np.array([b["center_um"] for b in bands])
    vals = np.full(102, np.nan)
    per_band = {}
    for r in rows:
        i = band_index(r["wavelength_um"])
        if i is not None and not r["flagged"]:
            per_band.setdefault(i, []).append((r["flux_ujy"], r["err_ujy"]))
    for i, pts in per_band.items():
        flux = float(np.median([p[0] for p in pts]))
        err = float(np.median([p[1] for p in pts])) / math.sqrt(len(pts))
        vals[i] = flux if flux > 3 * err else 0.0     # not seen in this band (WISE 0855 below 3.8 um)
    measured = int(np.isfinite(vals).sum())
    if measured == 0:
        # no exposure photometry: fall back to one value per detector stack at its mid wavelength
        pts = {}
        for v in stack.visits:
            px, py = target_xy(target, stack.grid, stack.mjd(v))
            for b in stack.bands(v):
                if b != "ALL":
                    flux, n, _ = aperture_sum(stack.image(v, b), px, py, 2.0)
                    if math.isfinite(flux) and flux > 0:
                        pts.setdefault(int(b[1:]), []).append(flux)
        for det, fl in pts.items():
            lo, hi = DETECTOR_RANGE[det]
            vals[band_index(math.sqrt(lo * hi))] = np.median(fl)
    good = np.isfinite(vals)
    if not good.any():
        return [0.0] * 102, 0
    filled = np.interp(centres, centres[good], vals[good])
    top = filled.max()
    filled = filled / top if top > 0 else filled
    return [round(float(v), 4) for v in filled], measured


def cube_tiles(stack, v, stretches):
    """17 x 6 grid of 32 px tiles, one per band; per-band tiles from the stack when step 4 made them."""
    sheet = np.zeros((6 * TILE, 17 * TILE), np.uint8)
    cy, cx = stack.grid.ny // 2, stack.grid.nx // 2
    y0, x0 = max(0, cy - TILE // 2), max(0, cx - TILE // 2)
    cube = stack.cubes.get(v)
    for det in range(1, 7):
        st = stretches.get(f"D{det}")
        img = stack.image(v, f"D{det}")
        for ch in range(17):
            tile = None
            if cube is not None:
                tile = cube[(det - 1) * 17 + ch]
                if not np.isfinite(tile).any():
                    tile = None
            if tile is None and img is not None:
                tile = img[y0:y0 + TILE, x0:x0 + TILE]
            if tile is None or st is None:
                continue
            t8 = flip(to_8bit(tile, st))
            sheet[(det - 1) * TILE:(det - 1) * TILE + t8.shape[0], ch * TILE:ch * TILE + t8.shape[1]] = t8
    return sheet


def predictions(stack, comp, ident, target, name):
    ny = stack.grid.ny
    visit_mjd = {v: stack.mjd(v) for v in stack.visits}
    out = []
    movers = (ident or {}).get("movers") or (comp or {}).get("movers") or []
    for m in movers:
        track = []
        for v, mjd in visit_mjd.items():
            dt = mjd_to_year(mjd) - m["t0"]
            x, y = m["x0"] + m["vx_px_yr"] * dt, m["y0"] + m["vy_px_yr"] * dt
            track.append({"epoch": v, "visit": v, "mjd": round(mjd, 4), "x": round(x, 2),
                          "y": round(ny - 1 - y, 2)})
        matches = m.get("matches") or {}
        match = (matches.get("gaia") or matches.get("wise") or {}).get("id")
        conf = 0.95 if m.get("confirmed") else min(0.9, round(1 - 2 / max(m["significance"], 2.5), 2))
        if m.get("is_target"):
            label = f"{name} (target)"
        else:
            label = "Known fast-moving object" if match else "Possible mover"
        out.append({"id": m["id"], "label": label, "kind": "mover", "confidence": conf,
                    "pm_arcsec_yr": m["pm_arcsec_yr"], "match": match, "bands": m.get("bands", ["all"]),
                    "track": track})
    var = (comp or {}).get("variability", {})
    if var.get("verdict") in ("changing", "possible change"):
        track = []
        for v, mjd in visit_mjd.items():
            x, y = target_xy(target, stack.grid, mjd)
            track.append({"epoch": v, "visit": v, "mjd": round(mjd, 4), "x": round(float(x), 2),
                          "y": round(float(ny - 1 - y), 2)})
        out.append({"id": "var1", "label": f"{name} brightness {var['verdict']}", "kind": "variable",
                    "confidence": 0.9 if var["verdict"] == "changing" else 0.6,
                    "detectors": var.get("changing_detectors", []), "track": track})
    matched = {t.get("identified_as") for t in (ident or {}).get("transients", []) if t.get("identified_as")}
    for i, a in enumerate((ident or {}).get("asteroids", [])):
        mids = {}
        for p in a["track"]:
            mids.setdefault(p["visit"], []).append(p)
        track = []
        for v, pts in sorted(mids.items()):
            p = pts[len(pts) // 2]
            track.append({"epoch": v, "visit": v, "mjd": p["mjd"], "x": p["x"], "y": round(ny - 1 - p["y"], 2)})
        label = a["name"] or a["number"]
        out.append({"id": f"a{i + 1}", "label": f"Asteroid {label}" + (f" (V {a['v']})" if a.get("v") else ""),
                    "kind": "asteroid", "confidence": 0.9 if (a["name"] or a["number"]) in matched else 0.7,
                    "match": label, "track": track})
    for i, t in enumerate((ident or {}).get("transients", (comp or {}).get("transients", []))):
        if t.get("kind") == "asteroid":
            continue
        out.append({"id": f"u{i + 1}", "label": "Seen in one visit only", "kind": "unidentified",
                    "confidence": 0.3, "track": [{"epoch": t["visit"], "visit": t["visit"],
                                                  "mjd": round(visit_mjd[t["visit"]], 4), "x": t["x"],
                                                  "y": round(ny - 1 - t["y"], 2)}]})
    return out


def overlays(ident, layers):
    out, notes = {}, []
    cats = (ident or {}).get("catalogues", {})
    for name in layers:
        info = cats.get(name)
        if not info or not info.get("loaded"):
            notes.append(f"{'Gaia DR3' if name == 'gaia' else 'CatWISE2020'} lookup didn't finish; rerun step 6.")
            continue
        out[name] = [{"ra": round(s["ra"], 7), "dec": round(s["dec"], 7), "label": s["id"], "epoch": s["epoch"],
                      "pmra": clean_float(s["pmra"], 2) or 0.0, "pmdec": clean_float(s["pmdec"], 2) or 0.0,
                      "mag": clean_float(s["mag"], 2)} for s in info["sources"]]
    return out, notes


def verdicts(comp, ident, target):
    tgt = (ident or {}).get("target") or (comp or {}).get("target") or {}
    pm = (comp or {}).get("target", {}).get("measured_pm_arcsec_yr")
    if tgt.get("mover"):
        motion = "moves"
    elif any(r.get("found") for r in tgt.get("per_visit", [])):
        motion = "steady"
    else:
        motion = "not found"
    var = (comp or {}).get("variability", {}).get("verdict", "not checked")
    notes = list((comp or {}).get("notes", [])) + list((ident or {}).get("notes", []))
    if pm:
        expected = (target.get("pm_mas") or 0) / 1000
        conf = "confirmed by catalogue" if tgt.get("confirmed") else "not yet confirmed by a catalogue"
        notes.append(f"Measured motion {pm}″/yr (catalogue {expected:.2f}″/yr), {conf}.")
    if tgt.get("saturated"):
        notes.append("The target is saturated in some images, so its brightness and position are approximate.")
    if tgt.get("mean_offset_px") is not None and not tgt.get("within_third_px"):
        notes.append(f"The target sits {tgt['mean_offset_px']} px from where we expected it.")
    return {"motion": motion, "variability": var, "notes": notes}


def status_text(v, pm):
    if v["motion"] == "moves" and pm:
        return f"moves {pm:.1f}″/yr"
    if v["variability"] in ("changing", "possible change"):
        return v["variability"]
    return "steady" if v["motion"] == "steady" else v["motion"]


def export_patch(stack, patch_id, site, name, kind, target=None, layers=("gaia", "wise"), comp=None,
                 ident=None, clean_rows=None, subtype="", simulated=False):
    """Write frames, <id>.json and dome cubes for one stack; returns (patch json, fragment)."""
    site = Path(site)
    target = target or {"id": patch_id, "ra": stack.grid.ra0, "dec": stack.grid.dec0}
    clean_rows = clean_rows or []
    frame_dir = site / "frames" / patch_id
    frame_dir.mkdir(parents=True, exist_ok=True)
    written = set()

    stretches = {b: stretch_for([stack.image(v, b) for v in stack.visits]) for b in BANDS
                 if any(stack.image(v, b) is not None for v in stack.visits)}
    tgt_info = (comp or {}).get("target", {})
    sat_visits = {r["visit"] for r in tgt_info.get("per_visit", []) if r.get("saturated")}
    frames = []
    for v in stack.visits:
        for b in stack.bands(v):
            data, hdr = stack.images[(v, b)]
            det = det_value(b)
            fname = f"v{v:02d}_{det}"
            Image.fromarray(flip(to_8bit(data, stretches[b]))).save(frame_dir / f"{fname}.png", optimize=True)
            flags = stack.flags(v, b).astype(np.uint8) * 255
            Image.fromarray(flip(flags)).save(frame_dir / f"{fname}_flags.png", optimize=True)
            written |= {f"{fname}.png", f"{fname}_flags.png"}
            saturated = bool(hdr.get("SATUR", False)) or v in sat_visits
            lo = hdr.get("WAVEMIN", 0.75 if det == "all" else DETECTOR_RANGE[det][0])
            hi = hdr.get("WAVEMAX", 5.0 if det == "all" else DETECTOR_RANGE[det][1])
            frames.append({
                "file": f"frames/{patch_id}/{fname}.png", "flags_file": f"frames/{patch_id}/{fname}_flags.png",
                "mjd": round(stack.mjd(v), 5), "date": mjd_to_date(stack.mjd(v)), "visit": v, "band": str(det),
                "detector": det, "wavelength_um": [round(lo, 4), round(hi, 4)],
                "n_exposures": int(hdr.get("NFRAMES", 0)), "coverage": clean_float(hdr.get("COVERAGE", 1.0), 3),
                "saturated": saturated, "stretch": stretches[b], "flags": frame_notes(hdr, saturated),
                "flag_bits": {k[3:]: int(val) for k, val in sorted(hdr.items()) if k.startswith("FB_") and val},
            })
    for old in frame_dir.glob("*.png"):
        if old.name not in written:
            old.unlink()

    ov, ov_notes = overlays(ident, layers) if ident is not None else ({}, [])
    v_out = verdicts(comp, ident, target)
    v_out["notes"] += ov_notes
    pm = tgt_info.get("measured_pm_arcsec_yr")
    fov = round(max(stack.grid.nx, stack.grid.ny) * stack.grid.scale / 3600, 4)
    patch = {"id": patch_id, "name": name, "kind": kind, "width_px": stack.grid.nx, "height_px": stack.grid.ny,
             "ra": round(stack.grid.ra0, 7), "dec": round(stack.grid.dec0, 7), "epoch": EPOCH, "fov_deg": fov,
             "pixel_scale_arcsec": stack.grid.scale, "pipeline_version": PIPELINE_VERSION}
    if simulated:
        patch["simulated"] = True
    doc = {"patch": patch, "frames": frames, "light_curve": light_curve(clean_rows, target, stack),
           "overlays": ov, "predictions": predictions(stack, comp, ident, target, name),
           "verdicts": v_out}
    if clean_rows:
        doc["spectrum"] = [{"wavelength_um": round(r["wavelength_um"], 4), "flux_ujy": clean_float(r["flux_ujy"], 3),
                            "err": clean_float(r["err_ujy"], 3), "visit": r["visit"], "saturated": r["saturated"]}
                           for r in sorted(clean_rows, key=lambda r: r["wavelength_um"]) if not r["flagged"]]
    write_json(site / f"{patch_id}.json", doc)

    cube_dir = site / "dome" / "cubes" / patch_id
    if cube_dir.exists():
        shutil.rmtree(cube_dir)
    cube_dir.mkdir(parents=True)
    epochs = []
    bright = {}
    for v in stack.visits:
        px, py = target_xy(target, stack.grid, stack.mjd(v))
        img = stack.image(v, "ALL")
        if img is not None:
            flux, _, _ = aperture_sum(img, px, py, 2.0)
            bright[v] = flux if math.isfinite(flux) else None
    top = max([b for b in bright.values() if b] or [1.0])
    for v in stack.visits:
        Image.fromarray(cube_tiles(stack, v, stretches)).save(cube_dir / f"e{v:02d}.png", optimize=True)
        epochs.append({"mjd": round(stack.mjd(v), 4), "cube": f"dome/cubes/{patch_id}/e{v:02d}.png",
                       "brightness": round(bright[v] / top, 3) if bright.get(v) else None})
    spectrum, measured = spectrum_102(clean_rows, stack, target)

    word = KIND_WORDS.get(kind, kind)
    blurb = f"{subtype[0].upper() + subtype[1:]}." if subtype else f"A {word}."
    status = status_text(v_out, pm)
    fragment = {
        "patch_entry": {"id": patch_id, "title": name, "ra": patch["ra"], "dec": patch["dec"], "fov_deg": fov,
                        "simulated": simulated},
        "gallery_entry": {"id": patch_id, "name": name, "type": kind, "ra": patch["ra"], "dec": patch["dec"],
                          "fov": fov, "thumb": frames[0]["file"] if frames else None, "status": status,
                          "blurb": blurb},
        "poi_entry": {"id": patch_id, "name": name, "category": kind, "type": subtype or word,
                      "ra": patch["ra"], "dec": patch["dec"], "size": fov, "blurb": blurb, "patch": patch_id,
                      "spectrum": spectrum, "bands_measured": measured, "epochs": epochs},
    }
    if simulated:
        fragment["gallery_entry"]["simulated"] = fragment["poi_entry"]["simulated"] = True
    return doc, fragment


def export_target(target_id, targets, site, force=False):
    src = stack_path(target_id)
    if not src.exists():
        print(f"  {target_id}: no stack.fits yet (run step 4)", flush=True)
        return None
    frag_path = OUT / "web" / "results" / f"{target_id}.json"
    inputs = [p for p in (src, OUT / "compare" / f"{target_id}.json", OUT / "identify" / f"{target_id}.json")
              if p.exists()]
    old = read_json(site / f"{target_id}.json")
    if (not force and old and frag_path.exists() and old["patch"].get("pipeline_version") == PIPELINE_VERSION
            and all(frag_path.stat().st_mtime >= p.stat().st_mtime for p in inputs)):
        print(f"  {target_id}: done already", flush=True)
        return old
    target = targets.get(target_id, {"id": target_id})
    stack = read_stack(src)
    target = {**target, "ra": target.get("ra", stack.grid.ra0), "dec": target.get("dec", stack.grid.dec0)}
    comp = read_json(OUT / "compare" / f"{target_id}.json")
    ident = read_json(OUT / "identify" / f"{target_id}.json")
    doc, fragment = export_patch(stack, target_id, site, target.get("name", target_id), target.get("kind", "star"),
                                 target=target, comp=comp, ident=ident, clean_rows=read_clean_csv(target_id),
                                 subtype=target.get("subtype", ""))
    write_json(frag_path, fragment)
    print(f"  {target_id}: {len(doc['frames'])} frames, {len(doc['predictions'])} prediction(s), "
          f"{fragment['poi_entry']['bands_measured']}/102 bands measured, "
          f"status '{fragment['gallery_entry']['status']}'", flush=True)
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only")
    ap.add_argument("--site", default=str(SITE))
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    targets = target_map()
    ids = parse_only(args.only, [t["id"] for t in load_targets() if stack_path(t["id"]).exists()])
    print(f"step 7: exporting {len(ids)} target(s) to {args.site}", flush=True)
    _, failed = run_many(lambda i: export_target(i, targets, Path(args.site), args.force), ids, args.workers)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
