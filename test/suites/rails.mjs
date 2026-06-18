/**
 * test/suites/rails.mjs
 *
 * Ground-truth query set for the Rails (Ruby) fixture — a subset of
 * mastodon/mastodon (a large ActivityPub social-network server).
 *
 * Source layout (files live directly under test/fixtures/rails/):
 *   services/                 — service objects (the "do one thing" command pattern)
 *     post_status_service.rb        — PostStatusService: publish a new status
 *     follow_service.rb             — FollowService: follow another account
 *     fan_out_on_write_service.rb   — FanOutOnWriteService: push a status to feeds
 *     notify_service.rb             — NotifyService: create notifications
 *     mute_service.rb               — MuteService: mute an account
 *     suspend_account_service.rb    — SuspendAccountService: suspend an account
 *     resolve_account_service.rb    — ResolveAccountService: find/create remote acct
 *     fetch_link_card_service.rb    — FetchLinkCardService: fetch link preview cards
 *     process_mentions_service.rb   — ProcessMentionsService: resolve @mentions
 *     batched_remove_status_service.rb — bulk status deletion
 *     translate_status_service.rb   — TranslateStatusService: translate status text
 *     activitypub/process_collection_service.rb — ActivityPub::ProcessCollectionService
 *   models/                   — ActiveRecord models (Status, Account, Follow, PreviewCard, ...)
 *   lib/                      — feed_manager.rb, text_formatter.rb, html_aware_formatter.rb,
 *                               link_details_extractor.rb, webfinger.rb
 *   controllers/concerns/     — signature_verification.rb (HTTP signature auth)
 *
 * NOTE: ActivityPub classes are namespaced (e.g. ActivityPub::ProcessCollectionService).
 * The strict predicate splits on `::`/`.`/`#`, so the bare component name resolves.
 */

export const META = {
    id: 'rails',
    displayName: 'Mastodon (Rails subset)',
    language: 'Ruby/Rails',
    version: 'subset',
    url: 'https://github.com/mastodon/mastodon',
    expectedMinChunks: 80,
    expectedMinFiles: 40,
};

export const QUERIES = [
    // ── EASY (symbolic name / keyword lookup) ───────────────────────────────────

    {
        id: 'RB01',
        query: 'FollowService',
        difficulty: 'easy',
        topK: 5,
        description: 'FollowService — follow another account and create the relationship (adapted seed: follow)',
        expected_names: ['FollowService', 'Follow'],
        expected_files: ['services/follow_service.rb', 'models/follow.rb'],
    },
    {
        id: 'RB02',
        query: 'FeedManager',
        difficulty: 'easy',
        topK: 5,
        description: 'FeedManager — manages Redis-backed home/list timeline feeds',
        expected_names: ['FeedManager'],
        expected_files: ['lib/feed_manager.rb'],
    },
    {
        id: 'RB03',
        query: 'PreviewCard',
        difficulty: 'easy',
        topK: 5,
        description: 'PreviewCard — model for link preview cards attached to statuses',
        expected_names: ['PreviewCard'],
        expected_files: ['models/preview_card.rb'],
    },

    // ── MEDIUM (keyword lookup over a behavioural concept) ──────────────────────

    {
        id: 'RB04',
        query: 'mute account notifications service',
        difficulty: 'medium',
        topK: 5,
        description: 'MuteService — mutes a target account and optionally hides its notifications',
        expected_names: ['MuteService'],
        expected_files: ['services/mute_service.rb'],
    },
    {
        id: 'RB05',
        query: 'fetch link preview card from url',
        difficulty: 'medium',
        topK: 5,
        description: 'FetchLinkCardService — extracts URLs from a status and builds a link preview card',
        expected_names: ['FetchLinkCardService'],
        expected_files: ['services/fetch_link_card_service.rb'],
    },
    {
        id: 'RB06',
        query: 'process mentions resolve remote users',
        difficulty: 'medium',
        topK: 5,
        description: 'ProcessMentionsService — scans a status for @mentions and resolves the accounts',
        expected_names: ['ProcessMentionsService'],
        expected_files: ['services/process_mentions_service.rb'],
    },

    // ── NL / SEMANTIC (behavioural; target symbol NOT named) ────────────────────

    {
        id: 'RB07',
        query: 'publish a new status for an account with text and media attachments',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'PostStatusService — composes and persists a new status (seed: post-status)',
        expected_names: ['PostStatusService'],
        expected_files: ['services/post_status_service.rb'],
    },
    {
        id: 'RB08',
        query: 'push a newly created post into the home and mentions timelines of all followers',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'FanOutOnWriteService — distributes a status into followers feeds',
        expected_names: ['FanOutOnWriteService'],
        expected_files: ['services/fan_out_on_write_service.rb'],
    },
    {
        id: 'RB09',
        query: 'look up or create the local record for a remote user given their handle, fetching their profile',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'ResolveAccountService — resolves a username@domain via webfinger + ActivityPub',
        expected_names: ['ResolveAccountService'],
        expected_files: ['services/resolve_account_service.rb'],
    },

    // ── XC / CROSS-CUTTING (behavioural, spans files) ───────────────────────────

    {
        id: 'RB10',
        query: 'process an incoming ActivityPub activity delivered to the inbox',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'ActivityPub::ProcessCollectionService — handles an incoming AP payload (adapted seed: process-ap)',
        expected_names: ['ActivityPub', 'ProcessCollectionService'],
        expected_files: ['services/activitypub/process_collection_service.rb'],
    },
    {
        id: 'RB11',
        query: 'verify the cryptographic HTTP signature on an incoming federated request to authenticate the sender',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'SignatureVerification — controller concern that validates HTTP request signatures',
        expected_names: ['SignatureVerification'],
        expected_files: ['controllers/concerns/signature_verification.rb'],
    },
    {
        id: 'RB12',
        query: 'create a notification for a recipient and decide whether it should also be emailed',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'NotifyService — builds notifications and gates email delivery by type',
        expected_names: ['NotifyService'],
        expected_files: ['services/notify_service.rb'],
    },

    // ── HELD-OUT (validation only — authored fresh, distinct targets) ───────────
    {
        id: 'HO-RB1',
        query: 'SuspendAccountService',
        difficulty: 'easy',
        topK: 5,
        expected_names: ['SuspendAccountService'],
        expected_files: ['services/suspend_account_service.rb'],
        heldOut: true,
    },
    {
        id: 'HO-RB2',
        query: 'convert a status body into safe sanitised HTML, linkifying mentions and hashtags',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        expected_names: ['HtmlAwareFormatter', 'TextFormatter'],
        expected_files: ['lib/html_aware_formatter.rb', 'lib/text_formatter.rb'],
        heldOut: true,
    },
    {
        id: 'HO-RB3',
        query: 'delete many statuses at once efficiently and clean them out of timelines',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        expected_names: ['BatchedRemoveStatusService'],
        expected_files: ['services/batched_remove_status_service.rb'],
        heldOut: true,
    },
];
