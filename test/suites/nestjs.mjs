/**
 * test/suites/nestjs.mjs
 *
 * Ground-truth query set for NestJS v10.4.9 (TypeScript).
 * Source: https://github.com/nestjs/nest (tag v10.4.9)
 *
 * NestJS is an enterprise-grade TypeScript framework that uses Express by default.
 * It provides dependency injection, decorators, modules, controllers, services,
 * middleware, guards, pipes, and interceptors.
 *
 * Key source layout (all TypeScript in packages/):
 *   core/
 *     application.ts         — NestApplication, createNestApplication
 *     nest-factory.ts        — NestFactory.create(), NestFactory.createMicroservice()
 *     injector/              — dependency injection engine
 *   common/
 *     decorators/controller.decorator.ts  — @Controller()
 *     decorators/module.decorator.ts      — @Module()
 *     decorators/injectable.decorator.ts  — @Injectable()
 *     decorators/get.decorator.ts         — @Get, @Post, @Put, @Delete, @Patch
 *   microservices/
 *   websockets/
 */

export const META = {
    id: 'nestjs',
    displayName: 'NestJS v10.4.9',
    language: 'TypeScript',
    version: 'v10.4.9',
    url: 'https://github.com/nestjs/nest',
    expectedMinChunks: 100,
    expectedMinFiles: 50,
};

export const QUERIES = [
    // ── EASY — exact class / function / decorator name ────────────────────────

    {
        id: 'NJ01',
        query: 'NestFactory',
        difficulty: 'easy',
        topK: 5,
        description: 'Factory for creating and bootstrapping Nest applications',
        expected_names: ['NestFactory'],
        expected_files: ['nest-factory', 'core'],
    },
    {
        id: 'NJ02',
        query: 'NestApplication',
        difficulty: 'easy',
        topK: 5,
        description: 'Main Nest application instance with HTTP/Express methods',
        expected_names: ['NestApplication'],
        expected_files: ['application', 'core'],
    },
    {
        id: 'NJ03',
        query: 'Controller',
        difficulty: 'easy',
        topK: 5,
        description: '@Controller() decorator for routing and dependency injection',
        expected_names: ['Controller'],
        expected_files: ['controller.decorator', 'decorators'],
    },
    {
        id: 'NJ04',
        query: 'Module',
        difficulty: 'easy',
        topK: 5,
        description: '@Module() decorator for organizing application into logical units',
        expected_names: ['Module'],
        expected_files: ['module.decorator', 'decorators'],
    },
    {
        id: 'NJ05',
        query: 'Injectable',
        difficulty: 'easy',
        topK: 5,
        description: '@Injectable() decorator marking a service for dependency injection',
        expected_names: ['Injectable'],
        expected_files: ['injectable.decorator', 'decorators'],
    },

    // ── MEDIUM — partial name, related terms, or multi-token ────────────────

    {
        id: 'NJ06',
        query: 'HttpServer express adapter',
        difficulty: 'medium',
        topK: 5,
        description: 'Express HTTP server adapter integration',
        expected_names: ['HttpServer', 'ExpressAdapter'],
        expected_files: ['adapters', 'http-adapter'],
    },
    {
        id: 'NJ07',
        query: 'Router route handler mapping',
        difficulty: 'medium',
        topK: 5,
        description: 'Routes HTTP requests to controller methods',
        // CORRECTION: NestJS indexes no `Router`/`route` chunk; the route→handler
        // mapper is RouterExplorer / RoutesResolver / RouterModule (verified in index).
        expected_names: ['RouterExplorer', 'RoutesResolver', 'RouterModule'],
        expected_files: ['router'],
    },
    {
        id: 'NJ08',
        query: 'Guard middleware authentication',
        difficulty: 'medium',
        topK: 5,
        description: 'Guard for request authentication and authorization',
        expected_names: ['CanActivate', 'Guard'],
        expected_files: ['guards', 'decorators'],
    },
    {
        id: 'NJ09',
        query: 'Pipe transform validate input',
        difficulty: 'medium',
        topK: 5,
        description: 'Pipe that transforms or validates request data',
        expected_names: ['PipeTransform', 'Pipe'],
        expected_files: ['pipes', 'decorators'],
    },
    {
        id: 'NJ10',
        query: 'Interceptor request response',
        difficulty: 'medium',
        topK: 5,
        description: 'Intercepts method execution to add logging or transform responses',
        expected_names: ['NestInterceptor', 'Interceptor'],
        expected_files: ['interceptors', 'decorators'],
    },

    // ── HARD — semantic / conceptual descriptions ──────────────────────────────

    {
        id: 'NJ11',
        query: 'dependency injection container resolve providers',
        difficulty: 'hard',
        topK: 10,
        description: 'Core DI engine that resolves and injects service dependencies',
        expected_names: ['Injector', 'Container', 'resolve'],
        expected_files: ['injector', 'core'],
    },
    {
        id: 'NJ12',
        query: 'bootstrap application module startup',
        difficulty: 'hard',
        topK: 10,
        description: 'Entry point that creates and initialises the Nest application',
        expected_names: ['create', 'bootstrap', 'listen'],
        expected_files: ['nest-factory', 'application'],
    },
    {
        id: 'NJ13',
        query: 'middleware chain pipeline execution',
        difficulty: 'hard',
        topK: 10,
        description: 'Request pipeline with middleware, guards, pipes, interceptors',
        expected_names: ['use', 'middleware', 'apply'],
        expected_files: ['middleware', 'router'],
    },
    {
        id: 'NJ14',
        query: 'decorator metadata reflection class',
        difficulty: 'hard',
        topK: 10,
        description: 'TypeScript decorator system using reflect-metadata',
        // CORRECTION: `Reflect`/`metadata`/`decorator` are not indexed names; the
        // reflection/metadata classes are Reflector / MetadataScanner / SetMetadata.
        expected_names: ['Reflector', 'MetadataScanner', 'SetMetadata'],
        expected_files: ['decorators', 'metadata'],
    },

    // ── SEMANTIC — agent-style conceptual queries (what prompts/CORE.md trains agents to write) ─
    // These queries deliberately contain NO exact symbol name. They describe *behavior*,
    // mirroring what an LLM following the prompt guidelines would type into search_code().
    // They primarily exercise the embedding channel; BM25 must still find them via
    // docstrings and code body content.

    {
        id: 'NJ15',
        query: 'class-based HTTP endpoint handler binding route path prefix to controller methods',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent searching conceptually for the controller mechanism — must NOT contain "Controller" in query',
        expected_names: ['Controller'],
        expected_files: ['controller.decorator', 'decorators'],
    },
    {
        id: 'NJ16',
        query: 'mark TypeScript class as provider available for automatic constructor injection',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the DI provider registration decorator',
        expected_names: ['Injectable'],
        expected_files: ['injectable.decorator'],
    },
    {
        id: 'NJ17',
        query: 'validate or transform incoming request data payload before route handler executes',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent searching for the pipe/transform abstraction',
        // CORRECTION: `PipeTransform` (an interface) is not an indexed chunk; the
        // concrete pipe/transform chunks are ValidationPipe / PipesConsumer / Pipe.
        expected_names: ['ValidationPipe', 'PipesConsumer', 'Pipe'],
        expected_files: ['pipes'],
    },
    {
        id: 'NJ18',
        query: 'Catching unhandled errors globally across the app and formatting them into standard HTTP responses',
        difficulty: 'semantic',
        topK: 10,
        description: 'Conceptual search for Exception Filters',
        expected_names: ['ExceptionFilter', 'Catch', 'BaseExceptionFilter'],
        expected_files: ['filters', 'core'],
    },
    {
        id: 'NJ19',
        query: 'Restricting access to certain endpoints based on user roles or active session permissions',
        difficulty: 'semantic',
        topK: 10,
        description: 'Searching for Guard logic',
        expected_names: ['Guard', 'CanActivate'],
        expected_files: ['guards'],
    },
    {
        id: 'NJ20',
        query: 'Bootstrapping the server engine, binding it to a port, and starting the HTTP listener to accept traffic',
        difficulty: 'semantic',
        topK: 10,
        description: 'Looking for the app initialization block',
        expected_names: ['create', 'listen', 'bootstrap'],
        expected_files: ['nest-factory', 'application'],
    },
    {
        id: 'NJ21',
        query: 'Wrapping a request handler to measure execution time or mutate the final returned JSON object',
        difficulty: 'semantic',
        topK: 10,
        description: 'Describing Interceptor behavior',
        expected_names: ['NestInterceptor', 'Interceptor'],
        expected_files: ['interceptors'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    { id: 'HO-NJ1', query: 'Reflector', difficulty: 'easy', expected_names: ['Reflector'], heldOut: true },
    { id: 'HO-NJ2', query: 'read decorator metadata attached to a class or route handler', difficulty: 'semantic', topK: 10, expected_names: ['Reflector', 'MetadataScanner'], heldOut: true },
    { id: 'HO-NJ3', query: 'ExceptionsHandler', difficulty: 'easy', expected_names: ['ExceptionsHandler'], heldOut: true },

    // EXPANDED-QUERIES-V2 — benchmark-power upgrade: expanded ground truth (n↑).
    // ── EXPANDED TUNING ───────────────────────────────────────────────────────
    {
        id: "NJ22",
        query: "RouterExplorer",
        difficulty: "easy",
        topK: 5,
        description: "Explores controllers, maps route paths to handler methods and registers them on the HTTP adapter",
        expected_names: ["RouterExplorer"],
        expected_files: ["router/router-explorer","core"],
    },
    {
        id: "NJ23",
        query: "InstanceWrapper provider instance scope metadata",
        difficulty: "medium",
        topK: 5,
        description: "Wrapper holding a provider's instances, scope and dependency metadata inside the DI container",
        expected_names: ["InstanceWrapper"],
        expected_files: ["injector/instance-wrapper"],
    },
    {
        id: "NJ24",
        query: "walk every module to collect controllers providers and dynamic imports into the container",
        difficulty: "hard",
        topK: 10,
        description: "NL intent for the dependency graph scanner that populates the container from module metadata",
        expected_names: ["DependenciesScanner"],
        expected_files: ["core/scanner"],
    },
    // ── EXPANDED HELD-OUT (validation only — frozen, never tuned) ──────────────
    {
        id: "HO-NJ4",
        query: "NestContainer",
        difficulty: "easy",
        topK: 5,
        description: "Top-level DI container holding all registered modules and their relationships",
        expected_names: ["NestContainer"],
        expected_files: ["injector/container"],
        heldOut: true,
    },
    {
        id: "HO-NJ5",
        query: "ConfigurableModuleBuilder",
        difficulty: "easy",
        topK: 5,
        description: "Builder that generates forRoot/forRootAsync dynamic-module boilerplate",
        expected_names: ["ConfigurableModuleBuilder"],
        expected_files: ["module-utils/configurable-module.builder"],
        heldOut: true,
    },
    {
        id: "HO-NJ6",
        query: "WebSocketGateway",
        difficulty: "easy",
        topK: 5,
        description: "@WebSocketGateway() decorator marking a class as a websocket message gateway",
        expected_names: ["WebSocketGateway"],
        expected_files: ["decorators/socket-gateway.decorator","websockets"],
        heldOut: true,
    },
    {
        id: "HO-NJ7",
        query: "ValidationPipe",
        difficulty: "easy",
        topK: 5,
        description: "Built-in pipe that validates and transforms DTOs using class-validator",
        expected_names: ["ValidationPipe"],
        expected_files: ["pipes/validation.pipe","common"],
        heldOut: true,
    },
    {
        id: "HO-NJ8",
        query: "StreamableFile",
        difficulty: "easy",
        topK: 5,
        description: "Wrapper letting a handler return a streamable file response",
        expected_names: ["StreamableFile"],
        expected_files: ["file-stream/streamable-file"],
        heldOut: true,
    },
    {
        id: "HO-NJ9",
        query: "lazy module loader register import on demand",
        difficulty: "medium",
        topK: 5,
        description: "Service that loads a module lazily at runtime instead of at bootstrap",
        expected_names: ["LazyModuleLoader"],
        expected_files: ["lazy-module-loader"],
        heldOut: true,
    },
    {
        id: "HO-NJ10",
        query: "instance loader create singleton provider instances",
        difficulty: "medium",
        topK: 5,
        description: "Instantiates providers and controllers for every module after scanning",
        expected_names: ["InstanceLoader"],
        expected_files: ["injector/instance-loader"],
        heldOut: true,
    },
    {
        id: "HO-NJ11",
        query: "grpc microservice transport server",
        difficulty: "medium",
        topK: 5,
        description: "Server strategy handling incoming gRPC microservice calls",
        expected_names: ["ServerGrpc"],
        expected_files: ["server/server-grpc","microservices"],
        heldOut: true,
    },
    {
        id: "HO-NJ12",
        query: "console logger colorized output log levels",
        difficulty: "medium",
        topK: 5,
        description: "Default logger implementation writing colorized messages to stdout",
        expected_names: ["ConsoleLogger"],
        expected_files: ["services/console-logger.service"],
        heldOut: true,
    },
    {
        id: "HO-NJ13",
        query: "compose multiple class and method decorators into one",
        difficulty: "hard",
        topK: 10,
        description: "NL intent for the helper that merges several decorators behind a single one",
        expected_names: ["applyDecorators"],
        expected_files: ["core/apply-decorators"],
        heldOut: true,
    },
    {
        id: "HO-NJ14",
        query: "break a circular reference between two modules that import each other",
        difficulty: "hard",
        topK: 10,
        description: "NL intent for forwardRef used to resolve circular module/provider dependencies",
        expected_names: ["forwardRef"],
        expected_files: ["forward-ref.util"],
        heldOut: true,
    },
    {
        id: "HO-NJ15",
        query: "build the per-request execution context object exposing the handler and class",
        difficulty: "hard",
        topK: 10,
        description: "NL intent for the ExecutionContext implementation passed to guards/interceptors",
        expected_names: ["ExecutionContextHost"],
        expected_files: ["helpers/execution-context-host"],
        heldOut: true,
    },
    {
        id: "HO-NJ16",
        query: "subscribe a gateway method to a named websocket event message",
        difficulty: "semantic",
        topK: 10,
        description: "NL intent for the @SubscribeMessage decorator (no identifier spoken)",
        expected_names: ["SubscribeMessage"],
        expected_files: ["decorators/subscribe-message.decorator"],
        heldOut: true,
    },
    {
        id: "HO-NJ17",
        query: "bind a controller method to handle a message pattern over a microservice transport",
        difficulty: "semantic",
        topK: 10,
        description: "NL intent for @MessagePattern / @EventPattern request-reply and event handlers",
        expected_names: ["MessagePattern","EventPattern"],
        expected_files: ["decorators/message-pattern.decorator","decorators/event-pattern.decorator"],
        heldOut: true,
    },
    {
        id: "HO-NJ18",
        query: "run each registered guard and deny the request when one returns false",
        difficulty: "semantic",
        topK: 10,
        description: "NL intent for the guards consumer that invokes canActivate (no identifier spoken)",
        expected_names: ["GuardsConsumer"],
        expected_files: ["guards/guards-consumer"],
        heldOut: true,
    },
    {
        id: "HO-NJ19",
        query: "convert a thrown error into the right error response for rpc and websocket channels",
        difficulty: "semantic",
        topK: 10,
        description: "Cross-cutting NL intent for the base RPC/WS exception filters and their handlers",
        expected_names: ["BaseRpcExceptionFilter","BaseWsExceptionFilter","RpcExceptionsHandler","WsExceptionsHandler"],
        expected_files: ["base-rpc-exception-filter","base-ws-exception-filter","microservices","websockets"],
        heldOut: true,
    },
    {
        id: "HO-NJ20",
        query: "parse and coerce a route parameter string into an integer or uuid before the handler",
        difficulty: "semantic",
        topK: 10,
        description: "Cross-cutting NL intent for the built-in parse pipes (no identifier spoken)",
        expected_names: ["ParseIntPipe","ParseUUIDPipe","ParseFloatPipe","ParseBoolPipe","ParseArrayPipe"],
        expected_files: ["pipes","common"],
        heldOut: true,
    },
];
