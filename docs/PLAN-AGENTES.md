# Plan: graph-indexer como capa de lectura y búsqueda de código para agentes

Fecha: 2026-09-23 · Plan activo. [PLAN-SOTA.md](PLAN-SOTA.md) queda como historia de cómo se llegó a la versión 3.0.

**Estado tras la ronda 4** (F4, 122 ejecuciones, todas resueltas): de los tres criterios del §3 se cumplen dos. En preguntas y refactorizaciones (B1 + B2), graph-indexer instalado cuesta **0,48** de grep, con 0,42 del tiempo y 0,59 de los turnos; en preguntas el modelo razona la mitad (12k tokens de salida frente a 30k). En arreglos sencillos (B4) no encarece: 0,85 de coste y 0,86 de tiempo. En issues reales (B3) no se cumple: **0,85** de coste frente al objetivo de 0,70, y las reglas de búsqueda solas dan lo mismo (0,86). Lo que queda para B3 está en F5.

## 1. Qué hay hoy y qué resuelve

graph-indexer 3.0 es un índice local del repositorio:
- tree-sitter en WASM y SQLite, 16 lenguajes, sin compilar ni instalar dependencias nativas;
- referencias resueltas por ámbito, imports y tipo del receptor, con grafo de llamadas;
- impacto de un cambio, comprobación de ediciones sin compilar, selección de tests y búsqueda híbrida.

Se sirve de tres formas, que dan las mismas respuestas:
- 8 herramientas MCP (unos 2.500 tokens);
- una CLI;
- tres hooks de Claude Code: comprobación tras editar, qué definición es cada coincidencia tras un grep y una línea de estado al empezar.

`init` lo conecta a Claude Code, Cursor, VS Code, Gemini CLI y Codex.

**Lo que resuelve, medido** en tres rondas y 237 ejecuciones de agente ([AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md)), con el coste corregido del §2:
- **Preguntas estructurales**: usos de un método con homónimos, llamadores a dos niveles, implementaciones de una interfaz. Mismo resultado con **0,67** del coste y **−24 %** de turnos.
- **Refactorizaciones multi-sitio**: **0,81** del coste y **−16 %** de turnos, sin perder tareas.
- **Precisión de las referencias** frente al compilador de TypeScript: 0,996, con cobertura 0,961.

**Lo que no resuelve:**
- Arreglar issues reales cuesta lo mismo con o sin graph-indexer: **0,95**, y los mismos 47 turnos.
- El agente sigue leyendo y buscando como siempre. graph-indexer es una herramienta más que consulta en momentos concretos: con grep disponible, menos de 2 llamadas por issue.

La idea de partida era cambiar la forma en que los agentes leen y buscan código. Eso todavía no ocurre.

## 2. Diagnóstico: en qué gastan los agentes

### 2.1 Corrección de la métrica

Las transcripciones guardan los tokens de salida de cada mensaje tal como estaban al empezar la respuesta. El razonamiento interno del modelo (thinking) no aparecía: turnos que añaden 8.600 tokens al contexto figuraban con 5 tokens de salida.

La salida real se reconstruye así: crecimiento del contexto entre un turno y el siguiente, menos lo que devolvieron las herramientas. Los caracteres por token se calibran en 301 turnos sin razonamiento y salen 2,63. Con esta corrección, el coste real es 1,3–1,5 veces el registrado.

Las proporciones entre brazos cambian poco:
- preguntas: 0,67 con la corrección, frente a 0,71;
- refactorizaciones: 0,81 en ambos casos;
- issues: 0,95 frente a 0,97.

### 2.2 Anatomía del coste (brazo `grep`, sin graph-indexer)

Coste en tokens equivalentes de entrada: entrada ×1, escritura de caché ×1,25, lectura de caché ×0,1, salida ×5. Cada parte incluye su escritura y sus relecturas en los turnos posteriores.

| | B1 preguntas | B2 refactorizaciones | B3 issues reales |
|---|---|---|---|
| turnos | 20,6 | 28,9 | 46,9 |
| tokens de salida (razonamiento, texto, llamadas) | 25k | 20k | 55k |
| coste real por tarea | 319k | 351k | 951k |
| prefijo fijo (~42k tokens releídos en cada turno) | 31 % | 38 % | 22 % |
| generar la salida del modelo | 39 % | 29 % | 29 % |
| releer esa salida en los turnos siguientes | 18 % | 16 % | 28 % |
| lo que devuelven las herramientas (lecturas, grep, tests…) | 11 % | 15 % | 21 % |
| tiempo total / parte del modelo | 3,2 min / 83 % | 2,6 min / 58 % | 9,1 min / 59 % (tests 21 %) |

### 2.3 Hallazgos

1. **Se paga por turno.** El prefijo y el razonamiento del modelo son el 79–89 % del coste:
   - el prefijo se relee entero en cada turno;
   - el razonamiento se genera a precio de salida y se relee en cada turno posterior.

   Lo que devuelven las herramientas es el 11–21 %. Un turno evitado en un issue ahorra en torno a 15k tokens equivalentes; acortar una salida en 1k tokens ahorra unos 3,5k.
2. **Explorar es perseguir nombres de uno en uno.** En los issues el agente llega al fichero relevante hacia el turno 4, pero no edita hasta el 15–19.
   - Antes de editar hace 21 llamadas; 17,7 de ellas son búsquedas y lecturas encadenadas.
   - El **71 %** de sus búsquedas busca un nombre que acababa de ver en código leído.
   - Es "ir a la definición" hecho con grep: un salto por turno y con errores de ruta. Por ejemplo, `grep "class Interval" sqlglot/expressions.py`, en un fichero que no existe, seguido de `find`, `ls` y otro `grep`.
   - En esta fase ocurre el 55–60 % del razonamiento.
3. **El contexto está lleno de código que no se cambia.** Solo el **14 %** de las líneas de código leídas (mediana 10 %) cae en las funciones que el parche modifica; con graph-indexer, 21 %.

   No todo lo demás es inútil: entender alrededor forma parte del trabajo. Pero el agente lee ficheros para encontrar lo que el índice ya sabe.
4. **Encoger las salidas no basta.** Plegar las lecturas completas de ficheros grandes ahorraría un ~3 % en issues, porque el volumen leído es pequeño frente al razonamiento.
5. **graph-indexer hoy contesta una pregunta por llamada, como grep.**
   - Con grep disponible, en issues se usa poco: 0,6 `symbol` y 1,0 `grep` por ejecución.
   - Sin grep, el agente hace las mismas 23 llamadas con otra herramienta.
   - Cada llamada por CLI tarda de media unos 2 s, sobre todo en arrancar el proceso y comprobar el índice.

6. **La evidencia externa dice lo mismo** ([notas](research/notes/output_rewriting_and_read_hooks.md)).
   - Comprimir las salidas de las herramientas (el enfoque de RTK) no bajó el coste en ningún estudio independiente:
     - JetBrains: +7,6 %;
     - Quesma: +1 % y +17 %;
     - PointFive: −2,9 %, no significativo, en 2.908 ejecuciones;
     - en ese estudio, la lectura de caché era el 87 % del coste.
   - Sustituir una lectura por un esqueleto de firmas perdió el 65 % de las líneas que el agente usaba después.
   - Lo que sí ahorró fue cambiar cómo busca el agente:
     - un bloque de 745 tokens inyectado al empezar ("reconocimiento en una pasada", "leer 50 líneas, no el fichero") bajó el coste un 17,9 % y los turnos un 20 %, con la misma calidad; como skill que el agente tenía que descubrir no ahorró nada;
     - herramientas de grafo que solo intervienen cuando el agente está rastreando costaron 0,88 veces lo de grep; interviniendo en cada búsqueda, 1,44–1,72 veces.

**Conclusión.** Para bajar mucho tokens y tiempo hay que quitar turnos y razonamiento, no solo bytes. Eso exige dos cosas:
- responder de una vez lo que el agente va a preguntar a continuación: dónde está definido cada nombre del código que lee, quién lo usa y qué tests lo cubren;
- hacerlo en los pasos que el agente ya da (leer, buscar, editar, probar), como camino por defecto y no como una herramienta opcional que tiene que acordarse de usar.

## 3. Objetivo y criterios de aceptación

Mismo agente y mismo modelo, con graph-indexer instalado frente a sin instalar. Se mide en tareas reservadas, que no se usan para diseñar: 2 ejecuciones por tarea y brazo, estadística pareada por tarea e IC del 95 %.

| Tipo de tarea | Coste real | Tiempo | Turnos | Calidad |
|---|---|---|---|---|
| Issues reales (B3) | −30 % | −25 % | −30 % | resolución no inferior (margen −5 puntos); precisión de contexto ×1,5 |
| Preguntas y refactorizaciones (B1, B2) | −40 % | −35 % | −35 % | F1 y compilación no inferiores |
| Tareas sencillas (B4) | como mucho +5 % | como mucho +5 % | — | no inferior |

Una puerta se cumple cuando la estimación puntual alcanza el objetivo y el IC queda por debajo de 1. El objetivo de este plan se da por cumplido cuando se cumplen las tres filas.

Métricas nuevas en el informe:
- coste real (salida reconstruida) y tokens de salida;
- tiempo del modelo y de las herramientas;
- turnos hasta la primera edición;
- precisión de contexto: parte de las líneas leídas que caen en las funciones cambiadas;
- búsquedas que persiguen un nombre ya visto.

## 4. Principios de diseño

1. **La unidad es el símbolo y sus relaciones**, no el fichero ni la línea. Los humanos navegan con un IDE (ir a la definición, ver usos, esquema); los agentes lo hacen a golpe de grep y lectura de ficheros. graph-indexer les da la navegación del IDE ya resuelta y en texto.
2. **Cada respuesta cierra la pregunta siguiente**, dentro de un presupuesto de tokens. Incluye:
   - el código pedido;
   - dónde está definido cada nombre que usa;
   - quién lo usa;
   - qué tests lo cubren.
3. **Varias cosas por llamada.** Leer tres símbolos es una llamada, no tres turnos.
4. **Dentro del flujo del agente.** Se engancha a lo que ya hace:
   - al leer código, añade la tarjeta de definiciones;
   - al buscar, dice a qué definición apunta cada coincidencia y dónde está lo que no encontró;
   - al editar, comprueba lo roto.

   Donde hay hooks, sin turnos extra; donde no, por MCP y CLI con unas pocas líneas de instrucciones.
5. **Rápido.** Menos de 100 ms por respuesta con un proceso residente, para que los hooks no añadan tiempo.
6. **Exacto y honesto**, como en la 3.0: sin ceros falsos, truncado explícito, confianza declarada y silencio cuando no hay nada útil que decir.
7. **Añadir, no sustituir.**
   - No se comprimen ni se pliegan las lecturas que el agente pidió: los números de línea tienen que seguir sirviendo para editar.
   - El esquema de un fichero es un mapa antes de leer, no un sustituto de la lectura.
   - Los hooks solo intervienen cuando el agente está rastreando o una búsqueda falló, nunca en cada llamada.
8. **Medir de extremo a extremo** con la métrica corregida antes de declarar una mejora.

## 5. Arquitectura objetivo

### 5.1 Vistas (el motor)

| Vista | Qué devuelve | Estado |
|---|---|---|
| `read <objetivo>…` | ver detalle debajo | nueva |
| `symbol A B C` | varias definiciones con su código y la misma tarjeta | existe; añadir la tarjeta |
| `grep <patrón>` | ver detalle debajo | existe; añadir el rescate |
| `context "<tarea>"` | candidatos para empezar (símbolos con ubicación y firma) a partir de identificadores, cadenas y errores del enunciado, más los tests relacionados | nueva; solo se expone si su precisión en B3 lo justifica |
| `refs`, `impact`, `check`, `callgraph`, `outline`, `files` | como en la 3.0 | existen |

`read <objetivo>…` acepta un fichero, un rango (`fichero:120-180`) o un símbolo (`Clase.método`), y varios a la vez. Devuelve:
- el código con números de línea exactos, listo para editar;
- la **tarjeta de definiciones**: por cada nombre que usa el fragmento y está definido fuera de él, una línea `nombre → ruta:línea firma · primera línea de la doc`, ordenada por relevancia y con presupuesto;
- los llamadores resumidos y los tests que lo cubren;
- para un fichero grande sin rango, su esquema plegado, con la instrucción exacta para desplegar cada parte.

`grep <patrón>` devuelve la salida de grep con la definición a la que apunta cada coincidencia. Además, cuando lo buscado es una definición que no está donde se buscó (o no hay coincidencias), dice dónde está.

### 5.2 Canales

- **MCP**, para todos los agentes: herramientas e instrucciones del servidor de 2 KB como máximo.
- **CLI**, para cualquier agente con shell: las mismas respuestas.
- **Hooks**, que aumentan lo que el agente ya hace sin turnos extra:
  - tras leer código, la tarjeta de definiciones del rango leído;
  - tras buscar, la definición de lo buscado y el rescate de búsquedas fallidas;
  - tras editar, `check`;
  - al empezar, una línea de estado.
- **Instrucciones de búsqueda** (`AGENTS.md`, `CLAUDE.md`, reglas, y el hook de inicio donde exista): explorar en una pasada, leer por trozos, seguir los nombres por la tarjeta, usos exactos con `find_references`, comprobar una vez. Unas 8 líneas redactadas como hechos, inyectadas al empezar; una skill que el agente tiene que descubrir no sirve para esto.
- **Hooks con detector de rastreo**: la tarjeta tras leer solo cuando el agente encadena búsquedas y lecturas sin editar; el rescate tras una búsqueda de una definición que falló, siempre.

### 5.3 Proceso residente

El servidor MCP escucha también en un socket local del repositorio (`src/cli/resident.mjs`); sin servidor, los hooks arrancan `graph-indexer daemon`, que hace lo mismo y se cierra tras 30 minutos sin peticiones. La CLI y los hooks lo usan si está vivo; si no, abren el índice ellos mismos, como antes. El socket está en `.graph-indexer/` con permisos 0600 (o en un directorio 0700 del usuario si la ruta es demasiado larga) y solo acepta peticiones de la misma versión, salvo el cliente del plugin, que no tiene lógica propia.

## 6. Integración por agente

Lo que cada agente permite en septiembre de 2026 decide cuánto se puede hacer de forma transparente. Fuentes en [research/research_notes/…/integracion_en_agentes.md](research/research_notes/Impacto%20real%20de%20indexación%20en%20agentes/integracion_en_agentes.md) y [research/notes/output_rewriting_and_read_hooks.md](research/notes/output_rewriting_and_read_hooks.md).

| Agente | MCP | Instrucciones | Hooks útiles |
|---|---|---|---|
| Claude Code | sí; herramientas diferidas, instrucciones visibles | `CLAUDE.md` | PreToolUse (`updatedInput`, `additionalContext`), PostToolUse (`additionalContext`; `updatedToolOutput` con el formato exacto de cada herramienta, que hay que comprobar en la versión instalada); también dentro de subagentes |
| Codex CLI | sí; diferidas, búsqueda BM25 | `AGENTS.md` | contrato de Claude: PreToolUse (`updatedInput` solo con `allow`, `additionalContext`), PostToolUse (`additionalContext`); todo pasa por la shell |
| VS Code / Copilot (IDE y CLI) | sí (máximo 128 herramientas) | `AGENTS.md`, `.github/…` | PreToolUse y PostToolUse con `additionalContext`; Copilot CLI también reescribe resultados y ejecuta los hooks de `.claude/settings.json` |
| Cursor | sí | reglas, `AGENTS.md` | `preToolUse` (reescribe comandos); el contexto tras una herramienta no llega al modelo desde marzo de 2026; ejecuta hooks de Claude importados |
| Devin Desktop (antes Windsurf, Cascade retirado el 2026-09-08) | sí | `AGENTS.md` | hooks con el contrato de Claude; carga los de `.claude` por defecto |
| Kilo Code (reconstruido sobre OpenCode) y OpenCode | sí | `AGENTS.md` | plugins `tool.execute.before/after`: reescriben entradas y salidas |
| Gemini CLI | sí; instrucciones en el system prompt | `GEMINI.md`, `AGENTS.md` | BeforeTool / AfterTool (`additionalContext`, `tailToolCallRequest`) |
| Antigravity CLI (sucesor para usuarios de Gemini) | sí, pero descarta herramientas cuyo esquema usa `const` o `additionalProperties` | `AGENTS.md` | por verificar |
| Junie | sí | `AGENTS.md` | solo en su CLI (acceso anticipado, sin PostToolUse); en el IDE, ninguno |
| Zed, Cline (extensión) | sí | `AGENTS.md` o reglas | sin hooks útiles: MCP e instrucciones |

Un mismo ejecutable de hook tiene que detectar qué agente lo llama: Copilot CLI, Cursor y Devin ejecutan también los hooks escritos para Claude Code.

## 7. Benchmarks

- **Métrica corregida** en [`bench/agentic/transcript.mjs`](../bench/agentic/transcript.mjs): salida reconstruida del crecimiento del contexto. El informe da coste real, salida, tiempo repartido, turnos hasta la primera edición y precisión de contexto.
- **Tareas reservadas nuevas.**
  - B3: commits posteriores al 22-09-2026 de sqlglot y networkx, y, si es posible, un tercer repositorio Python sin dependencias.
  - B1 y B2: nuevas, sin repetir métodos.
  - B4: tareas sencillas, el subconjunto de B3 de un solo fichero.
- **Brazos:**
  - `grep`: herramientas nativas;
  - `reglas`: nativas más solo las instrucciones de búsqueda, sin graph-indexer. Es el control que separa el efecto de las instrucciones del de las herramientas;
  - `grep+gi4`: nativas más graph-indexer con la tarjeta nueva (`read`, lotes, tarjeta de definiciones); el agente decide cuándo usarlo, como con MCP sin hooks;
  - `gi4-hooks`: emulación de los hooks. El agente lee y busca con `gi read` y `gi grep`, que devuelven la misma salida que las herramientas nativas más lo que añadirían los hooks. Edita con las herramientas nativas.
- **Hooks reales.** Los brazos `mcp` (servidor MCP y el bloque de `init`) y `mcp+hooks` (además, los hooks) se ejecutan con [`run-headless.mjs`](../bench/agentic/run-headless.mjs), que lanza `claude -p` con `--mcp-config` y `--settings` y deja las transcripciones listas para corregir. Necesita un `claude` autenticado en la máquina que lo ejecuta; esta sesión no lo tiene, así que es el paso de validación en local (o con permiso para registrar hooks aquí). Falta la variante para `codex exec`.

## 8. Fases y puertas

| Fase | Contenido | Puerta |
|---|---|---|
| F0 ✅ | Diagnóstico (§2) y métrica corregida | — |
| F1 ✅ | `read_code` con tarjeta de definiciones, lotes y esquema para ficheros largos; rescate de definiciones en `search_text`; `symbol` con tarjeta; instrucciones de búsqueda; resolución de nombres a través de paquetes que reexportan en Python | en las trayectorias B3, la tarjeta habría respondido ≥ 60 % de las búsquedas que persiguen un nombre ya visto; tarjeta media ≤ 400 tokens. Resultado: **48 %** con ubicación y 11 % solo nombrados; 339 tokens de media. De las búsquedas de una definición que fallaron, el rescate sitúa 16 de 27. Lo que falta viene del enunciado, de salidas de Python, de tablas de registro y de métodos llamados por convención de nombre |
| F2 ✅ | Hecho: hooks de lectura, búsqueda y edición con detector de rastreo, rescate de definiciones, reglas al arrancar un subagente y salida según el agente; proceso residente (el servidor MCP, o `graph-indexer daemon`, que arrancan los hooks y se cierra tras 30 min sin peticiones) que responde a hooks y CLI por un socket local; el hook del plugin de Claude Code es un cliente mínimo de ese socket, sin `npx`; `init` para OpenCode y Kilo Code (`opencode.json` o el `kilo.json` existente), Junie (`.junie/mcp/mcp.json`), Zed (`context_servers`) y Devin (instrucciones y los hooks de `.claude/`, que carga por defecto); plugin de OpenCode y Kilo Code (`tool.execute.after`) que añade a la salida de lecturas, búsquedas y ediciones lo mismo que los hooks, contestado por el proceso residente | p95 del hook < 150 ms con el proceso residente; silencio cuando no aporta. Resultado en nestjs (1.641 ficheros): un hook pasa de 280–570 ms a 70–120 ms (lectura con tarjeta, rescate, `check` tras editar, inicio de sesión), y una consulta de la CLI de ~370 ms a 110–210 ms, con la misma salida |
| F3 | `context` evaluado sin agente sobre B3 | Acc@5 de función ≥ 0,6 antes de exponerlo. Resultado: la búsqueda sobre el título y los identificadores del enunciado sitúa una función del arreglo entre las 5 primeras en el 50 % de 24 tareas; un resumen anclado en lo que el enunciado nombra (definiciones de sus identificadores, ficheros cuyo nombre aparece, búsqueda dentro de ellos) baja al 29 % en 35, porque las funciones de entrada de la reproducción (`transpile`, `parse_one`, `Graph`) desplazan a las que cambian. No se expone; se entregaría sin turnos con un hook `UserPromptSubmit`, así que vuelve a medirse si la localización mejora |
| F4 ✅ | Ronda 4 sobre tareas reservadas: 19 tareas nuevas (7 B1, 1 B2, 11 B3), brazos `grep`, `grep+rules` (solo las reglas, sin graph-indexer), `grep+gi4` (lecturas y búsquedas a través de graph-indexer, con tarjeta), `grep+gi5` (definiciones leídas por nombre, tarjeta compacta) y `grep+gi6` (las reglas del control para leer y buscar; graph-indexer para usos, llamadores, impacto, `check` y definiciones que una búsqueda no encontró); 122 ejecuciones, todas resueltas | criterios del §3. Resultado con `grep+gi6` frente a `grep`: **B1 + B2 cumplida** (coste 0,48, tiempo 0,42, turnos 0,59; B1 sola 0,44, con la mitad de razonamiento: 12k tokens de salida frente a 30k; B2 tiene una sola tarea, 0,77) y **B4 cumplida** (0,85 de coste y 0,86 de tiempo en los arreglos de un fichero). **B3 no cumplida**: 0,85 de coste (IC 0,76–0,96), 0,90 de tiempo, 0,79 de turnos y precisión de contexto ×1,06; las reglas solas dan 0,86. Leer por nombre a través de graph-indexer (`gi5`) triplica la precisión de contexto (42 % de las líneas leídas en las funciones que cambian, frente a 13–16 %) y hace un tercio de consultas antes de editar, al mismo coste; la tarjeta completa de `gi4` encarece los arreglos sencillos (1,12). Decisión: `init`, las reglas de sesión y las instrucciones del servidor siguen `gi6`; `check` e `impact` nombran las subclases que heredan un método cambiado y sus tests (lo que los agentes buscaban a mano tras editar). Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#fourth-round-19-tasks-122-runs) |
| F6 ✅ | Compilador de indirección (`src/query/facts.mjs`): desvirtualización con la MRO (C3), tablas de registro con `**Base.TABLE`, despacho por nombres construidos (`getattr`, `dir(cls)` + `endswith`) y decoradores, entregados tras las lecturas (`read_code`, `get_symbol`, hook) | O2 precisión ≥ 0,98 contra el programa en ejecución y A1 razonamiento previo a editar ≤ 0,80 de `grep`. Resultado: **O2 cumplida** (sqlglot: sobrescrituras 1,000, herencia 1,000 —0,59 antes de la MRO—, claves de tabla 0,995; networkx 0,983 y 1,000). **A1 no cumplida**: con control concurrente, `grep+gi7` da 0,87 de razonamiento previo, 0,95 de coste (IC 0,82–1,10) y precisión de contexto ×1,6 en las 11 tareas B3. El modelo había cambiado desde la ronda 4 (`grep` solo pasa de 751k a 337k), así que toda comparación necesita control concurrente. Con el modelo actual el prefijo fijo es el 38–39 % del coste: la siguiente palanca son menos turnos y un prefijo menor. Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#resolved-indirection-development-rc8-11-tasks-22-runs) |
| F7 ✅ | Modelo pequeño (`rc8small`): el producto de `rc8` sin cambios con un modelo a la mitad de precio por token, en las 7 preguntas y los 11 issues de la ronda 4 y 7 refactors, con control concurrente y, en los issues, el brazo de solo reglas | ¿Se mantienen las ganancias estructurales con un modelo actual, y deja graph-indexer que un modelo barato haga lo que hace el habitual? Resultado: **preguntas** a 0,26 del coste de `grep` (IC 0,18–0,50) y 0,32 del tiempo, 7/7 exactas frente a 5/7 sin graph-indexer: una décima parte de lo que gastaba el modelo habitual con `grep`, con sus mismas respuestas. **Refactors** a 0,69 (0,56–0,87), 7/7 en ambos brazos. **Issues** a 1,05 (0,82–1,46), y 1,19 con las reglas solas; 11/11, 10/11 y 10/11 (tras nueve tareas la estimación era 0,84: con una ejecución por tarea, la varianza manda). **Decisión:** se cierra la línea de abaratar issues desde la lectura (definiciones, lectura por nombre, hechos resueltos y modelo pequeño no bajan su coste, que es el razonamiento del modelo y el prefijo que relee). El valor medido de graph-indexer son las respuestas estructurales exactas, y un modelo pequeño lo aprovecha más que uno grande. Siguiente paso: un ayudante estructural sobre un modelo pequeño al que el modelo principal delegue llamadores, implementaciones e impacto, medido con más preguntas que las siete de ahora. Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#a-smaller-model-rc8small-25-tasks-61-runs) |
| F8 ✅ | Ayudante estructural (`rc9`): `init` instala para Claude Code `.claude/agents/code-structure.md`, un subagente de solo lectura sobre un modelo pequeño que responde llamadas, llamadores, subclases e impacto con el índice y devuelve solo la lista. Medido con 24 preguntas nuevas (12 de llamadas, 7 de llamadores a dos niveles, 5 de subclases, respuestas del compilador) planteadas como las delega un agente principal, a tres subagentes con el modelo pequeño: uno general con `grep`, el Explore de Claude Code y el ayudante | ¿Resuelve el ayudante las preguntas estructurales con la misma exactitud y menos coste que el agente con sus herramientas? Resultado: **20/24 exactas en los tres**; el ayudante a **0,24** del coste del general (IC 0,18–0,33) y **0,28** del tiempo, Explore a 0,76. Los tres devuelven unos 170 tokens; buscarlo en su propio contexto añade unos 23k. Los fallos son preguntas de llamadores a dos niveles; dos de los del ayudante venían del índice (un método `initialize` tomado por constructor en todos los lenguajes, un valor sacado de `new Map<K, V>()` sin tipo) y otro de omitir la recursión: corregidos después (el índice solo pasa de 20 a 22 respuestas exactas de 24; frente al compilador, cobertura 0,960 → 0,961 y conjuntos exactos 0,902 → 0,905). **Decisión:** el ayudante queda en `init` y en el plugin. Después se cerraron los dos huecos que quedaban (el `this` de una clase anónima, que el índice ligaba a la clase que la contiene, y los valores de una clase que extiende `Map`): el índice solo responde exactas las 24; conjuntos exactos 0,907. Falta medir el reparto dentro de una sesión (si el modelo principal delega en el momento justo y cuánto ahorra un contexto limpio en una tarea larga): la ronda está preparada con sesiones reales de Claude Code (`session-round.mjs`, brazos `cc`, `cc+gi`, `cc+gi+helper`, 12 preguntas nuevas y 8 refactorizaciones) y solo necesita un `claude` autenticado. Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#delegated-questions-rc9-24-new-questions-72-runs) |
| F9 ✅ | Sesiones reales de Claude Code (`rt1`): 12 preguntas nuevas y 8 refactorizaciones, cada una en una sesión `claude -p` con el modelo habitual, sin graph-indexer (`cc`), con él como lo instala `init --no-helper` (`cc+gi`) y como lo instala `init`, con el ayudante (`cc+gi+helper`); 60 ejecuciones, 4,48 $ en total | ¿Mejora graph-indexer una sesión real y delega el agente principal en el ayudante? Resultado: **12/12 preguntas exactas con graph-indexer frente a 9/12 sin él** (los tres fallos, las tres preguntas de llamadores a dos niveles), coste 0,86–0,89 y tiempo 0,68–0,70; refactorizaciones iguales (8/8, coste 0,98–1,03). **Nadie delegó**, ni en el ayudante ni en Explore: las sesiones duran 5–8 turnos y el agente lo busca él mismo. Las sesiones reales gastan una décima parte que los subagentes de las rondas anteriores, así que el ahorro relativo es menor y la ganancia está sobre todo en acertar. **Decisión:** el ayudante se queda (no cuesta nada si no se usa); queda por medir la delegación en tareas largas (issues) en sesiones reales. Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#real-sessions-rt1-20-tasks-60-runs) |
| F10 ✅ | Issues en sesiones reales (`rt2`: las 11 de la cuarta ronda, 2 ejecuciones por tarea y brazo, 66 sesiones, 7,62 $) y superficie de herramientas mínima (`rt3i` issues y `rt3q` preguntas y refactorizaciones, con `cc` de control el mismo día; 126 sesiones, 11,66 $) | ¿Qué cuesta graph-indexer donde el agente no lo necesita? Resultado: en issues **ninguna sesión lo llamó** y aun así costaban 1,07–1,10 (1,29 en arreglos de un fichero): su parte fija del prompt (definiciones cargadas de entrada, instrucciones del servidor, bloque de CLAUDE.md) sumaba 2.930 tokens que se releen en cada turno, y 62 de las 64 llamadas en sesiones reales eran `find_references`. **Decisión:** solo `find_references` se carga de entrada; el resto queda tras la búsqueda de herramientas del cliente, con descripciones e instrucciones de pocas líneas. La parte fija baja a 1.190 tokens; issues 1,02–1,05 (IC incluye 1), preguntas 12/12 frente a 8/12 a 0,80–0,84 del coste, refactorizaciones iguales. Nadie delegó en 252 sesiones. Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md#real-sessions-on-issues-rt2-and-the-lean-tool-surface-rt3-252-runs) |
| F5 | B3 tras la ronda 4, con hooks reales ([`run-headless.mjs`](../bench/agentic/run-headless.mjs), que necesita un `claude` autenticado; los hooks de un subagente de proyecto no se ejecutan en las sesiones que corrieron las rondas) y tareas B3 nuevas. (1) **Después de la primera edición** está la mitad del coste de un issue: tests, revisar el cambio y buscar a mano las subclases que heredan el método editado. `check` ya las nombra y añade sus tests (tras la ronda, sin medir). (2) **Hooks** que llevan el siguiente salto a las lecturas, búsquedas y ediciones del propio agente sin una llamada más: la tarjeta de definiciones al rastrear, el rescate de definiciones y `check` tras editar. (3) **Lecturas de ficheros enteros**: las de más de 20.000 caracteres son 0,2–0,3 por ejecución y un 4–6 % del coste medio de B3 (hasta un 10–15 % en las ejecuciones donde ocurren, como sqlglot-87d16d02). Un PreToolUse que responda con el esquema del fichero solo se activa si la medición lo respalda: la evidencia externa sobre reescribir lecturas es negativa. (4) Más repositorios y lenguajes, y otros modelos | criterios del §3 con hooks reales |

## 9. Riesgos

- **Contexto añadido que no evita turnos.** La tarjeta cuesta tokens en cada lectura; si no ahorra búsquedas, resta. Se mide su tamaño y cuántas búsquedas evita, y se calla cuando no hay nombres externos relevantes.
- **Intervenir de más.** Contexto añadido en cada búsqueda encareció 1,44–1,72 veces las preguntas de tipo "dónde está X" en otro proyecto. Por eso el detector de rastreo y la tarjeta proporcional a lo leído.
- **Emulación frente a hooks reales.** La emulación mide el efecto del contenido, no el de la adopción automática. La validación con hooks reales queda pendiente de permiso o del arnés local.
- **Sobreajuste.** Las decisiones se toman con las tareas de desarrollo y se juzgan con tareas reservadas.
- **Potencia estadística.** Con 12–20 tareas por suite solo son detectables efectos de 20–30 % en coste. Los resultados se dan con su IC.
- **Un solo modelo.** Las rondas usan el mismo modelo; el comportamiento con otros agentes se comprueba con el arnés local.
