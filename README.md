# 文章缩略图预览

[English](README.en.md) | 简体中文

Chrome / Edge Manifest V3 扩展，在支持的 Discuz! 论坛列表页显示帖子图片缩略图，并汇总可复制的资源链接。

当前版本：**1.16.9**。无需服务器、npm 安装或构建即可使用。

## 安装与启动

1. 下载并解压安装 ZIP，或克隆本仓库。
2. 打开 Chrome 的 `chrome://extensions`，或 Edge 的 `edge://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的目录：仓库根目录、安装 ZIP 解压目录，或打包生成的 `dist/chrome-unpacked`。
5. 如已安装另一份旧版，先禁用旧版，避免重复注入。刷新论坛列表页，通过工具栏扩展图标或页面右下角浮窗调整设置。

不要双击 `popup.html`，它依赖浏览器扩展环境。加载后请保留安装目录；更新文件后，在扩展管理页点击重新加载，再刷新论坛页面。

## 功能

- 列表页缩略图、点击大图预览、滚动续载与可视区域优先调度。
- 普通图片和重图独立并发、图床退避、解码预算及隐藏标签页暂停。
- 提取 ED2K、磁力、百度网盘、夸克、115、阿里云盘、UC、迅雷云盘和部分普通文件链接。
- TXT 附件自动低并发解析；失败时可手动重试或导入已经下载的 TXT。
- 本地配置、缓存和诊断日志；支持清理与参数调整，详细 DEBUG 日志默认关闭。

## 支持范围与隐私

内容脚本仅在 HTTPS 的 `sehuatang.org`、`sehuatang.net` 及其子域名运行。附件跨域请求另允许 `dl.ldkms.la` 和 `xia.ewrewej.la`。其他镜像域名不会自动启用。

扩展申请 `storage` 和 Manifest 中列出的站点访问权限，没有自建上传服务器。论坛正文、附件和图片请求仍会连接相应网站；同源附件读取可能使用当前论坛会话。本地缓存和日志可能包含浏览痕迹，分享问题报告前请检查导出内容，不要上传浏览器资料、Cookie 或私人附件。

## 开发与验证

验证使用 Node.js，当前验证环境为 Node.js 22。没有第三方 npm 依赖。在仓库根目录运行：

```powershell
node tools/verify.js
```

该命令检查 JS 语法、Manifest 引用与权限、文档版本、沙箱行为回归，并运行四组独立测试。测试专用内部入口仅注入沙箱，不加入生产扩展。

Windows 下打包（需要 PowerShell 和 Node.js）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1 -Zip
```

输出位于 `dist/`，包括 `chrome-unpacked`、安装 ZIP 和 SHA-256。脚本仅复制 Manifest / popup 引用的运行时白名单，并复验实际目录及 ZIP；不会把文档、测试、日志和环境文件放入安装包。

打包后运行浏览器回归：

```powershell
node tools/browser-smoke.js
```

脚本使用独立临时浏览器资料及本地 HTTPS 合成论坛，不访问真实论坛。默认寻找本机 Playwright Chromium；也可显式指定支持自动加载扩展的 Chromium / Edge：

```powershell
$env:ATP_BROWSER_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tools/browser-smoke.js
```

它不需要安装 Playwright npm 包；浏览器可执行文件需自行准备。品牌版 Chrome 可能不接受自动化扩展加载参数，遇到此情况请使用 Chromium / Edge，或手动安装验证。

维护者完整交接包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-maintainer-handoff.ps1
```

## 常见问题

- **页面没有缩略图**：确认使用支持的域名、当前页面是帖子列表、扩展和当前站点开关已启用；重新加载扩展后刷新页面。
- **部分图片失败**：可能是图床失效、限流、登录限制或网络问题。降低并发后重试，必要时临时开启调试日志。
- **TXT 无法读取**：先确认浏览器能正常打开附件，再用手动重试或“导入已下载TXT”。扩展不保证受登录、挑战页或下载限制保护的附件可自动读取。
- **升级后出现两套浮窗**：检查是否同时启用了多个安装目录的扩展副本。

## 仓库结构与版本来源

- 根目录 JS / CSS / HTML、`manifest.json`、`icons/`：可直接加载的扩展。
- `tests/`：合成夹具与回归测试。
- `tools/`：验证、浏览器回归和打包脚本。
- `dist/`：生成物，Git 忽略；安装 ZIP 适合单独作为发布附件，不提交进源码历史。

本仓库从现存 **1.16.8 发布运行时**恢复，整合 **1.16.3 源码快照的测试和维护工具**，在 1.16.9 修复日志索引、UTF-8 字节估算和交接打包问题，并更新测试。原交接目录没有携带 Git 历史，因此本仓库不包含之前的提交记录，也不推测 1.16.4–1.16.8 的逐版修改归属。

[CHANGELOG.md](CHANGELOG.md) 记录版本变化。[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)、[技术总览](插件技术总览.md)、[维护者指南](维护者交接指南.md) 和 [旧版使用说明](使用说明.md) 保留架构及历史材料；当前安装与验证以本 README 为准，具体参数以 `settings-schema.js` 为准。

验证通过不代表对真实论坛所有页面、当前网络或未来浏览器版本的兼容保证。本地 Chromium 合成回归覆盖首屏、滚动续载、并发、TXT、弹窗消息、多标签与 BFCache；尚未完成真实论坛实测。

## 许可证

项目所有者尚未选择许可证，本仓库暂不附带开源许可证。请勿把仓库可访问性视为复制、修改或再分发授权。
