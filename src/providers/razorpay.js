import crypto from 'node:crypto';

// Thin Razorpay REST client — ported from VidaPulse's razorpayService.js but for
// one-time Orders (wallet top-ups) instead of subscriptions, in ESM/fetch. Keys
// are passed in (resolved from platform billing config), never hard-coded.

const API = 'https://api.razorpay.com/v1';

async function razorpayRequest(keyId, keySecret, method, path, body) {
  if (!keyId || !keySecret) throw new Error('Razorpay keys are not configured.');
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.error?.description || json?.error?.code || `HTTP ${res.status}`;
    throw new Error(`Razorpay API error (${res.status}): ${msg}`);
  }
  return json;
}

// Create a one-time Order for a wallet top-up. amountPaise is the TOTAL charged.
export function createOrder(keys, amountPaise, notes) {
  return razorpayRequest(keys.keyId, keys.keySecret, 'POST', '/orders', {
    amount: amountPaise,
    currency: 'INR',
    notes: notes || {},
    payment_capture: 1,
  });
}

// Verify the Checkout handler signature: HMAC_SHA256(order_id|payment_id, key_secret).
export function verifyPaymentSignature(keySecret, orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`).digest('hex');
  return timingSafeEqual(expected, signature);
}

// ---------- subscriptions (Always-On recurring tier) ----------

// Create a recurring subscription against a dashboard-created plan. total_count is
// the max number of billing cycles (120 months ~= open-ended monthly); the customer
// authorises a mandate at Checkout, then Razorpay auto-charges each cycle.
export function createSubscription(keys, { planId, totalCount = 120, notes }) {
  return razorpayRequest(keys.keyId, keys.keySecret, 'POST', '/subscriptions', {
    plan_id: planId,
    total_count: totalCount,
    customer_notify: 1,
    notes: notes || {},
  });
}

export function fetchSubscription(keys, subId) {
  return razorpayRequest(keys.keyId, keys.keySecret, 'GET', `/subscriptions/${subId}`);
}

// Cancel a subscription. cancelAtCycleEnd=true lets the paid period run out first.
export function cancelSubscription(keys, subId, cancelAtCycleEnd = true) {
  return razorpayRequest(keys.keyId, keys.keySecret, 'POST', `/subscriptions/${subId}/cancel`, {
    cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0,
  });
}

// Verify the subscription Checkout handler signature.
// For subscriptions Razorpay signs HMAC_SHA256(payment_id + '|' + subscription_id).
export function verifySubscriptionSignature(keySecret, subscriptionId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', keySecret)
    .update(`${paymentId}|${subscriptionId}`).digest('hex');
  return timingSafeEqual(expected, signature);
}

// Verify a webhook: HMAC_SHA256(rawBody, webhook_secret) == X-Razorpay-Signature.
export function verifyWebhookSignature(webhookSecret, rawBody, signature) {
  const expected = crypto.createHmac('sha256', webhookSecret)
    .update(rawBody).digest('hex');
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
