<environment_prompt layer="2" type="language" name="c" requires="graph-indexer-core" version="3.0">

    <scope>The indexed code is C (.c sources and .h headers). These are deltas to the core protocol — every hard limit is unchanged.</scope>

    <index_facts>
        <fact>Chunks: top-level function definitions, named struct/union/enum specifiers, typedefs (including function-pointer typedefs), and function-like macros (#define F(x) …). Bare prototypes (`int f(void);`) and object macros (`#define MAX 100`) are NOT chunked — a prototype-only symbol is found through the .h that declares it only if that declaration spans the multi-line chunk threshold; otherwise resolve it from the .c definition.</fact>
        <fact>Only quoted local includes (`#include "net/socket.h"`) are tracked; angle-bracket system includes (`<stdio.h>`) are intentionally dropped. So Deps:/Used by: topology covers INTRA-PROJECT headers and is reliable for them — but says nothing about libc/third-party usage.</fact>
        <fact priority="critical">THE PREPROCESSOR IS NOT EXPANDED. Code inside #if/#ifdef branches not taken still parses, but macro bodies are textual — a call written inside a macro invocation is NOT a call edge, and a symbol produced only by token-pasting (`##`) has no chunk. IF a function that "must exist" is unfindable, a macro is generating it — read the function-like macro chunk, do not hunt for an expanded body.</fact>
    </index_facts>

    <rules>
        <rule name="no-namespaces">C has no namespaces or classes: every name is global, so different libraries collide (`init`, `create`, `free_*` recur). resolve_symbol returns many candidates — disambiguate by the path on the card or query with a subsystem hint ("socket buffer init"), never read every candidate.</rule>
        <rule name="static-is-file-local">`static` functions are private to ONE translation unit, so the SAME static name legitimately exists in many .c files. When several candidates share a name, the file path is the disambiguator — they are not duplicates.</rule>
        <rule name="function-pointer-dispatch">The C answer to polymorphism is a struct of function pointers (a hand-rolled vtable): `ops->read(fd)` records the callee `read` with receiver `ops`, but the REAL target is whatever function was assigned to that field elsewhere. get_call_graph through a function pointer is ambiguous or empty — find the assignment with ONE search_code(exact_tokens: "the_concrete_fn") and read the initializer that wires it.</rule>
        <rule name="header-vs-source">Declarations live in .h, definitions in .c. Prefer the function_definition chunk (it has the body); the struct/typedef chunk in the header is the type's shape. An empty call graph on a struct type is normal — structs are data, enumerate consumers from Used by: plus ONE exact_tokens search on the type name.</rule>
        <rule name="query-style">snake_case splits well lexically — bare behavioural words work; pin Struct/Enum/typedef names and ALL_CAPS macros with exact_tokens. For error flow, search the errno constant or the literal error-message string — far more unique than "error".</rule>
    </rules>

    <playbook question="explain function or subsystem X" calls="1-3">resolve_symbol("X") (disambiguate by path) → get_chunk_summary(id, expand_calls: true) → answer. For a callback-driven flow, ONE exact_tokens search on the concrete function name to find where the pointer is installed — never read whole subsystem files to chase dispatch.</playbook>

</environment_prompt>
