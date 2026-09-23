# Plan: graph-indexer como capa de lectura y búsqueda de código para agentes

Fecha: 2026-09-23 · Plan activo. [PLAN-SOTA.md](PLAN-SOTA.md) queda como historia de cómo se llegó a la versión 3.0.

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
- **Precisión de las referencias** frente al compilador de TypeScript: 0,996, con cobertura 0,960.

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

   Lo que devuelven las herramientas es el 11–21 %. Un turno evitado en un issue ahorra en torno a 15k tokens equivalentes; acortar una salida en 1k tokens ahorra unos 4k.
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
   - Cada llamada por CLI tarda 1–2,5 s solo en arrancar.

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
7. **Medir de extremo a extremo** con la métrica corregida antes de declarar una mejora.

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
- **Instrucciones** (`AGENTS.md`, `CLAUDE.md`, reglas) y una skill: pocas líneas, redactadas como hechos.

### 5.3 Proceso residente

El servidor MCP escucha también en un socket local del repositorio. La CLI y los hooks lo usan si está vivo, en menos de 100 ms; si no, abren el índice ellos mismos, como hoy.

## 6. Integración por agente

Lo que cada agente permite en septiembre de 2026 decide cuánto se puede hacer de forma transparente. Fuentes en [research/research_notes/…/integracion_en_agentes.md](research/research_notes/Impacto%20real%20de%20indexación%20en%20agentes/integracion_en_agentes.md) y [research/notes/output_rewriting_and_read_hooks.md](research/notes/output_rewriting_and_read_hooks.md).

| Agente | MCP | Instrucciones | Hooks útiles |
|---|---|---|---|
| Claude Code | sí; herramientas diferidas, instrucciones visibles | `CLAUDE.md` | PreToolUse (`updatedInput`), PostToolUse (`additionalContext`, `updatedToolOutput` en todas las herramientas); dentro de subagentes también |
| Codex CLI | sí; diferidas, búsqueda BM25 | `AGENTS.md` | contrato de Claude: PreToolUse (`updatedInput`, `additionalContext`), PostToolUse (`additionalContext`); todo pasa por la shell |
| VS Code / Copilot | sí (máximo 128 herramientas) | `AGENTS.md`, `.github/…` | PreToolUse y PostToolUse con `additionalContext` |
| Gemini CLI | sí; instrucciones en el system prompt | `GEMINI.md`, `AGENTS.md` | BeforeTool / AfterTool (`additionalContext`, `tailToolCallRequest`, que sustituye el resultado) |
| Cursor | sí | reglas, `AGENTS.md` | `postToolUse` con `additional_context`, con fallos de inyección reportados |
| Windsurf | sí (máximo 100 herramientas) | reglas, `AGENTS.md` | hooks previos que pueden bloquear; los posteriores son solo informativos |
| Junie, Kilo Code, Zed, Cline, OpenCode | sí | `AGENTS.md` o reglas propias | sin hooks útiles o no verificados: MCP e instrucciones |

## 7. Benchmarks

- **Métrica corregida** en [`bench/agentic/transcript.mjs`](../bench/agentic/transcript.mjs): salida reconstruida del crecimiento del contexto. El informe da coste real, salida, tiempo repartido, turnos hasta la primera edición y precisión de contexto.
- **Tareas reservadas nuevas.**
  - B3: commits posteriores al 22-09-2026 de sqlglot y networkx, y, si es posible, un tercer repositorio Python sin dependencias.
  - B1 y B2: nuevas, sin repetir métodos.
  - B4: tareas sencillas, el subconjunto de B3 de un solo fichero.
- **Brazos:**
  - `grep`: herramientas nativas;
  - `grep+gi4`: nativas más graph-indexer con la tarjeta nueva (`read`, lotes, tarjeta de definiciones); el agente decide cuándo usarlo, como con MCP sin hooks;
  - `gi4-hooks`: emulación de los hooks. El agente lee y busca con `gi read` y `gi grep`, que devuelven la misma salida que las herramientas nativas más lo que añadirían los hooks. Edita con las herramientas nativas.
- **Hooks reales.** La medición con hooks reales necesita registrarlos para los subagentes de la sesión, lo que requiere permiso explícito, o el arnés headless en local (`claude -p` con `--mcp-config` y `--settings`; `codex exec`). Queda como paso de validación.

## 8. Fases y puertas

| Fase | Contenido | Puerta |
|---|---|---|
| F0 ✅ | Diagnóstico (§2) y métrica corregida | — |
| F1 | `read` con tarjeta de definiciones, lotes y esquema plegado; `grep` con rescate de definiciones; `symbol` con tarjeta; tarjeta de instrucciones nueva | en las trayectorias B3, la tarjeta habría respondido ≥ 60 % de las búsquedas que persiguen un nombre ya visto; tarjeta media ≤ 400 tokens |
| F2 | Proceso residente; hooks de lectura, búsqueda y edición para Claude Code, Codex, VS Code/Copilot, Gemini CLI y Cursor; `init` para Windsurf, Junie, Kilo Code, Zed y OpenCode | p95 del hook < 150 ms con el proceso residente; silencio cuando no aporta |
| F3 | `context` evaluado sin agente sobre B3 | Acc@5 de función ≥ 0,6 antes de exponerlo |
| F4 | Ronda 4 sobre tareas reservadas | criterios del §3 |
| F5 | Iterar sobre las trayectorias; hooks reales; más repositorios y lenguajes | criterios del §3 con hooks reales |

## 9. Riesgos

- **Contexto añadido que no evita turnos.** La tarjeta cuesta tokens en cada lectura; si no ahorra búsquedas, resta. Se mide su tamaño y cuántas búsquedas evita, y se calla cuando no hay nombres externos relevantes.
- **Emulación frente a hooks reales.** La emulación mide el efecto del contenido, no el de la adopción automática. La validación con hooks reales queda pendiente de permiso o del arnés local.
- **Sobreajuste.** Las decisiones se toman con las tareas de desarrollo y se juzgan con tareas reservadas.
- **Potencia estadística.** Con 12–20 tareas por suite solo son detectables efectos de 20–30 % en coste. Los resultados se dan con su IC.
- **Un solo modelo.** Las rondas usan el mismo modelo; el comportamiento con otros agentes se comprueba con el arnés local.
