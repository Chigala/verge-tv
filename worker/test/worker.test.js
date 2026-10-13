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
