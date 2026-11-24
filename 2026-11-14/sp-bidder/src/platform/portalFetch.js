'use strict';
/**
 * The fetch both portal adapters use by default, with connections kept open across quiet spells.
 *
 * Node's fetch (its bundled undici) closes an idle connection after 4 s unless the server sends a
 * Keep-Alive hint. SuperProcure and GoComet send none and keep a connection open for 65 s or more,
 * so a write after a quiet spell paid a fresh TCP and TLS handshake. This hands fetch a dispatcher
 * that keeps idle connections for KEEPALIVE_MS (30 s), well inside the portals' idle timeout, which is
 * measured only as "at least 65 s": a server-side close must never leave a dead pooled socket for a
 * bid write. Nothing else about the request changes: same fetch, same
 * headers, and no retry.
 *
 * undici is not requirable from Node itself, and adding it as a dependency would ship a second copy
 * of it. Its Agent class is reached through the global dispatcher Node installs when undici loads;
 * a Node that installs none gets plain fetch. SP_HTTP_KEEPALIVE=0 turns it off.
 */
const { createLogger } = require('../logging/logger');

const KEEPALIVE_MS = 30_000;
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

const plainFetch = (url, init) => fetch(url, init);

function bundledAgentClass() {
  // Constructing a Response loads Node's undici, which installs the global dispatcher. No request.
  new Response('');
  const d = globalThis[GLOBAL_DISPATCHER];
  return d && typeof d.constructor === 'function' && typeof d.dispatch === 'function' ? d.constructor : null;
}

function keepAliveOn(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.SP_HTTP_KEEPALIVE || '').trim());
}

function createPortalFetch({ keepAlive = keepAliveOn(), keepAliveMs = KEEPALIVE_MS, log = createLogger('portalFetch') } = {}) {
  if (!keepAlive) return plainFetch;
  const Agent = bundledAgentClass();
  if (!Agent) {
    log.warn('this Node exposes no fetch dispatcher; portal connections close after 4 s idle as before');
    return plainFetch;
  }
  const dispatcher = new Agent({ keepAliveTimeout: keepAliveMs });
  return (url, init) => fetch(url, { ...init, dispatcher });
}

let shared = null;
function portalFetch(url, init) {
  if (!shared) shared = createPortalFetch();
  return shared(url, init);
}

module.exports = { portalFetch, createPortalFetch, keepAliveOn, KEEPALIVE_MS };
