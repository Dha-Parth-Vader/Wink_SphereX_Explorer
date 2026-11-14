"""Step 1b: list every SPHEREx image covering each target.

Asks IRSA what exists now (all releases), groups the images into visits (gaps > 20 days) and writes
out/inventory/<id>.csv plus out/inventory_summary.json. Lists younger than --max-age-days are kept.

    python pipeline/step1_inventory.py --only barnard,epsindib --workers 6
"""
import argparse
import csv
import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import obscore_for, survey_of, visits_of  # noqa: E402

OUT = os.path.join(HERE, "out")
INV = os.path.join(OUT, "inventory")
FIELDS = ["obs_id", "release", "mjd", "visit", "survey", "detector", "em_min_um", "em_max_um",
          "access_url", "s_region"]


def load_targets(only):
    targets = json.load(open(os.path.join(OUT, "targets.json"), encoding="utf-8"))
    if only:
        keep = only.split(",")
        missing = set(keep) - {t["id"] for t in targets}
        if missing:
            sys.exit("not in targets.json: " + ",".join(sorted(missing)))
        targets = [t for t in targets if t["id"] in keep]
    return targets


def summarise(t, rows):
    per_visit = []
    for v in sorted({int(r["visit"]) for r in rows}):
        sel = [r for r in rows if int(r["visit"]) == v]
        mjds = [float(r["mjd"]) for r in sel]
        per_visit.append(dict(visit=v, survey=int(sel[0]["survey"]), mjd_start=round(min(mjds), 2),
                              mjd_end=round(max(mjds), 2), n=len(sel),
                              per_detector=dict(sorted(Counter(int(r["detector"]) for r in sel).items()))))
    return dict(id=t["id"], name=t["name"], kind=t["kind"], n_images=len(rows), n_visits=len(per_visit),
                per_detector=dict(sorted(Counter(int(r["detector"]) for r in rows).items())),
                releases=dict(Counter(r["release"] for r in rows)), visits=per_visit)


def inventory(t):
    found = obscore_for(t["ra"], t["dec"])
    vis = visits_of([r["t_min"] for r in found])
    rows = [dict(obs_id=r["obs_id"], release=r["obs_collection"], mjd=f"{r['t_min']:.5f}", visit=v,
                 survey=survey_of(r["t_min"]), detector=r["detector"], em_min_um=f"{r['em_min_um']:.4f}",
                 em_max_um=f"{r['em_max_um']:.4f}", access_url=r["access_url"], s_region=r["s_region"])
            for r, v in zip(found, vis)]
    path = os.path.join(INV, t["id"] + ".csv")
    with open(path + ".part", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(path + ".part", path)
    return rows


def read_inventory(tid):
    with open(os.path.join(INV, tid + ".csv"), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--max-age-days", type=float, default=7.0)
    ap.add_argument("--force", action="store_true", help="query again even if the list is fresh")
    a = ap.parse_args()
    targets = load_targets(a.only)
    os.makedirs(INV, exist_ok=True)

    def fresh(t):
        p = os.path.join(INV, t["id"] + ".csv")
        return os.path.exists(p) and time.time() - os.path.getmtime(p) < a.max_age_days * 86400

    todo = [t for t in targets if a.force or not fresh(t)]
    print(f"{len(targets) - len(todo)} lists fresh, {len(todo)} to query", flush=True)
    failed = []
    with ThreadPoolExecutor(a.workers) as ex:
        jobs = {ex.submit(inventory, t): t for t in todo}
        for j in as_completed(jobs):
            t = jobs[j]
            try:
                rows = j.result()
                print(f"{t['id']:18s} {len(rows):5d} images", flush=True)
            except Exception as e:  # noqa: BLE001
                failed.append(t["id"])
                print(f"{t['id']:18s} FAILED: {str(e)[:120]}", flush=True)

    sp = os.path.join(OUT, "inventory_summary.json")
    summary = {s["id"]: s for s in json.load(open(sp, encoding="utf-8"))} if os.path.exists(sp) else {}
    for t in targets:
        if os.path.exists(os.path.join(INV, t["id"] + ".csv")):
            summary[t["id"]] = summarise(t, read_inventory(t["id"]))
    order = [t["id"] for t in json.load(open(os.path.join(OUT, "targets.json"), encoding="utf-8"))]
    out = [summary[i] for i in order if i in summary]
    with open(sp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    if failed:
        sys.exit("could not list: " + ",".join(failed) + " (run the same command again)")


if __name__ == "__main__":
    main()
