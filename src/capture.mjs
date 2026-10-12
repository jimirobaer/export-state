// Snapshot a page's rendered state: markup without scripts, all applied CSS in one file,
// and every referenced image/font saved into the session's shared assets folder.

const CSS_URL_RE = /(?<!@import\s*)url\(\s*(['"]?)(?!data:|#|%23|about:|blob:)([^'")]+)\1\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/g;
const TOKEN_RE = /__export_asset_(\d+)__/g;
const CANVAS_TOKEN_RE = /__export_canvas_(\d+)__/g;

// settle: scroll for lazy images and wait for animations first (record mode does its own settling).
// canvas: replace each <canvas> with a PNG of its current pixels (scripts are stripped, so it can't redraw).
export async function capture(page, session, { settle = true, canvas = true } = {}) {
    if (settle) {
        await loadLazyContent(page);
        await page.waitForTimeout(800); // let enter animations settle
    }
    const snap = await page.evaluate(serialize, { canvas });
    session.ensureDir(new URL(snap.url).hostname);
    const canvasFiles = await saveCanvases(page, session, snap.canvases);

    const keepLinks = [];
    const cssParts = await Promise.all(
        snap.sheets.map(async (sheet) => {
            if (!sheet.href) return wrapMedia(await rewriteCss(sheet.css, sheet.base, session), sheet.media);
            // Cross-origin sheet the page couldn't read: fetch it from Node instead.
            const text = await session.fetchText(sheet.href);
            if (text == null) {
                keepLinks.push(sheet.href);
                return '';
            }
            return wrapMedia(await rewriteCss(text, sheet.href, session), sheet.media);
        }),
    );

    const saved = await Promise.all(snap.urls.map((u) => session.saveAsset(u)));
    let html = snap.html.replace(TOKEN_RE, (_, i) => saved[i] ?? escapeAttr(snap.urls[i])).replace(CANVAS_TOKEN_RE, (_, i) => canvasFiles[i] ?? '');
    if (keepLinks.length) {
        const links = keepLinks.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join('');
        html = html.replace('<link rel="stylesheet" href="styles.css">', (m) => m + links);
    }
    return { html, css: cssParts.filter(Boolean).join('\n'), title: snap.title, url: snap.url };
}

// Canvases whose pixels couldn't be read in the page (tainted by cross-origin content, WebGL) are
// screenshotted instead; serialize() marked them with data-export-canvas. Returns paths by index.
async function saveCanvases(page, session, canvases) {
    const files = [];
    for (const [i, { dataUrl }] of canvases.entries()) {
        const buffer = dataUrl
            ? Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
            : await page.locator(`[data-export-canvas="${i}"]`).first().screenshot({ timeout: 3000 }).catch(() => null);
        files.push(buffer ? await session.saveBuffer(buffer, 'canvas.png') : null);
    }
    if (canvases.some((c) => !c.dataUrl)) {
        await page.evaluate(() => document.querySelectorAll('[data-export-canvas]').forEach((n) => n.removeAttribute('data-export-canvas'))).catch(() => {});
    }
    return files;
}

// Scroll through the page so lazy-loaded images load, then restore the scroll position. Non-fatal.
async function loadLazyContent(page) {
    try {
        await page.evaluate(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelectorAll('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
            const start = window.scrollY;
            for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 40; y += window.innerHeight, n++) {
                window.scrollTo(0, y);
                await sleep(100);
            }
            window.scrollTo(0, start);
            const pending = [...document.images].filter((img) => !img.complete);
            const loaded = pending.map((img) => new Promise((r) => {
                img.addEventListener('load', r, { once: true });
                img.addEventListener('error', r, { once: true });
            }));
            await Promise.race([Promise.all(loaded), sleep(3000)]);
        });
    } catch (e) {
        console.warn(`  (lazy-load scroll skipped: ${e.message.split('\n')[0]})`);
    }
}

// Rewrites url(...) to saved assets (resolved against the sheet's own URL) and inlines @import.
async function rewriteCss(css, base, session, depth = 0) {
    css = css.replace(/@charset[^;]*;/gi, '');
    css = await replaceAsync(css, CSS_URL_RE, async (m) => {
        const abs = resolveUrl(m[2], base);
        const local = abs && (await session.saveAsset(abs));
        return `url("${local ?? abs ?? m[2]}")`;
    });
    return replaceAsync(css, CSS_IMPORT_RE, async (m) => {
        const href = resolveUrl(m[2] ?? m[4], base);
        const text = href && depth < 5 ? await session.fetchText(href) : null;
        if (text == null) return href ? `@import url("${href}")${m[5]};` : m[0];
        return wrapMedia(await rewriteCss(text, href, session, depth + 1), m[5]);
    });
}

function wrapMedia(css, media) {
    media = media?.trim();
    if (!css || !media || media === 'all' || /^(layer|supports)\b/.test(media)) return css;
    return `@media ${media} {\n${css}\n}`;
}

function resolveUrl(url, base) {
    try {
        const abs = new URL(url.trim(), base).href;
        return /^https?:/.test(abs) ? abs : null;
    } catch {
        return null;
    }
}

async function replaceAsync(str, re, fn) {
    const results = await Promise.all([...str.matchAll(re)].map(fn));
    let i = 0;
    return str.replace(re, () => results[i++]);
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Runs in the page. Asset URLs are replaced by __export_asset_N__ tokens that Node swaps for local paths.
async function serialize({ canvas }) {
    const urls = [];
    const token = (raw, base = document.baseURI) => {
        let abs;
        try {
            abs = new URL(raw.trim(), base).href;
        } catch {
            return null;
        }
        if (!/^https?:/.test(abs)) return null;
        let i = urls.indexOf(abs);
        if (i < 0) i = urls.push(abs) - 1;
        return `__export_asset_${i}__`;
    };
    const toDataUrl = async (url) => {
        try {
            const blob = await (await fetch(url)).blob();
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(url);
                reader.readAsDataURL(blob);
            });
        } catch {
            return url;
        }
    };

    // Collect CSS from every stylesheet the browser applies, expanding readable @imports in place.
    const sheets = [];
    const collect = (sheet, base, media) => {
        let rules;
        try {
            rules = [...sheet.cssRules];
        } catch {
            if (sheet.href) sheets.push({ href: sheet.href, media }); // cross-origin: Node fetches it
            return;
        }
        let buffer = [];
        const flush = () => {
            if (buffer.length) sheets.push({ css: buffer.join('\n'), base, media });
            buffer = [];
        };
        for (const rule of rules) {
            if (rule instanceof CSSImportRule) {
                flush();
                if (rule.styleSheet) collect(rule.styleSheet, rule.styleSheet.href || base, rule.media.mediaText);
                else sheets.push({ href: new URL(rule.href, base).href, media: rule.media.mediaText });
            } else buffer.push(rule.cssText);
        }
        flush();
    };
    for (const sheet of document.styleSheets) if (!sheet.disabled) collect(sheet, sheet.href || document.baseURI, sheet.media.mediaText);
    for (const sheet of document.adoptedStyleSheets) collect(sheet, document.baseURI, sheet.media.mediaText);

    // Pair live elements with their clones before anything is removed.
    const root = document.documentElement.cloneNode(true);
    const pair = (selector) => {
        const clones = [...root.querySelectorAll(selector)];
        return [...document.querySelectorAll(selector)].map((el, i) => [el, clones[i]]).filter(([, c]) => c);
    };
    const images = pair('img');
    const fields = pair('input, textarea, select');
    const canvases = canvas ? pair('canvas') : [];

    root.querySelectorAll(
        'script, noscript, style, base, link[rel=stylesheet], link[rel=modulepreload], link[rel=preload], link[rel=prefetch], meta[http-equiv="Content-Security-Policy" i], meta[http-equiv=refresh i]',
    ).forEach((n) => n.remove());
    root.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));

    // Live form state isn't in the attributes; copy it over.
    for (const [el, c] of fields) {
        if (el.tagName === 'TEXTAREA') c.textContent = el.value;
        else if (el.tagName === 'SELECT') [...c.options].forEach((o, j) => (el.options[j]?.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
        else if (el.type === 'checkbox' || el.type === 'radio') el.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked');
        else if (el.type !== 'file') c.setAttribute('value', el.value);
    }

    // Images: collapse srcset/<picture> to the candidate the browser actually picked.
    for (const [el, img] of images) {
        const src = el.currentSrc || el.getAttribute('src') || el.getAttribute('srcset')?.split(',')[0].trim().split(/\s+/)[0];
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        if (!src || src.startsWith('data:')) continue;
        img.setAttribute('src', src.startsWith('blob:') ? await toDataUrl(src) : token(src) ?? src);
    }
    root.querySelectorAll('picture > source').forEach((n) => n.remove());

    // Canvas pixels aren't in the markup: swap each canvas for an <img> that Node fills with a PNG.
    // width/height attributes on an <img> only set its default size, so class/inline CSS still wins.
    const canvasList = [];
    for (const [el, clone] of canvases) {
        if (!el.width || !el.height || !root.contains(clone)) continue;
        let dataUrl = null;
        try {
            // getContext('2d') is null for WebGL canvases, whose drawing buffer toDataURL reads back blank.
            if (el.getContext('2d')) dataUrl = el.toDataURL('image/png'); // throws if the canvas is tainted
        } catch {}
        const n = canvasList.length;
        if (!dataUrl || dataUrl === 'data:,') {
            dataUrl = null;
            el.setAttribute('data-export-canvas', String(n)); // Node screenshots it instead
        }
        const img = document.createElement('img');
        for (const { name, value } of clone.attributes) if (name !== 'width' && name !== 'height') img.setAttribute(name, value);
        img.setAttribute('width', String(el.clientWidth || el.width));
        img.setAttribute('height', String(el.clientHeight || el.height));
        img.setAttribute('src', `__export_canvas_${n}__`);
        clone.replaceWith(img);
        canvasList.push({ dataUrl });
    }

    // Other asset references that would otherwise resolve against file:// (video posters, SVG <image>).
    for (const [selector, attr] of [['video[poster]', 'poster'], ['image[href]', 'href']]) {
        for (const n of root.querySelectorAll(selector)) {
            const t = token(n.getAttribute(attr));
            if (t) n.setAttribute(attr, t);
        }
    }

    // Inline style="background-image: url(...)" and friends.
    for (const el of root.querySelectorAll('[style*="url("]')) {
        const style = el.getAttribute('style').replace(/url\(\s*(['"]?)(?!data:|#)([^'")]+)\1\s*\)/g, (m, q, u) => {
            const t = token(u);
            return t ? `url(${t})` : m;
        });
        el.setAttribute('style', style);
    }

    for (const link of root.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')) {
        const href = link.getAttribute('href');
        const t = href && token(href);
        if (t) link.setAttribute('href', t);
    }

    // Open modals/sheets lock the page; unlock for prototyping.
    const body = root.querySelector('body');
    body?.style.removeProperty('pointer-events');
    body?.removeAttribute('data-scroll-locked');

    const head = root.querySelector('head');
    // The file is written as UTF-8 whatever the original encoding was.
    head.querySelectorAll('meta[charset], meta[http-equiv=content-type i]').forEach((n) => n.remove());
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.prepend(meta);
    const link = document.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', 'styles.css');
    head.append(link);

    return { html: '<!doctype html>\n' + root.outerHTML, sheets, urls, canvases: canvasList, title: document.title, url: location.href };
}
