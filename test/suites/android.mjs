/**
 * test/suites/android.mjs
 *
 * Ground-truth query set for the Android "Sunflower" sample (Kotlin), a subset
 * of github.com/android/sunflower.
 * Source: https://github.com/android/sunflower
 *
 * Key source layout (under com/google/samples/apps/sunflower/):
 *   data/
 *     Plant.kt                      — @Entity data class Plant, shouldBeWatered()
 *     GardenPlanting.kt             — @Entity recording a plant added to the garden
 *     PlantDao.kt                   — Room DAO: getPlants / getPlant / upsertAll
 *     GardenPlantingDao.kt          — Room DAO for garden plantings
 *     PlantRepository.kt            — repository over PlantDao
 *     GardenPlantingRepository.kt   — create/remove garden plantings, isPlanted
 *     UnsplashRepository.kt         — paged Unsplash photo search
 *     UnsplashPagingSource.kt       — PagingSource that loads photo pages
 *     Converters.kt                 — Room TypeConverters (Calendar <-> Long)
 *     AppDatabase.kt                — abstract RoomDatabase, getInstance
 *   api/UnsplashService.kt          — Retrofit interface, searchPhotos
 *   di/ NetworkModule.kt, DatabaseModule.kt — Hilt @Module providers
 *   viewmodels/
 *     PlantListViewModel.kt         — plant list + grow-zone filter
 *     PlantDetailViewModel.kt       — single plant + add-to-garden action
 *     GalleryViewModel.kt           — paged Unsplash gallery
 *   workers/SeedDatabaseWorker.kt   — CoroutineWorker seeding the DB from JSON
 *   utilities/GrowZoneUtil.kt       — getZoneForLatitude helper
 *   compose/ ...                    — Jetpack Compose screens (@Composable funcs,
 *                                      indexed as <File>_function_declaration)
 *
 * NOTE: top-level / @Composable functions are indexed under the synthetic name
 * "<FileBaseName>_function_declaration" (e.g. GrowZoneUtil_function_declaration),
 * so those are the real symbol names used in expected_names below.
 */

export const META = {
    id: 'android',
    displayName: 'Android Sunflower',
    language: 'Kotlin/Android',
    version: 'subset',
    url: 'https://github.com/android/sunflower',
    expectedMinChunks: 60,
    expectedMinFiles: 30,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'AN01',
        query: 'GardenPlantingRepository',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Repository that creates and removes garden plantings via the DAO',
        expected_names: ['GardenPlantingRepository'],
        expected_files: ['GardenPlantingRepository.kt'],
    },
    {
        id: 'AN02',
        query: 'PlantDao',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Room Data Access Object for the Plant entity',
        expected_names: ['PlantDao'],
        expected_files: ['PlantDao.kt'],
    },
    {
        id: 'AN03',
        query: 'AppDatabase Room database',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'The abstract Room database holding the DAOs',
        expected_names: ['AppDatabase'],
        expected_files: ['AppDatabase.kt'],
    },

    // ── MEDIUM (keyword lookup) ─────────────────────────────────────────────────

    {
        id: 'AN04',
        query: 'garden planting repository dao insert',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Seed case: garden planting repository over the DAO',
        expected_names: ['GardenPlantingRepository'],
        expected_files: ['GardenPlantingRepository.kt'],
    },
    {
        id: 'AN05',
        query: 'unsplash service retrofit search photos http',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Retrofit network interface calling the Unsplash photo search endpoint',
        expected_names: ['UnsplashService'],
        expected_files: ['api/UnsplashService.kt'],
    },
    {
        id: 'AN06',
        query: 'room type converter calendar timestamp',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Room TypeConverters mapping Calendar to a stored Long timestamp',
        expected_names: ['Converters'],
        expected_files: ['Converters.kt'],
    },

    // ── HARD (cross-cutting, phrased behaviourally) ─────────────────────────────

    {
        id: 'AN07',
        query: 'screen state for a single plant with an add-to-garden action',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Seed case: detail view model exposing a plant and an add-to-garden action',
        expected_names: ['PlantDetailViewModel'],
        expected_files: ['viewmodels/PlantDetailViewModel.kt'],
    },
    {
        id: 'AN08',
        query: 'load pages of remote images for an infinitely scrolling photo grid',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'PagingSource that fetches successive pages of Unsplash photos',
        expected_names: ['UnsplashPagingSource'],
        expected_files: ['data/UnsplashPagingSource.kt'],
    },

    // ── SEMANTIC (natural-language behaviour, target name NOT mentioned) ────────

    {
        id: 'AN09',
        query: 'view model exposing the list of plants and the grow-zone filter',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Seed case: list view model with the grow-zone filter',
        expected_names: ['PlantListViewModel'],
        expected_files: ['viewmodels/PlantListViewModel.kt'],
    },
    {
        id: 'AN10',
        query: 'background job that reads plant records from a bundled JSON file and writes them into the local database on first launch',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'CoroutineWorker that seeds the database from a JSON asset',
        expected_names: ['SeedDatabaseWorker'],
        expected_files: ['workers/SeedDatabaseWorker.kt'],
    },
    {
        id: 'AN11',
        query: 'work out which hardiness zone a location belongs to from its latitude',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Helper mapping a latitude to a plant growing zone',
        expected_names: ['GrowZoneUtil_function_declaration'],
        expected_files: ['utilities/GrowZoneUtil.kt'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──

    {
        id: 'HO-AN1',
        query: 'PlantRepository',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Repository wrapping the Plant DAO',
        expected_names: ['PlantRepository'],
        expected_files: ['PlantRepository.kt'],
        heldOut: true,
    },
    {
        id: 'HO-AN2',
        query: 'decide whether a plant is overdue to be watered based on its watering interval',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Held-out: the Plant entity carrying the should-be-watered logic',
        expected_names: ['Plant'],
        expected_files: ['data/Plant.kt'],
        heldOut: true,
    },
    {
        id: 'HO-AN3',
        query: 'dependency-injection module that provides the configured network client',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'Held-out: Hilt module providing the Unsplash network service',
        expected_names: ['NetworkModule'],
        expected_files: ['di/NetworkModule.kt'],
        heldOut: true,
    },
];
