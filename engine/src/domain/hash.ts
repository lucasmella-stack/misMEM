// Pure content hashing, apart from db.ts so domain modules do not depend on the SQLite driver to get a sha256.
import { createHash } from "node:crypto";

export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
