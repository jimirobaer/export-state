// A session is one export run: a timestamped folder holding a gallery, a session.json
// manifest, one subfolder per captured state and an assets/ folder shared by all states.
// Recordings are stored flat as NN-<name>-01, NN-<name>-02, ... so every state folder sits
// at the same depth and shares ../assets.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// Output root precedence: --out > $EXPORT_STATE_OUT > ~/Exports. A leading ~ is expanded.
export function resolveOutRoot(out, env = process.env) {
    const dir = out ?? env.EXPORT_STATE_OUT ?? join(homedir(), 'Exports');
    return resolve(dir.replace(/^~(?=$|[/\\])/, homedir()));
}

export const slugify = (text, max = 48) =>
    String(text ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, max)
        .replace(/^-+|-+$/g, '');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STYLES_LINK = '<link rel="stylesheet" href="styles.css">';

export class Session {
    constructor({ outRoot, request, name }) {
        this.outRoot = outRoot;
        this.request = request; // Playwright APIRequestContext: shares cookies, no CORS
        this.name = name;
        this.headers = {};
        this.createdAt = new Date();
        this.count = 0; // numbered items: single states and recordings
        this.states = [];
        this.groups = [];
        this.assets = new Map(); // url -> Promise<relative path | null>
        this.dir = null;
    }

    // The folder is created lazily so interactive sessions can be named after the first captured host.
    ensureDir(fallbackName) {
        if (this.dir) return this.dir;
        const base = `${stamp(this.createdAt)}-${slugify(this.name || fallbackName) || 'session'}`;
        let dir = join(this.outRoot, base);
        for (let n = 2; existsSync(dir); n++) dir = join(this.outRoot, `${base}-${n}`);
        mkdirSync(join(dir, 'assets'), { recursive: true });
        return (this.dir = dir);
    }

    // Saves an asset once per session; returns its path relative to a state folder, or null on failure.
    saveAsset(url) {
        if (!this.assets.has(url)) this.assets.set(url, this.#download(url));
        return this.assets.get(url);
    }

    async #download(url) {
        try {
            const res = await this.request.get(url, { headers: this.headers, timeout: 20000 });
            if (!res.ok()) return null;
            const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'asset').replace(/[^\w.-]/g, '_').slice(-60);
            const hash = createHash('sha1').update(url).digest('hex').slice(0, 6);
            const file = `${hash}-${name}`;
            writeFileSync(join(this.dir, 'assets', file), await res.body());
            return `../assets/${file}`;
        } catch {
            return null;
        }
    }

    // Snapshot of what's on disk, so a discarded recording can be rolled back.
    checkpoint() {
        return { dir: this.dir, assets: new Set(this.assets.keys()) };
    }

    // Deletes assets first saved after the checkpoint (kept states only use earlier ones), and the
    // session folder itself if it was created since and holds no states.
    async rollback({ dir, assets }) {
        for (const [url, saved] of this.assets) {
            if (assets.has(url)) continue;
            this.assets.delete(url);
            const path = await saved;
            if (path) rmSync(join(this.dir, 'assets', basename(path)), { force: true });
        }
        if (!dir && this.dir && !this.states.length) {
            rmSync(this.dir, { recursive: true, force: true });
            this.dir = null;
        }
    }

    async fetchText(url) {
        try {
            const res = await this.request.get(url, { headers: this.headers, timeout: 20000 });
            return res.ok() ? await res.text() : null;
        } catch {
            return null;
        }
    }

    #writeState(folder, url, html, css) {
        const dir = join(this.ensureDir(url && new URL(url).hostname), folder);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.html'), html);
        if (css != null) writeFileSync(join(dir, 'styles.css'), css);
        return dir;
    }

    addState({ name, url, title, html, css }) {
        const index = ++this.count;
        const folder = `${pad(index)}-${slugify(name) || 'state'}`;
        const dir = this.#writeState(folder, url, html, css);
        this.states.push({ index, name, folder, url, title, capturedAt: new Date().toISOString() });
        this.#writeIndex();
        return dir;
    }

    // steps: [{ html, css, url, title, capturedAt, via: { id, type, key } | null }], via = the
    // interaction in the previous step that led here. Writes all steps, linking each to the next.
    addRecording({ name, steps, links = true }) {
        const index = ++this.count;
        const slug = slugify(name) || 'recording';
        const folders = steps.map((_, i) => `${pad(index)}-${slug}-${pad(i + 1)}`);

        // A link only exists if the interacted element is present in the previous step's markup.
        const edges = [];
        steps.forEach((step, i) => {
            const via = steps[i + 1]?.via;
            if (via?.id && (via.id === 'document' || step.html.includes(` data-export-id="${via.id}"`))) {
                edges.push({ from: folders[i], to: folders[i + 1], element: via.id, trigger: via.type, ...(via.key && { key: via.key }) });
            }
        });

        let cssOwner = null;
        steps.forEach((step, i) => {
            const edge = links ? edges.find((e) => e.from === folders[i]) : null;
            let html = step.html.replace(/ data-export-id="([^"]*)"/g, (m, id) => (edge?.element === id ? m : ''));
            // Identical CSS to the previous step: point at the first copy instead of duplicating it.
            const sharedCss = i > 0 && step.css === steps[i - 1].css;
            if (sharedCss) html = html.replace(STYLES_LINK, `<link rel="stylesheet" href="../${cssOwner}/styles.css">`);
            else cssOwner = folders[i];
            if (edge) html = injectLink(html, edge);
            this.#writeState(folders[i], step.url, html, sharedCss ? null : step.css);
            this.states.push({
                index,
                name: `${name} ${pad(i + 1)}`,
                folder: folders[i],
                url: step.url,
                title: step.title,
                capturedAt: step.capturedAt,
                group: index,
                step: i + 1,
                styles: `${cssOwner}/styles.css`,
            });
        });
        const group = { index, name, states: folders, links: edges, linksInjected: links };
        this.groups.push(group);
        this.#writeIndex();
        return group;
    }

    finalize() {
        if (!this.dir) return null;
        this.finishedAt = new Date();
        this.#writeIndex();
        return this.dir;
    }

    #writeIndex() {
        const title = this.name || basename(this.dir);
        const manifest = {
            name: title,
            createdAt: this.createdAt.toISOString(),
            finishedAt: this.finishedAt?.toISOString() ?? null,
            states: this.states.map((s) => ({ ...s, path: `${s.folder}/index.html` })),
            recordings: this.groups,
        };
        writeFileSync(join(this.dir, 'session.json'), JSON.stringify(manifest, null, 2) + '\n');
        writeFileSync(join(this.dir, 'index.html'), gallery(title, this.createdAt, this.states, this.groups));
    }
}

// Exported pages are script-free; recorded steps get one small, clearly delimited script that
// turns the recorded interaction into a jump to the next step.
function injectLink(html, edge) {
    const on =
        edge.element === 'document'
            ? ['keydown']
            : edge.trigger === 'submit'
              ? ['submit']
              : ['click', ...({ keydown: ['keydown'], input: ['input', 'change'], change: ['input', 'change'], hover: ['mouseover'] }[edge.trigger] ?? [])];
    const links = { [edge.element]: { href: `../${edge.to}/index.html`, on, key: edge.key ?? null } };
    const script = `<!-- export-state:links -->
<script>
(() => {
    const links = ${JSON.stringify(links)};
    for (const type of ['click', 'keydown', 'input', 'change', 'submit', 'mouseover']) {
        addEventListener(type, (e) => {
            const el = e.target.closest?.('[data-export-id]');
            const link = links[el?.dataset.exportId] ?? (type === 'keydown' ? links.document : null);
            if (!link || !link.on.includes(type) || (type === 'keydown' && link.key !== e.key)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            location.href = link.href;
        }, true);
    }
})();
</script>
<!-- /export-state:links -->
`;
    const at = html.lastIndexOf('</body>');
    return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}

function card(s) {
    return `<li>
        <a href="${s.folder}/index.html">
            <div class="thumb"><iframe src="${s.folder}/index.html" loading="lazy" tabindex="-1" scrolling="no"></iframe></div>
            <strong>${s.step ? `${pad(s.index)}.${pad(s.step)}` : pad(s.index)} · ${escapeHtml(s.name)}</strong>
        </a>
        <small>${escapeHtml(s.title || '')}<br>${escapeHtml(s.url || '')}<br>${escapeHtml(new Date(s.capturedAt).toLocaleString())}</small>
    </li>`;
}

function gallery(title, createdAt, states, groups) {
    const items = [];
    for (const s of states) {
        if (!s.group) items.push(`    ${card(s)}`);
        else if (s.step === 1) {
            const g = groups.find((x) => x.index === s.group);
            const steps = states.filter((x) => x.group === s.group);
            items.push(`    <li class="group">
        <h2>${pad(g.index)} · ${escapeHtml(g.name)} <small>recording · ${steps.length} states · ${g.links.length} links</small></h2>
        <p><a class="start" href="${s.folder}/index.html">▶ Start click-through at step 01</a></p>
        <ol>
        ${steps.map(card).join('\n        ')}
        </ol>
    </li>`);
        }
    }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
    body { font: 14px/1.4 system-ui, sans-serif; margin: 2rem; color: #222; background: #fafafa; }
    h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
    h2 { margin: 0; font-size: 1.1rem; }
    p { margin: 0 0 1.5rem; color: #666; }
    ul, ol { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1.5rem; }
    .group { grid-column: 1 / -1; padding: 1rem; border: 1px solid #ddd; border-radius: 8px; background: #fff; }
    .group p { margin: .5rem 0 1rem; }
    .group ol { margin: 0; }
    a { color: inherit; text-decoration: none; display: block; }
    a:hover strong, a.start:hover { text-decoration: underline; }
    a.start { display: inline; color: #0a58ca; }
    .thumb { width: 400px; height: 250px; overflow: hidden; border: 1px solid #ddd; border-radius: 6px; background: #fff; margin-bottom: .5rem; }
    .thumb iframe { width: 1600px; height: 1000px; border: 0; transform: scale(.25); transform-origin: 0 0; pointer-events: none; }
    small { display: block; color: #777; word-break: break-all; margin-top: .25rem; }
    h2 small { display: inline; font-weight: normal; margin-left: .5rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${states.length} state${states.length === 1 ? '' : 's'}${groups.length ? ` · ${groups.length} recording${groups.length === 1 ? '' : 's'}` : ''} · ${escapeHtml(createdAt.toLocaleString())}</p>
<ul>
${items.join('\n')}
</ul>
</body>
</html>
`;
}
