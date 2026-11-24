'use strict';
/**
 * The ONE sample alert payload shared by the three WhatsApp scripts that render copy:
 * create-wa-templates.js (preview), send-mock-whatsapp.js (real Maytapi send), and
 * verify-whatsapp-setup.js (pre-deploy check). They used to each keep a private copy
 * "in sync manually" - and one drifted to the old field names, silently rendering every
 * field as a dash while still reporting green. Importing this single object is what keeps
 * all three on the current waTemplates field contract.
 *
 * Fields the bidder does not expose to a template (gid, transit, wonRate, inquiryDate,
 * autoExtend) are intentionally blank - as BRL's own template shows them.
 *
 * loadCode/weight/weightUnit/distanceKm/shipmentType/productName/hasPortalComments/
 * hasPortalAttachments ARE on the SP payload (see realAdapter.js) - populated here (not
 * blank) so the preview actually shows the loadDetails()/portalNote() lines rendering.
 * weightUnit deliberately set to 'MT' here (Waaree is an MT branch) - a KG-branch sample
 * would be a better regression fixture for the unit bug; scripts/test-whatsapp.js covers
 * that case directly instead of forking this shared object.
 */
const SAMPLE = {
  // shared
  loadId: '2607061CV2',
  shipper: 'Waaree Energies',
  link: 'https://vps.suyashh.com/price/waaree-energies-8jul-EXAMPLETOKEN', // readable slug + token
  // price_needed ("New enquiry")
  name: '2607061CV2',
  loadCode: '1801',
  from: 'SAMAKHIYALI',
  to: 'M/S WAAREE Energies Limited, Village Degam, Taluka Chikhli, Degam 396521',
  closesText: '06-07-2026 02:02 PM',
  cargo: '1 x 9FT Pickup Truck',
  weight: 7.5,
  weightUnit: 'MT',
  distanceKm: 1051,
  shipmentType: 'FTL',
  productName: 'Solar Modules',
  hasPortalComments: true,
  hasPortalAttachments: true,
  transit: '',
  extraNote: '40FT ODC * 2 VEHICLES',
  quotes: [
    { amount: 16620, rank: 2, at: '17/04/2026 20:24' },
    { amount: 20477, rank: 2, at: '25/02/2026 18:00' },
    { amount: 20268, rank: 3, at: '17/02/2026 22:09' },
  ],
  // price_submitted ("Market Rate Submitted")
  oaNo: '2607061CV2',
  gid: '',
  closingTime: '06-07-2026 02:02 PM',
  route: 'SAMAKHIYALI → M/S WAAREE Energies Limited, Village Degam, Degam 396521',
  cargoQty: '1 x 9FT Pickup Truck',
  enteredTime: '12:11 pm',
  submittedRate: '₹47,000',
  // won / lost money detail (our-side; competitor Won Rate stays blank)
  vehicleType: '1 x 9FT Pickup Truck',
  marketRate: '47,000',
  marginRate: '48,500',
  wonRate: '',
  finalRank: 2,
  attempts: 3,
  marketRateRaw: '47000',
  marginPct: '3.19',
  closeTime: '06-07-2026 02:02 PM',
  inquiryDate: '',
  autoExtend: '',
  // WHO POSTED THE LOAD - renders the won receipt's "Posted by" contact line (the number the desk
  // rings to place the vehicle). Populated here, not blank, for the same reason loadCode/weight
  // above are: a field left off this shared object renders as nothing in all three scripts while
  // they still report green, which is the exact drift the docblock describes. Fictional name and a
  // 9000-prefixed number, in the same spirit as the rest of this sample - never a real contact.
  poster: { name: 'Rakesh Menon', mobile: '9000012345', createdBy: '0' },
  // operational extras (bid_live / outbid / error / test)
  lane: 'Samakhiyali -> Degam',
  price: 48500,
  rank: 2,
  context: 'Samakhiyali -> Degam',
  detail: 'auth_error_mid_auction',
  note: 'You are set to receive bid alerts.',
};

module.exports = { SAMPLE };
