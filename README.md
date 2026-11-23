# Rebirth Sandbox

**GitHub Game Off 2026 entry · Theme: SHIFT**

A 10×10 grid survival game. You are a mutant trapped in a garden. Shift one cell at a time, dodge projectiles, hold Attack to break through the plants, and evolve before the board closes in.

- Play on itch.io: https://deloki-cai.itch.io/rebirth-sandbox
- Jam page: https://itch.io/jam/game-off-2026
- Author: **JiahaoCai**
- Engine: Phaser 3 + TypeScript + Vite
- Platforms: browser (desktop + mobile), WeChat mini-game build available separately
- Languages: English / 中文

## Theme: SHIFT

The whole game is built on small, deliberate shifts:

- You **shift** one cell at a time on a 10×10 board.
- Every plant you clear **shifts** the board's pressure: new plants, new projectiles, new paths.
- Every evolution **shifts** your body, damage, and options.
- The shop **shifts** the run: spend now for survival, or save for a stronger evolution.

The rule is simple: move, attack, adapt. The board does the rest.

## Controls

| Action | Desktop | Mobile |
|---|---|---|
| Move | WASD / arrow keys | swipe on the board |
| Attack | hold Space | hold the board or Attack button |
| Shop | B | Shop button |
| Pause | Esc | Pause button |
| Heavy attack | hold Space with cutter | hold Attack with cutter |

## Run locally

```bash
npm install
npm run dev
```

Then open the URL printed by Vite; the game entry is `/game.html`.

Production build:

```bash
npm run build
```

The static output is written to `dist/`.

## Project layout

```text
src/            scenes, entities, systems, UI, platform adapters
public/assets/  runtime art, music, sound effects
index.html      redirects to the browser build
game.html       browser game shell
```

## Credits and licenses

- Game code, design, and UI: **JiahaoCai**
- Engine: [Phaser 3](https://phaser.io/) (MIT)
- Some character, plant, and prop images are AI-assisted and used with commercial authorization; details in [ASSET_LICENSES.md](ASSET_LICENSES.md).
- Music and sound effects: Pixabay Content License / Kenney (CC0), as listed in [ASSET_LICENSES.md](ASSET_LICENSES.md).
- See [AI_DISCLOSURE.md](AI_DISCLOSURE.md) for the Game Off AI disclosure.
- See [LICENSE](LICENSE) for the repository license.

## Game Off 2026

This repository contains the source used for the Game Off 2026 submission. The playable build is hosted on itch.io:

https://deloki-cai.itch.io/rebirth-sandbox

Built during the Game Off 2026 jam period. Feedback is welcome in the itch.io comments.
