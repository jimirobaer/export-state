# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`export-state` is a Node CLI built on Playwright. It snapshots the live rendered state of web pages into static folders for prototyping elsewhere. It works on any URL, including local dev servers. There is no build, lint or test setup. The repo is `jimirobaer/export-state` on GitHub (branch `main`); `exports/` and `node_modules/` are git-ignored.

## Setup and running

```
npm install && npx playwright install chromium && npm link
export-state [url]                                  # interactive, headed
export-state <url> --headless [--click "<sel>"]...  # quick single capture
export-state --manifest states.json [--headed]      # batch, headless by default
```

In interactive mode the prompt is `Enter = capture, r = record, q = finish`. Record mode captures a sequence of interaction states and links them into a click-through (see Architecture).

Other flags are `--out <dir>` (default `$EXPORT_STATE_OUT`, then `~/Exports`), `--no-open` (by default the session folder opens in Finder when done), `--name <session>` and `--profile <dir>`. Record-mode flags are `--hover` (hovering interactive elements also creates steps), `--max-states <n>` (default 50) and `--no-links` (skip the click-through script). The profile defaults to `$EXPORT_STATE_PROFILE` or `~/.export-state/profile`. See `README.md` for the manifest format and output layout.

To test, serve a few static pages on two localhost ports (so one stylesheet is cross-origin), run manifest mode headless with `--profile` pointed at a temp dir, and open the output via `file://`. Test record mode by calling `record()` against a headless Playwright page. To exercise the real CLI under a pty, use a test page that triggers its own interactions once `window.__exportStateRec` exists. Tests must pass `--out` pointing at a temp dir and `--no-open`. Never write to the real `~/Exports`.

## Architecture

- `export-state.mjs` is the bin entry. It parses args (`node:util` parseArgs), launches a persistent Chromium context, and runs one of three modes: interactive, manifest or quick.
  - It pins `*.orb.local` hosts that are known at launch (URL argument or manifest) to IPv4 via `--host-resolver-rules`, because Chromium can't reach them over IPv6. Other hosts are unaffected.
  - `goto` waits for `networkidle` with a 15s timeout, then continues.
  - The interactive prompt is a queued line reader, so piped stdin works (e.g. `printf '\nname\nq\n' | export-state --out /tmp/x --no-open`).
  - On a TTY, a spinner runs while each capture is in progress. During that time, input is muted and discarded. Without a TTY, it prints plain lines.
  - Typing `r` at the prompt starts record mode.
    - While the first step is being captured, `prompt.busy()` drops input and a yellow "Preparing" spinner shows.
    - Once `onReady` fires, a green READY line is printed and `prompt.listen()` makes the first Enter (or Ctrl+C, or the end of piped input) stop the recording. Typing `d`, either then or at the name prompt, discards the recording.
    - Colors are used only on a TTY without `NO_COLOR`.
- `src/capture.mjs` has `capture(page, session)`. It runs these steps:
  1. Scroll for lazy images, then wait 800ms to settle. Record mode passes `{ settle: false }` to skip this step.
  2. Serialize in the page. `serialize()` runs in the page: it collects CSS chunks from `cssRules` and expands readable `@import`s. Cross-origin sheets come back as `{ href }`. It then clones the DOM; strips scripts, styles, preloads, `<base>` and CSP meta; removes `inert` and the scroll lock; copies live form values; collapses `srcset`/`<picture>` to `currentSrc`; and replaces asset URLs (img, inline-style `url()`, icons) with `__export_asset_N__` tokens.
  3. Post-process in Node. Node fetches cross-origin CSS and rewrites `url()` relative to each sheet's own URL. It inlines `@import` recursively, saves assets and swaps the tokens for `../assets/...` paths.
- `src/record.mjs` has `record(page, session, { signal, hover, maxStates, spinner, onReady, prepareLabel })`, the recording engine. It has no prompt, so tests can drive it directly against a Playwright page.
  - Events are ignored until the first step is saved and `markReady` confirms the in-page listeners are live. It then sets `window.__exportStateRec.ready` and calls `onReady`.
  - It installs listeners in the page's capture phase. They report to a context-level `exposeBinding` (`__exportStateEvent`), and a `MutationObserver` tracks when the page settles.
  - Interactions are coalesced, and the last target is kept. A snapshot is taken after 400ms of quiet with no running finite animations, or after at most 2s.
  - Steps whose HTML is identical to the previous step (ignoring ids) are skipped.
  - It stops when `page.url()` changes (`framenavigated`, including pushState), when the signal aborts or when `maxStates` is reached. It returns the steps in memory, and the live DOM is cleaned up afterwards.
  - Linking: before each snapshot, every element in the live DOM gets a `data-export-id`. An interaction records the id of the closest interactive ancestor, so that element is already present in the previous step's HTML.
- `src/session.mjs` has the `Session` class.
  - It creates `<out>/<YYYY-MM-DD-HHMM>-<slug>/` lazily on the first capture and names it with `--name`, the manifest name or the first host.
  - It downloads assets via `context.request` (cookies, no CORS, the browser's UA). Files are named `<sha1(url)[:6]>-<name>` and deduplicated per session.
  - It writes `NN-<slug>/index.html + styles.css`, and rewrites `session.json` and the gallery `index.html` after every capture.
  - Recordings are written only when kept. To discard one, the CLI calls `checkpoint()` before recording and `rollback()` afterwards. `rollback()` deletes the assets first saved since the checkpoint, so assets kept states use survive. It also removes the session folder if the recording created it and no states were kept.
  - `addRecording()` writes the steps flat as `NN-<name>-01…`, so they share `../assets`.
    - It keeps only the linked `data-export-id` attributes.
    - It injects a delimited `<!-- export-state:links -->` script that maps that id to `../<next>/index.html`. The script triggers on click, plus the original keydown, input or submit.
    - It reuses the previous step's `styles.css` when the CSS is byte-identical.
    - It records `recordings: [{ states, links }]` in `session.json`.
