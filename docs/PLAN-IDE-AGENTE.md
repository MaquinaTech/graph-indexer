# Plan: graph-indexer, el IDE y la memoria del agente

Fecha: 2026-10-12 · Plan activo. Sustituye como plan de producto a [PLAN-REFERENCIA.md](PLAN-REFERENCIA.md), del que conserva la parte de adopción y lanzamiento (§3 y §4), y reordena las prioridades de [PLAN-AGENTES.md](PLAN-AGENTES.md).

## 0. Tesis

El código se escribió para que lo lean personas, y ahora lo leen y escriben agentes. La intuición original de graph-indexer era que el agente trabaja como una persona y que eso es ineficiente. Los datos la confirman a medias, y la mitad que falla cambia el plan:

- **Buscar y leer texto no es ineficiente para un modelo.** Es su interfaz nativa. Con `grep`, el agente llega a la función que tiene que cambiar en unas 2 llamadas y resuelve el 93 % de los issues reales (piloto `issue1p`). Ningún índice, ni el nuestro ni el de los competidores, le gana ahí: en la arena, B3 queda en 1,03 frente a Claude Code solo, y el `explore` mejorado sube a 1,12 en el piloto.
- **Lo ineficiente es deducir leyendo hechos que dependen de todo el repositorio.** ¿Quién llama de verdad a este método? ¿Qué rompe este cambio de firma? ¿Qué subclases heredan esto? ¿Qué tests lo cubren? Una persona no lo saca con grep: usa el IDE ("buscar usos") y el compilador. El agente no tiene IDE: lo deduce gastando tokens y a veces se equivoca sin saberlo. Ahí ganamos:
  - B1: 11 de 11 preguntas frente a 9 de 11 de Claude Code solo, todas las falladas de llamadores a dos niveles;
  - precisión de referencias de 0,99 frente a 0,56–0,93 de CodeGraph y codebase-memory-mcp.

**Definición:** graph-indexer calcula una vez, de forma exacta, lo que al agente le cuesta tokens y errores deducir, y se lo da cuando lo necesita. No es un buscador para agentes: es su IDE y su memoria.

**Prueba para cada función:** ¿la seguiría necesitando un modelo diez veces más listo?
- Localizar código a partir de un issue: no. Los modelos mejoran en eso con cada versión, así que invertir aquí es competir con el propio modelo.
- Referencias exactas, impacto, herencia, selección de tests y verificación sin compilar: sí. Son cálculos globales sobre todo el repositorio; ninguna inteligencia los abarata si hay que leer cada vez un millón de líneas. Esta ventaja dura.

## 1. Qué significa ser el mejor

**Métrica norte:** en las tareas donde importan los hechos globales, más tareas resueltas, menos errores silenciosos y menos coste por tarea resuelta. Se compara con Claude Code solo y con cada competidor (CodeGraph, codebase-memory-mcp, Serena), en tareas reservadas, con estadística pareada e IC del 95 %.

### Puertas

| Puerta | Qué mide | Criterio | Hoy |
|---|---|---|---|
| S1 hechos exactos | referencias frente a oráculos de compilador, en ≥ 3 repos por lenguaje | precisión ≥ 0,99 y cobertura ≥ 0,95 en TS/JS, Python, Go y Java; ningún "0 dependientes" falso en la suite de regresión | TS 0,996 / 0,961; Python 0,871–0,998 / 0,929–0,998; Rust 0,93–0,955 / 0,58–0,84 |
| S2 tareas de hechos globales (B1 + B2 + B5) | frente a Claude Code solo | +10 puntos de resueltas (IC > 0), o la misma tasa con coste por resuelta ≤ 0,75 | B1 0,92 y B2 1,00 de coste en la arena; B1 resueltas 11 frente a 9 |
| S3 frente a competidores | las mismas tareas, todos los brazos | mejor tasa de resueltas y menor coste por resuelta que cada competidor | B1 y B2 ganadas a los tres |
| S4 errores silenciosos (B5) | regresiones que deja el agente en código que no tocó (tests ocultos de otras partes) | la mitad que Claude Code solo | sin medir: el banco no existe |
| S5 no estorbar (B3, B4) | issues y arreglos sencillos | coste ≤ 1,03 con el IC superior ≤ 1,10, y resueltas no inferiores | B3 1,03 (0,97–1,08) en la arena; 1,12 en `issue1p` |
| S6 adopción | sesiones de B1, B2 y B5 que usan graph-indexer sin forzarlo | ≥ 80 % | 19 de 19 en la arena |

Ser el mejor del mundo, aquí, es cumplir S1 a S4 y publicarlo con método y transcripts, incluidas las derrotas.

## 2. Qué dejamos de hacer

- **Afinar la localización para B3.** Lo hecho se queda: `explore` muestra el código del issue en 25 de 50 issues en vez de 12, y la regla de `TokenType` sube de 9 a 14 y de 6 a 11. Pero B3 pasa a ser una puerta de no empeorar (S5), no un objetivo. El piloto `issue2`, ya en marcha, cierra esta línea: se publica lo que dé.
- **Añadir contexto que el agente no pidió.** Los hooks `b3h2`–`b3h4` añadieron 256 definiciones en 15 sesiones y no cambiaron nada (coste 1,00–1,07). Solo se inyecta un hecho cuando cambia lo que el agente haría (§3.4).
- **Avisar de qué tests romperá un arreglo** como palanca de B3: solo 13 de 50 arreglos correctos rompen tests existentes, y en sqlglot son expectativas de cadenas SQL que el grafo no puede ligar (`localize.mjs breaks`). El techo es de un 2 % del coste.

## 3. Líneas de trabajo

### 3.1 Verdad exacta: el motor (S1)

Es lo que nadie puede improvisar, y la base de todo lo demás: un hecho inexacto obliga al agente a comprobarlo y pierde su valor.

- **Python a nivel 1 en todos los repos:**
  - subir la cobertura más baja (0,929) sin perder precisión;
  - lecturas de atributos y `self.x` tipados;
  - `super()`, decoradores y descriptores.
- **Go y Java:** cerrar los huecos que señalan los oráculos (interfaces implícitas, genéricos, sobrecargas).
- **Rust:** cobertura de 0,58 a ≥ 0,90 (rasgos, métodos de `impl` genéricos, macros comunes).
- **C#** con Roslyn como oráculo, por demanda.
- **"No sé" antes que "cero":** cada respuesta dice qué no puede ver (despacho dinámico, llamadas por nombre en cadenas, reflexión), con un recuento exacto. Suite de regresión de falsos ceros, ampliada con cada caso que encuentren los agentes.
- **Medición:** los oráculos (`eval-graph*.mjs`) en cada cambio, como ya se hace. Ninguno puede empeorar.

### 3.2 Verificar después de editar (S2, S4)

Entre el 60 y el 69 % de los fallos de los agentes ocurren después de llegar al código correcto: arreglos incompletos y llamadores olvidados ([§3 de PLAN-SOTA](PLAN-SOTA.md#3-lo-que-dice-la-evidencia-resumen)). `check` es nuestra pieza más alineada con eso.

- **`check` como producto central.** Tras cada edición, sin compilar, dice:
  - qué llamadas ya no encajan con la firma cambiada;
  - qué nombres quitados se siguen usando;
  - qué subclases heredan el cambio;
  - qué llamadores en ficheros no tocados conviene revisar;
  - qué tests ejecutar, con el comando.
- **Selección de tests medida como NameRTS:** qué fracción de ficheros de test evita y qué fracción de los afectados detecta. La verdad de referencia se obtiene ejecutando la suite completa con y sin el parche correcto, generalizando `localize.mjs breaks` a B1, B2 y B5. Objetivo: detectar ≥ 99 % de los afectados evitando ≥ 60 %.
- **Opción de ejecutar:** `check` ejecuta los tests seleccionados y devuelve solo los fallos, con fichero:línea y lo esperado frente a lo obtenido. Ahorra el ciclo "ejecutar, filtrar con grep, volver a ejecutar" que vemos en las transcripciones. Se mide antes de ofrecerlo por defecto.

### 3.3 Editar con seguridad en muchos sitios (S2, S4)

Es la otra mitad de la tesis: el agente edita como una persona sin IDE, con `sed` por número de línea y heredocs de Python. En las transcripciones fallan a menudo (por ejemplo, `sed -i` sin `''` en macOS) y olvidan sitios.

- **Cambios estructurales sobre referencias exactas:**
  - renombrar un símbolo;
  - cambiar una firma y actualizar sus llamadas;
  - mover una definición y actualizar sus imports.
- Cada uno devuelve el diff y pasa por `check` antes de escribir nada.
- Solo cuando la referencia es exacta (confianza ≥ 0,9). Lo incierto se lista para que el agente decida.
- **Medición:** con B2 y B5, en sitios correctos y omitidos, llamadas y coste. Se lanza solo si gana en ambos.

### 3.4 El hecho justo en el momento justo (S6, S5)

- **Hook tras editar:** si la edición cambió una firma o quitó un nombre, el hook dice en una línea qué llamadas ya no encajan. Si no hay nada que decir, no dice nada.
- **Instrucciones mínimas:** `init` describe las herramientas de hechos globales (`find_references`, `change_impact`, `check`). `explore` queda para preguntas y tareas en palabras, no para localizar issues. Así se reduce el prefijo, que hoy pesa unos 1.700 tokens en cada llamada.
- **Medición:** adopción (S6) y coste en B3 (S5) con cada cambio de instrucciones.

### 3.5 Memoria entre sesiones (investigación)

El índice ya persiste entre sesiones; las respuestas del agente no. Esta línea mide si una segunda sesión sobre el mismo repositorio sale más barata cuando el índice recuerda qué se exploró y qué se cambió: decisiones, invariantes descubiertas, tests lentos. Es una apuesta: no entra en las puertas hasta tener un piloto con resultado.

## 4. Bancos de prueba

El banco define qué mejoramos, así que se reordena con la tesis.

| Banco | Qué mide | Tamaño objetivo | Papel |
|---|---|---|---|
| B1 preguntas de hechos globales | llamadores a varios niveles, implementaciones, quién usa un campo | ≥ 40 tareas nuevas en ≥ 4 lenguajes | principal (S2, S3) |
| B2 refactors | renombrar, cambiar firmas, mover, con tests ocultos | ≥ 30 tareas | principal (S2, S3) |
| **B5 errores silenciosos (nuevo)** | tareas cuyo arreglo plausible rompe un llamador o una subclase que no aparecen en el issue; se califican con los tests ocultos de esas otras partes | ≥ 30 tareas, minadas de commits reales que tocaron llamadores en varios ficheros | principal (S4) |
| B3 issues reales | arreglo de un issue | las 50 actuales, más tareas frescas de cada ronda | no empeorar (S5) |
| B4 arreglos sencillos | un fichero | las actuales | no empeorar (S5) |
| Oráculos | precisión y cobertura frente al compilador | TS, Python, Go, Java y Rust, ≥ 3 repos cada uno | S1 |

### Criterio de B5 (fijado el 2026-10-12, antes de minar)

Un commit real entra en B5 si cumple todo esto. Ninguna regla usa graph-indexer: solo el diff, el texto y los tests.

1. **Fresco y enfocado.** Posterior al 2026-06-15, sin merges, con los filtros de asunto de `mine-fresh`. Modifica (sin crear ni borrar) entre 2 y 8 ficheros fuente y como mucho 16 ficheros en total, y trae tests. No crea ni borra otros ficheros Python, porque un módulo nuevo se filtraría o rompería la tarea.
2. **Onda.** Existe un nombre `N` (función, método o clase; no un método especial `__x__`) definido en la base en un fichero fuente A cuya línea de definición el commit cambia o borra. Además, otro fichero fuente B, que no es a su vez un fichero A, ya usaba `N` en la base y el commit cambia en B una línea que contiene `N`: una llamada, una importación o un método que lo sobrescribe.
3. **El arreglo parcial rompe algo.** El parche parcial es el del commit limitado a los ficheros que definen esos nombres. La regla se comprueba con los tests del commit aplicados, ejecutando todos los ficheros de test (sqlglot, networkx) o los de los paquetes de A y B (sympy):
   - el conjunto R, los tests que pasan con el arreglo completo y fallan con el parcial, no está vacío;
   - ningún test de R es un error de importación, porque un error de importación salta en cuanto se ejecuta cualquier test y no es silencioso.
4. **Validación.** Igual que en las tareas frescas: FAIL_TO_PASS no vacío (y como mucho 40 tests), se descartan los tests inestables, que se ejecutan dos veces, y los tests del commit tardan como mucho 180 s de tiempo de CPU. Después, `validate-fresh` comprueba con el propio calificador que la tarea se resuelve con el arreglo real tres veces de tres y que RIPPLE falla con el parcial.
5. **Aislamiento.** Todo el código de los repositorios se ejecuta en el sandbox de macOS (`bench/agentic/sandbox.sb`): sin red, sin escribir fuera del checkout y sin leer credenciales.
6. **Enunciado.** Describe el comportamiento que pide el commit. Nunca nombra B ni sus sitios: eso es lo que el agente tiene que descubrir.

Calificación:
- **Resuelta:** FAIL_TO_PASS y PASS_TO_PASS en verde, como en B3.
- **S4:** se cuentan aparte los tests de R que quedan rotos al final de la sesión. Son los errores silenciosos.

Se publican todos los candidatos y la regla que descartó cada uno.

Cambios sobre el texto fijado, todos del 2026-10-12, y su motivo:
- **Antes de ver resultados**, la exclusión de commits que crean o borran otros ficheros Python.
- **Después del primer minado de sqlglot**, se alinea el texto con lo que el minero ya hacía desde el principio: ficheros modificados, nada de métodos especiales, B distinto de A y el tope de 40 FAIL_TO_PASS. El límite de tiempo pasó de tiempo de reloj a tiempo de CPU porque la máquina se comparte con otros trabajos: dos candidatos de sympy se descartaron por lentitud con la máquina cargada, y se vuelven a juzgar con la regla nueva. Las tareas ya minadas se vuelven a validar dentro del sandbox.
- **xarray, mypy y pylint usan su propio entorno virtual** (`venv-b5`, con dask y los requisitos de test de mypy y pylint; solo wheels, instalados sin red dentro del sandbox). Los 6 candidatos de xarray se vuelven a juzgar en él: con el entorno compartido, sin dask, sus tests no podían ejecutarse, y eso decidía el veredicto. El cambio afecta a todos los candidatos por igual, no a los que se descartaron.
- **2026-10-13, después del segundo minado de xarray y pylint (0 tareas en ambos):** los veredictos "FAIL_TO_PASS 0" no medían lo que dicen. En xarray, el test nuevo del commit comprobado a mano (d0366c65) se saltaba por falta de flox; `venv-b5` recibe flox, con numpy_groupies y scipy, por el mismo procedimiento. En pylint los tests que cambia el commit son casos funcionales (`tests/functional/…`) que solo ejecuta `tests/test_functional.py`, y en mypy son ficheros `test-data/unit/*.test` que leen los módulos de `mypy/test/`. El minero no sabía traducirlos; ahora cada repositorio declara qué módulo lee cada fichero de datos, como ya hacía sqlglot con sus `.sql`. Los candidatos de xarray, pylint y mypy se vuelven a juzgar todos. Las tareas de sqlglot, sympy y sqlalchemy no cambian: sus ficheros de datos no son `.py`.
- **Lo que no se cambia aunque se haya visto:** la regla 3 deja entrar tareas cuyo arreglo parcial rompe cientos de tests (213 y 363 en dos de sqlglot), que en la práctica no son silenciosas. No se excluyen a posteriori. S4 se informa por tamaño de R (1–10, 11–100, >100) para que se vea.

Reglas de siempre:
- tareas reservadas para la ronda que decide;
- 3 ejecuciones por brazo cuando el efecto buscado sea menor de 15 puntos;
- Sonnet 5.5 en todas las sesiones;
- publicar con método, IC y derrotas.

## 5. Orden y calendario

| Semanas | Trabajo | Sale con |
|---|---|---|
| 0–1 | Cerrar B3: piloto `issue2`, documentarlo y publicarlo. Diseño y minado de B5. Selección de tests medida (§3.2) sobre las 50 tareas actuales | cifras de B3 publicadas; B5 con ≥ 10 tareas validadas |
| 1–3 | `check` con selección de tests medida y la opción de ejecutar; hook tras editar (§3.4); instrucciones mínimas | ronda B1 + B2 + B5 contra Claude Code solo (S2, S4, S6) |
| 3–6 | Cambios estructurales (§3.3); Python y Rust hacia S1 | ronda con los cambios estructurales; oráculos publicados |
| 6–8 | Arena completa con los cuatro brazos sobre B1, B2 y B5 (S3) | página de resultados; con S2 y S3 cumplidas se pasa al lanzamiento de [PLAN-REFERENCIA §4](PLAN-REFERENCIA.md#4-promoción-desde-la-semana-6-con-el-arena-publicado) |
| 8+ | Memoria entre sesiones (§3.5); más lenguajes a nivel 1 | piloto de memoria |

Si hay que recortar, se recorta §3.5 y después §3.3. Nunca §3.1, §3.2 ni el banco B5.

## 6. Riesgos

- **B5 diseñado a nuestro favor.** Las tareas se minan de commits reales con un criterio fijado antes de ver resultados. Los competidores se ejecutan con su instalación recomendada, y el criterio se publica con el banco.
- **Los modelos aprenden a no olvidar llamadores.** Se mide con cada versión del modelo. Si Claude Code solo deja de cometer errores silenciosos, S4 deja de importar y lo diremos.
- **Los cambios estructurales escriben algo mal.** Solo se aplican con referencias exactas, siempre pasan por `check` y devuelven el diff. Se lanzan solo si ganan medido.
- **El prefijo de herramientas encarece todo.** S5 lo vigila en cada ronda. Las herramientas que no ganan su sitio se quitan de la lista que se carga de entrada.
- **Capacidad.** El orden de §5 es el compromiso. Lo que no cabe se queda en el plan con su estado.
