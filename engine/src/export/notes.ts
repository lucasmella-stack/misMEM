// Format of every Obsidian note: names, links, frontmatter and body. Nothing here touches the
// disk or the database; `exportObsidian` feeds it plain rows so the format can be tested alone.
import { createHash } from "node:crypto";

export interface NoteMemory {
  id: string;
  scope: string;
  gist: string;
  details: string | null;
  created_at: number;
}

export interface NoteTrait {
  id: string;
  scope: string;
  name: string;
  strength: number;
  polarity: string;
  evidence_memory_ids: string;
  updated_at: number;
}

export interface NoteEpisode {
  id: string;
  scope: string;
  body: string;
  created_at: number;
}

/** The path of each note, without `.md`, shared by the note bodies and the file names. */
export interface NotePaths {
  readonly memory: ReadonlyMap<string, string>;
  readonly trait: ReadonlyMap<string, string>;
  readonly episode: (episode: NoteEpisode) => string;
  readonly scope: (scope: string) => string;
}

/** A file name valid in Obsidian and Windows, readable and short. */
export function safeName(text: string, max = 60): string {
  const clean = text
    // Control characters (including \n\r\t and \0) break writing, syncing and some backups:
    // a NUL in the name makes the whole export fail.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this regex.
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = clean.length <= max ? clean : clean.slice(0, max).replace(/\s+\S*$/, "");
  return cut.replace(/[.\s]+$/, "") || "sin título";
}

const shortId = (id: string): string => id.slice(-6);
export const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** YAML in double quotes: JSON is a valid subset. */
export const yaml = (value: string): string => JSON.stringify(value);
/**
 * Text of a memory inside the note. Obsidian reads a `<word>` (e.g. "fuser -k <port>/tcp") as an
 * HTML tag that opens a block and stops parsing Markdown, and a stray `[s]` as a broken link;
 * both are escaped with a backslash, not an entity, so the note keeps the literal text.
 */
export const text = (value: string): string => value.replace(/[<[\]]/g, (c) => `\\${c}`);
/** An Obsidian tag allows no spaces. */
const tag = (value: string): string => value.replace(/\s+/g, "-");
// A wikilink label cannot contain the link's closing brackets nor break the line: a trailing
// `\` escaped the `]]` and a newline left the link open across two lines.
const linkLabel = (label: string): string => label.replace(/[[\]|\\<>]/g, " ").replace(/\s+/g, " ").trim();
export const link = (path: string, label?: string): string =>
  label ? `[[${path}|${linkLabel(label)}]]` : `[[${path}]]`;

const short = (value: string): string => safeName(value, 80);

export const memoryPath = (memory: Pick<NoteMemory, "id" | "gist">): string =>
  `Memorias/${safeName(memory.gist)} (${shortId(memory.id)})`;
export const traitPath = (trait: Pick<NoteTrait, "id" | "name">): string =>
  `Rasgos/${safeName(trait.name)} (${shortId(trait.id)})`;
export const episodePath = (episode: NoteEpisode): string =>
  `Episodios/${day(episode.created_at)} ${safeName(episode.body, 40)} (${shortId(episode.id)})`;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const scopeBase = (s: string): string => safeName(s.replace(/\//g, " - "));
const scopeKey = (s: string): string => scopeBase(s).normalize("NFC").toLowerCase();

/**
 * Scope notes carry no id suffix, so truncation, case or Unicode normalisation alone would
 * collide; the hash separates them and disambiguates Windows names (`CON`, `NUL`). Collisions
 * count across every scope, so a one-scope export keeps its suffix and does not break links.
 */
export function scopePathResolver(allScopes: readonly string[]): (scope: string) => string {
  const scopeCount = new Map<string, number>();
  for (const s of allScopes) scopeCount.set(scopeKey(s), (scopeCount.get(scopeKey(s)) ?? 0) + 1);
  return (s: string): string => {
    const base = scopeBase(s);
    if ((scopeCount.get(scopeKey(s)) ?? 0) === 1 && !WINDOWS_RESERVED.test(base)) return `Ámbitos/${base}`;
    const hash = createHash("sha256").update(s, "utf8").digest("hex").slice(0, 6);
    return `Ámbitos/${base} (${hash})`;
  };
}

export interface MemoryNoteInput {
  memory: NoteMemory;
  salience: number;
  sources: readonly NoteEpisode[];
  citing: readonly NoteTrait[];
  related: readonly { id: string; score: number }[];
  memories: readonly NoteMemory[];
  paths: NotePaths;
  episodes: boolean;
}

export function memoryNote(input: MemoryNoteInput): string {
  const m = input.memory;
  const lines = [
    "---",
    `id: ${yaml(m.id)}`,
    `scope: ${yaml(m.scope)}`,
    `salience: ${input.salience.toFixed(2)}`,
    `created: ${day(m.created_at)}`,
    `tags: [mismem/memoria, ${yaml(`ámbito/${tag(m.scope)}`)}]`,
    "---",
    "",
    `# ${text(m.gist)}`,
    "",
  ];
  if (m.details && m.details !== m.gist) lines.push(text(m.details), "");
  lines.push("## Origen", "");
  if (input.sources.length === 0) lines.push("Sin episodios: ya los borró `forget`.");
  for (const e of input.sources) {
    if (input.episodes) lines.push(`- ${link(input.paths.episode(e), `${day(e.created_at)} ${short(e.body)}`)}`);
    else lines.push(`> ${day(e.created_at)}`, ...text(e.body).split("\n").map((l) => `> ${l}`), "");
  }
  if (input.citing.length > 0) {
    lines.push("", "## Rasgos que la citan", "");
    for (const t of input.citing) lines.push(`- ${link(input.paths.trait.get(t.id) as string, t.name)}`);
  }
  const near = [...input.related].sort((a, b) => b.score - a.score);
  if (near.length > 0) {
    lines.push("", "## Parecidas", "");
    for (const n of near) {
      const path = input.paths.memory.get(n.id);
      const other = input.memories.find((x) => x.id === n.id);
      if (path && other) lines.push(`- ${link(path, short(other.gist))} (${n.score.toFixed(2)})`);
    }
  }
  lines.push("", `Ámbito: ${link(input.paths.scope(m.scope), m.scope)}`, "");
  return lines.join("\n");
}

export interface TraitNoteInput {
  trait: NoteTrait;
  evidenceIds: readonly string[];
  memories: readonly NoteMemory[];
  paths: NotePaths;
}

export function traitNote(input: TraitNoteInput): string {
  const t = input.trait;
  const lines = [
    "---",
    `id: ${yaml(t.id)}`,
    `scope: ${yaml(t.scope)}`,
    `strength: ${t.strength}`,
    `polarity: ${yaml(t.polarity)}`,
    `updated: ${day(t.updated_at)}`,
    `tags: [mismem/rasgo, ${yaml(`ámbito/${tag(t.scope)}`)}]`,
    "---",
    "",
    `# ${text(t.name)}`,
    "",
    "## Lo sostienen",
    "",
  ];
  for (const id of input.evidenceIds) {
    const path = input.paths.memory.get(id);
    const m = input.memories.find((x) => x.id === id);
    lines.push(path && m ? `- ${link(path, short(m.gist))}` : `- Memoria olvidada (${id})`);
  }
  lines.push("", `Ámbito: ${link(input.paths.scope(t.scope), t.scope)}`, "");
  return lines.join("\n");
}

export interface EpisodeNoteInput {
  episode: NoteEpisode;
  memory?: string;
}

export function episodeNote(input: EpisodeNoteInput): string {
  const e = input.episode;
  const lines = [
    "---",
    `id: ${yaml(e.id)}`,
    `scope: ${yaml(e.scope)}`,
    `created: ${day(e.created_at)}`,
    "tags: [mismem/episodio]",
    "---",
    "",
    text(e.body),
    "",
    input.memory ? `Consolidado en ${link(input.memory)}` : "",
    "",
  ];
  return lines.join("\n");
}

export interface ScopeNoteInput {
  scope: string;
  traits: readonly Pick<NoteTrait, "id" | "name">[];
  memories: readonly Pick<NoteMemory, "id" | "gist">[];
  paths: NotePaths;
}

export function scopeNote(input: ScopeNoteInput): string {
  const s = input.scope;
  const lines = [
    "---",
    `id: ${yaml(s)}`,
    `scope: ${yaml(s)}`,
    "tags: [mismem/ámbito]",
    "---",
    "",
    `# ${s}`,
    "",
  ];
  if (input.traits.length > 0) {
    lines.push("## Rasgos", "");
    for (const t of input.traits) lines.push(`- ${link(input.paths.trait.get(t.id) as string, t.name)}`);
    lines.push("");
  }
  lines.push("## Memorias", "");
  for (const m of input.memories) lines.push(`- ${link(input.paths.memory.get(m.id) as string, short(m.gist))}`);
  return `${lines.join("\n")}\n`;
}
