const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 20 * 60;
const UPSTREAM_AGENT = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 Safari/537.36';
const STATIC_RESOLVER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const BROWSER_TIMEOUT = Symbol('browser-timeout');
const STATIC_RESOLVER_MAX_REQUESTS = 12;
const STATIC_RESOLVER_MAX_MS = 14000;
const RESOLVER_MAX_MS = 58000;
const UPSTREAM_FETCH_MAX_MS = 8000;
const UPSTREAM_BODY_MAX_MS = 5000;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return safeError('METHOD_NOT_ALLOWED', 405, cors);
  }

  const accessPath = normalizeAccessPath(env.ACCESS_PATH);
  if (!accessPath || !env.TRAILER_URL_TEMPLATE) {
    return safeError('WORKER_NOT_CONFIGURED', 503, cors);
  }

  const rootPath = '/' + accessPath;
  if (requestUrl.pathname === rootPath + '/health') {
    return json({ ok: true }, 200, cors);
  }
  if (requestUrl.pathname === rootPath + '/embed') {
    if (!originAllowed(request, env)) return safeError('ORIGIN_NOT_ALLOWED', 403, cors);
    return redirectToPlayer(request, env, cors);
  }
  if (requestUrl.pathname === rootPath + '/player') {
    if (!originAllowed(request, env)) return safeError('ORIGIN_NOT_ALLOWED', 403, cors);
    return disclosePlayerUrl(request, env, cors);
  }
  if (requestUrl.pathname === rootPath + '/resolve') {
    if (!env.PLAYBACK_TOKEN_SECRET) return safeError('WORKER_NOT_CONFIGURED', 503, cors);
    if (!originAllowed(request, env)) return safeError('ORIGIN_NOT_ALLOWED', 403, cors);
    return resolveTrailer(request, env, rootPath, cors);
  }
  if (requestUrl.pathname.indexOf(rootPath + '/media/') === 0) {
    if (!env.PLAYBACK_TOKEN_SECRET) return safeError('WORKER_NOT_CONFIGURED', 503, cors);
    if (!originAllowed(request, env)) return safeError('ORIGIN_NOT_ALLOWED', 403, cors);
    return proxyMedia(request, env, rootPath, cors);
  }
  return safeError('NOT_FOUND', 404, cors);
}

function configuredPlayerUrl(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const tmdb = url.searchParams.get('tmdb') || '';
  const imdb = url.searchParams.get('imdb') || '';
  const title = (url.searchParams.get('title') || '').slice(0, 300);
  const year = url.searchParams.get('year') || '';
  const startAt = url.searchParams.get('startAt') || url.searchParams.get('t') || '';

  if (type !== 'movie' && type !== 'tv') throw codedError('INVALID_MEDIA_TYPE', 400);
  if (!/^\d{1,12}$/.test(tmdb)) throw codedError('INVALID_TMDB_ID', 400);
  if (imdb && !/^tt\d{5,12}$/i.test(imdb)) throw codedError('INVALID_IMDB_ID', 400);
  if (year && !/^\d{4}$/.test(year)) throw codedError('INVALID_YEAR', 400);
  if (startAt && !/^\d{1,10}$/.test(startAt)) throw codedError('INVALID_START_TIME', 400);

  const destination = assertSafeUpstreamUrl(
    fillTemplate(env.TRAILER_URL_TEMPLATE, { type, tmdb, imdb, title, year }),
    env,
  );
  if (startAt) destination.searchParams.set('startAt', startAt);
  return destination;
}

function redirectToPlayer(request, env, cors) {
  let destination;
  try { destination = configuredPlayerUrl(request, env); }
  catch (error) { return safeError(errorCode(error, 'INVALID_TEMPLATE'), statusForError(error, 500), cors); }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function disclosePlayerUrl(request, env, cors) {
  try {
    return json({ url: configuredPlayerUrl(request, env).toString() }, 200, cors);
  } catch (error) {
    return safeError(errorCode(error, 'INVALID_TEMPLATE'), statusForError(error, 500), cors);
  }
}

async function resolveTrailer(request, env, rootPath, cors) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const tmdb = url.searchParams.get('tmdb') || '';
  const imdb = url.searchParams.get('imdb') || '';
  const title = (url.searchParams.get('title') || '').slice(0, 300);
  const year = url.searchParams.get('year') || '';

  if (type !== 'movie' && type !== 'tv') return safeError('INVALID_MEDIA_TYPE', 400, cors);
  if (!/^\d{1,12}$/.test(tmdb)) return safeError('INVALID_TMDB_ID', 400, cors);
  if (imdb && !/^tt\d{5,12}$/i.test(imdb)) return safeError('INVALID_IMDB_ID', 400, cors);
  if (year && !/^\d{4}$/.test(year)) return safeError('INVALID_YEAR', 400, cors);

  let sourceUrl;
  try {
    sourceUrl = fillTemplate(env.TRAILER_URL_TEMPLATE, { type, tmdb, imdb, title, year });
    assertSafeUpstreamUrl(sourceUrl, env);
  } catch (error) {
    return safeError(errorCode(error, 'INVALID_TEMPLATE'), 500, cors);
  }

  let resolved;
  try {
    resolved = await browserWithin(resolveMediaWithBrowserFallback(sourceUrl, env), RESOLVER_MAX_MS);
    if (resolved === BROWSER_TIMEOUT) throw codedError('RESOLVER_TIMEOUT', 504);
  } catch (error) {
    return safeError(errorCode(error, 'UPSTREAM_UNAVAILABLE'), statusForError(error), cors);
  }

  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = {
    u: resolved.url,
    e: expires,
    h: resolved.headers,
  };
  const token = await sealPayload(payload, env.PLAYBACK_TOKEN_SECRET);
  const filename = resolved.kind === 'hls' ? 'master.m3u8' : mediaFilename(resolved.url, 'trailer.mp4');
  const playbackUrl = new URL(request.url);
  playbackUrl.pathname = rootPath + '/media/' + token + '/' + filename;
  playbackUrl.search = '';

  return json({ url: playbackUrl.toString(), type: resolved.kind, expiresAt: expires }, 200, cors);
}

export function fillTemplate(template, values) {
  const input = String(template || '').trim();
  if (!input) throw codedError('MISSING_TEMPLATE');
  if (!/\{\w+\}/.test(input)) return input + values.tmdb;

  const allowed = {
    type: values.type || '',
    tmdb: values.tmdb || '',
    imdb: values.imdb || '',
    title: values.title || '',
    year: values.year || '',
  };
  const output = input.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(allowed, name)) throw codedError('UNKNOWN_TEMPLATE_FIELD');
    if (!allowed[name]) throw codedError('MISSING_TEMPLATE_VALUE');
    return encodeURIComponent(allowed[name]);
  });
  return output;
}

async function resolveMedia(sourceUrl, env) {
  const page = await fetchWithSession(sourceUrl, env);
  const response = page.response;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  const responseUrl = response.url || page.url;

  assertSafeUpstreamUrl(responseUrl, env);
  if (isHls(type, responseUrl)) {
    return { url: responseUrl, kind: 'hls', headers: playbackHeaders(page) };
  }
  if (isVideo(type, responseUrl)) {
    return { url: responseUrl, kind: 'video', headers: playbackHeaders(page) };
  }
  if (!response.ok) throw codedError('UPSTREAM_HTTP_' + response.status, response.status);

  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_TEXT_BYTES) throw codedError('SOURCE_PAGE_TOO_LARGE', 502);
  const text = await browserWithin(response.text(), UPSTREAM_BODY_MAX_MS);
  if (text === BROWSER_TIMEOUT) throw codedError('UPSTREAM_TIMEOUT', 504);
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
    throw codedError('SOURCE_PAGE_TOO_LARGE', 502);
  }
  if (looksInteractive(text)) throw codedError('SOURCE_REQUIRES_INTERACTION', 409);

  const mediaUrl = extractMediaUrl(text, responseUrl);
  if (!mediaUrl) throw codedError('NO_PLAYABLE_MEDIA', 404);
  assertSafeUpstreamUrl(mediaUrl, env);
  return {
    url: mediaUrl,
    kind: /\.m3u8(?:[?#]|$)/i.test(mediaUrl) ? 'hls' : 'video',
    headers: playbackHeaders(page),
  };
}

async function resolveMediaWithBrowserFallback(sourceUrl, env) {
  try {
    return await resolveMedia(sourceUrl, env);
  } catch (error) {
    if (errorCode(error, '') !== 'NO_PLAYABLE_MEDIA') throw error;
  }

  try {
    return await resolveMultiHopMedia(sourceUrl, env);
  } catch (error) {
    if (errorCode(error, '') !== 'NO_PLAYABLE_MEDIA') throw error;
  }

  if (!env.BROWSER) throw codedError('BROWSER_RUN_NOT_CONFIGURED', 503);
  return resolveMediaInBrowser(sourceUrl, env);
}

async function resolveMultiHopMedia(sourceUrl, env) {
  const deadline = Date.now() + STATIC_RESOLVER_MAX_MS;
  const session = { cookies: [] };
  const queue = [{ url: sourceUrl, referer: '', depth: 0 }];
  const seen = new Set();
  let requests = 0;

  while (queue.length && requests < STATIC_RESOLVER_MAX_REQUESTS && Date.now() < deadline) {
    const item = queue.shift();
    if (!item || item.depth > 6 || seen.has(item.url)) continue;
    seen.add(item.url);

    let target;
    try { target = assertSafeUpstreamUrl(item.url, env); } catch (_) { continue; }

    let response;
    try {
      response = await fetchStaticHop(target.toString(), item.referer, session, env);
      requests++;
    } catch (_) {
      requests++;
      continue;
    }

    const responseUrl = response.url || target.toString();
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const responseKind = browserMediaKind(responseUrl, type);
    if (responseKind) {
      return staticMediaResult(responseUrl, responseKind, item.referer || sourceUrl, session);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      const next = normalizeStaticUrl(location, responseUrl);
      if (next) {
        const kind = browserMediaKind(next, '');
        if (kind) return staticMediaResult(next, kind, responseUrl, session);
        queue.unshift({ url: next, referer: responseUrl, depth: item.depth + 1 });
      }
      continue;
    }
    if (!response.ok) continue;

    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_TEXT_BYTES) continue;
    let text;
    try { text = await browserWithin(response.text(), Math.min(UPSTREAM_BODY_MAX_MS, Math.max(1, deadline - Date.now()))); } catch (_) { continue; }
    if (text === BROWSER_TIMEOUT) continue;
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) continue;
    if (/^\s*#EXTM3U(?:\s|$)/i.test(text)) {
      return staticMediaResult(responseUrl, 'hls', item.referer || sourceUrl, session);
    }

    const direct = extractMediaUrl(text, responseUrl) || extractEncodedMediaUrl(text, responseUrl);
    if (direct) {
      try { assertSafeUpstreamUrl(direct, env); } catch (_) { continue; }
      await warmStaticPassPath(text, responseUrl, session, env, deadline);
      return staticMediaResult(
        direct,
        /\.m3u8(?:[?#]|$)/i.test(direct) ? 'hls' : 'video',
        responseUrl,
        session,
      );
    }

    const templatedMedia = extractTemplateMediaCandidates(text, responseUrl);
    for (let index = templatedMedia.length - 1; index >= 0; index--) {
      const candidate = templatedMedia[index];
      if (!seen.has(candidate)) queue.unshift({ url: candidate, referer: responseUrl, depth: item.depth + 1 });
    }
    const candidates = extractStaticHopCandidates(text, responseUrl);
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      queue.push({ url: candidate, referer: responseUrl, depth: item.depth + 1 });
    }
  }

  throw codedError('NO_PLAYABLE_MEDIA', 404);
}

// Playerjs pages can publish URLs with {v1}/{v2} placeholders and list
// the eligible tmstr hosts separately. Expand only page-provided hosts.
export function extractTemplateMediaCandidates(input, baseUrl) {
  const text = decodePageEscapes(String(input || ''));
  const suffixes = [];
  const hostPattern = /https:\/\/(tmstr\d*\.[a-z0-9.-]+)/gi;
  let match;
  while ((match = hostPattern.exec(text)) && suffixes.length < 12) {
    const hostname = match[1].toLowerCase();
    const dot = hostname.indexOf('.');
    const suffix = dot >= 0 ? hostname.slice(dot + 1) : '';
    if (suffix && !suffixes.includes(suffix)) suffixes.push(suffix);
  }
  if (!suffixes.length) return [];

  const output = [];
  const fields = /\bfile\s*:\s*["']([^"']{1,32768})["']/gi;
  while ((match = fields.exec(text)) && output.length < 24) {
    const alternatives = match[1].split(/\s+or\s+/i).slice(0, 12);
    for (const alternative of alternatives) {
      if (!/\{v\d+\}/i.test(alternative)) continue;
      for (const suffix of suffixes) {
        const expanded = alternative.replace(/\{v\d+\}/gi, suffix);
        const url = normalizeStaticUrl(expanded, baseUrl);
        if (url && !output.includes(url)) output.push(url);
        if (output.length >= 24) break;
      }
      if (output.length >= 24) break;
    }
  }
  return output;
}

async function fetchStaticHop(url, referer, session, env) {
  assertSafeUpstreamUrl(url, env);
  const headers = new Headers({
    Accept: 'text/html,application/xhtml+xml,application/json,text/javascript,application/javascript,*/*;q=0.7',
    'User-Agent': STATIC_RESOLVER_AGENT,
  });
  const cookie = staticCookieHeader(session.cookies, url);
  if (cookie) headers.set('Cookie', cookie);
  if (referer) headers.set('Referer', referer);
  const options = { headers, redirect: 'manual' };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    options.signal = AbortSignal.timeout(5000);
  }
  const response = await fetch(url, options);
  absorbStaticCookies(response.headers, new URL(url), session.cookies);
  return response;
}

function staticMediaResult(url, kind, referer, session) {
  const headers = { referer, 'user-agent': STATIC_RESOLVER_AGENT };
  try { headers.origin = new URL(referer).origin; } catch (_) {}
  const cookie = staticCookieHeader(session.cookies, url);
  if (cookie) headers.cookie = cookie;
  return { url, kind, headers };
}

async function warmStaticPassPath(text, baseUrl, session, env, deadline) {
  if (Date.now() >= deadline) return;
  const match = String(text || '').match(/\bpass_path\s*=\s*["']([^"']+)["']/i);
  const url = match ? normalizeStaticUrl(match[1], baseUrl) : '';
  if (!url) return;
  try { await fetchStaticHop(url, baseUrl, session, env); } catch (_) {}
}

function extractStaticHopCandidates(input, baseUrl) {
  const text = decodePageEscapes(String(input || ''));
  const priority = [];
  const output = [];
  const addTo = (list, value) => {
    const url = normalizeStaticUrl(value, baseUrl);
    if (url && !priority.includes(url) && !output.includes(url)) list.push(url);
  };
  const add = (value) => addTo(output, value);
  const addPriority = (value) => addTo(priority, value);
  let match;

  const embedded = /<(?:iframe|source)[^>]+\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((match = embedded.exec(text)) && output.length < 30) add(match[1]);

  const dataLink = /\b(?:data-src|data-url|data-link|data-redirect)\s*=\s*["']([^"']+)["']/gi;
  while ((match = dataLink.exec(text)) && output.length < 30) add(match[1]);

  const assigned = /\b(?:url|src|source|redirect|location|endpoint)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = assigned.exec(text)) && output.length < 30) add(match[1]);

  const scripts = /<script[^>]+\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((match = scripts.exec(text)) && output.length < 30) {
    if (/(?:player|embed|stream|source|rcp|api)/i.test(match[1])) add(match[1]);
  }

  const hashes = [];
  const hashPattern = /\bdata-hash\s*=\s*["']([^"']{2,512})["']/gi;
  while ((match = hashPattern.exec(text)) && hashes.length < 8) hashes.push(match[1]);
  for (const hash of hashes) {
    if (/^https?:\/\//i.test(hash) || hash.startsWith('//')) {
      addPriority(hash);
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(hash)) continue;
    try {
      const base = new URL(baseUrl);
      const root = registrableHostGuess(base.hostname);
      if (root && base.hostname !== 'rcp.' + root) addPriority('https://rcp.' + root + '/rcp/' + hash);
      addPriority('/rcp/' + hash);
      const withoutWww = base.hostname.replace(/^www\./i, '');
      if (withoutWww && withoutWww !== root && !withoutWww.startsWith('rcp.')) {
        addPriority('https://rcp.' + withoutWww + '/rcp/' + hash);
      }
    } catch (_) {}
  }

  const encodedValues = [];
  const seeds = [];
  const encodedPattern = /\bdata-h(?!ash)\s*=\s*["']([0-9a-f]+)["']/gi;
  const seedPattern = /\bdata-i\s*=\s*["']([^"']{1,512})["']/gi;
  while ((match = encodedPattern.exec(text)) && encodedValues.length < 4) encodedValues.push(match[1]);
  while ((match = seedPattern.exec(text)) && seeds.length < 4) seeds.push(match[1]);
  for (const encoded of encodedValues) {
    for (const seed of seeds) {
      const decoded = decodeHexXor(encoded, seed);
      for (const url of staticUrlsFromValue(decoded, baseUrl)) addPriority(url);
    }
  }

  const hunter = decodeHunterPacked(text);
  if (hunter) for (const url of staticUrlsFromValue(hunter, baseUrl)) addPriority(url);
  for (const decoded of decodeEmbeddedStrings(text)) {
    for (const url of staticUrlsFromValue(decoded, baseUrl)) addPriority(url);
  }
  return priority.concat(output).slice(0, 30);
}

export function extractEncodedMediaUrl(input, baseUrl) {
  const values = decodeEmbeddedStrings(input);
  const hunter = decodeHunterPacked(input);
  if (hunter) values.unshift(hunter);
  for (const value of values) {
    const media = extractMediaUrl(value, baseUrl);
    if (media) return media;
    const url = normalizeStaticUrl(value.trim(), baseUrl);
    if (url && browserMediaKind(url, '')) return url;
  }
  return '';
}

function staticUrlsFromValue(value, baseUrl) {
  const text = decodePageEscapes(String(value || '')).trim();
  const output = [];
  const add = (candidate) => {
    const url = normalizeStaticUrl(candidate, baseUrl);
    if (url && !output.includes(url)) output.push(url);
  };
  if (/^(?:https?:)?\/\//i.test(text) || /^(?:\.\.\/|\.\/|\/)/.test(text)) add(text);
  let match;
  const absolute = /https?:\/\/[^"'\s<>\\]+/gi;
  while ((match = absolute.exec(text)) && output.length < 12) add(match[0]);
  const assigned = /\b(?:file|url|src|source|redirect|location)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = assigned.exec(text)) && output.length < 12) add(match[1]);
  return output;
}

function normalizeStaticUrl(value, baseUrl) {
  if (!value) return '';
  let input = decodePageEscapes(String(value)).trim().replace(/&amp;/gi, '&');
  input = input.replace(/^['"]|['"]$/g, '').replace(/[),;]+$/, '');
  if (!input || /^(?:javascript|data|blob):/i.test(input)) return '';
  try {
    const url = new URL(input, baseUrl);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function registrableHostGuess(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  const multipart = parts[parts.length - 1].length === 2 && /^(?:ac|co|com|edu|gov|net|org)$/.test(parts[parts.length - 2]);
  return parts.slice(multipart && parts.length >= 3 ? -3 : -2).join('.');
}

function decodeEmbeddedStrings(input) {
  const text = decodePageEscapes(String(input || ''));
  const encoded = [];
  let match;
  const fields = /\b(?:file|src|source|url|hls|playlist|manifest)\s*[:=]\s*["']([^"']{12,16384})["']/gi;
  while ((match = fields.exec(text)) && encoded.length < 40) encoded.push(match[1]);
  const quoted = /["']([a-zA-Z0-9+/_=-]{20,16384}(?:#2)?)["']/g;
  while ((match = quoted.exec(text)) && encoded.length < 40) encoded.push(match[1]);
  const tokens = /(?:^|[^a-zA-Z0-9+/_-])([a-zA-Z0-9+/_-]{32,8192}={0,2})(?=$|[^a-zA-Z0-9+/_=-])/g;
  while ((match = tokens.exec(text)) && encoded.length < 40) encoded.push(match[1]);

  const output = [];
  for (const original of encoded) {
    const variants = [original.replace(/#2/gi, '')];
    const prefixed = original.match(/^\/\/[^=]{1,128}=(.+)$/);
    if (prefixed) variants.push(prefixed[1].replace(/#2/gi, ''));
    for (const variant of variants) {
      let current = variant;
      for (let depth = 0; depth < 3; depth++) {
        const decoded = decodeBase64Text(current);
        if (!decoded || output.includes(decoded)) break;
        output.push(decoded);
        current = decoded.trim();
      }
    }
  }
  return output;
}

export function decodeBase64Text(value) {
  let input = String(value || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (input.length < 12 || input.length > 16384 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(input)) return '';
  input += '='.repeat((4 - input.length % 4) % 4);
  try {
    const binary = atob(input);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    let printable = 0;
    for (const character of decoded) {
      const code = character.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
    }
    return decoded && printable / decoded.length >= 0.85 ? decoded : '';
  } catch (_) {
    return '';
  }
}

export function decodeHexXor(encoded, seed) {
  const hex = String(encoded || '');
  const key = String(seed || '');
  if (!key || key.length > 512 || !/^(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > 32768) return '';
  let output = '';
  for (let index = 0; index < hex.length; index += 2) {
    output += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16) ^ key.charCodeAt((index / 2) % key.length));
  }
  return output;
}

export function decodeHunterPacked(input) {
  const text = String(input || '');
  const expression = /escape\s*\(\s*r\s*\)\s*\)\s*\}\s*\(\s*([\s\S]{1,131072}?)\s*\)/g;
  let match;
  while ((match = expression.exec(text))) {
    const args = parsePackedArguments(match[1]);
    if (args.length !== 6) continue;
    const decoded = hunterDecode(args[0], args[1], args[2], args[3], args[4], args[5]);
    if (decoded) return decoded;
  }
  return '';
}

function parsePackedArguments(input) {
  const pieces = [];
  let token = '';
  let quote = '';
  let escaped = false;
  for (const character of String(input || '')) {
    if (escaped) { token += character; escaped = false; continue; }
    if (quote && character === '\\') { token += character; escaped = true; continue; }
    if (quote) {
      token += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; token += character; continue; }
    if (character === ',') { pieces.push(token.trim()); token = ''; continue; }
    token += character;
  }
  pieces.push(token.trim());
  if (pieces.length !== 6) return [];
  return pieces.map((piece) => {
    if (/^-?\d+$/.test(piece)) return Number(piece);
    if ((piece[0] === '"' && piece[piece.length - 1] === '"') || (piece[0] === "'" && piece[piece.length - 1] === "'")) {
      return decodePackedString(piece.slice(1, -1));
    }
    return piece;
  });
}

function decodePackedString(value) {
  return String(value || '')
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([\\'"/])/g, '$1');
}

function hunterDecode(h, _u, n, t, e, _r) {
  h = String(h || '');
  n = String(n || '');
  t = Number(t);
  e = Number(e);
  if (!h || !n || !Number.isInteger(t) || !Number.isInteger(e) || e < 2 || e > 62 || n.length <= e || h.length > 131072) return '';
  const delimiter = n[e];
  let output = '';
  for (const chunk of h.split(delimiter)) {
    if (!chunk) continue;
    let numeric = chunk;
    for (let index = 0; index < n.length; index++) numeric = numeric.split(n[index]).join(String(index));
    const code = hunterNumber(numeric, e, 10) - t;
    if (!Number.isInteger(code) || code < 0 || code > 65535) return '';
    output += String.fromCharCode(code);
    if (output.length > MAX_TEXT_BYTES) return '';
  }
  return output;
}

function hunterNumber(value, fromBase, toBase) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
  const source = alphabet.slice(0, fromBase);
  const target = alphabet.slice(0, toBase);
  let number = 0;
  const reversed = String(value || '').split('').reverse();
  for (let index = 0; index < reversed.length; index++) {
    const position = source.indexOf(reversed[index]);
    if (position >= 0) number += position * fromBase ** index;
  }
  let converted = '';
  while (number > 0) {
    converted = target[number % toBase] + converted;
    number = Math.floor(number / toBase);
  }
  return Number.parseInt(converted, 10) || 0;
}

function absorbStaticCookies(headers, requestUrl, jar) {
  let values = [];
  if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie();
  else if (typeof headers.getAll === 'function') values = headers.getAll('Set-Cookie');
  else if (headers.get('set-cookie')) values = splitSetCookie(headers.get('set-cookie'));

  for (const value of values.slice(0, 30)) {
    const parts = String(value).split(';');
    const first = parts.shift() || '';
    const equal = first.indexOf('=');
    if (equal <= 0) continue;
    const cookie = {
      name: first.slice(0, equal).trim(),
      value: first.slice(equal + 1).trim(),
      domain: requestUrl.hostname.toLowerCase(),
      hostOnly: true,
      path: '/',
      secure: false,
    };
    let remove = false;
    for (const attribute of parts) {
      const separator = attribute.indexOf('=');
      const name = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
      const content = separator < 0 ? '' : attribute.slice(separator + 1).trim();
      if (name === 'domain') {
        const domain = content.toLowerCase().replace(/^\./, '');
        if (domain && (requestUrl.hostname === domain || requestUrl.hostname.endsWith('.' + domain))) {
          cookie.domain = domain;
          cookie.hostOnly = false;
        }
      } else if (name === 'path' && content.startsWith('/')) cookie.path = content;
      else if (name === 'secure') cookie.secure = true;
      else if (name === 'max-age' && Number(content) <= 0) remove = true;
      else if (name === 'expires' && Number.isFinite(Date.parse(content)) && Date.parse(content) <= Date.now()) remove = true;
    }
    const matches = (item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path;
    for (let index = jar.length - 1; index >= 0; index--) if (matches(jar[index])) jar.splice(index, 1);
    if (!remove && cookie.name && cookie.name.length <= 256 && cookie.value.length <= 8192) jar.push(cookie);
    if (jar.length > 50) jar.splice(0, jar.length - 50);
  }
}

function staticCookieHeader(jar, value) {
  let url;
  try { url = new URL(value); } catch (_) { return ''; }
  const host = url.hostname.toLowerCase();
  return jar.filter((cookie) => {
    const domain = cookie.hostOnly ? host === cookie.domain : (host === cookie.domain || host.endsWith('.' + cookie.domain));
    return domain && url.pathname.startsWith(cookie.path) && (!cookie.secure || url.protocol === 'https:');
  }).map((cookie) => cookie.name + '=' + cookie.value).join('; ');
}

async function resolveMediaInBrowser(sourceUrl, env) {
  let browser;
  let page;
  try {
    browser = await launchBrowser(env.BROWSER);
    const candidates = [];
    const evidence = {};
    const pages = new Set();
    const pendingInspections = new Set();

    const watchPage = (target) => {
      if (!target || pages.has(target)) return;
      pages.add(target);
      target.on('request', (request) => {
        trackBrowserInspection(
          inspectBrowserRequest(request, candidates, evidence).catch(() => {}),
          pendingInspections,
        );
      });
      target.on('response', (response) => {
        trackBrowserInspection(
          inspectBrowserResponse(response, candidates, evidence).catch(() => {}),
          pendingInspections,
        );
      });
      target.on('websocket', (socket) => {
        socket.on('framereceived', (event) => {
          try {
            const baseUrl = socket.url() || target.url() || sourceUrl;
            const value = typeof event.payload === 'string' ? event.payload : '';
            const media = extractMediaUrl(value, baseUrl) || extractEncodedMediaUrl(value, baseUrl);
            if (!media) return;
            const kind = /\.m3u8(?:[?#]|$)/i.test(media) ? 'hls' : 'video';
            addBrowserCandidate(candidates, media, kind, { Referer: target.url() || sourceUrl });
          } catch (_) {}
        });
      });
      target.on('close', () => pages.delete(target));
    };

    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.context().on('page', watchPage);
    watchPage(page);

    let navigationFailed = false;
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (_) {
      navigationFailed = true;
    }

    await delay(1500);
    for (let attempt = 0; attempt < 5 && !candidates.length; attempt++) {
      if (await browserShowsChallenge(pages)) throw codedError('SOURCE_REQUIRES_INTERACTION', 409);
      await inspectBrowserDom(pages, candidates);
      await activateBrowserPlayers(pages, attempt);
      await delay(attempt === 0 ? 2500 : 3500);
    }
    await inspectBrowserDom(pages, candidates);
    await browserWithin(Promise.allSettled(Array.from(pendingInspections)), 2500);
    if (await browserShowsChallenge(pages)) throw codedError('SOURCE_REQUIRES_INTERACTION', 409);

    const selected = selectBrowserCandidate(candidates);
    if (!selected) {
      if (evidence.dash) throw codedError('UNSUPPORTED_STREAM_FORMAT', 415);
      if (evidence.segment) throw codedError('PLAYLIST_NOT_OBSERVED', 502);
      throw codedError(navigationFailed ? 'BROWSER_NAVIGATION_FAILED' : 'NO_PLAYABLE_MEDIA', navigationFailed ? 502 : 404);
    }
    assertSafeUpstreamUrl(selected.url, env);
    return { url: selected.url, kind: selected.kind, headers: selected.headers };
  } catch (error) {
    if (error && error.code) throw error;
    const message = String(error && error.message || '').toLowerCase();
    if (message.includes('429') || message.includes('time limit')) {
      throw codedError('BROWSER_RUN_LIMIT_REACHED', 429);
    }
    throw codedError('BROWSER_RUN_FAILED', 502);
  } finally {
    if (page) { try { await browserWithin(page.close(), 1500); } catch (_) {} }
    if (browser) { try { await browserWithin(browser.close(), 2000); } catch (_) {} }
  }
}

async function inspectBrowserDom(pages, candidates) {
  for (const page of pages) {
    let frames = [];
    try { frames = page.frames(); } catch (_) { continue; }
    for (const frame of frames) {
      if (/(?:captcha|challenge|recaptcha|hcaptcha|challenge-platform)/i.test(frame.url() || '')) continue;
      try {
        const snapshot = await browserWithin(frame.evaluate(() => {
          const media = Array.from(document.querySelectorAll('video,source')).map((element) =>
            element.currentSrc || element.src || element.getAttribute('src') || ''
          );
          const scripts = Array.from(document.scripts).map((script) => script.textContent || '').join('\n');
          return { media, scripts: scripts.slice(0, 512 * 1024) };
        }), 1500);
        if (snapshot === BROWSER_TIMEOUT || !snapshot) continue;
        for (const value of snapshot.media || []) {
          const kind = browserMediaKind(value, '');
          if (kind) addBrowserCandidate(candidates, value, kind, { Referer: frame.url() || page.url() });
        }
        const encoded = String(snapshot.scripts || '');
        const media = extractMediaUrl(encoded, frame.url()) || extractEncodedMediaUrl(encoded, frame.url());
        if (media) {
          addBrowserCandidate(
            candidates,
            media,
            /\.m3u8(?:[?#]|$)/i.test(media) ? 'hls' : 'video',
            { Referer: frame.url() || page.url() },
          );
        }
      } catch (_) {}
    }
  }
}

function trackBrowserInspection(inspection, pendingInspections) {
  pendingInspections.add(inspection);
  inspection.finally(() => pendingInspections.delete(inspection));
}

let browserLibrary;

async function launchBrowser(binding) {
  browserLibrary ||= import('@cloudflare/playwright');
  const { launch } = await browserLibrary;
  return launch(binding);
}

async function inspectBrowserRequest(request, candidates, evidence) {
  noteBrowserEvidence(evidence, request.url(), '');
  const kind = browserMediaKind(request.url(), '');
  if (!kind) return;
  addBrowserCandidate(candidates, request.url(), kind, await readBrowserHeaders(request));
}

async function inspectBrowserResponse(response, candidates, evidence) {
  const url = response.url();
  const responseHeaders = await readBrowserHeaders(response);
  const contentType = String(responseHeaders['content-type'] || '');
  noteBrowserEvidence(evidence, url, contentType);
  const requestHeaders = await readBrowserHeaders(response.request());
  const kind = browserMediaKind(url, contentType);
  if (kind) {
    addBrowserCandidate(candidates, url, kind, requestHeaders);
    return;
  }

  const resourceType = response.request().resourceType();
  if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
  if (!/(?:json|javascript|text\/plain)/i.test(contentType)) return;
  const length = Number(responseHeaders['content-length'] || 0);
  if (length > 512 * 1024) return;
  const body = await browserWithin(response.text(), 1800);
  if (body === BROWSER_TIMEOUT || typeof body !== 'string') return;
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) return;
  const extracted = extractMediaUrl(body, url);
  if (!extracted) return;
  addBrowserCandidate(
    candidates,
    extracted,
    /\.m3u8(?:[?#]|$)/i.test(extracted) ? 'hls' : 'video',
    requestHeaders,
  );
}

async function readBrowserHeaders(source) {
  if (source && typeof source.allHeaders === 'function') return await source.allHeaders();
  if (source && typeof source.headers === 'function') return await source.headers();
  return {};
}

export function browserMediaKind(url, contentType) {
  const kind = browserResourceKind(url, contentType);
  if (kind === 'hls' || kind === 'video') return kind;
  return '';
}

export function browserResourceKind(url, contentType) {
  if (/\.m3u8(?:[?#]|$)/i.test(url || '') || /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType || '')) return 'hls';
  if (/\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(url || '') || /video\/(?:mp4|webm|quicktime)/i.test(contentType || '')) return 'video';
  if (/\.mpd(?:[?#]|$)/i.test(url || '') || /application\/dash\+xml/i.test(contentType || '')) return 'dash';
  if (/\.(?:m4s|ts|aac|m4a|cmfv|cmfa)(?:[?#]|$)/i.test(url || '') || /video\/mp2t/i.test(contentType || '')) return 'segment';
  return '';
}

function noteBrowserEvidence(evidence, url, contentType) {
  const kind = browserResourceKind(url, contentType);
  if (kind) evidence[kind] = true;
}

function addBrowserCandidate(candidates, url, kind, requestHeaders) {
  if (!/^https:\/\//i.test(url || '')) return;
  if (candidates.some((candidate) => candidate.url === url)) return;
  candidates.push({
    url,
    kind,
    headers: browserPlaybackHeaders(requestHeaders),
    score: browserCandidateScore(url, kind),
  });
  if (candidates.length > 24) candidates.sort((a, b) => b.score - a.score).length = 24;
}

export function browserCandidateScore(url, kind) {
  const value = String(url || '').toLowerCase();
  let score = kind === 'hls' ? 100 : 60;
  if (/(?:^|[\W_])(?:ad|ads|advert|preroll|tracking)(?:[\W_]|$)/i.test(value)) score -= 80;
  if (/(?:trailer|movie|episode|stream|master|playlist|manifest)/i.test(value)) score += 20;
  return score;
}

function selectBrowserCandidate(candidates) {
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => b.score - a.score)[0];
}

export function browserPlaybackHeaders(input) {
  const source = input || {};
  const output = {};
  const allowed = ['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent'];
  for (const name of Object.keys(source)) {
    const lower = name.toLowerCase();
    if (!allowed.includes(lower) && !lower.startsWith('x-')) continue;
    if (lower.startsWith('x-forwarded-') || lower.startsWith('x-real-') || lower.startsWith('x-vercel-')) continue;
    const value = String(source[name] || '');
    if (value && value.length <= 8192) output[lower] = value;
  }
  return output;
}

async function browserShowsChallenge(pages) {
  for (const page of pages) {
    let frames = [];
    try { frames = page.frames(); } catch (_) { continue; }
    for (const frame of frames) {
      if (/(?:captcha|challenge|recaptcha|hcaptcha|challenge-platform)/i.test(frame.url() || '')) return true;
      try {
        const blocked = await browserWithin(frame.evaluate(() => {
          const text = String(document.body && document.body.innerText || '').slice(0, 10000).toLowerCase();
          return text.includes('confirm you are not a robot') ||
            text.includes('verify you are human') ||
            text.includes('checking your browser') ||
            text.includes('security verification') ||
            !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], [class*="captcha"], input[name="cf-turnstile-response"]');
        }), 1500);
        if (blocked) return true;
      } catch (_) {}
    }
  }
  return false;
}

async function activateBrowserPlayers(pages, attempt) {
  const serverSelectors = [
    '[data-hash]',
    '[data-server]',
    '[data-source]',
    '[class*="server" i]',
    '[class*="source" i]',
  ];
  const selectors = [
    '.vjs-big-play-button',
    '.jw-display-icon-container',
    '.jw-icon-playback',
    '.plyr__control--overlaid',
    '[data-plyr="play"]',
    'button[aria-label*="play" i]',
    '[title*="play" i]',
    '[class*="play-button" i]',
    '[class*="play_btn" i]',
    '[class*="play-btn" i]',
    '[class~="play" i]',
    '[id*="play" i]',
    '[data-action*="play" i]',
    'button:has-text("Play")',
  ];
  for (const page of pages) {
    let frames = [];
    try { frames = page.frames(); } catch (_) { continue; }
    for (const frame of frames) {
      if (/(?:captcha|challenge|recaptcha|hcaptcha|challenge-platform)/i.test(frame.url() || '')) continue;
      try {
        await browserWithin(frame.evaluate(() => {
          const videos = Array.from(document.querySelectorAll('video'));
          for (const video of videos) video.muted = true;
        }), 1500);
      } catch (_) {}

      for (const selector of serverSelectors) {
        try {
          const choices = frame.locator(selector);
          const count = Math.min(await choices.count(), 8);
          if (!count) continue;
          const target = choices.nth(attempt % count);
          if (await target.isVisible()) {
            await target.click({ force: true, timeout: 1200 });
            await delay(250);
            break;
          }
        } catch (_) {}
      }

      let clicked = false;
      for (const selector of selectors) {
        try {
          const target = frame.locator(selector).first();
          if (await target.count() && await target.isVisible()) {
            await target.click({ force: true, timeout: 1200 });
            clicked = true;
            break;
          }
        } catch (_) {}
      }
      if (!clicked) {
        try {
          const target = frame.locator('video').first();
          if (await target.count() && await target.isVisible()) {
            await target.click({ force: true, timeout: 1200 });
          }
        } catch (_) {}
      }
      if (!clicked) {
        try {
          const size = await browserWithin(frame.evaluate(() => ({
            width: Math.max(document.documentElement.clientWidth || 0, document.body && document.body.clientWidth || 0),
            height: Math.max(document.documentElement.clientHeight || 0, document.body && document.body.clientHeight || 0),
          })), 1000);
          if (size !== BROWSER_TIMEOUT && size && size.width > 40 && size.height > 40) {
            await frame.locator('body').click({
              position: { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) },
              force: true,
              timeout: 1200,
            });
            clicked = true;
          }
        } catch (_) {}
      }
      try { await frame.locator('body').press(attempt % 2 ? 'Space' : 'Enter', { timeout: 800 }); } catch (_) {}

      try {
        await browserWithin(frame.evaluate(() => {
          const videos = Array.from(document.querySelectorAll('video'));
          for (const video of videos) {
            video.muted = true;
            const playing = video.play();
            if (playing && playing.catch) playing.catch(() => {});
          }
        }), 1500);
      } catch (_) {}
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function browserWithin(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(BROWSER_TIMEOUT), milliseconds);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function fetchWithSession(initialUrl, env) {
  let current = initialUrl;
  let referer = '';
  const cookies = {};

  for (let redirects = 0; redirects <= 5; redirects++) {
    assertSafeUpstreamUrl(current, env);
    const headers = new Headers({
      Accept: 'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,video/*;q=0.9,*/*;q=0.7',
      'User-Agent': UPSTREAM_AGENT,
    });
    const cookie = cookieString(cookies);
    if (cookie) headers.set('Cookie', cookie);
    if (referer) headers.set('Referer', referer);

    const options = { headers, redirect: 'manual' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(UPSTREAM_FETCH_MAX_MS);
    }
    let response;
    try {
      response = await fetch(current, options);
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw codedError('UPSTREAM_TIMEOUT', 504);
      }
      throw error;
    }
    absorbCookies(response.headers, cookies);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: current, referer: current, cookie: cookieString(cookies) };
    }
    const location = response.headers.get('location');
    if (!location) throw codedError('UPSTREAM_REDIRECT_INVALID', 502);
    referer = current;
    current = new URL(location, current).toString();
  }
  throw codedError('UPSTREAM_TOO_MANY_REDIRECTS', 502);
}

function playbackHeaders(page) {
  const result = { referer: page.referer || page.url };
  try { result.origin = new URL(result.referer).origin; } catch (_) {}
  if (page.cookie) result.cookie = page.cookie;
  return result;
}

export function extractMediaUrl(input, baseUrl) {
  const text = decodePageEscapes(String(input || ''));
  const candidates = [];
  let match;
  const absolute = /https?:\/\/[^"'\s<>]+?\.(?:m3u8|mp4|m4v|webm|mov)(?:\?[^"'\s<>]*)?/gi;
  while ((match = absolute.exec(text))) candidates.push(match[0]);

  const assigned = /(?:file|src|source|url|hls|playlist|manifest)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = assigned.exec(text))) {
    if (/\.(?:m3u8|mp4|m4v|webm|mov)(?:[?#]|$)/i.test(match[1])) candidates.push(match[1]);
  }

  const normalized = [];
  for (const candidate of candidates) {
    try {
      const clean = candidate.replace(/&amp;/gi, '&').replace(/[),;]+$/, '');
      if (/\{v\d+\}/i.test(clean)) continue;
      const value = new URL(clean, baseUrl).toString();
      if (!normalized.includes(value)) normalized.push(value);
    } catch (_) {}
  }
  normalized.sort((a, b) => Number(!/\.m3u8(?:[?#]|$)/i.test(a)) - Number(!/\.m3u8(?:[?#]|$)/i.test(b)));
  return normalized[0] || '';
}

function decodePageEscapes(value) {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&#x26;/gi, '&')
    .replace(/&#38;/g, '&');
}

function looksInteractive(text) {
  const sample = text.slice(0, MAX_TEXT_BYTES).toLowerCase();
  return sample.includes('confirm you are not a robot') ||
    sample.includes('verify you are human') ||
    sample.includes('g-recaptcha') ||
    sample.includes('hcaptcha') ||
    sample.includes('cf-chl-');
}

async function proxyMedia(request, env, rootPath, cors) {
  const requestUrl = new URL(request.url);
  const marker = rootPath + '/media/';
  const remainder = requestUrl.pathname.slice(marker.length);
  const token = remainder.split('/')[0];
  if (!token) return safeError('INVALID_PLAYBACK_TOKEN', 400, cors);

  let payload;
  try {
    payload = await openPayload(token, env.PLAYBACK_TOKEN_SECRET);
    if (!payload || !payload.u || !payload.e || payload.e < Math.floor(Date.now() / 1000)) {
      throw codedError('PLAYBACK_TOKEN_EXPIRED', 401);
    }
    assertSafeUpstreamUrl(payload.u, env);
  } catch (error) {
    return safeError(errorCode(error, 'INVALID_PLAYBACK_TOKEN'), statusForError(error, 401), cors);
  }

  const headers = new Headers({
    Accept: '*/*',
    'User-Agent': UPSTREAM_AGENT,
  });
  applyPlaybackHeaders(headers, payload.h);
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(payload.u, { method: request.method, headers, redirect: 'follow' });
    if (upstream.url) assertSafeUpstreamUrl(upstream.url, env);
  } catch (_) {
    return safeError('MEDIA_UPSTREAM_UNAVAILABLE', 502, cors);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return safeError('MEDIA_UPSTREAM_' + upstream.status, 502, cors);
  }

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstream.url || payload.u;
  if (request.method !== 'HEAD' && isHls(type, finalUrl)) {
    const text = await upstream.text();
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      return safeError('PLAYLIST_TOO_LARGE', 502, cors);
    }
    const rewritten = await rewriteHls(text, finalUrl, async (target) => {
      assertSafeUpstreamUrl(target, env);
      const child = await sealPayload({ u: target, e: payload.e, h: payload.h || {} }, env.PLAYBACK_TOKEN_SECRET);
      const childUrl = new URL(request.url);
      childUrl.pathname = rootPath + '/media/' + child + '/' + mediaFilename(target, 'stream.bin');
      childUrl.search = '';
      return childUrl.toString();
    });
    const responseHeaders = new Headers(cors);
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    responseHeaders.set('Cache-Control', 'private, no-store');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(rewritten, { status: 200, headers: responseHeaders });
  }

  const responseHeaders = filteredMediaHeaders(upstream.headers, cors);
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function rewriteHls(text, playlistUrl, wrap) {
  const lines = String(text || '').split(/\r?\n/);
  const output = [];
  for (const original of lines) {
    let line = original;
    if (line && line[0] !== '#') {
      line = await wrap(new URL(line.trim(), playlistUrl).toString());
    } else if (/URI\s*=\s*["']/i.test(line)) {
      line = await rewriteUriAttributes(line, playlistUrl, wrap);
    }
    output.push(line);
  }
  return output.join('\n');
}

async function rewriteUriAttributes(line, playlistUrl, wrap) {
  const expression = /URI\s*=\s*(["'])(.*?)\1/gi;
  let output = '';
  let offset = 0;
  let match;
  while ((match = expression.exec(line))) {
    output += line.slice(offset, match.index);
    const absolute = new URL(match[2], playlistUrl).toString();
    output += 'URI=' + match[1] + await wrap(absolute) + match[1];
    offset = match.index + match[0].length;
  }
  return output + line.slice(offset);
}

function filteredMediaHeaders(source, cors) {
  const headers = new Headers(cors);
  const copy = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  for (const name of copy) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function applyPlaybackHeaders(headers, stored) {
  if (!stored) return;
  const names = ['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent'];
  for (const name of Object.keys(stored)) {
    const lower = name.toLowerCase();
    if (!names.includes(lower) && !lower.startsWith('x-')) continue;
    if (lower.startsWith('x-forwarded-') || lower.startsWith('x-real-') || lower.startsWith('x-vercel-')) continue;
    const value = String(stored[name] || '');
    if (value && value.length <= 8192) headers.set(name, value);
  }
}

function isHls(contentType, url) {
  return contentType.includes('mpegurl') || /\.m3u8(?:[?#]|$)/i.test(url || '');
}

function isVideo(contentType, url) {
  return contentType.startsWith('video/') || /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(url || '');
}

function mediaFilename(url, fallback) {
  try {
    const name = new URL(url).pathname.split('/').pop() || fallback;
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '').slice(-100);
    return safe && /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : fallback;
  } catch (_) {
    return fallback;
  }
}

function assertSafeUpstreamUrl(value, env) {
  let url;
  try { url = new URL(value); } catch (_) { throw codedError('INVALID_UPSTREAM_URL', 500); }
  if (url.protocol !== 'https:' || url.username || url.password) throw codedError('UNSAFE_UPSTREAM_URL', 500);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw codedError('UNSAFE_UPSTREAM_HOST', 500);

  const allowlist = String(env.ALLOWED_MEDIA_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length && !allowlist.some((rule) => hostMatches(host, rule))) {
    throw codedError('UPSTREAM_HOST_NOT_ALLOWED', 403);
  }
  return url;
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((value) => value > 255)) return true;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function hostMatches(host, rule) {
  if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
  return host === rule;
}

function normalizeAccessPath(value) {
  const path = String(value || '').replace(/^\/+|\/+$/g, '');
  return /^[a-zA-Z0-9_-]{16,128}$/.test(path) ? path : '';
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  const expected = String(env.APP_ORIGIN || '').replace(/\/$/, '');
  return !origin || !expected || origin === expected;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const expected = String(env.APP_ORIGIN || '').replace(/\/$/, '');
  const allowed = origin && expected && origin === expected ? origin : (expected || origin || '*');
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function absorbCookies(headers, jar) {
  let values = [];
  if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie();
  else if (typeof headers.getAll === 'function') values = headers.getAll('Set-Cookie');
  else if (headers.get('set-cookie')) values = splitSetCookie(headers.get('set-cookie'));
  for (const value of values) {
    const first = value.split(';', 1)[0];
    const equal = first.indexOf('=');
    if (equal > 0) jar[first.slice(0, equal).trim()] = first.slice(equal + 1).trim();
  }
}

function splitSetCookie(value) {
  return String(value || '').split(/,(?=\s*[^;,=]+=[^;,]*)/g);
}

function cookieString(jar) {
  return Object.keys(jar).map((name) => name + '=' + jar[name]).join('; ');
}

async function sealPayload(payload, secret) {
  const key = await tokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return base64UrlEncode(iv) + '.' + base64UrlEncode(encrypted);
}

async function openPayload(token, secret) {
  const pieces = token.split('.');
  if (pieces.length !== 2) throw codedError('INVALID_PLAYBACK_TOKEN', 401);
  const key = await tokenKey(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(pieces[0]) },
    key,
    base64UrlDecode(pieces[1]),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function tokenKey(secret) {
  if (!secret || String(secret).length < 32) throw codedError('WORKER_NOT_CONFIGURED', 503);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function json(value, status, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(value), { status, headers });
}

function safeError(code, status, headers) {
  return json({ error: /^[A-Z0-9_]{1,64}$/.test(code || '') ? code : 'INTERNAL_ERROR' }, status, headers);
}

function codedError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function errorCode(error, fallback) {
  return error && /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : fallback;
}

function statusForError(error, fallback = 502) {
  return error && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : fallback;
}
