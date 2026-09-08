'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.resolve(process.env.ATP_EXTENSION_DIR || path.join(PROJECT_ROOT, 'dist', 'chrome-unpacked'));
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8')).version;
const SMOKE_HOST = 'smoke.sehuatang.org';
const CROSS_HOST = 'other.sehuatang.org';
const HEAVY_HOST = 'image.imx.to';
const CERT_PASSWORD = 'atp-browser-smoke';
const DEVTOOLS_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 30000;
const IMAGE_DELAY_MS = 180;

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function waitFor(label, callback, timeoutMs, intervalMs) {
  var timeout = timeoutMs || PAGE_TIMEOUT_MS;
  var interval = intervalMs || 80;
  var startedAt = Date.now();
  var lastError = null;
  while (Date.now() - startedAt < timeout) {
    try {
      var value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  var suffix = lastError ? ': ' + lastError.message : '';
  throw new Error('Timed out waiting for ' + label + suffix);
}

function findBrowserExecutable() {
  var candidates = [];
  if (process.env.ATP_BROWSER_PATH) candidates.push(path.resolve(process.env.ATP_BROWSER_PATH));

  var playwrightRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(playwrightRoot)) {
    var builds = fs.readdirSync(playwrightRoot, { withFileTypes: true })
      .filter(function(entry) { return entry.isDirectory() && /^chromium-\d+$/.test(entry.name); })
      .sort(function(a, b) {
        return Number(b.name.substring('chromium-'.length)) - Number(a.name.substring('chromium-'.length));
      });
    for (var bi = 0; bi < builds.length; bi++) {
      candidates.push(path.join(playwrightRoot, builds[bi].name, 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(playwrightRoot, builds[bi].name, 'chrome-win', 'chrome.exe'));
    }
  }

  candidates.push(path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  candidates.push(path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return path.resolve(candidates[i]);
  }
  throw new Error('No Chromium browser found. Set ATP_BROWSER_PATH to chrome.exe or msedge.exe.');
}

function removeSmokeRunRoot(runRoot) {
  var resolvedRoot = path.resolve(runRoot);
  var tempPrefix = path.resolve(os.tmpdir()) + path.sep;
  assert(
    resolvedRoot.startsWith(tempPrefix) && path.basename(resolvedRoot).startsWith('atp-browser-smoke-'),
    'Refusing to remove an unexpected browser smoke directory: ' + resolvedRoot
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

function createCertificate(pfxPath) {
  var script = [
    "$ErrorActionPreference = 'Stop'",
    "$pfxPath = [Environment]::GetEnvironmentVariable('ATP_SMOKE_PFX_PATH')",
    "$password = [Environment]::GetEnvironmentVariable('ATP_SMOKE_PFX_PASSWORD')",
    '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
    "$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=smoke.sehuatang.org', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    '$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
    "$san.AddDnsName('smoke.sehuatang.org')",
    "$san.AddDnsName('other.sehuatang.org')",
    "$san.AddDnsName('image.imx.to')",
    '$request.CertificateExtensions.Add($san.Build())',
    '$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false))',
    '$usage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment',
    '$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $false))',
    '$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(2))',
    '$bytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)',
    '[System.IO.File]::WriteAllBytes($pfxPath, $bytes)',
    '$certificate.Dispose()',
    '$rsa.Dispose()'
  ].join('\r\n');
  var encoded = Buffer.from(script, 'utf16le').toString('base64');
  var result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      ATP_SMOKE_PFX_PATH: pfxPath,
      ATP_SMOKE_PFX_PASSWORD: CERT_PASSWORD
    })
  });
  if (result.status !== 0 || !fs.existsSync(pfxPath)) {
    throw new Error('Failed to generate the local HTTPS certificate: ' + String(result.stderr || result.stdout || result.error || 'unknown error').trim());
  }
}

function htmlPage(body, title) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>body{font:16px sans-serif;margin:20px}table{width:900px;border-collapse:collapse}tbody{height:48px;border-bottom:1px solid #ccc}th{text-align:left}.smoke-note{height:1200px}</style>' +
    '</head><body>' + body + '</body></html>';
}

function forumPage(port, mode) {
  var rows;
  if (mode === 'heavy') {
    rows = '<tbody id="normalthread_300"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-300-1-1.html">Heavy gallery</a></th></tr></tbody>';
  } else {
    var listing = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/fixtures/pages/listing.html'), 'utf8')
      .replaceAll('{{ORIGIN}}', 'https://' + SMOKE_HOST + ':' + port)
      .replaceAll('{{CROSS}}', 'https://' + CROSS_HOST + ':' + port);
    return htmlPage(listing + '<div class="smoke-note"></div>', 'ATP smoke forum');
  }
  return htmlPage('<h1>ATP browser smoke</h1><div id="threadlist" class="threadlist"><table id="threadlisttable">' + rows + '</table></div><div class="smoke-note"></div>', 'ATP smoke forum');
}

function imageMarkup(host, port, prefix, count) {
  var images = [];
  for (var i = 0; i < count; i++) {
    images.push('<img src="https://' + host + ':' + port + '/img/' + prefix + '-' + i + '.jpg" alt="' + prefix + '-' + i + '">');
  }
  return images.join('\n');
}

function ordinaryThread(port) {
  return htmlPage(
    '<h1>Ordinary gallery</h1>' + imageMarkup(SMOKE_HOST, port, 'ordinary', 24) +
    '<p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111">Main magnet</a></p>' +
    '<p><a href="https://pan.baidu.com/s/1AtpSmokeMain">Baidu share</a> \u63d0\u53d6\u7801: abcd</p>' +
    '<p><a href="https://downloads.example.test/smoke.zip">Archive</a></p>',
    'Ordinary thread'
  );
}

function crossThread(port) {
  return htmlPage(
    '<h1>Cross-origin resources</h1>' +
    '<p><a href="https://' + CROSS_HOST + ':' + port + '/forum.php?mod=attachment&aid=456">resources.txt</a></p>' +
    '<p><a href="https://pan.quark.cn/s/AtpCrossMain">Quark share</a> \u63d0\u53d6\u7801: qwer</p>',
    'Cross-origin thread'
  );
}

function heavyThread(port) {
  return htmlPage('<h1>Heavy gallery</h1>' + imageMarkup(HEAVY_HOST, port, 'heavy', 20), 'Heavy thread');
}

function createFixtureServer(pfxPath) {
  var pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  var metrics = {
    requestCount: 0,
    requestsByHost: {},
    requestsByPath: {},
    activeOrdinaryImages: 0,
    activeHeavyImages: 0,
    activeImages: 0,
    maxOrdinaryImages: 0,
    maxHeavyImages: 0,
    maxCombinedImages: 0
  };
  var server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: CERT_PASSWORD }, function(req, res) {
    var host = String(req.headers.host || '').split(':')[0].toLowerCase();
    var requestUrl = new URL(req.url, 'https://' + (req.headers.host || SMOKE_HOST));
    var pathname = requestUrl.pathname;
    metrics.requestCount++;
    metrics.requestsByHost[host] = (metrics.requestsByHost[host] || 0) + 1;
    metrics.requestsByPath[pathname] = (metrics.requestsByPath[pathname] || 0) + 1;

    if (pathname === '/bridge-redirect.txt') {
      var redirectHost = requestUrl.searchParams.get('target') === 'cross' ? CROSS_HOST : SMOKE_HOST;
      res.writeHead(302, { location: 'https://' + redirectHost + ':' + server.address().port + '/bridge-target.txt' });
      res.end();
      return;
    }
    if (pathname === '/bridge-target.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': 'https://' + SMOKE_HOST + ':' + server.address().port,
        'access-control-allow-credentials': 'true'
      });
      res.end('bridge redirect fixture');
      return;
    }

    if (pathname === '/forum.php' && requestUrl.searchParams.get('mod') === 'attachment') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ed2k://|file|www.98T.la@妃妃宝贝.zip|2945409455|43B5B13B95A9187A3BF041CC0A94FFC2|/');
      return;
    }
    if (pathname === '/forum.php') {
      var mode = requestUrl.searchParams.get('mode') || 'mixed';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(forumPage(server.address().port, mode));
      return;
    }
    if (pathname === '/thread-100-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ordinaryThread(server.address().port));
      return;
    }
    if (pathname === '/thread-200-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(crossThread(server.address().port));
      return;
    }
    if (pathname === '/thread-300-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(heavyThread(server.address().port));
      return;
    }
    if (pathname === '/other.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<h1>BFCache destination</h1>', 'BFCache destination'));
      return;
    }
    if (pathname.indexOf('/img/') === 0) {
      var heavy = host === HEAVY_HOST;
      var settled = false;
      if (heavy) {
        metrics.activeHeavyImages++;
        metrics.maxHeavyImages = Math.max(metrics.maxHeavyImages, metrics.activeHeavyImages);
      } else {
        metrics.activeOrdinaryImages++;
        metrics.maxOrdinaryImages = Math.max(metrics.maxOrdinaryImages, metrics.activeOrdinaryImages);
      }
      metrics.activeImages++;
      metrics.maxCombinedImages = Math.max(metrics.maxCombinedImages, metrics.activeImages);
      function settleImage() {
        if (settled) return;
        settled = true;
        if (heavy) metrics.activeHeavyImages = Math.max(0, metrics.activeHeavyImages - 1);
        else metrics.activeOrdinaryImages = Math.max(0, metrics.activeOrdinaryImages - 1);
        metrics.activeImages = Math.max(0, metrics.activeImages - 1);
      }
      res.on('close', settleImage);
      setTimeout(function() {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length });
          res.end(pixel, settleImage);
        } else {
          settleImage();
        }
      }, IMAGE_DELAY_MS);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return { server: server, metrics: metrics };
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    var self = this;
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise(function(resolve, reject) {
      var timer = setTimeout(function() { reject(new Error('CDP websocket open timeout')); }, 5000);
      self.ws.addEventListener('open', function() { clearTimeout(timer); resolve(); }, { once: true });
      self.ws.addEventListener('error', function(event) { clearTimeout(timer); reject(event.error || new Error('CDP websocket error')); }, { once: true });
    });
    this.ws.addEventListener('message', function(event) {
      var raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      var message = JSON.parse(raw);
      if (message.id) {
        var pending = self.pending.get(message.id);
        if (!pending) return;
        self.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
        return;
      }
      var handlers = self.listeners.get(message.method) || [];
      handlers.slice().forEach(function(handler) { handler(message.params || {}); });
    });
    this.ws.addEventListener('close', function() {
      self.pending.forEach(function(pending) { pending.reject(new Error('CDP websocket closed')); });
      self.pending.clear();
    });
    return this;
  }

  on(method, handler) {
    var handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
    return function() {
      var current = this.listeners.get(method) || [];
      var index = current.indexOf(handler);
      if (index !== -1) current.splice(index, 1);
    }.bind(this);
  }

  send(method, params) {
    var self = this;
    var id = this.nextId++;
    return new Promise(function(resolve, reject) {
      var settled = false;
      var timer;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        self.pending.delete(id);
        callback(value);
      }
      var pending = {
        resolve: function(value) { finish(resolve, value); },
        reject: function(error) { finish(reject, error); }
      };
      timer = setTimeout(function() {
        pending.reject(new Error('CDP command timed out: ' + method));
      }, DEVTOOLS_TIMEOUT_MS);
      self.pending.set(id, pending);
      try {
        self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      } catch (error) {
        pending.reject(error);
      }
    });
  }

  close() {
    this.pending.forEach(function(pending) { pending.reject(new Error('CDP websocket closed')); });
    this.pending.clear();
    if (this.ws && this.ws.readyState < 2) this.ws.close();
  }
}

async function fetchJson(url, options) {
  var response = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(DEVTOOLS_TIMEOUT_MS) }));
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText + ' for ' + url);
  return response.json();
}

async function createTarget(devtoolsPort, url) {
  return fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/new?' + encodeURIComponent(url || 'about:blank'), { method: 'PUT' });
}

async function listTargets(devtoolsPort) {
  return fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/list');
}

async function closeTarget(devtoolsPort, targetId) {
  try {
    await fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/close/' + targetId);
  } catch (error) {}
}

async function createPageSession(devtoolsPort) {
  var target = await createTarget(devtoolsPort, 'about:blank');
  var cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
  var contexts = new Map();
  var errors = [];
  var consoleErrors = [];
  var bfcacheNotUsed = [];
  cdp.on('Runtime.executionContextCreated', function(event) { contexts.set(event.context.id, event.context); });
  cdp.on('Runtime.executionContextDestroyed', function(event) { contexts.delete(event.executionContextId); });
  cdp.on('Runtime.executionContextsCleared', function() { contexts.clear(); });
  cdp.on('Runtime.exceptionThrown', function(event) { errors.push(event.exceptionDetails || event); });
  cdp.on('Runtime.consoleAPICalled', function(event) {
    if (event.type === 'error') consoleErrors.push(event);
  });
  cdp.on('Log.entryAdded', function(event) {
    if (event.entry && (event.entry.level === 'error' || event.entry.level === 'warning')) consoleErrors.push(event.entry);
  });
  cdp.on('Page.backForwardCacheNotUsed', function(event) { bfcacheNotUsed.push(event); });
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Log.enable')
  ]);
  return {
    target: target,
    cdp: cdp,
    contexts: contexts,
    errors: errors,
    consoleErrors: consoleErrors,
    bfcacheNotUsed: bfcacheNotUsed
  };
}

async function evaluate(session, expression, contextId) {
  var params = {
    expression: expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  };
  if (contextId) params.contextId = contextId;
  var response = await session.cdp.send('Runtime.evaluate', params);
  if (response.exceptionDetails) {
    var description = response.exceptionDetails.exception && response.exceptionDetails.exception.description;
    throw new Error(description || response.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return response.result ? response.result.value : undefined;
}

async function navigate(session, url) {
  var result = await session.cdp.send('Page.navigate', { url: url });
  if (result.errorText) throw new Error('Navigation failed: ' + result.errorText);
  await waitFor('document ready: ' + url, async function() {
    return evaluate(session, 'document.readyState === "complete"');
  });
}

function findExtensionContext(session, extensionId) {
  var expectedOrigin = 'chrome-extension://' + extensionId;
  var contexts = Array.from(session.contexts.values());
  return contexts.find(function(context) {
    return context.origin === expectedOrigin || (
      context.auxData && context.auxData.type === 'isolated' && String(context.name || '').indexOf(extensionId) !== -1
    );
  }) || null;
}

async function waitForExtensionContext(session, extensionId) {
  var existing = findExtensionContext(session, extensionId);
  if (existing) return existing;
  session.contexts.clear();
  await session.cdp.send('Runtime.disable');
  await session.cdp.send('Runtime.enable');
  return waitFor('extension isolated world', async function() {
    return findExtensionContext(session, extensionId);
  }, 5000);
}

function flattenResourceItems(resources) {
  var items = [];
  var groups = resources && resources.groups || {};
  Object.keys(groups).forEach(function(type) {
    (groups[type] || []).forEach(function(item) {
      items.push(Object.assign({ type: type }, item));
    });
  });
  return items;
}

function summarizeErrors(session) {
  return {
    exceptions: session.errors.map(function(item) {
      return item.text || item.exception && item.exception.description || 'Runtime exception';
    }),
    consoleErrors: session.consoleErrors.map(function(item) {
      if (item.text) return item.text;
      if (Array.isArray(item.args)) {
        return item.args.map(function(arg) { return arg.value || arg.description || ''; }).join(' ');
      }
      return item.level || item.type || 'console error';
    })
  };
}

async function main() {
  assert(fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')), 'Packaged extension is missing: ' + EXTENSION_DIR);
  var packagedManifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  assert.strictEqual(packagedManifest.version, EXPECTED_VERSION, 'Packaged extension version must match the worktree manifest');

  var browserPath = findBrowserExecutable();
  var runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-browser-smoke-'));
  var profileDir = path.join(runRoot, 'profile');
  var pfxPath = path.join(runRoot, 'fixture.pfx');
  fs.mkdirSync(profileDir, { recursive: true });
  createCertificate(pfxPath);

  var fixture = createFixtureServer(pfxPath);
  await new Promise(function(resolve, reject) {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  var fixturePort = fixture.server.address().port;
  var browserOutput = '';
  var browser = childProcess.spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--no-proxy-server',
    '--ignore-certificate-errors',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--disable-extensions-except=' + EXTENSION_DIR,
    '--load-extension=' + EXTENSION_DIR,
    '--host-resolver-rules=MAP ' + SMOKE_HOST + ' 127.0.0.1, MAP ' + CROSS_HOST + ' 127.0.0.1, MAP ' + HEAVY_HOST + ' 127.0.0.1, EXCLUDE localhost',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  browser.stdout.on('data', function(chunk) { browserOutput = (browserOutput + chunk.toString()).slice(-32768); });
  browser.stderr.on('data', function(chunk) { browserOutput = (browserOutput + chunk.toString()).slice(-32768); });

  var sessions = [];
  var browserConnection = null;
  try {
    var devtoolsFile = path.join(profileDir, 'DevToolsActivePort');
    var devtoolsText = await waitFor('DevToolsActivePort', async function() {
      if (browser.exitCode !== null) throw new Error('Browser exited with code ' + browser.exitCode + '\n' + browserOutput);
      if (!fs.existsSync(devtoolsFile)) return null;
      var text = fs.readFileSync(devtoolsFile, 'utf8').trim();
      return text || null;
    }, DEVTOOLS_TIMEOUT_MS);
    var devtoolsLines = devtoolsText.split(/\r?\n/);
    var devtoolsPort = Number(devtoolsLines[0]);
    assert(Number.isFinite(devtoolsPort) && devtoolsPort > 0, 'Invalid DevTools port: ' + devtoolsLines[0]);

    var versionInfo = await fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/version');
    browserConnection = await new CdpConnection(versionInfo.webSocketDebuggerUrl).connect();

    var expectedWorkerPath = '/' + String(packagedManifest.background && packagedManifest.background.service_worker || 'background.js').replace(/^\/+/, '');
    var extensionTarget = await waitFor('unpacked extension service worker', async function() {
      var targets = await listTargets(devtoolsPort);
      return targets.find(function(target) {
        if (target.type !== 'service_worker' || !/^chrome-extension:\/\//.test(target.url || '')) return false;
        try {
          return new URL(target.url).pathname === expectedWorkerPath;
        } catch (error) {
          return false;
        }
      }) || null;
    }, DEVTOOLS_TIMEOUT_MS, 120);
    var extensionMatch = /^chrome-extension:\/\/([a-p]{32})/.exec(extensionTarget.url || '');
    assert(extensionMatch, 'Could not read the unpacked extension id from ' + extensionTarget.url);
    var extensionId = extensionMatch[1];

    var pageOne = await createPageSession(devtoolsPort);
    sessions.push(pageOne);
    var forumUrl = 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=mixed';
    await navigate(pageOne, forumUrl);
    await waitFor('floating panel injection', async function() {
      return evaluate(pageOne, 'document.querySelectorAll("#bfp-root").length === 1');
    });
    var pageOneContext;
    try {
      pageOneContext = await waitForExtensionContext(pageOne, extensionId);
    } catch (error) {
      var pageDiagnostic = await evaluate(pageOne, `({
        href: location.href,
        title: document.title,
        bodyText: (document.body && document.body.innerText || '').slice(0, 300),
        floatingRootCount: document.querySelectorAll('#bfp-root').length
      })`);
      var contextDiagnostic = Array.from(pageOne.contexts.values()).map(function(context) {
        return {
          id: context.id,
          name: context.name,
          origin: context.origin,
          auxData: context.auxData
        };
      });
      var targetDiagnostic = (await listTargets(devtoolsPort)).map(function(target) {
        return { type: target.type, title: target.title, url: target.url };
      });
      throw new Error(error.message + '\npage=' + JSON.stringify(pageDiagnostic) + '\ncontexts=' + JSON.stringify(contextDiagnostic) + '\ntargets=' + JSON.stringify(targetDiagnostic));
    }
    await waitFor('three rendered thread panels', async function() {
      return evaluate(pageOne, 'document.querySelectorAll(".atp-thread-panel").length === 3');
    });
    await waitFor('ordinary images to start loading', async function() {
      return fixture.metrics.maxOrdinaryImages >= 2;
    });
    await waitFor('mixed ordinary and heavy channel overlap', async function() {
      return fixture.metrics.maxOrdinaryImages >= 2 && fixture.metrics.maxHeavyImages >= 1 && fixture.metrics.maxCombinedImages >= 4;
    });

    var ordinaryFirstScreen = await waitFor('ordinary first screen completion', async function() {
      var progress = await evaluate(pageOne, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
        if (!thread || !thread.firstScreenDone) return null;
        return { firstScreenTotal: thread.firstScreenTotal, firstScreenOk: thread.firstScreenOk, loaded: thread.loaded };
      })()`, pageOneContext.id);
      return progress && progress.firstScreenOk === progress.firstScreenTotal ? progress : null;
    });
    var scrolledOrdinaryViewport = await evaluate(pageOne, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
      const viewport = thread && thread.panel && thread.panel.querySelector('.atp-scroll-viewport');
      if (!viewport) return false;
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`, pageOneContext.id);
    assert(scrolledOrdinaryViewport, 'Ordinary thumbnail viewport was not available for background progression');
    var ordinaryBackgroundProgress = await waitFor('ordinary background loading beyond the first screen', async function() {
      var progress = await evaluate(pageOne, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
        return thread ? { firstScreenTotal: thread.firstScreenTotal, sourceCandidates: thread.sourceCandidates.length, loaded: thread.loaded } : null;
      })()`, pageOneContext.id);
      return progress && progress.loaded >= Math.min(progress.sourceCandidates, progress.firstScreenTotal + 10) ? progress : null;
    });

    var initialThreads = await evaluate(pageOne, `(() => Object.values(window.ATPState.threads).map((thread) => ({
      link: thread.link,
      heavyMode: thread.heavyMode,
      sourceCandidates: thread.sourceCandidates.length,
      loaded: thread.loaded,
      resources: thread.resources,
      hasTextAttachments: thread.hasTextAttachments,
      textAttachmentCount: thread.textAttachmentCount
    })))()`, pageOneContext.id);
    assert.strictEqual(initialThreads.length, 3, 'Expected ordinary, heavy, and cross-origin threads on the mixed page');
    var ordinaryState = initialThreads.find(function(thread) { return thread.link.indexOf('/thread-100-1-1.html') !== -1; });
    var mixedHeavyState = initialThreads.find(function(thread) { return thread.link.indexOf('/thread-300-1-1.html') !== -1; });
    var crossState = initialThreads.find(function(thread) { return thread.link.indexOf('/thread-200-1-1.html') !== -1; });
    assert(ordinaryState && ordinaryState.sourceCandidates === 24, 'Same-origin article must expose all 24 ordinary candidates');
    assert(mixedHeavyState && mixedHeavyState.heavyMode && mixedHeavyState.sourceCandidates === 20, 'Mixed page must classify and retain the heavy channel beside ordinary work');
    assert(crossState && crossState.textAttachmentCount >= 1, 'Cross-origin article must preserve the detected TXT attachment count while automatic parsing progresses');
    var ordinaryItems = flattenResourceItems(ordinaryState.resources);
    var fixtureRoot = path.join(PROJECT_ROOT, 'tests/fixtures/pages');
    var pageCases = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'cases.json'), 'utf8')).cases;
    for (var pageCase of pageCases) {
      assert(/^[a-z-]+\.html$/.test(pageCase.file), 'Unsafe fixture path');
      var fixtureHtml = fs.readFileSync(path.join(fixtureRoot, pageCase.file), 'utf8');
      var fixtureResult = await evaluate(pageOne, `(html => {
        const base = 'https://www.sehuatang.org/thread-100-1-1.html';
        const images = SharedUtils.extractImagesByDom(html, base, 100);
        const resources = SharedUtils.extractResources(html, base, 'html');
        return { images: images.map(i => i.src), previews: images.map(i => i.previewSrc),
          resourceCount: SharedUtils.countResources(resources), passwords: resources.passwords,
          attachments: SharedUtils.extractTextAttachments(html, base, 8).length };
      })(${JSON.stringify(fixtureHtml)})`, pageOneContext.id);
      assert.deepStrictEqual(fixtureResult.images, pageCase.images, pageCase.file + ': browser images');
      if (pageCase.previews) assert.deepStrictEqual(fixtureResult.previews, pageCase.previews);
      assert.strictEqual(fixtureResult.resourceCount, pageCase.resourceType ? 1 : 0);
      assert.deepStrictEqual(fixtureResult.passwords, pageCase.passwords);
      assert.strictEqual(fixtureResult.attachments, pageCase.attachments);
    }
    var signedImageUrls = await evaluate(pageOne, `(() => {
      const url = 'https://img.example/photo.jpg?sig=a&amp;b;part2,';
      const encoded = url.replace(/&/g, '&amp;');
      return ['<img src="' + encoded + '">', '<a href="' + encoded + '">image</a>',
        '<meta property="og:image" content="' + encoded + '">'].map(html => ({
          expected: url,
          dom: SharedUtils.extractImagesByDom(html, location.href, 10)[0].src,
          fallback: SharedUtils.extractImagesByRegex(html, location.href, 10)[0].src
        }));
    })()`, pageOneContext.id);
    signedImageUrls.forEach(function(result) {
      assert.strictEqual(result.dom, result.expected, 'DOM extraction must preserve signed query values');
      assert.strictEqual(result.fallback, result.expected, 'fallback extraction must preserve signed query values');
    });
    assert(ordinaryItems.some(function(item) { return item.type === 'magnet' && /1111111111/.test(item.url); }), 'Main magnet link was not extracted');
    assert(ordinaryItems.some(function(item) { return item.type === 'baidu' && item.code === 'abcd'; }), 'Baidu access code was not bound to its link');
    assert(ordinaryItems.some(function(item) { return item.type === 'other' && /smoke\.zip/.test(item.url) && !item.code; }), 'Ordinary ZIP link inherited a cloud access code');
    assert((fixture.metrics.requestsByHost[CROSS_HOST] || 0) > 0, 'Cross-origin article did not pass through the background fetch path');

    // Exercise the real MAIN-world bridge, including a cross-origin endpoint
    // that would explicitly allow credentialed CORS without the same-origin mode.
    async function requestBridgeRedirect(kind) {
      return evaluate(pageOne, `(kind => new Promise((resolve, reject) => {
        const id = 'bridge_smoke_' + kind;
        const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('bridge smoke timeout')); }, 3000);
        function listener(event) {
          if (event.source !== window || event.origin !== location.origin || !event.data ||
              event.data.type !== 'ATP_PAGE_TEXT_FETCH_RESPONSE_V1' || event.data.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener('message', listener);
          resolve(event.data);
        }
        window.addEventListener('message', listener);
        window.postMessage({ type: 'ATP_PAGE_TEXT_FETCH_REQUEST_V1', id,
          url: location.origin + '/bridge-redirect.txt?target=' + kind, timeoutMs: 2000 }, location.origin);
      }))(${JSON.stringify(kind)})`);
    }
    var sameRedirect = await requestBridgeRedirect('same');
    assert.strictEqual(sameRedirect.ok, true, 'Page bridge must preserve allowed same-origin redirects');
    var targetsBeforeCrossRedirect = fixture.metrics.requestsByPath['/bridge-target.txt'] || 0;
    var crossRedirect = await requestBridgeRedirect('cross');
    assert.strictEqual(crossRedirect.ok, false, 'Page bridge must reject a cross-origin redirect');
    assert.strictEqual(fixture.metrics.requestsByPath['/bridge-target.txt'] || 0, targetsBeforeCrossRedirect,
      'Cross-origin redirect destination must not receive a network request');

    var openedResourcePanel = await evaluate(pageOne, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-200-1-1.html'));
      const trigger = thread && thread.panel && thread.panel.querySelector('[data-resource-trigger]');
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`, pageOneContext.id);
    assert(openedResourcePanel, 'Cross-origin resource trigger was not available');
    var txtState = await waitFor('automatic fresh TXT resource extraction', async function() {
      var state = await evaluate(pageOne, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-200-1-1.html'));
        if (!thread || !thread.textResourcesDone) return null;
        return {
          resources: thread.resources,
          retryable: thread.textResourcesRetryable,
          autoAttempted: thread.textResourcesAutoAttempted,
          autoActive: thread.textResourcesAutoActive
        };
      })()`, pageOneContext.id);
      if (!state) return null;
      var items = flattenResourceItems(state.resources);
      return items.some(function(item) { return item.type === 'ed2k' && /43B5B13B95A9187A3BF041CC0A94FFC2/.test(item.url); }) ? state : null;
    });
    assert(txtState && txtState.autoAttempted === true && txtState.autoActive === false && txtState.retryable === false, 'Automatic fresh TXT extraction did not finish cleanly');
    var automaticTxtUi = await evaluate(pageOne, `(() => ({
      hasFallback: !!document.querySelector('#atp-resource-sidebar [data-parse-txt], #atp-resource-sidebar [data-import-txt]'),
      hasEd2kCopy: !!document.querySelector('#atp-resource-sidebar [data-copy-type="ed2k"]')
    }))()`, pageOneContext.id);
    assert(automaticTxtUi && !automaticTxtUi.hasFallback && automaticTxtUi.hasEd2kCopy, 'Successful automatic 86-byte ED2K TXT extraction must show a copy action without manual fallback buttons');
    assert((fixture.metrics.requestsByPath['/forum.php'] || 0) >= 2, 'TXT attachment fetch was not observed');

    var pageTwo = await createPageSession(devtoolsPort);
    sessions.push(pageTwo);
    var heavyForumUrl = 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=heavy';
    await navigate(pageTwo, heavyForumUrl);
    await waitFor('second-tab floating panel injection', async function() {
      return evaluate(pageTwo, 'document.querySelectorAll("#bfp-root").length === 1');
    });
    var pageTwoContext = await waitForExtensionContext(pageTwo, extensionId);
    await waitFor('heavy thread panel', async function() {
      return evaluate(pageTwo, 'document.querySelectorAll(".atp-thread-panel").length === 1');
    });
    await waitFor('two concurrent heavy image requests', async function() {
      return fixture.metrics.maxHeavyImages >= 2;
    });
    var heavyFirstScreen = await waitFor('heavy first screen completion', async function() {
      var progress = await evaluate(pageTwo, `(() => {
        const thread = Object.values(window.ATPState.threads)[0];
        if (!thread || !thread.firstScreenDone) return null;
        return { firstScreenTotal: thread.firstScreenTotal, firstScreenOk: thread.firstScreenOk, loaded: thread.loaded };
      })()`, pageTwoContext.id);
      return progress && progress.firstScreenOk === progress.firstScreenTotal ? progress : null;
    });
    var heavyState = await evaluate(pageTwo, `(() => {
      const thread = Object.values(window.ATPState.threads)[0];
      return {
        heavyMode: thread.heavyMode,
        sourceCandidates: thread.sourceCandidates.length,
        configuredHeavyConcurrency: window.ATPState.settings.heavyImageConcurrency,
        configuredOrdinaryConcurrency: window.ATPState.settings.backgroundConcurrency
      };
    })()`, pageTwoContext.id);
    assert(heavyState.heavyMode && heavyState.sourceCandidates === 20, 'Heavy article was not classified with all source candidates');
    assert.strictEqual(heavyState.configuredHeavyConcurrency, 2, 'Heavy concurrency default changed unexpectedly');
    assert.strictEqual(heavyState.configuredOrdinaryConcurrency, 1, 'Ordinary background concurrency default changed unexpectedly');
    assert(fixture.metrics.maxHeavyImages <= 2, 'Heavy browser requests exceeded the configured concurrency');
    assert(fixture.metrics.maxOrdinaryImages <= 3, 'Ordinary first-screen requests exceeded the configured concurrency');

    var pageOneRootCount = await evaluate(pageOne, 'document.querySelectorAll("#bfp-root").length');
    var pageTwoRootCount = await evaluate(pageTwo, 'document.querySelectorAll("#bfp-root").length');
    assert.strictEqual(pageOneRootCount, 1, 'First tab must contain exactly one floating root');
    assert.strictEqual(pageTwoRootCount, 1, 'Second tab must contain exactly one floating root');

    var popup = await createPageSession(devtoolsPort);
    sessions.push(popup);
    await navigate(popup, 'chrome-extension://' + extensionId + '/popup.html');
    await waitFor('popup settings UI', async function() {
      return evaluate(popup, 'document.querySelector("#settingsContainer").children.length > 0 && document.querySelector("#versionFooter").textContent.includes("' + EXPECTED_VERSION + '")');
    });
    var messageResult = await evaluate(popup, `new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS_PATCH', settingsPatch: { debugLogging: false } }, (response) => {
        resolve({ response, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      });
    })`);
    assert(!messageResult.error && messageResult.response && messageResult.response.ok === true, 'Popup/background settings message failed: ' + JSON.stringify(messageResult));

    await evaluate(pageOne, `(() => {
      window.__atpSmokePageShows = [];
      window.addEventListener('pageshow', (event) => window.__atpSmokePageShows.push(event.persisted));
      return true;
    })()`);
    await navigate(pageOne, 'https://' + HEAVY_HOST + ':' + fixturePort + '/other.html');
    var history = await pageOne.cdp.send('Page.getNavigationHistory');
    var previousEntry = history.entries.slice(0, history.currentIndex).reverse().find(function(entry) {
      return entry.url.indexOf('/forum.php?mode=mixed') !== -1;
    });
    assert(previousEntry, 'Could not find the forum page in navigation history');
    await pageOne.cdp.send('Page.navigateToHistoryEntry', { entryId: previousEntry.id });
    await waitFor('BFCache return to forum', async function() {
      return evaluate(pageOne, 'location.href.includes("/forum.php?mode=mixed") && document.querySelectorAll("#bfp-root").length === 1');
    });
    await waitFor('BFCache pageshow marker', async function() {
      return evaluate(pageOne, 'Array.isArray(window.__atpSmokePageShows) && window.__atpSmokePageShows.includes(true)');
    }, 5000);
    var bfcacheState = await evaluate(pageOne, `({
      pageShows: window.__atpSmokePageShows || [],
      navigationType: (performance.getEntriesByType('navigation')[0] || {}).type || '',
      rootCount: document.querySelectorAll('#bfp-root').length,
      panelCount: document.querySelectorAll('.atp-thread-panel').length
    })`);
    var bfcachePersisted = bfcacheState.pageShows.indexOf(true) !== -1;

    var pageErrors = [summarizeErrors(pageOne), summarizeErrors(pageTwo), summarizeErrors(popup)];
    var allExceptions = [].concat.apply([], pageErrors.map(function(item) { return item.exceptions; }));
    var extensionConsoleErrors = [].concat.apply([], pageErrors.map(function(item) { return item.consoleErrors; }))
      .filter(function(text) { return /chrome-extension|ATP|bfp|Uncaught|TypeError|ReferenceError/i.test(text); });
    assert.strictEqual(allExceptions.length, 0, 'Browser runtime exceptions: ' + JSON.stringify(allExceptions));
    assert.strictEqual(extensionConsoleErrors.length, 0, 'Extension console errors: ' + JSON.stringify(extensionConsoleErrors));

    var report = {
      ok: true,
      browser: versionInfo.Browser,
      browserPath: browserPath,
      extensionId: extensionId,
      extensionVersion: packagedManifest.version,
      extensionDir: EXTENSION_DIR,
      extensionHashes: {
        loader: sha256File(path.join(EXTENSION_DIR, 'loader.js')),
        viewportObserver: sha256File(path.join(EXTENSION_DIR, 'viewport-observer.js')),
        loadingPolicy: sha256File(path.join(EXTENSION_DIR, 'loading-policy.js'))
      },
      isolatedWorld: true,
      pageOne: {
        rootCount: pageOneRootCount,
        threadCount: initialThreads.length,
        ordinaryCandidates: ordinaryState.sourceCandidates,
        mixedHeavyCandidates: mixedHeavyState.sourceCandidates,
        ordinaryFirstScreenLoaded: ordinaryFirstScreen.firstScreenOk,
        ordinaryLoadedAfterScroll: ordinaryBackgroundProgress.loaded,
        crossOriginTxtMarker: crossState.textAttachmentCount,
        txtFreshExtracted: true
      },
      pageTwo: {
        rootCount: pageTwoRootCount,
        heavyCandidates: heavyState.sourceCandidates,
        heavyFirstScreenLoaded: heavyFirstScreen.firstScreenOk
      },
      concurrency: {
        ordinaryObservedMax: fixture.metrics.maxOrdinaryImages,
        ordinaryConfiguredFirstScreen: 3,
        heavyObservedMax: fixture.metrics.maxHeavyImages,
        heavyConfigured: 2,
        combinedObservedMax: fixture.metrics.maxCombinedImages
      },
      popupBackgroundMessage: true,
      pageBridgeRedirectBoundary: true,
      signedImageUrlParity: true,
      syntheticPageFixtureCount: pageCases.length + 1,
      multiTab: true,
      bfcache: {
        persisted: bfcachePersisted,
        navigationType: bfcacheState.navigationType,
        rootCount: bfcacheState.rootCount,
        panelCount: bfcacheState.panelCount,
        notUsedReasons: pageOne.bfcacheNotUsed
      },
      fixtureRequests: fixture.metrics.requestCount,
      runtimeExceptions: allExceptions.length,
      extensionConsoleErrors: extensionConsoleErrors.length
    };
    if (!bfcachePersisted) {
      report.ok = false;
      report.warning = 'The browser completed a back/forward reload, but did not expose a persisted BFCache restore.';
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;

    await Promise.all(sessions.map(function(session) {
      session.cdp.close();
      return closeTarget(devtoolsPort, session.target.id);
    }));
    sessions.length = 0;
    try {
      await browserConnection.send('Browser.close');
    } catch (error) {}
    browserConnection.close();
    browserConnection = null;
  } finally {
    sessions.forEach(function(session) { session.cdp.close(); });
    if (browserConnection) {
      try { await browserConnection.send('Browser.close'); } catch (error) {}
      browserConnection.close();
    }
    await new Promise(function(resolve) {
      fixture.server.close(resolve);
      if (typeof fixture.server.closeAllConnections === 'function') fixture.server.closeAllConnections();
    });
    if (browser.exitCode === null) browser.kill();
    await Promise.race([
      new Promise(function(resolve) { browser.once('exit', resolve); }),
      sleep(3000)
    ]);
    if (process.env.ATP_BROWSER_SMOKE_KEEP !== '1') {
      removeSmokeRunRoot(runRoot);
    } else {
      console.log('browser smoke artifacts: ' + runRoot);
    }
  }
}

main().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
