# ASCII City

A real-time ASCII art city raycaster that runs entirely in the browser. Explore a procedurally generated city at night with lit windows, neon signs, traffic, streetlamps, weather, and a day/night cycle — all rendered as colored text characters on a canvas.

## Quick Start

Open `index.html` in any modern browser. No build step, no dependencies.

## Controls

| Key | Action |
|-----|--------|
| W A S D | Move |
| Left / Right | Turn |
| Up / Down | Look up / down |
| M | Toggle minimap / world map (click world map to teleport) |
| L | Toggle streetlamps |
| F | Toggle fly mode (Space/Shift for altitude) |
| P | Toggle settings panel |
| Esc | Close settings panel |

## Features

- **Procedural city generation** — Perlin noise-based zoning (residential, commercial, downtown, parks) with variable building heights
- **Raycast rendering** — DDA grid raycaster with per-column wall slicing, distance fog, and a quantized color cache for fast run-merged drawing
- **Animated facades** — Blinking windows and cycling neon signs on commercial buildings
- **Traffic system** — Cars that drive the road grid with headlights and taillights
- **Day/night cycle** — 4-minute full cycle through midnight, dawn, noon, and dusk keyframes
- **Weather** — Rain and snow particle overlays
- **Procedural audio** — Web Audio ambience (city rumble, rain, footsteps) with no asset files
- **Settings panel** — Persistent via localStorage; tweak FOV, fog, font size, time of day, and more

## Project Structure

| File | Purpose |
|------|---------|
| `index.html` | Entry point, canvas, and inline styles |
| `main.js` | Raycaster core, render loop, input, HUD |
| `city-generator.js` | Perlin noise city layout + building heights |
| `facade.js` | Animated windows and neon sign logic |
| `traffic.js` | Car movement and billboard rendering |
| `weather.js` | Day/night cycle and rain/snow particles |
| `audio.js` | Procedural Web Audio ambience |
| `settings.js` | Settings registry, panel UI, localStorage persistence |

## License

MIT
