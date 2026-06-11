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
        expected_names: ['Router', 'route'],
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
        expected_names: ['Reflect', 'metadata', 'decorator'],
        expected_files: ['decorators', 'metadata'],
    },

    // ── SEMANTIC — agent-style conceptual queries (what PROMPT.md trains agents to write) ─
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
        expected_names: ['PipeTransform'],
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
];
