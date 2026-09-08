# 页面夹具 / Page fixtures

这些页面是按 Discuz 结构编写的合成数据，不是下载的真实帖子。listing.html 用于浏览器完整加载回归，其余案例通过 cases.json 同时驱动 Node 和真实浏览器 DOM 提取验证。

These are synthetic Discuz-shaped fixtures, not captured forum pages. listing.html drives the complete browser listing test; cases.json drives extraction checks for detail and error pages.

## 加入真实页面回归

1. 手动把有问题的页面另存到仓库的 `.local-fixtures/`（已 Git 忽略），不要直接提交原始 HTML。
2. 保留触发问题的 DOM 结构，删除脚本、个人信息、Cookie、登录 token、签名下载地址及其他用户内容；用 example.test / example.com 地址和虚构文案替换，必要时删掉原内容只保留最小复现结构。
3. 人工检查后将最小脱敏 HTML 放到本目录，为 cases.json 添加精确预期，并标注来源为 sanitized reproduction（不要写真实帖子地址或账号）。
4. 执行 `node tests/page-fixtures.test.js` 和 `node tools/browser-smoke.js`。真实帖子和网络兼容性仍由实际浏览器验收确认。

Keep raw captures in ignored `.local-fixtures/`. Submit only manually reviewed minimal, sanitized reproductions with explicit expected results; never submit session secrets or original personal/content data. Run both fixture and browser tests before committing.
