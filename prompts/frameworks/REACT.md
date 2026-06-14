<environment_prompt layer="2" type="framework" name="react" requires="graph-indexer-core, javascript-typescript" version="3.0">

    <scope>The codebase uses React (JSX/TSX components, hooks). Loads AFTER the javascript-typescript layer; all of its rules and every hard limit still apply.</scope>

    <critical_fact>JSX tags are NOT call expressions: `&lt;MyComponent /&gt;` is a JSXElement, so get_call_graph("MyComponent") NEVER lists render sites and an empty call graph NEVER means a component is unused. Render sites come from `Used by:` (import topology — reliable in JS/TS) or ONE exact_tokens search on the component name.</critical_fact>

    <rules>
        <rule name="hooks-are-calls">Hook invocations ARE ordinary calls: get_call_graph("useAuth") reliably lists every component using that hook. The graph is trustworthy for hooks even though it is blind to JSX. A custom hook's contract is its return value — summary + Calls: line usually answers "what does this hook do" without the body.</rule>
        <rule name="runtime-flow-invisible">State setter → re-render → effect firing is a runtime property no index sees. Answer ordering/timing questions from ONE get_chunk of the component, reasoning over hook semantics — never search for the render loop.</rule>
        <rule name="wrappers">memo(...), forwardRef(...), and HOCs export the WRAPPER. IF resolution lands on a one-line wrapped export, the implementation is in the same file — get_file_skeleton(that file), never a new repo-wide search.</rule>
        <rule name="context">Provider and consumers link through the Context OBJECT, not calls: ONE search with exact_tokens on the context name ("ThemeContext") returns creation, Provider JSX, and consumers together.</rule>
        <rule name="render-props">Logic injected via children/render props lives at the CALL SITE. IF a component's body looks "empty", check ONE consumer to see what it injects (hard limit 4).</rule>
        <rule name="query-style">Component names are PascalCase and unique — exact_tokens with the component name is the highest-precision query in a React codebase. For visual/behavioural questions ("the dropdown that closes on outside click"), use a behavioural sentence — handler names vary too much.</rule>
    </rules>

    <playbook question="explain component X and where it renders" calls="2-3">resolve_symbol("X") → get_chunk(id) — a component's body IS its behaviour (hooks + JSX), so the full chunk replaces two summary calls → answer citing Used by: as the render sites; at most ONE consumer chunk as a render example. Do NOT also resolve every child component in its JSX. Several named components? ONE batched search per hard limit 2.</playbook>

</environment_prompt>
