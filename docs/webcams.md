# Missoula webcams we can pull from

Surveyed 2026-09-03. All are third-party cameras; check terms before anything public-facing, and fetch gently (every 10 to 15 minutes at most). Stills only, no video streams.

## Worth using

### KPAX "Missoula Cam" (St. Patrick Hospital)
- URL: `https://mediaassets.kpax.com/weatherimages/Saint-Pats.jpg`
- View: downtown looking east-southeast straight at **Mount Sentinel with the M**, Hellgate Canyon, and Mount Jumbo on the left. 1920x1080, updated every few minutes. Sponsor overlay top-left.
- Use: cloud ceiling on Sentinel, snowline on Sentinel and Jumbo, visibility/smoke, real sky color. This is the primary camera for the observation feed.

### Mountain Press "Missoula Montana Live Webcam" (South Hills)
- URL: `https://wingsvirtualtours.com/webcams/missoula_valley/public_html/cam/streaming/mp/current.jpg`
- View: from the South Hills looking north over the whole valley to the North Hills and Rattlesnake. Wide sky, cloud deck, valley haze. 1188x568, timestamp burned into the top-right.
- Use: valley inversion fog (it looks down into the valley), overall cloud deck, smoke haze across the valley.

### MDT RWIS "Bonner" (I-90 mile 110, Hellgate Canyon east of town)
- Site page: `https://app.mdt.mt.gov/atms/public/rwis/150011`
- Images are timestamped URLs of the form `https://mdt.mt.gov/other/WebAppData/External/RRS/RWIS/Bonner-150011-<cam>-<M>-<D>-<YYYY>-<H>-<MM>-<n>.jpg`, camera 00 = East, 03 = West. The site page HTML contains the current URLs, so the fetcher scrapes the page then downloads the image. New image every 15 minutes.
- Use: east-facing sky and clouds (weather arrives from the west, so this is the "what's leaving" view), rain/wet road, fog in the canyon.

## Looked at, low value

- **MDT Lolo North "East Horizon"** (`/atms/public/rwis/150013`): mostly trees, mountains barely visible, lens gets rain-spotted.
- **MDT Evaro Hill** (`/atms/public/rwis/150014`), **Ninemile** (`/atms/public/rwis/150005`): road-focused, 15 to 25 miles out. Possible backup for snow on the ground.
- **FAA WeatherCams at MSO** (`weathercams.faa.gov`): the airport has cameras with several views updated every 10 minutes, but the JSON API returns 401 without a key. Would need the app's key or a scrape of the map page. Not pursued.
- **KPAX "Hamilton"** (`https://mediaassets.kpax.com/weatherimages/Hamilton.jpg`): exists, but Bitterroot Valley, not Missoula.
- **NBC Montana / KECI cameras page** and **montanarightnow.com Missoula cam**: video players, no still URL found.
- **Windfinder "Mt. Sentinel"**: page exists, no camera behind it.
- **WeatherBug Missoula**: no cameras.
- **Montana Snowbowl base cam**: exists, but 12 miles out and pointed at a lodge. Could serve as a "snow in the mountains" signal in winter.

## Not real cameras
- worldcamera.net, liveworldwebcams.com, worldcam.eu, montana-webcams.com, montanawebcam.com: aggregators re-hosting the feeds above. montanawebcam.com is where the two direct URLs at the top came from.
