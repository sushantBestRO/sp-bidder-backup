'use strict';

/**
 * Allowed enums for the per-load rules pipeline (loadRules.js) and the per-customer rules config
 * (rulesConfig.js). ONE home so the ajv schema, the pure derivation, and the fail-closed guard can
 * never drift out of agreement. Frozen so nothing can mutate the allowed set at runtime.
 *
 * The split that matters: PRICING_MODES names every mode the system KNOWS as a concept (so the
 * config schema can validate a declared value); SUPPORTED_MECHANICS names what the payload builder
 * can ACTUALLY translate to the SuperProcure wire TODAY. A load whose rules reference a mechanic
 * outside SUPPORTED_MECHANICS is refused (fail closed), never bid blind - the opposite of
 * json-rules-engine's own run(), which silently emits nothing on a no-match (a silent fail-OPEN).
 * Each future mechanic (carrier, transit, per-tonne, KG, ...) adds its token to SUPPORTED_MECHANICS
 * + one branch in realAdapter.buildBidPayload; that is the entire extension surface.
 */

// SuperProcure's own brancheUnit values (the weight unit a branch quotes in). Most BRL branches
// are MT; a few (Ashirvad Pipes, Tata Consumer) are KG - confirmed live against SP's own
// weightUtilizationPercentage. Recorded as a fact today; not yet a wire mechanic.
const UNITS = Object.freeze(['MT', 'KG']);

/**
 * Normalise SuperProcure's raw brancheUnit to the canonical weight-unit enum (Module 2 L6). SP
 * quotes most branches in MT and some (Ashirvad Pipes ~1,907 loads, some Havells/Tata - 2,047 loads
 * total) in KG; the raw value has been seen as 'MT'/'KG' but is trimmed + upper-cased here so a
 * case/whitespace variant ('kg', ' Mt ') still resolves to the same canonical token everywhere.
 * Anything OUTSIDE the known set - and an absent value - returns null (UNKNOWN), never a GUESSED
 * unit: the display layer applies its own documented MT fallback on null (see fmtWeight), and there
 * is deliberately no per-tonne bid math a wrong unit could corrupt (that capability is unbuilt). So
 * the fact layer never asserts a unit SP did not send, and KG is never silently mislabeled MT (the
 * ~1000x trap). Shared by loadRules.deriveLoadRules (the LoadRules `unit` fact) and
 * realAdapter._mapLoad (the load's `weightUnit`) so the two can never disagree.
 */
function normalizeUnit(raw) {
  if (raw == null) return null;
  const u = String(raw).trim().toUpperCase();
  return UNITS.includes(u) ? u : null;
}

// Auction close model. 'hard' = fixed end; 'soft' = anti-snipe extension; 'any' = a customer policy
// opting in to both. The single home for this enum: CustomerStore imports it (as CLOSE_MODELS) for
// its auction.closeModel check, and the per-customer rules schema uses it for rules.closeModel, so
// the two can never diverge.
const CLOSE_TYPES = Object.freeze(['hard', 'soft', 'any']);

// How a bid amount is priced, as a KNOWN CONCEPT (for the config schema to validate a declared
// value). 'flat' = one absolute FTL rupee amount; the per-* modes are future work - present here so
// a customer policy can name its intent, but NOT yet buildable (see SUPPORTED_MECHANICS).
const PRICING_MODES = Object.freeze(['flat', 'per_tonne', 'per_kg', 'per_vehicle']);

// The mechanics realAdapter.buildBidPayload can translate to a real createV2 body RIGHT NOW. A
// LoadRules whose `requires` names anything outside this set, or whose pricingMode is outside it,
// fails CLOSED. Deliberately minimal - each mechanic joins this list only when its wire branch
// actually ships:
//   'flat'         - one absolute FTL rupee amount (the day-one baseline).
//   'transit_time' - conditional transit time (Module 2 L2): loads with loadIsTransitTimeOn
//                    require transitTime:"<days>" (a STRING of days) on the bid or SuperProcure
//                    rejects it (proven live on SIKA: null -> HTTP 400, "3" -> 201). The days come
//                    from the pricing operator at capture and stay sticky for the load's lifetime;
//                    the builder refuses (MISSING_TRANSIT_TIME) when they were never captured.
const SUPPORTED_MECHANICS = Object.freeze(['flat', 'transit_time']);

// SP_PMT_BID - the per-tonne SAFETY GATE. per_tonne is a live-money mechanic whose write wire is now
// proven by DIRECT OBSERVATION of a desk bid (createV2 sent amount 2240 on PMT load 23828313; SP
// stored 33600 and echoed amountPMT/bidRate 2240 - _research/2026-08-05_pmt-createv2-capture-
// SETTLED.md), but the BOT has still never placed one, so it ships DARK: 'per_tonne' joins the
// EFFECTIVE supported set ONLY when SP_PMT_BID=1.
// This MIRRORS the SP_MULTI_VEHICLE_BID pattern but INVERTS its default: multi-vehicle is an
// off-switch (default ON, proven live), whereas per-tonne is opt-in (default OFF) because it is the
// newer, capture-pending mechanic. Flag OFF (default) reproduces EXACTLY the fail-closed posture the
// PMT-classification change (feat/pmt-per-tonne-bidding's cherry-picked #81 commit) established: a
// PMT load classifies pricingMode 'per_tonne', per_tonne is NOT supported, and the existing guard
// refuses it with unsupported_rule_blocked at all three layers.
//
// Read FRESH from process.env on each call (NOT snapshotted at module load like config.js's flags):
// the fail-closed guard (loadRules.assertRulesSupported) is a pure model-layer function with no
// config handle, and a fresh read lets the floor-invariant tests prove BOTH the refused (flag off)
// and the built (flag on) path deterministically inside one process, while a live operator flip +
// process restart re-evaluates cleanly. The gate lives HERE, beside SUPPORTED_MECHANICS, so the ajv
// schema, the pure derivation, and the three fail-closed layers can never drift about whether
// per-tonne is currently biddable. config.js carries a signpost comment pointing here.
function pmtBidEnabled() {
  return process.env.SP_PMT_BID === '1';
}

// The mechanics buildBidPayload can translate to a real createV2 body RIGHT NOW, GATED by the runtime
// safety flags. Identical to SUPPORTED_MECHANICS except that 'per_tonne' is present ONLY when
// SP_PMT_BID=1. Every fail-closed layer that decides "is this mechanic biddable" -
// loadRules.assertRulesSupported (the pure guard + the realAdapter wire boundary + the engine
// _maybeBid all route through it) - reads THIS, never the frozen base set, so the flag can never be
// honoured at one layer and ignored at another. Returns a fresh array (never mutates the frozen base).
function effectiveSupportedMechanics() {
  return pmtBidEnabled() ? [...SUPPORTED_MECHANICS, 'per_tonne'] : SUPPORTED_MECHANICS.slice();
}

module.exports = {
  UNITS, CLOSE_TYPES, PRICING_MODES, SUPPORTED_MECHANICS, normalizeUnit,
  pmtBidEnabled, effectiveSupportedMechanics,
};
