<environment_prompt layer="2" type="language" name="c" requires="graph-indexer-core" version="1.0">

    <scope>Indexed code is C (.c sources, .h headers). Deltas to core; hard limits unchanged.</scope>

    <index_facts>
        <fact>Chunks: function definitions, named struct/union/enum specifiers, typedefs (incl. function-pointer typedefs), function-like macros (#define F(x) …). Bare prototypes (`int f(void);`) and object macros (`#define MAX 100`) are NOT chunked — resolve a prototype-only symbol from its .c definition.</fact>
        <fact>Only quoted local includes (`#include "net/socket.h"`) are tracked; angle-bracket system includes are dropped. So Deps:/Used by: cover INTRA-PROJECT headers (reliable) but say nothing about libc/third-party.</fact>
        <fact priority="critical">THE PREPROCESSOR IS NOT EXPANDED. Macro bodies are textual — a call inside a macro invocation is NOT an edge, and a symbol produced only by token-pasting (`##`) has no chunk. If a function that "must exist" is unfindable, a macro is generating it — read the function-like macro chunk, don't hunt for an expanded body.</fact>
    </index_facts>

    <rules>
        <rule name="no-namespaces">No namespaces/classes: every name is global, so libraries collide (init, create, free_* recur). resolve_symbol returns many — disambiguate by card path or a subsystem hint ("socket buffer init").</rule>
        <rule name="static-is-file-local">`static` functions are private to ONE translation unit, so the same static name legitimately exists in many .c files — the path is the disambiguator, they are not duplicates.</rule>
        <rule name="function-pointer-dispatch">Polymorphism is a struct of function pointers (hand-rolled vtable): `ops->read(fd)` records callee `read` with receiver `ops`, but the REAL target is whatever was assigned to that field. get_call_graph through a pointer is ambiguous/empty — find the assignment with ONE search_code(exact_tokens: "the_concrete_fn") and read the initializer that wires it.</rule>
        <rule name="header-vs-source">Declarations in .h, definitions in .c. Prefer the function_definition chunk (has the body); the struct/typedef chunk in the header is the type's shape. Empty call graph on a struct type is normal — enumerate consumers from Used by: + ONE exact_tokens search on the type name.</rule>
        <rule name="query-style">snake_case splits well — bare behavioural words work; pin Struct/Enum/typedef names and ALL_CAPS macros with exact_tokens. For error flow, search the errno constant or the literal error message — far more unique than "error".</rule>
    </rules>

    <playbook question="explain function or subsystem X" calls="1-3">resolve_symbol("X") (disambiguate by path) → get_chunk_summary(id, expand_calls: true) → answer. Callback-driven flow: ONE exact_tokens search on the concrete function name to find where the pointer is installed — never read whole subsystem files to chase dispatch.</playbook>

</environment_prompt>
