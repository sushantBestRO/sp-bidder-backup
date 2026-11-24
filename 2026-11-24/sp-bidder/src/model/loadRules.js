'use strict';

const { parseHMS, plausibleCeiling } = require('../engine/pricing');
const { effectiveSupportedMechanics, normalizeUnit, PRICING_MODES } = require('./rulesConstants');

// plausibleCeiling - parse + bound-check a shipper ceiling at the map boundary, fail-closed to null -
// is the SINGLE source of "is this ceiling real" and lives in engine/pricing so the adapter's ceiling
// belt, the engine's ladder cap, and the map boundary (deriveLoadRules below) all share ONE definition
// and can never disagree. Imported above and re-exported from this module because deriveLoadRules is
// one of the two map-boundary parse sites, and test-ceiling-plausibility.js reads it from here.

/**
 * LoadRules - the per-load facts every bidding mechanic needs, derived ONCE from a raw SuperProcure
 * load (in realAdapter._mapLoad), snapshotted WHOLE onto the price request, carried through
 * armFromRequest -> BidEngine.arm onto monitor.meta, and handed to placeBid as its opts. This is the
 * single seam the audit's four independent reports converged on: the path from a LOAD to the BID
 * PAYLOAD. Every future capability (carrier, transit, ceiling, per-tonne, KG, close-model) becomes
 * one field HERE + one branch in realAdapter.buildBidPayload, never five-file surgery on the money
 * path (the shape mature bots use - freqtrade CONF_SCHEMA, ccxt data tables).
 *
 * Its field names are deliberately DISTINCT from the createV2 wire keys (carrierBranchId, in, vcq,
 * type, transitTime, ...). The engine hands a LoadRules to placeBid as `opts`, and buildBidPayload
 * keeps reading the legacy wire keys with the same defaults, so a LoadRules that carries none of
 * those keys reproduces the exact BYTE-IDENTICAL body the bot sends today. Carrier-per-load was the
 * FIRST consumer to change the wire (the master-account carrier-identity HTTP 400 diagnosis);
 * conditional transit time is the SECOND (loadIsTransitTimeOn -> transitTime:"<days>" on the bid,
 * proven live on SIKA: null -> HTTP 400, "3" -> 201). A transit-required load pushes 'transit_time'
 * into `requires`; the days themselves are NOT derivable from the load - a pricing operator enters
 * them at capture and armFromRequest layers them onto this object as `transitDays` (a distinct,
 * non-wire key), sticky for every rung/revision on the load. pricingMode is 'flat' for every real
 * load EXCEPT a PMT ("Quote Per MT") load, which classifies to 'per_tonne'. That routes the load
 * into the per-tonne arm of the fail-closed guard (assertRulesSupported), which REFUSES it unless
 * SP_PMT_BID=1 and the load is MT-quoted and carries no shipper ceiling - per_tonne is deliberately
 * absent from the frozen SUPPORTED_MECHANICS and joins the effective set only behind that flag.
 *
 * @param {object} l - the raw SuperProcure load object (as read in realAdapter._mapLoad).
 * @returns {object|null} - the derived LoadRules fact object, or null when `l` is not an object.
 */
/**
 * THE pricing-basis classifier - the ONE place a raw SuperProcure quote basis becomes a pricingMode.
 * Normalises (trim + upper-case) exactly the way discovery.isMultiVehicle normalises load.quoteType,
 * so the two PMT classifiers can never disagree about what counts as 'PMT'. Split out of
 * deriveLoadRules so the arm-time re-derivation (reconcilePricingMode below) applies the IDENTICAL
 * rule rather than a second copy of it that could drift.
 *
 * A genuinely-PMT basis classifies 'per_tonne'; EVERY other basis - a real FTL load, and (critically)
 * an unknown/missing basis from a mock/sim/legacy record - stays 'flat' and behaves exactly as today.
 * This is a POSITIVE classification of a known basis only; the refusal is never widened to ambiguity.
 *
 * Takes the already-resolved BASIS, not a raw load: deriveLoadRules resolves it with the same
 * truthy-OR fallback _mapLoad uses (see classifyBasis below), while reconcilePricingMode can only
 * offer the snapshot's recorded `rateType`. Keeping the fallback OUT of here is deliberate - the two
 * callers legitimately have different fields available, and only the normalisation must be shared.
 */
function derivePricingMode(quoteBasisRaw) {
  const quoteBasis = quoteBasisRaw == null ? '' : String(quoteBasisRaw).trim().toUpperCase();
  return quoteBasis === 'PMT' ? 'per_tonne' : 'flat';
}

/**
 * RE-DERIVE the pricing basis from a LoadRules' OWN recorded rateType, for a snapshot that may
 * predate the per-tonne build. Classification happens once at map time and is snapshotted WHOLE onto
 * the price request and the durable intent; every restore path (armFromRequest on capture/re-price,
 * _intentToArm on a scheduled wake or a post-restart rehydrate) hands that snapshot back verbatim.
 * A PMT load captured or armed BEFORE this build carries the old hardcoded pricingMode:'flat', and
 * buildBidPayload plus the whole fail-closed stack branch purely on `pricingMode`. What that costs is
 * NO LONGER an amount error - since 2026-08-05 both branches put Math.round(price) on the wire, so a
 * misclassified PMT load bids the same rupee figure either way. What it costs is EVERY PER-TONNE
 * GUARD: a 'flat' snapshot bypasses the SP_PMT_BID gate entirely (it bids a PMT load on a box where
 * per-tonne is switched off), bypasses the MT-only refusal (so a KG-quoted Tata/Ashirvad load would
 * bid an unproven per-KG-vs-per-MT rate - the ~1000x trap), bypasses the ceiling refusal, sends
 * in:"FTL" instead of the true PMT basis, and leaves the pmt_amount_mismatch oracle unarmed because
 * that is gated on the mode we SENT. `rateType` holds the load's raw basis on every LoadRules
 * snapshot, including the pre-build ones, so the datum to catch it is already there. Same class, and
 * same remedy, as the transit-days recovery for "a request captured before the transit build
 * deployed" (priceRequests.setBidOverride / the price-page recovery field).
 *
 * ONE-DIRECTIONAL BY DESIGN - it only ever corrects a PMT-basis load UP to per_tonne (toward the
 * fail-closed guard), and NEVER rewrites anything down to 'flat'. A downward rewrite would strip
 * the very guards listed above from a real per-tonne load if rateType were ever absent on one. Any
 * rules object that is not a PMT basis - FTL, unknown basis, a legacy/mock opts bag with no rateType
 * at all, or an already-correct per_tonne snapshot - is returned as the SAME OBJECT, unmodified, so
 * no non-PMT load can observe any change. Never mutates the caller's snapshot.
 *
 * WHAT IT CANNOT HEAL, stated because the omission looks like an oversight and is not:
 * `pmtVehicleCount`. That fact is vehicleCount / weight, and a persisted LoadRules snapshot carries
 * NEITHER - it stores the derived `pmtQuantity`, and the armed intent (_intentToArm) stores `units`
 * but never `weight`. So a snapshot taken before pmtVehicleCount existed cannot have it re-derived
 * here from anything, and guessing a count is the exact failure this whole build exists to undo.
 * The consequence is bounded and is made VISIBLE rather than papered over: the engine logs a
 * one-shot "vehicle-count read-back NOT checked" line on such a load (bidEngine, per-tonne read-back
 * block), and the price page re-derives the count from the load it holds - which does carry both
 * fields - instead of relying on the snapshot. A fresh snapshot always has the field.
 *
 * KNOWN RESIDUAL (bounded, needs TWO unlikely things at once). This can only read the snapshot's
 * `rateType`, which records SP's basis VERBATIM - so on the one divergent wire shape
 * { branchQuoteType: '', rateType: 'PMT' } a PRE-build snapshot stored rateType '' and this returns
 * 'flat'. deriveLoadRules gets that shape right (it falls back across both fields), so any snapshot
 * taken from THIS build onward is already correct and needs no re-derivation; the gap is only a
 * snapshot captured before the build, of a load in a shape never observed across the 5,532-load
 * census (the two fields are always both 'PMT' or both absent - an empty-string rateType has never
 * been seen). Not closed by guessing here: refusing every '' rateType would fail closed on a real
 * shape SP does send (absent basis arrives as null, but a future '' would sweep in legitimate FTL
 * loads), and no code can recover a field the old snapshot never stored. The deploy-ordering note on
 * the PR - no PMT customer allowlisted until this is deployed - covers the pre-build snapshot class
 * as a whole, this shape included.
 */
function reconcilePricingMode(rules) {
  if (!rules || typeof rules !== 'object') return rules;
  if (derivePricingMode(rules.rateType) !== 'per_tonne') return rules; // not a PMT basis -> untouched
  if (rules.pricingMode === 'per_tonne') return rules;                 // already correct -> untouched
  return Object.assign({}, rules, { pricingMode: 'per_tonne' });
}

/**
 * The load's own `vehicleCount`, bound-checked to a usable positive number - a pure FACT, read by
 * nothing on the write path.
 *
 * On a PMT load SuperProcure's `vehicleCount` carries the MT quantity rather than a truck count (the
 * documented "PMT lie"). Until 2026-08-05 this number was the TONNAGE MULTIPLIER the wire conversion
 * multiplied the desk's per-MT rate by, and this function carried a `weight` CROSS-CHECK that
 * returned null on a disagreement so buildBidPayload would refuse (PMT_QUANTITY) rather than
 * multiply by a quantity we could not prove.
 *
 * THAT CROSS-CHECK IS GONE, because the thing it protected is gone: the captured PMT createV2 WRITE
 * (_research/2026-08-05_pmt-createv2-capture-SETTLED.md) proves we send the bare per-MT rate and
 * SuperProcure applies its own per-vehicle tonnage. There is no multiplier on the write path, so
 * nulling this field could no longer fail anything closed - it could only blind the read-back
 * oracle's diagnostics, and it was actively refusing real loads (3 of the 5 live Vishal Pipes PMT
 * loads on the 2026-08-05 board carry vehicleCount != weight, and every one of them would have been
 * held with nothing on the wire, for a mechanic that never needed the number).
 *
 * What remains is a fact the fact-layer should report verbatim, the way it reports every other
 * SuperProcure field: absent / non-finite / <= 0 -> null, anything else -> the number, identically
 * on flat and per_tonne. It is a SNAPSHOT/AUDIT field with no reader in src/ today - the alert text
 * reads SuperProcure's OWN echoed bidQuantity and the price page reads the mapped load's `units`,
 * neither of which is this - so do not add a wire reader for it. The truck-count question the
 * `weight` comparison used to answer is answered by pmtVehicleCount below instead.
 */
function derivePmtQuantity(l) {
  const n = Number(l.vehicleCount);
  if (!(l.vehicleCount != null && Number.isFinite(n) && n > 0)) return null;
  return n;
}

/**
 * HOW MANY TRUCKS a per-tonne bid commits BRL to - the fact that replaces the deleted PMT_QUANTITY
 * refusal, and the reason the `vehicleCount` vs `weight` comparison did NOT die with the multiplier.
 *
 * The comparison was written as a multiplier sanity check, but what it actually detected was whether
 * a PMT load is SPLIT ACROSS TRUCKS. That question outlived the multiplier, because the 2026-08-05
 * capture proved `vcq:-1` does not mean "one vehicle" to SuperProcure: on load 23828313 we send -1
 * and SP records bidVehicleCount 2, derived from the load. A PMT bid therefore commits to the load's
 * FULL truck count, and until this field existed nothing above the wire could say what that count was.
 *
 * The derivation, and why it is trustworthy enough for what it is used for:
 *   on a PMT load `vehicleCount` is the load's TOTAL quantity (the documented "PMT lie") and `weight`
 *   is the PER-VEHICLE quantity (SuperProcure's own UI labels it "Qty/Vehicle"), so
 *       trucks = vehicleCount / weight.
 *   Checked against every PMT row ever observed: the capture 23828313 (30 / 15 = 2, and SP recorded
 *   bidVehicleCount 2 - the one row with a DIRECT server-side confirmation); the readback's
 *   multi-vehicle rows 21594487 (20/10 = 2), 20944559 (22/11 = 2), 18861847 (30/15 = 2), whose
 *   amount/amountPMT divisor is the per-vehicle `weight` in each case; and the 1,002 clean
 *   single-vehicle rows plus live Rajratan 23129542, all of which carry vehicleCount == weight -> 1.
 *
 * It is NOT on the write path and must never be put there. It is a DISPLAY fact (the price page
 * states the truck commitment to the desk before a cost is entered) and the expected value for the
 * engine's vehicle-count read-back oracle on a per-tonne bid. Being wrong costs a wrong line on a
 * page or one spurious alert; it cannot move money. That is a different risk class from the
 * inference that put a multiplier on the wire, and the separation is deliberate.
 *
 * Fails to null rather than guessing, on every shape it cannot prove: a non-per_tonne load (on FTL
 * `vehicleCount` is already a truck count and the ratio is meaningless), an unusable vehicleCount or
 * weight, and a ratio that is not a positive whole number (compared with a relative epsilon so a
 * fractional tonnage - 20.3 MT loads are real - cannot masquerade as a non-integer). null means "we
 * do not know how many trucks", and both consumers say exactly that rather than substituting 1.
 */
function derivePmtVehicleCount(l, pricingMode) {
  if (pricingMode !== 'per_tonne') return null;
  const total = Number(l.vehicleCount);
  const per = Number(l.weight);
  if (!(l.vehicleCount != null && Number.isFinite(total) && total > 0)) return null;
  if (!(l.weight != null && Number.isFinite(per) && per > 0)) return null;
  const ratio = total / per;
  const trucks = Math.round(ratio);
  if (trucks < 1) return null;
  if (Math.abs(ratio - trucks) > 1e-9 * Math.max(1, ratio)) return null;
  return trucks;
}

/**
 * The truck count a per-tonne bid commits BRL to, off a LOADED (mapped) load object - the ONE call
 * the price page and the WhatsApp ask/receipt both use, so a split load cannot render two different
 * truck counts on two different surfaces (review r1, docs/reviews/bid-command/fix-pmt-copy-dead-login,
 * Finding 1: the ask/receipt dropped the load's whole-load quantity on a split load, showing only the
 * per-truck figure).
 *
 * Prefers a PERSISTED, server-healed rules snapshot (rules.pmtVehicleCount, which survives a restart
 * a fresh derivation cannot) and falls back to deriving it off the load's own vehicleCount/weight
 * (derivePmtVehicleCount) when the snapshot predates the field - the exact fallback server.js's price
 * page already uses. `isPmt` is the caller's own isPmtBasis(load) result, passed in rather than
 * re-derived here, so this file never needs to import discovery's classifier to stay in the loop.
 */
function pmtVehicleCountFor(l, isPmt) {
  const rules = l && l.rules;
  if (rules && Number.isInteger(rules.pmtVehicleCount) && rules.pmtVehicleCount > 0) return rules.pmtVehicleCount;
  if (!isPmt) return null;
  return derivePmtVehicleCount({ vehicleCount: pmtTotalUnitsFor(l), weight: l && l.weight }, 'per_tonne');
}

/**
 * The load's own whole-load quantity (`units`), rounded to a whole number - the SAME rounding the
 * price page's own `totalUnits` (server.js renderPriceForm) and pmtVehicleCountFor above both use.
 * Exists as its own call so a per-tonne ask/receipt stating the load's TOTAL when the truck count is
 * unknown (review sweep, release-2026-09-28, Finding 5) can never compute a different total than the
 * price page's pmtCommitmentText(trucks=null) branch does for the same load. null when `units` is
 * absent or not a usable number - callers must not substitute 0 or guess a count from nothing.
 */
function pmtTotalUnitsFor(l) {
  const n = l && Number(l.units);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function deriveLoadRules(l) {
  if (!l || typeof l !== 'object') return null;
  const extendSeconds = parseHMS(l.branchAuctionExtendTime);
  // The branch's quote basis (branchQuoteType, falling back to rateType), extracted TWICE on purpose
  // because the two uses have genuinely different jobs:
  //   rawQuoteType  - AUDIT/display. `!= null`, so a present-but-empty branchQuoteType is recorded
  //                   VERBATIM on the `rateType` field below. The fact layer must report what
  //                   SuperProcure actually sent, never a substituted value.
  //   classifyBasis - CLASSIFICATION. Uses the SAME truthy-OR fallback realAdapter._mapLoad uses to
  //                   build load.quoteType (`normQuoteType(l.branchQuoteType || l.rateType)`), which
  //                   is the field discovery.isMultiVehicle reads. Sharing the OPERATOR - not just the
  //                   trim/upper-case normalization - is what makes "the two PMT classifiers can never
  //                   disagree about what counts as PMT" true BY CONSTRUCTION rather than by
  //                   observation. With `!= null` here the two DID diverge on one wire shape:
  //                   { branchQuoteType: '', rateType: 'PMT' } - isMultiVehicle sees `'' || 'PMT'` ->
  //                   'PMT' and treats `units` as tonnage, while this saw '' -> 'flat', so the load
  //                   slid past the per_tonne refusal and would have been bid as a flat FTL amount:
  //                   the exact per-MT-rate-on-the-wire underbid this guard exists to close, in the
  //                   fail-OPEN direction. Never observed across the 5,532-load census (the two fields
  //                   are always both 'PMT' or both absent), which is why it is a hardening, not a
  //                   live bug - but an unobserved shape is not an impossible one on live money.
  // Both are handed to derivePricingMode above (the ONE classifier the arm-time re-derivation also
  // calls), so a snapshot and a fresh derivation can never disagree.
  // The swap is monotonically SAFE: `||` only advances to rateType when branchQuoteType is FALSY, and
  // a falsy value can never normalise to 'PMT' on its own, so it can only ever turn a 'flat'
  // classification INTO 'per_tonne' (toward the refusal) - never the reverse.
  const rawQuoteType = l.branchQuoteType != null ? l.branchQuoteType : (l.rateType != null ? l.rateType : null);
  const classifyBasis = l.branchQuoteType || l.rateType || null;
  // Hoisted (rather than inlined at the pricingMode field below) because derivePmtVehicleCount needs
  // the classification: the vehicleCount/weight ratio is a truck count on a PMT load and meaningless
  // on a flat one. Same single classifier, so the hoist can introduce no disagreement.
  const pricingMode = derivePricingMode(classifyBasis);
  return {
    loadId: l.id != null ? String(l.id) : null,
    // per-load carrier identity: the load's branch is mapped to a specific BRL carrier entity, and
    // SuperProcure rejects (HTTP 400) a bid placed as the wrong carrier. Captured here as a FACT;
    // buildBidPayload STILL bids as the account carrier in this PR (byte-identical). The carrier-
    // routing PR flips one branch to consume this. branchFreighterId rides along for that same PR.
    branchCarrierCarrierId: l.branchCarrierCarrierId != null ? l.branchCarrierCarrierId : null,
    branchFreighterId: l.branchFreighterId != null ? l.branchFreighterId : null,
    // does the load require a transit time on the bid? buildBidPayload reads this to emit the
    // transitTime wire field ("<days>" as a STRING) from the capture-provided transitDays - and to
    // REFUSE (fail closed) when the days were never captured, instead of bidding a null that
    // SuperProcure 400s (proven live on SIKA).
    loadIsTransitTimeOn: !!l.loadIsTransitTimeOn,
    // shipper ceiling price, if any. Parsed to a NUMBER (SP ships it as a string, e.g. "90000.00")
    // and bound-checked here so a future ceiling mechanic clamps against a number, never a string.
    // null = no known ceiling (fail closed). See plausibleCeiling (engine/pricing, re-exported here).
    ceilingPrice: plausibleCeiling(l.ceilingPrice),
    // how the branch quotes this load (branchQuoteType / rateType). Recorded RAW here; the normalized
    // token (classifyBasis, above) classifies a PMT load into pricingMode 'per_tonne' below (a KG
    // per-tonne mechanic is still future work).
    rateType: rawQuoteType,
    // SuperProcure's own weight unit for this branch (brancheUnit) - MT for most, KG for some.
    // Normalised to the canonical enum (KG/MT), unknown/absent -> null; interpretation/display only,
    // never per-tonne bid math (that capability is unbuilt). Same normaliser _mapLoad's weightUnit
    // uses, so the LoadRules fact and the display field can never disagree about the load's unit.
    unit: normalizeUnit(l.brancheUnit),
    // close-model facts (same source _mapLoad classifies softClose from).
    softClose: extendSeconds > 0,
    extendSeconds,
    // per-load revision cap (branchBidCountAllowed / loadBidCountAllowed).
    revisionLimit: l.branchBidCountAllowed || l.loadBidCountAllowed || null,
    // per-load minimum bid difference (loadBidDifference: SP refuses a revision closer than this to our
    // own standing bid; observed live at 100/500/1000/1500). Carried as a NON-wire fact so the arm-time
    // rung interpolation (Layer 3) can size rungs against the real per-load decrement instead of the
    // adapter's static 100 default. Absent OR junk ('', non-numeric) -> null (the engine falls back
    // to caps.minDecrement) - same Number.isFinite gate plausibleCeiling applies, so a wire string
    // like 'abc' can never leak NaN into the rung math; 0 is kept (a real "no gap rule" value).
    minDecrement: (l.loadBidDifference != null && String(l.loadBidDifference).trim() !== ''
      && Number.isFinite(Number(l.loadBidDifference))) ? Number(l.loadBidDifference) : null,
    // pricingMode: a PMT ("Quote Per MT") load is classified 'per_tonne', which routes it through the
    // per-tonne branch of assertRulesSupported below. per_tonne is not in the frozen
    // SUPPORTED_MECHANICS base set - it joins the EFFECTIVE set only behind SP_PMT_BID=1, so on a box
    // without that flag (which is every box today) a PMT load is still REFUSED outright. The PMT
    // write wire itself is no longer the unknown: it was captured on 2026-08-05 and carries the bare
    // per-MT rate (_research/2026-08-05_pmt-createv2-capture-SETTLED.md). What keeps the flag off is
    // the operational rollout, not the semantics. Every OTHER basis stays 'flat' and inert exactly
    // as before: a genuine FTL load, and (critically) an unknown/missing quoteType (mock/sim/stale
    // intent), which must behave EXACTLY as today. This is a POSITIVE classification of a genuinely-PMT
    // basis ONLY - the refusal is never widened to an ambiguous load. Mirrors discovery.isMultiVehicle,
    // which likewise acts only on a KNOWN basis and leaves the unknown case to its own per-mode flag;
    // here the safe direction on an unknown basis is to stay 'flat' (behave as today).
    pricingMode,
    // PMT tonnage - the load's own quantity as SuperProcure states it, a DIAGNOSTIC/DISPLAY fact and
    // NOT a wire operand. On a PMT load SuperProcure's `vehicleCount` field carries the MT QUANTITY,
    // NOT a truck count (the documented "PMT lie" - discovery.isMultiVehicle returns false on PMT for
    // exactly this reason). It used to be the multiplier the wire conversion applied; the 2026-08-05
    // captured PMT write proved SuperProcure does that multiplication itself off its own per-vehicle
    // tonnage, so nothing on the write path reads this any more
    // (_research/2026-08-05_pmt-createv2-capture-SETTLED.md). Kept as a bound-checked NUMBER purely
    // because it rides every persisted LoadRules snapshot - it has NO reader in src/ at all. Do not
    // restate a consumer list here; derivePmtQuantity's own docstring above is the single statement
    // of that fact, and an earlier version of this line claimed the alert text and the price page
    // still surfaced it when neither does (the alert reads SuperProcure's own echoed bidQuantity,
    // the page reads the mapped load's `units`). Two comments in one file disagreeing about PMT
    // semantics is precisely how the defect this build fixes propagated. Allows a FRACTIONAL quantity (real PMT
    // loads run e.g. 20.3 MT); absent / non-finite / <= 0 -> null. See derivePmtQuantity for why the
    // `weight` cross-check that used to null this out was removed with the multiplier it guarded.
    pmtQuantity: derivePmtQuantity(l),
    // How many TRUCKS a per-tonne bid on this load commits BRL to (vehicleCount / weight), or null
    // when SuperProcure's own figures cannot settle it. NOT a wire operand - we still send vcq:-1 and
    // SuperProcure derives the count itself. This is the number the price page shows the desk before
    // a cost is entered, and the value the engine's vehicle-count read-back oracle expects on a
    // per-tonne bid. null on every flat load. See derivePmtVehicleCount.
    pmtVehicleCount: derivePmtVehicleCount(l, pricingMode),
    // mechanics THIS load needs the builder to handle beyond the flat baseline. The guard below
    // enforces every token against SUPPORTED_MECHANICS, so a load can only ever be classified here
    // for something the builder truly speaks. Transit-required loads (~1,629 across Havells / KEI /
    // Cords / Dynamic Cables / SIKA per the 2026-07-14 board census) declare 'transit_time'.
    requires: l.loadIsTransitTimeOn ? ['transit_time'] : [],
  };
}

// Widest plausible transit time, in days. All-India road lanes run well under two weeks; 60 is a
// fat-finger guard (a "300" typo for "3"), not a business rule - widen if a real lane ever needs it.
const MAX_TRANSIT_DAYS = 60;

/**
 * Normalize an operator-entered transit time to a whole number of days, or null when it is not
 * usable. The wire wants a STRING of integer days ("3" proved on SIKA; "3.5" is uncaptured
 * territory), so a decimal/zero/negative/absurd value is rejected here rather than sent as a guess.
 * Accepts a number or a numeric string (form inputs arrive as strings); null/'' -> null.
 */
function normalizeTransitDays(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRANSIT_DAYS) return null;
  return n;
}

/**
 * FAIL CLOSED on a transit-required load whose transit days were never captured. The mechanic
 * itself IS built (see SUPPORTED_MECHANICS), so assertRulesSupported passes - what can still be
 * missing is the per-load DATUM: the days only exist once a pricing operator enters them (capture
 * validates that; this guard covers every load armed around that gate, e.g. a request captured
 * before the transit build deployed). Without it the bid goes out with transitTime:null, which
 * SuperProcure answers with HTTP 400 (proven live on SIKA) - a silent miss on live money. Same
 * refuse-and-alert posture as assertRulesSupported; distinct code so the alert can say exactly
 * what to do (re-price the load with days). No-op on legacy opts / non-transit loads.
 */
function assertTransitSatisfied(rules) {
  if (!rules || typeof rules !== 'object') return; // no rules -> nothing to refuse
  if (!rules.loadIsTransitTimeOn) return;          // transit not required -> nothing to check
  if (normalizeTransitDays(rules.transitDays) != null) return;
  const e = new Error('missing_transit_time: this load requires transit time (days) on the bid and none was captured - refusing to bid; re-price the load and enter the transit days');
  e.code = 'MISSING_TRANSIT_TIME';
  throw e;
}

/**
 * FAIL CLOSED on an unbuilt mechanic. If a load's rules name a mechanic (in `requires`) or a
 * pricingMode the payload builder cannot actually construct, throw UNSUPPORTED_RULE so the caller
 * REFUSES + ALERTS rather than bidding a wrong payload on live money. The opposite of
 * json-rules-engine's run(), which silently emits nothing on a no-match (a fail-OPEN we must not
 * copy). A no-op for legacy opts / mock loads (no `requires`, no pricingMode) and for every real
 * load whose mechanics are all built (flat mode; transit-required loads name 'transit_time',
 * which IS built - their per-load days are enforced separately by assertTransitSatisfied).
 */
function assertRulesSupported(rules) {
  if (!rules || typeof rules !== 'object') return; // no rules -> nothing to refuse
  // The EFFECTIVE set is flag-gated: 'per_tonne' is present only when SP_PMT_BID=1 (read fresh, see
  // rulesConstants.effectiveSupportedMechanics). Flag OFF -> per_tonne is absent -> a PMT load is
  // refused via the pricingMode branch below, EXACTLY the fail-closed posture the classification
  // change established. All three fail-closed layers call this one function, so the gate can never be
  // honoured at one layer and skipped at another.
  const supported = effectiveSupportedMechanics();
  const requires = Array.isArray(rules.requires) ? rules.requires : [];
  const unknown = requires.filter((m) => !supported.includes(m));
  // Both namespaces: the supported set also holds non-mode mechanics ('transit_time'), and a token
  // that is not a pricing mode at all must not pass as one.
  if (rules.pricingMode != null && (!PRICING_MODES.includes(rules.pricingMode) || !supported.includes(rules.pricingMode))) {
    unknown.push(`pricingMode:${rules.pricingMode}`);
  } else if (rules.pricingMode === 'per_tonne') {
    // per_tonne IS supported here (the branch above already refused every per-tonne load when the
    // SP_PMT_BID gate is off, so a flag-off box refuses with the identical single reason it always
    // did). What remains are two PER-LOAD preconditions that stay fail-closed even with the gate on.
    // They are checked INDEPENDENTLY rather than as an else-if chain, so a load failing both names
    // both, and no ordering decides which reason an operator gets to see.
    if (rules.unit !== 'MT') {
      // per_tonne is SUPPORTED (SP_PMT_BID=1) but ONLY for MT. A KG or unknown-unit per-tonne load
      // stays FAIL CLOSED regardless of the flag: the per-KG write wire is UNCAPTURED (Tata / Ashirvad
      // wait for their own supervised capture), and an unknown unit must NEVER be assumed MT (the
      // ~1000x KG<->MT trap normalizeUnit exists to prevent). Refuse with an explicit unit-named reason
      // so the alert says why.
      unknown.push(`per_tonne_unit:${rules.unit == null ? 'unknown' : rules.unit}`);
    }
    const perTonneCeiling = plausibleCeiling(rules.ceilingPrice);
    if (perTonneCeiling != null) {
      // This load carries a shipper CEILING, and the ceiling's UNIT on a per-tonne load is UNPROVEN
      // - so refuse rather than bet live money on a coin-flip. STILL UNPROVEN after the 2026-08-05
      // wire capture: all 11 PMT loads on that day's board carry ceilingPrice null, so the capture
      // that settled the amount says nothing about the ceiling. Do NOT delete this branch on the
      // strength of that capture.
      //
      // The 2026-08-05 fix DID change the shape of the hazard, and the surviving argument is this.
      // Both consumers of ceilingPrice now read it in the SAME space - the engine caps the per-MT
      // ladder with it (bidEngine.arm) and the adapter belt asserts it against body.amount, which is
      // now also per-MT - so the two no longer contradict each other. What is left is that BOTH are
      // wrong together if SuperProcure's number is a whole-load total:
      //   ceiling is PER-MT -> everything is correct and this refusal costs a biddable load.
      //   ceiling is a TOTAL -> a total-magnitude number sits far ABOVE every per-MT rung, so the
      //                         ladder cap silently never binds and the ceiling-below-floor stand-down
      //                         never fires. The ceiling is not enforced at all, in silence, and a
      //                         load that cannot be won profitably arms with no warning. A safety
      //                         check that quietly no-ops is worse than one that refuses.
      // The evidence LEANS total - ceilingPrice on captured FTL loads sits in wire-amount magnitudes
      // (Havells "300000.00", Shriji "90000.00") - but that is an inference FROM FTL, and inferring a
      // PMT semantic from FTL is precisely how the amount-is-a-total error got into this codebase in
      // the first place (see the wire block comment in realAdapter.js). So this refuses instead,
      // through the same unsupported-mechanic path (one ERROR_KINDS alert, per-load dedupe, no rung
      // spent, nothing on the wire) rather than the belt's CEILING throw, which re-fires on every tick
      // and says "ceiling breach" for a load that actually cannot be bid at all.
      // RESOLVED BY: observing a real PMT load that carries a non-null ceilingPrice and comparing its
      // magnitude against that load's own per-MT rates. That is a read on the load object, not a bid.
      // Only then decide which space the ceiling lives in, fix BOTH consumers together, and delete
      // this branch.
      // Costs nothing today: no PMT load in the captured board carries a ceiling (all four PMT
      // branches in the 476-load v4 capture show '-', live PMT load 23129542 has "ceilingPrice":
      // null; the 430 ceiling-carrying loads are FTL). Flat loads never reach this branch, so FTL
      // ceiling behaviour - the engine cap and the belt's CEILING throw alike - is byte-identical.
      unknown.push(`per_tonne_ceiling:${perTonneCeiling}`);
    }
  }
  if (unknown.length) {
    const e = new Error(`unsupported_rule: load requires unbuilt mechanic(s) [${unknown.join(', ')}] - refusing to bid`);
    e.code = 'UNSUPPORTED_RULE';
    e.mechanics = unknown;
    throw e;
  }
}

module.exports = { deriveLoadRules, derivePricingMode, reconcilePricingMode, assertRulesSupported,
  plausibleCeiling, assertTransitSatisfied, normalizeTransitDays, MAX_TRANSIT_DAYS,
  derivePmtVehicleCount, pmtVehicleCountFor, pmtTotalUnitsFor };
