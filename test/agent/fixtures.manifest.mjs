/**
 * test/agent/fixtures.manifest.mjs
 *
 * Reproducible definition of the full-matrix benchmark fixtures (every supported
 * language + framework). Each entry is a real open-source repo, shallow-cloned and
 * reduced to a language-pure, idiomatic subset so indexing stays fast and the
 * per-language signal isn't diluted by a bundled frontend/assets.
 *
 * Rebuild everything with:  node test/agent/setup-fixtures.mjs
 * (requires git + a running Ollama with nomic-embed-text; see OLLAMA_HOST.)
 *
 * The original 5 fixtures (axios, express-js, fastapi, gin, nestjs) are produced
 * by the repo's existing test/setup.mjs and are intentionally NOT duplicated here.
 */
export const FIXTURES = [
    { dest: 'spring',  repo: 'https://github.com/spring-projects/spring-petclinic',   subdirs: ['.'],                       lang: 'Java/Spring' },
    { dest: 'rust',    repo: 'https://github.com/serde-rs/json',                       subdirs: ['.'],                       lang: 'Rust' },
    { dest: 'android', repo: 'https://github.com/android/sunflower',                   subdirs: ['app/src/main/java'],       lang: 'Kotlin/Android' },
    { dest: 'aspnet',  repo: 'https://github.com/dotnet-architecture/eShopOnWeb',      subdirs: ['src'],                     lang: 'C#/ASP.NET' },
    { dest: 'react',   repo: 'https://github.com/react-bootstrap/react-bootstrap',     subdirs: ['src'],                     lang: 'TS/React' },
    { dest: 'django',  repo: 'https://github.com/django-oscar/django-oscar',          subdirs: ['src/oscar/apps'],          lang: 'Python/Django' },
    { dest: 'symfony', repo: 'https://github.com/symfony/symfony',                     subdirs: ['src/Symfony/Component/HttpKernel'], lang: 'PHP/Symfony' },
    { dest: 'css',     repo: 'https://github.com/twbs/bootstrap',                      subdirs: ['scss'],                    lang: 'SCSS' },
    {
        dest: 'rails', repo: 'https://github.com/mastodon/mastodon', lang: 'Ruby/Rails',
        // mastodon bundles its TS/HAML frontend under app/ — keep only Ruby dirs.
        subdirs: ['app/controllers', 'app/models', 'app/services', 'app/serializers', 'app/workers',
                  'app/lib', 'app/policies', 'app/helpers', 'app/mailers', 'app/validators', 'app/presenters'],
    },
    {
        dest: 'laravel', repo: 'https://github.com/koel/koel', lang: 'PHP/Laravel',
        subdirs: ['app/Models', 'app/Services', 'app/Http', 'app/Repositories', 'app/Providers', 'app/Console',
                  'app/Events', 'app/Listeners', 'app/Policies', 'app/Rules', 'app/Values', 'app/Builders',
                  'app/Facades', 'app/Exceptions'],
    },
];
