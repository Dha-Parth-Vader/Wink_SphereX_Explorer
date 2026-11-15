"""Step 6: identify what step 5 found. Movers are confirmed against Gaia DR3 and CatWISE2020 (R16),
one-visit sources against SkyBoT asteroid predictions (R17). 2MASS (observed 1997-2001) gives each mover a
third, much older position to check against. Also saves the Gaia, WISE and 2MASS overlays for the viewer. Reads out/compare/<id>.json and cache/<id>/stack.fits, writes out/identify/<id>.json.
SkyBoT answers are cached in cache/<id>/skybot.json.

    python pipeline/step6_identify.py --only barnard,wise0855 [--workers 4] [--force] [--offline]
"""
import argparse
import csv
import io
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from astropy.io import ascii

from stackfile import (CACHE, EPOCH, OUT, PIPELINE_VERSION, load_targets, parse_only, read_json, read_stack,
                       run_many, separation_arcsec, stack_path, target_map, write_json)

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
SCS_URL = "https://irsa.ipac.caltech.edu/SCS"
GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"
ESA_GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SCS_MAX_DEG = 0.05       # IRSA Cone Search times out on bigger circles when it's busy; larger cones are tiled
SKYBOT_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
GAIA_EPOCH = 2016.0
CATWISE_EPOCH = 2015.4
TMASS_EPOCH = 1999.0     # nominal; each 2MASS source carries its own date (jdate)
TMASS_MATCH = 2.0        # arcsec between 2MASS and Gaia moved back to the 2MASS date
CONE_BASE = 6.0          # arcsec, before widening by proper motion
MATCH_ARCSEC = 12.0      # 2 px at 2026.0
ASTEROID_VMAX = 20.5
ASTEROID_MATCH = 12.0
FIELD_ROWS = 1500
CAT_EPOCH = {"gaia": GAIA_EPOCH, "wise": CATWISE_EPOCH, "tmass": TMASS_EPOCH}


class ArchiveError(Exception):
    pass


def tap(query, retries=4, timeout=120, base=TAP_URL):
    """TAP sync query (IRSA unless base says otherwise) returning a list of dicts (retries on 5xx and
    'Server busy')."""
    url = base + "?" + urllib.parse.urlencode({"LANG": "ADQL", "REQUEST": "doQuery", "FORMAT": "csv",
                                               "QUERY": query})
    delay = 2.0
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
            if "Server busy" in text[:500]:
                raise ArchiveError("Server busy")
            return list(csv.DictReader(io.StringIO(text)))
        except (urllib.error.URLError, TimeoutError, ArchiveError, ConnectionError) as exc:
            code = getattr(exc, "code", 500)
            if attempt == retries - 1 or (isinstance(code, int) and 400 <= code < 500):
                raise ArchiveError(f"IRSA TAP failed: {exc}") from exc
            time.sleep(delay)
            delay *= 2
    return []


_tap_down = False


def scs(table, ra, dec, radius_deg, retries=6):
    """Same circle from IRSA's Cone Search, tiled with SCS_MAX_DEG circles. Rows keep the table's column
    names, so callers read them exactly as TAP rows. Duplicates from overlapping tiles are dropped."""
    centres = [(ra, dec)]
    if radius_deg > SCS_MAX_DEG:
        step, centres = SCS_MAX_DEG * math.sqrt(3), []
        n = int(radius_deg / step) + 2
        for j in range(-n, n + 1):
            for i in range(-n, n + 1):
                x, y = (i + 0.5 * (j % 2)) * step, j * 1.5 * SCS_MAX_DEG
                if math.hypot(x, y) <= radius_deg + SCS_MAX_DEG:
                    centres.append(((ra + x / math.cos(math.radians(dec))) % 360, dec + y))

    def fetch(centre):
        cra, cdec = centre
        url = SCS_URL + "?" + urllib.parse.urlencode({"table": table, "RA": f"{cra:.6f}", "DEC": f"{cdec:.6f}",
                                                       "SR": f"{min(radius_deg, SCS_MAX_DEG):.6f}", "format": "csv"})
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(url, timeout=60) as resp:
                    text = resp.read().decode("utf-8", "replace")
                if text.lstrip().startswith("<"):
                    raise ArchiveError("Cone Search error: " + text[:200])
                return text
            except (urllib.error.URLError, TimeoutError, ConnectionError, ArchiveError) as exc:
                if attempt == retries - 1:
                    raise ArchiveError(f"IRSA Cone Search failed: {exc}") from exc
                time.sleep(min(30, 2 * 2 ** attempt))

    with ThreadPoolExecutor(4) as pool:   # a few tiles at a time; more makes a busy IRSA answer 502
        texts = list(pool.map(fetch, centres))
    rows, seen = [], set()
    for text in texts:
        for r in csv.DictReader(io.StringIO(text)):
            key = r.get("source_id") or r.get("source_name") or r.get("designation")
            if key is not None and key in seen:
                continue
            seen.add(key)
            if separation_arcsec(ra, dec, float(r["ra"]), float(r["dec"])) <= radius_deg * 3600:
                rows.append(r)
    return rows


def gator(table, columns, ra, dec, radius_deg):
    """IRSA's Gator catalogue query: answers a whole-field CatWISE cone in a couple of seconds and returns
    only the columns asked for, even when TAP and Cone Search are struggling."""
    names = [c.strip() for c in columns.split(",")]
    url = GATOR_URL + "?" + urllib.parse.urlencode({
        "catalog": table, "spatial": "cone", "objstr": f"{ra:.6f} {dec:.6f}", "radius": f"{radius_deg * 3600:.2f}",
        "radunits": "arcsec", "outfmt": "1", "selcols": ",".join(names)})
    delay = 2.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:
                text = resp.read().decode("utf-8", "replace")
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == 3:
                raise ArchiveError(f"IRSA Gator failed: {exc}") from exc
            time.sleep(delay)
            delay *= 2
    if "|" not in text:
        return []
    return [{c: str(r[c]) if c in r.colnames and r[c] is not np.ma.masked else "" for c in names}
            for r in ascii.read(text, format="ipac")]


def fallback_rows(table, columns, ra, dec, radius_deg, top, order):
    """Without IRSA TAP: IRSA Gator first (Gaia DR3 and CatWISE2020, a second or two even when TAP and Cone
    Search are down), then ESA's Gaia archive for Gaia, then tiled IRSA Cone Search."""
    try:
        return gator(table, columns, ra, dec, radius_deg)
    except ArchiveError as exc:
        print(f"  {exc}", flush=True)
    try:
        if table == "gaia_dr3_source":
            head = f"SELECT TOP {top} " if top else "SELECT "
            tail = f" ORDER BY {order}" if top else ""
            return tap(f"{head}{columns} FROM gaiadr3.gaia_source WHERE CONTAINS(POINT('ICRS',ra,dec),"
                       f"CIRCLE('ICRS',{ra:.6f},{dec:.6f},{radius_deg:.6f}))=1{tail}", retries=2, timeout=60,
                       base=ESA_GAIA_TAP)
    except ArchiveError as exc:
        print(f"  ESA Gaia archive: {exc}", flush=True)
    return scs(table, ra, dec, radius_deg)


def cone_rows(table, columns, ra, dec, radius_deg, top=None, order=None):
    """IRSA TAP first. IRSA TAP was down for hours on 14 Nov 2026, so once it has failed in this run the
    rest of the run uses fallback_rows (same rows, same columns)."""
    global _tap_down
    if not _tap_down:
        head = f"SELECT TOP {top} " if top else "SELECT "
        tail = f" ORDER BY {order}" if top else ""
        try:
            return tap(f"{head}{columns} FROM {table} WHERE CONTAINS(POINT('ICRS',ra,dec),"
                       f"CIRCLE('ICRS',{ra:.6f},{dec:.6f},{radius_deg:.6f}))=1{tail}", retries=1, timeout=60)
        except ArchiveError as exc:
            _tap_down = True
            print(f"  IRSA TAP isn't answering ({str(exc)[:60]}); using IRSA Gator, ESA Gaia, Cone Search",
                  flush=True)
    rows = fallback_rows(table, columns, ra, dec, radius_deg, top, order)
    if top:
        rows.sort(key=lambda r: _f(r, order) if _f(r, order) is not None else 99.0)
        rows = rows[:top]
    return rows


def _f(row, key):
    try:
        v = float(row.get(key, ""))
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def gaia_cone(ra, dec, radius_deg, top=None):
    rows = cone_rows("gaia_dr3_source", "source_id, ra, dec, pmra, pmdec, phot_g_mean_mag", ra, dec, radius_deg,
                     top, "phot_g_mean_mag")
    return [{"catalog": "Gaia DR3", "id": f"Gaia DR3 {r['source_id']}", "ra": _f(r, "ra"), "dec": _f(r, "dec"),
             "pmra": _f(r, "pmra"), "pmdec": _f(r, "pmdec"), "mag": _f(r, "phot_g_mean_mag"),
             "epoch": GAIA_EPOCH} for r in rows if _f(r, "ra") is not None]


def catwise_cone(ra, dec, radius_deg, top=None):
    rows = cone_rows("catwise_2020", "source_name, ra, dec, pmra, pmdec, w1mpro, w2mpro", ra, dec, radius_deg,
                     top, "w1mpro")
    out = []
    for r in rows:
        if _f(r, "ra") is None:
            continue
        pmra, pmdec = _f(r, "pmra"), _f(r, "pmdec")
        out.append({"catalog": "CatWISE2020", "id": f"CatWISE {r.get('source_name', '').strip()}",
                    "ra": _f(r, "ra"), "dec": _f(r, "dec"),
                    "pmra": pmra * 1000 if pmra is not None else None,      # arcsec/yr -> mas/yr
                    "pmdec": pmdec * 1000 if pmdec is not None else None,
                    "mag": _f(r, "w1mpro"), "w2": _f(r, "w2mpro"), "epoch": CATWISE_EPOCH})
    return out


def tmass_cone(ra, dec, radius_deg, top=None):
    rows = cone_rows("fp_psc", "designation, ra, dec, j_m, h_m, k_m, jdate", ra, dec, radius_deg, top, "j_m")
    out = []
    for r in rows:
        if _f(r, "ra") is None:
            continue
        jd = _f(r, "jdate")
        epoch = round(2000.0 + (jd - 2451545.0) / 365.25, 3) if jd else TMASS_EPOCH
        out.append({"catalog": "2MASS", "id": f"2MASS J{r.get('designation', '').strip()}",
                    "ra": _f(r, "ra"), "dec": _f(r, "dec"), "pmra": None, "pmdec": None,
                    "mag": _f(r, "j_m"), "j_m": _f(r, "j_m"), "h_m": _f(r, "h_m"), "k_m": _f(r, "k_m"),
                    "epoch": epoch})
    return out


def move_to(src, epoch):
    """Position of a catalogue source at another epoch from its proper motion (mas/yr)."""
    dt = epoch - src["epoch"]
    dec = src["dec"] + (src["pmdec"] or 0) / 3.6e6 * dt
    ra = src["ra"] + (src["pmra"] or 0) / 3.6e6 * dt / math.cos(math.radians(src["dec"]))
    return ra, dec


def nearest_tmass(ra_at, tmass, limit):
    """Closest 2MASS source to a position function ra_at(epoch) -> (ra, dec), checked at each source's date."""
    best = None
    for t in tmass:
        ra, dec = ra_at(t["epoch"])
        sep = separation_arcsec(ra, dec, t["ra"], t["dec"])
        if sep <= limit and (best is None or sep < best[1]):
            best = (t, sep)
    return best


def tmass_check(mover, grid, cones, result):
    """Extra check on a mover from the ~1999 2MASS epoch. When Gaia confirmed the mover, Gaia's position moved
    back to the 2MASS date must land on a 2MASS source. Without a Gaia match we extrapolate our own track,
    which is far less precise over 25+ years, so the tolerance grows with our motion error."""
    tmass = cones.get("tmass") or []
    gaia_id = (result.get("matches", {}).get("gaia") or {}).get("id")
    gaia = next((s for s in cones.get("gaia") or [] if s["id"] == gaia_id), None)
    if gaia and gaia["pmra"] is not None:
        found = nearest_tmass(lambda ep: move_to(gaia, ep), tmass, 3 * TMASS_MATCH)
        basis, tol = "gaia", TMASS_MATCH
    else:
        def track(ep):
            dt = ep - mover["t0"]
            r, d = grid.to_radec(mover["x0"] + mover["vx_px_yr"] * dt, mover["y0"] + mover["vy_px_yr"] * dt)
            return float(r), float(d)
        tol = MATCH_ARCSEC + 3 * mover["pm_err"] * (EPOCH - TMASS_EPOCH)
        found = nearest_tmass(track, tmass, tol)
        basis = "track"
    if not found:
        return {"basis": basis, "agrees": False, "match": None}
    t, sep = found
    return {"basis": basis, "agrees": sep <= tol, "match": {"id": t["id"], "epoch": t["epoch"],
                                                           "sep_arcsec": round(sep, 2), "j_m": t["j_m"],
                                                           "h_m": t["h_m"], "k_m": t["k_m"]}}


def link_tmass_to_gaia(tmass, gaia):
    """Give each 2MASS source the proper motion of the Gaia star it matches (Gaia moved back to that source's
    own 2MASS date), so the viewer can carry 2MASS markers forward to the SPHEREx dates like the others."""
    if not tmass or not gaia:
        return
    g = [s for s in gaia if s["pmra"] is not None]
    if not g:
        return
    ra = np.array([s["ra"] for s in g])
    dec = np.array([s["dec"] for s in g])
    pmra = np.array([s["pmra"] for s in g])
    pmdec = np.array([s["pmdec"] for s in g])
    cosd = np.cos(np.radians(dec))
    for t in tmass:
        dt = t["epoch"] - GAIA_EPOCH
        dra = (ra + pmra / 3.6e6 * dt / cosd - t["ra"]) * math.cos(math.radians(t["dec"]))
        ddec = dec + pmdec / 3.6e6 * dt - t["dec"]
        sep = np.hypot(dra, ddec) * 3600
        i = int(np.argmin(sep))
        if sep[i] <= TMASS_MATCH:
            t["pmra"], t["pmdec"], t["gaia_id"] = g[i]["pmra"], g[i]["pmdec"], g[i]["id"]


def mover_sky(mover, grid):
    """Mover position at 2026.0 and its motion in mas/yr (east, north)."""
    dt = EPOCH - mover["t0"]
    ra, dec = grid.to_radec(mover["x0"] + mover["vx_px_yr"] * dt, mover["y0"] + mover["vy_px_yr"] * dt)
    pm_ra = -mover["vx_px_yr"] * grid.scale * 1000
    pm_dec = mover["vy_px_yr"] * grid.scale * 1000
    return float(ra), float(dec), pm_ra, pm_dec


def confirm_mover(mover, grid, cones):
    """R16: a catalogue source that sits on our track at the catalogue's epoch and whose proper motion agrees
    with ours. A source on the track with a different motion is kept as a disagreement (CatWISE has a wrong
    motion for Luhman 16, for example)."""
    ra, dec, pm_ra, pm_dec = mover_sky(mover, grid)
    pm = math.hypot(pm_ra, pm_dec)
    tol_pm = max(3 * mover["pm_err"] * 1000, 0.3 * pm, 500.0)
    matches, rejected = {}, {}
    for name, sources in cones.items():
        best = worst = None
        for s in sources:
            if s["pmra"] is None or s["pmdec"] is None:
                continue
            dt = s["epoch"] - mover["t0"]
            mra, mdec = grid.to_radec(mover["x0"] + mover["vx_px_yr"] * dt, mover["y0"] + mover["vy_px_yr"] * dt)
            sep = separation_arcsec(float(mra), float(mdec), s["ra"], s["dec"])
            if sep > MATCH_ARCSEC + 3 * mover["pm_err"] * abs(EPOCH - s["epoch"]):
                continue
            dpm = math.hypot(s["pmra"] - pm_ra, s["pmdec"] - pm_dec)
            entry = {"catalog": s["catalog"], "id": s["id"], "sep_arcsec": round(sep, 2),
                     "pm_catalog_arcsec_yr": round(math.hypot(s["pmra"], s["pmdec"]) / 1000, 3),
                     "pm_measured_arcsec_yr": round(pm / 1000, 3), "mag": s["mag"]}
            if dpm <= tol_pm:
                if best is None or sep < best["sep_arcsec"]:
                    best = entry
            elif worst is None or sep < worst["sep_arcsec"]:
                worst = entry
        if best:
            matches[name] = best
        elif worst:
            rejected[name] = worst
    disagree = False
    if "gaia" in matches and "wise" in matches:
        g, w = matches["gaia"]["pm_catalog_arcsec_yr"], matches["wise"]["pm_catalog_arcsec_yr"]
        disagree = abs(g - w) > max(0.3 * g, 0.5)
    elif ("gaia" in matches and "wise" in rejected) or ("wise" in matches and "gaia" in rejected):
        disagree = True
    return {"ra_2026": round(ra, 6), "dec_2026": round(dec, 6), "pmra_mas": round(pm_ra, 1),
            "pmdec_mas": round(pm_dec, 1), "matches": matches, "motion_mismatch": rejected,
            "confirmed": bool(matches), "catwise_gaia_disagree": disagree}


def mover_cones(mover, grid):
    ra, dec, _, _ = mover_sky(mover, grid)
    pm = mover["pm_arcsec_yr"] + 3 * mover["pm_err"]
    gaia_r = (CONE_BASE + pm * (EPOCH - GAIA_EPOCH)) / 3600
    wise_r = (CONE_BASE + pm * (EPOCH - CATWISE_EPOCH)) / 3600
    tmass_r = (CONE_BASE + pm * (EPOCH - TMASS_EPOCH + 2)) / 3600   # 2MASS ran 1997-2001
    return {"gaia": gaia_cone(ra, dec, gaia_r), "wise": catwise_cone(ra, dec, wise_r),
            "tmass": tmass_cone(ra, dec, tmass_r)}


def parse_skybot(text):
    """SkyBoT text answer: '# Num | Name | RA(h) | DE(deg) | Class | Mv | Err(arcsec) | ...' rows."""
    header, rows = None, []
    for line in text.splitlines():
        if line.startswith("#") and "|" in line:
            header = [h.strip(" #").lower() for h in line.split("|")]
            continue
        if not line.strip() or line.startswith("#") or header is None or "|" not in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        rows.append(dict(zip(header, cells)))
    out = []
    for r in rows:
        ra = _sexa(_pick(r, "ra"), hours=True)
        dec = _sexa(_pick(r, "de"))
        if ra is None or dec is None:
            continue
        out.append({"number": _pick(r, "num"), "name": _pick(r, "name"), "class": _pick(r, "class"),
                    "ra": ra, "dec": dec, "v": _num(_pick(r, "mv")), "err_arcsec": _num(_pick(r, "err")),
                    "dra_arcsec_h": _num(_pick(r, "dra")), "ddec_arcsec_h": _num(_pick(r, "ddec"))})
    return out


def _pick(row, prefix):
    for k, v in row.items():
        if k.startswith(prefix):
            return v
    return None


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _sexa(s, hours=False):
    if s is None:
        return None
    parts = s.replace(":", " ").split()
    try:
        if len(parts) == 1:
            v = float(parts[0])
        else:
            sign = -1 if parts[0].startswith("-") else 1
            d, m = abs(float(parts[0])), float(parts[1])
            sec = float(parts[2]) if len(parts) > 2 else 0.0
            v = sign * (d + m / 60 + sec / 3600)
    except ValueError:
        return None
    return v * 15 if hours else v


def skybot(target_id, mjd, ra, dec, radius_deg):
    cache_path = CACHE / target_id / "skybot.json"
    cache = read_json(cache_path, {})
    key = f"{mjd:.4f}|{ra:.4f}|{dec:.4f}|{radius_deg:.4f}"
    if key in cache:
        return cache[key]
    params = {"-ep": f"{mjd + 2400000.5:.5f}", "-ra": f"{ra:.6f}", "-dec": f"{dec:.6f}",
              "-rd": f"{radius_deg:.5f}", "-mime": "text", "-output": "obs", "-loc": "500",
              "-filter": "0", "-objFilter": "111", "-refsys": "EQJ2000", "-from": "Wink"}
    url = SKYBOT_URL + "?" + urllib.parse.urlencode(params)
    last = None
    for delay in (0, 3, 10):
        time.sleep(delay)
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                text = resp.read().decode("utf-8", "replace")
            found = parse_skybot(text)
            cache[key] = found
            write_json(cache_path, cache)
            return found
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = exc
    raise ArchiveError(f"SkyBoT failed: {last}")


def asteroids_for(target_id, stack, transients):
    """SkyBoT per visit (mid time), positions at the start and end of the visit from the rates (R17)."""
    grid = stack.grid
    radius = math.hypot(grid.nx, grid.ny) / 2 * grid.scale / 3600
    tracks = {}
    for v in stack.visits:
        hdr = stack.meta(v)
        mid = stack.mjd(v)
        t0, t1 = hdr.get("MJDMIN", mid), hdr.get("MJDMAX", mid)
        for a in skybot(target_id, mid, grid.ra0, grid.dec0, radius):
            if a["v"] is not None and a["v"] > ASTEROID_VMAX:
                continue
            pts = []
            for t in sorted({t0, mid, t1}):
                hours = (t - mid) * 24
                ra = a["ra"] + (a["dra_arcsec_h"] or 0) * hours / 3600 / math.cos(math.radians(a["dec"]))
                dec = a["dec"] + (a["ddec_arcsec_h"] or 0) * hours / 3600
                x, y = grid.to_pix(ra, dec)
                pts.append({"visit": v, "mjd": round(t, 5), "ra": round(ra, 6), "dec": round(dec, 6),
                            "x": round(float(x), 2), "y": round(float(y), 2)})
            inside = [p for p in pts if -5 <= p["x"] <= grid.nx + 5 and -5 <= p["y"] <= grid.ny + 5]
            if not inside:
                continue
            key = a["name"] or a["number"]
            entry = tracks.setdefault(key, {"name": a["name"], "number": a["number"], "class": a["class"],
                                            "v": a["v"], "err_arcsec": a["err_arcsec"], "track": []})
            entry["track"].extend(pts)
    for t in transients:
        best = None
        for name, a in tracks.items():
            seg = [p for p in a["track"] if p["visit"] == t["visit"]]
            if not seg:
                continue
            tol = ASTEROID_MATCH + min(a["err_arcsec"] or 0, 30.0)
            d = _dist_to_path(t["x"], t["y"], seg) * grid.scale
            if d <= tol and (best is None or d < best[1]):
                best = (name, d)
        t["identified_as"] = best[0] if best else None
        t["kind"] = "asteroid" if best else "unidentified"
    return list(tracks.values())


def _dist_to_path(x, y, pts):
    if len(pts) == 1:
        return math.hypot(x - pts[0]["x"], y - pts[0]["y"])
    best = float("inf")
    for a, b in zip(pts, pts[1:]):
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        seg = dx * dx + dy * dy
        u = 0.0 if seg == 0 else max(0.0, min(1.0, ((x - a["x"]) * dx + (y - a["y"]) * dy) / seg))
        best = min(best, math.hypot(x - a["x"] - u * dx, y - a["y"] - u * dy))
    return best


def identify_target(target_id, targets, force=False, offline=False):
    out_path = OUT / "identify" / f"{target_id}.json"
    comp_path = OUT / "compare" / f"{target_id}.json"
    comp = read_json(comp_path)
    if comp is None:
        print(f"  {target_id}: no compare result yet (run step 5)", flush=True)
        return None
    old = read_json(out_path)
    if (not force and old and not old.get("errors") and old.get("pipeline_version") == PIPELINE_VERSION
            and "tmass" in old.get("catalogues", {}) and out_path.stat().st_mtime >= comp_path.stat().st_mtime):
        print(f"  {target_id}: done already", flush=True)
        return old

    stack = read_stack(stack_path(target_id))
    grid = stack.grid
    target = targets.get(target_id, {})
    errors, notes = [], []
    fov = max(grid.nx, grid.ny) * grid.scale / 3600
    field = {}
    for name, fn in (("gaia", gaia_cone), ("wise", catwise_cone), ("tmass", tmass_cone)):
        if offline:
            field[name] = None
            continue
        try:
            field[name] = fn(grid.ra0, grid.dec0, 0.75 * fov + 0.01, top=FIELD_ROWS)
        except ArchiveError as exc:
            field[name] = None
            errors.append(f"{name} field: {exc}")

    link_tmass_to_gaia(field.get("tmass"), field.get("gaia"))

    movers = []
    for m in comp["movers"]:
        entry = {**m}
        if offline:
            entry.update({"confirmed": False, "matches": {}, "lookup": "skipped (offline)"})
        else:
            try:
                cones = mover_cones(m, grid)
                entry.update(confirm_mover(m, grid, {k: cones[k] for k in ("gaia", "wise")}))
                entry["tmass_check"] = tmass_check(m, grid, cones, entry)
            except ArchiveError as exc:
                errors.append(f"mover {m['id']}: {exc}")
                entry.update({"confirmed": False, "matches": {}, "lookup": "failed"})
        if entry.get("catwise_gaia_disagree"):
            notes.append(f"Mover {m['id']}: CatWISE and Gaia disagree on its motion; we go with Gaia.")
        check = entry.get("tmass_check")
        if check and check["basis"] == "gaia" and check["match"] and not check["agrees"]:
            notes.append(f"Mover {m['id']}: Gaia's motion doesn't lead back to its 2MASS position "
                         f"({check['match']['sep_arcsec']}″ off in {check['match']['epoch']:.0f}).")
        movers.append(entry)

    transients = [dict(t) for t in comp.get("transients", [])]
    asteroids = []
    if offline:
        for t in transients:
            t.update({"identified_as": None, "kind": "unidentified"})
    else:
        try:
            asteroids = asteroids_for(target_id, stack, transients)
        except ArchiveError as exc:
            errors.append(f"asteroids: {exc}")
            for t in transients:
                t.update({"identified_as": None, "kind": "unidentified"})

    tgt = dict(comp["target"])
    tm = next((m for m in movers if m["id"] == tgt.get("mover")), None)
    tgt["confirmed"] = bool(tm and tm.get("confirmed"))
    if tm and target.get("pm_mas"):
        expected = target["pm_mas"] / 1000
        tgt["pm_ratio"] = round(tm["pm_arcsec_yr"] / expected, 3)
        if abs(tgt["pm_ratio"] - 1) > 0.2:
            notes.append(f"Measured motion {tm['pm_arcsec_yr']}″/yr differs from the catalogue "
                         f"{expected:.2f}″/yr by more than 20%.")

    result = {"id": target_id, "pipeline_version": PIPELINE_VERSION,
              "catalogues": {name: ({"loaded": True, "epoch": CAT_EPOCH[name], "sources": rows}
                                    if rows is not None else {"loaded": False})
                             for name, rows in field.items()},
              "movers": movers, "asteroids": asteroids, "transients": transients, "target": tgt,
              "notes": notes, "errors": errors}
    write_json(out_path, result)
    conf = sum(1 for m in movers if m.get("confirmed"))
    old_ok = sum(1 for m in movers if (m.get("tmass_check") or {}).get("agrees"))
    n_ast = sum(1 for t in transients if t.get("kind") == "asteroid")
    print(f"  {target_id}: {conf}/{len(movers)} mover(s) confirmed ({old_ok} also at the 2MASS epoch), "
          f"{len(asteroids)} asteroid(s) in field, "
          f"{n_ast}/{len(transients)} one-visit source(s) are asteroids"
          f"{', ' + str(len(errors)) + ' lookup error(s), rerun later' if errors else ''}", flush=True)
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--offline", action="store_true", help="skip catalogue and SkyBoT lookups")
    args = ap.parse_args(argv)
    targets = target_map()
    ids = parse_only(args.only, [t["id"] for t in load_targets() if (OUT / "compare" / f"{t['id']}.json").exists()])
    print(f"step 6: identifying {len(ids)} target(s)", flush=True)
    _, failed = run_many(lambda i: identify_target(i, targets, args.force, args.offline), ids, args.workers)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
