'use strict';
/**
 * LOW-COST GUARD ON THE OPERATOR MARGIN ROUTE - POST /api/price-requests/:id/margin.
 *
 * The desk's public /price submit has refused an implausibly low cost since the Rs 2 fat-finger on
 * load 23189088 (2026-07-16): below config.minPlausibleCost it needs an explicit low_cost_ack. That
 * guard was only ever wired into that one handler.
 *
 * This route is the OTHER cost-entry path and it had no floor at all. `cost` rides its body straight
 * into setBidOverride, whose own check is Rs >= 1, and an armed request then goes through
 * reArmWithNewBand - the same money mutation the desk's re-price performs, rebuilding the whole
 * ladder on a live auction off the new number. So the one path with no plausibility check was the
 * one an operator drives from the console. Nothing sends a cost on it TODAY (the console posts
 * marginsPct + minMarginPct + confirm only), which is precisely why it needed pinning before someone
 * wires a cost field into the margin editor and inherits a hole nobody remembers is there.
 *
 * Guarded with the SAME lowCostNeedsConfirm / lowCostError helpers the /price submit uses, so the two
 * cost-entry paths cannot drift. This file pins: the refusal, that it is a 400 and not a 500 (the
 * error map had no LOW_COST case, so a naive throw would have read as a server fault), that the ack
 * still confirms through exactly as it does on /price, that the armed cost survives a refusal, and
 * that a margin-only call - the only shape in use - is completely untouched.
 *
 *   node scripts/test-margin-route-cost-floor.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';        // this test is about the cost guard, not close-scope
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_PLAUSIBLE_COST = '500';   // pin the soft threshold this route now honours
// This process's own knobs stay at 0 - config.js otherwise defaults SP_MIN_COST_ABS/PER_KM to
// 5000/10 (see src/config.js), which would silently reshape every "soft-only" case below (Parts
// 1-7, written before the hard band was armed on this route) into hard-band refusals with a
// different message. Pinning both to 0 here is the "knobs at 0 -> pre-#93 behavior" baseline: this
// whole file, at this env, is that pin. Part 8 below spawns fresh child processes with the hard
// knobs ACTIVE to test the newly-armed band, since config reads env once at require time.
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
delete process.env.SP_ADMIN_PASS_HASH;       // auth off - this is about the guard, not the login gate
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-margin-floor-'));

const http = require('http');
const { spawnSync } = require('child_process');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    // The /api surface refuses a cross-site POST outright ("missing origin"), so an API call has to
    // carry the same-origin header a browser would send. The public /price form post does not.
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
// minimum 4 sits under the 6.3% house minimum, so the route needs the desk's confirmation (M0-F2).
const BAND = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 4, below_min_ack: '1' };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id, over = {}) => ({
    id, lane: { origin: 'Govindgarh', destination: 'Vadodara' }, equipment: 'Dala Body LPT 14Ft', units: 1,
    quoteType: 'FTL', companyName: 'Waaree', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live', ...over,
  });
  // Arms a fresh request at a normal cost through the desk's own capture route, so every case below
  // starts from a real armed load rather than a hand-built document.
  const armed = async (id, cost = 22000) => {
    const r = await requests.createForLoad(mkLoad(id));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: String(cost) }), contentType: 'application/x-www-form-urlencoded' });
    if (res.status !== 200) throw new Error(`setup failed to arm ${id}: HTTP ${res.status}`);
    return r;
  };
  const margin = (id, body) => req('POST', `${base}/api/price-requests/${id}/margin`, { body: JSON.stringify(body), origin: base });

  console.log('\n1. an implausibly low cost on the margin route is REFUSED (it used to sail through)');

  {
    const r = await armed('MR-1');
    const res = await margin(r.id, { ...BAND, cost: 2, confirm: true });
    ok(res.status === 400, 'margin route: a Rs 2 cost is refused with 400');
    ok(res.status !== 500, 'margin route: the refusal is NOT a 500 - the error map carries a LOW_COST case');
    ok(res.json && /unusually low/i.test(res.json.error || ''),
      'margin route: the refusal reuses the /price wording, so the two paths say the same thing');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 22000, 'margin route: the refused Rs 2 left the armed Rs 22,000 intact');
    ok(after.marginSource !== 'bid', 'margin route: a refused call saves NO part of the override');
  }

  console.log('\n2. the ack confirms through, exactly as it does on the /price submit');

  {
    const r = await armed('MR-2');
    const res = await margin(r.id, { ...BAND, cost: 2, low_cost_ack: '1', confirm: true });
    ok(res.status === 200, 'margin route: Rs 2 WITH low_cost_ack is accepted (soft guard, not a hard floor)');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 2, 'margin route: the acked cost was actually written');
  }

  console.log('\n3. a margin-only call - the only shape in use today - is untouched');

  {
    const r = await armed('MR-3');
    const res = await margin(r.id, { ...BAND, confirm: true });
    ok(res.status === 200, 'margin route: a margin-only call (no cost in the body) still succeeds');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 22000, 'margin route: a margin-only call leaves the captured cost alone');
    ok(after.marginSource === 'bid', 'margin route: the margin override was saved');
  }
  // An explicit null must behave like an absent cost, not like Number(null) === 0 (which would be
  // below the floor and would refuse a legitimate margin-only call).
  {
    const r = await armed('MR-3b');
    const res = await margin(r.id, { ...BAND, cost: null, confirm: true });
    ok(res.status === 200, 'margin route: an explicit cost:null is treated as "no cost", not as Rs 0');
  }

  console.log('\n4. a legitimate cost still re-prices');

  {
    const r = await armed('MR-4');
    const res = await margin(r.id, { ...BAND, cost: 18000, confirm: true });
    ok(res.status === 200, 'margin route: a normal Rs 18,000 re-price goes through');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 18000, 'margin route: the legitimate cost was stored');
  }
  // Exactly at the threshold is accepted - the floor is inclusive, same as /price.
  {
    const r = await armed('MR-4b');
    const res = await margin(r.id, { ...BAND, cost: 500, confirm: true });
    ok(res.status === 200, 'margin route: exactly Rs 500 (at the floor) is accepted - the floor is inclusive');
  }

  console.log('\n5. the guard did not reorder the route (the armed-confirm gate still fires first)');

  {
    const r = await armed('MR-5');
    const res = await margin(r.id, { ...BAND, cost: 2 });   // armed, no confirm
    ok(res.status === 428 && res.json && res.json.needConfirm === true,
      'margin route: an armed load without confirm still gets 428 BEFORE any cost check');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 22000, 'margin route: the unconfirmed call changed nothing');
  }

  console.log('\n6. an AWAITING request: margins ride through, and a bogus cost is still refused');

  {
    const r = await requests.createForLoad(mkLoad('MR-6'));
    const res = await margin(r.id, { ...BAND });
    ok(res.status === 200, 'margin route: an awaiting request takes a margin override with no confirm');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price' && after.marginSource === 'bid',
      'margin route: the awaiting request kept its status and carries the override');
  }
  // setBidOverride only WRITES a cost on an armed request, so a low cost here would have been
  // silently dropped. Refuse it anyway: silently discarding a number an operator typed is the exact
  // failure this codebase has been burned by, and the guard should not depend on which status
  // happens to persist the field today.
  {
    const r = await requests.createForLoad(mkLoad('MR-6b'));
    const res = await margin(r.id, { ...BAND, cost: 2 });
    ok(res.status === 400, 'margin route: a Rs 2 on an AWAITING request is refused, not silently ignored');
    const after = await requests.getByToken(r.id);
    ok(after.marginSource !== 'bid', 'margin route: that refusal saved no margin override either');
  }

  console.log('\n7. margin/clear carries no cost and must stay completely unaffected');

  {
    const r = await armed('MR-7');
    await margin(r.id, { ...BAND, confirm: true });
    const res = await req('POST', `${base}/api/price-requests/${r.id}/margin/clear`, { body: JSON.stringify({ confirm: true }), origin: base });
    ok(res.status === 200, 'margin/clear: unaffected by the cost guard (it never carries a cost)');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 22000, 'margin/clear: the captured cost is untouched');
  }

  server.close();

  // ------------------------------------------------------------------------------------------------
  // PART 8 - the HARD band, now armed on this route (the #93 -> #99 follow-up). Everything above ran
  // with SP_MIN_COST_ABS/PER_KM pinned to 0 (see top of file) - that IS the "knobs at 0 -> pre-#93
  // behavior" case: soft guard only, ack bypasses it, byte-for-byte what Parts 1-7 already pin. This
  // part needs the knobs ACTIVE, which config.js only reads at require time, so - same technique as
  // test-desk-cost-floor.js Part 14 - each case spawns a fresh child process with its own env.
  // ------------------------------------------------------------------------------------------------
  console.log('\n8. the HARD band, now armed on the margin route');

  const CHILD = `
const os=require('os'),fs=require('fs'),path=require('path'),http=require('http');
process.env.PLATFORM='mock';process.env.STORE_BACKEND='memory';process.env.SP_HARD_CLOSE_ONLY='0';
process.env.SP_NOTIFY_MODE='dashboard';process.env.SP_MIN_PLAUSIBLE_COST='500';
process.env.SP_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sp-margin-floor-child-'));
const {app,requests,store}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'web', 'server.js'))});
const cfg=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
const {redactToken}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'util', 'redactToken.js'))});
function reqHttp(base,method,pathname,body,contentType){return new Promise(function(res,rej){
  const u=new URL(base+pathname);
  const headers={};
  if(body!=null){headers['content-type']=contentType;headers['content-length']=Buffer.byteLength(body);}
  headers.origin=base;
  const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:method,headers:headers},
    (rs)=>{let t='';rs.on('data',d=>t+=d);rs.on('end',()=>{let j=null;try{j=JSON.parse(t);}catch(e){}res({status:rs.statusCode,text:t,json:j});});});
  r.on('error',rej);if(body!=null)r.write(body);r.end();});}
const form=(o)=>Object.entries(o).map(function(e){return encodeURIComponent(e[0])+'='+encodeURIComponent(e[1]);}).join('&');
const BAND={marginsPct:[12.6,7.2,6.3],minMarginPct:4,below_min_ack:'1'};
(async()=>{
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const now=Date.now();
  const mk=(id,over)=>Object.assign({id:id,lane:{origin:'Govindgarh',destination:'Vadodara'},equipment:'Dala Body LPT 14Ft',units:1,
    quoteType:'FTL',companyName:'Waaree',closesAt:now+20*60000,startsAt:now-60000,
    softClose:false,closeModelKnown:true,status:'live'},over||{});
  const armed=async(id,over)=>{
    const r=await requests.createForLoad(mk(id,over));
    const res=await reqHttp(base,'POST','/price/'+r.id,form({cost:'22000'}),'application/x-www-form-urlencoded');
    if(res.status!==200)throw new Error('setup failed to arm '+id+': HTTP '+res.status);
    return r;};
  const margin=(id,body)=>reqHttp(base,'POST','/api/price-requests/'+id+'/margin',JSON.stringify(body),'application/json');
  const out={abs:cfg.minCostAbs,perKm:cfg.minCostPerKm};

  // A: below the hard floor, WITH low_cost_ack AND confirm - the hard band ignores the ack (same as /price).
  const a=await armed('CH-A');
  const resA=await margin(a.id,Object.assign({},BAND,{cost:1500,low_cost_ack:'1',confirm:true}));
  out.hardWithAckStatus=resA.status;
  out.hardWithAckMsg=(resA.json&&resA.json.error)||'';
  const afterA=await requests.getByToken(a.id);
  out.hardWithAckCostUnchanged=afterA.price.cost===22000;

  // B: same cost/load via the /price re-price submit (the capture path), for a direct status+message
  // comparison - "behaves like the capture path" means these two must match.
  const b=await armed('CH-B');
  const priceRes=await reqHttp(base,'POST','/price/'+b.id,JSON.stringify({cost:'1500',m_0:'12.6',m_1:'7.2',m_2:'6.3'}),'application/json');
  const marginRes=await margin(b.id,Object.assign({},BAND,{cost:1500,confirm:true}));
  out.priceStatus=priceRes.status;
  out.marginStatus=marginRes.status;
  out.priceMsg=(priceRes.json&&priceRes.json.error)||priceRes.text;
  out.marginMsg=(marginRes.json&&marginRes.json.error)||'';

  // C: margin-only call (no cost) - must stay untouched with the hard knobs active.
  const c=await armed('CH-C');
  const resC=await margin(c.id,Object.assign({},BAND,{confirm:true}));
  out.marginOnlyStatus=resC.status;

  // D: exactly at the floor - inclusive, same as /price.
  const d=await armed('CH-D');
  const resD=await margin(d.id,Object.assign({},BAND,{cost:5000,confirm:true}));
  out.atFloorStatus=resD.status;

  // E: a legitimate cost still re-prices and is actually stored.
  const e=await armed('CH-E');
  const resE=await margin(e.id,Object.assign({},BAND,{cost:18000,confirm:true}));
  out.aboveFloorStatus=resE.status;
  const afterE=await requests.getByToken(e.id);
  out.aboveFloorCost=afterE.price.cost;

  // F: the refusal RECORD this seam leaves. costFloorRefused is a two-writer stream now, so the record
  // has to say WHICH seam refused and WHO drove it (this route is behind the /api session gate, unlike
  // the two /price call sites) - and it must not carry the price-request capability token whole.
  const f=await armed('CH-F');
  const beforeF=(await store.readEvents('costFloorRefused')).length;
  await margin(f.id,Object.assign({},BAND,{cost:1500,low_cost_ack:'1',confirm:true}));
  const evs=await store.readEvents('costFloorRefused');
  out.refusalAppended=evs.length-beforeF;
  const rec=evs[evs.length-1]||{};
  out.recLoadId=rec.loadId;
  out.recSource=rec.source;
  out.recActor=rec.actor;
  out.recRequestId=rec.requestId;
  out.recExpectRequestId=redactToken(f.id);
  out.recCarriesWholeToken=JSON.stringify(rec).indexOf(f.id)>=0;

  server.close();
  process.stdout.write('<<RESULT>>'+JSON.stringify(out)+'<</RESULT>>');
})().catch(e=>{console.error(e);process.exit(1);});
`;
  function child(env) {
    const e = Object.assign({}, process.env, env);
    delete e.SP_DATA_DIR;
    const r = spawnSync(process.execPath, ['-e', CHILD], { env: e, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error('child failed: ' + (r.stderr || '').slice(0, 800));
    const m = /<<RESULT>>([\s\S]*?)<<\/RESULT>>/.exec(String(r.stdout));
    if (!m) throw new Error('child emitted no result payload; stdout tail=' + String(r.stdout).slice(-400));
    return JSON.parse(m[1]);
  }

  {
    const c = child({ SP_MIN_COST_ABS: '5000', SP_MIN_COST_PER_KM: '10' });
    ok(c.abs === 5000 && c.perKm === 10, 'hard-armed: config carries the shipped defaults 5000/10');

    ok(c.hardWithAckStatus === 400, 'margin route: Rs 1,500 WITH low_cost_ack AND confirm is STILL refused (hard band ignores the ack)');
    ok(!/unusually low/i.test(c.hardWithAckMsg), 'margin route: the refusal is the HARD message, not the soft "unusually low" one');
    ok(/too low for this load/i.test(c.hardWithAckMsg) && /missing digit/i.test(c.hardWithAckMsg),
      'margin route: the hard refusal names the clerical-error wording (same as /price)');
    ok(c.hardWithAckCostUnchanged, 'margin route: the refused Rs 1,500 left the armed Rs 22,000 intact');

    ok(c.priceStatus === 400 && c.marginStatus === 400, 'margin route: Rs 1,500 (between the hard and soft bands) is refused on BOTH seams');
    ok(/too low for this load/i.test(c.priceMsg) && /too low for this load/i.test(c.marginMsg),
      'margin route: the capture path and the margin route give the SAME hard-band wording for the same cost');

    ok(c.marginOnlyStatus === 200, 'margin route: a margin-only call (no cost) is untouched even with the hard knobs active');

    ok(c.atFloorStatus === 200, 'margin route: exactly Rs 5,000 (at the hard floor) is accepted - inclusive, same as /price');

    ok(c.aboveFloorStatus === 200 && c.aboveFloorCost === 18000, 'margin route: a legitimate Rs 18,000 re-price still goes through and is stored');

    // The refusal record on the authenticated seam (case F).
    ok(c.refusalAppended === 1 && c.recLoadId === 'CH-F', 'margin route: the refusal appended exactly one costFloorRefused record for this load');
    ok(c.recSource === 'margin-route', 'margin route: the record names THIS seam - a two-writer stream that cannot be split by seam is just a count');
    // Auth is off in this harness so currentAdmin resolves to the built-in 'dev' identity; with
    // SP_ADMIN_PASS_HASH set on a real box this is the logged-in operator's username. The load-bearing
    // half is that it is NOT the anonymous 'pricing' label the public /price seam records.
    ok(c.recActor === 'dev' && c.recActor !== 'pricing', 'margin route: the record carries the session identity, not the anonymous /price label');

    // SECURITY: reqDoc.id IS the capability token that authenticates the public /price/<token> page -
    // anyone reading this record whole could arm a live-money bid with no session. The stream is
    // appended to disk under data/logs and rides into backups. Asserted on the serialized record so a
    // future field re-adding the token whole fails here too.
    ok(c.recCarriesWholeToken === false, 'margin route: the FULL capability token appears NOWHERE in the refusal record');
    ok(c.recRequestId === c.recExpectRequestId, 'margin route: requestId is the redactToken() prefix, the house idiom for every token sink');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
