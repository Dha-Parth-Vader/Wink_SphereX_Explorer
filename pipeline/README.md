# SPHEREx pipeline

Turns real SPHEREx Level 2 images into the files the site in `public/` reads (format: `public/data/README.md`).
Each step reads the previous step's files, can be run again on its own, takes `--only id1,id2`, and skips
work that is already done. Python 3.12, `pip install -r pipeline/requirements.txt`.

## How we get the data

We follow the [IRSA SPHEREx tutorial notebooks](https://caltech-ipac.github.io/irsa-tutorials/) (NASA/IPAC IRSA).
The image list comes from an ADQL query on IRSA's TAP service (`spherex.obscore`). When TAP is down, as it
was for hours on 14 Nov 2026, `irsa.py` asks IRSA's SIA service instead, which returns the same images and
their file paths. Pixels are range-read from NASA's public AWS copy (`nasa-irsa-spherex`, no credentials):
only the cutout's bytes of the IMAGE, FLAGS, VARIANCE and ZODI layers plus WCS-WAVE, never the 5 MB PSF.
That is about 4x faster and 13x less data than IRSA's cutout service, which stays as a fallback
(`--source irsa`). Catalogue checks use Gaia DR3 and CatWISE2020 through IRSA TAP. We don't use CDS.

Every query asks the archive what exists now, so new releases are picked up by re-running step 1.

## Steps

| Step | Script | What it does | Output |
|---|---|---|---|
| 1a | `step1_select_targets.py` | Picks ~100 targets (challenge, fast stars, brown dwarfs, variables), positions at 2026.0. Only if `targets.json` is missing | `out/targets.json` |
| 1b | `step1_inventory.py` | Lists every SPHEREx image covering each target, grouped into visits | `out/inventory/<id>.csv`, `out/inventory_summary.json` |
| 2 | `step2_download.py` | Cutouts 1.5x the field from AWS, at most 20 per (visit, detector) spread in wavelength | `cache/<id>/*.fits`, `out/step2_timing.json` |
| 3 | `step3_clean.py` | ZODI, science and display masks from FLAGS, sky level, wavelength and microJy flux of the target per frame | `cache/<id>/clean/`, `out/clean/<id>.csv` |
| 4 | `step4_align_stack.py` | North-up 6.15" grid, clipped mean per (visit, detector), all-detector and cold (D5+D6) stacks, alignment check | `cache/<id>/stack.fits`, `out/stack/<id>.json` |
| 5-7 | `step5_compare.py`, `step6_identify.py`, `step7_export.py` | Movers and changes, catalogue and asteroid checks, web export | see `public/data/README.md` |

`cache/` is gitignored (about 140 to 300 MB of FITS per target). `out/targets.json` and `out/inventory/` are committed.

## Commands

```
python pipeline/step1_inventory.py --only barnard,epsindib --workers 6
python pipeline/step2_download.py --only barnard --source s3 --workers 16 --cap 20 --fov 0.25
python pipeline/step3_clean.py --only barnard --workers 6
python pipeline/step4_align_stack.py --only barnard --fov 0.25 --workers 2
```

Useful flags: `step1_inventory.py --force` (refresh lists younger than 7 days), `step2_download.py --cap 6`
(blink quality, about 3x faster, fewer spectrum bands), `step3_clean.py --force` and `step4_align_stack.py --force`
(redo after a processing fix), `step4_align_stack.py --no-flatten` (keep large-scale glow, for nebulae).
`SPHEREX_CACHE=/path` moves the FITS cache.

## stack.fits

All cubes are `[visit, band, y, x]` in FITS order (row 0 = south, east left). Band 0 is all detectors,
1 to 6 one detector each, 7 the cold stack (mean of D5 and D6) for Y dwarfs such as WISE 0855.

| Extension | Content |
|---|---|
| STACK | 3-sigma-clipped mean in MJy/sr, background flattened, under-covered pixels NaN |
| DISPLAY | STACK with interior holes (saturated cores) filled; gaps touching the edge stay NaN |
| NFRAMES | frames used per pixel |
| SATFRAC | fraction of frames with saturation flags at the pixel |
| FLAGFRAC | fraction of frames where the science mask drops the pixel |

`out/stack/<id>.json` lists, per visit, the dates, frames and wavelength range per detector, coverage, summed
FLAGS bit counts, and the target's predicted and measured pixel position. `motion` compares the first and last
visit with the catalogue proper motion. Visits with fewer than 12 frames are listed in `visits_skipped`.

## Checks on the challenge targets

Barnard's Star moves 1.65 px north between Aug 2025 and Aug 2026, which is 10.3"/yr against Gaia's 10.4.
Every visit's measured position is within 0.12 px of the prediction.
