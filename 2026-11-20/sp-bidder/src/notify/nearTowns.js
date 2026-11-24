'use strict';
/**
 * NEARBY TOWN -> FR8 HUB, for the FR8 guide line only.
 * FR8 prices a few big hubs; a town next door (Chakan next to Pune) is quoted by FR8 as the hub.
 * When a lane end is one of these towns, the FR8 line uses the hub's rate and shows the real names
 * in brackets, e.g.  FR8 guide (Chakan -> Pune) - ~Rs 24,000.
 *
 * TO EDIT: one line per town, lower case, letters and spaces only (no pincode). The value must be a hub
 * slug that exists in HUB_SLUG (src/notify/rateHints.js). Save, then restart sp-bidder.
 * Left out on purpose (too far or unclear): Hosur, Malur, Dewas, Thane, Aurangabad.
 */
module.exports = {
  // Pune
  chakan: 'pune', pimpri: 'pune', chinchwad: 'pune', 'pimpri chinchwad': 'pune', ranjangaon: 'pune',
  talegaon: 'pune', hinjewadi: 'pune', hinjawadi: 'pune', bhosari: 'pune', wagholi: 'pune',
  sanaswadi: 'pune', shikrapur: 'pune',
  // Ahmedabad
  sanand: 'ahmedabad', changodar: 'ahmedabad', bavla: 'ahmedabad', naroda: 'ahmedabad', vatva: 'ahmedabad',
  odhav: 'ahmedabad', aslali: 'ahmedabad', moraiya: 'ahmedabad', santej: 'ahmedabad', kathwada: 'ahmedabad',
  // Bhiwandi
  padgha: 'bhiwandi', kharbao: 'bhiwandi', anjur: 'bhiwandi', vashind: 'bhiwandi', kasheli: 'bhiwandi',
  // Mumbai
  'navi mumbai': 'mumbai', vashi: 'mumbai', turbhe: 'mumbai', taloja: 'mumbai', panvel: 'mumbai',
  // Delhi / NCR
  bawana: 'delhi', narela: 'delhi', okhla: 'delhi', mundka: 'delhi',
  manesar: 'gurgaon', 'kherki daula': 'gurgaon',
  sahibabad: 'ghaziabad', 'greater noida': 'noida',
  // South
  sriperumbudur: 'chennai', oragadam: 'chennai', ambattur: 'chennai', poonamallee: 'chennai',
  gummidipoondi: 'chennai', irungattukottai: 'chennai', 'maraimalai nagar': 'chennai', 'red hills': 'chennai',
  peenya: 'bangalore', whitefield: 'bangalore', nelamangala: 'bangalore', hoskote: 'bangalore',
  devanahalli: 'bangalore', anekal: 'bangalore', bommasandra: 'bangalore', electronic: 'bangalore',
  jigani: 'bangalore',
  patancheru: 'hyderabad', medchal: 'hyderabad', shamshabad: 'hyderabad', jeedimetla: 'hyderabad',
  pashamylaram: 'hyderabad', bollaram: 'hyderabad', kukatpally: 'hyderabad',
  sulur: 'coimbatore', kuniyamuthur: 'coimbatore',
  nanjangud: 'mysuru', hootagalli: 'mysuru', kadakola: 'mysuru',
  // Central / West / North / East
  pithampur: 'indore', sanwer: 'indore',
  sitapura: 'jaipur', sanganer: 'jaipur', bagru: 'jaipur',
  butibori: 'nagpur', hingna: 'nagpur', kamptee: 'nagpur', mihan: 'nagpur', khapri: 'nagpur',
  savli: 'vadodara', padra: 'vadodara', waghodia: 'vadodara', makarpura: 'vadodara',
  sachin: 'surat', pandesara: 'surat', kadodara: 'surat', hazira: 'surat',
  sinnar: 'nashik', ambad: 'nashik', satpur: 'nashik',
  metoda: 'rajkot', shapar: 'rajkot',
  shiroli: 'kolhapur', 'gokul shirgaon': 'kolhapur',
  howrah: 'kolkata', dankuni: 'kolkata', 'salt lake': 'kolkata', barasat: 'kolkata', sankrail: 'kolkata',
  sahnewal: 'ludhiana', doraha: 'ludhiana',
  danapur: 'patna', 'phulwari sharif': 'patna', bihta: 'patna',
  amausi: 'lucknow', chinhat: 'lucknow',
  panki: 'kanpur', jajmau: 'kanpur',
  siltara: 'raipur', urla: 'raipur', bhanpuri: 'raipur', birgaon: 'raipur',
  ormanjhi: 'ranchi', namkum: 'ranchi',
};
