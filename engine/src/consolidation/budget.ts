// A call's budget: how much of each episode travels and when the batch stops growing.
// What does not fit stays pending for the next batch.
import type { EpisodeForPrompt } from "./prompts.js";

// What buildUserPrompt adds per episode: id, date and separator.
const PROMPT_OVERHEAD_PER_EPISODE = 60;
const TRUNCATION_MARK = "\n[recortado]\n";

/** The caps of one batch; `maxEpisodes` drops when the LLM truncates the answer. */
export interface PromptBudget {
  maxEpisodes: number;
  maxPromptChars: number;
  maxEpisodeChars: number;
}

export function truncateEpisode(body: string, max: number): string {
  if (body.length <= max) return body;
  const room = max - TRUNCATION_MARK.length;
  // A cap smaller than the marker would cut negative slices and yield text longer than the cap.
  if (room <= 0) return body.slice(0, Math.max(0, max));
  const head = Math.ceil(room * 0.75);
  return body.slice(0, head) + TRUNCATION_MARK + body.slice(body.length - (room - head));
}

/**
 * The episodes that fit the batch, already truncated. The first one always goes in, even
 * if it does not fit: a single one has to travel so that its error says something about the episode.
 */
export function fitPrompt(episodes: EpisodeForPrompt[], budget: PromptBudget): EpisodeForPrompt[] {
  const fitted: EpisodeForPrompt[] = [];
  let used = 0;
  for (const e of episodes) {
    if (fitted.length >= budget.maxEpisodes) break;
    const body = truncateEpisode(e.body, budget.maxEpisodeChars);
    const cost = body.length + PROMPT_OVERHEAD_PER_EPISODE;
    if (fitted.length > 0 && used + cost > budget.maxPromptChars) break;
    fitted.push({ id: e.id, body, created_at: e.created_at });
    used += cost;
  }
  return fitted;
}
