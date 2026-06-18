/**
 * test/suites/spring.mjs
 *
 * Ground-truth query set for Spring PetClinic (Java / Spring, a subset of
 * spring-projects/spring-petclinic).
 *
 * NOTE on the symbol universe: this fixture indexes at class granularity — the
 * indexed `name` of each chunk is the Java type (Owner, OwnerController,
 * OwnerRepository, PetValidator, …) and there are no per-method chunks. So
 * expected_names here are the REAL class names from bench/_chunks/spring.json;
 * behavioural nl/xc queries describe what a class *does* and resolve to the
 * class that owns that behaviour. SCSS files contribute `*_rule_set` chunks.
 *
 * Key source layout:
 *   model/        BaseEntity (id), NamedEntity (name), Person (first/last name)
 *   owner/        Owner (entity + pets/visits), OwnerController (CRUD web forms),
 *                 OwnerRepository (Spring Data find-by-last-name), Pet, PetType,
 *                 PetController, PetValidator, PetTypeFormatter, PetTypeRepository,
 *                 Visit, VisitController
 *   vet/          Vet, Vets (XML list), VetController, VetRepository, Specialty
 *   system/       CacheConfiguration (JCache for vets), CrashController (throws),
 *                 WelcomeController (home page), WebConfiguration
 *   PetClinicApplication (boot main), PetClinicRuntimeHints (AOT/native hints)
 *   scss/         petclinic / header / responsive / typography rule sets
 */

export const META = {
    id: 'spring',
    displayName: 'Spring PetClinic',
    language: 'Java/Spring',
    version: 'subset',
    url: 'https://github.com/spring-projects/spring-petclinic',
    expectedMinChunks: 40,
    expectedMinFiles: 20,
};

export const QUERIES = [
    // ── EASY (symbolic name lookup) ─────────────────────────────────────────────

    {
        id: 'SP01',
        query: 'OwnerRepository',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Spring Data repository for Owner entities (find by last name, find by id)',
        expected_names: ['OwnerRepository'],
        expected_files: ['owner/OwnerRepository.java'],
    },
    {
        id: 'SP02',
        query: 'PetValidator',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Validator that checks a Pet form before saving',
        expected_names: ['PetValidator'],
        expected_files: ['owner/PetValidator.java'],
    },
    {
        id: 'SP03',
        query: 'CrashController',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Demo controller whose handler deliberately throws to showcase error handling',
        expected_names: ['CrashController'],
        expected_files: ['system/CrashController.java'],
    },

    // ── MEDIUM (keyword lookup with a bit of intent) ────────────────────────────

    {
        id: 'SP04',
        query: 'owner repository find by last name pageable',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Spring Data query method returning a page of owners whose last name starts with a prefix',
        expected_names: ['OwnerRepository'],
        expected_files: ['owner/OwnerRepository.java'],
    },
    {
        id: 'SP05',
        query: 'PetTypeFormatter parse print pet type',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Spring Formatter that converts between a PetType and its display name string',
        expected_names: ['PetTypeFormatter'],
        expected_files: ['owner/PetTypeFormatter.java'],
    },
    {
        id: 'SP06',
        query: 'vet controller list veterinarians paginated model',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Controller that lists veterinarians as an HTML page and as a JSON/XML resource',
        expected_names: ['VetController', 'Vets'],
        expected_files: ['vet/VetController.java', 'vet/Vets.java'],
    },

    // ── NL / SEMANTIC (behavioural — does NOT name the target symbol) ───────────

    {
        id: 'SP07',
        query: 'handle the web form submission that creates a new pet owner and saves it',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Seed case owner-create — the controller that processes the new-owner form',
        expected_names: ['OwnerController'],
        expected_files: ['owner/OwnerController.java'],
    },
    {
        id: 'SP08',
        query: 'reject the form when a pet is missing its name, type, or birth date',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Seed case pet-validate — validation rules applied to a pet before it is saved',
        expected_names: ['PetValidator'],
        expected_files: ['owner/PetValidator.java'],
    },
    {
        id: 'SP09',
        query: 'record a new appointment booking for a pet belonging to an owner',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Controller handling the visit (appointment) creation form for a pet',
        expected_names: ['VisitController', 'Visit'],
        expected_files: ['owner/VisitController.java', 'owner/Visit.java'],
    },

    // ── XC (cross-cutting concern phrased behaviourally) ────────────────────────

    {
        id: 'SP10',
        query: 'set up an in-memory cache so the veterinarian list is not recomputed on every request',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'JCache configuration that caches the vets listing',
        expected_names: ['CacheConfiguration'],
        expected_files: ['system/CacheConfiguration.java'],
    },
    {
        id: 'SP11',
        query: 'base persistent entity giving every domain object an auto-generated database id',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'Mapped superclass supplying the shared id primary key to all entities',
        expected_names: ['BaseEntity', 'NamedEntity'],
        expected_files: ['model/BaseEntity.java', 'model/NamedEntity.java'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking; ~25%) ───────────

    {
        id: 'HO-SP1',
        query: 'PetTypeRepository',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Repository that loads the available pet types',
        expected_names: ['PetTypeRepository'],
        expected_files: ['owner/PetTypeRepository.java'],
        heldOut: true,
    },
    {
        id: 'HO-SP2',
        query: 'render the application landing page at the site root',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Controller mapping the home page / welcome view',
        expected_names: ['WelcomeController'],
        expected_files: ['system/WelcomeController.java'],
        heldOut: true,
    },
    {
        id: 'HO-SP3',
        query: 'register reflection and serialization hints so the app runs as a GraalVM native image',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'AOT runtime-hints registrar for native-image builds',
        expected_names: ['PetClinicRuntimeHints'],
        expected_files: ['PetClinicRuntimeHints.java'],
        heldOut: true,
    },
];
