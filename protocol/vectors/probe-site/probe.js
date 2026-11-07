// MeshSites no-network probe. Runs inside a rendered site and reports what it
// could reach. Native (WKWebView): window.webkit.messageHandlers.meshsitesProbe.
// Web testbed: parent.postMessage. Expected results are in the "expect" field.
(async () => {
  const results = [];
  const add = (id, what, expect, got, detail) => results.push({ id, what, expect, got, detail: detail ? String(detail).slice(0, 160) : undefined });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = location.href.replace(/[^/]*$/, '');
  const other = location.protocol === 'meshsite:' ? 'meshsite://bafybeib5gg45er6y7rgo2hgisx7bj4issekvfyhu52k3em52a2bb2khvxy/' : '/site/bafybeib5gg45er6y7rgo2hgisx7bj4issekvfyhu52k3em52a2bb2khvxy/';

  const tryFetch = async (id, what, url, expect) => {
    try { const r = await Promise.race([fetch(url), sleep(4000).then(() => { throw new Error('timeout'); })]); add(id, what, expect, r.ok ? 'allowed' : 'blocked', 'HTTP ' + r.status); }
    catch (e) { add(id, what, expect, 'blocked', e && e.message); }
  };
  const tryImg = (id, what, url, expect) => new Promise((res) => {
    const i = new Image();
    let done = false;
    const finish = (got, d) => { if (!done) { done = true; add(id, what, expect, got, d); res(); } };
    i.onload = () => finish('allowed');
    i.onerror = () => finish('blocked');
    i.src = url;
    setTimeout(() => finish('blocked', 'timeout'), 4000);
  });

  await tryFetch('own-file', "fetch() of the site's own file", base + 'probe.json', 'allowed');
  await tryImg('own-img', 'an <img> from the site itself', base + 'pixel.svg', 'allowed');
  await tryFetch('other-site', 'fetch() of another stored site', other, 'blocked');
  await tryFetch('remote-https', 'fetch() of https://example.com', 'https://example.com/', 'blocked');
  await tryFetch('remote-http', 'fetch() of http://127.0.0.1', 'http://127.0.0.1:9/', 'blocked');
  await tryImg('remote-img', 'an <img> from https://example.com', 'https://example.com/favicon.ico', 'blocked');
  try {
    const ws = new WebSocket('wss://example.com/');
    const state = await new Promise((r) => { ws.onerror = () => r('blocked'); ws.onopen = () => r('allowed'); setTimeout(() => r(ws.readyState === 1 ? 'allowed' : 'blocked'), 4000); });
    add('ws', 'WebSocket to wss://example.com', 'blocked', state);
  } catch (e) { add('ws', 'WebSocket to wss://example.com', 'blocked', 'blocked', e && e.message); }
  {
    const violated = new Promise((r) => {
      document.addEventListener('securitypolicyviolation', (ev) => { if (String(ev.blockedURI).includes('example.com')) r(ev.effectiveDirective); });
      setTimeout(() => r(null), 2500);
    });
    let queued = false;
    try { queued = navigator.sendBeacon('https://example.com/beacon', 'x'); } catch (e) { queued = false; }
    const d = await violated;
    add('beacon', 'navigator.sendBeacon to example.com', 'blocked', !queued || d ? 'blocked' : 'allowed', d ? 'CSP ' + d : 'returned ' + queued);
  }
  {
    // A cross-origin frame can't be inspected, so the evidence is the CSP
    // violation (frame-src 'none'); with no violation it counts as allowed.
    const violated = new Promise((r) => {
      document.addEventListener('securitypolicyviolation', (ev) => { if (ev.effectiveDirective === 'frame-src') r(true); });
      setTimeout(() => r(false), 2500);
    });
    const f = document.createElement('iframe');
    f.src = 'https://example.com/';
    document.body.appendChild(f);
    add('iframe', 'an <iframe> of https://example.com', 'blocked', (await violated) ? 'blocked' : 'allowed');
  }
  const rtc = typeof RTCPeerConnection !== 'undefined' || typeof webkitRTCPeerConnection !== 'undefined';
  add('webrtc', 'WebRTC (RTCPeerConnection) available', 'blocked', rtc ? 'allowed' : 'blocked', rtc ? 'RTCPeerConnection is present' : 'removed');
  {
    // Escape attempt: a fresh about:blank iframe has its own window with
    // untouched constructors unless the lockdown also runs in subframes.
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    await sleep(200);
    let leaked = false;
    try { const w = f.contentWindow; leaked = !!(w && (w.RTCPeerConnection || w.webkitRTCPeerConnection)); } catch (e) { leaked = false; }
    add('webrtc-iframe', 'WebRTC through a blank same-origin iframe', 'blocked', leaked ? 'allowed' : 'blocked');
  }
  {
    let w = null;
    try { w = window.open('about:blank'); } catch (e) { w = null; }
    let leaked = false;
    try { leaked = !!(w && (w.RTCPeerConnection || w.webkitRTCPeerConnection || w.fetch)); } catch (e) { leaked = false; }
    add('window-open', 'window.open() of a new window', 'blocked', w ? 'allowed' : 'blocked', leaked ? 'new window has network APIs' : undefined);
  }
  const md = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  add('media', 'camera/microphone API available', 'blocked', md ? 'allowed' : 'blocked');

  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.meshsitesProbe;
  if (h) h.postMessage(JSON.stringify(results));
  else if (parent !== window) parent.postMessage({ meshsitesProbe: results }, '*');
  document.title = 'probe:done';
})();
