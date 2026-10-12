# export-state

Snapshot the rendered state of web pages (modals open, forms filled, logged in) into static folders of HTML, CSS and assets that you can prototype on elsewhere. Scripts are stripped. All applied CSS goes into one `styles.css`, and images and fonts are saved locally.

## Install

```sh
npm install
npx playwright install chromium
npm link            # or: npm i -g .
```

This puts `export-state` on your PATH, and you can run it from any directory. Sessions are saved to `~/Exports` by default. When a run captures at least one state, the session folder opens in Finder (`xdg-open` on Linux, `start` on Windows).

## Usage

### Interactive (default)

```sh
export-state [url]
```

This opens a browser window, at `url` or at about:blank. Log in and navigate to a state, then press **Enter** in the terminal and give the state a name. The suggested name comes from the URL path or page title. A spinner runs while each state is captured, and anything you type during that time is ignored. Repeat for as many states as you like, then type **q** to finish. If several tabs are open, the focused or visible tab is captured.

### Recording interactions

At the capture prompt, type **r** instead of pressing Enter to record a click-through prototype.

1. The current page is captured as step 01. While this happens, a yellow "⚠ Preparing recording" warning is shown. Don't interact with the page yet, because nothing is recorded and anything you type is ignored. Recording starts when the green "● READY — recording" line appears.
2. Interact in the browser. After every click, input, change, form submit or key press (Enter, Escape, Space, Tab, arrow keys) that changes the page, a new step is captured once the page settles. "Settles" means about 400ms without DOM changes or animations, with a maximum wait of about 2s.
3. The recording ends when the page URL changes, whether by full navigation or by `pushState` or a hash change, or when you press **Enter**. The page at the new URL isn't captured.
4. Name the recording, and you're back at the normal prompt.

To throw a recording away, type **d** and press Enter. This works while recording or at the name prompt. A discarded recording leaves nothing behind: no folders, no assets only it used, no gallery or `session.json` entry, and no used-up number.

How steps are kept and linked:
- **No-change interactions:** an interaction that leaves the page unchanged doesn't create a step.
- **Recording length:** a recording stops after 50 steps (`--max-states`).
- **Hover:** with `--hover`, hovering an interactive element also counts as an interaction.
- **Click-through links:** each step gets a small inline script. Repeating the recorded interaction on the same element, for example clicking the menu button or typing in the field, jumps to the next step. `--no-links` leaves this script out.
- **Missing elements:** if the interacted element didn't exist in the previous step, that link is skipped. The step is still kept.

Steps are stored as `NN-<name>-01`, `NN-<name>-02`, and so on. A step whose CSS is identical to the previous step's uses the earlier `styles.css` instead of writing a copy. The gallery shows a recording as a group with a "Start click-through" link, and `session.json` lists its steps and links under `recordings`.

### Manifest (batch, headless)

```sh
export-state --manifest states.json [--headed]
```

```json
{
  "name": "bookings",
  "states": [
    { "name": "calendar", "url": "https://app.test/calendar" },
    { "name": "new booking", "url": "https://app.test/calendar", "clicks": ["button:has-text('New')"], "waitFor": "[role=dialog]" }
  ]
}
```

For each state, export-state opens the `url`, clicks each selector in `clicks` in order (Playwright selectors, first match), waits for `waitFor` if one is given, and then captures. A state that fails is logged and skipped.

### Quick single capture

```sh
export-state https://example.com --headless [--click "<selector>"]...
```

## Options

| Flag | |
|---|---|
| `--manifest <file>` | batch mode, headless unless `--headed` is set |
| `--headless` / `--headed` | hide or show the browser |
| `--click <selector>` | click before capturing (repeatable; used with a url argument) |
| `--out <dir>` | output root, default `$EXPORT_STATE_OUT` or `~/Exports` (a leading `~` is expanded) |
| `--no-open` | don't open the session folder when done |
| `--no-canvas` | keep `<canvas>` elements as they are instead of replacing them with a PNG |
| `--name <name>` | session name, default: the manifest name or the first captured host |
| `--profile <dir>` | browser profile, default `$EXPORT_STATE_PROFILE` or `~/.export-state/profile` |
| `--hover` | record mode: hovering interactive elements also creates steps |
| `--max-states <n>` | record mode: steps per recording, default 50 |
| `--no-links` | record mode: don't inject click-through links |
| `-h`, `--help` | show help |

The browser profile is persistent, so you stay logged in between runs. Delete the profile directory to reset it.

## Output

Each run creates one session:

```
~/Exports/2026-10-09-1204-bookings/
  index.html        gallery linking to every state and recording (no JS)
  session.json      states, urls, titles, timestamps, recordings with their links
  assets/           images and fonts shared by all states, deduplicated by URL
  01-calendar/      index.html + styles.css
  02-new-booking/   index.html + styles.css
  03-menu-flow-01/  recording step 1: index.html + styles.css (+ link script)
  03-menu-flow-02/  recording step 2: index.html (reuses ../03-menu-flow-01/styles.css)
```

State pages reference shared files as `../assets/...`, so the folder works offline from `file://`.

## What gets captured

- **CSS**: all CSS the browser applies, including adopted stylesheets and the rules of CSS-in-JS. Cross-origin stylesheets are fetched from Node and inlined, with `@import` inlined too. If that fetch fails, the original `<link>` is kept.
- **Asset URLs**: `url(...)` references are resolved against the stylesheet they appear in and saved as assets.
- **Images**: each `<img>` keeps only the image the browser actually chose, so `srcset` and `<picture>` are reduced to that one file. Inline `style="...url(...)"` images and favicons are saved too.
- **Canvas**: scripts are stripped, so a `<canvas>` (e.g. Chart.js) would export blank. Each one is replaced by an `<img>` of its current pixels (a static picture, no hover or tooltips); canvases the page can't read (cross-origin content, WebGL) are screenshotted instead. `--no-canvas` turns this off.
- **Lazy-loaded images**: the page is scrolled through before capture so they load, then the original scroll position is restored.
- **Forms and modals**: live form values are copied into the markup. `inert` and body scroll locks are removed, so open modals stay usable.
- **Slow pages**: page loads wait for network idle for up to 15 seconds, then continue with a warning.
- **OrbStack**: `*.orb.local` hosts given on the command line or in the manifest are pinned to IPv4.

Links (`<a href>`), inline event handlers, iframes and shadow DOM content are left as they are.
