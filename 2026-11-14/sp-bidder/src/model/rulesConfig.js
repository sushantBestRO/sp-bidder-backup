'use strict';

const { UNITS, CLOSE_TYPES, PRICING_MODES } = require('./rulesConstants');

/**
 * Schema-validated per-customer RULES config (the Module 2 foundation). The parts of a customer's
 * policy that are genuinely customer-level - the pricing mode its loads are quoted in, the unit, the
 * close model, a soft-close opt-in - expressed as CONFIG DATA and validated by a JSON Schema (ajv),
 * the same shape mature bots use (freqtrade CONF_SCHEMA, ccxt data tables) instead of scattered
 * `if (customer === ...)` conditionals. Margin already lives on the customer doc; this is the rest
 * of the customer-level policy surface, added under `customer.rules`.
 *
 * FAIL CLOSED: an invalid rules block is refused at write time (CustomerStore.upsert) AND at boot
 * (assertCustomerRulesValid, called in server.js before any account stack is built) - a real-money
 * console must not start on a policy it cannot parse. additionalProperties:false means a TYPO in a
 * key ('pricingMdoe') is REJECTED, not silently ignored into a wrong bid. Enums come from
 * rulesConstants (one source of truth shared with loadRules + the fail-closed guard).
 *
 * INERT in this PR: nothing yet reads a customer's rules block to change a bid - a per-tonne or
 * soft-close-opt-in customer still bids exactly as today. This ships the validated config surface so
 * a follow-on mechanic is one schema field + one consumer, never a money-path conditional.
 */

const customerRulesSchema = {
  $id: 'brl:customerRules',
  type: 'object',
  additionalProperties: false,
  properties: {
    pricingMode: { type: 'string', enum: PRICING_MODES },
    unit: { type: 'string', enum: UNITS },
    closeModel: { type: 'string', enum: CLOSE_TYPES },
    softCloseOptIn: { type: 'boolean' },
  },
};

// ajv is a hard dependency (package.json). The require is guarded ONLY so a partially-installed tree
// fails LOUDLY at first use (with a clear message) instead of a raw MODULE_NOT_FOUND on an unrelated
// line - the validator throws if ajv is genuinely missing; it never silently passes (never
// fail-open). Compiled lazily + memoized: a customer with no rules block (today's norm) never
// touches ajv at all, so this dependency only bites once a rules block is actually in play.
let _validate = null;
function compile() {
  if (_validate) return _validate;
  let Ajv;
  try { Ajv = require('ajv'); }
  catch (_e) {
    const err = new Error('rulesConfig: ajv is required to validate customer rules but is not installed (run: npm install ajv)');
    err.code = 'CONFIG';
    throw err;
  }
  const ajv = new Ajv({ allErrors: true });
  _validate = ajv.compile(customerRulesSchema);
  return _validate;
}

/**
 * Validate ONE customer's rules block. null/undefined is valid (a customer with no rules block is
 * the norm today). Throws a BAD_INPUT error listing every schema violation on failure. Returns the
 * (unchanged) rules object on success so a caller can assign it through.
 */
function validateCustomerRules(rules, customerId) {
  if (rules == null) return null;
  if (typeof rules !== 'object' || Array.isArray(rules)) {
    const e = new Error(`customer${customerId ? ` ${customerId}` : ''} rules must be an object`);
    e.code = 'BAD_INPUT';
    throw e;
  }
  const validate = compile();
  if (!validate(rules)) {
    const msg = (validate.errors || []).map((er) => `${er.instancePath || '/'} ${er.message}`).join('; ');
    const e = new Error(`invalid customer${customerId ? ` ${customerId}` : ''} rules: ${msg}`);
    e.code = 'BAD_INPUT';
    throw e;
  }
  return rules;
}

/**
 * Boot gate: validate EVERY customer's rules block. Throws on the first invalid one so boot() fails
 * closed (server.js -> process.exit(1)) rather than starting on an unparseable policy. A no-op on
 * today's data (no customer carries a rules block yet), matching the repo's fail-closed boot posture
 * (real mode already refuses to boot without the operator login secrets).
 */
function assertCustomerRulesValid(customers) {
  for (const c of (customers || [])) {
    if (c && c.rules != null) validateCustomerRules(c.rules, c.customerId);
  }
  return true;
}

module.exports = { customerRulesSchema, validateCustomerRules, assertCustomerRulesValid };
