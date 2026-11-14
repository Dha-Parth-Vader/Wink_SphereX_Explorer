# Data contract

Everything the site reads lives here. The pipeline (step 7 and merge_lists.py) and the live server both
write this shape, so the viewer doesn't care where a patch came from. Only `public/js/data-source.js`
fetches these files.

Positions are degrees (ICRS) at epoch 2026.0 unless a field says otherwise. Pixels are 6.15" on a TAN grid,
north up, east left. PNG rows are top = north (flipped once, at export).

## patches.json

One entry per pre-built patch. The viewer opens the nearest patch whose `fov_deg` covers the requested spot,
then crops to the requested field.

```
[{ "id": "barnard", "title": "Barnard's Star", "ra": 269.446268, "dec": 4.768204, "fov_deg": 0.25,
   "simulated": false }]
```

## <id>.json

```
{
  "patch": { "id", "name", "kind", "width_px", "height_px", "ra", "dec", "epoch", "fov_deg",
             "pixel_scale_arcsec": 6.15, "simulated"?, "pipeline_version" },
  "frames": [{ "file", "flags_file", "mjd", "date", "visit", "band",
               "detector": "all" | 1..6, "wavelength_um": [lo, hi], "n_exposures",
               "coverage": 0..1, "saturated", "stretch": { "black", "knee", "top" },
               "flags": ["plain-language notes"], "flag_bits": { "NAME": count } }],
  "light_curve": [{ "mjd", "flux_ujy", "err", "detector", "wavelength_um", "flagged", "approximate" }],
  "spectrum"?: [{ "wavelength_um", "flux_ujy", "err", "visit", "saturated" }],
  "overlays": { "gaia": [{ "ra", "dec", "label", "epoch", "pmra", "pmdec", "mag" }], "wise": [...] },
  "predictions": [{ "id", "label", "kind": "mover" | "variable" | "asteroid" | "unidentified",
                    "confidence", "pm_arcsec_yr"?, "match"?, "track": [{ "epoch": frameIndex, "x", "y" }] }],
  "verdicts": { "motion", "variability", "notes" }
}
```

- `frames` are oldest first and all on the same grid.
- `stretch` is computed once per detector across all visits (R18), so every date of one detector matches.
- `flux_ujy` is real microJy per detector; for detector "all" it is relative.
- `overlays` only holds the layers that were loaded (R32). A missing layer means "not requested",
  an empty list means "requested, nothing found".
- `track` x/y are pixels in the PNG (x right, y down).

## Frames

```
frames/<id>/vNN_<all|1..6>.png         8-bit greyscale, one per visit and detector
frames/<id>/vNN_<all|1..6>_flags.png   255 = flagged by the display mask, 0 = clean
```

`NN` is the visit number, two digits, from 00.

## gallery.json

```
[{ "id", "name", "type": "brown-dwarf" | "star" | "variable" | "nebula" | "asteroid",
   "ra", "dec", "fov", "thumb", "status", "blurb" }]
```

## Sky Dome

```
dome/bands.json   102 x { "index", "detector", "channel": 0-16, "center_um", "width_um", "resolving_power" }
dome/poi.json     { "categories": { id: { "label", "color", "shape" } },
                    "pois": [{ "id", "name", "category", "type", "ra", "dec", "size", "blurb", "patch",
                               "spectrum": [102 values, max = 1, gaps interpolated], "bands_measured",
                               "simulated"?, "epochs": [{ "mjd", "cube", "brightness" }] }] }
dome/cubes/<id>/eNN.png   17 x 6 grid of 32 px tiles, one per band;
                          tile for (channel, detector) at x = channel * 32, y = (detector - 1) * 32
```

## Per-target fragments and the merge

Step 7 never edits a shared list. For each target it writes
`pipeline/out/web/results/<id>.json`:

```
{ "patch_entry": {...patches.json entry}, "gallery_entry": {...}, "poi_entry": {...} }
```

`pipeline/merge_lists.py` rebuilds `patches.json`, `gallery.json`, `dome/poi.json` and `dome/bands.json`
from every fragment present plus the hand-made entries in `extra/*.json` (same fragment shape; this is
where the simulated sample patch and the simulated dome objects live, with `"simulated": true`).
It is deterministic, safe to run again, and never drops a target whose frames exist.

## Live API

The live server (pipeline/server.py, hosted on Render) answers spots that aren't pre-built.

```
GET /api/patch?ra=&dec=&fov=[&det=][&layers=gaia,wise|none][&max=]
  200  <id>.json shape, with file URLs absolute to the server
  202  { "status": "working" | "queued", "step", "steps": 4, "stage", "message",
         "done", "total", "elapsed_s" }
  404  { "status": "no-coverage", "nearest": { "id", "name", "ra", "dec", "sep_deg" } }

GET /api/health
  200  { "ok": true, "jobs_running", "queued", "version" }
```

Poll the same URL every 1.5 s while it returns 202. `layers` missing means `gaia,wise`; `layers=` or
`layers=none` means SPHEREx only.

Live results are cached under `data/live/` on the server. That folder is gitignored and never deployed.
