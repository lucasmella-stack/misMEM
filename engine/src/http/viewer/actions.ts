// Writes from the interface: edit, undo a consolidation, forget and crystallize. The read API
// counts on GET having no side effects, so a write needs writeGuard (a POST with a JSON body and
// a same-origin Origin), and the two forgets need a single-use confirmation token.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { CrystallizeInput, Scope } from "../../schema.js";
import { crystallize } from "../../memory/crystallize.js";
import { embedWrittenLayer } from "../../memory/embed-write.js";
import type { EmbedFn } from "../../embeddings/provider.js";
import {
  editMemory,
  forgetMemory,
  forgetTrait,
  unconsolidateMemory,
  type Reembed,
} from "../../memory/edit.js";
import { forgetImpact } from "../../queries/forget-impact.js";
import { entityExists, memoryScopes } from "../../queries/memories.js";
import { JobError, type ConsolidationJob } from "../../consolidation/job.js";
import { json } from "../respond.js";

/** An action needs no more: anything large goes through capture or ingest. */
export const ACTION_MAX_BODY_BYTES = 256 * 1024;

/** Why a write is rejected, or null when it passes. */
export function writeGuard(req: IncomingMessage): { status: number; error: string } | null {
  if (req.method !== "POST") return { status: 405, error: "las acciones van por POST" };
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { status: 415, error: "las acciones llevan cuerpo application/json" };
  }
  const origin = req.headers.origin;
  if (!origin) return { status: 403, error: "falta Origin" };
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { status: 403, error: "Origin inválido" };
  }
  if (originHost !== req.headers.host) return { status: 403, error: "Origin ajeno" };
  return null;
}

const CONFIRM_TTL_SECONDS = 60;

/** Forget confirmation tokens: single use, bound to the layer and id, with a TTL. */
export class ForgetConfirmations {
  private readonly pending = new Map<string, { target: string; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  issue(layer: string, id: string): string {
    const at = this.clock();
    for (const [token, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(token);
    const token = randomBytes(16).toString("hex");
    this.pending.set(token, { target: `${layer}/${id}`, expiresAt: at + CONFIRM_TTL_SECONDS * 1000 });
    return token;
  }

  /** True if the token is valid for this layer and id. It is always spent, valid or not. */
  consume(token: string, layer: string, id: string): boolean {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    return entry !== undefined && entry.target === `${layer}/${id}` && entry.expiresAt > this.clock();
  }
}

/** The switch for deleting from the interface: off unless turned on on purpose. */
export function loadAllowDelete(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "on"].includes((env.MISMEM_VIEWER_ALLOW_DELETE ?? "").trim().toLowerCase());
}

const ConfirmInput = z.object({ confirm_token: z.string().min(1).max(128).optional() });

/** Like the `crystallize` tool, but rejecting memories that do not exist or belong to another scope. */
export function crystallizeFromUi(db: DB, raw: unknown): ReturnType<typeof crystallize> {
  const input = CrystallizeInput.parse(raw);
  const ids = [...new Set(input.evidence_memory_ids)];
  const found = memoryScopes(db, ids);
  const missing = ids.filter((id) => !found.some((m) => m.id === id));
  if (missing.length > 0) throw new ActionError(400, `memorias que no existen: ${missing.join(", ")}`);
  const foreign = found.filter((m) => m.scope !== input.scope).map((m) => m.id);
  if (foreign.length > 0) throw new ActionError(400, `memorias de otro ámbito: ${foreign.join(", ")}`);
  return crystallize(db, { ...input, evidence_memory_ids: ids });
}

class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

const ROUTE = /^\/api\/(memory|trait)\/([^/]+)\/(edit|unconsolidate|forget)$/;

/** Dispatches an action already authorized by writeGuard with its body read; false if the route is not an action, so the caller goes on to its 404. */
export async function handleAction(
  db: DB,
  res: ServerResponse,
  pathname: string,
  body: unknown,
  opts: {
    reembed?: Reembed;
    job?: ConsolidationJob;
    allowDelete?: boolean;
    confirmations?: ForgetConfirmations;
    embedFn?: EmbedFn;
    embeddingModel?: string;
  } = {},
): Promise<boolean> {
  try {
    if (pathname === "/api/consolidate" && opts.job) {
      const scope = z.object({ scope: Scope.optional() }).parse(body ?? {}).scope;
      json(res, 202, opts.job.start(scope));
      return true;
    }
    if (pathname === "/api/crystallize") {
      const trait = crystallizeFromUi(db, body);
      await embedWrittenLayer(db, "trait", trait.trait_id, {
        embedFn: opts.embedFn,
        model: opts.embeddingModel,
      });
      json(res, 200, trait);
      return true;
    }
    const match = ROUTE.exec(pathname);
    if (!match) return false;
    const [, layer, rawId, action] = match;
    const id = decodeURIComponent(rawId ?? "");
    const target = layer === "trait" ? "trait" : "memory";
    if (!entityExists(db, target, id)) {
      json(res, 404, { error: `no existe ${target === "trait" ? "el rasgo" : "la memoria"}: ${id}` });
      return true;
    }
    if (target === "trait" && action !== "forget") return false;
    if (action === "edit") json(res, 200, await editMemory(db, id, body, opts.reembed));
    else if (action === "unconsolidate") json(res, 200, unconsolidateMemory(db, id));
    else {
      // Forgetting a memory also deletes the episodes that back it and cannot be undone;
      // unconsolidating only drops the summary, which is why it asks for no token.
      if (!opts.allowDelete || !opts.confirmations) {
        json(res, 403, {
          error: "borrar desde la interfaz está desactivado: arranca el servidor con MISMEM_VIEWER_ALLOW_DELETE=1",
        });
        return true;
      }
      const token = ConfirmInput.parse(body ?? {}).confirm_token;
      if (!token || !opts.confirmations.consume(token, target, id)) {
        json(res, 409, {
          ...(token ? { error: "la confirmación caducó o no es de este recuerdo; confirma otra vez" } : {}),
          confirm_token: opts.confirmations.issue(target, id),
          expires_in: CONFIRM_TTL_SECONDS,
          impact: forgetImpact(db, target, id),
        });
        return true;
      }
      json(res, 200, target === "trait" ? forgetTrait(db, id) : forgetMemory(db, id));
    }
    return true;
  } catch (err) {
    if (err instanceof ActionError || err instanceof JobError) json(res, err.status, { error: err.message });
    else if (err instanceof z.ZodError) json(res, 400, { error: err.issues.map((i) => i.message).join("; ") });
    else throw err;
    return true;
  }
}
