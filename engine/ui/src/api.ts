/** What the viewer API returns (engine/src/http/viewer/). */

export type Layer = "episode" | "memory" | "trait";

export interface ScopeCount {
  scope: string;
  episodes_pending: number;
  episodes_consolidated: number;
  memories: number;
  traits: number;
}

interface MemoryItem {
  id: string;
  scope: string;
  text: string;
  details: string | null;
  salience: number;
  stored_salience: number;
  created_at: number;
  last_accessed_at: number | null;
  noise: boolean;
  sources?: number;
  episodes_left?: number;
  traits?: number;
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
  memory: MemoryItem;
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
  /** Only with the connectome on: accumulated association and neighbours above the floor. */
  co_use?: { degree: number; strength: number; support: number };
}

export interface GraphLink {
  source: string;
  target: string;
  kind: "origin" | "evidence" | "related" | "co_use";
  /** Cosine, `related` only. */
  score?: number;
  /** Turns backing the edge, `co_use` only: strength does not read without its support. */
  n?: number;
  /** NPMI, `co_use` only. */
  strength?: number;
}

/** The sample behind the lateral layer: what lets the panel say the figures mean nothing yet. */
export interface ConnectomeSummary {
  turns: number;
  pairs: number;
  shown: number;
  min_n: number;
  /** Best support among the edges drawn: with every pair at 1, no figure above means anything. */
  max_n: number;
  hubs: Array<{ id: string; degree: number; strength: number; support: number }>;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  truncated: { memories: boolean; traits: boolean; episodes: boolean };
  connectome?: ConnectomeSummary;
}

/** One page of `/api/recent?layer=episode&pending=1`. */
export interface RecentPage {
  rows: EpisodeItem[];
  total: number;
}

export interface MemoriesPage {
  total: number;
  memories: MemoryItem[];
}

/** Rows requested per page. The server cap is 200. */
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
  // Relative to /viewer/: works the same behind a proxy that mounts misMEM on another path.
  const res = await fetch(`../api/${path}${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Writes: a JSON POST, which is what the server requires (viewer-actions.ts). */
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

/** First step of a forget: deletes nothing, returns what would be lost and the confirmation token. */
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
  // The top 50: this is a relevance list and the tail adds nothing.
  search: (q: string, scope: string | undefined, signal?: AbortSignal) =>
    get<{ hits: SearchHit[] }>("search", { q, scope, limit: "50" }, signal),
  // `co_use_min_n` goes to the server and not to the client so the hubs and the sample it
  // reports describe the same edges that get drawn.
  graph: (
    scope: string | undefined,
    episodes: boolean,
    coUse: { enabled: boolean; minN: number },
    signal?: AbortSignal,
  ) =>
    get<GraphData>(
      "graph",
      {
        scope,
        related: "1",
        episodes: episodes ? "1" : undefined,
        co_use: coUse.enabled ? "1" : undefined,
        co_use_min_n: coUse.enabled ? String(coUse.minN) : undefined,
      },
      signal,
    ),
  memory: (id: string, signal?: AbortSignal) => get<MemoryDetail>(`memory/${encodeURIComponent(id)}`, {}, signal),
  trait: (id: string, signal?: AbortSignal) => get<TraitDetail>(`trait/${encodeURIComponent(id)}`, {}, signal),
};
