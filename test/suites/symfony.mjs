/**
 * test/suites/symfony.mjs
 *
 * Ground-truth query set for a subset of symfony/symfony (the HttpKernel
 * component, PHP).
 * Source: https://github.com/symfony/symfony
 *
 * Key source layout (under the fixture root):
 *   HttpKernel.php            — class HttpKernel: turns a Request into a Response
 *                                 by dispatching kernel events to listeners
 *   Kernel.php                — class Kernel: the application root / bundle boot
 *   Controller/
 *     ControllerResolver.php          — resolves the controller from a Request
 *     ContainerControllerResolver.php — resolves "service::method" via container
 *     ArgumentResolver.php            — resolves the arguments for an action
 *   HttpCache/
 *     HttpCache.php             — reverse-proxy HTTP caching kernel wrapper
 *     Store.php                 — stores cache metadata / response bodies on disk
 *     Esi.php                   — ESI surrogate (edge side includes) language
 *     ResponseCacheStrategy.php — combine surrogate TTLs into the main response
 *   Fragment/
 *     EsiFragmentRenderer.php      — render a sub-fragment as an ESI tag
 *     HIncludeFragmentRenderer.php — render a sub-fragment as an hinclude tag
 *     FragmentHandler.php          — dispatch fragment rendering to a renderer
 *   EventListener/
 *     RouterListener.php   — match the request path to a route
 *     LocaleListener.php   — set the request locale
 *     ErrorListener.php    — convert an exception into a Response
 *     SessionListener.php  — bind the session onto the request
 *   Log/Logger.php          — minimal PSR-3 logger writing to a stream
 *   Profiler/
 *     Profiler.php             — collects/stores profiling data per request
 *     FileProfilerStorage.php  — file-backed profiler storage
 *   Exception/*HttpException.php — typed HTTP-status exceptions
 */

export const META = {
    id: 'symfony',
    displayName: 'Symfony HttpKernel (subset)',
    language: 'PHP/Symfony',
    version: 'subset',
    url: 'https://github.com/symfony/symfony',
    expectedMinChunks: 200,
    expectedMinFiles: 150,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'SF01',
        query: 'HttpKernel',
        difficulty: 'easy',
        topK: 5,
        description: 'HttpKernel — converts a Request into a Response',
        expected_names: ['HttpKernel'],
        expected_files: ['HttpKernel.php'],
    },
    {
        id: 'SF02',
        query: 'ControllerResolver argument value resolver',
        difficulty: 'easy',
        topK: 5,
        description: 'ControllerResolver — picks the controller to run from a Request (seed: controller-res)',
        expected_names: ['ControllerResolver'],
        expected_files: ['Controller/ControllerResolver.php'],
    },
    {
        id: 'SF03',
        query: 'Profiler',
        difficulty: 'easy',
        topK: 5,
        description: 'Profiler — collects and stores profiling data for a request',
        expected_names: ['Profiler'],
        expected_files: ['Profiler/Profiler.php'],
    },
    // ── MEDIUM (keyword lookup) ─────────────────────────────────────────────────

    {
        id: 'SF05',
        query: 'argument resolver action method parameters',
        difficulty: 'medium',
        topK: 5,
        description: 'ArgumentResolver — resolves the arguments passed to a controller action',
        expected_names: ['ArgumentResolver'],
        expected_files: ['Controller/ArgumentResolver.php'],
    },
    {
        id: 'SF06',
        query: 'http cache store metadata response',
        difficulty: 'medium',
        topK: 5,
        description: 'HttpCache reverse-proxy kernel and its on-disk Store',
        expected_names: ['HttpCache', 'Store'],
        expected_files: ['HttpCache/HttpCache.php', 'HttpCache/Store.php'],
    },
    {
        id: 'SF07',
        query: 'logger stderr stream PSR-3',
        difficulty: 'medium',
        topK: 5,
        description: 'Logger — minimalist PSR-3 logger writing to a stream',
        expected_names: ['Logger'],
        expected_files: ['Log/Logger.php'],
    },
    {
        id: 'SF08',
        query: 'router listener match request route',
        difficulty: 'medium',
        topK: 5,
        description: 'RouterListener — matches the incoming request path to a route',
        expected_names: ['RouterListener'],
        expected_files: ['EventListener/RouterListener.php'],
    },

    // ── HARD (cross-cutting, behavioural) ───────────────────────────────────────

    {
        id: 'SF09',
        query: 'render an embedded page fragment using an ESI surrogate',
        difficulty: 'hard',
        topK: 10,
        description: 'EsiFragmentRenderer — renders a sub-request as an ESI tag (seed: esi-fragment)',
        expected_names: ['EsiFragmentRenderer', 'Esi'],
        expected_files: ['Fragment/EsiFragmentRenderer.php', 'HttpCache/Esi.php'],
    },
    {
        id: 'SF10',
        query: 'catch an uncaught exception during request handling and turn it into a response',
        difficulty: 'hard',
        topK: 10,
        description: 'ErrorListener — converts a thrown exception into a Response',
        expected_names: ['ErrorListener', 'ExceptionEvent'],
        expected_files: ['EventListener/ErrorListener.php', 'Event/ExceptionEvent.php'],
    },

    // ── SEMANTIC (behavioural, target name not mentioned) ───────────────────────

    {
        id: 'SF11',
        query: 'turn an incoming request into a response by notifying listeners at each stage of the lifecycle',
        difficulty: 'semantic',
        topK: 10,
        description: 'HttpKernel dispatches lifecycle events; RequestEvent is the first one (seed: kernel-handle)',
        expected_names: ['HttpKernel', 'RequestEvent'],
        expected_files: ['HttpKernel.php', 'Event/RequestEvent.php'],
    },
    {
        id: 'SF12',
        query: 'detect and apply the language the visitor wants for the current request',
        difficulty: 'semantic',
        topK: 10,
        description: 'LocaleListener — initialises the request locale',
        expected_names: ['LocaleListener'],
        expected_files: ['EventListener/LocaleListener.php'],
    },
    {
        id: 'SF13',
        query: 'reconcile the freshness lifetimes of several embedded sub-responses into the lifetime of the main page',
        difficulty: 'semantic',
        topK: 10,
        description: 'ResponseCacheStrategy — lowers the main response TTL to the smallest surrogate TTL',
        expected_names: ['ResponseCacheStrategy'],
        expected_files: ['HttpCache/ResponseCacheStrategy.php'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-SF1',
        query: 'FileProfilerStorage',
        difficulty: 'easy',
        topK: 5,
        description: 'File-backed profiler storage',
        expected_names: ['FileProfilerStorage'],
        expected_files: ['Profiler/FileProfilerStorage.php'],
        heldOut: true,
    },
    {
        id: 'HO-SF2',
        query: 'bind the session object onto the request so handlers can read and write it',
        difficulty: 'semantic',
        topK: 10,
        description: 'SessionListener — sets the session in the request',
        expected_names: ['SessionListener'],
        expected_files: ['EventListener/SessionListener.php'],
        heldOut: true,
    },
    {
        id: 'HO-SF3',
        query: 'aggregate several cache warmers and warm them all up before serving traffic',
        difficulty: 'semantic',
        topK: 10,
        description: 'CacheWarmerAggregate — aggregates several cache warmers into one',
        expected_names: ['CacheWarmerAggregate'],
        expected_files: ['CacheWarmer/CacheWarmerAggregate.php'],
        heldOut: true,
    },
    {
        id: 'HO-SF4',
        query: 'NotFoundHttpException',
        difficulty: 'easy',
        topK: 5,
        description: 'NotFoundHttpException — exception carrying a 404 status',
        expected_names: ['NotFoundHttpException'],
        expected_files: ['Exception/NotFoundHttpException.php'],
        heldOut: true,
    },
];
