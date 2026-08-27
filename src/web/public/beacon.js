// Human-confirmation beacon for public pages. That it fires at all proves a real
// browser ran JS (crawlers don't). Sends viewport + timezone; the server reads
// the visitor id and Meta (_fbp/_fbc) cookies straight off the request.
(function () {
  try {
    var body = JSON.stringify({
      path: location.pathname,
      screen: (screen.width || 0) + 'x' + (screen.height || 0),
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || null,
      ref: document.referrer || null,
    });
    var sent = false;
    if (navigator.sendBeacon) {
      sent = navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    }
    if (!sent) {
      fetch('/api/track', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: body,
      }).catch(function () {});
    }
  } catch (e) { /* beacon is best-effort */ }
})();
