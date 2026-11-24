'use strict';

// patchDoc's compare-and-set. A patch may carry `__expect: { field: value }`; the write is refused
// when the stored document no longer holds those values, so a caller that checked a document and
// writes it later cannot merge over a change another writer made in between. Never stored.
function splitExpect(partial) {
  if (!partial || !Object.prototype.hasOwnProperty.call(partial, '__expect')) return { patch: partial, expect: null };
  const { __expect: expect, ...patch } = partial;
  return { patch, expect };
}

function assertExpected(current, expect) {
  if (!expect) return;
  for (const [field, expected] of Object.entries(expect)) {
    const actual = current ? current[field] : undefined;
    if (actual !== expected) {
      const e = new Error(`write refused: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      e.code = 'EXPECT_FAILED';
      e.field = field;
      e.expected = expected;
      e.actual = actual;
      throw e;
    }
  }
}

module.exports = { splitExpect, assertExpected };
