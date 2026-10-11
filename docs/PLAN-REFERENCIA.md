# Plan: graph-indexer como referencia de code intelligence para agentes

Fecha: 2026-10-11 · Propuesta. Complementa [PLAN-AGENTES.md](PLAN-AGENTES.md) (motor y benchmarks internos) con producto, competencia y adopción.

## Estado (2026-10-11, rama `roadmap/plan-referencia`)

| Punto | Estado | Medido |
|---|---|---|
| 1.1 `explore` | hecho | 4–50 ms por llamada; sin medir aún en sesiones de agente |
| 1.2 B3 con hooks reales | brazo `cc+gi+hooks` hecho y piloto preparado (11 tareas × 2 brazos, `b3h1`); sin lanzar | el preflight encontró la cuenta al 99 % del límite semanal y las herramientas MCP diferidas tras `ToolSearch` (`explore` no se carga de entrada pese a `_meta.alwaysLoad`; CodeGraph usa `"alwaysLoad": true` en la entrada del servidor) |
| 1.3 arena | ejes de exactitud e indexado medidos con CodeGraph 1.6.2 y codebase-memory-mcp 0.11.0 | nestjs P/R 0,993/0,886 frente a 0,743/0,755 y 0,559/0,263; fastapi 0,997/0,826 frente a 0,652/0,363 y 0,929/0,571; frío nestjs 1,9 s frente a 3,0 s y 11,8 s; perdemos en tamaño de respuesta (310 tokens frente a 80 y 96). Falta el eje de sesiones |
| 1.4 velocidad de indexado | parseo en hilos | nestjs completo: 3,3–3,8 s frente a 4,5–4,7 s, índice idéntico |
| 2.1 niveles de lenguaje | hechos en el README; Python con oráculo (pyright) en 6 repos | precisión 0,871–0,998, recall 0,929–0,998 (click 0,888→0,980 de recall); Go re-ejecutado (gin, caddy, nats-server): cifras idénticas a las publicadas; Rust con oráculo (rust-analyzer) en serde_json, ripgrep y tokio: precisión 0,930–0,955, recall 0,582–0,841 (antes 0,887–0,914 / 0,389–0,555); pasa a nivel verificado |
| 2.2 frameworks | rutas HTTP → manejador (FastAPI, Flask, NestJS, Spring, Express/Fastify/Koa/Hono, Gin/Echo/chi, net/http) | — |
| 3.1 nombre | decisión pendiente | — |
| 3.2 primer minuto | `init` termina con `demo` (grep frente a usos exactos en el repo del usuario) | nestjs: 4.238 líneas de grep frente a 129 llamadas exactas |
| 3.3 feedback | `graph-indexer report` y plantilla de issue | — |
| 4 promoción | no empieza hasta tener el arena con competidores (puerta P2) | — |

## 0. Tesis

graph-indexer ya gana en lo difícil de copiar: referencias exactas verificadas contra compiladores (TS 0,996 / 0,961; Go y Java con oráculo), índice siempre fresco y cero dependencias. Pierde en lo que sí se puede construir en semanas: eficiencia en sesiones de issues reales (B3 a 0,85 del coste de grep, objetivo 0,70), una herramienta de "dame todo el contexto", cobertura de lenguajes y frameworks, y visibilidad.

La jugada: **ser el árbitro de la categoría antes de ser el rey.** Publicar el benchmark abierto y reproducible con el que se comparan todas las herramientas (incluida la nuestra, también cuando pierde). Quien define la métrica define la conversación, y la métrica que mejor nos favorece —respuestas exactas y baratas— es también la que más importa al usuario.

Métrica norte (una sola, pública): **coste por tarea resuelta, con la misma resolución o mejor, frente a grep y frente a cada competidor, en tareas reservadas.**

## 1. Fase 1 (semanas 0–6): ganar en eficiencia de sesión

Nada de promoción fuerte hasta cerrar esta fase: el lanzamiento debe llegar con una victoria medible frente a CodeGraph.

### 1.1 `explore`: una llamada, el contexto entero
La lección de CodeGraph: el agente usa una herramienta potente, no ocho especializadas.
- Entrada: una pregunta o tarea en lenguaje natural, o una lista de símbolos/ficheros. Opcional `budget` en tokens (por defecto 1.500, máx. 4.000).
- Salida, en este orden y recortada al presupuesto con truncado explícito:
  1. símbolos semilla (búsqueda híbrida + coincidencias exactas de identificadores en la pregunta);
  2. su código, con números de línea editables;
  3. tarjeta de definiciones de los nombres externos que usan;
  4. llamadores y dependientes directos (con confianza declarada), subclases/implementaciones;
  5. tests que los cubren y el comando para ejecutarlos;
  6. una línea "qué no se muestra y cómo pedirlo".
- Reutiliza `search_code`, `read_code`, `find_references`, `change_impact` y `testcmd`: es composición, no un motor nuevo.
- Se convierte en la herramienta que se carga de entrada junto a `find_references`; las demás siguen disponibles por nombre.
- Puerta: en B3, turnos hasta la primera edición −30 % y precisión de contexto ×1,5 frente al brazo actual.

### 1.2 Cerrar B3 (lo que queda de F5)
- Ejecutar la ronda con hooks reales (`run-headless.mjs`), ahora con `explore`.
- `check` tras editar con subclases y tests afectados ya nombrados, medido.
- Puerta: B3 ≤ 0,70 de coste con resolución no inferior. Si no se alcanza, se publica igualmente el resultado.

### 1.3 Benchmark cara a cara, abierto (`bench/arena/`)
- Mismo arnés agéntico, mismo modelo, mismas tareas reservadas, 4 brazos: grep solo, graph-indexer, CodeGraph, codebase-memory-mcp. Versiones fijadas e instaladas como recomienda cada proyecto.
- Tres ejes, cada uno con IC del 95 % pareado por tarea:
  - sesión: coste real, turnos, tiempo, resolución (B1–B4);
  - exactitud: precisión/cobertura de referencias contra oráculos de compilador;
  - indexado: tiempo en frío e incremental en un repo pequeño, uno medio y uno enorme (p. ej. Twenty, 28k ficheros).
- Invitar a los mantenedores de los competidores a revisar la configuración de sus brazos **antes** de publicar. Aceptar PRs que mejoren su brazo.
- Página de resultados regenerable con un comando, publicada aunque perdamos en algún eje (y diciendo dónde).

### 1.4 Velocidad de indexado
- Perfilar el indexado en frío sobre Twenty y un monorepo grande de Go/Java; fijar objetivo con datos (orientativo: ≤ 2× el binario nativo más rápido en frío, ≤ 200 ms incremental).
- Palancas por orden de rendimiento esperado: parseo en `worker_threads` (un parser WASM por worker), escrituras SQLite en lote dentro de una transacción con `PRAGMA` de carga masiva, resolución de referencias diferida por fichero, caché de árboles por huella de contenido.
- Sigue sin dependencias nativas: todo con built-ins de Node.

## 2. Fase 2 (semanas 6–14): cobertura sin perder precisión

### 2.1 Niveles de lenguaje, declarados en el README
- **Nivel 1 — verificado:** referencias medidas contra un oráculo de compilador en ≥ 3 repos reales, con cifras publicadas. Hoy: TypeScript/JavaScript, Go, Java.
- **Nivel 2 — resuelto:** ámbito + imports + tipos, sin oráculo aún.
- **Nivel 3 — sintáctico:** símbolos, esquema y búsqueda; referencias solo por nombre, marcadas como tales.
- Subir al nivel 1, por demanda: Python (pyright), C# (Roslyn), Rust (rust-analyzer), Kotlin. Un oráculo nuevo cada ~2 semanas.
- Añadir en nivel 3 los lenguajes que faltan con gramática WASM disponible: Swift, Dart, Lua, Elixir, Zig, Vue/Svelte (bloques de script). Cada uno: gramática en `vendor/grammars`, extractor en `src/parse/lang`, suite en `bench/suites`.

### 2.2 Frameworks: los enlaces que el compilador no ve
Donde los agentes más se pierden y donde grep falla. Cada uno se trata como un tipo de arista con su propia prueba de regresión:
- Rutas HTTP → manejador: Express/Fastify, NestJS, FastAPI/Flask, Django, Spring, ASP.NET, Gin/Echo, Rails.
- Inyección de dependencias → implementación: NestJS, Spring, ASP.NET, Angular.
- Componente → uso en plantillas/JSX: React, Vue, Svelte.
- Modelos ORM → tablas y migraciones: Prisma, TypeORM, SQLAlchemy, Django ORM.
- `explore` y `change_impact` cruzan estas aristas ("cambiar este DTO afecta a estas 3 rutas").
- Prioridad por lo que pidan los issues de usuarios reales (§3.3), empezando por NestJS, FastAPI y Spring, que ya tienen tareas en el benchmark.

## 3. Producto y adopción (en paralelo desde la semana 0)

### 3.1 Nombre
"graph-indexer" choca con The Graph Protocol en búsquedas y no dice qué hace. Con 11 estrellas, renombrar nunca será más barato que ahora; después del lanzamiento será inviable. Decidir en la semana 1:
- si se mantiene: añadir un descriptor fijo en todo sitio visible ("graph-indexer — exact code references for AI agents") y comprobar que buscar "graph-indexer mcp" da el repo primero;
- si se cambia: nombre corto, buscable, con npm y dominio libres; `graph-indexer` queda como alias en npm y redirección en GitHub. Actualizar [TRADEMARK.md](../TRADEMARK.md).

### 3.2 Primer minuto
- `npx graph-indexer init` detecta el agente, indexa y muestra en la terminal **una respuesta real sobre el propio repo del usuario** (p. ej. el símbolo más referenciado y sus usos exactos frente a lo que devolvería grep). Ese contraste es la demo.
- Un GIF de 20 segundos en el README con ese mismo contraste, antes de cualquier tabla.
- README: tres frases arriba (qué es, por qué es distinto, cómo se instala), la tabla del arena después, la arquitectura al final.
- Listado en los directorios de MCP y en los marketplaces de plugins de cada agente (Claude Code, Cursor, VS Code, Gemini CLI, Codex).

### 3.3 Bucle de feedback sin telemetría
Sin telemetría por defecto (coherente con "local y honesto"):
- `graph-indexer report` genera un resumen local y anónimo (lenguajes, tamaño, latencias, llamadas no enlazadas por tipo) que el usuario puede pegar en un issue.
- Plantilla de issue "respuesta incorrecta" con el comando exacto para reproducirla; cada una se convierte en un test de regresión. Objetivo: respuesta en < 48 h y arreglo publicado en < 1 semana.
- Releases pequeñas y frecuentes (cada 1–2 semanas) con changelog que nombre a quien reportó.

## 4. Promoción (desde la semana 6, con el arena publicado)

Mensaje central: **"La mayoría te da un mapa aproximado. Este te da referencias exactas, actualizadas y pequeñas — y te enseña el benchmark donde pierde."**

| Semana | Acción | Pieza |
|---|---|---|
| 4–5 | Power users primero | 10–20 personas conocidas en Claude Code/Cursor/MCP: acceso al arena antes de publicar, pedir que lo ejecuten en sus repos. Su feedback entra antes del lanzamiento. |
| 6 | Show HN | "Show HN: exact code references for AI agents, checked against the TypeScript, Go and Java compilers". Enlace al arena, no a la landing. Responder todo el día. |
| 6–7 | Post técnico largo | "Medimos 4 herramientas de code graph para agentes con oráculos de compilador": metodología, resultados por eje, dónde perdemos. |
| 7+ | Hilos en X / Reddit (r/ClaudeAI, r/cursor, r/LocalLLaMA) | Un antes/después real por hilo: misma pregunta, transcript con grep vs con graph-indexer, tokens y turnos. |
| 8+ | Cadencia | Cada lenguaje que sube a nivel 1 y cada framework nuevo es un post corto con su cifra. Re-ejecutar el arena con cada versión de los competidores y publicar el diff. |
| 10+ | Integraciones | PRs a plantillas/starters de agentes y a guías de MCP para que graph-indexer aparezca como opción por defecto de "code graph". |

Lo que no se hace: cifras sin IC, "100× menos tokens", comparaciones con brazos de competidores mal configurados.

## 5. KPIs y puertas

| Puerta | Cuándo | Criterio |
|---|---|---|
| P1 | semana 6 | B3 ≤ 0,70 de coste; `explore` publicado; arena con 4 brazos y resultados públicos |
| P2 | semana 6 | graph-indexer ≤ coste por tarea resuelta de CodeGraph en B1–B3, con exactitud superior; si no, no se lanza HN y se itera |
| P3 | semana 10 | indexado en frío ≤ 2× el más rápido; ≥ 1 lenguaje nuevo en nivel 1; 3 frameworks con aristas |
| P4 | semana 14 | 1.000 estrellas, 50 issues externos resueltos, 10 contribuidores externos, ≥ 1 benchmark independiente (de terceros) que lo cite |

## 6. Riesgos

- **Benchmark percibido como sesgado.** Mitigación: brazos revisados por sus mantenedores, código y transcripts públicos, publicar derrotas.
- **`explore` infla el contexto en tareas sencillas** (como ya pasó con contexto añadido en "¿dónde está X?"). Mitigación: presupuesto por defecto bajo y puerta B4 (≤ +5 %).
- **Frameworks degradan la precisión.** Mitigación: cada tipo de arista con confianza declarada y su propia suite; nunca mezclarlas en las cifras de nivel 1.
- **Competidores copian `explore`.** Esperable; la ventaja defendible es la exactitud verificada y el arena. Por eso se invierte en oráculos.
- **Capacidad.** Un equipo pequeño no hace todo a la vez: el orden es 1.1 → 1.3 → 1.2 → 3.2 → 1.4 → Fase 2. Si hay que recortar, se recorta Fase 2, nunca el arena.
