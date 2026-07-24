import { z } from "zod";

export const Scope = z.string().min(1).max(128);

export const CaptureInput = z.object({
  scope: Scope,
  body: z.string().min(1),
});
export type CaptureInput = z.infer<typeof CaptureInput>;

export const RecallInput = z.object({
  query: z.string().min(1),
  scope: Scope.optional(),
  limit: z.number().int().positive().max(50).default(10),
});
export type RecallInput = z.infer<typeof RecallInput>;

export const ConsolidateInput = z.object({
  scope: Scope,
  gist: z.string().min(1),
  details: z.string().optional(),
  source_episode_ids: z.array(z.string()).min(1),
});
export type ConsolidateInput = z.infer<typeof ConsolidateInput>;

export const CrystallizeInput = z.object({
  scope: Scope,
  name: z.string().min(1),
  evidence_memory_ids: z.array(z.string()).min(1),
  polarity: z.enum(["shadow", "light", "neutral"]).default("neutral"),
});
export type CrystallizeInput = z.infer<typeof CrystallizeInput>;

export const ForgetInput = z.object({
  scope: Scope.optional(),
  before_days: z.number().int().positive().default(30),
  salience_below: z.number().min(0).max(1).default(0.1),
  dry_run: z.boolean().default(true),
});
export type ForgetInput = z.infer<typeof ForgetInput>;

export const Layer = z.enum(["episode", "memory", "trait"]);
export type Layer = z.infer<typeof Layer>;

export interface RecallHit {
  layer: Layer;
  id: string;
  scope: string;
  text: string;
  salience?: number;
  created_at: number;
  /** Presente cuando el hit vino de la búsqueda semántica y no del FTS5. */
  via?: "semantic";
}
