// Public policy/legal pages, served at /privacy, /terms, /refund, /shipping, /contact.
// Content only — the layout lives in views/legal.ejs. Plain factual policy text; update the
// company/contact details here in one place.

export const COMPANY = 'Divine Leads';
export const PRODUCT = 'AVideoRouter';
export const SUPPORT_EMAIL = 'connect@divineleads.guru';
export const SUPPORT_WHATSAPP = '+91 93568 19176';
export const SUPPORT_WHATSAPP_LINK = 'https://wa.me/919356819176';
export const LAST_UPDATED = '27 August 2026';

// Order controls the footer link order.
export const LEGAL_ORDER = ['privacy', 'terms', 'refund', 'shipping', 'contact'];

export const LEGAL = {
  privacy: {
    title: 'Privacy Policy',
    html: `
      <p>${PRODUCT} is operated by ${COMPANY}. This policy explains what we collect and why.</p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Account details</b> — your name and email address, used to sign you in and identify your workspace.</li>
        <li><b>Connected-service credentials</b> — the API keys and OAuth tokens you enter to connect Zoom,
          Fathom, YouTube/Google and your LMS. These are stored <b>encrypted</b> (AES-256-GCM) and are used
          only to move your recordings on your behalf.</li>
        <li><b>Recording metadata</b> — titles, timestamps, durations, file sizes and the resulting
          YouTube/LMS links, so we can route, log and display your transfers.</li>
        <li><b>Billing information</b> — wallet balance and transaction history. Card/UPI payment details are
          entered directly with our payment gateway and are <b>never</b> stored on our servers.</li>
      </ul>

      <h2>How we use it</h2>
      <p>Solely to provide the service: downloading your recordings from the source you connected and uploading
      them to the destinations you chose, on the schedule you set, plus billing and support. We do not sell your
      data or use your recordings for any purpose other than routing them where you direct.</p>

      <h2>Third parties</h2>
      <p>To perform the service we exchange data with the providers you connect — <b>Zoom</b>, <b>Fathom</b>,
      <b>Google/YouTube</b> and your <b>LMS</b> — and with our payment gateway for top-ups. Each is governed by
      its own privacy policy.</p>

      <h2>Retention &amp; security</h2>
      <p>Video files are downloaded to temporary storage only for the duration of a transfer and deleted after a
      successful upload; we do not keep copies of your videos. Credentials and metadata are retained while your
      account is active. Credentials are encrypted at rest; access is restricted to your workspace.</p>

      <h2>Your choices</h2>
      <p>You can disconnect any service or remove stored credentials at any time from the Connections page. To
      close your account or request deletion of your data, contact us (see the Contact page).</p>`,
  },

  terms: {
    title: 'Terms of Service',
    html: `
      <p>These terms govern your use of ${PRODUCT}, operated by ${COMPANY}. By using the service you agree to them.</p>

      <h2>The service</h2>
      <p>${PRODUCT} automatically transfers your meeting/webinar recordings from a source you connect (Zoom or
      Fathom) to destinations you choose (YouTube and/or your LMS), on a schedule you control. Availability of
      source and destination features depends on those third-party services and their APIs.</p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>You must own or have the right to upload and publish the recordings you route, and to grant the
          access needed to the connected accounts.</li>
        <li>You are responsible for keeping your login and connected-service credentials secure, and for the
          activity of staff you add to your workspace.</li>
        <li>You must comply with the terms of the connected services (Zoom, Fathom, Google/YouTube, your LMS).</li>
      </ul>

      <h2>Billing</h2>
      <p>The service is pay-as-you-go. Each uploaded video draws one credit from your wallet; the first upload is
      free. Credits are purchased in packs as shown on the Billing page, with applicable taxes and gateway fees.
      Purchased credits are non-refundable — see the Refund policy.</p>

      <h2>Availability &amp; liability</h2>
      <p>The service is provided “as is”, without warranty of uninterrupted or error-free operation. Transfers
      depend on third-party APIs that may change or fail. To the maximum extent permitted by law, ${COMPANY} is
      not liable for indirect or consequential losses, and total liability is limited to the amount you paid for
      credits in the preceding month.</p>

      <h2>Changes &amp; termination</h2>
      <p>We may update the service and these terms; material changes will be reflected here. You may stop using
      the service at any time. We may suspend accounts that violate these terms or the connected services' terms.</p>

      <h2>Governing law</h2>
      <p>These terms are governed by the laws of India.</p>`,
  },

  refund: {
    title: 'Refund & Cancellation Policy',
    html: `
      <h2>No refunds — your balance stays until you use it</h2>
      <p>${PRODUCT} is a pay-as-you-go digital service. <b>Payments for video credits are non-refundable.</b>
      However, credits you purchase <b>do not expire and remain in your wallet</b> until you use them, so nothing
      you pay for is lost.</p>

      <h2>Try before you buy</h2>
      <p>Your <b>first upload is free</b>, so you can confirm the service works for you before purchasing any
      credits.</p>

      <h2>Cancellation</h2>
      <p>There is no subscription to cancel — you only pay when you top up. You can stop using the service at any
      time; any remaining wallet balance simply stays available for whenever you return.</p>

      <h2>Billing errors</h2>
      <p>If you were charged but credits were not added to your wallet (for example a payment that succeeded at the
      gateway but did not reflect), contact us with your payment reference and we will reconcile it.</p>`,
  },

  shipping: {
    title: 'Shipping & Delivery Policy',
    html: `
      <h2>Digital service — nothing is physically shipped</h2>
      <p>${PRODUCT} is a software service (SaaS). There are <b>no physical goods and no shipping</b>.</p>

      <h2>Delivery</h2>
      <p>Access is delivered electronically. When you purchase video credits, they are added to your wallet
      <b>immediately</b> after the payment is confirmed, and are available to use right away. If a top-up does not
      reflect within a few minutes of a successful payment, contact us and we will resolve it.</p>`,
  },

  contact: {
    title: 'Contact Us',
    html: `
      <p>We're happy to help with setup, connections, billing or anything else.</p>

      <div class="contact-card">
        <p><span class="ic">💬</span> <b>WhatsApp:</b>
          <a href="${SUPPORT_WHATSAPP_LINK}">${SUPPORT_WHATSAPP}</a></p>
        <p><span class="ic">✉️</span> <b>Email:</b>
          <a href="mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(PRODUCT + ' — support request')}">${SUPPORT_EMAIL}</a></p>
      </div>

      <div class="kb-note">${COMPANY} runs several apps, so please <b>mention “${PRODUCT}” in your email
        subject</b> — it helps us route your request to the right team quickly.</div>

      <p class="muted">Business hours support. For account-specific issues, include your workspace/login email
        (not your password) so we can find your workspace.</p>`,
  },
};
