# Plan de ingeniería: llevar graph-indexer al estado del arte

Fecha: 2026-09-22 · Estado: tres rondas de evaluación completadas (ver §7 y §9) · Sustituido como plan activo por [PLAN-AGENTES.md](PLAN-AGENTES.md) el 2026-09-23

Base empírica: [informe de investigación](research/reports/Impacto%20real%20de%20indexación%20en%20agentes.md) y sus [notas](research/research_notes/Impacto%20real%20de%20indexación%20en%20agentes/), la investigación previa ([informe](research/Indexación%20de%20código%20para%20agentes%20IA.md)), dos estudios de uso con agentes sobre nestjs, fastapi y gin, y un pilotaje del benchmark agéntico.

## 1. Qué significa aquí "estado del arte"

graph-indexer está en el estado del arte cuando, con el mismo modelo y la misma tarea, un agente de código que lo usa **junto a grep** o **en lugar de grep** resuelve más tareas reales, o las mismas con claramente menos coste, sin empeorar las tareas sencillas. Se mide de extremo a extremo (tareas resueltas, regresiones, tokens, turnos, tiempo), no con métricas de recuperación aisladas. Estas siguen sirviendo como pruebas de regresión.

Criterios de aceptación. Los benchmarks están en §5 y la estadística es pareada por tarea, con IC del 95 %.

| Puerta | Comparación | Criterio |
|---|---|---|
| G1 | grep + graph-indexer integrado frente a solo grep, tareas multi-sitio y de impacto | +10 puntos de tareas resueltas (IC excluye 0), o la misma tasa con −25 % de coste por tarea resuelta |
| G2 | ídem, en todo el conjunto | coste por tarea resuelta −15 % y tasa de resolución no inferior (margen −3 puntos) |
| G3 | graph-indexer sin grep frente a solo grep | resolución no inferior (margen −5 puntos) y coste no mayor |
| G4 | tareas sencillas (localizar una función) | coste como mucho +10 % |
| G5 | calidad del grafo frente al compilador de TypeScript | precisión ≥ 0,99 y cobertura ≥ 0,93; ningún "0 dependientes / riesgo bajo" falso en los casos de regresión |
| G6 | adopción en el brazo integrado | graph-indexer usado en ≥ 80 % de las tareas multi-sitio sin forzarlo |

## 2. Diagnóstico de la versión 3.0

**Lo que funcionaba.** Las referencias exactas cuando se conoce el tipo del receptor: `NestContainer.addProvider` 18/18 separado de `Module.addProvider`, `Reflector.get` 9/9 frente a 917 líneas de grep, 735 `@app.get` de FastAPI enlazados. También la velocidad (1–100 ms por llamada), los outlines (1k tokens frente a 5k de leer el fichero) y el precio de las herramientas en contexto (~1,8k tokens).

**Lo que fallaba.** Los estudios de uso encontraron respuestas **seguras y falsas**, que son las que más daño hacen a un agente:

- `change_impact` decía "0 dependientes, riesgo bajo" en código que se ejecuta en cada petición. Causas:
  - llamadas `await x.m<T>()` guardadas como lecturas;
  - clases de Python que no llevaban a su `__init__`;
  - interfaces sin implementaciones;
  - tests en bloques `describe` sin contar.
- Enlaces solo por nombre muy ruidosos: 395 de las 399 "referencias" de `HandlerMetadataStorage.set` eran `Map.set`, y 134 de 140 de `Params.Get` eran de la biblioteca estándar de Go.
- Se perdían las llamadas sobre variables llamadas `module`, `process`…
- Go no calculaba implementaciones de interfaces; Python no enlazaba `super()`, las anotaciones en texto ni los atributos `self.x`.
- 18 de 24 veredictos de "sin referencias" en `fastapi/` eran erróneos: faltaban lecturas de campos y atributos.
- El pie de página "712 llamadas no enlazadas, haz grep" obligaba a verificar a mano.

**Pilotaje del benchmark** (3 tareas × 2 configuraciones):
- El agente con solo grep responde bien a preguntas de un salto con estrategias ingeniosas: buscar "reflector" para acotar los ficheros.
- En la pregunta de dos niveles, graph-indexer dio la misma respuesta con −55 % de coste y la mitad de tiempo.
- En la de un salto costó +26 %, porque el agente desconfiaba del pie de página y lo verificaba con grep.

## 3. Lo que dice la evidencia (resumen)

1. **Resolución.** Los índices mejoran la localización con claridad (+20 a +40 puntos) y la resolución poco (+2 a +8,5 puntos).
   - El estudio más sólido ("Code Isn't Memory", 3 semillas) da 50,4 % frente a 41,9 % de tareas resueltas y 2,30 frente a 2,92 dólares por tarea resuelta, con la ganancia concentrada en cambios multi-archivo.
   - Frente a un buen agente con grep, en cambio, no es concluyente (p ≈ 0,08).
2. **Dónde fallan los agentes.** El 60–69 % de los fallos ocurre **después** de llegar al código correcto: arreglos parciales o incompletos, 37 % de los fallos analizados.
   - Los errores de sintaxis son el 24–30 % de los fallos de algunos modelos en SWE-bench Pro.
   - La tasa de éxito cae con el número de ficheros: RefactorBench 22 % frente a 87 % humano; SWE-EVO 21 % frente a 65 % en Verified.
3. **Verificación al editar.** Un linter tras cada edición sumó +3 puntos en SWE-agent.
   - Un mapa estático código→test bajó las regresiones del 6,08 % al 1,82 % y subió la resolución del 24 % al 32 %.
   - La selección de tests por nombres (NameRTS) evita el 69,9 % de los ficheros de test y detecta el 99,6 % de los afectados.
4. **Adopción.** Los agentes ignoran las herramientas opcionales.
   - LSP: 0–6 % de uso en localización, +6 % a +118 % de tokens; y forzarlo primero bajó el éxito del 100 % al 89 %.
   - Serena se usa en el 35 % de las sesiones.
   - Truncar sin avisar bajó el recall de 0,723 a 0,525.
   - Claude Code muestra de entrada solo los nombres de las herramientas MCP y las instrucciones del servidor (≤ 2.048 caracteres).
   - Los hooks funcionan también en subagentes y pueden añadir contexto tras cualquier herramienta.
   - Los ficheros de contexto largos generados por LLM restan un 3 % de éxito y encarecen un 20 %.
5. **Medición.** La varianza entre ejecuciones (0,5–3 puntos de desviación típica) es del tamaño de los efectos anunciados. Con diseño pareado y 3 ejecuciones por brazo hacen falta:

   | Efecto a detectar | Tareas necesarias |
   |---|---|
   | 15 puntos de resolución | ~30 |
   | 10 puntos de resolución | ~56 |
   | −20 a −30 % de coste | 15–40 |

## 4. Principios de diseño

1. **Nunca con seguridad y equivocado.** Mejor "no sé, y por qué" que un cero falso. Cada respuesta dice qué no puede ver: llamadas no enlazadas con el mismo nombre, lecturas de campos sin tipo, despacho dinámico. Separa lo plausible de lo irrelevante para que el agente no tenga que verificar con grep.
2. **Dentro del flujo del agente.** El agente ya usa grep, edita y ejecuta tests; graph-indexer tiene que mejorar esos pasos:
   - un grep que dice a qué definición apunta cada coincidencia;
   - una comprobación tras editar;
   - los tests a ejecutar, con el comando.
3. **Respuestas completas y acotadas.** Totales siempre exactos, truncado explícito, lo importante primero (código de la biblioteca antes que tests y ejemplos) y el siguiente paso al final.
4. **Verificar es más barato que razonar.** Detectar sin compilar lo que el agente olvidó (llamadores, nombres renombrados, sintaxis) ataca la mayor clase de fallos.
5. **Medir de extremo a extremo antes de declarar mejoras**, con el agente real, tareas verificables y estadística pareada.

## 5. Benchmarks nuevos

Arnés en [`bench/agentic/`](../bench/agentic/). Las configuraciones (brazos) comparten modelo, tarea e instrucciones y solo cambian las herramientas:

| Brazo | Herramientas |
|---|---|
| `grep` | Read, Grep, Glob, Bash, Edit, Write |
| `gi` | graph-indexer en lugar de grep/glob (sin grep, rg ni find en la shell) |
| `grep+gi` | ambos, presentado como un servidor MCP |
| `grep+gi+` | ambos, con reglas de decisión y los comandos de verificación de la integración (ronda 1) |
| `grep+gi2` | ambos, con la segunda versión de las reglas: verificar solo los cambios que cruzan el límite de una función (ronda 2) |
| `gi2` | graph-indexer en lugar de grep/glob, con las reglas de `grep+gi2` y `files` para buscar ficheros (ronda 2) |
| `grep+gi3` | ambos, con la tercera tarjeta: `refs` lista los subtipos indirectos, filtra por directorio y dice cuándo una lista de llamadas está completa (ronda 3) |
| `gi3` | graph-indexer en lugar de grep/glob, con la tercera tarjeta (ronda 3) |

La política de herramientas se audita en cada trayectoria. Las violaciones se mantienen en el análisis (intención de tratar) y `--exclude-violations` sirve de análisis de sensibilidad. Las ejecuciones que consultan la solución (web, repositorio remoto, clones locales con la historia posterior, ficheros de la tarea, respuestas o copias de trabajo de otras ejecuciones), las corregidas mientras el agente seguía trabajando y las cortadas por errores de la API se descartan y se repiten; cada descarte queda registrado con su motivo. Las preguntas mal planteadas (un getter y un setter con el mismo nombre) se retiran antes de comparar y se sustituyen. Métricas por ejecución:
- tareas resueltas y puntuación;
- tokens (entrada sin caché, escritura y lectura de caché, salida) y un coste equivalente;
- turnos, llamadas a herramientas y tiempo.

La estadística es pareada por tarea: IC por bootstrap, McNemar exacto, permutación de signos y corrección de Holm.

| Suite | Qué mide | Cómo se corrige | Estado |
|---|---|---|---|
| B1 Preguntas con oráculo (TypeScript, nestjs) | encontrar llamadas de un método con homónimos, llamadores a dos niveles, implementaciones | conjunto verificado por el compilador de TypeScript; P/R/F1 | 25 tareas: 8 de desarrollo, 7 reservadas y 10 de la tercera ronda |
| B2 Cambios multi-sitio | añadir un parámetro obligatorio y actualizar todos los llamadores, renombrar un método con homónimos | `tsc` diferencial + comprobación estructural (señuelos intactos) | 20 tareas validadas (la solución de referencia pasa, el checkout sin tocar y la solución textual fallan): 8 de desarrollo, 6 reservadas y 6 de la tercera ronda, generadas sin repetir ningún método |
| B3 Cambios reales posteriores al corte (Python) | issues reales de sqlglot y networkx con commits de junio–septiembre de 2026 | tests del commit (FAIL_TO_PASS) y existentes (PASS_TO_PASS), aplicados solo al corregir | 24 tareas validadas: 14 de desarrollo y 10 reservadas; checkout de un solo commit y trabajo sin red |
| B4 Tareas sencillas | arreglos de un solo fichero y ≤ 40 líneas | el subconjunto de B3 que cumple esa condición (G4) | sin suite propia |
| B5 Regresión (existentes) | precisión del grafo, búsqueda, localización en commits | oráculo del compilador, consultas escritas, commits reales | en uso |

**Limitaciones del entorno actual:**
- Los registros de paquetes (npm, PyPI, Go, crates, Maven) están bloqueados por la política de red. Por eso los cambios reales con tests se limitan a proyectos sin dependencias (sqlglot, networkx) y los de TypeScript se corrigen con `tsc` diferencial.
- No se pueden lanzar agentes `claude -p` anidados, así que las ejecuciones usan subagentes. Las herramientas de cada brazo se fijan por instrucciones y se comprueban después en la trayectoria.
- El arnés headless con hooks y MCP reales (`claude -p --tools … --mcp-config … --settings …`) no está implementado: el lector de transcripciones admite su formato, pero falta el script que lance las ejecuciones.

## 6. Líneas de trabajo

| # | Línea | Contenido | Prioridad | Estado |
|---|---|---|---|---|
| W1 | Corrección y honestidad del grafo | los 20 fallos del §2; pie de página con plausibilidad; impacto con sitios, overrides, tests y puntos ciegos; `riesgo: desconocido` | P0 | hecho (precisión 0,979→0,996, cobertura 0,895→0,960) |
| W2 | grep estructural | `search_text` / `graph-indexer grep`: todo el repositorio, cada coincidencia con su definición contenedora y, para identificadores, a qué símbolo apunta | P0 | hecho |
| W3 | Verificación tras editar | `check_changes` / `graph-indexer check`: sintaxis nueva, llamadas que ya no encajan con una firma cambiada, definiciones eliminadas o renombradas aún en uso, llamadores sin tocar, tests y comando | P0 | hecho (≈1 s en nestjs) |
| W4 | Selección de tests | tests que ejercitan el cambio, por grafo y convenciones de nombre, con el comando por ecosistema (jest, vitest, mocha, pytest, unittest, Django, go test, cargo, Maven/Gradle…) | P0 | hecho (mejora continua) |
| W5 | Integración en agentes | ver detalle debajo | P0 | hecho: instrucciones con reglas adaptativas, herramientas siempre visibles, bloque de `CLAUDE.md`/`AGENTS.md`, `hook`, `init --hooks` y plugin de Claude Code; para Cursor, VS Code, Gemini CLI y Codex, configuración MCP e instrucciones |
| W6 | Canal semántico opcional | potion-code-16M-v2 (MIT, 32 MB, JS puro; 3.790 fragmentos/s) con fusión ponderada y peso bajo en consultas de identificador; solo se activa si mejora B3/B4 y la suite semántica | P2 | experimento |
| W7 | Marcos y lenguajes | rutas HTTP → handlers, inyección de dependencias, eventos; alternativas `if PYDANTIC_V2` y ficheros con build tags de Go; recall de lecturas de campos sin tipo | P1 | pendiente |
| W8 | Escala | prefiltro de trigramas (FTS5) para grep en monorepos; comprobación incremental rápida para hooks (< 300 ms) | P1 | pendiente |

**Detalle de W5 (integración):**
- instrucciones del servidor con reglas de decisión, en ≤ 2.048 caracteres, redactadas como hechos;
- descripciones que venden la herramienta en la primera frase, porque la búsqueda de herramientas muestra solo nombres;
- herramientas clave marcadas como siempre visibles;
- bloque de 6–8 líneas en `AGENTS.md`/`CLAUDE.md`;
- `graph-indexer hook`, que falla en abierto y calla cuando no aporta:
  - tras un grep de un identificador ambiguo añade qué definición es cada una;
  - tras editar ejecuta `check` sobre el fichero;
  - en SessionStart/SubagentStart da una línea de estado;
- plugin de Claude Code y `init --hooks`;
- configuración equivalente para Codex, Gemini CLI y Cursor.

## 7. Orden de ejecución

1. ✅ Revisión, investigación, pilotaje del arnés y B1.
2. ✅ W1–W4, con tests de regresión (`test/honesty.test.mjs`) y benchmarks B5 sin regresiones.
3. ✅ W5: instrucciones, descripciones, `init`, `graph-indexer hook` y plugin.
4. ✅ B2 y B3: generación, validación de cada tarea (la solución de referencia pasa, el checkout sin tocar falla) y pilotaje.
5. ✅ Ronda de desarrollo (instantáneas rc2 y rc3): brazos `grep`, `gi`, `grep+gi` y `grep+gi+` sobre B1 (8), B2 (8) y B3 (14), una ejecución por tarea y brazo con el mismo modelo.
6. ✅ Iteración sobre las trayectorias (instantánea rc4): reglas adaptativas (verificar solo lo que cruza el límite de una función), líneas de `search_text` compactas, `symbol` con varios objetivos, `files`, miembros nombrados por cadena, `super()` sin despacho a hermanos y sin falsos positivos de `check` con decoradores.
7. ✅ Ronda reservada (instantánea rc4): brazos `grep`, `gi2` y `grep+gi2` sobre tareas que no se usaron en el desarrollo: B1 (7), B2 (6) y B3 (10).
8. ✅ Iteración sobre la ronda reservada (instantánea rc5): `refs` lista los subtipos indirectos y el tipo por el que pasan, filtra por directorio (`--path`) y dice cuándo una lista de llamadas está completa.
9. ✅ Tercera ronda (instantánea rc5): brazos `grep`, `gi3` y `grep+gi3` sobre B1 (10) y B2 (6) nuevas.
10. ✅ Huecos de cobertura que mostraron las trayectorias, corregidos y medidos contra el compilador: cadenas fluidas de una llamada por línea, cadenas que empiezan por `(await …)`, parámetros de tipos función tomados por variables locales, parámetros de callbacks tipados por la firma de la función que los recibe y posibles llamadas omitidas en ficheros que usan una subclase.
11. Siguientes pasos en §9.

## 8. Riesgos

- **Potencia.** Con 30–60 tareas solo son detectables efectos de 10–15 puntos en resolución o del 20–30 % en coste. Los resultados se darán con sus IC y sin extrapolar.
- **Fidelidad.** Un subagente con restricciones por instrucciones no es idéntico a un agente con herramientas eliminadas, y los hooks no se pueden medir en esta sesión. Un arnés headless en local cubriría ese caso (pendiente de escribir).
- **Contaminación.** B1 y B2 son tareas nuevas por construcción; B3 usa commits posteriores al corte de los modelos.
- **Sobreajuste.** B1 lo verifica el compilador, no graph-indexer. Los pesos de búsqueda solo se ajustan con la partición de ajuste.
- **Coste de verificación.** `check` y los hooks deben seguir siendo rápidos y silenciosos cuando no hay nada que decir; si no, restarían en lugar de sumar.

## 9. Resultados y siguientes pasos

Detalle en [AGENTIC-BENCHMARK.md](AGENTIC-BENCHMARK.md). Mismo modelo, una ejecución por tarea y brazo, coste en tokens equivalentes de entrada, pareado por tarea con IC del 95 % por bootstrap:

| Ronda | Tareas | graph-indexer con grep: coste frente a `grep` | Sin grep | Resueltas |
|---|---|---|---|---|
| Desarrollo (rc2/rc3) | B1 8, B2 8, B3 14 | 0,93 (0,81–1,03); B1 + B2: 0,76 | 0,97 (0,81–1,17) | 120 de 120 |
| Reservada (rc4) | B1 7, B2 6, B3 10 | 0,90 (0,77–1,04); B1 + B2: 0,81 | 1,02 (0,89–1,15) | 69 de 69 |
| Tercera (rc5) | B1 10, B2 6 | 0,73 (0,58–0,90) | 0,82 (0,59–1,12) | 47 de 48 (`grep`: 15 de 16) |

| Puerta | Estado |
|---|---|
| G1 (B1 + B2, integrado) | cumplida en la tercera ronda: coste por tarea resuelta 0,68 (0,49–0,90), por debajo de 0,75 en la estimación puntual; 0,76 y 0,81 en las anteriores |
| G2 (todo, integrado) | no cumplida: 0,90 en la ronda reservada frente a 0,85; B3 no se movió y la tercera ronda no lo repitió |
| G3 (sin grep) | cumplida en desarrollo (0,97), no en la reservada (1,02, IC 0,89–1,15); 0,82 en B1 + B2 de la tercera |
| G4 (tareas sencillas) | cumplida (1,06 y 0,98) |
| G5 (grafo frente al compilador) | cumplida: precisión 0,996, cobertura 0,960 |
| G6 (adopción) | cumplida: 100 % en las tres rondas |

**Conclusiones.**
- En preguntas de código y refactorizaciones multi-sitio, graph-indexer junto a grep cuesta en torno a tres cuartos de grep solo, sin perder tareas. Para responder por cadenas de llamadores el agente lee una cuarta parte del código, y "qué clases implementan X" pasó de costar 1,46 veces grep a 0,62 tras la iteración rc5.
- Sin grep no se pierde nada y el coste es parecido.
- Arreglar issues reales (B3) cuesta lo mismo con o sin graph-indexer. El 70–80 % de lo que lee el agente es el código alrededor del fallo y la salida de los tests, pero el coste es sobre todo el razonamiento del modelo y el prefijo que se relee en cada turno ([PLAN-AGENTES.md](PLAN-AGENTES.md) §2).
- Casi todas las ejecuciones resuelven su tarea en todos los brazos, así que el benchmark mide sobre todo coste.

**Siguientes pasos.**
1. B3: menos lectura y menos ejecuciones de tests (lanzar solo los tests que ejercitan el cambio, mostrar la parte relevante de las salidas largas) y repetir B3 con la tarjeta actual.
2. `impact`: registrar al indexar el tipo estático del receptor, para no contar como afectadas las llamadas a través de un supertipo que no pueden llegar a la sobrescritura cambiada.
3. Cobertura pendiente: objetos literales tipados por una interfaz, desestructuración y clases declaradas como expresión.
4. Más repositorios y lenguajes en B1 y B2, y varias ejecuciones por tarea para estrechar los intervalos.
5. La integración real (servidor MCP y hooks dentro del arnés del agente) con el arnés headless en local.
