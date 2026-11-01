# Hooks del cliente

Dos binarios enganchan misMEM a [Claude Code](https://claude.com/claude-code) sin que el modelo tenga que
acordarse de pedir nada. Son opcionales; `scripts/install.sh` los configura si se le pide.

| Hook | Evento | Qué hace |
|---|---|---|
| `mismem-inject` | `UserPromptSubmit` | Busca con el prompt y adelanta unos pocos recuerdos. Busca con `reinforce: false`: lo que el usuario no pidió no es uso. Se mantiene dormido hasta comprobar que el servidor expone `reinforce`, así que se puede configurar antes de desplegar |
| `mismem-used` | `Stop` | Mira el último turno (lo que el modelo pidió con `recall` y lo que la inyección le puso delante) y refuerza sólo aquello cuyas palabras distintivas reaparecen en la respuesta. Es una aproximación: falla hacia no reforzar |

Dos matices sobre esa aproximación:

- Con `MISMEM_HOOK_URL`, la inyección recibe de `recall` el `text` ya recortado a 2.000 puntos de código
  (`MAX_TEXT_CHARS`). Sin servidor remoto lee la base y recibe el texto entero. El presupuesto del hook
  (`MISMEM_HOOK_MAX_CHARS`, 1.200 por defecto) cuenta unidades UTF-16, no puntos de código: con el valor por
  defecto un recuerdo de ese tamaño no se inyecta por ningún camino, y con un presupuesto alto un recuerdo
  largo puede caber recortado por el camino remoto y no caber entero por el local.
- `mismem-used` mide el solapamiento sólo sobre el `text` del hit, recortado cuando vino de un `recall` por
  MCP: los `details` no cuentan como señal, aunque el modelo también los recibe: el refuerzo depende sólo de
  que la respuesta repita palabras del gist. El recorte puede quitar palabras que la respuesta no repetía, así que para un gist por
  encima del tope el error ya no cae siempre del lado de no reforzar.

## Qué sale de la máquina

Lo inyectado viaja en **cada prompt** al proveedor del modelo, así que `MISMEM_HOOK_EXCLUDE_SCOPES`
decide qué ámbitos no salen. Antes de activarlo, `echo '{"prompt":"..."}' | mismem-inject --dry-run`
imprime los ids y los ámbitos de lo que elegiría, sin mandar nada.

## Refuerzo por uso

Con `MISMEM_REINFORCE_ON_RECALL=off`, la saliencia pasa a seguir el uso en vez de la aparición. Conviene
mirar antes qué reforzaría `mismem-used --dry-run` y, sólo entonces, apagarlo; las cifras y el motivo
están en DEPLOY.md.

## Cuándo cuenta que un recuerdo se usó

`mismem-used` no refuerza todo lo que el recall devolvió: premiaría a lo que siempre aparece. Cuenta como
usado el recuerdo cuya respuesta repite **al menos 2 de sus palabras distintivas** y **al menos el 20 % de
ellas**. Los dos umbrales están en `engine/src/hooks/usage.ts`.

La calibración se midió el 2026-10-31 sobre 898 recuerdos puestos delante en 565 turnos reales, contra un
**modelo nulo**: la misma respuesta comparada con recuerdos de *otros* turnos, 25 barajadas. Lo que pasa el
umbral ahí es ruido por construcción, y la distancia entre lo real y lo nulo es la señal.

| Umbral | Pares escritos | Señal sobre el azar |
|---|---|---|
| 0,20 / 3 (anterior) | 147 | 3,0× |
| **0,20 / 2 (actual)** | **187** | **2,9×** |
| 0,10 / 3 | 245 | 2,1× |
| 0,05 / 3 | 245 | 2,1× |

Dos cosas que esa tabla deja ver y que conviene no olvidar:

- **Bajar la fracción satura.** Con un piso de 3 palabras y recuerdos de ~17, el piso equivale a una fracción
  de 0,18: por debajo de 0,12 manda el piso y la fracción deja de hacer nada. El piso de palabras es el que
  realmente decide.
- **Aflojar cuesta señal.** De 0,20 a 0,10 la proporción sobre el azar cae de 3,0× a 2,1×: casi la mitad de lo
  que entraría sería casualidad.

Se comprobaron además dos efectos indeseados y ninguno aparece: no hay sesgo por longitud (la mediana de los
que pasan es de 17 palabras contra 16 de todos los ofrecidos) y el refuerzo no se concentra en unos pocos
recuerdos (el más reforzado, 6 veces; los cinco primeros se llevan el 11 % del total).

**Por qué el tope de la inyección es 5 y no 3.** La capa lateral sólo aprende de **pares**, y los pares crecen
con el cuadrado de lo que hay delante: con 3 recuerdos salen 3 pares como mucho, con 5 salen 10. El
presupuesto de caracteres (`DEFAULT_MAX_CHARS`) sigue siendo el tope real del costo.

## Montaje y variables

El montaje paso a paso (configuración de `settings.json`, el envoltorio `scripts/mismem-hook.sh`, la
espera a que el servidor esté listo) y todas las variables están en [DEPLOY.md](../DEPLOY.md):
[refuerzo por uso](../DEPLOY.md#refuerzo-por-uso-hook-del-cliente) y
[recuperación proactiva](../DEPLOY.md#recuperación-proactiva-hook-del-cliente).
