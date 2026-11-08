/**
 * Spring dependency injection: which bean an injection point receives. A field, constructor or
 * `@Bean` parameter declares a type, usually an interface; Spring gives it the bean of that type
 * (a class annotated as a component, or what a `@Bean` method returns), choosing among several by
 * `@Qualifier`, `@Primary` and then the parameter's name. The compiler sees the interface, not the
 * implementation that runs.
 *
 * Recognised from the indexed source (Java):
 *   - beans: classes annotated @Component, @Service, @Repository, @Controller, @RestController,
 *     @Configuration, @SpringBootApplication (and the advice variants), @ConfigurationProperties classes
 *     that something registers (@EnableConfigurationProperties naming them, or a
 *     @ConfigurationPropertiesScan), with the name Spring gives them (the annotation's
 *     value or the decapitalised class name), @Primary, @Qualifier and the conditions that may
 *     leave them out (@Profile, @Conditional…); `@Bean` methods, by return type, with their names;
 *   - beans the framework generates at run time, as such: Feign clients (@FeignClient, a primary
 *     proxy), Spring Data repositories (interfaces extending a `…Repository`) and MyBatis mappers
 *     (@Mapper, or interfaces in a package named by @MapperScan);
 *   - injection points: fields and setters with @Autowired, @Inject or @Resource; the parameters of
 *     a component's constructor (its only one, or the @Autowired one) and of `@Bean` methods; the
 *     final fields of a component that Lombok's @RequiredArgsConstructor injects. @Value parameters
 *     are configuration, not beans.
 * A type a bean is assignable to is its class or anything it extends or implements, followed
 * through the index; a type the index does not bind (a library type) is matched by its name.
 * Collections (`List<T>`, `Map<String, T>`…) receive every bean of the element type. A build module
 * (the nearest directory with a pom.xml or build.gradle) holding a @SpringBootApplication is one
 * application, made of itself and the modules its build file depends on (Maven artifactIds and
 * Gradle `project(':…')` of this repository): an injection point sees the beans of the
 * applications its module is part of, never another application's; a shared module's point is
 * filled by each application that includes it. Not modelled:
 * custom stereotype annotations, beans declared in XML, auto-configuration from libraries and
 * generics as a qualifier — what a library provides is reported as not in the indexed code.
 * Test files are left out.
 */

const STEREOTYPE = /^(Component|Service|Repository|Controller|RestController|Configuration|ControllerAdvice|RestControllerAdvice|SpringBootApplication|ConfigurationProperties)$/;
const POINT = /^(Autowired|Inject|Resource)$/;
const CONDITION = /^(Profile|Conditional\w*)$/;
const MODIFIER = /^(private|public|protected|static|final|transient|volatile|abstract|default|synchronized)$/;
const MANY = /^(List|Set|Collection|Iterable|Map|SortedSet|SortedMap|LinkedHashMap|HashMap)$/;
const WRAP = /^(Optional|ObjectProvider|ObjectFactory|Provider|Lazy)$/;
const ANNOTATION = /@[\w.]+(?:\s*\((?:[^()"]|"[^"]*"|\((?:[^()"]|"[^"]*")*\))*\))?/g;

import fs from 'node:fs';
import path from 'node:path';

const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];

const decorators = (s) => { try { return JSON.parse(s.decorators || '[]'); } catch { return []; } };
const bases = (s) => { try { return JSON.parse(s.bases || '[]'); } catch { return []; } };
const strip = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Module directory → the module directories its build file depends on (pom.xml artifactIds, Gradle project paths). */
function moduleDeps(root, mods) {
    const info = new Map();
    for (const m of mods) {
        const dir = path.join(root, m);
        const pom = read(path.join(dir, 'pom.xml'));
        if (pom != null) {
            const body = pom.replace(/<!--[\s\S]*?-->/g, '');
            const own = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(body.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1];
            const ds = [...(body.match(/<dependencies>[\s\S]*?<\/dependencies>/g) ?? []).join('\n').matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)].map(x => x[1]);
            info.set(m, { names: [own, path.posix.basename(m)].filter(Boolean), deps: ds });
            continue;
        }
        const gradle = read(path.join(dir, 'build.gradle')) ?? read(path.join(dir, 'build.gradle.kts'));
        if (gradle != null) info.set(m, { names: [path.posix.basename(m)], deps: [...gradle.matchAll(/project\(\s*(?:path\s*[:=]\s*)?['"]:?([\w:.-]+)['"]/g)].map(x => x[1].split(':').pop()) });
    }
    const byName = new Map();
    for (const [m, i] of info) for (const n of i.names) if (!byName.has(n)) byName.set(n, m);
    const out = new Map();
    for (const [m, i] of info) out.set(m, new Set(i.deps.map(d => byName.get(d)).filter(d => d && d !== m)));
    return out;
}

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

/** Spring's default bean name: `FooService` → `fooService`, but `URLMapper` stays `URLMapper`. */
const beanName = (cls) => /^[A-Z]{2}/.test(cls) ? cls : cls[0].toLowerCase() + cls.slice(1);

/** The source of a declaration from its first line (annotations included) to its name, or to `upto`. */
function headText(lines, s, upto = null) {
    const end = upto ?? s.name_line;
    const out = [];
    for (let l = s.start_line; l <= end && l <= lines.length; l++) out.push(l === s.name_line && upto == null ? lines[l - 1].slice(0, s.name_col) : lines[l - 1]);
    return out.join('\n');
}

/** The annotations in a text: [{ name, args }] with `args` the parenthesised text, if any. */
function annotations(text) {
    return [...text.matchAll(ANNOTATION)].map(m => {
        const a = /^@([\w.]+)\s*(?:\(([\s\S]*)\))?$/.exec(m[0]);
        return { name: a[1].split('.').pop(), args: a[2] ?? null, index: m.index, length: m[0].length };
    });
}

/** The string values of an annotation's `value`/`name` (or bare) argument: `("x")`, `(name = "x")`, `({"a", "b"})`. */
function annotationNames(args, keys = ['value', 'name']) {
    if (args == null) return [];
    const t = args.trim();
    const kv = new RegExp(`\\b(?:${keys.join('|')})\\s*=\\s*(\\{[^}]*\\}|"[^"]*")`).exec(t);
    const v = kv ? kv[1] : (/^(\{[^}]*\}|"[^"]*")/.exec(t)?.[1] ?? '');
    return [...v.matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(Boolean);
}

/** A declared type → { raw, many, text }: `List<Foo>` → raw Foo, many; `Optional<Foo>` → Foo. */
function typeOf(text) {
    let t = strip(text).replace(/\.\.\.$/, '');
    let many = false;
    for (let i = 0; i < 3; i++) {
        const g = /^([\w.]+)\s*<(.*)>$/.exec(t);
        if (!g) break;
        const head = g[1].split('.').pop();
        if (MANY.test(head)) { many = true; t = splitTop(g[2]).pop().trim(); continue; }
        if (WRAP.test(head)) { t = g[2].trim(); continue; }
        break;
    }
    if (t.endsWith('[]')) { many = true; t = t.slice(0, -2); }
    const raw = /^([\w.]+)/.exec(t)?.[1]?.split('.').pop() ?? null;
    return { raw, many, text: strip(text) };
}

/** Split at commas outside <>, () and {}. */
function splitTop(s) {
    const out = [];
    let depth = 0, cur = '', q = false;
    for (const ch of s) {
        if (ch === '"') q = !q;
        if (!q && '<({'.includes(ch)) depth++;
        if (!q && '>)}'.includes(ch)) depth--;
        if (!q && ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

/** A parameter list's text (`(…)` after the name) → the parameters, with their line. */
function params(lines, s) {
    let text = '', depth = 0, started = false;
    const lineAt = [];
    for (let l = s.name_line; l <= Math.min(lines.length, s.name_line + 40); l++) {
        const src = l === s.name_line ? lines[l - 1].slice(s.name_col) : lines[l - 1];
        for (const ch of src) {
            if (ch === '(') { depth++; if (!started) { started = true; continue; } }
            if (ch === ')') { depth--; if (started && depth === 0) return parse(); }
            if (started) { text += ch; lineAt.push(l); }
        }
        if (started) { text += ' '; lineAt.push(l); }
    }
    return [];
    function parse() {
        const out = [];
        let at = 0;
        for (const part of splitTop(text)) {
            const offset = text.indexOf(part, at);
            at = offset + part.length;
            const anns = annotations(part);
            let rest = part;
            for (const a of [...anns].reverse()) rest = rest.slice(0, a.index) + rest.slice(a.index + a.length);
            const words = strip(rest).replace(/\bfinal\s+/, '').split(' ');
            if (words.length < 2) continue;
            const name = words.pop();
            const lead = part.length - part.trimStart().length;
            out.push({ name, type: words.join(' '), anns, line: lineAt[Math.min(lineAt.length - 1, offset + lead)] ?? s.name_line });
        }
        return out;
    }
}

/**
 * Beans and injection points of the repository's Java code. Each injection point carries the
 * beans it may receive (`from`) and why (`why`); see injection.mjs for the shapes.
 */
export function collectSpring(intel) {
    const files = intel.store.all(`SELECT id, path, package FROM files WHERE lang = 'java' AND is_test = 0`);
    if (!files.length) return { providers: [], injections: [] };
    const fileOf = new Map(files.map(f => [f.id, f]));
    const ids = files.map(f => f.id);
    const syms = [];
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        syms.push(...intel.store.all(`SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.file_id IN (${chunk.map(() => '?').join(',')})`, ...chunk));
    }
    const byId = new Map(syms.map(s => [s.id, s]));
    const children = new Map();
    for (const s of syms) if (s.parent_id != null) (children.get(s.parent_id) ?? children.set(s.parent_id, []).get(s.parent_id)).push(s);

    // what extends or implements what (inherit references bound by the index), for assignability
    const subs = new Map();
    for (const r of intel.store.all(`SELECT r.src_id, r.dst_id FROM refs r JOIN files f ON f.id = r.file_id WHERE r.kind = 'inherit' AND f.lang = 'java' AND r.dst_id IS NOT NULL AND r.src_id IS NOT NULL`)) {
        (subs.get(r.dst_id) ?? subs.set(r.dst_id, new Set()).get(r.dst_id)).add(r.src_id);
    }
    const supertypesCache = new Map();
    const supersOf = new Map();
    for (const [base, ss] of subs) for (const x of ss) (supersOf.get(x) ?? supersOf.set(x, []).get(x)).push(base);
    /** A type's id and the ids of everything it extends or implements (through the index). */
    const supers = (id) => {
        if (supertypesCache.has(id)) return supertypesCache.get(id);
        const out = new Set([id]);
        const stack = [id];
        while (stack.length) for (const b of supersOf.get(stack.pop()) ?? []) if (!out.has(b)) { out.add(b); stack.push(b); }
        supertypesCache.set(id, out);
        return out;
    };
    /** The names of a type's supertypes the index does not bind (library types), for name matching. */
    const superNames = (id) => {
        const out = new Set();
        for (const x of supers(id)) { const s = byId.get(x); if (!s) continue; out.add(s.name); for (const b of bases(s)) out.add(/^([\w.]+)/.exec(b)?.[1]?.split('.').pop()); }
        return out;
    };

    /** The definition a type name on lines [l0, l1] of a file is bound to. */
    const bindType = (fileId, l0, l1, name) => {
        if (!name) return null;
        const r = intel.store.get(`SELECT dst_id FROM refs WHERE file_id = ? AND name = ? AND line BETWEEN ? AND ? AND kind IN ('type', 'inherit') AND dst_id IS NOT NULL LIMIT 1`, fileId, name, l0, l1);
        return r ? (byId.get(r.dst_id) ?? intel.sym(r.dst_id)) : null;
    };

    // @MapperScan packages: the interfaces there are MyBatis mappers
    const mapperPackages = [];
    for (const s of syms) if (decorators(s).includes('MapperScan')) {
        const lines = intel.fileLines(s.path) ?? [];
        for (const a of annotations(headText(lines, s))) if (a.name === 'MapperScan') mapperPackages.push(...annotationNames(a.args, ['value', 'basePackages']));
    }

    // build modules: an application's beans are not another application's
    const moduleCache = new Map();
    const moduleOf = (rel) => {
        let dir = path.posix.dirname(rel);
        const seen = [];
        while (true) {
            if (moduleCache.has(dir)) { const m = moduleCache.get(dir); for (const d of seen) moduleCache.set(d, m); return m; }
            seen.push(dir);
            if (BUILD_FILES.some(b => fs.existsSync(path.join(intel.root, dir, b))) || dir === '.' || dir === '') {
                const m = dir === '' ? '.' : dir;
                for (const d of seen) moduleCache.set(d, m);
                return m;
            }
            dir = path.posix.dirname(dir);
        }
    };
    const apps = new Set(syms.filter(s => s.kind === 'class' && decorators(s).includes('SpringBootApplication')).map(s => moduleOf(s.path)));
    // which modules an application includes: its build file's dependencies on other modules here
    const mods = new Set(syms.map(s => moduleOf(s.path)));
    const deps = moduleDeps(intel.root, mods);
    const closure = (m) => { const out = new Set([m]), st = [m]; while (st.length) for (const d of deps.get(st.pop()) ?? []) if (!out.has(d)) { out.add(d); st.push(d); } return out; };
    const appMods = new Map([...apps].map(a => [a, closure(a)]));
    const known = [...deps.values()].some(d => d.size);
    // the applications a module is part of: itself if it is one, else those that include it
    // (without dependency information, every application, as a shared library)
    const appsOf = (m) => apps.has(m) ? [m] : [...apps].filter(a => !known || appMods.get(a).has(m));
    const visible = (pointFile, p) => {
        const a = moduleOf(pointFile), b = moduleOf(p.file);
        if (a === b || !apps.size) return true;
        const pa = appsOf(a);
        // a module no application includes: its own beans and those of other such modules
        if (!pa.length) return !appsOf(b).length || !known;
        return pa.some(x => known ? appMods.get(x).has(b) : (b === x || !apps.has(b)));
    };

    // @ConfigurationProperties classes are beans only when registered
    const enabledProps = new Set();
    let propsScan = false;
    for (const s of syms) {
        const dec = decorators(s);
        if (dec.includes('ConfigurationPropertiesScan')) propsScan = true;
        if (!dec.includes('EnableConfigurationProperties')) continue;
        for (const a of annotations(headText(intel.fileLines(s.path) ?? [], s))) if (a.name === 'EnableConfigurationProperties') for (const m of (a.args ?? '').matchAll(/([\w.]+)\.class/g)) enabledProps.add(m[1].split('.').pop());
    }
    const isBeanClass = (s, dec) => dec.some(d => STEREOTYPE.test(d) && d !== 'ConfigurationProperties') || (dec.includes('ConfigurationProperties') && (propsScan || enabledProps.has(s.name)));

    const providers = [];
    const conditionsOf = (anns) => anns.filter(a => CONDITION.test(a.name)).map(a => `@${a.name}${a.args != null ? `(${strip(a.args)})` : ''}`);
    for (const s of syms) {
        const dec = decorators(s);
        const lines = intel.fileLines(s.path) ?? [];
        if (s.kind === 'class' && isBeanClass(s, dec) && !/\babstract\b/.test(s.sig ?? '')) {
            const anns = annotations(headText(lines, s));
            const st = anns.find(a => STEREOTYPE.test(a.name) && (a.name !== 'ConfigurationProperties' || !dec.some(d => STEREOTYPE.test(d) && d !== 'ConfigurationProperties')));
            // @ConfigurationProperties("prefix") names a prefix, not the bean
            const name = (st?.name !== 'ConfigurationProperties' && annotationNames(st?.args)[0]) || beanName(s.name);
            providers.push({ how: `@${st?.name ?? dec.find(d => STEREOTYPE.test(d))}`, target: s, targetText: s.qname, name, primary: dec.includes('Primary'),
                qualifiers: anns.filter(a => a.name === 'Qualifier' || a.name === 'Named').flatMap(a => annotationNames(a.args)),
                conditions: conditionsOf(anns), types: supers(s.id), typeNames: superNames(s.id), file: s.path, line: s.start_line, exact: true });
        } else if (s.kind === 'method' && dec.includes('Bean')) {
            const anns = annotations(headText(lines, s));
            const ret = typeOf(s.type ?? '');
            const rt = bindType(s.file_id, s.start_line, s.name_line, ret.raw);
            const names = annotationNames(anns.find(a => a.name === 'Bean')?.args);
            providers.push({ how: '@Bean', target: s, targetText: `${s.qname}()`, name: names[0] ?? s.name, aliases: names.slice(1), primary: dec.includes('Primary'),
                qualifiers: anns.filter(a => a.name === 'Qualifier' || a.name === 'Named').flatMap(a => annotationNames(a.args)),
                conditions: conditionsOf(anns), types: rt ? supers(rt.id) : new Set(), typeNames: new Set([ret.raw, ...(rt ? superNames(rt.id) : [])]), returns: ret.raw, file: s.path, line: s.start_line, exact: !!rt });
        } else if (s.kind === 'interface') {
            // beans the framework generates: Feign proxies, Spring Data repositories, MyBatis mappers
            const pkg = fileOf.get(s.file_id)?.package ?? '';
            const repo = [...superNames(s.id)].some(n => n && /^(Repository|CrudRepository|ListCrudRepository|PagingAndSortingRepository|JpaRepository|MongoRepository|ElasticsearchRepository|ReactiveCrudRepository|R2dbcRepository|Neo4jRepository|CassandraRepository|QuerydslPredicateExecutor|JpaSpecificationExecutor|KeyValueRepository|RedisRepository)$/.test(n));
            const how = dec.includes('FeignClient') ? 'Feign client proxy'
                : repo ? 'Spring Data repository'
                : dec.includes('Mapper') || mapperPackages.some(p => pkg === p || pkg.startsWith(p + '.')) ? 'MyBatis mapper'
                : null;
            if (how) providers.push({ how, target: s, targetText: `${s.qname} (generated at run time)`, name: beanName(s.name), primary: how === 'Feign client proxy', qualifiers: [], conditions: [],
                types: supers(s.id), typeNames: superNames(s.id), generated: true, file: s.path, line: s.start_line, exact: true });
        }
    }
    for (const p of providers) p.key = `id:${p.target.id}`;

    /** The beans an injection point may receive, and why that one. */
    const resolve = ({ type, typeSym, qualifier, name, byName, file }) => {
        let cands = providers.filter(p => (typeSym ? p.types.has(typeSym.id) : p.typeNames.has(type.raw)) && visible(file, p));
        // a shared module's injection point: each application that includes it brings its own bean
        const perApp = !apps.has(moduleOf(file)) && new Set(cands.flatMap(p => appsOf(moduleOf(p.file)).length === 1 && apps.has(moduleOf(p.file)) ? [moduleOf(p.file)] : [])).size > 1;
        let why = typeSym ? 'by type' : `by type name ${type.raw} (a type the index does not bind)`;
        if (byName) {
            const n = providers.filter(p => p.name === name && (cands.includes(p)));
            if (n.length === 1) return { from: n, why: `by name "${name}" (@Resource)` };
        }
        if (qualifier) {
            cands = cands.filter(p => p.name === qualifier || p.aliases?.includes(qualifier) || p.qualifiers.includes(qualifier));
            return { from: cands, why: `@Qualifier("${qualifier}")` };
        }
        if (type.many) return { from: cands, why: `every bean of type ${type.raw}` };
        if (perApp) return { from: cands, why: 'the bean of the application that includes this module (one per application)' };
        if (cands.length > 1) {
            const prim = cands.filter(p => p.primary);
            if (prim.length === 1) return { from: prim, why: `@Primary, over ${cands.filter(p => p !== prim[0]).map(p => p.target.name).join(', ')}`, others: cands.filter(p => p !== prim[0]) };
            const byParam = cands.filter(p => p.name === name || p.aliases?.includes(name));
            if (byParam.length === 1) return { from: byParam, why: `by the name "${name}"`, others: cands.filter(p => p !== byParam[0]) };
            const why2 = cands.every(p => p.conditions.length) ? 'one of these, by the active profile or conditions' : 'ambiguous: several beans match and none is @Primary or named so';
            return { from: cands, why: why2 };
        }
        return { from: cands, why };
    };

    const injections = [];
    const point = (owner, s, decl, line, anns, extra = {}) => {
        if (anns.some(a => a.name === 'Value')) return;
        const type = typeOf(decl.type);
        if (!type.raw || /^(String|int|long|boolean|double|float|short|byte|char|Integer|Long|Boolean|Double|Object)$/.test(type.raw)) return;
        const typeSym = bindType(s.file_id, Math.min(line, s.start_line), Math.max(line, s.name_line) + 1, type.raw);
        const qualifier = anns.filter(a => a.name === 'Qualifier' || a.name === 'Named').flatMap(a => annotationNames(a.args))[0] ?? null;
        const res = anns.find(a => a.name === 'Resource');
        const name = (res && annotationNames(res.args, ['name'])[0]) || decl.name;
        const r = resolve({ type, typeSym, qualifier, name, byName: !!res, file: s.path });
        injections.push({ key: typeSym ? `id:${typeSym.id}` : `text:${type.raw}`, token: typeSym?.qname ?? type.raw, exact: !!typeSym, owner, param: decl.name, type: type.text,
            file: s.path, line, framework: 'spring', ...r, ...extra });
    };
    // Spring injects only into beans: a class that is one, that a @Bean method returns, or that a bean extends
    const beanIds = new Set(providers.filter(p => !p.generated && p.how !== '@Bean').map(p => p.target.id));
    const returned = new Set(providers.filter(p => p.how === '@Bean').map(p => p.returns));
    // a @Bean declared as an interface but returning `new Impl(…)`: Impl is the bean
    for (const p of providers) if (p.how === '@Bean') {
        const body = (intel.fileLines(p.target.path) ?? []).slice(p.target.start_line - 1, p.target.end_line).join('\n');
        for (const m of body.matchAll(/\bnew\s+([A-Z][\w]*)\s*[(<]/g)) returned.add(m[1]);
    }
    const isBeanOwner = (c) => {
        if (!c) return false;
        if (beanIds.has(c.id) || returned.has(c.name)) return true;
        const stack = [c.id], seen = new Set(stack);
        while (stack.length) for (const x of subs.get(stack.pop()) ?? []) {
            const k = byId.get(x);
            if (beanIds.has(x) || (k && returned.has(k.name))) return true;
            if (!seen.has(x)) { seen.add(x); stack.push(x); }
        }
        return false;
    };
    for (const s of syms) {
        const dec = decorators(s);
        const lines = intel.fileLines(s.path) ?? [];
        const owner = s.parent_id != null ? byId.get(s.parent_id) ?? null : null;
        if (!isBeanOwner(owner)) continue;
        if (s.kind === 'field' && dec.some(d => POINT.test(d)) && !s.is_static) {
            const head = headText(lines, s);
            const anns = annotations(head);
            let rest = head;
            for (const a of [...anns].reverse()) rest = rest.slice(0, a.index) + rest.slice(a.index + a.length);
            const words = strip(rest).split(' ').filter(w => w && !MODIFIER.test(w));
            point(owner, s, { name: s.name, type: words.join(' ') || s.type || '' }, s.name_line, anns);
        } else if ((s.kind === 'method' || s.kind === 'constructor') && (dec.some(d => POINT.test(d)) || dec.includes('Bean'))) {
            for (const p of params(lines, s)) point(owner, s, p, p.line, p.anns, dec.includes('Bean') ? { via: `@Bean ${s.name}()` } : {});
        }
    }
    // constructor injection: a component's only constructor, or its @Autowired one (handled above)
    for (const p of providers) {
        // constructor binding of @ConfigurationProperties takes properties, not beans
        if (p.how === '@Bean' || p.how === '@ConfigurationProperties' || p.generated) continue;
        const kids = children.get(p.target.id) ?? [];
        const ctors = kids.filter(k => k.kind === 'constructor');
        const lines = intel.fileLines(p.target.path) ?? [];
        if (ctors.length === 1 && !decorators(ctors[0]).some(d => POINT.test(d))) {
            for (const x of params(lines, ctors[0])) point(p.target, ctors[0], x, x.line, x.anns);
        } else if (!ctors.length && decorators(p.target).some(d => d === 'RequiredArgsConstructor' || d === 'AllArgsConstructor')) {
            const all = decorators(p.target).includes('AllArgsConstructor');
            for (const f of kids.filter(k => k.kind === 'field' && !k.is_static && !decorators(k).some(d => POINT.test(d)))) {
                const head = headText(lines, f);
                if (!all && !/\bfinal\b/.test(head)) continue;
                const anns = annotations(head);
                let rest = head;
                for (const a of [...anns].reverse()) rest = rest.slice(0, a.index) + rest.slice(a.index + a.length);
                const words = strip(rest).split(' ').filter(w => w && !MODIFIER.test(w));
                point(p.target, f, { name: f.name, type: words.join(' ') || f.type || '' }, f.name_line, anns, { via: '@RequiredArgsConstructor' });
            }
        }
    }
    return { providers, injections };
}
