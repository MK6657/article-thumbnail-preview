# 项目概览

## 当前更新

- 1.16.11：普通 URL 的查询标点按 URL 数据保留，图片属性在提取链只解码一次；完整标签顺序扫描替代全篇图片/OG 正则。浏览器验证命令与 HTTP 请求具备独立超时，新增 URL 双路径和命令生命周期回归。权限、配置和调度不变。

- 1.16.10：优化非渲染区域与锚点预处理的最坏情况复杂度，修复实体重复解码及 Object 原型名密码丢失。页面 TXT 请求在 fetch 层限制同源跳转并及时取消拒绝响应的网络流；浏览器回归验证跨域重定向目的地不会收到请求。权限、设置和图片调度保持原有行为。

1.16.9 基线修复：日志发现先记录旧索引再枚举真实分片，移除旧失效条目并保留期间新增的会话；UTF-8 fallback 正确处理代理对。维护者打包纳入 MAIN world 页面桥接、四组测试与双语 README，并支持尚无提交的新 Git 仓库。完整验证包含沙箱行为回归和独立 Chromium 合成论坛回归，不包含真实论坛实测。

- 1.16.9：从 v1.16.8 安装目录恢复统一源码，整合旧测试与工具，新增中英文 README。manifest.json 是版本权威，根目录是可直接加载的扩展，dist/ 仅为生成物。以下版本条目保留作历史参考；当前安装与验证以 README.md 为准。

- 1.16.3：TXT 附件改为识别后自动解析，使用独立 FIFO、每页最多同时处理 2 帖，单帖附件串行读取，background 消息另有扩展级并发 2，避免多附件/多标签请求放大后与可视图片竞争；自动成功直接出现分类复制按钮，自动失败后才显示手动解析和本地导入。文章缓存新增可选的 TXT 完成/未解析状态，完整结果返回页面直接复用，部分成功、新增附件或部分本地导入继续补齐；运行令牌阻止本地导入被迟到网络结果覆盖。图片调度、弱图预设、重图策略、权限、缓存 key/TTL 和复制格式不变。
- 1.16.2：修复同源 Discuz TXT 下载附件在扩展隔离 fetch/background fetch 下被 Cloudflare 或 SameSite 会话边界拦截的问题。新增仅允许当前站点 origin 和附件形态 URL 的页面主环境读取桥，限制 512KB/10 秒并保留原后台回退；资源面板增加“导入已下载TXT”无权限兜底，复用现有资源解析器并将结果写入文章/TXT 缓存，后续返回页面可直接复制。文章解析和图片 URL 缓存语义不变，图片二进制仍使用浏览器 HTTP 缓存；不增加 Manifest 权限或修改图片调度。
- 1.16.1：修复真实论坛日志中确认的调度阻塞。自动全局槽不再被后台并发缩成单路，普通与重图自动总并发改为通道之和；真实视口使用零 margin 直达队列并动态晋升在途请求，槽位释放后不再通过 12 项轮转扫描寻找可视任务。普通 host 熔断加入最近失败比例，避免少量坏 URL 把健康图床锁进 30 秒单路循环；重图 restore 纳入统一槽位。弱图预设改为 100M、200M、高速三档完整配置，且继续不修改资源提取、访问码、fresh TXT、缓存或权限链路。
- 1.16.0：把兼容 key `firstScreenConcurrency` 明确为用户可调“弱图可见并发”，滚动后进入真实视口的普通图不再继续受单路后台并发限制。新增独立 `viewportPriorityReservedSlots`：只降低离屏弱图 admission，可见图/手动重试使用完整弱图并发，离屏仍至少保留一路推进；重图独立并发和混合页普通保留槽不受挤压。popup 与悬浮面板提供温和、均衡、快速三档共享预设，协调弱图可见/后台/同域并发和后台速度，不修改重图、显式全局 ceiling、抓取/显示上限或资源链。
- 1.15.4：根据 `forum-49` 混合页日志继续收口重图 host 状态机。旧实现把同一任务的多个 fallback 坏 URL 各计一次 host 失败，少量任务即可击穿阈值；恢复前启动的迟到失败还会重新打开刚恢复的冷却窗口，指数冷却计数也会跨恢复累积。现在每任务/host/健康代际最多计一次失败，普通与重图请求均记录启动代际并忽略旧代际迟到失败；恢复会清空失败窗口与指数退避。OPEN host 的离屏重图继续 deferred，可见图和手动重试则可使用受公开 probe、重图 ceiling、全局总槽和普通图保留槽共同约束的恢复通道。资源、fresh TXT、缓存、消息、权限、设置和页面全路径覆盖不变。
- 1.15.3：根据真实论坛日志修复普通图 host 自适应锁死：坏链将 host 降到单槽后，离屏慢请求曾独占唯一槽，使 24 个真实可见占位持续零推进并按约 30 秒一张失败循环。现在同批在途失败不续期冷却，冷却到期清除旧失败窗口，达到公开恢复成功数也立即恢复；真实可见图拥有受普通 host 软限制约束的独立保底 admission，离屏探针不能饿死可见图。离屏首屏 pending 保留首屏并发，首屏/后台共用同一 pending 上限；容量与槽释放唤醒全局调度，混合线程普通图可越过 OPEN 重图，detached current task 会重建或结算。重图预算与内部滚动裁剪统一，预览捕获失败保留原图，快速 restore 重试耗尽后转 15 秒可见 watchdog；多内部滚动根切换会复位上一根，空根不保留 observer。资源链、缓存、消息、权限和设置契约不变。
- 1.15.2：在 Manifest 既有全站覆盖范围内增加轻量启动状态机：没有帖子候选的页面短退避后进入 dormant DOM 唤醒，不常驻滚动扫描，后续出现帖子或列表容器时自动恢复。同源正文仍并发下载，但资源、TXT、图片三阶段同步解析进入单队列并在阶段间让出一帧，降低批量响应长任务。图片首屏配额与网络优先级解耦，真实可见/手动重试才使用 `eager/high`，离屏首屏图进入受限 viewport pending，隐藏页允许续载时使用 `eager/low`；页面和内部 `.atp-scroll-viewport` 按滚动方向/速度使用 200-1000px 自适应预取，overflow 裁剪参与真实可见判断。shimmer 仅在占位真实可见期间运行，重图恢复前重算优先级。资源分类、访问码、fresh TXT、缓存结构与完整态、消息协议、权限、设置 schema 及公开并发/超时语义不变。
- 1.15.1：图片首屏调度按真实页面视口距离优先，在当前视口及前后 200px 内仍保持帖子间轮询公平；后台候选的 DOM wrapper/IntersectionObserver 注册改为使用独立 pending 预算，可在 8ms 时间片内批量推进到公开 `viewportPendingLimit`，不再被网络并发槽和后台逐张间隔误限速。实际图片请求继续读取原有全局、普通、重图和 host 槽位策略，资源提取、访问码、fresh TXT、缓存格式、消息协议、权限和全部用户设置语义不变。
- 1.15.0：加载策略改由 `settings-schema.js` + `loading-policy.js` 统一驱动。正文抓取使用可配置的流式 worker，单篇完成即提交；普通图与重图共用公开的总槽位、host 槽位和保留槽位策略。重图删除 8s/3.5s/6s 及混合 1/3 等隐藏截断，改为用户可配置的 fixed/adaptive host 状态机，开路期间候选 deferred、半开探针恢复后继续。普通图删除固定 5 次失败/2 分钟的旧域名熔断，普通/重图候选回退分别读取公开设置。重图解码数量、MP、可见区和轻量 preview 尺寸均可调，0 预算表示不限。并发、超时和预算设置支持 live reconfigure，旧设置缺少新增字段时读取默认值，不重写已有值。新增维护者入口文档和原子化交接包脚本，将当前工作树源码、验证工具、完整文档和可安装扩展打成单一带哈希 ZIP，不携带原机器 Git/agent/日志状态。
- 1.14.362：新增面向评审、维护和开源协作者的 `插件技术总览.md`，集中说明功能分类、MV3 上下文、扫描/抓取/提取/渲染完整数据链、普通图与重图槽位公式、视口 pending、重图 MP 预算、资源访问码边界、fresh TXT、全部 25 项设置、缓存代际、日志、测试证据和发布边界。README 增加公开入口，源码发布公开文档白名单和 staged 文件集合纳入该文档，扩展安装包仍排除 Markdown。运行时代码、权限、缓存格式、消息协议、所有用户设置默认值/范围和图片加载上限不变。
- 1.14.361：补齐真实 Chromium/Edge unpacked 验证入口。新增标准库实现的 `tools/browser-smoke.js`，在一次性 profile 中加载 `dist/chrome-unpacked`，通过本地 HTTPS Discuz 夹具验证 isolated world、唯一浮窗、同源/跨域抓取、普通图首屏和滚动后续载、重图独立并发、访问码绑定、fresh TXT、popup/background 消息、多标签及 BFCache。Playwright Chromium 148 和 Edge 150 实测通过：普通图首屏 10/10、滚动后继续到后台任务，重图首屏 5/5，并发峰值普通 3/重图 2，BFCache `pageshow.persisted=true`，运行时异常和扩展控制台错误均为 0。官方 Chrome 150 忽略自动 `--load-extension`，手工 Chrome UI 加载仍作为补充验证。工具、临时证书和 profile 不进入扩展包；v1.14.360 的运行时行为、权限、缓存格式和全部用户可调设置不变。
- 1.14.360：收口大量图片与资源提取主链。content/background 的文章请求改为并发上限仍为 3 的动态补位池，慢请求完成前其他 worker 可继续取下一篇；图片总 active 槽位改取普通并发与重图并发的较大值，使默认普通 1/重图 2 真正允许两个重图槽，同时普通通道仍只按普通并发限流、混合总槽不相加。跨域 Discuz 临时 TXT 附件新增独立 fresh 消息按需提取，访问码只绑定网盘链接；设置统一为 live/hotReload/pageReload，普通显示和加载设置不再额外整页刷新，DEBUG 默认关闭并在 loader/viewport 热路径提前门控。新增 8 类、含 600 条链接压力输入的独立资源测试，以及 Manifest 白名单扩展打包脚本，测试/工具/文档不进入安装目录和 ZIP。不调整用户可调的抓取/显示上限、默认值、范围、普通或重图并发、超时、重试、重图预算、既有消息值、权限、缓存 key/TTL/值结构。
- 1.14.359：补齐缓存索引和浮窗注入的失败自愈边界。`cache.js` 与 `background.js` 在缓存值已经成功落盘、但 cacheIndex 批量更新明确失败时，会异步触发一次完整索引重建；同一上下文重建未完成期间的连续失败会合并，不改变缓存写入成功回调和用户操作时序。`content.js` 创建悬浮面板前会清理没有 `window.__bfpPanel` 活实例持有的遗留 `#bfp-root`，活实例不受影响，旧根无法确认移除时停止创建新面板。`tools/verify.js` 补 content/background 索引故障注入、重建去重，以及孤儿根、活实例和删除失败回归。不调整 manifest 权限、host 权限、缓存 key/TTL/值结构、cacheIndex 格式、消息协议、设置 schema、DOM id、图片调度或重图预算。
- 1.14.358：修复两个已确认的兼容性缺陷。`shared-utils.js` 对 HTTP 200 的 Discuz 登录、权限、购买和下载拦截正文增加保守分类，只有明确提示页结构或购买动作才判为不可用；`fetcher.js` 将这些结果按可重试空结果处理且不写文章负缓存，background 复用同一分类并保留具体原因。`renderer.js` 显式保留合法的 `gridGap=0`，不再回退到 6px。四个跨上下文消息类型集中到不可变的 `SharedUtils.MESSAGE_TYPES`，所有发送方和 background handler 统一引用，实际线协议不变。`tools/verify.js` 补消息协议值、同源/background 拦截页、普通正文防误判和实际渲染 CSS 零间距回归。不调整 manifest 权限、host 权限、缓存 key/TTL/值结构、cacheIndex 格式、消息 type/响应结构、设置 schema、图片调度、并发和重图预算。
- 1.14.357：修复最近版本缩略图加载卡死回归。`loader.js` 的 no-referrer fallback 改为按当前真实 `img.src` 加载窗口计算，同一 src direct timeout/error 后必须获得一次独立 no-referrer 重试，重试 timeout 限制在 3-8 秒，candidate fallback 换 src 后重新获得一次机会，不再因为任务创建、排队或 slot claim 已经过久而成批 `no_referrer_deadline`；普通图床 host 新增页内自适应降速，同 host 默认最多占用 6 个 active slot，连续失败后降到 2，再失败降到 1 并短冷却，首屏任务保留优先级但不绕过同 host 保护；诊断补 `image_retry` 的 retry/current-src/hostActive 字段、`image_done` 的 release 后 active 字段和调度 host active top；`tools/verify.js` 补 no-referrer retry、排队 88s、candidate 换 src、普通 host 降速和 release 后 active 下降回归。不调整 manifest 权限、host 权限、用户设置 schema、用户可见并发配置含义或跨标签全局并发队列。
- 1.14.356：继续收口多标签/隐藏页缩略图加载卡顿的本页内边界。`viewport-observer.js` 会在 pending 计数、统计、可见重试、slot 重试和隐藏页 drain 前清理已脱离 DOM、已 loaded 或任务失效的 wrapper，避免 `getPendingCount()` 被失效节点长期顶高并阻塞后台队列；`loader.js` 在隐藏标签页且启用“不可见时暂停”时会取消已启动 `<img>`、释放图片 slot，并把 direct 任务重排，`viewport-observer.js` 会把已启动懒加载 wrapper 放回 pending。`loader.js` 的 no-referrer fallback 改用剩余墙钟时间，不再重启完整 `imageTimeout`；`renderer.js` 将滚动视口 padding 计入折叠高度，`content.css` 用 border-box/inset 边线、绝对覆盖 loading 和 `object-fit: contain` 减少只露边角。`tools/verify.js` 补 pending prune、隐藏页取消重排、no-referrer deadline 和缩略图布局守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、cacheIndex 格式、日志字段结构、导出字段结构、设置 schema 或跨标签全局并发队列。
- 1.14.355：继续收口缓存清理代际的同 key 写入竞态。`cache.js` 与 `background.js` 的过期写入清理在删除前核对 storage 当前值仍属于该批写入，避免新任务已刷新同一 key 后被旧任务清理误删；`content.js` 将扫描开始时间传入 `renderer.js` 线程状态，resource-only 文章补写和 `loader.js` 的 loaded URL 延迟 flush 继续使用该时间，避免清缓存前已完成抓取、但稍后才渲染或加载图片的旧任务重新写回缓存。`tools/verify.js` 补 content/background 同 key 新值所有权竞态回归和 renderer/loader 时间传递静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、cacheIndex 格式、日志字段结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值或资源面板交互语义。
- 1.14.354：新增 `atp_cache_generation_v1` 缓存清理代际。popup 清理缓存会在发现/删除缓存前后写入代际；content/background 已排队或已开始的 article/TXT/负缓存写入在真正落盘前后都会校验代际，generation 读取失败时 fail-closed，quota 淘汰重试也会重新校验；`fetcher.js`、`content.js`、`renderer.js` 与 `background.js` 将异步 fetch/flush 起始时间传入缓存写入。`tools/verify.js` 补 content/background/popup 缓存清理代际回归和静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、cacheIndex 格式、日志字段结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值或资源面板交互语义。
- 1.14.353：继续收口诊断日志清空代际的 storage 异常边界。`logger.js` 与 `background.js` 在 flush 前读取 `atp_logs_cleared_at` 清空标记失败时会 fail-closed，把当前批次重新入队并结束本轮写入，不再按“无清空标记”继续写 storage，避免用户清空日志期间的短暂 storage 读取失败让旧内存日志回写。`tools/verify.js` 补 content/background logger 清空标记读取失败回归和静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.352：继续收口帖子列表容器替换后的扫描恢复边界。`content.js` 保留现有帖子容器内部 `MutationObserver`，同时在容器父节点上增加轻量 `childList` observer；当站点整块替换 `#threadlist`/帖子列表容器时，会断开旧 observer、提升扫描 generation、重新绑定新容器并触发快速补扫，避免缩略图只能等滚动、BFCache 恢复或设置重载才继续扫描。父级 observer 不开启 `subtree`，teardown/禁用/启动失败路径都会清理该 observer。`tools/verify.js` 补父容器替换动态回归和静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.351：继续收口诊断日志清空后的内存队列和异步 UI 边界。popup 清空日志/一键清空会写入 `atp_logs_cleared_at` 清空代际；`logger.js` 与 `background.js` 后续 flush 会过滤清空前已在 `buffer`、`flushQueue` 或 `retryBatch` 中的旧日志，避免用户刚清空的日志又被回写到 storage。popup 读取、过滤和导出日志也会按清空代际隐藏旧条目，清空失败会回滚 marker；折叠态 `refreshLogCount()` 加入序列保护，旧异步计数不再覆盖清空后的 `0`。`tools/verify.js` 补 content/background logger 清空代际、popup marker、失败回滚、读取过滤和计数竞态回归。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.350：继续收口 mixed worktree 发布验证可见性。`tools/verify.js` 默认模式发现 release 文件有未暂存变更时，会输出 `worktree verify ok (staged release files not checked)`，并在 staged warning 中读取 index 里的 `manifest.json` 与发布文档版本锚点，提示 staged/worktree 版本差异；当前 staged 快照仍停在旧版本时，不会再被默认输出误读为完整发布验证。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志存储结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.349：继续收口内部缩略图滚动时的加载降载边界。`loader.js` 现在除 `window.scroll` 外，还用 document capture scroll 监听嵌套滚动容器；用户在 `.atp-scroll-viewport` 内滚动时也会进入 `HEAVY_SCROLLING`，重图恢复与高 fanout 加载会等滚动 idle 后再继续，减少内部滚动中的卡顿风险。`tools/verify.js` 新增 loader nested-scroll 动态回归，并补静态守护确认 capture listener 注册和 teardown 对称移除。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志存储结构、导出字段结构、设置 schema、主加载策略、pending budget、重图预算阈值或资源面板交互语义。
- 1.14.348：继续收口诊断日志隐私边界。`logger.js`、`background.js` 和 `popup.js` 的日志清洗现在会按字段名遮蔽 `token`、`access_token`、`authorization`、`cookie`、`password`、`signature` 等敏感值；popup 导出历史结构化 `fields` 与旧 JSON `data` 时也会二次遮蔽，避免非 URL 敏感字段值落盘或导出。`tools/verify.js` 扩展 content/background/popup 日志脱敏回归，确认敏感值不出现在 storage/export 文本，同时保留 URL query/hash 脱敏与路径上下文。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志存储结构、导出字段结构、设置 schema、主加载策略、重图预算阈值、资源面板交互或运行时加载调度语义。
- 1.14.347：继续收口关键加载链路验证。`tools/verify.js` 新增 loader/viewport 动态压力回归，模拟 500 个后台候选进入 viewport pending、pending-full backoff、visible pending retry、slot pressure 和 slot-release wake 的组合路径，确认后台占位不会越过 pending budget，visible pending retry 的布局读取保持有界，slot 释放后能继续推进 pending 加载。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值、资源面板交互或运行时加载调度语义。
- 1.14.346：继续收口 TXT 附件隐私和临时链接缓存边界。`shared-utils.js` 新增临时/可持久化 TXT 附件判断与 pageUrl 净化 helper；`cache.js` 不再把 Discuz 附件、`xia.ewrewej.la` 签名直链或带常见签名 query 的 TXT 直链写入 article cache，只保留 TXT marker；`fetcher.js`、`background.js`、`content.js`、`renderer.js` 统一用 transient TXT 判断过滤缓存写入和文章响应；content/background 同源 TXT referrer 会剥离 query/hash 后再发送，跨源仍拒绝。`tools/verify.js` 补 article cache signed TXT 隐私、pageUrl 净化、background transient response 过滤和同源 referrer 去 query/hash 回归。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值、资源面板交互或加载调度语义。
- 1.14.345：继续收口 reduced-motion 用户体验边界。`content.css` 与 `floating-panel.css` 在 `prefers-reduced-motion: reduce` 下会禁用普通缩略图和悬浮按钮的 hover scale，减少动态效果用户不再遇到缩放跳变；`tools/verify.js` 补 reduced-motion hover transform 静态守护，防止未来只关闭 transition/animation 却保留实际缩放。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值、资源面板交互或加载调度语义。
- 1.14.344：继续收口 mixed worktree 发布风险可见性。`tools/verify.js` 的默认验证在 staged release files 未检查时，会列出前几个未暂存 release 文件并摘要剩余数量，不再只给出总数；发布前能更快判断 staged 快照与当前工作树差异来自哪些关键文件。仅调整验证输出和守护，不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.343：继续收口隐藏页 viewport pending drain 的发布边界。`tools/verify.js` 新增 `loadPendingWhenHidden()` 动态回归，确认长列表 pending 在隐藏页继续加载时会按请求上限派生扫描窗口，不会因旧的 `pendingWrappers.forEach` 路径全量扫过大量离屏 pending。仅增加验证守护，不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值、资源面板交互或运行时加载语义。
- 1.14.342：继续收口 TXT 临时附件和高频日志热路径。`background.js` 的文章响应会过滤 Discuz 临时 TXT 附件 URL，并保留 `hasTextAttachments` / `textAttachmentCount` marker；跨域首次渲染后按需解析 TXT 时，会重新提取临时附件链接，不再直接请求可能过期的 raw Discuz URL。`shared-utils.js` 的 Discuz 附件判定支持 `sehuatang.org` 与 `www.sehuatang.org` 等同站点 host alias 互跳，仍拒绝跨站 host。`logger.js` 对结构化 object 日志只执行一次字段归一化，复用到 `fields`、`data` 和 console 输出，减少 loader/viewport 高频诊断日志的重复递归清洗成本。`tools/verify.js` 补 background Discuz TXT marker、Discuz host alias、logger 单次 normalize 动态回归和静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志字段、导出字段、设置 schema、主加载策略、重图预算阈值或资源面板交互。
- 1.14.341：继续收口 TXT 附件裸文本 URL 清理边界。`shared-utils.js` 的 `extractTextAttachments()` 在生成候选前统一通过 `cleanResourceUrl()` 清理 URL；裸文本 `xia.ewrewej.la` 签名直链或 Discuz 附件链接后接中文标点、括号、逗号等说明文字时，不再把尾随标点编码进真实下载 URL、缓存 key 或后续 fetch 请求。`tools/verify.js` 补裸文本 signed xia 后接中文标点回归和静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源面板交互。
- 1.14.340：继续收口 TXT 附件 URL 识别与去重边界。`shared-utils.js` 新增并复用 signed TXT 下载 URL helper，文章页锚点和裸文本里的 `xia.ewrewej.la` 签名直链即使没有 `.txt` 后缀也会作为 TXT 附件候选进入按需解析；Discuz 附件判定改为大小写不敏感并补 `attachid` / `attachmentid` / `aid` 形态，避免临时附件链接被当作可缓存外部 TXT；`extractTextAttachments()` 和 `extractTextDownloadUrls()` 统一用 `normalizeTextAttachmentUrl()` 去重，query 顺序或 hash 不同的同一 URL 不再重复进入候选。`tools/verify.js` 补 signed xia、Discuz 大小写、跨 host 拒绝和 query/hash 归一去重回归及静态守护。不调整实际权限、host 权限、缓存 TTL、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源面板交互。
- 1.14.339：继续收口 viewport pending 恢复卡顿边界。`viewport-observer.js` 的 pending retry timer 清理会同步重置 visible pending 空扫进度；hidden pause、BFCache/pagehide、公开 pause 或 destroy 后恢复时，不再沿用旧空扫计数过早停止 80ms 自重试，减少可见占位等待下一次 scroll / observer / slot release 才继续加载的短时卡住。`tools/verify.js` 补 visible pending 空扫计数清理回归和静态守护。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源提取规则。
- 1.14.338：继续收口混合 TXT marker 的失败降级路径。`renderer.js` 在 cached 外部 TXT 只是子集、需要重新提取 Discuz 临时附件时，如果 fresh extraction 抛错、返回异常或 reject，会回退解析已缓存的外部 TXT 附件，避免重新提取失败反而跳过已有 cached TXT；纯 marker-only 状态没有可缓存 URL 时仍保持可重试失败反馈。`tools/verify.js` 补 mixed TXT fresh-failure fallback 动态回归和静态守护。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源提取规则。
- 1.14.337：继续收口 TXT 附件缓存和按需解析边界。`cache.js` / `background.js` 读取 TXT 正缓存和失败缓存时会逐 key 验证有效候选，hashed current key 为空、过期或无效时继续检查 legacy raw key，命中 legacy 后迁移到 hashed key 并清理 raw key，避免无效 current 值遮挡可用 legacy 缓存。`cache.js` 保留外部 TXT 与 Discuz 临时附件混合场景的原始附件 marker；`renderer.js` 在 cached TXT 数量只是子集时会重新提取附件并合并 cached/fresh 结果，避免只解析外部 TXT 而漏掉 Discuz TXT。`tools/verify.js` 补混合 TXT marker、renderer 合并、content/background legacy 遮挡迁移回归和静态守护。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源提取规则。
- 1.14.336：继续收口 popup 保存失败回滚和重图恢复中卸载清理。`popup.js` 的设置保存失败回滚会同步修复实际触发控件，顶层启用开关等非 schema id 控件保存失败后不再停留在错误勾选状态；“恢复默认设置”执行期间会临时禁用设置控件和恢复按钮，避免 reset 写入与其它设置保存交错。`viewport-observer.js` 在恢复中的重图被卸载时会清理 restore timeout、reveal listener 和 loader active-load control，避免快速滚动后残留失效恢复控制。`tools/verify.js` 补 popup 保存失败动态回滚、reset 执行期锁定、恢复中重图卸载清理回归和静态守护。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或资源解析策略。
- 1.14.335：继续收口 popup 恢复默认设置和重图 observer 热路径。`popup.js` 的“恢复默认设置”在默认值已经成功写入 storage 后，如果后续 `loadUI()` 重新读取失败，不再把界面回滚到旧设置；已保存的默认值会保留，并通过持久 warning 告知重新读取失败。`viewport-observer.js` 的 heavy IntersectionObserver 在同一批 entries 恢复多个已卸载重图时复用一次 budget snapshot，避免 unloaded restore 路径对每个 entry 都同步构建 heavy render snapshot。`tools/verify.js` 补保存后 reload 失败回归，并扩展 heavy observer batching 回归覆盖多个 unloaded wrapper 同批恢复只读取一次 budget。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略、重图预算阈值或 popup 维护按钮文案。
- 1.14.334：继续收口 popup 维护操作的脏索引边界。`popup.js` 从 cacheIndex 读取待清理缓存 key 时不再只信任 entry type，还会复用 `isCacheKeyOfTypes()` 校验 key 前缀；即使 `atp_cache_index_v1` 混入 `settings`、日志 shard 或其它非缓存 key，也不会被清缓存按钮或一键清空当成缓存删除。`tools/verify.js` 补 dirty cacheIndex 回归，确认真实缓存 key 仍会被发现，非缓存 key 会被忽略。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、日志格式、导出字段、设置 schema、主加载策略或 popup 维护按钮文案。
- 1.14.333：继续收口 TXT 附件缓存隐私、浮窗保存反馈和 viewport pending 空扫成本。TXT 正缓存/失败缓存的新 storage key 改为 hash 后缀，不再把完整附件 URL、query token 或 hash 写进 key/cacheIndex；content/background 命中旧 raw TXT key 时会迁移到 hash key 并清理旧 key/index，cacheIndex rebuild 和 background mutation 不再接受 raw TXT key 更新。`floating-panel.js` 保存进入队列后立即播报“保存中...”，避免连续保存时上一轮成功提示误导当前状态。`viewport-observer.js` 的 visible pending retry 连续空扫覆盖完整 pending 集合后停止 80ms 自重试，避免大量离屏 pending 空闲时持续读布局。`tools/verify.js` 补隐私 key、legacy 迁移、rebuild 过滤、保存中提示和空扫停止回归。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存值结构、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主扫描策略。
- 1.14.332：继续收口浮窗保存反馈、隐藏页 viewport pending 推进和 manifest 权限发布边界。`floating-panel.js` 保存成功文案改为统一计算，只要本次 patch 或回退 changedKey 涉及任一 `immediate:false` 设置，就会在自定义成功文案后继续追加“需刷新页面生效”；reset 和重图预设不再吞掉刷新提示。`loader.js` 的 slot 释放唤醒会在隐藏页且 `pauseWhenHidden=false` 时继续调用 hidden viewport pending drain，避免后台任务队列为空但已有离屏懒加载占位等待槽位时停止推进。`tools/verify.js` 新增 manifest 权限精确白名单，固定 `permissions`、`host_permissions`、content script matches 和 web accessible resources matches，并拒绝 optional/externally_connectable 扩权入口。不调整实际权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主扫描策略。
- 1.14.331：继续收口长列表深滚和重图 observer 热路径成本。`scanner.js` 在 `scanState` 刚 reset 后可根据当前视口上边界一次性 seek 到附近候选，并保留少量回退行；同一 cursor 续扫不会重复 seek。`content.js` 缓存 `viewportTop` 并传入 scanner，深滚后不再从列表顶部逐项过滤大量离屏帖子，同时保留 below-viewport 空链扫停止、滚动队列原地压缩和结构性 cursor 清理语义。`viewport-observer.js` 的 heavy observer 回调改为 0ms 合并 budget reconcile，避免同步构建 heavy render snapshot。`tools/verify.js` 补 scanner 深滚、content seek 参数、heavy observer 合并和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.330：继续收口启动反馈、浮窗帮助按钮语义、资源侧栏空态和 mutation 扫描噪声。`popup.js` 在设置读取完成后只清理仍显示“正在读取设置...”的状态，不再覆盖并发日志计数失败写入的持久错误；`floating-panel.js` 的参数说明按钮会随展开/收起同步 `aria-label`；`resource-panel.js` 的无当前帖子空态改为 polite live region。`content.js` 的 MutationObserver 现在要求外部新增节点具备帖子行或标题链接特征后才清 scanner cursor 并触发重扫，广告、计数或普通占位节点插入不会反复打断滚动续扫。`tools/verify.js` 补对应动态和静态回归。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.329：修复窄屏内联资源栏 TXT 持久状态的读屏播报边界。`resource-panel.js` 在 inline 资源栏有非空 TXT 状态时改用 polite live region 渲染，覆盖自动解析中、失败、部分成功待重试等状态；空状态占位继续使用普通 span，避免空内容播报。`tools/verify.js` 同步更新 inline status 静态守护，并把后台补图 idle timeout 动态回归扩展为 extreme / veryfast / fast / normal / slow 速度矩阵，确认 100ms 短下限不会覆盖 normal / slow delay。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.328：继续降低后台补图调度尾延迟。`loader.js` 的后台补图 `requestIdleCallback` timeout 改为通过 `getBackgroundIdleTimeout(delay)` 计算，保留 100ms 短下限并跟随 `backgroundSpeed` delay，不再固定使用 `Math.max(1000, delay)`；忙页面下 fast / extreme 后台补图不会额外被 idle timeout 拖慢近一秒。`tools/verify.js` 更新后台 idle cleanup 回归，确认 fast 背景速度会使用 100ms idle timeout，并加静态守护禁止恢复旧 1000ms 地板。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、后台并发上限、pending budget、重图策略、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.327：收口 scanner 链接选择和缩略图展开按钮可访问名称。`scanner.js` 的 `findArticleLink()` 会按 selector 顺序返回第一个可用帖子链接；如果 `.icn a[href]` 先命中 `javascript:` 或 `#`，会继续尝试 `a.xst[href]` 等标题链接，避免根容器探测或候选扫描漏掉有效帖子行。`renderer.js` 的缩略图“展开/收起”按钮补充并同步 `aria-label`，多帖列表里读屏用户不再只听到多个泛化的“展开”按钮。`tools/verify.js` 补 scanner 不可用 icon link 回退动态回归，并加静态守护覆盖文章链接 fallback 和展开按钮可访问名称同步。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、扫描批次大小、资源解析调度、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.326：继续减少滚动续扫热路径分配。`content.js` 的 `keepUnconsumedQueuedProcessCandidates()` 改为用索引循环在原数组内压缩未消费候选，不再通过 `processCandidateQueue.slice(processCandidateQueueCursor)` 为每次滚动保留候选分配新数组；已入队但未处理的帖子仍会继续保留，scanner cursor 仍按滚动视口失效。`tools/verify.js` 补动态回归，确认压缩后队列对象保持不变、未消费候选不丢，并用静态守护禁止恢复 scroll-time `slice()` 分配。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、候选筛选语义、扫描批次大小、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.325：继续降低长列表链式扫描的重复根查询成本。`scanner.js` 的 `detectArticleContainers()` 会在同一个 `scanState` 仍持有有效 root、且 root 仍挂在当前 `document` 内时复用根容器，连续批次不再重复执行 `findThreadContainer()` 的多轮候选根探测；结构性失效、root 脱离文档或缺少 `querySelectorAll` 时仍会重新选择线程容器。`tools/verify.js` 增加 root 查询计数回归，确认第二批续扫复用已验证的线程根，并更新静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、候选提取语义、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.324：补齐 popup 二段确认 helper 的默认提示清理边界。`popup.js` 会先归一默认确认提示，再用于显示和超时清理判断；未来调用方即使不传自定义提示，确认超时后也会清空 `popupStatus`，不会留下过期 warning。`tools/verify.js` 补二段确认边界回归，覆盖切换到另一个破坏性按钮会恢复前一个按钮、默认提示超时会清状态和恢复文案。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.323：补齐 popup 破坏性按钮二段确认态的键盘取消路径。`popup.js` 现在支持在“再次点击确认”状态下按 `Escape` 取消，立即恢复按钮文案并通过 `popupStatus` 播报取消；`tools/verify.js` 补动态回归和静态守护，确认取消会清除 `data-confirming`、恢复按钮文案并拦截按键事件。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.322：收口 popup 破坏性操作的误触风险。`popup.js` 的清理缓存、清理失败缓存、清除全部缓存、一键清空缓存和日志、恢复默认设置、清空诊断日志现在都走共享二段确认；首次点击只进入确认态并通过 `popupStatus` 提示，3 秒内再次点击才执行。`popup.css` 补确认态样式，`tools/verify.js` 补按钮路径和静态守护，确认首次点击不会删除数据。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.321：修复 popup 诊断日志数量徽标的索引缺失边界。`popup.js` 折叠态刷新日志数量时仍先走轻量索引读取；如果索引缺失导致读到 0 条，再触发一次 storage key discovery 恢复真实 content log shard 数量，避免徽标初始显示 0、展开或导出后才跳变。`tools/verify.js` 补动态回归，确认该恢复路径在支持 `storage.getKeys()` 时不会读取全部 storage value。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志格式、导出字段、设置 schema 或主加载策略。
- 1.14.320：收口资源面板 TXT 解析按钮的 loading 视觉状态。`content.css` 为 `aria-disabled="true"` 的 TXT 解析按钮补降低透明度和 `not-allowed` cursor，并让 hover 背景只作用于未 aria-disabled 的按钮，避免解析中按钮看起来仍可点击。`tools/verify.js` 补 disabled CSS 守护，并确认侧栏与内联两个点击入口都会忽略 loading 按钮。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、资源解析调度、日志字段、设置 schema 或主加载策略。
- 1.14.319：继续降低 content script 启动期空成本。`content.js` 移除无消费者的用户交互唤醒监听，不再为 `click`、`keydown`、`scroll`、`mousemove`、`wheel` 注册一次性 document listener，也不再维护未被读取的 `ATPState.userInteracted`；`config.js` 同步移除死 API `ATPConfig.onUserInteraction`。`tools/verify.js` 改为守护 content/config 不恢复这条空监听链路。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志字段、设置 schema 或主加载策略。
- 1.14.318：继续减少 content logger 热路径分配。`logger.js` 为 content logger 增加 `timezoneNameCache`，页面会话内首次解析 `Intl.DateTimeFormat().resolvedOptions().timeZone` 后复用结果，不再为每条日志重复创建 Intl formatter；日志格式、时区字段、URL 脱敏、flush、索引维护和 popup 导出语义不变。`tools/verify.js` 补 content logger timezone 缓存动态回归，连续写入多条日志时断言 formatter 只创建一次，并补静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、日志字段或主加载策略。
- 1.14.317：继续降低页面启动期浮动设置面板成本。`content.js` 创建浮动面板时会传入已读取并归一化的 `ATPConfig.settings`，`floating-panel.js` 启动期不再二次读取 `chrome.storage.local.get('settings')`；构造期只创建启动按钮和空面板骨架，设置控件延迟到首次打开面板时渲染，参数说明延迟到首次打开帮助时渲染，减少用户不打开设置时的隐藏 HTML 拼装和重复 storage 读取。`tools/verify.js` 补构造期不读 settings、不渲染隐藏设置/帮助，以及首次打开/首次帮助打开才渲染的动态回归。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、设置 schema、保存语义或主加载策略。
- 1.14.316：继续降低重图 onload 热路径上的同步 canvas 成本。`viewport-observer.js` 的 balanced 重图缩略图加载完成后，会先执行渲染预算协调，再把低清 canvas preview 预热延后到 `requestIdleCallback` 或短 timeout，不再在每张重图 onload 热路径同步 `drawImage()`；轻量缩略模式仍会在释放原图前立即生成轻量 preview，预算释放 `unloadHeavyImage()` 也继续同步 `captureHeavyPreview()`，确保占位预览不丢。`tools/verify.js` 补 balanced monitor/restore 延迟预热、lightweight 即时预热、deferred prewarm 清理和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式、重图预算阈值或主加载策略。
- 1.14.315：继续收口失败缩略图重试反馈和诊断日志可读性。`loader.js` 的失败缩略图占位会显示“加载失败，点击重试”状态文字；手动重试遇到图片并发槽已满时，会同步更新可见文字、hover title 和 `aria-label` 为“正在加载其他图片，稍后重试”，并保留点击/键盘重试，不再只有图标无变化。`content.js` 的同源文章抓取异常日志恢复为可读中文“同源文章抓取异常”，避免 popup 诊断日志出现 mojibake。`tools/verify.js` 补失败占位槽满重试动态回归、可见状态静态守护和同源异常日志中文文案守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.314：继续收口 TXT 过期等待和长列表离屏扫描成本。`fetcher.js` 在 TXT 附件共享 deadline 已耗尽时直接返回可重试的未解析状态，不再启动同源 fetch、后台 `FETCH_TEXT_RESOURCES` 消息或本地 timeout timer；`content.js` 的 scanContext 会记录本轮是否已扫到当前视口下方，当本轮没有近屏候选且 scanner cursor 尚未耗尽时，不再继续每 250ms 链式空扫整页离屏列表，等待滚动、mutation 或 retry 重新触发。`tools/verify.js` 补对应动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.313：继续收口 TXT 附件等待预算和多行表格重复注入边界。`fetcher.js` 为一次 TXT 附件解析创建共享 deadline，并让同源直抓、同源后台回退和跨域后台回退沿用同一个剩余预算，避免慢/无响应 TXT 把单轮解析拖到 50 秒以上；`scanner.js`、`content.js` 和 `renderer.js` 复用父 `TBODY` 感知的已装饰候选判断，父容器已注入缩略图或已标记处理后，旧 `TR` 候选不会再次注入。`tools/verify.js` 补 TXT 共享 deadline、多行 `TBODY`、queued `TR` 和 renderer 插入前 guard 回归。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.312：继续收口资源复制反馈、后台 TXT 输入 fanout 和长列表扫描性能。`resource-panel.js` 在 Clipboard API 同步抛错或返回非 Promise 时会回退到临时 textarea 复制，并保留成功/失败反馈；`background.js` 的 `FETCH_TEXT_RESOURCES` 对原始附件输入增加 `SharedUtils.BG_FETCH_MAX_TEXT_ATTACHMENTS=30` 扫描上限，避免大量无效/重复附件拖住 service worker；`scanner.js` 的候选扫描增加每轮节点预算，长列表里大量离屏候选被视口过滤时会暂停并通过 scanState 续扫，不再单次滚动扫描读取整页布局。`tools/verify.js` 补对应动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.311：继续收口后台消息输入边界和滚动扫描漏候选边界。`background.js` 的 `FETCH_IMAGES` / `FETCH_TEXT_RESOURCES` 只接受真实数组输入，`FETCH_IMAGES` 使用 `SharedUtils.BG_FETCH_MAX_URLS=60` 限制单次 fanout，避免类数组 payload 或异常超大数组放大后台 CPU/网络工作；`content.js` 在滚动扫描保留未消费候选时会让 scanner cursor 重新校准，并强制后续 refill，避免快速滚动后旧队列项被当前视口过滤、再回滚时同一 generation 内不再发现帖子。`tools/verify.js` 补 background 非数组/超上限输入和 content 快速滚动/回滚恢复动态回归。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.310：继续收口后台抓取、加载调度和 TXT 手动解析反馈边界。`background.js` 的 `FETCH_IMAGES` 会为安全 sender 中单个不在 allowlist 内的 URL 返回显式 `origin_disallowed`、`retryableEmpty=false`，避免 content 把策略拒绝误判成 `background_timeout` 反复重试；`loader.js` 的 `clearBgTasks()` 会清理完整后台 timer，避免清队列后新后台任务被旧 `GLOBAL_BG_TIMER` 延迟挡住；`resource-panel.js` 在侧栏空态但仍可手动解析 TXT 时也保留 `.atp-resource-msg` live region，解析调度反馈不再丢失。`tools/verify.js` 补对应动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist 范围、缓存索引条目格式或主加载策略。
- 1.14.309：继续收口后台消息回调诊断边界。`fetcher.js` 的 TXT 后台抓取和文章后台 fallback、`content.js` 的跨域文章批量后台抓取都会先快照并消费 `chrome.runtime.lastError`，再判断请求是否已因本地 timeout 进入 stale 状态；迟到回调仍不写 late warning，避免 Chrome 报 unchecked `runtime.lastError`。`tools/verify.js` 补对应动态回归和静态守护。不调整 timeout、重试、缓存、权限、host 权限、TXT allowlist、缓存索引条目格式或主加载策略。
- 1.14.308：继续优化 popup 诊断日志阅读体验。`popup.js` 的日志重绘会在替换 HTML 前判断用户是否接近底部；首次加载或原本就在底部时仍自动跟随最新日志，用户正在中间或顶部阅读旧日志时，搜索、筛选或缓存日志重绘不再强制跳回底部。`tools/verify.js` 补对应动态回归和静态守护。不调整日志格式、过滤语义、导出字段、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。
- 1.14.307：继续收口跨域后台抓取诊断噪声。`content.js` 的跨域文章批量后台抓取在本地超时后，如果后台回调迟到，会先检查请求是否已完成；迟到回调不再读取 `chrome.runtime.lastError` 或写入“后台消息失败”warning，避免日志出现已经按 timeout 处理后又追加的噪声。`tools/verify.js` 补静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、主扫描策略或重试策略。
- 1.14.306：继续收口 popup 当前站点初始化失败反馈。`popup.js` 初始化“当前站点”时会检查 `chrome.tabs.query` 是否可用，并在回调中读取 `chrome.runtime.lastError`；当前标签页查询失败时，会清空当前站点、禁用“仅在此站点禁用”开关，并在状态区显示持久 warning，不再只隐式回退为 `--`。`tools/verify.js` 补 active tab 查询失败动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。
- 1.14.305：继续收口 TXT 手动解析失败反馈。`resource-panel.js` 的侧栏和内联“解析TXT”按钮统一走 guarded helper，`ATPRenderer` 缺失、调度同步抛错或返回未接受状态时会清除本地 loading、保留可重试状态并播报错误，不再误报“解析中”。`renderer.js` 的 TXT 调度返回明确 `true/false`，并对 TXT fetcher / 重新提取入口同步失败或非 Promise 返回统一失败收尾，避免按钮长期停在 `aria-disabled`。`tools/verify.js` 补这些动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。
- 1.14.304：继续收口两个可访问性/反馈边界。`floating-panel.js` 的页面浮动设置面板保持非模态 dialog 语义，不再拦截 `Tab` / `Shift+Tab`，让键盘焦点可以按浏览器默认顺序进入页面控件；`Escape` 关闭、方向键隔离、外部点击关闭和预览浮层快捷键保护不变。`popup.js` 保存需要刷新后生效的设置时会等待 `tabs.query/reload` 结果并检查 `chrome.runtime.lastError`，保存成功但当前页刷新失败时显示持久 warning，不会回滚已保存设置；恢复默认设置后的刷新失败 warning 也会保留。`tools/verify.js` 补对应动态回归和静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.303：修复 BFCache 禁用态恢复和滚动扫描漏候选两个关键链路边界。`content.js` 的 BFCache `pagehide/pageshow/resume` 路径新增 initialized / enabled guard，未初始化或当前页已禁用时不再恢复 active image loads、loader visibility、observer、scroll 监听或浮窗；滚动触发扫描改为压缩已消费前缀并保留未消费候选，继续复用 scanner cursor，避免已入队但尚未处理的帖子被跳过。`tools/verify.js` 补 BFCache 禁用/未初始化不恢复、滚动队列压缩后继续消费未处理候选的动态回归，并更新静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.302：继续收口 popup 日志失败反馈。`popup.js` 启动时刷新隐藏日志计数失败后，除了把 `logCount` 置为 `!`，还会把“读取日志计数失败”写入 `popupStatus` 持久 live region，并使用 `alert` / `assertive` 语义，避免用户只看到无原因的错误计数。`tools/verify.js` 补隐藏日志计数失败动态回归，确认计数、状态文本和 live region 语义同步进入错误状态。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.301：修复滚动触发扫描时的 scanner cursor 失效边界。`content.js` 新增只清当前候选队列的 `clearQueuedProcessCandidates()`，`handleScrollScan()` 不再清空 `processCandidateScanState`，避免未耗尽的链式 selector 扫描在深滚动期间反复从 selector 0 重新开始；结构性变化、mutation、隐藏页暂停、BFCache pagehide、重载和失败清理仍通过 `clearProcessCandidateQueue()` 全量清理 cursor。`tools/verify.js` 补滚动式队列清理复用 cursor、结构性清理重新分配 cursor 的动态回归，并更新静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.300：修复设置浮窗的非模态语义和外部关闭稳定性。`floating-panel.js` 打开浮窗时不再声明 `aria-modal="true"`，因为该浮窗没有遮罩或背景 inert，继续按非模态 dialog 暴露；外部关闭监听从冒泡 `click` 改为捕获阶段 `pointerdown`，并保留捕获阶段 `mousedown` 回退，避免宿主页面 `stopPropagation()` 阻断关闭。`tools/verify.js` 补打开非模态语义、捕获阶段外部关闭、内部路径不误关和鼠标回退的动态回归，并替换旧的 modal 静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.299：继续收口 popup 日志失败反馈。`popup.js` 在诊断日志读取失败时，除了把日志内容区写成错误并把计数置为 `!`，还会把同一错误写入 `popupStatus` 持久 live region，并使用 `alert` / `assertive` 语义，避免读屏用户错过日志读取失败原因。`tools/verify.js` 补日志索引读取失败动态回归，确认日志内容区、计数和状态 live region 同步进入错误状态。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.298：修复 BFCache 可见恢复和 `pageshow.persisted` 到达顺序的重复恢复边界。`content.js` 的 `handlePageShow()` 只消费 `pagehide.persisted` 或隐藏恢复留下的 `bfcacheRecoveryPending`，不再把已被可见 `visibilitychange` 消费的恢复状态重新置为 pending，避免同一次 BFCache 返回重复执行 active image recover、visibility sync、observer/scroll/panel 恢复和当前扫描。`tools/verify.js` 补 pagehide→pageshow、隐藏延迟恢复和 visibilitychange 先恢复后迟到 pageshow 不重复恢复的动态回归与静态守护。不调整权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.297：小幅优化 popup 日志导出摘要路径。`popup.js` 的 `buildLogSummaryStats()` 继续单次统计 type/host/level，但改用普通 `for` 循环扫描日志，不再用 `logs.forEach()` 分配回调；`tools/verify.js` 补对应静态守护。不调整日志格式、导出字段、过滤语义、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式或主加载策略。

- 1.14.296：继续收口发布验证输出语义。默认 verifier 在实际发布白名单仍有 unstaged 变更时，首行改为 `worktree verify ok`，不再输出裸 `verify ok`，避免只看退出码或 grep 成功文本的脚本误判为 staged/release 证据；`ATP_VERIFY_PACKAGE=1` 在 mixed dirty/staged 状态下会输出 `release package: checked against current worktree only`，明确归档只与当前工作区逐字节一致。新增输出标签行为守护，并替换过期的自引用 package 输出静态守护。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.295：继续收口发布验证证据边界。`tools/verify.js` 的 staged 发布门禁现在从当前 manifest 引用、popup 引用、公开文档、`HANDOFF.md` 和 `tools/verify.js` 动态生成实际发布文件集合；默认 `staged release files: not checked` 提示和 `ATP_VERIFY_STAGED=1` 硬门禁会覆盖运行时 JS/CSS/HTML、图标和发布文档，避免只校验版本锚点文件而漏掉未暂存的运行时代码。新增 staged release file set 行为守护，确认白名单包含 background、shared utils、loader、viewport、popup 和图标等发布文件。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.294：继续收口发布验证证据边界。`tools/verify.js` 默认验证在发现发布相关文件存在 unstaged 工作区变更时，会输出 `staged release files: not checked` 提示，明确普通 `verify ok` 只证明当前工作区通过，不代表当前 staged 快照也可提交或发布；`ATP_VERIFY_STAGED=1` 仍作为暂存区一致性的硬门禁。真实 Chrome/BFCache smoke 作为手工验收标准记录，自动 `--load-extension` 环境不可观测时记录为 `Chrome target unavailable`，不替代 verifier 硬门禁。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.293：继续收口后台文章抓取 deadline 竞态和内容侧 DOM 解析成本。`background.js` 复用 shared in-flight 前会检测旧 control 是否已经 abort；若 abort timer 已触发但旧 promise 还没 cleanup，会清理旧 entry 并重新发起有效 fetch，避免新请求复用旧 `deadline_exhausted`。`shared-utils.js` 对超过 `DOM_IMAGE_EXTRACT_HTML_MAX_CHARS` 的大 HTML 在进入 `DOMParser` 前改走 regex fallback，避免不可中断的 `parseFromString` / `querySelectorAll` 长任务；普通 DOM 路径仍保留 250ms soft collection guard。`tools/verify.js` 补这些动态回归和静态守护。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.292：继续收口后台文章抓取 deadline 和内容侧提取成本。`background.js` 的 shared in-flight 文章请求现在使用可扩展的 deadline abort control，短 deadline 调用者仍按自身等待窗口返回，后续更长 deadline 的重复请求会延长底层 fetch abort timer，避免底层请求无视内容侧 deadline 继续占用 service worker/network。`shared-utils.js` 的 DOM 图片提取路径补 250ms soft collection guard，限制大量节点遍历和候选处理在 content 主线程上的拖尾成本。`tools/verify.js` 补 mixed-deadline 动态回归和 DOM time-bounded guard 守护。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.291：继续收口列表加载时的读屏和键盘可用性。`renderer.js` 的每线程缩略图状态改为 `aria-live="off"` 的静态状态文本，不再为每个帖子创建会主动播报的 `role="status"` 区域，避免批量加载图片时产生大量进度播报。缩略图“展开/收起”按钮改用 `atp-thumbnail-expand` CSS 类，`content.css` 补最小触控尺寸和高对比 `focus-visible`；`floating-panel.css` 提升启动按钮焦点环对比度。`tools/verify.js` 补这些 UX 守护。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.290：继续加严 active image load stale token 的验证证据。`tools/verify.js` 现在对 direct 旧 `onerror` 和 manual retry 旧 `onload` 额外断言旧图片 handler 已清空，并对 viewport lazy load 旧 `onerror` 断言不会记录成功或 thread done 成功，补齐 v1.14.289 verifier 覆盖里的断言强度缺口。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.289：继续收口 active image load stale token 的验证覆盖。`tools/verify.js` 现在对 direct、manual retry 和 viewport lazy load 分别覆盖旧 `recover`、timer、`onload`、`onerror` 到达时的 registry 注销、旧 timer 清理、旧图片请求取消和新 slot 不被释放，补齐 v1.14.288 运行时修复的动态证据。运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.288：继续收口 active image load stale token 生命周期。`loader.js` 的 direct/manual retry 图片加载和 `viewport-observer.js` 的 viewport lazy load 在同一 task 被新 slot token 替换后，旧请求的 `recover`、timer、`onload`、`onerror` 会注销 active-load control、清理旧 timer 并取消旧图片请求，不再滞留 registry、释放新 slot、误结算成功/失败或绑定旧预览。`tools/verify.js` 补 direct、manual retry 和 viewport lazy load 的 stale token 动态回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.287：继续收口关键加载生命周期和网盘资源归一化。`viewport-observer.js` 的隐藏页/BFCache 暂停会清理 active 重图恢复请求自己的 restore timer，恢复时对仍有效的 active restore 按当前超时重新计时，避免旧超时在暂停后继续取消图片并改写 DOM。`shared-utils.js` 的网盘分类改为按候选 URL 的真实 host/path 判定，避免站内跳转外壳被误分类；pan URL 会统一 `www` host、尾随 `/`、hash 和非提码 query 参数顺序，减少等价链接重复显示/复制；URL query code 会先清理再覆盖 stale cached code。`tools/verify.js` 补这些动态回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.286：继续收口网盘访问码查询参数归一化。`shared-utils.js` 现在会先清理 URL query 提取出的 `pwd/password/code` 值，再写入资源 `code`；当旧缓存或外部合并资源同时带有 stale `code` 和 URL query code 时，URL query 会覆盖旧值，避免复制出带空格或错误访问码。`tools/verify.js` 补查询参数访问码 trim 和 stale cached code 覆盖回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.285：继续收口访问码查询参数优先级。`shared-utils.js` 的 `extractAccessCode()` 现在复用大小写不敏感的 URL 查询参数提码逻辑，`?PWD=`、`?Password=`、`?CODE=` 会优先于附近正文提取码，避免查询参数归一化后丢失正确访问码。`tools/verify.js` 补大写查询参数与附近冲突文本提取码同时存在时的回归断言。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.284：继续收口资源提取和 BFCache 生命周期一致性。`shared-utils.js` 的网盘访问码查询参数按大小写不敏感方式识别和剥离，`?PWD=`、`?Password=`、`?CODE=` 等变体也会合并到 `code`；anchor 局部提取码绑定改为用当前 anchor 在上下文窗口中的实际文本偏移，避免多个同名“网盘”链接把前一个提取码串到后一个链接。`cache.js` 在 content 侧 LRU rebuild 失败时会清理 pending baseline，避免 stale 高水位影响后续淘汰。`logger.js` 不再注册 `beforeunload`，改用 `pagehide` 和隐藏页 `visibilitychange` 尽力 flush，与 content 的 BFCache `pagehide/pageshow` 策略保持一致。`tools/verify.js` 补这些回归守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.283：继续收口 v1.14.282 后发现的资源合并边界。`shared-utils.js` 把网盘访问码查询参数归一化抽成共享路径，`extractResources()`、`normalizeResources()` 和 `mergeResources()` 都会用移除 `pwd/password/code` 后的 URL 去重，并把查询参数回填到 `code`，避免旧缓存、TXT 缓存或外部合并资源重新显示重复网盘链接。href 预扫描不再用整页正文上下文绑定提取码，多网盘 anchor 会交给局部 anchor 上下文提码，避免第一个提取码串到后续链接。`cache.js` 在 content 侧 LRU 因 cacheIndex rebuild 失败跳过淘汰时会写 warning；`tools/verify.js` 补这些动态和静态回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.282：继续收口资源提取和缓存索引维护失败边界。`shared-utils.js` 会把网盘访问码查询参数合并到 `code`，并用移除 `pwd/password/code` 后的 URL 去重，避免同一网盘链接的带码版和裸链重复显示；结构化 href/anchor 扫描改为只基于原始 HTML 的真实标签，避免转义展示的伪 `<a>` 被误提取。`cacheIndex.rebuild()` 索引写入失败时会失效旧 `atp_cache_index_v1`，避免 stale index 继续被信任；`cache.js` 和 `background.js` 在 storage 删除成功但 cacheIndex 删除失败时会尝试 rebuild，LRU/升级清理日志会区分索引未确认状态。`tools/verify.js` 补这些动态回归，并修复 verifier 主流程静默退出时的最终输出捕获。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.281：继续收口启动取消、浮窗设置失败和资源提取边界。`content.js` 在设置读取 Promise 尚未返回时遇到非 BFCache `pagehide` 会取消本次启动，防止离页后继续安装 listener、observer 或创建悬浮面板。`floating-panel.js` 设置读取失败后改为 fail-closed，禁用字段并阻止把默认值保存回 storage。`shared-utils.js` 提取资源时会在重复网盘 URL 上合并后续局部上下文提取码，修复长帖锚点先被整页 href 去重后复制缺少提取码的问题。`tools/verify.js` 补这些动态回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。

- 1.14.280：继续收口启动失败恢复和日志维护失败语义。`content.js` 在设置读取成功但页面启用流程失败时，会清理已安装的 storage listener、扫描 timer、observer 和日志 flush timer，并释放启动 guard，让后续 DOM/load fallback 可以重试，不会把 content script 卡在半初始化状态。`popup.js` 的旧 content 日志 shard prune 在 `storage.remove` 失败时改为 fail-open，保留原索引并继续读取现有日志，避免日志查看或导出被旧 shard 删除失败阻断。`logger.js` 删除 stale content 日志 shard 失败时会把 stale shard 继续保留在 `atp_logs_content_keys` 中，方便下一次 flush 重试清理，避免孤儿日志分片长期占用 storage。`tools/verify.js` 补这些动态回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、候选提取和主加载策略不变。

- 1.14.279：继续修复关键图片显示/恢复边界，并补齐 verifier 覆盖和公开同步说明。`loader.js` 的重图 fallback 现在用 replacement `displaySrc` 更新缩略图显示、日志和实际 `<img>` 加载，点击预览仍使用 `previewSrc` 原图语义；`content.js` 初始化读取设置失败后会释放启动 guard，让后续 DOM/load fallback 可重试，成功后仍只安装一次 storage listener；`viewport-observer.js` 的重图 restore 在 BFCache recover 遇到未完成但仍有效的请求时会重启 timer 继续等待，不再取消当前请求或重新排队。`tools/verify.js` 补 display/preview fallback、content init retry、heavy restore recover、popup `storage.remove` 失败和 background idle cleanup 动态回归。`HANDOFF.md` 的公开仓库同步白名单包含 `HANDOFF.md`，扩展上传包仍排除它和本地工具目录。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、候选提取和主加载策略不变。

- 1.14.278：继续修复关键图片加载恢复、popup 维护性能和发布门禁。`loader.js` 与 `viewport-observer.js` 的 direct/retry/viewport 图片加载在 fallback、BFCache recover 或重启 timer 时会重新计算当前 timeout，避免慢图 stop-loss、cooling 或 stale background 的短超时被旧 timer 覆盖；BFCache pageshow 遇到未完成但仍有有效 `src/currentSrc` 且 wrapper 仍在文档中的 active 图片时会继续等待，不再立即记失败或显示失败占位。`popup.js` 一键清空缓存/日志复用同一次 storage key discovery，缺失 cacheIndex 时不再重建索引，清空日志和一键清空不会写回即将删除的日志索引。`background.js` 的 cacheIndex remove 代理接受 legacy/base 前缀 cleanup key，但 update 仍只允许当前 cache 前缀。`tools/verify.js` 补这些动态回归，并让 release package/archive 强制包含 `CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md` 三份公开文档。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、候选提取和主加载策略不变。

- 1.14.277：继续收口 `cacheIndex` 单写者边界、popup 存储失败反馈和发布 staged gate。`shared-utils.js` 的非 background owner mutation 在无法通过 `CACHE_INDEX_MUTATION` 代理时会直接失败，不再退回本地 storage 写入；队列 callback 抛错不会卡住 `_writing`。`background.js` 只接受合法 cache key 与 `{ t, ts, b }` 条目的 `updateEntries/removeEntries`，并拒绝代理整表 `write`。`popup.js` 的日志 discovery/prune 写回 `atp_logs_content_keys` 失败时降级为 warning，不再阻断日志读取、导出或清理；清缓存/一键清空在真实 storage 删除成功但 cacheIndex 更新失败时使用持久 warning 状态。`tools/verify.js` 补无代理非 owner、callback throw 队列、payload 拒绝、日志索引写回失败、真实按钮 warning 路径和 `tools/verify.js` staged 一致性回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、候选提取和主加载策略不变。

- 1.14.276：收口 `cacheIndex` 跨运行时写入和 popup 存储失败反馈。`shared-utils.js` 的 cache index 写入现在默认由 background service worker 单写者处理，content script 和 popup 的 `write/updateEntries/removeEntries/rebuild` 通过 `CACHE_INDEX_MUTATION` 代理到 background 队列，缓存索引条目格式不变，降低跨上下文整份索引覆盖导致的新增项丢失或删除项复活风险。`popup.js` 的普通清缓存和一键清空缓存/日志会保留真实 storage 删除成功结果，cacheIndex 删除失败只作为索引状态提示并尝试 rebuild；一键清空会先清空已加载日志视图和计数，再处理索引状态。非 discovery 的日志索引读取失败会进入错误状态，不再静默显示偏小日志计数。`tools/verify.js` 补 background 代理、popup 部分失败清理和日志索引读失败回归。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式、候选提取和主加载策略不变。

- 1.14.275：继续修复 BFCache 可见恢复顺序、content 日志分片索引恢复和发布归档验证覆盖。`content.js` 在可见 BFCache 恢复时会先调用 `recoverActiveImageLoads()`，让 `loader.js` 重新计入 suspended active slot，再同步 visibility 并唤醒调度，避免恢复瞬间并发统计为 0 时提前放行新加载。`logger.js` 在写回 content 日志索引前通过 `chrome.storage.local.getKeys()` 合并真实存在的 sibling shard；`popup.js` 的日志 discovery 改为权威重建 content shard 索引，旧索引里不存在的 shard 不再参与读取，真实 content shard 为空时也会写回空索引。`tools/verify.js` 补这些动态回归，并新增 zip/crx 内存行为 fixture；`HANDOFF.md` 的最终 zip/crx 发布流程改为直接用 `ATP_RELEASE_ARCHIVE` 校验最终归档。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.274：继续收口 BFCache 恢复、storage 清理计数和发布归档校验。`content.js` 在 BFCache `pageshow.persisted` 时会先同步 loader 可见性暂停状态，隐藏页仍暂停时延后 active image recover 和当前扫描，等页面可见后再恢复；链式续扫和 rescan follow-up 改为共享可清理 timer，pagehide 会一并清掉。`loader.js` 在 BFCache recover 前会重新计入仍 current 的 suspended active slot 并重新计算重图 slot，避免旧请求继续加载时全局并发统计低估。`shared-utils.js` 的 `cacheIndex.removeEntries()` 读索引失败会返回失败，`popup.js` 普通缓存/失败缓存/全部缓存清理改为按实际存在 key 计数，失败缓存说明标明同时清 TXT 解析失败标记。`tools/verify.js` 支持最终 zip/crx 发布归档校验，拒绝归档路径逃逸、重复 entry 和大小写变体重复 entry，并允许公开同步目录缺少本地 `.gitignore` / `CLAUDE.md`。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.273：修复维护清理计数、content 恢复调度顺序和资源面板 TXT/a11y 边界。`popup.js` 的一键清空缓存和日志成功数量改为统计实际存在的 storage key，避免 stale 索引和固定候选 key 误报；`content.js` 在设置变更需要热重载时跳过前置 visibility sync，BFCache pagehide 会清理内容层扫描 timer/候选队列，pageshow 可扫描时先消费旧 `rescanRequested`；`resource-panel.js` 在桌面侧栏切到窄屏 inline 时恢复同语义按钮焦点，TXT 解析 loading 期间保留 `aria-disabled` 按钮，并把 inline 手动解析状态写入 live region。`tools/verify.js` 补对应动态回归和静态守护，`HANDOFF.md` 收窄公开同步白名单。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.272：优化 popup storage key discovery 热路径。`popup.js` 在日志分片发现和缓存键兜底发现时优先调用 `chrome.storage.local.getKeys()` 只读取 key 列表，避免展开/导出/清空日志或清缓存时反序列化全部缓存值；旧浏览器或 `getKeys()` 失败时仍回退到 `get(null)`。`tools/verify.js` 补 storage `getKeys()` sandbox 和动态回归，确认日志 key discovery、缓存 key discovery 不再直接全量读取 storage value。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.271：修复 popup 日志清空竞态和浮窗重叠保存应用边界，并补强 BFCache 动态回归。`popup.js` 在清空日志或一键清空缓存/日志后会作废正在进行的日志加载，防止旧 storage 读取回填已清空内容；content 日志分片发现只接受 `atp_logs_content_` 后跟数字时间戳的键，避免元数据键被误读误清。`floating-panel.js` 在连续保存不同设置时会对每个成功落盘 patch 调用 `business.onSettingsChange()`，只让过期保存跳过成功提示。`tools/verify.js` 补 popup in-flight 清空、浮窗 overlap save、BFCache pageshow 恢复顺序/快速扫描，以及同一 task suspend 后重新 acquire 的旧 token 释放回归。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.270：修复 BFCache pagehide active slot 处理，并收口 popup 日志缓存和窄屏 UX/a11y。`content.js` 在 `pagehide.persisted` 下改为调用 `ATPLoader.suspendActiveImageSlotsForBfcache('bfcache_pagehide')`，`loader.js` 只释放全局/重图 slot 计数并保留 active image recover 控制柄，旧 frozen slot 通过 `slotCounted=false` 避免 pageshow recover 后误扣新 slot；`popup.js` 展开日志后缓存已加载日志，筛选/搜索只做内存 rerender，初次加载中不重复读取 storage，导出日志后保留当前筛选计数；`resource-panel.js` 为窄屏 inline TXT 解析按钮补附件数量 aria-label；`floating-panel.css` 补窄面板输入宽度约束和复选行换行；`tools/verify.js` 补对应动态回归和静态守护。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.269：继续收口 retryable empty、发布包边界和小屏 UX/a11y。`content.js` 的 retryable empty 冷却和退避计数改用 normalized article key，同一文章 query/hash 变体不会绕过 `Retry-After` / 负缓存冷却重复抓取；`tools/verify.js` 的实际发布目录校验会规范化 manifest 和 popup 引用，拒绝 URL-like、绝对路径、通配符和 `..` 逃逸，并补 content retryable empty key、发布引用逃逸和 heavy restore completed recover 动态回归；`resource-panel.js` 的 inline 持久 TXT 状态改为非 live 文本，只保留用户触发反馈 live region；`floating-panel.css` 允许设置行标签换行，避免窄面板挤压输入控件。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.268：修复 retryable HTTP 文章空结果没有消费 `Retry-After` 的问题，并收口 popup 日志刷新播报。`shared-utils.js` 新增 `parseRetryAfterHeader()`，`fetcher.js` 和 `background.js` 在 HTTP 429/5xx/401/403 返回时会解析秒数或 HTTP date，并把绝对重试时间透传给 content 的 retryable empty 调度；popup 诊断日志内容区改为非 live region，日志刷新只通过原子化日志计数提示，避免批量刷新时读屏重复朗读。`tools/verify.js` 新增 Retry-After 动态回归和 popup 日志 a11y 静态守护。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.267：修复后台同 URL in-flight 文章抓取的 mixed-deadline 污染，并继续收紧发布包边界。`background.js` 的共享文章 fetch 不再继承首个调用者的短 deadline，底层 fetch 使用固定文章超时，每个调用者只通过 `waitForArticleDeadline()` 单独等待自己的 deadline；短预算请求超时不会让后续长预算请求也误报 `deadline_exhausted`。`tools/verify.js` 新增 mixed-deadline 动态回归，并从 manifest/popup 引用构建实际发布文件集合，拒绝未被引用但扩展名合法的根 JS/CSS/HTML 混入发布包。权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 1.14.266：补强 BFCache completed image recover 的动态验证。`tools/verify.js` 现在实际驱动 `ATPLoader.loadImageDirect()`、`ATPLoader.retryLoadImage()` 和 `ATPViewport.loadWrapper()` 注册 active recover handler，把测试图片标记为 `complete && naturalWidth` 后触发 recover，确认 direct/retry/viewport 都走成功结算、释放 active slot、保留预览激活，并且不记录失败或失败占位。本版不调整运行时代码、权限、host 权限、缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.265：修复 BFCache 恢复 active image loads 时把已完成图片误判为失败的问题。`loader.js` 的 direct/retry recover 和 `viewport-observer.js` 的 viewport recover 遇到 `complete && naturalWidth` 会先走既有 `img.onload()` 成功结算路径；重图 restore recover 遇到已完成图会先 `restoreReveal({ type: 'load' })`，避免取消已恢复图片并重新排队。`tools/verify.js` 新增对应静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.264：收紧发布包验证并补两个浮窗 help 边界。`tools/verify.js` 的 `ATP_VERIFY_PACKAGE=1` 现在必须配合 `ATP_RELEASE_DIR` 校验实际发布目录，不再用项目根工作树本地工具目录检查替代发布包边界；`ATP_VERIFY_STAGED=1` 复用固定文档版本锚点。`floating-panel.js` 在 docked help 打开时会把焦点从被覆盖主面板迁到 help 内，旁侧布局改为检查左右单侧实际空间，避免面板居中时 help 覆盖主面板。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.263：修复浮窗参数说明在窄屏/矮屏下覆盖主面板的问题。`floating-panel.js` 在 stacked help 上下都放不下时切换为主浮窗内部的 docked 视图，清掉 fixed 坐标并临时隐藏被覆盖主面板内容的辅助语义；退出 docked 或关闭说明后恢复主面板内容。`floating-panel.css` 补 docked 布局，`tools/verify.js` 新增矮屏 docked 动态回归和静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.262：补齐 popup 无效站点禁用的触屏和读屏反馈。当前页面没有可用 http/https host 时，“仅在此站点禁用”行内会显示持久说明“当前页面不支持站点禁用”，并通过 `aria-describedby` 关联 disabled checkbox；切回有效 host 后会清空提示并移除 stale 描述。`tools/verify.js` 新增动态回归和静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.261：收口后台文章抓取重复请求。`background.js` 为 `FETCH_IMAGES` 增加同 URL in-flight 复用，跨批次或连续请求命中同一文章时共享正在进行的 fetch；`content.js` 和 `fetcher.js` 会把本地等待窗口提前 500ms 作为 deadline 传给后台，后台用 deadline clamp 文章 fetch 超时，deadline 耗尽时停止调度后续 chunk 并返回 retryable 的 `deadline_exhausted`。`tools/verify.js` 新增并发同 URL 只触发一次 fetch、过期 deadline 不发起 fetch 的动态回归和静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.260：修复 BFCache 恢复后的 active image slot 残留。`content.js` 在 `pageshow.persisted` 中先调用 `ATPLoader.recoverActiveImageLoads('bfcache_pageshow')`，`loader.js` 的 direct/retry 图片加载和 `viewport-observer.js` 的 viewport lazy load/重图恢复会注册 recover handler，恢复后可继续 fallback、失败释放槽位或重新排队重图恢复，避免返回页面后 frozen/canceled 图片请求长期占用全局加载容量。`tools/verify.js` 新增 BFCache active image recover 动态回归、pageshow 顺序守护和 recover 注册静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.259：修复 popup 设置读取期间的 reset-all 边界。`popup.js` 在设置读取/失败态批量禁用设置控件时会同步禁用“恢复默认设置”，点击处理也会先通过 `ensureSettingsReady()` 兜底，避免设置尚未加载时访问空 settings 并落入通用操作失败路径。`tools/verify.js` 新增加载期禁用动态断言和 reset handler 静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.258：继续收紧实际发布目录边界。`tools/verify.js` 的 `ATP_RELEASE_DIR` 检查现在会比对发布目录内每个允许文件与当前工作树同路径文件的内容，避免发布目录混入旧版 JS/CSS/HTML/manifest/icon 但版本号已更新时仍通过；发布目录 Markdown 白名单改为显式允许 `CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`，拒绝 `AGENTS.md`、`CLAUDE.md`、`HANDOFF.md` 等内部维护文档进入实际发布包。默认验证、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.257：补齐 popup 站点禁用正向动态验证。`tools/verify.js` 在 popup VM 中模拟 background `SAVE_SETTINGS_PATCH`，实际触发有效 host 的“仅在此站点禁用”change，确认 `siteConfigs[host].disabled=true` 会写入 storage、回填当前 settings，并使用 polite status 语义提示保存成功。本次只增强验证覆盖，popup 运行时代码、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.256：补齐实际发布目录白名单校验。`tools/verify.js` 新增可选 `ATP_RELEASE_DIR` 检查，只有显式指定发布目录时才递归扫描该目录，拒绝 `.agents`、`.claude`、`.opencode`、`.codex`、`.git`、`node_modules`、`.env*`、密钥和数据库类文件，只允许扩展根目录的 `.js/.css/.html/.md/manifest.json` 与 `icons/` 资源；同时解析发布目录内 `manifest.json`，确认版本一致、content script 顺序未变、manifest 与 popup 引用文件存在。默认验证、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.255：补齐浮窗设置读取加载态。`floating-panel.js` 在面板创建后立即渲染“正在读取设置...”并设置 `aria-busy=true`，设置读取完成或失败后由 `_renderSettings()` 清除 busy，避免慢 storage 场景下打开浮窗看到空白设置区；`floating-panel.css` 增加加载态样式。`tools/verify.js` 新增浮窗设置加载态动态回归和静态守护。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.254：补齐浮窗触屏拖拽。`floating-panel.js` 的标题栏拖拽优先使用 Pointer Events，支持触屏拖拽、pointer capture/release 和 `pointercancel` 清理，不支持 Pointer Events 的环境继续走鼠标事件兜底；`floating-panel.css` 为标题栏增加 `touch-action: none`，避免页面滚动抢走拖拽手势。`tools/verify.js` 新增浮窗 pointer 拖拽动态回归和静态守护，覆盖移动、保存位置、帮助面板重定位和鼠标兜底保留。权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.253：补齐 popup 边界行为的动态验证。`tools/verify.js` 在 popup VM 中实际触发设置未加载时的 schema change、无有效 hostname 时的“仅在此站点禁用”change，以及帮助面板渲染，确认不会提前创建/修改 settings、会通过状态区报错、无效站点会回滚并保持禁用、帮助默认值不会展示 `默认normal` / `默认true` 这类内部值。`popup.js` 仅在 `window.__ATP_VERIFY_POPUP__` 下暴露对应测试 hook。运行时功能、权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取和主加载策略不变。
- 1.14.252：收口 popup 设置加载和发布验证边界。`popup.js` 在设置读取完成前禁用设置控件并播报“正在读取设置...”，设置未加载或读取失败时阻止保存；“仅在此站点禁用”只在当前标签页存在可用 http/https hostname 时启用，无效页面会回滚并提示不支持站点禁用；帮助面板默认值改为用户可读的 boolean/select/number 展示。`tools/verify.js` 将版本同步检查收紧到 changelog 首个标题、项目概览当前更新、使用说明版本行和交接当前版本行，并新增 `ATP_VERIFY_STAGED=1` 暂存区一致性检查与 `ATP_VERIFY_PACKAGE=1` 发布包本地工具目录检查。不调整权限、host 权限、缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.251：修复 TXT 多附件 partial-success 状态串扰。`fetcher.js` 新增 status-aware TXT 解析包装并保留旧纯资源 API，`background.js` 的 `FETCH_TEXT_RESOURCES` 响应在 `resources` 外额外返回 `attemptedCount/unresolvedCount/retryableCount`；`renderer.js` 会合并已成功解析的 TXT 资源，但只在 `unresolvedCount === 0` 时才把 TXT 解析标记为完成，避免一个附件成功、其他附件失败或超时时隐藏资源面板和窄屏 inline 的手动重试入口。`tools/verify.js` 新增 content/background/renderer partial-success 动态回归和静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.250：继续收口后台调度和 pending slot 恢复路径。`loader.js` 的后台队列处理把单轮 inspect 上限限制为 `maxPerRound * 3`，避免大量 deferred heavy task 在一个 tick 内整队轮转，降低滚动和可见图加载热路径上的调度尖峰。`viewport-observer.js` 的 pending slot 重试在普通加载前会按当前 geometry 刷新可见性，BFCache、隐藏页恢复或布局变化后离屏的候选会清理重试标记；hidden 强制加载和 lightweight preload 强制加载不受影响。`tools/verify.js` 补这些静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.249：修复 partial 文章写入合并到新鲜完整缓存时丢失 TXT 元数据的问题。`cache.js` 在保留完整图片候选和 `complete=true` 的同时，会继续合并新发现的 TXT 附件，并保留 marker-only 的 `hasTextAttachments/textAttachmentCount`，避免后续缓存命中后资源面板缺少 TXT 手动解析入口直到 TTL 过期。`tools/verify.js` 扩展动态回归覆盖真实 TXT 附件和仅 marker 两条 partial 合并路径。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.248：修复纯图片帖后台候选全部完成后的文章缓存完整性，并补两个加载/资源入口边界。`loader.js` 的整帖完成分支现在只要已有成功图片或资源 payload，就会用 `complete=true` 立即刷新对应文章缓存，避免延迟批量 flush 只写 incomplete `loadedUrls`，导致后续列表扫描无法命中正缓存并重复抓取文章 HTML。`resource-panel.js` 的密码-only 侧栏会保留待解析 TXT 状态和手动解析按钮；`content.js` 在隐藏页恢复可见时会先消费 `rescanRequested` 再执行恢复扫描，避免一次 visible 恢复追加重复扫描。`tools/verify.js` 补这些静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.247：继续减少后台 storage 热路径竞争，并补 UX/a11y 小目标与焦点边界。`background.js` 的跨域文章成功抓取不再按每篇写 `响应/HTML/提取` 三条 info，而是在每个 background chunk 写一条 `文章批量提取` 摘要；`FETCH_IMAGES` / `FETCH_TEXT_RESOURCES` 成功响应会先返回 content，再通过 `BGLOG.flushSoon()` 延迟合并日志刷盘。TXT 正缓存写入成功后改为短延迟合并 eviction 检查，quota 写失败后的 baseline 淘汰路径不再重复读取 bytes，后台索引写入改用 `cacheIndex.updateEntries()`。`content.css`、`floating-panel.css`、`popup.css` 补资源按钮、浮窗 header/help/reset/重图预设按钮和 popup 小按钮的 24px 最小目标尺寸；浮窗 header/help header 使用高对比 focus ring；`resource-panel.js` 在 inline 资源栏删除后会回退同帖缩略图或释放已删除节点焦点，inline TXT 解析按钮复用共享按钮样式。`tools/verify.js` 补这些动态和静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.246：修复文章负缓存命中后的无效短重试。`cache.js` 的 `getArticleCacheState()` 在负缓存命中时会返回 `negativeTs`、`negativeExpiresAt` 和 `negativeRemainingMs`，存储格式仍保持原有时间戳；`fetcher.js` 会把负缓存到期时间写入 retryable empty 的 `retryAfter`。`content.js` 的 retryable empty 队列保留 `reason` / `retryAfter` 元数据，跨域缓存预读、同源/后台 retryable 或 partial 空结果、后台 timeout 统一通过 helper 记录；负缓存命中会等 5 分钟 TTL 到期后再重扫，不再按 15-60 秒短退避反复扫描和读取 storage。`tools/verify.js` 补负缓存到期时间动态回归和静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、缓存索引格式、候选提取或主加载策略。
- 1.14.245：继续收口加载诊断开销、observer retry、重图恢复失败兜底和设置 UI/a11y 边界。`viewport-observer.js` 的重图预算批处理日志会复用同轮 heavy render snapshot，避免恢复/卸载密集时为诊断重复扫描 `heavyRenderItems` 和读取几何信息；重图恢复 `error` / `restore_timeout` 会在保留 preview fallback 后按每缩略图最多 3 次的退避重试调度预算 reconcile，避免可见占位长期停住。`content.js` 拆分 observer retry timer 清理和 retry count 重置，缺少帖子容器时保留 retry count，避免最大重试次数和退避失效。`shared-utils.js` 的 `cacheIndex.rebuild()` 会把索引写入失败作为重建失败返回 `null`。`popup.js`、`floating-panel.js` 在程序化回填、依赖禁用、整体禁用、reset 和回滚时统一清理数值输入错误 ARIA 状态；`floating-panel.js` 的方向键传播隔离移到 ShadowRoot 冒泡阶段，让原生 number/select 先处理方向键；`popup.html` 的帮助/日志 region 改用静态标题 label；`resource-panel.js` 清空侧栏前会清理 live-region timer。`tools/verify.js` 补这些静态和动态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、候选提取或主加载策略。
- 1.14.244：修复一处会阻断 content 初始化的高危 timer 回归，并继续收口缓存、TXT 抓取和 UI 状态边界。`content.js` 的 `clearObserverRetryTimer()` 恢复为清理 observer retry timer 和 retry count，避免隐藏暂停或 observer 重试路径自递归栈溢出。`cache.js` 成功写入文章正缓存后会清理同 URL 旧负缓存键和 cache index 条目。`fetcher.js`、`background.js` 的 TXT 附件入口按规范化 URL 兜底去重，避免旧缓存或手动入口传入重复附件时重复抓取。`floating-panel.js` 的 dirty input 保护改用 shadow active element，打开时重新 clamp 保存位置，避免外部刷新覆盖正在编辑的输入和窄屏重新打开出屏。`resource-panel.js` 的侧栏可见性判断不再提前创建空 sidebar，重渲染/移除资源 live region 前会清理消息 timer。`tools/verify.js` 补这些动态和静态守护，并补 viewport destroy shared retry cleanup 守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、候选提取或主加载策略。
- 1.14.243：继续减少首屏启动等待，并收口隐藏页扫描、viewport pending、TXT allowlist、cache index 和键盘焦点边界。`content.js` 首次启用页面时改用现有快速扫描入口，仍先同步 loader 可见性暂停状态，再用 `detectAndProcess(true)` 调度首批文章扫描，把初始化后的扫描等待从普通路径约 300ms 降到快速路径约 150ms；隐藏页暂停、pagehide、停用和 observer 重绑路径会同步清理 observer retry timer。`viewport-observer.js` 在 visible pending 多于单轮扫描窗口且仍有可用槽时会短延迟续扫，`loader.js` 槽位释放唤醒会先重试 visible pending 再处理 slot retry pending。`fetcher.js` 直连和最终重定向 TXT 附件 URL 统一复用 shared allowlist，`background.js` 升级清理后会 rebuild cache index 以移除 index-only 旧 key，`SharedUtils.cacheIndex.rebuild()` 支持无回调调用。`popup.js`、`floating-panel.js`、`previewer.js` 补收起面板/帮助面板/预览层的焦点和方向键传播边界。`tools/verify.js` 补这些静态和行为守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist 范围、候选提取或主加载策略。
- 1.14.242：继续收口短生命周期 timer 和首屏启动等待。`popup.js` 的按钮文案恢复 timer 改为按按钮隔离，新一轮按钮操作开始前会取消该按钮旧的恢复 timer，避免旧 timer 覆盖“清除中...”或“恢复中...”状态。`resource-panel.js` 的复制反馈 live region timer 改为按消息元素隔离，窄屏下快速复制不同帖子资源时，不同 inline 提示不再互相取消清理，避免“已复制/复制失败”残留。`content.js` 首次初始化不再固定等待 500ms，DOM 可用后立即调度初始化，并在已初始化后跳过 load 兜底重复空调度，减少首屏缩略图链路等待。`tools/verify.js` 补这些静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.241：继续收口隐藏页暂停、viewport pending 恢复、资源面板响应式焦点和预览快捷键边界。`content.js` 新增隐藏页扫描中断 helper，已经开始的 `processContainers()` 会在同源抓取、跨域缓存预读、background 抓取返回和渲染前重新检查 `pauseWhenHidden`，隐藏时清理待处理扫描队列并等待恢复可见后重扫；`reloadThumbnails()` 和 `enableCurrentPage()` 通过 visibility-aware helper 恢复 loader，隐藏页暂停仍生效时不会短暂或直接 `resume()`。`viewport-observer.js` 的 visible pending retry 在当前没有可用图片槽时，会按当前 geometry 标记可见 pending wrapper 为 slot retry，等真实槽位释放时由 release-driven wake 继续加载。`resource-panel.js` 在窄屏 inline 资源按钮持有焦点时切回宽屏，会把焦点迁到桌面资源侧栏同语义按钮，找不到时回退同帖资源 trigger。`previewer.js` 对预览弹层接管的 Escape、左右方向键和 Tab 停止事件传播。`tools/verify.js` 补这些静态守护，并新增 background `onInstalled` 旧 TXT cache key 清理、TXT allowlist 与 manifest host 权限一致性、content 同源 TXT 正缓存优先级回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.240：修复重图恢复请求缺少超时保护的生命周期边界，并收口 BFCache/visibility/public resume 恢复后的 viewport pending 唤醒。`viewport-observer.js` 在 `restoreHeavyImage()` 启动恢复加载时设置基于 `ATPLoader.getImageLoadTimeout()` 的 `data.restoreTimer`，如果恢复图片长期不触发 `load/error`，会通过 `restore_timeout` 走统一取消路径，注销 active-load、取消图片请求并恢复 unloaded preview 占位，避免 `restoreLoading` 和 active-load registry 长期挂住；`retryVisiblePending()` 会按当前 geometry 刷新可见状态。`loader.js` 的可见恢复和公开 `resume()` 路径会同时唤醒普通 visible pending 和 slot retry，避免恢复后可见占位延迟到滚动或 IntersectionObserver 回调才继续加载。`tools/verify.js` 补 heavy restore timeout、visibility 恢复唤醒和 pagehide teardown active-load 取消断言。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.239：修复隐藏页暂停后的 viewport 和扫描晚到回调漏网。`viewport-observer.js` 的 `loadWrapper()` 增加 loader paused 闸门，隐藏页暂停或公开 `ATPLoader.pause()` 后，IntersectionObserver / lightweight preload 回调不会再绕过 pause 状态占用图片槽并启动新请求；visible pending retry、slot retry 和 retry timer 回调也会尊重 `ATPLoader.isPaused()`。`loader.js` 暂停路径会清理 scroll-idle timer，避免旧滚动回调重新启动 viewport pending 加载。`content.js` 在隐藏页且 `pauseWhenHidden=true` 时不再启动新的扫描、retry scan、mutation scan 或 scroll scan，避免继续发起文章后台抓取；恢复可见后会重绑 observer 并按已有请求重扫。`tools/verify.js` 补 paused viewport load VM 回归和这些静态守护。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.238：修复文章缓存、临时空结果、TXT referrer 和设置保存边界。`cache.js` 在已有新鲜完整文章缓存时不再被后续 partial 写入降级，只合并 `loadedUrls` 和资源；`fetcher.js`、`background.js`、`content.js` 将负缓存命中、登录重定向、Cloudflare/blocked、HTTP 401/403/429/5xx 统一按可重试空结果处理，不写新的文章负缓存，并按归一化文章 URL 合并同批重复抓取；TXT 直连和 background 代理只在附件 URL 与来源页同源且同为 HTTPS 时设置 referrer。`floating-panel.js` 保留正在编辑的 dirty input，`popup.js` 在恢复默认设置保存失败时回滚本地状态，`settings-schema.js` 将 `thumbHeight` step 调整为 1。`tools/verify.js` 补这些缓存、重试、referrer、设置和 schema 回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.237：继续收口资源面板窄屏焦点和验证守护。`resource-panel.js` 在窄屏布局切换时如果隐藏 desktop sidebar/trigger 内仍有焦点，但同帖没有可聚焦 inline 资源操作，会主动释放隐藏桌面资源控件焦点；同步 resource trigger 时只有当前线程且 desktop sidebar 可见才设置 `aria-expanded=true`，避免隐藏 trigger 在窄屏声明桌面侧栏已展开。`tools/verify.js` 同步当前 `content.js` 的跨域缓存预读 retryable empty、article group key 注入和确定性空结果负缓存 helper 断言，并补资源面板隐藏焦点 release/visible sidebar expanded 回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.236：修复短屏大图预览布局裁切和资源面板宽窄屏切换焦点状态。`previewer.js` 的 modal 容器改为明确的 flex 高度约束，工具栏固定占位，图片 wrapper 使用 `flex:1`、`min-height:0` 和 `overflow:hidden` 在剩余空间内收缩，图片自身改为相对 wrapper `max-height:100%`，避免原来的 `80vh` 图片高度忽略工具栏导致短屏溢出。`resource-panel.js` 监听 `matchMedia('(max-width: 1024px)')` 和 resize，进入窄屏时同步收起桌面 sidebar 的 `aria-expanded`，并把隐藏 sidebar/trigger 内的焦点迁到同帖 inline 资源操作；窄屏 inline 不存在时不再回退聚焦隐藏 trigger。`tools/verify.js` 补这些布局、焦点和 ARIA 回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.235：修复 BFCache/pagehide 生命周期和正在恢复的重图请求取消链路。`viewport-observer.js` 的重图恢复请求会注册到 loader active-load registry，完成/失败后注销，取消时复位 `restoreLoading` 并恢复 unloaded preview 状态；`content.js` 移除破坏性的 `beforeunload` teardown，改由 `pagehide` 区分 persisted 与真实离页，`pageshow.persisted` 会恢复 visibility listener、pause state、observer、滚动监听、浮窗和一次当前重扫；`loader.js` 的公开 `pause()` 同步清 viewport pending retry/wake timer。`tools/verify.js` 补 restore active-load、BFCache 生命周期、禁止 destructive beforeunload 和 public pause 清理回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.234：修复浮窗和预览关闭后的隐藏焦点残留，并补齐 viewport destroy 清理守护。`floating-panel.js` 外部点击关闭时仍不恢复 launcher 焦点，但会释放停留在隐藏 panel/help 内的活动焦点；`previewer.js` 在 opener、打开前焦点和同帖 fallback 都不可用时释放隐藏 overlay 内焦点，避免焦点留在 `display:none` close button 上；`viewport-observer.js` 的 destroy 循环显式清理 heavy restore reveal listener 后再取消恢复加载。`tools/verify.js` 补这些焦点和清理路径回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.233：修复隐藏页暂停未覆盖重图恢复队列的问题。`loader.js` 在隐藏页暂停和公开 `pause()` 路径同步调用 `ATPViewport.pauseHeavyRestores()`，清理重图恢复/预算定时器但保留队列；可见恢复、公开 `resume()` 和 `pauseWhenHidden=false` 隐藏加载路径会显式 `resumeHeavyRestores()`。`viewport-observer.js` 为 heavy restore 和 budget reconcile 调度补 loader paused guard，暂停期间不消费恢复队列，也不创建新的恢复/预算定时器。`tools/verify.js` 补 hidden/public pause、visible/resume 唤醒和 paused guard 静态回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.232：修复 partial 空结果和空 TXT 正缓存导致的当前页/手动重试卡住问题。`content.js` 会把同源和 background 返回的 partial 空文章结果纳入 retryable empty 退避队列，不再把当前页面容器标记为 `atp-processed`；`cache.js` / `background.js` 的 TXT 正缓存读取会先确认归一化后存在真实 payload，空 `TEXT_RESOURCE` 缓存会被当作 miss 并清理，避免遮蔽真实抓取或手动重试。`tools/verify.js` 补 partial 空结果 processed 前退避、content/background 空 TXT 正缓存过滤和 background 手动重试真实 fetch 回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.231：修复资源面板重渲染导致键盘焦点丢失的问题。`resource-panel.js` 在桌面侧栏和 inline 资源栏 DOM 替换前记录当前聚焦按钮的动作语义，重绘后恢复到同语义按钮；如果 inline 动作已消失，则回退到可用 inline/trigger 动作。`tools/verify.js` 补资源动作焦点捕获、侧栏 `innerHTML` 替换后恢复焦点、inline `old.remove()` 后恢复或回退焦点的静态回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.230：修复 content 侧跨域 TXT 资源缓存优先级。`fetcher.js` 在跨域 TXT 附件发 background 前会先读取正向 `TEXT_RESOURCE` 缓存，命中有效资源时直接合并结果并清理陈旧 `TEXT_FAIL`，不再让旧失败缓存遮蔽可用 TXT 资源；同源 TXT 正缓存命中也会清理旧失败缓存，与 background 语义保持一致。`tools/verify.js` 补 content 侧正缓存优先行为回归和跨域预检静态断言。不调整权限、host 权限、缓存 TTL、负缓存 TTL、TXT allowlist、候选提取或主加载策略。
- 1.14.229：修复关闭资源栏设置后仍可能留下桌面资源 trigger 的 UX 问题。`resource-panel.js` 新增 `syncResourceTrigger()`，在线程 attach/update 时按 `showResourcePanel` 状态创建或移除真实资源触发按钮，禁用资源栏时会移除旧 trigger 并让 inline 渲染继续清理自身，避免出现可见、可聚焦但点击后无内容的控件。`tools/verify.js` 补 trigger 启用/禁用同步和 attach/update 入口回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、缓存索引格式、候选提取或主加载策略。
- 1.14.228：继续收口资源面板 UX/a11y 边界。`resource-panel.js` 现在在每个线程工具栏中维护真实 resource trigger button，`aria-controls/aria-expanded` 迁移到按钮，线程 panel 不再拥有 `tabindex` 或 Enter/Space 触发语义；`content.css` 给按钮补 hover / `focus-visible` 样式，并在 `max-width: 1024px` 下隐藏桌面 trigger，窄屏继续使用 inline 资源操作；`previewer.js` 关闭预览的同帖 fallback 会优先恢复到真实资源 trigger，再回退线程 panel。`tools/verify.js` 补真实 trigger、旧 panel 键盘语义负断言、窄屏 CSS 和预览焦点 fallback 回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、缓存索引格式、候选提取或主加载策略。
- 1.14.227：修复 reload/disable/unload 后旧图片请求占槽状态滞留的问题。`loader.js` 为每次图片占槽增加 per-load token 和 active slot registry，active reset/teardown 会同步清理 task active 标记、普通/重图 active 计数和旧图片 load canceler；direct、manual retry 和 viewport 懒加载完成/失败路径都使用捕获的 slot token 释放，旧 onload/onerror/timeout 回调不能再误扣同一个 task 后续重新占用的新槽。`content.js` 在缩略图 DOM 清理和 `beforeunload` 时调用 `ATPLoader.teardownActiveSlots()`，让热重载、停用和卸载立即释放 loader active 槽状态。`tools/verify.js` 补同一 task teardown 后重新占槽、旧 token 释放不扣新 active/heavy 计数、active image canceler 和 viewport token 释放回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、缓存索引格式、候选提取或主加载策略。
- 1.14.226：继续收口缓存索引、TXT 资源缓存和键盘 UX 边界。`popup.js` 现在通过 `removeCacheIndexEntries()` 把 `SharedUtils.cacheIndex.removeEntries()` 包装成 Promise，缓存清理和“一键清空缓存和日志”都会等待索引删除回调完成后再返回成功；如果索引写入失败，会先尝试 `cacheIndex.rebuild()`，再把失败显式传回按钮操作。`background.js` 的 TXT 读取改为正向 `TEXT_RESOURCE` 缓存优先于 `TEXT_FAIL`，命中正向缓存时清掉旧失败缓存，升级清理也覆盖旧 `atp_text_fail_*` 前缀。`shared-utils.js` / `cache.js` 将 TXT 附件提取和旧缓存归一化对齐到实际抓取 allowlist，只保留 HTTPS 站点附件、`xia.ewrewej.la` 签名下载和 `dl.ldkms.la/*.txt`。`floating-panel.js` 在焦点逃出设置 dialog 时仍可 Escape 关闭；`resource-panel.js` 的 inline 资源栏改为 per-panel 渲染签名和 click 委托，窄屏键盘打开聚焦 inline 操作而不是隐藏 sidebar。`tools/verify.js` 补这些缓存、TXT、浮窗和资源面板回归。不调整权限、host 权限、缓存 TTL、缓存索引格式或主加载策略。
- 1.14.225：收紧设置保存安全边界并补齐滚动内容可访问性。`floating-panel.js` 的设置控件改为容器级事件委托，重绘设置视图后不再为每个输入和按钮重复绑定监听器，并拒绝非用户触发的合成 `change/click` 事件，避免页面脚本通过 open shadow root 合成事件写入扩展设置。`defaults.js` / `background.js` 对 settings 归一化和 `SAVE_SETTINGS_PATCH` 写入做白名单过滤，只保留 `enabled`、schema 字段和合法 `siteConfigs[host].disabled`。`popup.html` / `floating-panel.js` 让帮助说明和诊断日志等滚动内容可键盘聚焦，`popup.css` / `floating-panel.css` 补可见焦点样式并遵守 `prefers-reduced-motion: reduce`。`tools/verify.js` 补设置委托、合成事件拒绝、settings 白名单、滚动区可聚焦、popup/浮窗 reduced-motion 和当前预览 opener-first 焦点契约回归。不调整权限、host 权限、缓存 TTL、负缓存 TTL、候选提取、缓存索引格式或主加载策略。
- 1.14.224：修复大图预览关闭后的焦点恢复分流。`loader.js` / `viewport-observer.js` 现在只有鼠标点击缩略图或重图 wrapper 打开预览时才传递 opener-first 标志；`previewer.js` 关闭预览时，鼠标入口优先恢复到本次 opener，opener 已移除或隐藏时回落到同帖同序号缩略图或线程面板，键盘 Enter/Space 入口则优先恢复打开前焦点，避免键盘用户被带到鼠标兜底位置。焦点目标会排除 inline/computed hidden 与 `display:none`，并且只有 `document.activeElement` 实际切换后才视为恢复成功。`floating-panel.js` 的 focus trap 跳过隐藏帮助控件，帮助面板窄屏堆叠后重新测量再定位；`content.css` 和 `resource-panel.js` 补资源触发面板的键盘可见焦点与空态文案。`tools/verify.js` 补这些焦点、隐藏目标和堆叠定位回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选提取、缓存索引格式或主加载策略。
- 1.14.223：继续补齐 UX/a11y 边界。`resource-panel.js` 的桌面资源侧栏现在有稳定 `id` 和 `role="region"`，缩略图资源触发面板维护 `aria-controls/aria-expanded`，键盘用户可按 Enter/Space 打开侧栏并直接聚焦第一个侧栏按钮，按 Escape 关闭未固定侧栏；`content.css` 补侧栏复制、固定、TXT 解析按钮的 `focus-visible` 样式。`floating-panel.js` 的参数说明面板补 labelled region，并在横向空间不足时切换上下堆叠定位；`popup.html` 的使用说明/诊断日志面板补 labelled region，`popup.css` 补窄容器宽度兜底。`tools/verify.js` 补这些语义、键盘路径和小屏布局静态回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选提取、缓存索引格式或主加载链路。
- 1.14.222：继续收口 viewport pending slot 的 no-slot 唤醒路径。`loader.js` 在图片 slot 实际释放后通过 coalesced 0ms timer 唤醒 `ATPViewport.retryPendingSlotLoads()`，连续多张图完成只触发一次 pending-slot 扫描，并在隐藏暂停和公开 `pause()` 路径取消尚未触发的唤醒。`viewport-observer.js` 移除 slot 全满时的固定 250ms 轮询，`retryPendingSlotLoads()` 在无容量时直接等待释放事件；只有仍有容量且仍有 pending slot retry 时才保留短延迟继续扫描。`tools/verify.js` 补 release wake 行为回归和禁止恢复 no-slot 250ms 轮询的静态规则。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选提取、缓存索引格式、渲染预算或资源面板行为。
- 1.14.221：继续收紧 background/pending wake 的状态驱动边界。`loader.js` 在后台队列非空但普通/重图通道暂无容量时改走 `background_capacity_wait` 退避重试，不再按 `backgroundSpeed` 创建普通后台 timer；`processBgTasks()` 收尾和无 `requestIdleCallback` fallback 重排前也会复用后台队列快照确认容量。公开 `pause()` 现在同步清理后台 timer，保证暂停状态不保留 background wake/retry timer。`viewport-observer.js` 新增 `releaseViewportSlot()`，图片成功或失败释放活跃槽位后会通过 coalesced wake 显式唤醒后台队列，减少依赖 `threadImageDone()` / `handleFail()` 的跨函数间接调度。`tools/verify.js` 补 background capacity retry、`pause()` 清 timer、pending 删除唯一 helper、viewport release wake helper 和 retry delay 必须来自退避计算的静态回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选提取、缓存索引格式、渲染预算或资源面板行为。
- 1.14.220：继续减少缓存索引维护的 storage 往返。`shared-utils.js` 的 `cacheIndex` 写队列改为结构化队列项，连续相邻的 `updateEntry()` / `updateEntries()` 会在同一轮 drain 中合并为一次读取和一次写回，降低多批缓存写入连续完成时对整份 `atp_cache_index_v1` 的重复 JSON 处理；重复 key 以后入队值为准。`removeEntries()`、`write()` 和 `rebuild()` 仍作为屏障，不跨删除、整表覆盖或重建合并更新。`tools/verify.js` 补连续 update 队列合并、callback、重复 key、barrier 和静态规则回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、缓存索引条目格式或主加载链路。
- 1.14.219：减少 viewport pending 满载时的后台队列空转。`loader.js` 将 `viewport_pending_full` 下的后台兜底 retry 从固定 500ms 轮询改为 500ms 起步、最高 4000ms 的指数退避；pending 容量恢复进入正常调度、清空后台任务或隐藏页暂停时会重置退避状态。`viewport-observer.js` 将 detached、stale task、domain skip 和真正转入加载的 pending wrapper 删除统一收口到 `removePendingWrapper()`，释放 pending 容量后通过 coalesced wake 唤醒后台队列，减少后台队列对兜底 retry 的依赖。`tools/verify.js` 补 pending-full retry 退避、禁止固定 500ms 轮询、退避重置和 pending 删除统一 wake helper 的静态回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选提取、渲染预算或资源面板行为。
- 1.14.218：继续优化资源面板桌面侧栏的渲染热路径。`resource-panel.js` 将侧栏复制分类、复制全部、复制密码、TXT 手动解析和固定切换统一收口到一次性 `handleSidebarClick()` 事件委托，避免每次侧栏 `innerHTML` 重绘后重新查询并绑定按钮；新增侧栏渲染签名，覆盖线程、固定状态、TXT 状态、密码、附件加载/完成/重试状态、资源分组以及每条资源的 `url/code/source`，状态未变化时跳过重复 DOM 替换。`tools/verify.js` 补侧栏委托点击、禁止恢复逐按钮绑定、渲染签名必须包含密码和资源条目内容的静态回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL 或主加载链路。
- 1.14.217：优化重图候选提取热路径。`shared-utils.js` 的 `extractImagesForSettings()` 改为单次解析文章 HTML，通过 `createImageCollectionGuard()` 的 soft fallback limit 先收集到普通隐藏候选池，再在同一次 DOM/regex 提取过程中用前 `displayLimit` 个候选判断是否需要扩展到 `fetchLimit`；普通帖子仍停在 `effectiveFallbackLimit()`，重图命中后仍扩展到完整 fetch pool，避免重图前缀命中后为了扩展候选池再次 `DOMParser` 同一篇文章。`tools/verify.js` 将重图提取回归改为 `heavyParseCount === 1` 且仍返回完整 fetch pool，并补 soft-limit guard、禁止二次 fetchLimit 解析和 regex/DOM 共享扩展策略静态断言。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL、候选顺序、去重或主加载链路。
- 1.14.216：收口资源面板、预览器和悬浮设置面板的读屏/键盘语义。`resource-panel.js` 将固定状态迁移到独立 pin toggle button，移动端 inline 资源栏和桌面资源侧栏都提供真实按钮，只在按钮上维护 `aria-pressed`，不再把包含多个按钮的缩略图容器声明为 `role="button"`；资源侧栏拆分 hover/focus 状态，并在延迟清理时检查侧栏当前焦点，避免键盘焦点仍在侧栏按钮内时被鼠标离开事件清空。`previewer.js` 关闭大图预览时会根据 opener/thread/preview index 元数据恢复焦点，原缩略图已移除或隐藏时回落到同帖可见缩略图或线程资源面板；`loader.js` / `viewport-observer.js` 会传入该 opener 元数据。`floating-panel.js` 将参数说明面板挂入主设置 dialog 子树，并避免 focus trap 重复收集说明控件，让 `aria-modal` 的 DOM 范围和实际焦点范围一致。`tools/verify.js` 补独立 pin toggle、禁止容器 button 语义、侧栏 focus 独立保活、preview opener fallback、滚动/mutation 清 scanState 和 help panel modal 子树回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL 或主加载链路。
- 1.14.215：修复悬浮设置面板保存中字段被外部 storage 刷新临时覆盖的问题，并补齐资源面板/浮动面板的键盘与读屏语义。`floating-panel.js` 会按字段记录 pending save attempt，`setSettings()` 遇到 pending 字段且 incoming 值不是本次保存值时跳过该字段的 `settings` 和控件重绘，非 pending 字段仍正常同步；pending 只在保存成功或失败回滚路径按 `seq/value` 匹配清理，避免 A->B->A 这类同值旧事件误清新的同字段尝试。`resource-panel.js` 的资源侧栏支持键盘 focus 保活，thread panel 焦点移入侧栏时不再触发延迟清空，资源触发面板同步 `role="button"` 和 `aria-pressed`。`floating-panel.js` 在面板打开并启用 Tab focus trap 时同步 `aria-modal="true"`，关闭后恢复 `false`。`tools/verify.js` 补 pending 字段保护、非 pending 字段刷新、同值外部刷新不清 pending、旧 attempt 不清新 pending、当前 rollback 清 pending、资源侧栏 focus 保活、资源面板 pressed state 和 floating panel modal 语义回归。不调整权限、host 权限、设置项 schema、缓存 TTL、负缓存 TTL 或主加载链路。
- 1.14.214：修复 TXT 手动重试被失败缓存挡住的问题，并补齐 cacheIndex 缺失索引时的单次写回路径。`resource-panel.js` 的侧栏空态、侧栏已有资源态和 inline 资源条三个手动解析入口会传递 `manualRetry`；`renderer.js` 将该状态交给 `fetcher.js`，content 侧同源抓取和跨域 background 预检都会在手动重试时跳过 `TEXT_FAIL`，background 消息也会继续透传该状态。TXT 附件 HTTP 429 不再写失败缓存，background 侧非 401/403 异常也不再写 `TEXT_FAIL`，只保留 401/403 这类明确站点拒绝作为短期失败缓存。`shared-utils.js` 的 `cacheIndex.updateEntries()` 在索引缺失时会扫描旧缓存、合并新 updates 后一次写回，不再先 rebuild 写一次、再合并写第二次。`tools/verify.js` 补手动重试透传、失败缓存绕过、429 不写缓存、cacheIndex 缺失索引单次写回和 removeEntries 多 key/失败/缺失语义回归。不调整权限、host 权限、设置项、缓存 TTL、负缓存 TTL、TXT 资源缓存命中语义或缓存淘汰策略。
- 1.14.213：减少缓存写入后的 cacheIndex 索引维护成本。`shared-utils.js` 新增 `cacheIndex.updateEntries()` 批量索引更新路径，`cache.js` 的同一批缓存写入会合并 index entry 后一次读/写 `atp_cache_index_v1`，避免图片缓存 flush 或文章批量写入时每个 key 都串行读取并写回整份索引。`cacheIndex.updateEntry()` 保留原 API 并委托到批量路径，storage 读取失败、rebuild 失败和写入失败的回调语义不变。`tools/verify.js` 补批量 index 更新一读一写、合并条目持久化、旧失败语义和缓存写入调用批量路径回归。不调整权限、host 权限、设置项、缓存 TTL、负缓存 TTL 或淘汰策略。
- 1.14.212：减少文章图片候选提取的普通帖重复解析，修复扫描根被宽泛容器或空列表壳抢占的漏扫风险，并收紧预览 modal 焦点边界。`shared-utils.js` 的 `extractImagesForSettings()` 会先直接提取到 bounded fallback pool，普通帖子不再为了从 display pool 扩到 fallback pool 而重复解析同一 HTML；只有前缀候选已确认是重图集合时才继续扩展到 full fetch pool。`scanner.js` 的 `findThreadContainer()` 改为按 populated primary、高置信、宽泛 fallback、empty shell fallback 分层选择，宽泛 `.bm_c` / `[id*="forum"]` / `[id*="thread"]` 必须先确认包含有效 thread 链接，避免提示块、广告容器或空 `#threadlist` 抢占扫描根。`previewer.js` 在首尾导航按钮禁用/隐藏后会把焦点拉回仍可用的预览控件，Tab trap 也会兜底拉回逃出 modal 的焦点。`tools/verify.js` 补普通帖单次 DOMParser、fallback pool 上限、重图 full fetch 扩展、prefix 重图判定、scanner root 分层选择、无有效链接 decoy 容器跳过、populated broad 优先于 empty shell 和预览焦点修复回归。不调整权限、host 权限、设置项、缓存 TTL、负缓存 TTL 或渲染策略。
- 1.14.211：继续收紧 viewport pending slot retry、隐藏页后台加载调度和容器替换后的 stale DOM 边界。`viewport-observer.js` 为 slot retry 增加 O(1) 计数和统一标记 helper，`hasPendingSlotRetry()` 不再整表扫描 `pendingWrappers`；hidden pending drain 增加轮转游标，隐藏标签页允许继续加载时会从上次位置推进，减少头部 blocked pending 反复消耗 attempt window；`loader.js` 进入隐藏页暂停时会同时清理 viewport pending slot retry timer 和 background wake timer，且异步图片任务会拒绝 detached `panel` / `container`；`content.js` 在列表容器替换时提升 generation 后重绑 observer 并立即补扫；`renderer.js`、`resource-panel.js` 会跳过 detached thread 更新并清掉旧资源面板引用；`floating-panel.js` 的旧 settings 保存失败不再伪装成功，只抑制 stale 错误提示；`tools/verify.js` 补 slot retry、hidden drain、detached thread 和 stale save failure 回归。不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.210：收口跨上下文 settings patch 写入、异步注入 stale DOM、跨域缓存复用和一批键盘/读屏体验边界。`background.js` 新增 `SAVE_SETTINGS_PATCH` 单队列写入入口，patch 会与当前 storage 合并后归一化，`siteConfigs` 按 host 深合并；`popup.js` / `floating-panel.js` 只提交 changed-field patch，悬浮面板单项修改、单项重置和重图原始预设不再写回完整 schema 快照；`content.js` 在异步抓取返回后确认容器、链接和 href 仍然匹配，并在列表容器替换后重绑 observer 且立即补扫，跨域文章交给 background 前会预读文章缓存/负缓存，只发送 cache miss；`previewer.js` 预览层级高于悬浮面板，`renderer.js` 的展开按钮和缩略图状态补按钮类型、展开语义和 live region，`loader.js` / `viewport-observer.js` 的预览入口名称包含图片序号；`floating-panel.js` 打开后约束 Tab 焦点且 Escape 不抢占已打开预览层；`resource-panel.js` 复制 fallback 后恢复焦点；`popup.html` / `popup.js` 明确“一键清空缓存和日志”并把通用操作失败写入状态区；`tools/verify.js` 补相关行为和静态回归。不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.209：修复悬浮面板 partial 设置保存覆盖完整 settings 的数据完整性问题，并继续收紧扫描、资源面板可访问性和 background 消息边界。`floating-panel.js` 只保存 schema 字段 patch，写入 storage 时再与当前完整设置合并并归一化，避免覆盖总开关和 `siteConfigs`；`popup.js` 对 settings 读取失败 fail-closed，popup/悬浮面板的非法数值会设置 `aria-invalid` 并播报有效范围；`resource-panel.js` 支持键盘 focus 显示资源、Enter/Space 固定资源面板，复制按钮和提示区补读屏语义；`background.js` TXT 代理只在同源 HTTPS 时设置 referrer，并为非对象消息、缺失 sender 和未知消息补安全响应；`scanner.js` / `content.js` 通过可复用 scan state 和 sentinel 扫描减少长列表重复 selector 查询，候选先经过 accept 再读服务帖文本，异步抓取完成后会重新过滤仍连接在 DOM 上的容器；`loader.js` / `viewport-observer.js` 在隐藏页暂停时避免空后台 wake timer，并清理 hidden force load 标记；`tools/verify.js` 补 VM 行为回归和静态规则。不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.208：修复 popup/悬浮面板自动保存 payload 与写入顺序边界，并补齐本轮复核发现的可访问性和重图调度热路径问题。`popup.js` / `floating-panel.js` 保存前会克隆稳定 settings snapshot，并通过串行写入队列提交 storage，避免异步保存读取可变 live settings 或旧写入晚完成时覆盖新设置；popup 错误状态切换为 `alert` / `aria-live="assertive"`，日志筛选/搜索、单项重置按钮和悬浮面板 select/number 控件补可靠可访问名称与 `label for` 关联；`popup.css` / `floating-panel.css` 补输入、选择框和按钮的 `focus-visible` 焦点样式；`viewport-observer.js` 在 balanced 清晰度恢复时复用一次 budget snapshot，只 queue 可见或预算选中重图，restore queue 消费阶段不再重复预算判定，defer 路径复用 cached viewport state；`loader.js` 的 round-robin 背景容量检查复用已有 background channel snapshot，并传给后台队列处理；`tools/verify.js` 补相关静态回归。不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.208 追加：`content.js` 的链式扫描会缓存一批候选并按 5 条小批量消费，避免每批完成都重新从 selector 起点扫描；`viewport-observer.js` 的 pending retry 默认隐藏页暂停，轻量预热范围内的 slot retry 不会被普通 viewport 离开事件清掉，并通过轮转游标降低后段 pending 饥饿风险；`loader.js` 在页面回到可见时主动唤醒一次 viewport pending retry。`tools/verify.js` 补这些边界的静态回归。
- 1.14.207：修复 popup/悬浮面板自动保存反馈竞态，补齐失败缩略图、popup disclosure、日志读取和悬浮帮助面板的键盘/读屏状态，并继续减少 MutationObserver、viewport pending、重图恢复和调度诊断重复扫描。`floating-panel.js` 会在显示新消息前清理旧自动隐藏 timer，错误不再被旧成功提示清掉，消息区域补 `role` / `aria-live` / `aria-atomic`，帮助按钮同步 `aria-expanded` / `aria-controls` / `aria-hidden` 并在关闭帮助后恢复焦点；`popup.js` / `floating-panel.js` 用按字段的保存尝试序号和值校验保护失败回滚，旧失败不会覆盖用户后续新选择，popup 回滚会同步首屏计数和依赖控件；`popup.html` / `popup.js` / `popup.css` 补总开关可访问名称、帮助/日志展开状态、日志读取中 `aria-busy` 和总开关键盘焦点样式；`loader.js` 的失败缩略图占位支持 Enter/Space 重试；`viewport-observer.js` 将 pending 抢槽重试合并为共享 timer，hidden/visible pending retry 按可用槽和尝试窗口提前停止，pending 转入加载后会唤醒后台队列；`viewport-observer.js` 让预算协调队列恢复复用已有 budget snapshot，并在同批 projected MP 触到 hard 阈值后停止继续恢复；`content.js` 跳过 ATP 自有子树内新增节点；`loader.js` 调度诊断复用 heavy stats 的 `heavyUnloaded`；`tools/verify.js` 补相关静态回归。不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.206：改进 popup 设置保存反馈，并修复悬浮设置面板外部点击关闭时抢回焦点的问题，不调整权限、host 权限、设置项、缓存 TTL、负缓存 TTL 或主加载链路。`popup.html` 新增 `#popupStatus` 状态区域并用 `role="status"` / `aria-live="polite"` 公布状态；`popup.js` 集中通过 `setPopupStatus()` 显示保存中、已保存、刷新后生效、读取失败和保存失败，失败提示保持可见，重叠保存用 `saveStatusSeq` 避免旧结果覆盖新状态；`popup.css` 补 info/success/error 状态样式；`floating-panel.js` 将外部点击关闭改为不恢复 launcher 焦点，Escape 和面板关闭按钮仍恢复焦点；`tools/verify.js` 补相关静态回归。
- 1.14.205：改进大图预览、缩略图入口和悬浮面板的键盘/读屏体验，并继续减少 MutationObserver、后台队列和重图恢复队列的重复扫描。`previewer.js` 将大图预览声明为 modal dialog，打开后聚焦关闭按钮、Tab 限定在预览控件内、关闭后恢复原焦点，并给计数状态补 `aria-live`；`loader.js` / `viewport-observer.js` 给缩略图 wrapper 补键盘 Enter/Space 打开预览能力，`content.css` 补焦点样式；`floating-panel.js/css` 补 dialog 语义、打开移焦、Escape 关闭、关闭后恢复 launcher 焦点和隐藏态 Tab 隔离；`content.js` 的 MutationObserver 自身节点过滤只检查直接 ATP root class；`loader.js` 的 idle 后台队列 drain 复用 `processBgTasks()` 单批处理，不再同一 idle tick 内循环触发 `globalSchedule()`，并用队列版本缓存复用后台普通任务存在性判断；`viewport-observer.js` 在 restore queue 单轮处理中复用 budget snapshot 和 viewport state，并用本批已恢复 MP 投影 delay 压力；`tools/verify.js` 补相关静态回归，不调整权限、host 权限、设置项、缓存 TTL 或负缓存 TTL。
- 1.14.204：优化资源栏 TXT 状态、缓存写入配额检查、空结果注入 fallback、重图预算 snapshot 复用和短视口/键盘体验。`resource-panel.js` 对 marker-only 或 retryable TXT 状态回退 1 个附件，避免出现 0 个附件但可解析的入口，并让已有资源和 inline 资源条继续保留 TXT 加载/失败提示；`cache.js` 对成功缓存写入后的 `getBytesInUse(null)` 做时间/批量节流，失败淘汰路径仍即时检查；`content.js` 对无返回结果的注入路径懒创建并复用一个空文章对象；`viewport-observer.js` 在同一轮 `reconcileHeavyRenderBudget()` 内复用 `budget.snapshot`；`content.css` 给资源侧栏补短视口约束；`floating-panel.js/css` 将启动器改为 button、同步 `aria-expanded` 并增加 `:focus-visible`；`tools/verify.js` 补相关静态回归。
- 1.14.203：修复外部设置变更、协议边界和跨域空结果重复抓取问题，并补 manifest 加载顺序验证。`content.js` 通过 `SETTINGS_SCHEMA` 统一判断所有 `immediate:false` 设置是否需要重建缩略图，且把 storage 最新设置同步到已打开的 `FloatingPanel`；`floating-panel.js` 新增 `setSettings()` 刷新控件值和依赖禁用状态；`background.js` / `fetcher.js` 的文章与 TXT 最终 URL 校验统一要求 `https:`，匹配 manifest 权限；跨域 background 的确定性空结果会写负缓存，`retryableEmpty`、`partial` 和 `html_too_large` 仍保持不写负缓存；`tools/verify.js` 补相关静态回归和 content script 顺序检查。
- 1.14.202：优化 cache miss 前缓存读取、TXT background deadline、窄容器缩略图可访问性和浮动面板首帧/拖动体验，并修复旧 TXT marker 和预览 overflow 恢复边界；不调整权限、host 权限、设置项、缓存 TTL、负缓存 TTL 或主加载链路。`cache.js` 新增 `getArticleCacheState()` 一次读取文章缓存和负缓存，`fetcher.js` 复用该状态并给 TXT background 请求传 deadline；`background.js` 按剩余 deadline 裁剪递归中转 fetch timeout，`shared-utils.js` 将 TXT background 等待预算提高到 4 个 TXT fetch 窗口；旧缓存缺少 TXT 计数时保留 `hasTextAttachments` 并回退计数 1；`renderer.js` 允许缩略图 viewport 横向滚动；`floating-panel.js/css` 隐藏 CSS 未就绪的 Shadow host、适配窄/短视口并用 RAF 合并拖动；`previewer.js` 恢复原始 body overflow，`content.css` 补 reduced-motion；验证脚本补静态回归。
- 1.14.201：优化 scanner 候选检测的 DOM 查询范围，不调整帖子过滤、服务帖跳过、扫描上限、权限或设置项。`scanner.js` 在每轮 `detectArticleContainers()` 先定位论坛线程容器，后续候选选择器从 scoped root 内查询，减少滚动、MutationObserver 和补扫触发时的全文档选择器扫描；root 本身是候选行时仍会被纳入检测；验证脚本补静态回归。
- 1.14.200：优化 content 扫描结果注入阶段重复归一化，不调整统计口径、retryable empty、注入顺序、缓存写入、权限或设置项。`content.js` 直接复用同源/跨域收集阶段已归一化的 `results[url]`，仅在缺失结果时用空文章数据兜底，避免对 `sameData` / `bgData` 二次 `ATPCache.normalizeArticleData()`；验证脚本补静态回归。
- 1.14.199：优化 content 同源文章抓取批处理数组分配，不调整同源并发数、请求顺序、`Promise.all()` 结果顺序、跨域 fallback、权限或设置项。`content.js` 先计算 `batchEnd` / `batchSize`，用 `new Array(batchSize)` 预分配 Promise 批次并按索引写入，避免每个批次通过 `batch.push()` 动态扩容；验证脚本补静态回归。
- 1.14.198：优化 content 扫描批处理 URL 分组的 Map 查询成本，不调整 URL 顺序、同源/跨域分流、注入顺序、权限或设置项。`content.js` 对每个候选 URL 只执行一次 `urlMap.get(url)`，首次出现时创建 `entriesForUrl` 并复用该数组写入分组，避免 `has()` / `set()` / 二次 `get().push()` 多次查表；验证脚本补静态回归。
- 1.14.197：优化 viewport 重图渲染日志的重复统计扫描，不调整日志字段、统计口径、重图恢复/卸载策略、权限或设置项。`viewport-observer.js` 在 `getHeavyRenderLogFields()` 快照里同步产出 `heavyUnloaded`，`logHeavyRender()` 直接复用该字段作为 `unloadedCount`，避免同一条重图日志额外扫描 `heavyRenderItems`；验证脚本补静态回归。
- 1.14.196：优化 loader 首屏队列诊断的重复遍历，不调整 `schedule_state` 字段、首屏调度顺序、普通/重图压力语义、权限或设置项。`loader.js` 新增 `getFirstTaskChannelSnapshot()`，一次遍历取得首屏 ordinary/heavy 计数和首个重图任务，并移除旧的 count-only / first-heavy 双扫描 helper；验证脚本补静态回归。
- 1.14.195：优化 loader background 队列快照复用范围，不调整容量判断、隐藏页加载数量、普通/重图压力语义、任务顺序、权限或设置项。`loader.js` 让 `getAvailableBackgroundSlots()`、隐藏页 pending drain 和 `schedule_state` 日志路径复用 `getTaskChannelSnapshot()` 的普通/重图计数与首个重图任务，减少同轮重复遍历 `BG_TASKS`；验证脚本补静态回归。
- 1.14.194：优化 loader background 调度轮内 channel count / first-heavy 重复扫描，不调整容量判断、普通/重图压力语义、任务顺序、权限或设置项。`loader.js` 新增 `getTaskChannelSnapshot()`，单次扫描后台队列得到普通/重图计数和首个重图任务，`processBgTasks()` 将快照传入 `hasBackgroundCapacity()` 复用；验证脚本补静态回归。
- 1.14.193：优化 loader background 调度轮内普通任务存在性重复扫描，不调整普通/重图压力语义、任务顺序、延期重排、权限或设置项。`loader.js` 的 `processBgTasks()` 在单个调度轮内缓存 `hasNonHighFanoutWaiting`，每个任务 defer 判断复用该值，避免逐任务重复扫描 `BG_TASKS`；验证脚本补静态回归。
- 1.14.192：优化 renderer 已加载候选命中阶段重复 candidate 读取和归一化，不调整候选顺序、display/preview 成对去重、loaded URL 匹配、权限或设置项。`renderer.js` 改用 normalized URL 到候选索引的缓存，并并行缓存 preview/display key，loaded 命中后直接用索引标记成对 key；验证脚本补静态回归。
- 1.14.191：优化 renderer 已加载候选补齐阶段重复 preview URL 读取，不调整候选顺序、loaded URL 匹配、去重语义、权限或设置项。`renderer.js` 直接用缓存的 `previewKeys[j]` 做空值和去重判断，避免二次调用 `SharedUtils.getImagePreviewSrc(candidates[j])`；验证脚本补静态回归。
- 1.14.190：优化 renderer 已加载候选优先排序重复 URL 归一化，不调整候选顺序、loaded URL 匹配、去重语义、权限或设置项。`renderer.js` 在构建 normalized 索引时缓存 preview key，后续补齐候选直接复用 `previewKeys`，避免对同一候选 preview URL 二次 `normalizeImageUrl()`；验证脚本补静态回归。
- 1.14.189：优化 renderer 首屏任务队列构造分配，不调整首屏任务顺序、字段、时间戳、队列 offset、权限或设置项。`renderer.js` 按 `firstScreenTotal` 预分配 `firstTasks` 数组，并用索引写入任务，避免线程注册阶段逐项 `push()` 扩容；验证脚本补静态回归。
- 1.14.188：优化 resource panel 侧栏和 inline 渲染路径重复归一化，不调整资源展示内容、按钮绑定、TXT 提示、权限或设置项。`resource-panel.js` 新增 normalized group/TXT helper，`renderThread()` / `renderInline()` 在入口归一化 resources 后复用同一份对象生成分组和 TXT badge；验证脚本补静态回归。
- 1.14.187：优化 resource panel 复制文本格式化重复归一化，不调整复制内容、分组顺序、密码开关、权限或设置项。`resource-panel.js` 新增 normalized helper，`formatTypeText()` / `formatAllText()` 在入口只归一化一次资源对象，分组和密码文本复用同一个 normalized resources；验证脚本补静态回归。
- 1.14.186：优化 renderer 表格模式 colspan 计数分配，不调整表格插入位置、colspan fallback、权限或设置项。`renderer.js` 新增 `countTableCells()`，按 `children` 计数 `TD/TH`，避免每个缩略图行插入时分配 `querySelectorAll('td,th')` NodeList；验证脚本补静态回归。
- 1.14.185：优化 content 跨域 background 主循环重复条目读取，不调整返回处理顺序、缓存写入、重试判定、日志字段、权限或设置项。`content.js` 在主 `bg` 循环内缓存 `bgEntry`，统计图片/资源和归一化文章数据都复用同一次 `bg[bk]` 读取；验证脚本补静态回归。
- 1.14.184：优化 content 跨域 background 返回 totals 重复扫描，不调整返回处理顺序、超时重试、缓存写入、日志字段、权限或设置项。`content.js` 在主 `bg` 扫描里同步累计返回图片数和资源数，避免为了日志 totals 第二次遍历同一批 background 结果；验证脚本补静态回归。
- 1.14.183：优化 loader 后台批量入队重复时间读取，不调整批量大小、任务顺序、队列字段、权限或设置项。`loader.js` 的 `enqueueBgForThread()` 复用单次 `Date.now()` 作为整批 `createdAt` / `queuedAt`，避免同批 background task 逐项读取时间；验证脚本补静态回归。
- 1.14.182：优化 loader background idle drain 循环内 pending 上限重复计算，不调整后台加载速度、viewport pending 上限语义、权限或设置项。`loader.js` 的 `requestIdleCallback` drain 在单次 idle 回调内复用 `idleMaxPending`，避免每轮重复读取 settings、背景并发和 pending limit；验证脚本补静态回归。
- 1.14.181：优化 loader 后台容量判断重复普通活跃计数，不调整普通/重图容量判断、普通工作压力语义、权限或设置项。`loader.js` 的 `getAvailableSlotsForLimits()` / `hasBackgroundCapacity()` 在单次同步计算内复用 `activeOrdinary`，避免重复调用 `getActiveOrdinaryCount()`；验证脚本补静态回归。
- 1.14.180：优化 loader 调度/队列诊断的 pending 统计读取，不调整诊断字段名、统计口径、权限或设置项。`loader.js` 复用单次 `getViewportPendingStatsFields()` 结果，通过 `pendingCount` 派生 `viewportPending`，pending stats 不可用时再兜底调用 `ATPLoader.getViewportPendingCount()`；验证脚本补静态回归。
- 1.14.179：优化 viewport destroy 清理路径分配，不调整清理顺序、pending slot retry timer 清理、heavy restore reveal 监听移除、权限或设置项。`viewport-observer.js` 的 `destroy()` 改用 `pendingWrappers.values()` / `heavyRenderItems.values()` iterator 循环，避免热重载、停用或销毁时分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.178：优化轻量重图预热 observer 初始化遍历分配，不调整预热 margin 记录、`lightweightPreloadEligible` 过滤、observe 语义、权限或设置项。`viewport-observer.js` 在 observer 创建后补挂现有 pending wrapper 时改用 `pendingWrappers.entries()` iterator 循环，避免分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.177：优化重图清晰度切换遍历分配，不调整切换策略、预览持有、卸载、恢复入队、权限或设置项。`viewport-observer.js` 的 `applyHeavyThumbnailClarity()` 改用索引循环和 `heavyRenderItems.entries()` iterator 循环，避免恢复队列清理、lightweight 持有/卸载和 balanced 恢复入队时分配 `forEach` 回调；验证脚本补静态回归。
- 1.14.176：优化可见页恢复时 hidden-load 标记清理分配，不调整 `forceLoadWhenHidden` 清理、离屏 slot retry timer 清理、权限或设置项。`viewport-observer.js` 的 `clearHiddenLoadFlags()` 改用 `pendingWrappers.values()` iterator 循环，避免从隐藏页回到可见页时分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.175：优化 scheduler 重图卸载计数诊断分配，不调整卸载计数语义、诊断字段名、恢复队列计数、权限或设置项。`viewport-observer.js` 的 `getHeavyUnloadedCount()` 改用 `heavyRenderItems.values()` iterator 循环，避免调度诊断生成 `heavyUnloaded` 字段时分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.174：优化 viewport pending 诊断统计分配，不调整统计字段、单次时间戳、距离读取、权限或设置项。`viewport-observer.js` 的 `getPendingStats()` 改用 `pendingWrappers.entries()` iterator 循环，避免调度诊断收集 pending age、距离和轻量预热 miss 时分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.173：优化 scroll idle 近屏 pending 补扫分配，不调整待加载筛选、加载入口、返回计数、权限或设置项。`viewport-observer.js` 的 `retryVisiblePending()` 改用 `pendingWrappers.entries()` iterator 循环，避免滚动停止后为 pending 重试分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.172：优化隐藏页 pending 补图上限扫描，不调整隐藏页强制加载标记、加载入口、返回计数、权限或设置项。`viewport-observer.js` 的 `loadPendingWhenHidden(maxLoads)` 改用 `pendingWrappers.entries()` iterator 循环，达到 `maxLoads` 后真正 `break`，避免 `Map.forEach` 继续遍历剩余 pending 项；验证脚本补静态回归。
- 1.14.171：优化 viewport 重图渲染预算快照构建分配，不调整快照字段、viewport 几何读取、统计口径、预算选择、权限或设置项。`viewport-observer.js` 的 `getHeavyRenderSnapshot()` 改用 `heavyRenderItems.entries()` iterator 循环，避免高频预算快照构建时分配 `Map.forEach` 回调；验证脚本补静态回归。
- 1.14.170：优化 viewport 重图渲染预算 reconcile 遍历分配，不调整预算选择、卸载批量、恢复入队、可见预览 retry、权限或设置项。`viewport-observer.js` 复用同一个 `budget.snapshot.items` 快照数组，并将卸载/恢复两轮扫描改为索引循环，避免两次 `forEach` 回调分配；验证脚本补静态回归。
- 1.14.169：优化 renderer host 诊断解析重复代码，不调整 `hostMix` 字段、格式异常 URL 忽略语义、`image.imx.to-heavy` 计数、权限或设置项。`renderer.js` 新增 `getImageHost()`，线程注册诊断 `summarizeImageHosts()` 复用该 helper 解析候选 preview host，避免在候选循环内展开 `new URL(src).hostname` 和 try/catch；验证脚本补静态回归。
- 1.14.168：优化 background origin host 判断重复解析，不调整允许站点、`xia.ewrewej.la` / `dl.ldkms.la` TXT 规则、重定向拒绝、权限或设置项。`background.js` 新增 `isAllowedOriginHost()`，`originAllowed()` 和 `textAttachmentAllowed()` 共用站点 host 判断，TXT final URL 校验复用已解析的 `u.hostname`，避免通过 `originAllowed(url)` 二次解析同一个 URL；验证脚本补静态回归。
- 1.14.167：优化 content 扫描 URL 同源分流重复解析，不调整同源直连抓取、跨域 handoff、空结果重试、权限或设置项。`content.js` 新增本地 `isSameOriginUrl()`，扫描批处理的 same/cross URL 分流复用该 helper，避免在分流循环内展开 `new URL(u)` 和 try/catch；验证脚本补静态回归。
- 1.14.166：优化 loader host parsing 重复解析，不调整 `image.imx.to` 识别、no-referrer 默认策略、普通域名熔断、权限或设置项。`loader.js` 的高扇出图床判断和域名熔断提取复用 `getUrlHost()`，避免在 `isHighFanoutImageHost()` / `extractDomain()` 内各自重复 `new URL(url).hostname` 解析和异常防护；验证脚本补静态回归。
- 1.14.165：优化 fetcher 同源 URL 判断重复解析，不调整同源直连、跨域中转、失败缓存、权限或设置项。`fetcher.js` 新增本地 `isSameOriginUrl()`，TXT 附件分流、TXT 中转下载递归和 fresh 附件抓取入口复用同源判断，避免三处重复 `new URL(...).origin` 解析和 try/catch 防护；验证脚本补静态回归。
- 1.14.164：优化 shared article URL 归一化参数表分配，不调整文章缓存 key 归一化、参数排序、hash 清理、权限或设置项。`shared-utils.js` 新增模块级 `ARTICLE_KEEP_PARAM_MAP`，`normalizeArticleUrl()` 复用该表筛选 `mod/tid/page`，避免每次调用重建 `keepParams` 数组和执行数组 `indexOf` 扫描；验证脚本补静态回归。
- 1.14.163：优化 content 扫描结果注入分配，不调整候选 URL 顺序、空结果重试、已处理标记、缩略图注入策略、权限或设置项。`content.js` 复用已有 `allUrls` 顺序数组，用索引循环读取 `urlMap.get(url)` 分组，避免 `urlMap.forEach(function(entries, url)` 回调分配；验证脚本补静态回归。
- 1.14.162：优化 viewport observer entries 批处理分配，不调整 observer margin、threshold、加载/卸载策略、权限或设置项。`viewport-observer.js` 的重图渲染观察、轻量重图预热观察和主 viewport lazy 观察都改用索引循环遍历 `entries`，避免 `entries.forEach(function(entry)` 回调分配；验证脚本补静态回归。
- 1.14.161：优化 content 用户交互监听绑定分配，不调整监听事件集合、`passive/once` 选项、卸载清理、权限或设置项。`content.js` 新增 `bindUserInteractionListeners()`，启动注册和卸载移除都用索引循环遍历 `USER_EVENTS`，避免 `USER_EVENTS.forEach()` 回调分配；验证脚本补静态回归。
- 1.14.153：优化资源密码清洗候选分配，不调整密码清洗规则、中文说明截断、占位过滤、长度上限、权限或设置项。`shared-utils.js` 的 `cleanPasswordValue()` 现在用首个空白分隔符和后缀中文检测处理说明文本，避免对每个密码候选执行 `split()`、`slice(1)`、`join()`；验证脚本补静态回归。
- 1.14.152：优化 popup 日志 key 发现固定 key 初始化分配，不调整日志 key 发现范围、去重、索引读取、日志加载/导出/清理行为、权限或设置项。`popup.js` 的 `getLogKeysFromItems()` 现在循环填充固定 `LOG_KEYS` 并同步 seen map，避免 `LOG_KEYS.slice()` 复制固定 key 数组；验证脚本补静态回归。
- 1.14.151：优化 content/background 日志字节预算裁剪调用点分配，不调整估算输入、裁剪步进、最终保留窗口、日志顺序、storage key、权限或设置项。`logger.js` 和 `background.js` 新增 `estimateLogBytesFrom()`，裁剪循环通过 helper 估算保留窗口，避免在调用点直接 `entries.slice(start)`；验证脚本补静态回归。
- 1.14.150：优化 content/background 日志裁剪最终保留窗口分配，不调整裁剪起点、字节预算、条数上限、失败重试、日志顺序、storage key、权限或设置项。`logger.js` 和 `background.js` 新增 `copyLogEntriesFrom()`，预分配并循环复制最终保留窗口，避免 `entries.slice(start)`；验证脚本补静态回归。
- 1.14.149：优化 shared 图片提取结果限制分配，不调整图片候选顺序、数量上限、去重、重图识别、权限或设置项。`shared-utils.js` 新增 `limitImageResults()`，regex/DOM 图片提取路径只在超限时原地收窄，避免每次返回前 `images.slice(0, maxCount)` 复制结果数组；验证脚本补静态回归。
- 1.14.148：优化 popup 重图原始预设恢复的字段遍历分配，不调整预设字段、保存流程、失败回滚、权限或设置项。`popup.js` 新增 `forEachHeavyOriginalPreset()`，应用预设和失败回滚都通过 `for...in` 自有属性扫描字段，避免 `Object.keys(HEAVY_ORIGINAL_PRESET).forEach()` 分配 key 数组；验证脚本补静态回归。
- 1.14.147：优化 popup 缓存/日志维护 key 合并分配，不调整删除范围、去重语义、日志索引 key、缓存索引清理、权限或设置项。`popup.js` 新增 `collectUniqueKeys()`，缓存索引兜底、一键清空缓存、清空日志现在按分组单次去重合并 key，避免 `concat()` 链复制大 key 数组；验证脚本补静态回归。
- 1.14.146：优化资源/密码解析中的 mailto 恢复候选合并分配，不调整候选检查顺序、受保护邮箱恢复、密码提取、资源解析、权限或设置项。`shared-utils.js` 的 `restoreMailtoPassword()` 现在先固定 href/title/label，再循环追加 `data-*` 属性值，避免每个 anchor 用 `concat()` 合并数组；验证脚本补静态回归。
- 1.14.145：优化 content/background 日志 flush 失败重试队列分配，不调整日志顺序、重试次数、丢弃策略、storage key、权限或设置项。`logger.js` 和 `background.js` 新增 `retryBatch` 优先槽，下一次 drain 先合并失败批次再合并新队列，避免 `flushQueue.unshift(batch)` 搬移队列；验证脚本补静态回归。
- 1.14.144：优化 renderer 线程注册候选数组收窄分配，不调整候选顺序、fetch/display 限制、重图策略、首屏任务、缓存格式、权限或设置项。`renderer.js` 新增 `copyCandidatePrefix()`，候选池和展示候选收窄时预分配目标数组并按索引复制，避免注册线程热路径里的 `slice()`；验证脚本补静态回归。
- 1.14.143：优化 content/background 日志写入合并扩容成本，不调整日志顺序、容量预算、失败重试、storage key、权限或设置项。`logger.js` 和 `background.js` 的 `mergeLogEntries()` 现在预分配 existing+batch 总长度数组并按索引写入，避免动态 `push()` 扩容；验证脚本补静态回归。
- 1.14.142：优化资源结果合并分配，不调整资源归一化、去重、密码合并、缓存格式、权限或设置项。`shared-utils.js` 的 `mergeResources()` 现在对各分组用循环 `push()` 追加 normalized group 项，避免每个资源源合并时用 `concat()` 复制已有分组数组；验证脚本补静态回归。
- 1.14.141：优化 content/background 日志写入合并分配，不调整日志顺序、尾部保留、容量预算、失败重试、storage key、权限或设置项。`logger.js` 和 `background.js` 用 `mergeLogEntries()` 循环合并 existing+batch，用 `trimLogEntriesFrom()` 直接从重试起点裁剪，避免 `concat()` 和失败重试前的 `slice()`；验证脚本补静态回归。
- 1.14.140：优化 content 日志索引维护分配，不调整按时间排序、最近 key 保留、容量裁剪、旧日志删除、storage key、权限或设置项。`logger.js` 现在用 `collectSortedContentLogKeys()` 单次过滤/去重/追加当前 key，`planLogKeyPrune()` 用循环分流 kept/stale，避免 `filter()`、`concat()`、`slice()` 索引中间数组；验证脚本补静态回归。
- 1.14.139：优化 content/background 日志裁剪分配，不调整日志保留尾部、条数上限、字节预算、失败重试、storage key、权限或设置项。`logger.js` 和 `background.js` 的 `trimLogEntries()` 现在用 `start` 游标定位最终保留窗口，避免裁剪前复制完整日志数组和先按条数上限生成中间 slice；验证脚本补静态回归。
- 1.14.138：优化 content/background 结构化日志脱敏分配，不调整字段脱敏规则、优先字段、字段数量上限、循环引用保护、日志输出、权限或设置项。`logger.js` 和 `background.js` 现在用有界循环处理数组字段和对象字段，避免 `slice().map()`、`Object.keys().slice()` 中间数组；验证脚本补静态回归。
- 1.14.137：优化 content/background 日志 flush 队列合并，不调整日志字段、storage key、容量上限、失败重试、重排语义、权限或设置项。`logger.js` 和 `background.js` 现在用 `drainFlushQueue()` 一次性嵌套循环合并 queued batches，避免 `concat(shift())` 反复复制数组和搬移队列；验证脚本补静态回归。
- 1.14.136：优化 background TXT 附件资源解析分配，不调整附件允许规则、数量上限、失败缓存、读取流程、资源合并顺序、权限或设置项。`FETCH_TEXT_RESOURCES` 入口和 `fetchTextAttachmentResources()` 现在用有界循环过滤/截断附件并构造 TXT fetch Promise，避免 `filter()`/`slice()`/`map()` 中间数组；验证脚本补静态回归。
- 1.14.135：优化 background 跨域文章抓取批处理分配，不调整 background fetch 协议、批大小、抓取顺序、结果结构、缓存写入、权限或设置项。`FETCH_IMAGES` 入口现在循环收集合规 URL，`handleFetch()` 循环构造每批 URL/Promise，避免 service worker 热路径中的 `filter()`/`slice()`/`map()` 中间数组；验证脚本补静态回归。
- 1.14.134：优化 fetcher TXT 附件资源解析分配，不调整附件数量上限、同源直连、跨域 background 兜底、硬失败缓存、资源合并顺序、权限或设置项。`fetchTextAttachmentResources()` 现在用有界循环截断输入并构造同源/跨域 Promise，最终兜底附件也用单次循环收集，避免 `slice()`/`map()`/`filter()` 中间数组；验证脚本补静态回归。
- 1.14.133：优化 loader 初始图片 source 读取复用，不调整加载策略、fallback、重试、缓存、权限或设置项。`loadImageDirect()` 和 `retryLoadImage()` 初始化 `<img>` 时用单个 `initialSrc` 同时设置图片地址和默认 referrer 策略，避免同一语句连续读取两次当前任务 URL；timeout/error/fallback 仍重新读取当前候选 URL；验证脚本补静态回归。

- 1.14.132：优化 renderer 线程注册时间戳复用，不调整线程 id 格式、首屏任务结构、调度策略、缓存、权限或设置项。`registerThread()` 现在用单个 `registeredAt` 同时生成 `threadId` 并作为首屏任务 `queuedAt/createdAt` 基准，避免同一注册路径重复读取时间戳；验证脚本补静态回归。
- 1.14.131：优化 content 跨域后台抓取返回日志汇总，不调整后台抓取协议、返回数据处理、缓存写入、权限或设置项。后台结果日志现在单次 `for...in` 自有属性扫描，同时累计图片和资源总数，不再 `Object.values(bg).reduce(...)` 分配数组并重复遍历；验证脚本补静态回归。
- 1.14.130：优化 content 滚动扫描候选筛选成本，不调整扫描范围、批量上限、重试退避、文章 URL 筛选、权限或设置项。`detectProcessCandidates()` 每轮创建 `scanContext`，复用同一个 `now` 和 `viewportBottom` 给 `isProcessCandidate()` / `isNearViewport()`，避免每个候选重复读取时间戳和计算近屏下界；验证脚本补静态回归。
- 1.14.129：优化 viewport 重图恢复入队预算判断链，不调整恢复策略、预算阈值、defer reason、权限或设置项。`isVisibleRestoreBudgetAllowed()`、`getRestoreBudgetBlockReason()` 和 `isHeavyRestoreBudgetAllowed()` 支持传入缓存的 `viewportState`，`queueHeavyRestore()` 复用一次几何读取完成范围、预算和 skip-budget 可见性判断；验证脚本补静态回归。
- 1.14.128：优化 viewport 重图恢复队列几何读取，不调整恢复策略、预算、排序优先级、权限或设置项。`processHeavyRestoreQueue()` 现在提前建立 `restoreQueueViewportState`，清理阶段的 `inHeavyRestoreRange` 判断和排序阶段的可见性/中心距比较共用同一批 `getViewportRectState()` 结果，减少恢复批处理中的重复 layout read；验证脚本补静态回归。
- 1.14.127：优化预览打开路径的 URL 列表构造，不调整图片加载、预览器行为、缓存、权限或设置项。`loader.js` 新增并暴露 `buildPreviewUrls()`，加载成功和重试成功点击预览、viewport 恢复图点击预览均复用循环式 URL builder，不再通过 `previewCandidates.map(...)` 生成回调分配；验证脚本补静态回归。
- 1.14.126：优化 content 扫描完成 article count 计数，不调整扫描、抓取、渲染、日志字段、权限或设置项。扫描完成时通过 `countOwnProperties(results)` 单次自有属性计数，不再 `Object.keys(results).length` 分配 key 数组；普通完成日志和 `scan_complete` 事件继续复用同一计数；验证脚本补静态回归。
- 1.14.125：优化 loader 首屏 round-robin 队列消费，不调整首屏并发、普通图/重图优先级、重试、stop-loss、权限或设置项。首屏任务通过 `firstTaskOffset` 游标读取和 `consumeFirstTask()` 消费，不再每张图 `firstTasks.shift()` 搬移数组；消费前缀足够大时再批量压缩；验证脚本补静态回归。
- 1.14.124：优化 shared utils 资源访问码匹配分配，不调整资源识别、访问码优先级、跨资源链接隔离、解压密码跳过、权限或设置项。`extractAccessCode()` 扫描时维护 `bestCandidate`，不再收集候选数组、`concat()` 后 `sort()`；验证脚本补静态回归。
- 1.14.123：优化 shared utils 资源密码提取分配，不调整资源识别、密码清洗、去重、占位过滤、缓存格式、权限或设置项。`extractResources()` 使用 `mergeUniqueLimited(..., 5)` 有界合并 HTML 和正文密码，不再完整 `mergeUnique(...)` 后 `.slice(0, 5)`；验证脚本补静态回归。
- 1.14.122：优化 loader host timing p90 诊断计算，不调整日志字段、host timing 样本上限、flush 时机、调度策略、权限或设置项。`percentile()` 改为有界选择目标分位值，不再 `values.slice().sort(...)` 复制并排序样本数组，且不修改 ring buffer 样本顺序；验证脚本补静态回归。
- 1.14.121：优化 loader 诊断汇总和首屏线程收集分配，不调整调度策略、重图 host 健康评分、日志字段、权限或设置项。`mergeMaxCountObject()`、`mergePendingAgeByQueueKind()`、`getHeavyHostHealthSummaryFields()` 和 `getActiveFirstThreadIds()` 改为 `for...in` 自有属性扫描，不再 `Object.keys(...).forEach(...)` 分配 key 数组；验证脚本补静态回归。
- 1.14.120：优化 popup 日志 key 发现和 cacheIndex 条目扫描，不调整日志格式、缓存类型、删除范围、权限或设置项。`getLogKeysFromItems()` 和 `cacheKeysFromEntries()` 改为 `for...in` 单次扫描并保留 own-property 检查，不再 `Object.keys(...).forEach(...)` 分配完整 key 数组；验证脚本补静态回归。
- 1.14.119：优化 popup 日志读取最近窗口裁剪，不调整日志排序、过滤、显示上限、导出内容、权限或设置项。`loadLogEntries()` 在排序后通过 `logs.splice(0, logs.length - LOG_VIEW_LIMIT)` 原地删除旧日志，不再 `logs.slice(...)` 复制最近日志数组；验证脚本补静态回归。
- 1.14.118：优化 popup 日志面板最近窗口渲染，不调整日志排序、过滤语义、显示上限、导出内容、权限或设置项。日志刷新时通过 `renderStart` 直接从 filtered 数组渲染最近 `LOG_RENDER_LIMIT` 条，不再 `filtered.slice(-LOG_RENDER_LIMIT)` 复制最近日志数组；验证脚本补静态回归。
- 1.14.117：优化 popup 日志数组字段脱敏，不调整日志格式、脱敏规则、数组上限、循环引用标记、导出内容、权限或设置项。数组值保留 50 项上限并用有界循环填充结果，不再 `value.slice(0, 50).map(...)`，减少日志查看/导出时的中间数组分配；验证脚本补静态回归。
- 1.14.116：优化 popup 日志字段脱敏和数据文本判断，不调整日志格式、脱敏规则、字段上限、导出内容、权限或设置项。字段脱敏改为有界 `for...in` 扫描并保留 120 字段上限，不再 `Object.keys(fields).slice(...)`；字段存在判断改为 `hasLogFields()`，避免仅判断字段时分配 key 数组；验证脚本补静态回归。
- 1.14.115：优化 popup 清缓存兜底 storage key 发现，不调整 cacheIndex 优先级、删除范围、storage key 前缀、按钮语义、权限或设置项。兜底扫描改为单次 `for...in` 收集匹配 key，不再用 `Object.keys(all).filter(...)` 先分配全量 key 数组再过滤；验证脚本补静态回归。
- 1.14.114：优化 content 扫描完成日志计数，不调整扫描、抓取、缓存、渲染、跨域或权限语义。扫描完成时只计算一次 `articleCount`，普通日志和 `scan_complete` 结构化事件共用，不再重复执行 `Object.keys(results).length`；验证脚本补静态回归。
- 1.14.113：优化 renderer 帖子初始化候选池构造，不调整候选提取、显示数量、重图策略、fallback、缓存语义、权限或设置项。`candidatePool` 只有在 `fetchLimit` 真正小于图片数组长度时才复制；未收窄时直接复用 `images`，减少普通帖子和已按抓取上限收敛帖子初始化阶段的一次数组分配；验证脚本补静态回归。
- 1.14.112：优化 renderer 注册线程诊断 hostMix 汇总，不调整候选提取、渲染数量、重图策略、fallback、缓存语义、权限或设置项。hostMix 通过有界 top 6 host 集合维护，不再对全部 host counter 执行 `Object.keys().sort().slice().map()`，减少帖子初始化诊断路径的排序和中间数组成本；验证脚本补静态回归。
- 1.14.111：优化 popup 日志导出摘要 counter top-N 汇总，不调整日志格式、导出字段、过滤语义、权限或设置项。type/host/level 摘要通过有界 top-N key 收集生成，不再对全部 counter key 执行 `Object.keys().sort().slice().map()`，减少大日志导出时的排序和中间数组成本；验证脚本补静态回归。
- 1.14.110：优化 popup content 日志裁剪，不调整日志格式、存储 key、清理语义、权限或设置项。裁剪时通过有界 newest key 集合保留最新 `MAX_CONTENT_LOG_KEYS` 条 content 日志，再单次收集旧 key，不再先 `filter()` 全量 content key、排序再 `slice()`；验证脚本补静态回归。
- 1.14.109：优化 loader 诊断摘要 top-N 汇总，不调整图片加载策略、日志字段、权限或设置项。counts/reasons/hosts/channels/unloadReasons/preloadMissReasons 和 host timing 现在通过有界 key 收集保留最高计数项，不再对全量 key/host 做 `sort().slice()`，减少大样本诊断 flush 的排序和中间数组成本；验证脚本补静态回归。
- 1.14.108：优化 renderer TXT 附件归一化构造，不调整附件字段、缓存语义、资源面板行为或权限。注册线程时改用显式循环补齐缺失 `pageUrl`，不再用 `(textAttachments || []).map(...)` 生成回调分配；验证脚本补静态回归。
- 1.14.107：优化 resource panel 复制文本构造，不调整资源识别、复制开关、显示内容或权限。密码复制改为单次循环生成文本，单类型复制直接拼接资源组和密码段，不再额外 `filter()` 中间数组；验证脚本补静态回归。
- 1.14.106：优化 renderer 帖子缩略图候选数组构造，不调整显示数量、重图策略、fallback 语义或权限。`allCandidates` 只有在显示/重图上限小于 `candidatePool.length` 时才复制数组；上限未收窄时直接复用候选池，减少帖子初始化阶段的短时分配；验证脚本补静态回归。
- 1.14.105：优化 content 同源文章抓取批处理和跨域日志摘要，不调整抓取策略、并发上限、缓存语义、权限或 host permissions。同源 URL 每批通过循环构造 promise 列表，不再 `slice().map()`；跨域交后台日志摘要通过 `formatUrlSample()` 循环生成，减少扫描触发文章抓取时的临时数组分配；验证脚本补静态回归。
- 1.14.104：优化 loader 诊断摘要 host timing 采样，不调整图片加载策略、日志字段名称、权限或设置项。每个 host 的耗时样本达到 80 条后改为环形覆盖旧样本，不再用 `samples.shift()` 触发数组搬移；验证脚本补静态回归。
- 1.14.103：优化 popup 日志索引合并路径，不调整日志格式、存储 key、筛选语义或权限。日志索引写入、storage 发现和读取合并统一通过 `appendUniqueKeys()` 单次追加去重，避免 `uniqueKeys(...).filter(...)`、`keys.filter(...)` 和 `LOG_KEYS.concat(indexed.filter(...))` 造成中间数组分配；验证脚本补静态回归。
- 1.14.102：优化 popup 日志过滤路径，不调整日志格式、筛选语义或权限。`filterLogEntries()` 在默认 all 且无搜索词时直接复用原日志数组，session id 只在 session 筛选时计算，其它筛选改为单次循环收集匹配项，避免日志面板每次刷新都复制数组；验证脚本补静态回归。
- 1.14.101：优化 shared utils cacheIndex 串行写队列消费路径，不调整缓存索引格式、存储 key 或失败处理语义。`cacheIndex._drain()` 现在用 `_queueOffset` 游标读取下一项，队列消费完后一次性清空并重置 offset，避免每次写入完成都 `shift()` 搬移数组；验证脚本补静态回归。
- 1.14.100：优化 popup 日志读取前 stale key 剔除路径，不调整日志格式、存储 key 或权限。`loadLogEntries()` 在 prune 后构建 pruned key map，并单次生成 live log key 列表，避免 `logKeys.filter(... staleLogKeys.indexOf(...))` 对每个 key 做线性查找；验证脚本补静态回归。
- 1.14.99：优化 popup content 日志索引裁剪路径，不调整日志格式、存储 key 或权限。`pruneContentLogKeys()` 现在构建 stale key map 后单次循环保留有效 content 日志 key，避免链式 `filter()` 和每个 key 的 `stale.indexOf()` 线性查找；验证脚本补静态回归。
- 1.14.98：优化 shared utils 协议资源链接提取路径，不调整资源识别规则、权限或设置项。`extractProtocolLinks()` 现在清洗后只把非空链接加入结果，不再用 `links.filter(Boolean)` 额外生成过滤数组，减少资源/TXT 扫描中的短时分配；验证脚本补静态回归。
- 1.14.97：优化 loader 后台队列调度消费路径，不调整加载策略、权限或设置项。`processBgTasks()` 现在用 `bgReadIndex` 游标读取当前轮原始队列前缀，延期任务仍 `push()` 到队尾，循环结束后一次性 `splice()` 已检查前缀，避免每个后台任务 `shift()` 触发数组搬移；验证脚本补静态回归。
- 1.14.96：优化 viewport 重图恢复队列消费路径，不调整加载策略、权限或设置项。`processHeavyRestoreQueue()` 现在用 `consumeIndex` 游标顺序读取队列，循环后一次性 `splice()` 已消费前缀，避免每个恢复项 `shift()` 触发数组搬移，也避免 lane 限制时 `unshift()` 放回；验证脚本补静态回归。
- 1.14.95：优化 viewport 重图恢复队列清理路径，不调整加载策略、权限或设置项。`processHeavyRestoreQueue()` 现在用读写索引原地压缩有效队列项，单项移除改为 `indexOf()` + `splice()`，避免恢复批处理和卸载路径上用 `filter()` 重建队列；验证脚本补静态回归。
- 1.14.94：优化 viewport 重图渲染预算选择路径，不调整加载策略、权限或设置项。`selectHeavyBudgetItems()` 现在单次循环收集 in-range 候选后排序，避免预算调和时先 `filter()` 出中间数组；验证脚本补静态回归。
- 1.14.93：优化 viewport 可见重图预览恢复路径，不调整加载策略、权限或设置项。`reconcileVisiblePreviewRoom()` 现在单次循环收集 stuck 可见预览候选后排序，避免滚动预算调和时先 `filter()` 出中间数组；验证脚本补静态回归。
- 1.14.92：优化 loader 首屏 round-robin 调度分配，不调整加载策略、权限或设置项。活跃首屏线程收集集中到 `getActiveFirstThreadIds()`，调度循环中失效线程改为原地 `splice()` 移除，避免循环内反复 `filter()` 生成新数组；调度快照和 schedule 诊断复用同一 helper；验证脚本补静态回归。
- 1.14.91：优化 viewport 可见重图压力释放路径，不调整加载策略、权限或设置项。`reconcileVisibleRenderPressure()` 现在单次循环完成稳定可见锁定和卸载候选收集，避免滚动预算调和时连续创建 `visibleItems` / `candidates` 中间数组；验证脚本补静态回归。
- 1.14.90：优化 renderer 帖子渲染初始化分配，不调整加载策略、权限或设置项。重图帖子不再额外创建未使用的 `displayCandidates` 数组；没有历史成功图片 URL 时 `prioritizeLoadedCandidates()` 直接复用候选池，减少首轮渲染初始化的数组复制；验证脚本补静态回归。
- 1.14.89：优化 popup 日志导出摘要构建，不调整图片加载策略、权限或设置项。导出摘要现在通过 `buildLogSummaryStats()` 单次遍历同时统计事件、host 和级别，避免三个摘要维度分别重复扫描日志和读取结构化字段；验证脚本补静态回归。
- 1.14.88：继续优化资源/TXT/图片提取热路径分配，不调整图片加载策略、权限或设置项。新增 `SharedUtils.forEachHrefValue()`，让 TXT 下载链接提取、资源链接提取和正则图片提取直接迭代 href 属性，不再先构造完整 href 数组；验证脚本补 streaming href 静态回归。
- 1.14.87：优化资源提取扫描分配，不调整图片加载策略、权限或设置项。`SharedUtils.extractResources()` 现在通过 `scanResourceText()` 分别扫描正文文本和 `href` 值，不再先拼接一个包含全文与所有 href 的大型 `scanText`，减少长帖子和 TXT 附件解析时的临时字符串分配与 GC 抖动；验证脚本补静态回归。
- 1.14.86：优化 popup 日志导出大文本构建，不调整图片加载策略、权限或设置项。导出路径新增 `buildLogExportText()`，把导出头部和每条日志行收集到数组后一次性 `join`，避免最多 1000 条日志导出时循环内反复字符串追加；验证脚本补静态回归。
- 1.14.85：修复 popup 日志刷新竞态并继续优化渲染，不调整图片加载策略、权限或设置项。`loadLogs()` 现在用 `logLoadSeq` 标记每次异步读取，旧请求返回后会被忽略，避免快速输入搜索或切换过滤器时旧结果覆盖新结果；日志列表渲染改为 `renderLogEntries()` 循环拼接，避免 `map().join()` 的中间数组；验证脚本补静态回归。
- 1.14.84：优化 popup 日志搜索交互，不调整图片加载策略、权限或设置项。日志搜索输入现在通过 `scheduleLogReload()` 做 180ms debounce，再读取 storage、过滤并渲染日志，避免连续输入时每个字符都触发一次日志读取/排序/DOM 更新；隐藏日志面板后已排队的刷新也会跳过；验证脚本补静态回归。
- 1.14.83：优化 loader 调度诊断热路径，不调整图片加载策略、权限或设置项。`logScheduleState()` 现在只在节流通过后才扫描 active threads、统计首屏/后台队列、读取 viewport pending stats 和重图渲染统计；节流日志回调可返回空值以保留无工作不写 `schedule_state` 的行为，减少频繁调度时的诊断聚合开销；验证脚本补静态回归。
- 1.14.82：优化重图恢复和预算计算热路径，不调整图片加载策略、权限或设置项。`viewport-observer.js` 现在用 `getViewportRectState()` 集中读取 wrapper 几何信息，重图预算快照复用同一次范围/可见性/中心距离判断，恢复队列排序也会在单次排序中缓存 wrapper 几何状态，减少滚动恢复时的重复布局读取；验证脚本补静态回归。
- 1.14.81：优化列表页扫描路径，不调整图片加载策略、权限或设置项。`ATPScanner.detectArticleContainers()` 现在会在单次扫描内缓存每个表格的 `separatorline` 查询，服务帖判断也会先检查标题文本，再按需读取整行文本，减少滚动/Mutation 扫描中的重复 DOM 查询和大文本读取；验证脚本补静态回归。
- 1.14.80：修复热重载/停用时 pending cache flush 丢失边界，不调整图片加载策略、权限或设置项。`reloadThumbnails()` 和 `disableCurrentPage()` 现在会在 `clearThumbnailDom()` 清空 `window.ATPState.threads` 前先 `flushPendingData()`，确保待写的 loaded URL 缓存落盘，并同步清理延迟 flush timer；验证脚本补静态回归。
- 1.14.79：优化后台任务清理时的诊断摘要边界，不调整图片加载策略、权限或设置项。`ATPLoader.clearBgTasks()` 现在会先 `flushDiagnosticSummary('clear_bg_tasks')` 再清空后台队列，避免热重载或停用页面后旧队列统计延迟写入并混入新队列，同时清掉诊断摘要延迟 timer；验证脚本补静态回归。
- 1.14.78：修复热重载时预览器旧状态残留，不调整图片加载策略、权限或设置项。`clearThumbnailDom()` 现在会同步调用 `ATPPreviewer.close()`，让缩略图重载和页面停用都清理预览图片加载 timer、键盘监听和 `body` 滚动锁；验证脚本补静态回归。
- 1.14.77：修复页面卸载时 loader 全局监听清理不完整，不调整图片加载策略、权限或设置项。`handleBeforeUnload()` 现在复用 `ATPLoader.removeGlobalVisListener()`，同步清理 visibility listener、scroll listener 和 scroll idle timer；验证脚本补静态回归，防止退回只移除单个 visibility listener。
- 1.14.76：修复预览器销毁清理边界，不调整图片加载策略、权限或设置项。`ATPPreviewer.destroy()` 现在先复用 `close()`，确保图片加载 timeout、加载 token、当前图片 `src` 和 `body` 滚动状态都会被清理，避免热重载或页面卸载时预览器打开造成 timer/overflow 残留。验证脚本补静态回归。
- 1.14.75：修复热重载时 loader 监听器残留，不调整图片加载策略、权限或设置项。`reloadThumbnails()` 清理后台 timer/task 后，也会调用 `ATPLoader.removeGlobalVisListener()`，同步移除可见性监听、滚动监听和滚动 idle timer；新线程注册时继续按现有 `ensureGlobalVisListener()` 重新绑定。验证脚本补静态回归。
- 1.14.74：优化隐藏页暂停时的后台队列 timer 清理，不调整图片加载策略、权限或设置项。启用 `pauseWhenHidden` 且页面隐藏时，会同步清理已挂起的 background timeout/idle/retry timer，避免暂停期间醒来空跑；恢复可见时继续走现有 `globalSchedule()` 重启。`clearBgTimer()` 复用集中清理函数，验证脚本补静态回归。
- 1.14.73：优化缓存 flush 定时器清理，不调整图片加载策略、权限或设置项。首屏或整帖完成调用 `flushCacheNow(threadId)` 后，如果 pending 队列已空，会同步清理延迟 flush timer，避免 1 秒后再次空跑一次缓存 flush。验证脚本补静态回归。
- 1.14.72：优化加载成功 URL 状态写入，不调整图片加载策略、权限或设置项。线程状态新增 `loadedUrlMap`，图片成功后按规范化 preview URL 去重，再写入 `loadedUrls` 并触发缓存 flush，避免同一候选因重试/fallback 重复成功时膨胀状态数组和重复缓存写入。验证脚本补静态回归。
- 1.14.71：优化列表页扫描调度，不调整图片加载策略、权限或设置项。内容脚本每批处理帖子后，不再额外执行一次全页候选扫描来判断是否继续；改为复用当前批次是否达到 `PROCESS_BATCH_LIMIT`，达到上限才继续链式扫描，减少滚动/批处理后的重复 DOM 查询。验证脚本补静态回归。
- 1.14.70：修复旧缓存 Discuz TXT 临时附件 URL 清理条件，不调整图片加载策略、权限或设置项。读取文章缓存时，只要缓存里仍有 TXT 附件数组，就会扫描并剔除 Discuz 临时附件 URL，保留重提取 marker；不再依赖旧 `hasTextAttachments` 为 false，避免 1.14.69 的缓存归一化把临时 URL 标为可解析后绕过清理。验证脚本补 fetcher 静态回归。
- 1.14.69：继续收紧旧缓存 TXT 附件状态一致性，不调整图片加载策略、权限或设置项。`ATPCache.normalizeArticleData()` 清洗 `textAttachments` 后，`textAttachmentCount` 优先使用清洗后的附件数量；没有有效附件时，只有正数 legacy marker 才保留为 Discuz 重提取状态，零计数脏 marker 会被清除。验证脚本补脏计数覆盖和零计数 marker 清理回归。
- 1.14.68：修复旧缓存 TXT 附件状态和计数跟随清洗结果的一致性，不调整图片加载策略、权限或设置项。`ATPCache.normalizeArticleData()` 清洗 `textAttachments` 后会同步重算 `hasTextAttachments` 和 `textAttachmentCount`；如果旧缓存只剩脏附件，状态和计数会清零；如果是 Discuz 无 URL 需重提取 marker，则继续保留。验证脚本补行为回归和静态规则。
- 1.14.67：修复旧文章缓存里的 TXT 附件数组清洗边界，不调整图片加载策略、权限或设置项。`ATPCache.normalizeArticleData()` 现在会过滤空 URL、非 http(s) 协议和重复附件，补齐安全默认 `source/name`，丢弃无效 `pageUrl`，并按共享 TXT 附件上限截断，避免旧缓存脏附件继续进入解析链路。验证脚本补行为回归和静态规则。
- 1.14.66：小幅重构资源 payload 判断，不调整图片加载策略、权限或设置项。`SharedUtils.hasResourcePayload()` 现在只统计已归一化后的资源组和密码，不再调用 `countResources()` 触发二次归一化，减少资源面板、renderer 和 loader 频繁判断时的重复清洗开销。验证脚本补静态回归。
- 1.14.65：修复密码归一化对中文无效占位的显式过滤边界，不调整图片加载策略、权限或设置项。`SharedUtils.isInvalidPasswordValue()` 现在直接识别“无/无密码/暂无/见图/看图/见截图”等占位，避免旧缓存或异常来源中的 password-only 占位依赖乱码正则而漏判。验证脚本补 Unicode 中文占位回归，并确认真实密码不会被误删。
- 1.14.64：修复 background 侧 TXT 附件 payload 判断不一致，不调整图片加载策略、权限或设置项。TXT 中转页追踪结果和最终缓存写入现在都统一使用 `SharedUtils.hasResourcePayload()`，避免无效密码占位绕过 `normalizePasswords()` 后仍按 password-only 有效结果写入缓存。验证脚本补静态回归，禁止回退到原始 `passwords.length` 判断。
- 1.14.63：修复旧缓存或异常来源中的无效密码占位导致的 password-only 误判，不调整图片加载策略、权限或设置项。`SharedUtils.normalizeResources()` 现在会通过 `normalizePasswords()` 清理密码数组，过滤“无/无密码/[emailprotected]”等占位和重复值；`hasResourcePayload()` 因此不会把无效 password-only 缓存当作有效资源。验证脚本补行为回归。
- 1.14.62：修复 loader 收尾缓存写回的 password-only 边界，不调整图片加载策略、权限或设置项。线程首屏完成、整帖完成和重图 stop-loss 完成时，完整缓存写回判断统一使用 `SharedUtils.hasResourcePayload(ts.resources)`，避免只解析到密码的资源在 loader 收尾阶段按“无资源”处理。验证脚本补静态回归。
- 1.14.61：修复 password-only 结果在“复制时附带密码”关闭时点击“复制密码”会复制空内容的问题，不调整图片加载策略、权限或设置项。资源面板把显式“复制密码”和“复制全部”拆成不同路径；“复制密码”始终复制有效密码，“复制全部”继续按设置决定是否附带密码。验证脚本补专用复制路径静态回归。
- 1.14.60：修复 TXT 附件 password-only 边界，不调整图片加载策略、权限或设置项。共享 `SharedUtils.hasResourcePayload()` 会把资源链接或解压密码都视为有效 payload；content 扫描、renderer TXT 解析状态和资源面板展示统一使用该语义，避免只解析到密码时误报“未解析到资源链接”。资源面板和内联资源栏支持仅密码结果，并提供“复制密码”入口；验证脚本补静态回归。
- 1.14.59：补齐 content logger 日志索引维护的脏值过滤，不调整图片加载策略、权限或设置项。`Logger.flush()` 更新 `atp_logs_content_keys` 时会过滤非字符串、索引 key 本身和不符合 `atp_logs_content_<timestamp>` 形态的条目，避免旧污染索引被继续写回或因 `key.indexOf` 抛错。验证脚本补 content logger VM 脏索引回归。
- 1.14.58：补齐 popup 脏日志索引的非字符串边界，不调整图片加载策略、权限或设置项。`isLogKey()` 和 `isContentLogKey()` 会先确认 key 是字符串，再做前缀判断；如果 `atp_logs_content_keys` 被污染成包含 `null`、数字等值，日志读取会忽略这些条目而不是抛错。验证脚本的脏索引样例新增 `null` 和数字条目。
- 1.14.57：修复 popup 日志 key 发现边界和仓库说明，不调整图片加载策略、权限或设置项。popup 不再把 `atp_logs_content_keys` 索引本身当作 content 日志 key，读取日志时也只合并对象 entry，避免脏索引导致空白日志条目和计数偏高；`CLAUDE.md` 改为说明 `.claude/skills/` 只用于本地 Claude workflow，不作为仓库可复用 workflow 目录。验证脚本补脏日志索引和 CLAUDE 说明回归。
- 1.14.56：继续补齐日志脱敏盲点，不调整加载策略、权限或设置项。content/background 入库和 popup 旧日志导出现在会同时清洗对象 key 中的 URL，避免结构化日志或旧 JSON `data` 出现 `{ "https://x/a.jpg?secret=...#h": 1 }` 时从 key 泄露 query/hash；对象值仍使用原字段名判断 URL 类字段，脱敏后 key 碰撞时会加短数字后缀防止覆盖。验证脚本补 content/background、嵌套对象 key、popup 旧 `fields` 和旧 JSON `data` 的回归样例。
- 1.14.55：继续补齐日志入库侧隐私边界，不调整加载策略、权限或设置项。content/background 的普通字符串日志现在会和 popup 导出侧一样扫描 `https://`、协议相对 URL 和裸域名 URL，写入 storage 和输出控制台前统一去除 query/hash，避免旧的 `sanitizeLogText()` 只处理 `http(s)://`。验证脚本补 content/background 普通字符串中 `//cdn.example/a.jpg?token=...`、`img.example/a.jpg?token=...`、`example.com?token=...` 的回归样例。
- 1.14.54：继续收紧 popup 旧日志导出侧隐私边界，不调整加载策略、权限或设置项。导出头部摘要现在也会对事件统计、Host 统计、等级统计等 key 做二次 URL 脱敏；导出行和查看行里的 `src`、`lv`、`type`、`sessionId`、`pageHost` 等元字段也按旧日志不可信处理，统一去除 query/hash。验证脚本补完整摘要头和这些元字段的回归样例。
- 1.14.53：继续补齐日志隐私和可靠性边界，不调整加载策略、权限或设置项。popup 查看/导出日志时会对旧日志做二次 URL 脱敏，覆盖结构化 `fields`、旧 JSON `data`、普通文本和消息中的 query/hash；background logger 增加循环引用保护，循环对象会保留已脱敏字段和 `[Circular]` 标记，不再降级成 `[object Object]`。验证脚本新增 popup 旧日志导出脱敏行为测试，并补 background 循环对象 URL 脱敏回归。
- 1.14.52：补齐日志可靠性和验证覆盖，不调整加载策略、权限或设置项。content logger 归一化结构化字段时增加循环引用保护，循环对象会写入安全标记，不再因日志调用打断业务路径；验证脚本新增 content 循环对象样例，并新增 background logger VM sandbox，真实执行 `BGLOG` 写入 `atp_logs_bg` 后检查结构化、嵌套、数组和普通文本 URL 脱敏。
- 1.14.51：补齐 1.14.50 日志脱敏的边界行为，不调整加载策略、权限或设置项。`Logger.sanitizeUrl` 对空值直接返回空字符串，避免空 `url/src/href` 被误记为当前页面地址；无协议或非法 URL 不再借当前页面补全，只裁剪 query/hash 后保留原始路径形态。验证脚本新增空 URL、`undefined`、`null`、无协议 URL 和非法 URL 回归检查，使用说明同步更新本版诊断脱敏说明。
- 1.14.50：继续收紧 1.14.49 的日志隐私边界，不调整加载策略、权限或设置项。content logger 现在会按 URL 类字段名统一脱敏结构化字段，同时扫描普通字符串和 object fallback `data` 中的内嵌 URL；background logger 入库前也统一脱敏，并把 TXT 附件/文章抓取日志中的原始 URL 截断改为脱敏 URL。验证脚本补带 query/hash 的结构化、嵌套、数组和纯字符串日志样例，防止 popup 导出重新漏出访问参数。
- 1.14.49：本版不调整加载策略，只收紧发布风险、storage 异常边界和日志可靠性。本地工具目录 `.claude/`、`.opencode/`、`.codex/` 加入忽略，验证脚本会阻止 `.agents/`、`.claude/`、`.opencode/`、`.codex/` 被 Git 跟踪；settings 读取失败时改为 fail closed 安全停用；停用当前页会先 flush 日志；content/background 日志增加字节预算裁剪和一次裁旧重试；日志 URL 默认去除 query/hash，减少导出日志暴露访问参数。
- 1.14.48：根据 1.14.47 测试日志复查，确认“不行”的失败集中在 `image.imx.to`，普通图床没有失败。失败 URL 多数不是 404，而是图床首响应约 3 秒且原图体积较大，导致 stop-loss 的 1.8 秒窗口过早判死。本版只调整轻量缩略全重图 stop-loss：低并发和 2 次 fallback 上限保持不变，单图 stop-loss 超时放宽到 3.5 秒；第二次 fallback 允许复用深度跳跃采样探到候选池后段，并新增 `heavyStopLossDeepRescue`、`heavyStopLossDeepRescueEligible`、`maxHeavyStopLossDeepRescuePickedIndex` 诊断字段。普通图/弱图通道、全局并发、资源提取、manifest 权限和设置项不变。
- 1.14.47：根据 1.14.45 最后一版测试日志继续处理轻量缩略重图 pending/stale 拖尾。轻量缩略重图独立近屏预热距离从固定约 2400px 改为 `max(2400px, 4 * viewport height)` 自适应，仍只作用于“重图优化 + 轻量缩略 + 重图后台任务”，普通图床和弱图床不受影响。日志新增任务创建/当前距离、`preloadMissReason`、按 `queueKind` 聚合的 pending 年龄、预热注册/触发累计和实际自适应 margin，方便下一轮判断是未进预热范围、进范围但无槽位，还是滚动后才触发。
- 1.14.46：新增 `HANDOFF.md` 交接文档，集中说明当前稳定基线、核心模块职责、近期轻量缩略重图优化脉络、日志字段解读、测试重点、公开仓库同步注意事项和后续优化方向。本版仅补充维护文档，不改变图片加载、资源提取、渲染、并发或设置行为；当前功能逻辑沿用 1.14.45。
- 1.14.45：继续处理轻量缩略重图“看见才开始加载”导致的速度不足。新增仅作用于轻量缩略重图后台任务的独立近屏预热观察器，提前约 2400px 进入加载调度，但普通图床/弱图床仍走原 viewport 懒加载边界；轻量缩略重图在普通图仍有工作时的高扇出通道从硬性 1 路改为最多 3 路软保护，仍受总后台并发、重图并发和 host 冷却约束。日志补充 `lightweightPreload*`、`maxPendingAgeMs`、`stalePendingCount`、`heavyOrdinaryPressureSoftened` 等字段，popup 导出优先使用结构化字段，减少截断影响。
- 1.14.44：根据最新日志继续处理“轻量缩略重图后台/viewport 任务排队太久，最后滚到视口才集中加载或失败”的拖尾问题。轻量缩略后台重图如果等待超过 60 秒，启动时会标记为 `heavyStaleBackground`，单次超时收紧到 6 秒，并取消该槽位额外的高扇出重图 fallback，避免过期任务用 8+8 秒继续占满重图通道。日志摘要新增 `heavyStaleBackground` 和 `maxHeavyStaleWaitMs`，下一轮可以直接判断慢加载是否来自 stale 队列拖尾；普通图、弱图、首屏、均衡模式和手动重试不受影响。
- 1.14.43：合并修复日志时间误导和全坏重图后台拖队列问题。日志 `ts` 现在使用本地时间，额外保留 `tsUtc`、时区偏移和时区名；popup 导出头与每条日志都会标明 UTC/时区，文件名也改用本地时间。加载策略上，轻量缩略全重图帖如果首屏已经全失败、没有普通候选、且高扇出重图 host 正在冷却，后台补齐会直接进入 `heavy_bg_stop_loss`，把剩余后台槽位标记为失败并停止继续排坏链，避免翻页时被全坏 `image.imx.to` 长队列拖住。
- 1.14.42：根据 1.14.41 日志复查，确认深度跳跃救援已经能扫到候选池后半段，当前主要问题转为 `image.imx.to` 这类高扇出重图 host 在坏链密集时仍会用较长候选链和较长超时拖住页面。本版只在“重图优化 + 轻量缩略 + 全重图候选 + host 冷却 + 已有失败证据”的路径启用止损：首屏/手动重试收敛到更少候选和更短超时，后台补齐仍保持单候选快失败，普通图/弱图/混合普通候选不受影响。日志同步记录 `heavyStopLoss`、`timeoutMs`、`coolingTimeoutMode` 等字段，便于下一轮实测判断止损是否命中。
- 1.14.41：根据 1.14.40 实测日志复查，确认深度跳跃救援已触发并扫到候选池后半段，但 `fallback_pick` 明细因为 content logger 只保留前 45 个字段，导致 `pickedIndex`、`heavyDeepRescue`、`rescueStrategy` 等关键字段常被截掉，只能从摘要里间接判断。本版不改变加载策略，只把重图救援、host 冷却、候选位置和队列压力字段提升为优先保留，并把结构化字段上限提高到 80，方便下一轮直接定位是候选全坏、救援不足还是调度约束过强。
- 1.14.40：根据 1.14.39 实测截图和日志，继续修正全重图轻量缩略下的坏链密集问题。日志显示冷却态扩展救援已生效，但多个槽位仍共用顺序 `fallbackIdx`，会集中消耗前 30-40 张坏链，碰不到 66/70/118 张候选池后半段。本版只在“轻量缩略 + 全重图 + host 冷却 + 首屏/手动重试 + 无普通候选可替换”路径启用深度跳跃采样，救援次数仍受原上限控制；后台补齐、普通图床和混合普通候选逻辑不变。日志摘要新增 `heavyDeepRescue`、`maxHeavyDeepRescuePickedIndex` 和采样跨度字段，便于下一轮确认是否扫到候选后半段。
- 1.14.39：根据 1.14.38 实测截图和日志，修正全重图轻量缩略下坏链密集时过早失败的问题。日志显示重图 host 冷却已生效，但首屏槽位在 `fallbackLimit=2` 后直接显示失败，占用大量灰色失败占位；本版只在“轻量缩略 + 全重图 + host 冷却 + 首屏/手动重试”路径放宽受控救援次数，让它继续从后续候选里找可用图。重图候选失败准备切换 fallback 时也会立即计入 host 健康度，更早触发冷却和扩展救援；后台补齐仍保持 1 次救援，普通图床逻辑不变。
- 1.14.38：根据最新混合重图日志，新增高扇出重图 host 健康度降速。`image.imx.to` 连续失败后只对重图通道进入短冷却，把有效重图并发临时压到小额并发，避免坏/慢 host 长时间占满全部重图通道；普通图床通道、普通队列和手动重试不走这套熔断。日志摘要同步记录 `heavyHostCooling`、`heavyHostLimited`、`heavyHostCooldownRemainingMs` 等字段，方便下一轮实测直接区分 host 冷却、队列堆积和 viewport 懒加载。
- 1.14.37：按最新日志分析继续强化诊断，不改变加载策略。失败图片日志现在会记录任务年龄、排队等待、队列来源、fallback 次数/上限、线程状态、首屏/后台队列、viewport pending、重图通道和滚动延迟快照；viewport 懒加载会记录 pending 等待、进入视口状态、隐藏页强制加载和 slot retry 次数；`diagnostic_summary` 也会汇总队列峰值，方便继续判断快速滚动时是图床失败、队列堆积还是离屏懒加载延后。
- 1.14.36：继续处理轻量缩略第二行坏链等待过久；后台补齐阶段的重图单槽救援从 2 次降到 1 次，首批一行、均衡模式、普通图和手动重试不变，并在 fallback 日志中标记 `lightweightHeavyMode` / `backgroundBatch`。
- 1.14.35：轻量缩略模式仍按普通图/弱图数量展示，但重图网络启动改为分阶段：首批只启动一行，后续按行后台补齐，并通过 `lightweight_bg_batch` 日志记录批次。目标是保留 5*2 的展示效果，同时避免 `image.imx.to` 从 5 张直接扩到 10 张后放大慢响应和失败。
- 1.14.34：在“重图优化”开启且“重图缩略清晰度”为“轻量缩略”时，重图不再砍成一行，而是按普通图/弱图的显示数量展示；“均衡”和“恢复原始预设”仍保持一行重图代表图逻辑。轻量缩略 canvas 从 128px 提高到 160px，并在日志摘要中保留 `heavyLightweightPreviewMaxEdge` 便于继续调清晰度。
- 1.14.33：把“模糊优先”调整为“轻量缩略”。默认仍为“均衡”；轻量缩略模式生成固定 128px 长边 canvas 预览并释放重图原始 `src`，弱化毛玻璃 blur，让列表缩略图接近普通图床缩略图的细节水平，同时继续点击打开原图预览。
- 1.14.32：新增“重图缩略清晰度”。默认“均衡”沿用当前清晰/毛玻璃预算恢复逻辑；“模糊优先”仅在重图优化开启时生效，重图加载完成后保持毛玻璃缩略图，不再进入恢复清晰队列，点击仍打开原图预览。恢复原始预设会恢复为“均衡”。
- 1.14.31：继续把重图毛玻璃恢复策略做成可测参数；“重图兜底等待”范围放宽到 1-24 秒，“重图兜底上限”范围放宽到 820-2000MP，并新增低压恢复批量 1-6、高压/兜底恢复批量 1-4。popup 和悬浮面板新增“恢复原始预设”，只重置重图调优参数。
- 1.14.30：继续把重图毛玻璃饥饿兜底参数开放为可测项；新增“重图兜底上限”，默认 820MP、范围 820-1220MP，仅重图优化开启时有效。
- 1.14.29：把 `visible_preview_starvation_grace` 饥饿兜底等待改为“重图兜底等待”设置项，默认 8 秒、范围 4-24 秒；仅重图优化开启时可调，方便继续实测不同等待窗口。
- 1.14.28：根据 1.14.27 实测反馈将 `visible_preview_starvation_grace` 从约 24 秒提前到约 16 秒；仍只在没有重图正在恢复时允许单张图走约 820MP 饥饿兜底，减少漏网毛玻璃等待。
- 1.14.27：继续处理 1.14.26 后少数漏网毛玻璃；新增等待约 24 秒后的 `visible_preview_starvation_grace`，只在没有重图正在恢复时允许单张图走约 820MP 饥饿兜底，并让日志摘要统计 `visiblePreviewStarvation`。
- 1.14.26：继续处理 1.14.25 后少数长期毛玻璃残留；日志显示 500MP 迟到兜底被约 512MP 的单张恢复投影卡住，因此改为约 8 秒 560MP、约 16 秒 680MP 的分级兜底，并新增 `visiblePreviewLastChance` 诊断。
- 1.14.25：在 1.14.24 的稳定方案上继续处理少数长期毛玻璃残留；可见毛玻璃等待超过约 8 秒后允许走约 500MP 上限的迟到兜底 grace，不恢复可见清晰图轮换卸载，并新增 `visiblePreviewLateGrace` 诊断。
- 1.14.24：根据最新满屏重图实测日志修复清晰/毛玻璃来回闪；不再用可见清晰图轮换卸载来给毛玻璃腾预算，改为等待后在约 320MP 上限内走稳定 grace 恢复，并新增 `visiblePreviewStableGrace` 诊断。
- 1.14.23：根据 `forum-49-9` 日志修复全重图帖首批候选失败后直接 0/5 的问题；`image.imx.to` 全重图帖子没有普通候选时，允许每个槽位少量尝试后续重图候选救援补位，并补充 fallback miss/skip 诊断。
- 1.14.22：根据用户反馈“原图/毛玻璃横条来回切换”继续修正重图可见恢复；重图刚恢复为清晰图后会进入短暂稳定窗口，可见区预算释放和可见毛玻璃轮换都会跳过这批刚恢复的清晰图，避免 `restore_loaded` 后立即卸载造成闪烁。
- 1.14.21：根据受控浏览器日志和代码复查继续修正重图毛玻璃恢复；恢复中的隐藏图片不再计入清晰图 MP 预算，避免 `restoreLoading` 既看起来仍是毛玻璃又占住可见区预算，同时日志区分恢复中 MP。
- 1.14.20：继续修复可见毛玻璃长期不恢复；当可见占位等待过久且预算仍被已稳定清晰图占满时，会每轮最多释放一张较远清晰重图并短暂 hold，为超时占位腾出恢复空间，避免恢复队列反复归零。
- 1.14.19：修复可见重图长期停在毛玻璃占位的问题；预算阻塞的可见预览会持续重试，等待超过短窗口后允许小幅 MP grace 恢复，并在日志摘要中记录可见预览等待、defer 和 grace 次数。
- 1.14.18：按实测反馈继续提高“毛玻璃到清晰图”速度；保持低压 fast lane 每批 2 张不变，只把低压恢复间隔从约 180ms 降到约 90ms，不放宽滚动中保护和高压预算。
- 1.14.17：在 1.14.16 的低卡顿基础上加快清晰图恢复；滚动停止且 MP 压力低时允许低压 fast lane 每批恢复 2 张小/中图，间隔约 180ms，遇到大图或接近预算仍退回单张慢恢复。
- 1.14.16：根据 1.14.15 实测继续压“清晰重图恢复”峰值；重图 load 完成后先进入预算/预览再露出清晰图，可见区预算收紧到约 180MP、恢复硬预算约 150MP，并让视口内低 MP 图片优先恢复，减少超大图先闪出再卸载。
- 1.14.15：继续处理“玻璃模糊预览要滚出当前范围才出现”；viewport 懒加载保留 loading 到真实 load 完成，重图初始加载/恢复等待/预算延迟时都会先显示低压玻璃占位，并在日志里区分 canvas 预览和 fallback 占位。
- 1.14.14：针对用户反馈“玻璃模糊预览有时要滚出当前范围才出现”，重图首次加载完成后立即预生成隐藏的 40px 模糊 canvas，恢复成功后也刷新预览缓存，让预算释放或恢复被挡时可以直接显示预览。
- 1.14.13：重图页高频日志改为 2 秒 `diagnostic_summary` 聚合摘要；常规图片开始/成功、defer、重图 unload/restore/state 不再逐条写入 storage，失败、fallback、retry 和恢复错误仍保留明细，目标是降低日志打满和 storage 写入对调优的干扰。
- 1.14.12：根据 1.14.11 日志继续压重图渲染峰值；可见区预算从约 320MP 前移到 260MP，恢复硬预算从 240MP 收紧到 220MP，80MP+ 超大图恢复间隔提高到 900ms，并把预算释放改为每轮最多 4 张、120ms 后续 reconcile，减少同一瞬间批量生成模糊预览和释放 `src` 的主线程压力。
- 1.14.11：阶段二点五补上重图释放后的模糊低压预览层；重图释放 `src` 前尽量生成 40px canvas 预览，卸载后保留可辨认的模糊画面，恢复期间继续保留预览，原图 `load` 后再切回清晰图。
- 1.14.10：根据 1.14.9 最新实测继续收紧重图近屏恢复预算；恢复范围硬预算从约 300MP 降到 240MP，软压力从 240MP 前移到 200MP，目标是避免离屏/近屏先恢复到 250MP+ 后一滚入视口形成可见区峰值。
- 1.14.9：阶段二第三步继续降低重图恢复瞬时解码压力；在 240MP 可见区硬预算前增加 200MP 软压力档，恢复范围也在 240MP 起提前放慢，并补充恢复压力日志字段，便于继续根据实测判断卡顿来源。
- 1.14.8：阶段二第二步修正可见重图保护时机；重图进入视口后需要稳定显示约 1.2 秒才会被锁定保护，刚出现的超大图仍可被 320MP 可见区预算释放，恢复加载中的隐藏图片也不会提前获得稳定保护。
- 1.14.7：阶段二继续压重图可见区峰值；新增可见区 320MP 上限保护，刚进入视口且尚未稳定显示的重图如果会把 `heavyVisibleMP` 推得过高，会先保持占位；已经稳定显示在视口里的重图会被标记保护，不作为本轮释放对象。

- 1.14.6：针对混合页日志继续收紧重图压力；普通图和重图共享总 active 上限，避免普图高并发时重图额外叠加；重图可见区恢复增加 MP 压力预算，当前视口已有足够重图解码量时，新的可见重图先保持占位并放慢恢复，减少 `render_restore` / `render_unload` 抖动。

- 1.14.5：重图渲染预算不再卸载当前视口内已显示的图片，避免滚动时可见图闪成占位；图片候选拆成显示图/预览图，列表优先加载真实缩略图或小 `srcset`，点击预览仍打开原图；如果显示图和预览图不同，列表加载按显示图通道调度，重图判定和预览仍按原图 URL。

## 项目目标

在文章列表页自动抓取文章内图片并显示缩略图，同时提取帖子内资源链接，避免被标题党欺骗。

## 已确认需求

- Manifest V3，支持 Edge 和 Chrome
- 列表页自动扫描帖子行，提取图片 URL，加载缩略图
- 提取帖子内 ED2K、磁力、网盘链接和附带密码，支持列表页直接复制
- 可读取帖子内可访问的 TXT 附件，识别后进入独立并发 2 的自动 FIFO；单帖附件串行读取，成功直接复制，失败后才显示手动兜底
- 首屏优先加载，后台补齐剩余
- 支持同源直接 fetch、跨域由 background 代理抓取
- 缓存已加载图片 URL，减少重复请求
- 悬浮窗（右下角 launcher）用于常用参数调整
- 弹窗（popup）用于全局启停、站点禁用、缓存清理、日志查看
- 右侧资源栏用于显示当前帖子资源类型数量，并复制单类或全部链接
- 设置项由统一 schema 驱动，帮助视图由 schema 生成
- 悬浮窗使用 Shadow DOM 隔离样式

## 最近需求变更
- 1.14.44：用户补充当前设置较激进但“加载时间有点久”。最新日志显示不是 host 全冷却，而是轻量缩略后台重图进入 viewport 懒加载后保留很老的排队时间，部分任务等到 120 秒级才启动并失败。本版优先收敛这些 stale 后台重图任务的启动后耗时，并增加日志字段方便下一轮确认。
- 1.14.43：用户确认日志文件名显示为 5/24 但实际测试发生在 5/25 凌晨，要求和上一轮全坏重图问题一起修复。本版明确区分本地时间与 UTC，并让轻量缩略全坏重图后台补齐在 host 冷却后快速止损，下一轮重点看 `heavy_bg_stop_loss` 是否出现以及普通/弱图通道是否继续流畅。
- 1.14.42：用户测试全重图翻页仍出现第二行条纹占位和坏链失败等待，要求继续按日志定位。日志显示深度救援已覆盖候选池后半段，但 `image.imx.to` 成功率极低且失败耗时长，因此本版从“继续加深扫描”转为“冷却态坏重图止损”，目标是让坏链密集帖更快释放通道，同时保留日志字段验证是否真的进入 stop-loss。
- 1.14.41：用户同意先强化日志再继续调策略。本版修正 fallback 明细字段被截断的问题，把深度救援、候选 index、host 冷却和队列压力字段置前保留，目标是下一轮实测能逐槽判断失败原因。
- 1.14.40：用户继续反馈 1.14.39 后仍有全重图老帖出现大量失败占位。日志显示扩展救援次数已经生效，但顺序 fallback 只能覆盖候选前段，坏链集中在前 30-40 张时仍会失败。本版在冷却态全重图首屏/手动重试路径加入深度跳跃采样，目标是在不增加救援总等待的前提下扫到候选池后半段。
- 1.14.39：用户发来截图显示部分全重图帖在轻量缩略下仍出现 `0/10`、`3/10` 大量失败占位。日志确认不是普通图阻塞，也不是渲染预算，而是 `image.imx.to` 成功/坏链混杂时每槽救援上限过低，且 host 健康度之前等槽位最终失败才计数。本版针对首屏/手动重试增加冷却态扩展救援，并让候选级失败提前喂给 host 健康度，目标是减少可用候选仍很多时的过早失败。
- 1.14.38：用户同意在强化日志后继续处理 `image.imx.to` 坏/慢重图 host 占满通道的问题。本版不把重图 host 加回普通域名熔断，而是新增重图专用健康度：连续失败后进入降速冷却，成功后逐步恢复，目标是在坏链集中时释放后续调度机会，同时保持普通图床顺滑。
- 1.14.37：用户怀疑快速滚动是否导致队列堆积、部分图片被挤出。日志复查显示没有 drop/cancel/discard 证据，失败更像图床超时和 fallback 耗尽；本版先强化日志系统，让后续实测能直接看到失败时是否在视口、pending 了多久、队列是否堆积、重图通道是否占满，以及任务是否来自轻量缩略后台补齐。
- 1.14.36：用户截图显示轻量缩略下部分老重图帖仍会 `7/10 失败3`。日志确认失败集中在后台补齐槽位，每槽原图加 2 次重图救援后仍 `viewport_fail`，耗时约 24-25 秒。本版减少后台补齐坏链救援次数，让坏链更快结束并释放重图通道。
- 1.14.35：用户实测 1.14.34 后反馈加载速度下降，截图显示轻量缩略下重图帖出现 `4/10 失败6`。日志显示渲染压力正常、预览生成正常，但 `image.imx.to` 平均约 4.9 秒、最高约 24 秒且失败被 10 格显示数量放大。本版不回退显示数量和 160px 清晰度，改为首批一行、后续按行分批补齐。
- 1.14.34：用户希望轻量缩略模式既然已经不再显示原图清晰缩略，就不要继续套用重图“一行代表图”的显示数量；此版只在轻量缩略下恢复普通图显示数量，切回均衡或恢复原始预设则严格回到旧的一行逻辑，同时把轻量缩略固定长边从 128px 提到 160px。
- 1.14.33：用户反馈“模糊优先”太像毛玻璃，希望是原图缩小后只损失一点细节、接近普通图床缩略图的效果。本版不增加新质量设置，先固定 128px 轻量缩略用于实测，减少变量。
- 1.14.32：用户希望不再增加“清晰优先”，只在重图优化下增加“均衡 / 模糊优先”。此版保留 1.14.31 作为均衡逻辑；模糊优先会跳过恢复清晰批量、兜底等待和兜底 MP 逻辑，优先换取满屏重图滚动流畅度，同时保留点击原图预览。
- 1.14.31：用户希望基于当前毛玻璃缓冲继续更激进测试，把兜底等待下限降到 1 秒、兜底 MP 上限最高放到 2000，并把“每批恢复几张”拆成可配置项。此版保持默认值接近原始稳态，同时允许手动提高低压/高压批量；新增恢复原始预设按钮，方便测试后快速回到当前基准。
- 1.14.30：用户希望饥饿兜底 MP 上限也可调。此版新增“重图兜底上限”，允许在 820-1220MP 内测试不同峰值，同时保留单张恢复约束。
- 1.14.29：用户希望饥饿兜底能更短，或做成可输入项自行测试。此版新增“重图兜底等待”，默认 8 秒，可填 4-24 秒，仍只影响开启重图优化后的重图毛玻璃恢复。
- 1.14.28：用户反馈 1.14.27 方向对但约 24 秒等待太久；此版把饥饿兜底提前到约 16 秒，和最后兜底窗口对齐，继续保持单张恢复和不轮换卸载可见清晰图。
- 1.14.27：用户反馈 1.14.26 好一些但仍有少数毛玻璃残留。此版不恢复会导致闪烁的可见清晰图轮换卸载，而是在等待约 24 秒后加入单张、无并行恢复的饥饿兜底，目标是清理固定 MP 上限下的漏网占位。
- 1.14.26：用户反馈 1.14.25 好一点但截图仍有少数毛玻璃。日志显示 `maxHeavyVisibleMP` 约 462MP、`maxHeavyMaxVisibleMP` 约 50.3MP、`maxVisiblePreviewWaitMS` 已超过 40 秒，但 `visiblePreviewLateGrace` 仍为 0；判断为 500MP 上限无法容纳再恢复一张。此版改为分级迟到兜底，减少长时间残留，同时继续避免闪烁旧路径。
- 1.14.25：用户反馈 1.14.24 效果很好但仍有少数漏网毛玻璃。本地日志显示 `maxHeavyVisibleMP` 约 355MP、`maxVisiblePreviewWaitMS` 持续增长到数十秒以上、`visiblePreviewStableGrace` 为 0，判断为 320MP 稳定 grace 上限仍会挡住少量已等待很久的可见占位。本版增加等待约 8 秒后的迟到兜底 grace，目标是减少残留而不回到闪烁逻辑。
- 1.14.24：用户反馈 1.14.23 在满屏都是重图时仍会一闪一闪。本地扩展日志显示 `restoreErrors:0`，但 `visible_preview_rotate_unload` 在 2 秒窗口内可出现 5-11 次，判断为“为了恢复毛玻璃而主动卸载可见清晰图”的轮换策略导致闪烁。本版停止可见清晰图轮换卸载，改为稳定超额恢复和对应诊断。
- 1.14.23：用户截图显示 `forum-49-9` 多个老重图帖出现“重图优化 完成 0/5 失败5”。本地扩展日志显示 `image.imx.to` 连续 `direct_fail`，重图帖 `sourceCandidates` 有 47/94 张但没有 `fallback_pick`；判断为全重图候选时补位策略只找普通候选，找不到就直接失败。本版保留普通候选优先，但为全重图帖开放受限重图救援补位。
- 1.14.22：用户反馈 1.14.21 比上一版好，但仍会出现“原图 → 模糊 → 原图 → 模糊”的横条来回；代码复查判断为恢复成功后立即触发 `restore_loaded` reconcile，刚露出的清晰图尚未进入 `visibleLocked` 稳定保护，就可能被可见区预算再次释放。本版加恢复后稳定窗口，并补充 settle MP 诊断。
- 1.14.21：用户要求看日志并判断逻辑问题；受控 Chrome 复现页没有稳定复现长期糊住，但日志显示可见等待会短暂出现，代码复查发现 `restoreLoading` 隐藏图仍被算进清晰图预算。本版将恢复中 MP 单独诊断，不再挤占清晰图预算。
- 1.14.20：用户截图显示 1.14.19 仍会在“重图优化 完成 5/5”后出现部分可见缩略图长期毛玻璃；判断为可见区清晰 MP 已超过 grace 上限，单纯重试无法腾出预算。本版增加可见占位超时后的公平轮换，不影响普通图通道。
- 1.14.19：用户反馈 1.14.18 比上一版好，但仍会出现部分图片一直停在模糊占位；判断为可见重图被预算挡住后队列可能归零，缺少持续重试和 bounded grace。本版只修恢复调度和诊断，不扩大普通图逻辑。
- 1.14.18：用户反馈 1.14.17 恢复更快且无明显卡顿，但清晰图出现速度仍不足，希望再提一倍试试；本版选择缩短低压恢复间隔，而不是增加单批张数，以降低解码峰值反弹风险。
- 1.14.17：用户反馈滚动卡顿已经很好，但“毛玻璃到真实图片”恢复太慢；日志显示 `restoreQueue` 会堆积、恢复常以单张慢节奏推进。本版只提高低压 idle 恢复吞吐，不放宽滚动中保护和高压预算。
- 1.14.16：1.14.15 反馈“比上一版好，但还是不太行”；日志显示预览命中已经正常，主要剩余问题是 `heavyRestoreQueued` 偏高、`visible_mp_defer` 反复、`heavyVisibleMP` 常贴近 190-216MP。本版不改网络并发和资源提取，改为更早纳入渲染预算、更低清晰图 MP 峰值、低 MP 优先恢复。
- 1.14.15：1.14.14 仍存在“当前可见范围卡住，滚出后才出现玻璃感”的反馈；判断为初始/恢复等待阶段没有可绘制 canvas 且 viewport 懒加载提前移除了 loading。本版只补低压视觉占位和诊断字段，不继续改变并发、候选提取和 MP 阈值。
- 1.14.14：1.14.13 后加载和日志有所改善，但模糊预览仍偏“后置触发”；本版不继续压 MP 预算，先把预览生成前移到图片加载完成和恢复完成时，避免用户必须滚出当前范围才看到玻璃预览。
- 1.14.13：1.14.12 日志显示 `heavyVisibleMP` 已压到约 243MP，但 50 秒仍打满 800 条；本版不改变加载和渲染策略，只把高频诊断合并为每 2 秒摘要，摘要保留 host 耗时、MP 峰值、队列峰值、预览命中和错误计数，便于后续判断是否继续压 `heavyRangeMP` 或进入 host 自适应策略。
- 1.14.12：1.14.11 实测日志显示模糊预览命中率 100%、恢复失败 0，但 `heavyVisibleMP` 仍贴近 320MP 且释放/恢复会成批出现；本版不再调整网络并发，专门收紧可见区/恢复预算，并用小批次释放降低 canvas 预览生成和 `src` 释放的瞬时抖动。
- 1.14.11：用户反馈 1.14.10 在重图释放后会出现“完成 5/5 但缩略图全灰”的体验问题；本版不改变并发、图床识别和 MP 预算，先在释放前保留小 canvas 模糊预览，并补充 `previewKept` / `render_restore_error` 日志，便于下一轮判断预览命中率和恢复失败情况。
- 1.14.10：最新 1.14.9 日志显示 `heavyVisibleMP` 峰值约 257.5MP，来源是恢复范围先堆到 257.5MP，随后滚入视口；本版只下调恢复范围预算，继续保留现有并发、候选提取和可见区保护逻辑。
- 1.14.9：根据 1.14.8 实测，`heavyVisibleMP` 已从 400MP+ 降到约 240MP 内，但仍可能在 200MP 以上连续恢复多张重图；本版不改并发和提取，只在接近可见区/范围预算时提前放慢恢复节奏，并提高日志结构化字段上限。
- 1.14.8：根据 1.14.7 实测日志，`visible_budget_unload` 未触发且 `heavyVisibleMP` 仍可冲到约 447MP，判断为 `visibleLocked` 过早设置；本版改为延迟锁定稳定可见重图，并补充 `heavyVisibleLockDelayMS` 诊断字段，重点验证可见区峰值和图片闪烁是否改善。
- 1.14.7：按阶段二路线继续小步优化，重点验证 `heavyVisibleMP` 峰值是否从 500MP+ 下降；新增 `visible_budget_unload` 诊断，实测后根据日志判断是否继续收紧可见区预算或调整保护阈值
- 1.14.6：根据混合重图/弱图页面日志，处理 `ordinaryActive` 打满时重图 active 继续叠加、以及可见重图恢复导致 `heavyVisibleMP` 过高的问题；新增 `global_limit`、`visible_mp_defer` 诊断字段，方便后续判断并发叠加和可见区解码压力
- 1.14.5：按测试反馈调整重图体验；当前视口内的已显示重图不再因预算被释放，减少滚动闪烁；提取阶段会把 `file`/`zoomfile`/`data-original`/最大 `srcset` 作为预览原图，把 `<img src>`、小 `srcset`、`data-thumb` 等作为列表显示图，优先用低解码压力的真实缩略图展示
- 1.14.4：继续优化重图滚动卡顿；在网络并发之外增加重图渲染预算，优先保留靠近视口中心的图片，超出预算的图片保持稳定占位；滚动停止后按单张队列恢复并对超大图放慢；调度日志同步输出 `heavyVisibleMP`、`heavyRangeMP`、预算上限等指标
- 1.14.2：针对重图滚动卡顿增加渲染层保护；已加载的重图缩略图离视口较远时释放 `src`，靠近视口再恢复；滚动期间暂缓新的重图启动，滚动停止约 240ms 后继续；日志补 `render_unload`、`render_restore`、`render_state`、`heavyScrollDeferred` 和 `heavyUnloaded`
- 1.14.1：按测试需要放开图片加载配置上限；首屏并发最高 30，普图后台并发最高 24，重图并发最高 12；后台加载速度新增 20ms 与 50ms 两档。本版不改变重图/普图分通道策略和渲染逻辑
- 1.14.0：重图优化开启时新增 1-3 的“重图并发”设置，默认 2；普通图床和重图图床分通道调度，普通图床 active/等待时重图保底 1，普通图床空闲后重图提升到配置值；popup/悬浮窗在关闭重图优化时禁用该设置；验证脚本补相关回归检查
- 1.13.99：日志系统升级为轻量结构化诊断；content 日志记录会话、页面、版本、事件类型和字段，loader/renderer/content 补图片调度关键事件，popup 支持最近会话、告警/错误、图片调度、重图相关过滤与导出摘要；验证脚本补相关回归检查
- 1.13.98：根据最新日志继续处理重图；高扇出重图图床收紧为单通道，重图失败后只允许补位到非高扇出普通图床候选，并会回扫完整候选池寻找普通图床，找不到则释放当前槽位而不是继续试另一张重图；验证脚本补相关回归检查
- 1.13.97：根据最新日志继续收紧重图调度；高扇出图床只保留小额专用并发，混合普通图床等待时只留 1 个重图槽；重图失败补位优先跳到非高扇出普通图床候选，避免连续尝试同一重图图床；验证脚本补相关回归检查
- 1.13.96：根据本地日志继续收紧图片调度；高扇出重图图床使用更短挂起超时，重图 active 槽高压时停止同槽候选补位，且高频图片 debug 日志节流汇总，减少 storage 写入和日志查看开销；验证脚本补相关回归检查
- 1.13.95：高扇出重图图床加载挂起时会为普通图床任务让出首屏/后台调度槽，重图候选补位限制为每个 active 槽有限尝试，避免一个重图帖子长期占住全局并发导致下方普通图片不加载；验证脚本补相关回归检查
- 1.13.94：普通/混合图片帖保留少量隐藏候选用于失败补位，但仍只按显示上限渲染和预览；loader 的候选替换从重图专属改为有隐藏候选即可补位，减少坏链导致的失败占位铺满；验证脚本补相关回归检查
- 1.13.93：正则图片提取路径按单个 `<img>` 只保留最佳候选，避免 background/无 DOMParser 环境把 `data-original`、`srcset`、`src` 缩略图变体一起加入加载队列；图片直链判断支持代理图片 `<a href>`；验证脚本补相关回归检查
- 1.13.92：`srcset` 图片提取只选择最合适候选，避免响应式变体占满名额；图片 URL 去重保留代理图身份参数、归一签名参数名并忽略 fragment；隐藏页接管 viewport pending 占位时按空闲槽推进，避免大量重试 timer 突发；验证脚本补相关回归检查
- 1.13.91：图片 URL 去重保留签名参数时改为大小写不敏感，并补充常见 CDN 签名参数，避免 `X-Amz-Signature` 等混合大小写签名图片被误合并漏图；验证脚本补相关回归检查
- 1.13.90：图片 URL 去重保留常见签名/鉴权参数，避免同一路径下不同签名图片被误判为重复而漏图；验证脚本补相关回归检查
- 1.13.89：外部设置更新后会同步 loader 的可见性暂停状态，切换“标签页不可见时暂停/继续加载”无需等待下一次 visibilitychange；magnet hash 后无空格紧贴密码说明时也会裁掉说明；验证脚本补相关回归检查
- 1.13.88：全局图片轮询调度入口先检查暂停状态，确保“标签页不可见时暂停”同时覆盖首屏图片和后台补齐图片；验证脚本补相关回归检查
- 1.13.87：磁力链接后紧贴“解压密码/提取码”等说明时会裁掉说明文本并保留独立密码；`ed2k` 清理按 `|/` 终止符截断尾随说明，继续保护文件名内中文标点；验证脚本补相关回归检查
- 1.13.86：重图判定收紧为至少 3 张且占候选图片一半以上才触发，避免混合普通图帖误套一行重图策略；loader 注册可见性监听时立即按当前标签页状态初始化暂停标记；验证脚本补相关回归检查
- 1.13.85：隐藏标签页继续加载时，后台调度会优先推进已接管的 viewport pending 占位，减少等待占位重试 timer 的短暂停顿；验证脚本补相关回归检查
- 1.13.84：关闭“标签页不可见时暂停”后，隐藏页会主动接管切后台前已经创建的 viewport pending 占位继续加载；回到可见页面清理强制标记，普通可见页仍使用 viewport lazy；验证脚本补相关回归检查
- 1.13.83：中文标点尾随清理收紧到 HTTP/网盘/TXT/图片/附件直链场景，保护 `ed2k`/`magnet` 文件名中的中文标点不被误切；验证脚本补相关回归检查
- 1.13.82：图片直链、TXT 下载链接、Discuz 附件链接和其他资源链接在 URL 解析前统一清理中文标点/括号后的尾随说明；正则图片提取补充扫描并清理 `<a href>` 图片直链；验证脚本补相关回归检查
- 1.13.81：扫描延迟执行遇到并发处理或空候选边界时会保留并消费补扫请求；资源链接提取会清理网盘 URL 尾部中文括号/标点和紧贴的提取码说明，避免链接尾巴污染；验证脚本补相关回归检查
- 1.13.80：滚动触发扫描命中节流窗口时会补排节流到期后的扫描，避免停在新位置后短暂停住不加载后续帖子；验证脚本补相关回归检查
- 1.13.79：关闭“标签页不可见时暂停”后，隐藏标签页后台图片任务绕过 viewport 懒加载并按后台并发/速度继续直载；临时空结果退避到期后同步清理该 URL 的失败次数；验证脚本补相关回归检查
- 1.13.78：临时空结果自动重试改为按 URL 指数退避，连续失败最多退避到 60 秒；TXT 中转页可提取并放行没有 `.txt` 后缀的 `xia.ewrewej.la` 签名下载地址；验证脚本补相关回归检查
- 1.13.77：临时空结果退避重试按最早到期时间调度，扫描跳过未到期帖子时会补排下一次唤醒；修复前置提取码跨过第一个网盘链接串给第二个链接；截断 HTML 空结果不再做 15 秒短周期自动重试；验证脚本补相关回归检查
- 1.13.76：临时抓取失败、HTTP 429/5xx 或 background 超时时不再把帖子永久标记为已处理，改为 15 秒退避重试；资源提取相邻网盘链接时按当前链接就近绑定提取码且不跨过其他资源链接；补充裸域名/协议相对 `www` 网盘链接识别；验证脚本补相关回归检查
- 1.13.75：content 初始化从只等待 `window.load` 改为 DOM 可用后即调度启动，并保留 `load` 兜底，减少页面图片/广告拖慢时插件首轮扫描等待；验证脚本补相关回归检查
- 1.13.74：viewport 懒加载记录占位是否仍在视口附近，并发槽位不足后的延迟重试不会在用户滚走后继续加载离屏图片；验证脚本补相关回归检查
- 1.13.73：TXT 资源解析空结果、异常或附件链接重新提取失败后保留手动重试入口；资源面板保留失败/需手动下载提示文案；验证脚本补相关回归检查
- 1.13.72：后台图片调度在 `requestIdleCallback` 路径也遵守后台加载速度；提高懒加载占位 pending 预算避免隐藏占位卡住后续帖子后台队列；资源提取支持链接前提取码和 TXT `.txt#hash` 裸链接；验证脚本补相关回归检查
- 1.13.71：图片提取的正则和 DOM 路径都支持带 query/hash 的直链，避免签名图片链接被漏掉；预览大图增加超时保护，超时后复用 `no-referrer` 兜底再进入失败状态；验证脚本补相关回归检查
- 1.13.70：统一缩略图 `<img>` 初始化；首屏图片和手动重试使用 `eager/high` 优先级，后台补齐图片使用 `lazy/low` 优先级；viewport 懒加载复用 loader 初始化逻辑；验证脚本补相关回归检查
- 1.13.69：预览大图加载增加 token 保护，快速切换或关闭预览时忽略旧加载回调和旧延迟赋值；预览失败时自动做一次 `no-referrer` 兜底重试；验证脚本补预览 stale-load guard 和 no-referrer 重试检查
- 1.13.68：后台图片命中域名熔断时会先创建缩略图 slot 并显示可重试失败占位，不再直接吞掉后台任务导致用户看不到重试入口；验证脚本补 loader 域名熔断占位回归检查
- 1.13.67：重图候选扩展收窄为重图专属；普通图片帖子仍只按显示上限提取和打开，只有首批候选已命中重图判定时才扩大到抓取上限用于失败补位；验证脚本补“普通帖不扩展、重图帖才扩展”的回归检查
- 1.13.66：重图优化拆分抓取上限和显示上限，抓取阶段保留更大的候选池，重图模式仍只渲染一行但可从完整候选池补位；历史已成功加载的图片 URL 会优先作为代表图；文章缓存前缀升级到 `article_cache_v9_`，避免旧缓存继续只保留过少候选；验证脚本补相关回归检查
- 1.13.65：URL 解析前统一解码 HTML 实体，修复 background 正则提取路径把图片参数 `&amp;` 原样带入请求导致的加载失败；读取旧文章缓存时修复实体编码图片 URL；域名熔断不再隐藏首屏图片和手动重试，懒加载熔断跳过时保留可重试失败占位；验证脚本补相关回归检查
- 1.13.64：热重载清理旧扫描定时器，并在旧扫描结束后补发当前 generation 扫描；content/background 校验文章和 TXT 附件重定向后的最终 URL；存储设置统一清洗类型和范围；图片候选过滤非 http(s) 协议和带查询参数的 SVG；悬浮面板窗口 resize 后重新夹紧位置；验证脚本补相关回归检查
- 1.13.63：预览大图复用 loader 的 no-referrer 策略；TXT 附件同源直连按单个附件补 background 兜底；热重载/停用通过 generation 令牌丢弃旧扫描、旧图片任务和旧 TXT 回调；扫描异常会写日志并恢复状态；悬浮面板历史位置恢复时夹紧到当前窗口内；验证脚本补相关回归检查
- 1.13.62：cacheIndex 重建失败不再被伪装为空索引，content/background LRU 淘汰和 popup 清缓存会显式处理失败；早期用户交互会初始化 ATPState；悬浮设置面板区分保存失败和页面应用回调失败；验证脚本补 fake storage 行为测试
- 1.13.61：跨域 background 抓取结果会写入文章缓存并过滤 Discuz 临时附件 URL，后续按需解析可回到 background 重新提取附件入口；窄屏 inline 资源栏可在只有 TXT 附件时触发解析；文章/TXT 正文读取改为共享限长 reader；cacheIndex 区分读取失败与索引缺失，避免失败时覆盖成空索引；验证脚本补相关回归检查
- 1.13.60：日志 flush storage 失败时批次会重入队并限次重试；资源面板 panel 事件绑定加一次性保护并同步最新 threadState；`.agents/` 作为本地 agent 工具配置加入忽略；验证脚本补相关回归检查
- 1.13.59：popup 启动不再全量扫描/裁剪日志，只刷新索引内日志数量；popup/floating-panel storage 失败会提示并回滚 UI；background/cache/config/cacheIndex 补 lastError 防护；content 生命周期监听可清理；验证脚本补资源提取和日志启动回归检查
- 1.13.58：popup 读取/导出/清空日志时合并索引与 storage 实际日志 key，避免 content 日志索引并发丢失后漏读；验证脚本补日志兜底规则
- 1.13.57：首屏并发上限从 8 提高到 16，后台并发上限从 4 提高到 12；默认值不变，供高速网络用户手动调高
- 1.13.56：TXT 附件 background 等待超时改为共享预算并清理同步消息异常 timer；默认 no-referrer 图床不再重复同 URL no-referrer 重试；popup 清缓存合并 cacheIndex 与 storage 兜底扫描；验证脚本补 popup 引用和关键静态规则
- 1.13.55：`image.imx.to` 不再参与全局域名熔断；重图优化首批失败时从原始候选继续替换尝试；no-referrer 重试强制重新发起同 URL 请求
- 1.13.54：图片连续失败 3 次后不再永久暂停帖子队列；图片失败/超时时自动 no-referrer 兜底重试一次；验证脚本增加 loader 暂停回归检查
- 1.13.53：loader 状态判断拆出纯 helper，统一完成判断、状态分母和后台补齐数量计算，行为不变
- 1.13.52：新增 tools/verify.js 验证脚本；content 日志 key 建立索引；popup 清理缓存优先走 cacheIndex；缓存写入回调区分成功/失败
- 1.13.51：恢复每帖显示上限的硬上限语义，移除显示上限外的 10 张预取候选，避免设置 10 时加载状态停在 10/20
- 1.13.50：截断 HTML 结果标记为 partial，不写负缓存且不标记完整文章缓存；跨域分批大小和 timeout 常量统一到 SharedUtils
- 1.13.49：修复 TXT 附件并发硬失败状态串扰；热重载清理 loader 后台任务；跨域 background 抓取等待按分批数计算；文章 HTML 增加大小保护；popup 自动裁剪旧 content 日志 key；cacheIndex 写入失败输出告警
- 1.13.48：修复 TXT 附件临时失败缓存阻断 background 回退；文章正文读取纳入超时；content 日志改为分页面 key 并由 popup 聚合；BGLOG flush 串行化；复制 fallback 检查 execCommand 返回值
- 1.13.47：Popup 清除缓存遗漏 TXT 失败缓存前缀；cacheIndex read-modify-write 竞态改为串行队列写入；淘汰 entries 缓存在删除/写入后失效；并发淘汰记录最高 baseline 二次淘汰；BGLOG warn/error 即时 flush；sendMessage 回调检查 lastError；Previewer 键盘 preventDefault；normalizeImageUrl 参数排序
- 1.13.44：background 代理请求 Discuz TXT 附件时携带帖子来源 referrer，避免附件接口返回 HTTP403
- 1.13.43：TXT 附件真实下载地址跳转到 xia.ewrewej.la 签名链接时，background 代理具备权限继续获取并解析
- 1.13.42：TXT 附件保留来源页面 URL，同源下载携带页面 referrer；旧缓存附件会补齐帖子 URL；非标准 HTML 下载中转响应也会继续追踪真实附件
- 1.13.41：TXT 附件解析支持 Discuz 下载中转页继续追踪附件链接；资源提取支持无协议网盘链接自动补 https
- 1.13.40：关闭“标签页不可见时暂停”后进入 eager 后台加载模式，后台图片并发至少提升到 6，并绕过视口 pending 队列阻塞
- 1.13.39：关闭“标签页不可见时暂停”后，首屏外图片绕过视口懒加载，按后台并发继续主动加载；设置说明同步更新
- 1.13.38：模块级 var → const 迁移，函数内 var 保留；不影响行为
- 1.13.37：新增 cache index — getCacheStats 使用索引统计 count，evictLRU/checkAndEvict 淘汰前全量 rebuild 保证一致性，索引缺失时自动重建
- 1.13.36：图片提取双轨收敛，新增 SharedUtils.extractImages 统一入口，按 DOMParser 可用性自动派发 DOM/正则路径
- 1.13.35：context 候选附件文件名收窄匹配范围，多附件相邻时优先取 tag 属性和近距匹配
- 1.13.34：extractTextAttachments 三轮扫描合并为单轮 + 合并阶段；esc() 统一到 SharedUtils.escapeHtml
- 1.13.33：缓存淘汰从条目数（500条上限）改为字节水位淘汰（85%/75%）；写入配额失败时淘汰后重试一次；background.js 补充淘汰逻辑
- 1.13.32：scanner 排除模式和版务关键词提取为文件顶部常量；popup 标题移除 emoji
- 1.13.31：图片正则提取移至 SharedUtils 共用；同源 TXT 附件优先 content 直连、跨域走 background、同源直连失败回退 background；LRU 淘汰优先级排序方向修正；setupObserver 重试状态清理补全
- 1.13.30：负缓存过期主动删除+纳入 LRU；setupObserver 指数退避+上限+定时器清理；Loader visibility 监听禁用时移除；background onInstalled 基础前缀统一引用；Previewer 大图 onerror 提示
- 1.13.29：heavy 模式预览使用 sourceCandidates；Previewer keydown 生命周期配对；Logger flush 定时器可控启停；contain-intrinsic-size 动态计算；Popup 缓存清除引用 CACHE_PREFIXES；负缓存 TTL 独立 5 分钟；重试并发控制 acquireSlot；contain-intrinsic-height 修复
- 1.13.28：修复 defaults.js 使用 window 导致 MV3 Service Worker 启动失败，改为 globalThis
- 1.13.27：网络异常/超时不写负缓存；增加 visibilitychange/pagehide 提前 flush；flush 节流 2s→1s；正则时间保护 100ms→250ms；defaults.js 包 IIFE
- 1.13.26：新增”重图优化”设置，命中高分辨率重图图床时仅加载一行代表图，降低滚动解码压力且不截断文章缓存候选列表
- 1.13.25：扫描阶段默认跳过置顶/版务帖和“版块主题”前的管理区域，新增“跳过置顶/版务帖”设置以减少无效抓取
- 1.13.24：UI 层统一 HTML 转义（popup/floating-panel/resource-panel）；storage 写入失败 lastError 检查（cache/logger/background）
- 1.13.23：文章缓存按 key 串行写入避免 TXT 资源与 loadedUrls 交叉覆盖；图片成功后自动恢复失败暂停线程
- 1.13.22：scanner 支持视口候选过滤提前停止；资源面板接入 ATPConfig.loaded；popup 清缓存按钮语义对齐；清理 TXT 缓存前缀死常量
- 1.13.21：scanner 移除硬截断交由 content 视口过滤；缓存前缀集中到 CACHE_PREFIXES；ATPConfig.loaded 初始化状态；移除 unload 监听
- 1.13.20：文章缓存语义分离，images 固定为完整候选列表，loadedUrls 独立存储；fetcher 提取后立即缓存；TXT 常量统一到 SharedUtils；popup 帮助补渲染维护分组；timer 清理和 sendMessage 异常处理
- 1.13.19：降低滚动扫描频率，离屏缩略图面板跳过绘制，动态图片异步解码
- 1.13.18：无内容/权限受限帖子会标记为已处理，避免占用后续小批量扫描
- 1.13.17：放宽视口预取范围和每轮处理数量，减少高图片密度页面加载停顿
- 1.13.16：扫描改为视口附近小批量处理，并忽略插件自身 DOM 更新，缓解高图片密度板块滚动卡顿
- 1.13.15：修复资源栏从帖子移动到复制按钮时过早清空或回退的问题
- 1.13.14：修复双态 updateThread 条件，popup 支持未知 schema 分组
- 1.13.13：侧栏断点、扩展安装清理、scanner 提前退出等低优优化
- 1.13.12：资源栏新增悬停查看 + 点击固定双态交互
- 1.13.11：popup 设置 UI 改为 schema 动态渲染，消除双写维护问题
- 1.13.10：修复 TXT 附件缓存写入、日志并发覆盖、跨域抓取默认值和多个失败/调度边界问题

- 1.13.9：资源栏标记 TXT 来源，正文和 TXT 重复链接按 URL 去重并保留 `html+txt` 来源
- 1.13.8：TXT 附件下载遇到 HTML 中转页时，会从中转页提取真实 `.txt` 下载地址并二次读取
- 1.13.7：TXT 附件读取优先统一走 background，兼容同源附件跳转到 CDN 后被 content script 跨域限制拦截
- 1.13.6：允许读取 `dl.ldkms.la` 上的 TXT 附件下载文件，修复 CDN 附件已识别但无法解析的问题
- 1.13.5：扫描 HTML 中非 href 位置的附件下载 URL，并在资源栏显示 TXT 附件识别/解析状态
- 1.13.4：补强 Discuz TXT 附件上下文兜底识别，允许文本下载接口 Content-Type 异常但正文为纯文本时继续解析
- 1.13.3：扩展 TXT 附件识别到附件块上下文，并升级文章/负缓存前缀，避免旧缓存挡住 TXT 解析
- 1.13.2：TXT 附件资源改为渲染后异步补齐，避免附件下载阻塞缩略图和正文资源显示
- 1.13.1：新增 TXT 附件资源缓存，避免同一附件在缓存期内反复下载，并纳入缓存清理入口
- 1.13.0：新增 TXT 附件识别和读取，合并附件内 ED2K、磁力、网盘链接及密码到资源栏
- 1.12.8：修复抓取失败、非 HTML、登录重定向和 Cloudflare 拦截时返回结构不一致导致列表处理中断
- 1.12.7：收紧 mailto 密码前缀拼接，并支持 `www.98T.la@` 这类后缀 @ 场景
- 1.12.6：修复 Cloudflare 邮箱保护导致 ED2K 重复提取，并兜底过滤 `...` 密码占位
- 1.12.5：修复密码显示为 `...` 时从 mailto/title/data 属性还原，并过滤无效占位值
- 1.12.4：popup 新增一键清空测试缓存，覆盖文章缓存、图片缓存、失败缓存和诊断日志
- 1.12.3：修复 mailto 密码的 `%40` / HTML 实体编码还原，并过滤邮箱保护占位值
- 1.12.2：支持从解压密码字段附近的 `mailto:` 链接还原被论坛邮箱保护的密码
- 1.12.1：修复带括号标签的解压密码提取，避免复制结果残留 `] :` 前缀
- 1.12.0：新增帖子资源链接提取和右侧资源栏，支持 ED2K/磁力/网盘分类复制、提取码和解压密码复制
- 1.11.6：修复视口懒加载和手动重试绕过域名熔断器，视口跳过时线程状态正确标记，onInstalled 清旧缓存
- 1.11.5：修复停用当前页不清理、失败重试状态不同步、后台调度 timer 边界和状态分母显示问题
- 1.11.4：pending 满时暂停 idle 调度，避免空转
- 1.11.3：后台懒加载限制 wrapper 数量、retryLoadImage 空值保护、目录结构补齐
- 1.8.5：修复 isMeaningfulImage 无效参数、beforeunload 缓存丢失、负缓存缺失、死代码清理等问题
- 1.8.4：修复 popup checkbox bug、backgroundSpeed 缺失导致中断、默认值重复、无差别刷新、O(n²) 去重、资源泄漏等问题
- 1.8.0：悬浮窗框架拆分（floating-panel.js / floating-panel.css / settings-schema.js），Shadow DOM 隔离，bfp- 类名
- 1.8.1：修复设置覆盖问题、Shadow DOM 点击误关闭、错误刷新逻辑、版本日志同步
- 1.8.2：帮助视图从面板内切换改为独立并排面板
- 1.8.3：修复权限冗余、版本号硬编码、错误处理缺失、事件监听器泄漏、废弃 API、默认值重复定义等问题

## 功能模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 默认值定义 | `defaults.js` | 统一设置默认值 `ATP_DEFAULTS` |
| 共享工具 | `shared-utils.js` | URL 归一化、图片过滤、资源链接/密码提取、TXT 附件识别、资源统计 |
| 悬浮窗框架 | `floating-panel.js` | launcher、面板、设置/帮助视图、拖动、校验、消息提示 |
| 悬浮窗样式 | `floating-panel.css` | `bfp-` 前缀样式，fetch 注入 Shadow DOM |
| 设置 Schema | `settings-schema.js` | 统一设置定义（key/label/type/group/default/min/max/step/description 等） |
| 扫描器 | `scanner.js` | 帖子容器检测、URL 过滤、帖子列表扫描 |
| 缓存管理 | `cache.js` | 文章数据缓存、旧图片缓存兼容、负缓存、缓存刷新 |
| 加载器 | `loader.js` | 图片加载调度、轮询队列、失败处理、域名熔断 |
| 资源栏 | `resource-panel.js` | 本帖资源摘要、分类复制、复制全部 |
| 渲染器 | `renderer.js` | 缩略图和资源入口渲染、线程注册 |
| 抓取器 | `fetcher.js` | 图片 URL、资源链接和 TXT 附件资源提取、文章抓取 |
| 配置管理 | `config.js` | 设置读取、站点配置、启停判断 |
| 视口观察 | `viewport-observer.js` | IntersectionObserver 懒加载后台图片 |
| 预览器 | `previewer.js` | 大图查看器、左右切换、键盘导航 |
| 入口 | `content.js` | 初始化、事件绑定、Observer、热重载 |
| 缩略图样式 | `content.css` | 缩略图网格、加载状态、资源栏样式 |
| 后台服务 | `background.js` | 跨域图片、资源链接和 TXT 附件资源抓取代理 |
| 弹窗 UI | `popup.html / popup.js / popup.css` | 全局启停、站点禁用、缓存清理、设置重置、日志 |
| 日志工具 | `logger.js` | 运行日志写入、上限控制、导出 |
| 使用说明 | `使用说明.md` | 用户文档 |
| 技术总览 | `插件技术总览.md` | 面向评审、维护和开源协作者的完整实现说明 |
| 配置规则 | `AGENTS.md` | AI 行为规范 |

## 数据和安全边界

- 不上传页面内容
- 只从用户已访问或列表页可访问的帖子 HTML 中提取图片 URL 和资源链接
- TXT 附件识别后自动低并发解析；登录页、购买页、下载拦截页、Cloudflare/blocked 和 HTTP 401/403/429/5xx 按可重试空结果处理，不写新的文章负缓存；Discuz 附件 URL 不长期缓存，每次自动尝试或手动重试时重新提取
- 缓存存储在本地 `chrome.storage.local`
- 图片 URL 不发送到外部服务器
- 资源链接只显示和复制到本机剪贴板，不发送到外部服务器
- 不读取账号、cookie、localStorage 敏感数据
- 不绕过登录、验证码、付费限制
- 只对 `matches` 声明的域名运行
- 不使用远程代码

## 当前目录结构

```
article-thumbnail-preview/
  manifest.json              扩展声明、权限、文件引用
  background.js              后台 Service Worker（跨域代理）
  defaults.js                设置默认值定义
  shared-utils.js            共享工具函数
  content.js                 内容脚本入口
  content.css                缩略图和资源栏样式
  scanner.js                 帖子扫描模块
  cache.js                   缓存管理模块
  loader.js                  图片加载调度模块
  resource-panel.js          资源链接摘要和复制模块
  renderer.js                UI 渲染模块
  fetcher.js                 图片抓取模块
  config.js                  配置管理模块
  viewport-observer.js       视口懒加载模块
  previewer.js               大图预览模块
  floating-panel.js          悬浮窗框架
  floating-panel.css         悬浮窗样式
  settings-schema.js         设置项 schema
  logger.js                  日志工具
  popup.html                 弹窗 HTML
  popup.js                   弹窗逻辑
  popup.css                  弹窗样式
  tools/verify.js            本地项目验证脚本
  icons/                     扩展图标
  CHANGELOG.md               版本变更记录
  PROJECT_OVERVIEW.md        本文件
  插件技术总览.md            评审与开源技术文档
  使用说明.md                用户文档
  AGENTS.md                  AI 行为规范
```

## 已知限制

- 只对 `matches` 配置的域名运行，不默认对所有网站生效
- 跨域帖子需 background 代理抓取，单次超时 15 秒
- 普通显示和加载参数保存后会热重载缩略图链路；只有总开关和站点禁用等页面级状态需要整页重新初始化
- 论坛隐藏内容（阅读权限、回复可见）的图片和资源链接无法提取
- 图片托管在需要登录或 Referer 校验的图床时可能加载失败
- 资源链接和密码基于页面文本规则提取，格式异常时可能漏识别
- Chromium 148 与 Edge 150 的真实 unpacked/BFCache smoke 已完成；官方 Chrome 150 忽略自动 `--load-extension`，Chrome 品牌版仍需手工 unpacked 加载补充验收

## 技术债

- 全项目使用 `var`：建议迁移至 `let/const`，但涉及大量代码改动，需单独分支进行
- 图片提取逻辑重复：Service Worker 无 DOM API，保留现状

## 待用户确认事项

- 是否需要支持更多目标网站域名
- 是否需要在设置中增删域名，而非修改 `manifest.json`
