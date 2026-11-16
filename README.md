# Wink

Wink lets anyone blink real NASA SPHEREx infrared images of any spot in the sky to find things that move or change brightness. Built for NASA Space Apps 2026, challenge "Planet X & SPHEREx".
The site is static HTML/CSS/JS in `public/` (Vercel), with 100 pre-built targets in `public/data/`; any other spot goes to a small live server on Render.
The Python pipeline in `pipeline/` queries IRSA, reads SPHEREx cutouts from NASA's public AWS copy, cleans, stacks and exports them.
Pipeline steps: [pipeline/README.md](pipeline/README.md). Data format: [public/data/README.md](public/data/README.md).
Hosting the live server: [pipeline/RENDER.md](pipeline/RENDER.md). Team plan for the build day: [pipeline/HACKATHON_DAY.md](pipeline/HACKATHON_DAY.md).
Claude was utilized to write and debug code. However, all creative and problem-related decisions were made by our team (POMegranate Juice).