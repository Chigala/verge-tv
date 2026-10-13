import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserCandidateScore,
  browserMediaKind,
  browserPlaybackHeaders,
  browserResourceKind,
  extractMediaUrl,
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
