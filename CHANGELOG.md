# Changelog

## Sin publicar

### El grafo se puede pintar por tema, no sólo por ámbito

- *Ajustes del grafo* cambia **Color por ámbito** por una elección de tres: **ámbito, tema o ninguno**.
  Por tema, cada nodo toma el color de la isla semántica a la que pertenece, y la leyenda los nombra
  con la memoria más saliente de cada una.
- La paleta se reparte entre **los temas que están dibujados**, no entre los más grandes del total.
  Es la misma regla que ya seguía la de ámbitos: la paleta es corta y gastarla en temas que casi no
  salen en pantalla deja un dibujo donde no se pinta casi nada. Medido sobre una base real, pasa de
  74 a 85 nodos pintados de los 600 que se dibujan.
- Los temas se piden sólo cuando pintan, y con la misma clave de consulta que la pestaña *Temas*:
  llegando desde ahí, los colores ya están en mano.
- Un rasgo conserva su color de marca pinte quien pinte: es la capa que organiza a las demás.
- Las filas del panel (interruptores, deslizadores, secciones y la elección nueva) pasan a
  `components/graph/PanelRows.tsx`: el panel se había comido el trinquete de 400 líneas.

### Los marcadores de ruido dejan de ocupar un vector

- Un marcador (`[noise] ...`, `[pareto:l0] ...`) no compite en el recall ni gasta un embedding, pero
  las bases anteriores a esa regla todavía arrastraban los suyos. Al abrir, se borran: son dato
  derivado y no cuesta nada regenerar lo que haga falta.
- Medido en una base real: **235 de 3.887 vectores (el 6 %) eran marcadores**. Ensuciaban cualquier
  lectura que fuera a la tabla de vectores directamente — agrupando las memorias por parecido, la
  segunda isla más grande eran 235 avisos de «episodios sin señal» pareciéndose entre sí.
- El camino que escribe vectores ya los excluía, así que no vuelven a aparecer.

### Una pestaña de temas: qué recuerdos hablan de lo mismo, aunque vivan en ámbitos distintos

- El conectoma mide **qué se usó junto**, y hace falta uso acumulado para que diga algo. Encima de las
  mismas memorias hay un segundo grafo que ya está lleno: **el de los vectores**, que mide qué se
  parece a qué. *Temas* lo muestra como islas.
- Cada isla trae su tamaño, **de qué ámbitos sale** y la memoria más saliente como puerta de entrada.
  Lo que no se ve navegando por ámbito es justo eso: un tema que cruza tres.
- El corte es **0,85**, medido sobre 3.652 memorias reales: a 0,80 un solo bloque se come el 66 % de
  todo y a 0,88 la isla mayor baja a 17. A 0,85 se parten en 409 islas con la mayor al 6 %.
- El coste es un coseno por par, o sea cuadrático, así que mira **las 1.500 memorias más salientes**:
  1,8 s sobre una base real. Sin tope, una petición se quedaría colgada calculando un mapa que nadie
  pidió exhaustivo.
- `GET /api/topics`, con `scope` y `min_score` opcionales; un `min_score` ilegible o fuera de (0,1)
  cae al valor por defecto en vez de devolver una lista vacía sin explicación.

### El tamaño de un nodo dice cuántas conexiones tiene, no cuántos días lleva (#217)

- El radio salía de la saliencia, que nace en la confianza del LLM y decae con una vida media de 90
  días: en la práctica el dibujo decía sobre todo la antigüedad, y entre 2,2 px y 4,1 px todos los
  nodos medían casi lo mismo. Ahora sale del **número de aristas visibles** de cada nodo, contadas en
  el cliente con los filtros puestos, así que apagar una capa redimensiona el grafo con ella.
- El radio no pasa de **tres veces el mínimo**: el peso crece hasta 9× y los píxeles salen de su raíz
  cuadrada, así que un nodo muy conectado destaca sin tapar a sus vecinos. Como el peso también
  alimenta la simulación, los centros ganan espacio, que es lo que se busca.
- Por conexiones todas las capas miden igual: un rasgo fijo en 5 y un episodio en una saliencia de 0,5
  no decían nada de cuál organiza a los demás.
- **El área para pinchar** deja de ser siempre de 7 px: ese es su mínimo y crece con el nodo.
- *Ajustes del grafo* trae el selector: **Tamaño por conexiones**, encendido por defecto; apagándolo
  vuelve el dibujo por saliencia de antes.

### El instalador ya no se queda sin búsqueda semántica porque el 8080 esté ocupado

- El puerto de `llama-server` estaba fijo en 8080, donde viven igual de a menudo un panel de Traefik, un
  Jenkins o un Tomcat. Con el puerto tomado por algo que no sirve embeddings, el instalador bajaba 296 MB de
  modelo, escribía `MISMEM_EMBEDDING_URL` apuntando ahí y dejaba la búsqueda sólo por palabras. Ahora se
  mueve al primer puerto libre y lo dice; un servidor de embeddings que ya responda en el puerto se sigue
  reutilizando, y el puerto que escribió una instalación anterior manda, así que re-ejecutarlo no mueve un
  servidor que ya anda. `MISMEM_INSTALL_GEMMA_PORT` fija el puerto preferido.
- **`install.sh` desde el repo exige pnpm** y lo dice en una línea: el repo sólo trae `pnpm-lock.yaml`, así
  que la alternativa `npm ci` no podía funcionar nunca y fallaba con un volcado de npm de veinte líneas.
- `engine/tests/installer.test.ts` corre el instalador de verdad contra un `HOME` temporal, con
  `llama-server` y `systemctl` simulados: es lo único que prueba sus decisiones, porque hasta ahora de
  `scripts/` sólo se comprobaban la sintaxis y shellcheck.

### El conectoma deja de ser un panel aparte que tapaba los ajustes (#209)

- **Los dos paneles del grafo se tapaban por debajo de 34rem.** A 375 px el del conectoma cubría
  entero el de ajustes, y entre lo que tapaba estaba el único interruptor que apaga la capa: desde el
  teléfono se entraba y no se salía. La lectura del conectoma pasa a ser el cuerpo de su propia
  sección dentro de *Ajustes del grafo*, así que el solapamiento desaparece por construcción.
- **El deslizador de soporte mínimo pedía el grafo entero en cada paso**, y cada petición recalcula el
  NPMI de toda la tabla `co_use`: cinco pulsaciones de flecha eran cinco `GET /api/graph`, cuatro
  abortadas. Ahora el número se mueve al instante y el valor viaja una sola vez, cuando se deja de
  mover.
- **El halo tiene su propio token** (`--color-graph-halo`) en los dos temas: el rosa de marca
  resplandece sobre una superficie oscura, pero en claro el mismo tono a baja opacidad leía como un
  cerco gris sucio.
- **Los deslizadores no tenían nombre accesible**: `aria-labelledby` iba al contenedor y el
  `role="slider"` lo tiene el pulgar, así que ninguno se anunciaba. La etiqueta llega ahora al pulgar.
- Los tests de interfaz pueden renderizar componentes (`jsdom` y testing-library, con versión exacta):
  hasta ahora sólo probaban lógica pura, y nada de esto se puede ver sin montar el panel.

### `consolidate` ya no le roba episodios a otra memoria ni crea memorias sin origen (#233)

- La herramienta MCP marcaba sus episodios con `UPDATE episodes SET consolidated_into = ?` **sin
  comprobar que estuvieran pendientes**, así que un episodio que ya pertenecía a otra memoria pasaba a
  la nueva y dejaba a la anterior con un `source_episode_ids` que ya no apuntaba a nada. Y si ninguno de
  los ids existía o era de otro ámbito, la memoria se insertaba igual, sin un solo episodio detrás.
- Ahora sólo toma episodios pendientes del ámbito pedido, como la consolidación nocturna, y si no queda
  ninguno falla con un error que dice qué pasó en vez de insertar una memoria huérfana. La excepción
  deshace el `INSERT` porque todo ocurre en la misma transacción.
- **La consolidación nocturna**, que llama a esa misma herramienta, habría empezado a fallar la corrida
  entera cuando el LLM cita el mismo episodio en dos memorias. Un episodio pertenece a una sola memoria
  —`consolidated_into` guarda un id—, así que la primera se lo queda y la segunda busca otra evidencia;
  sin ninguna, se salta con su línea de log y la corrida sigue.

### El servidor MCP dice cuándo usar cada herramienta y cómo recuperarse de un fallo

- El servidor MCP le dice al modelo cuándo usar cada herramienta y qué hacer cuando algo falla. Al inicializar anuncia unas `instructions` de menos de 1.500 caracteres con las tres capas, el formato del ámbito (`<persona o equipo>/<proyecto>`, el mismo al guardar y al buscar), cuándo capturar (una decisión con su porqué, la causa raíz de un fallo, una corrección del usuario, una idea por llamada, nunca secretos ni datos de terceros), buscar antes de preguntar al usuario algo que quizá ya esté guardado, reforzar con los ids que de verdad se usaron y leer entero con `mem_get_observation` un hit `truncated`. Las seis descripciones dicen en una frase "Use when"; un `recall` o un `mem_search` sin resultados añaden `scopes` (los ámbitos que tienen contenido, 20 como mucho) y, si se pidió un `scope`, un `hint` que lo nombra; y un `ZodError` llega como una línea por campo (`Error en capture: body: se esperaba un texto`) en vez del JSON de Zod, con el entero dicho como entero y el mínimo exclusivo como "tiene que ser mayor que 0".

### `recall` por MCP le da al modelo la fecha, los detalles y la polaridad (#153)

- Cada resultado trae `date` legible en UTC, los `details` de una memoria, la `polarity` de un rasgo cuando
  no es neutra y `truncated` si un texto se recortó (2.000 caracteres de `text`, 1.200 de `details`). Las
  respuestas MCP van sin indentación. Los alias `mem_*` conservan sus campos y también van sin indentación (salvo `mem_search`, que ante un vacío añade `scopes` y `hint`, como `recall`); el visor y su API no cambian.

## 0.8.0 — 2026-11-01

### El README describe el sistema: sin modelos concretos y sin una lista cerrada de clientes

- La búsqueda por significado funciona con cualquier modelo detrás de un servidor de embeddings, y la
  consolidación con cualquier LLM de API compatible con OpenAI: el README deja de presentar modelos concretos
  como si fueran parte del sistema.
- misMEM sirve a cualquier cliente MCP: los ejemplos pasan a ser las herramientas de código (opencode,
  Claude Code, Codex, Cursor, VS Code), y la lista de clientes que configura el instalador queda en su `--help`.

### Un solo proveedor de embeddings, con EmbeddingGemma 2 por defecto y sin nomic (#229)

- **Un protocolo**: el `/v1/embeddings` de OpenAI, que sirven llama-server y Ollama. Fuera el camino `/api/embed`,
  `MISMEM_EMBEDDING_PROVIDER` y `MISMEM_OLLAMA_URL`; otro servidor u otro modelo se eligen con
  `MISMEM_EMBEDDING_URL` y `MISMEM_EMBEDDING_MODEL`, y cambiar de modelo sigue reindexando solo.
- **Sin configurar nada**, EmbeddingGemma 2 en `http://127.0.0.1:8080`, el puerto del instalador. Con un modelo
  de la familia EmbeddingGemma (su id contiene `embeddinggemma`) van solos sus prefijos y el corte de 0,65, el
  mayor que no pierde aciertos en el golden eval (PR #181, que esto sustituye); otro modelo arranca sin prefijos
  y con 0,5. Quien configuró EmbeddingGemma a mano sin prefijos tiene que reindexar con `mismem-embed --force`.
- **El instalador** monta sólo EmbeddingGemma 2: `--embeddings gemma|off`. Una instalación con nomic en el Ollama local pasa
  a EmbeddingGemma 2 al re-ejecutarlo si hay `llama-server` (si no, conserva nomic); nomic en otro servidor u otro modelo se conservan, y una búsqueda apagada
  con `MISMEM_EMBEDDINGS=off` sigue apagada.
- **Rompe** a quien use nomic o el proveedor `ollama`, a mano o con el instalador anterior, hasta que re-ejecute el
  instalador: el motor ya no lee `MISMEM_EMBEDDING_PROVIDER` ni `MISMEM_OLLAMA_URL`, así que la URL pasa a
  `http://127.0.0.1:8080`, el modelo por defecto a EmbeddingGemma 2 y el corte de nomic de 0,65 a 0,5. Para conservar lo
  que tenía, que escriba `MISMEM_EMBEDDING_URL=http://127.0.0.1:11434`,
  `MISMEM_EMBEDDING_MODEL=nomic-embed-text` y `MISMEM_EMBEDDING_MIN_SCORE=0.65`; para pasarse a EmbeddingGemma 2,
  que re-ejecute el instalador.
- El comentario del umbral de aristas `related` del grafo se rehace con EmbeddingGemma 2 medido sobre una base
  real: el par mediano da 0,673 y el vecino más cercano 0,822; el 0,75 se mantiene.

### Un vector inválido ya no esconde una memoria de la búsqueda (#155)

- Cada vector se valida y se normaliza a norma 1 al entrar, venga del servidor de embeddings o de un
  `embedFn` inyectado: `NaN`, `Infinity`, un componente nulo o no numérico y la norma cero dejan de
  guardarse. Un vector malo sólo se pierde a sí mismo, sin arrastrar a sus compañeros de lote; un lote con
  menos vectores que textos o con dimensiones mezcladas cuenta como fallido.
- El backfill reescribe los vectores que una versión anterior guardó inválidos, y `mismem-embed --status`
  los cuenta en `invalid`. La consulta degrada a búsqueda por palabras cuando su propio vector no es válido.
- `--status` no cuenta los marcadores de ruido, que el backfill nunca reescribe, y una tanda entera de
  vectores inválidos cuenta como fallida: dos seguidas abortan la corrida como si el servidor estuviera caído.

### La suite de tests ya no llama al servidor de embeddings de quien la corre, y hay una suite que sí lo prueba

- Tras consolidar, `runConsolidation` rellena los vectores con la configuración real, así que cada corrida de
  `pnpm test` hacía 24 peticiones a `127.0.0.1:11434` que ningún test comprobaba: cargaba un modelo en el Ollama
  de la máquina y, con ese Ollama ocupado, un test de consolidación pasaba de 5 s y fallaba de forma intermitente.
  `pnpm test` arranca ahora con `MISMEM_EMBEDDINGS=off`, y un test falla si consolidar vuelve a llamar a `fetch`.
  Medido en un espacio de red propio con un servidor falso que anota cada petición: 24 antes, 0 después.
- **`pnpm test:integration`** prueba el servidor de embeddings real, por defecto EmbeddingGemma 2 en `:8080` con
  los prefijos y el corte que escribe el instalador: vectores válidos, una paráfrasis en castellano que la
  búsqueda por palabras no encuentra, una consulta de otro tema que no trae nada, el indexado y el backfill de la
  consolidación. Sin servidor falla en vez de saltarse. No corre en CI.

### La pantalla de entrada perdía su logo al instalar desde npm

- El logo se leía de `"dist/ui"`, una ruta **relativa al directorio de trabajo**. Dentro del repo
  resolvía porque el servidor arranca desde `engine/`; instalado desde npm y arrancado desde
  cualquier otra carpeta, daba 404 y la pantalla quedaba sin imagen.
- Pasa a resolverse contra el propio módulo, como ya hacía `serveUi` para el resto de la interfaz,
  y el único dueño de dónde vive `dist/ui` vuelve a ser `viewer-static.ts`.
- Encontrado empaquetando con `pnpm pack` e instalando en un directorio limpio, que es lo que hace
  cualquiera: dentro del repo el fallo era invisible.

### Salir del visor desde la propia interfaz

- Un botón de icono al lado de *Consolidar ahora*, para poder cerrar la sesión sin borrar cookies a mano
  —que es lo único que había— cuando el visor queda guardado como aplicación.
- **Sólo aparece si hay sesión que cerrar.** `GET /api/session` dice si hay credenciales configuradas: sin
  ellas el visor es abierto y el botón prometería algo que no existe.
- No usa un formulario: la CSP del visor fija `form-action 'none'`, así que el botón llama a `POST /logout`
  y luego navega.

### El refuerzo escribía pocos pares, y la capa lateral sólo aprende de pares

- Medido sobre 565 turnos reales de ocho días: sólo el **6,7 %** escribía un par, que es lo único que alimenta
  `co_use`. Con 42 pares repartidos sobre 1.414 coincidencias posibles, que ninguno se repitiera era **cara o
  cruz** (47 % por simulación): `max(n) = 1` en producción no era un fallo, era poco volumen.
- **El piso de palabras compartidas baja de 3 a 2.** Es el umbral que de verdad decide: con recuerdos de ~17
  palabras, un piso de 3 equivale a una fracción de 0,18, así que bajar la fracción por debajo de 0,12 no hacía
  nada. De 147 pares a **187**, con la señal sobre el azar casi intacta: de 3,0× a 2,9×.
- **La inyección pasa de 3 recuerdos a 5.** Los pares crecen al cuadrado de lo que hay delante: 3 dan 3 pares
  como mucho, 5 dan 10. El presupuesto de caracteres sigue acotando el costo.
- La fracción **no se toca**: de 0,20 a 0,10 la señal cae de 3,0× a 2,1×, casi la mitad por casualidad.
- Calibrado contra un modelo nulo —la misma respuesta comparada con recuerdos de otros turnos, 25 barajadas—
  y comprobado que no aparece sesgo por longitud ni concentración en unos pocos recuerdos. Las cifras, en
  [`docs/hooks.md`](docs/hooks.md).

### El visor tiene su propia pantalla de entrada

- Hasta ahora el visor pedía la contraseña con el diálogo del navegador. Ahora `GET /viewer` sin
  sesión lleva a `/login`, una pantalla con el logo y los tokens del visor. **La API sigue
  respondiendo 401**: un script tiene que leer un error, no una página.
- **`/mcp` no acepta la cookie.** Un cliente MCP manda `Basic` y no puede rellenar un formulario;
  una sesión del visor no es una llave de las herramientas. El `Basic` también sigue valiendo en el
  visor, para quien ya lo tenga puesto.
- La cookie va firmada con HMAC, `HttpOnly`, `SameSite=Strict` y `Secure` cuando la petición llega
  por TLS —en claro no, o el navegador la tiraría sin decir nada—. La clave se **deriva** de
  `MISMEM_AUTH_*` y no se guarda: cambiar la contraseña cierra todas las sesiones vivas, que es lo
  que tiene que pasar cuando se cambia porque se filtró.
- Tope de intentos fallidos por ventana: pasado el tope deja de comparar la contraseña y responde
  429, antes incluso de leer el cuerpo.
- **El formulario no usa JavaScript**: la CSP del visor prohíbe los scripts en línea, y un
  formulario que no depende de JS no se puede romper. La página lleva su propia CSP, más estrecha
  que la del visor salvo por el `form-action 'self'` que necesita para poder enviarse.
- Dos variables nuevas en [`DEPLOY.md`](DEPLOY.md): `MISMEM_SESSION_HOURS` y
  `MISMEM_LOGIN_MAX_BODY_BYTES`.

### La calibración del dibujo deja de estar en números sueltos

- `graphData` hacía cinco cosas en 112 líneas; la capa lateral sale a su propia función por el corte
  que ya marcaba su retorno temprano, y baja a 84.
- Los números que deciden cómo se ve el grafo —el peso de un rasgo frente al de una memoria, cuánto
  crece el halo, el suelo y el techo del trazo lateral, cuánto se apaga lo que no está iluminado—
  pasan a constantes con nombre y con el porqué de **ese** valor, no de que exista el umbral.

### La forma del grafo estaba escrita tres veces y nada ataba las copias

- `GraphNode`, `GraphLink` y el resumen se declaran en el motor, **a mano otra vez** en la interfaz
  (que no puede importar de `src/`) y una tercera en los tests. Justo `label`, `scope` y `salience`
  —los tres que la pantalla dibuja— no los miraba ningún test. Comprobado: renombrar `label` en todo
  el motor dejaba `tsc` del motor **en cero errores** y la suite en verde, con el visor roto.
- `tests/graph-contract.test.ts` asigna lo que devuelve el motor al tipo que declara la interfaz, así
  que la divergencia falla en `pnpm typecheck` antes de que nadie abra el visor, y comprueba que esos
  tres campos viajen poblados.
- `paint.ts` tenía cinco funciones exportadas y **cero tests**, y `scopePalette` ninguno: su rama de
  más ámbitos que colores nunca se había ejecutado. Cubiertas las puras; el componente del panel sigue
  sin poder probarse porque el proyecto no tiene renderizador.

### Documentación que el código dejó mintiendo

- `docs/architecture.md` enmarcaba la degeneración como problema de pocos datos. Es del estimador: con
  `n = useA = useB` el NPMI da 1 con 20 turnos y con 10.000. Ahora lo dice, y documenta `max_n`, la
  ponderación por soporte, la diferencia entre `pairs` y `shown`, los parámetros `?scope=` y
  `?episodes=1`, y el bloque `truncated`.
- El `0` del NPMI está sobrecargado —"azar" y "no sé"— y los documentos se leían al revés entre sí.
- `AGENTS.md` no listaba la tabla `meta`, de la que depende el denominador del conectoma, y describía
  de menos a `connectome.ts` y a `relations.ts`.

### El panel del conectoma y el lienzo no miraban lo mismo

- `Pares: X de Y` contaba **Y sólo entre las memorias dibujadas** mientras `Turnos medidos` era
  global. Con 3.885 memorias y un tope de 400, el panel podía decir «0 de 0» habiendo pares
  medidos, y aconsejar bajar el soporte cuando lo que los dejaba fuera era el tope. Ahora `pairs`
  cuenta sobre toda la base, con un `COUNT` en el módulo que posee `co_use` en vez de materializar
  cada arista para leerle el `.length`, y el texto distingue los tres casos.
- `filterGraph` filtraba el conjunto de nodos pero **no recalculaba** su `co_use`: un vecino
  conservaba la fuerza de aristas que ya no se dibujaban y llevaba halo de hub con una sola arista
  en pantalla. Se reacumula sobre lo que queda, con la misma regla que el motor.
- **Dos máximos para el mismo brillo**: el lienzo normalizaba sobre lo filtrado y el panel sobre lo
  que mandó el servidor, así que el mismo nodo iba con halo lleno en el dibujo y punto apagado al
  lado. Ahora se mide una vez y se pasa a los dos.
- «Por dónde entrar» ofrecía nodos que la búsqueda o el grafo local habían dejado fuera; al pulsarlos
  la cámara perseguía un nodo inexistente y se rendía en silencio. La lista se limita a lo dibujado.
- Con las aristas por parecido **apagadas** se pedían igual: `relatedLinks` es O(n²) cosenos sobre
  hasta 400 memorias, unos 160.000 por petición, para descartarlos en el cliente. Van condicionadas
  como las demás capas.
- Dos pares de topes sin relación declarada —20 hubs del servidor contra 10 del panel, 120 caracteres
  de etiqueta contra 48 del lienzo— quedan nombrados y atados por un test.
- El grafo pedía `details` y `source_episode_ids` de **todas** las memorias del ámbito para dibujar un
  `gist` recortado a 120: el pico de memoria por petición crecía con el texto de la base. Lee sólo las
  columnas que dibuja.
- `co_use_min_n=1e400` llegaba como `Infinity` y salía en la respuesta como `null`, dejando un hueco
  donde el panel imprime el soporte mínimo. Y `escapeHtml` no cubría la comilla simple: basta para el
  cuerpo del tooltip de hoy, no para un atributo el día que alguien lo reutilice.

### El conectoma dejaba de avisar justo cuando más mentía

- Medido en producción el 2026-10-31: 3.885 memorias, 37 pares en `co_use`, **todos con `n = 1`** y
  ningún par repetido nunca, con el contador de turnos en 23. En ese estado NPMI vale **1 exacto**
  para los 37 —`log(T)/log(T)`, para cualquier `T`—, así que el ruido se dibujaba con el alfa y el
  grosor **máximos**: el triple que una arista por parecido, y más del doble que una asociación real
  medida (`n = 8` sobre 200 turnos puntúa 0,40).
- El aviso de muestra fina miraba `turns`, que es la variable equivocada: acumular turnos no diluye
  la degeneración, y al pasar de 20 el aviso **se apagó solo** mientras los datos seguían vacíos.
  Ahora mira el soporte, y el resumen viaja con `max_n` para que la interfaz pueda decirlo.
- La fuerza no se lee sin su soporte, que es lo que el tipo de la arista decía desde siempre y
  ningún consumidor leía. Lo leen los cuatro: el trazo, el halo, el aviso y el ranking de hubs.
  Un par visto una vez cae al suelo del trazo, que es no decir nada.
- `hubs()` ponderaba la suma sin soporte, así que un nodo con tres coincidencias le ganaba a un par
  repetido: "ordenados por asociación acumulada, no por vecinos" era falso en los datos reales. Cada
  `Hub` lleva ahora su `support` y la suma va ponderada.
- La regla vive en `engine/src/domain/support.ts`; la interfaz no puede importar de `src/`, así que
  conserva su copia y `tests/support.test.ts` falla si las dos dejan de coincidir.
- De paso, `queries/graph.ts` deja de reimplementar el acumulador de `store/connectome.ts`: el halo
  del lienzo y la lista del panel responden ya a una sola definición de hub.

### El logo oficial encabeza el README

- `docs/assets/logo.webp` y `logo-dark.webp`, el mismo logo con el fondo blanco quitado y la tinta en
  `#141311` o `#e8e4dc` según el tema; el rosa de marca no cambia. Un `<picture>` con
  `prefers-color-scheme` elige cuál, así que se lee igual en claro y en oscuro.
- Van encima del `<h1>`, que se conserva: el logo encabeza y el título sigue siendo texto, que es lo
  que leen el índice de GitHub y quien no ve la imagen.

### Capturas nuevas del visor en el README

- Las dos capturas pasan a ser del grafo: la vista entera con los ajustes abiertos y el grafo local
  alrededor de una memoria con su detalle al costado.
- Sin la barra del navegador, que al 48 % de ancho tapaba lo que la captura muestra.
- En `webp` en vez de `png`: **72 kB y 115 kB** frente a los 127 kB y 160 kB de las anteriores, con el
  texto igual de nítido.

### Los tests de uso de los CLI dejan de depender de la carga de la máquina (#213)

- `cli-usage-exit.test.ts` lanzaba el CLI con `npx tsx`: resolver el binario costaba más que la
  corrida, **1,6 s de 1,6 s**. El caso que lanza dos procesos se iba a 6 s con la máquina cargada y
  se pasaba del límite de 5 s de vitest, tumbando un `pnpm publish` entero desde `prepublishOnly`.
- Pasa a lanzar por `process.execPath` con `--import tsx`, como ya hacía `obsidian-cli.test.ts`:
  **de 6,0 s a 1,3 s** el caso que fallaba, y de 2,8 s a 0,7 s el otro. Además cada caso recibe el
  mismo presupuesto que ya le concedía a su subproceso, 60 s, en vez de los 5 s por defecto: el
  test se daba a sí mismo doce veces menos tiempo del que le daba al proceso que lanzaba.

## 0.7.0 — 2026-10-31

### La exportación a Obsidian no escribe fuera de `<bóveda>/misMEM/` (#206)

- Las rutas se comparan por su ruta real: una nota que es un enlace simbólico, o una carpeta enlazada que
  lleva fuera de `<bóveda>/misMEM/`, se omite y cuenta en `skipped`, y la pasada de borrado no la atraviesa.
  Un manifiesto que es un enlace detiene el export sin tocar la bóveda. Una carpeta enlazada colgante o en
  bucle cuenta como fuera, en vez de abortar la corrida a medias. Que la propia `misMEM/` sea un enlace sigue
  valiendo.

### Las dos variables de embeddings que quedaban fuera de `env.ts` (#187)

- `MISMEM_EMBEDDING_MIN_SCORE` y `MISMEM_EMBEDDING_MAX_CHARS` pasan por `envNonNegativeNumber` y
  `envPositiveNumber`, la convención de `engine/src/env.ts`.
- Sólo cambia un caso: con `MISMEM_EMBEDDING_MIN_SCORE` en blanco (`" "`) el corte quedaba en `0` y cualquier
  memoria con vector competía en los candidatos; ahora vuelve al default del modelo. El `0` explícito sigue
  valiendo como elección, y `MAX_CHARS` no cambia para ningún valor.

### `.env.example` remite a la guía que existe (#203)

- El comentario del servidor compatible con OpenAI apunta a `DEPLOY.md`, «Búsqueda por significado», en vez de a
  una sección del README que no existe, y el ejemplo de EmbeddingGemma 2 usa el corte de 0,65 que recomienda la guía.

### La documentación dice lo que hace el código (#186)

- `DEPLOY.md` daba a entender que EmbeddingGemma 2 arranca en 0,65: sólo `nomic-embed-text` sube el default a 0,65;
  cualquier otro modelo, EmbeddingGemma 2 incluido, arranca en 0,5 y hay que fijarlo a mano.
- `latest` sí se mueve al republicar a mano un tag viejo: el workflow lo habilita para `workflow_dispatch`,
  y la guía ahora avisa de despachar sólo el release vigente. Los ejemplos de tag pasan a `X.Y.Z` / `X.Y`
  para no envejecer con cada release.
- La arquitectura pierde la sección «Pendiente» (un binario con `bun --compile`, que no existe) y la
  validación menciona la excepción de los hooks, que se parsean a la defensiva.
- Salen de la guía de operación el relato del incidente de GHCR y las cifras sin base: los 310 MB que el
  instalador cifra en 296, y la medición del rescate en `docs/recall.md`, sin fecha ni versión. La historia
  ya está en las versiones anteriores de este fichero.
- Las tareas programadas se cuentan como son (tres tareas, cuatro entradas de cron) y
  `docs/standards/tests.md` ubica `distillFn` donde se define.
- Los tres documentos de operación pasan a formas impersonales, como pide la convención de español neutro, y el comentario del
  trinquete de tamaño deja de narrar PRs.

### La norma de comentarios se aplica a todo el código fuente (#171)

- Los comentarios de `engine/src`, `engine/ui/src` (sin `components/ui`, que es shadcn) y `engine/tests` están
  en inglés, con la cabecera y los bloques dentro de sus límites y sin historia ni notas de PR. Las
  descripciones de `it()` y `describe()`, los textos de la interfaz y los mensajes de error siguen en castellano.
- El registro de excepciones de `engine/tests/comments.test.ts` queda vacío: el mecanismo sigue ahí para una
  excepción justificada, pero el test ya no perdona ninguna violación.
- La calibración del rescate laxo que vivía en `recall/rescue.ts` pasa a `docs/recall.md`, y el comentario
  enlaza la sección. Los razonamientos largos que quedaban en tests van con el código que explican.
- Sólo cambian comentarios: el texto sin comentarios es idéntico antes y después. `docs/standards/comments.md`
  y `AGENTS.md` dejan de describir una lista de excepciones pendiente.

### Los comentarios tienen forma, y un test la comprueba (#171)

- `docs/standards/comments.md` fija la norma: todos los comentarios de `engine/src`, `engine/ui/src` y
  `engine/tests` en inglés; cabecera de módulo de tres líneas como mucho y sin inventarios; cualquier otro
  bloque de cinco como mucho, con la calibración en `docs/`; JSDoc de una o dos líneas sólo si la firma no
  dice el contrato; y nada de código comentado, historia, `TODO` sin issue ni `biome-ignore` sin motivo,
  cada regla con su ejemplo. `AGENTS.md` recoge lo mismo en sus convenciones.
- `engine/tests/comments.test.ts` extrae los comentarios y aplica seis reglas con etiqueta: `header`, `block`,
  `lang`, `todo`, `dead` y `sup`. Cada regla tiene su caso sintético, incluido el límite: tres líneas de
  cabecera pasan y cuatro no. El escáner vive en `engine/tests/support/source-scan.ts` y es el mismo que usa
  `architecture.test.ts`: entiende texto JSX con comillas, expresiones `${...}` anidadas y la diferencia entre
  división y expresión regular.
- `lang` ignora URLs y texto entrecomillado, exige dos palabras funcionales o un acento en una palabra en
  minúscula, y ya no basta con `sin` o `los`; `dead` reconoce llamadas, condicionales, funciones, `await`,
  asignaciones y `console.`, sin marcar prosa que acaba en punto y coma. `sup` exige motivo en cada
  `biome-ignore`.
- Las excepciones son un `Record<"ruta (regla)", { motivo, count }>` calculado ejecutando el test sobre el
  código actual: 173 entradas y 648 violaciones (49 de cabecera, 12 de bloque, 112 de idioma), ninguna de
  `TODO`, código comentado ni `biome-ignore`. Sólo encogen: el test falla si aparece una violación nueva en un
  fichero ya exceptuado, si sobra una excepción o si su cuenta cambia. Ningún comentario del código cambia en
  esta PR; la siguiente aplica la norma y vacía el registro.
- La norma corrige dos ejemplos que describían mal el código (el contrato de `isMismemDb` y el peso de la
  saliencia en RRF), alarga el ejemplo "Mal" de bloque a seis líneas, deja de usar `#171` como issue de
  `TODO`, y dice qué mide el test y qué queda en revisión (la longitud del JSDoc y el porqué).

### La interfaz parte `GraphView.tsx` y `MemoryView.tsx` (#170)

- El grafo deja en `GraphView.tsx` la consulta, el estado y la composición: los colores leídos del tema pasan a `lib/graph-tokens.ts` y el pintado de nodos y aristas a `components/graph/paint.ts`. La ficha de memoria saca el formulario de edición a `components/memory/EditForm.tsx`, los dos pasos de deshacer y olvidar a `hooks/use-memory-actions.ts` y sus textos a `lib/memory-text.ts`, que ahora tiene test. Nada visible cambia.

### La corrida de consolidación recibe un contexto y deja su estado aparte (#168)

- `engine/src/consolidation/run.ts` queda en `runConsolidation`: lee el entorno, arma el contexto de la
  corrida, recorre los ámbitos y cierra el resumen. `processScope` pasa a
  `engine/src/consolidation/scope.ts` con dos objetos con nombre, `RunContext` (db, cutoff, limits, llm,
  distillFn, dryRun, paretoPrefilter, log y uncitedStrikes) y `RunState` (llamadas gastadas, tope de la
  tanda y episodios saltados o aplazados), en vez de catorce posicionales.
- El presupuesto del prompt y el recorte pasan a `engine/src/consolidation/budget.ts`: `truncateEpisode`,
  `PROMPT_OVERHEAD_PER_EPISODE`, `TRUNCATION_MARK` y `fitPrompt`, que arma la tanda.
- Mismos episodios leídos, mismas llamadas al LLM en el mismo orden, mismos topes, mismos registros de log y
  mismo `RunSummary`. `engine/tests/architecture.test.ts` pierde la excepción de tamaño de
  `consolidation/run.ts`; `engine/tests/consolidation-budget.test.ts` fija el presupuesto como pieza pura.

### La exportación a Obsidian separa sus lecturas, su formato y su bóveda (#167)

- `engine/src/export/obsidian.ts` queda en `exportObsidian`, que orquesta: lee, arma los mapas de enlaces y
  entrega los ficheros al escritor. Las cuatro lecturas (memorias, rasgos, episodios consolidados y ámbitos)
  pasan a `engine/src/queries/export.ts`; el formato puro de cada nota (nombres, enlaces, frontmatter y
  cuerpo) a `engine/src/export/notes.ts`; y el manifiesto, la propiedad por frontmatter y la escritura o
  borrado a `engine/src/export/vault.ts`. `EXPORT_ROOT` sigue exportándose desde `obsidian.ts`.
- `mismem-obsidian` comprueba que el fichero es una base de misMEM con `engine/src/store/probe.ts`, que la abre
  en sólo lectura antes de que `openDb` migre el esquema o pase el journal a WAL.
- Mismos ficheros, mismos bytes, mismo manifiesto y mismas negativas. `engine/tests/export-notes.test.ts` fija el
  formato sin disco; `engine/tests/architecture.test.ts` pierde las dos excepciones de SQL y la de tamaño de la
  exportación, y `AGENTS.md` y `docs/architecture.md` describen el corte.

### Los alias de Engram y su migración dejan de escribir SQL (#166)

- `engine/src/mcp/engram-tools.ts` reúne `ENGRAM_TOOLS` y `EngramToolDef`; `engram-compat.ts` queda en el
  despacho y los helpers de argumentos. `mem_get_observation` lee por `engine/src/queries/observation.ts` y
  `mem_update` escribe por `engine/src/memory/engram-update.ts`: la memoria y el borrado de su vector, o el
  nombre de un rasgo, con el mismo fallback al episodio de siempre.
- `engine/src/migrate-engram-cli.ts` queda en argumentos, ayuda, llamada y salida. `engine/src/ingest/engram.ts`
  abre la base de Engram en sólo lectura, la lee entera y la migra en una transacción, con el mismo mapeo, los
  mismos ids determinísticos, la misma idempotencia y los mismos mensajes.
- `engine/tests/ingest-engram.test.ts` cubre la lectura, el mapeo, la idempotencia y la salida del CLI; los
  alias siguen fijados por `engine/tests/engram-compat.test.ts` sin cambios. `engine/tests/architecture.test.ts`
  pierde las dos excepciones de SQL de `mcp/engram-compat.ts` y `migrate-engram-cli.ts`, y `AGENTS.md` y
  `docs/architecture.md` describen el corte.

### El SQL del visor y de los CLI sale de la entrega (#165)

- Las lecturas de `engine/src/http/viewer/read.ts` y `api.ts` pasan a `engine/src/queries/`: `stats.ts` (los
  conteos del visor y el resumen de los dos CLI, con una función por forma), `recent.ts`, `scopes.ts`,
  `memories.ts` (lista y detalle), `traits.ts` (detalle), `graph.ts` y `forget-impact.ts`, más `views.ts` con
  la forma de una memoria y un rasgo. Las escrituras de `actions.ts` pasan a `engine/src/memory/edit.ts`.
- Los handlers y `mismem-stats` / `mismem-ingest` quedan en validar, llamar y responder. Las consultas, el
  orden de las operaciones, las claves y los códigos de las respuestas y la salida de los CLI se mueven sin
  editarlos.
- `engine/tests/queries.test.ts` cubre cada módulo, y `engine/tests/architecture.test.ts` pierde las cinco
  excepciones de SQL que ya no hacen falta. `AGENTS.md` y `docs/architecture.md` describen el corte.

### El despacho HTTP se prueba sin abrir un puerto (#164)

- `engine/src/server-http.ts` queda en leer el entorno, abrir la base, componer y escuchar. El despacho
  (Host, `/healthz`, `/mcp`, el POST del visor, los GET, 404 y 405) pasa a `engine/src/http/routes.ts`, que
  recibe por parámetro la base, la auth, los Hosts permitidos, el tope del cuerpo, el job de consolidación,
  las opciones de borrado, el transporte del MCP y la interfaz compilada.
- `engine/src/http/respond.ts` reúne `json` (que sale de `viewer/read.ts`) y las respuestas de texto que se
  repetían: 401 con su reto, 404, 405 y 413. Códigos, cabeceras, cuerpos y el orden de las comprobaciones no
  cambian.
- `engine/tests/http-routes.test.ts` llama al handler con peticiones y respuestas simuladas y fija ese orden;
  `server-http.test.ts` sigue lanzando el proceso real para bind, auth y Host.

### Una herramienta por fichero (#163)

- `engine/src/memory/tools.ts` (419 líneas) queda en `capture.ts`, `pending.ts` (la lista de episodios
  pendientes), `reinforce.ts` (con el registro de uso), `consolidate.ts`, `crystallize.ts` y `forget.ts`, y
  el camino del recall se muda a `recall/recall.ts` con `recall`, `recallHybrid` y la forma del hit. No hay
  barril: cada import nombra el fichero que lo exporta.
- `memory/` deja de importar de `recall/`: desaparece el único ciclo entre carpetas y, con él, las dos
  excepciones de capa y la de tamaño de `engine/tests/architecture.test.ts`.
- Sólo cambian rutas, imports y los nombres de las variables locales en castellano (`registrarUso` pasa a
  `recordUse`); las consultas y el orden de las operaciones se mueven sin editarlos, y `server-core.ts`
  sólo cambia sus imports.

### El ranking del recall se parte por política (#162)

- `engine/src/recall/search.ts` (510 líneas) queda en `fts.ts` (sintaxis de la consulta FTS5), `rescue.ts`
  (rescate laxo y sus constantes), `lexical.ts` (candidatos léxicos y sus tipos) y `fuse.ts` (RRF con la
  saliencia). No hay barril: cada import nombra el fichero que lo exporta.
- Sólo cambian rutas e imports: las constantes, las consultas y el orden de las operaciones se mueven sin
  editarlas, así que el ranking es el mismo.

### Una sola definición de las formas de fila (#161)

- `engine/src/store/rows.ts` reúne `MemoryRow`, `TraitRow` y `EpisodeRow` con los tipos del esquema de `db.ts`,
  además de `MEMORY_COLUMNS` y `SalienceRow`. El visor y la exportación a Obsidian dejan de declarar sus copias,
  que ya discrepaban en la anulabilidad de `consolidated_into`; quien selecciona menos columnas las deriva con
  `Omit` en vez de repetirlas, así que dos lectores ya no pueden discrepar sobre una columna.
- `excludeNoiseSql` pasa de `domain/noise.ts` a `store/rows.ts`, porque construye SQL: el dominio se queda con
  `isNoiseGist` y los prefijos. No cambia ninguna consulta ni el comportamiento.

### La interfaz parte `App.tsx` y `Lists.tsx` (#169)

- `App.tsx` (470 líneas) queda en composición: la cabecera, el diálogo de cristalizar, la barra de selección y los hooks de tema, atajos y debounce viven en sus propios ficheros. Las cuatro listas y sus primitivas pasan a `components/list/`, y el tipo `Selection` a `lib/selection.ts`, que rompe el ciclo de imports entre `App` y las listas. Nada visible cambia.

### engine/src se organiza por capacidad (#160)

- `engine/src` deja de ser plano: `hash.ts`, `terms.ts` y `noise.ts` pasan a `domain/`; `db.ts` y
  `connectome.ts` a `store/`; `tools.ts` y `salience.ts` a `memory/`; `search.ts` y `bench.ts` a `recall/`;
  `relations.ts` a `queries/`; `obsidian.ts` a `export/`; `engram-compat.ts` a `mcp/`; `inject.ts`, `usage.ts`,
  `hook-client.ts` y `hook-readiness.ts` a `hooks/`; y los módulos del servidor HTTP a `http/` y
  `http/viewer/`, con `pareto/classifier.ts` en `consolidation/pareto.ts`. Sólo cambian rutas e imports: no
  se parte ningún fichero ni cambia lógica.
- `engine/tests/architecture.test.ts` fija la lista de ficheros de la raíz, la matriz de dependencias entre
  carpetas, la pureza de `domain/`, la ausencia de SQL en la entrega y el trinquete de 400 líneas, con
  excepciones explícitas que sólo encogen.
- Nada de eso cambia lo que se publica: `dist/server.js`, `dist/server-http.js` y `dist/*-cli.js` conservan
  su ruta y su nombre.

### El conectoma se puede ver (#208)

- El visor gana un modo de iluminación sobre el mismo grafo: en *Ajustes del grafo* → **Conectoma**
  se encienden las aristas por co-uso, y los caminos y los nodos se alumbran según su asociación.
  El dibujo que abre no cambia: el modo nace apagado y lo que ya había se pinta igual.
- La luz sale de la fuerza, no del conteo. Una arista se vuelve más viva y más gruesa cuanto más
  arriba de lo que predice el azar aparece el par; en 0 o por debajo no se ilumina, porque un par
  que se evita no es un camino. Cada nodo lleva un halo con su asociación acumulada, normalizado
  contra el más fuerte a la vista: un grafo de asociaciones flojas se lee solo, sin quedar negro.
- El costado deja de ser decorativo: dice **cuántos turnos** se midieron, cuántos pares hay y
  cuántos se dibujan, y lista *por dónde entrar* — los nodos ordenados por asociación acumulada y
  no por vecinos, cada uno clicable. Un control de soporte mínimo filtra los pares de poca
  evidencia, y viaja al servidor para que los hubs describan las mismas aristas que se pintan.
- **Por debajo de 20 turnos medidos el panel lo dice en vez de dejar que el dibujo mienta**: con
  pocos datos, dos recuerdos usados una vez y juntos esa vez dan el máximo. Comprobado con una
  base de un solo turno, que es como se ve una instalación recién actualizada.

### El paquete que se publica es el que compilan las fuentes (#210)

- `pnpm build` borra `dist/` antes de compilar. `tsc` sólo añade, así que un módulo borrado de
  `src/` seguía compilado en disco y viajaba dentro del tarball: medido sobre este repositorio,
  **81 ficheros sobrantes y 27 módulos muertos** de la estructura anterior a la reorganización
  (`viewer.js`, `search.js`, `salience.js`, `tools/`, `pareto/`…). Lo que se publicaba dependía de
  lo que el publicador tuviera en disco, no de las fuentes.
- El job `packaging` de CI lo vigila con dos comprobaciones nuevas: que un fichero plantado en
  `dist/` no sobreviva al siguiente `build`, y que el tarball lleve `dist/ui/index.html`. Sin la
  interfaz compilada, `/viewer` responde 503 sólo a quien instala desde npm, porque en el
  repositorio siempre está construida al lado.

## 0.6.0 — 2026-10-29

### El olvido respeta `before_days` también al borrar memorias

- `forget` borraba los episodios de una memoria de saliencia baja aunque alguno fuera más nuevo que `before_days`. Con los defaults de `mismem-forget` (90 y 30 días), un episodio de 40 días atado a una memoria olvidable se borraba antes de los 90 que promete `before_days`. Ahora la memoria sólo es olvidable cuando todos sus episodios ya superaron `before_days`; mientras quede uno más nuevo, la memoria y sus episodios esperan. Las memorias sin episodios o con todos viejos se borran igual que antes, y sus episodios con ellas para que `ON DELETE SET NULL` no los devuelva a pendientes.
- El conteo de `dry_run` sale de las mismas consultas que el borrado, y un test compara lo que anuncia con lo que después borra.

### Embeddings: mejores valores por defecto para quien instala misMEM (#72)

- Con `nomic-embed-text` el corte semántico de 0,5 no cortaba nada: las 10 preguntas ajenas de la
  medición traían 5 recuerdos cada una, así que el hook de inyección añadía recuerdos sin relación a
  cada prompt. Sin `MISMEM_EMBEDDING_MIN_SCORE`, el corte por defecto ahora depende del modelo: 0,65
  para `nomic-embed-text` (también con etiqueta, p. ej. `:latest`) y 0,5 para el resto. Con 0,65 las
  preguntas ajenas bajan a 0 recuerdos sin perder aciertos. Un valor explícito, incluido `0`, sigue
  ganando siempre.
- `scripts/install.sh`: si hay `llama-server`, ofrece EmbeddingGemma 2 como opción recomendada.
  Con memorias en castellano encontró 34 de 50 paráfrasis frente a 4 de 50 de `nomic-embed-text`
  (medición de la issue). Baja el GGUF (296 MB) sólo si el usuario dice que sí, deja `llama-server`
  como servicio de systemd de usuario (`mismem-embed`, en CPU; `--embeddings-gpu` o la pregunta
  interactiva lo pasan a la GPU) y escribe en `~/.config/mismem/env` el proveedor, los prefijos y el
  corte 0,65. `nomic-embed-text` por Ollama queda como alternativa ligera. Con `--yes` el modelo no
  cambia salvo que se pida con `--embeddings gemma|nomic`: re-ejecutarlo conserva tal cual cualquier
  configuración de embeddings que ya hubiera (otro modelo, otro servidor, prefijos, corte) y no duplica el
  servicio. Si se vuelve a nomic, el servicio `mismem-embed` que montó el instalador se para y se
  desactiva para no dejar ocupados el puerto y la memoria. Con EmbeddingGemma 2 elegido pero sin servidor
  arrancado no se escribe `MISMEM_EMBEDDINGS=off`: la búsqueda degrada a palabras y se activa sola cuando
  el servidor arranca.
- README y `DEPLOY.md` dicen claro que con memorias que no estén en inglés la opción es EmbeddingGemma 2,
  que con `nomic-embed-text` el corte es 0,65 y no hay que esperar paráfrasis, y que el corte de
  EmbeddingGemma 2 recomendado pasa de 0,68 a 0,65 (misma efectividad medida, con más recuerdos por
  pregunta).

- El timeout de embeddings y el puerto HTTP dejan de aceptar valores imposibles: un negativo, basura, 0 o vacío vuelven a 3000 ms y a 3200 (antes `MISMEM_EMBEDDING_TIMEOUT_MS=-5` hacía que `AbortSignal.timeout` lanzara `RangeError` y un `MISMEM_HTTP_PORT` con basura llegaba a `listen` como `NaN`); `prepublishOnly` usa pnpm.

### jscpd sube a 5.4.1, y sus dos clones de más desaparecen

- `jscpd` pasa de 4.3.0 a 5.4.1 (versión exacta). La 5 compara dos bloques que la 4 no veía: `recall` y
  `recallHybrid` montaban igual la lista de hits, ahora en `finalizeHits`, y `MemoryList`/`PendingList`
  repetían el `<ul>` y el pie de "cargar más", ahora en `PagedList`. `pnpm dup` sigue con umbral 0 y no
  encuentra clones; no hay cambios de comportamiento ni visibles.

### `AGENTS.md` como contrato de trabajo

- `AGENTS.md` deja de ser las antiguas instrucciones de Copilot: mapa del código actual, comandos, reglas duras con
  su porqué, convenciones y trampas propias del repo, y enlaces al resto de la documentación en vez de copiarla.

### Un estándar de contribución escrito, y comprobado

- Contribuir no tenía forma: ni formularios de issue, ni plantillas de PR, ni normas escritas, y el
  README mezclaba la presentación con material de referencia y con la historia de cada iteración. Ahora
  `CONTRIBUTING.md` es la puerta de entrada (entorno, flujo trunk-based, estándar de issue y de PR,
  etiquetas, releases) y `docs/standards/` fija ramas, commits, comentarios, estilo, tests, seguridad y
  releases, cada norma con su forma de comprobarla. `docs/README.md` dice qué documento es para quién y
  qué no se documenta.
- `.github/` gana cuatro formularios de issue (error, mejora, documentación y medición de recall, cada
  uno con su criterio de cierre), los issues en blanco desactivados con un enlace al reporte privado de
  vulnerabilidades, una plantilla de PR por defecto y tres más (`release`, `dependency`, `documentation`),
  `release.yml` para agrupar las notas por etiqueta y `CODEOWNERS`.
- Las etiquetas que citan los formularios, las plantillas, `release.yml` y `CONTRIBUTING.md` se declaran
  en `.github/labels.json`. `engine/tests/contribution-standard.test.ts` falla si alguno cita una que no
  existe, o si un tipo se queda sin formulario ni excepción razonada; el workflow `labels.yml` compara
  ese fichero con las etiquetas que tiene GitHub.
- Dependabot deja de proponer saltos de versión mayor de `node` en el Dockerfile: los majors se mueven a
  mano a una LTS.
- El README pasa a ser una guía: qué es, un diagrama del sistema, el Quickstart primero y un mapa de la
  documentación. Lo que era referencia se mueve sin perder nada: el comportamiento del recall y la
  búsqueda por significado a `docs/recall.md`, los hooks a `docs/hooks.md`, y las capas, los componentes,
  la saliencia y el índice hebbiano a `docs/architecture.md`. El roadmap por fases de `engine/README.md`
  desaparece (la historia es este fichero) y la consolidación deja de repetir el despliegue de `DEPLOY.md`.

### zod 4

- zod pasa de 3.25.76 a 4.6.7 (versión exacta): `.int()` rechaza enteros fuera del rango seguro de JS (y el `inputSchema` de `forget` lo anuncia), los límites de longitud cuentan *code points* en vez de unidades UTF-16 y cambian los textos de `ZodError`; `tests/tool-schemas.test.ts` compara con `z.toJSONSchema` en vez de leer internos de zod 3.

### Un solo diálogo de confirmación en el detalle

- `MemoryView` y `TraitView` repetían el pie del diálogo de confirmación y la forma de sus props. Ambos viven ahora en `DetailParts.tsx` (`ConfirmDialog` y `DetailViewProps`), sin cambios visibles, y `pnpm dup` pasa a exigir umbral 0: ningún bloque copiado de 10 o más líneas.

### `@vitejs/plugin-react` sube a 5.2.0

- `@vitejs/plugin-react` pasa de 4.7.0 a 5.2.0, fijado exacto. `ui/vite.config.ts` llama a `react()`
  sin opciones y la 5.x sólo deja de añadir `react`/`react-dom` a `resolve.dedupe`, que aquí sobra.

### Linter con Biome, y fuera las directivas de ESLint que no hacían nada

- No había linter ni formateador. Ahora Biome 2 es el único, sólo como linter: `pnpm lint` y un step
  de CI justo después de `pnpm dup`. El formato no se toca a propósito. `biome.json` limita el
  análisis a `src/`, `ui/src/` y `tests/` en TypeScript, y deja fuera `ui/src/components/ui`, que es
  shadcn vendorizado, además de CSS, JSON y fixtures.
- Las cinco directivas de supresión de ESLint no desactivaban nada: cuatro `no-console` en
  `server-http.ts` y `used-cli.ts`, y un `no-explicit-any` en `viewer-api.test.ts`. Ese `any`
  escondía dos huecos: el mock no implementa `ServerResponse` y el cuerpo de la respuesta no tenía
  tipo. Ahora el mock se ensancha una sola vez al pasarlo al handler y el cuerpo tiene `ApiBody`.
- Reglas recomendadas desactivadas, todas por patrones deliberados del repo: `noNonNullAssertion`
  (los guardas y los tests afirman con `!` justo después de comprobar longitud o nulidad; reescribir
  los 24 usos serían cambios cosméticos), `useSemanticElements` (los roles `search`, `group` y
  `meter` son ARIA válido sobre elementos con estilos; cambiarlos por `fieldset`, `meter` o
  `search` cambiaría el marcado y el CSS sin arreglar nada) y `noAutofocus` (el formulario de
  edición enfoca el campo al abrirse). `useExhaustiveDependencies` sigue activa pero no avisa de
  dependencias de más: `GraphView` repite `size.width` a propósito para reaplicar el estado cuando
  el canvas termina de montarse. `biome.json` es JSON estricto y Biome no acepta comentarios ahí,
  así que el porqué queda en esta entrada.
- Los errores que sí eran defectos, arreglados: ocho `let` sin tipo en los CLI y el `entries` de
  `walk.ts`, tres `return` que devolvían un `void` en `viewer-static.ts`, la comprobación de
  `content-type` sin cadena opcional en `http-body.ts`, un `break` con etiqueta que no hacía nada en
  `consolidation/run.ts`, los `any` de los tests y las claves por índice de los esqueletos de carga.

### Errores, claves y ayudas en el idioma del producto

- Los errores que ven un cliente MCP o el viewer salían en inglés (`Unknown tool`, `not found`,
  `is required`, `invalid layer`) mientras el resto del producto responde en español. Ahora están en
  español, con el mismo contenido y el mismo código de estado.
- La confirmación de olvido mezclaba claves en los dos idiomas (`impacto`, `memorias_que_cita`,
  `rasgos_que_la_citan`, `episodios`). Pasan a `impact`, `memories_cited`, `traits_citing` y
  `episodes`; la UI y los tests leen las nuevas claves.
- Las ayudas de `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-migrate-engram`,
  `mismem-obsidian` y `mismem-embed` usan los encabezados `Uso:` y `Variables:`, y la de
  `mismem-ingest`, que estaba entera en inglés, también está en español. Los encabezados de las ayudas
  pasan a `misMEM: CLI de ...`, el progreso de `mismem-migrate-engram` y la cabecera de `mismem-stats`
  están traducidos, y los fallos de todos los CLIs salen con el prefijo `ERROR:` en vez de `FATAL:` o
  `Error:`. Los flags y lo que hace cada comando no cambian.
- El servidor HTTP responde en español el 415 de `/mcp`, el error de parseo de JSON-RPC (mismo
  `-32700`), las acciones y endpoints desconocidos y los 404, también los del viewer. Los códigos de
  estado, los identificadores y los nombres de tools no cambian.

### Una conversación de ChatGPT sin texto no se importa

- `ingestChatGPTExport` decidía si saltarse una conversación mirando la cadena ya montada, y
  `flattenConversation` siempre emite la cabecera `# título` y `Created:`. Una conversación con
  todos los mensajes vacíos o de sistema se importaba como un episodio con sólo título y fecha.
  Ahora la decisión se toma sobre los mensajes con texto y esa conversación cuenta como `skipped`.

### Una sola versión, y comprobada

- La versión estaba escrita a mano en `engine/package.json`, `server.json` (dos campos) y
  `engine/src/server-core.ts`, y nada comparaba las cuatro. Un release podía anunciar por MCP una
  versión distinta de la publicada. Ahora `server-core.ts` lee `engine/package.json` al cargarse
  (`createRequire`, que funciona igual desde `src/` con tsx que desde `dist/`), y `tests/version.test.ts`
  falla si el `serverInfo` que ve un cliente MCP o cualquiera de los dos campos de `server.json` deja de
  coincidir con el paquete.
- `DEPLOY.md` recuerda que los tags van anotados (`git tag -a vX.Y.Z -m 'misMEM X.Y.Z'`).

### Higiene del repositorio: reportar en privado, dependencias y secretos

- `SECURITY.md` dice cómo reportar una vulnerabilidad en privado (GitHub Private Vulnerability
  Reporting), que sólo la última versión publicada recibe arreglos y qué cuenta como
  vulnerabilidad acá: la autenticación del modo HTTP, y esa DB que tiene toda la memoria. Antes
  no había ningún canal privado, así que el reporte terminaba en un issue público.
- Las convenciones pasan de `.github/copilot-instructions.md` a `AGENTS.md`, que leen todos los agentes (Claude Code a través de `CLAUDE.md`, que lo importa); el fichero de Copilot desaparece.
  `install.sh` configura Claude Code y opencode, y hasta ahora sólo Copilot cargaba esas
  convenciones: los otros dos agentes trabajaban sin ellas.
- `.github/dependabot.yml` saca la actualización de dependencias de la mano de nadie: npm en
  `engine/` (minor y patch agrupados en un PR), los actions, que están fijados por SHA y sin
  esto no se mueven nunca, y el `node:22-alpine` del Dockerfile.
- El job `secret-scan` de CI corre gitleaks sobre todos los commits en cada PR y en cada push a
  `main`, con la imagen fijada por digest. Nada buscaba una clave commiteada antes de que llegara
  a `main`.
- `.gitignore` cubre `*.db-journal`, el diario que SQLite deja al lado de la DB cuando no
  trabaja en modo WAL.

### Ningún CLI se traga un flag mal escrito

- `mismem-embed`, `mismem-bench`, `mismem-stats` y `mismem-migrate-engram` ignoraban los flags que no
  entendían: un `--scop daimon` reindexaba o contaba todos los ámbitos, un `--jsn` dejaba la salida en
  texto, un `--dryrun` migraba de verdad y un `--batch abc` caía al valor por defecto. `mismem-ingest`
  hacía lo mismo con los posicionales de más. Ahora cada uno parsea en su `<cli>-args.ts`, como
  `consolidate` y `forget`, y un flag o posicional inesperado corta con `argumento desconocido: <x>` y
  exit 64. Un valor ausente (`--scope`, `--batch`, `--limit`, `--source`) también corta, un posicional
  de ingest en blanco cuenta como ausente, y un subcomando de `mismem-ingest` que no existe se rechaza
  en vez de imprimir la ayuda.
- `mismem-stats` abría la base y, si una consulta fallaba, moría con la base abierta y sin mensaje.
  Ahora la cierra en un `finally` y el fallo sale por stderr como `[stats] FATAL: ...` con exit 1.

### La imagen y el paquete dejan de arrastrar lo que no usan

- Sin `engine/.dockerignore`, un `docker build` local mandaba al daemon `node_modules`, `dist`,
  `coverage` y cualquier `.db` que hubiera en `engine/`. El Dockerfile no los usa: sólo copia
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `src` y `ui`.
- Las dos etapas fijaban la base por tag (`node:22-alpine`), así que un rebuild meses después
  compilaba contra otra Alpine sin que nadie tocara el repositorio, y `better-sqlite3` es nativo.
  Ahora van por digest, con el tag legible al lado.
- La etapa runtime copiaba `node_modules` entero, con vite, typescript, react y vitest dentro de una
  imagen que sólo ejecuta `dist/server-http.js`. Tras `pnpm build` se hace `pnpm prune --prod`;
  `better-sqlite3` es dependencia de producción y se queda (probado con `docker build`).
- El paquete npm declaraba `MIT` sin llevar el texto de la licencia. `engine/LICENSE` es copia
  literal de la raíz y entra en `files`. En CI, `cmp LICENSE engine/LICENSE` falla si se separan, y
  hadolint revisa el Dockerfile con la imagen fijada por digest.

### `mismem-http` escucha sólo en loopback por defecto

- Sin `MISMEM_AUTH_*`, el servidor escuchaba en `0.0.0.0` y la guarda de `Host` sólo frena el
  DNS rebinding del navegador: cualquier cliente de la LAN puede mandar `Host: localhost`. Ahora el
  valor por defecto de `MISMEM_HTTP_HOST` es `127.0.0.1`. Para mantener el comportamiento anterior,
  `MISMEM_HTTP_HOST=0.0.0.0` junto con `MISMEM_AUTH_USER` y `MISMEM_AUTH_PASS`. Los contenedores no
  cambian: el Dockerfile y el ejemplo de compose ya fijan `0.0.0.0`.
- El fichero SQLite, con toda la memoria, se creaba con el umask por defecto. Ahora queda en `0600`
  (y sus `-wal` y `-shm`), y el directorio, si lo crea mismem, en `0700`. Un directorio que ya existía
  no se toca.

### Fuera el código muerto

- Se retiran `src/tools/dump-engram.ts`, `ingest-engram-dump.ts` y `smoke-recall.ts`: scripts de una sola vez
  que nada importaba ni documentaba, pero se compilaban dentro del paquete npm, y uno apagaba la
  verificación TLS antes de mandar la cabecera `Authorization`. Para migrar desde Engram sigue
  `mismem-migrate-engram`, que lee un `engram.db`. `ENGRAM_URL` y `ENGRAM_AUTH` salen de `.env.example`.
- `pnpm knip` corre en CI: falla con ficheros, exports o dependencias sin uso.

### El índice hebbiano empieza a existir

- `reinforce` recibía los `memory_ids` **juntos** —sabe que esos recuerdos se usaron en el mismo
  turno— y lo colapsaba en un bump de saliencia por recuerdo. Tiraba justo la co-ocurrencia, que
  es la señal hebbiana de verdad. Ahora la guarda: `memories.use_count` cuenta los turnos en que
  cada recuerdo se usó, y `co_use(memory_a, memory_b, n, last_at)` cuenta cada par que se usó junto.
- Se escribe desde `reinforce` y **no** desde `reinforceMemories`, porque a esa última la llama
  también el camino de recall, donde aparecer no es haberse usado. Con la reinyección por aparición
  apagada (`MISMEM_REINFORCE_ON_RECALL=off`) la señal arranca limpia: `use_count` en 0 para todos.
- Hacía falta porque `salience` hoy mide recencia, no uso: la pasada de decay escribe
  `salience_updated_at` en las 3.738 memorias, así que el campo no distingue "se usó" de "se
  marchitó". Medido sobre producción: de 1.351 memorias de más de 60 días sólo 14 tienen saliencia
  por encima de 0,85, y entre ésas hay tres marcadores de ruido `[pareto:l0]`. Ordenar por
  saliencia hoy pone arriba lo nuevo, no lo importante.
- Migración aditiva, verificada sobre copia de la DB de producción: 15 ms, `integrity_check` y
  `foreign_key_check` ok, 3.738 memorias y 216 rasgos intactos. Los pares se van por cascada
  cuando el recuerdo se borra.
- Para qué: es la fase 1 del ordenador de memoria.

### El refuerzo por uso ve lo que la inyección adelantó

- Los dos hooks no se enganchaban: `mismem-used` sólo reconocía resultados de `recall`, y lo que
  `mismem-inject` adelanta llega como adjunto `hook_additional_context`, no como `tool_result`. Un
  recuerdo inyectado y usado nunca sumaba saliencia. Medido sobre un transcript real: la inyección
  había dejado 6 ids en el turno y se veían 0.
- `parseInjection` es lo inverso de `formatInjection` y vive en el mismo archivo, para que el
  formato y su lectura no puedan derivar.
- `reinforce` cuenta los rasgos aparte (`traits`) en vez de meterlos en `unknown`. La inyección
  también adelanta rasgos, así que mezclarlos dejaba esa alarma —la de "alguien manda ids
  inventados"— sonando desde el primer día.
- Aportado por [@iDiagoValeta](https://github.com/iDiagoValeta) en #48, con el hallazgo de los
  rasgos que quedaba abierto ahí.

### El README dice lo que el código hace

- Seis gestos, no cinco: faltaba `reinforce`, y `recall` ya no refuerza siempre.
- Los binarios de los hooks (`mismem-inject`, `mismem-used`) y una sección que explica para qué
  sirven, qué no sale de la máquina y cómo se enciende el refuerzo por uso.
- Dos lugares seguían diciendo cinco invocaciones mientras el título decía seis. Ahora los tres
  dicen lo mismo.
- El viewer: la API de sólo lectura ya expone los ámbitos, el origen de cada recuerdo, los rasgos
  que lo citan y el grafo (`/api/{scopes,memories,memory/:id,trait/:id,graph}`), y el README
  mencionaba sólo los tres endpoints originales.
- La consolidación acepta OpenAI y cualquier servidor compatible desde #67, y tanto los
  componentes como la sección de privacidad hablaban sólo de DeepSeek y OpenRouter. Importa
  porque es lo que permite consolidar sin que el texto salga de la red propia.
- Una sección para el índice hebbiano.
- El README y DEPLOY.md mandaban a `docker pull ghcr.io/lucasmella-stack/mismem-brain:latest` como
  camino recomendado, y esa imagen **nunca se publicó**: las tres corridas de `docker.yml` fallan
  al empujar con `denied: permission_denied: read_package`, así que el `pull` responde `denied`.
  Cualquiera que siguiera el README se chocaba con eso. Ahora el camino documentado es el build
  local, que sí funciona, y la imagen publicada queda marcada como pendiente.
- Una sección de agradecimiento con lo que trajo [@iDiagoValeta](https://github.com/iDiagoValeta),
  que a esta altura es buena parte de lo que hace a misMEM instalable y auditable por alguien que
  no sea su autor.

### La memoria se puede exportar como bóveda de Obsidian

- `mismem-obsidian` escribe la memoria como bóveda en `<bóveda>/misMEM/`: una nota por memoria,
  rasgo y ámbito, enlazadas por origen y por parecido.
- Re-exportar sólo borra las notas cuyo frontmatter sigue declarando el id del manifiesto, y se
  niega si la base no tiene nada que exportar o el manifiesto no se puede leer: así una bóveda
  migrada a mano no se vacía por error.

### La interfaz deja de ser de sólo lectura

- UI React con shadcn y TanStack Query: listas, detalle, grafo 2D con filtros y búsqueda dentro
  del grafo.
- `viewer-actions.ts` expone POST desde el propio origen para corregir una memoria, deshacer su
  consolidación, cristalizar y lanzar una consolidación.
- Olvidar una memoria (con sus episodios) o un rasgo exige `MISMEM_VIEWER_ALLOW_DELETE=1` y dos
  pasos: el primero devuelve qué se perdería y un token de 60 s, y borra el segundo.

### La búsqueda léxica rescata paráfrasis

- Sin capa semántica, una consulta estricta (todas las palabras) que no encontraba nada dejaba
  fuera la paráfrasis que sí estaba. Ahora `recall` reintenta con una consulta OR y conserva sólo
  los candidatos que comparten al menos dos términos informativos (una con una consulta de una
  palabra, el 30 % en las largas), con un tope de 3 por capa (rasgos, episodios y memorias).
- El rescate sólo entra cuando la estricta no devolvió nada y no hay vectores comparables que
  puntuar, para no alterar una búsqueda que ya funcionaba.

### Instalación en Linux con un solo script

- `scripts/install.sh` instala y configura misMEM: elige dónde vive la DB y con qué proveedor
  consolidar, guarda la clave en `~/.config/mismem/env` con permisos 600 y deja los clientes
  llamando a `~/.local/bin/mismem-run`, sin credenciales en su configuración.

### El servidor HTTP se protege sin auth

- `MISMEM_ALLOWED_HOSTS`: sin auth, sólo se atienden `Host` de loopback y el resto responde 403,
  contra DNS rebinding.
- `MISMEM_HTTP_MAX_BODY_BYTES`: `POST /mcp` corta el cuerpo en 4 MiB con 413 sin juntarlo en
  memoria, y un `Content-Type` que no es JSON responde 415 antes de leer.

### El conectoma se puede mirar

- `/api/graph?co_use=1` suma una segunda capa lateral. La que ya había, `?related=1`, une memorias
  **parecidas**: sale de lo que cada una dice. Esta sale de lo que **pasó**: qué recuerdos usó junto
  un mismo turno. Las dos juntas valen más que cada una —parecidas que nunca se usan juntas son
  candidatas a que una reemplace a la otra— pero eso es otra entrada.
- El peso **no** es el conteo crudo, es NPMI. Un recuerdo que se usa en todos los turnos co-ocurre
  con todo, así que por conteo sería el centro del grafo sin orientar a nada: el mismo error de la
  saliencia midiendo recencia. Con NPMI, 0 es "indistinguible del azar" y 1 "nunca aparecen
  separados". Hay un test que construye el caso y falla si el ranking se ordena por grado;
  comprobado mutando el comparador.
- Hacía falta un denominador y no existía: la tabla `meta` guarda el total de turnos de uso medido,
  y se suma dentro de la misma transacción que los conteos de `co_use` para que no pueda quedar
  desfasado. Migración aditiva.
- Con pocos datos la fuerza es ruido por construcción —dos recuerdos usados una sola vez, esa vez
  juntos, dan 1—, así que cada arista viaja con su `n`, `?co_use_min_n=k` filtra por soporte y el
  resumen informa el tamaño de la muestra. Los costados de la interfaz tienen que poder decir "esto
  todavía no significa nada" en vez de pintar ruido.
- Sin el parámetro la respuesta no cambia: las aristas verticales no reciben campos nuevos y hay un
  test que compara las dos respuestas.
- Sobre copia de producción: migración en 18 ms, `integrity_check` y `foreign_key_check` ok, 3.805
  memorias y 216 rasgos intactos, y las seis aristas existentes dan fuerza 0 porque el contador nace
  ahora. Es correcto: son turnos que nadie midió, y 0 dice "no sé" en vez de inventar un número.

### El contador de turnos nace con la cota que los datos permiten

- Un cerebro que ya venía midiendo co-uso con la versión anterior guarda `n` y `use_count` de turnos
  que nadie contó. Con el contador en 0 toda fuerza vale 0, que es correcto —dice "no sé"—, pero
  **desde el primer turno medido después de actualizar** el cociente `n / turnos` se acota a 1 y cada
  par heredado se lee como asociación máxima: justo el club de los ricos que el peso existe para
  evitar. Duraba hasta que el contador pasaba por arriba de cada `n`.
- Al abrir, si el contador no existe, se siembra con el uso más alto registrado (`max(use_count)` y
  `max(n)` de `co_use`). Es una cota inferior de los turnos que hubo, porque cada uso ocupó un turno:
  subestima, nunca infla. Sólo cuando falta: un contador andando es la medición de verdad y no se pisa.
- Sobre copia de producción (2.527 memorias, 2.651 episodios, esquema previo a `use_count`): migración
  en 19 ms, nada perdido, y no siembra nada porque ahí no hay uso medido —un cerebro viejo no recibe un
  contador inventado—. Con 40 turnos reinyectados sobre ids reales, el par identidad+acompañante da
  0,112; sin semilla, el primer turno tras el deploy lo sube a **1**; con semilla (38, la cota) vuelve a
  **0**, que es la respuesta correcta para algo que acompaña a un recuerdo que está en todos los turnos.
  El par poco usado se queda en 1 con `n` de 3, y para eso está `?co_use_min_n=k`.
- El test que lo cubre afirma las dos lecturas, la de antes y la de después, así que el artefacto queda
  escrito en la suite en vez de en un comentario.

### La imagen de GHCR existe

- `ghcr.io/lucasmella-stack/mismem-brain` se publica de verdad: `0.5.0`, `0.5` y `latest`, multi-arch
  (`linux/amd64` y `linux/arm64`), con pull anónimo. Es la primera imagen que llega al registro desde
  que existe el repo, y `latest` deja de apuntar al `0.2.0` de julio de 2026.
- No hacía falta cambiar nada del workflow. Los push de v0.1.0 y v0.2.0 habían creado el paquete en
  julio, GitHub no lo vinculó al repositorio, y desde v0.3.0 todo push moría en `denied:
  permission_denied: read_package`. El paquete tampoco se veía en la lista de la cuenta por estar
  privado y sin vincular. Dos cambios en *Package settings*: el repo con rol **Write** en *Manage
  Actions access*, y la visibilidad a **Public**.
- El Quickstart de Docker del README pasa a ser `docker run ghcr.io/...` en vez de clonar y construir,
  y en `DEPLOY.md` la imagen publicada pasa a ser la opción A: el build en el servidor queda como la
  alternativa para probar un cambio sin pasar por un release. El diagnóstico queda escrito ahí, con el
  comando de `gh api` que hace visible un paquete privado sin vincular y el `docker logout ghcr.io`
  para las máquinas con credenciales viejas.

## 0.5.0 — 2026-10-23

### Que el LLM ignore un episodio ya no lo condena a la primera

- Un episodio que el LLM leía y no citaba en ninguna memoria quedaba atado a un marcador
  `[noise]` con `salience=0.05`, y `forget` lo borraba junto con el episodio. Una sola omisión del
  modelo bastaba para perder el contenido.
- Ahora cada tanda sin citar suma un strike (`uncited_count`). Recién al llegar a
  `MISMEM_CONSOLIDATION_UNCITED_STRIKES` (3, `--uncited-strikes`) el episodio pasa a ruido; mientras
  le queden, vuelve en la corrida siguiente. Reintentarlo cuesta los tokens de una tanda que ya se
  paga, no una llamada extra, y dentro de la misma corrida no se repaga.
- El resumen informa `episodes_uncited_pending`.
- Migración aditiva: `episodes.uncited_count` arranca en 0 para todo lo que ya existe.

### Una preferencia corta ya no se descarta antes del LLM

- El pre-filtro Pareto mandaba a L0 (ruido, sin pasar por el LLM) cualquier texto de menos de 40
  caracteres sin densidad: "prefiero Rust para el backend" entraba ahí, porque los patrones de
  densidad sólo reconocían código y decisiones.
- Se agregaron patrones de preferencia (`prefiero`, `uso`, `me gusta`, `dejé de`, `en vez de`,
  `elijo`, `mejor que`…), así que una preferencia breve suma densidad y llega al LLM.

### Los marcadores de ruido ya no compiten en el recall

- Las memorias `[noise] …` y `[pareto:l0] …` existen sólo para que `forget` sepa qué episodios
  borrar, pero entraban en FTS5 y en el índice semántico como cualquier otra. Desde que la relevancia
  manda sobre la saliencia, `salience=0.05` ya no alcanzaba para hundirlas: sobre la copia de
  producción, "señal" devolvía 4 marcadores de 5 memorias y "episodios" los 5 de 5.
- Ahora quedan afuera del recall por palabras y por significado, y tampoco gastan un embedding
  (`noise.ts` tiene la única definición de qué es un marcador). `forget` y el viewer los siguen viendo.
- Medido con `mismem-bench` sobre la copia de producción, con el servidor de embeddings arriba:
  `parafrasis` sube de 56/80 (70 %) a 58/80 (73 %), `literal` queda en 78/80 y las ajenas en 0/10.
  Los marcadores que llegaban al tope pasan de 43 a 0: ocupaban lugares que ahora son memorias reales.

### La saliencia puede seguir el uso en vez de la aparición

- `recall` reforzaba todo lo que devolvía, así que un recuerdo que aparece siempre y no sirve
  nunca ganaba importancia igual. Medido sobre 573 recuerdos devueltos en turnos reales de Claude
  Code, la mediana de solapamiento entre el recuerdo y la respuesta es **0,07**: casi nada de lo
  que se reforzaba se había usado.
- Herramienta MCP nueva `reinforce(memory_ids[], boost?)`: marca los recuerdos que una respuesta
  usó de verdad e informa cuántos ids no existían, así un cliente que inventa ids se nota.
- `MISMEM_REINFORCE_ON_RECALL=off` apaga el refuerzo por aparición. Por defecto sigue en `on`:
  apagarlo sin una fuente de refuerzo deja que el decaimiento mande.
- `mismem-used`: hook `Stop` de Claude Code que lee el transcript, mira el último turno y refuerza
  sólo los recuerdos cuyas palabras distintivas reaparecen en la respuesta. Habla con el servidor
  remoto por JSON-RPC (`MISMEM_HOOK_URL`) o con la base local. Tiene `--dry-run`, nunca escribe en
  stdout y nunca sale con error: un hook que rompe no vale un punto de saliencia.
- Umbrales calibrados contra esos 573 casos, no inventados: 0,2 de solapamiento y 3 palabras
  compartidas dejan pasar el 9 %, más o menos un recuerdo por llamada a `recall`.
- La tokenización de la búsqueda por palabras se movió a `terms.ts` y la comparte el hook: si las
  dos partieran el texto distinto, un recuerdo se encontraría con unas palabras y se daría por
  usado con otras.

### misMEM puede adelantar recuerdos antes de que el modelo los pida

- El modelo sólo recuerda lo que pide: si no llama a `recall`, no recuerda. `mismem-inject` es un
  hook `UserPromptSubmit` de Claude Code que busca con el prompt y devuelve unos pocos recuerdos
  por `additionalContext`.
- La búsqueda va con `reinforce: false` (campo nuevo en la entrada de `recall`): algo que el
  usuario no pidió no es uso y no puede subir la saliencia.
- Lo que inyecta queda acotado a propósito: sin episodios (son verbatim y `forget` los borra),
  3 recuerdos como mucho, 1.200 caracteres, nada que ya esté en el contexto, y nada de los ámbitos
  de `MISMEM_HOOK_EXCLUDE_SCOPES`. Un prompt sin dos palabras con sustancia ni gasta la llamada.
- **Lo inyectado viaja en cada prompt al proveedor del modelo.** `DEPLOY.md` explica cómo excluir
  los ámbitos personales y cómo revisar con `--dry-run`, que imprime ids y ámbitos pero no el texto.

### El bench dice dónde cayó el acierto, no sólo si cayó

- `mismem-bench` medía una sola cosa: si la memoria esperada estaba en el tope. Con eso, un cambio
  que mueve el acierto de la 5ª a la 1ª posición no se ve, y un cliente que muestra 3 recuerdos no
  encuentra lo que el recall@5 prometía.
- Ahora informa MRR, posición media del acierto, aciertos en la 1ª y entre las 3 primeras, y el
  reparto completo por posición.
- Del lado de la precisión: cuántos recuerdos devuelve por pregunta (el modelo los lee todos) y
  cuántos recuerdos trajeron las preguntas ajenas, no sólo cuántas trajeron algo.
- `noiseHits` cuenta los marcadores de ruido que llegaron a algún tope y tiene que ser 0. Es el
  guardia del filtro de `noise.ts`, y hay un test que falla si el filtro se cae.
- Medido sobre la copia de producción (80 preguntas, 2.527 memorias, EmbeddingGemma 2 local que
  reproduce los vectores guardados con coseno 0,9999):

  | variante | entre las 5 | en la 1ª | entre las 3 | MRR |
  |---|---|---|---|---|
  | `literal` | 78/80 (98 %) | 66 | 77 | 0,89 |
  | `literal_limpia` | 76/80 (95 %) | 66 | 76 | 0,88 |
  | `parafrasis` | 58/80 (73 %) | 41 | 52 | 0,59 |
  | `parafrasis_limpia` | 55/80 (69 %) | 36 | 49 | 0,54 |

  Ajenas 0/10 y 4,8 recuerdos devueltos de 5. Lo que el recall@5 no mostraba: con paráfrasis, un
  cliente que muestra 3 recuerdos encuentra 52 de 80 (65 %), no 73 %.

## 0.4.0 — 2026-10-12

### La búsqueda por palabras ya no tropieza con las palabras vacías

- FTS5 exige todas las palabras de la consulta, así que una pregunta entera ("¿qué decidimos sobre el
  deploy?") no encontraba nada por palabras: sólo las memorias, por significado. Ahora las palabras vacías
  (castellano e inglés) y las de una o dos letras no cuentan; los números cortos sí. Si la consulta es toda
  de palabras vacías, se busca tal cual vino.
- El modelo de embeddings sigue recibiendo la pregunta entera. Los clientes ya no necesitan limpiar la
  consulta antes de mandarla.
- Medido con `mismem-bench` (80 preguntas, 2.527 memorias): las memorias dan lo mismo que antes (70 % con
  otras palabras, 98 % con términos exactos, 0 de 10 ajenas). Lo que cambia es que rasgos y episodios, que
  sólo se buscan por palabras, ahora responden a una pregunta entera.

### Los ámbitos chicos ya no quedan pendientes para siempre

- Un ámbito con menos de `MISMEM_CONSOLIDATION_MIN_EPISODES` episodios se consolida igual cuando lleva
  `MISMEM_CONSOLIDATION_QUIET_DAYS` (14) sin episodios nuevos (`--quiet-days`). Antes una charla importada
  o un proyecto abandonado con uno o dos episodios no se consolidaba nunca y sólo se encontraba por palabras
  exactas. Con muchos ámbitos así, el tope de llamadas por corrida los reparte en varias noches.

### Un episodio que el LLM no logra procesar queda pendiente

- Si con un solo episodio la respuesta llega cortada o con JSON inválido, el episodio queda pendiente
  y la corrida sigue con el resto del ámbito. Antes, con JSON inválido se marcaba como ruido (y `forget`
  lo borraba a los 30 días) y con respuesta cortada el ámbito entero fallaba todas las noches contra el
  mismo episodio.
- El resumen de la corrida informa `episodes_skipped`.

### Documentación: una sola referencia de configuración

- `DEPLOY.md` tiene la única tabla completa de variables de entorno; el README, `engine/README.md`,
  la guía de consolidación y `.github/copilot-instructions.md` enlazan ahí en vez de repetir defaults.
- `DEPLOY.md` documenta lo que faltaba para un despliegue real: el servidor de embeddings, cuándo hay
  que reindexar, las tres tareas programadas (respaldo, consolidación, olvido) y qué texto sale a terceros.
- Corregido lo que ya no era cierto: la consolidación "vía OpenRouter", el TTL de los episodios (no
  existe: los borra `forget`), la firma de `forget`, el esquema y que la memoria "nunca sale de tu máquina"
  (con la consolidación activada, los episodios viajan al proveedor del LLM).

### Medir el recall sin tocarlo

- `mismem-bench --bank <banco.jsonl>` cuenta cuántas veces la memoria esperada sale entre las devueltas,
  por variante de pregunta y por grupo, y cuántas preguntas ajenas traen algo. Usa el mismo recall y el
  mismo servidor de embeddings que producción y no refuerza. El banco es privado y no va al repo.

### Bordes de configuración

- `MISMEM_EMBEDDING_MIN_SCORE=0` se respeta (traer todo); antes volvía a 0,5 sin avisar.
- Con `MISMEM_EMBEDDING_PROVIDER=openai` y sin `MISMEM_EMBEDDING_URL`, el default es
  `http://127.0.0.1:8080` (llama-server). Antes heredaba la URL de Ollama y la búsqueda por
  significado quedaba apagada en silencio.
- `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` más chico que la marca de recorte ya no produce
  episodios más largos que el tope.
- La ayuda de `mismem-embed` lista `MAX_CHARS` y `TIMEOUT_MS`, y aclara cuándo hace falta `--force`.

### La consolidación ya no descarta contenido válido como ruido

- Un resumen de más de 500 caracteres ya no invalida la memoria: el `gist` se recorta y el texto completo
  pasa a `details`. Antes la memoria se descartaba en silencio y, si era la única de la tanda, todos sus
  episodios quedaban marcados como "sin señal" y se borraban con el siguiente `forget`.
- Si el LLM devuelve alguna memoria mal formada, o un JSON sin la lista de memorias, la respuesta entera
  cuenta como inválida: la tanda se parte y se reintenta, igual que con un JSON roto.
- El error de un JSON roto ya no incluye el texto de la respuesta (terminaba en el log del cron).

### Un JSON roto de un solo episodio ya no traba el ámbito

- Si el LLM devuelve JSON inválido con un único episodio, ese episodio queda como ruido
  y la corrida sigue con el resto. Antes el ámbito entero fallaba y la próxima noche
  chocaba contra el mismo episodio.
- Si ese episodio venenoso sale, la tanda siguiente vuelve a llenarse. En
  `engram-compat` el tope se quedaba en 1 y procesaba de a uno. Si la respuesta
  se corta, el tope chico se mantiene (el modelo no entra más).

### Vectores y consolidación más robustos

- Una tanda de vectores que falla ya no deja sin vector a todas las siguientes; recién dos fallas seguidas
  cortan (el servidor está caído). En la primera corrida grande, 660 de 756 memorias nuevas quedaron sin
  vector por una sola tanda lenta.
- Al modelo de embeddings le llegan como mucho 4000 caracteres por memoria (`MISMEM_EMBEDDING_MAX_CHARS`):
  el resumen va adelante y no se pierde, y en CPU ARM rinde mucho más.
- La consolidación rellena vectores de a 8.
- Un JSON mal armado del LLM parte la tanda y reintenta, como una respuesta cortada.

### Embeddings desde cualquier servidor compatible con OpenAI

- `MISMEM_EMBEDDING_PROVIDER=openai` + `MISMEM_EMBEDDING_URL` piden `/v1/embeddings` (p. ej. llama-server);
  Ollama sigue siendo el default y no cambia.
- Prefijos distintos para consulta y documento (`MISMEM_EMBEDDING_QUERY_PREFIX` / `_DOC_PREFIX`).
- Corte de parecido configurable (`MISMEM_EMBEDDING_MIN_SCORE`, default 0,5).
- Medido sobre una copia real (1.353 memorias, 80 preguntas con otras palabras): con EmbeddingGemma 2,
  sus prefijos y corte 0,68, el recuerdo correcto sale entre los 5 primeros en 73 de 80 y ninguna de
  10 preguntas ajenas trae recuerdos (con nomic y 0,5 traían las 10).

### La consolidación vuelve a andar y tiene el costo acotado

- `DEEPSEEK_API_KEY` consolida con DeepSeek directo; OpenRouter queda como alternativa.
- Cada llamada pide como mucho 8192 tokens de respuesta, el máximo de `deepseek-chat`. Antes no había
  tope, OpenRouter reservaba unos 100.000 por llamada y respondía HTTP 402 por saldo.
- Si una respuesta igual llega cortada (`finish_reason: length`), la tanda se parte a la mitad y se
  reintenta; el ámbito sigue con ese tamaño. Antes se perdía la tanda entera con "JSON inválido".
- Un ámbito se consolida en tandas que entran en un presupuesto de caracteres; un episodio enorme viaja
  recortado (principio y final). Antes las tandas grandes pasaban el contexto del modelo (163.840
  tokens) y volvían con HTTP 400.
- Un ámbito se vacía en la misma corrida, hasta un tope de 60 llamadas por noche.
- Un 401/402/403 corta la corrida en el primer error en vez de repetirse por cada ámbito.
- Los episodios que el LLM leyó y no citó en ninguna memoria quedan como ruido (`[noise] N episodios sin
  citar`, saliencia 0,05) y no se vuelven a mandar ni a pagar. Si la tanda no dio ninguna memoria válida,
  quedan pendientes como antes.

### La relevancia manda sobre la saliencia

- La saliencia sólo desempata entre recuerdos casi igual de relevantes
  (`SALIENCE_RRF_WEIGHT` 0.02 → 0.0002). Antes un recuerdo muy usado tapaba al
  correcto: sobre una copia real (1.353 memorias, 80 preguntas con otras
  palabras), el correcto entraba entre los 5 primeros 4 veces; ahora 18, y 73
  con un modelo de embeddings multilingüe.
- La búsqueda por palabras ordena por coincidencia (bm25) y después por
  saliencia; la semántica desempata por saliencia a igual parecido.

## 0.3.0 — 2026-07-28

### Decay y olvido coherentes

- Decay exponencial de `salience` con checkpoint idempotente y vida media
  configurable (90 días por defecto).
- El refuerzo Hebbiano aplica primero el decay pendiente y actualiza el
  checkpoint de la memory.
- `forget --dry-run` calcula elegibilidad sin escribir; las memories tienen
  período de gracia y al purgarlas elimina sus episodes consolidados para que
  no reaparezcan.
- Migración automática y aditiva para DBs existentes.

### Recall híbrido consistente

- FTS5 y semántica se ejecutan sobre candidatos independientes de `limit`.
- Fusión RRF con salience, conservando prioridad traits > memories > episodes.
- MCP `recall`, `mem_search`, Engram directo y viewer comparten el mismo núcleo.
- El viewer no aplica refuerzo y vuelve a ser realmente read-only.
- Descripciones MCP actualizadas; `mem_context` permanece como contexto reciente.

### Índice semántico seguro

- No se mezclan modelos ni dimensionalidades incompatibles.
- Cambiar de modelo reindexa automáticamente sin borrar el vector anterior si
  Ollama falla.
- `mismem-embed --status` diagnostica el índice y `--force` permite reconstruirlo.
- Actualizar una memory invalida su embedding para el siguiente backfill.

### Documentación y calidad

- Explicación concisa de episodes, memories y traits.
- 80+ tests incluyendo decay, migraciones, consistencia entre superficies,
  propiedad de prefijo y cambio de modelo.
- `better-sqlite3` 12.11.1 para instalaciones precompiladas compatibles con
  Node 24, verificadas en CI junto con Node 22.

## 0.2.0 — 2026-07-24

Los dos "bordes conocidos" de la 0.1.0, liquidados:

### Dedup en captura e ingesta
- `capture` calcula `content_hash` (sha256) y re-capturar el mismo `(scope, body)`
  devuelve el id original en vez de duplicar. Re-ingestar un export completo
  ahora es idempotente.
- Migración automática y aditiva al abrir la DB: backfill de hashes para filas
  existentes (chunked, seguro para DBs grandes en producción).
- `mismem-ingest walk` reporta `chunksDeduped`.

### Búsqueda semántica opcional (recall híbrido)
- `recall` / `mem_search` ahora combinan FTS5 (léxico) con coseno sobre
  embeddings (semántico): "problemas de plata" encuentra "deudas".
- Embeddings vía **Ollama local** (`nomic-embed-text` default). Sin Ollama,
  degradación silenciosa a FTS5 puro — cero configuración obligatoria.
- Sin extensiones nativas: vectores como BLOB en la misma SQLite, coseno
  brute-force en JS (para memoria personal de miles de filas, <50ms).
- Nueva CLI `mismem-embed` para backfill idempotente; la consolidación
  nocturna embebe automáticamente las memorias nuevas.
- Hits semánticos marcados con `via: "semantic"` y con refuerzo Hebbiano.
- Env: `MISMEM_EMBEDDINGS=off`, `MISMEM_OLLAMA_URL`, `MISMEM_EMBEDDING_MODEL`.

## 0.1.0 — 2026-07-24

Primera versión pública. Historia condensada del desarrollo (abril–julio 2026):

### Núcleo (abril 2026)
- Engine MCP stdio con schema de 3 capas (`episodes` → `memories` → `traits`),
  las 5 invocaciones (`capture`, `recall`, `consolidate`, `crystallize`, `forget`),
  FTS5 + refuerzo Hebbiano en recall, scopes jerárquicos y suite de tests (Vitest).
- Servidor **Streamable HTTP** stateless (server+transport por request) con capa
  **engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …)
  para clientes que hablan el protocolo Engram.
- Dockerfile multi-arch (`mismem-brain`, Alpine) + guía de deploy con Traefik
  (TLS, BasicAuth, healthcheck) y estrategia de backup diario
  (`VACUUM INTO` + scp, retención 14 días).
- Viewer read-only en `/viewer` + `/api/{stats,recent,search}`.
- Fix de robustez: orden estable en `mem_context`, escape seguro de queries FTS5.

### Consolidación LLM (abril 2026)
- Destilación nocturna episodes → memories vía OpenRouter (DeepSeek V3 default):
  idempotente, anti-alucinación (filtra evidencia fuera del batch), memoria stub
  con salience baja cuando no hay señal, tolerante a salidas no conformes del LLM.
- **Pre-filtro Pareto**: clasificador que descarta ruido antes de gastar tokens.
- CLIs: `mismem-ingest` (exports ChatGPT / transcripts VS Code),
  `mismem-consolidate`, `mismem-forget`, `mismem-migrate-engram`, `mismem-stats`.

### Preparación pública (julio 2026)
- Line endings normalizados (`.gitattributes`), docs genéricos sin referencias a
  infraestructura personal, README con arquitectura y quickstart, historial fresco.
