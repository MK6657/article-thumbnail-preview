# Article Thumbnail Preview

English | [简体中文](README.md)

A Chrome / Edge Manifest V3 extension that adds image previews and copyable resource links to supported Discuz! forum listing pages.

Current version: **1.18.5**. No server, npm installation, or build is required to use the extension.

Version 1.18.5 adds resource marking: mark threads on a list page (「标记」) to keep their title, links, share codes and archive passwords, then export them from the popup as a TXT file. Every export or copy is also kept in a dated daily backup. Share codes no longer get paired with a neighbouring link.

From version 1.18.4 the reset button works from the popup on any page and resets every forum domain at once.

Version 1.18.3 adds “立即重置论坛节流” (reset forum pacing now) to the popup maintenance section, which also shows the current forum tab's pace. After the forum shows its verification page the extension slows itself down and keeps that for 24 hours; this button brings back the normal pace at once.

Version 1.18.2 loads the first screen by what you are looking at: forum requests go to the threads on screen first, so after opening a page or scrolling the visible threads appear almost at once instead of one every 2 seconds from the top down. When the forum hands out an attachment host that is down, images are fetched from a working host of the same attachment store.

Version 1.18.1 adapts the GIF download lane to how fast each image host actually is, so images on screen load sooner, and shows animated GIF thumbnails as a still frame that plays on hover, which removes the scroll stutter from dozens of GIFs playing at once.

Version 1.18.0 supports forum mirror and reverse-proxy sites: approve each one under “镜像站点” (Mirror sites) in the popup and the extension runs there, reading only that site's own content. It also fixes forum challenge and rate-limit pages being treated as empty threads, which left the last few threads on each page without images: requests to the forum now go through one pacer that pauses and retries when the forum pushes back. Animated GIFs get their own small lane on each image host (at most 2 at a time) and a longer deadline. Each post loads its static thumbnails first, so multi-megabyte GIFs no longer use up the bandwidth and time out the thumbnails around them. It also reduces stutter from offscreen preloading, the loading shimmer on pending thumbnails, a background retry scan, and pathological post/TXT parsing. Several scheduler, TXT, cache, and logging defects are fixed as well.

Version 1.17.8 stages background image work per thread in bounded batches instead of creating hundreds of viewport-waiting tasks at once, reducing scheduler scans and memory pressure on long lists.

Version 1.17.7 turns off full-list offscreen first-row loading by default. The old default-on setting is not carried forward; users can opt in again. Listing pages return to distance-based fetching and loading for smoother scrolling.

Version 1.17.6 limits one ordinary image host to six in-flight requests during full-list automatic loading. A slow in-flight image keeps its original request until the existing per-task deadline instead of being interrupted for an immediate no-Referer retry.

Version 1.17.5 caps ordinary offscreen first-row requests at three and pauses new offscreen starts while scrolling. This reduces long-list loading and decode pressure while keeping visible images first and the per-thread first-row count unchanged.

Version 1.17.4 fixes article-view cache collisions and false TXT attachment detection. Offscreen threads can load their first configured rows while visible work keeps priority. Diagnostics now store fewer duplicate fields and retain effective settings, rollover counts, and first and recent failures; export flushes the active tab first.

Version 1.17.3 offers free slots to registered, actually visible pending images before ordinary queued work, instead of relying solely on a later wake callback. Diagnostic snapshots reuse unchanged background-queue counts to avoid repeated scans. Concurrency, image limits, and user settings are unchanged.

Version 1.17.2 fixes a conflict between JS admission and native image lazy loading. Images holding timed active slots now start eagerly, while offscreen fetch priority remains low. This prevents deferred requests from consuming slots until false timeouts trigger host throttling. Unadmitted images still wait; concurrency, user settings, and cache formats are unchanged.

Version 1.17.1 fixes idle toolbar-popup flicker by using a stable 320px document width instead of feeding the auto-sized viewport back into layout. Browser tests now sample an actual action popup over time. Image scheduling and user settings are unchanged.

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

- Listing-page thumbnails, full-image previews, and viewport-first scheduling. Optional offscreen loading fetches each thread's first columns × visible rows images; remaining images load after expanding or scrolling the thread's thumbnail area.
- Separate ordinary/heavy image concurrency, host backoff, decoding budgets, and hidden-tab pause.
- ED2K, magnet, Baidu, Quark, 115, Aliyun/Alipan, UC, Xunlei, and selected regular file links.
- Automatic low-concurrency TXT attachment parsing, with manual retry and local TXT import as fallbacks.
- Local settings, caches, and diagnostic logs. Detailed DEBUG logging is disabled by default.

Compact final image failures are recorded even with DEBUG disabled. Each page session retains effective loading settings, the first and latest incidents, host failure counts, and the range of trimmed details. Export asks the active forum tab to flush buffered logs first. URL query strings are removed; review paths and thread details before sharing a report.

## Supported sites and privacy

Built-in support covers HTTPS pages under `sehuatang.org`, `sehuatang.net`, and their subdomains. Cross-origin attachment access additionally allows the download relays `dl.ldkms.la` and `xia.ewrewej.la`.

### Mirror and reverse-proxy sites

Add other forum mirrors or reverse-proxy domains under “镜像站点” (Mirror sites) in the popup: open the popup on that site and click “添加当前站点” (Add current site), or type a domain such as `mirror.example` and click “添加” (Add). The browser asks for permission; only after you approve does the extension run on that domain and its subdomains. Adding the current site reloads that tab; reload other open tabs yourself.

- HTTPS only. IP addresses, localhost, the built-in domains, and the download relays cannot be added. Up to 20 mirrors.
- Each mirror is its own site: a mirror page only fetches, parses, and reads cached data for that mirror's threads and attachments, never using the built-in forum's or another mirror's session. The two built-in domains keep their existing behavior.
- Removing a mirror revokes the browser permission and unregisters the scripts; open tabs stop after a reload. You can also manage this under the extension's “Site access” settings.
- Permissions: `scripting` registers content scripts for approved mirrors; `activeTab` lets the popup read the current tab's address for one-click adding; the optional host permission `https://*/*` is only an upper bound — no site is granted at install and each one must be approved.

The extension requests `storage`, `scripting`, `activeTab`, and the site access described above. It has no custom upload server. Article, attachment, and image requests still contact the corresponding websites; same-origin attachment requests may use your current forum session. Local caches and logs can contain browsing traces. Review exported diagnostics before sharing them, and never upload browser profiles, cookies, or private attachments.

## Development and verification

Node.js is required for verification; the current validation environment uses Node.js 22. There are no third-party npm dependencies. From the repository root:

```powershell
node tools/verify.js
```

This checks JavaScript syntax, Manifest references and permissions, documentation versions, sandbox behavior regressions, and seven external test suites. Internal test hooks are injected into sandboxes only, not shipped in the extension.

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

- **No thumbnails:** check the domain (approve mirror sites under “镜像站点” in the popup first), listing-page type, global/site enable switches, then reload the extension and refresh the tab.
- **The last few threads on a page have no images for a while, or a “论坛限流” note follows the title:** after about thirty requests within a few seconds, the forum answers with a small challenge page. The extension sends at most 10 forum requests back to back and then one every 2 seconds, threads on screen first; all tabs of the same forum share this allowance, and after a challenge it stays below the pace that triggered it for 24 hours. If the forum still pushes back, all forum requests pause for 20 seconds (doubling up to 5 minutes), then single probes retry automatically; the log shows “论坛限流，暂停论坛请求” or “正文返回非帖子页”. The challenge usually clears once the browser loads a forum page normally, so reloading the list page retries at once. The extension never runs or answers the challenge page.
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
