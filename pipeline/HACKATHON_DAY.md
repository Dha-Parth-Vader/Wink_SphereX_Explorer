# Build day: the 4-way split

We split the 100 targets four ways so nobody downloads for more than about an hour and a half. The lists are
balanced by measured download time from our earlier run (about 5.4 hours if one machine does all 100) and by
type. A challenge target leads each list, so all five are ready in the first 10 to 15 minutes. Barnard's Star
and R Dra share Sky's list because Sky's other targets are lighter.

| Person | Branch | Targets | Brown dwarfs / variables / stars | Download (s3, 16 threads) | Steps 3-7 (3 in parallel) |
|---|---|---|---|---|---|
| A Sky | data/sky | 25 | 5 / 11 / 9 | ~81 min | ~45 to 75 min |
| B Pipe | data/pipe | 25 | 4 / 8 / 13 | ~80 min | ~45 to 75 min |
| C Screen | data/screen | 25 | 7 / 9 / 9 | ~80 min | ~45 to 75 min |
| D Lens | data/lens | 25 | 6 / 9 / 10 | ~80 min | ~45 to 75 min |

Estimates come from a cloud run (IRSA lookup plus S3 reads at about 4 images/s). Home Wi-Fi can be 2 to 3
times slower and Colab a bit faster. Steps 3 to 7 are mostly SkyBoT asteroid lookups (2 to 3 minutes per
target). With `--cap 6` downloads take about a third as long, but Sky Dome spectra get fewer bands.

## The lists

Challenge targets are marked *.

| # | A Sky | B Pipe | C Screen | D Lens |
|---|---|---|---|---|
| 1 | barnard * | epsindib * | wise0855 * | rwaur * |
| 2 | rdra * | gaia58739840 | gaia27143808 | kapteynsstar |
| 3 | w1405 | w1828 | rcrb | gaia73009792 |
| 4 | w0359 | luhman16 | groombridge1830 | gaia12759552 |
| 5 | gaia60306560 | gaia37310080 | w0410 | svir |
| 6 | gaia16413696 | teegardensstar | gaia92046592 | rcas |
| 7 | 2m0415 | groombridge34 | rboo | w1541 |
| 8 | gv3068984832 | gaia96586112 | gaia76250624 | w1738 |
| 9 | 61cygni | rtri | tcep | drtau |
| 10 | gaia68019072 | gaia63905536 | w1217 | w0458 |
| 11 | v1057cyg | deltacep | vanmaanensstar | rhya |
| 12 | fuori | gv3330179456 | gv9413825536 | gaia84811520 |
| 13 | gaia14712448 | gaia31605760 | chicyg | lp944 |
| 14 | raql | gaia17922304 | gaia12503424 | v1647ori |
| 15 | gl570d | lacaille9352 | denis0255 | uori |
| 16 | omicron2eridani4 | gaia41041536 | proximacentauri | gaia72576384 |
| 17 | gaia37068160 | gv6809283840 | rytau | exlup |
| 18 | gv3589489536 | etaaql | w1639 | 2m0036 |
| 19 | gv0945707776 | ttau | aatau | gaia72813568 |
| 20 | gv6977267328 | gliese440whitedw | gv7771922560 | cd3715492 |
| 21 | gv5907958144 | gaia02602752 | gv9231713408 | lacaille8760axmi |
| 22 | lalande21185 | gv2917288448 | w2056 | mira |
| 23 | w0647 | 2m0729 | 2m0939 | gaia28596096 |
| 24 | ruma | rleo | wolf359 | gaia96316416 |
| 25 | gv7798780288 | luytensstar | gaia79892096 | ugps0722 |

Copy-paste lines (no spaces, lowercase):

A Sky

```
--only barnard,rdra,w1405,w0359,gaia60306560,gaia16413696,2m0415,gv3068984832,61cygni,gaia68019072,v1057cyg,fuori,gaia14712448,raql,gl570d,omicron2eridani4,gaia37068160,gv3589489536,gv0945707776,gv6977267328,gv5907958144,lalande21185,w0647,ruma,gv7798780288
```

B Pipe

```
--only epsindib,gaia58739840,w1828,luhman16,gaia37310080,teegardensstar,groombridge34,gaia96586112,rtri,gaia63905536,deltacep,gv3330179456,gaia31605760,gaia17922304,lacaille9352,gaia41041536,gv6809283840,etaaql,ttau,gliese440whitedw,gaia02602752,gv2917288448,2m0729,rleo,luytensstar
```

C Screen

```
--only wise0855,gaia27143808,rcrb,groombridge1830,w0410,gaia92046592,rboo,gaia76250624,tcep,w1217,vanmaanensstar,gv9413825536,chicyg,gaia12503424,denis0255,proximacentauri,rytau,w1639,aatau,gv7771922560,gv9231713408,w2056,2m0939,wolf359,gaia79892096
```

D Lens

```
--only rwaur,kapteynsstar,gaia73009792,gaia12759552,svir,rcas,w1541,w1738,drtau,w0458,rhya,gaia84811520,lp944,v1647ori,uori,gaia72576384,exlup,2m0036,gaia72813568,cd3715492,lacaille8760axmi,mira,gaia28596096,gaia96316416,ugps0722
```

## Steps for each person

1. Pull main. Pipe's M1 commit has to be there (step2_download.py with `--only`).
2. Refresh your inventory if it's missing or more than 7 days old:
   `python pipeline/step1_inventory.py --only <your ids>`
3. Start the download in the background and go back to your own lane:
   `python pipeline/step2_download.py --only <your ids> --source s3 --workers 16 --cap 20 --fov 0.25`
   Log to `pipeline/out/logs/download_<you>.log`. Re-run the same command after any interruption; it skips
   finished files.
4. When Lens's steps 5 to 7 are on main, pull and run
   `python pipeline/run_all.py --only <your ids> --parallel 3 --site public/data`.
   It must not touch patches.json, gallery.json or dome/poi.json.
5. Commit only your own target files on `data/<you>`: `public/data/frames/<ids>/`, `public/data/<ids>.json`,
   `public/data/dome/cubes/<ids>/`, `pipeline/out/web/results/<ids>.json` and
   `pipeline/out/{clean,compare,identify,stack}/<ids>.*`. Never `pipeline/cache/` or FITS.
6. Tell Pipe in the team chat: "<name> done: 25/25, N warnings", with the branch name.
7. If someone's machine dies, anyone can re-run their list with the same commands.

Each person needs about 3.5 GB free for the FITS cache (about 140 MB per target). Delete it after step 4.
Colab is faster for downloads but disconnects after about 90 idle minutes; the scripts are restartable.

Only `merge_lists.py` writes the shared lists, on main, after all four branches are merged, so the four data
branches never conflict.
