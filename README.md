# liminal space

A quiet park scene that lives on the real clock and sky over Missoula, Montana. A bench, a bulletin board, a wooden pole with a pay phone, mountains behind. Nothing to win.

## Run it

```
npm run dev
```

Then open http://127.0.0.1:5173. Any static file server works; there is no build step.

## What it does right now

- Hi-res shaded pixel art rendered procedurally on a 960x540 canvas with ordered dithering.
- Sun and moon positions computed for Missoula in real time. Sky, light, and shadows follow.
- Live weather from Open-Meteo (no key needed): cloud cover, precipitation, fog, wind, snow depth. Refreshes every 10 minutes.
- Seasonal snow on the peaks, snow on the ground when there is snow on the ground.
- Hover the pay phone, bulletin board, or bench and click to zoom in. Esc backs out.
- Press `D` for the debug panel: override hour, month, weather, and cloud cover to preview any condition.

## Coming

- Pay phone: phone book with numbers, leaving and hearing voicemails.
- Bulletin board: post notes that weather over time and eventually fall off.
- Someone on the bench, rarely.

## Layout

```
index.html, style.css     shell and Sierra-style caption bar / panels
src/main.js               loop, live environment (time, sun, weather -> palette)
src/state.js              constants, time zone helpers
src/weather.js            Open-Meteo fetch, WMO code -> conditions, debug presets
src/palette.js            sky and light keyframes by sun altitude
src/render/sky.js         dithered sky gradient, stars, moon, sun
src/render/terrain.js     ridged-noise mountains, snowline, trees, ground and path
src/render/props.js       bench, board and notes, pole, pay phone, shadows, lamp glow
src/render/weatherfx.js   clouds, rain, snow, fog, lightning
src/render/renderer.js    layer compositor and caches
src/ui.js                 hotspots, camera zoom, panels, debug controls
```
