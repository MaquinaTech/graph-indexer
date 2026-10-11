/**
 * Dependency injection: the edge between a value a class receives and the code that provides it,
 * which the compiler does not see. In NestJS a constructor parameter marked `@Inject(TOKEN)` gets
 * whatever a module registered as `{ provide: TOKEN, useClass | useExisting | useFactory | useValue }`;
 * its declared type is often an interface or a union, so neither the type checker nor grep for the
 * type name leads to the implementation.
 *
 * Recognised from the indexed source (TypeScript):
 *   - providers: an object with `provide:` and one of `useClass`, `useExisting`, `useFactory`,
 *     `useValue`, on one line or over the lines that follow;
 *   - injection points: `@Inject(TOKEN)` on a constructor parameter or property.
 * Test files are left out: their providers are mocks.
 * A token is the definition the index binds it to (a constant, a class, a symbol); a string, a
 * constant declared as that string and `Class.name` are one token. An expression such as
 * `getRepositoryToken(User)` is matched by its text, only when written the same way, and marked so;
 * tokens computed at run time (`Object.values(Namespace).map(ns => ({ provide: ns, … }))`) are not
 * found. Microservice clients registered with `ClientsModule.register([{ name: TOKEN }])` are
 * providers too.
 */

const PROVIDE = /\bprovide\s*:\s*([^,}\n]+?)\s*(?:,|}|$)/;
const USE = /\buse(Class|Existing|Factory|Value)\s*:\s*([^,}\n]*)/;
const INJECT = /@Inject\(\s*([^)]*?)\s*\)/g;
const PARAM = /^\s*(?:(?:private|public|protected|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*([^,=)]+)/;

const strip = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** The definition a name on a line is bound to, through the index. */
function bound(intel, fileId, line, name) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    const r = intel.store.get('SELECT dst_id FROM refs WHERE file_id = ? AND line = ? AND name = ? AND dst_id IS NOT NULL LIMIT 1', fileId, line, name);
    return r ? symRow(intel, r.dst_id) : null;
}

function symRow(intel, id) {
    return intel.store.get('SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.parent_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?', id) ?? null;
}

/** A constant's string value (`const REFLECTOR = 'Reflector'`), if it is declared as one. */
function stringValue(intel, s) {
    if (s.kind !== 'constant' && s.kind !== 'variable') return null;
    const l = intel.fileLines(s.path)?.[s.start_line - 1] ?? '';
    return new RegExp(`\\b${s.name}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`]*)\\1\\s*;?\\s*$`).exec(l)?.[2] ?? null;
}

/**
 * A token's identity: the definition it names, or its text (strings and expressions). A string,
 * a constant holding one and `Class.name` are the same token when the strings are equal; `p.provide`
 * is the token of the provider declared as `p`.
 */
function tokenKey(intel, fileId, line, text) {
    const t = strip(text);
    const dotted = /^([\w$]+)\.(name|provide)$/.exec(t);
    if (dotted) {
        const head = bound(intel, fileId, line, dotted[1]);
        if (head && dotted[2] === 'name' && head.kind === 'class') return { key: `str:${head.name}`, token: t, sym: head, exact: true };
        if (head && dotted[2] === 'provide') return { key: `holder:${head.id}`, token: t, sym: head, exact: true };
    }
    const last = /^(?:[\w$]+\.)*([\w$]+)$/.exec(t)?.[1];
    let s = last ? bound(intel, fileId, line, last) : null;
    // a member of a type (`FactoryProvider.provide`) is a shape, not a token
    if (s && (s.kind === 'field' || s.kind === 'property')) s = null;
    if (s) {
        const v = stringValue(intel, s);
        return { key: v != null ? `str:${v}` : `id:${s.id}`, token: s.qname, sym: s, exact: true };
    }
    const lit = /^(['"`])(.*)\1$/.exec(t);
    return { key: lit ? `str:${lit[2]}` : `text:${t}`, token: t, sym: null, exact: !!lit };
}

/** The variable or constant a line is declared in (`const catsProvider = { provide: … }`). */
function holderAt(intel, fileId, line) {
    return intel.store.get(`SELECT id FROM symbols WHERE file_id = ? AND kind IN ('variable', 'constant') AND start_line <= ? AND end_line >= ? ORDER BY start_line DESC LIMIT 1`, fileId, line, line)?.id ?? null;
}

/** Is the line inside an interface or a type alias? */
function inTypeDeclaration(intel, fileId, line) {
    const s = intel.store.get(`SELECT kind FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ? AND kind IN ('class', 'interface', 'type', 'function', 'method', 'variable', 'constant')
        ORDER BY start_line DESC LIMIT 1`, fileId, line, line);
    return s?.kind === 'interface' || s?.kind === 'type';
}

/** The innermost class around a line. */
function classAt(intel, fileId, line) {
    return intel.store.get(`SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.parent_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.file_id = ? AND s.kind = 'class' AND s.start_line <= ? AND s.end_line >= ? ORDER BY s.start_line DESC LIMIT 1`, fileId, line, line) ?? null;
}

/**
 * Providers and injection points of the repository, keyed by token:
 * { providers: [{ key, token, exact, how, target, targetText, file, line }],
 *   injections: [{ key, token, exact, owner, param, type, file, line }] }.
 */
export function collectInjection(intel) {
    if (intel._injection?.version === intel.ix?.version) return intel._injection.data;
    const providers = [], injections = [];
    // test modules register mocks (`{ provide: Service, useValue: { get: jest.fn() } }`): not the app's wiring
    const files = intel.store.all(`SELECT id, path FROM files WHERE lang IN ('typescript', 'tsx') AND is_test = 0`);
    for (const f of files) {
        const lines = intel.fileLines(f.path);
        if (!lines) continue;
        const text = lines.join('\n');
        if (!text.includes('provide') && !text.includes('@Inject(') && !text.includes('ClientsModule')) continue;
        lines.forEach((l, i) => {
            const line = i + 1;
            if (/^\s*(\/\/|\/?\*)/.test(l)) return;
            const p = PROVIDE.exec(l);
            // `provide: InjectionToken;` in an interface or type declares the shape, it provides nothing
            if (p && !inTypeDeclaration(intel, f.id, line)) {
                // the `use…` of this provider: on its line, or on the lines below before the next one
                let u = USE.exec(l.slice(p.index)), at = line;
                for (let j = i + 1; !u && j < Math.min(lines.length, i + 15) && !PROVIDE.test(lines[j]); j++) { u = USE.exec(lines[j]); at = j + 1; }
                if (u) {
                    const tk = tokenKey(intel, f.id, line, p[1]);
                    const targetText = strip(u[2]) || `(${u[1] === 'Value' ? 'a value' : 'code'} on the lines below)`;
                    const name = /^(?:new\s+)?(?:[\w$]+\.)*([\w$]+)\b/.exec(targetText)?.[1];
                    let target = name && !/^(async|function)$/.test(name) && !/=>/.test(targetText.split('(')[0]) ? bound(intel, f.id, at, name) : null;
                    // `useClass: options.useClass` passes along what a caller gave: not a definition here
                    if (target && (target.kind === 'field' || target.kind === 'property')) target = null;
                    providers.push({ ...tk, how: `use${u[1]}`, target, targetText, file: f.path, line, holder: holderAt(intel, f.id, line) });
                }
            }
            // a microservice client: `ClientsModule.register([{ name: MATH_SERVICE, transport: … }])`
            const client = /^\s*name\s*:\s*([^,}\n]+?)\s*(?:,|}|$)/.exec(l) ?? /\{\s*name\s*:\s*([^,}\n]+?)\s*[,}]/.exec(l);
            if (client && lines.slice(Math.max(0, i - 6), i + 1).some(x => /\bClientsModule\.register(Async)?\s*\(/.test(x))) {
                providers.push({ ...tokenKey(intel, f.id, line, client[1]), how: 'ClientsModule', target: null, targetText: 'a client proxy for the microservice', file: f.path, line, holder: null });
            }
            for (const m of l.matchAll(INJECT)) {
                if (!m[1]) continue;
                const tk = tokenKey(intel, f.id, line, m[1]);
                // the parameter or property it decorates: the rest of the line, or the next line
                const rest = l.slice(m.index + m[0].length);
                const pm = PARAM.exec(rest.trim() ? rest : (lines[i + 1] ?? ''));
                injections.push({ ...tk, owner: classAt(intel, f.id, line), param: pm?.[1] ?? null, type: pm ? strip(pm[2]).replace(/;$/, '') : null, file: f.path, line });
            }
        });
    }
    // `@Inject(p.provide)`: the token of the provider declared as `p`
    for (const j of injections) {
        if (!j.key.startsWith('holder:')) continue;
        const p = providers.find(x => x.holder === Number(j.key.slice(7)));
        if (p) Object.assign(j, { key: p.key, token: `${j.token} (${p.token})` });
    }
    const data = { providers, injections };
    intel._injection = { version: intel.ix?.version, data };
    return data;
}

/** For a definition: the tokens it provides, each with where it is injected. */
export function providedBy(intel, id) {
    const { providers, injections } = collectInjection(intel);
    return providers.filter(p => p.target?.id === id).map(p => ({ ...p, into: injections.filter(j => j.key === p.key) }));
}

/** For a token (a definition used as one): its providers and injection points. */
export function tokenUses(intel, id) {
    const { providers, injections } = collectInjection(intel);
    const key = `id:${id}`;
    return { providers: providers.filter(p => p.key === key), injections: injections.filter(j => j.key === key) };
}

/** What a class receives through `@Inject(TOKEN)`, each with the providers of that token. */
export function injectedInto(intel, classId) {
    const { providers, injections } = collectInjection(intel);
    return injections.filter(j => j.owner?.id === classId).map(j => ({ ...j, from: providers.filter(p => p.key === j.key) }));
}
