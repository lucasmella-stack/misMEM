// Exports the memory as an Obsidian vault: one note per memory, trait and scope, linked by
// origin and similarity so Obsidian draws the graph. Everything goes under <vault>/misMEM/
// with a manifest, and a note is removed only after its frontmatter proves it is ours.
import type { Database as DB } from "better-sqlite3";
import { effectiveSalience } from "../memory/salience.js";
import { consolidatedEpisodes, exportMemories, exportScopes, exportTraits } from "../queries/export.js";
import { parseIds, relatedLinks } from "../queries/relations.js";
import {
  episodeNote,
  episodePath,
  memoryNote,
  memoryPath,
  scopeNote,
  scopePathResolver,
  traitNote,
  traitPath,
  type NotePaths,
} from "./notes.js";
import { writeVault, type ExportStats, type VaultOptions, type WrittenFile } from "./vault.js";

export { EXPORT_ROOT } from "./vault.js";
export type { ExportStats } from "./vault.js";

// Pairs grow with the square: above this, similarity is computed only among the highest-salience
// memories.
const RELATED_MAX_MEMORIES = 2000;

export interface ExportOptions extends VaultOptions {
  /** Episodes as notes of their own instead of quoted inside their memory. */
  episodes?: boolean;
  at?: number;
}

export function exportObsidian(db: DB, opts: ExportOptions): ExportStats {
  const at = opts.at ?? Date.now();
  const scope = opts.scope;
  const memories = exportMemories(db, scope);
  const traits = exportTraits(db, scope);
  // A fresh database (or the wrong path to another SQLite) has nothing to export: going on
  // would remove every note the manifest owns and leave the vault empty without an error.
  // Refuse before writing or removing, also in --dry-run.
  if (memories.length === 0 && traits.length === 0) {
    throw new Error(
      `no hay memorias ni rasgos que exportar${scope === undefined ? "" : ` en el ámbito ${scope}`}: no se toca la bóveda`,
    );
  }
  const episodes = consolidatedEpisodes(
    db,
    memories.map((m) => m.id),
  );

  const salience = new Map(memories.map((m) => [m.id, effectiveSalience(m, at)]));
  const memoryPaths = new Map(memories.map((m) => [m.id, memoryPath(m)]));
  const traitPaths = new Map(traits.map((t) => [t.id, traitPath(t)]));
  const scopes = [...new Set([...memories.map((m) => m.scope), ...traits.map((t) => t.scope)])].sort();
  const scopePath = scopePathResolver(exportScopes(db));
  const paths: NotePaths = { memory: memoryPaths, trait: traitPaths, episode: episodePath, scope: scopePath };

  const byMemory = new Map<string, typeof episodes>();
  for (const e of episodes) byMemory.set(e.consolidated_into, [...(byMemory.get(e.consolidated_into) ?? []), e]);
  const citedBy = new Map<string, Array<(typeof traits)[number]>>();
  for (const t of traits) {
    for (const id of parseIds(t.evidence_memory_ids)) citedBy.set(id, [...(citedBy.get(id) ?? []), t]);
  }
  const relatedIds = [...memories]
    .sort((a, b) => (salience.get(b.id) ?? 0) - (salience.get(a.id) ?? 0))
    .slice(0, RELATED_MAX_MEMORIES)
    .map((m) => m.id);
  const related = new Map<string, Array<{ id: string; score: number }>>();
  for (const l of relatedLinks(db, relatedIds)) {
    related.set(l.source, [...(related.get(l.source) ?? []), { id: l.target, score: l.score ?? 0 }]);
    related.set(l.target, [...(related.get(l.target) ?? []), { id: l.source, score: l.score ?? 0 }]);
  }

  const files = new Map<string, WrittenFile>();

  for (const m of memories) {
    const content = memoryNote({
      memory: m,
      salience: salience.get(m.id) ?? 0,
      sources: byMemory.get(m.id) ?? [],
      citing: citedBy.get(m.id) ?? [],
      related: related.get(m.id) ?? [],
      memories,
      paths,
      episodes: Boolean(opts.episodes),
    });
    files.set(`${memoryPaths.get(m.id)}.md`, { content, id: m.id, scope: m.scope });
  }

  for (const t of traits) {
    const content = traitNote({
      trait: t,
      evidenceIds: parseIds(t.evidence_memory_ids),
      memories,
      paths,
    });
    files.set(`${traitPaths.get(t.id)}.md`, { content, id: t.id, scope: t.scope });
  }

  if (opts.episodes) {
    for (const e of episodes) {
      files.set(`${episodePath(e)}.md`, {
        content: episodeNote({ episode: e, memory: memoryPaths.get(e.consolidated_into) }),
        id: e.id,
        scope: e.scope,
      });
    }
  }

  for (const s of scopes) {
    const content = scopeNote({
      scope: s,
      traits: traits.filter((t) => t.scope === s),
      memories: memories
        .filter((m) => m.scope === s)
        .sort((a, b) => (salience.get(b.id) ?? 0) - (salience.get(a.id) ?? 0)),
      paths,
    });
    files.set(`${scopePath(s)}.md`, { content, id: s, scope: s });
  }

  return writeVault(opts, files, {
    memories: memories.length,
    traits: traits.length,
    scopes: scopes.length,
    episodes: opts.episodes ? episodes.length : 0,
  });
}
