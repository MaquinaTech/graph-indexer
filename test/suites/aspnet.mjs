/**
 * test/suites/aspnet.mjs
 *
 * Ground-truth query set for eShopOnWeb (C# / ASP.NET Core).
 * Source: https://github.com/dotnet-architecture/eShopOnWeb (subset)
 *
 * Clean-architecture layout (the parts indexed in this fixture):
 *   ApplicationCore/
 *     Entities/        — domain aggregates: Basket, Order, CatalogItem, Buyer, ...
 *     Services/        — BasketService, OrderService, UriComposer
 *     Specifications/  — Ardalis.Specification query objects (filter/paging)
 *     Interfaces/      — IBasketService, IOrderService, IRepository, ...
 *   Infrastructure/
 *     Data/            — EfRepository<T> (EF Core repository), CatalogContext
 *     Identity/        — IdentityTokenClaimService (JWT), ApplicationUser
 *     Services/        — EmailSender
 *   PublicApi/
 *     *Endpoints/      — minimal-API endpoints (Create/Update/Delete/List catalog)
 *     Middleware/      — ExceptionMiddleware (global error handler)
 *   Web/
 *     Services/        — CatalogViewModelService, CachedCatalogViewModelService
 *     wwwroot/css/     — component stylesheets (rule_set chunks)
 */

export const META = {
    id: 'aspnet',
    displayName: 'eShopOnWeb (ASP.NET Core)',
    language: 'C#/ASP.NET',
    version: 'subset',
    url: 'https://github.com/dotnet-architecture/eShopOnWeb',
    expectedMinChunks: 200,
    expectedMinFiles: 120,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'AN01',
        query: 'BasketService',
        difficulty: 'easy',
        topK: 5,
        description: 'Application service for basket operations (add item, set quantities, transfer, delete)',
        expected_names: ['BasketService', 'IBasketService'],
        expected_files: ['ApplicationCore/Services/BasketService.cs'],
    },
    {
        id: 'AN02',
        query: 'EfRepository entity framework repository',
        difficulty: 'easy',
        topK: 5,
        description: 'Generic EF Core repository implementing the read/write repository interfaces',
        expected_names: ['EfRepository'],
        expected_files: ['Infrastructure/Data/EfRepository.cs'],
    },
    {
        id: 'AN03',
        query: 'ExceptionMiddleware error handler',
        difficulty: 'easy',
        topK: 5,
        description: 'ASP.NET middleware that catches unhandled exceptions and writes a JSON error response',
        expected_names: ['ExceptionMiddleware'],
        expected_files: ['PublicApi/Middleware/ExceptionMiddleware.cs'],
    },

    // ── MEDIUM (keyword lookup) ─────────────────────────────────────────────────

    {
        id: 'AN04',
        query: 'order service create order from basket checkout',
        difficulty: 'medium',
        topK: 5,
        description: 'OrderService.CreateOrderAsync builds an Order from a basket and ships it to an address',
        expected_names: ['OrderService', 'IOrderService'],
        expected_files: ['ApplicationCore/Services/OrderService.cs'],
    },
    {
        id: 'AN06',
        query: 'EmailSender send email account confirmation password reset',
        difficulty: 'medium',
        topK: 5,
        description: 'Email sender implementation used for account confirmation and password reset',
        expected_names: ['EmailSender', 'IEmailSender'],
        expected_files: ['Infrastructure/Services/EmailSender.cs'],
    },
    {
        id: 'AN07',
        query: 'component stylesheet css rules header',
        difficulty: 'medium',
        topK: 10,
        description: 'CSS rule sets for the application and shared header component stylesheets',
        expected_names: ['app_rule_set', 'header_rule_set', 'app.component_rule_set'],
        expected_files: ['Web/wwwroot/css'],
    },

    // ── NL / SEMANTIC (behavioural — target symbol NOT named) ───────────────────

    {
        id: 'AN08',
        query: 'service returning a paged and filtered list of catalog items for display',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Catalog view-model service that produces the paged/filtered catalog index for the storefront',
        expected_names: ['CatalogViewModelService', 'CatalogItemService', 'CachedCatalogViewModelService'],
        expected_files: ['Web/Services'],
    },
    {
        id: 'AN09',
        query: 'issue a signed JSON web token for a user containing their roles after sign in',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Builds a signed JWT carrying the user name and role claims',
        expected_names: ['IdentityTokenClaimService', 'ITokenClaimsService'],
        expected_files: ['Infrastructure/Identity/IdentityTokenClaimService.cs'],
    },
    // ── XC (cross-cutting, phrased behaviourally) ───────────────────────────────

    {
        id: 'AN11',
        query: 'persist a customer basket using the generic data-access repository abstraction',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'The repository interface(s) the basket aggregate is stored through (IRepository / IReadRepository)',
        expected_names: ['IRepository', 'IReadRepository'],
        expected_files: ['ApplicationCore/Interfaces'],
    },
    {
        id: 'AN12',
        query: 'the order aggregate holding order items and a shipping address',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Order aggregate root that encapsulates its order items and ship-to address and totals them (seed)',
        expected_names: ['Order', 'OrderItem'],
        expected_files: ['ApplicationCore/Entities/OrderAggregate/Order.cs'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──────────────────

    {
        id: 'HO-AN1',
        query: 'AuthenticateEndpoint',
        difficulty: 'easy',
        topK: 5,
        description: 'Minimal-API endpoint that authenticates a user and returns a token',
        expected_names: ['AuthenticateEndpoint'],
        expected_files: ['PublicApi/AuthEndpoints/AuthenticateEndpoint.cs'],
        heldOut: true,
    },
    {
        id: 'HO-AN2',
        query: 'record that captures the product details of a catalog item at the moment it was ordered',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Value object snapshotting catalog item name/picture/id on an order line',
        expected_names: ['CatalogItemOrdered'],
        expected_files: ['ApplicationCore/Entities/OrderAggregate/CatalogItemOrdered.cs'],
        heldOut: true,
    },
    {
        id: 'HO-AN3',
        query: 'wrap an inner catalog service to memoize its results in an in-memory cache',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'Caching decorator that stores catalog brand/type/item view models in IMemoryCache',
        expected_names: ['CachedCatalogItemServiceDecorator', 'CachedCatalogLookupDataServiceDecorator'],
        expected_files: ['BlazorAdmin/Services'],
        heldOut: true,
    },
];
