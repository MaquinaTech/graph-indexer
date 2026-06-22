/**
 * test/agent/benchmark.config.mjs
 *
 * The full-matrix agent benchmark: every supported language + framework, each as a
 * real indexed repo, exercised with NINE task archetypes that together cover the
 * WHOLE discovery tool surface and the per-language gotchas a coding agent actually
 * hits — not just resolve_symbol + get_call_graph.
 *
 *   symbol     — a known symbol: explain it, find usage, blast radius.            (resolve_symbol + topology)
 *   behaviour  — find code by BEHAVIOUR, no name given.                           (search_code, NL)
 *   keyword    — find code by domain keywords.                                    (search_code, lexical)
 *   crosscut   — a concern spanning files.                                        (multi-hop within budget)
 *   references — every referrer of a CLASS/TYPE: subclasses, implementers, type   (find_references)
 *                users, callers — and the per-language channel coverage.
 *   routes     — which handler serves an HTTP route. Tests BOTH find_routes-      (find_routes  | path search)
 *                supported frameworks AND the negative cases (Django/Rails/
 *                Laravel/Symfony/ASP.NET) where the correct move is a path search.
 *   refactor   — the COMPLETE caller set a signature change would break.          (get_call_graph)
 *   flow       — how a symbol connects across files (trace, don't describe one).  (get_subgraph)
 *   ecosystem  — a symbol's FULL composition tree incl. a dep-of-a-dep (depth-2): (card Deps/Calls + ONE hop)
 *                the failure class an ordinary lookup hides — a depth-1 answer
 *                looks complete but silently drops a grandchild dependency.
 *
 * GROUND TRUTH: every answerKey here was VERIFIED against the live fixture index by
 * driving the real tools (the discovery sweep). depth2 / referrer / caller keys are
 * substrings that literally appear in tool output — NEVER guessed. Re-derive with the
 * discovery workflow before adding a fixture; do not hand-author keys.
 *
 * `layers` is exactly what `npx graph-indexer init` assembles for that stack.
 * `answerKeys` are substrings a correct final answer is expected to contain (scored by
 * score-answers.mjs). `expectTools`/`avoidTools` are the discovery tools a clean answer
 * should / should not use for that archetype (scored by analyze.mjs tool-fit).
 */
import { SEARCH_CASES } from './search-cases.mjs';

const JS = 'languages/JAVASCRIPT_TYPESCRIPT.md';
const L = {
    CORE: 'CORE.md',
    js: JS, ts: JS,
    py: 'languages/PYTHON.md', go: 'languages/GO.md', rust: 'languages/RUST.md',
    java: 'languages/JAVA.md', kotlin: 'languages/KOTLIN.md', csharp: 'languages/CSHARP.md',
    ruby: 'languages/RUBY.md', php: 'languages/PHP.md', css: 'languages/CSS_SCSS.md',
    c: 'languages/C.md', bash: 'languages/BASH.md', swift: 'languages/SWIFT.md',
    fExpress: 'frameworks/NODE_EXPRESS_NESTJS.md', fReact: 'frameworks/REACT.md',
    fFastapi: 'frameworks/FASTAPI_DJANGO.md', fSpring: 'frameworks/SPRING_BOOT.md',
    fAndroid: 'frameworks/ANDROID.md', fAspnet: 'frameworks/ASPNET_CORE.md',
    fRails: 'frameworks/RAILS.md', fLaravel: 'frameworks/LARAVEL_SYMFONY.md',
};

const LAYERS = {
    axios: [L.CORE, L.js],
    'express-js': [L.CORE, L.js, L.fExpress],
    nestjs: [L.CORE, L.ts, L.fExpress],
    react: [L.CORE, L.ts, L.fReact],
    fastapi: [L.CORE, L.py, L.fFastapi],
    django: [L.CORE, L.py, L.fFastapi],
    gin: [L.CORE, L.go],
    rust: [L.CORE, L.rust],
    spring: [L.CORE, L.java, L.fSpring],
    android: [L.CORE, L.kotlin, L.fAndroid],
    aspnet: [L.CORE, L.csharp, L.fAspnet],
    rails: [L.CORE, L.ruby, L.fRails],
    laravel: [L.CORE, L.php, L.fLaravel],
    symfony: [L.CORE, L.php, L.fLaravel],
    css: [L.CORE, L.css],
    cjson: [L.CORE, L.c],
    nvm: [L.CORE, L.bash],
    alamofire: [L.CORE, L.swift],
};

const LANGUAGE = {
    axios: 'JavaScript', 'express-js': 'JavaScript', nestjs: 'TypeScript', react: 'TypeScript',
    fastapi: 'Python', django: 'Python', gin: 'Go', rust: 'Rust', spring: 'Java',
    android: 'Kotlin', aspnet: 'C#', rails: 'Ruby', laravel: 'PHP', symfony: 'PHP', css: 'SCSS',
    cjson: 'C', nvm: 'Bash', alamofire: 'Swift',
};

/** symbol-known target + the files/symbols a correct explain+usage+blast-radius answer names. */
const SYMBOL = {
    axios:        { target: 'dispatchRequest', kind: 'function', answerKeys: ['Axios', 'request', 'interceptor'] },
    'express-js': { target: 'Layer',           kind: 'class',    answerKeys: ['Router', 'Route', 'layer.js'] },
    nestjs:       { target: 'Injector',        kind: 'class',    answerKeys: ['instance', 'provider', 'injector.ts'] },
    react:        { target: 'Modal',           kind: 'component',answerKeys: ['Modal', 'overlay'] },
    fastapi:      { target: 'APIRoute',        kind: 'class',    answerKeys: ['APIRouter', 'routing', 'endpoint'] },
    django:       { target: 'AbstractAddress', kind: 'model',    answerKeys: ['Address', 'abstract_models'] },
    gin:          { target: 'Engine',          kind: 'struct',   answerKeys: ['RouterGroup', 'gin.go', 'ServeHTTP'] },
    rust:         { target: 'Map',             kind: 'struct',   answerKeys: ['map.rs', 'Value', 'insert'] },
    spring:       { target: 'OwnerController', kind: 'class',    answerKeys: ['Owner', 'OwnerRepository'] },
    android:      { target: 'PlantListViewModel', kind: 'class', answerKeys: ['Plant', 'ViewModel'] },
    aspnet:       { target: 'BasketService',   kind: 'class',    answerKeys: ['Basket', 'IBasketService'] },
    rails:        { target: 'PostStatusService', kind: 'class',  answerKeys: ['Status', 'Account'] },
    laravel:      { target: 'SongRepository',  kind: 'class',    answerKeys: ['Song', 'Repository'] },
    symfony:      { target: 'FragmentHandler', kind: 'class',    answerKeys: ['Fragment', 'render'] },
    css:          { target: 'button-variant',  kind: 'SCSS @mixin', answerKeys: ['button-variant', 'button'] },
    cjson:        { target: 'cJSON_Parse',     kind: 'function', answerKeys: ['cJSON_ParseWithOpts', 'cJSON.c'] },
    nvm:          { target: 'nvm_echo',        kind: 'function', answerKeys: ['nvm.sh', 'install.sh', 'printf'] },
    alamofire:    { target: 'Session',         kind: 'class',    answerKeys: ['SessionDelegate', 'RequestInterceptor', 'Session.swift'] },
};

/**
 * references: a CLASS/TYPE/INTERFACE/struct whose find_references output is meaningful.
 * `channels` records which find_references channels this language populates (callers /
 * extends / type_refs) — the per-language coverage the answer should acknowledge.
 */
const REFERENCES = {
    nestjs:    { target: 'Injector',                  kind: 'class',     answerKeys: ['TestingInjector', 'InstanceLoader', 'RouterExplorer'], channels: 'extends+type_refs' },
    react:     { target: 'TransitionCallbacks',       kind: 'interface', answerKeys: ['Fade', 'Collapse', 'TabPane', 'Toast'],                channels: 'type_refs' },
    fastapi:   { target: 'APIRoute',                  kind: 'class',     answerKeys: ['GzipRoute', 'ValidationErrorLoggingRoute', 'TimedRoute'], channels: 'extends' },
    django:    { target: 'AbstractAddress',           kind: 'model',     answerKeys: ['AbstractShippingAddress', 'AbstractBillingAddress', 'AbstractPartnerAddress'], channels: 'extends' },
    gin:       { target: 'RouterGroup',               kind: 'struct',    answerKeys: ['Engine', 'IRouter', 'Group', 'Handle'],                  channels: 'extends+type_refs' },
    rust:      { target: 'Value',                     kind: 'enum',      answerKeys: ['from.rs', 'de.rs', 'ser.rs', 'retain'],                  channels: 'extends+type_refs(heuristic)' },
    spring:    { target: 'OwnerRepository',           kind: 'interface', answerKeys: ['OwnerController', 'PetController', 'VisitController'],    channels: 'type_refs' },
    android:   { target: 'Plant',                     kind: 'class',     answerKeys: ['PlantDao', 'PlantListViewModel', 'GardenPlanting', 'SeedDatabaseWorker'], channels: 'callers+extends+type_refs' },
    aspnet:    { target: 'IBasketService',            kind: 'interface', answerKeys: ['BasketService', 'LoginModel', 'CheckoutModel', 'IndexModel'], channels: 'extends+type_refs(field-precise)' },
    rails:     { target: 'BaseService',               kind: 'class',     answerKeys: ['ReblogService', 'FavouriteService', 'SearchService'],    channels: 'extends' },
    laravel:   { target: 'SongRepository',            kind: 'class',     answerKeys: ['SongController', 'ScrobbleController', 'UploadSongController'], channels: 'type_refs' },
    symfony:   { target: 'FragmentRendererInterface', kind: 'interface', answerKeys: ['RoutableFragmentRenderer', 'AbstractSurrogateFragmentRenderer', 'FragmentHandler'], channels: 'extends+type_refs' },
    cjson:     { target: 'cJSON_Delete',              kind: 'function',  answerKeys: ['cJSON_ParseWithLengthOpts', 'parse_array', 'parse_object'], channels: 'callers' },
    nvm:       { target: 'nvm_version_dir',           kind: 'function',  answerKeys: ['nvm_alias_path', 'nvm_version_path', 'nvm_ls'],          channels: 'callers' },
    alamofire: { target: 'RequestInterceptor',        kind: 'protocol',  answerKeys: ['OfflineRetrier', 'DeflateRequestCompressor', 'RetryPolicy', 'AuthenticationInterceptor'], channels: 'extends+type_refs(heuristic)' },
};

/**
 * routes: which handler serves an HTTP route.
 *   supported:true  → find_routes returns it (Express/NestJS/FastAPI/Spring). expect find_routes.
 *   supported:false → find_routes is EMPTY by design (Django URLconf, Rails/Laravel routes
 *                     files, ASP.NET + attribute routing, Symfony). The CORRECT behaviour is
 *                     to search the URL/path/action string — expect search_code, NOT a
 *                     find_routes retry loop. This negative case is the per-framework gotcha.
 */
const ROUTES = {
    'express-js': { supported: true,  route: 'GET /users',                              handler: 'format',          answerKeys: ['/users', 'format'] },
    nestjs:       { supported: true,  route: 'GET /cats/:id',                           handler: 'findOne',         answerKeys: ['findOne', '/cats/:id', 'cats.controller'] },
    fastapi:      { supported: true,  route: 'GET /users/{user_id}/items/{item_id}',    handler: 'read_user_item',  answerKeys: ['read_user_item', '/users/{user_id}/items'] },
    spring:       { supported: true,  route: 'GET /owners/new',                         handler: 'initCreationForm',answerKeys: ['/owners/new', 'initCreationForm', 'OwnerController'] },
    django:       { supported: false, routeHint: 'the "shipping-address/" checkout URL', handler: 'ShippingAddressView', answerKeys: ['ShippingAddressView', 'checkout/views.py'] },
    aspnet:       { supported: false, routeHint: 'the order-detail endpoint (OrderController, attribute-routed)', handler: 'OrderController', answerKeys: ['OrderController', 'Detail', 'MyOrders'] },
    rails:        { supported: false, routeHint: 'POST /api/v1/statuses (create a new status)', handler: 'Api::V1::StatusesController', answerKeys: ['StatusesController', 'create', 'PostStatusService'] },
    laravel:      { supported: false, routeHint: 'the audio-scrobble endpoint', handler: 'ScrobbleController', answerKeys: ['ScrobbleController'] },
    symfony:      { supported: false, routeHint: 'the entry point that turns a Request into a Response', handler: 'HttpKernel::handle', answerKeys: ['handle', 'HttpKernel', 'Response'] },
};

/** refactor: a FUNCTION/METHOD with a real, enumerable caller set get_call_graph resolves. */
const REFACTOR = {
    axios:        { target: 'mergeConfig',        kind: 'function', answerKeys: ['createInstance', 'Axios', 'lib/core/Axios.js'] },
    'express-js': { target: 'Layer',              kind: 'function', answerKeys: ['Route', 'lib/router/route.js'] },
    nestjs:       { target: 'loadInstance',       kind: 'method', targetClass: 'Injector', answerKeys: ['loadMiddleware', 'loadPerContext', 'injector.ts'] },
    react:        { target: 'useWrappedRefWithWarning', kind: 'hook', answerKeys: ['DropdownMenu', 'DropdownToggle'] },
    fastapi:      { target: 'compile_path',       kind: 'function', answerKeys: ['APIWebSocketRoute', 'APIRoute', 'routing.py'] },
    django:       { target: 'get_password_reset_url', kind: 'function', answerKeys: ['PasswordResetForm', 'ProfileUpdateView', 'ChangePasswordView'] },
    gin:          { target: 'nameOfFunction',     kind: 'function', answerKeys: ['HandlerName', 'HandlerNames', 'debugPrintRoute'] },
    rust:         { target: 'parse_index',        kind: 'function', answerKeys: ['pointer', 'pointer_mut', 'value/mod.rs'] },
    android:      { target: 'isFiltered',         kind: 'method',   answerKeys: ['PlantListViewModel'] },
    aspnet:       { target: 'GetOrCreateBasketForUser', kind: 'method', targetClass: 'BasketViewModelService', answerKeys: ['CheckoutModel', 'IndexModel'] },
    rails:        { target: 'validate_media!',    kind: 'method',   answerKeys: ['PostStatusService', 'UpdateStatusService'] },
    laravel:      { target: 'getForListing',      kind: 'method', targetClass: 'SongRepository', answerKeys: ['AlbumController', 'ArtistController'] },
    symfony:      { target: 'addRenderer',        kind: 'method', targetClass: 'FragmentHandler', answerKeys: ['LazyLoadingFragmentHandler', 'FragmentHandler'] },
    cjson:        { target: 'cJSON_ParseWithOpts', kind: 'function', answerKeys: ['cJSON_Parse', 'cJSON.c'] },
    nvm:          { target: 'nvm_version_dir',    kind: 'function', answerKeys: ['nvm_alias_path', 'nvm_version_path', 'nvm_ls'] },
    alamofire:    { target: 'cleanup',            kind: 'method',   answerKeys: ['Request', 'UploadRequest'] },
};

/** flow: a seed with a rich get_subgraph neighbourhood (callees + callers across files). */
const FLOW = {
    axios:        { seed: 'Axios',                kind: 'class',    answerKeys: ['mergeConfig', 'assertOptions', 'buildURL', 'buildFullPath'] },
    'express-js': { seed: 'format',               kind: 'function', answerKeys: ['res.redirect', 'setCharset', 'render'] },
    nestjs:       { seed: 'Injector',             kind: 'class',    answerKeys: ['instantiateClass', 'loadProvider', 'loadInstance'] },
    react:        { seed: 'Carousel',             kind: 'component',answerKeys: ['triggerBrowserReflow', 'useBootstrapPrefix', 'useIsRTL'] },
    fastapi:      { seed: 'get_request_handler',  kind: 'function', answerKeys: ['run_endpoint_function', 'serialize_response', 'solve_dependencies'] },
    django:       { seed: 'get_shipping_address', kind: 'method',   answerKeys: ['is_shipping_required', 'populate_alternative_model'] },
    gin:          { seed: 'nameOfFunction',       kind: 'function', answerKeys: ['debugPrintRoute', 'IsDebugging', 'debugPrint'] },
    rust:         { seed: 'parse_index',          kind: 'function', answerKeys: ['pointer', 'pointer_mut', 'deserialize_number'] },
    spring:       { seed: 'Owner',                kind: 'class',    answerKeys: ['OwnerController', 'OwnerRepository', 'VisitController'] },
    android:      { seed: 'Plant',                kind: 'class',    answerKeys: ['PlantDao', 'PlantRepository', 'GardenPlanting'] },
    aspnet:       { seed: 'Basket',               kind: 'class',    answerKeys: ['IBasketService', 'BasketService', 'OrderService'] },
    rails:        { seed: 'PostStatusService',    kind: 'class',    answerKeys: ['process_status!', 'Antispam', 'considered_spam?'] },
    laravel:      { seed: 'SongService',          kind: 'class',    answerKeys: ['findOneByPath', 'resolveAlbum', 'updateSong'] },
    symfony:      { seed: 'InlineFragmentRenderer', kind: 'class',  answerKeys: ['ResponseCacheStrategy', 'HttpCache', 'Profiler'] },
    cjson:        { seed: 'cJSON_ParseWithLengthOpts', kind: 'function', answerKeys: ['parse_value', 'cJSON_New_Item', 'buffer_skip_whitespace'] },
    nvm:          { seed: 'nvm_version_path',     kind: 'function', answerKeys: ['nvm_strip_iojs_prefix', 'nvm_version_greater', 'nvm_version_dir'] },
    alamofire:    { seed: 'Session',              kind: 'class',    answerKeys: ['CompositeEventMonitor', 'RequestTaskMap', 'SessionDelegate'] },
};

/**
 * ecosystem — the DEPTH-2 composition probe (the failure class a depth-1 answer hides).
 *   depth1 — direct deps ON the seed's own card (Deps:/Calls/Type refs). Any answer covers these.
 *   depth2 — a dep-of-a-dep, NOT on the seed card. Only an answer that hops into a principal
 *            dependency (or names the boundary) covers it → the discriminator.
 *   callComposition:true — composition is via the CALL graph (Ruby/Django here), so depth2 IS
 *            reachable by get_subgraph(depth:2). Otherwise (import/type/DI composition, incl.
 *            React JSX) get_subgraph is BLIND to depth2 → reading the dep's card is the only way,
 *            and get_subgraph is the wrong tool (avoidTools).
 */
const ECOSYSTEM = {
    axios:     { seed: 'Axios',         kind: 'class', depth1: ['mergeConfig', 'buildURL', 'dispatchRequest'], depth2: ['throwIfCancellationRequested', 'getMergedValue', 'mergeDeepProperties'] },
    react:     { seed: 'Modal',         kind: 'component', depth1: ['Fade', 'ModalDialog', 'BootstrapModalManager'], depth2: ['TransitionWrapper'] },
    fastapi:   { seed: 'FastAPI',       kind: 'class', depth1: ['APIRouter', 'setup'], depth2: ['get_swagger_ui_html'] },
    django:    { seed: 'PasswordResetForm', kind: 'class', depth1: ['CustomerDispatcher', 'get_password_reset_url'], depth2: ['Dispatcher'], callComposition: true },
    spring:    { seed: 'PetController', kind: 'class', depth1: ['PetTypeRepository', 'PetValidator', 'PetType', 'Pet'], depth2: ['NamedEntity', 'Validator'] },
    android:   { seed: 'PlantListViewModel', kind: 'class', depth1: ['PlantRepository', 'SavedStateHandle'], depth2: ['PlantDao'] },
    aspnet:    { seed: 'BasketService', kind: 'class', depth1: ['IRepository', 'Basket', 'IAppLogger', 'BasketWithItemsSpecification'], depth2: ['IRepositoryBase'] },
    rails:     { seed: 'PostStatusService', kind: 'class', depth1: ['Antispam', 'validate_media!', 'process_status!'], depth2: ['considered_spam?', 'report_if_needed!'], callComposition: true },
    laravel:   { seed: 'SongService',   kind: 'class', depth1: ['SongRepository', 'TranscodeRepository', 'AlbumService', 'CacheStrategy'], depth2: ['ImageStorage', 'Finder', 'AlbumRepository'] },
    symfony:   { seed: 'InlineFragmentRenderer', kind: 'class', depth1: ['RoutableFragmentRenderer', 'HttpKernelInterface', 'ControllerReference'], depth2: ['FragmentRendererInterface'] },
    cjson:     { seed: 'cJSON_ParseWithLengthOpts', kind: 'function', depth1: ['cJSON_New_Item', 'parse_value', 'buffer_skip_whitespace', 'skip_utf8_bom'], depth2: ['parse_string', 'parse_number'] },
    nvm:       { seed: 'nvm_version_path', kind: 'function', depth1: ['nvm_strip_iojs_prefix', 'nvm_version_dir'], depth2: ['nvm_iojs_prefix'] },
};

const EXPECT = {
    symbol:    { expect: ['resolve_symbol', 'search_code'], avoid: [] },
    behaviour: { expect: ['search_code'], avoid: [] },
    keyword:   { expect: ['search_code'], avoid: [] },
    crosscut:  { expect: ['search_code'], avoid: [] },
    references:{ expect: ['find_references'], avoid: [] },
    refactor:  { expect: ['get_call_graph'], avoid: [] },
    flow:      { expect: ['get_subgraph'], avoid: [] },
};

/** Build the BENCHMARKS array from the layer/archetype tables. */
export const BENCHMARKS = Object.keys(LAYERS).map(fixture => {
    const cases = SEARCH_CASES[fixture] || [];
    const byKind = (k) => cases.find(c => c.kind === k);
    const tasks = {};

    const sym = SYMBOL[fixture];
    if (sym) tasks.symbol = {
        prompt: `Explore and summarize how \`${sym.target}\` (a ${sym.kind}) works in this codebase. Then (1) identify exactly where and how it is used, (2) map its dependencies, and (3) determine its blast radius — what would break if its signature changed.`,
        answerKeys: sym.answerKeys, target: sym.target, ...EXPECT.symbol,
    };

    const b = byKind('nl'); if (b) tasks.behaviour = { prompt: `Find and explain the code that does this (you are NOT given its name): ${b.query}.`, answerKeys: asKeys(b.expect), query: b.query, ...EXPECT.behaviour };
    const k = byKind('kw'); if (k) tasks.keyword = { prompt: `Locate the code for: ${k.query}. Identify the responsible symbol and where it is used.`, answerKeys: asKeys(k.expect), query: k.query, ...EXPECT.keyword };
    const x = byKind('xc'); if (x) tasks.crosscut = { prompt: `Investigate this concern across the codebase: ${x.query}. Explain how it works and which components participate.`, answerKeys: asKeys(x.expect), query: x.query, ...EXPECT.crosscut };

    const ref = REFERENCES[fixture];
    if (ref) tasks.references = {
        prompt: `Find every place that references \`${ref.target}\` (a ${ref.kind}) — what subclasses or implements it, type-annotates or injects it, and calls it. List the impact surface and note which reference channels this language actually populates.`,
        answerKeys: ref.answerKeys, target: ref.target, channels: ref.channels, ...EXPECT.references,
    };

    const rt = ROUTES[fixture];
    if (rt) tasks.routes = {
        prompt: rt.supported
            ? `Which handler serves the \`${rt.route}\` HTTP route, where is it defined, and what does it do?`
            : `Find the handler for ${rt.routeHint} and where it lives. (Routes may not be in the extracted route table for this framework — fall back to searching the path/action string if so.)`,
        answerKeys: rt.answerKeys, route: rt.route || rt.routeHint, handler: rt.handler,
        findRoutesSupported: rt.supported,
        expect: rt.supported ? ['find_routes'] : ['search_code'], avoid: [],
    };

    const rf = REFACTOR[fixture];
    if (rf) tasks.refactor = {
        prompt: `You need to change the signature of \`${rf.target}\` (a ${rf.kind}). Identify the COMPLETE set of callers that would break so the refactor is safe — completeness matters more than reading any single body.`,
        answerKeys: rf.answerKeys, target: rf.target, targetClass: rf.targetClass || null, ...EXPECT.refactor,
    };

    const fl = FLOW[fixture];
    if (fl) tasks.flow = {
        prompt: `Trace how \`${fl.seed}\` (a ${fl.kind}) connects across the codebase: what it calls and how those pieces link together. Map the flow in one pass — don't just describe the single symbol.`,
        answerKeys: fl.answerKeys, seed: fl.seed, ...EXPECT.flow,
    };

    const eco = ECOSYSTEM[fixture];
    if (eco) tasks.ecosystem = {
        prompt: `Explain \`${eco.seed}\` and its FULL dependency ecosystem: what it is built from / composed of — INCLUDING what its own direct dependencies are in turn composed of — and where it is used.`,
        answerKeys: [...eco.depth1, ...eco.depth2], seed: eco.seed, depth1: eco.depth1, depth2: eco.depth2,
        expect: ['resolve_symbol', 'get_chunk', 'get_chunk_summary', 'get_file_skeleton'],
        avoid: eco.callComposition ? [] : ['get_subgraph'],
    };

    return { fixture, language: LANGUAGE[fixture], layers: LAYERS[fixture], tasks };
});

function asKeys(expect) {
    const arr = Array.isArray(expect) ? expect : [expect];
    return [...new Set(arr.flatMap(e => [e.name, e.file].filter(Boolean)))];
}

export const ARCHETYPES = ['symbol', 'behaviour', 'keyword', 'crosscut', 'references', 'routes', 'refactor', 'flow', 'ecosystem'];
