/**
 * misMEM viewer — read-only control panel.
 *
 * Endpoints (todos detrás de la misma BasicAuth de /mcp):
 *   GET /viewer            → HTML autocontenido (vanilla JS, ~6 KB)
 *   GET /api/stats         → totales por capa + top scopes
 *   GET /api/recent        → últimas N filas de una capa (?layer=&scope=&limit=)
 *   GET /api/search        → recall híbrido read-only (?q=&scope=&limit=)
 *
 * Cero dependencias nuevas, cero escrituras desde el browser.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { recallHybrid } from "./tools.js";
import type { EmbedFn } from "./embeddings/index.js";

type Layer = "episode" | "memory" | "trait";
const LAYERS: readonly Layer[] = ["episode", "memory", "trait"] as const;

function isLayer(v: string | null): v is Layer {
  return v !== null && (LAYERS as readonly string[]).includes(v);
}

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export function handleStats(db: DB, res: ServerResponse): void {
  const counts = {
    episodes: (
      db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }
    ).n,
    memories: (
      db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
    ).n,
    traits: (
      db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number }
    ).n,
    consolidated: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NOT NULL",
        )
        .get() as { n: number }
    ).n,
  };
  const topScopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM episodes
       GROUP BY scope ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ scope: string; n: number }>;
  const last = db
    .prepare(
      "SELECT id, scope, created_at FROM episodes ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { id: string; scope: string; created_at: number } | undefined;
  json(res, 200, { counts, topScopes, last: last ?? null });
}

export function handleRecent(db: DB, res: ServerResponse, url: URL): void {
  const layerParam = url.searchParams.get("layer") ?? "episode";
  if (!isLayer(layerParam)) {
    json(res, 400, { error: `invalid layer: ${layerParam}` });
    return;
  }
  const layer: Layer = layerParam;
  const scope = url.searchParams.get("scope");
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  let rows: unknown[];
  if (layer === "episode") {
    rows = db
      .prepare(
        `SELECT id, scope, body AS text, created_at, consolidated_into
         FROM episodes
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else if (layer === "memory") {
    rows = db
      .prepare(
        `SELECT id, scope, gist AS text, details, salience, created_at, last_accessed_at
         FROM memories
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY salience DESC, created_at DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else {
    rows = db
      .prepare(
        `SELECT id, scope, name AS text, strength, polarity, created_at, updated_at
         FROM traits
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY strength DESC, updated_at DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  }
  json(res, 200, { layer, scope, rows });
}

export async function handleSearch(
  db: DB,
  res: ServerResponse,
  url: URL,
  embedFn?: EmbedFn,
  embeddingModel?: string,
): Promise<void> {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) {
    json(res, 400, { error: "missing q" });
    return;
  }
  const scope = url.searchParams.get("scope") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"), 20, 50);
  try {
    const out = await recallHybrid(
      db,
      { query, scope, limit },
      embedFn,
      { reinforce: false, embeddingModel },
    );
    json(res, 200, out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>misMEM viewer</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--border:#272d36;--fg:#e6edf3;--muted:#7d8590;--accent:#58a6ff;--ep:#3fb950;--mem:#d29922;--tr:#bc8cff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:var(--panel);position:sticky;top:0;z-index:10}
h1{margin:0;font-size:15px;font-weight:600}
.stats{display:flex;gap:14px;color:var(--muted);font-size:12px;margin-left:auto;flex-wrap:wrap}
.stats b{color:var(--fg)}
nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--panel)}
nav button{background:transparent;border:1px solid var(--border);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
nav button.active{background:var(--accent);border-color:var(--accent);color:#0e1116}
.controls{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
input,select{background:var(--bg);border:1px solid var(--border);color:var(--fg);padding:6px 10px;border-radius:6px;font:inherit}
input{flex:1;min-width:200px}
button.primary{background:var(--accent);border:1px solid var(--accent);color:#0e1116;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600}
main{padding:8px 16px}
.row{border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:6px;background:var(--panel);cursor:pointer}
.row:hover{border-color:var(--accent)}
.row .meta{display:flex;gap:10px;font-size:11px;color:var(--muted);margin-bottom:4px;flex-wrap:wrap;align-items:center}
.tag{padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;text-transform:uppercase}
.tag.ep{background:rgba(63,185,80,.15);color:var(--ep)}
.tag.mem{background:rgba(210,153,34,.15);color:var(--mem)}
.tag.tr{background:rgba(188,140,255,.15);color:var(--tr)}
.text{white-space:pre-wrap;word-break:break-word;font-size:13px;max-height:4.5em;overflow:hidden;position:relative}
.row.open .text{max-height:none}
.text.clipped::after{content:"";position:absolute;bottom:0;left:0;right:0;height:1.4em;background:linear-gradient(transparent,var(--panel))}
.id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:32px;font-size:13px}
.spinner{color:var(--muted);padding:16px;text-align:center}
</style>
</head>
<body>
<header>
  <h1>misMEM</h1>
  <div class="stats" id="stats">loading…</div>
</header>
<nav>
  <button data-tab="episode" class="active">Episodes</button>
  <button data-tab="memory">Memories</button>
  <button data-tab="trait">Traits</button>
  <button data-tab="search">Search</button>
</nav>
<div class="controls">
  <input id="scope" placeholder="filter scope (e.g. project)" />
  <input id="q" placeholder="search query (hybrid)" style="display:none" />
  <button class="primary" id="reload">Reload</button>
</div>
<main id="list"><div class="spinner">loading…</div></main>
<script>
const $ = (s) => document.querySelector(s);
const list = $('#list');
const scopeInput = $('#scope');
const qInput = $('#q');
let tab = 'episode';

const fmtTime = (ts) => ts ? new Date(ts).toISOString().replace('T',' ').slice(0,19) : '';
const tagFor = (l) => l==='episode'?'<span class="tag ep">ep</span>':l==='memory'?'<span class="tag mem">mem</span>':'<span class="tag tr">tr</span>';
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function loadStats(){
  try{
    const r = await fetch('api/stats');
    const j = await r.json();
    const c = j.counts;
    $('#stats').innerHTML =
      '<span><b>'+c.episodes+'</b> ep</span>' +
      '<span><b>'+c.memories+'</b> mem</span>' +
      '<span><b>'+c.traits+'</b> tr</span>' +
      '<span><b>'+c.consolidated+'</b> consolidated</span>' +
      (j.last ? '<span>last: '+fmtTime(j.last.created_at)+'</span>' : '');
  }catch(e){ $('#stats').textContent = 'stats error'; }
}

function renderRows(rows, layerHint){
  if(!rows.length){ list.innerHTML = '<div class="empty">no results</div>'; return; }
  list.innerHTML = rows.map(r => {
    const layer = r.layer || layerHint;
    const text = esc(r.text || r.gist || r.name || '');
    const extras = [];
    if(r.salience !== undefined) extras.push('salience '+r.salience.toFixed(2));
    if(r.strength !== undefined) extras.push('strength '+r.strength);
    if(r.polarity) extras.push(r.polarity);
    if(r.consolidated_into) extras.push('consolidated');
    return '<div class="row" data-id="'+esc(r.id)+'">' +
      '<div class="meta">' + tagFor(layer) +
        '<span>'+esc(r.scope)+'</span>' +
        '<span>'+fmtTime(r.created_at)+'</span>' +
        (extras.length ? '<span>'+esc(extras.join(' · '))+'</span>' : '') +
        '<span class="id">'+esc(r.id)+'</span>' +
      '</div>' +
      '<div class="text clipped">'+text+'</div>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.row').forEach(el => {
    el.addEventListener('click', () => {
      el.classList.toggle('open');
      el.querySelector('.text').classList.toggle('clipped');
    });
  });
}

async function load(){
  list.innerHTML = '<div class="spinner">loading…</div>';
  try{
    const scope = scopeInput.value.trim();
    if(tab === 'search'){
      const q = qInput.value.trim();
      if(!q){ list.innerHTML = '<div class="empty">type a query</div>'; return; }
      const params = new URLSearchParams({ q, limit: '30' });
      if(scope) params.set('scope', scope);
      const r = await fetch('api/search?'+params);
      const j = await r.json();
      renderRows(j.hits || [], null);
    } else {
      const params = new URLSearchParams({ layer: tab, limit: '50' });
      if(scope) params.set('scope', scope);
      const r = await fetch('api/recent?'+params);
      const j = await r.json();
      renderRows(j.rows || [], tab);
    }
  }catch(e){ list.innerHTML = '<div class="empty">error: '+esc(e.message)+'</div>'; }
}

document.querySelectorAll('nav button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    tab = b.dataset.tab;
    qInput.style.display = tab === 'search' ? '' : 'none';
    load();
  });
});
$('#reload').addEventListener('click', () => { loadStats(); load(); });
qInput.addEventListener('keydown', e => { if(e.key === 'Enter') load(); });
scopeInput.addEventListener('keydown', e => { if(e.key === 'Enter') load(); });

loadStats();
load();
setInterval(loadStats, 30000);
</script>
</body>
</html>`;

export function handleViewerHtml(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  );
  res.end(HTML);
}
