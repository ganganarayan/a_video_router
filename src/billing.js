import { pool, query, getConfigMap, setConfigValue } from './db.js';
import { encrypt, decrypt } from './lib/secrets.js';
import { log } from './lib/logger.js';
import { createOrder, verifyPaymentSignature, verifyWebhookSignature } from './providers/razorpay.js';

// ---------- config (global platform-level, in app_config) ----------

export const PROVIDERS = ['razorpay', 'easebuzz', 'phonepe'];
// Providers with a working adapter today. Easebuzz/PhonePe schema + credential
// storage exist now; their adapters land when those accounts activate.
export const LIVE_PROVIDERS = ['razorpay'];

export async function getBillingConfig() {
  const c = await getConfigMap();
  const provider = PROVIDERS.includes(c.payment_provider) ? c.payment_provider : 'razorpay';
  return {
    provider,
    pricePerUnitPaise: Number(c.price_per_unit_paise) || 5000,   // ₹50
    unitBytes: Number(c.unit_bytes) || 1073741824,               // 1 GiB
    gstPercent: Number(c.gst_percent) || 18,
    gatewayPercent: Number(c.gateway_percent) || 2.5,
    minTopupPaise: Number(c.min_topup_paise) || 50000,           // ₹500
    razorpayKeyId: c.razorpay_key_id || '',
    razorpayKeySecret: decrypt(c.razorpay_key_secret || '') || '',
    razorpayWebhookSecret: decrypt(c.razorpay_webhook_secret || '') || '',
  };
}

export async function setPaymentProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown payment provider.');
  await setConfigValue('payment_provider', provider);
}

export async function saveRazorpayKeys({ keyId, keySecret, webhookSecret }) {
  if (keyId !== undefined) await setConfigValue('razorpay_key_id', String(keyId).trim());
  if (keySecret) await setConfigValue('razorpay_key_secret', encrypt(String(keySecret).trim()));
  if (webhookSecret) await setConfigValue('razorpay_webhook_secret', encrypt(String(webhookSecret).trim()));
}

export async function razorpayConfigured() {
  const c = await getBillingConfig();
  return Boolean(c.razorpayKeyId && c.razorpayKeySecret);
}

// ---------- wallet reads ----------

export async function getWallet(tenantId) {
  const { rows } = await query('SELECT * FROM wallets WHERE tenant_id = $1', [tenantId]);
  return rows[0] || null;
}

export async function history(tenantId, limit = 100) {
  const { rows } = await query(
    'SELECT * FROM wallet_txns WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2',
    [tenantId, Math.min(limit, 500)],
  );
  return rows;
}

export function computeUnits(sizeBytes, unitBytes) {
  return Number(sizeBytes) > Number(unitBytes) ? 2 : 1;
}

// ---------- pre-push gate ----------
// Strict: a NEW push is allowed only when the tenant is unlimited, still has the
// free upload, or has a positive balance. The size (units) isn't known yet, so
// this only gates entry — the last upload is allowed to finish and go negative.
// Pure so every branch is unit-testable without a live wallet.
export function pushDecision(wallet) {
  if (!wallet) return { allowed: false, reason: 'No wallet for this tenant.' };
  if (wallet.unlimited) return { allowed: true, unlimited: true };
  if (!wallet.free_upload_used) return { allowed: true, freeAvailable: true };
  if (Number(wallet.balance_paise) > 0) return { allowed: true, balance: Number(wallet.balance_paise) };
  return { allowed: false, reason: 'Wallet balance is empty — top up to push more videos.', balance: Number(wallet.balance_paise) };
}

export async function canPush(tenantId) {
  return pushDecision(await getWallet(tenantId));
}

// ---------- deduction (runtime, by actual size; never blocks; may go negative) ----------
export async function deductForUpload(tenantId, recordingId, sizeBytes) {
  const cfg = await getBillingConfig();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM wallets WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    const w = rows[0];
    if (!w) { await client.query('ROLLBACK'); return { charged: 0, skipped: 'no wallet' }; }
    if (w.unlimited) { await client.query('COMMIT'); return { charged: 0, unlimited: true }; }

    const units = computeUnits(sizeBytes, cfg.unitBytes);
    let freeApplied = 0;
    if (!w.free_upload_used) freeApplied = Math.min(units, 1); // first upload: free covers ≤1 unit
    const chargeableUnits = units - freeApplied;
    const cost = chargeableUnits * cfg.pricePerUnitPaise;
    const newBalance = Number(w.balance_paise) - cost;

    await client.query(
      'UPDATE wallets SET balance_paise = $1, free_upload_used = true, updated_at = now() WHERE tenant_id = $2',
      [newBalance, tenantId],
    );
    await client.query(
      `INSERT INTO wallet_txns (tenant_id, type, amount_paise, balance_after_paise, units, recording_id, note)
       VALUES ($1, 'deduction', $2, $3, $4, $5, $6)`,
      [tenantId, -cost, newBalance, units, recordingId,
        freeApplied ? `free first upload (${freeApplied} unit free)` : `${chargeableUnits} unit(s)`],
    );
    await client.query('COMMIT');
    log(`billing: tenant ${tenantId} charged ${cost} paise (${units} unit(s), free ${freeApplied}) -> balance ${newBalance}`);
    return { charged: cost, units, freeApplied, newBalance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- top-up (Razorpay order) ----------

export function topupBreakdown(baseP, cfg) {
  const gst = Math.round(baseP * cfg.gstPercent / 100);
  const fee = Math.round((baseP + gst) * cfg.gatewayPercent / 100);
  return { base: baseP, gst, fee, total: baseP + gst + fee };
}

// ---------- descending pack pricing (single source of truth) ----------
// Larger packs bill at a lower per-unit rate. The discount is delivered as bonus
// wallet credit: you always RECEIVE units × base rate (₹50) of credit, but you PAY
// the tiered charge rate. So per-upload deduction (fixed ₹50/unit) never changes.
// chargePerUnitPaise: null = use the configured base rate (cfg.pricePerUnitPaise).
export const PACK_TIERS = [
  { minUnits: 100, chargePerUnitPaise: 4000 }, // ₹40/unit for 100+ units
  { minUnits: 50, chargePerUnitPaise: 4500 },  // ₹45/unit for 50–99 units
  { minUnits: 0, chargePerUnitPaise: null },   // base rate (₹50) below 50
];
export const PACK_PRESETS = [10, 50, 100];
export const UNITS_STEP = 10; // packs are sold in multiples of this

export function packRatePaise(units, cfg) {
  const tier = PACK_TIERS.find((t) => units >= t.minUnits);
  return tier.chargePerUnitPaise ?? cfg.pricePerUnitPaise;
}

// Full quote for buying `units`: what's charged (base+GST+fee) vs what's credited.
export function packQuote(units, cfg) {
  const u = Math.max(0, Math.round(Number(units) || 0));
  const rate = packRatePaise(u, cfg);
  const creditPaise = u * cfg.pricePerUnitPaise; // face value credited to the wallet
  const bd = topupBreakdown(u * rate, cfg);      // GST + gateway on the (discounted) charge base
  return {
    units: u,
    ratePerUnitPaise: rate,
    creditPaise,
    bonusPaise: creditPaise - bd.base,
    base: bd.base, gst: bd.gst, fee: bd.fee, total: bd.total,
  };
}

// Validate a requested unit count (integer, ≥ step, whole multiples of step).
export function validateUnits(units) {
  const u = Number(units);
  if (!Number.isInteger(u) || u < UNITS_STEP || u % UNITS_STEP !== 0) {
    return { ok: false, error: `Buy units in multiples of ${UNITS_STEP} (minimum ${UNITS_STEP}).` };
  }
  return { ok: true, units: u };
}

export async function createTopup(tenantId, units, extra = {}) {
  const cfg = await getBillingConfig();
  const v = validateUnits(units);
  if (!v.ok) throw new Error(v.error);
  // Tiered quote: customer pays q.total (on the discounted charge base); the wallet
  // is credited q.creditPaise (full face value) once the payment is captured.
  const q = packQuote(v.units, cfg);
  const merchantTxnId = `vr_${tenantId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Notes ride along on the Razorpay order/payment. The optional GSTIN + business
  // name are recorded here so Razorpay can raise a GST invoice for the customer.
  const notes = {
    tenant_id: String(tenantId), units: String(q.units),
    base_paise: String(q.base), credit_paise: String(q.creditPaise), merchant_txn_id: merchantTxnId,
  };
  if (extra.gstin) notes.gstin = extra.gstin;
  if (extra.businessName) notes.business_name = extra.businessName;
  if (extra.email) notes.email = extra.email;

  if (cfg.provider === 'razorpay') {
    if (!cfg.razorpayKeyId || !cfg.razorpayKeySecret) throw new Error('Razorpay is not configured yet.');
    const order = await createOrder(
      { keyId: cfg.razorpayKeyId, keySecret: cfg.razorpayKeySecret },
      q.total,
      notes,
    );
    await query(
      `INSERT INTO payments (tenant_id, provider, merchant_txn_id, provider_order_id, razorpay_order_id,
                             base_paise, gst_paise, fee_paise, total_paise, credit_paise, units, status, notes)
       VALUES ($1, 'razorpay', $2, $3, $3, $4, $5, $6, $7, $8, $9, 'created', $10)`,
      [tenantId, merchantTxnId, order.id, q.base, q.gst, q.fee, q.total, q.creditPaise, q.units,
        JSON.stringify(order.notes || {})],
    );
    // mode 'modal' -> Razorpay Checkout opens in-page (see billing.ejs)
    return {
      mode: 'modal', provider: 'razorpay', orderId: order.id, amount: q.total,
      keyId: cfg.razorpayKeyId, breakdown: q, units: q.units,
      prefill: { email: extra.email || '', name: extra.businessName || '' },
      gstin: extra.gstin || '',
    };
  }

  // Easebuzz / PhonePe: schema + credential storage exist; the hosted-redirect
  // adapters land when those accounts activate.
  throw new Error(`The ${cfg.provider} gateway isn't enabled yet — switch the active gateway to Razorpay on the Admin page.`);
}

// Credit the wallet for a paid order (idempotent). Called from webhook + checkout callback.
async function creditPaidOrder(orderId, paymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE", [orderId],
    );
    const p = rows[0];
    if (!p) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown order' }; }
    if (p.status === 'paid') { await client.query('ROLLBACK'); return { ok: true, already: true }; }
    await client.query(
      "UPDATE payments SET status = 'paid', provider_payment_id = $1, razorpay_payment_id = $1, updated_at = now() WHERE id = $2",
      [paymentId || null, p.id],
    );
    const { rows: wr } = await client.query('SELECT balance_paise FROM wallets WHERE tenant_id = $1 FOR UPDATE', [p.tenant_id]);
    // Credit the face value (credit_paise) so pack discounts arrive as bonus credit.
    // Older orders (pre-migration 009) have no credit_paise → fall back to base_paise (they were 1:1).
    const creditPaise = Number(p.credit_paise ?? p.base_paise);
    const newBalance = Number(wr[0]?.balance_paise || 0) + creditPaise;
    await client.query('UPDATE wallets SET balance_paise = $1, updated_at = now() WHERE tenant_id = $2', [newBalance, p.tenant_id]);
    await client.query(
      `INSERT INTO wallet_txns (tenant_id, type, amount_paise, balance_after_paise, units, payment_id, note)
       VALUES ($1, 'topup', $2, $3, $4, $5, $6)`,
      [p.tenant_id, creditPaise, newBalance, p.units || null, p.id, `top-up (order ${orderId})`],
    );
    await client.query('COMMIT');
    log(`billing: tenant ${p.tenant_id} topped up ${p.base_paise} paise -> balance ${newBalance}`);
    return { ok: true, tenantId: p.tenant_id, newBalance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Verify the in-page Checkout success handler and credit.
export async function confirmCheckout(orderId, paymentId, signature) {
  const cfg = await getBillingConfig();
  if (!verifyPaymentSignature(cfg.razorpayKeySecret, orderId, paymentId, signature)) {
    throw new Error('Payment signature verification failed.');
  }
  return creditPaidOrder(orderId, paymentId);
}

// Verify a Razorpay webhook (raw body) and credit on payment captured.
export async function handleWebhook(rawBody, signature) {
  const cfg = await getBillingConfig();
  if (!cfg.razorpayWebhookSecret) throw new Error('Webhook secret not configured.');
  if (!verifyWebhookSignature(cfg.razorpayWebhookSecret, rawBody, signature)) {
    throw new Error('Webhook signature verification failed.');
  }
  const evt = JSON.parse(rawBody);
  const pe = evt?.payload?.payment?.entity;
  if (evt.event === 'payment.captured' && pe?.order_id) {
    return creditPaidOrder(pe.order_id, pe.id);
  }
  return { ok: true, ignored: evt.event };
}

// ---------- super-admin adjustments ----------

export async function adjustBalance(tenantId, amountPaise, note) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT balance_paise FROM wallets WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if (!rows[0]) { await client.query('ROLLBACK'); throw new Error('no wallet'); }
    const newBalance = Number(rows[0].balance_paise) + Math.round(Number(amountPaise));
    await client.query('UPDATE wallets SET balance_paise = $1, updated_at = now() WHERE tenant_id = $2', [newBalance, tenantId]);
    await client.query(
      `INSERT INTO wallet_txns (tenant_id, type, amount_paise, balance_after_paise, note)
       VALUES ($1, 'adjustment', $2, $3, $4)`,
      [tenantId, Math.round(Number(amountPaise)), newBalance, note || 'super-admin adjustment'],
    );
    await client.query('COMMIT');
    return { newBalance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function setUnlimited(tenantId, unlimited) {
  await query('UPDATE wallets SET unlimited = $1, updated_at = now() WHERE tenant_id = $2', [Boolean(unlimited), tenantId]);
}
