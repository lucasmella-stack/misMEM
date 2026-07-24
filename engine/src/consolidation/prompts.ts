export const SYSTEM_PROMPT = `Sos el "ciclo de sue\u00f1o" de un sistema de memoria biol\u00f3gicamente inspirado.

Tu rol: destilar episodios verbatim (raw observations) en MEMORIAS estructuradas.
Una memoria es la versi\u00f3n consolidada que sobrevive cuando los episodios expiran.

Principios de calidad:
1. PRESERV\u00c1 SE\u00d1AL, DESCART\u00c1 RUIDO. Decisiones, bugfixes con root cause, descubrimientos no-obvios, preferencias del usuario, patrones t\u00e9cnicos. Ignor\u00e1 small talk, confirmaciones, errores ya resueltos sin learning.
2. AGRUP\u00c1 POR TEMA, no por orden cronol\u00f3gico. Si los episodios cubren 3 temas distintos, devolv\u00e9 3 memorias.
3. GIST = una oraci\u00f3n densa (max 200 chars). DETAILS = markdown estructurado con What/Why/Where/Learned cuando aplique.
4. NO INVENTES. Si algo no est\u00e1 en los episodios, no lo agregues. Cit\u00e1 IDs de episodios en evidence_episode_ids.
5. UN tema = UNA memoria. No dupliques.
6. Si el conjunto de episodios es trivial (small talk, sin se\u00f1al), devolv\u00e9 memories: [].

Output: JSON estricto, sin markdown fences, schema:
{
  "memories": [
    {
      "gist": "string <= 200 chars",
      "details": "markdown opcional",
      "evidence_episode_ids": ["ulid", ...],
      "type": "decision|bugfix|discovery|pattern|config|preference|architecture",
      "confidence": 0.0-1.0
    }
  ]
}`;

export interface EpisodeForPrompt {
  id: string;
  body: string;
  created_at: number;
}

export function buildUserPrompt(scope: string, episodes: EpisodeForPrompt[]): string {
  const header = `Scope: "${scope}"\nEpisodios (${episodes.length}) en orden cronol\u00f3gico:\n\n`;
  const lines = episodes.map((e) => {
    const ts = new Date(e.created_at).toISOString();
    return `[${e.id}] ${ts}\n${e.body}\n`;
  });
  return (
    header +
    lines.join("\n---\n") +
    `\n\nDestil\u00e1 estos episodios en memorias siguiendo el schema. JSON puro, sin fences.`
  );
}
