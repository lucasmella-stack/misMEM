import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { capture } from "../tools.js";

const TEXT_EXT = new Set([
  ".md", ".txt", ".json", ".jsonl", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".yaml", ".yml", ".toml", ".sh", ".ps1", ".env.example", ".sql", ".html",
  ".css", ".rs", ".go", ".java", ".rb", ".lua", ".vue", ".svelte", ".astro",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo",
  ".cache", "__pycache__", ".venv", "venv", ".pnpm-store", ".vscode-test",
  "out", ".nuxt", ".svelte-kit", "target", ".gradle", ".idea",
]);
const MAX_FILE_BYTES = 500_000;
const CHUNK_BYTES = 80_000;

export interface WalkOptions {
  root: string;
  scopePrefix: string;
  db: DB;
  skipBinary?: boolean;
}

export interface WalkStats {
  filesSeen: number;
  filesIngested: number;
  filesSkipped: number;
  bytesIngested: number;
  errors: string[];
}

function shouldIngest(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // Accept known config dotfiles without extension
  const name = basename(path).toLowerCase();
  return ["dockerfile", ".gitignore", ".npmrc", ".editorconfig", ".env.example"].includes(name);
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_BYTES) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_BYTES) {
    chunks.push(text.slice(i, i + CHUNK_BYTES));
  }
  return chunks;
}

export async function walkAndIngest(opts: WalkOptions): Promise<WalkStats> {
  const stats: WalkStats = {
    filesSeen: 0, filesIngested: 0, filesSkipped: 0,
    bytesIngested: 0, errors: [],
  };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      stats.errors.push(`readdir ${dir}: ${(e as Error).message}`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      stats.filesSeen++;
      if (!shouldIngest(full)) {
        stats.filesSkipped++;
        continue;
      }
      try {
        const s = await stat(full);
        if (s.size > MAX_FILE_BYTES) {
          stats.filesSkipped++;
          continue;
        }
        const content = await readFile(full, "utf8");
        if (!content.trim()) {
          stats.filesSkipped++;
          continue;
        }
        const rel = relative(opts.root, full).replace(/\\/g, "/");
        const scope = `${opts.scopePrefix}/${rel.split("/").slice(0, -1).join("/")}`.replace(/\/+$/, "");
        const chunks = chunkText(content);
        for (let i = 0; i < chunks.length; i++) {
          const header = chunks.length > 1
            ? `# ${rel} [chunk ${i + 1}/${chunks.length}]\n\n`
            : `# ${rel}\n\n`;
          capture(opts.db, { scope: scope || opts.scopePrefix, body: header + chunks[i] });
        }
        stats.filesIngested++;
        stats.bytesIngested += s.size;
      } catch (e) {
        stats.errors.push(`${full}: ${(e as Error).message}`);
      }
    }
  }

  await walk(opts.root);
  return stats;
}
