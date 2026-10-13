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

test('dependency injection (Spring): the bean each injection point receives', async (t) => {
    const J = 'src/main/java/demo';
    const root = makeRepo({
        'pom.xml': '<project><artifactId>parent</artifactId><modules><module>app</module><module>other</module><module>shared</module></modules></project>\n',
        'shared/pom.xml': '<project><parent><artifactId>parent</artifactId></parent><artifactId>shared</artifactId></project>\n',
        [`shared/${J}/shared/Clock.java`]: 'package demo.shared;\npublic interface Clock { long now(); }\n',
        [`shared/${J}/shared/Ticker.java`]: [
            'package demo.shared;',
            'import org.springframework.stereotype.Component;',
            'import org.springframework.beans.factory.annotation.Autowired;',
            '@Component',
            'public class Ticker {',
            '    @Autowired',
            '    private Clock clock;',                                                   // 7
            '}',
            '',
        ].join('\n'),
        'app/pom.xml': '<project><parent><artifactId>parent</artifactId></parent><artifactId>app</artifactId><dependencies><dependency><artifactId>shared</artifactId></dependency></dependencies></project>\n',
        [`app/${J}/app/App.java`]: 'package demo.app;\n@SpringBootApplication\npublic class App {}\n',
        [`app/${J}/app/PaymentService.java`]: 'package demo.app;\npublic interface PaymentService { void pay(); }\n',
        [`app/${J}/app/CardPayment.java`]: 'package demo.app;\n@Service\npublic class CardPayment implements PaymentService { public void pay() {} }\n',
        [`app/${J}/app/CashPayment.java`]: 'package demo.app;\n@Service("cash")\n@Primary\npublic class CashPayment implements PaymentService { public void pay() {} }\n',
        [`app/${J}/app/OwnerRepository.java`]: 'package demo.app;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OwnerRepository extends JpaRepository<Owner, Integer> {}\n',
        [`app/${J}/app/RatesClient.java`]: 'package demo.app;\n@FeignClient(name = "rates")\npublic interface RatesClient { String latest(); }\n',
        [`app/${J}/app/AppConfig.java`]: [
            'package demo.app;',
            '@Configuration',
            'public class AppConfig {',
            '    @Bean',
            '    public Clock systemClock() { return System::currentTimeMillis; }',      // 5
            '    @Bean(name = "fixed")',
            '    public Clock fixedClock() { return () -> 0L; }',                         // 7
            '}',
            '',
        ].join('\n'),
        [`app/${J}/app/Checkout.java`]: [
            'package demo.app;',
            '@Service',
            'public class Checkout {',
            '    private final PaymentService payments;',
            '    private final OwnerRepository owners;',
            '    @Autowired @Qualifier("fixed") private Clock clock;',                   // 6
            '    @Resource private PaymentService cardPayment;',                          // 7
            '    public Checkout(PaymentService payments,',                               // 8
            '                    OwnerRepository owners, @Value("${x}") String x) {',     // 9
            '        this.payments = payments; this.owners = owners;',
            '    }',
            '}',
            '',
        ].join('\n'),
        [`app/${J}/app/Report.java`]: [
            'package demo.app;',
            '@Component',
            '@RequiredArgsConstructor',
            'public class Report {',
            '    private final RatesClient rates;',                                       // 5
            '    private final List<PaymentService> all;',                                // 6
            '    private String title;',
            '}',
            '',
        ].join('\n'),
        'other/pom.xml': '<project><parent><artifactId>parent</artifactId></parent><artifactId>other</artifactId></project>\n',
        [`other/${J}/other/Other.java`]: 'package demo.other;\n@SpringBootApplication\npublic class Other {}\n',
        [`other/${J}/other/OtherPayment.java`]: 'package demo.other;\n@Service\npublic class OtherPayment implements demo.app.PaymentService { public void pay() {} }\n',
        [`app/${J}/app/Settings.java`]: 'package demo.app;\n@ConfigurationProperties(prefix = "s")\npublic class Settings {}\n',
        [`app/${J}/app/SettingsConfig.java`]: 'package demo.app;\n@Configuration\npublic class SettingsConfig {\n    @Bean\n    public Settings settings() { return new Settings(); }\n}\n',
        [`app/${J}/app/Uses.java`]: 'package demo.app;\n@Component\npublic class Uses {\n    @Autowired private Settings settings;\n}\n',
        [`app/${J}/app/Disabled.java`]: 'package demo.app;\n//@Component\npublic class Disabled {\n    @Autowired private PaymentService payments;\n}\n',
        [`app/src/test/java/demo/app/CheckoutTest.java`]: 'package demo.app;\npublic class CheckoutTest {\n    @Autowired private Checkout checkout;\n}\n',
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });

    const { injections } = collectInjection(intel);
    const at = (file, param) => {
        const j = injections.find(x => x.file.endsWith(file) && x.param === param);
        return j && `${j.from.map(p => p.target.name).join(' | ')} — ${j.why}`;
    };
    assert.equal(at('Checkout.java', 'payments'), 'CashPayment — @Primary, over CardPayment', 'constructor injection; another application\'s bean is not a candidate');
    assert.equal(at('Checkout.java', 'owners'), 'OwnerRepository — by type');
    assert.equal(at('Checkout.java', 'x'), undefined, '@Value is configuration, not a bean');
    assert.equal(at('Checkout.java', 'clock'), 'fixedClock — @Qualifier("fixed")');
    assert.equal(at('Checkout.java', 'cardPayment'), 'CardPayment — by name "cardPayment" (@Resource)');
    assert.equal(at('Report.java', 'rates'), 'RatesClient — by type', 'Lombok @RequiredArgsConstructor: final fields');
    assert.equal(at('Report.java', 'all'), 'CardPayment | CashPayment — every bean of type PaymentService');
    assert.equal(at('Report.java', 'title'), undefined);
    assert.equal(at('Ticker.java', 'clock'), 'systemClock | fixedClock — ambiguous: several beans match and none is @Primary or named so', 'a shared module sees the beans of the application that includes it');
    assert.ok(!injections.some(j => j.file.includes('/test/')), 'test files are left out');
    assert.equal(at('Uses.java', 'settings'), 'settings — by type', 'an unregistered @ConfigurationProperties class is not a second bean');
    assert.equal(at('Disabled.java', 'payments'), undefined, 'nothing is injected into a class that is not a bean');
    assert.equal(injections.find(j => j.param === 'owners').line, 9);

    const refs = await callTool(intel, 'find_references', { symbol: 'CardPayment' });
    assert.match(refs, /Dependency injection: a Spring bean \(@Service cardPayment, app\/src\/main\/java\/demo\/app\/CardPayment\.java:2\) and injected into Checkout\.cardPayment .*Checkout\.java:7, Report\.all /);
    const iface = await callTool(intel, 'find_references', { symbol: 'PaymentService' });
    assert.match(iface, /Dependency injection \(Spring\): 3 injection points of type PaymentService, filled by @Service CardPayment .*, @Service CashPayment/);
    const ex = await callTool(intel, 'explore', { symbols: ['Checkout'] });
    assert.match(ex, /receives by injection: .*payments ← PaymentService, @Service CashPayment \(app\/src\/main\/java\/demo\/app\/CashPayment\.java:2\) \[@Primary, over CardPayment\]/);
    const cli = await callTool(intel, 'inject', { filter: 'Clock' });
    assert.match(cli, /Clock\n\s+provided\s+@Bean\s+AppConfig\.fixedClock  app\/src\/main\/java\/demo\/app\/AppConfig\.java:6\n\s+provided\s+@Bean\s+AppConfig\.systemClock/);
});
