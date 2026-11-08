/**
 * ORM models, their tables, the migrations that touch them and, for Prisma, the client calls that
 * use them: links the compiler does not make, since a migration names its table in a string and
 * Prisma's client is generated outside the repository (`prisma.envelope.findFirst(…)` is typed
 * only by `node_modules/.prisma`).
 *
 * Models recognised:
 *   - Prisma: `model Name { … }` in `*.prisma` files, table `@@map("…")` or the model's name;
 *   - Django: classes deriving from `models.Model` (directly or through other models, abstract
 *     ones left out), table `Meta.db_table` or `<app_label>_<name>`, the app label from `Meta`
 *     (inherited from an abstract base) or the app's directory; a proxy model has its base's table;
 *   - SQLAlchemy / SQLModel: classes with `__tablename__`, or `table=True` (SQLModel names the
 *     table after the class, lower-cased);
 *   - TypeORM: `@Entity('name')` / `@Entity({ name, schema })`, or `@Entity()` (the class name in
 *     snake_case, TypeORM's default naming).
 * Migrations: files under a directory whose name holds `migration` (or Alembic's `versions`), and
 * code that drives TypeORM's `queryRunner` elsewhere (upgrade commands). A table is touched by SQL
 * that names it (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `RENAME TO`, `INSERT INTO`, `UPDATE`,
 * `DELETE FROM`, an index `ON` it, a foreign key `REFERENCES` it, a read `FROM` / `JOIN` it), by
 * Alembic's `op.*('table', …)` and `batch_alter_table`, by TypeORM's `queryRunner.*Table` /
 * `*Column`(…'table'…); a Django model by its app's `migrations.CreateModel(name=…)` and
 * `model_name=…` operations and by data migrations' `apps.get_model('app', 'Model')`.
 * Django models whose base comes from a library (auth's `AbstractUser`, treebeard, mptt,
 * polymorphic) are recognised by name.
 * Prisma client calls: `<client>.<model>.<operation>(` where the client is named `prisma…`, `db`,
 * `tx`/`trx`, `client` or `…Prisma`, and the operation is one of Prisma's model methods.
 * Test files are left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PRISMA_OPS = 'findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany|count|aggregate|groupBy';
const PRISMA_CALL = new RegExp(`\\b(prisma\\w*|\\w*Prisma|db|tx|trx|client|transaction)\\s*\\.\\s*([a-z]\\w*)\\s*\\.\\s*(${PRISMA_OPS})\\s*[(<]`, 'g');
const MIGRATION_DIR = /(^|\/)([^/]*migrations?[^/]*|versions)\//i;
const SQL_TABLE = /\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|RENAME\s+TO|REFERENCES|FROM|JOIN|ON)\s+((?:[`"[]?\w+[`"\]]?\s*\.\s*)?[`"[]?\w+[`"\]]?)/gi;
const ALEMBIC = /\bop\.(create_primary_key|create_table|drop_table|add_column|drop_column|alter_column|rename_table|create_index|drop_index|create_foreign_key|create_unique_constraint|create_check_constraint|drop_constraint|bulk_insert|batch_alter_table)\s*\(/g;
const TYPEORM_RUNNER = /\bqueryRunner\.(createTable|dropTable|renameTable|addColumn|addColumns|dropColumn|dropColumns|changeColumn|renameColumn|createIndex|dropIndex|createForeignKey|createForeignKeys|dropForeignKey|createUniqueConstraint|dropUniqueConstraint|createPrimaryKey|clearTable)\s*\(\s*['"`]((?:\w+\.)?\w+)['"`]/g;
const DJANGO_OP = /\bmigrations\.(\w+)\s*\(([^)]*?)\b(name|model_name)\s*=\s*['"](\w+)['"]/g;

const EXTERNAL_MODEL_BASES = /^(?:\w+\.)*(AbstractUser|AbstractBaseUser|MP_Node|NS_Node|AL_Node|MPTTModel|PolymorphicModel|TimeStampedModel)$/;
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
const unquote = (s) => s.replace(/[`"[\]\s]/g, '');
const decorators = (s) => { try { return JSON.parse(s.decorators || '[]'); } catch { return []; } };

/** Repository files matching a test, indexed or not (`*.prisma`, migration `.sql`): git's list, else a bounded walk. */
function repoFiles(root, test) {
    const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 << 20 });
    if (r.status === 0 && r.stdout) return r.stdout.split('\0').filter(f => f && test(f));
    const out = [];
    const walk = (dir, depth) => {
        if (depth > 8 || out.length > 5000) return;
        let ents = [];
        try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const rel = dir ? `${dir}/${e.name}` : e.name;
            if (e.isDirectory()) walk(rel, depth + 1); else if (test(rel)) out.push(rel);
        }
    };
    walk('', 0);
    return out;
}

function readLines(intel, rel) {
    const l = intel.fileLines(rel);
    if (l) return l;
    try { return fs.readFileSync(path.join(intel.root, rel), 'utf8').split(/\r?\n/); } catch { return null; }
}

/** Prisma models of every `.prisma` file. */
function prismaModels(intel) {
    const out = [];
    for (const rel of repoFiles(intel.root, f => f.endsWith('.prisma') && !f.includes('node_modules/'))) {
        const lines = readLines(intel, rel) ?? [];
        let cur = null;
        lines.forEach((l, i) => {
            const m = /^\s*model\s+(\w+)\s*\{/.exec(l);
            if (m) { cur = { orm: 'Prisma', name: m[1], sym: null, table: m[1], file: rel, line: i + 1, end: i + 1 }; out.push(cur); return; }
            if (!cur) return;
            const map = /^\s*@@map\(\s*(?:name\s*:\s*)?["']([^"']+)["']/.exec(l);
            if (map) cur.table = map[1];
            if (/^\s*\}/.test(l)) { cur.end = i + 1; cur = null; }
        });
    }
    return out;
}

/** The text of a class's body (its own lines), for `class Meta`, `__tablename__`. */
const bodyOf = (intel, s) => (intel.fileLines(s.path) ?? []).slice(s.start_line - 1, s.end_line).join('\n');

/** Django, SQLAlchemy/SQLModel and TypeORM models among the indexed classes. */
function classModels(intel) {
    const out = [];
    const classes = intel.store.all(`SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.decorators, s.bases, s.sig, s.parent_id, f.path, f.lang
        FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind = 'class' AND f.is_test = 0 AND f.lang IN ('python', 'typescript', 'tsx', 'javascript')`);
    const byId = new Map(classes.map(c => [c.id, c]));
    const basesOf = new Map();
    for (const r of intel.store.all(`SELECT src_id, dst_id FROM refs WHERE kind = 'inherit' AND dst_id IS NOT NULL AND src_id IS NOT NULL`)) (basesOf.get(r.src_id) ?? basesOf.set(r.src_id, []).get(r.src_id)).push(r.dst_id);
    const bases = (c) => { try { return JSON.parse(c.bases || '[]'); } catch { return []; } };
    const meta = (c) => {
        const body = bodyOf(intel, c);
        const m = /\n\s*class\s+Meta\b[^:]*:([\s\S]*?)(?=\n\s{0,8}(?:def|class|@)\s|\n\S|$)/.exec(body)?.[1] ?? '';
        return {
            abstract: /\babstract\s*=\s*True\b/.test(m),
            proxy: /\bproxy\s*=\s*True\b/.test(m),
            appLabel: /\bapp_label\s*=\s*['"](\w+)['"]/.exec(m)?.[1] ?? null,
            dbTable: /\bdb_table\s*=\s*['"]([^'"]+)['"]/.exec(m)?.[1] ?? null,
        };
    };
    // Django: a class is a model if a base is `models.Model` or a model, through the index
    const djangoMemo = new Map();
    const isDjango = (c, seen = new Set()) => {
        if (djangoMemo.has(c.id)) return djangoMemo.get(c.id);
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        // a base from django or a library of models (auth's users, treebeard, mptt, polymorphic …)
        let v = c.lang === 'python' && bases(c).some(b => (/^(models\.)?Model$/.test(String(b).trim()) || EXTERNAL_MODEL_BASES.test(String(b).trim())) && /\bmodels\b|django|treebeard|mptt|polymorphic/.test(bodyOrHead(c)));
        if (!v) for (const b of basesOf.get(c.id) ?? []) { const bc = byId.get(b); if (bc && isDjango(bc, seen)) { v = true; break; } }
        djangoMemo.set(c.id, v);
        return v;
    };
    function bodyOrHead(c) {
        // the module imports django's models (`from django.db import models`): read its first lines once
        const lines = intel.fileLines(c.path) ?? [];
        return lines.slice(0, 80).join('\n');
    }
    const inheritedMeta = (c, key, seen = new Set()) => {
        if (seen.has(c.id)) return null;
        seen.add(c.id);
        const v = meta(c)[key];
        if (v) return v;
        for (const b of basesOf.get(c.id) ?? []) { const bc = byId.get(b); const x = bc && inheritedMeta(bc, key, seen); if (x) return x; }
        return null;
    };
    for (const c of classes) {
        if (c.lang === 'python') {
            const body = bodyOf(intel, c);
            const tn = /^\s*__tablename__\s*=\s*['"]([^'"]+)['"]/m.exec(body)?.[1];
            if (tn) { out.push({ orm: 'SQLAlchemy', name: c.name, sym: c, table: tn, file: c.path, line: c.start_line }); continue; }
            if (/\btable\s*=\s*True\b/.test(c.sig ?? body.split('\n')[0])) { out.push({ orm: 'SQLModel', name: c.name, sym: c, table: c.name.toLowerCase(), file: c.path, line: c.start_line }); continue; }
            if (isDjango(c) && !meta(c).abstract) {
                const dir = path.posix.dirname(c.path);
                const appDir = /\/models$/.test(dir) ? path.posix.dirname(dir) : dir;
                const label = inheritedMeta(c, 'appLabel') ?? path.posix.basename(appDir);
                // a proxy model has no table of its own: its concrete base's
                const proxyOf = meta(c).proxy ? (basesOf.get(c.id) ?? []).map(b => byId.get(b)).find(b => b && isDjango(b)) ?? null : null;
                out.push({ orm: 'Django', name: c.name, sym: c, table: inheritedMeta(c, 'dbTable') ?? `${label}_${c.name.toLowerCase()}`, label, proxyOf, appDir, file: c.path, line: c.start_line });
            }
        } else {
            // `@Entity(…)` right above the class (an exported class's decorators are not stored on it)
            const lines = intel.fileLines(c.path) ?? [];
            let top = c.start_line - 1; // the decorators: the lines above the class up to the previous statement
            while (top > 0 && top > c.start_line - 150) {
                const l = lines[top - 1].trim();
                if (/;$/.test(l) || /^(import|export|class|const|let|var|function|interface|type)\b/.test(l) || l === '}') break;
                top--;
            }
            const last = lines.slice(top, c.start_line - 1).join('\n');
            if (!decorators(c).includes('Entity') && !/@Entity\(/.test(last)) continue;
            const head = decorators(c).includes('Entity') ? (intel.fileLines(c.path) ?? []).slice(Math.max(0, c.start_line - 6), c.start_line + 1).join('\n') : last;
            const e = /@Entity\(\s*(?:['"`]([^'"`]+)['"`]|\{([^}]*)\})?/.exec(head);
            const name = e?.[1] ?? /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(e?.[2] ?? '')?.[1] ?? null;
            const schema = /\bschema\s*:\s*['"`]([^'"`]+)['"`]/.exec(e?.[2] ?? '')?.[1] ?? null;
            out.push({ orm: 'TypeORM', name: c.name, sym: c, table: name ?? snake(c.name), schema, defaultName: !name, file: c.path, line: c.start_line });
        }
    }
    // proxies take their base's table (resolved through proxies of proxies)
    const byClass = new Map(out.filter(m => m.sym).map(m => [m.sym.id, m]));
    for (const m of out) {
        let base = m.proxyOf, guard = 0;
        while (base && guard++ < 8) {
            const bm = byClass.get(base.id);
            if (bm && !bm.proxyOf) { m.table = bm.table; m.appDir = bm.appDir; m.proxyName = bm.name; break; }
            base = bm?.proxyOf ?? null;
        }
    }
    return out;
}

/** Every table a migration file touches: [{ table (lower case, unqualified), schema, file, line, op }], and Django operations by model. */
function migrationRefs(intel) {
    const tables = [], django = [];
    const files = repoFiles(intel.root, f => MIGRATION_DIR.test(f) && /\.(sql|py|ts|js|mjs|cjs)$/.test(f) && !f.includes('node_modules/'));
    // schema changes outside a migrations directory (upgrade commands): code that drives TypeORM's queryRunner
    const seen = new Set(files);
    for (const r of intel.store.all(`SELECT DISTINCT f.path FROM refs r JOIN files f ON f.id = r.file_id WHERE r.recv = 'queryRunner' AND f.is_test = 0`)) if (!seen.has(r.path)) { seen.add(r.path); files.push(r.path); }
    for (const rel of files) {
        const lines = readLines(intel, rel);
        if (!lines) continue;
        const text = lines.join('\n');
        const lineAt = (off) => text.slice(0, off).split('\n').length;
        const isPy = /\.py$/.test(rel);
        const add = (raw, off, op) => {
            const parts = unquote(raw).split('.');
            const table = parts.pop();
            if (!table || /^(SET|SELECT|TABLE|IF|ONLY|EXISTS|DELETE|UPDATE|NOT|CONFLICT|LATERAL|DUAL|INSERT|VALUES|WHERE)$/i.test(table)) return;
            tables.push({ table: table.toLowerCase(), schema: parts.pop() ?? null, file: rel, line: lineAt(off), op });
        };
        for (const m of text.matchAll(SQL_TABLE)) {
            const kw = m[1].replace(/\s+/g, ' ').toUpperCase();
            // `ON` is an index's table only after CREATE [UNIQUE] INDEX …
            if (kw === 'ON' && !/CREATE\s+(UNIQUE\s+)?INDEX\b[^;]*$/i.test(text.slice(Math.max(0, m.index - 300), m.index))) continue;
            // `UPDATE t [AS] alias SET`: a statement, not the word in prose or a column name
            if (kw === 'UPDATE' && !/^\s*(?:(?:AS\s+)?\w+\s+)?SET\b/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 60))) continue;
            // reads (`FROM`, `JOIN`) in SQL only: in Python, `from x import y` is no table
            if ((kw === 'FROM' || kw === 'JOIN') && isPy && !/^["`]/.test(m[2]) && !/(execute|RunSQL|text)\s*\(/.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index))) continue;
            add(m[2], m.index, kw.split(' ').slice(0, 2).join(' '));
        }
        for (const m of text.matchAll(ALEMBIC)) {
            const args = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
            // the table: the first string argument (the second for create_index / create_foreign_key …), or table_name=
            const named = /\btable_name\s*=\s*['"](\w+)['"]/.exec(args.split(')')[0] ?? '')?.[1];
            const strs = [...args.matchAll(/['"](\w+)['"]/g)].map(x => x[1]);
            const viaF = /^\s*op\.f\(/.test(args);
            let table = named;
            if (!table) table = /^(create_index|create_unique_constraint|create_check_constraint|create_primary_key|drop_constraint|drop_index)$/.test(m[1]) || viaF ? strs[1] : strs[0];
            if (m[1] === 'create_foreign_key') {
                // (name, source, referent, …); the name may be None
                const [src, ref] = /^\s*None\b/.test(args) ? [strs[0], strs[1]] : [strs[1], strs[2]];
                if (src) tables.push({ table: src.toLowerCase(), schema: null, file: rel, line: lineAt(m.index), op: m[1] });
                if (ref) tables.push({ table: ref.toLowerCase(), schema: null, file: rel, line: lineAt(m.index), op: `${m[1]} (referenced)` });
                continue;
            }
            if (table) tables.push({ table: table.toLowerCase(), schema: null, file: rel, line: lineAt(m.index), op: m[1] });
        }
        for (const m of text.matchAll(TYPEORM_RUNNER)) add(m[2], m.index, m[1]);
        if (isPy) {
            for (const m of text.matchAll(DJANGO_OP)) django.push({ model: m[4].toLowerCase(), dir: path.posix.dirname(rel), file: rel, line: lineAt(m.index), op: m[1] });
            // data migrations: `apps.get_model("catalogue", "Option")`
            for (const m of text.matchAll(/\bget_model\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]/g)) django.push({ model: m[2].toLowerCase(), label: m[1], file: rel, line: lineAt(m.index), op: 'get_model (data migration)' });
        }
    }
    return { tables, django };
}

/** Prisma client calls in the indexed TypeScript/JavaScript: [{ model (lower-first), op, file, line }]. */
function prismaCalls(intel, models) {
    const names = new Set(models.map(m => m.name[0].toLowerCase() + m.name.slice(1)));
    const out = [];
    for (const f of intel.store.all(`SELECT id, path FROM files WHERE lang IN ('typescript', 'tsx', 'javascript', 'vue', 'svelte') AND is_test = 0`)) {
        const lines = intel.fileLines(f.path);
        if (!lines) continue;
        lines.forEach((l, i) => {
            if (!l.includes('.')) return;
            for (const m of l.matchAll(PRISMA_CALL)) if (names.has(m[2])) out.push({ model: m[2], op: m[3], fileId: f.id, file: f.path, line: i + 1, client: m[1] });
        });
    }
    return out;
}

/**
 * Models with their table, the migrations that touch it and (Prisma) the client calls:
 * [{ orm, name, sym, table, file, line, migrations: [{ file, line, op }], calls: [{ file, line, op, owner }] }].
 */
export function collectModels(intel) {
    if (intel._orm?.version === intel.ix?.version) return intel._orm.data;
    const prisma = prismaModels(intel);
    const models = [...prisma, ...classModels(intel)];
    if (!models.length) { intel._orm = { version: intel.ix?.version, data: [] }; return []; }
    const { tables, django } = migrationRefs(intel);
    const byTable = new Map();
    for (const t of tables) (byTable.get(t.table) ?? byTable.set(t.table, []).get(t.table)).push(t);
    const calls = prisma.length ? prismaCalls(intel, prisma) : [];
    for (const m of models) {
        const table = m.table.toLowerCase().split('.').pop();
        m.migrations = (byTable.get(table) ?? []).filter(t => !m.schema || !t.schema || t.schema.toLowerCase() === m.schema.toLowerCase());
        if (m.orm === 'Django') m.migrations.push(...django.filter(d => d.model === (m.proxyName ?? m.name).toLowerCase() && (d.label ? d.label === m.label : d.dir === `${m.appDir}/migrations`)));
        m.migrations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        m.calls = m.orm === 'Prisma' ? calls.filter(c => c.model === m.name[0].toLowerCase() + m.name.slice(1)) : [];
        for (const c of m.calls) c.owner ??= intel.store.get(`SELECT qname FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ? AND kind IN ('function', 'method', 'variable', 'constant') ORDER BY start_line DESC LIMIT 1`, c.fileId, c.line, c.line)?.qname ?? null;
    }
    intel._orm = { version: intel.ix?.version, data: models };
    return models;
}

/** The model a class symbol is, if any. */
export function modelOf(intel, id) {
    return collectModels(intel).find(m => m.sym?.id === id) ?? null;
}

/** Prisma models named so (case-insensitive), for a name that is no indexed symbol. */
export function prismaModelsNamed(intel, name) {
    const n = String(name ?? '').toLowerCase();
    return collectModels(intel).filter(m => m.orm === 'Prisma' && m.name.toLowerCase() === n);
}
