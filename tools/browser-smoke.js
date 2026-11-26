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
const AGE_ENTRY_HOST = 'www.sehuatang.org';
const CROSS_HOST = 'other.sehuatang.org';
const SIGNED_RELAY_HOST = 'xia.djhdhs.us';
const TXT_DOWNLOAD_HOST = 'dl.ldkms.la';
const PACER_HOST = 'pacer.sehuatang.org';
const HEAVY_HOST = 'image.imx.to';
const HOT_IMAGE_HOST = 'hot.sehuatang.org';
const ATTACHMENT_LIVE_HOST = 'tu.djhdhs.us';
const ATTACHMENT_DEAD_HOST = 'tu.w4kmzkm.com';
const MIRROR_ROOT = 'smoke-mirror.test';
const MIRROR_HOST = 'www.' + MIRROR_ROOT;
const MIRROR_PATTERN = 'https://*.' + MIRROR_ROOT + '/*';
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

async function removeSmokeRunRoot(runRoot) {
  var resolvedRoot = path.resolve(runRoot);
  var tempPrefix = path.resolve(os.tmpdir()) + path.sep;
  assert(
    resolvedRoot.startsWith(tempPrefix) && path.basename(resolvedRoot).startsWith('atp-browser-smoke-'),
    'Refusing to remove an unexpected browser smoke directory: ' + resolvedRoot
  );
  await fs.promises.rm(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    "$san.AddDnsName('www.sehuatang.org')",
    "$san.AddDnsName('other.sehuatang.org')",
    "$san.AddDnsName('pacer.sehuatang.org')",
    "$san.AddDnsName('hot.sehuatang.org')",
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

function ageNoticeMarkup(url, mode) {
  const href = mode === 'other-origin' ? 'https://' + TXT_DOWNLOAD_HOST + ':' + url.port + '/' : url.origin + '/';
  const attributes = ' class="enter-btn" href="' + href + '"' + (mode === 'hidden' ? ' hidden' : '');
  const english = '<a' + attributes + '>If you are over 18，please click here</a>';
  return '<div class="domain">SEHUATANG.ORG</div><div class="row down-content"><h3>警告 / WARNING</h3></div>' +
    '<a' + attributes + '>满18岁，请点此进入</a>' +
    (mode === 'delayed' ? '<template id="pending-age-link">' + english + '</template>' : english) + '<iframe title="empty"></iframe>';
}

function serveAgeEntry(req, res, url, scenario, pixel) {
  const route = url.pathname + url.search;
  const topLevel = req.headers['sec-fetch-dest'] === 'document';
  if (topLevel) scenario.navigations.push(route);
  const finalResponse = topLevel && route === scenario.responsePath;
  const status = finalResponse ? scenario.status : 200;
  const rateNotice = finalResponse && scenario.rateNotice ? '<p id="messagetext">请求过于频繁，请稍后再试。</p>' : '';
  const forumHeader = '<div id="hd"><div id="nv">Forum</div></div>';
  const listing = '<div id="wp"><div id="ct"><div id="threadlist"><table><tbody id="normalthread_740"><tr><th>' +
    '<a class="xst" href="/thread-740-1-1.html">Synthetic post</a></th></tr></tbody></table></div></div></div>';
  const post = '<div id="wp"><div id="ct"><div id="postlist"><div id="postmessage_740">' +
    '<img src="/age-preview.png"></div></div></div></div>';
  let kind = 'gate', title = 'SEHUATANG.ORG', body = ageNoticeMarkup(url, scenario.mode) + rateNotice;
  if (route === '/age-preview.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(pixel);
    return;
  }
  if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (scenario.navigations.length > 5) {
    kind = 'loop-detected'; body = '<p>Navigation loop detected in the fixture</p>';
  } else if (scenario.mode === 'post-copy') {
    kind = 'post-copy'; body = forumHeader + '<div id="wp"><div id="postlist"><article id="postmessage_740">' + body + '</article></div></div>';
  } else if (scenario.mode === 'challenge') {
    kind = 'challenge'; body += '<form id="challenge-form" action="/cdn-cgi/challenge-platform/"><div class="cf-turnstile"></div></form>';
  } else if (scenario.mode === 'embedded' && route !== '/embedded-notice.html') {
    kind = 'embedded'; body = forumHeader + '<div id="wp"><div id="ct"><iframe src="/embedded-notice.html" title="quoted notice"></iframe></div></div>';
  } else if (topLevel && route === '/' && scenario.mode !== 'persistent' && !(scenario.mode === 'root-only' && scenario.navigations.length === 1)) {
    scenario.admitted = true;
    kind = 'landing'; title = 'Fixture forum'; body = forumHeader + '<div id="wp"><div id="ct">' + (rateNotice || 'Forum home') + '</div></div>';
  } else if (scenario.admitted && scenario.mode !== 'restored-gate') {
    kind = route === '/forum-95-1.html' || (url.pathname === '/forum.php' && url.searchParams.get('mod') === 'forumdisplay') ? 'forum' : 'post';
    title = 'Fixture ' + kind;
    body = forumHeader + (kind === 'forum' ? listing : post);
  }
  if (kind === 'landing' && status >= 400) {
    title = 'SEHUATANG.ORG'; body += ageNoticeMarkup(url, scenario.mode);
  }
  const instrumentation = '<script>document.body.dataset.ageFixture=' + JSON.stringify(kind) + ';document.body.dataset.ageNavigation=' + scenario.navigations.length + ';' +
    'document.addEventListener("click", e => { if(e.target.closest("a.enter-btn")) {' +
    'const key="smokeAgeClicks"; sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key)) + 1)); } },true);</script>';
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(htmlPage(body + instrumentation, title));
}

function forumPage(port, mode) {
  const row = id => '<tbody id="normalthread_' + id + '"><tr><th><a class="xst" href="/thread-' + id + '-1-1.html">Post ' + id + '</a></th></tr></tbody>';
  var rows;
  if (mode === 'heavy') {
    rows = '<tbody id="normalthread_300"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-300-1-1.html">Heavy gallery</a></th></tr></tbody>';
  } else if (mode === 'offscreen') {
    return htmlPage('<div id="threadlist" class="threadlist"><table id="threadlisttable">' +
      '<tbody id="normalthread_400"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-400-1-1.html">Near gallery</a></th></tr></tbody></table>' +
      '<div style="height:5000px"></div><table>' +
      '<tbody id="normalthread_401"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-401-1-1.html">Far gallery</a></th></tr></tbody></table></div>',
      'ATP offscreen forum');
  } else if (mode === 'host-limit') {
    rows = '<tbody id="normalthread_402"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-402-1-1.html">Host limit gallery</a></th></tr></tbody>';
  } else if (mode === 'ready-queue') {
    rows = '<tbody id="normalthread_404"><tr><th><a class="xst" href="/thread-404-1-1.html">Ready queue gallery</a></th></tr></tbody>';
  } else if (mode === 'long-gallery') {
    rows = '<tbody id="normalthread_409"><tr><th><a class="xst" href="/thread-409-1-1.html">Long gallery</a></th></tr></tbody>';
  } else if (mode === 'cached-row') {
    return htmlPage('<div id="threadlist"><table id="threadlisttable">' + row(410) + row(411) + '</table><div style="height:5000px"></div>' +
      '<table>' + row(412) + '</table></div><div class="smoke-note"></div>', 'Cached post with pending requests');
  } else if (mode === 'cold-scroll') {
    return htmlPage('<div style="height:1300px"></div><div id="threadlist"><table id="threadlisttable">' + row(413) + row(414) +
      '</table><div style="height:5000px"></div><table>' + row(415) + '</table></div><div class="smoke-note"></div>', 'Cold post with offscreen requests');
  } else if (mode === 'auth-retry') {
    rows = row(416) + row(417) + row(418);
  } else if (mode === 'offline-recovery') {
    rows = '';
  } else if (mode === 'scroll-priority') {
    return htmlPage('<div id="threadlist"><table id="threadlisttable"><tbody id="normalthread_407"><tr><th>' +
      '<a class="xst" href="/thread-407-1-1.html">Slow gallery</a></th></tr></tbody></table><div style="height:5000px"></div>' +
      '<table><tbody id="normalthread_408"><tr><th><a class="xst" href="/thread-408-1-1.html">Newly visible gallery</a>' +
      '</th></tr></tbody></table></div><div class="smoke-note"></div>', 'Scroll priority');
  } else if (mode === 'attachment-recovery') {
    rows = '<tbody id="normalthread_405"><tr><th><a class="xst" href="/thread-405-1-1.html">Attachment recovery gallery</a></th></tr></tbody>';
  } else if (mode === 'txt-retry') {
    rows = '<tbody id="normalthread_403"><tr><th><a class="xst" href="/thread-403-1-1.html">TXT retry fixture</a></th></tr></tbody>';
  } else if (mode === 'mirror') {
    // One thread on the mirror itself and one on the built-in forum; a mirror
    // page must never have the built-in thread fetched with that session.
    rows = '<tbody id="normalthread_600"><tr><th><a class="xst" href="https://' + MIRROR_HOST + ':' + port + '/thread-600-1-1.html">Mirror gallery</a></th></tr></tbody>' +
      '<tbody id="normalthread_500"><tr><th><a class="xst" href="https://' + SMOKE_HOST + ':' + port + '/thread-500-1-1.html">Built-in gallery</a></th></tr></tbody>';
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

function attachmentPath(index) {
  return '/tupian/forum/202611/17/00000' + index + 'abcdefghijklmnop.jpg';
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

function mirrorThread(port) {
  return htmlPage(
    '<h1>Mirror gallery</h1>' + imageMarkup(MIRROR_HOST, port, 'mirror', 6) +
    '<p><a href="https://' + MIRROR_HOST + ':' + port + '/forum.php?mod=attachment&aid=789">mirror-resources.txt</a></p>',
    'Mirror thread'
  );
}

function createFixtureServer(pfxPath) {
  var pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  var pausedScrollImages = new Set();
  var pausedMixedImages = new Set();
  var heldResponses = new Map();
  var scrollImagesReleased = false;
  var holdMixedImages = false;
  var ageEntry = { mode: '', admitted: false, navigations: [] };
  var metrics = {
    requestCount: 0,
    requestPaths: [],
    requestsByHost: {},
    requestsByPath: {},
    activeOrdinaryImages: 0,
    activeHostLimitImages: 0,
    activeFarImages: 0,
    activeHeavyImages: 0,
    activeImages: 0,
    activeAttachmentImages: 0,
    maxAttachmentImages: 0,
    activeScrollImages: 0,
    maxScrollImages: 0,
    maxOrdinaryImages: 0,
    maxHostLimitImages: 0,
    maxFarImages: 0,
    maxHeavyImages: 0,
    maxCombinedImages: 0
  };
  var server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: CERT_PASSWORD }, function(req, res) {
    var host = String(req.headers.host || '').split(':')[0].toLowerCase();
    var requestUrl = new URL(req.url, 'https://' + (req.headers.host || SMOKE_HOST));
    var pathname = requestUrl.pathname;
    metrics.requestCount++;
    metrics.requestPaths.push(pathname);
    metrics.requestsByHost[host] = (metrics.requestsByHost[host] || 0) + 1;
    metrics.requestsByPath[pathname] = (metrics.requestsByPath[pathname] || 0) + 1;

    if (host === AGE_ENTRY_HOST) {
      serveAgeEntry(req, res, requestUrl, ageEntry, pixel);
      return;
    }

    if (/^\/tupian\/forum\/202611\/17\/00000[0-5]abcdefghijklmnop\.jpg$/.test(pathname)) {
      if (host !== ATTACHMENT_LIVE_HOST) {
        if (pathname === attachmentPath(5) && metrics.activeAttachmentImages > 0) metrics.mixedFailedWhileLive = true;
        res.writeHead(404, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      metrics.activeAttachmentImages++;
      metrics.maxAttachmentImages = Math.max(metrics.maxAttachmentImages, metrics.activeAttachmentImages);
      var attachmentSettled = false;
      res.on('close', function() {
        if (attachmentSettled) return;
        attachmentSettled = true;
        metrics.activeAttachmentImages--;
      });
      setTimeout(function() {
        if (attachmentSettled || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(pixel);
      }, pathname === attachmentPath(2) || pathname === attachmentPath(4) ? 1200 : IMAGE_DELAY_MS);
      return;
    }

    if (pathname === '/admitted-image-probe.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length });
      res.end(pixel);
      return;
    }

    if (pathname === '/mixed-forum.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('https://pan.baidu.com/s/1AtpForumFirst');
      return;
    }
    if (host === PACER_HOST && pathname === '/manual-probe.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('https://pan.baidu.com/s/1AtpManualProbe');
      return;
    }
    if (/^\/thread-41[01348]-1-1\.html$/.test(pathname) || pathname === '/mixed-download.txt') {
      heldResponses.set(pathname, () => {
        const isText = pathname.endsWith('.txt');
        res.writeHead(200, { 'content-type': isText ? 'text/plain' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(isText ? 'https://pan.quark.cn/s/AtpMixedDownload' : htmlPage('<a href="https://pan.quark.cn/s/AtpCompletedPost">Post link</a>', 'Completed post'));
      });
      res.on('close', () => heldResponses.delete(pathname));
      return;
    }
    if (/^\/thread-41[5679]-1-1\.html$/.test(pathname)) {
      const firstRequest = metrics.requestsByPath[pathname] === 1;
      const permission = pathname.startsWith('/thread-417-') && firstRequest;
      const unauthorized = pathname.startsWith('/thread-416-') && firstRequest;
      res.writeHead(unauthorized ? 403 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      if (permission) {
        res.end(htmlPage('<div id="messagetext" class="alert_error"><p>抱歉，本帖要求阅读权限高于 50 才能浏览</p></div>', '提示信息'));
      } else {
        res.end(htmlPage(unauthorized ? '<p>Forbidden</p>' :
          '<div id="postmessage_1"><img src="/img/access-or-scroll-' + pathname.slice(8, 11) + '.jpg"></div>', 'Recovered post'));
      }
      return;
    }
    if (pathname === '/bridge-redirect.txt') {
      var redirectTarget = requestUrl.searchParams.get('target');
      var redirectHost = redirectTarget === 'cross' ? CROSS_HOST : (redirectTarget === 'self' ? host : SMOKE_HOST);
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

    if (pathname === '/signed-relay-entry.txt') {
      res.writeHead(302, { 'cache-control': 'no-store', location: 'https://' + SIGNED_RELAY_HOST + ':' +
        server.address().port + '/download?sig=c%2Bd&part=2' });
      res.end();
      return;
    }
    if (host === SIGNED_RELAY_HOST && pathname === '/download') {
      if (requestUrl.searchParams.get('sig') !== 'c+d' || requestUrl.searchParams.get('part') !== '2') {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('https://pan.baidu.com/s/1AtpSignedRelay\n提取碼：jk34');
      return;
    }

    if (pathname === '/one-use-attachment.txt') {
      if (metrics.requestsByPath[pathname] > 1) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<a href="https://' + CROSS_HOST + ':' + server.address().port +
        '/one-use-download.txt?sig=a%2Bb&amp;part=1">Download</a>', 'One-use intermediary'));
      return;
    }
    if (pathname === '/one-use-download.txt') {
      if (requestUrl.searchParams.get('sig') !== 'a+b' || requestUrl.searchParams.get('part') !== '1') {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('https://pan.baidu.com/s/1AtpOneUse\n提取码：rt12', 'utf16le')]));
      return;
    }
    if (pathname === '/forbidden-txt-fixture.txt') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (/^\/throttled-forum-[123]\.txt$/.test(pathname)) {
      res.writeHead(429, { 'retry-after': '120', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (pathname === '/retry-txt-fixture.txt') {
      var token = requestUrl.searchParams.get('sig');
      if (!metrics.retryTokens) metrics.retryTokens = [];
      metrics.retryTokens.push(token);
      if (token !== 'current') {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('https://pan.baidu.com/s/1AtpManualRetry\n提取码：mr12');
      return;
    }
    if (pathname === '/thread-403-1-1.html') {
      var signature = metrics.requestsByPath[pathname] === 1 ? 'expired' : 'current';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' });
      res.end(htmlPage('<p><a href="/retry-txt-fixture.txt?sig=' + signature + '">retry-txt-fixture.txt</a></p>', 'TXT retry fixture'));
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
    if (pathname === '/thread-600-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(mirrorThread(server.address().port));
      return;
    }
    if (pathname === '/thread-500-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ordinaryThread(server.address().port));
      return;
    }
    if (pathname === '/thread-400-1-1.html' || pathname === '/thread-401-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<h1>Offscreen gallery</h1>' + imageMarkup(SMOKE_HOST, server.address().port,
        pathname === '/thread-400-1-1.html' ? 'near' : 'far', pathname === '/thread-400-1-1.html' ? 10 : 13), 'Offscreen thread'));
      return;
    }
    if (pathname === '/thread-402-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<h1>Host limit gallery</h1>' + imageMarkup(HOT_IMAGE_HOST, server.address().port, 'host-limit', 14), 'Host limit thread'));
      return;
    }
    if (pathname === '/thread-404-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<div id="postmessage_1"><img src="/img/ready-hang.gif">' +
        imageMarkup(SMOKE_HOST, server.address().port, 'ready-queue', 5) + '</div>', 'Ready queue thread'));
      return;
    }
    if (pathname === '/thread-407-1-1.html' || pathname === '/thread-408-1-1.html') {
      var files = pathname.includes('407') ? ['slow-1.gif', 'slow-2.gif', 'slow-3.webp'] : ['visible-1.jpg', 'visible-2.jpg'];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<div id="postmessage_1">' + files.map(file => '<img src="https://' + HOT_IMAGE_HOST + ':' +
        server.address().port + '/scroll-images/' + file + '">').join('') + '</div>', 'Scroll priority gallery'));
      return;
    }
    if (pathname === '/thread-409-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<div id="postmessage_409">' + imageMarkup(HOT_IMAGE_HOST, server.address().port, 'long-gallery', 5000) + '</div>', '5,000 images'));
      return;
    }
    if (pathname.startsWith('/scroll-images/')) {
      metrics.activeScrollImages++;
      metrics.maxScrollImages = Math.max(metrics.maxScrollImages, metrics.activeScrollImages);
      const slow = pathname.includes('/slow-') && !scrollImagesReleased;
      const socket = req.socket;
      let settled = false;
      const send = function() {
        if (settled || res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length, 'cache-control': 'no-store' });
        res.end(pixel);
      };
      const timer = setTimeout(send, slow ? 11000 : 50);
      if (slow) pausedScrollImages.add(send);
      function settle() {
        if (settled) return;
        settled = true;
        socket.removeListener('end', settle);
        clearTimeout(timer);
        pausedScrollImages.delete(send);
        metrics.activeScrollImages--;
      }
      // Count live responses. A cancelled image can close its socket before
      // Node emits the response's close event, and keep-alive sockets can outlive a response.
      socket.once('end', settle);
      res.once('finish', settle);
      res.once('close', settle);
      return;
    }
    if (pathname === '/thread-406-1-1.html') {
      var port = server.address().port;
      var mixedImages = '<img src="https://' + ATTACHMENT_LIVE_HOST + ':' + port + attachmentPath(4) + '">' +
        '<img src="https://' + ATTACHMENT_DEAD_HOST + ':' + port + attachmentPath(5) + '">' + imageMarkup(HEAVY_HOST, port, 'heavy-mixed', 3);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<div id="postmessage_406">' + mixedImages + '</div>', 'Mixed attachment recovery'));
      return;
    }
    if (pathname === '/thread-405-1-1.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<div id="postmessage_1">' + [0, 1].map(function(index) {
        return '<img src="https://' + ATTACHMENT_LIVE_HOST + ':' + server.address().port + attachmentPath(index) + '">';
      }).join('') + '</div>', 'Attachment recovery thread'));
      return;
    }
    if (pathname === '/other.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('<h1>BFCache destination</h1>', 'BFCache destination'));
      return;
    }
    if (pathname.indexOf('/img/') === 0) {
      var heavy = host === HEAVY_HOST;
      var far = pathname.indexOf('/img/far-') === 0;
      var hostLimitImage = pathname.indexOf('/img/host-limit-') === 0;
      var settled = false;
      if (heavy) {
        metrics.activeHeavyImages++;
        metrics.maxHeavyImages = Math.max(metrics.maxHeavyImages, metrics.activeHeavyImages);
      } else {
        metrics.activeOrdinaryImages++;
        metrics.maxOrdinaryImages = Math.max(metrics.maxOrdinaryImages, metrics.activeOrdinaryImages);
      }
      if (far) {
        metrics.activeFarImages++;
        metrics.maxFarImages = Math.max(metrics.maxFarImages, metrics.activeFarImages);
      }
      if (hostLimitImage) {
        metrics.activeHostLimitImages++;
        metrics.maxHostLimitImages = Math.max(metrics.maxHostLimitImages, metrics.activeHostLimitImages);
      }
      metrics.activeImages++;
      metrics.maxCombinedImages = Math.max(metrics.maxCombinedImages, metrics.activeImages);
      function settleImage() {
        if (settled) return;
        settled = true;
        if (heavy) metrics.activeHeavyImages = Math.max(0, metrics.activeHeavyImages - 1);
        else metrics.activeOrdinaryImages = Math.max(0, metrics.activeOrdinaryImages - 1);
        if (far) metrics.activeFarImages = Math.max(0, metrics.activeFarImages - 1);
        if (hostLimitImage) metrics.activeHostLimitImages = Math.max(0, metrics.activeHostLimitImages - 1);
        metrics.activeImages = Math.max(0, metrics.activeImages - 1);
      }
      res.on('close', settleImage);
      if (pathname === '/img/ready-hang.gif') {
        res.once('close', function() { metrics.readyHangClosed = (metrics.readyHangClosed || 0) + 1; });
        return;
      }
      function sendImage() {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length });
          res.end(pixel, settleImage);
        } else {
          settleImage();
        }
      }
      if (holdMixedImages && /^\/img\/(?:ordinary|heavy)-\d+\.jpg$/.test(pathname)) {
        pausedMixedImages.add(sendImage);
        res.once('close', () => pausedMixedImages.delete(sendImage));
      } else {
        setTimeout(sendImage, pathname === '/img/long-gallery-0.jpg' ? 1500 : (hostLimitImage ? 650 : IMAGE_DELAY_MS));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return {
    server, metrics, ageEntry, heldResponses,
    releaseScrollImages() {
      scrollImagesReleased = true;
      pausedScrollImages.forEach(send => send());
    },
    holdMixedImages() {
      holdMixedImages = true;
    },
    releaseMixedImages() {
      holdMixedImages = false;
      pausedMixedImages.forEach(send => send());
      pausedMixedImages.clear();
    }
  };
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

function matchesExtensionManifest(actual, expected) {
  return !!(actual && actual.name === expected.name && actual.version === expected.version &&
    actual.manifest_version === expected.manifest_version && actual.background &&
    actual.background.service_worker === expected.background.service_worker);
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

async function createPageSession(devtoolsPort, existingTarget) {
  var target = existingTarget || await createTarget(devtoolsPort, 'about:blank');
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

function spawnSmokeBrowser(browserPath, profileDir, extensionDir, mappedHosts) {
  var output = '';
  var child = childProcess.spawn(browserPath, [
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
    '--disable-extensions-except=' + extensionDir,
    '--load-extension=' + extensionDir,
    '--host-resolver-rules=' + mappedHosts.map(function(host) { return 'MAP ' + host + ' 127.0.0.1'; }).join(', ') + ', EXCLUDE localhost',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', function(chunk) { output = (output + chunk.toString()).slice(-32768); });
  child.stderr.on('data', function(chunk) { output = (output + chunk.toString()).slice(-32768); });
  return { child: child, output: function() { return output; } };
}

async function waitForDevtoolsPort(profileDir, browser) {
  var devtoolsFile = path.join(profileDir, 'DevToolsActivePort');
  var devtoolsText = await waitFor('DevToolsActivePort', async function() {
    if (browser.child.exitCode !== null) throw new Error('Browser exited with code ' + browser.child.exitCode + '\n' + browser.output());
    if (!fs.existsSync(devtoolsFile)) return null;
    var text = fs.readFileSync(devtoolsFile, 'utf8').trim();
    return text || null;
  }, DEVTOOLS_TIMEOUT_MS);
  var devtoolsLines = devtoolsText.split(/\r?\n/);
  var devtoolsPort = Number(devtoolsLines[0]);
  assert(Number.isFinite(devtoolsPort) && devtoolsPort > 0, 'Invalid DevTools port: ' + devtoolsLines[0]);
  return devtoolsPort;
}

async function findExtensionWorkerTarget(devtoolsPort, manifest) {
  var expectedWorkerPath = '/' + String(manifest.background && manifest.background.service_worker || 'background.js').replace(/^\/+/, '');
  return waitFor('unpacked extension service worker', async function() {
    var targets = await listTargets(devtoolsPort);
    for (var target of targets) {
      if (target.type !== 'service_worker' || !/^chrome-extension:\/\//.test(target.url || '')) continue;
      var workerConnection = null;
      try {
        if (new URL(target.url).pathname !== expectedWorkerPath || !target.webSocketDebuggerUrl) continue;
        workerConnection = await new CdpConnection(target.webSocketDebuggerUrl).connect();
        var workerResult = await workerConnection.send('Runtime.evaluate', {
          expression: 'chrome.runtime.getManifest()', returnByValue: true
        });
        var workerManifest = workerResult.result && workerResult.result.value;
        if (matchesExtensionManifest(workerManifest, manifest)) return target;
      } catch (error) {
        // A worker may disappear while its target is being inspected; retry.
      } finally {
        if (workerConnection) workerConnection.close();
      }
    }
    return null;
  }, DEVTOOLS_TIMEOUT_MS, 120);
}

async function stopSmokeBrowser(browser) {
  if (!browser || !browser.child) return;
  if (browser.child.exitCode !== null || browser.child.signalCode !== null || !browser.child.pid) return;
  if (browser.child.exitCode === null) browser.child.kill();
  await Promise.race([
    new Promise(function(resolve) { browser.child.once('exit', resolve); }),
    sleep(3000)
  ]);
}

async function evaluateInWorker(devtoolsPort, manifest, expression) {
  var target = await findExtensionWorkerTarget(devtoolsPort, manifest);
  var connection = await new CdpConnection(target.webSocketDebuggerUrl).connect();
  try {
    var result = await connection.send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'worker evaluation failed');
    return result.result ? result.result.value : undefined;
  } finally {
    connection.close();
  }
}

// Chrome's optional-permission prompt cannot be answered headlessly, so the
// mirror session loads a copy whose only change is the mirror grant approved
// up front in host_permissions. The worker derives mirrors from granted
// origins either way, so registration, injection and the zone boundary run
// the shipped code unmodified.
function createMirrorGrantExtensionCopy(runRoot) {
  var copyDir = path.join(runRoot, 'mirror-extension');
  fs.cpSync(EXTENSION_DIR, copyDir, { recursive: true });
  var manifestPath = path.join(copyDir, 'manifest.json');
  var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = (manifest.host_permissions || []).concat([MIRROR_PATTERN]);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { dir: copyDir, manifest: manifest };
}

async function runMirrorScenario(browserPath, runRoot, fixture, fixturePort) {
  var copy = createMirrorGrantExtensionCopy(runRoot);
  var profileDir = path.join(runRoot, 'mirror-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  var browser = spawnSmokeBrowser(browserPath, profileDir, copy.dir, [MIRROR_HOST, SMOKE_HOST]);
  var page = null;
  var devtoolsPort = 0;
  var browserConnection = null;
  try {
    devtoolsPort = await waitForDevtoolsPort(profileDir, browser);
    var versionInfo = await fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/version');
    browserConnection = await new CdpConnection(versionInfo.webSocketDebuggerUrl).connect();
    var workerTarget = await findExtensionWorkerTarget(devtoolsPort, copy.manifest);
    var extensionId = /^chrome-extension:\/\/([a-p]{32})/.exec(workerTarget.url || '')[1];

    var registration = await waitFor('mirror content script registration', async function() {
      var state = await evaluateInWorker(devtoolsPort, copy.manifest, `(async () => ({
        scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, world: s.world || 'ISOLATED', js: s.js.length })),
        stored: (await chrome.storage.local.get('atp_mirror_sites_v1')).atp_mirror_sites_v1 || null
      }))()`);
      return state && state.scripts.length === 2 && state.stored && state.stored.sites.length === 1 ? state : null;
    });
    registration.scripts.forEach(function(script) {
      assert.deepStrictEqual(script.matches, [MIRROR_PATTERN], 'Mirror scripts must match only the granted mirror pattern');
    });
    assert.deepStrictEqual(registration.scripts.map(function(script) { return script.world; }).sort(), ['ISOLATED', 'MAIN'],
      'Mirror registration must include the MAIN-world page bridge and the isolated runtime');
    assert.strictEqual(registration.stored.sites[0].root, MIRROR_ROOT);

    var builtinThreadRequestsBefore = fixture.metrics.requestsByPath['/thread-500-1-1.html'] || 0;
    page = await createPageSession(devtoolsPort);
    await navigate(page, 'https://' + MIRROR_HOST + ':' + fixturePort + '/forum.php?mode=mirror');
    var context = await waitForExtensionContext(page, extensionId);
    await waitFor('mirror floating panel styles', async function() {
      return evaluate(page, `(() => {
        const root = document.querySelector('#bfp-root');
        const style = root && root.shadowRoot && root.shadowRoot.querySelector('style');
        return !!(style && style.textContent.includes('.bfp-panel') && root.style.visibility !== 'hidden');
      })()`);
    });
    var gallery = await waitFor('mirror first screen', async function() {
      var state = await evaluate(page, `(() => {
        const threads = Object.values(window.ATPState.threads);
        const thread = threads.find((item) => item.link.includes('/thread-600-1-1.html'));
        if (!thread || !thread.firstScreenDone) return null;
        return {
          threadCount: threads.length,
          panelCount: document.querySelectorAll('.atp-thread-panel').length,
          firstScreenOk: thread.firstScreenOk,
          firstScreenTotal: thread.firstScreenTotal
        };
      })()`, context.id);
      return state && state.firstScreenOk === state.firstScreenTotal && state.firstScreenOk > 0 ? state : null;
    });
    assert.strictEqual(gallery.threadCount, 1, 'A mirror page must only process threads from its own site');
    assert.strictEqual(gallery.panelCount, 1);

    var txt = await waitFor('mirror same-origin TXT through the page bridge', async function() {
      var state = await evaluate(page, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-600-1-1.html'));
        return thread && thread.textResourcesDone ? thread.resources : null;
      })()`, context.id);
      if (!state) return null;
      return flattenResourceItems(state).some(function(item) { return item.type === 'ed2k' && /43B5B13B95A9187A3BF041CC0A94FFC2/.test(item.url); }) ? state : null;
    });
    assert(txt, 'Mirror TXT attachment was not resolved');

    var bridge = await evaluate(page, `new Promise((resolve, reject) => {
      const id = 'bridge_mirror_self';
      const timer = setTimeout(() => reject(new Error('mirror bridge timeout')), 3000);
      window.addEventListener('message', function listener(event) {
        if (event.source !== window || !event.data || event.data.type !== 'ATP_PAGE_TEXT_FETCH_RESPONSE_V1' || event.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(event.data.ok);
      });
      window.postMessage({ type: 'ATP_PAGE_TEXT_FETCH_REQUEST_V1', id, url: location.origin + '/bridge-redirect.txt?target=self', timeoutMs: 2000 }, location.origin);
    })`);
    assert.strictEqual(bridge, true, 'The MAIN-world bridge must run on granted mirrors');

    // Article jobs start together; any cross-site fetch would have landed by now.
    await sleep(300);
    assert.strictEqual(fixture.metrics.requestsByPath['/thread-500-1-1.html'] || 0, builtinThreadRequestsBefore,
      'A mirror page must never have a built-in thread fetched');

    var errors = summarizeErrors(page);
    var extensionErrors = errors.consoleErrors.filter(function(text) { return /chrome-extension|ATP|bfp|Uncaught|TypeError|ReferenceError/i.test(text); });
    assert.strictEqual(errors.exceptions.length, 0, 'Mirror runtime exceptions: ' + JSON.stringify(errors.exceptions));
    assert.strictEqual(extensionErrors.length, 0, 'Mirror extension console errors: ' + JSON.stringify(extensionErrors));

    return {
      registeredScripts: registration.scripts.length,
      threadCount: gallery.threadCount,
      firstScreenLoaded: gallery.firstScreenOk,
      txtResolved: true,
      pageBridge: true,
      floatingPanelStyled: true,
      crossSiteThreadRequests: 0
    };
  } finally {
    if (page) {
      page.cdp.close();
      await closeTarget(devtoolsPort, page.target.id);
    }
    if (browserConnection) {
      try { await browserConnection.send('Browser.close'); } catch (error) {}
      browserConnection.close();
    }
    await stopSmokeBrowser(browser);
  }
}

async function checkScrollPriority(page, extensionId, fixturePort, fixture) {
  const inFlight = new Set();
  const imagePrefix = 'https://' + HOT_IMAGE_HOST + ':' + fixturePort + '/scroll-images/';
  let maxBrowserInFlight = 0;
  let cancelled = 0;
  const listeners = [
    page.cdp.on('Network.requestWillBeSent', ({ request, requestId }) => {
      if (!request.url.startsWith(imagePrefix)) return;
      inFlight.add(requestId);
      maxBrowserInFlight = Math.max(maxBrowserInFlight, inFlight.size);
    }),
    page.cdp.on('Network.loadingFinished', ({ requestId }) => inFlight.delete(requestId)),
    page.cdp.on('Network.loadingFailed', ({ requestId, canceled }) => {
      if (inFlight.delete(requestId) && canceled) cancelled++;
    })
  ];
  try {
    await page.cdp.send('Network.enable');
    await navigate(page, 'https://' + CROSS_HOST + ':' + fixturePort + '/forum.php?mode=scroll-priority');
    const context = await waitForExtensionContext(page, extensionId);
    await waitFor('three original same-host images in flight', () => fixture.metrics.activeScrollImages === 3 && inFlight.size === 3);
    assert.strictEqual(fixture.metrics.requestsByPath['/scroll-images/visible-1.jpg'] || 0, 0);
    const started = Date.now();
    await evaluate(page, `document.querySelector('#normalthread_408').scrollIntoView({ block: 'center' })`);
    function threadProgress(id) {
      return evaluate(page, `(() => {
        const t = Object.values(ATPState.threads).find(item => item.link.includes('/thread-${id}-'));
        if (!t) return null;
        return { loaded: t.loaded, failed: t.failedCount, cells: t.grid.children.length,
          displayed: [...t.grid.querySelectorAll('.atp-thumbnail-img')].filter(img => img.complete && img.naturalWidth > 0).length };
      })()`, context.id);
    }
    const firstVisible = await waitFor('newly visible image under same-host pressure', async function() {
      const progress = await threadProgress(408);
      return progress && progress.displayed > 0 ? Date.now() - started : null;
    }, 18000, 20);
    assert(firstVisible < 4000, 'newly visible image waited ' + firstVisible + 'ms behind old offscreen requests');
    await waitFor('both newly visible thumbnails before releasing the slow responses', async function() {
      const progress = await threadProgress(408);
      return progress && progress.displayed === 2 && progress.failed === 0 && progress.cells === 2;
    }, 3000, 20);
    fixture.releaseScrollImages();
    await evaluate(page, `document.querySelector('#normalthread_407').scrollIntoView({ block: 'center' })`);
    await waitFor('original cells resume after scrolling back', async function() {
      const progress = await threadProgress(407);
      return progress && progress.loaded === 3 && progress.failed === 0 && progress.cells === 3 && progress.displayed === 3;
    });
    const slowAttempts = Object.entries(fixture.metrics.requestsByPath).filter(([name]) => name.startsWith('/scroll-images/slow-'))
      .map(([, count]) => count);
    assert(slowAttempts.every(count => count <= 2), 'a slow image must not be repeatedly cancelled and restarted');
    assert.strictEqual(cancelled, 1, 'Chromium must cancel exactly one displaced image request');
    assert.strictEqual(maxBrowserInFlight, 3, 'Chromium must cancel the old request before spending its image slot on a new request');
    assert.strictEqual(fixture.metrics.maxScrollImages, 3, 'old and new images must share the same three live responses');
    return { firstVisibleMs: firstVisible, maxConcurrent: fixture.metrics.maxScrollImages, maxBrowserInFlight,
      restoredImages: 3, restartedRequests: slowAttempts.reduce((total, count) => total + count - 1, 0) };
  } finally {
    listeners.forEach(remove => remove());
    await page.cdp.send('Network.disable');
  }
}

async function checkLongGallery(page, extensionId, fixturePort, fixture) {
  const listing = 'https://' + CROSS_HOST + ':' + fixturePort + '/forum.php?mode=long-gallery';
  await navigate(page, listing);
  const context = await waitForExtensionContext(page, extensionId);
  await waitFor('first image occupies the only connection in a 5,000-image gallery', () => fixture.metrics.requestsByPath['/img/long-gallery-0.jpg'] === 1);
  const click = await evaluate(page, `(() => {
    const gallery = Object.values(ATPState.threads).find(t => t.link.includes('/thread-409-'));
    const button = gallery.panel.querySelector('.atp-thumbnail-expand');
    const started = performance.now();
    button.click();
    const measured = { clickMs: Math.round((performance.now() - started) * 10) / 10,
      candidates: gallery.candidates.length, requestedLimit: gallery.readyImageLimit, prepared: gallery.readyImageIndexed };
    button.click();
    return measured;
  })()`, context.id);
  assert.strictEqual(click.candidates, 5000);
  assert.strictEqual(click.requestedLimit, 5000);
  assert(click.prepared < click.candidates, 'an expand click prepared all ' + click.prepared + ' images synchronously, taking ' + click.clickMs + 'ms');
  const cached = await waitFor('all 5,000 extracted images are saved as a complete article', () => evaluate(page, `(async () => {
    const gallery = Object.values(ATPState.threads).find(t => t.link.includes('/thread-409-'));
    const data = await ATPCache.getCachedArticleData(gallery.link);
    return data && { count: data.images.length, partial: data.partial,
      currentExtraction: data.imageExtractionVersion === SharedUtils.ARTICLE_IMAGE_EXTRACTION_VERSION };
  })()`, context.id));
  assert.deepStrictEqual(cached, { count: 5000, partial: false, currentExtraction: true });
  await waitFor('collapse still lets the original thumbnail finish', () => evaluate(page, `(() => {
    const t = Object.values(ATPState.threads).find(t => t.link.includes('/thread-409-'));
    return t.loaded === 1 && t.grid.children.length === 1 && t.readyImageLimit === 1;
  })()`, context.id));
  assert.strictEqual(Object.keys(fixture.metrics.requestsByPath).filter(p => p.startsWith('/img/long-gallery-')).length, 1,
    'collapsed rows must not start queued downloads');

  const articleRequests = fixture.metrics.requestsByPath['/thread-409-1-1.html'];
  const script = await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
    const timing = window.atpGalleryTiming = { frames: 0, longTasks: [] };
    function frame() {
      timing.frames++;
      if (!timing.finished) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    const observer = new PerformanceObserver(list => {
      for (const item of list.getEntries()) timing.longTasks.push(Math.round(item.duration));
    });
    observer.observe({ type: 'longtask', buffered: true });
    timing.finish = () => {
      timing.finished = true;
      observer.disconnect();
    };
  })()`});
  try {
    await navigate(page, listing + '&warm=1');
    const warmContext = await waitForExtensionContext(page, extensionId);
    const warm = await waitFor('the warm gallery restores its complete ordered list and one thumbnail', () => evaluate(page, `(() => {
      const gallery = Object.values(ATPState.threads).find(t => t.link.includes('/thread-409-'));
      if (!gallery || gallery.loaded !== 1) return null;
      return {
        candidates: gallery.candidates.length,
        last: new URL(gallery.candidates.at(-1).src).pathname,
        firstScreen: gallery.firstScreenOk,
        partial: gallery.partial
      };
    })()`, warmContext.id));
    assert.deepStrictEqual(warm, {
      candidates: 5000, last: '/img/long-gallery-4999.jpg', firstScreen: 1, partial: false
    });
    assert.strictEqual(fixture.metrics.requestsByPath['/thread-409-1-1.html'], articleRequests,
      'a warmed gallery must commit from cache without another article request');
    const timing = await evaluate(page, `(() => {
      const timing = window.atpGalleryTiming;
      timing.finish();
      return { frames: timing.frames, maxLongTaskMs: Math.max(0, ...timing.longTasks) };
    })()`);
    return { ...click, cachedImages: cached.count, warm: { ...warm, ...timing, articleRequests: 0 } };
  } finally {
    await page.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
  }
}

async function checkAgeEntry(devtoolsPort, extensionId, manifest, port, fixture, sessions, completedSessions) {
  const forum = '/forum-95-1.html';
  const post = '/thread-740-1-1.html';
  const phpPost = '/forum.php?mod=viewthread&tid=740&page=2';
  const phpForum = '/forum.php?mod=forumdisplay&fid=95&page=2';
  const typeFilter = phpForum + '&filter=typeid&typeid=4';
  const sortFilter = phpForum + '&filter=sortid&sortid=6';
  const writeAction = '/forum.php?mod=post&action=newthread&fid=95';
  const origin = 'https://' + AGE_ENTRY_HOST + ':' + port;
  const cases = [
    { name: 'list', kind: 'forum', steps: [forum, '/', forum], clicks: 1 },
    { name: 'delayed', kind: 'forum', steps: [forum, '/', forum], clicks: 1 },
    { name: 'thread', kind: 'post', steps: [post, '/', post], clicks: 1 },
    { name: 'php-thread', kind: 'post', steps: [phpPost, '/', phpPost], clicks: 1 },
    { name: 'php-extra', kind: 'post', steps: [phpPost + '&extra=page%3D1', '/', phpPost], clicks: 1 },
    { name: 'php-type-filter', kind: 'forum', steps: [typeFilter, '/', typeFilter], clicks: 1 },
    { name: 'php-sort-filter', kind: 'forum', steps: [sortFilter + '&action=ignored', '/', sortFilter], clicks: 1 },
    { name: 'php-duplicate-filter-id', kind: 'forum', steps: [typeFilter + '&typeid=9', '/', phpForum], clicks: 1 },
    { name: 'root-only', kind: 'landing', steps: ['/', '/'], clicks: 1 },
    { name: 'write-action', kind: 'landing', steps: [writeAction, '/'], clicks: 1 },
    { name: 'persistent', kind: 'gate', steps: [forum, '/'], clicks: 1 },
    { name: 'restored-gate', kind: 'gate', steps: [post, '/', post], clicks: 1 },
    { name: 'post-copy', kind: 'post-copy', steps: [post], clicks: 0 },
    { name: 'challenge', kind: 'challenge', steps: [forum], clicks: 0 },
    { name: 'entry-429', kind: 'gate', steps: [forum], clicks: 0, status: 429, testManual: true },
    { name: 'entry-503', kind: 'gate', steps: [forum], clicks: 0, status: 503, testManual: true },
    { name: 'landing-429', kind: 'landing', steps: [forum, '/'], clicks: 1, status: 429 },
    { name: 'landing-503', kind: 'landing', steps: [forum, '/'], clicks: 1, status: 503 },
    { name: 'entry-rate-text', kind: 'gate', steps: [forum], clicks: 0, rateNotice: true, testManual: true },
    { name: 'landing-rate-text', kind: 'landing', steps: [forum, '/'], clicks: 1, rateNotice: true },
    { name: 'embedded', kind: 'embedded', steps: [forum], clicks: 0 },
    { name: 'hidden', kind: 'gate', steps: [forum], clicks: 0 },
    { name: 'other-origin', kind: 'gate', steps: [forum], clicks: 0 },
    { name: 'option-off', kind: 'gate', steps: [forum], clicks: 0, settings: { autoEnterAgeGate: false } },
    { name: 'site-off', kind: 'gate', steps: [forum], clicks: 0, settings: { siteConfigs: { 'sehuatang.org': { disabled: true } } } },
    { name: 'extension-off', kind: 'gate', steps: [forum], clicks: 0, settings: { enabled: false } }
  ];
  const previous = await evaluateInWorker(devtoolsPort, manifest, 'chrome.storage.local.get("settings")');
  const report = {};
  try {
    for (const sample of cases) {
      const settings = Object.assign({}, previous.settings, sample.settings);
      await evaluateInWorker(devtoolsPort, manifest, `chrome.storage.local.set({settings:${JSON.stringify(settings)}})`);
      Object.assign(fixture.ageEntry, { mode: sample.name, admitted: false, navigations: [],
        responsePath: sample.steps.at(-1), status: sample.status || 200, rateNotice: sample.rateNotice });
      const page = await createPageSession(devtoolsPort);
      sessions.push(page);
      const pageIds = () => listTargets(devtoolsPort).then(all => all.filter(item => item.type === 'page').map(item => item.id).sort());
      const tabsBefore = await pageIds();
      const finalUrl = origin + sample.steps.at(-1);
      async function waitForPage(kind, documentNumber, url = finalUrl) {
        await waitFor('age entry ' + sample.name + ' reaches ' + kind + ' in the original tab', async () => {
          const ctx = findExtensionContext(page, extensionId);
          return ctx && evaluate(page, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' &&
            document.body.dataset.ageFixture === ${JSON.stringify(kind)} && Number(document.body.dataset.ageNavigation) === ${documentNumber} &&
            window.ATPConfig?.loaded === true`, ctx.id);
        }, 6000, 25);
        await evaluate(page, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      }
      try {
        await navigate(page, origin + sample.steps[0]);
        if (sample.name === 'delayed') {
          await waitForPage('gate', 1);
          assert.strictEqual(await evaluate(page, 'document.querySelectorAll("body > a.enter-btn").length'), 1);
          assert.strictEqual(await evaluate(page, 'Number(sessionStorage.getItem("smokeAgeClicks"))'), 0);
          await evaluate(page, `(() => { const pending = document.querySelector('#pending-age-link'); pending.replaceWith(pending.content); })()`);
        }
        await waitForPage(sample.kind, sample.steps.length);
        if (sample.status || sample.rateNotice) {
          assert.strictEqual(await evaluate(page, 'performance.getEntriesByType("navigation")[0].responseStatus'), sample.status || 200,
            sample.name + ' must expose the real top-level HTTP status');
        }
        if (sample.rateNotice) {
          assert.match(await evaluate(page, 'document.querySelector("#messagetext").innerText'), /请求过于频繁/);
        }
        if (sample.steps.length === 3 && sample.steps[1] === '/') {
          const history = await page.cdp.send('Page.getNavigationHistory');
          assert(history.entries.every(entry => entry.url !== origin + '/'), 'restoring the original page must replace the temporary forum home in history');
        }
        if (sample.kind === 'forum') {
          await waitFor('restored list renders the article thumbnail', () => evaluate(page,
            '!!document.querySelector("#normalthread_740 .atp-thumbnail-img")?.naturalWidth'), 6000, 40);
        }
        if (sample.name === 'embedded') {
          assert.strictEqual(await evaluate(page, `document.querySelector('iframe').contentDocument.body.dataset.ageFixture`), 'gate',
            'the iframe must actually contain the age notice');
        }
        const failedEntry = sample.name === 'persistent' || sample.name === 'restored-gate';
        if (failedEntry) {
          await page.cdp.send('Page.reload', { ignoreCache: true });
          await waitForPage('gate', sample.steps.length + 1);
          assert.strictEqual(await evaluate(page, `document.querySelector('body > a.enter-btn')?.getBoundingClientRect().width > 0`), true,
            'a notice the site keeps returning must retain its visible manual entry');
        }
        const expected = failedEntry ? sample.steps.concat(sample.steps.at(-1)) : sample.steps;
        assert.deepStrictEqual(fixture.ageEntry.navigations, expected, sample.name + ' top-level HTTP requests');
        const clicks = await evaluate(page, 'Number(sessionStorage.getItem("smokeAgeClicks"))');
        assert.strictEqual(clicks, sample.clicks, sample.name + ' native entry activations');
        report[sample.name] = { clicks, navigations: expected.length };
        if (sample.status) report[sample.name].responseStatus = sample.status;
        if (failedEntry || sample.testManual) {
          const center = await evaluate(page, `(() => { const rect = document.querySelector('body > a.enter-btn').getBoundingClientRect();
            return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}; })()`);
          for (const type of ['mousePressed', 'mouseReleased']) {
            await page.cdp.send('Input.dispatchMouseEvent', { type, ...center, button: 'left', clickCount: 1 });
          }
          await waitForPage(sample.name === 'persistent' ? 'gate' : 'landing', expected.length + 1, origin + '/');
          assert.strictEqual(await evaluate(page, 'Number(sessionStorage.getItem("smokeAgeClicks"))'), clicks + 1);
          assert.deepStrictEqual(fixture.ageEntry.navigations, expected.concat('/'), 'manual entry must still reach the native root');
          report[sample.name].manualEntry = true;
        }
        assert.deepStrictEqual(await pageIds(), tabsBefore, sample.name + ' must preserve the original browser tabs');
      } catch (error) {
        const state = await evaluate(page, '({ url: location.href, title: document.title, fixture: document.body?.dataset.ageFixture, clicks: sessionStorage.getItem("smokeAgeClicks") })').catch(() => null);
        error.message += ' ' + JSON.stringify({ page: state, navigations: fixture.ageEntry.navigations });
        throw error;
      } finally {
        page.cdp.close();
        await closeTarget(devtoolsPort, page.target.id);
        sessions.splice(sessions.indexOf(page), 1);
        completedSessions.push(page);
      }
    }
  } finally {
    await evaluateInWorker(devtoolsPort, manifest, previous.settings ? `chrome.storage.local.set(${JSON.stringify(previous)})` : 'chrome.storage.local.remove("settings")');
  }
  return report;
}

async function checkCachedRowAndTextProgress(page, extensionId, port, fixture) {
  const seed = await waitForExtensionContext(page, extensionId);
  const cachedUrl = 'https://' + CROSS_HOST + ':' + port + '/thread-412-1-1.html';
  const cached = await evaluate(page, `ATPCache.setCachedArticleData(${JSON.stringify(cachedUrl)}, {
    textAttachments: [{url:location.origin + '/mixed-forum.txt', name:'forum.txt'},
      {url:'https://${TXT_DOWNLOAD_HOST}:${port}/mixed-download.txt', name:'download.txt'}]
  }, true)`, seed.id);
  assert(cached, 'the post used for the busy-worker check must be in storage');
  await navigate(page, 'https://' + CROSS_HOST + ':' + port + '/forum.php?mode=cached-row');
  const context = await waitForExtensionContext(page, extensionId);
  const slow = ['/thread-410-1-1.html', '/thread-411-1-1.html'];
  await waitFor('two unfinished article requests', () => slow.every(path => fixture.heldResponses.has(path)));
  await evaluate(page, `document.querySelector('#normalthread_412').scrollIntoView({block:'center'})`);
  const state = `Object.values(ATPState.threads).find(t => t.link.includes('/thread-412-'))`;
  await waitFor('the cached post renders with both article workers occupied', () => evaluate(page, `!!(${state})?.panel?.isConnected`, context.id), 6000, 25);
  assert(slow.every(path => fixture.heldResponses.has(path)), 'article workers must still be occupied when the cache hit is displayed');
  assert.strictEqual(fixture.metrics.requestsByPath['/thread-412-1-1.html'] || 0, 0);
  slow.forEach(path => fixture.heldResponses.get(path)());

  await waitFor('one usable copy button while the download site is pending', () => fixture.heldResponses.has('/mixed-download.txt') &&
    evaluate(page, `((t) => t.textResourcesLoading && t.textResolvedAttachmentIds?.length === 1 &&
      !!t.panel.querySelector('[data-copy-type="baidu"]'))(${state})`, context.id), 7000, 25);
  fixture.heldResponses.get('/mixed-download.txt')();
  await waitFor('both TXT resources become usable', () => evaluate(page, `((t) => t.textResourcesDone &&
    t.textResolvedAttachmentIds.length === 2 && !!t.panel.querySelector('[data-copy-type="quark"]'))(${state})`, context.id));
  assert.strictEqual(fixture.metrics.requestsByPath['/mixed-forum.txt'], 1);
  assert.strictEqual(fixture.metrics.requestsByPath['/mixed-download.txt'], 1);
  return { busyArticleWorkers: 2, cachedPostNetworkRequests: 0, copyButtonsBeforeDownload: 1, completedAttachments: 2 };
}

async function checkColdScrollAndArticleRetry(page, extensionId, port, fixture) {
  const origin = 'https://' + SMOKE_HOST + ':' + port;
  await page.cdp.send('Page.bringToFront');
  await navigate(page, origin + '/forum.php?mode=cold-scroll');
  let context = await waitForExtensionContext(page, extensionId);
  const slow = ['/thread-413-1-1.html', '/thread-414-1-1.html'];
  await waitFor('initial offscreen request', () => slow.some(route => fixture.heldResponses.has(route)));
  const started = Date.now();
  await evaluate(page, `document.querySelector('#normalthread_415').scrollIntoView({block:'center'})`);
  const firstImage = await waitFor('new visible post loads before the offscreen response', async () =>
    await evaluate(page, `document.querySelector('#normalthread_415 .atp-thumbnail-img')?.naturalWidth > 0`, context.id)
      ? Date.now() - started : null, 6000, 25);
  assert.strictEqual(slow.filter(route => fixture.heldResponses.has(route)).length, 1,
    'offscreen requests must leave a worker for a cold visible row');
  assert.strictEqual(fixture.metrics.requestsByPath['/thread-415-1-1.html'], 1);
  slow.forEach(route => fixture.heldResponses.get(route)?.());

  await navigate(page, origin + '/forum.php?mode=auth-retry');
  context = await waitForExtensionContext(page, extensionId);
  const notes = await waitFor('distinct login and permission messages', () => evaluate(page, `(() => {
    const forbidden = document.querySelector('#normalthread_416 .atp-forum-wait');
    const permission = document.querySelector('#normalthread_417 .atp-forum-wait');
    return forbidden?.querySelector('button') && permission?.querySelector('button')
      ? { forbidden: forbidden.textContent, permission: permission.textContent } : null;
  })()`, context.id));
  assert.match(notes.forbidden, /正文访问受限/);
  assert.match(notes.permission, /阅读权限不足/);
  const unrelated = '/thread-418-1-1.html';
  await waitFor('unrelated article remains in flight during a manual retry', () => fixture.heldResponses.has(unrelated));
  assert(await evaluate(page, `(() => {
    const button = document.querySelector('#normalthread_416 .atp-forum-retry');
    window.__atpManualRetry = [];
    document.addEventListener('click', event => {
      if (event.isTrusted && event.target.matches('.atp-forum-retry')) {
        window.__atpManualRetry.push(event.target.closest('tbody').id);
      }
    }, true);
    button.focus();
    return document.activeElement === button;
  })()`, context.id), 'the configured retry button must receive focus');
  await page.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'
  });
  await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const recovered = (id, checkFocus) => evaluate(page, `(() => {
    const row = document.querySelector('#normalthread_${id}');
    return row.querySelector('.atp-thumbnail-img')?.naturalWidth > 0 &&
      !row.querySelector('.atp-forum-wait') && (!${checkFocus} || document.activeElement === row.querySelector('.xst'));
  })()`, context.id);
  await waitFor('keyboard retry recovers the post before automatic retry', () => recovered(416, true), 5000, 25);
  assert.strictEqual(fixture.metrics.requestsByPath['/thread-416-1-1.html'], 2);
  assert.strictEqual(fixture.metrics.requestsByPath['/thread-417-1-1.html'], 1, 'retry must reload only the selected post');

  const center = await evaluate(page, `(() => {
    const button = document.querySelector('#normalthread_417 .atp-forum-retry');
    button.scrollIntoView({ block:'center' });
    const rect = button.getBoundingClientRect();
    return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
  })()`, context.id);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, ...center, button: 'left', clickCount: 1 });
  }
  await waitFor('pointer retry recovers the permission post', () => recovered(417, false), 5000, 25);
  assert.deepStrictEqual(await evaluate(page, 'window.__atpManualRetry', context.id), ['normalthread_416', 'normalthread_417']);
  assert.strictEqual(fixture.metrics.requestsByPath['/thread-417-1-1.html'], 2);
  assert(fixture.heldResponses.has(unrelated), 'manual retries must finish while the unrelated article remains in flight');
  fixture.heldResponses.get(unrelated)();
  return { coldPostFirstImageMs: firstImage, recoveredByKeyboard: true, recoveredByClick: true, unrelatedRequestStillPending: true };
}

async function checkOfflineArticleRecovery(page, extensionId, port, fixture) {
  const route = '/thread-419-1-1.html';
  await navigate(page, 'https://' + SMOKE_HOST + ':' + port + '/forum.php?mode=offline-recovery');
  const context = await waitForExtensionContext(page, extensionId);
  await waitFor('settings on the empty list', () => evaluate(page, 'ATPConfig.loaded', context.id));
  await page.cdp.send('Network.enable');
  const setOffline = offline => page.cdp.send('Network.emulateNetworkConditions', {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1
  });
  try {
    await setOffline(true);
    await waitFor('browser offline state', () => evaluate(page, 'navigator.onLine === false'));
    await evaluate(page, `document.querySelector('#threadlisttable').insertAdjacentHTML('beforeend',
      '<tbody id="normalthread_419"><tr><th><a class="xst" href="${route}">Offline post</a></th></tr></tbody>')`);
    await waitFor('offline notice on the new post', () => evaluate(page,
      `document.querySelector('#normalthread_419 .atp-forum-wait')?.textContent.includes('网络已断开')`), 7000, 25);
    assert.strictEqual(fixture.metrics.requestsByPath[route] || 0, 0);
  } finally {
    await setOffline(false);
  }
  try {
    const started = Date.now();
    await waitFor('post resumes when the browser reconnects', () => evaluate(page, `(() => {
      const row = document.querySelector('#normalthread_419');
      return navigator.onLine && row.querySelector('.atp-thumbnail-img')?.naturalWidth > 0 &&
        !row.querySelector('.atp-forum-wait');
    })()`), 7000, 25);
    assert.strictEqual(fixture.metrics.requestsByPath[route], 1);
    return { offlineRequests: 0, recoveredRequests: 1, reconnectToImageMs: Date.now() - started };
  } finally {
    await page.cdp.send('Network.disable');
  }
}

async function checkDynamicListPreview(page, contextId) {
  await waitFor('clickable thumbnail in the original list', function() {
    return evaluate(page, `(() => {
      const img = document.querySelector('#normalthread_400 .atp-thumbnail-wrapper[role=button] .atp-thumbnail-img');
      if (!img || !img.complete || !img.naturalWidth) return false;
      window.__atpOriginalThumb = img;
      return true;
    })()`, contextId);
  });
  const result = await evaluate(page, `(async () => {
    const img = window.__atpOriginalThumb;
    const list = document.querySelector('#threadlist');
    const previewOpen = () => document.querySelector('.atp-preview-overlay')?.style.display === 'flex';
    img.click();
    const before = previewOpen();
    document.querySelector('.atp-preview-close').click();
    const sibling = document.createElement('a');
    sibling.href = '/thread-98765-1-1.html';
    sibling.className = 'xst';
    sibling.textContent = 'Additional fixture thread';
    list.after(sibling);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    img.click();
    const after = previewOpen();
    if (after) document.querySelector('.atp-preview-close').click();
    sibling.remove();
    return { before, after, sameRoot: list === document.querySelector('#threadlist'), visible: img.getBoundingClientRect().width > 0 };
  })()`, contextId);
  assert.deepStrictEqual(result, { before: true, after: true, sameRoot: true, visible: true });
  return result;
}

async function checkResourcePanelThreadSelection(page, contextId) {
  const selection = await evaluate(page, `(async () => {
    const threads = Object.values(ATPState.threads);
    const pinned = threads.find(item => item.link.includes('/thread-100-1-1.html'));
    const selected = threads.find(item => item.link.includes('/thread-200-1-1.html'));
    const sidebar = document.querySelector('#atp-resource-sidebar');
    pinned.panel.querySelector('[data-resource-trigger]').click();
    sidebar.querySelector('[data-sidebar-pin-toggle]').click();
    selected.panel.querySelector('[data-resource-trigger]').click();
    const copy = sidebar.querySelector('[data-copy-all]');
    copy.focus();
    const keepsSelection = () => document.activeElement === copy &&
      sidebar.querySelector('.atp-resource-thread-title').textContent.includes(selected.title);

    const originalMessage = pinned.textResourceMessage;
    pinned.textResourceMessage = 'TXT ready in the pinned thread';
    ATPResourcePanel.updateThread(pinned);
    const afterUpdate = keepsSelection();
    pinned.textResourceMessage = originalMessage;
    ATPResourcePanel.updateThread(pinned);
    pinned.panel.dispatchEvent(new MouseEvent('mouseenter'));
    const afterHover = keepsSelection();

    // Capture the exact payload without changing the system clipboard.
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async text => { copied = text; } }
    });
    try {
      copy.click();
    } finally {
      delete navigator.clipboard;
    }
    return { afterUpdate, afterHover, copied };
  })()`, contextId);
  assert(selection.afterUpdate && selection.afterHover, 'another thread must leave the active sidebar and focused copy action intact');
  assert(selection.copied.includes('AtpCrossMain') && !selection.copied.includes('1AtpSmokeMain'),
    'copying from the active sidebar must use the selected thread, including while another thread is pinned');

  const dismissalState = `(() => {
    const sidebar = document.querySelector('#atp-resource-sidebar');
    const pinned = document.querySelector('#normalthread_100 [data-resource-trigger]');
    const selected = document.querySelector('#normalthread_200 [data-resource-trigger]');
    return {
      expandedPinned: pinned.getAttribute('aria-expanded'),
      expandedSelected: selected.getAttribute('aria-expanded'),
      pinnedShown: !!sidebar.querySelector('.atp-resource-pin-badge'),
      empty: !sidebar.querySelector('.atp-resource-thread-title'),
      restoredFocus: document.activeElement === selected
    };
  })()`;
  await pressSmokeKey(page, 'Escape', 'Escape', 27);
  assert.deepStrictEqual(await evaluate(page, dismissalState, contextId), {
    expandedPinned: 'true', expandedSelected: 'false', pinnedShown: true, empty: false, restoredFocus: true
  }, 'Escape must return to the pinned thread and restore focus without reopening the dismissed thread');
  await pressSmokeKey(page, 'Enter', 'Enter', 13);
  assert.strictEqual((await evaluate(page, dismissalState, contextId)).expandedSelected, 'true',
    'Enter must reopen the resource sidebar from the restored trigger');

  await evaluate(page, `(() => {
    document.querySelector('#normalthread_100 [data-resource-trigger]').click();
    document.querySelector('#atp-resource-sidebar [data-sidebar-pin-toggle]').click();
    document.querySelector('#normalthread_200 [data-resource-trigger]').click();
  })()`, contextId);
  await pressSmokeKey(page, 'Escape', 'Escape', 27);
  assert.deepStrictEqual(await evaluate(page, dismissalState, contextId), {
    expandedPinned: 'false', expandedSelected: 'false', pinnedShown: false, empty: true, restoredFocus: true
  }, 'Escape must leave the sidebar empty when no other thread is pinned');
  await pressSmokeKey(page, 'Enter', 'Enter', 13);
  await evaluate(page, `document.querySelector('#atp-resource-sidebar [data-copy-all]').focus()`, contextId);
}

async function pressSmokeKey(page, key, code, keyCode) {
  const event = { key, code, windowsVirtualKeyCode: keyCode };
  const keyDown = key === 'Enter' ? { type: 'keyDown', text: '\r' } : { type: 'rawKeyDown' };
  await page.cdp.send('Input.dispatchKeyEvent', { ...event, ...keyDown });
  await page.cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

async function checkPreviewKeyboardRetry(page, contextId) {
  await page.cdp.send('Page.bringToFront');
  await evaluate(page, `(() => {
    const opener = document.querySelector('#normalthread_100 .atp-thumbnail-wrapper[role="button"]');
    opener.focus();
    ATPPreviewer.open(['data:image/png;base64,aW52YWxpZA=='], 0, { opener, preferOpenerFocus: true });
  })()`, contextId);
  const failedPreview = `document.querySelector('.atp-preview-counter')?.textContent === '加载失败 (1 / 1)'`;
  await waitFor('single-image preview failure', () => evaluate(page, failedPreview, contextId));
  await pressSmokeKey(page, 'Tab', 'Tab', 9);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert(await evaluate(page, `(() => {
      const retry = document.querySelector('.atp-preview-retry');
      window.__atpSmokeFailedPreview = document.querySelector('.atp-preview-img');
      return retry === document.activeElement && !retry.hidden && !retry.disabled;
    })()`, contextId), 'each failed manual preview must leave the retry button focused');
    await pressSmokeKey(page, ' ', 'Space', 32);
    await waitFor('keyboard preview retry fails and becomes actionable', () => evaluate(page, `${failedPreview} &&
      document.querySelector('.atp-preview-img') !== window.__atpSmokeFailedPreview &&
      document.activeElement === document.querySelector('.atp-preview-retry')`, contextId));
  }
  await pressSmokeKey(page, 'Escape', 'Escape', 27);
  assert(await evaluate(page, `!ATPPreviewer.isOpen() &&
    document.activeElement === document.querySelector('#normalthread_100 .atp-thumbnail-wrapper[role="button"]')`, contextId),
  'closing a failed preview must return focus to its thumbnail');
}

async function checkPopupNumberValidation(popup) {
  await popup.cdp.send('Page.bringToFront');
  await waitFor('popup numeric settings ready', () => evaluate(popup, `document.querySelector('#gridCols')?.disabled === false`));
  const before = await evaluate(popup, `chrome.storage.local.get('settings').then(({ settings }) => settings?.gridCols ?? null)`);
  await evaluate(popup, `(() => {
    const field = document.querySelector('#gridCols');
    field.focus();
    field.select();
  })()`);
  await popup.cdp.send('Input.insertText', { text: '1e2' });
  await pressSmokeKey(popup, 'Tab', 'Tab', 9);
  const error = await evaluate(popup, `(async () => {
    const field = document.querySelector('#gridCols');
    const description = document.getElementById(field.getAttribute('aria-describedby'));
    const { settings } = await chrome.storage.local.get('settings');
    return {
      text: description?.textContent || '',
      inline: description?.parentElement === field.closest('.setting-row'),
      invalid: field.getAttribute('aria-invalid'),
      value: field.value,
      stored: settings?.gridCols ?? null
    };
  })()`);
  assert(error.inline && error.invalid === 'true' && error.value === '1e2' && /1 至 32/.test(error.text),
    'a typed invalid exponent must explain the range beside its field: ' + JSON.stringify(error));
  assert.strictEqual(error.stored, before, 'invalid numeric input must not reach stored settings');
}

async function checkConcurrentArticleCache(pages) {
  const read = pages.map(item => expression => evaluate(item.page, expression, item.contextId));
  for (const run of read) {
    await run(`(() => {
      window.__article = new URL('/thread-977321-1-1.html', location.href).href;
      window.__image = new URL('/img/fixture.jpg', location.href).href;
      window.__attachment = { url: new URL('/fixture.txt', location.href).href, name: 'fixture.txt' };
      return true;
    })()`);
  }
  const [a, b] = read;
  await a(`ATPCache.setCachedArticleData(__article, { images: [{src: __image}], textAttachments: [__attachment], textAttachmentCount: 1 }, true)`);
  const inspect = `ATPCache.getCachedArticleData(__article).then(data => data && ({
    links: SharedUtils.countResources(data.resources), imported: !!data.textResourcesImported,
    complete: !!data.textResourcesComplete, imagesLoaded: data.loadedUrls.length
  }))`;
  await waitFor('shared article cache seed', () => a(inspect));

  // Delay a tab-local article read after Chrome has taken its snapshot. This
  // reproduces the historical race without delaying the worker or editing storage.
  await b(`(() => {
    const area = chrome.storage.local, get = area.get.bind(area);
    const key = ATPCache.ARTICLE_CACHE_PREFIX + SharedUtils.normalizeArticleUrl(__article);
    area.get = function(keys, callback) {
      if (keys !== key || typeof callback !== 'function') return get(...arguments);
      area.get = get;
      return get(keys, value => { window.__releaseOldRead = () => callback(value); });
    };
    window.__restoreArticleGet = () => { area.get = get; };
    ATPCache.updateArticleLoadedUrls(__article, [__image], true);
    return true;
  })()`);
  await waitFor('image progress committed or a tab holding its previous read', async () =>
    (await b('!!window.__releaseOldRead')) || (await a(inspect))?.imagesLoaded === 1);
  const accepted = await a(`ATPRenderer.importTextResources({ link: __article, candidates: [{src: __image}], textAttachments: [__attachment],
    textAttachmentCount: 1, loaded: 0, nextIdx: 0, failedCount: 0 }, [{ name: 'fixture.txt', resources: {
      groups: {magnet: ['magnet:?xt=urn:btih:0123456789012345678901234567890123456789']}
    } }])`);
  assert(accepted, 'the TXT import must be accepted by the normal renderer');
  await waitFor('TXT import persisted in Chrome', async () => (await a(inspect))?.imported);
  await b('window.__restoreArticleGet(); window.__releaseOldRead?.()');
  const result = await waitFor('saved image progress read in the other tab', async () => {
    const state = await b(inspect);
    return state?.imagesLoaded === 1 ? state : null;
  });
  assert.deepStrictEqual(result, { links: 1, imported: true, complete: true, imagesLoaded: 1 });
  return result;
}

async function checkCrossTabProbe(devtoolsPort, extensionId, fixturePort, sessions, completedSessions, fixture) {
  var pages = [];
  for (var i = 0; i < 2; i++) {
    var page = await createPageSession(devtoolsPort);
    sessions.push(page);
    await navigate(page, 'https://' + PACER_HOST + ':' + fixturePort + '/other.html');
    var context = await waitForExtensionContext(page, extensionId);
    await waitFor('native Web Locks in forum content script', function() {
      return evaluate(page, '!!(window.ATPForumPacer && navigator.locks && navigator.locks.request)', context.id);
    });
    pages.push({ page: page, contextId: context.id });
  }
  // Simulate an expired pause, on a separate fixture origin with no article
  // jobs. Only these two real extension contexts can claim the probe lease.
  await evaluate(pages[0].page, `(() => {
    const now = Date.now();
    localStorage.setItem(ATPForumPacer.STORE_KEY, JSON.stringify({
      at: now, tokens: 5, tokensAt: now, burst: 5, refillMs: 3000,
      level: 1, pauseUntil: now - 1, lastFloodAt: now - 20000,
      clearedAt: 0, calm: 0, relax: 0, resetId: ''
    }));
    return true;
  })()`, pages[0].contextId);
  // Prove that the actual native lock coordinates these isolated worlds:
  // a localStorage-only fallback could pass the lease test below as well.
  await evaluate(pages[0].page, `(() => {
    window.__atpSmokeNativeLockHeld = false;
    navigator.locks.request('atp.forumPacer.probe.v1', () => new Promise(resolve => {
      window.__atpSmokeReleaseNativeLock = resolve;
      window.__atpSmokeNativeLockHeld = true;
    }));
    return true;
  })()`, pages[0].contextId);
  await waitFor('explicit native recovery lock in first tab', function() {
    return evaluate(pages[0].page, 'window.__atpSmokeNativeLockHeld === true', pages[0].contextId);
  });
  await evaluate(pages[1].page, `(() => {
    window.__atpSmokeLockProbe = null;
    window.__atpSmokeCancelProbe = false;
    window.__atpSmokeCancelledResult = 'pending';
    ATPForumPacer.acquire({
      priority: 0, deadline: Date.now() + 10000,
      isCancelled: () => window.__atpSmokeCancelProbe
    }).then(ticket => { window.__atpSmokeCancelledResult = ticket; });
    ATPForumPacer.acquire({ priority: 0, deadline: Date.now() + 10000 })
      .then(ticket => { window.__atpSmokeLockProbe = ticket; });
    return true;
  })()`, pages[1].contextId);
  await sleep(700);
  assert(await evaluate(pages[1].page, `window.__atpSmokeCancelledResult === 'pending' &&
    !window.__atpSmokeLockProbe && !localStorage.getItem('atp.forumPacer.probe.v1')`, pages[1].contextId),
  'The second tab must neither grant a ticket nor write a lease while the first tab holds the native lock');
  await evaluate(pages[1].page, 'window.__atpSmokeCancelProbe = true', pages[1].contextId);
  await waitFor('cancelled probe while native lock is held', function() {
    return evaluate(pages[1].page, "window.__atpSmokeCancelledResult === null && !window.__atpSmokeLockProbe && !localStorage.getItem('atp.forumPacer.probe.v1')", pages[1].contextId);
  });
  await evaluate(pages[0].page, 'window.__atpSmokeReleaseNativeLock()', pages[0].contextId);
  await waitFor('probe after native lock release', function() {
    return evaluate(pages[1].page, '!!window.__atpSmokeLockProbe', pages[1].contextId);
  });
  await evaluate(pages[1].page, "window.__atpSmokeLockProbe.done('')", pages[1].contextId);
  await waitFor('native-lock probe lease released', function() {
    return evaluate(pages[0].page, "!localStorage.getItem('atp.forumPacer.probe.v1')", pages[0].contextId);
  });
  await Promise.all(pages.map(function(item) {
    return evaluate(item.page, `(() => {
      window.__atpSmokeProbe = null;
      ATPForumPacer.acquire({ priority: 0, deadline: Date.now() + 10000 }).then(ticket => {
        window.__atpSmokeProbe = ticket;
      });
      return true;
    })()`, item.contextId);
  }));
  async function readGrants() {
    return Promise.all(pages.map(function(item) {
      return evaluate(item.page, '!!window.__atpSmokeProbe', item.contextId);
    }));
  }
  var first = await waitFor('one cross-tab recovery probe', async function() {
    var grants = await readGrants();
    assert(grants.filter(Boolean).length <= 1, 'Recovery must never grant a probe in both tabs at once');
    return grants.some(Boolean) ? grants : null;
  });
  await sleep(700);
  assert.deepStrictEqual(await readGrants(), first, 'The second tab must wait until the first probe settles');
  var owner = first[0] ? 0 : 1;
  await evaluate(pages[owner].page, "window.__atpSmokeProbe.done('')", pages[owner].contextId);
  await waitFor('second tab probe after release', async function() {
    return (await readGrants())[1 - owner];
  });
  await evaluate(pages[1 - owner].page, "window.__atpSmokeProbe.done('')", pages[1 - owner].contextId);
  await waitFor('probe lease removed after settlement', function() {
    return evaluate(pages[0].page, "!localStorage.getItem('atp.forumPacer.probe.v1')", pages[0].contextId);
  });
  const [automatic, manual] = pages;
  await evaluate(automatic.page, `(async () => {
    localStorage.setItem('atp.forumPacer.retryAfter.v1', String(Date.now() - 1));
    window.__atpSmokeAutomaticTicket = await ATPForumPacer.acquire({ priority:0, deadline:Date.now() + 5000 });
    return !!window.__atpSmokeAutomaticTicket;
  })()`, automatic.contextId).then(ticket => assert(ticket, 'the first tab must hold a recovery ticket'));
  const manualPath = '/manual-probe.txt';
  await evaluate(manual.page, `(() => {
    window.__atpSmokeManualResult = null;
    ATPFetcher.fetchTextAttachmentResourcesWithStatus([{url:location.origin + ${JSON.stringify(manualPath)}}],
      {manualRetry:true, deadline:Date.now() + 7000}).then(status => {
        window.__atpSmokeManualResult = {unresolved:status.unresolvedCount, resources:SharedUtils.countResources(status.resources)};
      });
  })()`, manual.contextId);
  await waitFor('manual TXT waits in the second tab', () => evaluate(manual.page, `ATPForumPacer.getState().waiting === 1`, manual.contextId), 3000, 25);
  assert.strictEqual(fixture.metrics.requestsByPath[manualPath] || 0, 0, 'manual TXT must preserve the in-flight recovery lease');
  await evaluate(automatic.page, `window.__atpSmokeAutomaticTicket.done('')`, automatic.contextId);
  const manualRecovery = await waitFor('manual TXT claims the next recovery slot', () =>
    evaluate(manual.page, 'window.__atpSmokeManualResult', manual.contextId), 5000, 25);
  assert.deepStrictEqual(manualRecovery, { unresolved: 0, resources: 1 });
  assert.strictEqual(fixture.metrics.requestsByPath[manualPath], 1);

  const sharedArticle = await checkConcurrentArticleCache(pages);
  const articlePath = '/thread-419-1-1.html';
  const articleRequestsBeforeLimit = fixture.metrics.requestsByPath[articlePath] || 0;
  const forumLimit = await evaluate(pages[0].page, `(async () => {
    const target = 'https://${CROSS_HOST}:${fixturePort}';
    const path = ${JSON.stringify(articlePath)};
    const files = [1, 2, 3].map(id => ({ url: target + '/throttled-forum-' + id + '.txt' }));
    const status = await ATPFetcher.fetchTextAttachmentResourcesWithStatus(files, { manualRetry: true });
    const source = await ATPFetcher.fetchArticleDataByBackground(location.origin + path);
    const limited = await ATPFetcher.fetchArticleDataByBackground(target + path);
    return { retryable: status.retryableCount, sourcePaused: ATPForumPacer.getState().pausedMs > 0,
      sourceLoaded: source?.images?.length > 0, targetHeld: limited?.emptyReason === 'forum_cooldown' &&
        limited.retryAfter > Date.now() + 110000 };
  })()`, pages[0].contextId);
  assert.deepStrictEqual(forumLimit, { retryable: 3, sourcePaused: false, sourceLoaded: true, targetHeld: true });
  assert.deepStrictEqual([1, 2, 3].map(id => fixture.metrics.requestsByPath['/throttled-forum-' + id + '.txt'] || 0), [1, 0, 0]);
  assert.strictEqual(fixture.metrics.requestsByPath[articlePath], articleRequestsBeforeLimit + 1,
    'Only the healthy origin should receive the article request');
  for (var item of pages) {
    item.page.cdp.close();
    await closeTarget(devtoolsPort, item.page.target.id);
    sessions.splice(sessions.indexOf(item.page), 1);
    completedSessions.push(item.page);
  }
  return { nativeProbe: true, manualRecovery, sharedArticle, forumLimit };
}

async function main() {
  assert(fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')), 'Packaged extension is missing: ' + EXTENSION_DIR);
  var packagedManifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  assert.strictEqual(packagedManifest.version, EXPECTED_VERSION, 'Packaged extension version must match the worktree manifest');

  var browserPath = findBrowserExecutable();
  var runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-browser-smoke-'));
  var profileDir = path.join(runRoot, 'profile');
  var pfxPath = path.join(runRoot, 'fixture.pfx');
  var fixture = null;
  var browser = null;
  var sessions = [];
  var completedSessions = [];
  var browserConnection = null;
  var smokeFailure = null;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    createCertificate(pfxPath);
    fixture = createFixtureServer(pfxPath);
    await new Promise(function(resolve, reject) {
      fixture.server.once('error', reject);
      fixture.server.listen(0, '127.0.0.1', resolve);
    });
    var fixturePort = fixture.server.address().port;
    browser = spawnSmokeBrowser(browserPath, profileDir, EXTENSION_DIR,
      [SMOKE_HOST, AGE_ENTRY_HOST, CROSS_HOST, PACER_HOST, HOT_IMAGE_HOST, HEAVY_HOST, SIGNED_RELAY_HOST, TXT_DOWNLOAD_HOST,
        ATTACHMENT_LIVE_HOST, ATTACHMENT_DEAD_HOST]);
    var devtoolsPort = await waitForDevtoolsPort(profileDir, browser);

    var versionInfo = await fetchJson('http://127.0.0.1:' + devtoolsPort + '/json/version');
    browserConnection = await new CdpConnection(versionInfo.webSocketDebuggerUrl).connect();

    var extensionTarget = await findExtensionWorkerTarget(devtoolsPort, packagedManifest);
    var extensionMatch = /^chrome-extension:\/\/([a-p]{32})/.exec(extensionTarget.url || '');
    assert(extensionMatch, 'Could not read the unpacked extension id from ' + extensionTarget.url);
    var extensionId = extensionMatch[1];

    var ageEntry = await checkAgeEntry(devtoolsPort, extensionId, packagedManifest, fixturePort, fixture, sessions, completedSessions);

    await evaluateInWorker(devtoolsPort, packagedManifest, `chrome.storage.local.set({settings:{
      gridCols:5, visibleRows:2, firstScreenConcurrency:3, backgroundConcurrency:1, ordinaryHostConcurrency:6,
      globalImageConcurrency:5, imageTimeout:15000, imageTaskDeadline:0, maxRetryPerImage:0, autoLoadOffscreenFirstRowsEnabled:false
    }}).then(() => true)`);
    var scrollPage = await createPageSession(devtoolsPort);
    sessions.push(scrollPage);
    var scrollPriority = await checkScrollPriority(scrollPage, extensionId, fixturePort, fixture);
    await evaluateInWorker(devtoolsPort, packagedManifest, `chrome.storage.local.set({settings:{
      gridCols:1, visibleRows:1, firstScreenConcurrency:1, globalImageConcurrency:1, maxImagesPerPost:5000, maxDisplayPerPost:5000, articleFetchConcurrency:2
    }}).then(() => true)`);
    var longGallery = await checkLongGallery(scrollPage, extensionId, fixturePort, fixture);
    var cachedRowAndText = await checkCachedRowAndTextProgress(scrollPage, extensionId, fixturePort, fixture);
    var coldScrollAndArticleRetry = await checkColdScrollAndArticleRetry(scrollPage, extensionId, fixturePort, fixture);
    var offlineArticleRecovery = await checkOfflineArticleRecovery(scrollPage, extensionId, fixturePort, fixture);
    scrollPage.cdp.close();
    await closeTarget(devtoolsPort, scrollPage.target.id);
    sessions.splice(sessions.indexOf(scrollPage), 1);
    completedSessions.push(scrollPage);

    var legacyWorker = await new CdpConnection(extensionTarget.webSocketDebuggerUrl).connect();
    try {
      var legacySettingResult = await legacyWorker.send('Runtime.evaluate', {
        expression: 'chrome.storage.local.set({settings:{autoLoadOffscreenFirstRows:true}}).then(() => true)',
        awaitPromise: true,
        returnByValue: true
      });
      assert(legacySettingResult.result && legacySettingResult.result.value === true,
        'Browser smoke must seed the old default-on setting before checking migration');
    } finally {
      legacyWorker.close();
    }

    var defaultDistancePage = await createPageSession(devtoolsPort);
    sessions.push(defaultDistancePage);
    await navigate(defaultDistancePage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=offscreen');
    var defaultDistanceContext = await waitForExtensionContext(defaultDistancePage, extensionId);
    await waitFor('default nearby thread panel', async function() {
      return evaluate(defaultDistancePage, `(() => Object.values(window.ATPState.threads)
        .some((item) => item.link.includes('/thread-400-1-1.html')))()`, defaultDistanceContext.id);
    });
    await sleep(350);
    var distantDefaultState = await evaluate(defaultDistancePage, `({
      enabled: window.ATPState.settings.autoLoadOffscreenFirstRowsEnabled,
      farRegistered: Object.values(window.ATPState.threads)
        .some((item) => item.link.includes('/thread-401-1-1.html'))
    })`, defaultDistanceContext.id);
    assert(distantDefaultState.enabled === false && distantDefaultState.farRegistered === false,
      'Default settings must leave a distant thread unregistered until the user scrolls');
    var dynamicListPreview = await checkDynamicListPreview(defaultDistancePage, defaultDistanceContext.id);
    defaultDistancePage.cdp.close();
    await closeTarget(devtoolsPort, defaultDistancePage.target.id);
    sessions.splice(sessions.indexOf(defaultDistancePage), 1);
    completedSessions.push(defaultDistancePage);

    var setupWorker = await new CdpConnection(extensionTarget.webSocketDebuggerUrl).connect();
    try {
      var optInResult = await setupWorker.send('Runtime.evaluate', {
        expression: 'chrome.storage.local.set({settings:{autoLoadOffscreenFirstRowsEnabled:true}}).then(() => true)',
        awaitPromise: true,
        returnByValue: true
      });
      assert(optInResult.result && optInResult.result.value === true,
        'Browser smoke must explicitly opt in to offscreen first-row loading');
    } finally {
      setupWorker.close();
    }

    var pageOne = await createPageSession(devtoolsPort);
    sessions.push(pageOne);
    var forumUrl = 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=mixed';
    // Body fetches can start on different forum pacing ticks. Hold fixture
    // images until both image lanes have sent requests.
    fixture.holdMixedImages();
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
    await waitFor('mixed ordinary and heavy channel overlap', async function() {
      return fixture.metrics.activeOrdinaryImages >= 2 && fixture.metrics.activeHeavyImages >= 1 && fixture.metrics.activeImages >= 4;
    }).finally(fixture.releaseMixedImages);

    var ordinaryFirstScreen = await waitFor('ordinary first screen completion', async function() {
      var progress = await evaluate(pageOne, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
        if (!thread || !thread.firstScreenDone) return null;
        return { firstScreenTotal: thread.firstScreenTotal, firstScreenOk: thread.firstScreenOk, loaded: thread.loaded };
      })()`, pageOneContext.id);
      return progress && progress.firstScreenOk === progress.firstScreenTotal ? progress : null;
    });
    var firstScreenTiming = await evaluate(pageOne, `new Promise(resolve => {
      const thread = Object.values(window.ATPState.threads).find(item => item.link.includes('/thread-100-1-1.html'));
      Logger.flush(() => chrome.storage.local.get(null, stored => {
        const entries = Object.values(stored).filter(Array.isArray).flat();
        const logged = entries.find(entry => entry && entry.type === 'first_screen_timing' &&
          entry.fields && entry.fields.threadId === thread.id);
        resolve({ timing: thread.firstScreenTiming && thread.firstScreenTiming.result,
          logged: logged && logged.fields });
      }));
    })`, pageOneContext.id);
    assert(firstScreenTiming && firstScreenTiming.timing && firstScreenTiming.logged,
      'Completed first screen must retain and export its timing breakdown');
    var timing = firstScreenTiming.timing;
    assert.strictEqual(timing.settledTasks, ordinaryFirstScreen.firstScreenTotal);
    assert.strictEqual(timing.taskElapsedTotalMs,
      timing.queueWaitTotalMs + timing.hiddenPauseTotalMs + timing.requestTotalMs,
      'Queue, hidden pause and request time must partition the task totals');
    var explainedWallTime = timing.lastTaskStartOffsetMs + timing.lastTaskQueueWaitMs +
      timing.lastTaskHiddenPauseMs + timing.lastTaskRequestMs;
    assert(timing.wallClockMs >= explainedWallTime && timing.wallClockMs - explainedWallTime < 50,
      'Last completed task must explain wall time within the synchronous completion overhead');
    assert(timing.requestTotalMs > 0, 'Browser image requests must contribute measured processing time');
    assert.strictEqual(firstScreenTiming.logged.requestMeasurement, timing.requestMeasurement,
      'Exported timing log must preserve the request-time measurement description');
    var expandedOrdinaryViewport = await evaluate(pageOne, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
      const expandBtn = thread && thread.panel && (thread.panel.querySelector('.atp-more-overlay-badge') || thread.panel.querySelector('.atp-thumbnail-expand'));
      if (!expandBtn) return false;
      expandBtn.click();
      return true;
    })()`, pageOneContext.id);
    assert(expandedOrdinaryViewport, 'Ordinary thumbnail expand control was not available for background progression');
    var ordinaryBackgroundProgress = await waitFor('additional rows after expanding the collapsed gallery', async function() {
      var progress = await evaluate(pageOne, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
        return thread ? { firstScreenTotal: thread.firstScreenTotal, nextIdx: thread.nextIdx, loaded: thread.loaded } : null;
      })()`, pageOneContext.id);
      return progress && progress.loaded >= 15 ? progress : null;
    });
    assert(ordinaryBackgroundProgress.nextIdx >= 15, 'expanding the collapsed gallery must unlock and progress remaining rows');

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
    var admittedOffscreenImage = await evaluate(pageOne, `new Promise(resolve => {
      const wrapper = document.createElement('div');
      wrapper.className = 'atp-regression-probe';
      wrapper.style.cssText = 'position:absolute;top:100000px;left:0;width:110px;height:82px';
      const img = document.createElement('img');
      const task = { slotActive: true, currentlyVisible: false, isFirstScreen: true };
      ATPLoader.prepareThumbnailImage(img, task, 110, 82);
      wrapper.appendChild(img);
      document.body.appendChild(wrapper);
      ATPLoader.updateTaskViewportPriority(task, wrapper, false);
      let settled = false;
      const finish = loaded => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = { loaded, loading: img.loading, priority: img.fetchPriority };
        img.onload = img.onerror = null;
        img.removeAttribute('src');
        wrapper.remove();
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), 3000);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = location.origin + '/admitted-image-probe.png';
    })`, pageOneContext.id);
    assert(admittedOffscreenImage.loaded && admittedOffscreenImage.loading === 'eager' && admittedOffscreenImage.priority === 'low',
      'An admitted offscreen request must start without scrolling and retain low priority: ' + JSON.stringify(admittedOffscreenImage));
    assert.strictEqual(fixture.metrics.requestsByPath['/admitted-image-probe.png'], 1, 'Admitted request must actually reach the fixture server');
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

    var oneUseAttachment = await evaluate(pageOne, `ATPFetcher.fetchTextAttachmentResourcesWithStatus([
      { url: location.origin + '/one-use-attachment.txt', name: 'one-use.txt' }
    ], { manualRetry: true })`, pageOneContext.id);
    assert.strictEqual(oneUseAttachment.unresolvedCount, 0, 'TXT relay must use the target from the first response');
    assert.strictEqual(oneUseAttachment.resources.groups.baidu[0].code, 'rt12');
    assert.strictEqual(fixture.metrics.requestsByPath['/one-use-attachment.txt'], 1, 'one-use entry must only be read once');
    assert.strictEqual(fixture.metrics.requestsByPath['/one-use-download.txt'], 1, 'worker must fetch the signed target once');

    var signedRelay = await evaluate(pageOne, `ATPFetcher.fetchTextAttachmentResourcesWithStatus([
      { url: location.origin + '/signed-relay-entry.txt', name: 'signed-relay.txt' }
    ], { manualRetry: true })`, pageOneContext.id);
    assert.strictEqual(signedRelay.unresolvedCount, 0, 'The worker must follow the forum redirect to its signed TXT relay');
    assert.strictEqual(signedRelay.resources.groups.baidu[0].code, 'jk34');
    assert.strictEqual(fixture.metrics.requestsByPath['/signed-relay-entry.txt'], 2, 'The page bridge must hand off directly to the worker');
    assert.strictEqual(fixture.metrics.requestsByHost[SIGNED_RELAY_HOST], 1, 'Only the worker should fetch the relay once');

    var forbiddenAttachment = { url: 'https://' + CROSS_HOST + ':' + fixturePort + '/forbidden-txt-fixture.txt', name: 'forbidden.txt' };
    var deniedByWorker = await evaluate(pageOne, 'ATPFetcher.fetchTextAttachmentResourcesWithStatus([' +
      JSON.stringify(forbiddenAttachment) + '], { manualRetry: true })', pageOneContext.id);
    assert.strictEqual(deniedByWorker.accessDeniedCount, 1, 'worker HTTP denial must reach the content script');
    assert.strictEqual(fixture.metrics.requestsByPath['/forbidden-txt-fixture.txt'], 1);

    var retryPage = await createPageSession(devtoolsPort);
    sessions.push(retryPage);
    await navigate(retryPage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mod=forumdisplay&fid=95&mode=txt-retry');
    var retryContext = await waitForExtensionContext(retryPage, extensionId);
    var retryThreadExpression = "Object.values(window.ATPState.threads).find(item => item.link.includes('/thread-403-1-1.html'))";
    var retryStatus = await waitFor('TXT failure becomes actionable', function() {
      return evaluate(retryPage, `(() => {
        const thread = ${retryThreadExpression};
        return thread && thread.textResourcesRetryable && thread.statusEl.textContent;
      })()`, retryContext.id);
    });
    assert.strictEqual(retryStatus, 'TXT 待重试');
    assert(await evaluate(retryPage, `(() => {
      const thread = ${retryThreadExpression};
      thread.panel.querySelector('[data-resource-trigger]').click();
      return thread.textResourceMessage.includes('站点拒绝读取 1 个 TXT 附件') &&
        !!document.querySelector('a[data-open-thread][href*="/thread-403-1-1.html"]') &&
        !!document.querySelector('[data-import-txt]');
    })()`, retryContext.id), 'the failure must offer the original thread and TXT import');
    assert(await evaluate(retryPage, `(() => {
      const action = Array.from(document.querySelectorAll('[data-parse-txt]')).find(button =>
        button.getAttribute('aria-label') === '重试本帖 TXT');
      if (!action) return false;
      action.click();
      return true;
    })()`, retryContext.id), 'the per-thread retry action must be available after the automatic request fails');
    await waitFor('manual TXT retry succeeds', function() {
      return evaluate(retryPage, `(() => {
        const thread = ${retryThreadExpression};
        return thread && thread.textResourcesDone && !thread.textResourcesRetryable &&
          thread.resources.groups.baidu[0]?.code === 'mr12';
      })()`, retryContext.id);
    });
    assert.strictEqual(fixture.metrics.requestsByPath['/retry-txt-fixture.txt'], 2, 'manual retry should make one new attachment request');
    assert.strictEqual(fixture.metrics.requestsByPath['/thread-403-1-1.html'], 2, 'manual retry must re-read the cached thread');
    assert.deepStrictEqual(fixture.metrics.retryTokens, ['expired', 'current'], 'the new request must use the current attachment URL');
    retryPage.cdp.close();
    await closeTarget(devtoolsPort, retryPage.target.id);
    sessions.splice(sessions.indexOf(retryPage), 1);
    completedSessions.push(retryPage);
    await pageOne.cdp.send('Page.bringToFront');

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

    var listingTableStyle = await evaluate(pageOne, 'document.querySelector("#threadlisttable").style.cssText');
    try {
      await pageOne.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1366, height: 780, deviceScaleFactor: 1, mobile: false
      });
      const hasInlineActions = `(() => {
        const inline = document.querySelector('#normalthread_200 .atp-resource-inline');
        const sidebar = document.querySelector('#atp-resource-sidebar');
        return getComputedStyle(inline).display === 'flex' && getComputedStyle(sidebar).display === 'none' &&
          document.activeElement === inline.querySelector('[data-copy-all]');
      })()`;
      const hasDesktopFocus = `(() => {
        const sidebar = document.querySelector('#atp-resource-sidebar');
        return getComputedStyle(sidebar).display !== 'none' &&
          sidebar.querySelector('.atp-resource-thread-title').textContent.includes('Cross-origin resources') &&
          document.activeElement === sidebar.querySelector('[data-copy-all]');
      })()`;
      await waitFor('desktop sidebar before moving the listing', () =>
        evaluate(pageOne, `getComputedStyle(document.querySelector('#atp-resource-sidebar')).display !== 'none'`));
      await checkResourcePanelThreadSelection(pageOne, pageOneContext.id);
      await evaluate(pageOne, `document.querySelector('#threadlisttable').style.transform = 'translateX(250px)'`);
      await waitFor('inline copy focus after a position-only listing shift', () => evaluate(pageOne, hasInlineActions));
      await evaluate(pageOne, `document.querySelector('#threadlisttable').style.transform = ''`);
      await waitFor('sidebar copy focus after the listing moves back', () => evaluate(pageOne, hasDesktopFocus));
      await pageOne.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 920, height: 700, deviceScaleFactor: 1, mobile: false
      });
      await waitFor('inline copy focus below the narrow breakpoint', () => evaluate(pageOne, hasInlineActions));
      await pageOne.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1366, height: 780, deviceScaleFactor: 1, mobile: false
      });
      await waitFor('sidebar copy focus after widening the viewport', () => evaluate(pageOne, hasDesktopFocus));
      await pageOne.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1100, height: 700, deviceScaleFactor: 1, mobile: false
      });
      await waitFor('resource actions move inline when the list fills the sidebar gutter', function() {
        return evaluate(pageOne, `(() => {
          const panel = document.querySelector('#normalthread_200 .atp-thread-panel');
          const inline = panel && panel.querySelector('.atp-resource-inline');
          const mark = panel && panel.querySelector('.atp-mark-toggle');
          const sidebar = document.querySelector('#atp-resource-sidebar');
          return innerWidth === 1100 && inline && getComputedStyle(inline).display === 'flex' &&
            mark && getComputedStyle(mark).display !== 'none' &&
            (!sidebar || getComputedStyle(sidebar).display === 'none');
        })()`);
      });
      await pageOne.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 700, deviceScaleFactor: 1, mobile: false
      });
      var narrowGallery = await evaluate(pageOne, `(() => {
        const table = document.querySelector('#threadlisttable');
        table.style.width = '100%';
        table.style.tableLayout = 'fixed';
        const panel = document.querySelector('#normalthread_100 .atp-thread-panel');
        const button = panel.querySelector('.atp-thumbnail-expand');
        if (button.getAttribute('aria-expanded') === 'true') button.click();
        const viewport = panel.querySelector('.atp-scroll-viewport');
        viewport.scrollTop = 0;
        const secondRowCell = viewport.querySelector('.atp-thumbnail-wrapper[style*="grid-row-start: 2"]');
        return {
          horizontalOverflow: viewport.scrollWidth > viewport.clientWidth,
          secondRowFullyVisible: secondRowCell.getBoundingClientRect().bottom <=
            viewport.getBoundingClientRect().top + viewport.clientHeight + 0.5
        };
      })()`);
      assert.deepStrictEqual(narrowGallery, { horizontalOverflow: true, secondRowFullyVisible: true },
        'horizontal scrolling must leave the entire second thumbnail row visible in the collapsed gallery');
    } finally {
      await pageOne.cdp.send('Emulation.clearDeviceMetricsOverride');
      await evaluate(pageOne, 'document.querySelector("#threadlisttable").style.cssText = ' + JSON.stringify(listingTableStyle));
    }
    await checkPreviewKeyboardRetry(pageOne, pageOneContext.id);

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
    assert.strictEqual(heavyState.configuredHeavyConcurrency, 3, 'Heavy concurrency default changed unexpectedly');
    assert.strictEqual(heavyState.configuredOrdinaryConcurrency, 2, 'Ordinary background concurrency default changed unexpectedly');
    assert(fixture.metrics.maxHeavyImages <= 3, 'Heavy browser requests exceeded the configured concurrency');
    assert(fixture.metrics.maxOrdinaryImages <= 8, 'Ordinary first-screen requests exceeded the configured concurrency');

    var pageOneRootCount = await evaluate(pageOne, 'document.querySelectorAll("#bfp-root").length');
    var pageTwoRootCount = await evaluate(pageTwo, 'document.querySelectorAll("#bfp-root").length');
    assert.strictEqual(pageOneRootCount, 1, 'First tab must contain exactly one floating root');
    assert.strictEqual(pageTwoRootCount, 1, 'Second tab must contain exactly one floating root');

    var offscreenPage = await createPageSession(devtoolsPort);
    sessions.push(offscreenPage);
    await navigate(offscreenPage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=offscreen');
    var offscreenContext = await waitForExtensionContext(offscreenPage, extensionId);
    var farFirstRows = await waitFor('far thread first rows without page scrolling', async function() {
      return evaluate(offscreenPage, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-401-1-1.html'));
        if (!thread || !thread.firstScreenDone) return null;
        return { firstScreenTotal: thread.firstScreenTotal, firstScreenOk: thread.firstScreenOk,
          nextIdx: thread.nextIdx, bgQueued: thread.bgQueued, backgroundUnlocked: thread.backgroundUnlocked,
          top: thread.panel.getBoundingClientRect().top, viewportHeight: innerHeight };
      })()`, offscreenContext.id);
    });
    assert(farFirstRows.firstScreenTotal === 10 && farFirstRows.firstScreenOk === 10 &&
      farFirstRows.top > farFirstRows.viewportHeight + 2000,
      'Far thread must load exactly the configured 5x2 first rows without page scrolling');
    assert(farFirstRows.nextIdx === 10 && farFirstRows.bgQueued === false && farFirstRows.backgroundUnlocked === false,
      'Far thread must leave extra images out of the background queue until interaction');
    // v1.19.0 defaults: 8 ordinary slots minus 4 reserved for visible images, capped at 3 offscreen lanes.
    var offscreenMaxFarImages = fixture.metrics.maxFarImages;
    assert(offscreenMaxFarImages >= 1 && offscreenMaxFarImages <= 3,
      'Far first-row images must keep the visible-slot reserve inside the ordinary pool (<= 3 lanes)');
    assert(fixture.metrics.requestPaths.indexOf('/img/near-0.jpg') !== -1 &&
      fixture.metrics.requestPaths.indexOf('/img/near-0.jpg') < fixture.metrics.requestPaths.indexOf('/img/far-0.jpg'),
      'Near thread images must start before far thread images');
    for (var farIndex = 10; farIndex < 13; farIndex++) {
      assert(!fixture.metrics.requestsByPath['/img/far-' + farIndex + '.jpg'], 'Far thread must wait for interaction after the first 10 images');
    }
    await evaluate(offscreenPage, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-401-1-1.html'));
      thread.panel.scrollIntoView();
      return true;
    })()`, offscreenContext.id);
    await sleep(300);
    assert(!fixture.metrics.requestsByPath['/img/far-10.jpg'], 'Page scrolling alone must not exceed the per-thread automatic image cap');
    await evaluate(offscreenPage, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-401-1-1.html'));
      thread.panel.querySelector('.atp-thumbnail-expand').click();
      return true;
    })()`, offscreenContext.id);
    await waitFor('far thread extra images after expand', async function() {
      return !!fixture.metrics.requestsByPath['/img/far-10.jpg'];
    });

    var hostLimitPage = await createPageSession(devtoolsPort);
    sessions.push(hostLimitPage);
    await navigate(hostLimitPage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=host-limit');
    var hostLimitContext = await waitForExtensionContext(hostLimitPage, extensionId);
    await waitFor('host-limit first rows', async function() {
      return evaluate(hostLimitPage, `(() => {
        const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-402-1-1.html'));
        return !!(thread && thread.firstScreenDone);
      })()`, hostLimitContext.id);
    });
    var hostLimitObserved = fixture.metrics.maxHostLimitImages;
    assert(hostLimitObserved <= 8, 'automatic loading must cap one ordinary image host at eight concurrent requests');

    var popup = await createPageSession(devtoolsPort);
    sessions.push(popup);
    await navigate(popup, 'chrome-extension://' + extensionId + '/popup.html');
    await waitFor('popup settings UI', async function() {
      return evaluate(popup, 'document.querySelector("#settingsContainer").children.length > 0 && document.querySelector("#versionFooter").textContent.includes("' + EXPECTED_VERSION + '")');
    });
    await checkPopupNumberValidation(popup);
    var markedFromPanel = await evaluate(pageOne, `(() => {
      const thread = Object.values(window.ATPState.threads).find((item) => item.link.includes('/thread-100-1-1.html'));
      const button = thread && thread.panel && thread.panel.querySelector('[data-mark-toggle]');
      if (!button) return false;
      button.click();
      return true;
    })()`, pageOneContext.id);
    assert(markedFromPanel, 'Ordinary thread must expose its mark button');
    await evaluate(popup, `document.querySelector('#tabBtnMarks')?.click()`);
    await waitFor('marked thread in popup', async function() {
      return evaluate(popup, `document.querySelector('#marksCount').textContent === '1' &&
        document.querySelector('#marksList').textContent.includes('Ordinary gallery')`);
    });
    const markFocused = await evaluate(popup, `(() => {
      document.querySelector('#backupSection').open = true;
      window.__atpFocusedMark = document.querySelector('#marksList [data-mark-remove]');
      window.__atpOldBackup = document.querySelector('#backupList').textContent;
      window.__atpFocusedMark.focus();
      return document.activeElement === window.__atpFocusedMark;
    })()`);
    assert(markFocused, 'the fixture must focus a marked-thread action');
    await evaluate(pageOne, `(() => {
      const copy = document.querySelector('#normalthread_100 .atp-resource-inline [data-copy-all]');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => {} }
      });
      try {
        copy.click();
      } finally {
        delete navigator.clipboard;
      }
    })()`, pageOneContext.id);
    await waitFor('popup refresh after a copy in another tab', () => evaluate(popup,
      `document.querySelector('#backupList').textContent !== window.__atpOldBackup`));
    assert(await evaluate(popup, `document.activeElement === window.__atpFocusedMark &&
      window.__atpFocusedMark === document.querySelector('#marksList [data-mark-remove]')`),
    'a daily backup update must keep a focused mark and its action node intact');

    var downloadDir = path.join(runRoot, 'downloads');
    fs.mkdirSync(downloadDir);
    await popup.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await evaluate(popup, `document.querySelector('#exportMarks').click()`);
    await waitFor('mark export and daily backup', async function() {
      return evaluate(popup, `document.querySelector('#marksSummary').textContent.includes('均已导出') &&
        document.querySelector('#backupCount').textContent === '1'`);
    });
    assert(await evaluate(popup, `document.activeElement.getAttribute('data-mark-remove') ===
      window.__atpFocusedMark.getAttribute('data-mark-remove')`),
    'updating a visible mark must restore focus to the corresponding action');
    var markedDownload = await waitFor('marked resources download', function() {
      return fs.readdirSync(downloadDir).find(function(name) {
        return /^thumbnail-preview-marked-.*\.txt$/.test(name);
      });
    });
    var markedText = fs.readFileSync(path.join(downloadDir, markedDownload), 'utf8');
    assert(markedText.includes('Ordinary gallery') && markedText.includes('1AtpSmokeMain') && markedText.includes('abcd'),
      'Exported TXT must contain the marked thread and its paired share code');
    await evaluate(popup, `window.__atpBackupAction = document.querySelector('#backupList [data-backup-day]');
      document.querySelector('#clearExportedMarks').click();
      document.querySelector('#clearExportedMarks').click()`);
    await waitFor('exported mark cleared but backup retained', async function() {
      return evaluate(popup, `document.querySelector('#marksCount').textContent === '0' &&
        document.querySelector('#backupCount').textContent === '1'`);
    });
    assert(await evaluate(popup, `document.activeElement === document.querySelector('#marksHeading') &&
      window.__atpBackupAction === document.querySelector('#backupList [data-backup-day]')`),
    'removing the focused mark must return to the marks heading and keep the backup action');
    await evaluate(popup, `document.querySelector('#downloadAllBackups').click()`);
    var backupDownload = await waitFor('daily backup download', function() {
      return fs.readdirSync(downloadDir).find(function(name) {
        return /^thumbnail-preview-backup-all-.*\.txt$/.test(name);
      });
    });
    var backupText = fs.readFileSync(path.join(downloadDir, backupDownload), 'utf8');
    assert(backupText.includes('Ordinary gallery') && backupText.includes('1AtpSmokeMain'),
      'Daily backup must retain the exported thread after its mark is cleared');
    // A full tab cannot reproduce browser-action auto-size feedback loops.
    await evaluate(popup, 'chrome.action.openPopup()');
    var actionTarget = await waitFor('native action popup', async function() {
      return (await listTargets(devtoolsPort)).find(function(target) {
        return target.url === 'chrome-extension://' + extensionId + '/popup.html' && target.id !== popup.target.id;
      });
    });
    var actionPopup = await createPageSession(devtoolsPort, actionTarget);
    sessions.push(actionPopup);
    await waitFor('native popup settings layout', async function() {
      return evaluate(actionPopup, 'document.querySelector("#settingsContainer").children.length > 0 && document.body.getBoundingClientRect().width === 368');
    });
    await sleep(300);
    var actionPopupSizes = [];
    for (var sizeSample = 0; sizeSample < 20; sizeSample++) {
      actionPopupSizes.push(await evaluate(actionPopup, '({ viewport: innerWidth, body: document.body.getBoundingClientRect().width })'));
      await sleep(100);
    }
    assert(actionPopupSizes.every(function(size) { return size.body === 368 && size.viewport === actionPopupSizes[0].viewport; }),
      'Native popup must keep a stable 368px layout without user input: ' + JSON.stringify(actionPopupSizes));
    actionPopup.cdp.close();
    await closeTarget(devtoolsPort, actionTarget.id);
    sessions.splice(sessions.indexOf(actionPopup), 1);
    completedSessions.push(actionPopup);
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

    var readyWorkerTarget = await findExtensionWorkerTarget(devtoolsPort, packagedManifest);
    var readyWorker = await new CdpConnection(readyWorkerTarget.webSocketDebuggerUrl).connect();
    try {
      await readyWorker.send('Runtime.evaluate', {
        expression: 'chrome.storage.local.set({settings:{autoLoadOffscreenFirstRowsEnabled:false,' +
          'gridCols:2,visibleRows:1,firstScreenConcurrency:2,ordinaryHostConcurrency:2,globalImageConcurrency:3,' +
          'imageTimeout:1400,animatedThumbnailMode:"play",maxRetryPerImage:0}})',
        awaitPromise: true
      });
    } finally {
      readyWorker.close();
    }
    var readyPage = await createPageSession(devtoolsPort);
    sessions.push(readyPage);
    await navigate(readyPage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=ready-queue');
    var readyContext = await waitForExtensionContext(readyPage, extensionId);
    var readyDefault = await waitFor('first healthy image in the collapsed gallery', async function() {
      return evaluate(readyPage, `(() => {
        const thread = Object.values(ATPState.threads).find(item => item.link.includes('/thread-404-1-1.html'));
        if (!thread || thread.loaded < 1) return null;
        return { nextIdx: thread.nextIdx,
          expanded: thread.panel.querySelector('.atp-thumbnail-expand').getAttribute('aria-expanded') };
      })()`, readyContext.id);
    }, 6000, 25);
    assert.deepStrictEqual(readyDefault, { nextIdx: 2, expanded: 'false' },
      'the collapsed gallery must load only the configured rows until the reader acts');
    assert(!fixture.metrics.requestsByPath['/img/ready-queue-1.jpg'], 'the next row must make no request before explicit expansion');
    assert(await evaluate(readyPage, `(() => {
      const expand = document.querySelector('.atp-thumbnail-expand');
      if (!expand) return false;
      expand.click();
      return expand.getAttribute('aria-expanded') === 'true';
    })()`, readyContext.id), 'the collapsed gallery must expand on explicit reader action');
    var readyBeforeDeadline = await waitFor('later image rendered before the stuck first image settles', async function() {
      return evaluate(readyPage, `(() => {
        const thread = Object.values(ATPState.threads).find(item => item.link.includes('/thread-404-1-1.html'));
        if (!thread || thread.firstScreenDone || thread.failedCount) return null;
        const image = thread.grid.querySelector('img[src*="/img/ready-queue-1.jpg"]');
        if (!image || !image.complete || !image.naturalWidth) return null;
        return { firstBatch: thread.firstScreenTotal, readyImageLoaded: thread.loaded,
          row: image.parentElement.style.gridRowStart, column: image.parentElement.style.gridColumnStart };
      })()`, readyContext.id);
    }, 6000, 25);
    assert(readyBeforeDeadline.firstBatch === 2 && readyBeforeDeadline.row === '2' && readyBeforeDeadline.column === '1',
      'ready queue should show the second row in post order before first-row settlement');
    var readyAfterDeadline = await waitFor('stuck request cancelled and gallery settled', async function() {
      if (!fixture.metrics.readyHangClosed) return null;
      return evaluate(readyPage, `(() => {
        const thread = Object.values(ATPState.threads).find(item => item.link.includes('/thread-404-1-1.html'));
        if (!thread || thread.loaded !== 5 || thread.failedCount !== 1) return null;
        return { loaded: thread.loaded, failed: thread.failedCount,
          placeholders: thread.grid.querySelectorAll('.atp-thumbnail-failed').length };
      })()`, readyContext.id);
    }, 7000, 25);
    assert.strictEqual(readyAfterDeadline.placeholders, 1, 'terminal failure must leave one manually retryable cell');
    assert.strictEqual(fixture.metrics.requestsByPath['/img/ready-hang.gif'], 1, 'timeout must release the request without retrying in place');
    await evaluate(readyPage, `(() => {
      const failed = document.querySelector('.atp-thumbnail-failed');
      failed.click();
      failed.click();
    })()`, readyContext.id);
    await waitFor('remaining rows after explicit expansion', async function() {
      return evaluate(readyPage, `(() => {
        const thread = Object.values(ATPState.threads).find(item => item.link.includes('/thread-404-1-1.html'));
        return thread && thread.loaded === 5 && thread.failedCount === 1 &&
          thread.panel.querySelector('.atp-thumbnail-expand').getAttribute('aria-expanded') === 'true';
      })()`, readyContext.id);
    });
    await waitFor('manual retry deadline cancels the request', async function() {
      return fixture.metrics.readyHangClosed === 2 && evaluate(readyPage, `(() => {
        const thread = Object.values(ATPState.threads).find(item => item.link.includes('/thread-404-1-1.html'));
        return !!thread.grid.querySelector('.atp-thumbnail-failed') && !thread.grid.querySelector('.atp-thumbnail-loading');
      })()`, readyContext.id);
    }, 6000, 25);
    assert.strictEqual(fixture.metrics.requestsByPath['/img/ready-hang.gif'], 2,
      'repeated manual activation must send one retry and leave the terminal failure retryable');
    assert.strictEqual(await evaluate(readyPage, `(() => {
      const button = document.querySelector('.atp-thumbnail-expand');
      button.click();
      return button.getAttribute('aria-expanded');
    })()`), 'false', 'manual expansion must allow the reader to collapse the gallery');

    var recoveryPage = await createPageSession(devtoolsPort);
    sessions.push(recoveryPage);
    await navigate(recoveryPage, 'https://' + SMOKE_HOST + ':' + fixturePort + '/forum.php?mode=attachment-recovery');
    var recoveryContext = await waitForExtensionContext(recoveryPage, extensionId);
    var recoveryThreadExpression = "Object.values(ATPState.threads).find(item => item.link.includes('/thread-405-1-1.html'))";
    await waitFor('two healthy attachment images establish the sibling', function() {
      return evaluate(recoveryPage, `(() => {
        const thread = ${recoveryThreadExpression};
        return thread && thread.loaded === 2;
      })()`, recoveryContext.id);
    });
    fixture.metrics.maxAttachmentImages = 0;
    var liveBlocker = 'https://' + ATTACHMENT_LIVE_HOST + ':' + fixturePort + attachmentPath(2);
    var failedAttachment = 'https://' + ATTACHMENT_DEAD_HOST + ':' + fixturePort + attachmentPath(3);
    await evaluate(recoveryPage, `(() => {
      Object.assign(ATPState.settings, { ordinaryHostConcurrency: 1,
        firstScreenConcurrency: 2, globalImageConcurrency: 2, imageTimeout: 3000 });
      const thread = ${recoveryThreadExpression};
      thread.candidates.push({ src: ${JSON.stringify(liveBlocker)} }, { src: ${JSON.stringify(failedAttachment)} });
      thread.cacheImages = thread.candidates;
      thread.sourceCandidates = thread.candidates;
      thread.total = 4;
      thread.readyImageLimit = 4;
      ATPLoader.enqueueBgForThread(Object.keys(ATPState.threads).find(id => ATPState.threads[id] === thread));
      return true;
    })()`, recoveryContext.id);
    var attachmentRecovery = await waitFor('failed attachment resumes on its sibling after the host slot frees', function() {
      return evaluate(recoveryPage, `(() => {
        const thread = ${recoveryThreadExpression};
        if (thread.loaded !== 4) return null;
        return { loaded: thread.loaded, failed: thread.failedCount,
          mirrorHost: new URL(thread.candidates[3].src).hostname,
          originalHost: new URL(thread.cacheImages[3].src).hostname,
          cells: thread.grid.children.length };
      })()`, recoveryContext.id);
    }, 8000, 25);
    assert.deepStrictEqual(attachmentRecovery, { loaded: 4, failed: 0,
      mirrorHost: ATTACHMENT_LIVE_HOST, originalHost: ATTACHMENT_DEAD_HOST, cells: 4 });
    assert.strictEqual(fixture.metrics.maxAttachmentImages, 1, 'mirror recovery must respect the destination host concurrency');
    assert.strictEqual(fixture.metrics.requestsByHost[ATTACHMENT_DEAD_HOST], 2,
      'the failed attachment must get one original and one no-referrer attempt without a retry loop');

    fixture.metrics.maxAttachmentImages = 0;
    await evaluate(recoveryPage, `(() => {
      Object.assign(ATPState.settings, { gridCols: 5, heavyImageOptimization: true, heavyThumbnailClarity: 'lightweight' });
      const row = document.createElement('tbody');
      row.id = 'normalthread_406';
      row.innerHTML = '<tr><th><a class="xst" href="/thread-406-1-1.html">Mixed attachment recovery</a></th></tr>';
      document.querySelector('#threadlisttable').prepend(row);
      return true;
    })()`, recoveryContext.id);
    var mixedRecovery = await waitFor('mixed gallery retries into the busy destination host', function() {
      return evaluate(recoveryPage, `(() => {
        const t = Object.values(ATPState.threads).find(it => it.link.includes('/thread-406-1-1.html'));
        if (!t || t.loaded + t.failedCount < 5) return null;
        return { heavyMode: t.heavyMode, loaded: t.loaded, failed: t.failedCount, cells: t.grid.children.length };
      })()`, recoveryContext.id);
    }, 10000, 25);
    assert.deepStrictEqual(mixedRecovery, { heavyMode: true, loaded: 5, failed: 0, cells: 5 });
    assert.strictEqual(fixture.metrics.mixedFailedWhileLive, true, 'the destination must already be serving another image when the source fails');
    mixedRecovery.maxHostRequests = fixture.metrics.maxAttachmentImages;
    assert.strictEqual(mixedRecovery.maxHostRequests, 1, 'mixed-mode retries must re-enter the destination host limit');

    var crossTabChecks = await checkCrossTabProbe(devtoolsPort, extensionId, fixturePort, sessions, completedSessions, fixture);
    var pageErrors = completedSessions.concat(sessions).map(summarizeErrors);
    var allExceptions = [].concat.apply([], pageErrors.map(function(item) { return item.exceptions; }));
    var extensionConsoleErrors = [].concat.apply([], pageErrors.map(function(item) { return item.consoleErrors; }))
      .filter(function(text) { return /chrome-extension|ATP|bfp|Uncaught|TypeError|ReferenceError/i.test(text); });
    assert.strictEqual(allExceptions.length, 0, 'Browser runtime exceptions: ' + JSON.stringify(allExceptions));
    assert.strictEqual(extensionConsoleErrors.length, 0, 'Extension console errors: ' + JSON.stringify(extensionConsoleErrors));

    var mirrorReport = await runMirrorScenario(browserPath, runRoot, fixture, fixturePort);

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
      ageEntry: ageEntry,
      attachmentRecovery: attachmentRecovery,
      mixedAttachmentRecovery: mixedRecovery,
      scrollPriority: scrollPriority,
      longGallery: longGallery,
      cachedRowAndText: cachedRowAndText,
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
      offscreen: {
        firstRowsLoadedWithoutScroll: farFirstRows.firstScreenOk,
        maxParallelFarImages: offscreenMaxFarImages,
        beyondFirstRowsWaited: true,
        expandedExtraRequested: true
      },
      hostLimitObservedMax: hostLimitObserved,
      concurrency: {
        ordinaryObservedMax: fixture.metrics.maxOrdinaryImages,
        ordinaryConfiguredFirstScreen: 8,
        heavyObservedMax: fixture.metrics.maxHeavyImages,
        heavyConfigured: 3,
        combinedObservedMax: fixture.metrics.maxCombinedImages
      },
      popupBackgroundMessage: true,
      resourcePanelThreadAndFocus: true,
      previewKeyboardRetry: true,
      popupNumberValidation: true,
      markExportAndBackup: true,
      pageBridgeRedirectBoundary: true,
      oneUseTxtRelay: true,
      signedRelayRedirect: true,
      readyImageQueue: { initial: readyDefault, beforeDeadline: readyBeforeDeadline, afterDeadline: readyAfterDeadline,
        cancelledRequests: fixture.metrics.readyHangClosed },
      manualTxtRetry: true,
      signedImageUrlParity: true,
      nativePopupStableWidth: 368,
      admittedOffscreenRequest: true,
      syntheticPageFixtureCount: pageCases.length + 1,
      multiTab: true,
      crossTabRecoveryProbe: crossTabChecks.nativeProbe,
      manualTxtRecoveryProbe: crossTabChecks.manualRecovery,
      crossTabArticleCache: crossTabChecks.sharedArticle,
      crossOriginForumLimit: crossTabChecks.forumLimit,
      coldScrollAndArticleRetry,
      offlineArticleRecovery,
      dynamicListPreview: dynamicListPreview,
      firstScreenTiming: {
        wallClockMs: timing.wallClockMs,
        queueWaitTotalMs: timing.queueWaitTotalMs,
        hiddenPauseTotalMs: timing.hiddenPauseTotalMs,
        requestTotalMs: timing.requestTotalMs,
        totalsBasis: timing.totalsBasis
      },
      bfcache: {
        persisted: bfcachePersisted,
        navigationType: bfcacheState.navigationType,
        rootCount: bfcacheState.rootCount,
        panelCount: bfcacheState.panelCount,
        notUsedReasons: pageOne.bfcacheNotUsed
      },
      mirror: mirrorReport,
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
  } catch (error) {
    smokeFailure = error;
    throw error;
  } finally {
    sessions.forEach(function(session) { session.cdp.close(); });
    if (browserConnection) {
      try { await browserConnection.send('Browser.close'); } catch (error) {}
      browserConnection.close();
    }
    try {
      if (fixture) {
        await new Promise(function(resolve) {
          fixture.server.close(resolve);
          if (typeof fixture.server.closeAllConnections === 'function') fixture.server.closeAllConnections();
        });
      }
    } finally {
      try {
        await stopSmokeBrowser(browser);
      } finally {
        if (process.env.ATP_BROWSER_SMOKE_KEEP !== '1') {
          try {
            await removeSmokeRunRoot(runRoot);
          } catch (cleanupError) {
            if (!smokeFailure) throw cleanupError;
            console.error('Cleanup also failed: ' + cleanupError.message);
          }
        } else {
          console.log('browser smoke artifacts: ' + runRoot);
        }
      }
    }
  }
}

main().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
