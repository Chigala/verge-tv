#!/usr/bin/env node
/**
 * Native-player stream resolver — proof of concept for verge-tv.
 *
 * Resolves a TMDB id to a directly playable HLS URL, with a fallback chain:
 *
 *   1. moviesapi.to (VidSpark) — primary
 *      GET https://moviesapi.to/api/vidora/v1/movie/{tmdb}
 *      or  .../v1/tv/{tmdb}/{season}/{episode}
 *      Headers: x-player-key: <PLAYER_KEY>, Referer: https://moviesapi.to/...
 *      → sources[0].url is a signed m3u8 (12 h validity).
 *      ⚠ Stream requests (playlist/keys/segments) require Referer: https://moviesapi.to/
 *      ⚠ Catalog gaps return 404 {"result":false,"message":"Movie not yet encoded"}
 *        (e.g. The Incredibles 9806, Dune 2 693134 — same titles that fail in their embed).
 *
 *   2. vidrock.net — fallback (covers at least some moviesapi gaps)
 *      GET https://vidrock.net/api/movie/{tmdb}  or  .../api/tv/{tmdb}/{s}/{e}
 *      → { "<SourceName>": { url: <base64url AES-256-GCM blob>, type: "hls"|"mp4" } }
 *      Decrypt: key = hex VIDROCK_KEY_HEX (hardcoded in their bundle),
 *               blob = base64url( IV(12 bytes) ‖ ciphertext+tag ).
 *      ⚠ Header requirements vary per source: boomchick needs Referer:
 *        https://vidrock.net/ with a browser UA; Orion additionally needs
 *        Origin: https://vidrock.net. Send both headers for all sources.
 *      ⚠ Their CDN naming is NSFW-flavored (…/bigtits.m3u8) — cosmetic only, but
 *        never surface raw URLs in the app UI.
 *
 *   NOT used: vidfast.vc — its resolution API (/zirlaku/…) is encrypted AND bound
 *   to its ad-network handshake; the scrape only runs when their ad scripts execute
 *   in a real browser. Not scriptable from a worker/TV. (Verified 2026-10-15.)
 *
 * Usage:
 *   node scripts/stream-decode.mjs movie 550
 *   node scripts/stream-decode.mjs tv 66732 1 1
 *   node scripts/stream-decode.mjs movie 9806            # exercises the fallback
 *   node scripts/stream-decode.mjs movie 550 --deep      # also fetch a segment
 *   node scripts/stream-decode.mjs movie 9806 --only=vidrock
 */

const MOVIESAPI_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
const MOVIESAPI_REFERER = 'https://moviesapi.to/';
const VIDROCK_KEY_HEX = '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- provider: moviesapi.to ----------

async function resolveMoviesapi(type, tmdb, season, episode) {
  const path = type === 'tv' ? `/v1/tv/${tmdb}/${season}/${episode}` : `/v1/movie/${tmdb}`;
  const pagePath = type === 'tv' ? `/tv/${tmdb}/${season}/${episode}` : `/movie/${tmdb}`;
  const res = await fetch(`https://moviesapi.to/api/vidora${path}`, {
    headers: { 'x-player-key': MOVIESAPI_KEY, Referer: `https://moviesapi.to${pagePath}`, 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.result || !json?.sources?.[0]?.url) {
    return { ok: false, reason: json?.message || `HTTP ${res.status}` };
  }
  const src = json.sources[0];
  return {
    ok: true,
    provider: 'moviesapi',
    title: `${json.title}${json.year ? ` (${json.year})` : ''}${json.season ? ` S${json.season}E${json.episode}` : ''}`,
    url: src.url,
    referer: MOVIESAPI_REFERER, // required on ALL media requests
    tracks: (src.tracks || []).filter(t => t.file).map(t => ({ label: t.label, src: t.file })),
  };
}

// ---------- provider: vidrock.net ----------

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const m = s.length % 4;
  if (m === 2) s += '=='; else if (m === 3) s += '=';
  return Buffer.from(s, 'base64');
}

let vidrockKey = null;
async function vidrockDecrypt(blob) {
  const raw = b64urlToBytes(blob);
  if (raw.length < 28) throw new Error('ciphertext too short');
  if (!vidrockKey) {
    vidrockKey = await crypto.subtle.importKey('raw', Buffer.from(VIDROCK_KEY_HEX, 'hex'), { name: 'AES-GCM' }, false, ['decrypt']);
  }
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, vidrockKey, raw.subarray(12));
  return Buffer.from(pt).toString('utf8');
}

async function resolveVidrock(type, tmdb, season, episode) {
  const path = type === 'tv' ? `tv/${tmdb}/${season}/${episode}` : `movie/${tmdb}`;
  const res = await fetch(`https://vidrock.net/api/${path}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json !== 'object') {
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  const sources = [];
  for (const [name, val] of Object.entries(json)) {
    if (!val || typeof val !== 'object' || !val.url) continue;
    try {
      const url = await vidrockDecrypt(val.url);
      sources.push({ name, url, type: val.type === 'hls' ? 'hls' : 'mp4', language: val.language || 'Original audio' });
    } catch (e) {
      console.error(`  (vidrock: failed to decrypt source "${name}": ${e.message})`);
    }
  }
  if (!sources.length) return { ok: false, reason: 'no sources (all null or undecryptable)' };
  const preferred = sources.find(s => s.type === 'hls') || sources[0];
  return {
    ok: true,
    provider: 'vidrock',
    title: `${sources.length} source(s): ${sources.map(s => s.name).join(', ')}`,
    url: preferred.url,
    // vidrock sources vary: boomchick 403s browser-UA without Referer, Orion
    // 403s without Origin AND Referer. Sending both satisfies everything.
    referer: 'https://vidrock.net/',
    origin: 'https://vidrock.net',
    tracks: [],
    allSources: sources,
  };
}

// ---------- verification ----------

async function verifyPlaylist(result, deep) {
  const headers = { 'User-Agent': UA };
  if (result.referer) headers.Referer = result.referer;
  if (result.origin) headers.Origin = result.origin;
  const pl = await fetch(result.url, { headers, signal: AbortSignal.timeout(15000) });
  const plText = await pl.text();
  if (!pl.ok || !plText.startsWith('#EXTM3U')) {
    console.error(`✗ playlist fetch failed (HTTP ${pl.status})`);
    return false;
  }
  const variants = plText.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF')).length;
  const segments = (plText.match(/#EXTINF/g) || []).length;
  console.log(`✓ playlist OK (HTTP ${pl.status}${variants ? `, ${variants} variants` : `, ${segments} segments`})`);

  if (deep) {
    let mediaUrl = result.url;
    const variantLine = plText.split('\n').find(l => l.trim() && !l.startsWith('#'));
    if (variants && variantLine) mediaUrl = new URL(variantLine.trim(), result.url).href;
    const media = await fetch(mediaUrl, { headers, signal: AbortSignal.timeout(15000) });
    const mediaText = await media.text();
    const seg = mediaText.split('\n').find(l => l.trim() && !l.startsWith('#'));
    if (seg) {
      const segUrl = new URL(seg.trim(), mediaUrl).href;
      const segRes = await fetch(segUrl, { headers, signal: AbortSignal.timeout(20000) });
      const buf = await segRes.arrayBuffer();
      console.log(`✓ first segment OK (HTTP ${segRes.status}, ${(buf.byteLength / 1024).toFixed(0)} KB) — bytes flow, playable`);
      return segRes.ok && buf.byteLength > 1000;
    }
  }
  return true;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const [type, tmdb, season, episode] = args.filter(a => !a.startsWith('--'));
  const deep = args.includes('--deep');
  const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

  if (!type || !tmdb || !['movie', 'tv'].includes(type) || (type === 'tv' && (!season || !episode))) {
    console.error('usage: node scripts/stream-decode.mjs <movie|tv> <tmdbId> [season episode] [--deep] [--only=moviesapi|vidrock]');
    process.exit(1);
  }

  const chain = [
    ['moviesapi', resolveMoviesapi],
    ['vidrock', resolveVidrock],
  ].filter(([name]) => !only || name === only);

  let result = null;
  for (const [name, fn] of chain) {
    process.stdout.write(`→ ${name}: `);
    try {
      const r = await fn(type, tmdb, season, episode);
      if (r.ok) { console.log('resolved ✓'); result = r; break; }
      console.log(`miss (${r.reason})`);
    } catch (e) {
      console.log(`error (${e.message})`);
    }
  }

  if (!result) {
    console.error('✗ no provider had a stream — app should fall back to the embed iframe here.');
    process.exit(2);
  }

  console.log(`provider: ${result.provider}`);
  console.log(`title:    ${result.title}`);
  if (result.tracks?.length) console.log(`subs:     ${result.tracks.map(t => t.label).join(', ')}`);

  // Multi-source providers: vidrock URLs die independently — try each until one verifies.
  const candidates = result.allSources?.length
    ? result.allSources.map(s => ({ ...result, url: s.url, _name: s.name }))
    : [{ ...result, _name: null }];

  let ok = false;
  for (const c of candidates) {
    console.log(`stream:   ${c._name ? `[${c._name}] ` : ''}${c.url.slice(0, 140)}${c.url.length > 140 ? '…' : ''}`);
    console.log(`referer:  ${c.referer || 'not required'}`);
    try {
      ok = await verifyPlaylist(c, deep);
    } catch (e) {
      console.error(`✗ verify error: ${e.message}`);
      ok = false;
    }
    if (ok) break;
    if (candidates.length > 1) console.log('  → trying next source…');
  }
  process.exit(ok ? 0 : 3);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
