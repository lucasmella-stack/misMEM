// The vault on disk: the manifest, the ownership proof and the write/remove pass. Note text is
// built by `notes.ts`; this module never reads the database.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { yaml } from "./notes.js";

export const EXPORT_ROOT = "misMEM";
const MANIFEST = ".mismem-export.json";

export interface VaultOptions {
  /** The vault: the folder Obsidian opens. */
  dir: string;
  scope?: string;
  dryRun?: boolean;
}

export interface ExportStats {
  dir: string;
  memories: number;
  traits: number;
  scopes: number;
  episodes: number;
  written: number;
  unchanged: number;
  removed: number;
  /** Notes not written or removed: not provably ours, or a symlink would take them out of the export root. */
  skipped: number;
  dry_run: boolean;
}

/** What is written for each note: its content and what the manifest will need later. */
export interface WrittenFile {
  content: string;
  /** Full id of the memory, trait or episode; on a scope note, the scope itself. */
  id: string;
  scope: string;
}

interface ManifestEntry {
  id: string;
  scope: string;
}

interface Manifest {
  version: 2;
  files: Record<string, ManifestEntry>;
}

/**
 * Reads the manifest, or null when it cannot be interpreted (unreadable or unknown shape); the
 * caller decides, and a present file makes the export refuse rather than overwrite it and orphan
 * the notes it pointed at. An array is the old format: entries with no id or scope, unprovable.
 */
function readManifest(path: string): Map<string, ManifestEntry | null> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const entries = new Map<string, ManifestEntry | null>();
  if (Array.isArray(parsed)) {
    for (const rel of parsed) if (typeof rel === "string") entries.set(rel, null);
    return entries;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const files: unknown = (parsed as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  for (const [rel, meta] of Object.entries(files as Record<string, unknown>)) {
    const entry = meta as Partial<ManifestEntry> | null;
    entries.set(
      rel,
      entry && typeof entry.id === "string" && typeof entry.scope === "string"
        ? { id: entry.id, scope: entry.scope }
        : null,
    );
  }
  return entries;
}

/**
 * The real path of `path` or of its closest existing ancestor. On a first export only the
 * vault exists, so the folders of the notes cannot be resolved on their own. Only ENOENT
 * means "missing"; any other failure counts as outside the export root.
 */
function realPathOf(path: string): string | null {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // A missing path is safe to walk up only if no link is in the way: a dangling link
      // is not "not created yet", it points somewhere the export must not write through.
      if (isSymlink(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Only a missing path is not a link: an unreadable or looping one is treated as one. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The file is ours only if its frontmatter still declares the id the manifest recorded. */
function ownedBy(file: string, id: string): boolean {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const end = content.indexOf("\n---", 3);
  if (!content.startsWith("---\n") || end < 0) return false;
  return content.slice(4, end).split("\n").includes(`id: ${yaml(id)}`);
}

export function writeVault(
  opts: VaultOptions,
  files: Map<string, WrittenFile>,
  counts: Pick<ExportStats, "memories" | "traits" | "scopes" | "episodes">,
): ExportStats {
  const root = resolve(opts.dir, EXPORT_ROOT);
  const manifestPath = join(root, MANIFEST);
  // Writing through a symlinked manifest would land wherever it points; check before reading,
  // so a link to a FIFO cannot block the export first.
  if (isSymlink(manifestPath)) {
    throw new Error(`el manifiesto es un enlace simbólico o no se puede comprobar: ${manifestPath}. Revísalo a mano: no se toca la bóveda`);
  }
  const manifestExists = existsSync(manifestPath);
  const previous = readManifest(manifestPath);
  // Writing a new manifest over an unreadable one loses the trail of the old notes forever:
  // nobody will know they were ours and no export will remove them. Stop before writing;
  // fixing or deleting it is the person's decision.
  if (previous === null && manifestExists) {
    throw new Error(
      `el manifiesto no se puede interpretar: ${manifestPath}. Arréglalo o bórralo a mano: no se toca la bóveda`,
    );
  }

  const inside = (rel: string): string | null => {
    const file = resolve(root, rel);
    return file.startsWith(root + sep) ? file : null;
  };
  // `resolve` follows no symlink, so a note or a folder replaced by one still looks inside.
  // Compare real paths instead, against the export root; the root itself may be a symlink and
  // that one is allowed.
  const realRoot = realPathOf(root) ?? root;
  const insideReal = (path: string): boolean => {
    const real = realPathOf(path);
    return real !== null && (real === realRoot || real.startsWith(realRoot + sep));
  };

  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const [rel, { content }] of files) {
    const file = inside(rel);
    if (!file) continue;
    // A note replaced by a symlink, or reached through one, would write where it points.
    if (isSymlink(file) || !insideReal(dirname(file))) {
      skipped++;
      continue;
    }
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) {
      unchanged++;
      continue;
    }
    written++;
    if (opts.dryRun) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  // The manifest merges with the previous one instead of replacing it: with --scope, what was
  // exported before for other scopes is still ours and must not be orphaned or removed.
  const manifest: Manifest = { version: 2, files: {} };
  for (const [rel, { id, scope }] of files) manifest.files[rel] = { id, scope };

  let removed = 0;
  for (const [rel, entry] of previous ?? []) {
    if (files.has(rel)) continue;
    // Old format: without an id there is no telling our note from one of the person's.
    if (entry === null) {
      skipped++;
      continue;
    }
    if (opts.scope !== undefined && entry.scope !== opts.scope) {
      manifest.files[rel] = entry;
      continue;
    }
    const file = inside(rel);
    if (!file) continue;
    // A folder replaced by a symlink would make rmSync delete the file it points at; a symlink
    // as the note itself is removed as the link it is, never its target. Checked first, so a
    // note behind such a folder is not counted as removed either.
    if (!insideReal(dirname(file))) {
      skipped++;
      continue;
    }
    // A symlink left at the note path is not a missing note: the write pass skips it too.
    if (!existsSync(file) && !isSymlink(file)) {
      // The note is gone: the entry is stale.
      removed++;
      continue;
    }
    if (!ownedBy(file, entry.id)) {
      skipped++;
      continue;
    }
    removed++;
    if (!opts.dryRun) rmSync(file, { force: true });
  }

  if (!opts.dryRun) {
    mkdirSync(root, { recursive: true });
    const sorted: Record<string, ManifestEntry> = {};
    for (const rel of Object.keys(manifest.files).sort()) sorted[rel] = manifest.files[rel] as ManifestEntry;
    writeFileSync(manifestPath, `${JSON.stringify({ version: 2, files: sorted }, null, 2)}\n`);
  }

  return { dir: root, ...counts, written, unchanged, removed, skipped, dry_run: Boolean(opts.dryRun) };
}
