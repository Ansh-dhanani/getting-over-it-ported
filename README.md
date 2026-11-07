# Getting Over It — WebGL Port

A browser port of *Getting Over It with Bennett Foddy*, built with Unity 6.

Loads the Unity WebGL build from Neon S3-compatible object storage. The repo hosts only the tiny static shell (~80 KB) that fetches and boots the game.

## Files

- `index.html` — full-window canvas, minimal black shell, loading splash with progress and active-file readout.
- `logo.jpg` — splash emblem (user-supplied image).

## Build origin

Created as a port from the 2020.3 Unity project; assets and gameplay logic preserved from the recovered project where feasible.

## Deployment

Any static host. Serve this directory at the root; `index.html` `NEON_BASE` references the S3-compatible bucket URLs for the `.data`, `.wasm`, `.framework.js`, and `.loader.js` files.

## Third-party

- Game: *Getting Over It with Bennett Foddy* (Bennett Foddy).
- Engine: Unity 6.