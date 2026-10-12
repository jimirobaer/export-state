#!/usr/bin/env node
// export-state: snapshot the rendered state of web pages into static folders for prototyping.
// See README.md for usage; `export-state --help` for flags.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { capture } from './src/capture.mjs';
import { record } from './src/record.mjs';
import { Session, resolveOutRoot, slugify } from './src/session.mjs';

const HELP = `Usage:
  export-state [url] [options]                    interactive: capture states one by one
  export-state <url> --headless [--click <sel>]   quick: capture one state, no prompts
  export-state --manifest states.json [options]   batch: capture every state in the manifest

Options:
  --manifest <file>   JSON: { "name": "...", "states": [{ "name", "url", "clicks": [], "waitFor" }] }
  --headless          run without a browser window (default in manifest mode)
  --headed            show the browser window in manifest mode
  --click <selector>  click before capturing (repeatable; with a url argument)
  --out <dir>         output root (default: $EXPORT_STATE_OUT or ~/Exports)
  --name <name>       session name (default: manifest name or first host)
  --profile <dir>     browser profile (default: $EXPORT_STATE_PROFILE or ~/.export-state/profile)
  --no-open           don't open the session folder when done
  --no-canvas         keep <canvas> elements as is (default: replace each with a PNG of its pixels)
  --hover             record mode: also snapshot after hovering interactive elements
  --max-states <n>    record mode: stop a recording after n states (default 50)
  --no-links          record mode: don't make recorded states click through to the next
  -h, --help          show this help

Interactive: navigate in the browser, press Enter to capture, name the state; q finishes.
  r starts recording: every interaction that changes the page is captured as a linked step,
  until the URL changes or you press Enter. d + Enter (while recording or at the name prompt) discards it.
Output: <out>/<date>-<time>-<name>/{index.html, session.json, assets/, 01-<state>/...}`;

let opts;
try {
    opts = parseArgs({
        allowPositionals: true,
        options: {
            manifest: { type: 'string' },
            headless: { type: 'boolean' },
            headed: { type: 'boolean' },
            click: { type: 'string', multiple: true, default: [] },
            out: { type: 'string' },
            name: { type: 'string' },
            profile: { type: 'string' },
            'no-open': { type: 'boolean' },
            'no-canvas': { type: 'boolean' },
            hover: { type: 'boolean' },
            'max-states': { type: 'string', default: '50' },
            'no-links': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
    });
} catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(1);
}
const { values: args, positionals } = opts;
if (args.help) {
    console.log(HELP);
    process.exit(0);
}

const normalizeUrl = (url) => {
    if (/^[a-z][\w+.-]*:/i.test(url)) return url;
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:]+\]|[^/:]+\.(local|test|localhost))([:/]|$)/i.test(url);
    return `${local ? 'http' : 'https'}://${url}`;
};

const fail = (message) => {
    console.error(`✗ ${message}`);
    process.exit(1);
};

let manifest = null;
if (args.manifest) {
    try {
        manifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8'));
    } catch (e) {
        fail(`Can't read manifest ${args.manifest}: ${e.message}`);
    }
}
const startUrl = positionals[0] && normalizeUrl(positionals[0]);
const mode = manifest ? 'manifest' : args.headless ? 'quick' : 'interactive';
const headless = mode === 'manifest' ? !args.headed : !!args.headless;
if (mode === 'quick' && !startUrl) {
    console.error(`--headless needs a url or --manifest.\n\n${HELP}`);
    process.exit(1);
}
const maxStates = Number(args['max-states']);
if (!Number.isInteger(maxStates) || maxStates < 1) {
    console.error('--max-states must be a positive integer.');
    process.exit(1);
}
if (manifest && !Array.isArray(manifest.states)) {
    console.error('Manifest must have a "states" array.');
    process.exit(1);
}

// Chromium can't reach OrbStack's *.orb.local over IPv6; pin the IPv4 address of known hosts.
const hostnameOf = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return fail(`Invalid url: ${url}`);
    }
};
const knownUrls = [startUrl, ...(manifest?.states ?? []).map((s) => s.url && normalizeUrl(s.url))].filter(Boolean);
const orbHosts = [...new Set(knownUrls.map(hostnameOf).filter((h) => h.endsWith('.orb.local')))];
const rules = await Promise.all(
    orbHosts.map(async (h) => {
        try {
            return `MAP ${h} ${(await lookup(h, { family: 4 })).address}`;
        } catch (e) {
            return fail(`Can't resolve ${h}: ${e.message}`);
        }
    }),
);

const profile = resolve(args.profile ?? process.env.EXPORT_STATE_PROFILE ?? join(homedir(), '.export-state', 'profile'));
const context = await chromium.launchPersistentContext(profile, {
    headless,
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
    args: rules.length ? [`--host-resolver-rules=${rules.join(',')}`] : [],
});
const page = context.pages()[0] ?? (await context.newPage());

const session = new Session({ outRoot: resolveOutRoot(args.out), request: context.request, name: args.name ?? manifest?.name });
// Some CDNs (e.g. Google Fonts) serve different files per user agent; match the browser.
session.headers['user-agent'] = await page.evaluate(() => navigator.userAgent);

async function open(target, url) {
    try {
        await target.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (e) {
        if (e.name !== 'TimeoutError') throw e;
        console.warn(`  ! ${url} not idle after 15s, continuing anyway`);
    }
}

async function runClicks(target, selectors = []) {
    for (const selector of selectors) {
        await target.locator(selector).first().click();
        await target.waitForTimeout(300);
    }
}

async function defaultName(target) {
    const path = new URL(target.url()).pathname.replace(/\.\w+$/, '').split('/').filter(Boolean).slice(-2).join('-');
    return slugify(path) || slugify(await target.title().catch(() => '')) || 'state';
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

// Animated on a TTY; plain start/end lines otherwise (piped or redirected output).
function spinner(label) {
    if (!process.stdout.isTTY) {
        console.log(`  ${label}`);
        return { stop: (line) => line && console.log(`  ${line}`) };
    }
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    let i = 0;
    const draw = () => process.stdout.write(`\r\x1b[2K  ${frames[i++ % frames.length]} ${label}`);
    draw();
    const timer = setInterval(draw, 80);
    return {
        stop(line) {
            clearInterval(timer);
            process.stdout.write(line ? `\r\x1b[2K  ${line}\n` : '\r\x1b[2K');
        },
    };
}

async function captureState(target, name) {
    const spin = spinner(`Capturing ${name}…`);
    try {
        const result = await capture(target, session, { canvas: !args['no-canvas'] });
        const folder = basename(session.addState({ name, ...result }));
        spin.stop(`✔ Saved ${folder} (html ${(result.html.length / 1024).toFixed(0)} KB, css ${(result.css.length / 1024).toFixed(0)} KB)`);
        return true;
    } catch (e) {
        spin.stop(`✗ ${name}: ${e.message.split('\n')[0]}`);
        return false;
    }
}

const isDiscard = (answer) => ['d', 'discard'].includes(answer?.trim().toLowerCase());

async function recordSteps(target, prompt) {
    const controller = new AbortController();
    const checkpoint = session.checkpoint();
    let discard = false;
    // While preparing, typed input is dropped; once live, Enter stops the recording (d + Enter discards it).
    let release = prompt.busy();
    const { steps, reason } = await record(target, session, {
        signal: controller.signal,
        hover: args.hover,
        canvas: !args['no-canvas'],
        maxStates,
        spinner,
        prepareLabel: paint(33, "⚠ Preparing recording — don't interact with the page yet…"),
        onReady() {
            console.log(paint('1;32', '  ● READY — recording. Interact in the browser now. Enter = stop, d = discard.'));
            release = prompt.listen((line) => {
                discard = isDiscard(line);
                controller.abort();
            });
        },
    });
    release();
    if (reason === 'navigated') console.log('  URL changed, recording stopped.');
    const suggested = `recording-${session.groups.length + 1}`;
    const answer = steps.length && !discard ? await prompt.ask(`Recording name (Enter = ${suggested}, d = discard): `) : null;
    if (!steps.length || discard || isDiscard(answer)) {
        await session.rollback(checkpoint); // steps were only in memory; drop assets saved for them
        return console.log(steps.length ? paint(31, '  ✗ Recording discarded') : '  Nothing recorded.');
    }
    const name = answer?.trim() || suggested;
    const group = session.addRecording({ name, steps, links: !args['no-links'] });
    const range = steps.length > 1 ? `${group.states[0]} … ${group.states.at(-1)}` : group.states[0];
    console.log(`  ✔ Saved ${range} (${steps.length} state${steps.length === 1 ? '' : 's'}, ${group.links.length} link${group.links.length === 1 ? '' : 's'})`);
}

// Prefer the focused tab, then any visible tab, then the most recently opened one.
async function activePage() {
    const pages = context.pages().filter((p) => !p.isClosed());
    let best = pages.at(-1);
    let bestScore = -1;
    for (const p of pages) {
        const score = await p.evaluate(() => (document.hasFocus() ? 2 : 0) + (document.visibilityState === 'visible' ? 1 : 0)).catch(() => -1);
        if (score >= bestScore) [best, bestScore] = [p, score];
    }
    return best;
}

// Line reader that also works with piped stdin (lines arriving before they're asked for are queued).
// On a TTY, `busy()` mutes the echo and drops anything typed until the returned function is called.
function createPrompt() {
    const tty = !!process.stdin.isTTY;
    let muted = false;
    const output = new Writable({
        write(chunk, encoding, done) {
            if (!muted) process.stdout.write(chunk);
            done();
        },
    });
    Object.defineProperty(output, 'columns', { get: () => process.stdout.columns });
    const rl = createInterface({ input: process.stdin, output, terminal: tty });
    const lines = [];
    const waiters = [];
    let closed = false;
    let onEnter = null;
    rl.on('line', (line) => {
        if (onEnter) return onEnter(line);
        if (muted) return;
        waiters.length ? waiters.shift()(line) : lines.push(line);
    });
    rl.on('close', () => {
        closed = true;
        onEnter?.(null); // Ctrl+C or end of piped input also stops a recording
        waiters.splice(0).forEach((resolve) => resolve(null));
    });
    rl.on('SIGINT', () => rl.close());
    const unmute = () => {
        rl.write(null, { ctrl: true, name: 'e' }); // drop any half-typed text
        rl.write(null, { ctrl: true, name: 'u' });
        muted = false;
    };
    return {
        ask(question) {
            if (closed) {
                // Piped input already ended: answer from whatever was queued.
                const line = lines.length ? lines.shift() : null;
                console.log(question + (line ?? ''));
                return Promise.resolve(line);
            }
            rl.setPrompt(question);
            rl.prompt();
            if (lines.length) return Promise.resolve(lines.shift());
            return new Promise((r) => waiters.push(r));
        },
        busy() {
            if (!tty || closed) return () => {};
            muted = true;
            return unmute;
        },
        // Calls fn(line) once on the next Enter (or a line already queued from piped input; null on close). On a TTY,
        // echo is muted and further input is dropped until the returned function is called.
        listen(fn) {
            if (lines.length || closed) {
                fn(lines.shift() ?? null);
                return () => {};
            }
            muted = tty;
            onEnter = (line) => {
                onEnter = null;
                fn(line);
            };
            return () => {
                onEnter = null;
                if (tty) unmute();
            };
        },
        close: () => rl.close(),
    };
}

try {
    if (mode === 'manifest') {
        for (const [i, state] of manifest.states.entries()) {
            const label = state.name || `state ${i + 1}`;
            try {
                if (!state.url) throw new Error('missing "url"');
                console.log(`→ ${label}: ${state.url}`);
                await open(page, normalizeUrl(state.url));
                await runClicks(page, state.clicks);
                if (state.waitFor) await page.waitForSelector(state.waitFor, { timeout: 15000 });
                if (!(await captureState(page, state.name || (await defaultName(page))))) process.exitCode = 1;
            } catch (e) {
                console.error(`  ✗ ${label}: ${e.message.split('\n')[0]}`);
                process.exitCode = 1;
            }
        }
    } else if (mode === 'quick') {
        await open(page, startUrl);
        await runClicks(page, args.click);
        if (!(await captureState(page, await defaultName(page)))) process.exitCode = 1;
    } else {
        if (startUrl) {
            await open(page, startUrl);
            await runClicks(page, args.click);
        }
        const prompt = createPrompt();
        context.on('close', () => prompt.close());
        console.log('Navigate to a state in the browser, then press Enter here to capture it. Type q to finish.');
        while (true) {
            const answer = await prompt.ask(`[${session.states.length} captured] Enter = capture, r = record, q = finish: `);
            const command = answer?.trim().toLowerCase();
            if (answer === null || command === 'q') break;
            const target = await activePage();
            if (!target) {
                console.log('  No open page to capture.');
                continue;
            }
            if (command === 'r') {
                await recordSteps(target, prompt);
                continue;
            }
            const suggested = await defaultName(target);
            const name = (await prompt.ask(`State name [${suggested}]: `))?.trim() || suggested;
            const done = prompt.busy();
            await captureState(target, name);
            done();
        }
        prompt.close();
    }
} catch (e) {
    console.error(`✗ ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
} finally {
    const dir = session.finalize();
    await context.close().catch(() => {});
    if (dir && session.states.length) {
        console.log(`\nSession: ${dir} (${session.states.length} states)`);
        if (!args['no-open']) revealFolder(dir);
    } else {
        console.log('\nNothing captured.');
    }
}

// Best-effort: show the session folder in Finder / the file manager.
function revealFolder(dir) {
    const [cmd, cmdArgs] =
        process.platform === 'darwin' ? ['open', [dir]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', dir]] : ['xdg-open', [dir]];
    try {
        const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
    } catch {}
}
