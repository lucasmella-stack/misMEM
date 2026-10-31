# Consolidación con LLM (el ciclo de sueño)

Destila episodios literales en memorias estructuradas con un LLM: DeepSeek, OpenRouter, OpenAI o cualquier
servidor compatible con la API de OpenAI. El proveedor se elige con `MISMEM_LLM_PROVIDER`; sin esa
variable, se usa el primero que tenga su clave.

```
episodes (literales; `forget` los borra una vez consolidados)
   ↓ runConsolidation(), a diario a las 4:00
memories (gist + details, saliencia con decay y refuerzo hebbiano)
   ↓ crystallize()
traits (patrones cristalizados)
```

## Ejecutarla

```bash
mismem-consolidate [--dry-run] [--scope <name>] [--min-age-hours 24] [--min-episodes 3] [--quiet-days 14] [--max-batch 60] [--uncited-strikes 3]
```

Los valores son los de por defecto. Con `--dry-run` calcula qué haría sin llamar al LLM ni escribir. La
primera vez conviene un `--dry-run`, y después una corrida real acotada (`--scope <name> --max-batch 10`).

Programarla: `scripts/install.sh` ofrece un timer de systemd de usuario a las 4:00; en un servidor, el
cron de la sección "Tareas programadas" de [DEPLOY.md](../../../DEPLOY.md#tareas-programadas), que además
explica por qué el respaldo va antes. La clave del proveedor llega por el entorno del proceso.

## Configuración

Las variables (`MISMEM_LLM_PROVIDER`, las claves de cada proveedor, `MISMEM_CONSOLIDATION_*`) y sus
valores por defecto están en la [referencia única de DEPLOY.md](../../../DEPLOY.md#variables-de-entorno-referencia-única).
El modelo por defecto en DeepSeek es `deepseek-chat`.

## Qué garantiza

- **Costo acotado**: cada llamada lleva como mucho `MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS` caracteres de
  episodios y `MISMEM_CONSOLIDATION_MAX_TOKENS` de respuesta, y cada corrida como mucho
  `MISMEM_CONSOLIDATION_MAX_CALLS` llamadas. Un atraso grande se vacía en varias noches.
- **Proveedor sin saldo o con clave inválida** (HTTP 401, 402 o 403): la corrida se corta en el primer
  error en vez de repetirlo por cada ámbito.
- **Anti-alucinación**: se descartan los `evidence_episode_ids` que no estén en la tanda.
- **Idempotente**: sólo mira episodios con `consolidated_into IS NULL`.
- **Ruido**: lo que no llega a memoria queda atado a una memoria marcadora (`[noise] ...` o
  `[pareto:l0] ...`) con `salience=0.05`, y `forget` lo borra a los 30 días **junto con sus episodios**.
  El marcador no vuelve en el recall ni gasta un embedding (`engine/src/domain/noise.ts`). Pasa en dos casos: el
  prefiltro Pareto lo descartó, o el LLM leyó el episodio y no lo citó en
  `MISMEM_CONSOLIDATION_UNCITED_STRIKES` tandas seguidas. El segundo depende del LLM: conviene mirar el
  log de las primeras corridas y tener respaldos que duren más que esos 30 días.
- **Episodio que el LLM no cita**: suma un strike (`episodes.uncited_count`) y vuelve en la corrida
  siguiente, no en la misma. Sólo al agotar los strikes pasa a ruido. Un `memories: []` ("sin señal") cuenta
  como no citar toda la tanda. El resumen lo cuenta en `episodes_uncited_pending`.
- **Episodio que no entra**: si con un solo episodio la respuesta igual llega cortada o inválida, ese
  episodio queda pendiente (no se marca ruido ni falla el ámbito) y la corrida sigue con el resto. Se
  reintenta la noche siguiente y aparece en el resumen como `episodes_skipped`.
- **Respuesta mal formada**: un JSON roto, sin la lista de memorias o con alguna memoria inválida parte
  la tanda a la mitad y reintenta. Un `gist` de más de 500 caracteres se recorta y el texto completo pasa
  a `details`.

## Qué sale de la máquina

El cuerpo de cada episodio (hasta `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS`), su id, su fecha y el nombre
del ámbito viajan al proveedor del LLM. Apuntando `MISMEM_LLM_BASE_URL` a un servidor de la propia red, no
sale nada.

## Tests

```bash
pnpm test consolidation
```

Cubren: omisión por umbral y por edad, destilación correcta, marcador de ruido, anti-alucinación,
`--dry-run`, corte ante un error fatal, tandas dentro del presupuesto, recorte de episodios enormes, tope
de llamadas, strikes del episodio sin citar (pendiente a la primera, ruido al agotarlos), y elección de
proveedor y tope de tokens (`consolidation-llm.test.ts`).
