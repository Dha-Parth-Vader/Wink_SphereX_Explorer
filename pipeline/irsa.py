"""IRSA access: TAP queries (sync and async), SPHEREx image lists and file paths.

Follows the IRSA SPHEREx tutorial notebooks (caltech-ipac.github.io/irsa-tutorials). IRSA only, no CDS.
"""
import csv
import io
import time

import requests

TAP_SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
TAP_ASYNC = "https://irsa.ipac.caltech.edu/TAP/async"
SIA = "https://irsa.ipac.caltech.edu/SIA"
S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IRSA_BASE = "https://irsa.ipac.caltech.edu/"
VISIT_GAP_DAYS = 20.0
SURVEY_START_MJD = 60796.0
SURVEY_DAYS = 182.6

session = requests.Session()
session.headers["User-Agent"] = "skyblink-pipeline"


class ArchiveBusy(Exception):
    pass


def _check(resp):
    if resp.status_code >= 500:
        raise ArchiveBusy(f"HTTP {resp.status_code}")
    text = resp.text
    if "Server busy" in text[:200]:
        raise ArchiveBusy("Server busy")
    resp.raise_for_status()
    if text.lstrip().startswith("<?xml") or text.lstrip().startswith("<VOTABLE"):
        raise RuntimeError("TAP error: " + text[:400])
    return text


def retry(fn, retries=6, base=3.0):
    """Call fn(), retrying on 5xx, "Server busy" and network errors with exponential backoff."""
    for attempt in range(retries):
        try:
            return fn()
        except (ArchiveBusy, requests.ConnectionError, requests.Timeout) as e:
            if attempt == retries - 1:
                raise
            wait = base * 2 ** attempt
            print(f"  IRSA: {e}; retrying in {wait:.0f} s", flush=True)
            time.sleep(wait)


def tap(query, mode="sync", timeout=600, retries=6, poll=10, max_wait=3600):
    """Run an ADQL query and return a list of dict rows (all values are strings)."""
    if mode == "async":
        return _tap_async(query, poll, max_wait)

    def run():
        r = session.post(TAP_SYNC, data={"QUERY": query, "FORMAT": "csv"}, timeout=timeout)
        return _check(r)
    return list(csv.DictReader(io.StringIO(retry(run, retries=retries))))


def _tap_async(query, poll, max_wait):
    def submit():
        r = session.post(TAP_ASYNC, data={"QUERY": query, "FORMAT": "csv", "PHASE": "RUN"},
                         timeout=120, allow_redirects=False)
        if r.status_code >= 500:
            raise ArchiveBusy(f"HTTP {r.status_code}")
        job = r.headers.get("Location")
        if not job:
            raise RuntimeError("async TAP gave no job URL: " + r.text[:200])
        return job
    job = retry(submit)
    t0 = time.time()
    while time.time() - t0 < max_wait:
        phase = retry(lambda: _check(session.get(job + "/phase", timeout=60))).strip()
        if phase == "COMPLETED":
            text = retry(lambda: _check(session.get(job + "/results/result", timeout=600)))
            return list(csv.DictReader(io.StringIO(text)))
        if phase in ("ERROR", "ABORTED"):
            raise RuntimeError(f"async TAP job {job} ended {phase}")
        time.sleep(poll)
    raise TimeoutError(job)


def sia_for(ra, dec):
    """Same list from IRSA's SIA service, used when TAP is down (it was for hours on 14 Nov 2026)."""
    def run():
        r = session.get(SIA, params={"INSTRUMENT": "SPHEREx", "POS": f"circle {ra:.6f} {dec:.6f} 0.0001",
                                     "RESPONSEFORMAT": "CSV"}, timeout=300)
        return _check(r)
    rows = csv.DictReader(io.StringIO(retry(run)))
    keep = ("obs_id", "obs_collection", "t_min", "t_max", "energy_bandpassname", "em_min", "em_max",
            "access_url", "s_region")
    return [{k: r[k] for k in keep} for r in rows
            if r["dataproduct_type"] == "image" and not r["obs_collection"].endswith("_cube")]


_tap_failed_at = 0.0
TAP_RETRY_S = 600   # after a TAP failure, go straight to SIA for 10 minutes instead of waiting on TAP each time


def obscore_for(ra, dec):
    """Every SPHEREx spectral image (all releases) whose footprint contains (ra, dec), oldest first."""
    q = ("SELECT obs_id, obs_collection, t_min, t_max, energy_bandpassname, em_min, em_max, access_url, s_region "
         "FROM spherex.obscore "
         f"WHERE CONTAINS(POINT('ICRS',{ra:.6f},{dec:.6f}), s_region)=1 "
         "AND dataproduct_type='image' AND obs_collection NOT LIKE '%cube%'")
    global _tap_failed_at
    rows = None
    if time.time() - _tap_failed_at > TAP_RETRY_S:
        try:
            rows = tap(q, timeout=45, retries=1)
        except Exception as e:  # noqa: BLE001
            print(f"  TAP failed ({str(e)[:60]}), using SIA", flush=True)
            _tap_failed_at = time.time()
    if rows is None:
        rows = sia_for(ra, dec)
    for r in rows:
        r["detector"] = int(r["energy_bandpassname"].replace("SPHEREx-D", ""))
        r["t_min"] = float(r["t_min"])
        r["em_min_um"] = float(r["em_min"]) * 1e6
        r["em_max_um"] = float(r["em_max"]) * 1e6
    return sorted(rows, key=lambda r: r["t_min"])


def file_path(access_url):
    """'ibe/data/spherex/...fits' when the access URL already is the file (SIA rows), else None."""
    i = access_url.find("ibe/data/spherex/")
    return access_url[i:] if i >= 0 and access_url.endswith(".fits") else None


def did_of(access_url):
    from urllib.parse import parse_qs, urlparse
    return parse_qs(urlparse(access_url).query)["ID"][0]


def caom_paths(dids, batch=300):
    """obs_publisher_did -> 'ibe/data/spherex/...fits' from IRSA's CAOM tables."""
    dids = list(dict.fromkeys(dids))
    out = {}
    for i in range(0, len(dids), batch):
        chunk = ",".join("'" + d.replace("'", "") + "'" for d in dids[i:i + batch])
        rows = tap("SELECT p.obs_publisher_did, a.uri FROM spherex.plane p JOIN spherex.artifact a "
                   f"ON a.planeid=p.planeid WHERE p.obs_publisher_did IN ({chunk}) AND a.producttype='science'")
        out.update({r["obs_publisher_did"]: r["uri"] for r in rows})
    return out


def s3_url(uri):
    return S3_BASE + uri.replace("ibe/data/spherex/", "", 1)


def visits_of(mjds):
    """Visit number (0, 1, 2...) for each sorted MJD; a gap over 20 days starts a new visit."""
    out, v, prev = [], 0, None
    for m in mjds:
        if prev is not None and m - prev > VISIT_GAP_DAYS:
            v += 1
        out.append(v)
        prev = m
    return out


def survey_of(mjd):
    return int((mjd - SURVEY_START_MJD) // SURVEY_DAYS) + 1
