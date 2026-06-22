<environment_prompt layer="2" type="framework" name="react" requires="graph-indexer-core, javascript-typescript" version="1.0">

    <scope>React (JSX/TSX components, hooks). Loads after the javascript-typescript layer.</scope>

    <critical_fact>JSX tags are NOT call expressions: `<MyComponent />` is a JSXElement, so get_call_graph("MyComponent") NEVER lists render sites and an empty call graph NEVER means a component is unused. Render sites come from `Used by:` (import topology — reliable in JS/TS) or ONE exact_tokens search on the component name.</critical_fact>

    <rules>
        <rule name="hooks-are-calls">Hook invocations ARE ordinary calls: get_call_graph("useAuth") reliably lists every component using that hook — the graph is trustworthy for hooks even though blind to JSX. A custom hook's contract is its return value — summary + Calls: line usually answers "what does it do" without the body.</rule>
        <rule name="runtime-flow-invisible">State setter → re-render → effect firing is a runtime property no index sees. Answer ordering/timing from ONE get_chunk of the component, reasoning over hook semantics — never search for the render loop.</rule>
        <rule name="wrappers">memo(...), forwardRef(...), HOCs export the WRAPPER. Resolution landing on a one-line wrapped export → the implementation is in the same file: get_file_skeleton(that file), not a new repo-wide search.</rule>
        <rule name="context">Provider and consumers link through the Context OBJECT, not calls: ONE exact_tokens search on the context name ("ThemeContext") returns creation, Provider JSX, and consumers together.</rule>
        <rule name="render-props">Logic injected via children/render props lives at the CALL SITE. If a component's body looks "empty", check ONE consumer to see what it injects.</rule>
        <rule name="query-style">Component names are PascalCase and unique — exact_tokens with the component name is the highest-precision query here. For visual/behavioural questions ("the dropdown that closes on outside click"), use a behavioural sentence — handler names vary too much.</rule>
    </rules>

    <playbook question="explain component X and where it renders" calls="2-3">resolve_symbol("X") → get_chunk(id) — a component's body IS its behaviour (hooks + JSX), so the full chunk replaces two summary calls → answer citing Used by: as the render sites; ≤1 consumer chunk as a render example. Do NOT resolve every child component in its JSX.</playbook>

</environment_prompt>
