import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserCandidateScore,
  browserMediaKind,
  browserPlaybackHeaders,
  browserResourceKind,
  decodeBase64Text,
  decodeHexXor,
  decodeHunterPacked,
  extractEncodedMediaUrl,
  extractMediaUrl,
  extractTemplateMediaCandidates,
  fillTemplate,
  handleRequest,
  rewriteHls,
} from '../src/index.js';

test('fills the supported source template fields', () => {
  const result = fillTemplate('https://example.invalid/{type}/{tmdb}?imdb={imdb}', {
    type: 'movie', tmdb: '123', imdb: 'tt1234567', title: 'Example', year: '2026',
  });
  assert.equal(result, 'https://example.invalid/movie/123?imdb=tt1234567');
});

test('redirects an embed directly to the configured player without resolving media', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('embed redirect must not fetch upstream'); };

  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/embed?type=movie&tmdb=533533&startAt=90',
    { headers: { Origin: env.APP_ORIGIN }, redirect: 'manual' },
  ), env);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://player.example.invalid/movie/533533?startAt=90');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('returns a player URL without fetching it so Pages remains the iframe referrer', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('player URL lookup must not fetch upstream'); };

  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/movie/533533' });
});

test('src=alt returns the backup player URL from its own secret', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
    TRAILER_URL_TEMPLATE_ALT: 'https://backup.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533&src=alt',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://backup.example.invalid/movie/533533' });
});

test('src=alt without the backup secret returns 503 instead of the primary', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533&src=alt',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'ALT_PLAYER_NOT_CONFIGURED' });
});

test('rejects an unknown src value', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533&src=bogus',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 400);
});

test('builds the movie path from a base URL secret', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/movie/533533' });
});

test('builds the TV path from a base URL secret', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=tv&tmdb=66732&season=5&episode=3',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/tv/66732/5/3' });
});

test('does not duplicate an existing legacy movie suffix', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/movie/',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=533533',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/movie/533533' });
});

test('appends season and episode to a TV player template', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=tv&tmdb=66732&season=5&episode=3',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/tv/66732/5/3' });
});

test('converts an existing hard-coded movie route for TV playback', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/movie/{tmdb}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=tv&tmdb=66732&season=5&episode=3',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/tv/66732/5/3' });
});

test('supports explicit season and episode placeholders', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}/{season}/{episode}',
  };
  const response = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=tv&tmdb=66732&season=5&episode=3',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://player.example.invalid/tv/66732/5/3' });
});

test('cinesrc.st players take episodes as query params, subtitles off, no autonext', async () => {
  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    TRAILER_URL_TEMPLATE: 'https://cinesrc.st/embed/{type}/{tmdb}?autoplay=1',
  };
  const tv = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=tv&tmdb=66732&season=5&episode=3',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);
  assert.equal(tv.status, 200);
  assert.deepEqual(await tv.json(), { url: 'https://cinesrc.st/embed/tv/66732?autoplay=1&s=5&e=3&subtitles=off&autonext=false' });

  const movie = await handleRequest(new Request(
    'https://worker.example.invalid/private_test_path_1234/player?type=movie&tmdb=289',
    { headers: { Origin: env.APP_ORIGIN } },
  ), env);
  assert.equal(movie.status, 200);
  assert.deepEqual(await movie.json(), { url: 'https://cinesrc.st/embed/movie/289?autoplay=1&subtitles=off&autonext=false' });
});

test('finds an escaped HLS URL without contacting it', () => {
  const page = String.raw`{"file":"https:\/\/media.example.invalid\/trailers\/master.m3u8?token=fake\u0026v=1"}`;
  assert.equal(
    extractMediaUrl(page, 'https://player.example.invalid/movie/123'),
    'https://media.example.invalid/trailers/master.m3u8?token=fake&v=1',
  );
});

test('prefers HLS over a poster or MP4 candidate', () => {
  const page = '<video src="fallback.mp4"></video><script>const hls="/video/master.m3u8";</script>';
  assert.equal(
    extractMediaUrl(page, 'https://player.example.invalid/title/123'),
    'https://player.example.invalid/video/master.m3u8',
  );
});

test('rewrites variants, segments, keys and maps', async () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'segment-1.ts',
  ].join('\n');
  const rewritten = await rewriteHls(
    manifest,
    'https://media.example.invalid/path/master.m3u8',
    async (url) => 'https://worker.example.invalid/opaque/' + encodeURIComponent(url),
  );
  assert.match(rewritten, /opaque\/https%3A%2F%2Fmedia\.example\.invalid%2Fpath%2Faudio%2Findex\.m3u8/);
  assert.match(rewritten, /opaque\/https%3A%2F%2Fmedia\.example\.invalid%2Fpath%2Fkeys%2Fkey\.bin/);
  assert.match(rewritten, /opaque\/https%3A%2F%2Fmedia\.example\.invalid%2Fpath%2Finit\.mp4/);
  assert.match(rewritten, /opaque\/https%3A%2F%2Fmedia\.example\.invalid%2Fpath%2Fsegment-1\.ts/);
});

test('Browser Run discovery selects playlists and full videos, not transport segments', () => {
  assert.equal(browserMediaKind('https://media.example.invalid/master.m3u8', ''), 'hls');
  assert.equal(browserMediaKind('https://media.example.invalid/watch', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(browserMediaKind('https://media.example.invalid/trailer.mp4', ''), 'video');
  assert.equal(browserMediaKind('https://media.example.invalid/segment.ts', 'video/mp2t'), '');
  assert.equal(browserResourceKind('https://media.example.invalid/manifest.mpd', ''), 'dash');
  assert.equal(browserResourceKind('https://media.example.invalid/chunk.m4s', ''), 'segment');
  assert.ok(
    browserCandidateScore('https://media.example.invalid/trailer/master.m3u8', 'hls') >
    browserCandidateScore('https://ads.example.invalid/preroll/master.m3u8', 'hls'),
  );
});

test('Browser Run stores only playback-relevant request headers', () => {
  assert.deepEqual(browserPlaybackHeaders({
    Cookie: 'session=fake',
    Referer: 'https://player.example.invalid/',
    Authorization: 'Bearer fake',
    'X-Playback-Token': 'fake',
    'X-Forwarded-For': '127.0.0.1',
    Host: 'media.example.invalid',
  }), {
    cookie: 'session=fake',
    referer: 'https://player.example.invalid/',
    authorization: 'Bearer fake',
    'x-playback-token': 'fake',
  });
});

test('decodes bounded VidSrc-style Base64, XOR and Hunter values', () => {
  const media = 'https://media.example.invalid/trailer/master.m3u8';
  const encodedMedia = btoa(media);
  assert.equal(decodeBase64Text(encodedMedia), media);
  assert.equal(extractEncodedMediaUrl(`file:"${encodedMedia}"`, 'https://player.example.invalid/'), media);
  assert.equal(
    extractEncodedMediaUrl(`file:"//token.example.invalid/key=${encodedMedia}#2"`, 'https://player.example.invalid/'),
    media,
  );

  const seed = 'synthetic-seed';
  const hex = Array.from(media, (character, index) =>
    (character.charCodeAt(0) ^ seed.charCodeAt(index % seed.length)).toString(16).padStart(2, '0')
  ).join('');
  assert.equal(decodeHexXor(hex, seed), media);

  const hunterValue = Array.from(media, (character) => character.charCodeAt(0) + 'x').join('');
  const packed = `escape(r))}("${hunterValue}",0,"0123456789x",0,10,0)`;
  assert.equal(decodeHunterPacked(packed), media);
});

test('expands bounded VidSrc-style Playerjs host placeholders from the page', () => {
  const page = `
    <script>
      const mirrors = ["https://tmstr1.edge-a.invalid", "https://tmstr2.edge-b.invalid"];
      const player = { file: "https://video.{v1}/trailer/master.m3u8 or https://backup.{v2}/trailer/master.m3u8" };
    </script>`;
  assert.deepEqual(
    extractTemplateMediaCandidates(page, 'https://player.example.invalid/prorcp/fixture'),
    [
      'https://video.edge-a.invalid/trailer/master.m3u8',
      'https://video.edge-b.invalid/trailer/master.m3u8',
      'https://backup.edge-a.invalid/trailer/master.m3u8',
      'https://backup.edge-b.invalid/trailer/master.m3u8',
    ],
  );
});

test('follows a synthetic rcpvip, prorcp and templated-host HLS chain', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://source.invalid/movie/456') {
      return new Response('<iframe id="player_iframe" src="https://player.invalid/rcpvip/fixture"></iframe>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === 'https://player.invalid/rcpvip/fixture') {
      return new Response('<script>const next = {src: "/prorcp/fixture"};</script>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === 'https://player.invalid/prorcp/fixture') {
      return new Response(`
        <script>
          const mirrors = ["https://tmstr1.edge.invalid"];
          const player = {file: "https://video.{v1}/trailer/master.m3u8"};
        </script>`, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url === 'https://video.edge.invalid/trailer/master.m3u8') {
      return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (url === 'https://video.edge.invalid/trailer/segment.ts') {
      return new Response(new Uint8Array([7, 8, 9]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    PLAYBACK_TOKEN_SECRET: 'synthetic-secret-that-is-longer-than-thirty-two-characters',
    TRAILER_URL_TEMPLATE: 'https://source.invalid/{type}/{tmdb}',
  };
  const headers = { Origin: env.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + env.ACCESS_PATH + '/resolve?type=movie&tmdb=456',
    { headers },
  ), env);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.doesNotMatch(data.url, /video\.edge\.invalid/);
  assert.ok(calls.includes('https://player.invalid/prorcp/fixture'));
  assert.ok(calls.includes('https://video.edge.invalid/trailer/master.m3u8'));

  const manifest = await handleRequest(new Request(data.url, { headers }), env);
  assert.equal(manifest.status, 200);
  assert.match(await manifest.text(), /worker\.example\.invalid/);
});

test('follows a synthetic server-hash, XOR, redirect and Base64 media chain', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const seed = 'fixture-key';
  const redirectUrl = 'https://gate.invalid/step';
  const encodedRedirect = Array.from(redirectUrl, (character, index) =>
    (character.charCodeAt(0) ^ seed.charCodeAt(index % seed.length)).toString(16).padStart(2, '0')
  ).join('');
  const mediaUrl = 'https://media.invalid/trailer/master.m3u8';
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    calls.push({ url, referer: headers.get('referer') || '' });

    if (url === 'https://source.invalid/movie/123') {
      return new Response('<div class="server" data-hash="fixture123">Primary</div>', {
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'entry=fake; Path=/; Secure' },
      });
    }
    if (url === 'https://source.invalid/rcp/fixture123') return new Response('missing', { status: 404 });
    if (url === 'https://rcp.source.invalid/rcp/fixture123') {
      assert.equal(headers.get('referer'), 'https://source.invalid/movie/123');
      assert.doesNotMatch(headers.get('cookie') || '', /entry=fake/);
      return new Response(`<body data-i="${seed}"><div id="hidden" data-h="${encodedRedirect}"></div>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === redirectUrl) {
      assert.equal(headers.get('referer'), 'https://rcp.source.invalid/rcp/fixture123');
      return new Response(null, { status: 302, headers: { Location: 'https://player.invalid/watch' } });
    }
    if (url === 'https://player.invalid/watch') {
      return new Response(`file:"${btoa(mediaUrl)}"; var pass_path = "//media.invalid/pass";`, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === 'https://media.invalid/pass') {
      return new Response('ok', { headers: { 'Set-Cookie': 'play=fake; Path=/; Secure' } });
    }
    if (url === mediaUrl) {
      assert.match(headers.get('cookie') || '', /play=fake/);
      return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (url === 'https://media.invalid/trailer/segment.ts') {
      return new Response(new Uint8Array([4, 5, 6]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    PLAYBACK_TOKEN_SECRET: 'synthetic-secret-that-is-longer-than-thirty-two-characters',
    TRAILER_URL_TEMPLATE: 'https://source.invalid/{type}/{tmdb}',
  };
  const headers = { Origin: env.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + env.ACCESS_PATH + '/resolve?type=movie&tmdb=123',
    { headers },
  ), env);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.doesNotMatch(data.url, /media\.invalid/);
  assert.ok(calls.some((call) => call.url === 'https://rcp.source.invalid/rcp/fixture123'));
  assert.ok(calls.some((call) => call.url === 'https://media.invalid/pass'));

  const manifest = await handleRequest(new Request(data.url, { headers }), env);
  const manifestText = await manifest.text();
  const segmentUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), env);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [4, 5, 6]);
});

test('resolves and proxies an HLS stream without exposing the upstream URL', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('source.example.invalid')) {
      return new Response('<script>const playlist="https://media.example.invalid/hls/master.m3u8";</script>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.includes('master.m3u8')) {
      return new Response('#EXTM3U\n#EXTINF:4,\nsegment-1.ts', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (url.includes('segment-1.ts')) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL');
  };

  const env = {
    ACCESS_PATH: 'private_test_path_1234',
    APP_ORIGIN: 'https://chigala.github.io',
    PLAYBACK_TOKEN_SECRET: 'synthetic-secret-that-is-longer-than-thirty-two-characters',
    TRAILER_URL_TEMPLATE: 'https://source.example.invalid/{type}/{tmdb}',
  };
  const headers = { Origin: env.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + env.ACCESS_PATH + '/resolve?type=movie&tmdb=123',
    { headers },
  ), env);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.match(data.url, /^https:\/\/worker\.example\.invalid\//);
  assert.doesNotMatch(data.url, /media\.example\.invalid/);

  const manifest = await handleRequest(new Request(data.url, { headers }), env);
  assert.equal(manifest.status, 200);
  const manifestText = await manifest.text();
  assert.match(manifestText, /worker\.example\.invalid/);
  assert.doesNotMatch(manifestText, /media\.example\.invalid/);

  const segmentUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), env);
  assert.equal(segment.status, 200);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [1, 2, 3]);
});

/* ---------- /stream (native player resolution) ---------- */

const STREAM_ENV = {
  ACCESS_PATH: 'private_test_path_1234',
  APP_ORIGIN: 'https://chigala.github.io',
  PLAYBACK_TOKEN_SECRET: 'synthetic-secret-that-is-longer-than-thirty-two-characters',
  TRAILER_URL_TEMPLATE: 'https://player.example.invalid/{type}/{tmdb}',
};
const VIDROCK_TEST_KEY_HEX = '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';

async function encryptVidrockUrl(plainUrl) {
  const keyBytes = new Uint8Array(VIDROCK_TEST_KEY_HEX.length / 2);
  for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(VIDROCK_TEST_KEY_HEX.substr(i * 2, 2), 16);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainUrl)));
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv);
  blob.set(cipher, iv.length);
  let binary = '';
  for (const byte of blob) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

test('stream endpoint validates parameters', async () => {
  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const badType = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=anime&tmdb=550',
    { headers },
  ), STREAM_ENV);
  assert.equal(badType.status, 400);

  const badId = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=abc',
    { headers },
  ), STREAM_ENV);
  assert.equal(badId.status, 400);

  const tvNoEpisode = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=tv&tmdb=66732',
    { headers },
  ), STREAM_ENV);
  assert.equal(tvNoEpisode.status, 400);
});

test('stream resolves via moviesapi and proxies with its referer', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    calls.push({ url, referer: headers.get('referer') || '', playerKey: headers.get('x-player-key') || '' });

    if (url === 'https://moviesapi.to/api/vidora/v1/movie/550') {
      assert.ok(headers.get('x-player-key'));
      assert.equal(headers.get('referer'), 'https://moviesapi.to/movie/550');
      return new Response(JSON.stringify({
        result: true, title: 'Fight Club', year: 1999,
        sources: [{ url: 'https://cdn.upstream.invalid/hls/master.m3u8', tracks: [{ file: '/api/vidora/subs/en.vtt', label: 'English', language: 'en' }] }],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://cdn.upstream.invalid/hls/master.m3u8') {
      assert.equal(headers.get('referer'), 'https://moviesapi.to/');
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (url === 'https://cdn.upstream.invalid/hls/variant.m3u8') {
      assert.equal(headers.get('referer'), 'https://moviesapi.to/');
      return new Response('#EXTM3U\n#EXTINF:4,\nseg-1.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === 'https://cdn.upstream.invalid/hls/seg-1.ts') {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=550',
    { headers },
  ), STREAM_ENV);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.equal(data.provider, 'moviesapi');
  assert.equal(data.sources.length, 1);
  assert.match(data.sources[0].url, /\/media\//);
  assert.doesNotMatch(data.sources[0].url, /cdn\.upstream\.invalid/);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].label, 'English');

  const manifest = await handleRequest(new Request(data.sources[0].url, { headers }), STREAM_ENV);
  const manifestText = await manifest.text();
  assert.equal(manifest.status, 200);
  assert.match(manifestText, /worker\.example\.invalid/);
  assert.doesNotMatch(manifestText, /cdn\.upstream\.invalid/);

  const variantUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const variant = await handleRequest(new Request(variantUrl, { headers }), STREAM_ENV);
  const variantText = await variant.text();
  const segmentUrl = variantText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), STREAM_ENV);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [1, 2, 3]);
});

test('stream falls back to vidrock, decrypts sources, proxies with origin+referer', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const vidrockUrl = await encryptVidrockUrl('https://cdn.backup.invalid/movie/master.m3u8');
  const deadUrl = await encryptVidrockUrl('https://cdn.backup.invalid/movie/dead.m3u8');

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});

    if (url === 'https://moviesapi.to/api/vidora/v1/movie/9806') {
      return new Response(JSON.stringify({ result: false, message: 'Movie not yet encoded' }), { status: 404 });
    }
    if (url.startsWith('https://vidsrc.buzz/')) {
      return new Response('<html><body>no embedded config here</body></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (url === 'https://vidrock.net/api/movie/9806') {
      return new Response(JSON.stringify({
        Nova: { url: deadUrl, type: 'hls' },
        Orion: { url: vidrockUrl, type: 'hls' },
        Empty: { url: null, type: null },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://moviesapi.to/api/vidora/v1/subtitles/movie/9806') {
      return new Response(JSON.stringify({ tracks: [{ src: 'subs/en.vtt?v=1', label: 'English', language: 'en' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://cdn.backup.invalid/movie/dead.m3u8') {
      return new Response('gone', { status: 404 });
    }
    if (url === 'https://cdn.backup.invalid/movie/master.m3u8') {
      assert.equal(headers.get('referer'), 'https://vidrock.net/');
      assert.equal(headers.get('origin'), 'https://vidrock.net');
      return new Response('#EXTM3U\n#EXTINF:4,\nseg-1.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === 'https://cdn.backup.invalid/movie/seg-1.ts') {
      return new Response(new Uint8Array([9, 9]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=9806',
    { headers },
  ), STREAM_ENV);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.equal(data.provider, 'vidrock');
  assert.equal(data.sources.length, 2);
  assert.equal(data.sources[0].name, 'Nova');
  assert.equal(data.sources[1].name, 'Orion');
  // subtitle index works even though moviesapi has no encoded stream
  assert.equal(data.tracks.length, 1);

  // first (dead) source 404s through the proxy...
  const dead = await handleRequest(new Request(data.sources[0].url, { headers }), STREAM_ENV);
  assert.equal(dead.status, 502);

  // ...the player fails over to the second, which plays
  const manifest = await handleRequest(new Request(data.sources[1].url, { headers }), STREAM_ENV);
  assert.equal(manifest.status, 200);
  const manifestText = await manifest.text();
  assert.match(manifestText, /worker\.example\.invalid/);
  const segmentUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), STREAM_ENV);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [9, 9]);
});

test('stream returns 404 when no provider has the title', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://moviesapi.to/')) {
      return new Response(JSON.stringify({ result: false, message: 'Movie not yet encoded' }), { status: 404 });
    }
    if (url.startsWith('https://vidsrc.buzz/')) {
      return new Response('<html><body>no embedded config here</body></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.startsWith('https://vidrock.net/')) {
      return new Response(JSON.stringify({ Nova: { url: null } }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=1',
    { headers },
  ), STREAM_ENV);
  assert.equal(resolved.status, 404);
  assert.equal((await resolved.json()).error, 'STREAM_NOT_FOUND');
});

/* ---------- /seal (client-fetched vidrock fallback) ---------- */

function sealRequest(body, method) {
  return new Request('https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/seal', {
    method: method || 'POST',
    headers: { Origin: STREAM_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('seal accepts POST only and validates the envelope', async () => {
  const get = await handleRequest(sealRequest(undefined, 'GET'), STREAM_ENV);
  assert.equal(get.status, 405);

  const garbage = await handleRequest(sealRequest('not json'), STREAM_ENV);
  assert.equal(garbage.status, 400);

  const badType = await handleRequest(sealRequest({ type: 'anime', tmdb: '550', vidrock: {} }), STREAM_ENV);
  assert.equal(badType.status, 400);

  const badId = await handleRequest(sealRequest({ type: 'movie', tmdb: 'abc', vidrock: {} }), STREAM_ENV);
  assert.equal(badId.status, 400);

  const tvNoEpisode = await handleRequest(sealRequest({ type: 'tv', tmdb: '66732', season: '1', vidrock: {} }), STREAM_ENV);
  assert.equal(tvNoEpisode.status, 400);

  const noBody = await handleRequest(sealRequest({ type: 'movie', tmdb: '550' }), STREAM_ENV);
  assert.equal((await noBody.json()).error, 'INVALID_VIDROCK_BODY');

  const hugeUrl = await handleRequest(sealRequest({ type: 'movie', tmdb: '550', vidrock: { Nova: { url: 'x'.repeat(5000) } } }), STREAM_ENV);
  assert.equal(hugeUrl.status, 400);
});

test('seal 404s when no blob decrypts', async () => {
  const resolved = await handleRequest(sealRequest({
    type: 'movie', tmdb: '550',
    vidrock: { Nova: { url: 'AAAA' + 'A'.repeat(40), type: 'hls' }, Empty: { url: null } },
  }), STREAM_ENV);
  assert.equal(resolved.status, 404);
  assert.equal((await resolved.json()).error, 'STREAM_NOT_FOUND');
});

test('seal decrypts client-fetched blobs and seals them for the media proxy', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const goodUrl = await encryptVidrockUrl('https://cdn.clientfetch.invalid/movie/master.m3u8');
  const poisonUrl = 'https://cdn.poison.invalid/movie/fake.m3u8';

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    if (url === 'https://moviesapi.to/api/vidora/v1/subtitles/movie/550') {
      return new Response(JSON.stringify({ tracks: [{ src: 'subs/en.vtt', label: 'English', language: 'en' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://cdn.clientfetch.invalid/movie/master.m3u8') {
      assert.equal(headers.get('referer'), 'https://vidrock.net/');
      assert.equal(headers.get('origin'), 'https://vidrock.net');
      return new Response('#EXTM3U\n#EXTINF:4,\nseg-1.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === 'https://cdn.clientfetch.invalid/movie/seg-1.ts') {
      return new Response(new Uint8Array([7, 7]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const resolved = await handleRequest(sealRequest({
    type: 'movie', tmdb: '550',
    vidrock: { Orion: { url: goodUrl, type: 'hls' }, Poison: { url: poisonUrl, type: 'hls' } },
  }), STREAM_ENV);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.equal(data.provider, 'vidrock-client');
  // the plaintext decoy entry is dropped; only the real blob survives
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].name, 'Orion');
  assert.match(data.sources[0].url, /\/media\//);
  assert.doesNotMatch(data.sources[0].url, /cdn\.clientfetch\.invalid/);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].label, 'English');

  // the sealed client-fetched source plays through the proxy
  const manifest = await handleRequest(new Request(data.sources[0].url, { headers }), STREAM_ENV);
  assert.equal(manifest.status, 200);
  const manifestText = await manifest.text();
  assert.match(manifestText, /worker\.example\.invalid/);
  const segmentUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), STREAM_ENV);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [7, 7]);
});

test('seal refuses to proxy private hosts smuggled in a blob', async () => {
  const internalUrl = await encryptVidrockUrl('https://192.168.0.1/admin/master.m3u8');
  const resolved = await handleRequest(sealRequest({
    type: 'movie', tmdb: '550', vidrock: { Evil: { url: internalUrl, type: 'hls' } },
  }), STREAM_ENV);
  // the URL decrypts fine but fails the upstream safety check, and no other
  // source exists, so the endpoint surfaces a failure rather than sealing it
  assert.ok(resolved.status === 404 || resolved.status >= 500);
});

test('stream drops plaintext vidrock decoy URLs served to datacenter IPs', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://moviesapi.to/')) {
      return new Response(JSON.stringify({ result: false, message: 'Movie not yet encoded' }), { status: 404 });
    }
    if (url.startsWith('https://vidsrc.buzz/')) {
      return new Response('<html><body>no embedded config here</body></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.startsWith('https://vidrock.net/')) {
      // the datacenter decoy: same plaintext playlist for every "source"
      return new Response(JSON.stringify({
        source1: { url: 'https://vz-decoy.b-cdn.net/73baff63/playlist.m3u8', type: 'hls' },
        source2: { url: 'https://vz-decoy.b-cdn.net/73baff63/playlist.m3u8', type: 'hls' },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=19995',
    { headers: { Origin: STREAM_ENV.APP_ORIGIN } },
  ), STREAM_ENV);
  assert.equal(resolved.status, 404);
  assert.equal((await resolved.json()).error, 'STREAM_NOT_FOUND');
});

test('seal drops plaintext decoy URLs from client-fetched bodies too', async () => {
  const resolved = await handleRequest(sealRequest({
    type: 'movie', tmdb: '19995',
    vidrock: { source1: { url: 'https://vz-decoy.b-cdn.net/73baff63/playlist.m3u8', type: 'hls' } },
  }), STREAM_ENV);
  assert.equal(resolved.status, 404);
  assert.equal((await resolved.json()).error, 'STREAM_NOT_FOUND');
});

/* ---------- vidsrc.buzz resolver ---------- */

test('stream falls back to vidsrcbuzz, mints streams, serves subs', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const config = { type: 'movie', id: 'tt0137523', s: 0, e: 0, t: 'tok123' };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    if (url === 'https://moviesapi.to/api/vidora/v1/movie/550') {
      return new Response(JSON.stringify({ result: false, message: 'Movie not yet encoded' }), { status: 404 });
    }
    if (url === 'https://vidsrc.buzz/embed/movie/550') {
      return new Response('<html><script>var Q = ' + JSON.stringify(config) + ';\n</script></html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.startsWith('https://vidsrc.buzz/pl/api.php?')) {
      const api = new URL(url);
      assert.equal(headers.get('referer'), 'https://vidsrc.buzz/embed/movie/550');
      const action = api.searchParams.get('a');
      if (action === 'sources') {
        return new Response(JSON.stringify({
          status: 'ok',
          servers: [{ ref: 'refA', name: 'Server VNY' }, { ref: 'refB', name: 'Server XPM1' }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (action === 'play') {
        return new Response(JSON.stringify({ url: '/_stream?id=stream-' + api.searchParams.get('ref'), type: 'hls' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (action === 'subs') {
        return new Response(JSON.stringify({ subs: [{ label: 'English', lang: 'English', cc: 'us', ref: 'subref1' }] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (action === 'sub') {
        return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there', { headers: { 'Content-Type': 'text/vtt' } });
      }
      throw new Error('unexpected api action: ' + action);
    }
    if (url === 'https://vidsrc.buzz/_stream?id=stream-refA') {
      return new Response('#EXTM3U\n#EXTINF:4,\nseg-1.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === 'https://vidsrc.buzz/seg-1.ts') {
      return new Response(new Uint8Array([5, 5]), { headers: { 'Content-Type': 'video/mp2t' } });
    }
    if (url.startsWith('https://vidrock.net/')) throw new Error('vidrock must not be reached when vidsrcbuzz succeeds');
    throw new Error('unexpected synthetic URL: ' + url);
  };

  const headers = { Origin: STREAM_ENV.APP_ORIGIN };
  const buzzEnv = Object.assign({}, STREAM_ENV, { VIDSRCBUZZ_ENABLED: '1' });
  const resolved = await handleRequest(new Request(
    'https://worker.example.invalid/' + STREAM_ENV.ACCESS_PATH + '/stream?type=movie&tmdb=550',
    { headers },
  ), buzzEnv);
  assert.equal(resolved.status, 200);
  const data = await resolved.json();
  assert.equal(data.provider, 'vidsrcbuzz');
  assert.equal(data.sources.length, 2);
  assert.equal(data.sources[0].name, 'Server VNY');
  assert.match(data.sources[0].url, /\/media\//);
  assert.doesNotMatch(data.sources[0].url, /vidsrc\.buzz/);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].label, 'English');

  // the sealed minted stream plays through the proxy
  const manifest = await handleRequest(new Request(data.sources[0].url, { headers }), STREAM_ENV);
  assert.equal(manifest.status, 200);
  const manifestText = await manifest.text();
  assert.match(manifestText, /worker\.example\.invalid/);
  assert.doesNotMatch(manifestText, /vidsrc\.buzz/);
  const segmentUrl = manifestText.split('\n').find((line) => line && line[0] !== '#');
  const segment = await handleRequest(new Request(segmentUrl, { headers }), STREAM_ENV);
  assert.deepEqual(Array.from(new Uint8Array(await segment.arrayBuffer())), [5, 5]);

  // sealed subtitles serve through the proxy too
  const sub = await handleRequest(new Request(data.tracks[0].src, { headers }), STREAM_ENV);
  assert.equal(sub.status, 200);
  assert.match(await sub.text(), /WEBVTT/);
});
