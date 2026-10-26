/*
 * Verge VIDAA launch diagnostic.
 * Read-only: never invoke unknown functions, write files/settings, launch apps,
 * change sources, or send CDP commands. Network access is limited to explicit
 * CDP GET discovery and a WebSocket handshake after the user presses the button.
 */
(function (root) {
  'use strict';

  var SENSITIVE_NAME = /device.?id|serial|mac.?address|ip.?address|appident|uuid|ads.?id|customer.?id|role.?id|access.?token|refresh.?token|password|credential|auth|account|cookie|encrypt|decrypt|signcreate/i;
  var INTERESTING_NAME = /hisense|hiutils|vidaa|omi|oipf|vowos|proprietary|launch|startapp|appmanager|dial|source|input/i;
  var LAUNCH_NAME = /launchapp|launch_app|startapp|start_app|changesource|change_source|selectsource|select_source/i;
  var SAFE_GETTERS = [
    'Hisense_GetFirmWareVersion',
    'Hisense_GetModelName',
    'Hisense_GetBrand',
    'Hisense_GetApiVersion',
    'Hisense_GetOSVersion',
    'Hisense_GetChromiumVersion'
  ];

  function stringValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  function sanitize(value, limit) {
    var text = stringValue(value);
    var max = typeof limit === 'number' ? limit : 800;
    text = text
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
      .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[redacted-mac]')
      .replace(/\b(?:[0-9a-f]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})\b/g, '[redacted-token]')
      .replace(/("(?:[^"\\]*(?:id|token|secret|password|auth|cookie|serial|uuid|mac)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|\d+|true|false|null)/gi, '$1"[redacted]"');
    if (text.length > max) text = text.slice(0, max) + '…[truncated]';
    return text;
  }

  function errorText(error) {
    if (!error) return 'Unknown error';
    return sanitize(error.message || error.name || String(error), 220);
  }

  function parseJson(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  function appSummary(value) {
    var parsed = parseJson(value);
    var list = parsed;
    if (parsed && !Array.isArray(parsed)) {
      list = parsed.AppInfo || parsed.appInfo || parsed.apps || parsed.appList || parsed.data || parsed.msg;
    }
    if (typeof list === 'string') list = parseJson(list);
    if (!Array.isArray(list)) {
      return { available: false, count: null, names: [], note: 'Response was not a recognizable app list' };
    }
    var names = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      var name = item.name || item.appName || item.AppName || item.Title || item.title;
      if (name && names.indexOf(String(name)) === -1) names.push(sanitize(String(name), 80));
    }
    return { available: true, count: list.length, names: names.slice(0, 40) };
  }

  function dialSummary(value) {
    var info = parseJson(value);
    if (!info || typeof info !== 'object') {
      return { available: false, enabled: null, appNames: [] };
    }
    var apps = info.app_list || info.appList || info.apps || [];
    var names = [];
    if (Array.isArray(apps)) {
      for (var i = 0; i < apps.length; i += 1) {
        if (typeof apps[i] === 'string') names.push(sanitize(apps[i], 60));
        else if (apps[i] && apps[i].name) names.push(sanitize(apps[i].name, 60));
      }
    }
    return {
      available: true,
      enabled: info.enable === undefined ? info.enabled : info.enable,
      appNames: names.slice(0, 30)
    };
  }

  function propertyNames(value) {
    if (value === null || value === undefined) return [];
    var names = [];
    try { names = Object.getOwnPropertyNames(value); } catch (e) {}
    names.sort();
    return names.slice(0, 100);
  }

  function ownValue(object, name) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return { readable: true, value: descriptor.value };
      }
      return { readable: false, reason: descriptor ? 'accessor not invoked' : 'no descriptor' };
    } catch (e) {
      return { readable: false, reason: errorText(e) };
    }
  }

  function functionInfo(fn) {
    return {
      arity: typeof fn.length === 'number' ? fn.length : null,
      source: sanitize(Function.prototype.toString.call(fn), 900)
    };
  }

  function inspectGlobal(object, name) {
    var displayName = String(name);
    var result = { name: displayName };
    if (SENSITIVE_NAME.test(displayName)) {
      result.skipped = 'sensitive-looking name; value not read';
      return result;
    }
    var item = ownValue(object, name);
    if (!item.readable) {
      result.skipped = item.reason;
      return result;
    }
    var value = item.value;
    result.type = typeof value;
    if (typeof value === 'function') {
      result.function = functionInfo(value);
      result.launchRelated = LAUNCH_NAME.test(displayName);
    } else if (value && typeof value === 'object') {
      result.keys = propertyNames(value);
      if (/^(vowOS|omi_platform|opera_omi|oipfObjectFactory)$/i.test(displayName)) {
        result.children = {};
        var keys = propertyNames(value).slice(0, 30);
        for (var i = 0; i < keys.length; i += 1) {
          if (SENSITIVE_NAME.test(keys[i])) continue;
          var child = ownValue(value, keys[i]);
          if (!child.readable) continue;
          if (typeof child.value === 'function') {
            result.children[keys[i]] = { type: 'function', arity: child.value.length };
          } else if (child.value && typeof child.value === 'object') {
            result.children[keys[i]] = { type: 'object', keys: propertyNames(child.value) };
          } else {
            result.children[keys[i]] = { type: typeof child.value };
          }
        }
      }
    } else {
      result.value = sanitize(value, 120);
    }
    return result;
  }

  function bridgeShare(report) {
    var bridges = report && report.bridges;
    if (!bridges) return null;
    var candidates = [];
    var pattern = /hiutils|vowos|omi|oipf|proprietary|request|appmanager|dial/i;
    var relevantMethod = /application|launch|start|destroy|owner|source|input|request|memory|free|createApplication/i;
    for (var i = 0; i < bridges.globals.length; i += 1) {
      var item = bridges.globals[i];
      if (!pattern.test(item.name)) continue;
      var candidate = { name: sanitize(item.name, 100), type: item.type || 'skipped' };
      if (item.function) candidate.arity = item.function.arity;
      if (item.skipped) candidate.skipped = sanitize(item.skipped, 100);
      candidates.push(candidate);
    }
    var oipf = bridges.oipf || { available: false };
    var sharedOipf = { available: oipf.available, managerMethods: [] };
    if (oipf.managerMethods) {
      for (var j = 0; j < oipf.managerMethods.length; j += 1) {
        if (relevantMethod.test(oipf.managerMethods[j])) sharedOipf.managerMethods.push(sanitize(oipf.managerMethods[j], 100));
      }
    }
    if (oipf.error) sharedOipf.error = sanitize(oipf.error, 160);
    var proprietary = bridges.proprietary || { available: false, names: [] };
    var dial = bridges.dial || { available: false, enabled: null, appNames: [] };
    var shared = {
      schema: 'verge-vidaa-bridge-share/v2',
      userAgent: sanitize(report.context.userAgent, 240),
      versions: bridges.versions,
      launchRelated: bridges.launchRelated,
      proprietary: { available: proprietary.available, returned: proprietary.returned, names: (proprietary.names || []).slice(0, 30) },
      oipf: sharedOipf,
      dial: { available: dial.available, enabled: dial.enabled, appNames: (dial.appNames || []).slice(0, 12) },
      candidates: candidates
    };

    // QR v2 is deliberately summary-only. Shed lower-priority lists rather than
    // exceeding the renderer's reliable single-code capacity on unusual TVs.
    var budget = 2250;
    function trimLowestPriority() {
      if (shared.dial.appNames.length) { shared.dial.appNames.pop(); return true; }
      if (shared.proprietary.names.length) { shared.proprietary.names.pop(); return true; }
      if (shared.userAgent) { shared.userAgent = ''; return true; }
      if (shared.oipf.managerMethods.length > 12) { shared.oipf.managerMethods.pop(); return true; }
      if (shared.candidates.length > 12) { shared.candidates.pop(); return true; }
      if (shared.launchRelated.length > 12) { shared.launchRelated.pop(); return true; }
      return false;
    }
    while (JSON.stringify(shared).length > budget && trimLowestPriority()) {}
    return shared;
  }

  function makeReport() {
    return {
      schema: 'verge-vidaa-launch-diagnostic/v1',
      generatedAt: new Date().toISOString(),
      context: {
        origin: sanitize(root.location && root.location.origin ? root.location.origin : 'unknown', 200),
        protocol: root.location ? root.location.protocol : 'unknown',
        userAgent: sanitize(root.navigator ? root.navigator.userAgent : 'unknown', 400)
      },
      bridges: null,
      cdp: { status: 'not-tested' }
    };
  }

  function init() {
    var report = makeReport();
    var logEntries = [];
    var scanning = false;
    var probing = false;
    var $ = function (id) { return document.getElementById(id); };

    function toast(message, bad) {
      $('toast').textContent = message;
      $('toast').style.color = bad ? 'var(--red)' : 'var(--green)';
    }

    function addLog(name, detail) {
      logEntries.unshift({ name: name, detail: sanitize(detail, 400) });
      logEntries = logEntries.slice(0, 80);
      var log = $('log');
      log.innerHTML = '';
      for (var i = 0; i < logEntries.length; i += 1) {
        var row = document.createElement('div');
        row.className = 'log-row';
        var nm = document.createElement('div');
        nm.className = 'name';
        nm.textContent = logEntries[i].name;
        var data = document.createElement('div');
        data.className = 'data';
        data.textContent = logEntries[i].detail;
        row.appendChild(nm);
        row.appendChild(data);
        log.appendChild(row);
      }
    }

    function setStatus(prefix, kind, status, detail) {
      var el = $(prefix + '-status');
      el.className = 'status' + (kind ? ' ' + kind : '');
      el.lastChild.textContent = status;
      $(prefix + '-detail').textContent = detail;
    }

    function updateVerdict() {
      var bridges = report.bridges;
      var launchCount = bridges ? bridges.launchRelated.length : 0;
      var cdp = report.cdp || { status: 'not-tested' };
      $('m-globals').textContent = bridges ? String(bridges.globals.length) : '—';
      $('m-launch').textContent = bridges ? String(launchCount) : '—';
      $('m-cdp').textContent = cdp.handshake === 'open' ? 'OPEN' :
        (cdp.handshake === 'not-attempted' ? 'N/A' :
          (cdp.handshake ? 'BLOCKED' : (cdp.status === 'not-tested' ? 'Not tested' : 'Not open')));
      var dial = bridges && bridges.dial;
      $('m-dial').textContent = dial && dial.available ? String(dial.enabled) : 'No';

      var message = 'No working launcher is proven yet. Complete the CDP check, then send the four metrics.';
      if (launchCount > 0) {
        message = 'Launch-related names found. Their signatures still need review; existence alone does not prove a working launch.';
      }
      if (cdp.handshake === 'open') {
        message = 'Strong result: CDP discovery and handshake work in this TV context. The next safe step is a supervised read-only Runtime.evaluate capability query.';
      } else if (cdp.httpReachable && cdp.handshake && cdp.handshake !== 'open') {
        message = 'CDP metadata is readable, but the WebSocket did not open. Origin policy or firmware is blocking the useful control channel.';
      } else if (cdp.status === 'unavailable' && launchCount === 0) {
        message = 'No launch bridge or usable CDP channel found in this context. Test the other TV browser context before falling back to DIAL or a helper.';
      }
      $('verdict').textContent = message;
    }

    function inspectOipf() {
      var result = { available: false, managerMethods: [] };
      try {
        if (!root.oipfObjectFactory || typeof root.oipfObjectFactory.createApplicationManagerObject !== 'function') {
          return result;
        }
        result.available = true;
        var manager = root.oipfObjectFactory.createApplicationManagerObject();
        result.managerMethods = propertyNames(manager);
        var prototype = manager;
        for (var depth = 0; depth < 3; depth += 1) {
          try { prototype = Object.getPrototypeOf(prototype); } catch (e) { prototype = null; }
          if (!prototype || prototype === Object.prototype) break;
          var names = propertyNames(prototype);
          for (var i = 0; i < names.length; i += 1) {
            if (result.managerMethods.indexOf(names[i]) === -1) result.managerMethods.push(names[i]);
          }
        }
        result.managerMethods.sort();
      } catch (e) {
        result.error = errorText(e);
      }
      return result;
    }

    function safeVersionGetters() {
      var versions = {};
      for (var i = 0; i < SAFE_GETTERS.length; i += 1) {
        var name = SAFE_GETTERS[i];
        if (typeof root[name] !== 'function') continue;
        try { versions[name] = sanitize(root[name](), 160); }
        catch (e) { versions[name] = 'Error: ' + errorText(e); }
      }
      return versions;
    }

    function proprietarySummary() {
      if (typeof root.getTVProprietaryFunctions !== 'function') {
        return { available: false, names: [] };
      }
      try {
        var value = root.getTVProprietaryFunctions('');
        var names = [];
        if (Array.isArray(value)) {
          for (var i = 0; i < value.length; i += 1) names.push(sanitize(value[i], 120));
        } else if (value && typeof value === 'object') {
          names = propertyNames(value);
        }
        return { available: true, returned: typeof value, names: names.slice(0, 100) };
      } catch (e) {
        return { available: true, error: errorText(e), names: [] };
      }
    }

    function installedApps() {
      return new Promise(function (resolve) {
        if (typeof root.Hisense_getInstalledApps !== 'function') {
          resolve({ available: false, count: null, names: [] });
          return;
        }
        var settled = false;
        var timer = setTimeout(function () {
          finish({ available: true, count: null, names: [], note: 'No usable response within 4 seconds' });
        }, 4000);
        function finish(summary) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(summary);
        }
        function consume(value) {
          var parsed = parseJson(value);
          if (parsed === undefined || typeof parsed === 'boolean' || typeof parsed === 'number') return false;
          finish(appSummary(value));
          return true;
        }
        try {
          var direct = root.Hisense_getInstalledApps(function (list) { consume(list); });
          if (!consume(direct) && direct !== undefined) {
            addLog('Installed apps', 'Waiting for callback');
          }
        } catch (e) {
          finish({ available: true, count: null, names: [], error: errorText(e) });
        }
      });
    }

    function scanBridges() {
      if (scanning) return;
      scanning = true;
      $('scan').disabled = true;
      setStatus('bridge', 'running', 'Scanning', 'Reading property descriptors and safe metadata.');
      addLog('Bridge scan', 'Started');

      var names = [];
      try { names = names.concat(Object.getOwnPropertyNames(root)); } catch (e) {}
      if (typeof Object.getOwnPropertySymbols === 'function') {
        try {
          var symbols = Object.getOwnPropertySymbols(root);
          for (var i = 0; i < symbols.length; i += 1) names.push(String(symbols[i]));
        } catch (e) {}
      }
      names.sort();
      var globals = [];
      var launchRelated = [];
      var seen = {};
      for (var j = 0; j < names.length; j += 1) {
        var name = names[j];
        if (seen[name] || !INTERESTING_NAME.test(name)) continue;
        seen[name] = true;
        var symbolName = name.indexOf('Symbol(') === 0;
        var key = symbolName ? Object.getOwnPropertySymbols(root).filter(function (s) { return String(s) === name; })[0] : name;
        var info = inspectGlobal(root, key);
        info.name = name;
        globals.push(info);
        if (info.launchRelated || LAUNCH_NAME.test(name)) launchRelated.push(name);
      }

      var bridges = {
        globals: globals,
        launchRelated: launchRelated,
        versions: safeVersionGetters(),
        proprietary: proprietarySummary(),
        oipf: inspectOipf(),
        dial: { available: false, enabled: null, appNames: [] },
        apps: null
      };
      if (typeof root.Hisense_GetDialInfo === 'function') {
        try { bridges.dial = dialSummary(root.Hisense_GetDialInfo()); }
        catch (e) { bridges.dial = { available: true, enabled: null, appNames: [], error: errorText(e) }; }
      }

      installedApps().then(function (apps) {
        bridges.apps = apps;
        report.bridges = bridges;
        var dial = bridges.dial;
        setStatus('bridge', 'good', 'Scan complete',
          globals.length + ' globals · ' + launchRelated.length + ' launch names · ' + bridges.proprietary.names.length + ' proprietary names');
        setStatus('dial', dial.available && dial.enabled ? 'good' : '', dial.available ? 'DIAL advertised: ' + String(dial.enabled) : 'DIAL API not found',
          dial.available ? (dial.appNames.length ? dial.appNames.join(', ') : 'No registered app names returned') : 'No TV-side DIAL metadata available.');
        addLog('Launch names', launchRelated.length ? launchRelated.join(', ') : 'None found');
        addLog('OIPF manager', bridges.oipf.managerMethods.length ? bridges.oipf.managerMethods.join(', ') : 'No methods found');
        addLog('Installed apps', apps.count === null ? 'No countable list returned' : apps.count + ' apps; names only, IDs/URLs excluded');
        addLog('Bridge scan', 'Completed without launch or source commands');
        scanning = false;
        $('scan').disabled = false;
        updateVerdict();
      });
    }

    function xhrGet(url, timeoutMs) {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        function finish(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }
        try {
          xhr.open('GET', url, true);
          xhr.timeout = timeoutMs;
          xhr.onload = function () {
            var text = '';
            try { text = xhr.responseText || ''; } catch (e) {}
            finish({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: text });
          };
          xhr.onerror = function () { finish({ ok: false, status: xhr.status || 0, error: 'Network, CORS, mixed content, or unavailable' }); };
          xhr.ontimeout = function () { finish({ ok: false, status: 0, error: 'Timeout' }); };
          xhr.send();
        } catch (e) {
          finish({ ok: false, status: 0, error: errorText(e) });
        }
      });
    }

    function opaqueProbe(url) {
      if (typeof root.fetch !== 'function') return Promise.resolve(false);
      var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 3500); });
      var request = root.fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(function () { return true; }).catch(function () { return false; });
      return Promise.race([request, timeout]);
    }

    function websocketHandshake(url) {
      return new Promise(function (resolve) {
        var settled = false;
        var socket;
        var timer = setTimeout(function () {
          finish('timeout');
          try { if (socket) socket.close(); } catch (e) {}
        }, 4500);
        function finish(result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
        try {
          socket = new WebSocket(url);
          socket.onopen = function () {
            finish('open');
            try { socket.close(); } catch (e) {}
          };
          socket.onerror = function () { finish('error'); };
          socket.onclose = function () {
            if (!settled) finish('closed-before-open');
          };
        } catch (e) {
          finish('exception: ' + errorText(e));
        }
      });
    }

    function probeCdp() {
      if (probing) return;
      probing = true;
      $('cdp').disabled = true;
      report.cdp = { status: 'running', handshake: null, httpReachable: false };
      setStatus('cdp', 'running', 'Discovering', 'GET /json/version and /json only.');
      addLog('CDP', 'Read-only discovery started');
      updateVerdict();

      var versionUrl = 'http://127.0.0.1:9223/json/version';
      var targetsUrl = 'http://127.0.0.1:9223/json';
      var versionResponse;
      var targetsResponse;
      var versionJson;
      var targetsJson;
      var socketUrl = null;

      xhrGet(versionUrl, 4500).then(function (response) {
        versionResponse = response;
        report.cdp.version = { ok: response.ok, status: response.status, error: response.error || null };
        if (response.ok) {
          report.cdp.httpReachable = true;
          versionJson = parseJson(response.text);
          if (versionJson) {
            report.cdp.browser = sanitize(versionJson.Browser || versionJson.browser || 'unknown', 100);
            report.cdp.protocol = sanitize(versionJson['Protocol-Version'] || 'unknown', 30);
            if (versionJson.webSocketDebuggerUrl) socketUrl = versionJson.webSocketDebuggerUrl;
          }
        }
        addLog('CDP version', response.ok ? 'HTTP ' + response.status : response.error);
        return xhrGet(targetsUrl, 4500);
      }).then(function (response) {
        targetsResponse = response;
        report.cdp.targets = { ok: response.ok, status: response.status, error: response.error || null };
        if (response.ok) {
          report.cdp.httpReachable = true;
          targetsJson = parseJson(response.text);
          if (Array.isArray(targetsJson)) {
            var launcher = null;
            var firstPage = null;
            for (var i = 0; i < targetsJson.length; i += 1) {
              var target = targetsJson[i];
              if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
              if (!firstPage) firstPage = target;
              if (/hisenseUI|index\.html/i.test(target.url || '')) launcher = target;
            }
            report.cdp.targetCount = targetsJson.length;
            report.cdp.launcherTargetFound = !!launcher;
            if (launcher || firstPage) socketUrl = (launcher || firstPage).webSocketDebuggerUrl;
          }
        }
        addLog('CDP targets', response.ok ? 'HTTP ' + response.status + ' · ' + (report.cdp.targetCount || 0) + ' targets' : response.error);
        if (!report.cdp.httpReachable) return opaqueProbe(versionUrl);
        return false;
      }).then(function (opaqueReachable) {
        report.cdp.opaqueReachable = !!opaqueReachable;
        if (!socketUrl) {
          report.cdp.status = report.cdp.httpReachable ? 'metadata-only' : 'unavailable';
          report.cdp.handshake = 'not-attempted';
          setStatus('cdp', 'bad', report.cdp.httpReachable ? 'Metadata only' : 'Not available here',
            opaqueReachable ? 'Host responded opaquely, but CORS blocks target metadata.' : 'No readable CDP target or browser WebSocket URL.');
          addLog('CDP handshake', 'Not attempted; no WebSocket URL discovered');
          return null;
        }
        setStatus('cdp', 'running', 'Handshaking', 'Opening and closing the discovered WebSocket. No commands.');
        return websocketHandshake(socketUrl).then(function (result) {
          report.cdp.handshake = result;
          report.cdp.status = result === 'open' ? 'ready-for-supervised-query' : 'websocket-blocked';
          setStatus('cdp', result === 'open' ? 'good' : 'bad', result === 'open' ? 'Handshake open' : 'Handshake blocked',
            result === 'open' ? 'No CDP command was sent. A supervised read-only query is now justified.' : sanitize(result, 180));
          addLog('CDP handshake', result);
        });
      }).catch(function (e) {
        report.cdp.status = 'error';
        report.cdp.error = errorText(e);
        setStatus('cdp', 'bad', 'Diagnostic error', errorText(e));
      }).then(function () {
        probing = false;
        $('cdp').disabled = false;
        updateVerdict();
      });
    }

    function reportText() {
      return JSON.stringify(report, null, 2);
    }

    function closeShare() {
      $('share-overlay').className = '';
      $('share').focus();
    }

    function renderShareQr(text) {
      if (!$('share-overlay').className) return;
      $('share-qr').innerHTML = '';
      try {
        new root.QRCode($('share-qr'), {
          text: text,
          width: 320,
          height: 320,
          correctLevel: root.QRCode.CorrectLevel.L
        });
      } catch (e) {
        $('share-qr').textContent = 'QR unavailable. Photograph the text below.';
      }
    }

    function showShare() {
      var shared = bridgeShare(report);
      if (!shared) { toast('Wait for the bridge scan to finish.', true); return; }
      var json = JSON.stringify(shared);
      var text = 'VERGE VIDAA bridge share v2\n' + json;
      $('share-text').textContent = json;
      $('share-qr').textContent = 'Preparing QR…';
      $('share-overlay').className = 'on';
      $('share-close').focus();
      if (text.length > 2400) {
        $('share-qr').textContent = 'Details are too large for one QR. Photograph the text below.';
        return;
      }
      if (root.QRCode) { renderShareQr(text); return; }
      if (showShare.loading) return;
      showShare.loading = true;
      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      script.onload = function () { showShare.loading = false; renderShareQr(text); };
      script.onerror = function () {
        showShare.loading = false;
        $('share-qr').textContent = 'QR could not load. Photograph the text below.';
      };
      document.head.appendChild(script);
    }

    function copyText(text, successMessage) {
      function fallback() {
        var area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.focus();
        area.select();
        var copied = false;
        try { copied = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(area);
        toast(copied ? successMessage : 'Copy failed; use Download JSON instead.', !copied);
      }
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(text).then(function () {
          toast(successMessage);
        }).catch(fallback);
      } else {
        fallback();
      }
    }

    function downloadReport() {
      try {
        var blob = new Blob([reportText()], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = 'verge-vidaa-diagnostic.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast('Sanitized JSON download requested.');
      } catch (e) {
        toast('Download unavailable; use Copy sanitized report.', true);
      }
    }

    function moveFocus(keyCode) {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('.action:not([disabled])'));
      if (!buttons.length) return;
      var current = document.activeElement;
      if (buttons.indexOf(current) === -1) {
        buttons[0].focus();
        return;
      }
      var from = current.getBoundingClientRect();
      var fx = from.left + from.width / 2;
      var fy = from.top + from.height / 2;
      var best = null;
      var bestScore = Infinity;
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i] === current) continue;
        var rect = buttons[i].getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        var dx = x - fx;
        var dy = y - fy;
        var valid = keyCode === 37 ? dx < -5 : keyCode === 39 ? dx > 5 : keyCode === 38 ? dy < -5 : dy > 5;
        if (!valid) continue;
        var primary = keyCode === 37 || keyCode === 39 ? Math.abs(dx) : Math.abs(dy);
        var cross = keyCode === 37 || keyCode === 39 ? Math.abs(dy) : Math.abs(dx);
        var score = primary + cross * 2.5;
        if (score < bestScore) { best = buttons[i]; bestScore = score; }
      }
      if (best) {
        best.focus();
        best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    $('scan').addEventListener('click', scanBridges);
    $('cdp').addEventListener('click', probeCdp);
    $('copy').addEventListener('click', function () { copyText(reportText(), 'Sanitized report copied.'); });
    $('download').addEventListener('click', downloadReport);
    $('share').addEventListener('click', showShare);
    $('share-close').addEventListener('click', closeShare);
    $('copy-lan').addEventListener('click', function () {
      copyText('curl http://<TV-IP>:9223/json/version\ncurl http://<TV-IP>:9223/json', 'Laptop CDP checks copied. Replace <TV-IP>.');
    });
    document.addEventListener('keydown', function (event) {
      var key = event.keyCode;
      if (key === 8 || key === 27 || key === 461 || key === 10009 || key === 10071) {
        if ($('share-overlay').className) closeShare();
        else if (root.history.length > 1) root.history.back();
        else root.location.href = 'index.html';
        event.preventDefault();
        return;
      }
      if (key >= 37 && key <= 40) {
        moveFocus(key);
        event.preventDefault();
      }
    });

    scanBridges();
  }

  var api = {
    sanitize: sanitize,
    appSummary: appSummary,
    dialSummary: dialSummary,
    bridgeShare: bridgeShare,
    propertyNames: propertyNames,
    LAUNCH_NAME: LAUNCH_NAME,
    SENSITIVE_NAME: SENSITIVE_NAME
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VidaaDiagnostic = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
