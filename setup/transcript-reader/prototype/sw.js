'use strict';

// The transcript reader's service worker, for a sealed copy opened over a secure address (the phone, over the tailnet's
// HTTPS name). sync.py writes it beside the shell pages (out/hosted/sw.js, out/bucket/sw.js), so its scope is that folder. It
// does two things and holds no transcript, no key and no passphrase:
//
//   1. Opens the shell pages with the laptop away. A navigation to index.html or sheet.html asks the laptop first and, when
//      it answers within a few seconds, shows that (the sign-in page included). When there is no answer, or only a refusal or an
//      error, it opens the copy of the page the cache holds: the page's own code keeps one there (hosted.js
//      storeShell), and each page the worker passes through is kept too. The objects (the conversations, documents and fleet
//      weeks) are not the worker's business: the page keeps those in its own storage, sealed, by stamp.
//   2. Answers the frame an HTML document is shown in (view/<key>/<name>). The key names text that only a reader page open in a
//      window holds; the worker asks the windows for it over a message port and answers the frame's navigation with it and
//      the same policy the laptop's server puts on such a file (api.js VIEW_CSP): "sandbox allow-scripts" makes the document an
//      opaque origin with no network, frames or forms, so its own scripts run and nothing else does. The worker keeps none of it.
//
// A frame with a sandbox attribute is not controlled by a service worker, which is why the policy header does the sandboxing.
// With no worker answering (it is not installed, or no window holds the key) the server has no such address and answers 404,
// so an HTML file is never shown unsandboxed.

const CACHE = 'reader-shell-v1';
const SHELL = new Set(['index.html', 'sheet.html']);
const WAIT_MS = 4000;      // how long the laptop gets to answer a page request when a stored page is there to open instead
const VIEW_WAIT_MS = 3000;  // how long a window gets to answer for a view
const VIEW_CSP = ["sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "media-src data: blob:", "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"].join('; ');

const here = () => new URL(self.registration.scope);
const inside = (url) => url.origin === here().origin && url.pathname.startsWith(here().pathname);
const relative = (url) => url.pathname.slice(here().pathname.length);

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
// Navigation preload: the browser sends the page request itself, as the navigation it is (a worker's own fetch of it carries other
// Fetch-Metadata, which the reader's server refuses for a page), and the worker takes that answer or the stored page.
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), self.registration.navigationPreload ? self.registration.navigationPreload.enable().catch(() => null) : null]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (!inside(url)) return;
  const name = relative(url);
  if (name.startsWith('view/')) event.respondWith(view(name));
  else if (SHELL.has(name)) event.respondWith(shell(event, url));
});

// The shell page: the laptop's answer when there is one in time, else the stored page. An answer of any kind is shown as it is
// (a sign-in page included), except a refusal or an error when a stored page is there: that opens in its place.
async function shell(event, url) {
  const key = new URL(url.href);
  key.search = '';
  key.hash = '';
  const cache = await caches.open(CACHE);
  const stored = await cache.match(key.href);
  const asked = Promise.resolve(event.preloadResponse).then((preloaded) => preloaded || fetch(event.request));
  const network = asked.then(async (response) => {
    // Only a page that really is the shell is kept: not a sign-in page, an error or a proxy's answer.
    if (response.ok && (response.headers.get('content-type') || '').startsWith('text/html')) await cache.put(key.href, response.clone());
    return response;
  });
  if (!stored) return network;
  const answered = await Promise.race([network.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS))]);
  if (answered && (answered.ok || answered.status === 401)) return answered;
  event.waitUntil(network.catch(() => null));  // a late answer still refreshes the stored page
  return stored;
}

// One reader window's answer for a view key, or null.
function ask(client, key) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), VIEW_WAIT_MS);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data && typeof event.data.html === 'string' ? event.data.html : null); };
    try { client.postMessage({ kind: 'view', key }, [channel.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

async function view(name) {
  const key = name.slice('view/'.length).split('/')[0];
  if (!/^[0-9a-f]{32}$/.test(key)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const answers = await Promise.all(windows.map((client) => ask(client, key)));
  const html = answers.find((answer) => answer !== null);
  if (html === undefined) return new Response('This view is not open any more. Go back to the reader and open the file again.', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': VIEW_CSP, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    },
  });
}
