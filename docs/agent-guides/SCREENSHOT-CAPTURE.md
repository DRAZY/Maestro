# Capturing the Screenshot Set

How every screenshot in `docs/` and on runmaestro.ai gets made: Showcase Mode
seeds a fake workspace, and `capture.js` drives the running app over Chrome
DevTools Protocol to photograph each surface in each theme.

Run it when the UI has moved enough that the published set misreports the app,
which in practice is a few times a year.

---

## The two halves

**Showcase Mode** is the SET: `scripts/showcase/seed/data/` holds a fictional
twelve-agent fleet, a group chat, settings, and window bounds. `setup.js` copies
that into a throwaway data directory and `launch.js` starts the dev app against
it. Nothing here touches your real workspace.

**The capture driver** is the CAMERA: `capture.js` opens each surface and
shoots it.

They are separate because the set is reusable. `npm run dev:showcase` gives you
the same fake workspace to click around in by hand, with no capture involved.

---

## Running it

```bash
# Everything: every shot, all three published themes
npm run capture:showcase

# One theme while you iterate
npm run capture:showcase -- --themes pedurple

# A few shots, left running so you can look at the app afterwards
npm run capture:showcase -- --themes dracula --only main-screen,cue-dashboard --keep

# A set destined for the website, shot against a neutrally-located checkout
npm run capture:showcase -- --cwd /Users/maestro/Projects/Maestro
```

| Flag       | Default                             | What it does                                                              |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `--themes` | `dracula,catppuccin-latte,pedurple` | Comma-separated theme ids from `THEMES` in `src/shared/themes.ts`.        |
| `--size`   | `1796x1151`                         | Logical window size. The published set is this, which is 3592x2302 at 2x. |
| `--only`   | all                                 | Comma-separated shot names from `shots.js`.                               |
| `--out`    | `docs/screenshots`                  | Output directory.                                                         |
| `--cwd`    | this checkout                       | Working directory the demo agents point at (see below).                   |
| `--keep`   | off                                 | Leave the app running after the last shot.                                |

Output is `<out>/<shot>.<theme>.png`, so a docs page or the website gallery can
switch themes by substituting one path segment.

---

## What to know before you trust a run

**The path in the Files panel is published.** `$CWD` in the seed becomes a real
directory, because a made-up one renders an empty file tree, which looks broken
rather than anonymous. The default is whatever checkout you ran from, so a set
going on the website should use `--cwd` pointing at a clone living somewhere
neutral.

**A first-run modal will cover the hero if the seed misses it.** The onboarding
series shows one modal per step, each with its own seen flag, so a step added
later defaults to unseen. `setup.js` reads `ONBOARDING_STEPS` out of
`src/shared/onboardingSeries.ts` and refuses to seed when the settings file does
not dismiss every one, which turns a ruined run into a loud error. If you see
that error, add the named flag to
`scripts/showcase/seed/data/maestro-settings.json`.

**An Encore-gated surface is refused rather than shot.** `openUiSurface` turns
down a surface whose Encore Feature is off, and the driver treats that as a skip
instead of photographing whatever is behind it. Concerto, Pianola, Plugins,
Coworking, and Groups+ default OFF, so the seed turns them on; a new gated
surface needs the same.

**The driver waits for paint, not for a port.** The bridge file and the CDP
target both exist while the splash is still up. Readiness is the splash being
gone AND the Left Bar header having rendered.

---

## Changing what gets shot

`shots.js` is the shot list, and it is editorial rather than generated.
`UI_SURFACES` in `src/shared/uiSurfaces.ts` is everything that CAN be opened;
the shot list is what is worth publishing.

```js
{ name: 'cue-pipeline', surface: 'cue', tab: 'pipeline', settleMs: 1600 }
```

- `name` is the output basename. Renaming one orphans every doc embedding it.
- `surface` is a `UI_SURFACES` id, opened through the same `open_modal` path
  `maestro-cli open` uses. Omit it for the main window with nothing open.
- `settleMs` buys time for a surface that loads async (charts, the Cue canvas).

---

## Why it is built this way

**The bridge opens, CDP only shoots.** Surfaces are opened over the WebSocket
bridge because that is the same path `maestro-cli open` takes, so it honors
Encore gating and the modal layer stack: a shot can never capture a state a user
could not reach. CDP is confined to `Page.captureScreenshot` and an Escape
keypress, so the driver cannot drift from what the app supports.

**One launch per theme.** The theme is applied by seeding settings before the
app starts. Switching live would leave a repaint race on exactly the surfaces
that are slowest and most worth photographing.

**There is no `close_modals` verb, deliberately.** A main-window shot presses
Escape, the same key a user presses, rather than reaching for a back door that
could drift from the layer stack.

---

## Related

- [THEMES.md](../../THEMES.md) - the theme gallery and Showcase Mode commands.
- `scripts/showcase/` - seed data, setup, launcher, shot list, driver.
- `src/shared/uiSurfaces.ts` - the surface registry the shot list draws from.
