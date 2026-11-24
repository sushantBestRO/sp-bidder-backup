'use strict';

/**
 * Maytapi WhatsApp client - the provider BRL actually runs for its GoComet
 * notifications (product-scoped REST, one linked "phone" per sender number).
 * Unlike the official WhatsApp Business API, Maytapi needs NO Meta-approved
 * templates: we render the full message text (see waTemplates.js) and POST it.
 *
 * No new dependency: uses Node 18's global fetch, injectable as `transport`
 * for tests. No retry (matches the GoComet behaviour; a re-emit re-sends).
 *
 * Endpoint shape: {base}/{productId}/{phoneId}/sendMessage
 *   header  x-maytapi-key: <token>
 *   body    { to_number, type: 'text', message }
 * A send is ok only when HTTP is 2xx AND the body says success:true - Maytapi
 * returns 200 with success:false for a disabled/loading phone, so the HTTP
 * status alone would silently swallow those failures.
 */
const { logAt } = require('../logging/logger');
// The group-JID rule lives in ONE place (model/normalizePhone.js) - the same predicate the
// Person/recipient validators use, so the transport and the data layer can never disagree about
// what counts as a group. A second copy of the regex here is exactly the drift that let the
// account-contact endpoint diverge from the phone rule once before.
const { isGroupJid } = require('../model/normalizePhone');

const DEFAULT_ENDPOINT = 'https://api.maytapi.com/api';

class WhatsAppClient {
  constructor({ token, productId, phoneId, enabled = false, endpoint = DEFAULT_ENDPOINT, transport, log = () => {}, healthTtlMs } = {}) {
    this.token = token || null;
    this.productId = productId || null;
    this.phoneId = phoneId != null && phoneId !== '' ? String(phoneId) : null;
    this._enabled = !!enabled;
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.transport = transport || (typeof fetch === 'function' ? fetch : null);
    this.log = log;
    // circuit-breaker health cache (see sessionHealthy) - one listPhones call warms it, then a
    // burst of alerts reuses it for this long instead of one probe per send.
    this._healthTtlMs = healthTtlMs != null ? healthTtlMs : 45000;
    this._healthAt = 0;
    this._healthy = true;
  }

  // D007: every call site below used to call this.transport(url, init) directly, with no timeout
  // and no AbortSignal - a hung socket (TCP stall, no RST) never settled, and a hung alert send
  // could hang whatever awaited it. Same reference pattern as realAdapter._request: race the fetch
  // against a timer, abort() on expiry so a slow-but-eventually-successful fetch doesn't keep
  // running unbounded, and always settle either way (timeout -> a network-shaped rejection the
  // caller already handles via its existing try/catch).
  async _timeoutFetch(url, init, timeoutMs = 8000) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const fullInit = ac ? Object.assign({}, init, { signal: ac.signal }) : init;
    let timer = null;
    const timeout = new Promise((_res, rej) => {
      timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (_e) {} } rej(new Error('whatsapp_request_timeout')); }, timeoutMs);
      if (timer && timer.unref) timer.unref();
    });
    try {
      return await Promise.race([this.transport(url, fullInit), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Review correction (26 Sep): _timeoutFetch only bounded the wait for HEADERS - fetch() resolves
  // once they arrive, and every call site then reads the body (res.json()) as a SEPARATE, wholly
  // unbounded await. A server that sends headers immediately and then stalls or drips the body
  // never times out at all. Same race-against-a-timer shape, no measured send-latency figure exists
  // in this tree to justify a different number, so it keeps the same 8s default.
  async _timeoutRead(readPromiseFactory, timeoutMs = 8000) {
    let timer = null;
    const timeout = new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error('whatsapp_response_timeout')), timeoutMs);
      if (timer && timer.unref) timer.unref();
    });
    try {
      return await Promise.race([readPromiseFactory(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // `log` arrives via constructor injection - most call sites in this codebase (see
  // logging/logger.js's own header comment) still pass the plain ad hoc `log(msg)` callback
  // rather than a full createLogger instance with .debug/.info/.warn/.error, so route
  // level-specific calls through whichever shape was actually injected instead of assuming a
  // method that might not exist. Shared with DiscoveryPoller/Notifier via logging/logger.js's
  // exported logAt() so the DI-fallback logic lives in exactly one place.
  _emit(level, msg, meta) {
    logAt(this.log, level, msg, meta);
  }

  // All four must be present or we stay dark (the safe default until the account is wired).
  enabled() { return this._enabled && !!this.token && !!this.productId && !!this.phoneId && !!this.transport; }

  // Normalize a listPhones entry's `status` to a lowercase string. Mirrors verify-whatsapp-setup.js's
  // phoneStatus() (status can be a plain string OR an object with state/status/loggedIn/connected).
  // An unrecognised shape -> 'unknown' (which is NOT 'active', but the caller treats a parse it can't
  // read as fail-open, so 'unknown' never causes a blackout).
  static statusOf(entry) {
    const s = entry && entry.status;
    if (typeof s === 'string') return s.toLowerCase();
    if (s && typeof s === 'object') {
      if (typeof s.state === 'string') return s.state.toLowerCase();
      if (typeof s.status === 'string') return s.status.toLowerCase();
      if (s.loggedIn === true || s.connected === true) return 'active';
    }
    return 'unknown';
  }

  // Normalize one getGroups participant entry to a bare phone/JID string. Maytapi has returned a
  // group's `participants` both as an array of JID strings ('919...@c.us') and as an array of
  // objects ({ id, admin }) across versions; read whichever shape arrived rather than assume one,
  // for the same reason statusOf() reads listPhones' status robustly. An unreadable entry -> null
  // (dropped by the caller), never a throw - one odd row must not sink the whole audit.
  static participantId(entry) {
    if (entry == null) return null;
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object') {
      const v = entry.id || entry.number || entry.phone || entry.jid || null;
      return v == null ? null : String(v);
    }
    return null;
  }

  // Circuit breaker: is the sender's WhatsApp session actually LIVE? The failure this guards -
  // seen live 2026-07-15 - is that Maytapi ACCEPTS sends (200, success:true) and QUEUES them even
  // when the linked session is logged out, then floods the whole stale backlog on reconnect. So an
  // ok:true is not proof of delivery. The alert path checks this first and skips the send when the
  // session is down, rather than pile a stale message onto that queue. Cached for a short TTL so a
  // burst of alerts costs one listPhones call, not one per recipient. FAIL-OPEN: any error or an
  // unreadable response assumes healthy - a listPhones glitch must never block a real alert; the
  // separate sender-health monitor + a human are the backstop for a genuinely wrong read.
  async sessionHealthy() {
    if (!this.enabled()) return false;
    const now = Date.now();
    if (this._healthAt && now - this._healthAt < this._healthTtlMs) return this._healthy;
    let healthy = true;
    try {
      const res = await this._timeoutFetch(`${this.endpoint}/${this.productId}/listPhones`, { headers: { 'x-maytapi-key': this.token } });
      if (res && res.ok) {
        const data = await this._timeoutRead(() => res.json());
        const list = (data && data.data) || data;
        if (Array.isArray(list)) {
          const me = list.find((p) => String(p.id) === this.phoneId);
          // A DEFINITIVE not-'active' is the only 'down'. Parse `status` robustly - Maytapi has
          // returned it both as a plain string and (per the repo's verify-whatsapp-setup.js) as an
          // object. Crucially, an UNREADABLE shape resolves to 'unknown' and leaves `healthy` at its
          // fail-OPEN default (true) rather than flipping it down - a parse we can't trust must never
          // cause a total alert blackout (which would be worse than the queued-flood it guards).
          if (me) { const st = WhatsAppClient.statusOf(me); if (st !== 'unknown') healthy = st === 'active'; }
        }
      }
    } catch (_) { healthy = true; }
    this._healthy = healthy; this._healthAt = now;
    return healthy;
  }

  // Every WhatsApp group the sender is a member of - the read the daily heartbeat tripwire
  // (heartbeat.js -> collectMembership) uses for BOTH its checks. Endpoint mirrors sendMessage's
  // shape: GET {base}/{productId}/{phoneId}/getGroups, header x-maytapi-key. Returns
  // [{ id, name, participants: [<jid/number strings>], admins: [<jid/number strings>], config }]:
  //   - participants   -> the membership diff (unknown-participant tripwire, #48);
  //   - admins         -> the core-admin-superset check (each normalized like a participant, since
  //                       Maytapi returns admins as bare JID strings OR { id, admin } objects too);
  //   - config         -> the whole group-settings block (incl. config.membersCanAddMembers, i.e.
  //                       WhatsApp's "who can add members"), passed through verbatim; null when the
  //                       provider omitted it. Older revisions of this wrapper dropped `admins` and
  //                       `config` on the floor - the settings tripwire is exactly why they are kept.
  // The caller decides what an absent admins/config means (it fails that CLOSED); this wrapper only
  // surfaces what arrived and never guesses a default that would read as "all clear".
  //
  // Deliberately FAIL-CLOSED (throws on any HTTP/parse/success:false error), the OPPOSITE of
  // sessionHealthy's fail-open: a health probe that can't read must not blackout real alerts, but a
  // membership check that can't read must NOT be allowed to render as "all clear" - the caller
  // catches the throw and reports the audit as unavailable. Never logs the token/productId/phoneId
  // credential (same rule as sendText).
  async getGroups() {
    if (!this.enabled()) throw new Error('whatsapp disabled');
    const url = `${this.endpoint}/${this.productId}/${this.phoneId}/getGroups`;
    let res;
    try { res = await this._timeoutFetch(url, { headers: { 'x-maytapi-key': this.token } }); }
    catch (e) { throw new Error(`getGroups network: ${e && e.message}`); }
    if (!res || !res.ok) throw new Error(`getGroups http ${res ? res.status : '?'}`);
    let data = null;
    try { data = await this._timeoutRead(() => res.json()); } catch (_) { throw new Error('getGroups: non-JSON body'); }
    // Maytapi wraps the list under `data` and signals success:true (200 with success:false is a
    // real failure here, same asymmetry sendText guards). An unreadable envelope is fail-closed.
    if (!data || data.success !== true) throw new Error((data && (data.message || data.error)) || 'getGroups: success=false');
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.groups) ? data.groups : []);
    return list.filter(Boolean).map((g) => ({
      id: g.id != null ? String(g.id) : null,
      name: (g.name || g.subject) || null,
      participants: (Array.isArray(g.participants) ? g.participants : [])
        .map((p) => WhatsAppClient.participantId(p)).filter(Boolean),
      // admins normalize through the SAME participantId reader (string OR { id, admin } shape); an
      // absent list becomes [], which the caller treats as unreadable (fail-closed), not "no admins".
      admins: (Array.isArray(g.admins) ? g.admins : [])
        .map((p) => WhatsAppClient.participantId(p)).filter(Boolean),
      // config is passed through as-is (only the object shape is guarded); null signals "not provided",
      // which the caller cannot read as compliant.
      config: (g.config && typeof g.config === 'object') ? g.config : null,
    }));
  }

  // The sender's OWN dialable WhatsApp number (the MSISDN), read live off listPhones' `number`
  // field - the membership audit always counts this as allowed (the bot is a member of every group
  // it admins). null when it can't be resolved; the audit treats that as unavailable and fails
  // closed rather than flag the bot itself as an intruder. Same listPhones probe sessionHealthy
  // uses; never logs the token.
  async selfNumber() {
    if (!this.enabled()) return null;
    try {
      const res = await this._timeoutFetch(`${this.endpoint}/${this.productId}/listPhones`, { headers: { 'x-maytapi-key': this.token } });
      if (!res || !res.ok) return null;
      const data = await this._timeoutRead(() => res.json());
      const list = (data && data.data) || data;
      if (!Array.isArray(list)) return null;
      const me = list.find((p) => String(p.id) === this.phoneId);
      return me && me.number != null ? String(me.number) : null;
    } catch (_) { return null; }
  }

  // The raw listPhones array, fail-CLOSED (throws on any HTTP/parse error) - the OPPOSITE posture
  // from sessionHealthy(), which reads the same endpoint fail-open. A health probe must never
  // blackout a real alert; a supervised runner that has to confirm two phones are 'active' before it
  // mutates a live group must STOP on an unreadable board. Caller normalizes via statusOf().
  async listPhones() {
    if (!this.enabled()) throw new Error('whatsapp disabled');
    const url = `${this.endpoint}/${this.productId}/listPhones`;
    let res;
    try { res = await this._timeoutFetch(url, { headers: { 'x-maytapi-key': this.token } }); }
    catch (e) { throw new Error(`listPhones network: ${e && e.message}`); }
    if (!res || !res.ok) throw new Error(`listPhones http ${res ? res.status : '?'}`);
    let data = null;
    try { data = await this._timeoutRead(() => res.json()); } catch (_) { throw new Error('listPhones: non-JSON body'); }
    const list = (data && data.data) || data;
    if (!Array.isArray(list)) throw new Error('listPhones: unexpected shape');
    return list;
  }

  // A GROUP is addressed by its WhatsApp JID, not a phone number: '<digits>@g.us' (ids minted
  // since 2021) or the legacy '<creator>-<timestamp>@g.us'. Both go in the SAME to_number field
  // as an individual recipient - only the value shape differs.
  static isGroupId(to) { return isGroupJid(to); }

  // Maytapi wants an individual recipient with country code and no '+' (e.g. 919356252711).
  // A group JID must pass through VERBATIM: digit-stripping one silently turns it into a
  // plausible-looking phone number, so the send doesn't fail loudly - it succeeds against the
  // wrong recipient. That's the failure mode this branch exists to prevent.
  static cleanNumber(to) {
    const raw = String(to == null ? '' : to).trim();
    if (WhatsAppClient.isGroupId(raw)) return raw.toLowerCase();
    return raw.replace(/[^\d]/g, '');
  }

  // The group-admin endpoints address an individual as '<msisdn>@c.us', never a group JID. A group
  // JID or an empty value returns '' so the caller refuses the op instead of targeting the wrong
  // recipient - same fail-loud stance as cleanNumber.
  static toContactJid(number) {
    const raw = String(number == null ? '' : number).trim();
    if (WhatsAppClient.isGroupId(raw)) return '';
    if (/@c\.us$/i.test(raw)) return raw.toLowerCase();
    const d = raw.replace(/[^\d]/g, '');
    return d ? `${d}@c.us` : '';
  }

  // `kind` is an optional caller-supplied label (the notifier's alert kind, e.g. 'price_needed'
  // or 'test') carried through purely so a send can be correlated in the logs - it never reaches
  // the Maytapi request itself.
  async sendText(to, message, { kind } = {}) {
    return this._post(to, { type: 'text', message: String(message == null ? '' : message) }, { kind, verb: 'send' });
  }

  /**
   * Edit an already-sent message IN PLACE - WhatsApp shows an "edited" tag and does NOT re-notify.
   * Maytapi wire: { to_number, type:'edit', message, reply_to:<original msgId> } - the field is
   * `reply_to`, NOT `message_id` (message_id answers success:true and silently does nothing).
   * WhatsApp's edit window is ~15 min from the original send; PAST it the edit is a silent no-op that
   * Maytapi STILL answers success:true for - so ok:true is NOT proof it landed. The window is enforced
   * by the CALLER (notifier._deliverGroup), which falls back to a reply when the ask is stale; this
   * client only performs the wire call. Verified live 2026-07-20/21 against BRL's sender.
   */
  async editText(to, messageId, message, { kind } = {}) {
    const id = messageId == null ? '' : String(messageId).trim();
    if (!id) return { ok: false, error: 'no message id to edit' };
    return this._post(to, { type: 'edit', message: String(message == null ? '' : message), reply_to: id }, { kind, verb: 'edit' });
  }

  /**
   * Reply threaded under a parent message (quoted; DOES re-notify the group). Maytapi wire:
   * { to_number, type:'text', message, reply_to:<parent msgId> }. NO time window - a reply can quote
   * a message of any age, which is why it is both the safe fallback for a stale edit and the clean
   * "this ask is handled / here is the outcome" thread marker. Verified live 2026-07-20/21.
   */
  async replyText(to, replyToMsgId, message, { kind } = {}) {
    const id = replyToMsgId == null ? '' : String(replyToMsgId).trim();
    if (!id) return { ok: false, error: 'no message id to reply to' };
    return this._post(to, { type: 'text', message: String(message == null ? '' : message), reply_to: id }, { kind, verb: 'reply' });
  }

  /**
   * Shared POST core for send / edit / reply. All three hit the SAME sendMessage endpoint - Maytapi's
   * differentiator is the BODY (type + optional reply_to), not the path. `wire` is the body minus
   * to_number; `verb` is a log label only. Returns sendText's exact contract: { ok:true, messageId }
   * on success, { ok:false, error } on any failure, { ok:false, skipped } when the client is disabled.
   * A 200 with success:false (Maytapi's disabled/loading-phone case) is a FAILURE, not a silent ok.
   */
  async _post(to, wire, { kind, verb = 'send' } = {}) {
    if (!this.enabled()) return { ok: false, skipped: true, reason: 'whatsapp disabled' };
    const toNumber = WhatsAppClient.cleanNumber(to);
    if (!toNumber) return { ok: false, error: 'no recipient number' };
    const url = `${this.endpoint}/${this.productId}/${this.phoneId}/sendMessage`;
    // Never log the message body itself (it can carry commercial pricing detail) or the
    // token/productId/phoneId credential - only what's needed to correlate a delivery in
    // pm2 logs: the recipient, the verb, the alert kind, and roughly how big the message was.
    this._emit('debug', `[whatsapp] ${verb} attempt to ${toNumber} (${kind || 'unspecified'})`,
      { to: toNumber, kind: kind || null, verb, messageLength: wire && wire.message != null ? String(wire.message).length : 0 });
    let res;
    try {
      res = await this._timeoutFetch(url, {
        method: 'POST',
        headers: { 'x-maytapi-key': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ to_number: toNumber }, wire)),
      });
    } catch (e) {
      this._emit('error', `[whatsapp] ${verb} to ${toNumber} failed (network): ${e && e.message}`,
        { to: toNumber, kind: kind || null, err: e });
      return { ok: false, error: `network: ${e && e.message}` };
    }
    if (!res || !res.ok) {
      this._emit('error', `[whatsapp] ${verb} to ${toNumber} failed (http ${res ? res.status : '?'})`,
        { to: toNumber, kind: kind || null, status: res ? res.status : null });
      return { ok: false, error: `http ${res ? res.status : '?'}` };
    }
    let data = null;
    try { data = await this._timeoutRead(() => res.json()); } catch (_) { /* non-JSON body */ }
    if (!data || data.success !== true) {
      const errorBody = (data && (data.message || data.error)) || 'maytapi: success=false';
      this._emit('error', `[whatsapp] ${verb} to ${toNumber} failed (maytapi): ${errorBody}`,
        { to: toNumber, kind: kind || null, status: res.status, error: errorBody });
      return { ok: false, error: errorBody };
    }
    const messageId = (data.data && (data.data.msgId || data.data.messageId)) || null;
    return { ok: true, messageId };
  }

  /**
   * Shared POST core for the GROUP-ADMIN mutations (createGroup, group/config, group/add,
   * group/promote). Same contract as _post: 2xx AND success:true is the only success. Never logs the
   * credential or the body.
   *
   * Wired ONLY into the supervised runbooks (provision-group.js, promote-fallback-admin.js) - nothing
   * in the running engine creates, adds, promotes or reconfigures a group, and the daily membership
   * tripwire stays read-and-alert.
   *
   * The response carries no information about whether the change landed, in EITHER direction: a
   * description write returns success:true and is discarded (five shapes, 2026-07-28), and a
   * group/add returned HTTP 500 on a write that fully landed (Durian, same day). Callers always
   * read-back-verify via getGroups().
   */
  async _groupOp(pathSeg, wire, verb) {
    if (!this.enabled()) return { ok: false, skipped: true, reason: 'whatsapp disabled' };
    const url = `${this.endpoint}/${this.productId}/${this.phoneId}/${pathSeg}`;
    this._emit('debug', `[whatsapp] group ${verb} attempt`, { verb, target: (wire && wire.conversation_id) || null });
    let res;
    try {
      res = await this._timeoutFetch(url, {
        method: 'POST',
        headers: { 'x-maytapi-key': this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(wire),
      });
    } catch (e) {
      this._emit('error', `[whatsapp] group ${verb} failed (network): ${e && e.message}`, { verb, err: e });
      return { ok: false, error: `network: ${e && e.message}` };
    }
    if (!res || !res.ok) {
      this._emit('error', `[whatsapp] group ${verb} failed (http ${res ? res.status : '?'})`, { verb, status: res ? res.status : null });
      return { ok: false, error: `http ${res ? res.status : '?'}` };
    }
    let data = null;
    try { data = await this._timeoutRead(() => res.json()); } catch (_) { /* non-JSON body */ }
    if (!data || data.success !== true) {
      const errorBody = (data && (data.message || data.error)) || 'maytapi: success=false';
      this._emit('error', `[whatsapp] group ${verb} failed (maytapi): ${errorBody}`, { verb, status: res.status, error: errorBody });
      return { ok: false, error: errorBody };
    }
    return { ok: true, raw: data };
  }

  /**
   * CREATE a group, optionally born locked. Wire: POST /createGroup { name, numbers:[<msisdn>],
   * config? } -> { ok:true, id:'<digits>@g.us', raw }.
   *
   * The bot must CREATE every group it administers: /group/acceptInvite is dead on this account (GI2
   * for every transport shape), so BRL staff cannot make a group and drop the bot in.
   *
   * `config` at birth is passed through but NOT trusted - a group born unlocked stays open until
   * someone notices, so the caller reads the config back and remediates via setGroupConfig(). At
   * least one number is required: a second controlled number joins at birth so the group never has a
   * single administrator.
   */
  async createGroup(name, numbers, { config = null } = {}) {
    const subject = String(name == null ? '' : name).trim();
    if (!subject) return { ok: false, error: 'no group name' };
    const list = (Array.isArray(numbers) ? numbers : [numbers])
      .map((n) => WhatsAppClient.toContactJid(n).replace(/@c\.us$/i, ''))
      .filter(Boolean);
    if (!list.length) return { ok: false, error: 'no participant numbers' };
    const wire = { name: subject, numbers: list };
    if (config && typeof config === 'object') wire.config = config;
    const res = await this._groupOp('createGroup', wire, 'create');
    if (!res.ok) return res;
    // Read the plausible id aliases rather than assume one key. A create whose id we cannot parse is
    // a group that EXISTS and that no later op can address - report it as a failure to resolve by
    // hand (it will show up in the census), never ok-with-no-id.
    const d = (res.raw && res.raw.data) || res.raw || {};
    const id = d.id || d.conversation_id || d.group_id || d.gid || null;
    if (!id || !WhatsAppClient.isGroupId(String(id))) {
      return { ok: false, error: 'createGroup succeeded but returned no readable group id - find it via the census and continue by hand', raw: res.raw };
    }
    return { ok: true, id: String(id).toLowerCase(), raw: res.raw };
  }

  /**
   * SET a group's settings block. Wire: POST /group/config { conversation_id, config }.
   * membersCanAddMembers:false is WhatsApp's "Add members -> Only admins", settable on an existing
   * group and reversible.
   *
   * FULL REPLACE, not a patch - a partial block silently resets whatever it omits on a live customer
   * group, so the caller merges its one change into the config it just read (see mergeLockConfig).
   *
   * `description` is REFUSED. Maytapi answers success:true and discards it (five shapes tried
   * 2026-07-28); admin rights are irrelevant, it is an API limit. That silence got the job recorded
   * as done twice while nothing changed, so it fails loudly here - a description is a human editing
   * the group in the WhatsApp app.
   */
  async setGroupConfig(conversationId, config) {
    const gid = String(conversationId == null ? '' : conversationId).trim();
    if (!WhatsAppClient.isGroupId(gid)) return { ok: false, error: 'not a group id' };
    if (!config || typeof config !== 'object') return { ok: false, error: 'no config block' };
    if (Object.prototype.hasOwnProperty.call(config, 'description')) {
      return { ok: false, error: 'description cannot be set through this API - Maytapi returns success:true and discards it. A human must edit the group description in the WhatsApp app.' };
    }
    return this._groupOp('group/config', { conversation_id: gid.toLowerCase(), config }, 'config');
  }

  /**
   * Add ONE participant. Wire: POST /group/add { conversation_id, numbers:[<msisdn>], sendInvite }.
   * `numbers` is an array even for one; sendInvite lets Maytapi DM an invite link when a privacy
   * setting blocks a direct add. No `message` - nothing posts into the customer-visible group.
   */
  async addParticipant(conversationId, number, { sendInvite = true } = {}) {
    const gid = String(conversationId == null ? '' : conversationId).trim();
    if (!WhatsAppClient.isGroupId(gid)) return { ok: false, error: 'not a group id' };
    const jid = WhatsAppClient.toContactJid(number);
    if (!jid) return { ok: false, error: 'no participant number' };
    const msisdn = jid.replace(/@c\.us$/i, '');
    return this._groupOp('group/add', { conversation_id: gid.toLowerCase(), numbers: [msisdn], sendInvite: !!sendInvite }, 'add');
  }

  /**
   * Promote ONE participant to admin. Wire: POST /group/promote { conversation_id, number:'..@c.us' }.
   * The number must already be a member (add, read-back, THEN promote). group/demote reverses it and
   * is deliberately not wired - the runbooks are additive only.
   */
  async promoteAdmin(conversationId, number) {
    const gid = String(conversationId == null ? '' : conversationId).trim();
    if (!WhatsAppClient.isGroupId(gid)) return { ok: false, error: 'not a group id' };
    const jid = WhatsAppClient.toContactJid(number);
    if (!jid) return { ok: false, error: 'no participant number' };
    return this._groupOp('group/promote', { conversation_id: gid.toLowerCase(), number: jid }, 'promote');
  }
}

module.exports = { WhatsAppClient, DEFAULT_ENDPOINT };
