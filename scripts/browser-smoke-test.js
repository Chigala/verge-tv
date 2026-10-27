#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = path.join(os.tmpdir(), 'verge-vidaa-browser-test-' + process.pid);
const downloadDir = path.join(os.tmpdir(), 'verge-vidaa-download-' + process.pid);
const appPort = 7600 + (process.pid % 300);
const debugPort = 9400 + (process.pid % 300);
const pageUrl = `http://127.0.0.1:${appPort}/launcher-diagnostic.html`;
let server;
let chrome;
let socket;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(fn, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error('Timed out: ' + description + (lastError ? ' (' + lastError.message + ')' : ''));
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (error) {}
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function main() {
  assert(fs.existsSync(chromePath), 'Google Chrome is required for this browser smoke test');
  fs.mkdirSync(downloadDir, { recursive: true });

  server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js'), '--host', '127.0.0.1', '--port', String(appPort)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await until(async () => (await fetch(pageUrl)).ok, 'preview server');

  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    pageUrl
  ], { stdio: 'ignore' });

  const targets = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
    const items = await response.json();
    return items.find(item => item.type === 'page' && item.url === pageUrl);
  }, 'Chrome diagnostic tab');

  socket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  }
  async function waitFor(expression, description) {
    await until(() => evaluate(expression), description);
  }

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.querySelector('#bridge-status').textContent.includes('Scan complete')", 'automatic bridge scan', 12000);
  assert.strictEqual(await evaluate("document.querySelector('#scan').disabled"), false);
  assert.strictEqual(await evaluate("document.querySelector('#verdict').textContent.includes('No working launcher is proven yet')"), true);
  assert.strictEqual(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'TV layout must not overflow horizontally');

  await evaluate("document.querySelector('#scan').focus(); document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:39,bubbles:true}));");
  assert.strictEqual(await evaluate('document.activeElement.id'), 'cdp', 'Right arrow should move focus to the CDP button');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:37,bubbles:true}));");
  assert.strictEqual(await evaluate('document.activeElement.id'), 'scan', 'Left arrow should return focus');

  await evaluate("document.querySelector('#cdp').click()");
  await waitFor("document.querySelector('#cdp').disabled === false", 'CDP probe completion', 15000);
  assert.strictEqual(await evaluate("document.querySelector('#cdp-status').textContent.includes('Not available')"), true);
  assert.strictEqual(await evaluate("document.querySelector('#m-cdp').textContent"), 'N/A');

  await evaluate("document.querySelector('#copy').click()");
  await waitFor("document.querySelector('#toast').textContent.length > 0", 'copy feedback');
  const copyFeedback = await evaluate("document.querySelector('#toast').textContent");
  assert(/copied|Copy failed/.test(copyFeedback), 'Copy must produce honest feedback');

  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await evaluate("document.querySelector('#download').click()");
  const downloaded = await until(() => {
    const files = fs.readdirSync(downloadDir).filter(name => name.endsWith('.json'));
    return files.length ? path.join(downloadDir, files[0]) : null;
  }, 'sanitized JSON download');
  const exported = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
  assert.strictEqual(exported.schema, 'verge-vidaa-launch-diagnostic/v1');
  assert(exported.bridges && Array.isArray(exported.bridges.globals));
  assert.strictEqual(exported.cdp.status, 'unavailable');
  const exportedText = JSON.stringify(exported);
  assert(!exportedText.includes('webSocketDebuggerUrl'), 'CDP socket URLs must not be exported');
  assert(!exportedText.includes('192.168.'), 'LAN addresses must not be exported');

  await evaluate("document.querySelector('#share').click()");
  await waitFor("document.querySelector('#share-overlay').classList.contains('on')", 'phone share overlay');
  const shareText = await evaluate("document.querySelector('#share-text').textContent");
  assert(shareText.includes('verge-vidaa-bridge-share/v4'));
  assert(!shareText.includes('192.168.'), 'QR share must not contain LAN addresses');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:27,bubbles:true}));");
  assert.strictEqual(await evaluate("document.querySelector('#share-overlay').classList.contains('on')"), false, 'Back should close QR sharing');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.strictEqual(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Narrow layout must not overflow horizontally');
  assert.strictEqual(await evaluate("getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length"), 1);

  const appUrl = `http://127.0.0.1:${appPort}/index.html`;
  await cdp('Page.navigate', { url: appUrl });
  await waitFor("location.pathname.endsWith('/index.html') && document.querySelector('#tabs').children.length > 0 && !!document.querySelector('#rows .card')", 'Verge home with diagnostic entry', 15000);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:38,bubbles:true})); for(let i=0;i<20;i++) document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:39,bubbles:true}));");
  assert.strictEqual(await evaluate("document.querySelector('#nb-diagnostic').classList.contains('focus')"), true, 'Diagnostic entry must be reachable with the TV remote');
  assert.strictEqual(await evaluate("document.querySelector('#nav .in').scrollWidth <= document.querySelector('#nav .in').clientWidth"), true, 'Top navigation must fit the TV screen');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:13,bubbles:true}));");
  await waitFor("location.pathname.endsWith('/launcher-diagnostic.html')", 'remote OK opens diagnostic inside Verge');

  console.log(JSON.stringify({
    result: 'passed',
    bridgeScan: 'completed',
    cdpFailureHandled: true,
    remoteFocus: 'passed',
    copyFeedback,
    sanitizedDownload: 'passed',
    responsiveLayout: 'passed',
    vergeEntryPoint: 'remote navigation passed'
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (socket) socket.close();
  await Promise.all([stop(chrome), stop(server)]);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(downloadDir, { recursive: true, force: true });
});
