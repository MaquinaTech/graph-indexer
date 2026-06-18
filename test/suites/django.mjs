/**
 * test/suites/django.mjs
 *
 * Ground-truth query set for a django-oscar subset (Python/Django).
 * Source: https://github.com/django-oscar/django-oscar
 *
 * Every expected_name below is a REAL indexed symbol (whole name or a real
 * class_context) taken from bench/_chunks/django.json. Behavioural (nl/xc)
 * queries describe what the code DOES without naming the target symbol.
 *
 * Key source layout (oscar app packages):
 *   address/abstract_models.py     — AbstractAddress + subclasses (postal address models)
 *   customer/forms.py              — generate_username, PasswordResetForm, registration forms
 *   customer/utils.py              — normalise_email
 *   customer/auth_backends.py      — EmailBackend (authenticate by email)
 *   basket/abstract_models.py      — AbstractBasket: add_product, freeze, thaw, totals
 *   basket/middleware.py           — BasketMiddleware: merge_baskets, apply_offers_to_basket
 *   offer/applicator.py            — Applicator.apply (apply offers to a basket)
 *   order/utils.py                 — OrderCreator.place_order, OrderNumberGenerator, record_voucher_usage
 *   checkout/mixins.py             — OrderPlacementMixin: generate_order_number, place_order
 *   payment/bankcards.py           — luhn, bankcard_type (card number checks)
 *   shipping/repository.py         — Repository: get_shipping_methods
 *   voucher/abstract_models.py     — AbstractVoucher: is_available_to_user
 */

export const META = {
    id: 'django',
    displayName: 'django-oscar (subset)',
    language: 'Python/Django',
    version: 'subset',
    url: 'https://github.com/django-oscar/django-oscar',
    expectedMinChunks: 400,
    expectedMinFiles: 100,
};

export const QUERIES = [
    // ── EASY / MEDIUM (kw — symbolic name + domain-keyword lookup) ──────────────

    {
        id: 'DJ01',
        query: 'password reset form email user',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'PasswordResetForm — sends a one-use password reset link to the user (seed: pw-reset)',
        expected_names: ['PasswordResetForm'],
        expected_files: ['customer/forms.py'],
    },
    {
        id: 'DJ02',
        query: 'voucher form code create',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'Voucher creation form and the abstract voucher model',
        expected_names: ['VoucherForm', 'AbstractVoucher'],
        expected_files: ['voucher'],
    },
    {
        id: 'DJ03',
        query: 'order creator place order models',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'OrderCreator.place_order — writes out the order models when placing an order',
        expected_names: ['OrderCreator', 'place_order'],
        expected_files: ['order/utils.py'],
    },
    {
        id: 'DJ04',
        query: 'shipping repository methods available',
        kind: 'kw',
        difficulty: 'medium',
        topK: 5,
        description: 'Repository.get_shipping_methods — returns the available shipping methods for a basket',
        expected_names: ['Repository', 'get_shipping_methods'],
        expected_files: ['shipping/repository.py'],
    },

    // ── SEMANTIC (nl — behavioural, target symbol NOT named) ────────────────────

    {
        id: 'DJ05',
        query: 'generate a unique username derived from a user email address',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'generate_username — picks a random unique username (seed: username-gen)',
        expected_names: ['generate_username'],
        expected_files: ['customer/forms.py'],
    },
    {
        id: 'DJ06',
        query: 'check that a credit card number is valid using the standard checksum digit algorithm',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'luhn — Luhn checksum validation of a bankcard number',
        expected_names: ['luhn', 'bankcard_type'],
        expected_files: ['payment/bankcards.py'],
    },
    {
        id: 'DJ07',
        query: 'work out which promotional discounts apply to the items in a shopping cart and apply them',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'Applicator.apply — applies all relevant offers to a basket',
        expected_names: ['Applicator', 'apply'],
        expected_files: ['offer/applicator.py'],
    },

    // ── HARD / SEMANTIC (xc — cross-cutting concerns phrased behaviourally) ──────

    {
        id: 'DJ08',
        query: 'abstract base model describing a postal address with name and country',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'AbstractAddress — superclass postal address model (seed: address-model)',
        expected_names: ['AbstractAddress'],
        expected_files: ['address/abstract_models.py'],
    },
    {
        id: 'DJ09',
        query: 'when an anonymous shopper logs in, combine their session basket with any saved basket',
        kind: 'xc',
        difficulty: 'hard',
        topK: 10,
        description: 'BasketMiddleware.merge_baskets — merges the anonymous and authenticated baskets',
        expected_names: ['merge_baskets', 'BasketMiddleware'],
        expected_files: ['basket/middleware.py'],
    },

    // ── HELD-OUT (validation only — never used to tune ranking) ──
    {
        id: 'HO-DJ1',
        query: 'authentication backend that logs a user in by their email address instead of a username',
        kind: 'xc',
        difficulty: 'semantic',
        topK: 10,
        description: 'EmailBackend — authenticates a user against their email address',
        expected_names: ['EmailBackend'],
        expected_files: ['customer/auth_backends.py'],
        heldOut: true,
    },
    {
        id: 'HO-DJ2',
        query: 'produce a human-readable order number for a basket before the order is saved',
        kind: 'nl',
        difficulty: 'semantic',
        topK: 10,
        description: 'OrderNumberGenerator — generates an order number from a basket',
        expected_names: ['OrderNumberGenerator'],
        expected_files: ['order/utils.py'],
        heldOut: true,
    },
    {
        id: 'HO-DJ3',
        query: 'normalise_email',
        kind: 'kw',
        difficulty: 'easy',
        topK: 5,
        description: 'normalise_email — lower-cases the domain part of an email address',
        expected_names: ['normalise_email'],
        expected_files: ['customer/utils.py'],
        heldOut: true,
    },
];
