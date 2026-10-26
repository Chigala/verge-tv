#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const docsRoot = path.resolve(__dirname, '..', 'docs');
const args = process.argv.slice(2);
let host = '127.0.0.1';
let port = 7100;

function takeValue(index, name) {
  const arg = args[index];
  const prefix = name + '=';
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), consumed: 0 };
  if (arg === name) return { value: args[index + 1], consumed: 1 };
  return null;
}

for (let i = 0; i < args.length; i += 1) {
  const portArg = takeValue(i, '--port');
  const hostArg = takeValue(i, '--host');
  if (portArg) {
    if (!/^\d+$/.test(portArg.value || '')) throw new Error('--port requires a number');
    port = Number(portArg.value);
    i += portArg.consumed;
  } else if (hostArg) {
    if (hostArg.value === undefined) {
      host = '0.0.0.0';
    } else {
      host = hostArg.value;
      i += hostArg.consumed;
    }
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('--port must be between 1 and 65535');
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (error) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (pathname.includes('\0')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let filePath = path.resolve(docsRoot, '.' + pathname);
  if (filePath !== docsRoot && !filePath.startsWith(docsRoot + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (!statError && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.stat(filePath, (error, info) => {
      if (error || !info.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const headers = {
        'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'X-Content-Type-Options': 'nosniff'
      };
      if (path.extname(filePath).toLowerCase() === '.html') {
        headers['Cache-Control'] = 'no-store';
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
});

server.on('error', (error) => {
  console.error('Verge preview failed: ' + error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Verge preview: http://${host}:${port}/`);
  console.log('Press Ctrl+C to stop.');
});
