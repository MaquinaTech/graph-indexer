/**
 * test/agent/search-cases.mjs
 *
 * Ground-truth retrieval cases for search-eval.mjs — one set per fixture.
 *
 * Each case is how a REAL agent would phrase a query (we do NOT tune the words
 * to make a backend win), paired with the genuinely-correct target chunk(s).
 * `expect` is a single matcher or an array of acceptable matchers; a match needs
 * every provided field (name/file/type, case-insensitive substring) to hold.
 *
 * kind:
 *   nl  — natural-language behavioural query (the semantic channel's home turf)
 *   kw  — domain-keyword query (lexical/BM25's home turf)
 *   xc  — cross-cutting concern phrased behaviourally
 */
export const SEARCH_CASES = {
    // ── JavaScript / TypeScript ────────────────────────────────────────────────
    axios: [
        { id: 'dispatch-flow',  kind: 'nl', query: 'send the configured request through the chain of interceptors before handing it to the adapter', expect: { name: 'dispatchRequest' } },
        { id: 'interceptors',   kind: 'kw', query: 'interceptor manager use eject forEach handlers', expect: { name: 'InterceptorManager' } },
        { id: 'merge-config',   kind: 'xc', query: 'merge two request configuration objects with per-key strategies', expect: { name: 'mergeConfig' } },
    ],
    'express-js': [
        { id: 'route-match',    kind: 'nl', query: 'match an incoming request path against a registered route and invoke its handler', expect: [{ name: 'Layer' }, { name: 'Route', file: 'route.js' }] },
        { id: 'router-dispatch',kind: 'kw', query: 'router handle dispatch middleware stack next', expect: { file: 'router/index.js' } },
        { id: 'json-response',  kind: 'xc', query: 'set the response status code and send a JSON body', expect: { file: 'response.js' } },
    ],
    nestjs: [
        { id: 'di-resolve',     kind: 'nl', query: 'resolve and instantiate a provider together with all of its dependencies', expect: { name: 'Injector' } },
        { id: 'module-scan',    kind: 'kw', query: 'module container dependencies scanner metadata register', expect: [{ name: 'DependenciesScanner' }, { name: 'NestContainer' }] },
        { id: 'app-bootstrap',  kind: 'xc', query: 'create a Nest application instance from a root module', expect: { name: 'NestFactory' } },
    ],
    react: [
        { id: 'modal-overlay',  kind: 'nl', query: 'render an overlay dialog that traps focus and can be dismissed by the user', expect: { name: 'Modal', file: 'Modal' } },
        { id: 'dropdown',       kind: 'kw', query: 'dropdown toggle menu context show', expect: { name: 'Dropdown' } },
        { id: 'button-variant', kind: 'xc', query: 'a clickable button styled by variant and size props', expect: { name: 'Button', file: 'Button' } },
    ],
    // ── Python ──────────────────────────────────────────────────────────────────
    fastapi: [
        { id: 'route-bind',     kind: 'nl', query: 'bind a path operation to its endpoint function, dependencies and response model', expect: { name: 'APIRoute' } },
        { id: 'solve-deps',     kind: 'kw', query: 'solve dependencies dependant sub dependencies cache', expect: { name: 'solve_dependencies' } },
        { id: 'validate-body',  kind: 'xc', query: 'validate an incoming request body against the declared pydantic model and collect errors', expect: { file: 'dependencies/utils.py' } },
    ],
    django: [
        { id: 'username-gen',   kind: 'nl', query: 'generate a unique username derived from a user email address', expect: { name: 'generate_username' } },
        { id: 'pw-reset',       kind: 'kw', query: 'password reset form email user', expect: { name: 'PasswordResetForm' } },
        { id: 'address-model',  kind: 'xc', query: 'abstract base model describing a postal address with name and country', expect: { name: 'AbstractAddress' } },
    ],
    // ── Go ────────────────────────────────────────────────────────────────────
    gin: [
        { id: 'serve-http',     kind: 'nl', query: 'find the route that matches an incoming request and run its handler chain', expect: [{ name: 'handleHTTPRequest' }, { name: 'ServeHTTP', file: 'gin.go' }] },
        { id: 'router-group',   kind: 'kw', query: 'router group middleware use handlers basePath', expect: { name: 'RouterGroup' } },
        { id: 'json-render',    kind: 'xc', query: 'serialize a value to JSON and write it to the response with a status code', expect: [{ name: 'JSON', file: 'context.go' }, { file: 'render/json.go' }] },
    ],
    // ── Rust ────────────────────────────────────────────────────────────────────
    rust: [
        { id: 'parse-str',      kind: 'nl', query: 'parse a JSON string into an in-memory value tree', expect: [{ name: 'from_str' }, { file: 'de.rs' }] },
        { id: 'serialize',      kind: 'kw', query: 'serializer write value to string formatter output', expect: { file: 'ser.rs' } },
        { id: 'ordered-map',    kind: 'xc', query: 'an ordered map that inserts and looks up entries by string key', expect: { name: 'Map', file: 'map.rs' } },
    ],
    // ── Java / Spring ─────────────────────────────────────────────────────────
    spring: [
        { id: 'owner-create',   kind: 'nl', query: 'handle the web form submission that creates a new pet owner', expect: { name: 'OwnerController' } },
        { id: 'owner-repo',     kind: 'kw', query: 'owner repository find by last name pageable', expect: { name: 'OwnerRepository' } },
        { id: 'pet-validate',   kind: 'xc', query: 'validate a pet has a name and type before it is saved', expect: { name: 'PetValidator' } },
    ],
    // ── Kotlin / Android ──────────────────────────────────────────────────────
    android: [
        { id: 'plant-list-vm',  kind: 'nl', query: 'view model exposing the list of plants and the grow-zone filter', expect: { name: 'PlantListViewModel' } },
        { id: 'garden-repo',    kind: 'kw', query: 'garden planting repository dao insert', expect: { name: 'GardenPlantingRepository' } },
        { id: 'plant-detail',   kind: 'xc', query: 'screen state for a single plant with an add-to-garden action', expect: { name: 'PlantDetailViewModel' } },
    ],
    // ── C# / ASP.NET Core ─────────────────────────────────────────────────────
    aspnet: [
        { id: 'catalog-list',   kind: 'nl', query: 'service returning a paged and filtered list of catalog items for display', expect: [{ name: 'CatalogViewModelService' }, { name: 'CatalogItemService' }] },
        { id: 'basket-add',     kind: 'kw', query: 'basket service add item quantity checkout', expect: { name: 'BasketService' } },
        { id: 'order-aggregate',kind: 'xc', query: 'the order aggregate holding order items and a shipping address', expect: { name: 'Order', file: 'Order.cs' } },
    ],
    // ── Ruby / Rails ──────────────────────────────────────────────────────────
    rails: [
        { id: 'post-status',    kind: 'nl', query: 'publish a new status for an account with text and media attachments', expect: { name: 'PostStatusService' } },
        { id: 'follow',         kind: 'kw', query: 'follow service account relationship create', expect: [{ name: 'FollowService' }, { name: 'Follow', file: 'follow.rb' }] },
        { id: 'process-ap',     kind: 'xc', query: 'process an incoming ActivityPub activity delivered to the inbox', expect: { name: 'ActivityPub' } },
    ],
    // ── PHP / Laravel ─────────────────────────────────────────────────────────
    laravel: [
        { id: 'scan-library',   kind: 'nl', query: 'scan the music library directory and import songs into the database', expect: [{ name: 'ScanCommand' }, { name: 'MediaScanner' }] },
        { id: 'stream-audio',   kind: 'kw', query: 'stream audio file song controller play', expect: [{ name: 'StreamController' }, { name: 'Streamer' }] },
        { id: 'playlist-add',   kind: 'xc', query: 'add a set of songs to an existing playlist', expect: [{ name: 'PlaylistService' }, { name: 'Playlist', file: 'Playlist.php' }] },
    ],
    // ── PHP / Symfony ─────────────────────────────────────────────────────────
    symfony: [
        { id: 'kernel-handle',  kind: 'nl', query: 'turn a request into a response by dispatching kernel events to listeners', expect: [{ name: 'HttpKernel', file: 'HttpKernel.php' }, { name: 'RequestEvent' }] },
        { id: 'controller-res', kind: 'kw', query: 'controller resolver argument value resolver', expect: { name: 'ControllerResolver' } },
        { id: 'esi-fragment',   kind: 'xc', query: 'render an embedded page fragment using an ESI surrogate', expect: { name: 'EsiFragmentRenderer' } },
    ],
    // ── CSS / SCSS (rule_set selectors + named @mixin/@function chunks) ──────────
    css: [
        { id: 'btn-variant', kind: 'kw', query: 'button variant background border color mixin', expect: { name: 'button-variant' } },
        { id: 'breakpoint',  kind: 'kw', query: 'media breakpoint min width responsive', expect: { name: 'media-breakpoint-up' } },
        { id: 'contrast-fn', kind: 'kw', query: 'color contrast ratio function', expect: { name: 'color-contrast' } },
    ],
    // ── C (cJSON: public API functions over the parsed tree) ────────────────────
    cjson: [
        { id: 'parse-json',  kind: 'nl', query: 'parse a JSON text string into an in-memory tree of value nodes', expect: { name: 'cJSON_Parse' } },
        { id: 'duplicate',   kind: 'kw', query: 'duplicate clone a JSON item recursively', expect: { name: 'cJSON_Duplicate' } },
        { id: 'compare',     kind: 'xc', query: 'compare two JSON values for deep structural equality', expect: { name: 'cJSON_Compare' } },
    ],
    // ── Bash (nvm: shell functions in nvm.sh / install.sh) ──────────────────────
    nvm: [
        { id: 'download-node',kind: 'nl', query: 'download a remote node binary tarball over the network for a version', expect: { name: 'nvm_download' } },
        { id: 'is-installed', kind: 'kw', query: 'is version installed check directory exists', expect: { name: 'nvm_is_version_installed' } },
        { id: 'latest-npm',   kind: 'xc', query: 'upgrade to the newest npm for the active node version', expect: { name: 'nvm_install_latest_npm' } },
    ],
    // ── Swift (Alamofire: Session / Request / HTTPHeaders + extensions) ─────────
    alamofire: [
        { id: 'session-mgr',  kind: 'nl', query: 'create and manage URL session requests with adapters retries and a delegate', expect: { name: 'Session' } },
        { id: 'request-state',kind: 'kw', query: 'request state resume suspend cancel task', expect: { name: 'Request' } },
        { id: 'http-headers', kind: 'xc', query: 'an ordered collection of HTTP header name and value pairs', expect: { name: 'HTTPHeaders' } },
    ],
};
