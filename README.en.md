# Article Thumbnail Preview

English | [简体中文](README.md)

A Chrome / Edge Manifest V3 extension that adds image previews and copyable resource links to supported Discuz! forum listing pages.

Current version: **1.17.0**. No server, npm installation, or build is required to use the extension.

Version 1.17.0 adds TXT queue backpressure, continuous integration, and page-structure fixtures without changing image concurrency, permissions, or cache formats.

Version 1.16.11 preserves legal ASCII punctuation in image URL queries and prevents repeated entity decoding across DOM and fallback extraction. Image/OG tags use bounded forward scanning. Browser-test commands and HTTP requests now have independent deadlines and pending-request cleanup.

Version 1.16.10 fixes repeated entity decoding, lost prototype-named passwords, and HTML tag boundary handling. Comment-heavy preprocessing now scans forward once. The page TXT bridge enforces same-origin redirects at the request layer and cancels unread rejected response bodies. Image concurrency and user settings are unchanged.

## Install and start

1. Download and extract an installation ZIP, or clone this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**, then choose **Load unpacked**.
4. Select the folder containing `manifest.json`: the repository root, the extracted installation folder, or the generated `dist/chrome-unpacked` folder.
5. Disable duplicate older installations first. Refresh a supported forum listing page, then configure the extension using its toolbar popup or the floating panel at the bottom right.

Do not open `popup.html` directly: it requires the browser extension environment. Keep the installation folder in place. After updating its files, reload the extension from the extensions page and refresh the forum tab.

## Features

- Listing-page thumbnails, full-image previews, scroll loading, and viewport-first scheduling.
- Separate ordinary/heavy image concurrency, host backoff, decoding budgets, and hidden-tab pause.
- ED2K, magnet, Baidu, Quark, 115, Aliyun/Alipan, UC, Xunlei, and selected regular file links.
- Automatic low-concurrency TXT attachment parsing, with manual retry and local TXT import as fallbacks.
- Local settings, caches, and diagnostic logs. Detailed DEBUG logging is disabled by default.

## Supported sites and privacy

Content scripts run only on HTTPS pages under `sehuatang.org`, `sehuatang.net`, and their subdomains. Cross-origin attachment access additionally allows `dl.ldkms.la` and `xia.ewrewej.la`. Other mirror domains are not automatically supported.

The extension requests `storage` and the site access listed in its Manifest. It has no custom upload server. Article, attachment, and image requests still contact the corresponding websites; same-origin attachment requests may use your current forum session. Local caches and logs can contain browsing traces. Review exported diagnostics before sharing them, and never upload browser profiles, cookies, or private attachments.

## Development and verification

Node.js is required for verification; the current validation environment uses Node.js 22. There are no third-party npm dependencies. From the repository root:

```powershell
node tools/verify.js
```

This checks JavaScript syntax, Manifest references and permissions, documentation versions, sandbox behavior regressions, and six external test suites. Internal test hooks are injected into sandboxes only, not shipped in the extension.

Package on Windows using PowerShell and Node.js:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1 -Zip
```

The output in `dist/` includes `chrome-unpacked`, an installation ZIP, and its SHA-256 checksum. Packaging uses a Manifest/popup-derived runtime allowlist and verifies the actual directory and ZIP. Documentation, tests, logs, and environment files are excluded from the installation package.

After packaging, run the browser regression:

```powershell
node tools/browser-smoke.js
```

It uses a disposable browser profile and a local HTTPS synthetic forum, not the real forum. It searches for an installed Playwright Chromium executable by default. You can also select a Chromium / Edge executable that supports automated unpacked-extension loading:

```powershell
$env:ATP_BROWSER_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tools/browser-smoke.js
```

The Playwright npm package is not required; the browser executable must already be available. Branded Chrome may reject automated extension-loading flags. Use Chromium / Edge or verify a manual installation in that case.

To create a complete maintainer handoff archive:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-maintainer-handoff.ps1
```

## Troubleshooting

### TXT backpressure

The background still runs at most 2 TXT jobs concurrently. At most 32 jobs may wait, with 4 waiting slots per tab. Waiting expires after 30 seconds or the caller deadline, whichever comes first; this limit does not truncate already running jobs. Busy/expired results remain retryable and do not write permanent failure caches. Retry later using the existing TXT action. Pending timers and expired entries are cleaned up.

### CI and fixtures

GitHub Actions runs on pushes, pull requests, and manual dispatch: Windows / Node.js 22 checks, installation and handoff packaging, and Chromium integration using pinned Playwright 1.63.0. Jobs time out after 15 minutes; newer runs cancel older runs on the same branch. Verified installation ZIPs/checksums are retained for 14 days. Repository permissions are read-only, Action dependencies are pinned to commit SHAs, and CI does not publish releases or modify code.

Four Discuz-shaped cases cover listings, image posts, resource-only posts, and login barriers. **These are synthetic fixtures, not live captures.** See [fixture provenance and sanitization](tests/fixtures/pages/README.md). Raw captures belong only in ignored `.local-fixtures/` and must not be uploaded.

### Manual acceptance

Reload the extension and test mixed ordinary/heavy lists, long scrolling lists, concurrent TXT parsing in several tabs, retry after busy results, hidden-tab recovery, and back/forward navigation. Check continued image progress, copyable TXT resources, and absence of duplicate panels. Reports should contain the version, browser version, reproduction steps, and privacy-reviewed logs, not cookies or full authenticated pages.

### Common issues

- **No thumbnails:** check the domain, listing-page type, global/site enable switches, then reload the extension and refresh the tab.
- **Some images fail:** the image host may be unavailable, rate-limited, or restricted. Reduce concurrency and retry; temporarily enable debug logging if needed.
- **TXT cannot be read:** confirm you can open the attachment normally, then use manual retry or import a downloaded TXT. Login requirements, challenge pages, and download restrictions may prevent automatic parsing.
- **Duplicate panels after upgrading:** disable duplicate installations loaded from other directories.

## Repository layout and provenance

- Root JS/CSS/HTML, `manifest.json`, and `icons/`: directly loadable extension.
- `tests/`: synthetic fixtures and regressions.
- `tools/`: verification, browser regression, and packaging scripts.
- `dist/`: ignored build outputs. Distribute installation ZIPs as release assets rather than committing them to source history.

This repository restores the available **1.16.8 release runtime** and integrates the **tests and maintenance tools from a 1.16.3 source snapshot**. Version 1.16.9 fixes stale log indexing, UTF-8 byte accounting, and handoff packaging, and updates the tests. The handoff contained no Git metadata, so earlier commits are unavailable. We do not reconstruct unrecorded per-version changes for 1.16.4–1.16.8.

[CHANGELOG.md](CHANGELOG.md) and [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) retain Chinese release and architecture history. Other Chinese technical/maintainer documents are historical references, not fully revised descriptions of every current detail. Use this README for current installation and verification, and `settings-schema.js` for exact parameter defaults and limits.

Passing tests is not a guarantee of compatibility with every live forum page, network condition, or future browser. Local Chromium synthetic regressions cover initial loading, scroll loading, concurrency, TXT parsing, redirect network boundaries, popup messaging, multiple tabs, and BFCache. Live-forum testing has not been completed.

## License

The owner has not selected a license. No open-source license is included; repository access should not be treated as permission to copy, modify, or redistribute the code.
