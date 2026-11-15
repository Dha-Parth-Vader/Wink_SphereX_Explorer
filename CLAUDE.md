# Wink: Project Brief (CLAUDE.md)

## What we're building
Wink is a public web tool for NASA Space Apps 2026, challenge "Planet X & SPHEREx". A user enters a sky
position (RA, Dec), and Wink shows a series of real SPHEREx images of that patch like a little video
("blinking"), so anyone can spot things that move or change brightness. It must be tested on 5 targets:
Barnard's Star, Epsilon Indi B, WISE 0855-0714 (RA 08h55m10.831s, Dec -07d14m42.53s), RW Aurigae, R Draconis.
Audience: amateurs. Plain language everywhere. No login.

## Project settings (fill in during Step 0; never hard-code anything else)
{REPO_NAME}      = name of the GitHub repo (from `git remote get-url origin`, else the folder name)
{GITHUB_OWNER}   = GitHub user or org that owns it (from the git remote)
{FRONTEND_URL}   = the Vercel site, e.g. https://{REPO_NAME}.vercel.app (exact URL once Vercel assigns it)
{RENDER_SERVICE} = Render service name in render.yaml (default: {REPO_NAME}-live, lowercase, hyphens)
{RENDER_URL}     = https://{RENDER_SERVICE}.onrender.com (Render may add a suffix if the name is taken)

Keep the current values in project.config.json at the repo root. data-source.js reads LIVE_SERVER from
{RENDER_URL}, and render.yaml's ALLOWED_ORIGINS from {FRONTEND_URL}. When a value changes, update all three
places at the same time (the person commits them together). Values still unknown stay as the literal
placeholder plus a TODO, never a guess.
(Reference: the original build used Dodgertrash17/NasaTesting, nasatesting.vercel.app and
skyblink-spherex-live.onrender.com. Those belong to the old project; don't use them.)

## Architecture (do not change without asking)
- public/      static site, plain HTML/CSS/JS, no build step. Hosted on Vercel (Root Directory = public).
  Pages: index (Home), learn (Education), search (Raw search / Gallery / Filtered search tabs), viewer,
  dome (360° Sky Dome), about (team + credits). Nav: Home · Education · Search Tool · Sky Dome · About.
- public/js/data-source.js is the ONLY module that fetches patch data (pre-built files first, then live API).
- public/data/ pre-built data for 100 targets (PNG + JSON, ~80 MB). Contract in public/data/README.md.
- public/data/live/ live-search cache. Gitignored. Never committed, never deployed.
- pipeline/    Python 3.12: irsa.py, step1_select_targets.py, step1_inventory.py, step2_download.py,
  step3_clean.py, step4_align_stack.py, step5_compare.py, step6_identify.py, step7_export.py,
  merge_lists.py, run_all.py, server.py, requirements.txt (numpy scipy astropy fsspec aiohttp requests
  pillow).
- pipeline/out/targets.json and pipeline/out/inventory/*.csv are committed (slow to make, public lists).
- pipeline/cache/ holds FITS cutouts (~140 MB per target). Gitignored.
- render.yaml runs pipeline/server.py on Render's free plan for live search. Vercel cannot run Python
  (time limit, bundle size, no lasting disk), so the site calls Render for any spot not pre-built.
- .gitignore: pipeline/cache/ __pycache__/ *.pyc public/data/live/ *.fits .env

## Data sources
- SPHEREx image list: IRSA TAP https://irsa.ipac.caltech.edu/TAP/sync, table spherex.obscore:
  SELECT obs_id, obs_collection, t_min, t_max, energy_bandpassname, em_min, em_max, access_url, s_region
  WHERE CONTAINS(POINT('ICRS',ra,dec), s_region)=1. Detector = int from "SPHEREx-D". em_* in metres.
  Query all releases and record obs_collection. ALWAYS ask the archive what exists now (releases change:
  IRSA replaced the quick-release images with Data Release 1 mid-project and old file paths broke).
- File paths: IRSA CAOM tables (batch 300 ids per query) give the ibe/data/spherex/... path.
- Pixels (fast path): public AWS bucket https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/ + path minus
  "ibe/data/spherex/". astropy.io.fits.open(url, use_fsspec=True, fsspec_kwargs={"block_size":262144});
  read .section[y0:y1,x0:x1] of IMAGE, FLAGS, VARIANCE, ZODI; copy WCS-WAVE; shift CRPIX1/2 (+A/W variants).
  Skip the PSF extension. No credentials. ~4x faster and 13x less data than IRSA cutouts, identical pixels.
- Fallback pixels: IRSA IBE cutouts ?center=&size= (slow, includes a 5 MB PSF; retry on "Server busy").
- Catalogues: Gaia DR3 (gaia_dr3_source, epoch 2016.0) and CatWISE2020 (epoch 2015.4) via IRSA TAP.
  Do NOT depend on CDS (SIMBAD/VizieR returned "page unavailable" for hours). Async TAP for full-sky scans.
- Asteroids: IMCCE SkyBoT conesearch https://ssp.imcce.fr/webservices/skybot/api/conesearch.php; cache
  answers.
- Our access follows the IRSA SPHEREx tutorial notebooks (caltech-ipac.github.io/irsa-tutorials). Cite them.

## Science rules
R1  Propagate every position with proper motion to the epoch of use (targets to 2026.0, frames to their MJD).
    Never centre a mover on J2000 (Barnard's Star is 4.6' from its J2000 position).
R2  Group images into visits by gaps > 20 days. Survey number = floor((MJD - 60796)/182.6) + 1.
R3  Download cutout side = 1.5 x FOV. The detector is rotated differently on every visit; a cutout the
    size of the FOV comes back as a tilted square with black corners after reprojection ("rotated images").
R4  Cap 20 images per (visit, detector), spread evenly in wavelength. 6 is enough for blink-only.
R5  Clean: subtract ZODI (tolerate a missing ZODI layer), then build masks from FLAGS bits:
    TRANSIENT 0, OVERFLOW 1, SUR_ERROR 2, PHANTOM 4, REFERENCE 5, NONFUNC 6, DICHROIC 7, MISSING_DATA 9,
    HOT 10, COLD 11, FULLSAMPLE 12, PHANMISS 14, NONLINEAR 15, PERSIST 17, OUTLIER 19, CROSSTALK 20,
    SOURCE 21, GHOST 22, GHOST_FPA 23, GHOST_EXT 24, STREAK 25, BLOOM 26, SNOWBALL 27, HALO 28,
    SATELLITE_HALO 29.
R6  SCIENCE mask (photometry) = IRSA mosaic recipe: TRANSIENT SUR_ERROR NONFUNC DICHROIC MISSING_DATA HOT
    COLD PHANMISS NONLINEAR PERSIST CROSSTALK GHOST GHOST_FPA GHOST_EXT STREAK BLOOM SNOWBALL HALO
    SATELLITE_HALO. Never mask SOURCE, OVERFLOW or OUTLIER (that hides real stars).
R7  DISPLAY mask (pictures) = only NONFUNC DICHROIC MISSING_DATA HOT COLD PHANMISS. Mark saturation
    (NONLINEAR, BLOOM, early TRANSIENT/OVERFLOW with SUR_ERROR) separately and label it "saturated".
R8  Sky level = sigma-clipped median with MAD noise that never returns NaN or an empty sample (some early
    files flag every pixel SOURCE; some frames are almost fully masked).
R9  Per-frame wavelength at the target from WCS-WAVE. Photometry in microJy:
    pixel solid angle = (6.15/206264.806)^2 sr; flux = MJy/sr x sr x 1e12.
R10 Grid: TAN projection on the target's 2026.0 position, 6.15"/px, north up, east left, FOV x FOV.
    Arrays are FITS order (row 0 = south); flip exactly once, at export. Check north against Gaia.
R11 Stack per (visit, detector) with a 3-sigma-clipped mean; need >= 3 frames per detector, >= 12 per visit.
    Band "all" = mean of available detector stacks, kept only where >= half the detectors cover the pixel.
R12 Blank stacked pixels whose frame count < 0.4 x the best-covered pixel (else grainy edge wedges).
    Subtract smooth large-scale background (switchable off for nebulae).
R13 Never blink single exposures by default. Each exposure sees a star at a different wavelength, so a
    steep spectrum looks "variable". Blink detector stacks and compare the same detector across visits.
R14 Movers: sources > 5 sigma per visit stack (band "all" plus a "cold" D5+D6 stack for Y dwarfs), linked
    within 2.5 px between visits, straight-line fit, report if > 1.5"/yr. Prefer later visits as reference
    when the first (May 2025) visit is noisy or striped.
R15 Variability: compare only frames within 1% in wavelength; call a change if > 20% and > 5 sigma in at
    least 2 detectors. Saturated targets are at most "possible change".
R16 Identify: catalogue cone radius = base + |pm| x (2026 - catalogue epoch). Confirm only if a catalogue
    source is on the track AND its proper motion agrees. Cross-check CatWISE motion with Gaia (CatWISE is
    wrong for Luhman 16; its patch was centred 50" off until re-centred from Gaia).
R17 Asteroids: SkyBoT per frame time; only V <= 20.5; match within 12" + min(ephemeris error, 30").
    Save predicted tracks for overlays. Leftover one-frame detections are "unidentified" (mostly cosmic
    rays).

## Display rules
R18 8-bit asinh stretch: black = sky median, knee = 4 x MAD noise, top = max(99.95th pct, sky + 200 x noise).
    Compute ONCE per detector over all visits so blinking compares like with like. (Putting plain sky noise
    at mid-grey is what made frames look "static-y".)
R19 Fill interior NaN holes (saturated cores) by iterative 3x3 grey dilation; leave edge-touching NaN black.
R20 Frames swap instantly (no fade). Max 3 swaps/s, enforced in code. Never autoplay; Play doubles as Pause.
R21 Modes: Each date / Add all dates / Subtract (minus first, minus previous, minus all-dates stack).
    Detector picker: all, 1..6.
R22 FOV choices 5', 10', 15', 30', 1° (default 10' for live, 15' for fast movers). 2' fields are only
    ~20 px across and look like noise from date to date: never download less than 5'; offer 2' only as a
    client-side zoom of a bigger patch. Say "bigger = slower". Warn when data covers less than asked.
R23 Overlays: Gaia DR3 (diamond), CatWISE2020 (square), expected target position per date (dashed circle),
    contamination flags in red with per-bit counts, warning when the measured spot is flagged.
R24 Brightness-over-time chart for the target (tracking its motion) or any clicked pixel, with table view;
    flagged points distinct. Real microJy per detector (not 8-bit display values); relative for "all".
R25 URL holds everything: ra, dec (degrees or sexagesimal), fov, name, det, mode, ref, flags, gaia, wise,
    track, embed, source, layers, api. &embed=1 hides chrome. "Copy link" and "Copy embed code" buttons.
R26 Accessibility: keyboard (Space play/pause, arrows change date, Enter measure), canvas aria-label,
    works at phone width, no horizontal scroll.
R27 Label simulated data with a badge. Label pipeline predictions "AI · prototype" and say "your blink is
    the final check". Caption dates that cover only part of the field ("this date covers 56% of the field").
    Scattered-light glow (faint diagonal bands) is real SPHEREx light, not our bug: say so in a tooltip.
R28 Only data-source.js fetches. getPatch({ra,dec,fov,det,layers,onStage}) -> patch + decoded images, or
    {status:"no-coverage", nearest}; throws DataError on network failure (viewer shows Retry).
    Set img.crossOrigin="anonymous" for images from another origin.

## Live server and hosting rules
R29 GET /api/patch?ra&dec&fov[&det][&layers][&max]. Order: pre-built patch covering the spot -> cached live
    patch -> start background job and return 202 {status:"working", step, steps:4, message, done, total,
    elapsed_s, queued}. Same URL returns 200 with the patch when done; 404 {status:"no-coverage", nearest}.
R30 Job = find (TAP) -> download+clean -> stack -> export. Up to --max images (36 local, 30 Render), spread
    over every (visit, detector), wavelength-spread within each. Catalogue lookups run in parallel with the
    downloads. Live patches skip movers/asteroids (too slow for a click).
R31 PICK BY COVERAGE: compute each image's coverage of the requested square from its s_region footprint
    (project polygon and a 9x9 grid of test points onto the field's tangent plane; point-in-polygon).
    Within each (visit, detector) keep images with cover >= min(0.98, 0.9 x best); fall back to the best.
    Store per-frame "coverage" in the JSON. (Mixing centred and edge-of-detector exposures caused black
    wedges and different stars per date, which looked like "displaced" frames. Frames were aligned to 0.1
    px.)
R32 layers: missing param = gaia,wise. "layers=" (empty) or "layers=none" = SPHEREx only. Parse with
    parse_qs(..., keep_blank_values=True). The browser sends layers=none when nothing is ticked. Cached
    patches requested with fewer layers drop the others. New features (Mark this, report, WiseView) use
    only the layers the user loaded.
R33 Cache key = md5("ra:.3f,dec:.3f,fov,PIPELINE_VERSION"). Bump PIPELINE_VERSION whenever processing
    changes so old cached results are never served after a fix. Delete raw/clean files after export.
    Touch on every view; evict least recently viewed above --live-max-mb (500 local, 200 on Render).
R34 One job at a time on Render (LIVE_MAX_JOBS=1, 512 MB RAM, ~180 MB peak). Others get "queued" with
    "Waiting for another search on this server to finish". Each job has a hard timeout (6 min) so a hung
    job cannot hold the slot forever.
R35 Viewer polls every 1.5 s and shows "Step N of 4 · message (done of total)", a bar and elapsed time.
    No answer within 2.5 s on the first request: show "Waking up the live SPHEREx server…" (free Render
    sleeps after ~15 idle min; waking takes up to ~1 min; a new spot then takes ~1–4 min).
R36 Search page checkboxes: SPHEREx (always on), Gaia DR3, WISE (CatWISE). All ticked by default.
    Remembered in localStorage (wrapped in try/catch). Passed as layers.
R37 CORS: ALLOWED_ORIGINS env, exact origins comma-separated ({FRONTEND_URL}). Wildcards are
    written "*.vercel.app" without https://. Handle OPTIONS. Quiet logs for polling. Vercel preview URLs are
    blocked unless listed.
R38 render.yaml: free web service, branch main (must match the branch you deploy; a Blueprint sync
    overwrites dashboard edits), build "pip install -r pipeline/requirements.txt", start
    "python pipeline/server.py --site public --max 30 --live-max-mb 200", healthCheckPath /api/health ->
    {"ok":true,"jobs_running":n}. Env: PYTHON_VERSION 3.12.8, ALLOWED_ORIGINS, LIVE_MAX_JOBS 1,
    LIVE_THREADS 8, SPHEREX_LIVE_CACHE /tmp/spherex-live. The service name sets the URL
    ({RENDER_URL} from {RENDER_SERVICE}); data-source.js LIVE_SERVER must match it. Same-origin API when
    the site is served by server.py locally.
R39 A static-only deploy must say "this spot needs the live server" instead of failing silently.

## Credits and resources (from the challenge Resources tab)
R40 About page credits: SPHEREx (NASA/JPL-Caltech) via IRSA + IRSA acknowledgement sentence; CatWISE2020
    (Marocco et al. 2021); Gaia DR3 with ESA's exact wording ("This work has made use of data from the
    European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium
    (DPAC)... Gaia Multilateral Agreement"); SkyBoT (IMCCE; Berthier et al. 2006); WiseView (Caselden et
    al. 2018); IRSA tutorial notebooks; and the NASA line: "NASA does not endorse any non-U.S. Government
    entity and is not responsible for information contained on non-U.S. Government websites."
R41 Viewer: "Open in WiseView" link for the same RA/Dec/FOV (WiseView's Gaia layer follows our Gaia tick);
    "Mark this" (click a spot, label it, copy or download a report with position, date, patch link,
    nearby catalogue matches only from loaded layers, and credits for only the sources this view used).

## Process rules
R42 Every pipeline step reads files from the previous one, is rerunnable alone, and accepts --only id1,id2.
    run_all.py skips finished targets, runs N in parallel, supports --only and --force TAG, and is
    restartable (background runs got killed at a 2-hour limit).
R43 Shared lists (patches.json, gallery.json, dome/poi.json, dome/bands.json) are rebuilt by merge_lists.py
    from per-target fragments (pipeline/out/web/results/<id>.json). No step edits a shared list in place.
R44 Validate against physics: measured motions vs Gaia, target within 1/3 px of prediction, brown-dwarf
    spectra showing methane dips. Report "approximate" for saturated targets.
R45 Git: Claude NEVER runs git commit, git push, git merge, git rebase, git tag or anything that creates a
    commit or changes history or the remote. It may run read-only git (status, diff, log, branch, remote,
    fetch). It never adds Co-Authored-By, "Generated with Claude", Claude-Session or any other Claude
    attribution to commit messages, code, comments, docs or PR text. The person commits under their own name.
    End every task with this HAND-OFF block:
      Branch: <current branch> (say so if it looks wrong for this task)
      Changed files: <list>
      Suggested commit message: <one line, plain, no attribution>
      Commands: git add <files>   git commit -m "<message>"   git push origin <branch>
    If the person asks Claude to "just commit it", remind them of this rule once and give the commands.
    Suggested guard in .claude/settings.json: deny "Bash(git commit:*)", "Bash(git push:*)",
    "Bash(git merge:*)", and turn off co-author attribution (includeCoAuthoredBy: false, or the newer
    "attribution" setting, whichever this Claude Code version supports).
R46 If a file is over 25 MB or a tool can't copy it, zip in parts under 25 MB; never commit the zips.
R48 No AI fingerprints in anything shipped (site, repo, code, docs, commits):
    - Never write "Generated with Claude", "Built with Claude/AI", Claude/Anthropic/LLM/assistant mentions,
      or AI-tool names in code, comments, README/docs, HTML <meta> (generator, author), console logs,
      file names, commit messages or the UI. (The viewer's "Mover predictions · AI · prototype" label is
      about OUR detection model, not the coding tool, so it stays.)
    - Comments: only where the code isn't obvious, short, in plain words ("cutout is 1.5x the field so
      rotated frames still fill it"). No comment on every line, no section banners, no "This function…"
      docstrings that restate the name, no "Note:"/"Important:" spam.
    - Docs: short, direct, first-person-plural ("we"), concrete numbers. No emoji in headings or bullets,
      no "Let's dive in", "robust/seamless/leverage/comprehensive", no stacked hedging, no closing summaries
      that repeat the section. Headings in sentence case. Plain Markdown, few bold words.
    - UI copy: the team's voice, short sentences. Keep the few icons from our original design (🔭 🌐 ✦),
      don't add new emoji decoration.
    - Code style: consistent with what's already in the file; no unused helpers, no over-generic
      abstractions, no placeholder "TODO: implement" stubs left behind.
    - Before every hand-off, grep the changed files for: claude, anthropic, "generated with", "as an ai",
      co-authored-by, llm, chatgpt, copilot; remove any hits (except the submission disclosure below).
    - The ONLY place AI use is mentioned is one low-key line in the hackathon submission text (docs/DEMO.md
      "Submission" section), e.g. "We used AI coding assistants to help write and debug parts of the code;
      the design, data choices and testing are our own." Never on the site or in the README.
R47 Test in a real headless browser (Playwright/Chromium) with zero console errors before saying "done".
    Open the site over http (python -m http.server or server.py), never file://.
