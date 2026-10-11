import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { collectInjection } from '../src/query/injection.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

test('dependency injection (NestJS): tokens, providers and injection points', async (t) => {
    const root = makeRepo({
        'src/logger/tokens.ts': "export const LOGGER_DRIVER = Symbol('LOGGER_DRIVER');\n",
        'src/logger/console.driver.ts': 'export class ConsoleDriver {\n  log(m: string) { console.log(m); }\n}\n',
        'src/logger/logger.module.ts': [
            "import { Module } from '@nestjs/common';",
            "import { LOGGER_DRIVER } from './tokens';",
            "import { ConsoleDriver } from './console.driver';",
            "import { LoggerService } from './logger.service';",
            '@Module({',
            '  providers: [',
            '    LoggerService,',
            '    {',
            '      provide: LOGGER_DRIVER,',                                   // 9
            '      useClass: ConsoleDriver,',
            '    },',
            "    { provide: 'APP_NAME', useValue: 'demo' },",                 // 12
            '  ],',
            '})',
            'export class LoggerModule {}',
            '',
        ].join('\n'),
        'src/logger/logger.service.ts': [
            "import { Inject, Injectable } from '@nestjs/common';",
            "import { LOGGER_DRIVER } from './tokens';",
            'export interface Driver { log(m: string): void }',
            '@Injectable()',
            'export class LoggerService {',
            '  constructor(',
            '    @Inject(LOGGER_DRIVER) private readonly driver: Driver,',     // 7
            "    @Inject('APP_NAME') private readonly app: string,",          // 8
            '  ) {}',
            '  info(m: string) { this.driver.log(this.app + m); }',
            '}',
            '',
        ].join('\n'),
        'src/provider.interface.ts': 'export interface ClassProvider {\n  provide: string;\n  useClass: unknown;\n}\n',
        'src/logger/logger.service.spec.ts': "import { LOGGER_DRIVER } from './tokens';\nconst m = { provide: LOGGER_DRIVER, useValue: { log: jest.fn() } };\n",
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });

    const { providers, injections } = collectInjection(intel);
    assert.deepEqual(providers.map(p => `${p.file}:${p.line} ${p.how}`), ['src/logger/logger.module.ts:9 useClass', 'src/logger/logger.module.ts:12 useValue'], 'object providers only: not interface members, not test mocks');
    assert.equal(providers[0].target?.qname, 'ConsoleDriver');
    assert.equal(providers[0].exact, true);
    assert.equal(providers[1].exact, true, 'a string token is matched by its value');
    assert.deepEqual(injections.map(j => `${j.owner?.qname}.${j.param}: ${j.type} ← ${j.token}`), ['LoggerService.driver: Driver ← LOGGER_DRIVER', "LoggerService.app: string ← 'APP_NAME'"]);

    const refs = await callTool(intel, 'find_references', { symbol: 'ConsoleDriver' });
    assert.match(refs, /Dependency injection: provided as LOGGER_DRIVER \(useClass, src\/logger\/logger\.module\.ts:9\) and injected into LoggerService\.driver src\/logger\/logger\.service\.ts:7/);
    const tok = await callTool(intel, 'find_references', { symbol: 'LOGGER_DRIVER' });
    assert.match(tok, /LOGGER_DRIVER is a token, provided by useClass ConsoleDriver/);
    const ex = await callTool(intel, 'explore', { symbols: ['LoggerService'] });
    assert.match(ex, /receives by injection: driver ← LOGGER_DRIVER, useClass ConsoleDriver \(src\/logger\/logger\.module\.ts:9\)/);
    const cli = await callTool(intel, 'inject', { filter: 'logger' });
    assert.match(cli, /LOGGER_DRIVER\n\s+provided\s+useClass\s+ConsoleDriver/);
});

test('dependency injection: microservice clients, `provider.provide` and string tokens by value', async (t) => {
    const root = makeRepo({
        'src/math.constants.ts': "export const MATH_SERVICE = 'MATH_SERVICE';\n",
        'src/math.module.ts': [
            "import { ClientsModule, Transport } from '@nestjs/microservices';",
            "import { MATH_SERVICE } from './math.constants';",
            '@Module({ imports: [ClientsModule.register([{ name: MATH_SERVICE, transport: Transport.TCP }])] })', // 3
            'export class MathModule {}',
            '',
        ].join('\n'),
        'src/math.controller.ts': [
            "import { MATH_SERVICE } from './math.constants';",
            'export class MathController {',
            '  constructor(@Inject(MATH_SERVICE) private readonly client: ClientProxy) {}',   // 3
            '}',
            '',
        ].join('\n'),
        'src/superjson.provider.ts': "export const superJSONProvider = {\n  provide: 'SuperJSON',\n  useFactory: () => import('superjson'),\n};\n",
        'src/app.service.ts': [
            "import { superJSONProvider } from './superjson.provider';",
            "const REFLECTOR = 'Reflector';",
            'export class AppService {',
            '  constructor(@Inject(superJSONProvider.provide) private readonly superjson: unknown) {}',  // 4
            '}',
            'export class Interceptor {',
            '  constructor(@Inject(REFLECTOR) protected readonly reflector: any) {}',              // 7
            '}',
            '',
        ].join('\n'),
        'src/core.module.ts': "import { Reflector } from './reflector';\nexport const providers = [{ provide: Reflector.name, useExisting: Reflector }];\n",
        'src/reflector.ts': 'export class Reflector {}\n',
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });
    const { providers, injections } = collectInjection(intel);
    const from = (file, line) => providers.filter(p => p.key === injections.find(j => j.file === file && j.line === line)?.key).map(p => `${p.file}:${p.line} ${p.how}`);
    assert.deepEqual(from('src/math.controller.ts', 3), ['src/math.module.ts:3 ClientsModule']);
    assert.deepEqual(from('src/app.service.ts', 4), ['src/superjson.provider.ts:2 useFactory'], 'the token of the provider declared as superJSONProvider');
    assert.deepEqual(from('src/app.service.ts', 7), ['src/core.module.ts:2 useExisting'], "'Reflector' and Reflector.name are one token");
});
