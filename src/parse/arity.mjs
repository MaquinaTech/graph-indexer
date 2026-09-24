/**
 * Parameter and argument counting across languages, from tree-sitter nodes: how many arguments a
 * definition accepts ({ min, max }, max = Infinity for variadics) and how many a call passes
 * ({ n, open }, open = a spread/splat makes n a lower bound). Used by the edit checker to spot
 * call sites that no longer match a changed signature, without compiling anything.
 */

const PARAM_LIST_TYPES = new Set(['formal_parameters', 'parameters', 'parameter_list', 'function_value_parameters', 'method_parameters',
    'lambda_parameters', 'block_parameters', 'parameter_clause']);
const SKIP_PARAM = /^(comment|line_comment|block_comment|self_parameter|this|attribute_item|attribute|annotation|marker_annotation|decorator|keyword_separator|positional_separator|type_parameters|block_parameter)$/;
const VARIADIC = /(rest_pattern|rest_parameter|spread|variadic|splat|list_splat_pattern|dictionary_splat_pattern|varargs)/;
const OPTIONAL = /(optional_parameter|default_parameter|typed_default_parameter|optional_parameter_declaration|keyword_parameter)/;
const CALL_TYPES = new Set(['call_expression', 'call', 'method_invocation', 'invocation_expression', 'new_expression', 'object_creation_expression',
    'function_call_expression', 'member_call_expression', 'scoped_call_expression', 'nullsafe_member_call_expression', 'method_call_expression', 'macro_invocation']);
const ARG_LIST_TYPES = new Set(['arguments', 'argument_list', 'value_arguments', 'actual_parameters']);
const SPREAD_ARG = /^(spread_element|list_splat|dictionary_splat|splat_argument|hash_splat_argument|variadic_argument)$/;

function paramsNodeOf(def) {
    const direct = def.childForFieldName('parameters');
    if (direct) return direct;
    const value = def.childForFieldName('value');
    const vp = value?.childForFieldName?.('parameters');
    if (vp) return vp;
    if (value && (value.type === 'arrow_function') && value.childForFieldName('parameter')) return value.childForFieldName('parameter');
    for (const c of def.namedChildren) {
        if (PARAM_LIST_TYPES.has(c.type)) return c;
        // C/C++: declarator → function_declarator → parameters
        if (/declarator$/.test(c.type)) { const p = c.childForFieldName('parameters') ?? c.namedChildren.find(x => PARAM_LIST_TYPES.has(x.type)); if (p) return p; }
    }
    return null;
}

/**
 * Python decorators that turn a def into something other than a plain function: properties, and
 * classes (CapWords by convention, e.g. a caching descriptor). How the result is called is up to
 * that object, so the def's parameters say nothing about its call sites.
 */
function isDescriptorDecorator(d) {
    const last = d.split('.').pop();
    return /(property|setter|getter|deleter)$/i.test(last) || /^_*[A-Z]/.test(last);
}

/**
 * Accepted argument count of a function/method definition node.
 * @param {object} def tree-sitter node of the definition
 * @param {{ method?: boolean, lang?: string, isStatic?: boolean, decorators?: string[] }} ctx
 * @returns {{ min: number, max: number } | null}
 */
export function paramArity(def, { method = false, lang = '', isStatic = false, decorators = [] } = {}) {
    const params = paramsNodeOf(def);
    if (!params) return null;
    if (params.type === 'identifier') return { min: 1, max: 1 }; // `x => …`
    let min = 0, max = 0, first = true, keywordOnly = false;
    const py = lang === 'python';
    if (py && decorators.some(isDescriptorDecorator)) return null;
    for (const p of params.namedChildren) {
        const t = p.type;
        if (t === 'keyword_separator') { keywordOnly = true; continue; }
        if (SKIP_PARAM.test(t)) continue;
        const text = p.text;
        // the receiver: Python self/cls (not for staticmethods), TS `this: T`
        if (first && py && method && !isStatic && !decorators.some(d => /staticmethod/.test(d)) && /^(self|cls)\b/.test(text)) { first = false; continue; }
        first = false;
        if (/^this\s*[:?]/.test(text)) continue;
        if (VARIADIC.test(t) || /^(\.\.\.|\*\*?)/.test(text) || /^params\s/.test(text) || /\bvararg\b/.test(text) || /\.\.\.\s*\w*$/.test(text) && lang === 'go') { max = Infinity; continue; }
        // Go: `a, b int` declares two parameters
        const names = t === 'parameter_declaration' && lang === 'go' ? p.namedChildren.filter(c => c.type === 'identifier').length || 1 : 1;
        const optional = OPTIONAL.test(t) || !!p.childForFieldName('value') || !!p.childForFieldName('default_value')
            || p.namedChildren.some(c => c.type === 'equals_value_clause')
            || (['kotlin', 'scala', 'swift'].includes(lang) && /[^=]=[^=>]/.test(text));
        max += names;
        if (!optional && !(keywordOnly && py && /=/.test(text))) min += names;
    }
    return { min, max };
}

/** Node of the call whose callee name sits at (row, column), with its argument list. */
export function callAt(tree, row, column) {
    let n = tree.rootNode.descendantForPosition({ row, column });
    for (let g = 0; n && g < 6; g++, n = n.parent) {
        if (CALL_TYPES.has(n.type)) return n;
    }
    return null;
}

/** Arguments passed by a call node: { n, open } or null when they cannot be counted. */
export function callArgc(call) {
    let args = call.childForFieldName('arguments');
    if (!args) args = call.namedChildren.find(c => ARG_LIST_TYPES.has(c.type)) ?? null;
    if (!args) {
        // Kotlin: call_suffix → value_arguments (+ trailing lambda)
        const suffix = call.namedChildren.find(c => c.type === 'call_suffix');
        if (suffix) {
            const va = suffix.namedChildren.find(c => c.type === 'value_arguments');
            const lam = suffix.namedChildren.some(c => c.type === 'annotated_lambda') ? 1 : 0;
            if (!va && !lam) return null;
            const n = (va ? va.namedChildren.filter(c => c.type === 'value_argument').length : 0) + lam;
            return { n, open: va ? va.namedChildren.some(c => /\*/.test(c.text.slice(0, 1))) : false };
        }
        return null;
    }
    let n = 0, open = false;
    for (const c of args.namedChildren) {
        if (/comment/.test(c.type)) continue;
        if (SPREAD_ARG.test(c.type) || /^\.\.\./.test(c.text) || /\.\.\.$/.test(c.text)) { open = true; continue; }
        if (c.type === 'block' || c.type === 'do_block') continue; // Ruby block argument
        n++;
    }
    return { n, open };
}

/**
 * Accepted argument count read from a stored signature (`public List<T> find(String q, T... xs)`):
 * for languages whose overloads are separate methods, to bind a call to the one it can reach.
 * Parameters with a default value are optional; `...`, `vararg` and `params` make it open-ended.
 * @returns {{ min: number, max: number } | null}
 */
export function sigArity(sig, name) {
    if (!sig) return null;
    const m = new RegExp(`(?:^|[^\\w$])${name.replace(/[$]/g, '\\$')}\\s*(?:<[^()]*>)?\\s*\\(`).exec(sig);
    if (!m) return null;
    let depth = 0, cur = '', min = 0, max = 0, done = false;
    const param = (p) => {
        p = p.trim();
        if (!p) return;
        if (/\.\.\.|^vararg\s|^params\s/.test(p)) { max = Infinity; return; }
        max++;
        if (!/[^=!<>]=[^=]/.test(p)) min++;
    };
    for (let i = m.index + m[0].length; i < sig.length; i++) {
        const ch = sig[i];
        if (ch === ')' && depth === 0) { param(cur); done = true; break; }
        if ('([{<'.includes(ch)) depth++;
        else if (')]}>'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { param(cur); cur = ''; } else cur += ch;
    }
    return done ? { min, max } : null;
}

/** Does a call passing `a` arguments fit a definition accepting `r`? */
export function fits(a, r) {
    if (!a || !r) return true;
    if (a.n > r.max) return false;
    if (!a.open && a.n < r.min) return false;
    return true;
}

export function describeArity(r) {
    if (!r) return '?';
    if (r.max === Infinity) return `${r.min}+`;
    return r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
}
