/**
 * HTTP routes and the code that handles them: the edge no compiler sees and grep finds only in
 * pieces (a decorator here, a prefix on the class or router there, the handler named as a value).
 *
 * Recognised by the shape frameworks give them, from the indexed source:
 *   - decorators: FastAPI / Flask (`@app.get("/x")`, `@router.route("/x", methods=[…])`, with the
 *     prefix of an `APIRouter(prefix=…)` / `Blueprint(url_prefix=…)` defined in the same file),
 *     NestJS (`@Controller('users')` + `@Get(':id')`), Spring (`@RequestMapping` on the class +
 *     `@GetMapping("/x")`);
 *   - registration calls: Express / Fastify / Koa / Hono (`router.post('/x', auth, handler)`), Gin /
 *     Echo / chi (`r.GET("/x", handler)`) and net/http (`http.HandleFunc("/x", handler)`).
 * The handler is the decorated definition, or the last argument of the registration call bound
 * through the index (an inline function is reported by its location).
 */

const METHODS = 'get|post|put|delete|patch|head|options';
const PY_ROUTE = new RegExp(`^\\s*@([\\w.]+)\\.(${METHODS}|route|api_route|websocket)\\(\\s*(?:path\\s*=\\s*|rule\\s*=\\s*)?[rbuf]?["']([^"']*)["']([^\\n]*)`, 'i');
const PY_PREFIX = /^\s*(\w+)\s*=\s*(?:\w+\.)?(APIRouter|Blueprint)\(([^\n]*)/;
const NEST_CONTROLLER = /@Controller\(\s*(?:\{[^}]*path:\s*)?['"`]([^'"`]*)['"`]/;
const NEST_ROUTE = /^\s*@(Get|Post|Put|Delete|Patch|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
const SPRING_CLASS = /^\s*@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/;
const SPRING_ROUTE = /^\s*@(Get|Post|Put|Delete|Patch|Request)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"([^\n]*))?/;
const JS_CALL = new RegExp(`\\b([\\w$]+)\\.(${METHODS}|all)\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,([^\\n]*)`);
const GO_CALL = /\b(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|HandleFunc|Handle)\(\s*"([^"]+)"\s*,([^\n]*)/;

const HANDLER_KINDS = new Set(['function', 'method']);
const COMMENT = /^\s*(\/\/|\/?\*|#(?!\s*@)|>>>)/;

/** `/users/{id}`, `/users/:id`, `/users/<int:id>` → one comparable shape: `/users/*`. */
export function routeShape(p) {
    return ('/' + String(p).trim().replace(/^\/+/, ''))
        .replace(/\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*\??|\*\w*/g, '*')
        .replace(/\/+$/, '') || '/';
}

const join = (a, b) => ('/' + [a, b].map(x => String(x ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')) || '/';

/** Every route in the repository: { method, path, file, line, handler (symbol row or null), framework }. */
export function collectRoutes(intel) {
    if (intel._routes?.version === intel.ix?.version) return intel._routes.rows;
    const files = intel.store.all(`SELECT id, path, lang FROM files WHERE is_test = 0 AND lang IN ('python', 'typescript', 'tsx', 'javascript', 'java', 'kotlin', 'go')`);
    const out = [];
    for (const f of files) {
        const lines = intel.fileLines(f.path);
        if (!lines) continue;
        const text = lines.join('\n');
        if (!/(route|get|post|put|delete|patch|Mapping|Controller|HandleFunc|GET|POST)\s*\(/i.test(text)) continue;
        const defs = intel.store.all(`SELECT id, name, qname, kind, start_line, end_line, parent_id, ? AS path FROM symbols WHERE file_id = ? ORDER BY start_line`, f.path, f.id);
        const defAfter = (line, span = 12) => defs.find(d => HANDLER_KINDS.has(d.kind) && d.start_line >= line && d.start_line <= line + span) ?? null;
        // the prefix a class declares in an annotation just above its `class` line (`@Controller('users')`)
        const classPrefix = (line, re) => {
            let decl = line - 1;
            while (decl > 0 && !/\b(class|interface)\s+\w/.test(lines[decl - 1])) decl--;
            if (decl <= 0) return '';
            for (let i = decl; i >= Math.max(1, decl - 8); i--) { const m = re.exec(lines[i - 1]); if (m) return m[1]; }
            return '';
        };
        // an annotation is the class's own when the next line that is not an annotation declares the class
        const onClass = (line) => { let i = line; while (i < lines.length && /^\s*@/.test(lines[i])) i++; return /\b(class|interface)\s+\w/.test(lines[i] ?? ''); };
        // examples in comments and docstrings are not routes
        const add = (r) => { if (!COMMENT.test(lines[r.line - 1] ?? '')) out.push({ ...r, file: f.path, shape: routeShape(r.path) }); };
        if (f.lang === 'python') {
            const prefixes = new Map();
            for (const l of lines) {
                const m = PY_PREFIX.exec(l);
                if (m) prefixes.set(m[1], /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(m[3])?.[1] ?? '');
            }
            lines.forEach((l, i) => {
                const m = PY_ROUTE.exec(l);
                if (!m) return;
                const [, obj, verb, p, rest] = m;
                const owner = obj.split('.').pop();
                const methods = verb.toLowerCase() === 'route' || verb.toLowerCase() === 'api_route'
                    ? (/methods\s*=\s*[[(]([^\])]*)/.exec(rest)?.[1].match(/[A-Za-z]+/g)?.map(x => x.toUpperCase()) ?? ['GET'])
                    : [verb.toUpperCase() === 'WEBSOCKET' ? 'WS' : verb.toUpperCase()];
                const h = defAfter(i + 1);
                for (const method of methods) add({ method, path: join(prefixes.get(owner) ?? '', p), line: i + 1, handler: h, framework: prefixes.has(owner) ? 'router' : 'app' });
            });
        } else if (f.lang === 'typescript' || f.lang === 'tsx' || f.lang === 'javascript') {
            lines.forEach((l, i) => {
                const n = NEST_ROUTE.exec(l);
                if (n) {
                    add({ method: n[1].toUpperCase(), path: join(classPrefix(i + 1, NEST_CONTROLLER), n[2] ?? ''), line: i + 1, handler: defAfter(i + 1, 8), framework: 'nestjs' });
                    return;
                }
                const m = JS_CALL.exec(l);
                if (!m || !/^\//.test(m[3])) return;
                add({ method: m[2].toUpperCase() === 'ALL' ? 'ANY' : m[2].toUpperCase(), path: m[3], line: i + 1, handler: handlerArg(intel, f, i + 1, m[4]), framework: 'express' });
            });
        } else if (f.lang === 'java' || f.lang === 'kotlin') {
            lines.forEach((l, i) => {
                const m = SPRING_ROUTE.exec(l);
                if (!m) return;
                // the class-level @RequestMapping is the prefix, not a route
                if (m[1] === 'Request' && onClass(i + 1)) return;
                const prefix = classPrefix(i + 1, SPRING_CLASS);
                const method = m[1] === 'Request' ? (/RequestMethod\.(\w+)/.exec(m[3] ?? '')?.[1] ?? 'ANY') : m[1].toUpperCase();
                add({ method, path: join(prefix, m[2] ?? ''), line: i + 1, handler: defAfter(i + 1, 8), framework: 'spring' });
            });
        } else if (f.lang === 'go') {
            lines.forEach((l, i) => {
                const m = GO_CALL.exec(l);
                if (!m || !m[3].startsWith('/')) return;
                const verb = m[2];
                const method = /^Handle/.test(verb) ? 'ANY' : verb.toUpperCase();
                add({ method, path: m[3], line: i + 1, handler: handlerArg(intel, f, i + 1, m[4]), framework: 'go' });
            });
        }
    }
    intel._routes = { version: intel.ix?.version, rows: out };
    return out;
}

/** The handler of a registration call: its last argument, bound through the index where possible. */
function handlerArg(intel, f, line, args) {
    const parts = args.split(',').map(x => x.trim()).filter(Boolean);
    const last = (parts[parts.length - 1] ?? '').replace(/\)+;?\s*$/, '').trim();
    const name = /^(?:[\w$]+\.)*([\w$]+)$/.exec(last)?.[1];
    if (!name) return null; // an inline function: the route's own line is the handler
    const r = intel.store.get(`SELECT dst_id FROM refs WHERE file_id = ? AND line = ? AND name = ? AND dst_id IS NOT NULL LIMIT 1`, f.id, line, name);
    const id = r?.dst_id ?? intel.store.get(`SELECT s.id FROM symbols s JOIN files fl ON fl.id = s.file_id WHERE s.name = ? AND s.kind IN ('function', 'method') AND fl.is_test = 0 LIMIT 2`, name)?.id;
    return id != null ? intel.store.get('SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.parent_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?', id) : null;
}

/** Routes in a query (`POST /api/login`, `/users/{id}`): [{ method | null, shape }]. */
export function routesInQuery(q) {
    const out = [];
    const re = /(?:\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+)?(\/[\w\-.{}:<>*~/]*[\w}>*])/gi;
    for (let m; (m = re.exec(String(q))); ) if (m[2].length > 1) out.push({ method: m[1]?.toUpperCase() ?? null, shape: routeShape(m[2]) });
    return out;
}

/** Routes matching a query route: same shape (parameters match anything), and method when given. */
export function matchRoutes(routes, { method, shape }) {
    const parts = shape.split('/');
    const fits = (r) => {
        const rp = r.shape.split('/');
        if (rp.length !== parts.length) return false;
        return rp.every((x, i) => x === '*' || parts[i] === '*' || x.toLowerCase() === parts[i].toLowerCase());
    };
    return routes.filter(r => fits(r) && (!method || r.method === method || r.method === 'ANY'));
}
