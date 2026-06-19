/**
 * @file parse/routes.mjs
 * @description HTTP route extraction from AST (Express/NestJS/FastAPI/Flask/Spring Boot).
 * @author MaquinaTech <https://github.com/MaquinaTech>
 * @copyright (c) 2026 MaquinaTech. All rights reserved.
 * @license MIT
 */

// ─── HTTP route extraction ────────────────────────────────────────────────────
// The call graph records that a function was called, but cannot connect an HTTP
// verb+path (`GET /api/users`) to the handler that serves it. extractRoutes mines
// that mapping at index time from the four common shapes:
//   • decorator-on-method     — NestJS/Angular  (@Get/@Post on a class method)
//   • decorator-on-function   — FastAPI/Flask    (@app.get / @app.route)
//   • annotation-on-method    — Spring Boot      (@GetMapping / @RequestMapping)
//   • functional registration — Express/Koa      (router.get('/x', handler))
// Each route resolves its handler to a chunk id (by name, case-sensitive) so an
// agent can jump straight from an endpoint to get_chunk / get_call_graph on the
// handler. No framework names are hardcoded beyond the verb sets — detection is by
// AST node type, mirroring extractDecorators / extractCallSites.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);
// C# generic-constraint keywords that can sit in type position but are not types.
const ROUTE_JS_LIKE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Unquote a string-literal node across grammars (JS string_fragment, Python
 *  string_content, Java string_fragment, …). Returns null for non-string nodes. */
function _routeLiteral(node) {
    if (!node) return null;
    const STR = new Set(['string', 'template_string', 'string_literal',
        'interpreted_string_literal', 'raw_string_literal']);
    if (!STR.has(node.type)) return null;
    const frag = node.namedChildren?.find(c => /fragment|content/.test(c.type));
    if (frag) return frag.text;
    return node.text.replace(/^[`'"]+|[`'"]+$/g, '');
}

/** Join a controller/class path prefix to a method path. Empty prefix → path as-is
 *  (spec: "if no Controller prefix, leave it as-is"). Collapses duplicate slashes. */
function _joinRoutePath(prefix, sub) {
    prefix = (prefix || '').trim();
    sub = (sub || '').trim();
    if (!prefix) return sub;
    if (!sub) return prefix;
    return (prefix.replace(/\/+$/, '') + '/' + sub.replace(/^\/+/, '')).replace(/\/{2,}/g, '/');
}

/** Decorators that lead a node as siblings (mirrors extractDecorators' sibling walk).
 *  NestJS method decorators sit as previous siblings inside the class_body. */
function _leadingDecorators(node) {
    const out = [];
    let prev = node.previousSibling;
    while (prev) {
        if (prev.type === 'decorator') out.push(prev);
        else if (prev.isNamed && prev.type !== 'comment') break;
        prev = prev.previousSibling;
    }
    return out;
}

/** Parse a TS/JS decorator node into { name, path } — name is the callee (`Get`,
 *  `Controller`), path is its first string argument (or null for bare `@Get()`). */
function _parseTsDecorator(decoNode) {
    const call = decoNode.namedChildren?.find(c => c.type === 'call_expression');
    if (!call) {
        const id = decoNode.namedChildren?.find(c => c.type === 'identifier');
        return { name: id?.text || decoNode.text.replace(/^@/, '').split(/[\s(]/)[0], path: null };
    }
    const fn = call.childForFieldName?.('function');
    let name = '';
    if (fn?.type === 'identifier') name = fn.text;
    else if (fn?.type === 'member_expression') name = fn.childForFieldName?.('property')?.text || '';
    const args = call.childForFieldName?.('arguments');
    const firstStr = args?.namedChildren?.find(c => _routeLiteral(c) != null);
    return { name, path: _routeLiteral(firstStr) };
}

/** NestJS / Angular: @Get/@Post/… on class methods, with the enclosing
 *  @Controller(prefix) prepended. */
function _extractNestRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'class_declaration' || n.type === 'abstract_class_declaration') {
            // @Controller prefix. For `export class` the decorator is a leading
            // sibling (inside export_statement); for a bare/abstract `class` it is a
            // direct child of the class node before class_body. Check both.
            const classDecos = [..._leadingDecorators(n)];
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if (c.type === 'class_body') break;
                if (c.type === 'decorator') classDecos.push(c);
            }
            let prefix = '';
            for (const d of classDecos) {
                const { name, path } = _parseTsDecorator(d);
                if (name === 'Controller' && path != null) { prefix = path; break; }
            }
            const body = n.childForFieldName?.('body')
                || n.namedChildren?.find(c => c.type === 'class_body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member.type !== 'method_definition') continue;
                    const handler = member.childForFieldName?.('name')?.text
                        || member.namedChildren?.find(c => c.type === 'property_identifier')?.text;
                    for (const d of _leadingDecorators(member)) {
                        const { name, path } = _parseTsDecorator(d);
                        if (!name || !HTTP_VERBS.has(name.toLowerCase())) continue;
                        emit(name, _joinRoutePath(prefix, path), handler, member.startPosition.row + 1, 'nestjs');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** Derive a handler name from an Express argument node: a bare identifier, a member
 *  expression (`ctrl.getThing` → 'getThing', `this.handler` → 'handler'), or a
 *  `.bind()` call (`handler.bind(this)` → 'handler'). Arrow/inline fn → 'anonymous'. */
function _jsHandlerName(node) {
    if (!node) return 'anonymous';
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression') {
        return node.childForFieldName?.('property')?.text || 'anonymous';
    }
    if (node.type === 'call_expression') {
        const callee = node.childForFieldName?.('function');
        if (callee?.type === 'member_expression') {
            const obj = callee.childForFieldName?.('object');
            if (obj?.type === 'identifier') return obj.text;                                   // handler.bind(this) → handler
            if (obj?.type === 'member_expression') return obj.childForFieldName?.('property')?.text || 'anonymous';
            return callee.childForFieldName?.('property')?.text || 'anonymous';
        }
        if (callee?.type === 'identifier') return callee.text;                                 // makeHandler() → makeHandler
    }
    return 'anonymous'; // arrow_function / function / function_expression / unknown
}

/** Express / Koa: `<router|app>.<verb>(<path>, …, <handler>)` call sites. The route
 *  path must be rooted ('/…') or a wildcard ('*') — this matches Express/Koa
 *  convention and rejects look-alike calls (`cache.get('key', cb)`, `map.get(k)`). */
function _extractExpressRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'call_expression') {
            const fn = n.childForFieldName?.('function');
            if (fn?.type === 'member_expression') {
                const verb = fn.childForFieldName?.('property')?.text || '';
                const args = n.childForFieldName?.('arguments');
                if (verb && HTTP_VERBS.has(verb.toLowerCase()) && args) {
                    const named = args.namedChildren || [];
                    const routePath = _routeLiteral(named[0]);
                    if (routePath != null && /^[/*]/.test(routePath) && named.length >= 2) {
                        // The handler is the LAST argument (preceding args are middleware);
                        // it may be an identifier, a member expression, or a .bind() call.
                        const handler = _jsHandlerName(named[named.length - 1]);
                        emit(verb, routePath, handler, n.startPosition.row + 1, 'express');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** FastAPI / Flask: @app.get / @router.post / @app.route(path, methods=[…]). */
function _extractPyRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'decorated_definition') {
            const def = n.namedChildren?.find(c => c.type === 'function_definition');
            const handler = def?.childForFieldName?.('name')?.text
                || def?.namedChildren?.find(c => c.type === 'identifier')?.text;
            const line = (def || n).startPosition.row + 1;
            for (const d of n.namedChildren || []) {
                if (d.type !== 'decorator') continue;
                const call = d.namedChildren?.find(c => c.type === 'call');
                const fn = call?.childForFieldName?.('function');
                if (fn?.type !== 'attribute') continue;
                const verb = fn.childForFieldName?.('attribute')?.text || '';
                const args = call.childForFieldName?.('arguments');
                // Positional path string, or the `path=`/`rule=` keyword argument.
                let routePath = _routeLiteral(args?.namedChildren?.find(c => c.type === 'string'));
                if (routePath == null) {
                    const kw = args?.namedChildren?.find(c => c.type === 'keyword_argument'
                        && ['path', 'rule'].includes(c.childForFieldName?.('name')?.text));
                    routePath = _routeLiteral(kw?.childForFieldName?.('value'));
                }
                // A real FastAPI/Flask route always carries a rooted path string — this
                // rejects look-alike decorators (`@cache.get("key")`, `@retry.post(n=3)`).
                const isRoute = routePath != null && routePath.startsWith('/');
                if (HTTP_VERBS.has(verb.toLowerCase())) {
                    if (isRoute) emit(verb, routePath, handler, line, 'fastapi');
                } else if (verb === 'route' && isRoute) {
                    // @app.route(path, methods=["GET","POST"]) — Flask. One route per
                    // method; default GET when methods is omitted.
                    const kw = args?.namedChildren?.find(c => c.type === 'keyword_argument'
                        && c.childForFieldName?.('name')?.text === 'methods');
                    const list = kw?.childForFieldName?.('value');
                    const methods = list
                        ? (list.namedChildren || []).map(_routeLiteral).filter(Boolean)
                        : [];
                    for (const m of (methods.length ? methods : ['GET'])) {
                        emit(m, routePath, handler, line, 'flask');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/** Spring Boot: @GetMapping/@PostMapping/… and @RequestMapping(value=…, method=…)
 *  on methods, with class-level @RequestMapping as a prefix. */
function _springAnnotation(annNode) {
    // annotation > identifier <name> + annotation_argument_list
    const name = annNode.namedChildren?.find(c => c.type === 'identifier')?.text || '';
    const argList = annNode.namedChildren?.find(c => c.type === 'annotation_argument_list');
    const verbOf = (t) => (t || '').split('.').pop(); // RequestMethod.POST → POST
    let path = null, methods = [];
    if (argList) {
        const positional = argList.namedChildren?.find(c => _routeLiteral(c) != null);
        if (positional) path = _routeLiteral(positional);
        for (const pair of argList.namedChildren || []) {
            if (pair.type !== 'element_value_pair') continue;
            const key = pair.namedChildren?.[0]?.text;
            const valNode = pair.namedChildren?.[1];
            if (key === 'value' || key === 'path') path = _routeLiteral(valNode) ?? path;
            else if (key === 'method') {
                // Single (method = RequestMethod.GET) or array (method = {…, …}).
                methods = (valNode?.type === 'element_value_array_initializer'
                    ? (valNode.namedChildren || []).map(c => verbOf(c.text))
                    : [verbOf(valNode?.text)]).filter(Boolean);
            }
        }
    }
    return { name, path, methods };
}

const SPRING_VERB = {
    GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
    DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

function _extractSpringRoutes(rootNode, emit) {
    const stack = [rootNode];
    while (stack.length) {
        const n = stack.pop();
        if (n.type === 'class_declaration') {
            const mods = n.namedChildren?.find(c => c.type === 'modifiers');
            let prefix = '';
            for (const a of (mods?.namedChildren || [])) {
                if (a.type !== 'annotation') continue;
                const { name, path } = _springAnnotation(a);
                if (name === 'RequestMapping' && path != null) { prefix = path; break; }
            }
            const body = n.namedChildren?.find(c => c.type === 'class_body');
            for (const member of (body?.namedChildren || [])) {
                if (member.type !== 'method_declaration') continue;
                const handler = member.childForFieldName?.('name')?.text;
                const mMods = member.namedChildren?.find(c => c.type === 'modifiers');
                for (const a of (mMods?.namedChildren || [])) {
                    if (a.type !== 'annotation' && a.type !== 'marker_annotation') continue;
                    const { name, path, methods } = _springAnnotation(a);
                    let verbs;
                    if (SPRING_VERB[name]) verbs = [SPRING_VERB[name]];
                    else if (name === 'RequestMapping') verbs = methods.length ? methods : ['ALL'];
                    else continue;
                    // @RequestMapping(method = {GET, POST}) → one route per verb.
                    for (const verb of verbs) {
                        emit(verb, _joinRoutePath(prefix, path), handler, member.startPosition.row + 1, 'spring');
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
    }
}

/**
 * Map HTTP routes to their handlers for one parsed file.
 *
 * @param {object}  rootNode  parsed AST root
 * @param {string}  relPath   repo-relative file path (stored on each route)
 * @param {object[]} chunks   the file's already-extracted chunks (handler→id lookup)
 * @param {string}  ext       dotted file extension
 * @returns {Array<{method,path,handler_name,handler_chunk_id,file_path,line,framework}>}
 */
export function extractRoutes(rootNode, relPath, chunks, ext) {
    const routes = [];
    if (!rootNode) return routes;

    // handler name → chunk id (case-sensitive, first definition wins).
    const idByName = new Map();
    for (const c of (chunks || [])) {
        if (c && c.name && !idByName.has(c.name)) idByName.set(c.name, c.id);
    }

    const emit = (method, routePath, handlerName, line, framework) => {
        if (!method) return;
        // Normalise to a rooted path so NestJS controller-prefixed paths ('users/:id')
        // are uniform with Spring/Express/FastAPI ('/…') and a '/'-prefix query matches.
        let p = routePath == null ? '' : String(routePath);
        if (p && !p.startsWith('/')) p = '/' + p;
        routes.push({
            method: String(method).toUpperCase(),
            path: p,
            handler_name: handlerName || 'anonymous',
            handler_chunk_id: (handlerName && idByName.has(handlerName)) ? idByName.get(handlerName) : null,
            file_path: relPath,
            line,
            framework,
        });
    };

    try {
        if (ROUTE_JS_LIKE.includes(ext)) {
            _extractNestRoutes(rootNode, emit);    // decorator-based (NestJS/Angular)
            _extractExpressRoutes(rootNode, emit);  // functional (Express/Koa)
        } else if (ext === '.py') {
            _extractPyRoutes(rootNode, emit);
        } else if (ext === '.java') {
            _extractSpringRoutes(rootNode, emit);
        }
    } catch { /* route extraction is best-effort metadata — never fail indexing */ }
    return routes;
}
