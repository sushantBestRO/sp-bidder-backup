'use strict';
/**
 * Preview the WhatsApp alert messages the bidder sends.
 *
 * NOTE: this used to print DoubleTick templates for Meta/WABA approval. The bidder
 * now sends via Maytapi (BRL's provider), which needs NO template approval - we
 * render the full text and send it as-is. So there is nothing to register; this
 * just renders each kind with sample data so you can eyeball the copy.
 *
 * Usage: node scripts/create-wa-templates.js
 */

const { MESSAGES, renderMessage } = require('../src/notify/waTemplates');
const { SAMPLE } = require('./sample-alert-data');

console.log('SuperProcure bidder - WhatsApp alert messages (Maytapi, sent as plain text)\n');
for (const m of MESSAGES) {
  console.log('-'.repeat(60));
  console.log(`kind: ${m.kind}`);
  console.log(renderMessage(m.kind, SAMPLE));
}
console.log('-'.repeat(60));
console.log('\nNo approval step: set SP_WHATSAPP_ENABLED=1 + SP_MAYTAPI_TOKEN / SP_MAYTAPI_PRODUCT_ID /');
console.log("SP_MAYTAPI_PHONE_ID in .env, then set notifyMode='whatsapp' (Settings or SP_NOTIFY_MODE=whatsapp).");
