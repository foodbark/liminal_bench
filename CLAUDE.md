# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive website styled like a Sierra point-and-click scene: a park bench, bulletin board, and pay phone on a pole, with mountains behind. The sky, light, shadows, and weather mirror the real time and weather in Missoula, Montana. The vibe (quiet, liminal, slightly nostalgic) matters more than features. Art direction is hi-res *shaded* pixel art with visible pixels and dithering, not chunky low-res and not painterly smooth gradients.

**Beauty over realism.** Everything should pop: blue sky through gaps in the clouds, sparkle on wet grass and dew, bright stars, bold sunset color. Live data (Open-Meteo now, webcams later) tells the scene *what is happening* (ceiling, snowline, fog, rain) and never what color things are. Do not sample palettes from camera frames, and do not let overcast or rain flatten the image into webcam gray. When adding an effect, "is it more beautiful?" comes before "is it accurate?".

## Commands

- `npm run dev` — serves the site at http://127.0.0.1:5173 (plain `python3 -m http.server`). No build step, no bundler, no framework; everything is native ES modules loaded by `index.html`.
- `for f in $(find src -name '*.js'); do node --check "$f"; done` — the only automated check. There are no tests or linters.
- Visual verification: with the dev server running, `node tools/screenshot.mjs out.png "<js to run on the page first>"` renders a 960x540 PNG in headless Chromium (needs `npm install` and `npx playwright install chromium` once). Use the debug panel's inputs from the JS argument to preview conditions, e.g. set `#dbg-enabled` checked, `#dbg-hour`, `#dbg-month`, `#dbg-weather`, then dispatch an `input` event on each. Then look at the PNG. This is how rendering changes get checked.

## Architecture

**One environment object drives everything.** `src/main.js` runs the `requestAnimationFrame` loop. Each frame `computeEnv()` builds `state.env` from the current time (or the debug override), the sun/moon position (`src/util/solar.js`), the live weather (`src/weather.js`, Open-Meteo, no API key, refreshed every 10 min), and the sky palette (`src/palette.js`, keyframed by sun altitude and modified by cloud cover, precipitation, fog). Renderers read only `env`; they never fetch or look at the clock. Missoula local time is derived via `Intl` with `America/Denver`; `src/state.js` holds the constants (`W`, `H`, `HORIZON`, lat/lon).

**Layers with cache keys.** `src/render/renderer.js` composites offscreen canvases into a frame in this fixed order: sky gradient, stars, moon, sun, clouds, terrain (mountains + trees + ground), fog, shadows, ambient-tinted props, lamp glow, precipitation. Then it draws the frame through the camera transform (zoom on hotspots). The expensive per-pixel passes (sky gradient, terrain) write into `ImageData` and are only re-rendered when their key string in `env` changes (`skyKey`, `terrainKey`, `ambientKey`); those keys quantize sun altitude, cloud cover, snow, month, etc. If you add a new input to one of those renderers, add it to the matching key or the change will never show up.

**Pixel discipline.** Everything is drawn with integer `fillRect`s, `fillCircle`, `plotLine`/`plotWire`, and Bayer dither patterns from `src/util/pixel.js`. No canvas `arc`, `lineTo` strokes, gradients, or `globalAlpha` on fills (they anti-alias). Colors are quantized with `quant`/`quantRGB` using the Bayer threshold so banding dithers. The scene faces south: sun azimuth 90..270 maps to screen x left..right (`skyXY` in `sky.js`), so `sunSide` (+1 east, -1 west) picks which slope faces are lit and which way shadows fall.

**Props and lighting.** `src/render/props.js` draws the bench, board + notes, pole, and pay phone in flat base colors into one canvas; the renderer multiplies it by `env.pal.ambient` (multiply then `destination-in` to keep alpha) so props darken at night without redrawing. It is redrawn only when `sunSide`, `groundSnow`, or `state.notesVersion` changes; bump `notesVersion` after mutating `state.notes`. `PROPS`/`HOTSPOTS` there are the single source of truth for hit rectangles, shadow footprints, and labels.

**UI.** `src/ui.js` owns hover captions, click-to-zoom (`VIEWS` gives each view a camera target and a panel dock side), the HTML panels (`PANELS` map, currently placeholder text), the debug panel (press `D`), and the status line. The canvas is CSS-scaled to the window via the `--s` custom property; all UI sizes are multiples of it.

## Roadmap (not built yet)

Pay phone book with numbers and shared voicemails, posting notes to the board that weather over time and eventually disappear, and a rare visitor on the bench (including AI chatbot characters). Both shared features need a small backend; the front end currently has no persistence.
