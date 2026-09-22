# Plan de ingeniería: llevar graph-indexer al estado del arte

Fecha: 2026-09-22 · Estado: en ejecución (ver §7)

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
| `grep+gi+` | ambos, con reglas de decisión y los comandos de verificación de la integración |

La política de herramientas se audita en cada trayectoria y las violaciones se excluyen. Métricas por ejecución:
- tareas resueltas y puntuación;
- tokens (entrada sin caché, escritura y lectura de caché, salida) y un coste equivalente;
- turnos, llamadas a herramientas y tiempo.

La estadística es pareada por tarea: IC por bootstrap, McNemar exacto, permutación de signos y corrección de Holm.

| Suite | Qué mide | Cómo se corrige | Estado |
|---|---|---|---|
| B1 Preguntas con oráculo (TypeScript, nestjs) | encontrar llamadas de un método con homónimos, llamadores a dos niveles, implementaciones | conjunto verificado por el compilador de TypeScript; P/R/F1 | 15 tareas generadas, pilotaje hecho |
| B2 Cambios multi-sitio | añadir un parámetro obligatorio y actualizar todos los llamadores, renombrar un método con homónimos, eliminar una API y migrar sus usos | TypeScript: `tsc` diferencial + comprobación estructural (señuelos intactos); Python: tests del proyecto + `pyright` diferencial | por generar |
| B3 Cambios reales posteriores al corte (Python) | issues reales de sqlglot y networkx con commits de junio–septiembre de 2026 | tests del commit (FAIL_TO_PASS) y existentes (PASS_TO_PASS), aplicados solo al corregir | repositorios validados sin red |
| B4 Tareas sencillas | localizar una función descrita en palabras | respuesta verificada; coste | por crear |
| B5 Regresión (existentes) | precisión del grafo, búsqueda, localización en commits | oráculo del compilador, consultas escritas, commits reales | en uso |

**Limitaciones del entorno actual:**
- Los registros de paquetes (npm, PyPI, Go, crates, Maven) están bloqueados por la política de red. Por eso los cambios reales con tests se limitan a proyectos sin dependencias (sqlglot, networkx) y los de TypeScript se corrigen con `tsc` diferencial.
- No se pueden lanzar agentes `claude -p` anidados, así que las ejecuciones usan subagentes. Las herramientas de cada brazo se fijan por instrucciones y se comprueban después en la trayectoria.
- El arnés headless con hooks y MCP reales (`claude -p --tools … --mcp-config … --settings …`) queda preparado para ejecutarse en local.

## 6. Líneas de trabajo

| # | Línea | Contenido | Prioridad | Estado |
|---|---|---|---|---|
| W1 | Corrección y honestidad del grafo | los 20 fallos del §2; pie de página con plausibilidad; impacto con sitios, overrides, tests y puntos ciegos; `riesgo: desconocido` | P0 | hecho (precisión 0,979→0,996, cobertura 0,895→0,929) |
| W2 | grep estructural | `search_text` / `graph-indexer grep`: todo el repositorio, cada coincidencia con su definición contenedora y, para identificadores, a qué símbolo apunta | P0 | hecho |
| W3 | Verificación tras editar | `check_changes` / `graph-indexer check`: sintaxis nueva, llamadas que ya no encajan con una firma cambiada, definiciones eliminadas o renombradas aún en uso, llamadores sin tocar, tests y comando | P0 | hecho (≈1 s en nestjs) |
| W4 | Selección de tests | tests que ejercitan el cambio, por grafo y convenciones de nombre, con el comando por ecosistema (jest, vitest, mocha, pytest, unittest, Django, go test, cargo, Maven/Gradle…) | P0 | hecho (mejora continua) |
| W5 | Integración en agentes | ver detalle debajo | P0 | en curso |
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
3. ⏳ W5: instrucciones, descripciones, `init`, `graph-indexer hook` y plugin.
4. ⏳ B2 y B3: generación, validación de cada tarea (el parche real pasa y el vacío falla) y pilotaje.
5. ⏳ Medición principal:
   - brazos `grep`, `gi`, `grep+gi` (v3.0 como línea base) y `grep+gi+` (versión actual);
   - k = 2–3 ejecuciones por tarea, orden aleatorio y el mismo modelo;
   - informe con los criterios del §1.
6. Iterar sobre los fallos observados en las trayectorias y volver a medir. W6–W8 según lo que muestren los datos.

## 8. Riesgos

- **Potencia.** Con 30–60 tareas solo son detectables efectos de 10–15 puntos en resolución o del 20–30 % en coste. Los resultados se darán con sus IC y sin extrapolar.
- **Fidelidad.** Un subagente con restricciones por instrucciones no es idéntico a un agente con herramientas eliminadas, y los hooks no se pueden medir en esta sesión. El arnés headless cubre ese caso en local.
- **Contaminación.** B1 y B2 son tareas nuevas por construcción; B3 usa commits posteriores al corte de los modelos.
- **Sobreajuste.** B1 lo verifica el compilador, no graph-indexer. Los pesos de búsqueda solo se ajustan con la partición de ajuste.
- **Coste de verificación.** `check` y los hooks deben seguir siendo rápidos y silenciosos cuando no hay nada que decir; si no, restarían en lugar de sumar.
