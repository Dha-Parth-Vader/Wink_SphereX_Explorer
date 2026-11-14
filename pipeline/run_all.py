"""Run the pipeline for many targets: steps 2 to 6 per target, N targets at a time, then step 7 for all of
them, then merge_lists.py. Every step skips work that's already done, so after an interruption just run the
same command again.

    python pipeline/run_all.py --only barnard,rdra --parallel 3 --site public/data
    python pipeline/run_all.py --skip 2 --force compare      # data already downloaded, redo step 5 onwards

--skip takes step numbers or names (download, clean, stack, compare, identify, export, merge).
--force TAG redoes one step and everything after it (a TAG of "all" redoes everything).
"""
import argparse
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from stackfile import OUT, PIPE, SITE, load_targets, parse_only

STEPS = [(2, "download", "step2_download.py"), (3, "clean", "step3_clean.py"), (4, "stack", "step4_align_stack.py"),
         (5, "compare", "step5_compare.py"), (6, "identify", "step6_identify.py"), (7, "export", "step7_export.py"),
         (8, "merge", "merge_lists.py")]


def step_numbers(spec):
    names = {name: n for n, name, _ in STEPS}
    out = set()
    for part in (spec or "").split(","):
        part = part.strip().lower()
        if not part:
            continue
        if part == "all":
            out |= {n for n, _, _ in STEPS}
        elif part.isdigit():
            out.add(int(part))
        elif part in names:
            out.add(names[part])
        else:
            sys.exit(f"unknown step '{part}'; use 2-8 or {', '.join(names)}")
    return out


def run_step(script, args, log):
    cmd = [sys.executable, str(PIPE / script)] + args
    log.write(f"\n$ {' '.join(cmd)}\n")
    log.flush()
    return subprocess.run(cmd, cwd=PIPE.parent, stdout=log, stderr=subprocess.STDOUT).returncode


def run_target(target_id, steps, forced, workers, extra, total, counter):
    log_path = OUT / "logs" / f"run_{target_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    with open(log_path, "a", encoding="utf-8") as log:
        for n, name, script in STEPS:
            if n not in steps or n > 6:
                continue
            args = ["--only", target_id] + (["--force"] if n in forced else [])
            if n == 2:
                args += ["--workers", str(workers)] + extra
            if run_step(script, args, log) != 0:
                counter.append(target_id)
                print(f"[{len(counter)}/{total}] {target_id}: step {n} ({name}) failed, see {log_path}", flush=True)
                return False
    counter.append(target_id)
    print(f"[{len(counter)}/{total}] {target_id}: done in {time.time() - start:.0f} s", flush=True)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--only", help="comma-separated target ids (default: all of targets.json)")
    ap.add_argument("--skip", help="steps to leave out, e.g. 2 or download,clean")
    ap.add_argument("--force", metavar="TAG", help="redo this step and the ones after it")
    ap.add_argument("--parallel", type=int, default=3, help="targets at a time for steps 2-6")
    ap.add_argument("--workers", type=int, default=16, help="download threads per target (step 2)")
    ap.add_argument("--site", default=str(SITE))
    ap.add_argument("--fov", help="passed to step 2")
    ap.add_argument("--cap", help="passed to step 2")
    ap.add_argument("--source", help="passed to step 2 (s3 or irsa)")
    args = ap.parse_args(argv)

    ids = parse_only(args.only, [t["id"] for t in load_targets()])
    steps = {n for n, _, _ in STEPS} - step_numbers(args.skip)
    forced = set()
    if args.force:
        first = min(step_numbers(args.force))
        forced = {n for n, _, _ in STEPS if n >= first}
    missing = [script for n, _, script in STEPS if n in steps and not (PIPE / script).exists()]
    if missing:
        sys.exit(f"missing {', '.join(missing)}; add them first or leave those steps out with --skip")
    extra = []
    for flag in ("fov", "cap", "source"):
        if getattr(args, flag):
            extra += [f"--{flag}", getattr(args, flag)]

    print(f"run_all: {len(ids)} target(s), steps {sorted(steps)}, {args.parallel} at a time", flush=True)
    counter, failed = [], []
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
        futures = {pool.submit(run_target, i, steps, forced, args.workers, extra, len(ids), counter): i for i in ids}
        for fut in as_completed(futures):
            if not fut.result():
                failed.append(futures[fut])

    ok = [i for i in ids if i not in failed]
    if 7 in steps and ok:
        cmd = ["--only", ",".join(ok), "--site", args.site, "--workers", str(max(1, args.parallel))]
        if 7 in forced:
            cmd.append("--force")
        print("step 7: exporting", flush=True)
        if subprocess.run([sys.executable, str(PIPE / "step7_export.py")] + cmd, cwd=PIPE.parent).returncode:
            print("step 7 had failures (see above)", flush=True)
    if 8 in steps:
        subprocess.run([sys.executable, str(PIPE / "merge_lists.py"), "--site", args.site], cwd=PIPE.parent)
    if failed:
        print(f"failed: {', '.join(sorted(failed))} (run the same command again to retry)", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
