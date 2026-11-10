/**
 * Lost Temple service worker (registered by src/pwa.ts, built builds only).
 * Every URL is relative to the registration scope, so the game works from any subfolder.
 *  - pages: network first, the cached page when offline
 *  - packs/ (the asset packs and their index): not handled here. The page downloads them and keeps
 *    them in IndexedDB (src/packs/store.ts), and answers the game's asset and data fetches itself
 *  - everything else in scope (bundle/, the loose music and font under assets/, icons): cache first,
 *    cached as it is used
 * The first visit loads before this worker runs, so install precaches the page and the JS bundle (the
 * build lists it over PRECACHE), and the page then sends the other URLs it already loaded ('backfill',
 * src/pwa.ts).
 * Two caches:
 *  - code, per version (the build writes package.json's version over 2.3.0): a new version
 *    starts a fresh one and drops the old
 *  - music and the font (assets/), per extract (the build writes a hash of those files over
 *    991775829fc6): it outlives a new version, so a release that only changes code doesn't download
 *    the songs again
 * Ranged reads (audio elements stream the music with Range) are answered from a cached file when there
 * is one, so the music plays offline; a 206 from the network can't be cached and goes straight through.
 */
const VERSION = '2.3.0';
const CACHE = `lost-temple-${VERSION}`;
const ART_CACHE = `lost-temple-art-991775829fc6`;
const SCOPE = self.registration.scope;
const ART_ROOT = new URL('assets/', SCOPE).href;
const PACK_ROOT = new URL('packs/', SCOPE).href;
const PRECACHE = ["bundle/index-4zqF7ZMR.js","bundle/worker-CTztwe9d.js"];
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', ...PRECACHE].map((p) => new URL(p, SCOPE).href);

/** The cache a URL belongs in. */
const cacheOf = (url) => caches.open(url.startsWith(ART_ROOT) ? ART_CACHE : CACHE);

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then((c) => c.addAll(SHELL.filter((u) => !u.startsWith(ART_ROOT)))),
      // art already cached by an earlier version is kept as it is
      caches.open(ART_CACHE).then((c) => Promise.all(SHELL.filter((u) => u.startsWith(ART_ROOT)).map(async (u) => (await c.match(u)) || c.add(u)))),
    ]).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lost-temple-') && k !== CACHE && k !== ART_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// backfill: { type: 'backfill', urls } from the page: cache the ones in scope not cached yet
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'backfill' || !Array.isArray(e.data.urls)) return;
  const urls = e.data.urls.filter((u) => typeof u === 'string' && u.startsWith(SCOPE) && !u.startsWith(PACK_ROOT)).map((u) => u.split('#')[0]);
  e.waitUntil(
    Promise.all(
      urls.map(async (u) => {
        const c = await cacheOf(u);
        if (await c.match(u, { ignoreSearch: true })) return;
        const res = await fetch(u).catch(() => undefined);
        if (res?.status === 200) await c.put(u, res);
      }),
    ),
  );
});

/** A `Range: bytes=a-b` read of a cached file as a 206; from the network when the file isn't cached. */
async function ranged(req) {
  const key = req.url.split('#')[0];
  const hit = await (await cacheOf(key)).match(key, { ignoreSearch: true });
  if (!hit) return fetch(req);
  const body = await hit.arrayBuffer();
  const size = body.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
  if (!m || (!m[1] && !m[2])) return new Response(body, { status: 200, headers: hit.headers });
  // "a-b", "a-" (to the end) or "-n" (the last n bytes)
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(body.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': hit.headers.get('Content-Type') ?? 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // other origins and non-GETs go straight out
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  // the packs are the page's (IndexedDB): a copy here would store them twice
  if (req.url.startsWith(PACK_ROOT)) return;
  if (req.headers.has('range')) {
    e.respondWith(ranged(req));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) void caches.open(CACHE).then((c) => c.put(new URL('./', SCOPE).href, res.clone()));
          return res;
        })
        .catch(() => caches.match(new URL('./', SCOPE).href).then((r) => r ?? Response.error())),
    );
    return;
  }
  const key = req.url.split('#')[0];
  e.respondWith(
    cacheOf(key).then(async (c) => {
      const hit = await c.match(key, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) void c.put(key, res.clone());
      return res;
    }),
  );
});
