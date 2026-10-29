/** Lo que devuelve la API del viewer (engine/src/viewer.ts y viewer-api.ts). */

export type Layer = "episode" | "memory" | "trait";

export interface ScopeCount {
  scope: string;
  episodes_pending: number;
  episodes_consolidated: number;
  memories: number;
  traits: number;
}

interface EmbeddingRecord {
  model: string;
  dims: number;
  created_at: number;
}

interface MemoryItem {
  id: string;
  scope: string;
  text: string;
  details: string | null;
  salience: number;
  stored_salience: number;
  use_count: number;
  created_at: number;
  last_accessed_at: number | null;
  noise: boolean;
  sources?: number;
  episodes_left?: number;
  traits?: number;
}

/** The semantic index status; it never includes the provider URL. */
export interface EmbeddingStatus {
  enabled: boolean;
  provider: "ollama" | "openai";
  model: string;
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  stale_dims: number;
  models: Array<{ model: string; dims: number; count: number }>;
}

export interface TraitItem {
  id: string;
  scope: string;
  text: string;
  strength: number;
  polarity: string;
  created_at: number;
  updated_at: number;
}

export interface EpisodeItem {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  consolidated_into?: string | null;
  linked_here?: boolean;
}

export interface Missing {
  id: string;
  missing: true;
}

export interface SearchHit {
  layer: Layer;
  id: string;
  scope: string;
  text: string;
  salience?: number;
  created_at: number;
  via?: "semantic";
}

export interface MemoryDetail {
  memory: MemoryItem & { embedding: EmbeddingRecord | null };
  episodes: Array<EpisodeItem | Missing>;
  traits: TraitItem[];
}

export interface TraitDetail {
  trait: TraitItem;
  evidence: Array<MemoryItem | Missing>;
}

export interface GraphNode {
  id: string;
  layer: Layer;
  scope: string;
  label: string;
  salience?: number;
  strength?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: "origin" | "evidence" | "related";
  score?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  truncated: { memories: boolean; traits: boolean; episodes: boolean };
}

/** Una página de `/api/recent?layer=episode&pending=1`. */
export interface RecentPage {
  rows: EpisodeItem[];
  total: number;
}

export interface MemoriesPage {
  total: number;
  memories: MemoryItem[];
}

/** Cuántas filas se piden por página. El tope del servidor es 200. */
const PAGE_SIZE = 50;

export const isMissing = (item: object): item is Missing => "missing" in item;

async function get<T>(
  path: string,
  params: Record<string, string | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const qs = query.toString();
  // Relativo a /viewer/: funciona igual detrás de un proxy que monte misMEM en otra ruta.
  const res = await fetch(`../api/${path}${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Las escrituras: POST con JSON, que es lo que pide el servidor (viewer-actions.ts). */
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`../api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** El primer paso de un forget: no borra, devuelve lo que se perdería y el token para confirmar. */
export interface ForgetChallenge {
  confirm_token: string;
  expires_in: number;
  impact: { episodes?: number; traits_citing?: number; memories_cited?: number };
}

async function forgetChallenge(path: string): Promise<ForgetChallenge> {
  const res = await fetch(`../api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = (await res.json().catch(() => null)) as (Partial<ForgetChallenge> & { error?: string }) | null;
  if (res.status === 409 && payload?.confirm_token) return payload as ForgetChallenge;
  throw new Error(payload?.error ?? `HTTP ${res.status}`);
}

export type Polarity = "neutral" | "light" | "shadow";

export interface ConsolidationState {
  running: boolean;
  scope: string | null;
  started_at: number | null;
  finished_at: number | null;
  log: string[];
  summary: {
    memories_created: number;
    episodes_consolidated: number;
    llm_calls: number;
    scopes_failed: number;
  } | null;
  error: string | null;
}

export const actions = {
  editMemory: (id: string, gist: string, details: string | null) =>
    post<{ id: string; reembedded: boolean }>(`memory/${encodeURIComponent(id)}/edit`, { gist, details }),
  unconsolidate: (id: string) =>
    post<{ id: string; episodes_released: number }>(`memory/${encodeURIComponent(id)}/unconsolidate`),
  forgetMemoryChallenge: (id: string) => forgetChallenge(`memory/${encodeURIComponent(id)}/forget`),
  forgetMemory: (id: string, token: string) =>
    post<{ id: string; episodes_deleted: number }>(`memory/${encodeURIComponent(id)}/forget`, {
      confirm_token: token,
    }),
  forgetTraitChallenge: (id: string) => forgetChallenge(`trait/${encodeURIComponent(id)}/forget`),
  forgetTrait: (id: string, token: string) =>
    post<{ id: string }>(`trait/${encodeURIComponent(id)}/forget`, { confirm_token: token }),
  consolidate: (scope?: string) => post<ConsolidationState>("consolidate", scope ? { scope } : {}),
  crystallize: (scope: string, name: string, polarity: Polarity, ids: string[]) =>
    post<{ trait_id: string; created: boolean; strength: number }>("crystallize", {
      scope,
      name,
      polarity,
      evidence_memory_ids: ids,
    }),
};

export const api = {
  scopes: (signal?: AbortSignal) => get<{ scopes: ScopeCount[] }>("scopes", {}, signal),
  embeddings: (signal?: AbortSignal) => get<EmbeddingStatus>("embeddings", {}, signal),
  consolidation: (signal?: AbortSignal) => get<ConsolidationState>("consolidate", {}, signal),
  memories: (scope: string | undefined, offset: number, signal?: AbortSignal) =>
    get<MemoriesPage>("memories", { scope, limit: String(PAGE_SIZE), offset: String(offset) }, signal),
  pendingEpisodes: (scope: string | undefined, offset: number, signal?: AbortSignal) =>
    get<RecentPage>(
      "recent",
      { layer: "episode", pending: "1", scope, limit: String(PAGE_SIZE), offset: String(offset) },
      signal,
    ),
  traits: (scope: string | undefined, signal?: AbortSignal) =>
    get<{ rows: TraitItem[] }>("recent", { layer: "trait", scope, limit: "200" }, signal),
  // Los 50 mejores: es una lista por relevancia y la cola no aporta.
  search: (q: string, scope: string | undefined, signal?: AbortSignal) =>
    get<{ hits: SearchHit[] }>("search", { q, scope, limit: "50" }, signal),
  graph: (scope: string | undefined, episodes: boolean, signal?: AbortSignal) =>
    get<GraphData>("graph", { scope, related: "1", episodes: episodes ? "1" : undefined }, signal),
  memory: (id: string, signal?: AbortSignal) => get<MemoryDetail>(`memory/${encodeURIComponent(id)}`, {}, signal),
  trait: (id: string, signal?: AbortSignal) => get<TraitDetail>(`trait/${encodeURIComponent(id)}`, {}, signal),
};
