# Replanteamiento de graph-indexer (noviembre de 2026)

Fecha: 2026-11-10 · Punto de partida: 3.1.0 (`6e5bcee`) · Complementa [PLAN-IDE-AGENTE.md](PLAN-IDE-AGENTE.md), que sigue siendo el plan activo. No lo sustituye: revisa si sus decisiones son las mejores posibles, dice dónde no lo eran y deja medido lo que se ha cambiado.

Todas las cifras de este documento salen de scripts de [`bench/`](../bench) y se pueden reproducir (§9). Donde una mejora vino de mirar los mismos datos con los que se mide, se dice.

## 0. Resumen

graph-indexer tiene bien elegida la tesis (hechos exactos de todo el repositorio y verificación, no búsqueda) y una cultura de medición poco habitual. La revisión encontró tres puntos ciegos, los tres en sitios donde nadie estaba midiendo:

1. **El índice que usa un agente no era el índice que se mide.** Todos los oráculos de compilador puntúan un índice recién construido. Un agente trabaja sobre un índice actualizado decenas de veces, y en 3.1.0 ese índice se apartaba del fresco: una llamada seguía ligada al método antiguo después de cambiar un tipo de retorno, o no se ligaba nunca si se escribía antes que su definición. Ahora un índice actualizado contiene los mismos hechos que uno fresco, y un banco nuevo lo comprueba reproduciendo historia real.
2. **`check`, la pieza central del plan, no se había medido donde importa.** Se sabía que no daba falsos avisos en 50 arreglos de Python. No se sabía cuánto detecta de un cambio a medias, ni cómo se porta fuera de Python. Medido en la partición de desarrollo: veía el 39 % de los cambios a medias y marcaba como rotos cambios terminados en JavaScript. Ahora ve el 57 % y los falsos avisos casi desaparecen.
3. **Un coste cuadrático escondido** hacía que indexar un paquete Go grande tardara 38 s en vez de 9.

Además se ha construido la pieza del plan que faltaba (§3.3, cambios estructurales): un renombrado sobre referencias exactas que resuelve solo, sin modelo, las 17 tareas de renombrado del banco de agentes.

Lo que **no** se ha hecho, y sigue siendo lo que decide si el producto gana: rondas con agentes reales. Nada de lo de aquí demuestra todavía que un agente resuelva más tareas o más baratas (§7).

## 1. Qué es y cómo se ha construido

Cinco meses, 254 commits en `main`, tres productos distintos con el mismo nombre:

| Etapa | Fechas | Qué era | Qué se aprendió |
|---|---|---|---|
| 1.x | junio 2026 | Un buscador híbrido para agentes: fragmentos por función, BM25 + embeddings (Ollama), enriquecimiento con LLM, reranker | La métrica inicial ("Recall@5 = 1,00") estaba inflada. Medido en estricto, lo semántico no sumaba sobre lo léxico. De aquí sale la regla de la casa: métricas honestas, partición reservada |
| 2.x | junio–julio | Lo mismo con 16 herramientas MCP, SCIP, análisis de taint, ColBERT, 22 ficheros de prompts por lenguaje y framework | Acumulación. En sesiones reales costaba el doble que no tener índice: herramientas y prompt añadían 11.300 tokens a cada llamada |
| 3.0 | septiembre | Reescritura: tree-sitter en WASM, SQLite, un resolvedor propio de ámbitos, imports y tipos, cero dependencias, 8 herramientas. Referencias medidas contra compiladores. Nace el banco de agentes (B1–B4) | Precisión 0,997 frente al compilador de TypeScript. En preguntas de código y refactors, 0,7–0,8 del coste de grep. En issues reales, ninguna ganancia |
| 3.1 | octubre–noviembre | Oráculos para Go, Java, Python y Rust; aristas que ningún compilador ve (rutas HTTP, inyección, ORM, componentes); arena contra CodeGraph, codebase-memory-mcp y Serena; cambio de tesis el 12 de octubre | El agente llega solo al código con grep. Lo que le cuesta es deducir hechos globales. De ahí "el IDE y la memoria del agente" |

El patrón que se repite, y que es la mayor fortaleza del proyecto: cada vez que una medición contradijo la intuición, ganó la medición. Se borró el canal semántico por defecto, se tiró la superficie de 16 herramientas, se dejó de afinar la localización de issues cuando los pilotos dieron 1,03–1,12.

## 2. El objetivo y cómo lo aborda

**Objetivo.** Que un agente de código resuelva más tareas, deje menos errores silenciosos y gaste menos, dándole calculado lo que a él le cuesta tokens y errores deducir: quién llama de verdad a esto, qué rompe este cambio, qué hereda, qué tests lo cubren, qué se ha roto al editar.

**Cómo.** Un índice local del repositorio (definiciones, referencias ligadas a su definición con una confianza declarada, imports, tipos inferidos), siempre al día con el árbol de trabajo, servido por MCP, CLI y hooks. Sin compilador, sin servidor de lenguaje, sin red, sin dependencias.

**Cómo se sabe si funciona.** Tres capas, de barata a cara:
- oráculos: las referencias frente al compilador o el comprobador de tipos de cada lenguaje;
- bancos sin modelo: búsqueda, localización en commits reales;
- sesiones de agente con tareas reservadas, estadística pareada e intervalos.

## 3. Revisión crítica, decisión por decisión

| Decisión | Veredicto | Por qué |
|---|---|---|
| Tesis: hechos globales y verificación, no búsqueda | **Acertada.** Mantener | La confirman los datos propios (B1 11/11 frente a 9/11; B3 sin ganancia) y lo publicado en 2026: grep es difícil de batir dentro del arnés de Claude Code, y las ganancias de los índices semánticos en producción son pequeñas |
| Resolvedor heurístico propio en vez de compiladores o LSP | **Acertada, con una condición.** | Da instalación cero y 16 lenguajes, y está a 0,96–1,00 de precisión frente a los compiladores. La condición era que "exacto" se cumpliera también después de editar, y no se cumplía (§4.1) |
| Índice incremental con re-resolución "dirigida" | **Era el eslabón débil.** Rehecho | Tres reglas a mano (ficheros tocados, símbolos desaparecidos, nombres nuevos) no cubren un tipo de retorno que cambia, una clase base, un re-export, un `tsconfig`. Y las referencias sin destino se borraban, así que una definición escrita después de su uso no las recuperaba nunca |
| `check` como producto central | **Acertada, pero sin instrumento.** | Era la apuesta del plan y no tenía un banco propio. Sin él no se veían ni sus huecos ni sus falsos avisos (§4.2) |
| Aridad estricta en todos los lenguajes | **Errónea para JavaScript.** Corregida | En JavaScript pasar menos argumentos es legal. `check` lo daba por roto |
| "Eliminado pero aún en uso" por coincidencia de nombre | **Errónea.** Sustituida | Un `map` eliminado reclamaba todos los `.map()` del repositorio; un tipo renombrado en Go no se detectaba. Ahora se liga, como en `find_references` |
| Herramientas de solo lectura | **Mantener en MCP.** | El renombrado escribe solo desde la línea de órdenes. Exponerlo en MCP es una decisión de producto pendiente (§7) |
| Búsqueda léxica + grafo, semántica opcional | **Acertada.** | Medido varias veces. No tocar |
| SQLite, un fichero, sin servicio | **Acertada.** | El coste está en otro sitio: en Twenty el índice ocupa 335 MB, casi todo texto para búsqueda (§7) |
| Medir todo contra oráculos en índices frescos | **Incompleta.** | Faltaba el eje "después de editar". Añadido como banco y como tests |

## 4. Los tres puntos ciegos

### 4.1 El índice actualizado no era el índice fresco

**El fallo.** Tras una edición, 3.1.0 volvía a resolver las referencias del fichero tocado, las que apuntaban a símbolos desaparecidos y las que tenían el nombre de un símbolo nuevo (si estaban sin ligar). Todo lo demás se quedaba como estaba. Casos reales que eso deja mal, cada uno ahora un test (`test/incremental.test.mjs`):

| Edición | Qué respondía 3.1.0 |
|---|---|
| `make(): Foo` pasa a `make(): Bar` | `make().run()` en otro fichero sigue ligado a `Foo.run`. `find_references Bar.run` no lo lista; `Foo.run` lo lista sin serlo |
| `class X extends A` pasa a `extends B` | `x.hello()` sigue en `A.hello` |
| Un barrel re-exporta desde otro módulo | Sus importadores siguen en el módulo viejo |
| Se escribe la llamada y después el fichero que define la función | El import no se resuelve nunca; la llamada queda sin ligar hasta reindexar |
| Se usa un tipo o una constante antes de declararlos | La referencia se había borrado; no vuelve |
| Cambia un alias de `tsconfig.json` | Nada se mueve: ningún fichero fuente cambió |
| Se borra el último fichero de un paquete Go | Los imports siguen apuntando al directorio vacío |
| Se borra un fichero y se vuelve a escribir (cambio de rama) | Sus importadores se quedan sin ligar |

De los 32 tests de este tipo, 3.1.0 falla 26. Y reproduciendo historia real por la ruta de actualización (870 commits de nueve repositorios), 3.1.0 deja el índice distinto del fresco tras 8 commits si cada commit llega de una vez, y tras 25 o 30 si sus ficheros llegan de uno en uno, que es como edita un agente: entre 580 y 772 referencias mal ligadas, sin ligar o de más.

**Por qué no se había visto.** Los oráculos, que son el orgullo del proyecto, construyen un índice y lo puntúan. El caso de uso real (editar, preguntar, editar) no pasaba por ninguna medición. El README decía "las respuestas nunca están obsoletas", y era cierto para los números de línea, no para los enlaces.

**La solución.** No más reglas a mano. Tres piezas:

1. **La resolución apunta lo que lee.** Mientras se resuelven las referencias de un fichero, cada pregunta al resto del repositorio queda registrada: las definiciones de un nombre (existan o no), los imports de otro fichero, los campos inferidos de un tipo, si existe una ruta, el mapa de módulos. Los propios mapas de la tabla de símbolos registran sus lecturas, así que una regla nueva en el resolvedor queda cubierta sin tener que acordarse. Cada fichero guarda ese conjunto como hashes de 32 bits (en Twenty, 29 claves por fichero de media, 3,7 MB en total).
2. **Un cambio emite lo que altera.** Al reescribir un fichero se compara lo que los demás podían leer de él antes y después: por definición, una firma de todo salvo su posición, y su longitud; sus imports; sus tipos de campo. Solo se vuelven a resolver los ficheros cuyas lecturas tocan lo emitido. Editar un cuerpo sin cambiar firmas no alcanza a ningún otro fichero.
3. **Nada depende del orden.** Las listas de la tabla están en un orden canónico (ruta, posición), los empates se rompen por ese orden, y las referencias sin destino se guardan aparte (`refs_unbound`) en vez de borrarse.

**Resultado.** Sobre los mismos 870 commits, en los tres modos (2.610 reproducciones): ninguna diferencia, ni en símbolos, ni en imports, ni en una sola referencia. Una actualización vuelve a resolver de media entre 10 y 15 ficheros más; la peor, 957. Avanzar un commit cuesta lo mismo que antes (unos 100–170 ms frente a 1 s de reconstruir). El índice fresco es idéntico hecho a hecho al de 3.1.0 en 19 de 23 repositorios (incluido Twenty, 853.426 hechos; en Commons Collections cambian 8 referencias sin mover la nota frente a javac) (los tres de Go ganan referencias por otra mejora, §5), así que ningún oráculo cambia. Coste: +5 % de CPU en el indexado en frío de nestjs, +2–7 % de tamaño.

### 4.2 `check` no se había medido donde importa

**El banco que faltaba** (`bench/eval-check.mjs`). La historia real tiene la respuesta: un commit que cambió la línea de definición de un nombre en un fichero A y, a la vez, una línea que lo usa en otro fichero B, enseña dónde tuvo que seguir el cambio un desarrollador. Aplicar solo la parte de A al commit padre es el cambio a medias; las líneas de B son lo que `check` debería señalar. Y el commit entero es el control: lo que `check` marque ahí como roto es un falso aviso. Las reglas salen solo de git, como las de B5.

**Lo que enseñó sobre 3.1.0** (partición de desarrollo: gin, axios, nestjs, sqlglot; 56 commits, 103 ondas):
- veía el 39 % de las ondas (40 de 103);
- en axios, **el cambio terminado del desarrollador salía con problemas en 7 de 7 commits** (97 avisos): `merge(a, b)` con una función que ahora declara tres parámetros, legal en JavaScript; un `map` eliminado que reclamaba todos los `.map()`;
- en Go no veía un tipo renombrado que otro fichero del paquete seguía usando: las referencias de tipo sin destino se borraban al indexar;
- un método eliminado de una clase no se relacionaba con la interfaz que lo sigue declarando.

**Lo que se cambió.**
- **"Eliminado pero en uso" se liga, no se adivina.** La definición que ya no está se vuelve a poner en la tabla de símbolos tal como era, se resuelven otra vez las referencias sin destino que llevan su nombre, y las que se ligan a ella son sus usos. Es `find_references` sobre lo que ya no existe: encuentra tipos, constantes y atributos igual que llamadas, y no confunde otra definición del mismo nombre. Solo es posible porque las referencias sin destino ahora se conservan (§4.1).
- **Lo dudoso se dice como dudoso.** Los usos que solo el nombre relaciona pasan de "✗ problema" a "• posible".
- **Aridad según el lenguaje.** En JavaScript una cuenta distinta se lista para revisar; en TypeScript, Python, Go o Java sigue siendo un problema.
- **Python: palabras clave.** Una llamada que pasa `pretty=` a una función que ya no lo acepta.
- **La familia del método.** Si un método cambia o desaparece, las declaraciones en supertipos y las sobrescrituras en subtipos que siguen como estaban.
- **Firmas que cambian sin cambiar de aridad** (otro tipo de retorno, un parámetro renombrado): se listan sus llamadores en ficheros no tocados.
- Cuatro falsos avisos concretos: un cambio de clase de símbolo no es una eliminación (`function` a `class`, `type` a `interface`); un nombre que el fichero sigue ligando por import o desestructuración tampoco; `Base.metodo(self, x)` pasa `self` a mano; el polyfill de un nombre de la plataforma, al quitarse, deja paso al de la plataforma.

**Resultado.** Las particiones se fijaron antes de mirar nada; la reservada se ejecutó una vez, con el código congelado.

| Partición | Versión | Ondas vistas | Cambios terminados marcados con problemas |
|---|---|---|---|
| Desarrollo (56 commits, 103 ondas) | 3.1.0 | 40 (39 %) | 12 commits, 122 avisos |
| | ahora | 59 (57 %) | 1 commit, 6 avisos (un fallo real que el desarrollador dejó en un test) |
| Reservada (120 commits, 288 ondas, 10 repositorios) | 3.1.0 | 159 (55 %) | 18 commits, 147 avisos |
| | ahora | 177 (61 %) | 6 commits, 6 avisos |

Lo que hay que leer con cuidado: la ganancia en detección de la partición reservada es un tercio de la de desarrollo (6 puntos frente a 18). Casi todo lo que se arregló se encontró en JavaScript y TypeScript, y la reservada es sobre todo Python, donde 3.1.0 ya iba mejor. Lo que sí se traslada entero es la otra columna: los falsos avisos. De los 6 que quedan en la reservada, 3 eran dos errores sencillos que se corrigieron después sin volver a medir (uno de ellos lo había introducido este mismo trabajo). El coste en lectura es pequeño: la respuesta crece de 1.445 a 1.583 caracteres por cambio a medias en desarrollo.

### 4.3 Un coste cuadrático escondido

Al perfilar por qué nats-server (233 ficheros) tardaba 38 s en indexarse cuando sqlglot (266) tardaba 5: por cada referencia se recorrían todos los símbolos del fichero, o de todos los ficheros del paquete, para filtrar por nombre. En un paquete Go de 233 ficheros es cuadrático. Con un índice por nombre dentro de cada fichero el resultado es el mismo, en el mismo orden: 38,3 s → 8,8 s de CPU. En sqlglot, 4,9 → 4,2.

### 4.4 Lo que encontró una revisión independiente

Con todo medido, una lectura independiente del código (otro modelo, sin mis conclusiones) encontró fallos que los bancos no podían enseñar, y conviene decirlo porque marca el límite del método:

- **Un caso que la historia real no contiene.** Dos definiciones del mismo nombre que intercambian su posición dentro de un fichero cambiaban cuál es "la primera candidata" para una llamada de otro fichero, sin invalidar nada. Reproducir commits ejercita las ediciones que hacen los desarrolladores, no todas las posibles.
- **Dos fallos del renombrado en definiciones de nivel superior**, que las tareas del banco (todas de métodos) no tocan: reescribía también la ruta del import (`'./parse'` pasaba a `'./parseText'`) y no veía que el nombre nuevo ya estuviera ocupado en un fichero que usa la definición.
- Un manifiesto editado con el índice cerrado no se notaba hasta el siguiente barrido completo, y una actualización fallida dejaba la tabla en memoria por delante de la base de datos.

Todo corregido y con test. Después, una reproducción de confirmación (1.155 commits) volvió a dar cero diferencias y el renombrado, 17 de 17. La lección para el plan: los bancos dicen cuánto falla lo que ejercitan; para lo que no ejercitan hace falta leer el código con otros ojos, y merece ser un paso fijo antes de cada versión.

## 5. Lo que cambia en esta pasada

| Cambio | Medido con | Antes (3.1.0) | Ahora |
|---|---|---|---|
| Índice actualizado = índice fresco | `eval-incremental.mjs`, 870 commits × 3 modos | 8, 25 y 30 commits divergentes (580–772 referencias) | 0, 0 y 0 |
| | tests de edición (`test/incremental.test.mjs`) | fallan 26 de los 32 primeros | pasan los 35 |
| `check`: cambios a medias vistos (desarrollo) | `eval-check.mjs` | 40 de 103 ondas (39 %) | 59 de 103 (57 %) |
| `check`: cambios terminados marcados con problemas (desarrollo) | | 12 de 56 commits (122 avisos) | 1 de 56 (6 avisos, y es un fallo real que el desarrollador dejó en un test) |
| `check`: tamaño de la respuesta (desarrollo) | | 1.445 caracteres por cambio a medias, 1.669 por terminado | 1.583 y 1.744 |
| `check` en la partición reservada (una sola ejecución, código congelado) | | 159 de 288 ondas (55 %); 18 de 120 commits terminados con problemas (147 avisos) | 177 de 288 (61 %); 6 de 120 (6 avisos) |
| Renombrado estructural | `eval-rename.mjs`, 17 tareas con corrector de compilador | no existía | 15 de 17 a la primera; 17 de 17 tras cerrar un hueco de Go |
| Go: ámbitos de bloque y tablas de tests | oráculo `go/types`, conjuntos exactos | gin 0,986 · caddy 0,934 · nats-server 0,935 | 0,993 · 0,964 · 0,945 (precisión igual) |
| Indexado en frío, paquete Go grande | CPU, un hilo, alternando versiones | nats-server 38,3 s | 8,8 s |
| Indexado en frío, resto | | nestjs 3,45 s · fastapi 2,96 s · sqlglot 4,90 s | 3,63 s · 3,15 s · 4,23 s |

El renombrado merece una nota. Hace lo que hace un IDE: la definición, su familia (lo que sobrescribe y lo que la sobrescribe, a través de todos los tipos intermedios), las referencias ligadas con confianza exacta y los imports que la nombran. Lo que no puede ligar lo lista y no lo toca. En las 11 tareas de nestjs y las 4 de Twenty acertó a la primera, en 0,05–2,7 s. Falló las 2 de caddy por el mismo hueco del motor: las tablas de casos de los tests de Go (`for _, tc := range []struct{…}{…}`) no tenían tipo. Cerrado el hueco y verificado con el oráculo, pasan las dos; esas dos tareas ya no son inéditas.

## 6. El estado del arte fuera, y dónde queda graph-indexer

Lo relevante de 2026, con sus fuentes y con lo que no se pudo verificar, está en [research/notes/state_of_the_art_2026-11.md](research/notes/state_of_the_art_2026-11.md). Varias cifras son de proveedor y se tratan como tales. En resumen:

- **Los agentes ya traen LSP.** Claude Code tiene una herramienta LSP propia que, con un plugin y el servidor instalados, da definiciones, referencias y **diagnósticos tras cada edición**. Copilot hace lo mismo en CLI y VS Code, con renombrado incluido. JetBrains expone sus refactors por MCP. Serena sigue ese camino.
- **Pero el LSP no se usa solo, y a veces estorba.** Los trabajos que lo miden encuentran que los agentes siguen yendo a grep, que una lista de posiciones sin código provoca más lecturas, y que forzar la navegación semántica baja el éxito.
- **Los competidores de grafo con tree-sitter** (CodeGraph, codebase-memory-mcp) publican ahorros de tokens, no exactitud. En nuestra arena quedan en 0,56–0,93 de precisión.
- **stack-graphs está archivado.** SCIP sigue vivo como formato.
- **Nadie mide errores silenciosos ni cambios a medias.** Es un hueco en la literatura. B5 y `eval-check` son, hasta donde hemos encontrado, los únicos bancos que lo intentan.

Dónde queda: graph-indexer es la opción que funciona **sin instalar nada y sin compilar**, en 16 lenguajes, y la única que publica su exactitud contra compiladores. Frente al LSP nativo no compite en "errores de tipo tras editar" donde haya servidor; sí aporta lo que el LSP no da en una llamada: qué usos dejaste atrás al quitar o renombrar algo, qué familia de métodos queda incoherente, qué tests ejecutar. Y funciona donde no hay servidor: sesiones en la nube, repositorios políglotas, máquinas de CI.

## 7. Lo que queda

Por orden de valor esperado. Los tres primeros necesitan sesiones de agente, es decir, cuota y tu visto bueno.

1. **Una ronda B1 + B2 + B5 con esta versión.** Es lo único que dice si lo de aquí llega al agente. Hipótesis a contrastar: con `check` más fiable y más silencioso en JavaScript, el hook tras editar deja de costar (era 1,07) y B5 muestra menos errores silenciosos.
2. **Un brazo "Claude Code + LSP nativo" en la arena.** Hoy es el competidor real y no está medido.
3. **Renombrado en sesiones.** Resuelve las tareas solo; falta saber si el agente lo llama y si le ahorra. Solo entonces decidir si se lista en MCP (rompe "todas las herramientas son de solo lectura").
4. **`check`: lo que sigue sin ver.** En desarrollo se escapa el 43 % de las ondas. Lo que más pesa: cambios de significado sin cambio de firma, ficheros de declaraciones (`.d.ts`) y usos a través de valores sin tipo. Parte es indetectable sin ejecutar; el banco ya dice cuánto.
5. **Selección de tests.** Sigue en 86–94 % de los ficheros afectados; el objetivo es 99 %. No se ha tocado.
6. **Tamaño y arranque en monorepos.** Twenty: 60 s de indexado en frío y 335 MB. Crear un fichero cuesta 0,8 s porque se vuelven a resolver los 178.000 imports; renombrar el símbolo más usado, 4,2 s (4.561 ficheros dependientes). Es correcto y acotado, pero hay margen.
7. **Ámbitos de bloque en C#, Kotlin y C/C++.** En TypeScript y Java se probó y no movió nada; en Go sí. Falta medirlo donde hay oráculo que construir.
8. **B5 hasta 30 tareas, y memoria entre sesiones.** Sin cambios respecto al plan.

**Decisiones que son tuyas:**
- si se lanza la ronda de agentes (1–3) y con qué presupuesto;
- si `rename` se expone por MCP cuando esté medido (decidido el 2026-11-15: se expone ya, §8.5);
- si esto sale como 3.2.0 (cambia el esquema del índice: se reconstruye solo al actualizar;
  decidido el 2026-11-15: sí, §8.5).

## 8. Segunda pasada (2026-11-15)

Cinco días después se volvió sobre lo anterior con una regla: no dar nada por bueno porque los
bancos estuvieran en verde. Tres cosas a la vez: dos lecturas independientes del código (otro
modelo, sin las conclusiones de este documento; §4.4 decía que merecía ser un paso fijo), los
oráculos de compilador otra vez, lenguaje por lenguaje, y una medición sobre repositorios que
nadie había mirado. El trabajo siguió en `sota/next`, sobre 3.1.1 (con sus correcciones de
seguridad), y sale como 3.2.0 (§8.5).

### 8.1 Un cuarto punto ciego: lo que no se indexaba

Al mirar por qué `check` no veía una interfaz eliminada en nestjs apareció la causa, y no estaba
en `check`: el fichero vivía en un directorio llamado `external/`, y graph-indexer se saltaba por
nombre `bin`, `build`, `external`, `env`, `target`, `deps`, `out`, `obj` y `coverage`, sin opción
para cambiarlo. Esos nombres son salida de compilación en un proyecto y código fuente en otro. En
10 de los 43 repositorios que hay en esta máquina eso dejaba fuera 216 ficheros escritos por los
propios proyectos: 105 de Twenty (`cli/utilities/build`), 36 de sympy (`bin/`, `sympy/external`),
17 de nestjs, el `lib/env` de axios, el `bin/` de graph-indexer. Con la regla nueva no sale
ninguno de los que ya se indexaban, y la copia de googletest que mypy guarda en `mypyc/external/`
sigue fuera. Una función llamada solo desde `bin/` salía con
cero llamadores: justo el "cero falso" que la puerta S1 prohíbe, y ningún oráculo podía verlo
porque los oráculos puntúan lo que se indexa.

La regla nueva usa lo que git sabe: un directorio con uno de esos nombres solo se salta si git
no tiene código versionado dentro (lo que escribe una compilación está ignorado o sin versionar);
dentro de uno, una copia de otro proyecto (`deps/hiredis/`, con su fichero de licencia) sigue
fuera. `node_modules`, `vendor`, `third_party` y `dist` se saltan como antes. Es un cambio de
comportamiento visible (se indexa más), por eso se dice aquí y en el CHANGELOG.

### 8.2 Lo que encontraron las dos lecturas independientes

**En `check` y `rename`** (13 fallos reproducidos):

- `rename --write` con el índice atrasado **renombraba la llamada de otra clase y decía que todo
  había ido bien**: leía las posiciones antes de poner el índice al día. Era el fallo más grave de
  toda la rama, en la única orden que escribe.
- `rename` dejaba código roto en casos corrientes (la etiqueta de cierre de JSX, `@x.setter`, el
  `export { x }` del propio fichero, una propiedad abreviada `{ x }`), no veía conflictos con un
  miembro heredado ni con una variable local, y si un fichero era de solo lectura dejaba el
  renombrado a medias.
- `check` no decía nada al **borrar o mover un fichero que otros importan**, ni al quitar una
  función cuando otro fichero declara una del mismo nombre, ni en ficheros con espacios o tildes
  en la ruta; y daba por roto un cambio correcto bajo decoradores que aportan argumentos (click).

**En el índice incremental** (8 fallos): dos llamadas de herramienta a la vez lanzaban dos
actualizaciones simultáneas (una podía fallar y dejar referencias colgando); una actualización
fallida a medias dejaba imports apuntando a un fichero borrado para siempre; un segundo proceso
escribiendo la misma base (el hook) dejaba al residente contestando de memoria; y el tipo de un
receptor se recordaba por fichero, así que la respuesta dependía de qué referencia se resolvía
primero. Además, dos casos de trabajo inútil: reescribir un fichero solo en su directorio volvía
a resolver todo un repositorio Java, y un documento nuevo, todo uno de Rust.

Todo está corregido y con test (cada test se comprobó que falla en el código anterior). En el
banco de `check` el efecto es pequeño en detección (61 de 103 ondas en desarrollo, antes 59; 178
de 288 en la partición reservada, antes 177) y claro en lo que más importa: los cambios terminados
que `check` daba por rotos en la reservada bajan de 6 a 2 de 120 commits. `rename` sigue
resolviendo las 17 tareas de 17.

Y la reproducción de historia (840 commits de siete repositorios, en los tres modos) encontró a
su vez dos fallos, los dos solo en el modo de ficheros en orden inverso. El primero, introducido
en esta misma pasada: un fichero escrito mientras `.gitignore` aún lo ignoraba no volvía a
mirarse cuando la regla desaparecía (axios `7a2f901`). El segundo salió al repetir la
reproducción con ese arreglo (spring `a50bfb65bb`): un renombrado que solo cambia mayúsculas
(`readme.md` → `README.md`), en un sistema de ficheros que no las distingue, quedaba con el
nombre que aún guarda git en el barrido completo y con el del disco en la actualización de esa
ruta; la discrepancia existía de antes y el arreglo anterior la dejó a la vista. Ahora el nombre
es siempre el del disco, y `check` avisa de los imports que siguen usando el viejo. Repetida
entera sobre el código final, en los tres modos, no deja ninguna diferencia. Tres veces en un
día una medición que no se había afinado (el repositorio reservado de Rust y esta, dos veces) ha
detenido un fallo que los tests y los oráculos de desarrollo daban por bueno.

El precio: indexar en frío cuesta entre un 5 y un 14 % más de CPU que antes de la pasada (nestjs
3,10 → 3,39 s; sqlglot 3,69 → 4,20 s), sobre todo por recordar el tipo de un receptor por
definición y no por fichero, que es lo que hace que la respuesta no dependa del orden. Ninguno
de estos 21 fallos lo habría enseñado un banco: 870 commits reproducidos no contienen dos
procesos, ni un disco que falla, ni un `git mv`. La lección de §4.4 se confirma con creces.

### 8.3 Los oráculos, otra vez

Precisión / cobertura / conjuntos exactos, mismas muestras, ningún repositorio de ningún
lenguaje empeora (tablas y reglas en [BENCHMARKS.md](BENCHMARKS.md)):

| Lenguaje | Repositorio | Antes | Ahora |
|---|---|---|---|
| Java (javac) | commons-collections | 0,961 / 0,883 / 0,825 | 0,991 / 0,904 / 0,885 |
| | jsoup | 0,992 / 0,943 / 0,846 | 0,996 / 0,965 / 0,899 |
| | spring-petclinic | 0,994 / 0,989 / 0,973 | 1,000 / 0,995 / 0,991 |
| Python (pyright) | flask | 0,895 / 0,927 / 0,753 | 0,961 / 0,976 / 0,853 |
| | requests | 0,954 / 0,987 / 0,886 | 0,954 / 0,993 / 0,913 |
| | httpx | 0,998 / 0,950 / 0,800 | 0,999 / 0,970 / 0,873 |
| | click | 0,971 / 0,980 / 0,917 | 0,994 / 0,980 / 0,931 |
| | rich (reservado) | 0,992 / 0,974 / 0,861 | 0,992 / 0,979 / 0,896 |
| Rust (rust-analyzer) | tokio | 0,981 / 0,838 / 0,747 | 0,990 / 0,906 / 0,813 |
| | serde_json | 0,974 / 0,947 / 0,899 | 0,993 / 0,947 / 0,920 |
| | ripgrep | 0,990 / 0,944 / 0,912 | 0,990 / 0,948 / 0,919 |
| TypeScript, Go | (los seis) | sin cambio | sin cambio |

Estado de la puerta S1 (precisión ≥ 0,99 y cobertura ≥ 0,95): la cumplen TypeScript, Go, y ahora
jsoup y petclinic; commons-collections cumple la precisión y su cobertura (0,904) está limitada
por una discrepancia conocida del oráculo (las llamadas `super.m()`, 65 de sus 69 líneas no
encontradas; sin ella sería 0,993). En Python cumplen fastapi, httpx, rich y click; flask y
requests se quedan en 0,961 y 0,954 de precisión, y parte de lo que falta es del oráculo: pyright
no mira `examples/` en flask, y en requests rechaza `requests.cookies.X` tras un simple `import
requests`, que Python ejecuta sin problema. Ahí se eligió a propósito seguir a Python y no al
oráculo: con la regla de pyright requests subía a 0,975, pero se perdían usos reales y `check`
dejaba de ver un llamador de sqlglot que antes veía. Rust no entra en S1, pero los tres repositorios quedan en
precisión ≥ 0,99.

**Sobre repositorios que nadie había mirado** (muestra congelada, una sola ejecución de la
versión anterior y de esta):

| Repositorio | Antes | Ahora |
|---|---|---|
| gson (Java) | 0,939 / 0,983 / 0,905 | 0,991 / 0,987 / 0,940 |
| urllib3 (Python) | 0,966 / 0,975 / 0,780 | 0,966 / 0,980 / 0,827 |
| arrayvec (Rust) | 0,960 / 0,751 / 0,673 | 0,964 / 0,759 / 0,700 |

Java se traslada entero. Python y Rust, en la dirección y con una fracción del tamaño: lo que se
arregló en ellos eran sobre todo giros propios de los repositorios de desarrollo.

**Y un fallo de esta misma pasada, que encontró la medición reservada.** El primer repositorio de
Rust medido así fue bytes, y dio 0,666 / 0,844 antes y 0,904 / 0,732 después: 24 puntos más de
precisión y **11 menos de cobertura**. bytes tiene cuatro `impl From<…> for Bytes`; antes cada
`Bytes::from(x)` se ligaba a una de las cuatro (acierto para esa, error para las otras tres), y la
regla nueva, tal como se escribió primero, no ligaba ninguna. Ninguna de las dos respuestas es
buena. Por eso se añadió lo que faltaba: las llamadas de Rust guardan ahora el tipo que enseñan
sus argumentos, como las de Java, y se elige la implementación que lo acepta. bytes queda en
0,939 / 0,859 / 0,673 y los tres repositorios de desarrollo no se mueven. bytes dejó de ser
inédito en ese momento, y arrayvec se clonó después para ocupar su sitio. Sin la medición
reservada, esta regresión habría salido publicada con todos los oráculos en verde.

### 8.4 Lo que queda, actualizado

Sigue en pie §7. Cambia esto:

- **Rust: lo que aún no se elige entre `impl` de un mismo rasgo:** el tipo de una constante
  pasada como argumento, el de una variable local que sale del resultado de un método, y las
  implementaciones cuyo parámetro es genérico (`impl Extend<u8>` y `Extend<&u8>`).
- **Python: fixtures de pytest.** El parámetro de un test se resuelve por nombre a la función
  `@pytest.fixture` y su tipo de retorno. El oráculo (pyright) no ve fixtures y no puede
  confirmarlo; se mediría con sesiones o con un oráculo propio.
- **Otra edición estructural: añadir un parámetro y actualizar sus llamadas.** Hay 19 tareas en
  B2 corregidas por el compilador para medirla sin modelo, como se hizo con `rename`. No se ha
  construido en esta pasada: tras ver lo que una lectura independiente encontró en `rename`, una
  orden que escribe no se añade sin su propia revisión.
- **Go: las implementaciones implícitas se recalculan enteras en cada edición** de un fichero Go
  (160–217 ms en un repositorio sintético de 60 paquetes). Correcto, pero con margen.
- De las tres decisiones de §7 queda una: las rondas con agentes (§8.5).

### 8.5 Lo que se decidió: 3.2.0, con `rename` por MCP

El 2026-11-15 se decidió publicar todo lo anterior como 3.2.0 y exponer el renombrado por MCP sin
esperar a medirlo en sesiones. Queda así:

- `rename_symbol` es la única herramienta que no es de solo lectura, y se declara como tal
  (`readOnlyHint: false`, `destructiveHint: true`) para que el cliente pida permiso. Sin
  `apply: true` lista las ediciones y no toca nada; solo el booleano `true` escribe.
  `graph-indexer serve --read-only` (o `GRAPH_INDEXER_READ_ONLY=1`) arranca un servidor en el
  que solo las lista. Escribe con las mismas garantías que la orden de línea de comandos: todos
  los ficheros o ninguno, solo ficheros regulares del índice dentro del repositorio.
- Antes de publicar, una lectura independiente más, de lo que escribe y de lo cambiado en el
  descubrimiento y la actualización desde la anterior (§4.4 y §8.2 dicen por qué es un paso fijo).
  Encontró lo que ningún banco veía, y otra vez justifica el paso:
  - en `rename_symbol`, dos agujeros: un enlace plantado en el nombre previsible del fichero
    temporal hacía escribir fuera del repositorio, y un servidor `--read-only` seguía escribiendo
    para una orden de línea de comandos que le llegaba por su socket local. Además, cinco
    defectos de corrección: bytes que no son UTF-8 se corrompían en líneas no tocadas, un método
    de trait de Rust no arrastraba sus `impl`, usos que no son llamadas (`I.total` como valor,
    `k::send`) no se editaban ni se listaban, no veía un nombre ocupado en otro fichero del mismo
    paquete Go o Java, y aceptaba un builtin que el fichero ya usa (`len`);
  - en `check` y la actualización, dos graves: `check` no veía nada si el directorio indexado es
    un subdirectorio del árbol de git, ni con `diff.noprefix`/`diff.mnemonicPrefix` en la
    configuración del usuario. Además, ocho divergencias de la actualización frente a un índice
    fresco: repositorios anidados, rutas tras un enlace, nombres Unicode descompuestos, un
    fichero que pasa del límite de tamaño, rutas mal escritas, entre otras.
  Cada uno de esos tiene ahora una prueba que falla con el código anterior. Quedan anotados, sin
  corregir, dos casos fuera de git y uno con `git add` en un directorio de salida (CHANGELOG).
  Una tercera lectura, solo de esas correcciones, encontró que introducían falsos rechazos
  (los métodos de Go se trataban como nombres del paquete) y ruido (`params.get(…)` listado como
  mención), y huecos menores en lo corregido; corregidos también, con su prueba.
- Al pasar las pruebas con Node.js 26 apareció un fallo que ya tenía 3.1.1: tras escribir en las
  tablas de texto completo, SQLite puede dar como último rowid uno interno de FTS5, mayor que 2^53,
  y el `node:sqlite` de Node 26 lanza donde 22 y 24 redondean. El CI no probaba Node 26; ahora sí.
- Node.js 22.23.5+, 24.22.3+ o 26.13.1+: las versiones de seguridad del 11 de noviembre
  (CVE-2026-123864 y otras), como 3.1.1 hizo con las de octubre.
- La gramática de PHP pasa a tree-sitter-php 0.25.1 (misma extracción en 1.104 ficheros de
  Laravel y Symfony); el resto está en su última versión salvo Scala, que publica correcciones a
  diario estos días y se queda en 0.26.2. No hay dependencias de npm ni alertas abiertas.
- **Lo que sigue sin medirse:** si un agente llama a `rename_symbol` y si le ahorra. La línea
  que lo nombra en las instrucciones que escribe `init` tampoco se ha medido. Es lo primero que
  debería decir la próxima ronda B2.

## 9. Reproducir

```bash
node bench/fixtures.mjs --history 400

# un índice actualizado frente a uno fresco, sobre historia real
node bench/eval-incremental.mjs --fixtures gin,express-js,fastapi,axios,rust,spring --n 120 --mode commit
node bench/eval-incremental.mjs --fixtures gin,express-js,fastapi,axios,rust,spring --n 120 --mode file --order reverse

# check sobre cambios a medias (y sobre el cambio terminado, como control)
node bench/eval-check.mjs --repos gin,axios,nestjs --n 40 --verbose

# el renombrado, solo, sobre las tareas de B2 (necesita typescript y, para caddy, Go)
node bench/eval-rename.mjs

# los oráculos de Go
node bench/eval-graph-go.mjs --n 150
```

Detalle y tablas completas en [BENCHMARKS.md](BENCHMARKS.md).
