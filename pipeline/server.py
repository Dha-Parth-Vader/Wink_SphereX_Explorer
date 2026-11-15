"""Live SPHEREx server: serves the static site and makes a patch for any RA/Dec on request.

    python pipeline/server.py --site public --port 8000 [--max 36] [--live-max-mb 500]

GET /api/patch?ra=&dec=&fov=[&det=][&layers=gaia,wise|none][&max=]
  200  a patch in the <id>.json shape (pre-built if one covers the spot, else from the live cache)
  202  {status: working|queued, step, steps: 4, stage, message, done, total, elapsed_s} while a job runs
  404  {status: no-coverage, nearest} when SPHEREx has no image of the spot
GET /api/health -> {ok, jobs_running, queued, version}

A job finds the images (IRSA), downloads and cleans up to --max of them (steps 2 and 3), stacks them
(step 4) and exports them (step 7), fetching the ticked catalogues at the same time. Movers and asteroids
are left to the 100 pre-built targets. Results are cached under SPHEREX_LIVE_CACHE and served at
/data/live/; the cache is trimmed to --live-max-mb, least recently viewed first.
"""
import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sys
import threading
import time
import traceback
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import irsa  # noqa: E402
import step2_download  # noqa: E402
import step3_clean  # noqa: E402
import step4_align_stack  # noqa: E402
import step6_identify  # noqa: E402
import step7_export  # noqa: E402
from stackfile import PIPELINE_VERSION, read_stack, separation_arcsec  # noqa: E402

MIN_FOV = 5 / 60          # smaller fields are ~20 px across and look like noise; the viewer zooms instead (R22)
MAX_FOV = 1.0
MIN_COVER = 0.25          # dates covering less of the field than this are dropped, the rest captioned
JOB_TIMEOUT_S = 6 * 60
LAYERS = ("gaia", "wise")
STEPS = 4

ARGS = None
SITE = None
LIVE = None
JOB_SLOTS = None
JOBS = {}
JOBS_LOCK = threading.Lock()
NO_COVERAGE = {}


class JobCancelled(Exception):
    pass


# ---- positions and footprints ----

def tangent(ra0, dec0, ra, dec):
    """Gnomonic projection in degrees (xi east, eta north) around (ra0, dec0)."""
    a, d = math.radians(ra), math.radians(dec)
    a0, d0 = math.radians(ra0), math.radians(dec0)
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    if cosc <= 0:
        return None
    xi = math.cos(d) * math.sin(a - a0) / cosc
    eta = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / cosc
    return math.degrees(xi), math.degrees(eta)


def polygon_of(s_region):
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", s_region or "")]
    return list(zip(nums[0::2], nums[1::2]))


def inside(x, y, poly):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def coverage(s_region, ra, dec, fov):
    """Share of the requested square inside the image footprint, from a 9x9 grid of test points (R31)."""
    pts = [tangent(ra, dec, r, d) for r, d in polygon_of(s_region)]
    if len(pts) < 3 or any(p is None for p in pts):
        return 0.0
    half = fov / 2
    grid = [(-half + fov * (i + 0.5) / 9, -half + fov * (j + 0.5) / 9) for i in range(9) for j in range(9)]
    return sum(inside(x, y, pts) for x, y in grid) / len(grid)


def evenly(items, k):
    if len(items) <= k:
        return list(items)
    return [items[int((i + 0.5) * len(items) / k)] for i in range(k)]


def pick_images(rows, ra, dec, fov, max_images):
    """Best-covering images of every (visit, detector), then at most max_images spread over all of them."""
    for r in rows:
        r["coverage"] = coverage(r["s_region"], ra, dec, fov)
    groups = defaultdict(list)
    for r in rows:
        if r["coverage"] >= MIN_COVER:
            groups[(r["visit"], r["detector"])].append(r)
    for key, g in groups.items():
        best = max(r["coverage"] for r in g)
        keep = [r for r in g if r["coverage"] >= min(0.98, 0.9 * best)]
        groups[key] = sorted(keep, key=lambda r: r["em_min_um"])
    if not groups:
        return []
    keys = sorted(groups, key=lambda k: (k[1], k[0]))   # detector-major so a small cap still reaches every visit
    quota = {k: 0 for k in keys}
    left = max_images
    while left > 0 and any(quota[k] < len(groups[k]) for k in keys):
        for k in keys:
            if left and quota[k] < len(groups[k]):
                quota[k] += 1
                left -= 1
    return [r for k in keys for r in evenly(groups[k], quota[k])]


# ---- requests ----

def parse_layers(qs):
    if "layers" not in qs:
        return list(LAYERS)
    raw = ",".join(qs["layers"]).lower()
    return [x for x in LAYERS if x in [s.strip() for s in raw.split(",")]]


def cache_key(ra, dec, fov):
    return hashlib.md5(f"{ra:.3f},{dec:.3f},{fov:.4f},{PIPELINE_VERSION}".encode()).hexdigest()[:16]


def load_patches():
    path = SITE / "data" / "patches.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def covering_patch(ra, dec):
    best = None
    for p in load_patches():
        if p.get("simulated"):
            continue
        t = tangent(p["ra"], p["dec"], ra, dec)
        if t is None:
            continue
        off = max(abs(t[0]), abs(t[1]))
        if off <= p["fov_deg"] / 2 - 6.15 / 3600 and (best is None or off < best[0]):
            best = (off, p)
    return best and best[1]


def nearest_patch(ra, dec):
    best = None
    for p in load_patches():
        sep = separation_arcsec(ra, dec, p["ra"], p["dec"]) / 3600
        if best is None or sep < best["sep_deg"]:
            best = {"id": p["id"], "name": p.get("title", p["id"]), "ra": p["ra"], "dec": p["dec"],
                    "sep_deg": round(sep, 4)}
    return best


def absolute(doc, prefix):
    """File paths in a patch JSON made absolute to this server, so they resolve from any page."""
    for f in doc.get("frames", []):
        for k in ("file", "flags_file"):
            if f.get(k) and not f[k].startswith("/"):
                f[k] = prefix + f[k]
    return doc


def with_layers(doc, layers):
    doc = dict(doc)
    doc["overlays"] = {k: v for k, v in (doc.get("overlays") or {}).items() if k in layers}
    return doc


# ---- live cache ----

def live_json(key):
    return LIVE / f"{key}.json"


def live_paths(key):
    return [live_json(key), LIVE / "frames" / key, LIVE / "dome" / "cubes" / key, LIVE / "work" / key]


def size_of(path):
    if path.is_file():
        return path.stat().st_size
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


def evict():
    """Delete least recently viewed live patches until the cache fits in --live-max-mb (R33)."""
    limit = ARGS.live_max_mb * 1e6
    entries = []
    for j in LIVE.glob("*.json"):
        key = j.stem
        entries.append((j.stat().st_mtime, key, sum(size_of(p) for p in live_paths(key))))
    total = sum(e[2] for e in entries)
    for _, key, size in sorted(entries):
        if total <= limit:
            break
        with JOBS_LOCK:
            if key in JOBS:
                continue
        for p in live_paths(key):
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        total -= size


def cached_patch(key, layers):
    path = live_json(key)
    if not path.exists():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    if "loaded_layers" not in doc:
        return None   # step 7's copy with relative paths; the job replaces it in a moment
    absolute(doc, "/data/live/")
    missing = [x for x in layers if x not in doc["loaded_layers"]]
    if missing:   # asked for a catalogue this patch was made without: fetch just that one now
        doc["overlays"].update(fetch_catalogues(doc["patch"]["ra"], doc["patch"]["dec"], doc["patch"]["fov_deg"],
                                                missing))
        doc["loaded_layers"] = sorted(set(doc.get("loaded_layers", [])) | set(missing))
        path.write_text(json.dumps(doc), encoding="utf-8")
    os.utime(path)
    return with_layers(doc, layers)


def fetch_catalogues(ra, dec, fov, layers):
    radius = 0.75 * fov + 0.01
    ident = {"catalogues": {}}
    for name in layers:
        fn = step6_identify.gaia_cone if name == "gaia" else step6_identify.catwise_cone
        try:
            ident["catalogues"][name] = {"loaded": True, "sources": fn(ra, dec, radius, top=step6_identify.FIELD_ROWS)}
        except Exception as exc:  # noqa: BLE001  a catalogue failing must not lose the images
            print(f"  live: {name} lookup failed: {exc}", flush=True)
    overlays, _ = step7_export.overlays(ident, [n for n in layers if n in ident["catalogues"]])
    return overlays


# ---- jobs ----

class Job:
    def __init__(self, key, ra, dec, fov, layers, max_images):
        self.key, self.ra, self.dec, self.fov, self.layers, self.max = key, ra, dec, fov, layers, max_images
        self.state = "queued"
        self.step, self.stage, self.message, self.done, self.total = 0, "queued", "Waiting to start", 0, 0
        self.started = time.time()
        self.deadline = None
        self.cancelled = False
        self.error = None
        self.archive_down = False
        self.result = None

    def progress(self):
        if self.state == "queued":
            return {"status": "queued", "step": 0, "steps": STEPS, "stage": "queued",
                    "message": "Waiting for another search on this server to finish", "done": 0, "total": 0,
                    "elapsed_s": round(time.time() - self.started, 1), "queued": True}
        return {"status": "working", "step": self.step, "steps": STEPS, "stage": self.stage, "message": self.message,
                "done": self.done, "total": self.total, "elapsed_s": round(time.time() - self.started, 1),
                "queued": False}

    def set(self, step, stage, message, done=0, total=0):
        self.check()
        self.step, self.stage, self.message, self.done, self.total = step, stage, message, done, total

    def check(self):
        if self.cancelled or (self.deadline and time.time() > self.deadline):
            self.cancelled = True
            raise JobCancelled(f"took longer than {JOB_TIMEOUT_S // 60} minutes")


def start_job(key, ra, dec, fov, layers, max_images):
    job = Job(key, ra, dec, fov, layers, max_images)
    JOBS[key] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job


def run_job(job):
    JOB_SLOTS.acquire()
    released = threading.Event()

    def release():
        if not released.is_set():
            released.set()
            JOB_SLOTS.release()

    # a hung download must not hold the only slot forever (R34)
    watchdog = threading.Timer(JOB_TIMEOUT_S + 5, lambda: (setattr(job, "cancelled", True), release()))
    watchdog.daemon = True
    try:
        job.state = "working"
        job.started = time.time()
        job.deadline = job.started + JOB_TIMEOUT_S
        watchdog.start()
        job.result = make_patch(job)
    except Exception as exc:  # noqa: BLE001
        job.error = str(exc) or type(exc).__name__
        # IRSA answering 5xx or not at all: say so plainly instead of a bare HTTP error
        job.archive_down = isinstance(exc, (irsa.ArchiveBusy, irsa.requests.ConnectionError, irsa.requests.Timeout))
        if not isinstance(exc, (JobCancelled, irsa.ArchiveBusy)):
            traceback.print_exc()
        print(f"  live job {job.key} failed: {job.error}", flush=True)
    finally:
        job.state = "done"
        watchdog.cancel()
        release()
        shutil.rmtree(LIVE / "work" / job.key, ignore_errors=True)
        try:
            evict()
        except OSError:
            pass


def make_patch(job):
    ra, dec, fov, key = job.ra, job.dec, job.fov, job.key
    work = LIVE / "work" / key
    raw = work / "cache" / key
    raw.mkdir(parents=True, exist_ok=True)

    job.set(1, "find", "Finding SPHEREx images of this spot")
    rows = irsa.obscore_for(ra, dec)
    for r, v in zip(rows, irsa.visits_of([r["t_min"] for r in rows])):
        r["visit"] = v
    picked = pick_images(rows, ra, dec, fov, job.max)
    if not picked:
        NO_COVERAGE[key] = time.time()
        return "no-coverage"

    with ThreadPoolExecutor(1) as cat_pool:
        catalogues = cat_pool.submit(fetch_catalogues, ra, dec, fov, job.layers) if job.layers else None

        need = [irsa.did_of(r["access_url"]) for r in picked if not irsa.file_path(r["access_url"])]
        paths = irsa.caom_paths(need) if need else {}
        target = {"id": key, "name": "", "kind": "field", "ra": ra, "dec": dec, "epoch": 2026.0}
        clean_dir = raw / "clean"
        clean_dir.mkdir(exist_ok=True)
        total = len(picked)
        job.set(2, "download", "Downloading and cleaning SPHEREx images", 0, total)
        recs = []

        def one(r):
            job.check()
            uri = irsa.file_path(r["access_url"]) or paths.get(irsa.did_of(r["access_url"]))
            if not uri:
                return None
            name = f"{r['obs_id']}_D{r['detector']}.fits"
            dest = raw / name
            step2_download.fetch(step2_download.fetch_s3, uri, ra, dec, fov * step2_download.CUTOUT_PAD, str(dest))
            row = {"file": name, "obs_id": r["obs_id"], "release": r["obs_collection"], "mjd": f"{r['t_min']:.5f}",
                   "visit": r["visit"], "detector": r["detector"]}
            rec = step3_clean.clean_one((str(dest), str(clean_dir / name), target, row))
            dest.unlink(missing_ok=True)
            return rec

        with ThreadPoolExecutor(ARGS.threads) as pool:
            futures = [pool.submit(one, r) for r in picked]
            for i, f in enumerate(as_completed(futures), 1):
                try:
                    rec = f.result()
                    if rec:
                        recs.append(rec)
                except JobCancelled:
                    raise
                except Exception as exc:  # noqa: BLE001  one bad image shouldn't sink the patch
                    print(f"  live: skipped an image: {str(exc)[:100]}", flush=True)
                job.set(2, "download", "Downloading and cleaning SPHEREx images", i, total)
        if not recs:
            raise RuntimeError("none of the SPHEREx images could be read")

        job.set(3, "stack", "Lining up and stacking the images", 0, 0)
        out_dir = work / "out"
        (out_dir / "clean").mkdir(parents=True, exist_ok=True)
        with open(out_dir / "clean" / f"{key}.csv", "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(recs[0].keys()))
            w.writeheader()
            w.writerows(recs)
        msg = step4_align_stack.run(target, fov, True, True, out_dir=str(out_dir), cache_dir=str(work / "cache"),
                                    min_frames=1, min_visit_frames=3)
        stack_file = work / "cache" / key / "stack.fits"
        if not stack_file.exists():
            raise RuntimeError(msg)

        job.set(4, "export", "Making the pictures", 0, 0)
        overlays = catalogues.result() if catalogues else {}

    stack = read_stack(stack_file)
    name = f"RA {ra:.4f}, Dec {dec:+.4f}"
    doc, _ = step7_export.export_patch(stack, key, LIVE, name, "field", target=target, layers=())
    doc["overlays"] = overlays
    doc["loaded_layers"] = sorted(job.layers)
    doc["patch"]["live"] = True
    doc["verdicts"] = {"motion": "not checked", "variability": "not checked",
                       "notes": ["Made live for this search. We check movers, brightness changes and asteroids "
                                 "only for the 100 pre-built targets; your blink is the check here."]}
    doc["predictions"] = []
    for f in doc["frames"]:   # a live spot has no target, so the per-target saturation note doesn't apply
        f["flags"] = [n for n in f["flags"] if not n.startswith("The target is saturated")]
    absolute(doc, "/data/live/")
    live_json(key).write_text(json.dumps(doc), encoding="utf-8")
    shutil.rmtree(LIVE / "dome" / "cubes" / key, ignore_errors=True)   # the Sky Dome only shows pre-built targets
    return "ok"


# ---- HTTP ----

def origin_allowed(origin):
    allowed = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
    if "*" in allowed:
        return True
    host = urlparse(origin).hostname or ""
    for a in allowed:
        if a.startswith("*."):
            if host.endswith(a[1:]) and urlparse(origin).scheme == "https":
                return True
        elif origin.rstrip("/") == a.rstrip("/"):
            return True
    return False


class Handler(SimpleHTTPRequestHandler):
    server_version = "Wink"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def translate_path(self, path):
        p = urlparse(path).path
        if p.startswith("/data/live/"):
            rel = Path(*[x for x in p[len("/data/live/"):].split("/") if x not in ("", ".", "..")])
            return str(LIVE / rel)
        return super().translate_path(path)

    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        p = urlparse(self.path).path
        if p == "/api/health" or (p == "/api/patch" and len(args) > 1 and str(args[1]) == "202"):
            return   # polling every 1.5 s would drown the log
        super().log_message(fmt, *args)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        gz = len(body) > 2048 and "gzip" in self.headers.get("Accept-Encoding", "")
        if gz:   # patches with 1,500 catalogue stars are ~450 KB of JSON, ~60 KB gzipped
            body = gzip.compress(body, 6)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        self.send_response(204 if origin and origin_allowed(origin) else 403)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            origin = self.headers.get("Origin")
            if origin and not origin_allowed(origin):
                return self.send_json(403, {"status": "error", "message": "This site isn't allowed to use the server."})
            if url.path == "/api/health":
                with JOBS_LOCK:
                    jobs = list(JOBS.values())
                return self.send_json(200, {"ok": True, "jobs_running": sum(j.state == "working" for j in jobs),
                                            "queued": sum(j.state == "queued" for j in jobs),
                                            "version": PIPELINE_VERSION})
            if url.path == "/api/patch":
                return self.api_patch(parse_qs(url.query, keep_blank_values=True))
            return self.send_json(404, {"status": "error", "message": "Unknown API path."})
        return super().do_GET()

    def api_patch(self, qs):
        try:
            ra = float(qs["ra"][0]) % 360
            dec = float(qs["dec"][0])
            fov = float(qs.get("fov", [str(10 / 60)])[0])
            if not -90 <= dec <= 90 or not fov > 0:
                raise ValueError
        except (KeyError, ValueError, IndexError):
            return self.send_json(400, {"status": "error", "message": "Give ra and dec in degrees and fov > 0."})
        layers = parse_layers(qs)
        try:
            max_images = min(ARGS.max, max(6, int(qs.get("max", [ARGS.max])[0])))
        except ValueError:
            max_images = ARGS.max

        pre = covering_patch(ra, dec)
        if pre:
            doc = json.loads((SITE / "data" / f"{pre['id']}.json").read_text(encoding="utf-8"))
            return self.send_json(200, absolute(with_layers(doc, layers), "/data/"))

        fov = min(MAX_FOV, max(MIN_FOV, fov))
        key = cache_key(ra, dec, fov)
        with JOBS_LOCK:
            running = JOBS.get(key)
        if running and not (running.result or running.error):
            return self.send_json(202, running.progress())
        doc = cached_patch(key, layers)
        if doc:
            return self.send_json(200, doc)
        if key in NO_COVERAGE:
            return self.send_json(404, {"status": "no-coverage", "nearest": nearest_patch(ra, dec)})

        with JOBS_LOCK:
            job = JOBS.get(key)
            if job and (job.result or job.error):
                del JOBS[key]
            elif not job:
                job = start_job(key, ra, dec, fov, layers, max_images)
            else:
                return self.send_json(202, job.progress())
        if job.result == "no-coverage":
            return self.send_json(404, {"status": "no-coverage", "nearest": nearest_patch(ra, dec)})
        if job.result == "ok":
            return self.send_json(200, cached_patch(key, layers))
        if job.error:
            if job.archive_down:
                return self.send_json(500, {"status": "archive-down", "message": "NASA's SPHEREx archive (IRSA) isn't "
                                            "answering right now, so we can't fetch new images. Try again in a few "
                                            "minutes. The 100 targets in the gallery still work."})
            return self.send_json(500, {"status": "error", "message": f"This search failed ({job.error}). Try again."})
        return self.send_json(202, job.progress())


def main(argv=None):
    global ARGS, SITE, LIVE, JOB_SLOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--site", default=str(HERE.parent / "public"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--max", type=int, default=36, help="most images per live patch")
    ap.add_argument("--live-max-mb", type=float, default=500)
    ap.add_argument("--threads", type=int, default=int(os.environ.get("LIVE_THREADS", 8)))
    ARGS = ap.parse_args(argv)
    SITE = Path(ARGS.site).resolve()
    LIVE = Path(os.environ.get("SPHEREX_LIVE_CACHE", SITE / "data" / "live")).resolve()
    LIVE.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(LIVE / "work", ignore_errors=True)
    JOB_SLOTS = threading.Semaphore(max(1, int(os.environ.get("LIVE_MAX_JOBS", 1))))
    httpd = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    httpd.daemon_threads = True
    print(f"Wink on http://localhost:{ARGS.port}/  (site {SITE}, live cache {LIVE}, "
          f"{os.environ.get('LIVE_MAX_JOBS', 1)} job(s) at a time, origins {os.environ.get('ALLOWED_ORIGINS', '*')})",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
