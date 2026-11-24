'use strict';
/**
 * PINNED FIXTURE - the shape of Maytapi's `GET /getGroups` (list) response, as the daily
 * group-settings tripwire (src/notify/whatsapp.js getGroups + src/notify/heartbeat.js
 * collectMembership) assumes it. The tripwire rests entirely on THREE assumptions this fixture
 * pins so a wrong-shape assumption fails a test instead of firing a false "attention" DM to the
 * director on the very first live heartbeat:
 *   1. admin status is a TOP-LEVEL `admins[]` per group (NOT an inline `participants[i].admin` flag);
 *   2. `config.membersCanAddMembers` is a real BOOLEAN (WhatsApp's "who can add members" toggle);
 *   3. participant / admin ids are `<msisdn>@c.us` JID strings (and, across Maytapi versions, may
 *      also arrive as `{ id, admin }` objects - both must normalize to the same bare string).
 *
 * SANITIZED. The STRUCTURE, field names, value types, and id format are verbatim from a real,
 * read-only `getGroups` capture (live-verified 2026-07-21; see the group-control capability research
 * doc). Every phone number and group name has been replaced with an obviously-fake test value
 * (91900000000X mobiles, "Test Bids - <fake co>"); no real customer number or group name is present.
 * The two groups below are both in the desired COMPLIANT state (membersCanAddMembers:false, a full
 * top-level admins list) - the first with string-JID participants/admins, the second with the
 * object-shape variant - so the fixture exercises both wire shapes the wrapper normalizes.
 */
module.exports = {
  success: true,
  data: [
    {
      id: '120363000000000001@g.us',
      name: 'Test Bids - Acme',
      participants: [
        '919000000001@c.us',
        '919000000002@c.us',
        '919000000003@c.us',
        '919000000004@c.us',
        '919000000009@c.us',
      ],
      admins: [
        '919000000001@c.us',
        '919000000002@c.us',
        '919000000003@c.us',
        '919000000004@c.us',
      ],
      config: {
        edit: 'all',
        send: 'all',
        disappear: false,
        membersCanAddMembers: false,
        approveNewMembers: false,
      },
    },
    {
      id: '120363000000000002@g.us',
      name: 'Test Bids - Globex',
      participants: [
        { id: '919000000001@c.us', admin: true },
        { id: '919000000002@c.us', admin: true },
        { id: '919000000005@c.us', admin: false },
      ],
      admins: [
        { id: '919000000001@c.us', admin: true },
        { id: '919000000002@c.us', admin: true },
      ],
      config: {
        edit: 'all',
        send: 'all',
        disappear: false,
        membersCanAddMembers: false,
        approveNewMembers: false,
      },
    },
  ],
};
