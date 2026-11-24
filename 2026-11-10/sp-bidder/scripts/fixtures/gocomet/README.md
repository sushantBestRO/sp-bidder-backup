# GoComet captured-response fixtures

Real responses from `enquiry.gocomet.com`, captured read-only on **2026-08-11 ~10:40 IST**
(`2026-08-11T05:10Z`) against live enquiry **`2608115VVB`** (Waaree Energies Ltd., Degam GJ ->
Kottayam KL, close 11:30 IST). Nothing here is hand-written.

These exist because GoComet publishes no spec. Per `docs/MULTI_PLATFORM_ARCHITECTURE.md`
("Integrating a portal with no specification"), **fixtures are the contract**: the adapter is
tested against captured real responses, and a fixture test failing is the only early warning
available when the portal changes shape.

| File | Endpoint |
|---|---|
| `spot-enquiries.list.json` | `GET /api/v1/vendor/enquiries/spot?page=1&size=30&reset_filter=false&filter[enquiry_type]=spot` |
| `enquiry-detail.json` | `GET /api/v1/vendor/enquiries/2608115VVB` |
| `bidding-data.json` | `GET /api/v1/vendor/enquiries/2608115VVB/bidding-data` |

`scripts/test-gocomet-live-fixture-flow.js` drives the real adapter against all three.

## What was redacted, and why

Only response BODIES were captured - no request headers, so no `authorization`, no cookie and no
token appears in any file. Two further removals were necessary:

- **`created_by` (dropped whole, in `enquiry-detail.json`).** GoComet serves the SHIPPER's own
  staff user record to an unrelated vendor account, including
  `created_by.password_digest` - a 40-hex credential hash - plus that person's email, phone,
  employee id and permission map. The adapter's `ENQUIRY_DETAIL_FIELDS` allowlist exists for
  exactly this reason; this capture re-confirms the leak is still live on a fourth enquiry.
- **`client_group` (dropped whole, in `enquiry-detail.json`).** A second 30-key shipper config
  blob carrying company ids. Not adapter-relevant.

Both are replaced by `{"_redacted": "..."}` rather than deleted, so the KEY still exists and a
shape assertion over the top-level key set stays honest. Everything else is byte-faithful,
including fields the adapter ignores - that is the point.

Re-capturing: scrub with the same rule (drop `created_by` / `client_group` whole; redact any key
matching `password|digest|token|secret|email|phone|authorization|cookie`) and re-run the residual
scan for 40-hex digests, JWTs, emails and Indian mobile numbers before committing.
