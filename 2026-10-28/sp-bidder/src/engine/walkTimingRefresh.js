'use strict';

const walkTiming = require('./walkTiming');

// Reading closedBids parses the whole collection in one synchronous callback (tens of ms), so the
// recompute never runs while a load is inside its final window; it waits and tries again.
const RETRY_MS = 5_000;

/**
 * The walk's measured-timing recompute, run on request (boot, hourly, a Settings save). One read of
 * closedBids per run; deferred while busy() says a load is in its final window, with one retry armed.
 */
function createWalkTimingRefresher({ listClosedSplit, platformKeys, walk, save, apply, busy, log, onError,
  retryMs = RETRY_MS, setTimer = setTimeout, now = Date.now }) {
  let retry = null;
  let running = null;

  async function run() {
    const keys = platformKeys();
    const split = await listClosedSplit({ platformKeys: [keys.sp, keys.gocomet] });
    const gc = new Set(split[keys.gocomet] || []);
    const doc = walkTiming.computeWalkTiming((split[keys.sp] || []).concat(split[keys.gocomet] || []), walk(), {
      nowMs: now(), platformOf: (r) => (gc.has(r) ? 'gocomet' : 'sp') });
    await save(doc);
    apply(doc);
    log.info('walk step times computed', { sp: { n: doc.sp.n, step: doc.sp.step.atPercentile, source: doc.sp.source },
      gocomet: { n: doc.gocomet.n, step: doc.gocomet.step.atPercentile, source: doc.gocomet.source } });
    return doc;
  }

  function request() {
    if (running) return running;
    if (busy()) {
      if (!retry) {
        log.info('walk step times: a load is in its final window - recomputing when it clears', { retryMs });
        retry = setTimer(() => { retry = null; return request(); }, retryMs);
        if (retry && retry.unref) retry.unref();
      }
      return Promise.resolve(null);
    }
    running = run().catch((e) => {
      if (onError) onError(e);
      return null;
    }).finally(() => { running = null; });
    return running;
  }

  return { request, pending: () => !!(retry || running) };
}

module.exports = { createWalkTimingRefresher, RETRY_MS };
