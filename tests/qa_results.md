| Section | Check | Result | Detail |
|---|---|---|---|
| science | Barnard's Star motion within 10% of 10.4"/yr | PASS | 11.002"/yr |
| science | Eps Indi B motion 4.4-4.7"/yr | PASS | 4.457"/yr |
| science | WISE 0855 found as a mover | PASS | 8.594"/yr |
| science | WISE 0855 detected in the cold D5+D6 stack | PASS | found in ['cold'] |
| science | WISE 0855 confirmed in CatWISE | PASS | matches ['wise'] |
| science | RW Aur reported as changing | PASS | changing |
| science | epsindib brightness steady | PASS | steady |
| science | wise0855 brightness steady | PASS | steady |
| science | barnard brightness steady | PASS | steady |
| science | R Dra at most 'possible change' | PASS | steady |
| science | barnard within 1/3 px of prediction | PASS | 0.188 px |
| science | epsindib within 1/3 px of prediction | PASS | 0.103 px |
| science | wise0855 within 1/3 px of prediction | FAIL | 0.353 px |
| science | rwaur within 1/3 px of prediction | PASS | 0.192 px |
| science | rdra within 1/3 px of prediction | PASS | 0.067 px |
| images | no black corners except on captioned partial dates (2080 frames) | FAIL | 11 frames, e.g. ['epsindib v00_2.png', 'epsindib v00_3.png', 'epsindib v01_1.png'] |
| images | no static: sky near black, few mid-grey pixels | PASS |  |
| images | no black holes inside bright stars | PASS |  |
| images | same stretch for all dates of one detector | PASS | 100 targets |
| images | edge wedges | SKIP | not measurable from PNGs alone; covered by coverage blanking in step 4 |
| live | /api/health ok | PASS | {"ok": true, "jobs_running": 0, "queued": 0, "version": "1"} |
| live | CORS allowed for our site | PASS | https://wink-spherex-explorer.vercel.app |
| live | CORS refused for https://evil.example | PASS | HTTP 403 |
| live | new spot completes | FAIL | HTTP 500 NASA's SPHEREx archive (IRSA) isn't answering right now, so we can't fetch new images. Try |
| live | progress fields | SKIP | needs a working new-spot search |
| live | second request < 2 s | SKIP | needs a working new-spot search |
| live | layers | SKIP | needs a working new-spot search |
| live | partial-coverage field | SKIP | needs a working new-spot search |
| live | two searches at once | SKIP | needs a working new-spot search |
| ui desktop | index.html no horizontal scroll | PASS | 0px |
| ui desktop | learn.html no horizontal scroll | PASS | 0px |
| ui desktop | search.html no horizontal scroll | PASS | 0px |
| ui desktop | dome.html no horizontal scroll | PASS | 0px |
| ui desktop | about.html no horizontal scroll | PASS | 0px |
| ui desktop | viewer no horizontal scroll | PASS | 0px |
| ui desktop | no autoplay | PASS |  |
| ui desktop | at most 3 swaps/s with &speed=10 in the URL | PASS | 9 swaps in 4 s |
| ui desktop | arrow keys change date | PASS |  |
| ui desktop | Space toggles play | PASS |  |
| ui desktop | canvas has an aria-label | PASS |  |
| ui desktop | URL keeps ra= | PASS |  |
| ui desktop | URL keeps dec= | PASS |  |
| ui desktop | URL keeps fov= | PASS |  |
| ui desktop | WiseView link carries the position | PASS | https://byw.tools/wiseview#ra=269.446268&dec=4.768204&size=900&band=3&speed=164& |
| ui desktop | Mark this report has position, date and link | PASS | Wink find report Made 2026-11-15 17:21 UTC  1. qa test    Po |
| ui desktop | embed mode hides the header | PASS |  |
| ui desktop | credits: ESA/Gaia/DPAC wording | PASS |  |
| ui desktop | credits: NASA non-endorsement line | PASS |  |
| ui desktop | zero console errors | PASS | [] |
| ui phone | index.html no horizontal scroll | PASS | 0px |
| ui phone | learn.html no horizontal scroll | PASS | 0px |
| ui phone | search.html no horizontal scroll | PASS | 0px |
| ui phone | dome.html no horizontal scroll | PASS | 0px |
| ui phone | about.html no horizontal scroll | PASS | 0px |
| ui phone | viewer no horizontal scroll | PASS | 0px |
| ui phone | no autoplay | PASS |  |
| ui phone | zero console errors | PASS | [] |

48 passed, 3 failed, 6 skipped.
