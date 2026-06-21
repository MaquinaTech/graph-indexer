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

    // EXPANDED-QUERIES-V2 — benchmark-power upgrade: expanded ground truth (n↑).
    // ── EXPANDED TUNING ───────────────────────────────────────────────────────
    {
        id: "SF14",
        query: "ContainerControllerResolver",
        difficulty: "easy",
        topK: 5,
        description: "ContainerControllerResolver — resolves a controller from a PSR-11 container using the service::method notation",
        expected_names: ["ContainerControllerResolver"],
        expected_files: ["Controller/ContainerControllerResolver.php"],
    },
    {
        id: "SF15",
        query: "DateTimeValueResolver",
        difficulty: "easy",
        topK: 5,
        description: "DateTimeValueResolver — converts a request attribute into a DateTime instance",
        expected_names: ["DateTimeValueResolver"],
        expected_files: ["Controller/ArgumentResolver/DateTimeValueResolver.php"],
    },
    {
        id: "SF16",
        query: "ResponseListener kernel response headers",
        difficulty: "easy",
        topK: 5,
        description: "ResponseListener — fixes the Response headers based on the Request",
        expected_names: ["ResponseListener"],
        expected_files: ["EventListener/ResponseListener.php"],
    },
    {
        id: "SF17",
        query: "compiler pass register default logger service",
        difficulty: "medium",
        topK: 5,
        description: "LoggerPass — registers the default logger service if none is configured",
        expected_names: ["LoggerPass"],
        expected_files: ["DependencyInjection/LoggerPass.php"],
    },
    {
        id: "SF18",
        query: "service locator for tagged controller argument value resolvers",
        difficulty: "medium",
        topK: 10,
        description: "RegisterControllerArgumentLocatorsPass — creates the service-locators ServiceValueResolver depends on",
        expected_names: ["RegisterControllerArgumentLocatorsPass","ServiceValueResolver"],
        expected_files: ["DependencyInjection/RegisterControllerArgumentLocatorsPass.php","Controller/ArgumentResolver/ServiceValueResolver.php"],
    },
    {
        id: "SF19",
        query: "map request body json to a typed dto object and validate it",
        difficulty: "medium",
        topK: 10,
        description: "MapRequestPayload attribute + RequestPayloadValueResolver — deserialize and validate the request content into a typed object",
        expected_names: ["MapRequestPayload","RequestPayloadValueResolver"],
        expected_files: ["Attribute/MapRequestPayload.php","Controller/ArgumentResolver/RequestPayloadValueResolver.php"],
    },
    {
        id: "SF20",
        query: "resolve a route path parameter into a backed enum case or 404",
        difficulty: "medium",
        topK: 5,
        description: "BackedEnumValueResolver — resolves a backed enum from a request attribute, 404 if invalid",
        expected_names: ["BackedEnumValueResolver"],
        expected_files: ["Controller/ArgumentResolver/BackedEnumValueResolver.php"],
    },
    {
        id: "SF21",
        query: "guard fragment URIs so only signed internal sub-requests are allowed",
        difficulty: "hard",
        topK: 10,
        description: "FragmentListener — handles /_fragment URIs and rejects unsigned requests; FragmentUriGenerator builds the signed URI",
        expected_names: ["FragmentListener","FragmentUriGenerator"],
        expected_files: ["EventListener/FragmentListener.php","Fragment/FragmentUriGenerator.php"],
    },
    {
        id: "SF22",
        query: "render an embedded sub-request inline through the current kernel",
        difficulty: "hard",
        topK: 10,
        description: "InlineFragmentRenderer — renders the fragment by re-invoking the HTTP kernel in-process",
        expected_names: ["InlineFragmentRenderer"],
        expected_files: ["Fragment/InlineFragmentRenderer.php"],
    },
    {
        id: "SF23",
        query: "reset stateful services back to their initial state between requests",
        difficulty: "semantic",
        topK: 10,
        description: "ServicesResetter — resets the provided services so each request starts clean",
        expected_names: ["ServicesResetter"],
        expected_files: ["DependencyInjection/ServicesResetter.php"],
    },
    {
        id: "SF24",
        query: "stop search engines from indexing the site by sending a noindex header",
        difficulty: "semantic",
        topK: 10,
        description: "DisallowRobotsIndexingListener — adds the X-Robots-Tag header to keep the app out of search indexes",
        expected_names: ["DisallowRobotsIndexingListener"],
        expected_files: ["EventListener/DisallowRobotsIndexingListener.php"],
    },
    {
        id: "SF25",
        query: "validate the incoming request and reject it early when it is malformed",
        difficulty: "semantic",
        topK: 10,
        description: "ValidateRequestListener — validates the Request on kernel.request",
        expected_names: ["ValidateRequestListener"],
        expected_files: ["EventListener/ValidateRequestListener.php"],
    },
    // ── EXPANDED HELD-OUT (validation only — frozen, never tuned) ──────────────
    {
        id: "HO-SF5",
        query: "UidValueResolver",
        difficulty: "easy",
        topK: 5,
        description: "UidValueResolver — turns a string route parameter into a UID value object",
        expected_names: ["UidValueResolver"],
        expected_files: ["Controller/ArgumentResolver/UidValueResolver.php"],
        heldOut: true,
    },
    {
        id: "HO-SF6",
        query: "HttpClientKernel",
        difficulty: "easy",
        topK: 5,
        description: "HttpClientKernel — a kernel implementation that forwards requests through a real HTTP client",
        expected_names: ["HttpClientKernel"],
        expected_files: ["HttpClientKernel.php"],
        heldOut: true,
    },
    {
        id: "HO-SF7",
        query: "TooManyRequestsHttpException",
        difficulty: "easy",
        topK: 5,
        description: "TooManyRequestsHttpException — exception carrying a 429 status",
        expected_names: ["TooManyRequestsHttpException"],
        expected_files: ["Exception/TooManyRequestsHttpException.php"],
        heldOut: true,
    },
    {
        id: "HO-SF8",
        query: "ArgumentMetadataFactory",
        difficulty: "easy",
        topK: 5,
        description: "ArgumentMetadataFactory — builds ArgumentMetadata objects by reflecting a controller",
        expected_names: ["ArgumentMetadataFactory"],
        expected_files: ["ControllerMetadata/ArgumentMetadataFactory.php"],
        heldOut: true,
    },
    {
        id: "HO-SF9",
        query: "query string parameter binding to a controller argument",
        difficulty: "medium",
        topK: 5,
        description: "QueryParameterValueResolver — resolves scalar action arguments from query parameters",
        expected_names: ["QueryParameterValueResolver"],
        expected_files: ["Controller/ArgumentResolver/QueryParameterValueResolver.php"],
        heldOut: true,
    },
    {
        id: "HO-SF10",
        query: "inject a service as a controller method argument keyed by _controller",
        difficulty: "medium",
        topK: 5,
        description: "ServiceValueResolver — yields a container service for an action argument",
        expected_names: ["ServiceValueResolver"],
        expected_files: ["Controller/ArgumentResolver/ServiceValueResolver.php"],
        heldOut: true,
    },
    {
        id: "HO-SF11",
        query: "Cache attribute HTTP cache headers on a controller",
        difficulty: "medium",
        topK: 10,
        description: "Cache attribute + CacheAttributeListener — configure response cache headers declaratively on controllers",
        expected_names: ["Cache","CacheAttributeListener"],
        expected_files: ["Attribute/Cache.php","EventListener/CacheAttributeListener.php"],
        heldOut: true,
    },
    {
        id: "HO-SF12",
        query: "tagged fragment renderer registration compiler pass",
        difficulty: "medium",
        topK: 5,
        description: "FragmentRendererPass — collects services tagged kernel.fragment_renderer as rendering strategies",
        expected_names: ["FragmentRendererPass"],
        expected_files: ["DependencyInjection/FragmentRendererPass.php"],
        heldOut: true,
    },
    {
        id: "HO-SF13",
        query: "clear multiple PSR-6 cache pools by name",
        difficulty: "medium",
        topK: 10,
        description: "Psr6CacheClearer — clears registered PSR-6 cache pools; ChainCacheClearer aggregates clearers",
        expected_names: ["Psr6CacheClearer","ChainCacheClearer"],
        expected_files: ["CacheClearer/Psr6CacheClearer.php","CacheClearer/ChainCacheClearer.php"],
        heldOut: true,
    },
    {
        id: "HO-SF14",
        query: "rate limit a controller based on an attribute",
        difficulty: "medium",
        topK: 10,
        description: "RateLimit attribute + RateLimitAttributeListener — throttle requests to a controller declaratively",
        expected_names: ["RateLimit","RateLimitAttributeListener"],
        expected_files: ["Attribute/RateLimit.php","EventListener/RateLimitAttributeListener.php"],
        heldOut: true,
    },
    {
        id: "HO-SF15",
        query: "collect profiling data for the request by listening to kernel events",
        difficulty: "hard",
        topK: 10,
        description: "ProfilerListener — captures the profile for each request via the kernel event hooks",
        expected_names: ["ProfilerListener"],
        expected_files: ["EventListener/ProfilerListener.php"],
        heldOut: true,
    },
    {
        id: "HO-SF16",
        query: "wrap the event dispatcher to record which listeners ran for debugging",
        difficulty: "hard",
        topK: 10,
        description: "TraceableEventDispatcher — delegates dispatch while collecting listener data for the profiler",
        expected_names: ["TraceableEventDispatcher"],
        expected_files: ["Debug/TraceableEventDispatcher.php"],
        heldOut: true,
    },
    {
        id: "HO-SF17",
        query: "add a Surrogate-Control header when the response must be parsed for ESI or SSI tags",
        difficulty: "semantic",
        topK: 10,
        description: "SurrogateListener — sets Surrogate-Control so the reverse proxy parses surrogate markup",
        expected_names: ["SurrogateListener"],
        expected_files: ["EventListener/SurrogateListener.php"],
        heldOut: true,
    },
    {
        id: "HO-SF18",
        query: "execute a sub-request safely by stripping untrusted proxy headers first",
        difficulty: "semantic",
        topK: 10,
        description: "SubRequestHandler — handles an internal sub-request, sanitising trusted-proxy state",
        expected_names: ["SubRequestHandler"],
        expected_files: ["HttpCache/SubRequestHandler.php"],
        heldOut: true,
    },
    {
        id: "HO-SF19",
        query: "declare the HTTP status code an exception should map to",
        difficulty: "semantic",
        topK: 10,
        description: "WithHttpStatus attribute — annotates an exception class with the response status code to use",
        expected_names: ["WithHttpStatus"],
        expected_files: ["Attribute/WithHttpStatus.php"],
        heldOut: true,
    },
    {
        id: "HO-SF20",
        query: "fill in an action parameter with its default value when no other resolver supplies one",
        difficulty: "semantic",
        topK: 10,
        description: "DefaultValueResolver — yields the signature default (or null for nullable) when nothing else resolved",
        expected_names: ["DefaultValueResolver"],
        expected_files: ["Controller/ArgumentResolver/DefaultValueResolver.php"],
        heldOut: true,
    },
];
