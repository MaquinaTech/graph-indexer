/**
 * test/suites/laravel.mjs
 *
 * Ground-truth query set for a Laravel / PHP subset of koel/koel.
 * Source: https://github.com/koel/koel
 *
 * NOTE on granularity: chunks here are file-level — each chunk's `name` is the
 * top-level class declared in that PHP file (so expected_names are class names
 * drawn from bench/_chunks/laravel.json's `names` universe; class_context for a
 * file-level chunk equals that same class name). There are no per-method chunks.
 *
 * Key source layout (under App/):
 *   Console/Commands/ScanCommand.php           — `koel:scan` artisan command
 *   Services/Scanners/DirectoryScanner.php     — walks the media directory
 *   Services/Streamer/Streamer.php             — picks a streaming adapter, streams a song
 *   Http/Controllers/Subsonic/StreamController.php — Subsonic stream endpoint
 *   Services/Playlist/PlaylistService.php      — create / update / add songs to playlists
 *   Services/Playlist/SmartPlaylistService.php — resolves songs for rule-based playlists
 *   Values/SmartPlaylist/SmartPlaylistRule.php — a single smart-playlist rule
 *   Services/SearchService.php                 — multi-entity excerpt search
 *   Services/Auth/AuthenticationService.php    — email/password login, tokens
 *   Services/Auth/TwoFactorAuthenticator.php   — TOTP enrolment / verification
 *   Services/Upload/UploadService.php          — handle an uploaded song file
 *   Services/Integrations/LastfmService.php    — Last.fm scrobble / now-playing
 *   Services/Transcoding/TranscodeStrategyFactory.php — picks a transcoding strategy
 *   Models/Song.php, Models/Playlist.php, Models/User.php — Eloquent models
 */

export const META = {
    id: 'laravel',
    displayName: 'Koel (Laravel subset)',
    language: 'PHP/Laravel',
    version: 'subset',
    url: 'https://github.com/koel/koel',
    expectedMinChunks: 400,
    expectedMinFiles: 400,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'LV01',
        query: 'PlaylistService',
        difficulty: 'easy',
        topK: 5,
        description: 'PlaylistService — create, update and add songs to playlists',
        expected_names: ['PlaylistService'],
        expected_files: ['Services/Playlist/PlaylistService.php'],
    },
    {
        id: 'LV02',
        query: 'SearchService excerpt search',
        difficulty: 'easy',
        topK: 5,
        description: 'SearchService — runs a keyword search across songs, artists, albums, podcasts',
        expected_names: ['SearchService'],
        expected_files: ['Services/SearchService.php'],
    },

    // ── MEDIUM (domain-keyword lookup) ──────────────────────────────────────────

    {
        id: 'LV03',
        query: 'scan music library directory import songs command',
        kind: 'nl',
        difficulty: 'medium',
        topK: 5,
        description: 'Scan the media directory and import songs (adapted from search-cases scan-library)',
        expected_names: ['ScanCommand', 'DirectoryScanner'],
        expected_files: ['Console/Commands/ScanCommand.php', 'Services/Scanners'],
    },
    {
        id: 'LV04',
        query: 'stream audio file song controller play',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Stream an audio file for a song (adapted from search-cases stream-audio)',
        expected_names: ['StreamController', 'Streamer'],
        expected_files: ['StreamController.php', 'Services/Streamer/Streamer.php'],
    },
    {
        id: 'LV05',
        query: 'upload song file handle duplicate detection',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'UploadService — stores an uploaded file, detects duplicates, scans and persists it',
        expected_names: ['UploadService'],
        expected_files: ['Services/Upload/UploadService.php'],
    },
    {
        id: 'LV06',
        query: 'two factor authenticator totp recovery code',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'TwoFactorAuthenticator — TOTP enrolment, verification and recovery codes',
        expected_names: ['TwoFactorAuthenticator'],
        expected_files: ['Services/Auth/TwoFactorAuthenticator.php'],
    },

    // ── HARD / SEMANTIC (cross-cutting, behavioural) ────────────────────────────

    {
        id: 'LV07',
        query: 'add a set of songs to an existing playlist',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Adding songs to a playlist (adapted from search-cases playlist-add)',
        expected_names: ['PlaylistService', 'Playlist'],
        expected_files: ['Services/Playlist/PlaylistService.php', 'Models/Playlist.php'],
    },
    {
        id: 'LV08',
        query: 'choose the right way to convert an audio file to a lower bitrate depending on where it is stored',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Behavioural search for the transcoding strategy selection',
        expected_names: ['TranscodeStrategyFactory', 'TranscodingStrategy'],
        expected_files: ['Services/Transcoding'],
    },

    // ── SEMANTIC (intent-only, target name never spoken) ────────────────────────

    {
        id: 'LV09',
        query: 'verify a user email and password and issue an access token so they can sign in',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the login / credential authentication flow',
        expected_names: ['AuthenticationService'],
        expected_files: ['Services/Auth/AuthenticationService.php'],
    },
    {
        id: 'LV10',
        query: 'build a playlist whose contents are decided automatically by matching rules instead of a fixed song list',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the smart (rule-based) playlist machinery',
        expected_names: ['SmartPlaylistService', 'SmartPlaylistRule'],
        expected_files: ['Services/Playlist/SmartPlaylistService.php', 'Values/SmartPlaylist'],
    },
    {
        id: 'LV11',
        query: 'report the song a user is currently listening to and record a completed play to their external scrobbling account',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Agent looking for the Last.fm now-playing / scrobble integration',
        expected_names: ['LastfmService'],
        expected_files: ['Services/Integrations/LastfmService.php'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-LV1',
        query: 'EqualizerPresetService',
        difficulty: 'easy',
        topK: 5,
        expected_names: ['EqualizerPresetService'],
        expected_files: ['Services/EqualizerPresetService.php'],
        heldOut: true,
    },
    {
        id: 'HO-LV2',
        query: 'resize and store an uploaded cover image for an album or artist',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        expected_names: ['ImageStorage', 'ImageWriter'],
        expected_files: ['Services/Image'],
        heldOut: true,
    },
    {
        id: 'HO-LV3',
        query: 'periodically fetch a podcast RSS feed and store any new episodes',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        expected_names: ['PodcastService', 'SyncPodcastsCommand'],
        expected_files: ['Services/Podcast/PodcastService.php', 'Console/Commands/SyncPodcastsCommand.php'],
        heldOut: true,
    },
];
