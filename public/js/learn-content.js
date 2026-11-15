// Education chapters. Each section body is a small list of blocks: p, list, try, links.
window.LEARN_CHAPTERS = [
  {
    id: "basics",
    title: "Basic astronomy",
    intro: "A few ideas you need before blinking: where things are, what infrared light is, and why some stars seem to crawl.",
    sections: [
      {
        id: "coordinates",
        title: "Finding a spot: RA and Dec",
        blocks: [
          { p: "Astronomers pin a position on the sky with two numbers, like longitude and latitude on Earth. Declination (Dec) runs from +90° at the north celestial pole to −90° at the south. Right ascension (RA) goes around the sky." },
          { p: "RA is often written in hours instead of degrees, because the sky turns once a day. 24 hours of RA make the full 360°, so 1 hour = 15°. Wink accepts either: 133.759 (degrees) or 08h55m10.8s (hours) mean the same place." },
          { list: [
            "1 degree = 60 arcminutes (′). The full Moon is about 30′ wide.",
            "1 arcminute = 60 arcseconds (″). One SPHEREx pixel is about 6.2″.",
            "Field of view (FOV) is how big a square of sky you look at. 10′ is a good start.",
          ] },
          { try: "Try it: on the Search page, type 133.759 and −7.243, or tap the WISE 0855 chip." },
        ],
      },
      {
        id: "infrared",
        title: "Infrared: light we can't see",
        blocks: [
          { p: "Our eyes see wavelengths from about 0.4 to 0.7 microns (µm). Infrared starts just past red. SPHEREx sees from 0.75 to 5 µm." },
          { p: "Cool things glow mostly in infrared. A brown dwarf at a few hundred degrees is almost invisible in visible light but shines at 4 to 5 µm. Infrared also slips through dust that blocks visible light, so we can see stars being born inside clouds." },
          { list: [
            "Short infrared (around 1 µm) looks a lot like a very red photo.",
            "Long infrared (4 to 5 µm) shows the coldest objects and warm dust.",
          ] },
        ],
      },
      {
        id: "motion",
        title: "Why some stars move",
        blocks: [
          { p: "Stars all move through the galaxy, but most are so far away that they look frozen. Nearby stars drift across the sky a little each year. That drift is called proper motion and is measured in arcseconds per year (″/yr)." },
          { p: "Barnard's Star is the champion at about 10.4″/yr. SPHEREx pixels are 6.2″ wide, so over one year it shifts by under two pixels. That's small, but blinking makes it pop out." },
          { p: "Nearby stars also wobble back and forth once a year as Earth goes around the Sun. That wobble, parallax, is how we measure their distance." },
          { try: "Look for: a dot that steps the same way every date while its neighbours stay put." },
        ],
      },
      {
        id: "objects",
        title: "What's out there",
        blocks: [
          { list: [
            "Stars: suns like ours, from tiny red dwarfs to giants.",
            "Brown dwarfs: too big to be planets, too small to burn like stars. They cool for ever, and the coldest are colder than ice.",
            "Variable stars: stars that brighten and fade, from pulsing giants to young stars hidden by moving dust.",
            "Asteroids and comets: they move fast enough to jump between frames or appear only once.",
            "Nebulae and galaxies: clouds of gas and dust, and whole other galaxies, that don't move at all on our timescale.",
          ] },
        ],
      },
    ],
  },
  {
    id: "spherex",
    title: "The SPHEREx mission",
    intro: "The space telescope behind every picture on this site.",
    sections: [
      {
        id: "overview",
        title: "Overview",
        blocks: [
          { p: "SPHEREx is a NASA space telescope built and run by JPL and Caltech. It launched on 11 March 2025 on a SpaceX Falcon 9 from Vandenberg in California." },
          { p: "Its full name is the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer. Its main jobs are mapping hundreds of millions of galaxies, studying the first moments after the Big Bang, and finding water and other ices in our galaxy. Along the way it photographs every star, brown dwarf and asteroid in the sky." },
          { p: "The telescope is small, with a 20 cm mirror, but it sees a very wide patch: about 3.5° by 11°." },
          { links: [["NASA's SPHEREx page", "https://science.nasa.gov/mission/spherex/"], ["SPHEREx at Caltech", "https://spherex.caltech.edu/"]] },
        ],
      },
      {
        id: "colours",
        title: "102 colours",
        blocks: [
          { p: "SPHEREx has 6 detectors. Each sits behind a special filter whose colour changes smoothly from one edge to the other, so one picture holds 17 slightly different colours. 6 detectors × 17 = 102 colours from 0.75 to 5 µm." },
          { p: "As the telescope steps across the sky, each star lands on a different part of the filter, so over many pictures every star is measured in every colour. That gives a spectrum: brightness against wavelength." },
          { list: [
            "Detector 1: bands 1–17, 0.75–1.1 µm",
            "Detector 2: bands 18–34, 1.1–1.6 µm",
            "Detector 3: bands 35–51, 1.6–2.4 µm",
            "Detector 4: bands 52–68, 2.4–3.8 µm",
            "Detector 5: bands 69–85, 3.8–4.4 µm",
            "Detector 6: bands 86–102, 4.4–5.0 µm",
          ] },
          { try: "In the Viewer, switch detectors. In the Sky Dome, press ▶ Sweep bands." },
        ],
      },
      {
        id: "survey",
        title: "The survey",
        blocks: [
          { p: "SPHEREx orbits over Earth's poles and photographs the sky in strips, about 600 exposures a day. After six months it has looked in every direction. The plan is four full-sky maps over about two years." },
          { p: "Areas near the poles of Earth's orbit (the ecliptic poles) are seen again and again and become extra deep. That's why R Draconis, close to the north ecliptic pole, has thousands of pictures." },
          { p: "For Wink, one 'date' is a visit: all the pictures of a spot taken within a few days. We stack those pictures together for each detector, which cuts the noise and keeps the colour comparison fair." },
        ],
      },
      {
        id: "data",
        title: "Where the data lives",
        blocks: [
          { p: "SPHEREx images are public. NASA's Infrared Science Archive (IRSA) at Caltech/IPAC hosts them, and there is a copy on Amazon's cloud that anyone can read for free. IRSA has already reprocessed the early images once with better calibration, so we always ask the archive what exists now instead of keeping an old list." },
          { p: "We follow IRSA's SPHEREx tutorial notebooks to find and read the images, and we check star positions against ESA's Gaia and the CatWISE2020 catalogue." },
          { links: [["IRSA SPHEREx", "https://irsa.ipac.caltech.edu/Missions/spherex.html"], ["IRSA tutorial notebooks", "https://caltech-ipac.github.io/irsa-tutorials/"]] },
        ],
      },
    ],
  },
  {
    id: "planetx",
    title: "Planet X history",
    intro: "People have hunted for unseen planets for almost 200 years, and the trick that keeps working is comparing pictures.",
    sections: [
      {
        id: "neptune",
        title: "Neptune: found with maths",
        blocks: [
          { p: "In the early 1800s, Uranus wasn't moving quite where it should. Urbain Le Verrier in France, and John Couch Adams in England, worked out that an unseen planet must be tugging on it. In 1846 Johann Galle pointed a telescope at Le Verrier's spot and found Neptune within an evening." },
        ],
      },
      {
        id: "pluto",
        title: "Pluto: found by blinking",
        blocks: [
          { p: "Percival Lowell was sure another 'Planet X' lay past Neptune. After his death, his observatory in Arizona hired Clyde Tombaugh, a young amateur astronomer from a Kansas farm, to search for it." },
          { p: "Tombaugh photographed the same patches of sky a few nights apart and flipped between the plates in a blink comparator. Stars stayed still; a planet would jump. On 18 February 1930 he spotted a faint dot that had moved between plates taken in January. It was Pluto." },
          { p: "Pluto turned out to be far too small to be Lowell's Planet X, and in 2006 it was renamed a dwarf planet. The blinking method is exactly what Wink does." },
        ],
      },
      {
        id: "planet-nine",
        title: "Planet Nine",
        blocks: [
          { p: "In 2016 Konstantin Batygin and Mike Brown noticed that several distant icy bodies past Neptune have oddly lined-up orbits. One explanation is a planet several times Earth's mass, far beyond Pluto. Nobody has found it yet, and some astronomers think the pattern has other causes." },
          { p: "A planet that far out would be faint and slow, so surveys look for it with long-baseline images and infrared light." },
          { go: ["Try it: hide a planet in real SPHEREx pictures and see whether you could find it →", "simulator.html"] },
        ],
      },
      {
        id: "citizens",
        title: "Citizen scientists",
        blocks: [
          { p: "You don't need to be a professional. In the Backyard Worlds: Planet 9 project, volunteers blink infrared images from NASA's WISE mission in their browser. They have found thousands of brown dwarf candidates, including some of the coldest known." },
          { p: "Wink brings the same idea to SPHEREx's newer, many-coloured pictures. When you find something, use Mark this in the Viewer to save a report and compare it in WiseView." },
          { links: [["Backyard Worlds: Planet 9", "https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9"]] },
        ],
      },
    ],
  },
  {
    id: "methods",
    title: "Data collection methods",
    intro: "How astronomers turn pictures into discoveries.",
    sections: [
      {
        id: "imaging",
        title: "Imaging",
        blocks: [
          { p: "A telescope image is a grid of pixels, each holding how much light arrived from that bit of sky. Before we can compare images we clean them: subtract the faint glow of dust in our solar system, hide bad pixels, and line every picture up on the same grid with north up and east to the left." },
          { p: "Every image also comes with flags that mark trouble: hot pixels, cosmic ray hits, ghosts from bright stars, saturated cores. Wink can show those flags in red." },
        ],
      },
      {
        id: "blinking",
        title: "Blinking and difference images",
        blocks: [
          { p: "Blinking means showing two or more pictures of the same spot one after another. Your eye is very good at noticing the one thing that changes." },
          { p: "A difference image subtracts one date from another. Things that didn't change cancel to grey. A moving star leaves a blue 'was here' spot and a red 'is here' spot next to it. A star that got brighter shows up as one red blob." },
          { list: [
            "Compare the same detector across dates, not single exposures. Each exposure sees a star in a slightly different colour, which can fake a change.",
            "Saturated stars and partial-coverage dates can fool you. Wink labels both.",
          ] },
          { try: "In the Viewer, choose Subtract → minus first to see the blue and red pair." },
        ],
      },
      {
        id: "spectroscopy",
        title: "Spectroscopy",
        blocks: [
          { p: "Splitting light into its colours gives a spectrum. Dips and bumps in a spectrum come from molecules. Brown dwarfs show deep dips from methane and water, which is how we can tell them from distant galaxies that look similar in one colour." },
          { p: "SPHEREx's 102 colours give a low-resolution spectrum of every source in the sky. The Sky Dome shows one for each of our targets." },
        ],
      },
      {
        id: "exoplanets",
        title: "Finding exoplanets",
        blocks: [
          { list: [
            "Transits: a planet passes in front of its star and the star dims a tiny bit.",
            "Radial velocity: the star wobbles towards and away from us as the planet pulls it.",
            "Direct imaging: blocking the star's light to photograph the planet itself. Infrared helps, because young planets are still warm.",
            "Microlensing: a star and planet briefly magnify a star behind them.",
          ] },
          { links: [["NASA exoplanets", "https://science.nasa.gov/exoplanets/"]] },
        ],
      },
    ],
  },
];
