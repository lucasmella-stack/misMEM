// Tells a misMEM database from any other SQLite file before openDb touches it: openDb migrates
// the schema and switches the journal to WAL, so a wrong path would be modified even if the
// caller refuses the file afterwards.
import Database from "better-sqlite3";

export function isMismemDb(path: string): boolean {
  try {
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get() !== undefined;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}
