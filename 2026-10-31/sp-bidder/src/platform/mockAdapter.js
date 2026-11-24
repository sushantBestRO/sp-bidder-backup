'use strict';

const { PlatformAdapter } = require('./adapter');
const { createLogger } = require('../logging/logger');

/** Simulate variable network latency so the engine's RTT compensation is real. */
function jitter(baseMs, spreadMs) {
  return baseMs + Math.random() * spreadMs;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Operational logger for the mock adapter, kept at debug level only. This backs the
// demo/test harness rather than production traffic, so it stays below the default
// 'info' threshold and only shows up once someone turns debug logging on to watch it.
const log = createLogger('mockAdapter');

/**
 * MockSuperProcureAdapter — implements the PlatformAdapter against AuctionSim.
 *
 * Stands in for the real SuperProcure API. It deliberately reproduces the things
 * that make the real integration hard, so the engine is exercised honestly:
 *   - network latency on every call (so latency-compensated firing matters),
 *   - a session token with an expiry (so proactive refresh matters),
 *   - rank-only visibility by default (so the ladder strategy matters),
 *   - the strictly-lower / min-decrement rejection (so payload validation matters),
 *   - occasional transient read failures (so the engine must skip a tick, not crash).
 */
class MockSuperProcureAdapter extends PlatformAdapter {
  constructor(sim, opts = {}) {
    super();
    this.sim = sim;
    this.latency = opts.latency || { base: 35, spread: 90 }; // ms
    this.sessionTtlMs = opts.sessionTtlMs ?? 5 * 60_000;     // short on purpose, to exercise refresh
    this.transientFailRate = opts.transientFailRate ?? 0.02; // 2% of reads blip
    this.session = null;
    this.loginCount = 0;
    this.onAuthEvent = opts.onAuthEvent || (() => {});
  }

  capabilities() {
    return {
      standingPriceVisible: false, // SuperProcure shows your rank, not rivals' prices
      minDecrement: 100,
      allowsTieRate: false,        // confirmed: SuperProcure forbids equal rates
      revisionLimit: 6,
      closeModel: 'unknown',       // observed per-auction at runtime
      biddingEnabled: true,        // the simulator is the demo's whole point - it always bids
      platformLabel: 'SuperProcure', // this simulates SuperProcure; it is what the desk would be told
    };
  }

  async login() {
    await sleep(jitter(400, 600)); // OTP round-trip is slow
    this.loginCount += 1;
    const issuedAt = Date.now();
    this.session = {
      token: `mock.jwt.${issuedAt}.${Math.random().toString(36).slice(2)}`,
      issuedAt,
      expiresAt: issuedAt + this.sessionTtlMs,
    };
    this.onAuthEvent({ type: 'login', loginCount: this.loginCount, expiresAt: this.session.expiresAt });
    log.debug('mock login succeeded', { loginCount: this.loginCount, expiresAt: new Date(this.session.expiresAt).toISOString() });
    return this.session;
  }

  /** Proactive refresh: re-login when within 60s of expiry. */
  async ensureSession() {
    const now = Date.now();
    if (!this.session) return this.login();
    if (now >= this.session.expiresAt - 60_000) {
      this.onAuthEvent({ type: 'refresh', reason: 'near_expiry' });
      return this.login();
    }
    return this.session;
  }

  _assertSession() {
    if (!this.session || Date.now() >= this.session.expiresAt) {
      const e = new Error('session_expired');
      e.code = 'AUTH';
      throw e;
    }
  }

  async listAuctions() {
    await this.ensureSession();
    await sleep(jitter(this.latency.base, this.latency.spread));
    this._assertSession();
    return this.sim.listOpen().map(a => ({
      id: a.id,
      lane: a.lane,
      equipment: a.equipment,
      weight: a.weight,
      units: a.units,
      status: a.status,
      closesAt: a.closesAt,
      ceiling: a.ceiling,
    }));
  }

  async getAuctionState(auctionId) {
    const t0 = Date.now();
    await sleep(jitter(this.latency.base, this.latency.spread));
    const rtt = Date.now() - t0;

    // transient blip: engine must treat ok:false as "skip this tick"
    if (Math.random() < this.transientFailRate) {
      return { ok: false, myRank: null, totalBidders: 0, standingL1Price: null,
        closesInMs: 0, revisionsLeft: null, closeModel: 'hard', measuredRttMs: rtt };
    }
    try {
      this._assertSession();
    } catch (e) {
      return { ok: false, authError: true, myRank: null, totalBidders: 0, standingL1Price: null,
        closesInMs: 0, revisionsLeft: null, closeModel: 'hard', measuredRttMs: rtt };
    }

    const o = this.sim.observe(auctionId, 'US');
    if (!o) return { ok: false, myRank: null, totalBidders: 0, standingL1Price: null,
      closesInMs: 0, revisionsLeft: null, closeModel: 'hard', measuredRttMs: rtt };

    return {
      ok: true,
      status: o.status,
      myRank: o.myRank,
      totalBidders: o.totalBidders,
      standingL1Price: o.standingL1Price,
      closesInMs: o.closesInMs,
      // static per-load cap (total allowed) - mirrors realAdapter.js:697.
      revisionLimit: o.revisionLimit,
      revisionsLeft: o.revisionsLeft,
      // per-load Bid Difference - mirrors realAdapter.js:701.
      minDecrement: o.minDecrement,
      closeModel: o.closeModel,
      // L3 soft-close endgame inputs - mirror realAdapter.js:705-715. Without these the
      // engine's _observeExtension can never confirm an extension, so extendCap stays null
      // and every soft sim auction degrades to effectively-hard (no defend/snipe arc).
      extendMs: o.extendMs,                 // anti-snipe extension interval (ms); null on hard close
      extendCount: o.extendCount,           // MAX anti-snipe extensions; null = UNKNOWN cap
      triggerWindowMs: o.triggerWindowMs,   // seconds-remaining threshold that triggers an extension (ms)
      closesAtMs: o.closesAtMs,             // ABSOLUTE server-epoch close (reflects live extensions)
      measuredRttMs: rtt,
    };
  }

  async placeBid(auctionId, price) {
    const t0 = Date.now();
    // Timing only — mirrors realAdapter's request-start/response-received/latency
    // logging so the mock backing behaves observably the same way in dev.
    log.debug('placeBid request started', { auctionId, price: Math.round(price) });
    await this.ensureSession();
    await sleep(jitter(this.latency.base, this.latency.spread));
    let res;
    try {
      this._assertSession();
      res = this.sim.submitBid(auctionId, 'US', price);
    } catch (e) {
      const latencyMs = Date.now() - t0;
      log.debug('placeBid response received', { auctionId, accepted: false, reason: 'auth', latencyMs });
      return { accepted: false, status: 401, myRank: null, revisionsLeft: null, reason: 'auth', latencyMs };
    }
    const latencyMs = Date.now() - t0;
    log.debug('placeBid response received', { auctionId, accepted: !!res.accepted, reason: res.accepted ? null : res.reason, latencyMs });
    return {
      accepted: !!res.accepted,
      myRank: res.rank ?? null,
      revisionsLeft: res.revisionsLeft ?? null,
      reason: res.accepted ? null : res.reason,
      latencyMs,
    };
  }
}

module.exports = { MockSuperProcureAdapter };
