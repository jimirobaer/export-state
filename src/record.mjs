// Record mode: snapshot the page after each interaction until its URL changes, the signal is
// aborted or maxStates is hit. Returns the steps in memory; Session.addRecording writes them.
//
// Before every snapshot each element in the live DOM gets a data-export-id, so the element a
// later interaction targets can be found in the previous step's markup and linked to the next.
import { createHash } from 'node:crypto';
import { capture } from './capture.mjs';

const QUIET_MS = 400; // no DOM mutations / running animations for this long = settled
const MAX_WAIT_MS = 2000; // snapshot anyway this long after the first pending interaction
const POLL_MS = 100;

const bound = new WeakSet();
let listener = null; // the active recording's event handler (one recording at a time)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const hashOf = (html) => createHash('sha1').update(html.replace(/ data-export-id="[^"]*"/g, '')).digest('hex');
const quietSpinner = () => ({ stop() {} });

// onReady fires once the first step is saved and the in-page listeners are confirmed live;
// interactions before that are ignored. prepareLabel is the spinner label for that first step.
export async function record(
    page,
    session,
    { signal, hover = false, canvas = true, maxStates = 50, spinner = quietSpinner, warn = console.warn, onReady = () => {}, prepareLabel } = {},
) {
    const context = page.context();
    if (!bound.has(context)) {
        await context.exposeBinding('__exportStateEvent', ({ page: from }, event) => listener?.(from, event));
        bound.add(context);
    }

    const startUrl = page.url();
    const steps = [];
    let pending = null;
    let navigated = false;
    let ready = false;
    const moved = () => navigated || page.isClosed() || page.url() !== startUrl;
    listener = (from, event) => {
        if (from !== page || !ready) return;
        const now = Date.now();
        pending = { ...event, first: pending?.first ?? now, last: now }; // coalesce, keep the last target
    };
    const onNavigate = (frame) => {
        if (frame === page.mainFrame() && page.url() !== startUrl) navigated = true;
    };
    page.on('framenavigated', onNavigate);

    const snapshot = async (via) => {
        const label = `step ${pad(steps.length + 1)}`;
        const spin = spinner(steps.length === 0 && prepareLabel ? prepareLabel : `Capturing ${label}…`);
        try {
            await page.evaluate(tagElements);
            const result = await capture(page, session, { settle: false, canvas });
            if (moved()) return spin.stop(null); // the interaction navigated away; nothing to keep
            const hash = hashOf(result.html);
            const prev = steps.at(-1);
            if (prev?.hash === hash) {
                // Same state: keep the newest markup so ids of re-rendered elements stay resolvable.
                Object.assign(prev, { html: result.html, css: result.css });
                return spin.stop(null);
            }
            steps.push({ ...result, hash, via, capturedAt: new Date().toISOString() });
            spin.stop(`✔ ${label}${via ? ` (${via.type}${via.key ? ` ${via.key}` : ''})` : ''}`);
        } catch (e) {
            spin.stop(moved() ? null : `✗ ${label}: ${e.message.split('\n')[0]}`);
        }
    };

    let reason = 'stopped';
    try {
        await page.evaluate(startListening, { hover });
        await snapshot(null);
        // Mark the page as live (also confirms the listeners are installed) before announcing it.
        if (steps.length && !moved() && (await page.evaluate(markReady))) {
            ready = true;
            onReady();
        }
        while (true) {
            if (moved()) {
                reason = 'navigated';
                break;
            }
            if (steps.length >= maxStates) {
                warn(`  ! reached ${maxStates} states, stopping the recording`);
                reason = 'limit';
                break;
            }
            if (pending) {
                const now = Date.now();
                const idle = now - pending.last >= QUIET_MS && (await page.evaluate(isQuiet, QUIET_MS).catch(() => false));
                if (idle || now - pending.first >= MAX_WAIT_MS) {
                    const { id = null, type, key } = pending;
                    pending = null;
                    await snapshot({ id, type, ...(key && { key }) });
                    continue;
                }
            } else if (signal?.aborted) break; // stop requested and nothing left in flight
            await sleep(POLL_MS);
        }
    } finally {
        listener = null;
        page.off('framenavigated', onNavigate);
        await page.evaluate(stopListening).catch(() => {});
    }
    return { steps, reason };
}

// --- in-page functions ---

function startListening({ hover }) {
    if (window.__exportStateRec) return;
    const CANDIDATES =
        'a, button, input, select, textarea, summary, label, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=radio], [role=switch], [tabindex]:not([tabindex="-1"]), [contenteditable]';
    const KEYS = ['Enter', 'Escape', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const idOf = (target) => (target?.closest?.(CANDIDATES) ?? target)?.getAttribute?.('data-export-id') ?? null;
    const send = (type, id, key) => window.__exportStateEvent({ type, id, key });
    const rec = { last: performance.now(), nextId: 1, hovered: null };
    rec.handlers = {
        click: (e) => send('click', idOf(e.target)),
        input: (e) => send('input', idOf(e.target)),
        change: (e) => send('change', idOf(e.target)),
        submit: (e) => send('submit', e.target.getAttribute?.('data-export-id') ?? null),
        keydown: (e) => {
            if (!KEYS.includes(e.key)) return;
            const onPage = e.target === document.body || e.target === document.documentElement;
            send('keydown', onPage ? 'document' : idOf(e.target), e.key);
        },
    };
    if (hover) {
        rec.handlers.mouseover = (e) => {
            const el = e.target.closest?.(CANDIDATES);
            if (!el || el === rec.hovered) return;
            rec.hovered = el;
            send('hover', el.getAttribute('data-export-id'));
        };
    }
    for (const [type, handler] of Object.entries(rec.handlers)) addEventListener(type, handler, true);
    rec.observer = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.attributeName !== 'data-export-id')) rec.last = performance.now();
    });
    rec.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__exportStateRec = rec;
}

function markReady() {
    if (!window.__exportStateRec) return false;
    window.__exportStateRec.ready = true;
    return true;
}

function stopListening() {
    const rec = window.__exportStateRec;
    if (!rec) return;
    for (const [type, handler] of Object.entries(rec.handlers)) removeEventListener(type, handler, true);
    rec.observer.disconnect();
    document.querySelectorAll('[data-export-id]').forEach((el) => el.removeAttribute('data-export-id'));
    delete window.__exportStateRec;
}

function tagElements() {
    const rec = window.__exportStateRec;
    if (!rec) return;
    for (const el of document.body.querySelectorAll('*')) {
        if (!el.hasAttribute('data-export-id')) el.setAttribute('data-export-id', String(rec.nextId++));
    }
}

function isQuiet(quietMs) {
    const rec = window.__exportStateRec;
    if (!rec || performance.now() - rec.last < quietMs) return false;
    // Ignore infinite animations (spinners, pulses); they never settle.
    return !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
}
