"""Step 1a: choose about 100 targets and check their positions. Only needed if out/targets.json is missing.

  - the 5 challenge targets, checked against Gaia DR3 (WISE 0855 against CatWISE2020)
  - ~40 Gaia DR3 stars moving faster than 1.5"/yr
  - ~20 brown dwarfs: well-known ones confirmed in CatWISE2020 by colour and motion, topped up from a
    CatWISE2020 scan (W1-W2 > 1.8, pm > 0.6"/yr); Luhman 16 is re-centred from Gaia (CatWISE's motion is wrong)
  - ~35 variables: famous Miras, young outbursters, R CrB and Cepheids, plus Gaia DR3 VARIABLE stars with
    a large G-band scatter
Every position is moved to 2026.0 with its proper motion (R1). Uncertain matches are dropped, not guessed.
All queries go to IRSA (no CDS). The full-sky scans use async TAP and can take a while.

    python pipeline/step1_select_targets.py [--force] [--only barnard,mira] [--workers 6]
"""
import argparse
import json
import math
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import tap  # noqa: E402

OUT = os.path.join(HERE, "out")
EPOCH_OUT = 2026.0

# id, name, kind, subtype, approx J2000 RA/Dec
CHALLENGE = [
    ("barnard", "Barnard's Star", "star", "red dwarf, fastest-moving star in the sky", 269.4521, 4.6934),
    ("epsindib", "Epsilon Indi B", "brown-dwarf", "binary brown dwarf (T1+T6) orbiting Eps Indi A", 331.0438, -56.7827),
    ("wise0855", "WISE 0855-0714", "brown-dwarf", "Y dwarf (coldest known brown dwarf)", 133.79513, -7.24515),
    ("rwaur", "RW Aurigae", "variable", "young star (irregular dimming)", 76.9563, 30.4013),
    ("rdra", "R Draconis", "variable", "Mira variable (~245 d period)", 248.1675, 66.7551),
]
FAMOUS_VARIABLES = [
    ("mira", "Mira (o Ceti)", "Mira variable", 34.8366, -2.9775),
    ("chicyg", "Chi Cygni", "Mira variable", 297.6413, 32.9139),
    ("rleo", "R Leonis", "Mira variable", 146.8896, 11.4289),
    ("rcas", "R Cassiopeiae", "Mira variable", 359.6036, 51.3889),
    ("uori", "U Orionis", "Mira variable", 88.9550, 20.1752),
    ("rhya", "R Hydrae", "Mira variable", 202.4283, -23.2813),
    ("tcep", "T Cephei", "Mira variable", 317.3825, 68.4908),
    ("raql", "R Aquilae", "Mira variable", 286.5929, 8.2300),
    ("rtri", "R Trianguli", "Mira variable", 39.2584, 34.2642),
    ("ruma", "R Ursae Majoris", "Mira variable", 161.1604, 68.7758),
    ("rboo", "R Bootis", "Mira variable", 219.2983, 26.7367),
    ("svir", "S Virginis", "Mira variable", 203.2504, -7.1947),
    ("rcrb", "R Coronae Borealis", "R CrB variable", 237.1434, 28.1567),
    ("ttau", "T Tauri", "young star (T Tauri)", 65.4976, 19.5351),
    ("rytau", "RY Tauri", "young star (T Tauri)", 65.4892, 28.4433),
    ("aatau", "AA Tauri", "young star (dipper)", 68.7308, 24.4815),
    ("drtau", "DR Tauri", "young star (T Tauri)", 71.7759, 16.9786),
    ("fuori", "FU Orionis", "young star (FU Ori outburst)", 86.3433, 9.0700),
    ("v1647ori", "V1647 Orionis (McNeil's Nebula)", "young star (outburst)", 86.5547, -0.1014),
    ("v1057cyg", "V1057 Cygni", "young star (FU Ori outburst)", 314.7238, 44.2578),
    ("exlup", "EX Lupi", "young star (EXor outburst)", 240.7729, -40.3069),
    ("deltacep", "Delta Cephei", "Cepheid", 337.2929, 58.4153),
    ("etaaql", "Eta Aquilae", "Cepheid", 298.1183, 1.0056),
]
FAMOUS_BROWN_DWARFS = [
    ("luhman16", "Luhman 16AB", "binary L/T dwarf, nearest brown dwarfs", 162.3290, -53.3194),
    ("w1828", "WISE 1828+2650", "Y dwarf", 277.1300, 26.8437),
    ("w1541", "WISE 1541-2250", "Y dwarf", 235.4642, -22.8408),
    ("w0410", "WISE 0410+1502", "Y dwarf", 62.5963, 15.0446),
    ("w1738", "WISE 1738+2732", "Y dwarf", 264.648, 27.549),
    ("w2056", "WISE 2056+1459", "Y dwarf", 314.12, 14.998),
    ("w1405", "WISE 1405+5534", "Y dwarf", 211.32, 55.57),
    ("w1639", "WISE 1639-6847", "Y dwarf", 249.99, -68.80),
    ("w0359", "WISE 0359-5401", "Y dwarf", 59.91, -54.03),
    ("w0647", "WISE 0647-6232", "Y dwarf", 101.84, -62.54),
    ("ugps0722", "UGPS 0722-0540", "T9 dwarf", 110.6071, -5.6742),
    ("2m0415", "2MASS 0415-0935", "T8 dwarf", 63.8325, -9.5850),
    ("2m0939", "2MASS 0939-2448", "T8 dwarf", 144.90, -24.80),
    ("w0458", "WISE 0458+6434", "T8.5 binary dwarf", 74.72, 64.58),
    ("2m0729", "2MASS 0729-3954", "T8 dwarf", 112.26, -39.90),
    ("w1217", "WISE 1217+1626", "T9 binary dwarf", 184.48, 16.44),
    ("denis0255", "DENIS 0255-4700", "L9 dwarf", 43.77, -47.01),
    ("2m0036", "2MASS 0036+1821", "L3.5 dwarf", 9.07, 18.35),
    ("lp944", "LP 944-20", "M9 / young brown dwarf", 54.90, -35.43),
    ("gl570d", "Gliese 570 D", "T7.5 companion to a K star", 224.31, -21.36),
]
# names for the fastest Gaia stars, matched within 20' of their J2000 position
KNOWN_MOVERS = {
    "Kapteyn's Star": (77.919, -45.018), "Groombridge 1830": (178.245, 37.719),
    "Lacaille 9352": (346.467, -35.853), "CD-37 15492": (1.383, -37.367), "61 Cygni": (316.725, 38.749),
    "Lalande 21185": (165.836, 35.970), "Wolf 359": (164.120, 7.015), "Proxima Centauri": (217.429, -62.680),
    "Van Maanen's Star": (12.291, 5.388), "Luyten's Star": (111.852, 5.226), "Teegarden's Star": (43.254, 16.881),
    "Ross 128": (176.937, 0.804), "Omicron2 Eridani (40 Eri)": (63.818, -7.653),
    "Lacaille 8760 (AX Mic)": (319.313, -38.867), "Groombridge 34": (4.595, 44.023), "Ross 154": (282.456, -23.836),
    "Wolf 1061": (247.575, -12.666), "Gliese 440 (white dwarf)": (176.46, -64.84), "Mu Cassiopeiae": (17.07, 54.92),
}


def num(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def sep_deg(ra1, de1, ra2, de2):
    r = math.radians
    c = math.sin(r(de1)) * math.sin(r(de2)) + math.cos(r(de1)) * math.cos(r(de2)) * math.cos(r(ra1 - ra2))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def propagate(ra, dec, pmra_mas, pmdec_mas, epoch0):
    dt = EPOCH_OUT - epoch0
    return (ra + pmra_mas * dt / 3.6e6 / math.cos(math.radians(dec))) % 360, dec + pmdec_mas * dt / 3.6e6


def gaia_cone(ra, dec, radius_deg):
    return tap("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp FROM gaia_dr3_source "
               f"WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius_deg}))=1")


def catwise_cone(ra, dec, radius_deg):
    return tap("SELECT source_name, ra, dec, pmra, pmdec, w1mpro, w2mpro, meanobsmjd FROM catwise_2020 "
               f"WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius_deg}))=1")


def from_gaia(tid, name, kind, subtype, g):
    ra1, de1 = propagate(num(g["ra"]), num(g["dec"]), num(g["pmra"]), num(g["pmdec"]), 2016.0)
    return dict(id=tid, name=name, kind=kind, subtype=subtype, ra=round(ra1, 6), dec=round(de1, 6), epoch=EPOCH_OUT,
                ra_cat=num(g["ra"]), dec_cat=num(g["dec"]), epoch_cat=2016.0, pmra_mas=round(num(g["pmra"]), 2),
                pmdec_mas=round(num(g["pmdec"]), 2), pm_mas=round(math.hypot(num(g["pmra"]), num(g["pmdec"])), 1),
                parallax_mas=round(num(g["parallax"]), 3), gmag=round(num(g["phot_g_mean_mag"]), 2),
                catalog_id=f"Gaia DR3 {g['source_id']}", position_source="Gaia DR3")


def from_catwise(tid, name, subtype, c):
    pmra, pmdec = num(c["pmra"]) * 1000, num(c["pmdec"]) * 1000   # CatWISE motions are in arcsec/yr
    ep = 2000.0 + (num(c["meanobsmjd"]) - 51544.5) / 365.25
    ra1, de1 = propagate(num(c["ra"]), num(c["dec"]), pmra, pmdec, ep)
    return dict(id=tid, name=name, kind="brown-dwarf", subtype=subtype, ra=round(ra1, 6), dec=round(de1, 6),
                epoch=EPOCH_OUT, ra_cat=num(c["ra"]), dec_cat=num(c["dec"]), epoch_cat=round(ep, 2),
                pmra_mas=round(pmra, 1), pmdec_mas=round(pmdec, 1), pm_mas=round(math.hypot(pmra, pmdec), 1),
                w1=num(c["w1mpro"]), w2=num(c["w2mpro"]), catalog_id="CatWISE " + c["source_name"].strip(),
                position_source="CatWISE2020")


def challenge_target(spec):
    tid, name, kind, sub, ra, dec = spec
    if tid == "wise0855":   # too faint for Gaia: the reddest CatWISE source near the challenge position
        rows = sorted(catwise_cone(ra, dec, 60 / 3600), key=lambda r: num(r["w2mpro"], 99) - num(r["w1mpro"], 99))
        return from_catwise(tid, name, sub, rows[0]) if rows else None
    if tid == "epsindib":   # faint in Gaia: the red, fast source near Eps Indi A
        rows = [r for r in gaia_cone(ra, dec, 3 / 60)
                if math.hypot(num(r["pmra"]), num(r["pmdec"])) > 3000 and (num(r["bp_rp"], 9) > 2.5)]
        g = min(rows, key=lambda r: sep_deg(ra, dec, num(r["ra"]), num(r["dec"]))) if rows else None
    elif kind == "variable":
        rows = [r for r in gaia_cone(ra, dec, 60 / 3600) if r["phot_g_mean_mag"]]
        g = min(rows, key=lambda r: num(r["phot_g_mean_mag"], 99)) if rows else None
    else:   # Barnard's: search 8' (it has moved ~4.6' since J2000) and take the fastest star
        rows = gaia_cone(ra, dec, 8 / 60)
        g = max(rows, key=lambda r: math.hypot(num(r["pmra"]), num(r["pmdec"]))) if rows else None
    return from_gaia(tid, name, kind, sub, g) if g else None


def brown_dwarf(spec):
    tid, name, sub, ra, dec = spec
    if tid == "luhman16":   # CatWISE's motion is wrong for Luhman 16 (its patch ended up 50" off): use Gaia
        rows = [r for r in gaia_cone(ra, dec, 3 / 60) if math.hypot(num(r["pmra"]), num(r["pmdec"])) > 2000]
        g = min(rows, key=lambda r: num(r["phot_g_mean_mag"], 99)) if rows else None
        return from_gaia(tid, name, "brown-dwarf", sub, g) if g else None
    ok = []
    for c in catwise_cone(ra, dec, 2.5 / 60):
        pm = math.hypot(num(c["pmra"]), num(c["pmdec"]))
        w2 = num(c["w2mpro"], 99)
        colour = num(c["w1mpro"], 99) - w2 if c["w1mpro"] else 3.0
        need = 1.5 if sub[0] in "YT" else 0.3
        if pm > 0.2 and colour > need and w2 < 16.5 and sep_deg(ra, dec, num(c["ra"]), num(c["dec"])) < 1.5 / 60:
            ok.append((w2, c))
    if not ok:
        return None
    return from_catwise(tid, name, sub, min(ok, key=lambda x: x[0])[1])


def variable(spec):
    tid, name, sub, ra, dec = spec
    rows = [r for r in gaia_cone(ra, dec, 45 / 3600) if r["phot_g_mean_mag"]]
    if not rows:
        return None
    g = min(rows, key=lambda r: num(r["phot_g_mean_mag"], 99))
    if sep_deg(ra, dec, num(g["ra"]), num(g["dec"])) * 3600 > 30:
        return None
    return from_gaia(tid, name, "variable", sub, g)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="rebuild only these hand-picked ids and keep the rest of targets.json")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--force", action="store_true", help="overwrite an existing targets.json")
    ap.add_argument("--n-movers", type=int, default=40)
    ap.add_argument("--n-bd", type=int, default=22)
    ap.add_argument("--n-gaia-var", type=int, default=12)
    a = ap.parse_args()
    path = os.path.join(OUT, "targets.json")
    existing = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    if existing and not (a.force or a.only):
        sys.exit("out/targets.json exists; use --force to rebuild it or --only to refresh some ids")
    only = set(a.only.split(",")) if a.only else None
    pick = lambda specs: [s for s in specs if not only or s[0] in only]
    log = []

    with ThreadPoolExecutor(a.workers) as ex:
        chal = list(ex.map(challenge_target, pick(CHALLENGE)))
        bds = list(ex.map(brown_dwarf, pick(FAMOUS_BROWN_DWARFS)))
        vars_ = list(ex.map(variable, pick(FAMOUS_VARIABLES)))
    for spec, t in zip(pick(CHALLENGE), chal):
        if t:
            t["challenge"] = True
        else:
            log.append(f"could not confirm challenge target {spec[1]}")
    for kind, specs, found in (("brown dwarf", pick(FAMOUS_BROWN_DWARFS), bds),
                               ("variable", pick(FAMOUS_VARIABLES), vars_)):
        log += [f"dropped {kind} {s[1]}: no confident catalogue match" for s, t in zip(specs, found) if not t]
    new = [t for t in chal + bds + vars_ if t]

    if only:
        by_id = {t["id"]: t for t in existing}
        by_id.update({t["id"]: t for t in new})
        targets = list(by_id.values())
    else:
        targets = list(new)

        def taken(ra, dec, r=3 / 60):
            return any(sep_deg(ra, dec, t["ra"], t["dec"]) < r for t in targets)

        hpm = tap("SELECT source_id, ra, dec, pmra, pmdec, pm, parallax, phot_g_mean_mag, bp_rp FROM gaia_dr3_source "
                  "WHERE pm > 1500 AND phot_g_mean_mag BETWEEN 5 AND 17.5", mode="async")
        n = 0
        for g in sorted(hpm, key=lambda r: -num(r["pm"])):
            if n >= a.n_movers:
                break
            t = from_gaia("", "", "star", "high proper motion star", g)
            if taken(t["ra"], t["dec"]):
                continue
            nm = next((k for k, (r0, d0) in KNOWN_MOVERS.items()
                       if sep_deg(r0, d0, t["ra_cat"], t["dec_cat"]) < 20 / 60), None)
            t["name"] = nm or f"Gaia DR3 {g['source_id']}"
            t["id"] = re.sub(r"[^a-z0-9]", "", (nm or "gaia" + g["source_id"][-8:]).lower())[:16]
            if t["parallax_mas"] > 100:
                t["subtype"] = "nearby star (within 10 parsecs)"
            elif t["parallax_mas"] > 0 and 4.74 * t["pm_mas"] / t["parallax_mas"] > 150:
                t["subtype"] = "halo star (fast, from the Milky Way's old population)"
            targets.append(t)
            n += 1
        log.append(f"fast stars: {n}")

        nbd = sum(t["kind"] == "brown-dwarf" for t in targets)
        if nbd < a.n_bd:
            scan = tap("SELECT source_name, ra, dec, pmra, pmdec, sigpmra, w1mpro, w2mpro, meanobsmjd FROM catwise_2020 "
                       "WHERE w1mpro - w2mpro > 1.8 AND pmra*pmra + pmdec*pmdec > 0.36 AND w2snr > 30", mode="async")
            scan = [c for c in scan if 5 * max(num(c["sigpmra"]), 0.01) < math.hypot(num(c["pmra"]), num(c["pmdec"])) < 10]
            for c in sorted(scan, key=lambda c: -math.hypot(num(c["pmra"]), num(c["pmdec"]))):
                if nbd >= a.n_bd:
                    break
                t = from_catwise("cw" + re.sub(r"[^0-9]", "", c["source_name"])[:12], "CWISE " + c["source_name"].strip(),
                                 "T/Y dwarf", c)
                if taken(t["ra"], t["dec"]):
                    continue
                targets.append(t)
                nbd += 1
        log.append(f"brown dwarfs: {nbd}")

        gv = tap("SELECT TOP 2000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp, "
                 "phot_g_mean_flux_error * SQRT(phot_g_n_obs) / phot_g_mean_flux AS g_scatter FROM gaia_dr3_source "
                 "WHERE phot_variable_flag = 'VARIABLE' AND phot_g_mean_mag BETWEEN 8 AND 14 AND bp_rp > 2.5 "
                 "ORDER BY g_scatter DESC", mode="async")
        n = 0
        for g in gv:
            if n >= a.n_gaia_var:
                break
            t = from_gaia("gv" + g["source_id"][-10:], f"Gaia DR3 {g['source_id']}", "variable",
                          "large-amplitude red variable (Gaia-flagged)", g)
            if taken(t["ra"], t["dec"], 10 / 60):
                continue
            t["gaia_g_scatter"] = round(num(g["g_scatter"]), 3)
            targets.append(t)
            n += 1
        log.append(f"variables: {sum(t['kind'] == 'variable' for t in targets)}")

    os.makedirs(OUT, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(targets, fh, indent=1)
    print("\n".join(log))
    print(f"wrote {len(targets)} targets to out/targets.json")


if __name__ == "__main__":
    main()
