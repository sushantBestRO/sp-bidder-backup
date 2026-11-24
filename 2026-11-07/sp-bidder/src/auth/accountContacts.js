'use strict';

/**
 * Constants shared by every reader/writer of an account's login contact (phone/email) - the
 * side collection that exists purely for operator reference (see server.js's
 * rememberAccountContact for why it's never on the account record itself: `loadAccounts`
 * synthesizes an implicit `primary` while the `accounts` collection is empty, so writing a
 * contact there would silently promote it to an explicit account nobody asked for).
 *
 * Centralized here rather than duplicated per-file (server.js writes it, scripts/add-account.js
 * writes it, src/notify/notifier.js reads it) so a rename or a validation-rule change can't
 * silently drift between the copies - the same reason src/model/normalizePhone.js exists for
 * phone ("a number that validates for a Person validates identically for a legacy recipient").
 */
const COLLECTION = 'accountContacts';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { COLLECTION, EMAIL_RE };
