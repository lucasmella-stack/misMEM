import { z } from "zod";

const MemorySchema = z.object({
  gist: z.string().min(1).max(500),
  details: z.string().optional().nullable(),
  evidence_episode_ids: z.array(z.string()).min(1),
  type: z.string().min(1).max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ResponseSchema = z.object({
  memories: z.array(MemorySchema),
});

export type DistilledMemory = z.infer<typeof MemorySchema>;

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
}

export function loadLlmConfig(): LlmConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY no seteada. Setear como env var antes de consolidar.",
    );
  }
  return {
    apiKey,
    model: process.env.MISMEM_CONSOLIDATION_MODEL ?? "deepseek/deepseek-chat",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    appUrl: process.env.OPENROUTER_APP_URL ?? "https://github.com/lucasmella-stack/misMEM",
    appTitle: process.env.OPENROUTER_APP_TITLE ?? "misMEM",
  };
}

export async function distill(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<DistilledMemory[]> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      "HTTP-Referer": cfg.appUrl ?? "",
      "X-Title": cfg.appTitle ?? "",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter respuesta sin choices[0].message.content");
  }

  const cleaned = stripFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM devolvi\u00f3 JSON inv\u00e1lido: ${(err as Error).message}\nRaw: ${cleaned.slice(0, 500)}`);
  }
  const root = z
    .object({ memories: z.array(z.unknown()) })
    .parse(parsed);
  const out: DistilledMemory[] = [];
  for (const raw of root.memories) {
    const r = MemorySchema.safeParse(raw);
    if (r.success) out.push(r.data);
  }
  return out;
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return trimmed;
}
