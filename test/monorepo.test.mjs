/**
 * A product monorepo, measured against the TypeScript compiler (bench/eval-graph.mjs on Twenty):
 * each case here is one the compiler answered differently before it was fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

const S = 'packages/server/src/';
const FILES = {
    'tsconfig.base.json': '{ "compilerOptions": { "target": "es2018" } }\n',
    'packages/server/tsconfig.json': '{\n  "extends": "../../tsconfig.base.json",\n  // aliases of this package only\n  "compilerOptions": { "paths": { "src/*": ["./src/*"], "@/*": ["./src/lib/*"] } }\n}\n',
    'packages/front/tsconfig.json': '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/modules/*"] } } }\n',
    [S + 'lib/cache.ts']: 'export function sweepLocalCache(cache: Map<string, number>): number { return cache.size; }\nexport const format = (n: number) => String(n);\n',
    [S + 'engine/cache.service.ts']: [
        "import { sweepLocalCache } from 'src/lib/cache';",
        "import { format } from '@/cache';",
        '',
        'export class CacheService {',
        '  private local = new Map<string, number>();',
        '  sweepLocalCache(): string {',
        '    return format(sweepLocalCache(this.local));',
        '  }',
        '}',
        '',
    ].join('\n'),
    [S + 'engine/user.service.ts']: [
        "import { CacheService } from 'src/engine/cache.service';",
        '',
        'export class UserService {',
        '  constructor(private readonly cache: CacheService) {}',
        '  run(): string { return this.cache.sweepLocalCache(); }',
        '}',
        '',
    ].join('\n'),
    'packages/front/src/modules/cache.ts': 'export const format = (n: number) => `#${n}`;\n',
    'packages/front/src/app.ts': "import { format } from '@/cache';\nexport const label = format(1);\n",
    [S + 'dto/event.dto.ts']: 'export class EventPropertiesDTO { name!: string; }\n',
    [S + 'dto/event-list.dto.ts']: [
        "import { EventPropertiesDTO } from 'src/dto/event.dto';",
        '',
        'function Field(type: () => unknown): PropertyDecorator { return () => {}; }',
        '',
        'export class EventListDTO {',
        '  @Field(() => EventPropertiesDTO)',
        '  properties!: EventPropertiesDTO;',
        '}',
        '',
    ].join('\n'),
    [S + 'chart/fill.ts']: [
        'export function fillDateGaps(xs: number[]): number[] { return xs; }',
        'export function fillSelectGaps(xs: number[]): number[] { return xs; }',
        '',
    ].join('\n'),
    [S + 'chart/apply.ts']: [
        "import { fillDateGaps, fillSelectGaps } from './fill';",
        '',
        'export function applyGapFilling(dates: boolean, xs: number[]): number[] {',
        '  const fill = dates',
        '    ? fillDateGaps',
        '    : fillSelectGaps;',
        '  return fill(xs);',
        '}',
        'export const fillers: { fillSelectGaps: typeof fillSelectGaps } = {',
        '  fillSelectGaps,',
        '};',
        '',
    ].join('\n'),
};

let root, intel;
test.before(async () => {
    root = makeRepo(FILES);
    intel = new CodeIntel({ root });
    await intel.open();
});
test.after(() => { intel?.close(); rmrf(root); });

const sym = (qname, file) => intel.store.get('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qname = ? AND f.path = ?', qname, file)?.id;
const refs = (qname, file) => [...intel.references(sym(qname, file)).groups.values()].flat();
const at = (rs, file, line) => rs.some(r => r.path === file && r.line === line);

test('monorepo: each package resolves its own path aliases', () => {
    assert.ok(at(refs('CacheService', S + 'engine/cache.service.ts'), S + 'engine/user.service.ts', 4), "'src/…' is the server's alias");
    assert.ok(at(refs('format', S + 'lib/cache.ts'), S + 'engine/cache.service.ts', 7), "the server's '@/…'");
    assert.ok(!at(refs('format', S + 'lib/cache.ts'), 'packages/front/src/app.ts', 2), "the front's '@/…' is another directory");
    assert.ok(at(refs('format', 'packages/front/src/modules/cache.ts'), 'packages/front/src/app.ts', 2));
});

test('monorepo: a bare call inside a method is never the method itself', () => {
    const free = refs('sweepLocalCache', S + 'lib/cache.ts');
    assert.ok(at(free, S + 'engine/cache.service.ts', 7), 'the imported function');
    assert.ok(!at(refs('CacheService.sweepLocalCache', S + 'engine/cache.service.ts'), S + 'engine/cache.service.ts', 7), 'a method needs this.');
    assert.ok(at(refs('CacheService.sweepLocalCache', S + 'engine/cache.service.ts'), S + 'engine/user.service.ts', 5));
});

test('monorepo: a class named inside a decorator argument is a use', () => {
    assert.ok(at(refs('EventPropertiesDTO', S + 'dto/event.dto.ts'), S + 'dto/event-list.dto.ts', 6));
});

test('monorepo: functions used as values', () => {
    assert.ok(at(refs('fillDateGaps', S + 'chart/fill.ts'), S + 'chart/apply.ts', 5), 'a branch of a conditional');
    const sel = refs('fillSelectGaps', S + 'chart/fill.ts');
    assert.ok(at(sel, S + 'chart/apply.ts', 6), 'the other branch');
    assert.ok(at(sel, S + 'chart/apply.ts', 9), 'typeof');
    assert.ok(at(sel, S + 'chart/apply.ts', 10), 'a shorthand property');
});

test('monorepo: destructured values and Pick<> keep their types', async () => {
    const root2 = makeRepo({
        'src/manager.ts': 'export class OrmManager { getRepository(name: string) { return name; } }\nexport interface Command { runOnWorkspace(id: string): void; }\n',
        'src/cmd.ts': "import { Command } from './manager';\nexport class BackfillCommand implements Command { runOnWorkspace(id: string): void {} }\n",
        'src/deps.ts': "import { OrmManager } from './manager';\nexport type Deps = { ormManager: OrmManager; other: string };\n",
        'src/tool.ts': [
            "import { Deps } from './deps';",
            "import { Command } from './manager';",
            '',
            "export function listTool(deps: Pick<Deps, 'ormManager'>) {",
            "  return deps.ormManager.getRepository('dashboard');",
            '}',
            'export function run({ entry, id }: { entry: { command: Command; name: string }; id: string }) {',
            '  const { name, command: cmd } = entry;',
            '  cmd.runOnWorkspace(id);',
            '  return name;',
            '}',
            'export function use({ ormManager }: Deps) {',
            "  return ormManager.getRepository('x');",
            '}',
            '',
        ].join('\n'),
    });
    const i2 = new CodeIntel({ root: root2 });
    await i2.open();
    try {
        const r = (q) => [...i2.references(i2.store.get('SELECT id FROM symbols WHERE qname = ?', q).id).groups.values()].flat();
        const get = r('OrmManager.getRepository');
        assert.ok(at(get, 'src/tool.ts', 5), 'Pick<Deps, …> has Deps\' members');
        assert.ok(at(get, 'src/tool.ts', 13), 'a destructured parameter of a named type');
        assert.ok(at(r('Command.runOnWorkspace'), 'src/tool.ts', 9), 'a property destructured from an inline object type');
        assert.ok(at(r('BackfillCommand.runOnWorkspace'), 'src/tool.ts', 9), 'a call through the interface may run an implementation');
    } finally { i2.close(); rmrf(root2); }
});

test('monorepo: a type alias has the members of the types it is made of', async () => {
    const root3 = makeRepo({
        'src/cmd.ts': 'export interface Command { runOnWorkspace(id: string): void; }\nexport class Backfill implements Command { runOnWorkspace(id: string): void {} }\nexport type Registered = { name: string; command: Command; version: string };\n',
        'src/runner.ts': [
            "import { Registered } from './cmd';",
            '',
            "type Entry = Pick<Registered, 'name' | 'command'>;",
            'type Tagged = Entry & { tag: string };',
            '',
            'export function run(entry: Entry, tagged: Tagged) {',
            '  const { command } = entry;',
            "  command.runOnWorkspace('w');",
            "  tagged.command.runOnWorkspace('t');",
            '}',
            '',
        ].join('\n'),
    });
    const i3 = new CodeIntel({ root: root3 });
    await i3.open();
    try {
        const refs3 = [...i3.references(i3.store.get('SELECT id FROM symbols WHERE qname = ?', 'Backfill.runOnWorkspace').id).groups.values()].flat();
        assert.ok(at(refs3, 'src/runner.ts', 8), 'Pick<> of a type alias');
        assert.ok(at(refs3, 'src/runner.ts', 9), 'an intersection');
    } finally { i3.close(); rmrf(root3); }
});
