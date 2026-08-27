import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { topupBreakdown, computeUnits, pushDecision, packQuote, packRatePaise, validateUnits, isAlwaysOn } from '../src/billing.js';

const cfg = { gstPercent: 18, gatewayPercent: 2.5 };
const cfgP = { gstPercent: 18, gatewayPercent: 2.5, pricePerUnitPaise: 5000 };

test('top-up breakdown: ₹500 base -> ₹604.75 total (18% GST + 2.5% gateway on base+GST)', () => {
  const bd = topupBreakdown(50000, cfg); // 50000 paise = ₹500
  assert.equal(bd.base, 50000);
  assert.equal(bd.gst, 9000);            // 18% of 500 = ₹90
  assert.equal(bd.fee, 1475);            // 2.5% of (500+90)=₹590 -> ₹14.75
  assert.equal(bd.total, 60475);         // ₹604.75
});

test('top-up breakdown rounds to whole paise', () => {
  const bd = topupBreakdown(70000, cfg); // ₹700
  assert.equal(bd.gst, 12600);           // ₹126
  assert.equal(bd.fee, Math.round((70000 + 12600) * 2.5 / 100)); // 2065
  assert.equal(bd.total, 70000 + bd.gst + bd.fee);
});

test('units: <=1 GiB is 1 unit, over 1 GiB is 2 units', () => {
  const GiB = 1073741824;
  assert.equal(computeUnits(GiB, GiB), 1);        // exactly 1 GiB = 1 unit (not over)
  assert.equal(computeUnits(GiB - 1, GiB), 1);
  assert.equal(computeUnits(GiB + 1, GiB), 2);
  assert.equal(computeUnits(5 * GiB, GiB), 2);    // capped at 2 units
});

test('pack rate: descending by unit count', () => {
  assert.equal(packRatePaise(10, cfgP), 5000);  // ₹50 below 50
  assert.equal(packRatePaise(49, cfgP), 5000);
  assert.equal(packRatePaise(50, cfgP), 4500);  // ₹45 at 50–99
  assert.equal(packRatePaise(99, cfgP), 4500);
  assert.equal(packRatePaise(100, cfgP), 4000); // ₹40 at 100+
  assert.equal(packRatePaise(500, cfgP), 4000);
});

test('pack quote: 10 units — no discount, credit == charge base', () => {
  const q = packQuote(10, cfgP);
  assert.equal(q.ratePerUnitPaise, 5000);
  assert.equal(q.base, 50000);       // ₹500 charged (pre-tax)
  assert.equal(q.creditPaise, 50000); // ₹500 credited
  assert.equal(q.bonusPaise, 0);
  assert.equal(q.total, 60475);      // ₹604.75 incl GST + fee
});

test('pack quote: 50 units — ₹45/unit, discount as bonus credit', () => {
  const q = packQuote(50, cfgP);
  assert.equal(q.ratePerUnitPaise, 4500);
  assert.equal(q.base, 225000);        // ₹2,250 charged
  assert.equal(q.creditPaise, 250000); // ₹2,500 credited (50 uploads at ₹50)
  assert.equal(q.bonusPaise, 25000);   // ₹250 bonus
  assert.equal(q.gst, 40500);
  assert.equal(q.fee, 6638);
  assert.equal(q.total, 272138);
});

test('pack quote: 100 units — ₹40/unit', () => {
  const q = packQuote(100, cfgP);
  assert.equal(q.base, 400000);        // ₹4,000 charged
  assert.equal(q.creditPaise, 500000); // ₹5,000 credited (100 uploads)
  assert.equal(q.bonusPaise, 100000);  // ₹1,000 bonus
  assert.equal(q.total, 483800);
});

test('validateUnits: multiples of 10, min 10', () => {
  assert.equal(validateUnits(10).ok, true);
  assert.equal(validateUnits(50).ok, true);
  assert.equal(validateUnits(5).ok, false);
  assert.equal(validateUnits(15).ok, false);
  assert.equal(validateUnits(0).ok, false);
  assert.equal(validateUnits(10.5).ok, false);
});

test('isAlwaysOn: unlimited or unexpired subscription', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(isAlwaysOn(null), false);
  assert.equal(isAlwaysOn({ unlimited: true }), true);              // comped workspace
  assert.equal(isAlwaysOn({ unlimited: false, always_on_until: future }), true);
  assert.equal(isAlwaysOn({ unlimited: false, always_on_until: past }), false); // lapsed
  assert.equal(isAlwaysOn({ unlimited: false, always_on_until: null }), false);
});

test('push gate: every branch', () => {
  assert.deepEqual(pushDecision(null), { allowed: false, reason: 'No wallet for this tenant.' });
  // unlimited overrides everything, even a negative balance
  assert.equal(pushDecision({ unlimited: true, balance_paise: -9999, free_upload_used: true }).allowed, true);
  // free first upload still available -> allowed regardless of balance
  assert.equal(pushDecision({ unlimited: false, free_upload_used: false, balance_paise: 0 }).allowed, true);
  // positive balance -> allowed
  assert.equal(pushDecision({ unlimited: false, free_upload_used: true, balance_paise: 1 }).allowed, true);
  // strict: exactly zero -> blocked
  assert.equal(pushDecision({ unlimited: false, free_upload_used: true, balance_paise: 0 }).allowed, false);
  // negative -> blocked
  assert.equal(pushDecision({ unlimited: false, free_upload_used: true, balance_paise: -5000 }).allowed, false);
});
