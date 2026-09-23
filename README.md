# liminal space

A quiet park scene that lives on the real clock and sky over Missoula, Montana. A bench, a bulletin board, a pay phone, a pole with a lantern, mountains behind. Nothing to win.

![The scene on a mostly clear September afternoon](docs/screenshot.png)

## See it

https://foodbark.github.io/liminal_bench/ (GitHub Pages, redeployed on every push to master)

## Run it

```
npm run dev
```

Then open http://127.0.0.1:5173. Any static file server works; there is no build step.

## What it does right now

- The scene is a hand-painted (Gemini) pixel-art backdrop at 2752x1536, re-lit every few minutes by code: sky, sun, moon, clouds, alpenglow, snow, fog, and rain are procedural and dithered; the painting itself is never redrawn.
- Sun and moon positions computed for Missoula in real time. Sky, light, and shadows follow.
- Live weather from Open-Meteo (no key needed): low, mid and high cloud cover become cirrus, altocumulus, stratus, stratocumulus, nimbostratus and cumulus; precipitation, fog, wind, snow depth. Refreshes every 10 minutes. Thunderstorms bring a cumulonimbus and lightning.
- The real night sky: the Bright Star Catalog placed by sidereal time, the Milky Way on dark nights, shooting stars (more during the meteor showers), and a painted moon with its phase that lights the clouds.
- Seasonal snow on the peaks, snow on the ground when there is snow on the ground.
- Hover the pay phone, bulletin board, or bench and click to zoom in. Esc backs out.
- Press `D` for the debug panel: override hour, month, weather, and cloud cover to preview any condition.

## Coming

It has been public and barebones since mid September 2026. Next goal: a real domain, and one thing on the board you can actually touch.

- Pay phone: phone book with numbers, leaving and hearing voicemails.
- Bulletin board: post notes that weather over time and eventually fall off.
- Someone on the bench, rarely.

### Guiding rule: beauty over realism

Everything here should pop: blue sky through the clouds, sparkle on wet grass and dew, bright stars, brilliant sunsets. Weather data and webcams tell the scene what is happening, never what color it is. A webcam frame is gray and flat; this world is not. Smoke season is allowed to be hazy, but it stays full of color: an orange sun, an amber sky, ridges fading to pink and rust rather than gray.

### Weather ideas (procedural only, agreed 2026-09-03)

- Valley inversion fog that pools at the mountain bases and burns off top-down as the sun climbs, inferred from temperature, dew point, and wind even without a fog report.
- A daily snowline: fresh overnight snow on the low slopes that melts by afternoon while the peaks keep it.
- Smoke season: August wildfire haze from Open-Meteo's air quality PM2.5, orange sun, ridges fading out.
- Low cloud ceilings that cut off the peaks on overcast days.
- Wind on the ground: grass, wires, drifting snow.

### Webcam observation feed (idea, 2026-09-03)

Forecast data says how cloudy it is; a camera says where the clouds are. Seeing real clouds halfway up Mount Sentinel while the scene showed them at the top of the sky prompted this. The public Missoula webcams we looked at were not satisfying, so the plan is our own camera.

- A camera pointed at Sentinel and the sky above it, uploading a still every 5 to 15 minutes. Stable mount matters: the analysis assumes fixed framing.
- A small service that grabs the latest frame and publishes one tiny JSON document: cloud ceiling as a fraction of the mountain, snowline fraction, visibility/smoke score, horizon sky color, timestamp.
- The site fetches that JSON the same way it fetches Open-Meteo. The renderer does not need to know a camera exists.
- Analysis: classic image processing against a hand-traced ridge silhouette for ceiling and snowline; optionally a vision model asked a fixed question every 15 minutes for smoke and sky mood.
- This is the intended data source for the low-ceiling and daily-snowline items above.

### Art direction (thinking out loud, 2026-09-03)

- Keep the pixel-by-pixel procedural core. Hone it toward more detail and a more recognizably Missoula look.
- Grass, bushes, and trees that sway a little with the wind so the scene feels alive.
- Concept art comes first as a guide; the procedural scene gets retuned to match it.
- Possibly hand-drawn props (bench, board, pay phone) as PNG sprites, and possibly painted backgrounds in places with procedural overlays (snow, fog, light) on top.

## Backlog (2026-09-23)

Three quiet weeks, and the season moved without us. Smoke is done for the year. The valley trees are turning now, the larches on Dean Stone go gold in early October, and first snow on the mountain arrives when it arrives.

### Denver punch list — Monday Sept 28 and Tuesday Sept 29

Two days off work, on a laptop in a coffee shop, four states from the actual weather. Nothing on this list needs to look out a window or sit through a full art build, so it is the code-and-plumbing list. Roughly in order.

- [ ] **Settle whether the painting distinguishes larch from fir** (see the fall section below). Needs only the painting we already have and a `--debug` overlay, so a coffee shop is a fine place to do it, and the answer decides whether the larch are a code change or a repaint. Larch start turning about a week after Denver, so this is the last comfortable moment to find out.
- [ ] **Kill the calendar first snow.** `SEASON_SNOW` in `src/state.js` jumps November to 0.5, so on Nov 1 the peaks go white whether or not a flake has fallen. Take the *arrival* out of the table and drive it from data: a second Open-Meteo query at the ridge's latitude, longitude and elevation (the API takes an `elevation` parameter, and the valley station is useless for a summit), plus a latch, so that once snow has accumulated up there the peaks stay snowed through the winter instead of flickering with each forecast refresh. The table keeps its job for depth and spring melt. Until this lands, October's 0.04 is correct and should not be nudged upward out of impatience.
- [ ] **Bulletin board, step one, no backend.** Make notes postable and persistent in `localStorage`: a compose field on the cork zoom, writes to `state.notes`, `state.notesVersion++` to force the prop redraw, and notes that age — paper yellowing, a corner curling, gone after a couple of weeks. That is the entire interaction loop, single-player, and it works on bad coffee-shop wifi. The shared version later is the same UI pointed at a server instead of a browser.
- [ ] **Stand up the backend: Cloudflare Workers + D1.** Decided 2026-09-23 — already familiar, and the DNS is going there anyway. Free tier, one `wrangler deploy`, SQLite semantics. Deliverable for the day is `GET /notes` and `POST /notes` against a real table, with a rate limit from the first commit, because an anonymous public board will eventually be found.
- [ ] **Move the site to Cloudflare Pages.** Decided 2026-09-23. DNS, the Worker and now the host all in one account, which puts the API on the same origin under `/api/*` so CORS never becomes a problem to debug. Pages builds on a push to `master` exactly the way GitHub Pages does — no build command, output directory is the repo root — so `master` stays production and the workflow does not change. Keep the GitHub Pages deployment alive until the new one is verified, then retire it and leave a redirect.
- [ ] **Get the domain.** `liminalbench.net`, unless the "reads like an AI benchmark" thing starts to grate; a DNS check on 2026-09-23 found no delegation, but confirm at the registrar. Register through Cloudflare at cost, attach it to the Pages project in the dashboard, and the certificate and apex records handle themselves — none of the GitHub `CNAME`-file and A-record dance is needed. Watch for anything assuming the `/liminal_bench/` path prefix: the site moves to the root of its own host. Runner-up name if it comes to that: `nothingtowin.net`.
- [ ] **Mobile touch and landscape**, if there is time left. Phones already get the half-size scene, but hotspots and panels still assume a mouse: tap targets, a way out of a zoom without an Esc key, and a landscape layout.

### Seasonal, and only buildable while it is happening

**Which trees turn is the whole problem, and it is not only a fall problem.** Everything that changes color in this valley is scattered inside something that does not. Larch on Dean Stone are individual trees sprinkled through a matrix of pine and fir — a small fraction of the dome, not a band across it. The foreground valley trees are a mix of deciduous and evergreen, and so are the shrubs on Sentinel. The mask does not know the difference: it has one `FOLIAGE` code and one `SHRUB` code, so any tint keyed to material turns every tree on the mountain at once, which is worse than leaving it green.

Telling those apart buys the whole year, not three weeks of October. The same split is what makes **bare trees in winter** possible — and larch are deciduous conifers, so they go gold, then bare, and stand as gray skeletons among green fir until spring, which is most of what a Missoula winter hillside actually looks like. It decides **how snow sits**, too: bare branches catch it as white tracery, fir boughs hold it in slabs, and `terrain.js` already keys snow off material. And it runs the other way in **spring**, when the larch flush a green brighter than anything else on the mountain. Four seasons out of one classification pass. That is worth doing properly rather than cheaply.

- **Does the painting already know which trees are which?** Larch and cottonwood read a different green than fir, and if that difference survived into the painting then the build can classify it — hue and value histograms over the forest region, a `--debug` overlay tinting the candidates, and a look. This is squarely what the build is for: it masks, classifies and cleans what is painted, and invents nothing. If the answer is yes, the rest is cheap. If it is no, the scatter has to come from the art, because code choosing *which* trees are larch is code drawing the picture. Ten minutes of work and it decides the next three weeks, so do it before anything else in the fall list.
- **If classification works: new material codes, and the packing has to change.** `LARCH` and `DECIDUOUS` want to be materials 8 and 9, but codes are stored `32 *` in the mask's G channel (`tools/build_backdrop.py:362`) and 8 would overflow the byte. Re-space to 16 apart: sixteen codes, snap becomes `(v + 8) >> 4` in `src/assets.js:26`, and the drift tolerance drops from ±16 to ±8 — still far more than the unit or two of color management this defends against. Three places to touch and a rebuild.
- **If it does not: the art supplies the scatter.** An overlay painting over the existing framing, gold dabs where the larch actually are and checkerboard everywhere else, keyed in the way `front` already is. Registration is the risk, so it wants to be derived from the current painting rather than generated fresh.
- **Then the tint, and it should be saturated.** Only a tenth of those pixels change, so a gentle wash across them reads as nothing at all. Real larch season is gold flecked through dark green and it *pops*; the pixels that turn should go most of the way to gold while their neighbors stay fir-dark. Ramp in over about ten days, hold, then drop to bare gray-brown. A channel-ratio tint like `grassTint` may not survive a green-to-gold swing that big — mapping luminance through a gold ramp is the fallback.
- **Bare trees are not a tint, and that is the hard one.** Color is recoloring pixels that are already painted; bare is the leaf mass largely going *away*, with ridge and sky showing through where it was. The painting has nothing behind those trees, because nothing was ever painted there. So winter wants a painted state, not a computed one: the same framing with the deciduous and the larch stripped to branches. Thinning the silhouette by dithering out foliage pixels is the cheap approximation and is worth one screenshot, but expect it to read as moth-eaten rather than bare.
- **Which means: commission the fall and winter states in the same sitting.** If the art has to supply the scatter anyway, get all of it while the framing is loaded and matching — full green, fall, and bare-winter, same composition. Registering three variants painted together is a build problem; registering a winter variant painted in November against a fall variant painted in September is a re-tracing problem. Cross-fade between states by date, the way the tint would have.
- **Timing.** Valley trees are turning now and hold through late October. Larch go around Oct 5 into early November, then stand bare until the spring flush. Sentinel's shrubs come along with the valley. Bare-and-snowy is the state the scene will sit in for four or five months, so it is worth more care than its three-week neighbors. Dean Stone is the favorite mountain; check it first and check it again last.
- **First snow on the mountain top: wait for first snow on the mountain top.** No calendar snow, no getting ahead of it. See the punch list item above. It will happen overnight and the payoff is the morning after — a white crest over a still-green valley — so the code should be exercised through the debug panel *before* the event, not written during it.
- **Smoke season is over.** The PM2.5 haze idea keeps its notes above and comes back in August 2027. Tuning haze with no haze to look at is how it ends up gray.

### Still open from September 5

- **The tan hill right of the trees.** The Sentinel painting (`art/mount_sentinel_alone_transparent_sky.jpg`) carries its tan slope all the way across the frame, so in the layered scene Dean Stone's base sits behind a flat tan ridge instead of running down into the trees. It bothers us. Fix is in the art, not the code: a version of the Sentinel file with that far tan hill left transparent (checkerboard is fine), so Dean Stone shows through down to the tree line. Everything else in the layering stays as is. Worth doing before the larches, since it is the same mountain.
- An open-topped trash can prop is coming (user's art), so sprite critters can pop out of it later; the build copies new props from the props-only file, and the can's rim needs a small mask so critters draw behind it.
- Wind-swayed foliage.

## Layout

```
index.html, style.css     shell and Sierra-style caption bar / panels
src/main.js               loop, live environment (time, sun, weather -> palette)
src/state.js              constants, time zone helpers
src/weather.js            Open-Meteo fetch, WMO code -> conditions, debug presets
src/palette.js            sky and light keyframes by sun altitude
src/render/sky.js         dithered sky gradient, stars, moon, sun
src/assets.js             loads the painted scene and its layer/material mask
src/render/terrain.js     re-lights the painting: seasonal grass, snowline, fog, ambient
src/render/props.js       where the painted props are; notes on the cork, snow caps, shadows, lantern glow
src/render/clouds.js      cumulus sprites: seeded puff layout, height-field shading, five tones
src/render/weatherfx.js   cloud field, rain, snow, fog, lightning
src/render/renderer.js    layer compositor and caches
src/ui.js                 hotspots, camera zoom, panels, debug controls
art/                      paintings + a JSON config each (silhouettes, prop boxes, hotspots); art/current picks one
assets/                   generated backdrop.png, backdrop_mask.png, backdrop.json (tools/build_backdrop.py)
```
