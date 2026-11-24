'use strict';
/**
 * Contract tests for the offline price-request dimension refresh planner.
 *
 * These tests exercise only the exported pure helper. They do not load the server, open either
 * portal, or write stored price requests.
 *
 * @requires-summary-line
 *   node scripts/test-request-dimensions-refresh.js
 */
const assert = require('assert');
const { planDimensionRefresh } = require('../src/pricing/requestDimensions');
const { platformOf } = require('../src/pricing/priceRequests');

const SP = 'superprocure';
const GC = 'gocomet';
const DIM_SP = '78 x 40 x 78 ft';
const DIM_HIGH_CUBE = `40'x8'x9'6\"`;
const DIM_STANDARD = `40'x8'x8'6\"`;

function scalarRequest(overrides = {}) {
  const base = {
    id: 'price-token-sp-scalar',
    loadId: 'SP-LOAD-SCALAR',
    platformKey: SP,
    load: {
      equipment: '32 ft MXL',
      dimensions: null,
      origin: 'Pune',
      destination: 'Surat',
      units: 'MT',
      count: 2,
      matches: ['fleet-32-mxl'],
      costByType: { base: 54000 },
      margins: [5, 10],
      floor: 55000,
      id: 'embedded-load-id',
    },
    price: 61500,
    status: 'pending',
    account: 'waaree-desk',
  };
  return {
    ...base,
    ...overrides,
    load: { ...base.load, ...(overrides.load || {}) },
  };
}

function scalarSource(overrides = {}) {
  return {
    id: 'SP-LOAD-SCALAR',
    platformKey: SP,
    equipment: '32 ft MXL',
    dimensions: DIM_SP,
    ...overrides,
  };
}

function multiRequest(overrides = {}) {
  const base = {
    id: 'price-token-gc-multi',
    loadId: 'GC-LOAD-MULTI',
    platformKey: GC,
    load: {
      equipment: '40FT container',
      dimensions: null,
      origin: 'Mundra',
      destination: 'Hyderabad',
      units: 'TRUCK',
      count: 3,
      matches: ['40ft-high-cube', '40ft-standard'],
      costByType: { '40ft-high-cube': 74000, '40ft-standard': 71000 },
      margins: [5, 8],
      floor: 70000,
      id: 'embedded-gocomet-load-id',
      cargoTypes: [
        {
          label: '40 ft high cube',
          count: 1,
          match: '40ft-high-cube',
          dimensions: null,
          units: 'TRUCK',
          quotedCost: 74000,
        },
        {
          label: '40 ft standard',
          count: 2,
          match: '40ft-standard',
          dimensions: DIM_STANDARD,
          units: 'TRUCK',
          quotedCost: 71000,
        },
      ],
    },
    price: 83000,
    status: 'pending',
    account: 'waaree-desk',
  };
  return {
    ...base,
    ...overrides,
    load: { ...base.load, ...(overrides.load || {}) },
  };
}

function multiSource(overrides = {}) {
  return {
    id: 'GC-LOAD-MULTI',
    platformKey: GC,
    equipment: '40FT container',
    dimensions: null,
    cargoTypes: [
      {
        label: '40 ft high cube',
        count: 1,
        match: '40ft-high-cube',
        dimensions: DIM_HIGH_CUBE,
      },
      {
        label: '40 ft standard',
        count: 2,
        match: '40ft-standard',
        dimensions: DIM_STANDARD,
      },
    ],
    ...overrides,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// catches: default-value swap returning a fabricated change for empty collections.
function should_return_no_changes_when_both_collections_are_empty() {
  // Arrange
  const records = [];
  const sources = [];

  // Act
  const actual = planDimensionRefresh(records, sources);

  // Assert: expected [] because the contract says unmatched inputs are a no-op.
  assert.deepStrictEqual(actual, [], 'empty record and source collections must plan no writes');
}

// catches: constant replacement or return-[] stub on the canonical scalar refresh.
function should_plan_one_scalar_fill_with_the_exact_change_envelope() {
  // Arrange
  const request = scalarRequest();
  const source = scalarSource();
  const expectedAfter = { ...request.load, dimensions: DIM_SP };

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected one change because portal, load ID, equipment, and a non-empty size agree.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: request.platformKey,
    beforeLoad: request.load,
    afterLoad: expectedAfter,
  }], 'the scalar planner must emit the exact persisted-load before/after envelope');
}

// catches: off-by-one classification that treats one cargo row as a multi-type load.
function should_fill_the_load_level_dimension_for_a_single_type_request() {
  // Arrange
  const oneType = [{
    label: '32 ft MXL',
    count: 2,
    match: '32ft-mxl',
    dimensions: null,
  }];
  const request = scalarRequest({ load: { cargoTypes: oneType } });
  const source = scalarSource({ cargoTypes: [{ ...oneType[0], dimensions: DIM_SP }] });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected scalar load.dimensions at cardinality one, with the cargo row untouched.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: request.platformKey,
    beforeLoad: request.load,
    afterLoad: { ...request.load, dimensions: DIM_SP },
  }], 'one cargo type must use the scalar load dimension without rewriting its cargo row');
}

// catches: truthy/falsy collapse that treats an existing dimension as missing.
function should_not_overwrite_an_existing_scalar_dimension() {
  // Arrange
  const request = scalarRequest({ load: { dimensions: 'existing verified size' } });
  const source = scalarSource({ dimensions: DIM_SP });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because refresh only fills missing values.
  assert.deepStrictEqual(actual, [], 'an existing scalar dimension must remain authoritative');
}

// catches: whitespace truthiness accepting an empty or absent source dimension.
function should_skip_scalar_sources_without_a_nonempty_dimension_string() {
  // Arrange
  const records = [
    scalarRequest({ id: 'price-token-blank-source', loadId: 'SP-BLANK-SIZE' }),
    scalarRequest({ id: 'price-token-null-source', loadId: 'SP-NULL-SIZE' }),
    scalarRequest({ id: 'price-token-wrong-type-source', loadId: 'SP-ARRAY-SIZE' }),
  ];
  const sources = [
    scalarSource({ id: 'SP-BLANK-SIZE', dimensions: '   ' }),
    scalarSource({ id: 'SP-NULL-SIZE', dimensions: null }),
    scalarSource({ id: 'SP-ARRAY-SIZE', dimensions: ['78', '40', '78'] }),
  ];

  // Act
  const actual = planDimensionRefresh(records, sources);

  // Assert: expected [] because each candidate source size is invalid by contract.
  assert.deepStrictEqual(actual, [], 'blank, absent, and non-string source sizes must be skipped');
}

// catches: comparator dropped between request and source equipment identity.
function should_skip_scalar_refresh_when_equipment_changed() {
  // Arrange
  const request = scalarRequest();
  const source = scalarSource({ equipment: '40FT container' });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because stale equipment makes the portal row unsafe to apply.
  assert.deepStrictEqual(actual, [], 'a scalar source for different equipment must not refresh the request');
}

// catches: portal key omitted from the source lookup or first-match selection across portals.
function should_isolate_same_load_id_by_portal_even_when_sources_are_permuted() {
  // Arrange
  const spRequest = scalarRequest({ id: 'price-token-shared-sp', loadId: 'SHARED-LOAD-ID' });
  const gcRequest = scalarRequest({
    id: 'price-token-shared-gc',
    loadId: 'SHARED-LOAD-ID',
    platformKey: GC,
  });
  const sources = [
    scalarSource({ id: 'SHARED-LOAD-ID', platformKey: GC, dimensions: 'GC portal size' }),
    scalarSource({ id: 'SHARED-LOAD-ID', platformKey: SP, dimensions: 'SP portal size' }),
  ];

  // Act
  const actual = planDimensionRefresh([spRequest, gcRequest], sources);

  // Assert: expected portal-specific sizes despite reverse source order.
  assert.deepStrictEqual(actual, [
    {
      id: spRequest.id,
      loadId: spRequest.loadId,
      platformKey: SP,
      beforeLoad: spRequest.load,
      afterLoad: { ...spRequest.load, dimensions: 'SP portal size' },
    },
    {
      id: gcRequest.id,
      loadId: gcRequest.loadId,
      platformKey: GC,
      beforeLoad: gcRequest.load,
      afterLoad: { ...gcRequest.load, dimensions: 'GC portal size' },
    },
  ], 'portal and load ID together must select the source, independent of source order');
}

// catches: legacy untagged SuperProcure records being discarded instead of using canonical ownership.
function should_refresh_an_absent_legacy_platform_through_platform_of() {
  // Arrange
  const request = scalarRequest({
    id: 'price-token-legacy-untagged-sp',
    loadId: 'SP-LEGACY-UNTAGGED',
    platformKey: undefined,
  });
  const canonicalPlatform = platformOf(request);
  const source = scalarSource({
    id: 'SP-LEGACY-UNTAGGED',
    platformKey: canonicalPlatform,
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected canonical SP ownership because absent persisted platformKey predates GoComet.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: canonicalPlatform,
    beforeLoad: request.load,
    afterLoad: { ...request.load, dimensions: DIM_SP },
  }], 'an absent legacy platform must resolve through the canonical platformOf rule');
}

// catches: falsy fallback that treats an explicit blank platform as an absent legacy field.
function should_reject_an_explicitly_blank_platform_instead_of_defaulting_it() {
  // Arrange
  const request = scalarRequest({
    id: 'price-token-explicit-blank-platform',
    loadId: 'SP-EXPLICIT-BLANK-PLATFORM',
    platformKey: '   ',
  });
  const source = scalarSource({
    id: 'SP-EXPLICIT-BLANK-PLATFORM',
    platformKey: platformOf({}),
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because only null/undefined qualify for the legacy fallback.
  assert.deepStrictEqual(actual, [], 'an explicit blank platform must remain invalid rather than defaulting to SP');
}

// catches: legacy fallback overriding a source that explicitly belongs to another portal.
function should_not_refresh_an_untagged_legacy_record_from_a_cross_portal_source() {
  // Arrange
  const request = scalarRequest({
    id: 'price-token-legacy-cross-portal',
    loadId: 'SHARED-LEGACY-LOAD-ID',
    platformKey: undefined,
  });
  const source = scalarSource({
    id: 'SHARED-LEGACY-LOAD-ID',
    platformKey: GC,
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because legacy ownership resolves to SP and cannot override explicit GC.
  assert.deepStrictEqual(actual, [], 'an untagged legacy SP record must not consume an explicit GoComet source');
}

// catches: first-wins behavior when a portal/load source identity is duplicated.
function should_skip_only_the_ambiguous_identity_when_source_identity_is_duplicated() {
  // Arrange
  const ambiguous = scalarRequest({ id: 'price-token-ambiguous', loadId: 'SP-DUPLICATE-SOURCE' });
  const safe = scalarRequest({ id: 'price-token-safe', loadId: 'SP-UNIQUE-SOURCE' });
  const sources = [
    scalarSource({ id: 'SP-DUPLICATE-SOURCE', dimensions: 'first conflicting size' }),
    scalarSource({ id: 'SP-UNIQUE-SOURCE', dimensions: 'unique verified size' }),
    scalarSource({ id: 'SP-DUPLICATE-SOURCE', dimensions: 'second conflicting size' }),
  ];

  // Act
  const actual = planDimensionRefresh([ambiguous, safe], sources);

  // Assert: expected only the unique source because duplicate identity must never be guessed.
  assert.deepStrictEqual(actual, [{
    id: safe.id,
    loadId: safe.loadId,
    platformKey: safe.platformKey,
    beforeLoad: safe.load,
    afterLoad: { ...safe.load, dimensions: 'unique verified size' },
  }], 'a duplicate source identity must not suppress unrelated unambiguous refreshes');
}

// catches: argument-order or index matching instead of cargo match-token matching.
function should_match_multi_type_rows_by_token_and_preserve_request_order() {
  // Arrange
  const request = multiRequest();
  const source = multiSource({ cargoTypes: [...multiSource().cargoTypes].reverse() });
  const expectedAfter = {
    ...request.load,
    cargoTypes: [
      { ...request.load.cargoTypes[0], dimensions: DIM_HIGH_CUBE },
      request.load.cargoTypes[1],
    ],
  };

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected token-matched fill in original request order; the existing second size stays.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: request.platformKey,
    beforeLoad: request.load,
    afterLoad: expectedAfter,
  }], 'multi-type refresh must match by token and retain request row order and existing dimensions');
}

// catches: fallback propagation that invents one missing row's size from a sibling.
function should_fill_only_multi_type_dimensions_that_the_source_actually_has() {
  // Arrange
  const request = multiRequest({
    load: {
      cargoTypes: multiRequest().load.cargoTypes.map((type) => ({ ...type, dimensions: null })),
    },
  });
  const source = multiSource({
    cargoTypes: [
      { ...multiSource().cargoTypes[0], dimensions: null },
      multiSource().cargoTypes[1],
    ],
  });
  const expectedAfter = {
    ...request.load,
    cargoTypes: [request.load.cargoTypes[0], { ...request.load.cargoTypes[1], dimensions: DIM_STANDARD }],
  };

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected one available row fill while the absent source size remains absent.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: request.platformKey,
    beforeLoad: request.load,
    afterLoad: expectedAfter,
  }], 'a missing source row dimension must remain missing while another exact row may refresh');
}

// catches: scalar-to-multi fallback that assigns one shared load size to every cargo type.
function should_not_use_a_shared_scalar_dimension_for_a_multi_type_request() {
  // Arrange
  const request = multiRequest({
    load: {
      cargoTypes: multiRequest().load.cargoTypes.map((type) => ({ ...type, dimensions: null })),
    },
  });
  const source = multiSource({
    dimensions: 'shared scalar size must not fan out',
    cargoTypes: multiSource().cargoTypes.map((type) => ({ ...type, dimensions: null })),
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because multi-type sizes may only come from exact per-type source rows.
  assert.deepStrictEqual(actual, [], 'a load-level source dimension cannot populate multi-type rows');
}

// catches: label validation dropped after a cargo match token succeeds.
function should_skip_the_whole_multi_type_request_when_any_label_changed() {
  // Arrange
  const request = multiRequest();
  const source = multiSource({
    cargoTypes: [
      multiSource().cargoTypes[0],
      { ...multiSource().cargoTypes[1], label: '40 ft standard revised' },
    ],
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because one stale label invalidates the complete request mapping.
  assert.deepStrictEqual(actual, [], 'one changed cargo label must skip the whole multi-type request');
}

// catches: count equality comparator dropped after a cargo match token succeeds.
function should_skip_the_whole_multi_type_request_when_any_count_changed() {
  // Arrange
  const request = multiRequest();
  const source = multiSource({
    cargoTypes: [
      multiSource().cargoTypes[0],
      { ...multiSource().cargoTypes[1], count: 3 },
    ],
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because one stale count invalidates the complete request mapping.
  assert.deepStrictEqual(actual, [], 'one changed cargo count must skip the whole multi-type request');
}

// catches: off-by-one/cardinality check omitted for source cargo rows.
function should_skip_the_whole_multi_type_request_when_cardinality_differs() {
  // Arrange
  const missingRowRequest = multiRequest({
    id: 'price-token-cardinality-n-minus-one',
    loadId: 'GC-CARDINALITY-N-MINUS-ONE',
  });
  const extraRowRequest = multiRequest({
    id: 'price-token-cardinality-n-plus-one',
    loadId: 'GC-CARDINALITY-N-PLUS-ONE',
  });
  const sources = [
    multiSource({
      id: 'GC-CARDINALITY-N-MINUS-ONE',
      cargoTypes: [multiSource().cargoTypes[0]],
    }),
    multiSource({
      id: 'GC-CARDINALITY-N-PLUS-ONE',
      cargoTypes: [
        ...multiSource().cargoTypes,
        { label: '20 ft standard', count: 1, match: '20ft-standard', dimensions: '20 x 8 x 8 ft' },
      ],
    }),
  ];

  // Act
  const actual = planDimensionRefresh([missingRowRequest, extraRowRequest], sources);

  // Assert: expected [] at N-1 and N+1 because neither source describes the same request.
  assert.deepStrictEqual(actual, [], 'a source with one fewer or one extra cargo row must skip the request');
}

// catches: first-wins matching for duplicate cargo tokens in either side of the mapping.
function should_skip_multi_type_requests_with_duplicate_match_tokens() {
  // Arrange
  const duplicateRequest = multiRequest({
    id: 'price-token-duplicate-request-match',
    loadId: 'GC-DUPLICATE-REQUEST-MATCH',
    load: {
      cargoTypes: [
        multiRequest().load.cargoTypes[0],
        { ...multiRequest().load.cargoTypes[1], match: '40ft-high-cube' },
      ],
    },
  });
  const duplicateSourceRequest = multiRequest({
    id: 'price-token-duplicate-source-match',
    loadId: 'GC-DUPLICATE-SOURCE-MATCH',
  });
  const sources = [
    multiSource({ id: 'GC-DUPLICATE-REQUEST-MATCH' }),
    multiSource({
      id: 'GC-DUPLICATE-SOURCE-MATCH',
      cargoTypes: [
        multiSource().cargoTypes[0],
        { ...multiSource().cargoTypes[1], match: '40ft-high-cube' },
      ],
    }),
  ];

  // Act
  const actual = planDimensionRefresh([duplicateRequest, duplicateSourceRequest], sources);

  // Assert: expected [] because neither duplicate-token mapping has a unique correspondence.
  assert.deepStrictEqual(actual, [], 'duplicate cargo match tokens must skip the whole request');
}

// catches: empty-string token treated as a valid map key.
function should_skip_multi_type_requests_with_an_empty_match_token() {
  // Arrange
  const request = multiRequest({
    load: {
      cargoTypes: [
        { ...multiRequest().load.cargoTypes[0], match: '   ' },
        multiRequest().load.cargoTypes[1],
      ],
    },
  });
  const source = multiSource({
    cargoTypes: [
      { ...multiSource().cargoTypes[0], match: '   ' },
      multiSource().cargoTypes[1],
    ],
  });

  // Act
  const actual = planDimensionRefresh([request], [source]);

  // Assert: expected [] because blank cargo identity cannot safely pair rows.
  assert.deepStrictEqual(actual, [], 'an empty or whitespace-only cargo match token must skip the request');
}

// catches: repeated-run change emission when all target dimensions are already present.
function should_be_a_no_op_for_already_refreshed_scalar_and_multi_requests() {
  // Arrange
  const scalar = scalarRequest({ load: { dimensions: DIM_SP } });
  const multi = multiRequest({
    load: {
      cargoTypes: [
        { ...multiRequest().load.cargoTypes[0], dimensions: DIM_HIGH_CUBE },
        multiRequest().load.cargoTypes[1],
      ],
    },
  });

  // Act
  const actual = planDimensionRefresh([scalar, multi], [scalarSource(), multiSource()]);

  // Assert: expected [] because a second refresh run must not write identical loads again.
  assert.deepStrictEqual(actual, [], 'already refreshed requests must make the planner idempotent');
}

// catches: null dereference or malformed-record coercion into an accidental match.
function should_safely_skip_malformed_and_unmatched_records_and_sources() {
  // Arrange
  const records = [
    null,
    {},
    { id: 'missing-load', loadId: 'SP-MALFORMED', platformKey: SP },
    scalarRequest({ id: '', loadId: 'SP-EMPTY-TOKEN' }),
    scalarRequest({ id: undefined, loadId: 'SP-MISSING-TOKEN' }),
    scalarRequest({ id: 'price-token-blank-load-id', loadId: '   ' }),
    scalarRequest({ id: 'price-token-unmatched', loadId: 'SP-NO-SOURCE' }),
    scalarRequest({ id: 'price-token-cross-portal', loadId: 'PORTAL-ONLY' }),
  ];
  const sources = [
    null,
    {},
    scalarSource({ id: 'SP-EMPTY-TOKEN', dimensions: DIM_SP }),
    scalarSource({ id: 'SP-MISSING-TOKEN', dimensions: DIM_SP }),
    scalarSource({ id: '   ', dimensions: DIM_SP }),
    scalarSource({ id: 'PORTAL-ONLY', platformKey: GC, dimensions: 'wrong portal size' }),
  ];

  // Act
  const actual = planDimensionRefresh(records, sources);

  // Assert: expected [] because none has a complete, nonblank, unique, same-portal identity.
  assert.deepStrictEqual(actual, [], 'malformed, empty-token, unmatched, and cross-portal rows must be safe skips');
}

// catches: equality-only validation where two equally absent required shape fields appear to match.
function should_skip_matching_records_when_required_equipment_label_or_count_is_missing() {
  // Arrange
  const scalar = scalarRequest({ id: 'price-token-no-equipment', loadId: 'SP-NO-EQUIPMENT' });
  const scalarPortal = scalarSource({ id: 'SP-NO-EQUIPMENT' });
  delete scalar.load.equipment;
  delete scalarPortal.equipment;

  const noLabel = multiRequest({
    id: 'price-token-no-label',
    loadId: 'GC-NO-LABEL',
    load: {
      cargoTypes: multiRequest().load.cargoTypes.map((type, index) => index === 0
        ? { count: type.count, match: type.match, dimensions: type.dimensions }
        : type),
    },
  });
  const noLabelSource = multiSource({
    id: 'GC-NO-LABEL',
    cargoTypes: multiSource().cargoTypes.map((type, index) => index === 0
      ? { count: type.count, match: type.match, dimensions: type.dimensions }
      : type),
  });

  const noCount = multiRequest({
    id: 'price-token-no-count',
    loadId: 'GC-NO-COUNT',
    load: {
      cargoTypes: multiRequest().load.cargoTypes.map((type, index) => index === 0
        ? { label: type.label, match: type.match, dimensions: type.dimensions }
        : type),
    },
  });
  const noCountSource = multiSource({
    id: 'GC-NO-COUNT',
    cargoTypes: multiSource().cargoTypes.map((type, index) => index === 0
      ? { label: type.label, match: type.match, dimensions: type.dimensions }
      : type),
  });

  // Act
  const actual = planDimensionRefresh(
    [scalar, noLabel, noCount],
    [scalarPortal, noLabelSource, noCountSource],
  );

  // Assert: expected [] because absent required fields are malformed, even on both sides.
  assert.deepStrictEqual(actual, [], 'missing equipment, cargo label, or cargo count must be a safe skip');
}

// catches: state mutation, field dropping, or accidental edits outside dimensions.
function should_accept_deep_frozen_inputs_without_mutating_any_original_or_non_target_field() {
  // Arrange
  const request = deepFreeze(multiRequest());
  const source = deepFreeze(multiSource());
  const records = deepFreeze([request]);
  const sources = deepFreeze([source]);
  const recordsBefore = JSON.stringify(records);
  const sourcesBefore = JSON.stringify(sources);
  const expectedAfter = {
    ...request.load,
    cargoTypes: [
      { ...request.load.cargoTypes[0], dimensions: DIM_HIGH_CUBE },
      request.load.cargoTypes[1],
    ],
  };

  // Act
  const actual = planDimensionRefresh(records, sources);

  // Assert: expected a planned clone while both deeply frozen inputs remain byte-identical.
  assert.deepStrictEqual(actual, [{
    id: request.id,
    loadId: request.loadId,
    platformKey: request.platformKey,
    beforeLoad: request.load,
    afterLoad: expectedAfter,
  }], 'deep-frozen inputs must still produce the exact dimension-only plan');
  assert.strictEqual(JSON.stringify(records), recordsBefore, 'the original request graph must remain unchanged');
  assert.strictEqual(JSON.stringify(sources), sourcesBefore, 'the original source graph must remain unchanged');
  assert.strictEqual(request.price, 83000, 'request price must remain unchanged');
  assert.strictEqual(request.status, 'pending', 'request status must remain unchanged');
  assert.strictEqual(request.account, 'waaree-desk', 'request account must remain unchanged');
}

const tests = [
  should_return_no_changes_when_both_collections_are_empty,
  should_plan_one_scalar_fill_with_the_exact_change_envelope,
  should_fill_the_load_level_dimension_for_a_single_type_request,
  should_not_overwrite_an_existing_scalar_dimension,
  should_skip_scalar_sources_without_a_nonempty_dimension_string,
  should_skip_scalar_refresh_when_equipment_changed,
  should_isolate_same_load_id_by_portal_even_when_sources_are_permuted,
  should_refresh_an_absent_legacy_platform_through_platform_of,
  should_reject_an_explicitly_blank_platform_instead_of_defaulting_it,
  should_not_refresh_an_untagged_legacy_record_from_a_cross_portal_source,
  should_skip_only_the_ambiguous_identity_when_source_identity_is_duplicated,
  should_match_multi_type_rows_by_token_and_preserve_request_order,
  should_fill_only_multi_type_dimensions_that_the_source_actually_has,
  should_not_use_a_shared_scalar_dimension_for_a_multi_type_request,
  should_skip_the_whole_multi_type_request_when_any_label_changed,
  should_skip_the_whole_multi_type_request_when_any_count_changed,
  should_skip_the_whole_multi_type_request_when_cardinality_differs,
  should_skip_multi_type_requests_with_duplicate_match_tokens,
  should_skip_multi_type_requests_with_an_empty_match_token,
  should_be_a_no_op_for_already_refreshed_scalar_and_multi_requests,
  should_safely_skip_malformed_and_unmatched_records_and_sources,
  should_skip_matching_records_when_required_equipment_label_or_count_is_missing,
  should_accept_deep_frozen_inputs_without_mutating_any_original_or_non_target_field,
];

let passed = 0;
for (const test of tests) {
  try {
    test();
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${test.name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

console.log(`${passed}/${tests.length} checks passed`);
process.exit(passed === tests.length ? 0 : 1);
