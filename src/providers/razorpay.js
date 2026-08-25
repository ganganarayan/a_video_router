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
