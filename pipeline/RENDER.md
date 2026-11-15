# Hosting the live server on Render

Vercel serves the static site and the 100 pre-built targets. It can't run Python, so any other spot goes to
`pipeline/server.py` on Render's free plan. `render.yaml` at the repo root describes the service.

## First deploy

1. Go to render.com, click Get Started and sign in with GitHub.
2. Click New +, then Blueprint.
3. Connect the repo (Dha-Parth-Vader/Wink_SphereX_Explorer) and click Apply. Render reads `render.yaml`.
4. The first build takes 3 to 6 minutes (it installs numpy, scipy and astropy).
5. Open https://wink-spherex-explorer-live.onrender.com/api/health. It should answer
   `{"ok": true, "jobs_running": 0, "queued": 0, "version": "1"}`.

The service name sets the URL. If Render adds a suffix because the name is taken, put the real URL in
`project.config.json`, `LIVE_SERVER` in `public/js/data-source.js` and the Vercel origin in `ALLOWED_ORIGINS`
in `render.yaml`, and commit all three together.

## Settings live in render.yaml

- Change settings in `render.yaml`, not the dashboard. Every Blueprint sync overwrites dashboard edits.
- `branch: main` must be the branch we deploy. Every push to main redeploys.
- `ALLOWED_ORIGINS` lists the sites that may call the server, comma-separated: exact origins such as
  `https://wink-spherex-explorer.vercel.app`, or a wildcard written `*.vercel.app` without `https://`.
  Vercel preview URLs are refused unless listed. Other sites get HTTP 403.
- `LIVE_MAX_JOBS 1`: the free plan has 512 MB of RAM, and one job peaks at about 180 MB. A second search
  waits and the viewer says "Waiting for another search on this server to finish". A job that runs past
  6 minutes is stopped so it can't hold the slot.
- `--max 30` images per spot and `--live-max-mb 200` for the cache. `SPHEREX_LIVE_CACHE` is `/tmp/spherex-live`.

## What the free plan does

- It sleeps after about 15 minutes with no requests. The next request wakes it in up to a minute; the viewer
  shows "Waking up the live SPHEREx server…" while that happens.
- A new spot then takes 1 to 4 minutes. Locally we measured about 2 minutes for a 5' or 10' field
  (find, download and clean 30 to 36 images, stack, export). A spot that's been searched before answers in
  under a second.
- The disk is wiped on every restart and redeploy, so the cache starts empty after each push. Warm the demo
  spots again after deploying.
- 750 free instance hours a month, enough for one service running all month. Don't add a keep-awake pinger;
  it burns those hours.

## Checking it

```
curl https://wink-spherex-explorer-live.onrender.com/api/health
curl -H "Origin: https://wink-spherex-explorer.vercel.app" "https://wink-spherex-explorer-live.onrender.com/api/patch?ra=10.6847&dec=41.2690&fov=0.1667"
```

The second command returns HTTP 202 with progress while the job runs (`step`, `steps`, `message`, `done`,
`total`, `elapsed_s`); repeat it until it returns 200. `curl -H "Origin: https://evil.example" ...` should
get HTTP 403.

## Running it locally

```
python pipeline/server.py --port 8000
```

Then open http://localhost:8000/search.html. Locally the site uses the same server for live search, the cache
goes to `public/data/live/` (gitignored) and up to 36 images are used per spot.
