/**
 * test/suites/alamofire.mjs
 *
 * Ground-truth query set for Alamofire (Swift, subset).
 * Source: https://github.com/Alamofire/Alamofire
 *
 * Every expected_name below is a REAL indexed symbol drawn from
 * bench/_chunks/alamofire.json (whole name or a real class_context).
 *
 * Key source layout (under Core/, Features/, Extensions/):
 *   Core/Session.swift            — class Session (creates/manages requests, adapters,
 *                                     retries, SessionDelegate), request(), cancelAllRequests
 *   Core/Request.swift            — class Request (state machine: resume/suspend/cancel,
 *                                     task lifecycle, retry, finish), RequestDelegate
 *   Core/DataRequest.swift        — class DataRequest, response*, validate
 *   Core/DownloadRequest.swift    — class DownloadRequest, suggestedDownloadDestination
 *   Core/HTTPHeaders.swift        — struct HTTPHeaders / HTTPHeader (ordered header pairs)
 *   Core/HTTPMethod.swift         — struct HTTPMethod (GET/POST/...)
 *   Core/ParameterEncoding.swift  — protocol ParameterEncoding, URLEncoding, JSONEncoding
 *   Core/AFError.swift            — enum AFError + nested failure reasons
 *   Features/Validation.swift     — validate(statusCode:)/validate(contentType:)
 *   Features/RetryPolicy.swift    — class RetryPolicy / ConnectionLostRetryPolicy
 *   Features/MultipartFormData.swift — class MultipartFormData, append(...)
 *   Features/ServerTrustEvaluation.swift — ServerTrustEvaluating, PinnedCertificatesTrustEvaluator
 *   Features/NetworkReachabilityManager.swift — startListening / stopListening / status
 *   Features/RedirectHandler.swift — RedirectHandler / Redirector
 *   Features/CachedResponseHandler.swift — CachedResponseHandler / ResponseCacher
 *   Features/AuthenticationInterceptor.swift — AuthenticationInterceptor, Authenticator
 */

export const META = {
    id: 'alamofire',
    displayName: 'Alamofire (subset)',
    language: 'Swift',
    version: 'subset',
    url: 'https://github.com/Alamofire/Alamofire',
    expectedMinChunks: 200,
    expectedMinFiles: 20,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'AF01',
        query: 'HTTPHeaders',
        difficulty: 'easy',
        topK: 5,
        description: 'HTTPHeaders / HTTPHeader — ordered collection of HTTP header name/value pairs',
        expected_names: ['HTTPHeaders', 'HTTPHeader'],
        expected_files: ['HTTPHeaders'],
    },
    {
        id: 'AF02',
        query: 'HTTPMethod',
        difficulty: 'easy',
        topK: 5,
        description: 'HTTPMethod — wrapper for GET/POST/PUT/DELETE verbs',
        expected_names: ['HTTPMethod'],
        expected_files: ['HTTPMethod'],
    },
    {
        id: 'AF03',
        query: 'AFError',
        difficulty: 'easy',
        topK: 5,
        description: 'AFError — the framework error type with nested failure reasons',
        expected_names: ['AFError'],
        expected_files: ['AFError'],
    },

    // ── MEDIUM (keyword lookup of a concrete API) ───────────────────────────────

    {
        id: 'AF04',
        query: 'request state resume suspend cancel task',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Request — the request state machine driving the URLSession task lifecycle',
        expected_names: ['Request'],
        expected_files: ['Core/Request'],
    },
    {
        id: 'AF05',
        query: 'session manager create request adapter retry delegate',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Session — creates and manages requests with interceptors, retries and a delegate',
        expected_names: ['Session'],
        expected_files: ['Core/Session'],
    },
    {
        id: 'AF06',
        query: 'parameter encoding url query json body',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'ParameterEncoding family — encode request parameters as URL query or JSON body',
        expected_names: ['ParameterEncoding', 'URLEncoding', 'JSONEncoding'],
        expected_files: ['ParameterEncoding'],
    },
    {
        id: 'AF07',
        query: 'response validation acceptable status code content type',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'validate() — checks the response status code and content type are acceptable',
        expected_names: ['validate'],
        expected_files: ['Validation'],
    },

    // ── HARD (cross-cutting, phrased behaviourally) ─────────────────────────────

    {
        id: 'AF08',
        query: 'retry a failed network request after a delay with exponential backoff up to a limit',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'RetryPolicy — retrier that re-attempts idempotent requests with backoff',
        expected_names: ['RetryPolicy', 'ConnectionLostRetryPolicy'],
        expected_files: ['RetryPolicy'],
    },
    {
        id: 'AF09',
        query: 'build a multipart form body appending file data with a boundary for upload',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'MultipartFormData — assembles a multipart/form-data body from parts',
        expected_names: ['MultipartFormData', 'BodyPart'],
        expected_files: ['MultipartFormData'],
    },

    // ── SEMANTIC (natural-language intent; target NOT named) ────────────────────

    {
        id: 'AF10',
        query: 'pin a server certificate and reject the connection when the TLS chain does not match',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Pinned-certificate server trust evaluation for TLS pinning',
        expected_names: ['PinnedCertificatesTrustEvaluator', 'ServerTrustEvaluating'],
        expected_files: ['ServerTrustEvaluation'],
    },
    {
        id: 'AF11',
        query: 'watch whether the device currently has an internet connection and notify when it changes',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Network reachability monitoring — start/stop listening for connectivity changes',
        expected_names: ['NetworkReachabilityManager', 'startListening', 'NetworkReachabilityStatus'],
        expected_files: ['NetworkReachabilityManager'],
    },
    {
        id: 'AF12',
        query: 'decide whether a redirect response should be followed or rewritten before continuing',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Redirect handling policy applied when the server responds with a redirect',
        expected_names: ['RedirectHandler', 'Redirector'],
        expected_files: ['RedirectHandler'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-AF1',
        query: 'OfflineRetrier',
        difficulty: 'easy',
        topK: 5,
        description: 'OfflineRetrier — retrier that waits for connectivity before retrying',
        expected_names: ['OfflineRetrier'],
        expected_files: ['OfflineRetrier'],
        heldOut: true,
    },
    {
        id: 'HO-AF2',
        query: 'attach an OAuth credential to outgoing requests and refresh it when it expires',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Authentication interceptor that adapts requests with a credential and refreshes on expiry',
        expected_names: ['AuthenticationInterceptor', 'Authenticator'],
        expected_files: ['AuthenticationInterceptor'],
        heldOut: true,
    },
    {
        id: 'HO-AF3',
        query: 'customize the cached response stored for a request or prevent it from being cached',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Cached response handling — mutate or drop the URLCache entry for a response',
        expected_names: ['CachedResponseHandler', 'ResponseCacher'],
        expected_files: ['CachedResponseHandler'],
        heldOut: true,
    },
];
