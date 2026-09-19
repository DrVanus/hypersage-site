/* Cookieless visit counter: adds 1 to a daily total. What it sends and why: https://hypersage.ai/privacy.html#visit-counter */
(function () {
  try {
    var W = 'https://hs-tally.danielm188.workers.dev/v1/n', n = navigator, l = location, d = document, K = 'hs_nocount';
    var q = new URLSearchParams(l.search), sw = q.get('count');
    try { if (sw === 'off') localStorage.setItem(K, '1'); else if (sw === 'on') localStorage.removeItem(K); } catch (e) {}
    if (sw === 'off' || n.globalPrivacyControl || /^(1|yes)$/.test(n.doNotTrack || window.doNotTrack || n.msDoNotTrack || '') || n.webdriver) return;
    try { if (localStorage.getItem(K)) return; } catch (e) {}
    if (l.hostname !== 'hypersage.ai' || !n.sendBeacon) return;
    var APPS = { '6792772729': 'wingmate', '6792760857': 'saffra', '6792759454': 'storyvault', '6792761643': 'nightshelf',
      '6792798732': 'hexhunter', '6797693737': 'rowan', '6792761331': 'cryptosage' };
    // A value that could name a person is dropped: an email address, or more than 8 digits (a phone number, a member id).
    var tag = function (v) { v = String(v || ''); return /@|(\d\D*){9}/.test(v) ? '' : v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); };
    var send = function (o) { try { n.sendBeacon(W, JSON.stringify(o)); } catch (e) {} };
    // Canonical path: "/x/index.html" -> "/x/", "/x/privacy" -> "/x/privacy.html". A 404 page reports only
    // "/<counted folder>/404" (or "/404" for a miss at the top level), never the address that was mistyped,
    // and nothing at all for a miss inside an uncounted folder (e.g. /waddleton/..., /rowan/...).
    var p = l.pathname.replace(/\/index\.html$/, '/').replace(/\/([^\/.]+)$/, '/$1.html');
    if (/\/404\.html$/.test(p) || d.querySelector('meta[name="robots"][content*="noindex"]')) {
      var seg = l.pathname.split('/'), f = seg.length > 2 ? seg[1] : '';
      if (f && !/^(wingmate|saffra|storyvault|nightshelf|hexhunter)$/.test(f)) return;
      p = (f ? '/' + f : '') + '/404';
    }
    // Referrer host only ("hypersage.ai" for a move between pages, "" for none).
    var r = ''; try { r = new URL(d.referrer).hostname.toLowerCase().replace(/^www\./, '').slice(0, 100); } catch (e) {}
    var src = tag(q.get('src') || q.get('utm_source')), cmp = tag(q.get('utm_campaign'));
    var c = cmp ? src + '.' + cmp : src; // "<src>" or "<src>.<campaign>"; each part [a-z0-9-]{0,24}
    send({ p: p, r: r, e: 'pv', c: c, a: '', s: '' });
    d.addEventListener('click', function (ev) {
      try {
        var a = ev.target && ev.target.closest && ev.target.closest('a[href*="apps.apple.com"]');
        if (!a) return;
        var id = (String(a.href).match(/\/id(\d+)/) || [])[1];
        send({ p: p, r: r, e: 'tap', c: c, a: APPS[id] || '', s: tag(a.getAttribute('data-slot')) || 'link' });
      } catch (e) {}
    }, true);
  } catch (e) {}
})();
