# Changelog

## 1.18.5 (2026-09-26)

- 标记资源并导出：列表页每个帖子面板的工具栏新增「标记」按钮，一次保存该帖的标题、帖子链接、全部资源链接（提取码跟在各自链接下）和解压密码。标记存在扩展本地，关闭标签页、关闭插件、重启浏览器或清缓存都不会丢；在任何页面打开扩展弹窗，「已标记资源」可导出 TXT 或复制全部，工具栏图标数字为未导出的标记数。
  - 防混淆：帖子按「站点 + 帖子编号」识别（.org / .net 为同一站点，每个镜像各自独立，编号从链接读取并与列表行 id 核对，对不上就拒绝标记）；点击只标记该面板自己的帖子；解压密码只列在所属帖子下，标为「本帖候选」。
  - 防失效：论坛附件和签名下载链接几分钟内失效，不写入文件并注明排除条数；带签名参数的其他链接标注「临时链接，可能已失效」；文件写明帖子内容的实际读取时间（缓存命中不算新读取）。
  - 只增不减：已标记的帖子再次出现在列表页或 TXT 解析完成后，新链接自动补进标记；之后完整读取时不再出现的链接保留在「最近一次读取帖子时已不存在」下；TXT 未解析完、内容不完整、含本地导入 TXT 都会在文件中注明。
  - 上限 300 帖（约 2 MB），超出时拒绝新标记并提示，不删除旧标记。「清空已导出」只移除导出后没有变化的标记，「清空全部」需再次确认。
- 每日备份：每次导出、复制全部，以及在页面上点任何复制按钮，都会把该帖的标题、链接和密码按当天日期自动存一份，同一天同一帖合并为一条；弹窗「每日备份」可按天或全部下载，备份不会自动删除，清空标记也不影响备份。扩展新增 `unlimitedStorage` 权限（无安装提示、不涉及网站访问），缓存淘汰不计入标记和备份占用的空间。
- 修复提取码配错链接（原有复制按钮同样受影响）：一个链接的提取码会被下一个没有提取码的链接借用；「提取码在前、链接在后」的写法会把下一段的提取码配给上一个链接。现在整帖一次配对：帖子里所有链接都参与（写出来的链接、不带 https:// 的链接、文字不是网址的链接、蓝奏云/天翼/123 盘等本扩展不收集的网盘和普通下载链接——后几类用掉自己的提取码但不输出；磁力和 ed2k 链接不带提取码，提取码也不能越过它们配对），只有相邻的链接和提取码才能配对；同一行内的提取码优先；跨行时每段分别按「提取码在链接下一行」和「提取码在链接上一行」各配一次，取配上更多的一种（相同时取「下一行」，即各网盘分享文本的写法），开头一个多余的提取码不会让整段错位；行数按看到的行计算（空行、CR/LF、Discuz 的 `<br />` 换行都算一行，图片附件块不计）；写明网盘的提取码（如「百度提取码」）只配给该网盘的链接；压缩包密码、RAR 密码、账号密码不再当成提取码（压缩包密码、RAR 密码现在算解压密码）；无法判断时留空而不是猜。同一链接在帖内出现两次且提取码不同时两个都保留（「帖内另见提取码」）。只差大小写的解压密码不再被当成同一个。文章缓存和 TXT 结果缓存升级版本，旧的配对结果不再使用。
- 发布前对抗审查发现并修复：初版配对在「文字不是网址的链接」「其他网盘的链接」「行首是上一个链接的提取码」「Discuz 的 `<br />\r\n` 换行」等真实版式下仍会配错或丢失提取码（现已改为上面的整帖配对）；文件名带空格的 ed2k 链接在标记时被丢弃；同一帖子内容没变、只是重新读取，就会让已导出的标记变回「导出后有更新」；帖内已不存在的链接没有写进每日备份；本地导入 TXT 的提醒在刷新后丢失；超过 200 条链接时误报为「临时链接」且每次更新累加；复制成功但备份失败时没有提示。现在：链接只拒绝会断行的字符，无法保存的链接计数并注明；重新读取只更新读取时间；备份保留帖内已不存在的链接；导入的链接逐条标注「来自本地导入的 TXT」；超出 200 条单独注明；备份失败时显示「已复制，但未能备份：原因」。
- 第二轮对抗审查又发现并修复：开头一个不是提取码的「密码」（压缩包密码、隐藏内容里的提取码、账号密码）或一个信息/图片链接会让整段提取码错位一个链接；不带 https:// 的其他网盘链接的提取码会配给相邻网盘链接；网盘 ID 末尾恰好是 UC/115/123 时被误认成网盘标签；按类型复制超过 200 条链接的帖子时，复制的那一类没有进备份；TXT 附件超过 3 个的帖子被标为「完整」。现在：配对改为上面的双向取优；这些链接和标签都已识别；复制时先按类型取链接再计上限；超过 3 个 TXT 附件时在文件中注明且不算完整。随机生成的帖子上，同行、下一行、同行在前三种写法均无配错（旧版 8%~44% 配错）。
- 第三轮对抗审查又发现并修复：提取码在链接下方隔了几行（名称、大小、格式等）时会整体错位到下一个资源；「无需提取码」「免提取码」「提取码：」后面没有值、正文里的「提取」会把下一行或同行的词当成提取码；段落和空行没有参与判断，提取码写在上一行时被配给上方链接；其他网盘链接同一行或下方的提取码会跑到网盘链接上；页面里恰好含有内部标记字符时整帖解析失败；TXT 附件超过 3 个的帖子没有计入「需注意」。现在：提取码可以隔最多 8 行配给上方链接（代价更高）；「无需/免/无」开头的标签不取值，标签的值只能在同一行，或单独占一整行/一个表格格；段落（`</p>`、`</div>`、表格行、空行）作为判断依据，图片算作内容行；城通、蓝奏、123 盘等文件网盘的链接（含图片下载按钮）保留自己的提取码；页面中的标记字符先清除；「需注意」包含 TXT 附件超限。随机生成的帖子上，除「提取码单独一行写在链接上一行、且混有无提取码的链接」这种本身无法区分的写法外，其余写法均无配错。
- 第四轮对抗审查又发现并修复：写明网盘的提取码（百度提取码/夸克提取码）在多资源帖子里会互换或跑到备用链接上；链接自己写着「无需提取码」「提取码：无」时仍会拿到相邻的提取码；链接地址里已带 ?pwd= 时会拿走下一条的提取码；「几个链接后跟几个提取码」、网盘作为表格列时第一个提取码配给最后一个链接；[list] 列表项、div/p 包裹、隐藏内容框会打乱行和段落判断；提取码在链接下方 4~8 行时仍可能错位。现在：写明网盘的提取码跨行时只配给同段落内、上方的同网盘链接；「无需提取码」等说明绑定到同一行的链接；带 ?pwd= 的链接不再从别的行取提取码；「N 个链接后跟 N 个提取码」（或反过来、或表格的一行）按位置配对，单元格里只写「无」也算一项；只有「一个块结束后紧接新块」、分隔线和空行算分段，其他块标签只算换行。随机生成的帖子上，提取码在链接下方、同一行、写明网盘等写法均无配错；提取码写在链接上方且有分段时约 2% 配错，无分段时约 8%（旧版 60% 以上）。
- 回归：新增 tests/resource-marks.test.js（帖子识别、标题清洗、快照、只增合并、导出和备份文件格式）；verify 新增后台写入（两个标签页同时标记、只能标记本站帖子、弹窗不能添加、导出只认读取后未变的标记、清空需确认版本、上限、缓存用量不含标记）、弹窗导出（文件 BOM 与标题、提取码位置、备份下载）和页面按钮（只标记本面板的帖子、失败原因、跨标签同步、只发送变化）的测试；提取码配对新增 8 种版式的样例。

## 1.18.4 (2026-09-26)

- “立即重置论坛节流”在任何页面打开弹窗都能用，不必先切到论坛页面。
  - 点击后一次重置所有论坛域名（含镜像）：已打开的论坛标签页立即恢复突发 10、每 2 秒 1 个，暂停中等待的帖子立即继续；之后才打开的论坛页面也从正常速度开始。
  - 重置只清除点击之前学到的速度和暂停；论坛之后若再返回验证页，扩展照常自动放慢（即使系统时间之后往回调整）。
  - 弹窗按域名显示各论坛的速度（放慢的域名单独列出），不再需要当前标签页应答；没有标签页在用的域名，按扩展自己的规则到期后显示为恢复（闲置 5 分钟回到学到的速度，学到的速度 24 小时后失效）。
  - 实现：弹窗在扩展存储写入重置标记 `atp_forum_pacer_reset_at`；每个论坛域名第一个看到新标记的页面（加载时或收到存储变更时）清除学到的速度和暂停，并在该域名 localStorage 记下已应用的标记 `atp.forumPacer.resetApplied.v1`，同域名其他标签页从共享存储读到结果，每个标记只应用一次。各页面把本域名的速度、学到速度的失效时间和闲置到期时间写入 `atp_forum_pacer_status_v1`（速度变化时写入，工作中的标签页至多每分钟刷新一次）。原先的 `ATP_FORUM_PACER_STATE` / `ATP_FORUM_PACER_RESET` 标签页消息已移除。
  - 发布前对抗审查发现并修复：验证页发生在 5 分钟以前时（最常见的点按钮时机），页面记录已按学到的速度重建、不含验证页时间，按时间比较的初版重置不生效且弹窗随即又显示“已放慢”；系统时间回拨后初版会把新的验证页也当成重置前的而清除。
- 回归：verify 的节流测试改为重置标记（已打开页面立即恢复并放行等待中的请求、清除学到的速度、上报正常速度、之后的验证页不被旧重置撤销、重置后才打开的页面从正常速度开始、验证页在 20 分钟前时重置仍生效、系统时间回拨后新验证页仍放慢、工作中的标签页每分钟刷新上报）；弹窗测试改为在非论坛页面读取状态并重置所有记录的域名，并覆盖闲置和学到速度到期后的显示。

## 1.18.3 (2026-09-26)

- 弹窗“维护”新增“立即重置论坛节流”，并显示当前论坛标签页的节流速度。用户日志 11-58：论坛节流停在最慢档（突发 4，之后每 4 秒 1 个帖子），因为此前两次触发论坛验证页后，扩展记住了触发时的速度，24 小时内不再加快；这是扩展自己的限速，不是论坛此刻在限流。重置会清除本论坛域名下记住的速度和暂停，恢复突发 10、每 2 秒 1 个，暂停中等待的帖子立即继续。只影响当前论坛域名（该域名的所有标签页同步），其他论坛域名或镜像需各自重置；论坛若再次返回验证页，扩展仍会自动放慢。
- 回归：verify 新增节流重置（学到的速度与暂停清除、等待中的请求立即放行、无法删除存储时改写为正常速度）、弹窗读取与重置消息、弹窗按钮与状态显示的测试。

## 1.18.2 (2026-09-26)

- 首屏按正在看的内容加载（用户日志 09-50）：图片已经很快（静态图约 0.36 秒，动图约 0.64 秒，屏幕内图片从未等待槽位），慢在帖子正文。论坛节流在 10 个突发后每 2 秒放行 1 个请求，而 6 个正文抓取线程按页面顺序各自先领一个帖子，再去节流器排队。滚动到的新帖要排在约 14 个名额之后（约 28 秒）。屏外预取和自动 TXT 还会用光各页共享的名额，翻到下一页时首屏只能每 2 秒出一帖，于是列表自上而下一段段出现。
  - 论坛节流为屏幕内的帖子保留名额：屏外预取、自动 TXT 等只在剩余名额多于 4 个时发出（突发变小时按比例减少），屏幕内的帖子可以用全部名额。总速率不变，屏外工作仍能拿到保留量以上的每个名额；限流后的单路探测阶段不保留。
  - 正文抓取改为轮到名额时再挑帖子：先挑屏幕内的，再挑离屏幕最近的。名额不足时，最多一个屏外帖子在节流器里等待，其余线程不占帖子；在等待时滚出屏幕的帖子会让出线程。已缓存的帖子不等名额。滚动后，屏幕内所有新出现的帖子直接插队，空闲线程留在原地等待，不提前退出。
  - 自动 TXT：抓正文时读到的附件链接（Discuz 附件链接有时效，只在内存里保留 3 分钟）直接用于自动解析，不再为此重新抓一次帖子页，每个带 TXT 的帖子少 1 次论坛请求。页面帖子仍在抓取时，只有屏幕内帖子的自动 TXT 立即开始，屏外帖子的等正文抓完再开始。手动重试不变。
  - 本地模拟（同样的论坛节流，每页 30 帖，用户的设置，各两轮）：第 1 页仍在预取时打开第 2 页，屏幕内帖子全部出现从 4.3 秒降到 0.25 秒；滚动到尚未加载的位置，从 22.9 秒降到 0.11 秒；首页不变（0.36 秒），整页预取总量不变。
- 图床轮换（用户日志 09-50：一帖 7 张全部“加载失败”）：论坛同一套附件存储挂在多个轮换域名下（如 tu.djhdhs.us、tu.w4kmzkm.com，路径为 /tupian/forum/年月/日/…），每次渲染帖子时选一个。tu.w4kmzkm.com 在所有日志里从未加载成功，而同一路径在 tu.djhdhs.us 上正常。
  - 附件路径的图片在带 Referer 和不带 Referer 都失败后，改用本页已成功加载过图片的同族图床、同一路径再试一次。
  - 某个图床这样失败 3 次且从未成功后，新图片直接从同族的正常图床开始。
  - 只用 https、同一族（域名首段相同、路径前缀相同）、近 10 分钟内至少成功 2 次且未在冷却的图床。改用同族图床的图片按该图床的动图通道和并发上限准入；重图帖子的大图预览也打开同族图床上的地址；同一张图不会因候选回退重复出现；缓存仍保存论坛给出的原地址。
- 回归：verify 新增节流保留名额、正文按屏幕优先派发（离屏幕最近优先、屏外只一个等待、同时放行的竞争、等待中滚出屏幕让出线程、空闲线程留守、滚动插队覆盖整屏、缓存不等）、自动 TXT 复用链接与屏外等待（屏幕内始终优先）、同族图床回退（准入按同族图床、预览、不重复、缓存保留原地址）的测试。

## 1.18.1 (2026-09-26)

- 动图下载通道按图床速度自适应（用户日志 00-14）：1.18.0 后已无失败格，该图床两张在途时动图约 2 秒完成，与静态图相当。固定 2 张的动图通道反而成了瓶颈：常常只有 2–3 张在下载，屏幕内的图片最多等了 14 秒。
  - 规则：每个普通图床起始同时下载 2 张动图。通道占满时，只要动图在“快”阈值内完成（图片超时的 40%，2–5 秒），就放宽 1 张，最多到该图床上限的一半。浏览器对 HTTP/1.1 图床每个主机只开 6 个连接，更宽的通道会让静态图排在动图后面。该图床上任何图片（动图或静态图）超过“慢”阈值（图片超时，6–15 秒）或超时，通道就减半，但不低于起始的 2 张，同一批只减一次。更窄的通道只会拖住首屏，进而拖住后续行。图床正常时不再被固定的 2 张卡住；图床饱和时退回 2 张。屏外动图最多占通道的约一半，其余留给屏幕内。已开始的动图全部滚出屏幕时，屏幕内的动图可再多用 1 张。静态图不受此限；手动重试和重图通道不变；关闭“普通图床自适应”时固定为 2 张。
  - 通道宽度随设置变化重新限制，不超过准入实际能用的宽度，也不再记录并未生效的放宽。判断“正在等动图通道”改为读取准入检查本身的结果，后台和屏外首批使用各自的限额时不再误判。
- 滚动卡顿（用户反馈）：
  - 动图缩略图默认显示第一帧，右下角标“GIF”，鼠标悬停时播放，点击仍打开原图；“显示 → 动图缩略图”可改为始终播放。第一帧先异步解码，再在空闲时按缩略图像素尺寸画到画布上，不占用滚动帧。1.18.0 之后动图都能加载出来，同屏几十张动图全部播放时，每一帧都要按原尺寸重新解码并重绘，负担落在图片解码线程和 GPU 上，较慢的机器上表现为滚动卡顿。本地测量（1440×1700 窗口，同屏 30 张 480×270、16 帧动图，同一版本对比）：静止时 CPU 从单核的 27% 降到 0.9%；页面加载完后滚动从 78% 降到 29%，丢帧从 1.5–1.9% 降到 0.1%。
  - 静帧画布保持在 CPU 端，随页面一起绘制；高分辨率屏幕上的大缩略图不会各自成为一个合成层。
- 测量：
  - 本地慢图床模拟（用户的设置，24 帖，60 秒，各两轮）：
    - 图床总带宽 2MB/s、帖内混有 6MB 动图（复现用户日志 22-48）：关闭动图处理时只加载 16–17 张缩略图，24–25 格“加载失败”；开启后 84–87 张，0–1 格失败。
    - 帖子以动图为主、图床正常（每个连接 1.5MB/s）：1.18.0 的固定 2 张通道加载 131–135 张，屏幕内 30 格约 25 秒填满；自适应通道 174–179 张，15 秒填满，无失败。图床饱和时两者相同。
- 回归：verify 新增自适应动图通道测试，覆盖放宽、减半、下限与上限、每批只减一次、静态图超时收窄、真实加载与超时路径、设置变化后的上限、准入限额下的等待判定；新增静帧测试，覆盖空闲时绘制与每轮预算、解码后再绘制、缩略图被移除或换图时不绘制、始终播放设置、竖图尺寸。
- 版本号：每个交给用户测试的构建都使用新的版本号，避免误用旧版。

## 1.18.0 (2026-09-25)

- 镜像/反代站点（多个子代理域名）：弹窗新增“镜像站点”，可一键添加当前 HTTPS 站点或输入域名。每个镜像通过浏览器授权框单独授予可选主机权限 `https://*.<域名>/*`，后台按 Manifest 相同的脚本、顺序、运行世界和时机注册内容脚本，撤销授权后自动注销。所有论坛主机判断统一到 SharedUtils 站点注册表，移除后台、正文抓取和 TXT 白名单中的硬编码域名；下载中转域名改为常量列表。
- 跨站信任区：内置两个论坛域名为同一信任区，每个镜像为独立信任区。镜像页只处理本站帖子；后台拒绝跨区正文、TXT 附件和跨区重定向，内容脚本在读取缓存前跳过跨区链接，避免镜像借用其他站点的登录会话读取内容。镜像页的浮窗样式由后台读取，不扩大 `web_accessible_resources` 暴露范围。
- 权限：新增 `scripting`、`activeTab` 和可选主机权限 `https://*/*`；安装时不授予任何额外站点，必须逐站点确认。
- 每页最后几帖无图（用户日志）：论坛在几秒内收到约 30 个正文 / TXT 请求后，会对后续请求返回约 1.2KB、以随机名言作者为标题的验证页（HTTP 200）。旧版把它当作空帖写入负缓存，最后几帖因此一直无图。
  - 论坛节流器（新文件 `forum-pacer.js`）：发往论坛本站的请求统一排队，包括帖子正文、TXT 附件链接重取、附件下载及其后台回退；图床和下载中转站不受影响。最多连续 10 个，之后每 2 秒 1 个（实测“16 个后每秒 1 个”约 20 秒内仍会触发验证页）；屏幕内的帖子优先，其余按请求先后。论坛按浏览器计数，因此额度与暂停保存在该论坛域名的 localStorage，由所有标签页共享、跨页面延续，闲置 5 分钟后清空；快速翻页或多开标签页不会叠加突发。
  - 限流信号：验证页（`challenge_page`，约 6KB 以内、只有脚本、没有 Discuz 页面框架）、限流提示页、429/503 和 Cloudflare 挑战（含带 `cf-mitigated: challenge` 响应头的 403）会让论坛请求暂停，首次 20 秒，之后逐次翻倍，最长 5 分钟。暂停结束后先单路探测，连续 3 次正常再恢复；同一批在途请求只计一次。触发后突发额度减半、间隔放慢 1.5 倍；此后论坛每连续正常响应 8 次，额度逐步恢复，但不会回到触发时的速度：触发时的节奏会被记住 24 小时（突发不超过其 3/4、间隔不短于其 1.25 倍）。任何标签页正常打开论坛页面后，之前的暂停即解除，改为单路探测，等待中的帖子随即重试；最长的暂停结束后同样先探测，不会直接恢复满额突发。浏览器存储写入失败时，该标签页改用内存中的状态继续节流；系统时钟回拨不会让暂停失效。插件从不执行或应答验证页。
  - 阅读权限、登录等 Discuz 提示页，以及无法识别的页面，只是论坛对单个帖子的正常回应，不再触发全站暂停；标题提到“Just a moment”或加载 Cloudflare 页面脚本的普通帖子也不再被当作 Cloudflare 挑战。
  - 这些页面不写负缓存。帖子在暂停结束后自动重试：限流类每帖最多 6 次，提示页、拦截页和无法识别的页面（含后台路径返回的登录 / 权限 / 购买页）最多 4 次，两类分别计数；用完后本页不再抓取该帖，直到刷新页面。暂停期间不再让抓取线程空等，帖子改为推迟到暂停结束，已缓存或新进入视口的帖子照常显示。帖子标题后（不是图标列）显示“论坛限流，排队中”“稍后自动重试”或“未加载，刷新页面可重试”，关闭或重载缩略图时一并清除。`Retry-After` 只会延长等待，不会缩短退避。
  - TXT：按需重取遇到验证页时按失败处理，不再误报“0 个附件”；自动重取设有截止时间，不会因长时间暂停一直显示“重新提取中”；重取失败时只解析已缓存的附件，其余附件保持待重试，不再把该帖的 TXT 记为已完成。页面桥因论坛跳转到下载站而失败时直接交给后台，不再用内容脚本重复请求，每个附件的论坛请求从 3 次降到 2 次。跟随同站下载链接前先释放本次请求的名额，限流探测期间不再卡到截止时间。
- 卡顿与性能：
  - 移除加载中缩略图的无限微光动画，改为静态骨架（进度仍显示在工具栏“加载中 x/y”）。图床较慢时屏幕附近常有几十格同时处于加载中，每格动画各占一个合成层，滚动时每帧都要为它们重算样式、更新合成输入。按用户日志中的慢图床条件模拟（30 帖 × 60 张大图、CPU 降速 4 倍）：滚动期间主线程工作减少约三成，样式重算减少约九成。
  - 修复离屏帖子无需滚动即加载：缩略图只与帖内滚动框比较、从未与页面视口比较，整页帖子因此在后台持续加载。现在还需接近页面视口（约一屏前瞻，快速滚动时同样覆盖），由页面级观察器在帖子接近时唤醒。
  - 修复可见等待重试在加载期间以 80ms 周期持续运行（每次含布局读取和祖先样式检查）。
  - 重图恢复范围改为帖内裁剪 + 页面视口 ±900px，160MP 解码预算恢复生效。
  - 显式开启屏外首批时，在弱图并发池内为可见图片保留设定槽位（默认屏外 1 路、可见 2 路），并为可见重图保留 1 个重图槽；全页自动加载的单图床上限使用固定安全值 6，不再使用冷却期降低的自适应值。
  - 畸形帖子和 TXT 的正则回溯：附件 URL 扫描由立方复杂度改为线性（512KB 约 1ms，原先 40 秒级），标签去除、邮件保护、末尾标点和密码提取改为线性或有界。
  - 跳转或恢复滚动位置后，先扫描屏幕内帖子，再补屏幕上方的预取区。
- 慢图床上的动图（用户日志 22-48）：“加载失败”几乎都是同一图床上几 MB 的动图。十几张同时下载占满带宽，一起卡到 16 秒截止；同屏静态缩略图也等不到槽位。可见图片只与可见计数比较，该图床曾有 12 张在途，超过上限 10。
  - 动图单独限流：每个普通图床同时最多下载 2 张动图，屏外动图最多占 1 张，另 1 张留给屏幕内。已开始的动图全部滚出屏幕时，屏幕内的动图可再多用 1 张。静态图不受此限；手动重试和重图通道不变。
  - 动图的单次超时为图片超时的 3 倍（至少 30 秒），单图截止为 3 倍（至少 45 秒；未设截止时仍不设）。慢动图超时后不再改用无 Referer 重新下载，那会丢弃已收到的数据。
  - 每帖首屏内先排静态图、后排动图，只在实际显示的范围内调整；重图帖子顺序不变。缓存仍按帖子原顺序保存。排在帖子首批队首、正在等动图通道的动图，不再挡住同帖后面的静态图和重图主机图片（重图帖子不重排，失败重试也会排到队尾）。
  - 标签页隐藏时暂停的视口图片，恢复后重新计算截止时间，不再因截止已在隐藏期间过去而立即失败。等待动图通道的图片不再占用视口重试每轮的尝试次数。
  - 日志：图片事件新增 `largeImage`、`taskDeadlineMs`；图床耗时把动图单列为 `gif:主机`；汇总新增单图床最多在途动图数；诊断配置新增动图超时、截止和通道宽度。值为空的字段不再占用每条日志 80 个字段的上限，失败记录不会因此丢掉图床冷却等字段。
- 调度修复：预览与显示 URL 不同的重图主机缩略图按准入规则计入普通槽；冷却到期后的迟到失败不再重新冷却；重试获得新的单图截止时间；重新排队后恢复慢图宽限；帖子重建后的旧任务不再发起无 Referer 重试。
- TXT 与缓存：页面桥收到 HTTP 错误即结束本轮，不再依次用内容脚本和后台重复请求（429/5xx 同理）；被拒绝的响应立即中止下载；每次渲染都会变化的 Discuz 附件 URL 不再写入 TXT 缓存；缓存淘汰先清理已过期条目；存储配额读取浏览器实际值（Chrome 111–113 为 5MB）；`javascript:` / `data:` 链接不再作为可复制资源。
- 日志与界面：导出日志不再裁掉当前标签页的会话分片；刷新确认按序号判定，持续记录时也能及时回应；裁剪计数只统计真实裁剪，旧的清空标记不再重置新会话；诊断配置反映关闭重图优化后的真实槽位；大图预览越界索引不再打开空白遮罩；“仅在此站点禁用”只对内置或已授权站点显示，并兼容带末尾点的主机名。
- 回归：新增镜像注册表、后台同步、信任区和弹窗流程测试套件；verify 新增限流页与验证页识别、论坛节流器（突发、同批只计一次、单路探测、可见优先、跨页延续、未结票据超时）、正文与 TXT 限流路径、等待提示、页面前瞻门槛、线性 URL 扫描和资源协议检查；页面桥测试覆盖跳转失败后不再重复请求。本地浏览器模拟（40 帖，每 5 秒超过 30 次即触发且需导航解除）：旧版只显示 22/40 帖，收到 25 次验证页；新版显示 40/40 帖，0 次，任意 5 秒最多 22 个请求。浏览器回归新增真实镜像会话（脚本注册、注入、样式、TXT 桥、跨站请求为 0）。滚动基准（25 帖 × 100 图、快速预设）确认不再预载整页离屏帖子，进入视口时的空白率与旧版相当。
- 已知限制：页面主环境脚本仍可伪造 TXT 页面桥响应（同一站点本身即可伪造页面内容），影响限于该站点；镜像必须为 HTTPS；授权前已打开的页面需刷新后生效。

## 1.17.8 (2026-09-24)

- 长列表性能：后台图片任务按帖分批入队（普通图按后台并发计算小批次），不再在首屏完成后一次性创建数百个视口等待任务。普通图在内滚接近已生成内容末端时补批，无须等上一批慢图完成；重图仍在批次完成后推进。
- 根据 1.17.7 日志定位到单页后台队列峰值 739、视口待加载 24 且任务等待超过 5 分钟；新增压力回归确保队列和待视口数量有界。

## 1.17.7 (2026-09-24)

- 连续真实页面日志显示，全页屏外自动加载即使限制离屏并发和单图床并发，仍会在长列表持续抓取正文与原图，影响滚动响应。将该功能改为默认关闭，旧版默认开启的存储键不再生效；用户可在设置中重新手动开启。
- 默认路径恢复按视距抓取与图片加载；保留资源提取、诊断和可选屏外加载功能。补充旧设置迁移及浏览器显式开启的回归测试。

## 1.17.6 (2026-09-24)

- 修复全页自动加载下同一普通图床并发过高：含可见图片在内，每个普通图床最多 6 张在途；保留全局并发和可见优先规则。
- 慢图首次达到图片超时时，如原请求仍在进行且单图总截止时间尚有余量，继续原请求到截止时间。真正的加载错误仍可按原策略无 Referer 重试；截止后不再开启无效回退。
- 根据 1.17.5 实际日志定位到 12 张同图床在途、图床响应约 8.5 秒而每次超时 8 秒，导致 16 秒失败和重复回退。增加生命周期与图床并发回归。

## 1.17.5 (2026-09-24)

- 长列表卡顿回归：屏外首批普通图片最多同时加载 3 张；滚动期间暂停启动新的屏外请求，滚动空闲后继续。可见图片的并发、每帖首批数量和后续图片解锁规则不变。
- 诊断配置与调度快照新增实际屏外普通图并发上限，方便区分用户设置的全局槽位与离屏准入。
- 使用真实 1.17.4 诊断日志定位到 24 帖、1196 张候选、同一图床最高 12 张在途及 DEBUG 开启的负载；浏览器图床实际表现仍需实测。

## 1.17.4 (2026-09-24)

- 修复文章视图参数碰撞导致的缓存混用，收紧 TXT 附件识别并过滤隐藏内容；修复同段网盘提取码归属与图片候选边界。
- 列表页先处理可见帖子，再逐步抓取屏外帖子；每帖按列数 × 可见行数自动加载首批图片，其余图片在展开或滚动帖内区域后加载。屏外首批使用可用首批并发，同时为可见图片保留槽位。
- 诊断日志去除结构化字段的重复字符串副本；即使 DEBUG 关闭仍记录精简图片失败。会话留存有效设置、首次与最近异常、图床计数、明细裁剪数量和时间范围；导出前请求当前标签页刷新缓冲日志。
- 增加 600 张失败图的裁剪与清空回归、默认/快速预设的屏外并发回归及合成浏览器场景。真实站点和图床表现仍需实测。

## 1.17.3 (2026-09-08)

- 调度链路：同步全局调度先尝试已登记的真实可见图片，再运行首屏/后台队列；新增 actual-only 入口，不把附近或离屏待办混入这一优先阶段。普通队列和原有异步唤醒继续保留。
- 重入保护：同步完成回调不会递归进入全局调度，外层调度与已有槽位唤醒负责后续推进，避免嵌套扫描。
- 诊断开销：复用 BG_TASKS_VERSION 对应的后台通道快照，不再每条 DEBUG 图片事件都重扫完整后台队列；队列变更后照常失效重建。
- 回归：验证可见队列先于普通队列、实际可见与附近待办隔离、重入边界，以及 750 项队列连续 20 次快照复用与清空后失效。并发、数量上限、超时、用户配置和缓存格式不变；实际图床耗时仍需实测。


## 1.17.2 (2026-09-08)

- 修复取得活动加载槽的离屏图片仍使用原生 lazy、请求可能被浏览器继续延迟但插件已开始计时的问题。此冲突会消耗并发槽、产生假超时并触发图床自适应降载。
- 已获槽图片使用 eager，离屏网络优先级仍为 low；可见性回调不再把持槽图片重新改回 lazy。未获槽图片继续按需等待，不提高并发、不改用户设置或超时参数。
- 增加真实浏览器离屏请求回归：本地即时图片必须在不滚动的情况下抵达服务端且保持 low 优先级；同时保留原有并发、首屏/滚动、TXT、弹窗、BFCache 测试。原始用户诊断日志未纳入仓库。


## 1.17.1 (2026-09-08)

- 修复原生浏览器工具栏弹窗在无人操作时持续闪动：`body max-width:100vw` 与宿主自动尺寸形成反馈，复现为宽度交替变化。改为 html/body 固定 320px 且不依赖视口宽度。
- 回归从普通标签页设置测试扩展为实际 `chrome.action.openPopup()`，连续采样 20 次确认宽度稳定；更新原先错误要求 vw 上限的静态断言。
- 本版不调整图片调度、网络参数、权限或缓存，不宣称解决所有慢图问题。定位慢图需使用临时 DEBUG 日志区分排队、视口、图床和超时原因。


## 1.17.0 (2026-09-08)

- TXT 背压：保留扩展级并发 2，增加全局 32/单标签页 4 的等待队列边界，以及 30 秒/调用方截止时间的主动过期清理。拥挤、过期返回可重试状态，不生成失败缓存；同步异常也释放活动槽位。
- CI：新增只读权限、固定 Action SHA 的 Windows / Node.js 22 工作流，执行六组回归、安装与交接包验证、固定 Playwright 1.63.0 Chromium 浏览器回归，成功后保存安装 ZIP/校验值 14 天。
- CI 兼容：临时浏览器目录清理对 Windows 文件占用做有界重试；清理失败不覆盖原始测试异常，路径边界继续强制验证。
- Chrome 153 兼容：浏览器测试按 Manifest 名称、版本和后台入口识别目标扩展，避免把浏览器自带的同名 background.js 后台进程误认成本项目。
- 夹具：新增列表页、图文帖、纯资源帖、登录拦截页四类合成页面；Node 与浏览器分别验证提取，列表结构用于完整浏览器加载回归。没有新增真实帖子快照，提供手动脱敏导入说明并忽略原始捕获目录。
- 文档：更新中英文说明、背压行为和统一人工验收清单。权限、图片调度、配置和缓存格式保持兼容。


## 1.16.11 (2026-09-08)

- 链接：查询参数与片段中的合法 ASCII 标点不再被当作正文分隔符截断；图片属性在 HTML 回退路径仅解码一次，DOM 路径复用浏览器已经解码的值，保护含分号、逗号和实体文本的签名参数。
- 性能：图片与 OG 提取先顺序识别完整标签，再按 zoom / zoomfile / file / img / href / OG 类别收集，移除对整篇 HTML 反复尝试的标签正则；未闭合标签和属性中的 `>` 均有回归覆盖。
- 测试可靠性：浏览器 CDP 命令增加 15 秒独立超时，成功、超时、同步发送失败和主动关闭均清理 pending 与计时器；调试 HTTP 请求同样设置超时。
- 验证：补充 200KB 异常标签有界执行、合法 URL 参数及 CDP 生命周期测试；真实 Chromium 比对 DOM 与回退路径的 img、href、OG 签名链接。权限、用户配置、图片调度与缓存格式不变。


## 1.16.10 (2026-09-08)

- 性能：注释与非渲染区域识别合并为一次前向扫描，避免为缺失标签重复搜索剩余全文；320KB / 40,000 注释合成夹具本机从约 7.9 秒降至约 3.4 毫秒（修复后五次中位数，仅代表预处理环节）。
- 提取：锚点扫描识别属性引号中的 `>` 与带空格的闭合标签，拒绝把 `a-card` 等自定义元素当作链接；未闭合锚点不再重复扫描尾部。非渲染过滤使用完整标签边界，保留 `title-card` 等可见自定义元素，排除 script/style 伪图片。
- 正确性：HTML 实体仅单次解码，避免数字编码的 `&` 触发第二轮解码；密码字典不再继承 Object 原型，保留 `constructor`、`toString`、`__proto__` 等合法值。
- 请求边界：页面 TXT fetch 增加 `mode: 'same-origin'`，允许同源跳转但阻止跨域跳转发出网络请求；拒绝超限/错误响应后取消未读取的响应体。
- 回归：增加实体、密码、标签、病理输入超时和超限取消测试；真实 Chromium 合成服务确认同源重定向成功、允许 CORS 的跨域目标仍未收到请求。Manifest 权限、图片并发、缓存格式和用户设置不变。


## 1.16.9 (2026-09-08)

- 以现存 v1.16.8 发布目录恢复统一运行时源码，保留 v1.16.3 的测试、打包工具与历史文档；不再将旧源码误标为最新版。
- 增加中英文 README，统一当前版本入口，补充敏感文件忽略规则与可重复验证流程。
- 修复日志发现后旧分片索引被重新合并写回的问题，同时保留发现期间新注册的会话索引；增加并发回归。
- 修复无 TextEncoder 时 UTF-8 配额估算把 emoji 等代理对误计为 6 字节的问题，正确按 4 字节计算；补充孤立代理项和提取器回归。
- 修复维护者交接包漏掉页面桥接运行时与测试、依赖本地 agent 文件及无初始 Git 提交时打包报错的问题；纳入英文说明和新增回归测试。
- 修复暂存区验证读取超过 1MB 文件时触发子进程缓冲区溢出的问题，并避免失败信息输出完整源码。
- 更新旧测试夹具和静态断言以匹配 v1.16.8 的统一提取 API、时间片解析、事件缓存、延迟卸载及非模态键盘行为；测试专用状态入口只注入沙箱，不重新暴露到生产代码。
- 历史说明：交接材料没有包含 v1.16.4–v1.16.8 的完整源码变更日志，因此不推测各版本改动归属。


## 1.16.3 (2026-07-17)

- 自动 TXT：帖子识别到 TXT 附件后立即进入独立 FIFO，最多同时解析 2 帖；成功后资源面板直接显示 ED2K、磁力或网盘复制按钮，不再要求先点击“解析TXT”。手动解析与“导入已下载TXT”仅在自动读取为空、部分成功或失败后显示。
- 图片保护：自动 TXT 延后一轮任务启动，继续让图片首屏调度先运行；同一帖子内的 TXT 附件在 content 与 background 两端均改为串行读取，后台消息再共享扩展级并发 2，避免多标签或 2 个帖子槽通过多附件 `Promise.all` 放大请求。图片并发、预设、视口优先和重图策略不变。
- 缓存与竞态：文章缓存新增可选 TXT 完成/未解析计数字段；完整结果（包括仅密码结果）可在返回页面时直接复用，部分成功或后来新增附件不会被误判为完成。每次解析使用运行令牌，本地导入会使旧请求结果失效，但旧请求实际结束前不会提前释放网络槽；多附件帖子只导入部分文件时继续保留补齐入口。
- 验证：新增自动 FIFO/并发 2、成功/拒绝/同步异常/非 Promise/fresh 空结果释放、detached 线程、完整/部分缓存、本地导入迟到结果隔离和真实 86 字节 ED2K 字节/哈希回归；browser smoke 改为禁止点击手动按钮并等待自动复制入口。Manifest 权限、host 权限、缓存 key/TTL 和资源复制格式不变。

## 1.16.2 (2026-07-17)

- TXT 会话读取：同源 Discuz TXT 附件优先通过页面主环境发起受限同源请求，复用当前站点会话，解决隔离 content/background fetch 被 Cloudflare 或 SameSite 会话边界拦截后只能识别附件、无法读取内容的问题。桥接请求仅允许当前 `sehuatang` origin 的附件形态 URL，限制 512KB、10 秒并保持原有后台回退。
- 本地兜底：资源面板新增“导入已下载TXT”。用户选择已经下载的 `.txt` 后，复用现有 ED2K/磁力/网盘解析器，合并到当前帖子资源并写入文章缓存及匹配的 TXT 缓存；后续返回该页可直接复制，无需再次导入。不新增下载目录或文件系统权限。
- 缓存说明：文章正文解析结果、图片 URL、已加载 URL 和 TXT 资源继续按公开缓存 TTL 复用；图片二进制仍交由浏览器 HTTP 缓存管理，不扩张扩展存储格式。
- 验证：增加真实 86 字节 ED2K TXT 回归、页面主环境桥的同源/跨域/字节保真测试，以及桥接 allowlist、本地导入上限、缓存写回与 UI 静态守护。图片调度预设、资源复制格式、缓存 key/TTL、消息协议及 Manifest 权限不变。

## 1.16.1 (2026-07-17)

- 根因修复：自动图片总并发改为弱图可见通道与重图通道之和，并始终按可见并发计算；后台并发只限制离屏普通图，不再把总槽重新缩小。后台容量预判也会真正扣除可视保留槽，避免 20ms/100ms 空转扫描。
- 可视优先：新增零 margin 的真实视口直达队列。图片进入视线时会立即更新任务、host active 分类和 `loading/fetchPriority`；已经以离屏低优先级启动的请求会动态晋升，滚出视口后不再粘滞占用可见 host 槽。可视任务抢槽失败后直接等待槽位释放，不再在大 pending Map 尾部每 80ms 扫 12 项。
- 普通图床恢复：普通 host 自适应同时使用最近成功/失败比例与失败数量。少量坏 URL 不再把同一正常图床压成反复 30 秒单路冷却；真正高失败率的 host 仍会 soft/hard 降载，冷却到期先以 soft limit 半开恢复。普通失败按 task/host/健康代际去重。
- 重图恢复：卸载后的重图恢复请求纳入统一全局槽、重图槽与生命周期释放，不再绕过并发统计额外触发网络和解码尖峰。
- 网络预设：弱图预设调整为 `100M`、`200M`、`高速（推荐）`。三档同时协调可见/后台/同域并发、host 降载、全局自动模式、pending 上限、正文抓取、图片单次超时与共享任务期限；重图配置、抓取/显示上限和资源链保持独立。
- 诊断与验证：`schedule_state`/`diagnostic_summary` 新增真实可视 pending 数量、最老可视等待和可视到请求开始时延摘要；browser smoke 改为同页普通/重图竞争，并记录实际扩展目录与关键调度文件 SHA-256。
- 兼容：资源链接、访问码、fresh TXT、缓存 key/TTL/结构、消息协议、Manifest 权限与 host 权限均不变。

## 1.16.0 (2026-07-17)

- 弱图并发：保留兼容 key `firstScreenConcurrency`，在设置中明确呈现为“弱图可见并发”。普通/弱图无论来自首屏还是滚动后的后台 pending，只要进入真实可视范围或由用户手动重试，即可使用这条独立并发；重图继续使用自己的 `heavyImageConcurrency`。
- 可视优先：新增公开 `viewportPriorityReservedSlots`，默认 2、范围 0–128。离屏弱图只使用未保留容量，并始终至少保留 1 路持续推进；可见弱图可使用完整弱图并发。保留只限制离屏弱图 active，不会把默认重图并发 2 压回 1，也不会让混合页普通后台任务被在途重图永久挡住。
- 预设：popup 与页面悬浮设置新增弱图“温和 / 均衡 / 快速”三档预设，统一由 `settings-schema.js` 生成，同时协调弱图可见并发、可视保留槽、普图后台并发、普通图同域并发、后台速度及自定义间隔；不修改重图参数、用户显式全局总并发、缓存或抓取/显示上限。
- 验证：新增滚动后可见弱图提速、离屏保留、离屏持续推进、重图并发不回退、混合普通任务不阻塞，以及共享预设与浮窗应用行为回归；完整 verifier、资源提取和 loading policy 契约通过。
- 兼容：资源链接、访问码、fresh TXT、缓存 key/TTL/结构、消息协议、Manifest 权限、旧设置 key 和 v1.15.4 host 健康代际修复保持不变。

## 1.15.4 (2026-07-17)

- 根因修复：重图同一任务的多个 fallback 坏 URL 不再分别累加 host 失败；同一任务、同一 host、同一健康代际最多贡献一次失败，不同任务仍独立计数，避免两个任务的 2–3 个候选快速击穿默认阈值并误判整台图床故障。
- 恢复隔离：普通/重图请求在真正设置当前 `img.src` 前记录 host 健康代际；冷却到期、探针恢复或降级后成功会推进代际，恢复前启动的迟到失败不再重新污染新窗口。失败去重也使用请求启动代际，迟到失败不会吞掉同一任务恢复后发起的真实新失败。
- 重图恢复：成功探针会抵消滚动失败记录；完成恢复时清空失败窗口和指数冷却计数，下一次真实故障从基础冷却重新开始，不再沿用 20→40→60 秒的旧退避历史。
- 可见优先：重图 host 处于 OPEN 时，离屏任务继续 deferred，不推进候选或结算失败；真实可见图和手动重试可按公开 `heavyProbeConcurrency` 使用受控探针，并继续同时受用户重图 ceiling、全局总并发和普通图保留槽位约束。
- 工具链：维护者归档脚本在源码目录没有 `.git` 时跳过 Git 状态读取，仍按当前工作树生成可验证交接包。
- 验证：新增同任务 fallback 去重、跨任务计数、普通/重图迟到失败隔离、恢复清空冷却、OPEN 离屏延迟/可见探针、探针并发和总 ceiling 动态回归；完整 verifier、资源提取与 loading policy 契约通过。
- 兼容：资源链接分类、访问码、fresh TXT、文章/图片缓存 key、TTL、值结构与完整态、消息协议、Manifest 权限、设置 schema 及全部公开上限保持不变。

## 1.15.3 (2026-07-17)

- 现场复测补强：首次修复后，真实 Chrome 日志已出现 host 可见保底字段，但普通离屏请求与重图仍可能先占满全局槽，导致可见 pending 无法进入 host admission。现在离屏工作会按公开“普通图保留槽位”预留少量全局容量，真实可见图和手动重试可立即使用；小并发下按总槽比例收敛，避免把后台吞吐压成单路。
- 现场修复：真实 `forum-95` 页面复现 217 个 wrapper、24 个可见空占位 4 秒零推进；日志确认 `tu.ewrewej.la` 因少量坏链进入普通 host 单槽冷却，唯一槽又被离屏 `lazy/low` 请求占用，之后每约 30 秒只失败一张并再次冷却。
- 调度修复：普通 host 冷却期间不再被同批在途失败反复延长；冷却到期会清除旧失败窗口并恢复用户配置并发，达到公开“恢复成功数”后也会立即恢复。真实可见图使用不超过普通 host 软限制的独立保底槽，离屏单槽探针不能再饿死可见图片；页面首屏任务在 admission 前即可携带真实视口优先级。
- 首屏修复：离屏首屏任务从 viewport pending 变为可见时继续使用 `firstScreenConcurrency`，不再被降成默认单路后台并发。自动 `viewportPendingLimit` 统一按公开后台策略计算，首屏和后台不再各自产生不同上限而让远处占位封死后台补图。
- 持续推进：pending 容量和图片槽释放统一合并唤醒全局调度，手动重试失败也显式继续调度。OPEN 重图 host 只在剩余候选全部属于同一 OPEN host 时整线程延迟；混合线程会扩大轻量批次到最近健康候选，让普通图越过 OPEN 重图继续加载。仍属当前 generation 的 detached pending 会重建 wrapper，grid 已失效时则安全结算，不再静默丢任务并锁住 `bgBatchPending`。
- 重图修复：重图预算和恢复判断纳入内部 `.atp-scroll-viewport` 裁剪，被内部容器裁掉的图片不再发生 unload→restore 反馈环或虚增可见 MP。canvas 预览捕获失败时保留原图和可见状态，不再产生无 src、无 preview 的永久灰块。
- 恢复修复：重图三次快速恢复失败后，真实可见缩略图进入 15 秒低频 watchdog，不再静止于无定时器的死端。页面与多个内部滚动根切换时会立即复位上一根的自适应 margin；没有 pending 的内部根不会创建或残留 observer 状态。
- 验证：新增普通 host 离屏阻塞/可见保底、冷却到期恢复、冷却不续期、重图内部裁剪、预览捕获失败保源、恢复 watchdog、空滚动根和多根切换回归；完整 verifier、资源提取/loading policy 契约和 Chrome isolated-world smoke 通过。
- 兼容：资源分类、访问码、fresh TXT、缓存 key/TTL/值结构与完整态、消息协议、权限、设置 schema 和用户公开并发/超时配置均不变。

## 1.15.2 (2026-07-17)

- 全站启动：继续覆盖 Manifest 已允许的 `sehuatang.org` / `sehuatang.net` 全部页面，不增加 `forum-95` 或路径白名单。无帖子页面经过最多 4 次短退避检查后进入低成本 dormant 观察；帖子节点或列表容器稍后出现时自动唤醒完整扫描，避免全站常驻滚动和高频 DOM 扫描。
- 正文解析：同源文章网络请求继续按 `articleFetchConcurrency` 并发，HTML 响应进入单解析队列；资源、TXT 附件和图片三个同步解析阶段之间按帧让出主线程，全部完成后才沿用原规则归一化和写缓存，降低批量正文返回时的长任务尖峰。
- 图片调度：首屏配额与网络优先级解耦，只有真实可见图和手动重试使用 `eager/high`；离屏首屏图进入受 `viewportPendingLimit` 约束的懒加载 pending，隐藏页允许继续加载时使用 `eager/low`。后台任务在创建 wrapper 前固定 viewport 模式，避免绕过网络槽位。
- 滚动与重图：页面和 `.atp-scroll-viewport` 内部滚动根均按方向/速度自适应 200-1000px 预取边界；overflow 裁剪后的图片不再误判为可见。重图恢复前重新计算真实可见性，可见图为 `eager/high`、预取图为 `eager/low`。
- 渲染降载：loading 占位默认使用静态渐变，只有真实进入零边距可见区时才运行 shimmer；成功、失败、取消、重试、隐藏页恢复和销毁路径均清理动画观察状态，`prefers-reduced-motion` 继续强制禁用动画。
- 工具链：扩展与维护者打包脚本在 PATH 同时存在多个 Node 时固定选用首个可执行文件，并使用稳定的 `article-thumbnail-preview` 归档名而不再依赖源码目录名；新增 dormant 唤醒、解析分帧/串行、离屏 pending 上限、内部滚动根、自适应预取、shimmer 生命周期和优先级回归。
- 兼容：资源分类、访问码绑定、fresh TXT、缓存 key/TTL/值结构与完整态、消息协议、Manifest 权限、host 权限、用户设置 schema 和全部公开并发/超时语义不变。

## 1.15.1 (2026-07-16)

- 性能：首屏图片调度加入真实视口距离优先级；当前视口及前后 200px 内的帖子先按轮询公平占用槽位，快速跳页或滚动后不再继续优先推进远处帖子。
- 性能：后台候选的 wrapper/IntersectionObserver 注册与真实图片网络槽分离；单轮可在 8ms 时间片内批量注册到公开的 `viewportPendingLimit`，不再按图片并发和 300ms 默认间隔逐张创建占位。
- 兼容：真实图片请求仍受全局总槽、普通/重图并发、host 自适应降载、超时、fallback、隐藏页暂停和重图解码预算控制；抓取/显示上限、资源分类、访问码绑定、fresh TXT、缓存格式、消息协议和 Manifest 权限不变。
- 验证：新增真实视口首屏公平性、网络满槽时批量注册懒加载 wrapper、pending 高水位及压力场景回归；资源提取 8 类 fixture 和 loading policy 契约继续通过。

## 1.15.0 (2026-07-14)

- 架构：新增 `loading-policy.js` 作为加载策略唯一入口；正文抓取、图片总并发、普通图同域并发、重图状态机、候选回退、任务期限、viewport pending 和重图解码预算全部读取归一化后的公开设置。
- 性能：正文抓取改为持续补位的流式 worker 调度，单篇完成即可提交，不再等待整批最慢请求或固定 250ms 批间空转；后台图片队列按真实空槽推进，不再使用每轮 10 个任务的隐藏上限。
- 修复：删除重图 8 秒、冷却 3.5 秒、过期 6 秒以及混合场景 1/3 槽位等隐藏截断；重图 host 使用可配置的 fixed/adaptive 状态机，开路候选保持 deferred，恢复后继续，不再批量结算为永久失败。普通图删除固定 5 次失败/2 分钟的旧域名熔断，统一使用公开 host 自适应参数。
- 设置：新增“专家调优”组并扩大原有可见范围，普通图与重图的单槽候选回退均可独立调整。默认值和建议值继续提供，但用户保存的合法设置是运行时权威；并发下降只停止新 admission，并发提高会唤醒队列，超时变化作用于新请求。
- 验证：新增 loading policy 契约测试，验证 44 秒超时、20+ 并发、0=不限预算和自定义正文/host/pending 参数；更新调度、渲染、设置一致性、打包和浏览器 smoke 守护。
- 交接：新增 `维护者交接指南.md` 与 `tools/package-maintainer-handoff.ps1`。维护包同时包含当前工作树源码、测试、工具、文档、可安装扩展、逐文件哈希和 SHA-256，并排除 Git 元数据、本地 agent 配置、日志和本机私有路径。
- Breaking change：无；Manifest 权限、host 权限、缓存 key/TTL/值结构、既有消息值与旧设置均保持兼容。

## 1.14.362 (2026-07-14)

- 文档：新增 `插件技术总览.md`，面向代码评审者、维护者和开源协作者，详细说明功能分类、Manifest V3 架构、扫描/抓取数据链、普通图与重图调度、资源链接/TXT 提取、25 项设置、缓存、日志、测试和发布边界。
- 发布：README 增加技术总览入口，源码发布公开文档白名单与 staged 文件集合纳入该文档；扩展安装包仍排除全部 Markdown、`tests/` 和 `tools/`。
- 涉及文件：`插件技术总览.md`、`README.md`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无；运行时代码、Manifest 权限和 host 权限、缓存 key/TTL/值结构、消息协议、25 项设置及其默认值/范围、普通/重图并发和所有图片上限均不变。

## 1.14.361 (2026-07-13)

- 验证：新增无第三方依赖的 `tools/browser-smoke.js`，使用一次性浏览器用户目录和本地 HTTPS Discuz 夹具验证打包后的 unpacked 扩展，不访问真实论坛，也不修改用户日常浏览器配置。
- 覆盖：浏览器 smoke 会核对扩展 isolated world、唯一悬浮根、同源/跨域文章、24 张普通图首屏及滚动后后台续载、20 张重图、普通/重图实际并发峰值、网盘访问码绑定、跨域 fresh TXT、popup/background 消息、多标签和 BFCache 恢复，并拒绝运行时异常或扩展控制台错误。
- 实测：Playwright Chromium 148 与 Microsoft Edge 150 均通过；普通图首屏 10/10、滚动后继续加载，重图首屏 5/5，实际并发峰值分别为 3 和 2，BFCache 返回 `pageshow.persisted=true`。官方 Chrome 150 会忽略自动化 `--load-extension`，仍需通过扩展管理页手工加载时验证。
- 安全：临时证书、浏览器 profile 和夹具只生成在系统临时目录，自动清理前校验固定前缀；测试工具继续由 Manifest 白名单发布包排除。
- 涉及文件：`tools/browser-smoke.js`、`README.md`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无；v1.14.360 的运行时调度、资源提取、设置、权限、缓存格式和所有用户可调数值保持不变。

## 1.14.360 (2026-07-13)

- 性能：content/background 的文章抓取改为并发上限仍为 3 的补位 worker pool，单个慢请求不再卡住同一固定批次里的后续文章；不修改用户可调的抓取上限、显示上限、图片并发、超时、重试或重图预算。
- 修复：图片总 active 槽位使用普通并发与重图并发两者的较大值，默认“普通后台并发 1、重图并发 2”可以真实启动 2 个重图任务；普通图仍严格受普通并发限制，混合任务总槽位不做相加。
- 修复：跨域 Discuz 临时 TXT 附件通过新增的 `FETCH_TEXT_ATTACHMENTS_FRESH` 消息按需重新提取；网盘访问码只绑定百度、夸克、115、阿里等网盘链接，不再错误附着到后续普通 ZIP/Torrent 链接。
- 设置：设置应用语义统一为 `live`、`hotReload`、`pageReload`，保留 `immediate` 兼容；普通显示/加载设置只触发缩略图热重载，不再先热重载后整页刷新。新增用户可调“调试日志”，默认关闭，DEBUG 关闭时 loader/viewport 会提前跳过热路径诊断快照构造，WARN/ERROR 保留。
- 验证与发布：新增独立资源提取夹具和测试，覆盖 8 类场景及 600 条链接压力输入；新增 Manifest 白名单打包脚本，可生成 `dist/chrome-unpacked`、版本化 ZIP 和 SHA-256，并保证 `tests/`、`tools/`、本地代理目录和 Markdown 不进入扩展安装包。
- 涉及文件：`background.js`、`content.js`、`fetcher.js`、`loader.js`、`logger.js`、`popup.js`、`floating-panel.js`、`settings-schema.js`、`shared-utils.js`、`viewport-observer.js`、`tests/`、`tools/`、`README.md`、`.gitignore`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无；已有消息值、Manifest 权限、host 权限、缓存 key/TTL/值结构和用户设置继续兼容。

## 1.14.359 (2026-07-13)

- 修复：content/background 缓存值写入成功但 cacheIndex 批量更新失败时，会异步触发一次完整索引重建；同一上下文重建期间的连续失败会合并，缓存值写入成功语义和响应时序不变。
- 修复：content 创建悬浮设置面板前会清理没有活实例持有的遗留 `#bfp-root`；活实例继续作为权威，旧根无法确认删除时 fail-closed，不再创建第二个面板。
- 验证：`tools/verify.js` 增加 content/background cacheIndex 更新失败、重建合并/恢复，以及孤儿根、活实例和删除失败三种浮窗生命周期回归。
- 涉及文件：`cache.js`、`background.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.358 (2026-07-13)

- 修复：HTTP 200 返回的 Discuz 登录、权限、购买或下载拦截正文会识别为可重试不可用页，不再因没有图片/资源而写入文章负缓存；识别要求明确的提示页结构或购买动作，普通正文仅提及“登录/购买”不会误判。
- 修复：设置允许的 `gridGap=0` 现在会真实渲染为 `0px`，不再被 `|| 6` 回退覆盖。
- 重构：四个跨上下文消息类型集中到不可变的 `SharedUtils.MESSAGE_TYPES`，content、fetcher、popup、悬浮面板、cacheIndex 代理和 background handler 统一引用；实际消息字符串和响应结构不变。
- 验证：`tools/verify.js` 增加同源与 background 拦截正文、普通正文防误判和实际网格 CSS 零间距回归。
- 涉及文件：`shared-utils.js`、`background.js`、`content.js`、`fetcher.js`、`floating-panel.js`、`popup.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.357 (2026-06-23)

- 修复：`loader.js` 的 no-referrer fallback 不再用任务创建、排队或 slot claim 的墙钟时间判定过期；每次真正设置当前 `img.src` 前记录当前 src 起始时间，direct timeout/error 后同一 src 仍会获得一次独立 no-referrer 重试，重试 timeout 限制在 3-8 秒，candidate fallback 换 src 后重新获得一次机会。
- 修复：`loader.js` 新增普通图床 host 自适应降速，同页内同一普通 host 默认最多占用 6 个 active slot，连续失败后降到 2，进一步失败后降到 1 并短冷却，避免坏图床把 `firstScreenConcurrency/backgroundConcurrency` 全部占满；首屏仍保留优先级但不再绕过同 host 保护。
- 诊断：`image_retry` 补 `retryTimeoutMs`、`currentSrcAgeMs`、`hostActive`，`image_done` 补 release 后 active 预估字段，`schedule_state`/任务日志补普通 host active top 与 host 限速字段，方便确认 `no_referrer_deadline` 不再成批出现。
- 验证：`tools/verify.js` 增加 no-referrer retry、排队 88s、同 src 单次 retry、candidate 换 src、普通 host 失败降速和 release 后 active 下降回归测试。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.356 (2026-06-22)

- 修复：`viewport-observer.js` 在 pending 计数、统计、可见重试、slot 重试和隐藏页 drain 前清理已脱离 DOM、已 loaded 或任务失效的 pending wrapper，避免 `getPendingCount()` 长期偏高导致后台补图队列停在 pending budget。
- 修复：`loader.js` 在隐藏标签页且启用“不可见时暂停”时会取消已启动的缩略图 `<img>` 请求、释放当前图片 slot，并把未完成的 direct 任务重排；`viewport-observer.js` 会把已启动的懒加载 wrapper 放回 pending，避免隐藏页继续占用网络/解码资源和灰块卡死。
- 修复：`loader.js` 的 no-referrer fallback 改为使用剩余墙钟时间，默认只给一次短 grace，不再为 fallback 重启完整 `imageTimeout`。
- 修复：`renderer.js` 的缩略图视口高度计入 `.atp-scroll-viewport` 上下 padding；`content.css` 改为 border-box/inset 边线、loading 绝对覆盖和 `object-fit: contain`，减少只露图片边角和高度裁切。
- 验证：`tools/verify.js` 增加 pending prune、隐藏页 active load 取消重排、no-referrer deadline 和缩略图布局静态/动态守护。
- 涉及文件：`viewport-observer.js`、`loader.js`、`renderer.js`、`content.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.355 (2026-06-11)

- 修复：`cache.js` 与 `background.js` 的过期写入清理在删除前核对 storage 当前值仍属于该批写入，避免同一 cache key 已被新任务刷新后，旧任务因清缓存代际变化把新值一并删除。
- 修复：`content.js` 将扫描开始时间传入 `renderer.js` 的线程状态，resource-only 文章补写和 `loader.js` 的 loaded URL 延迟 flush 继续使用该时间，避免清缓存前已完成抓取、但稍后才渲染或加载图片的旧任务重新写回缓存。
- 收口：`tools/verify.js` 增加 content/background 同 key 新值所有权竞态回归，并增加扫描时间贯穿 renderer/loader 的静态守护。
- 文档：补齐 `PROJECT_OVERVIEW.md`、`使用说明.md` 与 `HANDOFF.md` 遗漏的 v1.14.354 发布锚点，并统一更新到 v1.14.355。
- 涉及文件：`cache.js`、`background.js`、`content.js`、`renderer.js`、`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.354 (2026-06-09)

- 修复：新增 `atp_cache_generation_v1` 缓存清理代际，popup 清理缓存会在发现/删除缓存前后写入代际，content/background 已排队或已开始的 article/TXT/负缓存写入在真正落盘前后都会校验代际，避免用户清理缓存后旧异步写入重新落盘。
- 收口：`cache.js` 与 `background.js` 的缓存写入集中点在 generation 读取失败时 fail-closed；quota 淘汰后的重试也会重新校验，过期写入不会更新 `cacheIndex` 或触发 legacy cleanup。
- 收口：`fetcher.js`、`content.js`、`renderer.js` 与 `background.js` 将异步 fetch/flush 的起始时间传入缓存写入，长耗时 TXT/文章结果不会跨过清理动作写回旧缓存。
- 验证：`tools/verify.js` 增加 content/background/popup 缓存清理代际动态回归和静态守护。
- 涉及文件：`shared-utils.js`、`cache.js`、`background.js`、`popup.js`、`fetcher.js`、`content.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.353 (2026-06-09)

- 修复：`logger.js` 与 `background.js` 在 flush 前读取 `atp_logs_cleared_at` 清空标记失败时改为 fail-closed，不再按“无清空标记”继续写入 storage，避免用户清空日志期间的短暂 storage 读取失败让旧内存日志回写。
- 收口：清空标记读取失败时会把当前批次重新入队并结束本轮写入；后续 flush 只有在能读取清空标记后才会按代际过滤并写入。
- 收口：`tools/verify.js` 增加 content/background logger 清空标记读取失败回归和静态守护，确认该路径不会写回旧日志。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.352 (2026-06-09)

- 修复：`content.js` 在帖子列表容器的父节点上增加轻量 `MutationObserver`，当站点整块替换 `#threadlist`/帖子列表容器时会断开旧 observer、提升扫描 generation、重新绑定新容器并触发快速补扫，避免列表替换后缩略图只能等滚动、BFCache 恢复或设置重载才继续扫描。
- 收口：父级 observer 只监听直接父节点 `childList`，不打开 `subtree`，保留现有帖子容器内部 observer 的窄范围扫描成本。
- 收口：`tools/verify.js` 增加父容器替换动态回归和静态守护，确认旧 observer 会被断开、新容器会被绑定、快速补扫会被安排，且 teardown 路径会清理父级 observer。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.351 (2026-06-09)

- 修复：popup 清空诊断日志和“一键清空缓存和日志”会写入 `atp_logs_cleared_at` 清空代际，content/background logger 后续 flush 会丢弃清空前已在内存队列中的旧日志，避免旧日志从 `buffer`、`flushQueue` 或 `retryBatch` 回写到 storage。
- 修复：popup 读取、过滤和导出诊断日志时会按清空代际过滤旧条目；清空失败会回滚清空标记，保持 fail-closed，不会把未删除的日志隐藏成已清空。
- 修复：popup 折叠态日志计数刷新新增序列保护，清空日志会让正在进行的 `refreshLogCount()` 失效，旧异步计数结果不再覆盖清空后的 `0`。
- 收口：`tools/verify.js` 增加 content/background logger 清空代际、popup 清空 marker、失败回滚、读取过滤和计数竞态回归。
- 涉及文件：`logger.js`、`background.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.350 (2026-06-09)

- 收口：`tools/verify.js` 默认模式发现 release 文件存在未暂存变更时，不再只输出 `worktree verify ok`，会明确标注 staged release files 未检查。
- 收口：默认 staged warning 现在会读取 index 中的 `manifest.json` 和发布文档版本锚点，提示 staged/worktree 版本差异，例如旧 staged 发布快照仍停在 `1.14.59` 时不会被误读为当前 worktree 已完成发布验证。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.349 (2026-06-09)

- 修复：`loader.js` 现在同时用 document capture scroll 监听内部缩略图滚动容器，用户在 `.atp-scroll-viewport` 内滚动时也会进入重图滚动降载状态，避免滚动过程中启动重图恢复或高 fanout 加载。
- 收口：`tools/verify.js` 新增 loader nested-scroll 动态回归，确认 document capture scroll 会触发 `isHeavyScrollActive()`，scroll idle 后会唤醒 visible pending 与重图恢复，并验证 teardown 对称移除 capture listener。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.348 (2026-06-09)

- 修复：content/background/popup 日志脱敏现在会按字段名遮蔽 `token`、`access_token`、`authorization`、`cookie`、`password`、`signature` 等敏感值，避免非 URL 字段值落入 storage 或日志导出。
- 收口：`tools/verify.js` 扩展 content/background/popup 日志脱敏回归，覆盖结构化 `fields`、background compact `data` 和 popup 历史 JSON `data` 导出路径，同时保留 URL query/hash 脱敏与路径上下文。
- 涉及文件：`logger.js`、`background.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.347 (2026-06-09)

- 收口：`tools/verify.js` 新增 loader/viewport 动态压力回归，模拟 500 个后台候选在 viewport pending budget、slot pressure、pending-full backoff 和 slot-release wake 下的组合路径，确认后台占位不会越过 pending 上限，visible pending retry 的布局读取保持有界，slot 释放后能继续推进 pending 加载。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.346 (2026-06-09)

- 修复：文章缓存不再持久化临时 TXT 附件 URL。Discuz 附件、`xia.ewrewej.la` 签名直链和带常见签名 query 的 TXT 直链会被视为 transient，只保留 `hasTextAttachments` / `textAttachmentCount` marker，避免签名参数或过期直链落入 article cache。
- 修复：content/background 的同源 TXT 附件 referrer 会剥离 query 和 hash 后再发送，避免把帖子 URL 参数带给附件请求；跨源 referrer 仍会被拒绝。
- 收口：`tools/verify.js` 增加 article cache signed TXT 隐私、pageUrl 净化、background transient response 过滤和同源 referrer 去 query/hash 回归，并补静态守护。
- 涉及文件：`shared-utils.js`、`cache.js`、`fetcher.js`、`background.js`、`content.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.345 (2026-06-09)

- 修复：`content.css` 与 `floating-panel.css` 在 `prefers-reduced-motion: reduce` 下会禁用普通缩略图和悬浮按钮的 hover scale，减少动态效果用户不再遇到缩放跳变。
- 收口：`tools/verify.js` 增加 reduced-motion hover transform 静态守护，防止未来只关闭 transition/animation 却保留实际缩放。
- 涉及文件：`content.css`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.344 (2026-06-09)

- 收口：`tools/verify.js` 的 mixed worktree 提示现在会列出前几个未暂存 release 文件，并对剩余数量做摘要；默认验证不再只给出数字，发布前能更快看出 staged 快照与当前工作树的差异来源。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.343 (2026-06-09)

- 收口：`tools/verify.js` 增加隐藏页 `loadPendingWhenHidden()` 回归，确认长列表 pending drain 会按请求上限派生扫描窗口，不会在 `pauseWhenHidden=false` 的隐藏页槽位释放路径中全量扫过大量离屏 pending。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.342 (2026-06-09)

- 修复：`background.js` 的文章响应现在会过滤 Discuz 临时 TXT 附件 URL，并保留 `hasTextAttachments` / `textAttachmentCount` marker；跨域首次渲染后按需解析 TXT 时，会重新提取临时附件链接，不再直接请求可能过期的 raw Discuz URL。
- 修复：`shared-utils.js` 的 Discuz 附件判定支持 `sehuatang.org` 与 `www.sehuatang.org` 等同站点 host alias 互跳，仍拒绝跨站 host。
- 优化：`logger.js` 对结构化 object 日志只执行一次字段归一化，复用到 `fields`、`data` 和 console 输出，减少 loader/viewport 高频诊断日志的重复递归清洗成本。
- 收口：`tools/verify.js` 增加 background Discuz TXT marker 动态回归、Discuz host alias 回归、logger 单次 normalize getter 回归，并补对应静态守护。
- 涉及文件：`shared-utils.js`、`background.js`、`logger.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.341 (2026-06-09)

- 修复：`extractTextAttachments()` 在生成 TXT 附件候选前统一通过 `cleanResourceUrl()` 清理 URL；裸文本 `xia.ewrewej.la` 签名直链或 Discuz 附件链接后接中文标点、括号、逗号等说明文字时，不再把尾随标点编码进真实下载 URL。
- 收口：`tools/verify.js` 增加裸文本 signed xia 后接中文标点的回归，并补静态守护确保 TXT candidate 解析前始终先做资源 URL 清理。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.340 (2026-06-09)

- 修复：`shared-utils.js` 会直接识别无 `.txt` 后缀的 `xia.ewrewej.la` 签名 TXT 下载直链，文章页锚点和裸文本链接都能作为 TXT 附件候选进入按需解析。
- 修复：Discuz 附件 URL 判定改为大小写不敏感，并补充 `attachid` / `attachmentid` / `aid` 形态，避免 `MOD=attachment` 或 `Attachment.php` 等临时附件链接被误判为可缓存外部 TXT。
- 收口：TXT 附件提取和中转下载 URL 提取统一用 `normalizeTextAttachmentUrl()` 去重，query 顺序或 hash 不同的同一附件不再重复进入候选，也减少混合 marker 的误触发。
- 收口：`tools/verify.js` 增加 signed xia 直链、raw signed link、Discuz 大小写、跨 host 拒绝和 query/hash 归一去重回归，并补静态守护覆盖 shared allowlist 与提取路径。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.339 (2026-06-09)

- 修复：`viewport-observer.js` 的 pending retry timer 清理现在会同步重置 visible pending 空扫进度；hidden pause、BFCache/pagehide、公开 pause 或 destroy 后恢复时，不再沿用旧空扫计数过早停止 80ms 自重试。
- 收口：`tools/verify.js` 增加 visible pending 空扫计数清理回归，并补静态守护确保 `clearPendingRetryTimers()` 始终重置 stale empty-scan state。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.338 (2026-06-09)

- 修复：`renderer.js` 在混合 TXT marker 需要重新提取 Discuz 附件时，如果 fresh extraction 抛错、返回异常或 reject，会回退解析已缓存的外部 TXT 附件；不再因为重新提取失败而跳过原本可解析的 cached TXT。
- 保持：纯 marker-only 状态没有可缓存 TXT URL 时仍保留可重试失败反馈，不伪造成功状态。
- 收口：`tools/verify.js` 增加 mixed TXT fresh-failure fallback 动态回归，并补静态守护确保 fallback helper、状态提示和 cached TXT 解析路径不被移除。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.337 (2026-06-09)

- 修复：`cache.js` 和 `background.js` 的 TXT 正缓存/失败缓存读取改为逐 key 验证有效候选；hashed current key 为空、过期或无效时会继续检查 legacy raw key，命中 legacy 后仍迁移到 hashed key 并清理 raw key，不再被无效 current 值遮挡。
- 修复：`cache.js` 保留“可缓存外部 TXT + 未缓存 Discuz 临时附件”混合场景的原始附件 marker；`renderer.js` 在 cached TXT 数量只是子集时会重新提取并合并 cached/fresh 附件，避免只解析外部 TXT 而漏掉 Discuz TXT。
- 收口：`tools/verify.js` 增加混合 TXT marker、renderer cached+fresh 合并、content/background legacy 遮挡迁移的动态回归，并更新对应静态守护。
- 涉及文件：`cache.js`、`background.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.336 (2026-06-09)

- 修复：`popup.js` 的设置保存失败回滚会同步修复实际触发控件，顶层启用开关等非 schema id 控件保存失败后不再停留在错误勾选状态。
- 修复：`popup.js` 的“恢复默认设置”执行期间会临时禁用设置控件和恢复按钮，避免 reset 写入与其它设置保存交错导致状态提示或局部回滚互相覆盖。
- 修复：`viewport-observer.js` 在恢复中的重图被卸载时会清理 restore timeout、reveal listener 和 loader active-load control，避免快速滚动后残留失效恢复控制。
- 收口：`tools/verify.js` 增加 popup 保存失败动态回滚、reset 执行期锁定、恢复中重图卸载清理的回归，并补对应静态守护。
- 涉及文件：`popup.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.335 (2026-06-09)

- 修复：`popup.js` 的“恢复默认设置”在设置已成功写入后，如果后续重新读取 UI 失败，不再把界面回滚到旧设置；已保存的默认值会保留，并通过持久 warning 提示重新读取失败。
- 优化：`viewport-observer.js` 的 heavy IntersectionObserver 在同一批次恢复多个已卸载重图时复用一次 budget snapshot，避免 unloaded restore 路径对每个 entry 都同步扫描重图集合。
- 收口：`tools/verify.js` 增加恢复默认设置保存后 reload 失败回归，并扩展 heavy observer batching 回归覆盖多个 unloaded wrapper 同批恢复只读取一次 budget。
- 涉及文件：`popup.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.334 (2026-06-09)

- 修复：`popup.js` 从 cacheIndex 读取待清理缓存 key 时会同时校验 key 前缀；即使 `atp_cache_index_v1` 里混入 `settings`、日志 shard 或其它非缓存 key，也不会被清缓存按钮或一键清空当作缓存删除。
- 收口：`tools/verify.js` 增加 dirty cacheIndex 回归，确认 popup 仍保留真实缓存 key，同时忽略伪装成缓存类型的非缓存 key。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.333 (2026-06-09)

- 修复：TXT 附件正缓存和失败缓存改用 `SharedUtils.getTextAttachmentCacheKey()` 生成 hash 后缀，新写入的 storage key 和 cacheIndex entry 不再包含完整附件 URL、query token 或 hash；content/background 命中旧 raw TXT key 时会迁移到 hash key 并清理旧 storage/index，cacheIndex rebuild 和 background mutation 也不再接受 raw TXT key 更新。
- 改进：`floating-panel.js` 在设置保存进入队列后立即通过 live region 显示“保存中...”，连续保存时不会继续显示上一轮“设置已保存”误导当前状态；最终成功/失败仍由最新 `saveSeq` 控制。
- 优化：`viewport-observer.js` 的 `retryVisiblePending()` 在连续空扫覆盖完整 pending 集合且没有任何可尝试项后停止 80ms 自重试，避免长列表大量离屏 pending 在空闲状态下持续读取布局。
- 收口：`tools/verify.js` 补 TXT cache key 隐私、legacy 迁移、cacheIndex rebuild 过滤、浮窗保存中提示和 viewport 空扫停止回归。
- 涉及文件：`shared-utils.js`、`cache.js`、`background.js`、`floating-panel.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.332 (2026-06-09)

- 修复：`floating-panel.js` 的设置保存成功文案统一追加刷新提示；reset、重图预设或自定义成功文案只要涉及任一 `immediate:false` 字段，都会保留“需刷新页面生效”，不再把刷新要求吞掉。
- 修复：`loader.js` 的 release-driven viewport slot wake 在隐藏页且 `pauseWhenHidden=false` 时会继续 drain 已有 viewport pending，占槽释放后即使后台队列为空也不会卡住剩余隐藏页懒加载占位。
- 收口：`tools/verify.js` 增加 manifest 权限精确白名单，覆盖 `permissions`、`host_permissions`、content script matches、web accessible resources matches，并拒绝 `optional_permissions`、`optional_host_permissions` 和 `externally_connectable`。
- 涉及文件：`floating-panel.js`、`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.331 (2026-06-09)

- 优化：`scanner.js` 在滚动或结构变化导致 `scanState` reset 后，支持根据当前视口上边界一次性 seek 到长列表中段附近，并保留少量回退行；同一 cursor 的后续批次继续从上次位置续扫，不会每轮重新跳回视口起点。
- 优化：`content.js` 的候选扫描上下文缓存 `viewportTop`，并把 `seekViewportStart` / `viewportTop` 传给 scanner，深滚后不再从列表顶部逐项过滤大量离屏帖子；below-viewport 空链扫停止逻辑、滚动队列原地压缩和结构性 cursor 清理语义保持不变。
- 优化：`viewport-observer.js` 的 heavy IntersectionObserver 回调改为 0ms 合并 budget reconcile，避免同一轮 observer 回调同步构建 heavy render snapshot。
- 收口：`tools/verify.js` 补 scanner 深滚 viewport seek、content seek 参数传递、heavy observer budget 合并以及对应静态守护。
- 涉及文件：`scanner.js`、`content.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.330 (2026-06-09)

- 修复：`popup.js` 启动期设置读取完成后只会清理仍然显示“正在读取设置...”的状态，不再覆盖并发 `refreshLogCount()` 写入的持久“读取日志计数失败”错误。
- 修复：`floating-panel.js` 的参数说明按钮会在展开时把 `aria-label` 同步为“关闭参数说明”，收起后恢复“打开参数说明”，避免读屏名称和 `aria-expanded` 语义冲突。
- 改进：`resource-panel.js` 的无当前帖子空态现在也是 polite live region；`content.js` 的 MutationObserver 只对外部新增的帖子行/标题链接特征清 scanner cursor 并触发重扫，避免无关广告或计数节点插入反复打断滚动续扫。
- 收口：`tools/verify.js` 补 popup 启动状态 race、floating help label、resource no-thread live region 和 mutation 噪声过滤回归。
- 涉及文件：`popup.js`、`floating-panel.js`、`resource-panel.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.329 (2026-06-09)

- 修复：`resource-panel.js` 的窄屏内联资源栏在 TXT 解析出现“解析中、失败、部分成功可重试”等持久状态时，会把非空状态渲染为 `role="status"` polite live region；空状态占位仍保持普通 span，避免无内容重复播报。
- 收口：`tools/verify.js` 更新资源面板 inline status 静态守护，并把后台补图 idle timeout 动态回归扩展为 extreme / veryfast / fast / normal / slow 速度矩阵，确认短 100ms 下限不会覆盖 normal / slow delay。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.328 (2026-06-09)

- 优化：`loader.js` 的后台补图 `requestIdleCallback` timeout 改为跟随 `backgroundSpeed` delay，使用短 100ms 下限，不再固定使用 1000ms 地板；忙页面下 fast / extreme 后台补图不会额外被 idle timeout 拖慢近一秒。
- 收口：`tools/verify.js` 更新后台 idle cleanup 回归，确认 fast 背景速度会使用 100ms idle timeout，并加静态守护禁止恢复 `Math.max(1000, delay)`。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.327 (2026-06-09)

- 修复：`scanner.js` 的文章链接选择会跳过不可用的早期 selector 命中；当 `.icn a[href]` 是 `javascript:` 或 `#` 时，会继续回退到真实 `a.xst[href]` 等帖子标题链接，避免根容器探测或候选扫描漏掉有效帖子行。
- 改进：`renderer.js` 的缩略图“展开/收起”按钮补充并同步 `aria-label`，多帖列表中读屏用户不再只听到多个泛化的“展开”按钮。
- 收口：`tools/verify.js` 补 scanner 不可用 icon link 回退动态回归，并加静态守护覆盖文章链接 fallback 和展开按钮可访问名称同步。
- 涉及文件：`scanner.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.326 (2026-06-09)

- 优化：`content.js` 的滚动续扫候选队列改为原地压缩未消费项，不再用 `slice()` 为每次滚动保留候选分配新数组；已入队但未处理的帖子仍会继续保留，scanner cursor 仍按滚动视口失效。
- 收口：`tools/verify.js` 补滚动队列压缩回归，确认压缩后队列对象保持不变、未消费候选不丢，并用静态守护禁止恢复 scroll-time `slice()` 分配。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.325 (2026-06-09)

- 优化：`scanner.js` 的链式候选扫描会在同一个 `scanState` 仍持有有效 root 时复用根容器，连续批次不再重复执行 `findThreadContainer()` 的多轮根查询；结构性失效后仍会重新选择线程容器。
- 收口：`tools/verify.js` 增加 scanner root 查询计数回归，确认第二批续扫复用已验证的线程根，并更新静态守护。
- 涉及文件：`scanner.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.324 (2026-06-09)

- 修复：`popup.js` 的破坏性按钮确认 helper 会先归一默认确认提示，再用于显示和超时清理判断；未来调用方即使不传自定义提示，确认超时后也会清空 `popupStatus`，不会留下过期 warning。
- 收口：`tools/verify.js` 补二段确认边界回归，覆盖切换到另一个破坏性按钮会恢复前一个按钮、默认提示超时会清状态和恢复文案。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.323 (2026-06-09)

- 修复：`popup.js` 的破坏性按钮二段确认态支持 `Escape` 取消；键盘用户可以立即撤销“再次点击确认”状态，按钮文案会恢复，并通过 `popupStatus` 播报取消。
- 收口：`tools/verify.js` 增加确认态 `Escape` 取消动态回归和静态守护，确认取消会清除 `data-confirming`、恢复按钮文案并拦截按键事件。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.322 (2026-06-09)

- 修复：`popup.js` 的清理缓存、清理失败缓存、清除全部缓存、一键清空缓存和日志、恢复默认设置、清空诊断日志改为二段确认；首次点击只进入确认态并通过 `popupStatus` 提示，3 秒内再次点击才执行，降低误删缓存、日志和设置的风险。
- 收口：`popup.css` 补确认态样式，`tools/verify.js` 补按钮路径回归，确认首次点击不会删除数据，所有破坏性按钮都必须走共享确认 helper。
- 涉及文件：`popup.js`、`popup.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.321 (2026-06-09)

- 修复：`popup.js` 的诊断日志数量徽标在折叠态会先走轻量索引读取；若索引缺失且读到 0 条，再触发一次 storage key discovery，避免旧 content log shard 已存在但徽标初始显示 0，展开或导出后才跳变。
- 收口：`tools/verify.js` 增加折叠态日志数量恢复回归，确认索引缺失时可恢复 content log shard 数量，且在支持 `storage.getKeys()` 时不读取全部 storage value。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.320 (2026-06-09)

- 修复：`content.css` 为资源面板 TXT 解析按钮补齐 `aria-disabled="true"` 视觉禁用态，解析中按钮会降低透明度并显示 `not-allowed` cursor，不再在 hover 时表现为可点击。
- 收口：`tools/verify.js` 补资源面板 TXT 解析按钮 disabled CSS 守护，并确认侧栏与内联两个点击入口都会忽略 `aria-disabled` 的 loading 按钮。
- 涉及文件：`content.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.319 (2026-06-09)

- 优化：移除 `content.js` 启动期无消费者的用户交互唤醒监听，不再为 `click`、`keydown`、`scroll`、`mousemove`、`wheel` 注册一次性 document listener，也不再维护未被读取的 `ATPState.userInteracted`。
- 收口：移除 `config.js` 的死 API `ATPConfig.onUserInteraction`，`tools/verify.js` 改为守护 content/config 不恢复这条空监听链路。
- 涉及文件：`content.js`、`config.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.318 (2026-06-09)

- 优化：`logger.js` 为 content logger 增加 `timezoneNameCache`，页面会话内首次解析 `Intl.DateTimeFormat().resolvedOptions().timeZone` 后复用结果，不再为每条日志重复创建 Intl formatter。
- 收口：`tools/verify.js` 增加 content logger timezone 缓存动态回归，连续写入多条日志时断言 formatter 只创建一次，并补静态守护。
- 涉及文件：`logger.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.317 (2026-06-09)

- 优化：`content.js` 创建浮动设置面板时会传入已读取并归一化的 `ATPConfig.settings`，`floating-panel.js` 启动期不再二次读取 `chrome.storage.local.get('settings')`。
- 优化：`floating-panel.js` 构造期只创建启动按钮和空面板骨架；设置控件延迟到首次打开面板时渲染，参数说明延迟到首次打开帮助时渲染，减少用户不打开设置时的隐藏 HTML 拼装成本。
- 收口：`tools/verify.js` 新增浮动面板构造器回归，断言构造期不读 settings、不渲染隐藏设置/帮助，并验证首次打开/首次帮助打开才渲染。
- 涉及文件：`floating-panel.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.316 (2026-06-09)

- 优化：`viewport-observer.js` 的 balanced 重图缩略图加载完成后，会先执行渲染预算协调，再把低清 canvas preview 预热延后到 `requestIdleCallback` 或短 timeout，不再在每张重图 onload 热路径同步 `drawImage()`。
- 保持：轻量缩略模式仍会在释放原图前立即生成轻量 preview；预算释放 `unloadHeavyImage()` 仍同步 `captureHeavyPreview()`，确保占位预览不丢。
- 收口：`tools/verify.js` 补 balanced 重图 monitor/restore 延迟预热、lightweight 即时预热、deferred prewarm 清理和静态守护。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.315 (2026-06-09)

- 修复：`loader.js` 的失败缩略图占位现在显示“加载失败，点击重试”状态文字；手动重试遇到图片并发槽已满时，会把可见文字、hover title 和 `aria-label` 更新为“正在加载其他图片，稍后重试”，并保留点击/键盘重试，不再只有图标和无变化反馈。
- 修复：`content.js` 的同源文章抓取异常日志恢复为可读中文“同源文章抓取异常”，避免 popup 诊断日志显示 mojibake 乱码。
- 收口：`tools/verify.js` 补失败占位槽满重试的动态回归、可见状态静态守护，以及同源异常日志中文文案守护。
- 涉及文件：`loader.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.314 (2026-06-09)

- 优化：`fetcher.js` 在 TXT 附件共享 deadline 已耗尽时，会直接返回可重试的未解析状态，不再启动同源 fetch、后台 `FETCH_TEXT_RESOURCES` 消息或本地 timeout timer，减少过期预算下的无意义网络和消息开销。
- 优化：`content.js` 的候选扫描会记录本轮是否已扫到当前视口下方；当本轮没有近屏候选且 scanner cursor 尚未耗尽时，不再继续每 250ms 链式空扫整页离屏列表，等待滚动、mutation 或 retry 重新触发。
- 收口：`tools/verify.js` 补 TXT 过期 deadline 短路和 below-viewport 空链扫描暂停的动态回归与静态守护。
- 涉及文件：`fetcher.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.313 (2026-06-09)

- 修复：`fetcher.js` 的 TXT 附件解析创建并复用一次共享 deadline，同源直抓、同源后台回退和跨域后台回退不再各自重置完整后台等待，慢响应或无响应 TXT 不会把单轮解析拖到 50 秒以上。
- 修复：`scanner.js`、`content.js` 和 `renderer.js` 增加父 `TBODY` 感知的已装饰候选判断；多行 `TBODY` 中父容器已注入缩略图或已标记处理后，旧 `TR` 候选不会二次注入。
- 收口：`tools/verify.js` 补 TXT 共享 deadline、多行 `TBODY`、queued `TR` 和 renderer 插入前 guard 的动态回归与静态守护。
- 涉及文件：`fetcher.js`、`scanner.js`、`content.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.312 (2026-06-09)

- 修复：`resource-panel.js` 的复制操作在 `navigator.clipboard.writeText()` 同步抛错或返回非 Promise 时，会回退到临时 textarea 复制并继续给出成功/失败反馈，不再出现点击复制无反馈。
- 优化：`background.js` 的 `FETCH_TEXT_RESOURCES` 对原始附件输入增加 `SharedUtils.BG_FETCH_MAX_TEXT_ATTACHMENTS=30` 扫描上限，避免大量无效/重复附件让后台 service worker 在线性过滤中消耗过久。
- 优化：`scanner.js` 的帖子候选扫描增加每轮节点预算，长列表里大量离屏候选被 `accept=false` 过滤时会暂停并通过 scanState 续扫，避免单次滚动扫描读取整页布局。
- 收口：`tools/verify.js` 补资源复制同步异常 fallback、TXT 原始附件 fanout 上限和 scanner 长列表离屏候选预算回归。
- 涉及文件：`resource-panel.js`、`background.js`、`shared-utils.js`、`scanner.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.311 (2026-06-09)

- 修复：`background.js` 的 `FETCH_IMAGES` / `FETCH_TEXT_RESOURCES` 消息输入只接受真实数组，`FETCH_IMAGES` 额外使用 `SharedUtils.BG_FETCH_MAX_URLS=60` 限制单次 fanout，避免类数组 payload 或异常超大数组放大后台 CPU/网络工作。
- 修复：`content.js` 滚动扫描保留未消费候选时会让 scanner cursor 重新校准，并强制后续 refill；快速滚动导致已入队候选被新视口过滤、再回滚时，能重新发现已越过的帖子，避免缩略图永久漏加载。
- 收口：`tools/verify.js` 补 background 非数组/超上限输入回归，以及 content 快速滚动/回滚候选恢复回归。
- 涉及文件：`background.js`、`shared-utils.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.310 (2026-06-09)

- 修复：`background.js` 的 `FETCH_IMAGES` 在安全 sender 的混合 URL 请求里，会为不在 allowlist 内的单个 URL 返回显式 `origin_disallowed`、`retryableEmpty=false` 响应，不再静默省略导致 content 误判为 `background_timeout` 并反复退避重试。
- 修复：`loader.js` 的 `clearBgTasks()` 现在清理完整后台 timer，而不只清 pending-full retry timer；热重载、禁用或状态切换后重新加入后台任务时，不会被旧 `GLOBAL_BG_TIMER` 的剩余延迟挡住。
- 修复：`resource-panel.js` 在侧栏空态但仍可手动解析 TXT 时，也渲染 `.atp-resource-msg` live region，手动解析调度失败或成功接受的反馈不再丢失。
- 收口：`tools/verify.js` 补混合 allowlist 后台响应、`clearBgTasks()` timer 重调度和资源空态 TXT 反馈通道守护。
- 涉及文件：`background.js`、`loader.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.309 (2026-06-09)

- 修复：`fetcher.js` 和 `content.js` 的后台 `sendMessage` 回调会先快照并消费 `chrome.runtime.lastError`，再判断请求是否已经因本地 timeout 进入 stale 状态；迟到回调仍不写 late warning，避免 Chrome 报 unchecked `runtime.lastError`。
- 收口：`tools/verify.js` 补 TXT 后台抓取和文章后台 fallback 的迟到回调动态回归，并把静态守护更新为要求先读取 `runtime.lastError` 再返回 stale。
- 涉及文件：`fetcher.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.308 (2026-06-09)

- 改进：`popup.js` 的诊断日志重绘会在替换 HTML 前判断用户是否接近底部。首次加载或原本就在底部时仍自动跟随最新日志；用户正在中间或顶部阅读旧日志时，搜索、筛选或缓存日志重绘不再强制跳回底部。
- 收口：`tools/verify.js` 补日志搜索/筛选缓存重绘的滚动位置动态回归，并加静态守护禁止无条件 `scrollTop = scrollHeight`。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.307 (2026-06-09)

- 修复：`content.js` 的跨域文章批量后台抓取在本地超时后，如果后台回调迟到，会先检查该请求是否已经完成；迟到回调不再读取 `chrome.runtime.lastError` 或写入“后台消息失败”warning，避免加载链路诊断日志出现已经按 timeout 处理后又追加的噪声。
- 收口：`tools/verify.js` 补静态守护，要求跨域后台回调先过滤 stale response，再读取 `lastError`。不改变后台抓取超时、重试、负缓存或主扫描策略。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.306 (2026-06-09)

- 修复：`popup.js` 初始化“当前站点”时会检查 `chrome.tabs.query` 是否可用，并在回调中读取 `chrome.runtime.lastError`。当前标签页查询失败时，会清空当前站点、禁用“仅在此站点禁用”开关，并在 popup 状态区显示持久 warning，不再只隐式回退为 `--`。
- 收口：`tools/verify.js` 补 active tab 查询失败动态回归，确认查询失败时站点禁用控件保持 disabled、状态区保留 runtime lastError 文案，并补静态守护要求 `loadUI()` 消费 `tabs.query` 的 `lastError`。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.305 (2026-06-09)

- 修复：`resource-panel.js` 的侧栏和内联“解析TXT”按钮改走统一的手动调度 helper。`ATPRenderer` 缺失、调度函数同步抛错或返回未接受状态时，会立即清除本地 loading、保留可重试状态，并通过 live region 给出错误反馈，不再无反馈中断或误报“解析中”。
- 修复：`renderer.js` 的 TXT 资源调度建立明确 `true/false` 返回契约；早退返回 `false`，接受异步工作返回 `true`。TXT fetcher 或重新提取附件入口同步抛错、返回非 Promise 时，会统一走失败收尾，清掉 `textResourcesLoading`、保留 `textResourcesRetryable=true` 并刷新资源面板，避免按钮长期停在 `aria-disabled` 的“解析中”状态。
- 收口：`tools/verify.js` 补资源面板手动 TXT 调度缺失/抛错/返回 false 的动态回归，补 renderer 同步失败、非 Promise 和 marker-only 重新提取失败不滞留 loading 的回归，并更新静态守护为要求 guarded helper 和本地失败兜底。
- 涉及文件：`renderer.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.304 (2026-06-09)

- 修复：`floating-panel.js` 的页面浮动设置面板继续保持 `aria-modal="false"` 非模态 dialog 语义，但不再在 document 捕获阶段拦截 `Tab` / `Shift+Tab`，避免键盘用户被困在一个声明为非模态的面板里；`Escape` 关闭、预览浮层快捷键保护、面板内方向键隔离和外部点击关闭不变。
- 修复：`popup.js` 保存需要刷新后生效的设置时，会等待当前标签页刷新结果并检查 `chrome.runtime.lastError`；设置已成功写入但当前页查询、无活动标签页或 `tabs.reload` 失败时，状态区显示持久 warning“已保存，但刷新当前页失败…”，不会把已保存的设置当作保存失败回滚；恢复默认设置后的刷新失败 warning 也会保留。
- 收口：`tools/verify.js` 补浮窗非模态 Tab 默认行为、Escape 关闭、popup 保存后 reload 失败反馈的动态回归，并把静态守护从要求 focus trap/盲目刷新改为禁止这些旧行为。
- 涉及文件：`floating-panel.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.303 (2026-06-09)

- 修复：`content.js` 的 BFCache `pagehide/pageshow` 恢复路径新增 initialized / enabled guard，扩展未初始化或当前页已禁用时不再恢复 active image loads、loader visibility、observer、scroll 监听或浮窗，也会清掉 pending recovery/rescan 状态。
- 修复：滚动触发扫描不再丢弃已扫描但未消费的候选队列。`handleScrollScan()` 改为压缩已消费前缀并保留未消费候选，继续复用 scanner cursor，避免深滚动期间跳过上一批 `row-5..row-9` 这类已入队但还没处理的帖子。
- 收口：`tools/verify.js` 补 BFCache 禁用/未初始化不恢复动态回归，以及滚动队列压缩后继续消费未处理候选的动态回归；静态守护同步要求 BFCache guard 和滚动队列压缩行为。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.302 (2026-06-09)

- 改进：`popup.js` 启动时刷新隐藏日志计数失败后，除了把 `logCount` 置为 `!`，还会把“读取日志计数失败”写入 `popupStatus` 持久 live region，并使用 `alert` / `assertive` 语义，避免只显示一个无原因的错误计数。
- 收口：`tools/verify.js` 补隐藏日志计数失败的动态回归，确认计数、状态文本、`role=alert` 和 `aria-live=assertive` 同步进入错误状态；静态守护要求初始日志计数失败也写入持久状态区。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.301 (2026-06-09)

- 修复：`content.js` 滚动触发扫描时只清理当前候选队列，不再清空 `processCandidateScanState`，避免未耗尽的链式 selector 扫描在深滚动期间反复从 selector 0 重新开始；结构性失效、mutation、隐藏页暂停、BFCache pagehide、重载和失败清理仍继续走全量 `clearProcessCandidateQueue()` 并清空 scanner cursor。
- 收口：`tools/verify.js` 补 content 候选扫描 cursor 动态回归，确认滚动式队列清理复用同一个 scanner cursor、结构性清理会置空并在下一次扫描重新分配；静态守护同步禁止 `handleScrollScan()` 调用全量 cursor 清理。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.300 (2026-06-09)

- 修复：`floating-panel.js` 的设置浮窗不再在打开时声明 `aria-modal="true"`；该浮窗没有遮罩或背景 inert，继续按非模态 dialog 语义暴露，避免读屏用户被错误告知页面背景已不可交互。
- 修复：设置浮窗外部关闭监听从冒泡 `click` 改为捕获阶段 `pointerdown`，并保留捕获阶段 `mousedown` 回退，避免宿主页面 `stopPropagation()` 阻断外部点击关闭。
- 收口：`tools/verify.js` 补打开非模态语义、捕获阶段外部关闭、内部路径不误关和鼠标回退的动态回归，并替换旧的 `aria-modal=true` 静态守护。
- 涉及文件：`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.299 (2026-06-09)

- 改进：`popup.js` 诊断日志读取失败时，除了在日志内容区显示错误和把计数置为 `!`，还会把同一错误写入 `popupStatus` 持久 live region，并使用 `alert` / `assertive` 语义，避免读屏用户错过失败原因。
- 收口：`tools/verify.js` 补 popup 日志索引读取失败的动态回归，确认日志内容区、计数和状态 live region 同步进入错误状态。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.298 (2026-06-09)

- 修复：`content.js` 的 BFCache `pageshow.persisted` 不再重新置位已被可见 `visibilitychange` 消费的恢复状态，避免同一次恢复重复执行 active image recover、visibility sync、observer/scroll/panel 恢复和当前扫描。
- 收口：`tools/verify.js` 的 BFCache 生命周期沙箱改为先经过 `pagehide.persisted`，并新增 visibilitychange 先恢复、迟到 pageshow 不重复恢复的动态回归和静态守护。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.297 (2026-06-09)

- 优化：`popup.js` 日志导出摘要的 `buildLogSummaryStats()` 改用普通 `for` 循环单次扫描日志，不再用 `logs.forEach()` 分配回调；不改变日志格式、导出字段、过滤语义、权限或设置项。
- 收口：`tools/verify.js` 补 popup 日志导出摘要避免 `forEach` 回调分配的静态守护。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.296 (2026-06-09)

- 收口：默认 verifier 在实际发布白名单仍有 unstaged 变更时，首行改为 `worktree verify ok`，不再输出裸 `verify ok`，避免只看退出码或 grep 成功文本的脚本把工作区验证误判为 staged/release 证据。
- 收口：`ATP_VERIFY_PACKAGE=1` 在当前 mixed dirty/staged 状态下会输出 `release package: checked against current worktree only`，明确发布归档只与当前工作区逐字节一致，不证明 staged 快照或即将提交内容一致。
- 收口：新增 verifier 输出标签行为守护，并替换过期的自引用 `console.log('release package: checked')` 静态守护。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.295 (2026-06-09)

- 收口：`tools/verify.js` 的 staged 发布门禁改为从 manifest 引用、popup 引用、公开文档、`HANDOFF.md` 和 `tools/verify.js` 动态生成实际发布文件集合；默认 `staged release files: not checked` 提示和 `ATP_VERIFY_STAGED=1` 硬门禁现在会覆盖运行时 JS/CSS/HTML、图标和发布文档，而不只覆盖版本锚点文件。
- 收口：新增 staged release file set 行为守护，确认发布白名单包含 `background.js`、`shared-utils.js`、`loader.js`、`viewport-observer.js`、popup 资源和图标，并拒绝未引用文件进入 staged 发布集合。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.294 (2026-06-09)

- 收口：`tools/verify.js` 默认验证在发现发布相关文件存在 unstaged 工作区变更时，会输出 `staged release files: not checked` 提示，避免把工作区 `verify ok` 误解为当前 staged 快照也可发布。
- 文档：同步当前验证基线和真实 Chrome/BFCache 手工 smoke 标准；`ATP_VERIFY_STAGED=1` 仍是暂存区一致性的硬门禁，当前 mixed dirty/staged 工作树不要直接按 staged 快照发布。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.293 (2026-06-09)

- 修复：后台文章抓取复用 shared in-flight 前会丢弃已 abort 但尚未 cleanup 的旧 entry，避免新请求误复用旧 `deadline_exhausted` promise；后续请求会重新发起有效 fetch。
- 优化：大 HTML 的 DOM 图片提取在进入 `DOMParser` 前改走 regex fallback，避免 `parseFromString` 和多次 `querySelectorAll` 在 content 主线程上形成不可中断长任务；普通 DOM 路径仍保留 250ms soft collection guard。
- 收口：`tools/verify.js` 补 abort 后 cleanup 前重复请求的动态回归，以及大 HTML 不进入 DOMParser 的动态回归和静态守护。
- 涉及文件：`background.js`、`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.292 (2026-06-09)

- 修复：后台文章抓取的 shared in-flight 请求现在使用可扩展的 deadline abort control。短 deadline 调用者仍会按自己的等待窗口返回 `deadline_exhausted`，后续更长 deadline 的重复请求会延长底层 fetch abort timer，避免底层网络请求继续跑到默认超时或被第一个短调用者过早取消。
- 优化：DOM 图片提取路径补上 250ms soft collection guard，限制大量节点遍历和候选处理在 content 主线程上的拖尾成本。
- 收口：`tools/verify.js` 补 mixed-deadline 底层 abort timer 延长、deadline control 静态守护和 DOM 图片提取 time-bounded guard。
- 涉及文件：`background.js`、`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.291 (2026-06-09)

- 优化：线程缩略图状态改为非主动播报的静态状态文本，避免多线程图片加载时每个进度 tick 都通过屏幕阅读器播报。
- 优化：缩略图“展开/收起”按钮改用共享 CSS 类，补齐最小触控尺寸、hover 和高对比 `focus-visible` 样式；悬浮面板启动按钮焦点环也改为更高对比的双层轮廓。
- 收口：`tools/verify.js` 补线程状态非 live region、展开按钮尺寸/焦点样式、launcher 高对比焦点环的静态守护。
- 涉及文件：`renderer.js`、`content.css`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.290 (2026-06-09)

- 收口：`tools/verify.js` 继续加严 active image load stale token 动态断言，direct 旧 `onerror` 和 manual retry 旧 `onload` 现在会验证旧图片 handler 已清空，viewport 旧 `onerror` 也会验证没有成功误结算。
- 文档：同步当前验证基线说明，明确本版是 `v1.14.289` verifier 覆盖的断言强度收口；运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.289 (2026-06-09)

- 收口：`tools/verify.js` 补齐 active image load stale token 的动态覆盖，direct、manual retry 和 viewport lazy load 现在分别覆盖旧 `recover`、timer、`onload`、`onerror` 到达时的 registry 注销、旧 timer 清理、旧图片请求取消和新 slot 不被释放。
- 文档：同步当前验证基线说明，明确本版是 `v1.14.288` stale token 修复的 verifier 覆盖收口，运行时权限、host 权限、缓存 TTL、TXT allowlist、缓存索引条目格式和主加载策略不变。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.288 (2026-06-09)

- 修复：`loader.js` 的 direct 和 manual retry 图片加载在同一 task 被新 slot token 替换后，旧 `recover`、timer、`onload`、`onerror` 会注销 active-load control、清理旧 timer 并取消旧图片请求，不再滞留 registry 或把旧图误结算为成功/失败。
- 修复：`viewport-observer.js` 的 viewport lazy load 同步处理 stale slot token，旧请求不会释放新 slot、清空新 `wrapperData.activeSlotToken`、记录失败占位或绑定旧预览。
- 收口：`tools/verify.js` 补 direct、manual retry 和 viewport lazy load 的 stale token 动态回归，覆盖旧 error/load 到达时 registry 注销、旧 timer 清理、旧图片请求取消和新 slot 保持 active。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.287 (2026-06-09)

- 修复：`viewport-observer.js` 的 `pauseHeavyRestores()` 现在会清理正在恢复的重图请求自己的 per-image restore timer；`resumeHeavyRestores()` 会对仍有效的 active restore 按当前超时重新计时，避免隐藏页暂停或 BFCache 边界下旧超时继续取消图片并改写 DOM。
- 修复：`shared-utils.js` 的网盘资源分类改为按候选 URL 的真实 host/path 判定，避免站内跳转外壳被误分类为网盘资源；pan URL 归一化会统一 `www` host、尾随 `/`、hash 和非提码 query 参数顺序，减少等价链接重复显示/复制。
- 修复：`shared-utils.js` 的网盘访问码查询参数会先清理首尾空白和中文标点，再写入 `code`；URL query code 会覆盖旧缓存或外部合并资源里的 stale `code`。
- 收口：`tools/verify.js` 补 active restore pause/resume timer、外层跳转 URL、pan canonicalization、query code trim 和 stale cached code 覆盖回归。
- 涉及文件：`shared-utils.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.286 (2026-06-09)

- 修复：`shared-utils.js` 的网盘访问码查询参数现在会先清理首尾空白和中文标点，再写入 `code`，避免 `?pwd=%20AB12%20` 复制出带空格的访问码。
- 修复：`shared-utils.js` 的 pan URL 归一化现在让 URL 上的 `pwd/password/code` 明确覆盖旧资源对象里的 stale `code`，避免旧缓存或外部合并资源保留错误访问码。
- 收口：`tools/verify.js` 补查询参数访问码 trim 和 URL query 覆盖 stale cached code 的回归断言。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.285 (2026-06-09)

- 修复：`shared-utils.js` 的 `extractAccessCode()` 现在复用大小写不敏感的 URL 查询参数提码逻辑，`?PWD=` / `?Password=` / `?CODE=` 会优先于附近正文提取码，避免查询参数归一化后丢失正确访问码。
- 收口：`tools/verify.js` 补大写查询参数与附近冲突文本提取码同时存在时的回归断言。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.284 (2026-06-09)

- 修复：`shared-utils.js` 的网盘访问码查询参数现在按大小写不敏感方式识别和剥离，`?PWD=`、`?Password=`、`?CODE=` 等变体也会合并到 `code` 并参与同 URL 去重。
- 修复：`shared-utils.js` 的 anchor 局部提取码绑定改为按当前 anchor 在上下文窗口中的实际位置计算，避免多个同名“网盘”链接把前一个链接的提取码串到后一个链接。
- 修复：`cache.js` 在 content 侧 LRU 因 cacheIndex rebuild 失败跳过淘汰时会清理 pending baseline，避免 stale 高水位影响后续淘汰。
- 修复：`logger.js` 不再从 manifest content script 注册 `beforeunload`，改为 `pagehide` 和隐藏页 `visibilitychange` 尽力 flush，保持 BFCache 生命周期策略一致。
- 收口：`tools/verify.js` 补大小写访问码、重复 anchor 文本、content script beforeunload 禁止、logger pagehide/visibility flush 和 LRU baseline 清理守护。
- 涉及文件：`shared-utils.js`、`cache.js`、`logger.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.283 (2026-06-09)

- 修复：`shared-utils.js` 的旧缓存、TXT 缓存和外部合并资源现在也会剥离网盘 `pwd/password/code` 查询参数并回填到 `code`，避免 `normalizeResources()` / `mergeResources()` 路径再次出现带码版和裸链重复。
- 修复：`shared-utils.js` 的 href 预扫描不再用整页正文上下文绑定提取码，避免多网盘 anchor 场景把第一个提取码错误复制到后续链接。
- 诊断：`cache.js` 在 content 侧 LRU 因 cacheIndex rebuild 失败而跳过淘汰时会写入 warning，方便定位缓存压力未释放的原因。
- 收口：`tools/verify.js` 补 `?password=`、`?code=`、normalize/merge 输入路径、多 anchor 提取码绑定和 content LRU warning 的回归守护。
- 涉及文件：`shared-utils.js`、`cache.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.282 (2026-06-09)

- 修复：`shared-utils.js` 资源提取会把网盘访问码查询参数合并为 `code` 并从去重 URL 中移除，避免同一网盘链接的 `?pwd=` 版和裸链重复显示/复制。
- 修复：`shared-utils.js` 的结构化 href/anchor 扫描改为基于原始 HTML 真实标签，避免 `&lt;a href=...&gt;` 这类转义展示内容被当成真实网盘链接。
- 修复：`shared-utils.js` 的 `cacheIndex.rebuild()` 在索引写入失败时会失效旧 `atp_cache_index_v1`，避免 storage 删除已成功但旧索引继续被信任。
- 修复：`cache.js` 和 `background.js` 的 storage 删除后 cacheIndex 清理失败会尝试 rebuild；LRU/升级清理日志会区分索引未确认状态，不再把索引失败路径记录成完全成功。
- 收口：`tools/verify.js` 补网盘 `?pwd=` 去重、转义伪 anchor、cacheIndex rebuild 写失败失效、content/background 删除后索引重建的动态回归，并修复 verifier 主流程静默退出时的输出捕获。
- 涉及文件：`shared-utils.js`、`cache.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.281 (2026-06-09)

- 修复：`content.js` 在设置读取 Promise 尚未返回时遇到非 BFCache `pagehide`，会取消本次启动，避免离页后继续安装 storage listener、observer、scroll listener 或创建悬浮面板。
- 修复：`floating-panel.js` 设置读取失败后改为 fail-closed，禁用设置字段并阻止用默认值保存覆盖真实配置。
- 修复：`shared-utils.js` 资源提取遇到长帖中的网盘锚点时，会在重复 URL 上合并后续局部上下文提取码，避免整页 href 先去重导致复制缺少提取码。
- 收口：`tools/verify.js` 补非 BFCache pagehide 取消启动、悬浮面板设置读取失败关闭保存、长帖网盘锚点提取码合并的动态回归。
- 涉及文件：`content.js`、`floating-panel.js`、`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.280 (2026-06-09)

- 修复：`content.js` 初始化读取设置成功但启用页面流程失败时，会清理已安装的 storage listener、扫描 timer、observer 和日志 flush timer，并释放启动 guard，允许后续 DOM/load fallback 重试。
- 修复：`popup.js` 裁剪旧 content 日志 shard 时，`storage.remove` 失败不再阻断日志查看或导出；失败时保留原日志索引并继续读取现有日志。
- 修复：`logger.js` 清理 stale content 日志 shard 失败时会把 stale shard 继续保留在 `atp_logs_content_keys` 中，避免留下无法通过索引重试清理的孤儿日志分片。
- 收口：`tools/verify.js` 补 content 启用失败重试、popup 日志 prune 删除失败、content logger stale 删除失败的动态回归。
- 涉及文件：`content.js`、`popup.js`、`logger.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.279 (2026-06-09)

- 修复：`loader.js` 的重图 fallback 使用 replacement `displaySrc` 更新缩略图显示、日志和实际 `<img>` 加载，点击预览继续保留 `previewSrc` 原图语义。
- 修复：`content.js` 初始化读取设置失败后会释放启动 guard，后续 DOM/load fallback 可重试；成功初始化后仍只安装一次 storage listener。
- 修复：`viewport-observer.js` 的重图 restore 在 BFCache recover 遇到未完成但仍有效的请求时会重启 restore timer 继续等待，不再取消当前请求或重排队。
- 收口：`tools/verify.js` 补 display/preview fallback、content init retry、heavy restore recover、popup `storage.remove` 失败和 background idle cleanup 动态回归，并调整 no-referrer fallback 测试时序。
- 文档：`HANDOFF.md` 的公开仓库同步白名单包含 `HANDOFF.md`；扩展上传包仍排除 `HANDOFF.md` 和本地工具目录。
- 涉及文件：`loader.js`、`content.js`、`viewport-observer.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.278 (2026-06-09)

- 修复：`loader.js` 和 `viewport-observer.js` 的 direct/retry/viewport 图片加载在 fallback、BFCache recover 或重启 timer 时会重新计算当前 timeout，避免慢图 stop-loss、cooling 或 stale background 的短超时被旧 timer 覆盖。
- 修复：BFCache pageshow 恢复未完成但仍有有效 `src/currentSrc` 且 wrapper 仍在文档中的 active 图片时，会重启 timer 并继续等待，不再立即记录失败、触发 fallback 或显示失败占位。
- 优化：popup 一键清空缓存/日志复用同一次 storage key discovery，缺失 cacheIndex 时不再重建索引；清空日志和一键清空不会写回即将删除的 `atp_logs_content_keys`。
- 修复：background 的 `CACHE_INDEX_MUTATION removeEntries` 接受 legacy/base 前缀 cleanup key，但 `updateEntries` 仍只允许当前 cache 前缀，避免旧缓存索引项阻断清理。
- 收口：release package/archive 校验现在强制包含 `CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md` 三份公开文档；`tools/verify.js` 补对应动态和静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`popup.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.277 (2026-06-09)

- 修复：非 background owner 的 `cacheIndex` mutation 在代理不可用时不再退回本地 storage 写入；队列 callback 抛错也不会卡住后续索引写入。background 只接受合法 `updateEntries/removeEntries` payload，并拒绝代理整表 `write`。
- 修复：`popup.js` 的日志 discovery/prune 写回 `atp_logs_content_keys` 失败时降级为 warning，不再阻断日志读取、导出或清理；`getKeys()` 失败仍回退到 `get(null)`。
- 改进：popup 清缓存/一键清空在真实 storage 删除成功但 cacheIndex 删除或 rebuild 失败时，状态条改用持久 warning 样式，不再用绿色成功掩盖部分失败。
- 收口：`tools/verify.js` 补非 owner 无代理、callback throw 队列、background payload 拒绝、日志索引写回失败、popup 真实按钮 warn 路径和 `tools/verify.js` staged 一致性检查回归。
- 涉及文件：`shared-utils.js`、`background.js`、`popup.js`、`popup.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.276 (2026-06-09)

- 修复：`shared-utils.js` 的 `cacheIndex` 写入现在由 background service worker 作为单写者处理；content script 和 popup 的 `write/updateEntries/removeEntries/rebuild` 会通过 `CACHE_INDEX_MUTATION` 消息代理到 background 队列，降低跨运行时整份索引读改写互相覆盖、丢新增项或复活已删除项的风险。缓存索引条目格式不变。
- 修复：`popup.js` 的普通清缓存和一键清空缓存/日志在实际 storage 删除成功后，不再因为 cacheIndex 删除失败把整次操作显示为失败；索引删除失败会尝试 rebuild，并在成功文案中提示“缓存索引已重建”或“缓存索引更新失败”。一键清空会先清空已加载日志视图和计数，再处理索引状态。
- 修复：`popup.js` 的日志索引读取在非 discovery 路径遇到 storage 失败时会抛出错误，让日志计数进入 `!` 错误状态，避免读取失败时用固定日志键显示偏小计数。
- 收口：`tools/verify.js` 新增 cacheIndex background 代理、background mutation handler、popup 索引部分失败清理、日志索引读取失败的动态回归，并同步静态守护。
- 涉及文件：`shared-utils.js`、`background.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.275 (2026-06-09)

- 修复：`content.js` 的可见 BFCache 恢复现在先 `recoverActiveImageLoads()` 重新计入 suspended slot，再同步 loader visibility 并唤醒调度，避免恢复瞬间调度器在旧 slot 计数为 0 时提前放行新加载。
- 修复：`logger.js` 在更新 content 日志分片索引前会通过 `chrome.storage.local.getKeys()` 合并真实存在的 sibling shard，降低多个 content script 同时 flush 时互相覆盖 `atp_logs_content_keys` 的风险。
- 修复：`popup.js` 的日志 discovery 改为权威重建 content shard 索引；旧索引里已不存在的 shard 不再参与本次读取，真实 content shard 为空时也会写回空索引。
- 收口：`tools/verify.js` 新增 content logger sibling shard 发现、popup stale/empty 日志索引重建、BFCache recover 早于可见调度、zip/crx 内存行为 fixture 的回归。
- 文档：`HANDOFF.md` 的最终 zip/crx 发布流程改为直接使用 `ATP_RELEASE_ARCHIVE=<zip或crx路径> ATP_VERIFY_PACKAGE=1 node tools\verify.js`，确保归档入口实际校验最终产物。
- 涉及文件：`content.js`、`logger.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.274 (2026-06-09)

- 修复：`content.js` 的 BFCache `pageshow.persisted` 现在先恢复 loader 可见性监听并同步隐藏页暂停状态；如果页面仍 hidden 且 `pauseWhenHidden=true`，会延后 active image recover 和当前扫描，等 `visibilitychange` 回到 visible 后再恢复，避免隐藏页恢复绕过暂停策略。
- 修复：`content.js` 的链式续扫和 rescan follow-up 改为共享可清理 timer，BFCache pagehide 会一并清掉，避免冻结页面后旧匿名 `setTimeout` 继续触发扫描。
- 修复：`loader.js` 在 BFCache recover 前会重新计入仍 current 的 suspended active slot，并重新计算重图 slot 计数，避免 pageshow 后继续加载的旧请求让全局并发统计长期低估。
- 修复：`shared-utils.js` 的 `cacheIndex.removeEntries()` 在索引读取失败时返回失败，缺失索引仍作为成功 no-op；`popup.js` 普通缓存、失败缓存和全部缓存清理改为按实际存在 key 计数，失败缓存说明同步标明会清 TXT 解析失败标记。
- 收口：`tools/verify.js` 支持 `ATP_RELEASE_ARCHIVE` / `ATP_RELEASE_ZIP` / `ATP_RELEASE_PACKAGE` 校验最终 zip/crx 发布归档，解压前拒绝路径逃逸、重复 entry 和大小写变体重复 entry；默认静态规则允许公开同步目录缺少本地 `.gitignore` / `CLAUDE.md`。
- 验证：新增 content 隐藏 BFCache 延迟恢复、follow-up timer 清理、loader suspended slot 恢复计数、cacheIndex 读失败语义、popup 实际 key 计数和发布归档入口回归。
- 涉及文件：`content.js`、`loader.js`、`shared-utils.js`、`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.273 (2026-06-09)

- 修复：popup 一键清空缓存和日志的成功数量改为统计实际存在的 storage key，避免固定候选 key、stale 日志索引或 stale cacheIndex key 被误计入已清空数量。
- 修复：content 外部设置变更需要热重载时不再先唤醒旧 loader/viewport 队列；BFCache `pagehide.persisted` 会清理内容层扫描 timer 和候选队列，`pageshow.persisted` 在可扫描时先消费旧 `rescanRequested` 再启动恢复扫描。
- 改进：资源面板从桌面侧栏切到窄屏 inline 时保留同语义按钮焦点；TXT 解析 loading 期间保留 `aria-disabled` 按钮，inline 手动解析会写入 live region，读屏用户能听到解析状态。
- 收口：`HANDOFF.md` 的公开仓库同步说明改为显式白名单，避免把内部 agent/交接文档当作根目录 Markdown 批量同步。
- 验证：`tools/verify.js` 新增 popup 实际 key 计数、content settings reload/BFCache 动态回归，并补资源面板焦点、TXT loading 按钮和 inline live region 静态守护。
- 涉及文件：`popup.js`、`content.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.272 (2026-06-09)

- 优化：popup 日志分片发现和缓存键兜底发现优先使用 `chrome.storage.local.getKeys()` 只读取 key 列表，避免展开/导出/清空日志或清缓存时反序列化全部缓存值。
- 兼容：旧浏览器或 `getKeys()` 失败时仍回退到 `chrome.storage.local.get(null)`，保留旧环境可用性。
- 验证：`tools/verify.js` 新增 storage `getKeys()` sandbox 和动态回归，确认日志 key discovery、缓存 key discovery 在支持 `getKeys()` 时不会发起 `get(null)` 全量读取，同时保留非数字 content log 分片过滤。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.271 (2026-06-09)

- 修复：popup 清空日志和一键清空缓存/日志时会作废正在进行的日志加载，避免旧 storage 读取完成后把已清空日志重新渲染回来。
- 修复：popup 发现 content 日志分片时只接受 `atp_logs_content_` 后跟数字时间戳的键，避免 `atp_logs_content_meta` 这类元数据键被当作日志分片读取、索引或清理。
- 修复：浮窗连续保存不同设置时，每个成功落盘的 patch 都会调用 `business.onSettingsChange()` 应用到当前页面；旧保存结果只抑制过期成功提示，不再跳过页面应用。
- 验证：`tools/verify.js` 新增 popup 清空日志 in-flight 回归、浮窗重叠保存回归、BFCache pageshow 恢复顺序/快速扫描动态回归，以及同一 task 在 BFCache suspend 后重新 acquire 的旧 token 释放回归。
- 涉及文件：`popup.js`、`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.270 (2026-06-09)

- 修复：BFCache `pagehide.persisted` 不再调用 `resetActiveImageSlots()` 取消 active image controls，改为 `suspendActiveImageSlotsForBfcache()` 只释放全局/重图槽位计数并保留 pageshow recover 控制柄。
- 修复：BFCache suspend 会把冻结 slot 标记为未计数；旧 frozen slot 在 pageshow recover 后释放时不会误扣后续新加载 slot 的计数。
- 优化：popup 诊断日志展开后缓存已加载日志，筛选/搜索只做内存 rerender；初次加载仍在进行时不会重复读取 storage，导出日志后也会保留当前展开筛选计数。
- 改进：窄屏 inline TXT 解析按钮增加带附件数量的 `aria-label`；浮窗窄面板下输入组合和复选行增加宽度约束与换行，避免控件溢出。
- 验证：`tools/verify.js` 新增 popup 日志缓存动态回归、BFCache suspend 动态/静态守护，以及 inline aria-label 和浮窗窄布局静态守护。
- 涉及文件：`content.js`、`loader.js`、`popup.js`、`resource-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.269 (2026-06-09)

- 修复：content 的 retryable empty 冷却和退避计数改用 normalized article key，同一文章的 query/hash 变体会共享 `Retry-After` / 负缓存冷却，避免绕过冷却重复抓取。
- 收口：实际发布目录校验会先规范化 manifest 和 popup 引用，拒绝 URL-like、绝对路径、通配符和 `..` 逃逸，避免发布包校验误用目录外文件；交接文档同步澄清公开仓库同步目录和扩展上传包不是同一个目录。
- 改进：inline 资源条的持久 TXT 状态改为普通文本，仅保留用户触发反馈的 live region；浮窗设置行在窄面板下允许标签换行，避免长标签挤压输入框和按钮。
- 验证：`tools/verify.js` 新增 content retryable empty normalized key 动态回归、manifest/popup 发布引用逃逸回归，并补 heavy restore completed recover 动态回归和相关静态守护。
- 涉及文件：`content.js`、`resource-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.268 (2026-06-09)

- 修复：同源文章抓取和后台 `FETCH_IMAGES` 在遇到 retryable 的 HTTP 429/5xx/401/403 时会解析 `Retry-After`，支持秒数和 HTTP date，并把绝对重试时间写入 `retryAfter`，避免服务端已给出冷却窗口时仍按 15-60 秒短退避反复重扫。
- 改进：popup 诊断日志内容区不再使用 `role="log"` / live region 批量播报，日志刷新只通过原子化的日志计数提示，避免最多 150 条日志刷新时读屏重复朗读。
- 验证：`tools/verify.js` 新增 Retry-After parser、同源 429 秒数、后台 503 HTTP-date 动态回归，并更新 popup 日志 a11y 静态守护。
- 涉及文件：`shared-utils.js`、`fetcher.js`、`background.js`、`popup.html`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.267 (2026-06-09)

- 修复：后台同 URL 文章 in-flight 复用不再把首个调用者的短 deadline 传给底层 fetch；共享 fetch 使用固定文章超时，每个调用者只通过 `waitForArticleDeadline()` 单独等待自己的 deadline，避免短预算请求污染后续长预算请求。
- 收口：实际发布目录校验现在会从 manifest 和 popup 引用构建发布文件集合，拒绝 `unused.js` 这类未被引用但扩展名看似合法的根 JS/CSS/HTML 文件混入发布包。
- 验证：`tools/verify.js` 新增 mixed-deadline in-flight 动态回归，确认短 deadline 调用者超时后，长 deadline 调用者仍能拿到共享文章结果；新增发布文件引用集合回归和静态守护。
- 涉及文件：`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.266 (2026-06-09)

- 增强：`tools/verify.js` 为 BFCache completed image recover 补动态回归，实际驱动 `ATPLoader.loadImageDirect()`、`ATPLoader.retryLoadImage()` 和 `ATPViewport.loadWrapper()` 注册 active recover handler。
- 验证：动态回归会把测试图片标记为 `complete && naturalWidth` 后触发 recover，确认 direct/retry/viewport 都走成功结算、释放 active slot、保留预览激活，并且不记录失败或失败占位。
- 维护：本版不调整运行时代码、权限、host 权限、缓存 TTL、TXT allowlist、候选提取或主加载策略，只强化 v1.14.265 BFCache 修复的行为覆盖。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.265 (2026-06-09)

- 修复：BFCache 恢复 active image loads 时，direct/retry/viewport 图片如果已经 `complete && naturalWidth`，会先走既有成功结算路径，不再误记为 recover 失败后触发 no-referrer/heavy fallback 或最终失败。
- 修复：重图 restore 的 BFCache recover 遇到已完成图片时会先调用 `restoreReveal({ type: 'load' })`，避免取消已恢复图片并重新排队。
- 验证：`tools/verify.js` 新增 BFCache completed image recover 静态守护，确认 direct/retry/viewport 在记录失败前先完成成功结算，重图 restore 在取消重试前先 reveal 完成图。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.264 (2026-06-09)

- 修复：`ATP_VERIFY_PACKAGE=1` 现在必须配合 `ATP_RELEASE_DIR` 校验实际发布目录，不再用项目根工作树里的 `.agents/.claude/.opencode/.codex` 检查替代发布包边界；通过时会明确输出 `release package: checked`。
- 增强：`ATP_VERIFY_STAGED=1` 的文档检查复用固定版本锚点，确认 staged `CHANGELOG.md` 首个版本标题、`PROJECT_OVERVIEW.md` 当前更新、`使用说明.md` 版本行和 `HANDOFF.md` 当前版本行都指向当前版本。
- 修复：浮窗参数说明进入 docked 视图时会把焦点从被覆盖的主面板控件迁到 help 内；旁侧布局改为检查左右单侧实际空间，避免面板居中时 help 被夹取并覆盖主面板。
- 涉及文件：`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.263 (2026-06-09)

- 修复：浮窗参数说明在窄屏且矮屏上下都放不下时，不再回退到视口顶部覆盖主面板，而是切换为主浮窗内部的 docked 视图，保留独立关闭按钮和内容滚动。
- 增强：docked help 打开时会临时隐藏被覆盖主面板内容的辅助语义，退出 docked 或关闭说明后恢复，避免读屏继续进入被遮住的控件。
- 验证：`tools/verify.js` 新增矮屏 docked 动态回归和静态守护，确认坐标清理、主面板状态、辅助语义隐藏/恢复和 docked CSS 都保留。
- 涉及文件：`floating-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.262 (2026-06-09)

- 改进：popup 在当前页面没有可用 http/https host 时，会在“仅在此站点禁用”行内显示持久说明“当前页面不支持站点禁用”，并通过 `aria-describedby` 关联 disabled checkbox，避免触屏和读屏用户只能依赖不可触发的 disabled 控件或 `title`。
- 验证：`tools/verify.js` 新增无效站点禁用持久提示动态回归和静态守护，确认无 host 时提示可见、有效 host 后清空提示并移除 stale `aria-describedby`。
- 涉及文件：`popup.js`、`popup.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.261 (2026-06-09)

- 修复：后台文章抓取增加同 URL in-flight 复用，跨批次或连续 `FETCH_IMAGES` 请求命中同一文章时共享正在进行的 fetch，减少 content 本地超时后重复抓同 URL 的后台压力。
- 修复：`FETCH_IMAGES` 现在会传递 content 侧 deadline，`background.js` 用 deadline clamp 文章 fetch 超时；deadline 已耗尽时不会继续调度后续 chunk，而是返回 retryable 的 `deadline_exhausted` 结果。
- 验证：`tools/verify.js` 新增并发 `FETCH_IMAGES` 同 URL 只触发一次 fetch 的动态回归、过期 deadline 不发起 fetch 的动态回归，以及 content/fetcher deadline 传递和 background in-flight/deadline 静态守护。
- 涉及文件：`background.js`、`content.js`、`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.260 (2026-06-09)

- 修复：BFCache 恢复时会先恢复仍注册的 active image load。`content.js` 在 `pageshow.persisted` 中调用 `ATPLoader.recoverActiveImageLoads('bfcache_pageshow')`，避免页面从 BFCache 回来后 frozen/canceled 图片请求继续占用全局加载槽。
- 增强：`loader.js` 为 direct/retry 图片加载暴露 recover 路径，保留可继续 fallback 的活跃加载，旧式 cancel-only 注册会在恢复兜底取消前先注销，避免后续 reset 重复取消。
- 增强：`viewport-observer.js` 为 viewport lazy load 和重图恢复注册 recover，BFCache 回来后可继续 no-referrer/heavy fallback 或重新排队重图恢复。
- 验证：`tools/verify.js` 新增 BFCache active image recover 动态回归、pageshow 顺序守护、loader/viewport recover 注册守护，并同步最终失败 reason 的静态断言。
- 涉及文件：`content.js`、`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.259 (2026-06-09)

- 修复：popup 设置读取期间会同步禁用“恢复默认设置”，点击处理也会先通过 `ensureSettingsReady()` 兜底，避免设置尚未加载时访问空 settings 并落入通用操作失败路径。
- 验证：`tools/verify.js` 新增 popup reset-all 加载期禁用动态断言和静态守护，确认加载态禁用、加载后恢复，以及 reset handler 入口保护。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.258 (2026-06-09)

- 增强：`tools/verify.js` 的 `ATP_RELEASE_DIR` 检查现在会比对发布目录内每个允许文件与当前工作树同路径文件的内容，避免发布目录混入旧版 JS/CSS/HTML/manifest/icon 但版本号已更新时仍通过。
- 收口：发布目录 Markdown 白名单改为显式允许 `CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`，拒绝 `AGENTS.md`、`CLAUDE.md`、`HANDOFF.md` 等内部维护文档进入实际发布包。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.257 (2026-06-09)

- 增强：`tools/verify.js` 为 popup “仅在此站点禁用”补有效 host 正向动态回归，在 VM 中模拟 `SAVE_SETTINGS_PATCH`，确认 `siteConfigs[host].disabled=true` 会写入 storage、回填当前 settings，并使用 polite status 语义提示保存成功。
- 维护：本次只增强验证覆盖，不调整 popup 运行时代码、manifest 权限、host 权限、缓存 TTL、TXT allowlist、缓存索引格式、候选提取或主加载策略。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.256 (2026-06-09)

- 增强：`tools/verify.js` 新增可选 `ATP_RELEASE_DIR` 发布目录白名单检查，会递归拒绝本地工具目录、Git 目录、`node_modules`、`.env*`、密钥和数据库类文件，并只允许扩展根文件与 `icons/` 资源进入实际发布目录。
- 验证：发布目录检查会解析发布目录内的 `manifest.json`，确认版本与工作区一致、content script 顺序未变、manifest 与 popup 引用文件存在；默认 `node tools/verify.js` 行为不变，只有设置 `ATP_RELEASE_DIR` 时启用。
- 涉及文件：`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.255 (2026-06-09)

- 改进：浮窗设置面板创建后立即显示“正在读取设置...”加载态，并通过 `aria-busy` 暴露设置读取状态，避免慢 storage 场景下打开浮窗看到空白设置区。
- 验证：`tools/verify.js` 新增浮窗设置加载态动态回归和静态守护，覆盖加载文案、`aria-busy=true/false` 和渲染完成后清除 busy。
- 涉及文件：`floating-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.254 (2026-06-09)

- 修复：浮窗标题栏拖拽优先使用 Pointer Events，支持触屏拖拽，并在触屏取消时清理拖拽状态；不支持 Pointer Events 的环境继续使用鼠标事件兜底。
- 改进：浮窗标题栏增加 `touch-action: none`，避免触屏拖拽被页面滚动抢走。
- 验证：`tools/verify.js` 新增浮窗 pointer 拖拽动态回归和静态守护，覆盖 pointer capture/release、RAF 合并移动、最终位置保存、帮助面板重定位和鼠标兜底保留。
- 涉及文件：`floating-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.253 (2026-06-09)

- 增强：`tools/verify.js` 为 popup 设置加载态、无有效站点禁用和帮助默认值格式化补 VM 事件回归，避免只靠静态字符串守护遗漏行为退回。
- 维护：`popup.js` 仅在 `window.__ATP_VERIFY_POPUP__` 下暴露站点禁用绑定、当前站点设置和帮助渲染测试 hook，运行时功能、权限、host 权限、缓存 TTL、TXT allowlist、候选提取和主加载策略不变。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.252 (2026-06-09)

- 修复：popup 设置区在异步读取设置完成前会禁用控件并显示读取状态，设置尚未加载或读取失败时的控件变更会被阻止并通过状态区提示，避免慢 storage 场景下用空状态覆盖真实设置。
- 修复：popup “仅在此站点禁用”会先确认当前标签页存在可用 http/https hostname；无有效站点时禁用控件并提示“当前页面不支持站点禁用”，保存失败时继续回滚勾选状态。
- 优化：popup 使用说明中的默认值改为用户可读格式，boolean 显示“开启/关闭”，select 显示选项标签，number 会附带单位。
- 增强：`tools/verify.js` 的版本同步检查改为固定锚点校验，覆盖 `CHANGELOG.md` 首个版本标题、`PROJECT_OVERVIEW.md` 当前更新、`使用说明.md` 版本行和 `HANDOFF.md` 当前版本行；新增 `ATP_VERIFY_STAGED=1` 暂存区发布一致性检查和 `ATP_VERIFY_PACKAGE=1` 本地工具目录打包检查。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.251 (2026-06-08)

- 修复：TXT 多附件解析现在会返回并消费 `{ resources, attemptedCount, unresolvedCount, retryableCount }` 状态；当一部分附件成功解析出资源、另一部分仍为空/失败/超时时，`renderer.js` 会合并已成功资源，但不会把 TXT 解析标记为完成，资源面板和窄屏 inline 入口会继续保留手动重试。
- 兼容：`fetcher.js` 保留旧的 `fetchTextAttachmentResources()` 纯资源返回 API，同时新增 status-aware 包装；`background.js` 的 `FETCH_TEXT_RESOURCES` 响应继续包含 `resources`，并额外携带附件解析计数，旧调用方可忽略新增字段。
- 验证：`tools/verify.js` 新增 partial-success 动态回归，覆盖 content 包装、background 消息响应和 renderer 状态更新，并更新相关静态守护。
- 涉及文件：`fetcher.js`、`background.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.250 (2026-06-08)

- 优化：`loader.js` 的后台队列处理现在把单轮 inspect 上限限制为 `maxPerRound * 3`，避免大量 deferred heavy task 在一个 tick 内整队轮转，降低滚动和可见图加载热路径上的调度尖峰。
- 修复：`viewport-observer.js` 的 pending slot 重试在普通加载前会刷新当前 viewport geometry；BFCache、隐藏页恢复或布局变化后，如果候选已经离屏会清理重试标记，hidden 强制加载和 lightweight preload 强制加载仍保留。
- 验证：`tools/verify.js` 补后台队列 inspect 上限和 slot retry 实时几何刷新静态守护，防止回退到整队轮转或陈旧 `inViewport` 标记。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.249 (2026-06-08)

- 修复：`cache.js` 的 partial 文章写入遇到新鲜完整文章缓存时，除继续合并 `loadedUrls` 和资源外，也会合并新发现的 TXT 附件，并保留 marker-only 的 `hasTextAttachments/textAttachmentCount`，避免后续缓存命中丢失 TXT 手动解析入口直到 TTL 过期。
- 验证：`tools/verify.js` 扩展文章 partial 写入动态回归，覆盖 partial 携带真实 TXT 附件和仅携带 Discuz/TXT marker 两条合并路径。
- 涉及文件：`cache.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.248 (2026-06-08)

- 修复：`loader.js` 在纯图片帖后台候选全部完成且已有成功图片时，会用 `ATPCache.flushCacheNow(threadId, true)` 把文章缓存标记为完整，避免延迟批量 flush 只写入 incomplete 的 `loadedUrls`，导致下次列表扫描继续 miss 并重复抓取文章 HTML。
- 修复：`resource-panel.js` 的密码-only 侧栏不再提前隐藏待解析 TXT 状态和手动解析按钮，避免只有解压密码且仍有 TXT 附件时桌面端缺少可见解析入口。
- 修复：`content.js` 在隐藏页恢复可见时会先消费 `rescanRequested` 再执行恢复扫描，避免同一次 visible 恢复结束后再被旧标记追加一次重复扫描。
- 验证：`tools/verify.js` 新增静态守护，确保整帖完成分支同时覆盖成功图片和资源 payload 的完整缓存写入，密码-only 分支保留 TXT 状态/解析入口，可见性恢复先清理待重扫标记。
- 涉及文件：`loader.js`、`content.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.247 (2026-06-08)

- 优化：`background.js` 的跨域文章成功抓取日志从每篇 `响应/HTML/提取` 三条 info 改为每个 background chunk 一条 `文章批量提取` 摘要，`FETCH_IMAGES` / `FETCH_TEXT_RESOURCES` 成功响应会先 `sendResponse` 再延迟合并 `BGLOG.flushSoon()`，减少日志 storage 读写与文章/TXT 缓存写入竞争；WARN/ERROR 仍即时 flush。
- 优化：`background.js` 的 TXT 正缓存写入成功后不再逐条立即 `getBytesInUse(null)`，改为短延迟合并 eviction 检查；quota 写失败后的 baseline 淘汰路径不再重复读取 bytes，后台缓存索引更新改用 `cacheIndex.updateEntries()` 批量入口。
- 改进：`content.css`、`floating-panel.css`、`popup.css` 补资源按钮、浮窗 header/help/reset/重图预设按钮、popup disclosure/重图预设按钮的 24px 最小目标尺寸；浮窗 header/help header 使用白色 outline 加深色外圈，避免蓝色/紫色标题栏上 focus ring 对比不足。
- 修复：`resource-panel.js` 在窄屏 inline 资源栏被删除且原按钮持有焦点时，会先尝试新 inline 动作，再回退同帖缩略图控件或释放已删除节点焦点；inline TXT 解析按钮改用共享资源按钮样式，避免 undersized inline style。
- 验证：`tools/verify.js` 新增 background 成功抓取日志聚合、TXT 缓存 eviction 合并、小按钮目标尺寸、浮窗 header 高对比焦点环和资源 inline 删除焦点释放的静态/动态守护。
- 涉及文件：`background.js`、`content.css`、`floating-panel.css`、`popup.css`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.246 (2026-06-08)

- 修复：`cache.js` 的文章负缓存状态读取现在返回命中时间、到期时间和剩余时间，`fetcher.js` 负缓存命中会把 `negativeExpiresAt` 写入 `retryAfter`，避免当前 DOM 行仍按 15-60 秒短退避反复扫描和读取 storage。
- 修复：`content.js` 的 retryable empty 队列保留 `reason` / `retryAfter` 元数据；跨域缓存预读、同源/后台 retryable 或 partial 空结果、后台 timeout 统一通过 helper 写入，负缓存命中会等 5 分钟 TTL 到期后再重扫。
- 验证：`tools/verify.js` 新增负缓存状态到期时间动态回归、负缓存命中 `retryAfter` 断言，并收紧 content/fetcher/cache 静态守护，确保负缓存命中不退回短重试。
- 涉及文件：`content.js`、`cache.js`、`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.245 (2026-06-08)

- 优化：`viewport-observer.js` 的重图预算批处理日志复用同轮 `getHeavyRenderSnapshot()` 结果，`logHeavyRender()` / `getHeavyRenderLogFields()` 只在没有传入 snapshot 或 stats 时才重新扫描 `heavyRenderItems` 和读取几何信息，减少重图恢复/卸载密集时的诊断开销。
- 修复：`content.js` 拆分 observer retry timer 清理和 retry count 重置，`setupObserver()` 缺少帖子容器时不再每轮重置计数，避免最大重试次数与退避失效导致长期 500ms 重试刷日志；隐藏暂停、停用和成功绑定仍会重置 retry count。
- 修复：`viewport-observer.js` 的重图恢复 `error` / `restore_timeout` 会在保留 preview fallback 后按每缩略图最多 3 次的退避重试调度预算 reconcile，避免可见重图恢复失败后长期停在占位状态。
- 修复：`shared-utils.js` 的 `cacheIndex.rebuild()` 现在会把索引写入失败作为重建失败返回 `null`，避免升级清理或索引修复在 storage 写失败时误报成功。
- 修复：`popup.js` 与 `floating-panel.js` 在程序化设置回填、依赖禁用、整体禁用、reset 和保存失败回滚时清理数值输入的 `aria-invalid` / `aria-describedby` 和脏输入状态，避免已恢复的控件继续被读屏当作错误输入。
- 修复：`floating-panel.js` 的方向键传播隔离移到 ShadowRoot 冒泡阶段，面板内 number/select 先收到原生方向键处理，再阻止事件继续触发宿主页面快捷键。
- 改进：`popup.html` 的帮助区和诊断日志区改用静态 `helpTitle` / `logTitle` 作为 region label，避免折叠按钮文本和动态日志计数进入区域名称；`resource-panel.js` 在 `clear()` 清空侧栏前会先清理 live-region timer。
- 验证：`tools/verify.js` 补重图日志快照复用、重图恢复失败重试、observer retry count 保留、cache index rebuild 写失败、popup/浮窗错误状态清理、浮窗方向键阶段、popup 静态 region label 和资源侧栏 clear timer 静态/动态守护。
- 涉及文件：`content.js`、`viewport-observer.js`、`shared-utils.js`、`popup.html`、`popup.js`、`floating-panel.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.244 (2026-06-08)

- 修复：`content.js` 的 `clearObserverRetryTimer()` 恢复为真正清理 observer retry timer 和 retry count，避免隐藏暂停或 observer 重试路径触发自递归导致 `RangeError: Maximum call stack size exceeded`，阻断 content 初始化。
- 修复：`cache.js` 成功写入文章正缓存后会清理同 URL 的旧负缓存键和 cache index 条目，避免正缓存后续被淘汰时残留负缓存短暂遮蔽可抓取文章。
- 优化：`fetcher.js`、`background.js` 的 TXT 附件入口按 `SharedUtils.normalizeTextAttachmentUrl()` 兜底去重，旧缓存或手动入口传入等价重复附件时不再重复抓取或重复写失败缓存。
- 修复：`floating-panel.js` 的 dirty input 保护改用 shadow root 内 active element，外部设置刷新不会覆盖 Shadow DOM 中正在编辑的输入；浮窗打开时会重新 clamp 当前保存位置，避免视口变窄后重新打开出屏。
- 修复：`resource-panel.js` 的侧栏可见性判断不再为了计算 trigger 的 `aria-expanded` 提前创建空 sidebar；侧栏重渲染和 inline 资源栏移除前会清理对应 live region timer，避免已移除节点残留延迟清理。
- 验证：`tools/verify.js` 补 content observer retry 自递归负断言、viewport destroy shared retry cleanup 守护、文章正缓存清负缓存动态回归、TXT 附件去重回归、浮窗 shadow dirty/clamp 和资源侧栏无副作用可见性守护。
- 涉及文件：`content.js`、`cache.js`、`fetcher.js`、`background.js`、`floating-panel.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.243 (2026-06-08)

- 优化：`content.js` 首次启用页面时改用现有快速扫描入口，仍先同步 loader 可见性暂停状态，再用 `detectAndProcess(true)` 调度首批文章扫描，把初始化后的扫描等待从普通路径约 300ms 降到快速路径约 150ms。
- 修复：`content.js` 隐藏页暂停、pagehide、停用和 observer 重绑路径会同步清理 observer retry timer；retry/throttled/scroll/mutation/visibility hidden 分支统一走隐藏页暂停 helper，避免隐藏前的 stale scan/observer retry 在恢复后重复触发。
- 修复：`viewport-observer.js` 在 visible pending 多于单轮扫描窗口且仍有可用槽时会短延迟续扫；`loader.js` 槽位释放唤醒时先重试 visible pending，再处理 slot retry pending，减少可见占位卡住到下一次滚动/IO 回调的情况。
- 修复：`fetcher.js` 直连 TXT 附件在缓存读取和 fetch 前复用 `SharedUtils.isAllowedTextAttachmentUrl()`；最终重定向 URL 也复用同一 allowlist，保持 content/background/shared 的 TXT 下载边界一致。
- 修复：`background.js` 升级清理旧缓存 key 后会重建 cache index；即使没有物理旧 key，也会清掉 index-only 的陈旧旧前缀条目。`SharedUtils.cacheIndex.rebuild()` 允许无回调调用，适配后台 fire-and-forget 重建。
- 修复：`popup.js` 收起帮助/日志 disclosure 前会把面板内焦点恢复到触发按钮；`floating-panel.js` 和 `previewer.js` 补方向键/Escape 传播边界，避免扩展 UI 快捷键同时触发底层页面。
- 验证：`tools/verify.js` 更新 enable 链路、隐藏页 pause helper、visible pending 续扫、TXT allowlist 复用、background index-only 旧 key 重建清理和键盘焦点边界守护。
- 涉及文件：`content.js`、`viewport-observer.js`、`loader.js`、`fetcher.js`、`background.js`、`shared-utils.js`、`popup.js`、`floating-panel.js`、`previewer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.242 (2026-06-08)

- 修复：`popup.js` 的按钮文案恢复 timer 改为按按钮隔离；新一轮清除、恢复或导出操作开始前会先取消该按钮旧的恢复 timer，避免旧 timer 覆盖“清除中...”或“恢复中...”状态。
- 修复：`resource-panel.js` 的复制反馈 live region timer 改为按消息元素隔离；窄屏下快速复制不同帖子资源时，不同 inline 提示不再互相取消清理，避免“已复制/复制失败”残留。
- 修复：`content.js` 的 retry scan、throttled scan、scroll scan、MutationObserver 和 visibilitychange 隐藏页分支统一走 `pauseScanningForHiddenPage()`，隐藏暂停时会同时清理 scan timer 和候选队列，避免恢复可见后复用隐藏前的 stale scan queue。
- 优化：`content.js` 首次初始化不再固定等待 500ms，DOM 可用后会立即调度初始化，并在已初始化后跳过 load 兜底的重复空调度，减少首屏缩略图链路等待。
- 验证：`tools/verify.js` 补 popup 按钮文案 timer、resource panel 消息 timer、content 首次初始化延迟和隐藏页扫描入口统一 pause helper 的静态守护。
- 涉及文件：`popup.js`、`resource-panel.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.241 (2026-06-08)

- 修复：`content.js` 的隐藏页暂停现在覆盖已经开始的文章扫描；同源抓取、跨域缓存预读、background 抓取返回和渲染前都会重新检查 `pauseWhenHidden`，隐藏时清理待处理扫描队列并等待页面恢复可见后重扫，避免隐藏页中途继续发起或完成文章抓取。
- 修复：`reloadThumbnails()` 和 `enableCurrentPage()` 改为通过 visibility-aware helper 恢复 loader；隐藏页暂停仍生效时不会短暂调用或直接调用 `ATPLoader.resume()`。
- 修复：`viewport-observer.js` 的 visible pending retry 在当前没有可用图片槽时，会用 bounded iterator 按当前 geometry 标记可见 pending wrapper 为 slot retry，等真实槽位释放时由 release-driven wake 继续加载，避免恢复可见后可见占位仍要等滚动或 IntersectionObserver 回调才继续。
- 修复：`resource-panel.js` 在窄屏 inline 资源按钮持有焦点时切回宽屏，会把焦点迁到桌面资源侧栏同语义按钮；找不到对应按钮时回退到同帖资源 trigger，避免焦点停在隐藏 inline 控件内。
- 修复：`previewer.js` 对预览弹层已接管的 Escape、左右方向键和 Tab 调用 `stopPropagation()`，避免底层页面快捷键同时响应。
- 验证：`tools/verify.js` 补隐藏页 in-flight scan 中断、loader visibility-aware reload/enable、viewport no-slot visible pending 标记、资源面板宽屏焦点迁移和预览快捷键传播静态守护；新增 background `onInstalled` 旧 TXT cache key 清理行为测试、TXT allowlist 与 manifest host 权限一致性检查，以及 content 同源 TXT 正缓存优先级回归。
- 涉及文件：`content.js`、`viewport-observer.js`、`loader.js`、`resource-panel.js`、`previewer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.240 (2026-06-08)

- 修复：`viewport-observer.js` 的重图恢复请求现在使用与普通图片加载一致的超时保护；如果恢复图片长期不触发 `load/error`，会通过 `restore_timeout` 取消请求、注销 active-load 并恢复 unloaded preview 占位，避免 `restoreLoading` 长期挂住。
- 修复：`loader.js` 的 visibility/BFCache 恢复和公开 `resume()` 路径现在会同时唤醒普通 visible pending 和 slot retry；`viewport-observer.js` 的 `retryVisiblePending()` 会按当前 geometry 刷新可见状态，避免恢复后旧 `inViewport` 标记滞后导致可见占位延迟到滚动或 IntersectionObserver 回调后才继续加载。
- 验证：`tools/verify.js` 补 heavy restore timeout 静态守护，要求恢复请求设置 `data.restoreTimer`、完成时清理 timer、超时时走 `cancelHeavyRestoreLoad()`；同时补 visibility 恢复唤醒 visible pending 的动态断言，以及 `teardownActiveSlots()` 取消 active-load registry 的 pagehide reason 断言。
- 涉及文件：`viewport-observer.js`、`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.239 (2026-06-08)

- 修复：`viewport-observer.js` 的 `loadWrapper()` 增加 loader paused 闸门，隐藏页暂停或公开 `ATPLoader.pause()` 后，晚到的 IntersectionObserver / lightweight preload 回调不会再绕过 pause 状态占用图片槽并启动新请求。
- 修复：`viewport-observer.js` 的 visible pending retry、slot retry 和 retry timer 回调同时尊重 `ATPLoader.isPaused()`；`loader.js` 暂停路径会清理 scroll-idle timer，避免显式 pause 后旧滚动回调重新启动 viewport pending 加载。
- 修复：`content.js` 在隐藏页且 `pauseWhenHidden=true` 时不再启动新的扫描、retry scan、mutation scan 或 scroll scan，避免继续发起文章后台抓取；恢复可见后会重绑 observer 并按已有请求重扫。
- 验证：`tools/verify.js` 新增 paused viewport load VM 回归，确认暂停状态不会 acquire slot、不会标记 loaded，且会保留 retry 标记；静态守护覆盖 `loadWrapper()` paused guard 顺序、slot retry pause guard、scroll-idle 清理和 content hidden scan guard。
- 涉及文件：`viewport-observer.js`、`loader.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.238 (2026-06-08)

- 修复：`cache.js` 在已有新鲜完整文章缓存时不再被后续 partial 写入降级，只合并 `loadedUrls` 和资源，保留完整图片候选和 `complete=true`。
- 修复：`fetcher.js`、`background.js`、`content.js` 将负缓存命中、登录重定向、Cloudflare/blocked、HTTP 401/403/429/5xx 统一按可重试空结果处理，不写新的文章负缓存，避免临时拦截或登录态波动把当前 DOM 行永久标记为已处理；同批扫描按归一化文章 URL 分组，减少重复抓取。
- 修复：TXT 附件直连和 background 代理只在附件 URL 与来源页同源且同为 HTTPS 时设置 referrer，避免跨源复用缓存 `pageUrl` 泄漏来源。
- 修复：`floating-panel.js` 避免外部 storage 刷新覆盖正在编辑但尚未触发 `change` 的设置输入；`popup.js` 全量恢复默认设置保存失败时回滚本地设置快照；`settings-schema.js` 将 `thumbHeight` step 调整为 1，保证默认值 82 符合原生 number input 约束。
- 验证：`tools/verify.js` 补完整缓存不被 partial 降级、临时空结果不写负缓存、安全 referrer、浮窗 dirty input 保护、popup reset 回滚和 schema number 默认值步进约束回归。
- 涉及文件：`cache.js`、`fetcher.js`、`background.js`、`content.js`、`floating-panel.js`、`popup.js`、`settings-schema.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.237 (2026-06-08)

- 修复：`resource-panel.js` 窄屏布局切换时如果隐藏的 desktop sidebar/trigger 内仍有焦点，但同帖没有可聚焦 inline 资源操作，会主动释放隐藏桌面资源控件焦点，避免焦点停在 `display:none` 控件内。
- 修复：`resource-panel.js` 同步 resource trigger 时只有当前线程且 desktop sidebar 可见才设置 `aria-expanded=true`，避免隐藏 trigger 在窄屏声明桌面侧栏已展开。
- 验证：`tools/verify.js` 对齐当前 `content.js` 的跨域缓存预读 retryable empty、article group key 注入、确定性空结果负缓存 helper，并补资源面板隐藏焦点 release/visible sidebar expanded 回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.236 (2026-06-08)

- 修复：`previewer.js` 的大图预览容器改为明确的 flex 高度布局，工具栏固定占位、图片区在剩余高度内收缩并隐藏溢出，避免短屏下图片按 `80vh` 撑破 modal 或被工具栏挤出视口。
- 修复：`resource-panel.js` 在窗口切到窄屏布局时同步收起桌面 sidebar 的 `aria-expanded`，并把仍停留在隐藏 sidebar/trigger 内的焦点迁到同帖 inline 资源操作；窄屏下 inline 不存在时不再回退聚焦隐藏 trigger。
- 验证：`tools/verify.js` 补预览容器总高度、工具栏 flex 固定、图片 wrapper `min-height:0`、禁止恢复 `max-height:80vh`，以及资源面板窄屏 matchMedia/resize 同步、销毁解绑、ARIA 收起和隐藏 trigger 不聚焦的静态回归。
- 涉及文件：`previewer.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.235 (2026-06-08)

- 修复：`viewport-observer.js` 的重图恢复请求现在注册到 `ATPLoader.registerActiveImageLoad()`，恢复完成或失败时注销，页面清理、active slot teardown 或 pagehide 取消时可触达并取消该请求。
- 修复：`cancelHeavyRestoreLoad()` 现在会注销 active-load 控制、取消图片请求、复位 `restoreLoading`，并恢复 `atp-heavy-unloaded` / preview 占位状态，避免 BFCache 或清理后留下空白重图位。
- 修复：`content.js` 移除破坏性的 `beforeunload` teardown，改由 `pagehide` 区分 BFCache 与真实离页；`event.persisted` 时只 flush 并暂停调度，非 persisted 离页再集中清理 active slots 和 in-flight heavy restores；新增 `pageshow.persisted` 恢复 visibility listener、pause state、observer、滚动监听、浮窗和一次当前重扫。
- 修复：`loader.js` 的公开 `pause()` 现在同步清理 viewport pending retry/wake timer，再暂停 heavy restore timer，避免 BFCache 冻结路径残留短定时器。
- 验证：`tools/verify.js` 补 restore active-load 注册/注销、pagehide/pageshow BFCache 生命周期、禁止 destructive beforeunload 和 public pause 清 viewport retry 的静态回归。
- 涉及文件：`content.js`、`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.234 (2026-06-08)

- 修复：`floating-panel.js` 外部点击关闭浮窗时不恢复 launcher 焦点，但会释放仍停留在隐藏 panel/help 内的活动焦点，避免焦点留在 `aria-hidden=true` 控件上。
- 修复：`previewer.js` 关闭预览时若 opener、打开前焦点和同帖 fallback 都不可用，会释放隐藏 overlay 内的当前焦点，避免 close button 留在 `display:none` 预览层里。
- 修复：`viewport-observer.js` 的 destroy 循环显式清理 heavy restore reveal listener 后再取消恢复加载，保持热重载/停用清理路径和验证守护一致。
- 验证：`tools/verify.js` 补浮窗外部关闭隐藏焦点 blur、预览全部恢复目标消失后的 hidden overlay blur，以及 viewport destroy reveal 清理回归。
- 涉及文件：`floating-panel.js`、`previewer.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.233 (2026-06-08)

- 修复：`loader.js` 在隐藏页暂停和公开 `pause()` 路径同步暂停重图恢复队列的定时器，保留队列但清掉 `heavyRestoreTimer` / `heavyBudgetTimer`，避免隐藏页暂停后仍继续恢复重图并触发后台网络或解码。
- 修复：`loader.js` 在可见恢复、公开 `resume()` 和 `pauseWhenHidden=false` 的隐藏加载路径显式唤醒 `ATPViewport.resumeHeavyRestores()`，避免切回页面或允许隐藏加载后重图恢复队列停住。
- 修复：`viewport-observer.js` 为 heavy restore 和 heavy budget reconcile 调度补 loader paused guard，暂停期间不创建恢复/预算定时器，已排队恢复项不会被消费。
- 验证：`tools/verify.js` 补 hidden/public pause、visible/resume 唤醒、heavy restore/budget paused guard 和定时器集中清理的静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.232 (2026-06-08)

- 修复：`content.js` 将同源和 background 返回的 partial 空文章结果纳入 retryable empty 退避队列，不再把当前页面容器标记为 `atp-processed`，避免截断 HTML 空结果在当前页面内永久不重试。
- 修复：`cache.js` / `background.js` 的 TXT 正向资源缓存读取会先确认归一化后存在真实 payload；空 `TEXT_RESOURCE` 缓存会被当作 miss 并清理，避免空正缓存遮蔽真实抓取或手动重试。
- 验证：`tools/verify.js` 补 partial 空结果必须在 processed 前退避、content/background 空 TXT 正缓存过滤、background 手动重试遇到空正缓存仍真实 fetch 的回归。
- 涉及文件：`content.js`、`cache.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.231 (2026-06-08)

- 修复：`resource-panel.js` 在桌面侧栏和 inline 资源栏重渲染前记录当前聚焦按钮的动作语义，DOM 替换后恢复到同语义按钮；如果 inline 动作消失，则回退到可用 inline/trigger 动作，避免解析 TXT、复制后刷新或固定状态切换时键盘焦点丢失。
- 验证：`tools/verify.js` 补资源动作焦点捕获、侧栏 `innerHTML` 替换后恢复焦点、inline `old.remove()` 后恢复或回退焦点的静态回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.230 (2026-06-08)

- 修复：`fetcher.js` 的 content 侧跨域 TXT 附件预检改为正向 `TEXT_RESOURCE` 缓存优先于 `TEXT_FAIL` 失败缓存，命中正缓存时直接合并结果、清理陈旧失败缓存，并跳过 background 代理，避免有效 TXT 资源被旧失败缓存遮蔽。
- 修复：`fetcher.js` 的同源 TXT 正缓存命中也会清理旧失败缓存，与 background TXT 读取语义保持一致。
- 验证：`tools/verify.js` 新增 content 侧 TXT 正缓存优先行为回归，并更新跨域预检静态断言，覆盖手动重试继续绕过失败缓存的路径。
- 涉及文件：`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.229 (2026-06-08)

- 修复：`resource-panel.js` 新增 `syncResourceTrigger()`，在线程 attach/update 时按 `showResourcePanel` 状态创建或移除真实资源触发按钮，避免关闭资源栏设置后仍留下可见、可聚焦但不会展示内容的桌面 trigger。
- 验证：`tools/verify.js` 补资源 trigger 启用/禁用同步、禁用时移除旧 trigger、attach/update 都走同步入口的静态回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.228 (2026-06-08)

- 改进：`resource-panel.js` 在每个线程工具栏中维护真实 `<button type="button" class="atp-resource-trigger" data-resource-trigger="1">` 作为桌面资源侧栏触发器，`aria-controls/aria-expanded` 迁移到按钮，线程 panel 不再承担 `tabindex` 或 Enter/Space 键盘触发语义。
- 修复：`content.css` 给资源触发按钮补 hover / `focus-visible` 样式，并在 `max-width: 1024px` 下隐藏桌面 trigger，避免窄屏 Tab 聚焦到控制 `display:none` sidebar 的控件。
- 修复：`previewer.js` 关闭预览时的同帖 fallback 优先恢复到资源触发按钮，再回退线程 panel，减少焦点落到不可用容器的情况。
- 验证：`tools/verify.js` 将资源面板断言迁移到真实 trigger button，并补旧 panel `tabIndex` / `keydown` 负断言、窄屏 CSS 和预览焦点 fallback 检查。
- 涉及文件：`resource-panel.js`、`content.css`、`previewer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.227 (2026-06-08)

- 修复：`loader.js` 为每次图片占槽增加 per-load token 和 active slot registry，`resetActiveImageSlots()` / `teardownActiveSlots()` 会同步清理 task active 标记、普通/重图 active 计数和旧图片 load canceler，避免热重载、停用或卸载后旧 onload/onerror/timeout 回调误释放新请求槽。
- 修复：`viewport-observer.js` 的懒加载完成/失败路径改为捕获 `ATPLoader.getActiveSlotToken(task)` 并通过 `releaseViewportSlot(task, slotToken)` 释放，旧 viewport 图片回调不再能扣减同一个 task 后续重新占用的槽。
- 修复：`content.js` 在缩略图 DOM 清理和 `beforeunload` 清理时调用 `ATPLoader.teardownActiveSlots()`，让 reload/disable/unload 的 DOM teardown 立即释放 active 图片槽状态，而不是等待旧图片请求自然超时。
- 验证：`tools/verify.js` 补同一 task teardown 后重新占槽、旧 token 释放不扣新 active/heavy 计数、active image canceler、viewport token 释放和内容脚本 teardown 挂点回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.226 (2026-06-08)

- 修复：`popup.js` 的缓存清理和“一键清空缓存和日志”会等待 `SharedUtils.cacheIndex.removeEntries()` 回调完成后再报告成功，避免 popup 生命周期结束前留下已删除 key 的陈旧 `atp_cache_index_v1` 索引。
- 修复：cacheIndex 删除写入失败时会先尝试 rebuild，再把维护失败显式传回按钮操作，避免静默显示“已清除”。
- 修复：`background.js` 的 TXT 资源读取改为正向 `TEXT_RESOURCE` 缓存优先于 `TEXT_FAIL` 失败缓存，命中正向缓存时顺手清理旧失败缓存；升级清理也补上旧 `atp_text_fail_*` 前缀，避免旧失败缓存长期残留。
- 修复：`shared-utils.js` / `cache.js` 将 TXT 附件提取和旧文章缓存归一化对齐到实际 background 抓取 allowlist，只保留 HTTPS 站点附件、`xia.ewrewej.la` 签名下载和 `dl.ldkms.la/*.txt`，避免外域或 HTTP `.txt` 反复进入不可抓取的空解析状态。
- 改进：`floating-panel.js` 在设置面板打开且焦点逃出 dialog 时仍可用 Escape 关闭；若图片预览层激活且事件不来自浮窗，则继续让预览层优先处理 Escape。
- 优化：`resource-panel.js` 的 inline 资源栏增加 per-panel 渲染签名和 click 委托，状态不变时跳过 DOM 替换；窄屏下键盘 Enter/Space 不再把焦点送进 `display:none` 的桌面 sidebar，而是聚焦 inline 资源按钮并保持 `aria-expanded=false`。
- 验证：`tools/verify.js` 补 popup cacheIndex 删除等待、TXT 正向缓存优先、旧 TEXT_FAIL 前缀清理、TXT allowlist 过滤、浮窗 Escape 逃逸关闭、窄屏资源 inline 聚焦和 inline 渲染签名静态/行为回归。
- 涉及文件：`popup.js`、`background.js`、`shared-utils.js`、`cache.js`、`floating-panel.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.225 (2026-06-08)

- 安全：`floating-panel.js` 的设置面板改为容器级事件委托，并拒绝非用户触发的合成 `change/click` 事件，避免页面脚本通过 open shadow root 合成事件改写扩展设置。
- 安全：`defaults.js` / `background.js` 对 settings 做白名单归一化，只保留 `enabled`、schema 字段和合法 `siteConfigs[host].disabled`，丢弃未知顶层字段、非法 host 和未知站点字段。
- 改进：`popup.html` / `floating-panel.js` 让帮助说明和日志等可滚动内容区可键盘聚焦，`popup.css` / `floating-panel.css` 补焦点样式并遵守 `prefers-reduced-motion: reduce`。
- 验证：`tools/verify.js` 补设置事件委托、合成事件拒绝、settings 白名单、滚动区可聚焦和 popup/浮窗 reduced-motion 回归，并重新对齐当前预览关闭 opener-first 焦点契约。
- 涉及文件：`floating-panel.js`、`floating-panel.css`、`popup.html`、`popup.css`、`defaults.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.224 (2026-06-08)

- 修复：`previewer.js` 关闭大图预览时按打开方式恢复焦点；鼠标点击缩略图或重图 wrapper 打开时优先恢复到本次 opener，opener 已移除或隐藏时回落到同帖同序号缩略图或线程面板，最后才恢复打开前旧焦点；键盘 Enter/Space 打开时优先恢复打开前焦点，避免键盘用户关闭预览后被强制带到鼠标 opener 兜底。焦点目标会排除 inline/computed hidden 与 `display:none`，并且只有 `document.activeElement` 实际切换后才视为恢复成功。
- 修复：`floating-panel.js` 的 focus trap 跳过隐藏祖先里的帮助面板控件，帮助面板切到窄屏上下堆叠后重新测量高度再定位；`content.css` 给线程资源触发面板补 `focus-visible`，`resource-panel.js` 的空态提示同步说明可通过聚焦或鼠标移入查看资源。
- 验证：`tools/verify.js` 补鼠标 opener-first、键盘 previous-focus、opener 移除/隐藏 fallback、floating help 隐藏控件过滤和堆叠重测量的行为/静态回归。
- 涉及文件：`previewer.js`、`loader.js`、`viewport-observer.js`、`floating-panel.js`、`content.css`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.223 (2026-06-08)

- 改进：`resource-panel.js` 的桌面资源侧栏补稳定 `id`、`role="region"`、触发面板 `aria-controls/aria-expanded`，键盘用户可在缩略图资源触发区按 Enter/Space 打开侧栏并直接聚焦第一个侧栏按钮，按 Escape 关闭未固定侧栏。
- 改进：`floating-panel.js` 的参数说明面板补独立 region/标题关联，并在横向空间不足时切换为上下堆叠定位；`popup.html` 的使用说明和诊断日志面板也补 labelled region，`popup.css` 增加窄容器宽度兜底。
- 验证：`tools/verify.js` 补资源侧栏键盘打开/关闭、ARIA 关联、按钮 focus-visible、浮动 help 小屏堆叠、popup help/log region 和 popup 窄宽度兜底的静态回归。
- 涉及文件：`resource-panel.js`、`content.css`、`floating-panel.js`、`floating-panel.css`、`popup.html`、`popup.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.222 (2026-06-08)

- 优化：`loader.js` 在实际释放图片 slot 后新增 coalesced viewport pending-slot wake，连续多张图完成只排一个 0ms 唤醒，避免在 onload/onerror 栈内同步扫描 pending wrappers。
- 优化：`viewport-observer.js` 移除 `retryPendingSlotLoads()` 在 slot 全满时的固定 250ms 轮询；no-slot 状态改为等待 loader 的释放唤醒，只有仍有容量且仍有 pending slot retry 时才保留短延迟继续扫描。
- 验证：`tools/verify.js` 补 loader slot release wake 的 VM 行为回归，以及禁止恢复 no-slot `schedulePendingSlotRetry(250)` / `started ? 100 : 250` 的静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.221 (2026-06-08)

- 优化：`loader.js` 在后台队列非空但当前普通/重图通道暂无容量时改走 `background_capacity_wait` 退避重试，不再按 `backgroundSpeed` 继续创建普通后台 timer；`processBgTasks()` 收尾和无 `requestIdleCallback` fallback 重排前也会复用后台队列快照检查容量。
- 修复：`loader.js` 的公开 `pause()` 现在同步清理后台 timer，让暂停状态本身保证不保留 background wake/retry timer。
- 优化：`viewport-observer.js` 新增 `releaseViewportSlot()`，图片成功或失败释放活跃槽位后会通过 coalesced wake 显式唤醒后台队列，减少依赖 `threadImageDone()` / `handleFail()` 的跨函数间接调度。
- 验证：`tools/verify.js` 补 background capacity retry、`pause()` 清 timer、pending 删除唯一 helper、viewport release wake helper 和 retry delay 必须来自退避计算的静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.220 (2026-06-08)

- 优化：`shared-utils.js` 的 `cacheIndex` 写队列改为结构化队列项，连续相邻的 `updateEntry()` / `updateEntries()` 会在同一轮 drain 中合并为一次索引读取和一次写回，减少短时间多批缓存写入时重复处理整份 `atp_cache_index_v1`。
- 兼容：`removeEntries()`、`write()` 和 `rebuild()` 继续作为队列屏障，不跨删除、整表覆盖或重建合并更新；重复 key 的连续 update 以后入队值为准，所有被合并调用的 callback 都会收到最终写入结果。
- 验证：`tools/verify.js` 补连续 update 队列合并、重复 key 后者覆盖、每个 callback 只调用一次、remove/write/rebuild barrier 不被跨越，以及相邻 update 合并静态规则。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.219 (2026-06-08)

- 优化：`loader.js` 将后台队列因 viewport pending 已满而挂起时的兜底重试从固定 500ms 轮询改为 500ms 起步、最高 4000ms 的指数退避；pending 容量恢复进入正常调度、清空后台任务或隐藏页暂停时会重置退避状态。
- 优化：`viewport-observer.js` 将 pending wrapper 删除收口到 `removePendingWrapper()`，detached、stale task、domain skip 和真正转入加载都会在释放 pending 容量后通过 coalesced wake 唤醒后台队列，减少依赖 loader 兜底 retry 的空转。
- 验证：`tools/verify.js` 补 pending-full retry 退避、禁止固定 500ms 轮询、退避重置和 pending 删除统一 wake helper 的静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.218 (2026-06-08)

- 优化：`resource-panel.js` 的桌面资源侧栏改为一次性 click 事件委托，复制分类、复制全部、复制密码、手动解析 TXT 和固定切换都通过 `handleSidebarClick()` 路由，不再在每次 `innerHTML` 重绘后重新绑定一批侧栏按钮。
- 优化：`resource-panel.js` 为桌面资源侧栏增加渲染签名，签名覆盖线程、固定状态、TXT 状态、密码、附件状态、资源分组和每条资源的 `url/code/source`；状态未变化时跳过重复 `innerHTML`，减少 hover/focus 和 TXT 状态刷新时的 DOM 替换与监听器 churn。
- 验证：`tools/verify.js` 改为断言资源侧栏必须使用委托点击、禁止恢复每次渲染后的侧栏按钮绑定，并覆盖渲染签名必须包含密码和资源条目内容，避免数量不变但内容变化时误跳过重绘。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.217 (2026-06-08)

- 优化：`shared-utils.js` 的 `extractImagesForSettings()` 改为单次解析文章 HTML，并通过 soft fallback limit 在同一次 DOM/regex 提取过程中判断是否需要把重图候选扩展到 `fetchLimit`，避免重图前缀命中后为扩展候选池再次 `DOMParser` 同一篇文章。
- 兼容：普通帖子仍停在 `effectiveFallbackLimit()` 的隐藏候选池，重图判断仍只看前 `displayLimit` 个候选；重图命中后仍扩展到 `effectiveFetchLimit()`，保留坏链 fallback 候选、候选顺序、去重、`srcset` 展示/预览语义和 DOMParser 失败后的 regex fallback。
- 验证：`tools/verify.js` 将重图提取回归改为要求 `heavyParseCount === 1` 且仍返回完整 fetch pool，并补 soft-limit guard、禁止二次 fetchLimit 解析和 regex/DOM 共享扩展策略的静态断言。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.216 (2026-06-08)

- 改进：`resource-panel.js` 将资源固定状态从缩略图容器迁移到独立的 pin toggle button；移动端 inline 资源栏和桌面资源侧栏都提供真实按钮，只在按钮上维护 `aria-pressed` 和固定/取消固定文案，避免 `role="button"` 容器包裹多个真实按钮造成读屏语义混乱。
- 修复：`resource-panel.js` 拆分资源侧栏 hover/focus 状态，并在延迟清理时额外检查侧栏当前焦点，避免鼠标离开侧栏但键盘焦点仍在侧栏按钮内时清空资源内容。
- 修复：`previewer.js` 关闭大图预览时会使用 opener/thread/preview index 元数据恢复焦点；如果原缩略图已被移除或隐藏，会回落到同帖可见缩略图或线程资源面板，避免焦点掉到 `body`。
- 修复：`floating-panel.js` 将参数说明面板挂入主设置 dialog 子树，并避免 focus trap 重复收集说明面板控件，让 `aria-modal` 的 DOM 范围和实际焦点范围一致。
- 验证：`tools/verify.js` 改为断言资源固定必须由真实 pin toggle button 驱动、禁止把资源触发容器声明为 button、覆盖侧栏 focus 独立保活、preview opener fallback、滚动/mutation 清 scanState 和 floating panel help panel 位于 modal 子树。
- 涉及文件：`resource-panel.js`、`content.css`、`previewer.js`、`loader.js`、`viewport-observer.js`、`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.215 (2026-06-08)

- 修复：`floating-panel.js` 记录按字段的 pending save attempt，外部 `storage.onChanged` 刷新到达时不会把正在保存的字段临时重绘成旧值；非 pending 字段仍会照常同步。
- 修复：pending 清理改为只在保存成功或失败回滚路径按 `seq/value` 匹配清理，避免 A->B->A 这类同值旧事件误清新的同字段保存尝试。
- 改进：`resource-panel.js` 的资源侧栏支持键盘 focus 保活，thread panel 焦点移入侧栏时不再触发延迟清空；资源触发面板同步 `role="button"` 和 `aria-pressed`，让固定/取消固定状态可被读屏识别。
- 改进：`floating-panel.js` 在设置面板打开并启用 Tab focus trap 时同步 `aria-modal="true"`，关闭后恢复 `false`，让 dialog 语义和键盘行为一致。
- 验证：`tools/verify.js` 补 pending 字段不被旧外部刷新覆盖、非 pending 字段继续刷新、同值外部刷新不清 pending、旧 attempt 不清新 pending、当前 rollback 清 pending、资源侧栏 focus 保活、资源面板 pressed state 和 floating panel modal 语义的回归。
- 涉及文件：`floating-panel.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.214 (2026-06-08)

- 修复：资源面板里的三个手动 TXT 解析入口会把 `manualRetry` 从 `resource-panel.js` 传到 `renderer.js`、`fetcher.js` 和 `background.js`，手动重试时跳过 `TEXT_FAIL` 失败缓存预检，避免按钮仍可见但 5 分钟内不再实际发起抓取。
- 修复：TXT 附件 HTTP 429 不再写入 `TEXT_FAIL`；background 侧非 401/403 的 TXT 异常也保持可重试，只保留站点明确拒绝的 401/403 写失败缓存。
- 优化：`shared-utils.js` 的 `cacheIndex.updateEntries()` 在索引缺失时会扫描旧缓存、合并新 updates 后一次写回，不再先 rebuild 写一次、再合并写第二次。
- 验证：`tools/verify.js` 补手动重试透传、content/background 绕过失败缓存、429 不写失败缓存、手动按钮强制重试、cacheIndex 缺失索引单次写回、removeEntries 多 key/失败/缺失语义的回归。
- 涉及文件：`resource-panel.js`、`renderer.js`、`fetcher.js`、`background.js`、`shared-utils.js`、`cache.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.213 (2026-06-08)

- 优化：`shared-utils.js` 新增 `cacheIndex.updateEntries()` 批量索引更新路径，`cache.js` 的同一批缓存写入会合并 index entry 后一次读/写 `atp_cache_index_v1`，减少图片缓存 flush 或文章批量写入时的 storage 往返和整索引 JSON 处理。
- 兼容：`cacheIndex.updateEntry()` 保留原 API 并委托到批量路径，storage 读取失败、rebuild 失败和写入失败的回调语义保持不变。
- 验证：`tools/verify.js` 补批量 index 更新一读一写、合并条目持久化、旧失败语义和缓存写入调用批量路径的回归。
- 涉及文件：`shared-utils.js`、`cache.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.212 (2026-06-08)

- 优化：`shared-utils.js` 的 `extractImagesForSettings()` 普通帖子会直接提取到 bounded fallback pool，不再先按 display pool 解析一次、再为 fallback pool 解析同一 HTML；重图集合仍按 full fetch pool 扩展，普通帖隐藏候选数量和重图扩展语义不变。
- 修复：`scanner.js` 的 `findThreadContainer()` 改为按 populated primary、高置信、宽泛 fallback、empty shell fallback 分层选择；宽泛 `.bm_c` / `[id*="forum"]` / `[id*="thread"]` 必须先确认包含有效 thread 链接，避免提示块、广告容器或空 `#threadlist` 抢占扫描根导致列表漏扫。
- 修复：`previewer.js` 在上一张/下一张按钮到达首尾后被禁用并隐藏时，会把焦点拉回仍可用的预览控件；Tab trap 也会把逃出 modal 的焦点重新拉回预览层，避免键盘焦点离开 `aria-modal` 弹层。
- 验证：`tools/verify.js` 补普通帖单次 DOMParser、fallback pool 上限、重图 full fetch 扩展、prefix 重图判定、scanner root 分层选择、无有效链接 decoy 容器跳过、populated broad 优先于 empty shell 和预览焦点修复回归。
- 涉及文件：`shared-utils.js`、`scanner.js`、`previewer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.211 (2026-06-08)

- 修复：`content.js` 在帖子列表容器替换时提升 scan generation 后立即重绑 observer 和补扫；`renderer.js` / `loader.js` 的异步线程检查会确认 `panel` 与 `container` 仍挂在当前 DOM，避免旧列表任务继续更新 detached 线程。
- 修复：`resource-panel.js` 不再对 detached panel 做 inline/侧栏刷新，旧 pinned/hover/current 引用会被清掉，减少容器替换后的旧资源面板残留。
- 修复：`floating-panel.js` 的旧 settings 保存失败不再向调用方伪装成功；旧失败仍不播报 stale 错误，但会返回 `false`，让字段回滚语义保持一致。
- 优化：`viewport-observer.js` 为 slot retry 增加 O(1) 计数和统一标记 helper，`hasPendingSlotRetry()` 不再为了判断是否需要重挂 shared retry timer 而整表扫描 `pendingWrappers`。
- 优化：`viewport-observer.js` 的 hidden pending drain 增加轮转游标，隐藏标签页允许继续加载时会从上次位置推进，减少头部 blocked pending 反复消耗 attempt window 导致后段可加载项延迟。
- 修复：`loader.js` 进入隐藏页暂停时会同时清理 viewport pending slot retry timer 和 background wake timer，避免短生命周期 timer 自触发后才发现 loader 已暂停。
- 验证：`tools/verify.js` 补 slot retry 计数、shared retry 标记、hidden drain 游标、隐藏暂停清理 viewport retry/wake timer、detached thread live 检查和 stale settings 保存失败返回值的静态/行为回归。
- 涉及文件：`viewport-observer.js`、`loader.js`、`content.js`、`renderer.js`、`resource-panel.js`、`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.210 (2026-06-08)

- 修复：`background.js` 新增 `SAVE_SETTINGS_PATCH` 单队列写入入口，settings patch 会先与当前 storage 合并再归一化，`siteConfigs` 按 host 深合并，避免 popup 与悬浮面板跨上下文快速保存时互相覆盖未改字段。
- 修复：`popup.js` 与 `floating-panel.js` 保存设置时只提交 changed-field patch；悬浮面板单项修改、单项重置和重图原始预设不再把完整 schema 快照写回，避免旧 `visibleRows` 等字段覆盖其他设置入口的新值。
- 修复：`content.js` 在异步抓取返回后会确认候选容器和链接仍在 DOM 内、链接仍属于容器且 href 未变化；帖子列表容器替换后会重新绑定 observer 并立即补扫，减少旧节点无效注入和新容器漏扫。
- 优化：`content.js` 跨域文章交给 background 前先预读文章缓存和负缓存，缓存命中直接复用、负缓存命中直接跳过，只把 cache miss URL 发给 background，减少跨域链接重复网络抓取。
- 改进：`previewer.js` 预览 modal 层级提升到悬浮设置面板之上；`renderer.js` 的展开按钮补 `type="button"`、`aria-expanded` / `aria-controls`，缩略图加载/TXT 状态补 live region；`loader.js` / `viewport-observer.js` 的缩略图预览入口可访问名称包含图片序号和总数。
- 改进：`floating-panel.js` 打开后会把 Tab 焦点约束在设置面板/帮助面板内，Escape 可在焦点逃出面板后关闭浮窗，但不会抢占已打开图片预览层的 Escape；`resource-panel.js` 复制 fallback 使用临时 textarea 后恢复原焦点。
- 改进：`popup.html` / `popup.js` 将“一键清空缓存”明确为“一键清空缓存和日志”，通用按钮操作失败会写入 popup live 状态区，不只短暂修改按钮文字。
- 验证：`tools/verify.js` 补 background settings patch 队列、siteConfigs host 合并、悬浮面板 changed-key 保存、content live candidate/跨域缓存预读、容器替换补扫、预览层级、缩略图展开/状态/预览命名、浮窗焦点约束、资源复制焦点恢复和 popup 维护提示回归。
- 涉及文件：`background.js`、`popup.html`、`popup.js`、`floating-panel.js`、`content.js`、`previewer.js`、`renderer.js`、`loader.js`、`viewport-observer.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.209 (2026-06-08)

- 修复：`floating-panel.js` 悬浮面板保存改为只提交 schema 字段 patch，默认 storage 在写入时再与当前完整 settings 合并并归一化，避免调整悬浮面板参数时把 `enabled:false` 或 `siteConfigs` 站点禁用列表覆盖成默认值。
- 修复：`popup.js` 读取 `settings` 失败时不再吞错渲染默认设置，改为 fail-closed、禁用设置控件并阻止保存，避免 storage 临时读取失败后把真实设置覆盖为默认值。
- 修复：`background.js` TXT 附件代理只在附件 URL 与来源页同源且同为 HTTPS 时设置 referrer，并为 `onMessage` 增加非对象消息和缺失 sender 守卫，未知消息返回安全空响应，避免 MV3 service worker 边界下的 TypeError。
- 改进：`resource-panel.js` 资源面板支持键盘 focus 显示资源、Enter/Space 固定或取消固定，复制按钮补资源类型与数量的 `aria-label`，资源提示补 live region，错误提示切换为 assertive alert；`content.css` 补资源触发区键盘焦点样式。
- 改进：`popup.html` / `popup.js` 和 `floating-panel.js` 的展开按钮与数值输入错误补更明确的读屏反馈，非法数值会设置 `aria-invalid` / `aria-describedby` 并通过状态区播报有效范围。
- 优化：`scanner.js` 支持复用 `scanState` 游标，`content.js` 在链式扫描中持有该状态并使用 `scanLimit + 1` sentinel 判断后续候选，减少长列表每批处理后从 selector 起点重复扫描，也避免刚好到缓存上限时额外空扫；候选会先经过 viewport/预算 accept，再读取服务帖文本，减少离屏行 `textContent` 扫描。
- 修复：`content.js` 在异步抓取完成后、标记 `atp-processed` 或注入缩略图前再次过滤仍连接在 DOM 上的候选容器，避免对已移除的旧节点做无效注入。
- 修复：`loader.js` / `viewport-observer.js` 在隐藏页暂停状态下不再创建后台队列 wake timer；切回隐藏暂停时清理 hidden force load 标记和非预热 slot retry，减少暂停状态下的空唤醒。
- 验证：`tools/verify.js` 新增 scanner 游标/accept 顺序、background 消息守卫、悬浮面板 partial save 与 stale failure 行为回归，并补 popup/floating/resource panel 可访问性、content live-entry 过滤、hidden pause guard 等静态规则。
- 涉及文件：`background.js`、`scanner.js`、`content.js`、`content.css`、`resource-panel.js`、`floating-panel.js`、`popup.html`、`popup.js`、`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.208 (2026-06-08)

- 修复：`popup.js` 和 `floating-panel.js` 自动保存会先克隆稳定 settings payload，并通过串行写入队列提交到 `chrome.storage.local`，避免异步保存拿到可变 live settings 或旧写入晚完成时覆盖后续新设置；旧保存成功也不会覆盖新一轮状态反馈。
- 改进：popup 错误状态会切换为 `alert` / `aria-live="assertive"`，日志筛选和搜索控件补可访问名称；popup 与悬浮面板的单项重置按钮补按设置项区分的 `aria-label`，悬浮面板 select/number 控件改为真实 `label for` 关联。
- 改进：popup 和悬浮面板的输入、选择框、重置按钮及常用按钮补 `focus-visible` 焦点样式，避免键盘焦点只依赖 1px 边框颜色。
- 优化：`viewport-observer.js` 在重图清晰度切回 balanced 时复用一次 budget snapshot，只恢复可见或预算选中的 unloaded 重图，并把 cached budget 传入 restore queue；restore queue 消费阶段不再重复同一预算判定，defer 路径复用已读 viewport state。
- 优化：`loader.js` 的 round-robin 调度复用已生成的 background channel snapshot 做容量检查，并把该 snapshot 传给后台队列处理，减少同一轮对 `BG_TASKS` 的重复扫描。
- 优化：`content.js` 链式批处理会先缓存一批候选并按 5 条小批量消费，避免每批完成后重新从 selector 起点扫描。
- 优化：`viewport-observer.js` 的 pending retry 在默认隐藏页暂停策略下不再继续抢槽或重挂短定时器，页面回到可见时由 `loader.js` 主动唤醒一次 viewport pending retry；可见 pending retry 和 slot retry 使用轮转游标，并保留仍在轻量预热范围内的 slot retry。
- 验证：`tools/verify.js` 补保存快照/串行写入、popup/floating 可访问性、重图 balanced budget 过滤、restore queue 预算复用、round-robin background snapshot 复用、content 扫描候选队列、viewport hidden pause guard、retry 轮转游标和可见恢复唤醒回归。
- 涉及文件：`popup.html`、`popup.js`、`popup.css`、`floating-panel.js`、`floating-panel.css`、`viewport-observer.js`、`content.js`、`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.207 (2026-06-08)

- 修复：`floating-panel.js` 的消息显示会先清理旧自动隐藏 timer，避免旧成功提示定时器把新的保存失败提示清掉；浮层消息区域补 `role` / `aria-live` / `aria-atomic`，错误提示使用 alert 语义。
- 修复：`popup.js` 和 `floating-panel.js` 为自动保存增加按字段的尝试序号和值校验，旧保存失败只会在字段仍等于本次尝试值时回滚，避免快速连续调整时旧失败覆盖新选择；popup 回滚会同步首屏计数和依赖控件状态。
- 改进：`loader.js` 的失败缩略图占位补 button 语义、`aria-label` 和 Enter/Space 键盘重试，抢不到并发槽时会恢复鼠标与键盘重试入口。
- 改进：`popup.html` / `popup.js` / `popup.css` 同步总开关可访问名称、帮助/日志展开按钮的 `aria-expanded` / `aria-controls` / `aria-hidden`、日志读取中的 `aria-busy` 状态和总开关键盘焦点样式。
- 改进：`floating-panel.js` 同步参数说明按钮的 `aria-expanded` / `aria-controls` 和帮助面板 `aria-hidden`，从帮助面板关闭时恢复焦点到说明按钮。
- 改进：`popup.css`、`floating-panel.css` 补通用 disabled 样式，并把 hover 样式限制到未禁用控件。
- 优化：`viewport-observer.js` 将 viewport pending 抢槽失败后的重试合并为一个模块级定时器，hidden drain 和可见 pending retry 都按可用槽与尝试窗口提前停止；pending 真正转入加载后会 coalesce 唤醒后台队列，避免 pending 满后必须等待 500ms 轮询。
- 优化：`viewport-observer.js` 在预算协调队列恢复时复用已有 budget snapshot，非可见已选项不再重复计算预算；同批恢复触到 hard projected MP 后停止继续加码。
- 优化：`content.js` 跳过 ATP 自有子树内的新增节点，避免重图预览 canvas 或失败占位触发整页重扫；`loader.js` 调度诊断复用 `getHeavyRenderStats()` 的 `heavyUnloaded`，不再额外扫描。
- 验证：`tools/verify.js` 补保存竞态、键盘重试、popup disclosure/log 状态、浮层帮助状态、viewport pending 共享重试、后台唤醒、MutationObserver 自有子树跳过、restore queue budget 复用和 heavyUnloaded 统计复用回归。
- 涉及文件：`popup.html`、`popup.js`、`popup.css`、`floating-panel.js`、`floating-panel.css`、`viewport-observer.js`、`content.js`、`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.206 (2026-06-08)

- 改进：`popup.html` 新增设置状态区域，使用 `role="status"` / `aria-live="polite"` 公布保存状态。
- 改进：`popup.js` 将设置保存反馈集中到 `setPopupStatus()`，保存中、保存成功、需刷新和读取/保存失败都会在 popup 内可见；失败提示保持显示，重叠保存通过序号忽略旧结果。
- 改进：`popup.css` 补 popup 状态条的 info/success/error 样式，避免保存失败只停留在 console 或短暂控件闪烁里。
- 修复：`floating-panel.js` 的外部点击关闭不再恢复 launcher 焦点，避免用户点击页面控件时焦点被抢回右下角悬浮按钮；Escape 和面板关闭按钮仍恢复焦点。
- 验证：`tools/verify.js` 补 popup 状态区域、保存中/成功/失败文案、读取失败提示、重叠保存防旧结果覆盖和浮动面板外部点击关闭不抢焦点的静态回归。
- 涉及文件：`popup.html`、`popup.js`、`popup.css`、`floating-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.205 (2026-06-08)

- 改进：`previewer.js` 将大图预览暴露为 modal dialog，打开后聚焦关闭按钮，Tab 保持在预览控件内，关闭/销毁后恢复原页面焦点；首尾图片按钮会禁用，计数区域通过 `aria-live` 提示状态。
- 改进：`loader.js` / `viewport-observer.js` 给缩略图 wrapper 补 `tabIndex`、button 语义和键盘 Enter/Space 打开预览能力，失败占位会清理旧预览键盘状态；`content.css` 补缩略图 `:focus-visible` 样式。
- 改进：`floating-panel.js` 将悬浮设置面板声明为 dialog，打开后移焦到关闭按钮，Escape/关闭会恢复到 launcher；外部点击关闭不再抢回页面焦点；隐藏面板同步 `aria-hidden`，`floating-panel.css` 避免隐藏控件留在 Tab 顺序中。
- 优化：`loader.js` 的 idle 后台队列 drain 改为复用 `processBgTasks()` 的单批处理，不再在同一个 idle tick 内循环调用 `globalSchedule()`，减少大后台队列时的重复全局调度扫描。
- 优化：`loader.js` 为后台队列“是否存在普通任务”的判断增加队列版本缓存，减少 viewport pending 同轮抢槽时反复扫描 `BG_TASKS`。
- 优化：`viewport-observer.js` 的重图 restore queue 在单轮处理中复用 viewport state 和 budget snapshot，并用本批已恢复 MP 投影 delay 压力，减少候选过滤/消费时重复遍历 `heavyRenderItems` 和布局读取。
- 优化：`content.js` 的 MutationObserver 自身节点过滤不再对新增大子树做 `.atp-*` descendant 查询，只保留直接 ATP root class 判定，减少滚动/动态插入时的负向 DOM 查询成本。
- 验证：`tools/verify.js` 补大图预览 modal 焦点管理、缩略图键盘预览、浮动面板焦点/Escape/外部点击关闭、loader idle 单批 drain、后台队列普通任务判定缓存、content MutationObserver 直接类判定和 viewport restore queue budget snapshot 复用回归。
- 涉及文件：`previewer.js`、`loader.js`、`viewport-observer.js`、`content.js`、`content.css`、`floating-panel.js`、`floating-panel.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.204 (2026-06-08)

- 修复：`resource-panel.js` 对只有 `hasTextAttachments` / `textResourcesRetryable` 标记的旧 TXT 状态回退为 1 个附件，避免资源栏出现 `解析TXT (0个附件)` 这类矛盾入口；已有资源时继续显示 TXT 解析状态，inline 资源条也保留加载/失败提示。
- 优化：`cache.js` 合并成功写入后的 `getBytesInUse(null)` 配额检查，按短时间窗口或批量写入节流，写入失败后的即时淘汰路径保持不变。
- 优化：`content.js` 对无返回结果的注入路径懒创建并复用一个空文章对象；`viewport-observer.js` 在一次重图预算 reconcile 内复用 `budget.snapshot` 做可见预览兜底检查，减少同轮重复扫描 `heavyRenderItems` 和布局读取。
- 改进：`content.css` 在短视口下压缩资源侧栏顶部和高度，`floating-panel.js` 将右下角启动器改为 button 并同步 `aria-expanded`，`floating-panel.css` 增加键盘焦点样式。
- 验证：`tools/verify.js` 补 TXT marker 计数、缓存写入配额节流、浮动入口可达性、短视口资源侧栏和 viewport snapshot 复用回归。
- 涉及文件：`content.js`、`resource-panel.js`、`content.css`、`floating-panel.js`、`floating-panel.css`、`cache.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.203 (2026-06-08)

- 修复：`content.js` 的外部设置变更改为按 `SETTINGS_SCHEMA` 判断所有 `immediate:false` 项，只要布局、扫描或渲染相关设置变化就重建缩略图，不再只处理 `heavyThumbnailClarity`；同时把最新设置同步回已打开的浮动面板，避免 popup 或其他 storage 写入后悬浮控件显示旧值。
- 修复：`background.js` 和 `fetcher.js` 的文章/TXT 最终 URL 校验统一要求 `https:`，与 manifest host permissions 保持一致，避免 `http://` 站点 URL 被误判为允许后进入无权限 fetch 和重复临时失败。
- 修复：跨域 background 返回的确定性空文章结果会写入负缓存，避免 404、非 HTML、登录页或拦截页在每次页面重载时重复抓取；`retryableEmpty`、`partial` 和 `html_too_large` 仍不写负缓存。
- 验证：`tools/verify.js` 补 schema 驱动设置重载、浮动面板外部同步、https 协议校验、跨域确定性空结果负缓存和 manifest content script 加载顺序回归。
- 涉及文件：`content.js`、`floating-panel.js`、`background.js`、`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.202 (2026-06-08)

- 优化：`fetcher.js` 通过 `ATPCache.getArticleCacheState()` 一次读取文章缓存和负缓存，减少文章 cache miss 前的串行 `chrome.storage.local.get` 往返；缓存 TTL、负缓存 TTL、过期清理和缓存命中返回语义不变。
- 修复：旧缓存只有 `hasTextAttachments: true` 而缺少 `textAttachmentCount` 时继续保留 TXT 解析入口，计数回退为 1，避免 TTL 内吞掉按需解析入口。
- 修复：TXT 附件 background 解析增加 content-side deadline，background 递归中转下载按剩余时间裁剪每次 fetch timeout，并把共享等待预算提高到 4 个 TXT fetch 窗口，降低下载中转页多候选顺序尝试导致的假阴性。
- 优化：窄容器下缩略图 viewport 允许横向滚动，grid 保留配置列宽，避免右侧缩略图被 `overflow-x:hidden` 裁掉；浮动面板 CSS 到达前隐藏 Shadow host，窄/短视口下收缩面板尺寸，并用 `requestAnimationFrame` 合并拖动位置更新。
- 修复：图片预览关闭时恢复页面原有 `body.style.overflow`，并为缩略图加载动画补 `prefers-reduced-motion` 兜底。
- 验证：`tools/verify.js` 补缓存合并读取、旧 TXT marker 兼容、TXT deadline 传递/裁剪、缩略图窄容器滚动、浮动面板首帧隐藏/拖动合帧、预览 overflow 恢复和 reduced-motion 的静态回归。
- 涉及文件：`background.js`、`cache.js`、`fetcher.js`、`shared-utils.js`、`renderer.js`、`floating-panel.js`、`floating-panel.css`、`previewer.js`、`content.css`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.201 (2026-06-08)

- 优化：`scanner.js` 的候选行检测先定位论坛线程容器，候选选择器从该 scoped root 内查询，减少滚动、MutationObserver 和补扫触发时的全文档选择器扫描；当 root 本身就是候选行时仍保留原有识别能力，帖子过滤、服务帖跳过、扫描上限、权限和设置项不变。
- 验证：`tools/verify.js` 补 scanner scoped root 查询、root 自匹配候选保留和禁止恢复逐 selector 全文档查询的静态回归。
- 涉及文件：`scanner.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.200 (2026-06-08)

- 优化：`content.js` 的扫描结果注入阶段直接复用同源/跨域收集阶段已归一化的 `results[url]`，仅在缺失结果时用空文章数据兜底，不再对已归一化的 `sameData` / `bgData` 二次调用 `ATPCache.normalizeArticleData()`；统计口径、retryable empty、注入顺序、缓存写入、权限和设置项不变。
- 验证：`tools/verify.js` 补注入阶段复用 normalized results 和禁止恢复 `normalizeArticleData(results[url])` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.199 (2026-06-08)

- 优化：`content.js` 的同源文章抓取批处理先计算 `batchEnd` / `batchSize` 并预分配 Promise 批次数组，再按索引写入 `fetchSameOriginArticle()` 结果，避免每个同源批次通过 `batch.push()` 动态扩容；同源并发数、请求顺序、`Promise.all()` 结果顺序、跨域 fallback、权限和设置项不变。
- 验证：`tools/verify.js` 补同源批处理预分配数组、索引写入和禁止恢复 `batch.push()` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.198 (2026-06-08)

- 优化：`content.js` 的扫描批处理 URL 分组改为单次 `urlMap.get(url)` 后复用 `entriesForUrl`，首次出现时创建数组并保存，后续直接写入该数组，不再对同一个 URL 执行 `has()`、`set()`、`get()` 和二次 `get().push()`；URL 顺序、同源/跨域分流、注入顺序、权限和设置项不变。
- 验证：`tools/verify.js` 补扫描 URL 分组复用 `entriesForUrl` 和禁止恢复 `urlMap.has()` / `urlMap.get(url).push()` 多次查询路径的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.197 (2026-06-08)

- 优化：`viewport-observer.js` 的重图渲染日志在一次 `getHeavyRenderLogFields()` 快照中同步取得 `heavyUnloaded`，`logHeavyRender()` 直接复用该字段作为 `unloadedCount`，不再为同一条重图日志额外调用 `getHeavyUnloadedCount()` 扫描 `heavyRenderItems`；日志字段、统计口径、重图恢复/卸载策略、权限和设置项不变。
- 验证：`tools/verify.js` 补重图日志复用 `heavyUnloaded` 快照字段和禁止恢复日志内额外 unloaded 扫描的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.196 (2026-06-08)

- 优化：`loader.js` 新增 `getFirstTaskChannelSnapshot()`，首屏队列诊断在一次遍历中取得普通/重图计数和首个重图任务，并移除旧的 count-only / first-heavy 双扫描 helper；`schedule_state` 字段、首屏调度顺序、普通/重图压力语义、权限和设置项不变。
- 验证：`tools/verify.js` 补首屏 channel snapshot、诊断复用首个重图任务和禁止恢复旧双扫描 helper 的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.195 (2026-06-08)

- 优化：`loader.js` 继续复用后台队列快照，`getAvailableBackgroundSlots()` / 隐藏页 pending drain / `schedule_state` 日志路径直接使用同一次 `getTaskChannelSnapshot()` 结果，减少同轮对 `BG_TASKS` 的普通/重图计数和首个重图任务重复遍历；容量判断、隐藏页加载数量、普通/重图压力语义、任务顺序、权限和设置项不变。
- 验证：`tools/verify.js` 补后台可用槽计算、隐藏页 drain 和调度日志复用 channel snapshot 的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.194 (2026-06-08)

- 优化：`loader.js` 新增 `getTaskChannelSnapshot()`，单次扫描后台队列得到普通/重图计数和首个重图任务；`processBgTasks()` 将该快照传入 `hasBackgroundCapacity()`，避免同一 background 调度轮内先后重复执行 channel count 和 first-heavy 扫描；容量判断、普通/重图压力语义、任务顺序、权限和设置项不变。
- 验证：`tools/verify.js` 补 background channel snapshot、capacity 复用快照和批处理轮不重复扫描普通/重图队列的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.193 (2026-06-08)

- 优化：`loader.js` 的 `processBgTasks()` 在单个 background 调度轮内缓存 `hasNonHighFanoutWaiting`，每个任务的 defer 判断复用该值，不再为同一轮每个后台任务重复扫描 `BG_TASKS` 判断普通任务是否存在；普通/重图压力语义、任务顺序、延期重排、权限和设置项不变。
- 验证：`tools/verify.js` 补 background 调度轮普通任务存在性缓存和禁止恢复逐任务 `hasNonHighFanoutBgTask()` 扫描的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.192 (2026-06-08)

- 优化：`renderer.js` 的已加载候选优先排序改用 normalized URL 到候选索引的缓存，并并行缓存 preview/display key，loaded 命中后直接用索引标记成对 key，不再通过 `markCandidateUsed()` 重读 candidate 并重复归一化；候选顺序、display/preview 成对去重、loaded URL 匹配、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer loaded hit index/key 缓存和禁止恢复 `markCandidateUsed()` 重读路径的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.191 (2026-06-08)

- 优化：`renderer.js` 的已加载候选补齐阶段直接用缓存的 `previewKeys[j]` 做空值和去重判断，不再二次调用 `SharedUtils.getImagePreviewSrc(candidates[j])`；候选顺序、loaded URL 匹配、去重语义、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer fallback append 使用 cached preview key 过滤和禁止恢复二次 preview URL 读取的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.190 (2026-06-08)

- 优化：`renderer.js` 的已加载候选优先排序在构建 normalized 索引时缓存 preview key，后续补齐候选直接复用 `previewKeys`，不再对同一候选 preview URL 二次 `normalizeImageUrl()`；候选顺序、loaded URL 匹配、去重语义、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer preview key 缓存和禁止恢复 fallback append 阶段重复归一化的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.189 (2026-06-08)

- 优化：`renderer.js` 的线程注册阶段按 `firstScreenTotal` 预分配 `firstTasks` 数组，并用索引写入首屏任务，不再在每个线程注册时通过逐项 `push()` 扩容；首屏任务顺序、字段、时间戳、队列 offset、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer 首屏任务预分配和禁止恢复注册阶段 `firstTasks.push()` 的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.188 (2026-06-08)

- 优化：`resource-panel.js` 的侧栏和 inline 渲染路径新增 normalized group/TXT helper，`renderThread()` / `renderInline()` 在入口归一化 resources 后复用同一份对象生成分组和 TXT badge，不再重复调用 `normalizeResources()`；资源展示内容、按钮绑定、TXT 提示、权限和设置项不变。
- 验证：`tools/verify.js` 补 resource panel 渲染 normalized helper 和禁止恢复渲染入口后二次归一化的静态回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.187 (2026-06-08)

- 优化：`resource-panel.js` 的复制文本格式化新增 normalized helper，`formatTypeText()` / `formatAllText()` 在入口只归一化一次资源对象，分组和密码文本复用同一个 normalized resources，不再在复制所有资源时按资源组重复归一化；复制内容、分组顺序、密码开关、权限和设置项不变。
- 验证：`tools/verify.js` 补 resource panel normalized formatting helper 和禁止恢复 all-copy 每组重复归一化的静态回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.186 (2026-06-08)

- 优化：`renderer.js` 的表格模式 colspan 计算改用 `countTableCells()` 按 `children` 计数 `TD/TH`，不再为每个缩略图行插入执行 `querySelectorAll('td,th')` 并分配 NodeList；表格插入位置、colspan fallback、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer 表格 cell 计数 helper 和禁止恢复 `querySelectorAll('td,th').length` 的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.185 (2026-06-08)

- 优化：`content.js` 的跨域 background 主循环缓存单个 `bgEntry`，统计图片/资源和归一化文章数据都复用同一次 `bg[bk]` 读取，不再对同一返回项重复索引访问；返回处理顺序、缓存写入、重试判定、日志字段、权限和设置项不变。
- 验证：`tools/verify.js` 补 background 主循环复用 `bgEntry` 和禁止恢复归一化阶段重复读取 `bg[bk]` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.184 (2026-06-08)

- 优化：`content.js` 的跨域 background 返回处理在主 `bg` 扫描里同步累计返回图片数和资源数，不再为了日志 totals 第二次遍历同一批 background 结果；返回处理顺序、超时重试、缓存写入、日志字段、权限和设置项不变。
- 验证：`tools/verify.js` 补 background 返回 totals 单轮累计和禁止恢复第二轮 `bg` 统计扫描的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.183 (2026-06-08)

- 优化：`loader.js` 的后台批量入队复用单次 `Date.now()` 作为整批 `createdAt` / `queuedAt`，不再为同一批 background task 每项重复读取时间；批量大小、任务顺序、队列字段、权限和设置项不变。
- 验证：`tools/verify.js` 补后台批量入队批次级时间戳和禁止恢复逐 task `Date.now()` 的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.182 (2026-06-08)

- 优化：`loader.js` 的 background `requestIdleCallback` drain 在单次 idle 回调内复用 `idleMaxPending`，不再在循环每轮重复读取 settings、背景并发和 viewport pending limit；idle 回调之间仍重新读取最新设置，后台加载速度、viewport pending 上限语义、权限和设置项不变。
- 验证：`tools/verify.js` 补 background idle drain pending limit 单次计算和禁止恢复逐轮重算的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.181 (2026-06-08)

- 优化：`loader.js` 的后台可用槽和容量判断在单次同步计算内复用 `activeOrdinary`，不再在 `getAvailableSlotsForLimits()` / `hasBackgroundCapacity()` 中重复调用 `getActiveOrdinaryCount()`；普通/重图容量判断、普通工作压力语义、权限和设置项不变。
- 验证：`tools/verify.js` 补后台 slot/capacity 复用 active ordinary count 和禁止恢复重复读取的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.180 (2026-06-08)

- 优化：`loader.js` 的调度/队列诊断复用单次 `getViewportPendingStatsFields()` 结果，通过 `pendingCount` 派生 `viewportPending`，不再在同一次诊断里额外调用 `ATPLoader.getViewportPendingCount()`；pending stats 不可用时仍保留原计数兜底，诊断字段名、统计口径、权限和设置项不变。
- 验证：`tools/verify.js` 补 viewport pending stats 单次读取、`viewportPending` 复用 stats 和禁止恢复单独 pending count 读取的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.179 (2026-06-08)

- 优化：`viewport-observer.js` 的 `destroy()` 清理路径改用 `pendingWrappers.values()` / `heavyRenderItems.values()` iterator 循环，不再为热重载、停用或销毁时的 pending slot retry timer 清理和 heavy restore reveal 清理分配 `Map.forEach` 回调；清理顺序、timer 清理、restore reveal 监听移除、权限和设置项不变。
- 验证：`tools/verify.js` 补 viewport destroy pending/heavy iterator 清理和禁止恢复 `Map.forEach` 清理回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.178 (2026-06-08)

- 优化：`viewport-observer.js` 的轻量重图预热 observer 初始化改用 `pendingWrappers.entries()` iterator 循环，不再为 observer 创建后补挂现有 pending wrapper 分配 `Map.forEach` 回调；预热 margin 记录、`lightweightPreloadEligible` 过滤、observe 语义、权限和设置项不变。
- 验证：`tools/verify.js` 补轻量重图预热 observer 初始化的 pending margin/observe 语义和禁止恢复 `pendingWrappers.forEach(...)` 回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.177 (2026-06-08)

- 优化：`viewport-observer.js` 的重图清晰度切换 `applyHeavyThumbnailClarity()` 改用索引循环和 `heavyRenderItems.entries()` iterator 循环，不再为恢复队列清理、lightweight 持有/卸载和 balanced 恢复入队分配 `forEach` 回调；切换策略、预览持有、卸载、恢复入队、权限和设置项不变。
- 验证：`tools/verify.js` 补重图清晰度切换队列清理、lightweight/balanced 跟踪项扫描和禁止恢复 `forEach` 回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.176 (2026-06-08)

- 优化：`viewport-observer.js` 的可见页恢复清理 `clearHiddenLoadFlags()` 改用 `pendingWrappers.values()` iterator 循环，不再为从隐藏页回到可见页时的 pending 标记清理分配 `Map.forEach` 回调；`forceLoadWhenHidden` 清理、离屏 slot retry timer 清理、权限和设置项不变。
- 验证：`tools/verify.js` 补 hidden-load flags 清理 iterator 遍历、标记清理语义和禁止恢复 `pendingWrappers.forEach(...)` 清理回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.175 (2026-06-08)

- 优化：`viewport-observer.js` 的重图卸载计数诊断 `getHeavyUnloadedCount()` 改用 `heavyRenderItems.values()` iterator 循环，不再为 scheduler 诊断中的 `heavyUnloaded` 字段分配 `Map.forEach` 回调；卸载计数语义、诊断字段名、恢复队列计数、权限和设置项不变。
- 验证：`tools/verify.js` 补重图卸载计数 iterator 遍历、计数语义保留和禁止恢复 `heavyRenderItems.forEach(...)` 诊断回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.174 (2026-06-08)

- 优化：`viewport-observer.js` 的 pending 诊断统计 `getPendingStats()` 改用 `pendingWrappers.entries()` iterator 循环，不再为调度诊断中的 pending age、距离和轻量预热 miss 统计分配 `Map.forEach` 回调；统计字段、单次时间戳、距离读取、权限和设置项不变。
- 验证：`tools/verify.js` 补 pending 诊断 iterator 遍历、单次 timestamp、无效项 guard 和禁止恢复 `pendingWrappers.forEach(...)` 诊断回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.173 (2026-06-08)

- 优化：`viewport-observer.js` 的 scroll idle 补扫入口 `retryVisiblePending()` 改用 `pendingWrappers.entries()` iterator 循环，不再为滚动停止后的近屏 pending 重试分配 `Map.forEach` 回调；只重试未加载且仍在 viewport 的 pending 项、加载入口、返回计数、权限和设置项不变。
- 验证：`tools/verify.js` 补 scroll idle visible pending retry 的 iterator 遍历、viewport/loaded guard 保留和禁止恢复 `pendingWrappers.forEach(...)` 回调的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.172 (2026-06-07)

- 优化：`viewport-observer.js` 的隐藏页 pending 补图入口 `loadPendingWhenHidden(maxLoads)` 改用 `pendingWrappers.entries()` iterator 循环，达到 `maxLoads` 后真正停止扫描，不再通过 `Map.forEach` 继续遍历剩余 pending 项；隐藏页强制加载标记、加载入口、返回计数、权限和设置项不变。
- 验证：`tools/verify.js` 补隐藏页 pending 加载可中断 iterator 遍历、达到上限后 `break` 和禁止恢复 `pendingWrappers.forEach(...)` 上限回调返回的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.171 (2026-06-07)

- 优化：`viewport-observer.js` 的重图渲染预算快照构建改用 `heavyRenderItems.entries()` iterator 循环，不再在高频 `getHeavyRenderSnapshot()` 中为 `Map.forEach` 分配回调；快照字段、viewport 几何读取、统计口径、预算选择、权限和设置项不变。
- 验证：`tools/verify.js` 补重图预算快照 iterator 遍历和禁止恢复 `heavyRenderItems.forEach(...)` 快照构建的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.170 (2026-06-07)

- 优化：`viewport-observer.js` 的重图渲染预算 reconcile 阶段复用同一个 `budget.snapshot.items` 快照数组，并将卸载/恢复两轮扫描改为索引循环，不再为两次预算遍历分配 `forEach` 回调；预算选择、卸载批量、恢复入队、可见预览 retry、权限和设置项不变。
- 验证：`tools/verify.js` 补重图预算快照数组复用、索引循环遍历和禁止恢复 `budget.snapshot.items.forEach(...)` 的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.169 (2026-06-07)

- 优化：`renderer.js` 新增 `getImageHost()`，线程注册诊断 `summarizeImageHosts()` 复用该 helper 解析候选 preview host，不再在候选循环内展开 `new URL(src).hostname` 和 try/catch；`hostMix` 字段、格式异常 URL 忽略语义、`image.imx.to-heavy` 计数、权限和设置项不变。
- 验证：`tools/verify.js` 补 renderer host 诊断 host parsing helper 和禁止恢复内联 candidate host 解析的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.168 (2026-06-07)

- 优化：`background.js` 新增 `isAllowedOriginHost()`，`originAllowed()` 和 `textAttachmentAllowed()` 共用站点 host 判断，TXT final URL 校验复用已解析的 `u.hostname`，不再通过 `originAllowed(url)` 二次解析同一个 URL；允许站点、`xia.ewrewej.la` / `dl.ldkms.la` TXT 规则、重定向拒绝、权限和设置项不变。
- 验证：`tools/verify.js` 补 background origin host helper 复用和禁止 TXT final URL 校验重复解析的静态回归。
- 涉及文件：`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.167 (2026-06-07)

- 优化：`content.js` 新增本地 `isSameOriginUrl()`，扫描批处理的 same/cross URL 分流复用该 helper，不再在分流循环内展开 `new URL(u)` 和 try/catch；非法 URL 仍进入 cross/background 兜底，同源直连抓取、跨域 handoff、空结果重试、权限和设置项不变。
- 验证：`tools/verify.js` 补 content 扫描 URL 同源 helper 复用和禁止恢复内联 URL origin 解析的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.166 (2026-06-07)

- 优化：`loader.js` 的高扇出图床判断和域名熔断提取复用 `getUrlHost()`，不再在 `isHighFanoutImageHost()` / `extractDomain()` 内各自重复 `new URL(url).hostname` 解析和异常防护；`image.imx.to` 识别、no-referrer 默认策略、普通域名熔断、权限和设置项不变。
- 验证：`tools/verify.js` 补 loader host parsing 集中复用和禁止恢复重复 hostname 解析的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.165 (2026-06-07)

- 优化：`fetcher.js` 新增本地 `isSameOriginUrl()`，TXT 附件分流、TXT 中转下载递归和 fresh 附件抓取入口复用同源判断，不再在三处重复 `new URL(...).origin` 解析和 try/catch 防护；非法 URL 仍走跨域/background 兜底，同源直连、跨域中转、失败缓存、权限和设置项不变。
- 验证：`tools/verify.js` 补 fetcher 同源 URL helper 复用和禁止恢复重复 origin 解析的静态回归。
- 涉及文件：`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.164 (2026-06-07)

- 优化：`shared-utils.js` 新增模块级 `ARTICLE_KEEP_PARAM_MAP`，`normalizeArticleUrl()` 复用该参数表筛选 `mod/tid/page`，不再为每个文章 URL 归一化调用重建 `keepParams` 数组或执行数组 `indexOf` 扫描；文章缓存 key 归一化、参数排序、hash 清理、权限和设置项不变。
- 验证：`tools/verify.js` 补 article URL 保留参数表复用和禁止恢复 per-call `keepParams` 数组的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.163 (2026-06-07)

- 优化：`content.js` 的扫描结果注入阶段复用已有 `allUrls` 顺序数组，用索引循环读取 `urlMap.get(url)` 分组，不再通过 `urlMap.forEach(function(entries, url)` 分配回调；候选 URL 顺序、空结果重试、已处理标记、缩略图注入策略、权限和设置项不变。
- 验证：`tools/verify.js` 补 content 扫描结果注入索引循环、URL 分组复用和禁止恢复 `urlMap.forEach()` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.162 (2026-06-07)

- 优化：`viewport-observer.js` 的三个 `IntersectionObserver` entries 回调改为索引循环遍历，覆盖重图渲染观察、轻量重图预热观察和主 viewport lazy 观察，减少滚动/可见性批处理中的回调分配；observer margin、threshold、加载/卸载策略、权限和设置项不变。
- 验证：`tools/verify.js` 补 viewport observer entries 索引循环和禁止恢复 `entries.forEach(function(entry)` 的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.161 (2026-06-07)

- 优化：`content.js` 的用户交互唤醒监听新增 `bindUserInteractionListeners()`，启动注册和卸载移除都改为索引循环遍历 `USER_EVENTS`，不再用 `USER_EVENTS.forEach()` 回调；监听事件集合、`passive/once` 选项、卸载清理、权限和设置项不变。
- 验证：`tools/verify.js` 补用户交互监听索引循环绑定和禁止恢复 `USER_EVENTS.forEach()` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.160 (2026-06-07)

- 优化：`content.js` 的缩略图清理路径新增 `removeNodes()` / `removeClassFromNodes()`，热重载、停用和清理缩略图 DOM 时改用索引循环处理 panels、rows 和 processed containers，不再对 `querySelectorAll()` 结果使用 `NodeList.forEach()` 回调；清理顺序、线程状态重置、预览器/viewport/资源面板销毁、权限和设置项不变。
- 验证：`tools/verify.js` 补 content 缩略图 DOM 清理索引循环和禁止恢复 NodeList.forEach 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.159 (2026-06-07)

- 优化：`resource-panel.js` 的资源类型复制按钮绑定改为 `bindCopyTypeButton()` 加索引循环，不再对 sidebar/inline 的 `querySelectorAll('[data-copy-type]')` 结果使用 `NodeList.forEach()` 回调；复制按钮行为、inline 点击先刷新侧栏、资源面板展示、权限和设置项不变。
- 验证：`tools/verify.js` 补资源面板 copy-type 按钮索引循环绑定和禁止恢复 NodeList.forEach 的静态回归。
- 涉及文件：`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.158 (2026-06-07)

- 优化：`shared-utils.js` 新增 `forEachResourceSourcePart()` / `hasResourceSource()`，资源来源合并和资源面板 TXT 来源判断改为扫描 `+` 分隔片段，不再为每个来源字符串执行 `split('+')`；资源来源合并顺序、TXT 标记识别、资源面板展示、权限和设置项不变。
- 验证：`tools/verify.js` 补资源来源 helper 行为测试和禁止恢复 split source 数组的静态回归。
- 涉及文件：`shared-utils.js`、`resource-panel.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.157 (2026-06-07)

- 优化：`shared-utils.js` 的 `isDirectImageUrl()` 复用模块级 `IMAGE_DIRECT_PARAM_NAMES`，不再为每个 href 图片直链判断重建代理图片参数名数组；直接图片后缀识别、代理 URL 参数识别、图片候选来源、权限和设置项不变。
- 验证：`tools/verify.js` 补图片直链代理参数名共享和禁止恢复逐 URL 构造参数数组的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.156 (2026-06-07)

- 优化：`shared-utils.js` 的 srcset 解析新增 `getSrcsetUrls()` 单次扫描 helper，图片提取路径每个 `srcset` 只解析一次并同时得到 best/smallest 候选；保留 `getBestSrcsetUrl()` / `getSmallestSrcsetUrl()` 兼容入口，图片候选顺序、显示图/预览图选择、去重语义、权限和设置项不变。
- 验证：`tools/verify.js` 补 srcset 单次解析行为测试和禁止恢复 comma/token split 中间数组的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.155 (2026-06-07)

- 优化：`shared-utils.js` 的 `normalizeImageUrl()` 复用模块级 `IMAGE_KEEP_PARAM_MAP`，不再为每个图片 URL 归一化调用重建保留 query 参数数组和 map；图片 URL 保留参数、排序、hash 清理、去重语义、权限和设置项不变。
- 验证：`tools/verify.js` 补图片 URL 归一化共享参数表和禁止恢复逐 URL 构造参数表的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.154 (2026-06-07)

- 优化：`shared-utils.js` 的 `extractProtocolLinks()` 改为单游标扫描 marker 并按需计算下一个边界，不再先收集 positions 数组；magnet/ed2k 协议链接提取顺序、清洗、去空、资源分类、权限和设置项不变。
- 验证：`tools/verify.js` 补协议链接单游标扫描和禁止恢复 marker positions 数组的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.153 (2026-06-07)

- 优化：`shared-utils.js` 的 `cleanPasswordValue()` 改为用首个空白分隔符和后缀中文检测处理密码说明，不再对每个密码候选执行 `split()`、`slice(1)`、`join()`；密码清洗规则、中文说明截断、占位过滤、长度上限、权限和设置项不变。
- 验证：`tools/verify.js` 补密码清洗首分隔符扫描和禁止恢复 password `split/slice/join` 的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.152 (2026-06-07)

- 优化：`popup.js` 日志 key 发现的固定 key 初始化改为循环填充并同步 seen map，不再用 `LOG_KEYS.slice()` 复制固定 key 数组；日志 key 发现范围、去重、索引读取、日志加载/导出/清理行为不变。
- 验证：`tools/verify.js` 补 popup 固定日志 key 循环初始化和禁止恢复 `LOG_KEYS.slice()` 的静态回归。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.151 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 的日志字节预算裁剪改为通过 `estimateLogBytesFrom()` 估算保留窗口，不再在裁剪循环调用点直接 `entries.slice(start)`；当前估算输入、裁剪步进、最终保留窗口、日志顺序、storage key、权限和设置项不变。
- 验证：`tools/verify.js` 补 content/background 日志字节估算 helper 和禁止恢复 trim callsite `estimateLogBytes(entries.slice(start))` 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.150 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 的日志裁剪最终保留窗口改为 `copyLogEntriesFrom()` 预分配循环复制，不再用 `entries.slice(start)` 复制；裁剪起点、字节预算、条数上限、失败重试、日志顺序、storage key、权限和设置项不变。
- 验证：`tools/verify.js` 补 content/background 日志保留窗口循环复制和禁止恢复 final `entries.slice(start)` 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.149 (2026-06-07)

- 优化：`shared-utils.js` 的图片提取结果限制新增 `limitImageResults()`，regex/DOM 两条图片提取路径只在超限时原地收窄，不再每次返回前 `images.slice(0, maxCount)` 复制数组；图片候选顺序、数量上限、去重、重图识别、权限和设置项不变。
- 验证：`tools/verify.js` 补图片提取结果集中限制、原地裁剪和禁止恢复无条件 result `slice()` 的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.148 (2026-06-07)

- 优化：`popup.js` 重图原始预设恢复新增 `forEachHeavyOriginalPreset()`，应用预设和失败回滚都用 `for...in` 自有属性扫描，不再用 `Object.keys(HEAVY_ORIGINAL_PRESET).forEach()` 分配 key 数组；预设字段、保存流程、失败回滚、权限和设置项不变。
- 验证：`tools/verify.js` 补 popup 重图预设字段集中遍历和禁止恢复 `Object.keys(HEAVY_ORIGINAL_PRESET)` 的静态回归。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.147 (2026-06-07)

- 优化：`popup.js` 的缓存/日志维护 key 合并新增 `collectUniqueKeys()`，缓存索引兜底、一键清空缓存、清空日志不再用 `concat()` 链复制 key 数组；删除范围、去重语义、日志索引 key、缓存索引清理、权限和设置项不变。
- 验证：`tools/verify.js` 补 popup 维护操作 grouped key 去重和禁止恢复 indexed/discovered/cache/log `concat()` 的静态回归。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.146 (2026-06-07)

- 优化：`shared-utils.js` 的 `restoreMailtoPassword()` 邮箱/密码恢复候选值合并改为先固定 href/title/label，再循环追加 `data-*` 属性值，不再对每个 anchor 使用 `concat()`；候选检查顺序、受保护邮箱恢复、密码提取、资源解析、权限和设置项不变。
- 验证：`tools/verify.js` 补 mailto 候选值循环追加和禁止恢复 data attribute `concat()` 的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.145 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 的日志 flush 失败重试改为 `retryBatch` 优先槽，不再用 `flushQueue.unshift(batch)` 搬移队列；失败批次仍在下一次 drain 中优先写入，日志顺序、重试次数、丢弃策略、storage key、权限和设置项不变。
- 验证：`tools/verify.js` 补 content/background retry batch 优先槽和禁止恢复 `flushQueue.unshift()` 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.144 (2026-06-07)

- 优化：`renderer.js` 帖子候选池和展示候选收窄改为 `copyCandidatePrefix()` 预分配循环复制，不再在注册线程热路径使用 `slice()` 复制候选数组；候选顺序、fetch/display 限制、重图策略、首屏任务和缓存格式不变。
- 验证：`tools/verify.js` 补 renderer 候选前缀复制 helper、预分配复制和禁止恢复 candidate/display `slice()` 的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.143 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 的 `mergeLogEntries()` 继续收窄日志写入热路径分配，合并 existing+batch 时预分配目标数组并按索引写入，不再依赖动态 `push()` 扩容；日志顺序、容量预算、失败重试、storage key、权限和设置项不变。
- 验证：`tools/verify.js` 补 content/background 日志合并预分配和禁止恢复 merged `push()` 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.142 (2026-06-07)

- 优化：`shared-utils.js` 的 `mergeResources()` 分组资源合并改为循环 `push()`，不再对每个资源源使用 `concat()` 复制已有分组数组；资源归一化、去重、密码合并、缓存格式、权限和设置项不变。
- 验证：`tools/verify.js` 补资源分组合并循环追加和禁止恢复 group `concat()` 的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.141 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 日志写入前的 existing+batch 合并改为 `mergeLogEntries()` 循环构造，不再用 `concat()` 复制；写入失败后的半段重试改用 `trimLogEntriesFrom()` 从起点裁剪，不再先 `slice()` 后裁剪。日志顺序、尾部保留、容量预算、失败重试和 storage key 不变。
- 验证：`tools/verify.js` 补 content/background 日志写入循环合并、起点裁剪重试和禁止恢复 concat/slice 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.140 (2026-06-07)

- 优化：`logger.js` 日志索引维护改为 `collectSortedContentLogKeys()` 单次过滤/去重/追加当前 key，`planLogKeyPrune()` 用循环分流 kept/stale，不再用 `filter()`、`concat()`、`slice()` 生成索引中间数组；按时间排序、最近 key 保留、容量裁剪和旧日志删除语义不变。
- 验证：`tools/verify.js` 补日志索引 key 收集、prune 分流和禁止恢复 filtered/concat/sliced key 数组的静态回归。
- 涉及文件：`logger.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.139 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 日志裁剪改为用 `start` 游标定位最终保留窗口，不再进入裁剪前先复制完整日志数组，也不再先按条数上限生成中间 slice；日志保留尾部、条数上限、字节预算和失败重试语义不变。
- 验证：`tools/verify.js` 补 content/background 日志裁剪 start 游标和禁止恢复全量复制/预切片的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.138 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 结构化日志脱敏改为有界循环处理数组字段和对象字段，不再用 `slice().map()`、`Object.keys().slice()` 生成中间数组；字段脱敏规则、优先字段、字段数量上限、循环引用保护和日志输出语义不变。
- 验证：`tools/verify.js` 补 content/background 日志数组字段、对象字段有界脱敏和禁止恢复 slice/map/Object.keys 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.137 (2026-06-07)

- 优化：`logger.js` 和 `background.js` 日志 flush 队列改为 `drainFlushQueue()` 一次性嵌套循环合并批次，不再用 `concat(shift())` 反复复制数组和搬移队列；日志字段、storage key、容量上限、失败重试和重排语义不变。
- 验证：`tools/verify.js` 补 content/background 日志 flush 队列 drain 和禁止恢复 `concat(shift())` 的静态回归。
- 涉及文件：`logger.js`、`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.136 (2026-06-07)

- 优化：`background.js` 的 `FETCH_TEXT_RESOURCES` 入口和后台 TXT 附件资源解析改为有界循环过滤/截断附件，并循环构造 TXT fetch Promise，不再通过 `filter()`、`slice()`、`map()` 生成中间数组；附件允许规则、数量上限、失败缓存、读取流程和资源合并顺序不变。
- 验证：`tools/verify.js` 补后台 TXT message handler、附件输入截断和 Promise 构造的静态回归。
- 涉及文件：`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.135 (2026-06-07)

- 优化：`background.js` 跨域文章抓取入口和批处理改为循环收集合规 URL、循环构造每批 URL/Promise，不再用 `filter()`、`slice()`、`map()` 在 service worker 热路径生成中间数组；批大小、抓取顺序、结果结构和缓存写入语义不变。
- 验证：`tools/verify.js` 补后台图片 handoff URL 收集、批次构造和禁止恢复 filter/slice/map 的静态回归。
- 涉及文件：`background.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.134 (2026-06-07)

- 优化：`fetcher.js` TXT 附件资源解析路径改为有界循环截断输入、循环构造同源直连 Promise 和跨域失败缓存 Promise，并用单次循环收集最终后台兜底附件，不再使用 `slice()`/`map()`/`filter()` 产生中间数组；同源直连、硬失败跳过、跨域 background 兜底和资源合并顺序不变。
- 验证：`tools/verify.js` 补 TXT 附件输入截断、同源/跨域 Promise 构造和最终兜底过滤的静态回归。
- 涉及文件：`fetcher.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.133 (2026-06-07)

- 优化：`loader.js` 直接加载和手动重试路径在初始化 `<img>` 的 `src/referrerPolicy` 时复用一次 `initialSrc`，不再连续两次读取 `getTaskImageSrc(task)`；timeout/error/fallback 仍按当前候选 URL 重新读取，加载策略不变。
- 验证：`tools/verify.js` 补初始图片 source 复用和禁止重复读取的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.132 (2026-06-07)

- 优化：`renderer.js` 线程注册时复用单个 `registeredAt` 时间戳生成 `threadId` 并作为首屏任务 `queuedAt/createdAt` 基准，不再在同一注册路径里为线程 id 和首屏任务时间分别读取 `Date.now()`。
- 验证：`tools/verify.js` 补线程注册单时间戳、thread id 复用注册时间和禁止恢复单独 `Date.now()` 生成 thread id 的静态回归。
- 涉及文件：`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.131 (2026-06-07)

- 优化：`content.js` 跨域后台抓取返回日志汇总改为单次 `for...in` 自有属性扫描，同时累计图片总数和资源总数，不再用两次 `Object.values(bg).reduce(...)` 分配数组并重复遍历后台结果。
- 验证：`tools/verify.js` 补后台返回日志单次汇总、禁止恢复 `Object.values(bg).reduce` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.130 (2026-06-07)

- 优化：`content.js` 滚动触发的扫描候选筛选新增 `createProcessScanContext()`，每轮 `detectProcessCandidates()` 复用一次时间戳和近屏 viewport 下界，避免每个候选都重复读取 `Date.now()` 和计算 `vh + VIEWPORT_SCAN_MARGIN`；候选仍逐项读取自身 DOM rect 判断是否近屏。
- 验证：`tools/verify.js` 补每轮扫描上下文、复用 timestamp/viewport bound 和禁止恢复逐候选 viewport 下界计算的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.129 (2026-06-07)

- 优化：`viewport-observer.js` 重图恢复预算判断链支持传入缓存的 `viewportState`，`queueHeavyRestore()` 在同一分支内复用一次几何读取完成恢复范围、预算允许和 skip-budget 可见性判断，减少入队阶段重复 `getBoundingClientRect()`。
- 验证：`tools/verify.js` 补预算 helper 接收缓存几何、入队路径复用 `viewportState` 和禁止恢复二次 viewport 读取的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.128 (2026-06-07)

- 优化：`viewport-observer.js` 重图恢复队列处理时提前建立 `restoreQueueViewportState` 几何缓存，清理阶段的恢复范围判断和后续排序共用同一批 `getViewportRectState()` 结果，减少恢复批处理中的重复 `getBoundingClientRect()` 读取。
- 验证：`tools/verify.js` 补恢复队列几何缓存、清理阶段复用缓存和禁止恢复清理/排序分离布局读取的静态回归。
- 涉及文件：`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.127 (2026-06-07)

- 优化：`loader.js` 和 `viewport-observer.js` 预览打开路径改为通过 `buildPreviewUrls()` 循环构造 URL 列表，不再在加载成功/恢复后点击预览时重复使用 `previewCandidates.map(...)` 回调分配；预览 URL 解析逻辑集中由 loader 暴露复用。
- 验证：`tools/verify.js` 补预览 URL builder 暴露、loader/viewport 预览路径复用和禁止恢复 `previewCandidates.map(...)` 的静态回归。
- 涉及文件：`loader.js`、`viewport-observer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.126 (2026-06-07)

- 优化：`content.js` 扫描完成 article count 改为 `countOwnProperties(results)` 单次自有属性计数，不再用 `Object.keys(results).length` 分配结果 key 数组；普通完成日志和 `scan_complete` 结构化事件继续复用同一计数。
- 验证：`tools/verify.js` 补 allocation-free article count、禁止恢复 `Object.keys(results).length` 的静态回归。
- 涉及文件：`content.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.125 (2026-06-07)

- 优化：`loader.js` 首屏 round-robin 队列消费改为 `firstTaskOffset` 游标读取，不再每启动一张首屏图就 `firstTasks.shift()` 搬移数组；队列前缀在累计消费后才批量压缩，重试任务仍追加到队尾，保持原首屏并发、重图/普通图优先级、重试和 stop-loss 语义。
- 验证：`tools/verify.js` 补 first-screen queue offset、队头 helper、禁止恢复 `firstTasks.shift()` 和直接 `firstTasks[0]` 的静态回归。
- 涉及文件：`loader.js`、`renderer.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.124 (2026-06-07)

- 优化：`shared-utils.js` 资源访问码匹配改为扫描时维护当前最佳候选，不再为附近提取码/密码候选构造数组、`concat()` 后再按 score 全量排序，减少资源链接提取时的中间数组和排序成本，同时保留最近候选优先、跨资源链接隔离和解压密码跳过语义。
- 验证：`tools/verify.js` 补 access-code best candidate、禁止恢复候选数组 concat/sort 的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.123 (2026-06-07)

- 优化：`shared-utils.js` 资源密码提取改为 `mergeUniqueLimited(..., 5)` 有界合并，不再先完整 `mergeUnique(...)` 后 `.slice(0, 5)`，减少长帖/TXT 中密码候选较多时的中间数组分配，同时保留 HTML 密码优先、正文密码补充、去重和占位过滤语义。
- 验证：`tools/verify.js` 补 bounded password merge、资源密码提取不切片完整合并列表的静态回归。
- 涉及文件：`shared-utils.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.122 (2026-06-07)

- 优化：`loader.js` host timing 诊断 p90 计算改为有界选择目标分位值，不再 `values.slice().sort(...)` 复制并排序样本数组，减少 `diagnostic_summary` flush 时的短时数组分配和排序成本，同时不修改 ring buffer 样本顺序。
- 验证：`tools/verify.js` 补 host timing percentile 使用 bounded selection、禁止恢复 copied sample sort 的静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.121 (2026-06-07)

- 优化：`loader.js` 诊断汇总合并、重图 host 健康摘要和活跃首屏线程收集改为 `for...in` 自有属性扫描，不再用 `Object.keys(...).forEach(...)` 先分配 key 数组，减少调度诊断、重图健康统计和首屏 round-robin 辅助路径的短时分配。
- 验证：`tools/verify.js` 补 loader 诊断 source 合并、queue-kind 合并、heavy-host health summary 和 active first-screen thread collection 的无 `Object.keys` 分配静态回归。
- 涉及文件：`loader.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.120 (2026-06-07)

- 优化：`popup.js` 日志 key 兜底发现和 cacheIndex 条目扫描改为 `for...in` 单次遍历，不再用 `Object.keys(...).forEach(...)` 先分配完整 key 数组，减少大 storage 下打开日志、清缓存和缓存索引兜底读取时的短时分配。
- 验证：`tools/verify.js` 补日志 key storage discovery、cache index scan 的无 `Object.keys` 分配静态回归。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.119 (2026-06-07)

- 优化：`popup.js` 日志读取在排序后保留最近 `LOG_VIEW_LIMIT` 条时改为原地 `splice()` 裁剪旧项，不再用 `logs.slice(...)` 复制最近日志数组，减少打开日志面板、导出日志或刷新日志计数时的大数组短时分配。
- 验证：`tools/verify.js` 补充日志读取原地裁剪和禁止恢复 copied recent-log array 的静态回归。
- 涉及文件：`popup.js`、`tools/verify.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`、`HANDOFF.md`
- Breaking change：无

## 1.14.118 (2026-06-07)

- 优化：`popup.js` 日志面板渲染最近日志时改为计算起始索引并直接从 filtered 数组渲染，不再 `filtered.slice(-LOG_RENDER_LIMIT)` 复制最近日志数组，减少大日志过滤/刷新后的短时分配。
- 验证：`tools/verify.js` 补 recent window 起始索引、直接渲染 filtered 数组和禁止恢复 recent-log slice 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.117 (2026-06-07)

- 优化：`popup.js` 日志数组字段脱敏改为有界循环填充结果，保留 50 项上限和循环引用保护，但不再 `value.slice(0, 50).map(...)`，减少日志查看/导出时的中间数组分配。
- 验证：`tools/verify.js` 补数组脱敏 50 项上限、有界循环和禁止恢复 `slice().map()` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.116 (2026-06-07)

- 优化：`popup.js` 日志字段脱敏改为有界 `for...in` 扫描，保留 120 字段上限但不再 `Object.keys(fields).slice(...)`；日志数据文本判断也改为 `hasLogFields()`，避免仅判断字段存在时分配 key 数组。
- 验证：`tools/verify.js` 补字段脱敏有界循环、120 字段上限、禁止 sliced field-key 数组和禁止 `Object.keys(fields).length` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.115 (2026-06-07)

- 优化：`popup.js` 清缓存兜底发现 storage key 时改为单次 `for...in` 扫描并直接收集匹配 key，不再用 `Object.keys(all).filter(...)` 先分配全量 key 数组再过滤，降低一键清缓存等维护操作在大 storage 下的短时分配。
- 验证：`tools/verify.js` 补 cache key discovery 单次扫描、禁止恢复 filtered storage-key 数组的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.114 (2026-06-07)

- 优化：`content.js` 扫描完成日志复用单次 `articleCount` 计数，不再为普通日志和 `scan_complete` 结构化事件分别执行 `Object.keys(results).length`，减少扫描收尾阶段重复枚举。
- 验证：`tools/verify.js` 补扫描完成 article count 单次计算、普通日志/结构化事件复用和禁止重复枚举结果 key 的静态回归。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.113 (2026-06-07)

- 优化：`renderer.js` 帖子初始化候选池只有在 `fetchLimit` 真正小于图片数组长度时才复制；未收窄时直接复用 `images`，减少普通帖子和已按抓取上限收敛帖子初始化阶段的一次数组分配。
- 验证：`tools/verify.js` 补 candidatePool 条件复制、禁止恢复无条件 `images.slice(0, fetchLimit)` 的静态回归。
- 涉及文件：renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.112 (2026-06-07)

- 优化：`renderer.js` 注册线程诊断的 `hostMix` 改为有界维护 top 6 host，不再对全部 host counter 执行 `Object.keys().sort().slice().map()`，减少帖子初始化诊断路径的临时数组和排序成本。
- 验证：`tools/verify.js` 补 renderer hostMix 有界 top host 收集、禁止恢复全量排序/切片/映射的静态回归。
- 涉及文件：renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.111 (2026-06-07)

- 优化：`popup.js` 日志导出摘要的 type/host/level top counts 改为有界 top-N key 收集，不再对全部 counter key 执行 `Object.keys().sort().slice().map()`，减少大日志导出时的临时数组和排序成本。
- 验证：`tools/verify.js` 补 popup 摘要 counter 有界 top-N 收集、禁止恢复全量排序/切片/映射的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.110 (2026-06-07)

- 优化：`popup.js` content 日志裁剪改为有界维护最新 `MAX_CONTENT_LOG_KEYS` 个 key，再单次收集待删除旧 key，不再先 `filter()` 全量 content key、排序再 `slice()`。
- 验证：`tools/verify.js` 补 content 日志裁剪有界 newest key 集合，以及禁止恢复全量过滤/排序/切片的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.109 (2026-06-07)

- 优化：`loader.js` 诊断摘要的 counts/reasons/hosts/channels/unloadReasons/preloadMissReasons 和 host timing 汇总改为有界 top-N key 收集，不再对全量 key/host 做 `sort().slice()`，减少大样本诊断 flush 时的临时数组排序成本。
- 验证：`tools/verify.js` 补 loader 诊断 top-N 有界收集、禁止恢复全量 key/host 排序的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.108 (2026-06-07)

- 优化：`renderer.js` 注册线程时 TXT 附件归一化不再用 `(textAttachments || []).map(...)`，改为显式循环补齐缺失 `pageUrl`，减少帖子初始化时的回调和中间分配。
- 验证：`tools/verify.js` 补 TXT 附件归一化单次循环和禁止恢复 `map(...)` 的静态回归。
- 涉及文件：renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.107 (2026-06-07)

- 优化：`resource-panel.js` 资源复制文本构造不再为密码列表先 `filter()`，单类型复制也不再 `parts.filter(Boolean)`；改为单次循环拼接，减少资源面板复制时的临时数组分配。
- 验证：`tools/verify.js` 补密码复制单次循环、禁止恢复密码 `filter()` 和单类型复制 `parts.filter(Boolean)` 的静态回归。
- 涉及文件：resource-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.106 (2026-06-07)

- 优化：`renderer.js` 构造 `allCandidates` 时只有显示/重图上限小于候选池长度才复制数组；上限未收窄时直接复用 `candidatePool`，减少帖子缩略图初始化阶段的候选数组分配。
- 验证：`tools/verify.js` 补 render limit 单次计算、候选池可复用和禁止恢复无条件 `candidatePool.slice(...)` 的静态回归。
- 涉及文件：renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.105 (2026-06-07)

- 优化：`content.js` 同源文章抓取批处理不再为每批 URL 先 `slice()` 再 `map()`，改为循环构造 promise 批次；跨域交后台日志摘要改为 `formatUrlSample()` 循环生成，减少扫描触发文章抓取时的临时数组分配。
- 验证：`tools/verify.js` 补同源 fetch 批次循环构造、禁止恢复 `same.slice(...).map(...)` 和跨域日志 `cross.slice(...).map(...)` 的静态回归。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.104 (2026-06-07)

- 优化：`loader.js` 诊断摘要的 host timing 样本从溢出后逐条 `samples.shift()` 改为固定 80 条环形覆盖，减少图片完成诊断高频写入时的数组搬移。
- 验证：`tools/verify.js` 补 host timing sample ring offset、覆盖写入和禁止恢复 `stats.samples.shift()` 的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.103 (2026-06-07)

- 优化：`popup.js` 日志索引写入、storage 发现和读取合并改用 `appendUniqueKeys()` 单次追加去重，不再为 content log key 和 indexed log key 先构造 `filter()` / `concat()` 中间数组。
- 验证：`tools/verify.js` 补日志索引单次追加去重、禁止恢复 `uniqueKeys(...).filter(...)`、`keys.filter(...)` 和 `LOG_KEYS.concat(indexed.filter(...))` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.102 (2026-06-07)

- 优化：`popup.js` 日志过滤默认 all 且无搜索词时直接复用原日志数组，不再每次 `logs.filter()` 复制；最新 session id 只在 session 筛选时计算，其它筛选改为单次循环收集匹配项。
- 验证：`tools/verify.js` 补默认日志视图复用原数组、session id 懒计算、单次循环过滤和禁止恢复 `return logs.filter(...)` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.101 (2026-06-07)

- 优化：`shared-utils.js` 的 `cacheIndex` 串行写队列不再每次 `_drain()` 都 `shift()`；改为 `_queueOffset` 游标读取下一项，队列消费完后一次性清空并重置 offset，减少缓存索引写入积压时的数组搬移。
- 验证：`tools/verify.js` 补 cacheIndex 队列 offset 消费、禁止恢复逐项 `shift()` 和消费完重置队列的静态回归。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.100 (2026-06-07)

- 优化：`popup.js` 读取日志内容前剔除 stale log key 时不再用 `logKeys.filter(... staleLogKeys.indexOf(...))`，改为构建 pruned key map 后单次生成 live key 列表，减少日志面板 prune 后读取阶段的线性查找。
- 验证：`tools/verify.js` 补 prune 后 stale key map、live key 单次重建和禁止恢复 `logKeys.filter(...indexOf...)` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.99 (2026-06-07)

- 优化：`popup.js` content 日志索引裁剪不再链式 `filter()` 并对每个 key 执行 `stale.indexOf()`；改为构建 stale key map 后单次循环保留仍有效的 content 日志 key，减少日志面板读取/裁剪时的扫描和线性查找。
- 验证：`tools/verify.js` 补 stale map、单次保留循环、禁止恢复线性 `stale.indexOf()` 和链式 filter 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.98 (2026-06-07)

- 优化：`shared-utils.js` 协议资源链接提取不再先收集清洗结果再 `filter(Boolean)`；改为清洗后非空才入数组，减少资源/TXT 扫描中的一次数组遍历和中间数组分配。
- 验证：`tools/verify.js` 补协议链接提取非空入队和禁止恢复 `return links.filter(Boolean)` 的静态回归。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.97 (2026-06-07)

- 优化：`loader.js` 后台队列调度不再对每个检查项执行 `BG_TASKS.shift()`；改为 `bgReadIndex` 游标读取当前轮原始队列前缀，延期任务继续 `push()` 到队尾，循环结束后一次性裁剪已检查前缀，减少后台调度中的数组搬移。
- 验证：`tools/verify.js` 补后台队列游标消费、一次性裁剪和禁止恢复逐项 `BG_TASKS.shift()` 的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.96 (2026-06-07)

- 优化：`viewport-observer.js` 重图恢复队列消费不再对每个恢复项执行 `shift()`，也不在 lane 限制时 `unshift()` 放回；改为游标读取队列，循环后一次性裁剪已消费前缀，减少恢复批处理中的数组搬移。
- 验证：`tools/verify.js` 补重图恢复队列游标消费、一次性裁剪和禁止恢复 `shift()/unshift()` 的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.95 (2026-06-07)

- 优化：`viewport-observer.js` 重图恢复队列清理不再用 `filter()` 重建数组，改为读写索引原地压缩有效 wrapper；单个 wrapper 出队也改为 `indexOf()` + `splice()`，减少恢复批处理和卸载路径上的队列分配。
- 验证：`tools/verify.js` 补重图恢复队列原地压缩、禁止恢复 `heavyRestoreQueue = heavyRestoreQueue.filter(...)` 和单项移除不重建队列的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.94 (2026-06-07)

- 优化：`viewport-observer.js` 重图渲染预算选择不再用 `filter().sort()` 生成 in-range 候选中间数组链，改为单次循环收集候选后排序，减少滚动预算调和时的短时分配。
- 验证：`tools/verify.js` 补 heavy render budget 候选单次收集和禁止恢复 `filter()` 结果再排序的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.93 (2026-06-07)

- 优化：`viewport-observer.js` 可见重图预览恢复路径不再用 `filter().sort()` 生成 stuck 预览中间数组链，改为单次循环收集 stuck 候选后排序，减少滚动预算调和时的短时分配。
- 验证：`tools/verify.js` 补 stuck visible preview 单次候选收集和禁止恢复 `filter()` 结果再排序的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.92 (2026-06-07)

- 优化：loader 首屏 round-robin 调度复用 `getActiveFirstThreadIds()` 收集活跃线程，调度循环中遇到失效线程改为原地 `splice()` 移除，避免循环内反复 `filter()` 分配新的线程 id 数组；调度快照和 schedule 诊断复用同一收集 helper。
- 验证：`tools/verify.js` 补活跃首屏线程收集集中化、round-robin 原地移除和禁止恢复循环内 `filter()` 的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.91 (2026-06-07)

- 优化：`viewport-observer.js` 可见重图压力释放路径不再用 `filter().forEach().filter().sort()` 连续分配中间数组，改为单次循环完成稳定可见锁定和卸载候选收集后再排序，减少滚动中重图预算调和的短时分配。
- 验证：`tools/verify.js` 补可见压力候选单次收集、保留 restore settle 保护和禁止恢复 `visibleItems` 中间数组的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.90 (2026-06-07)

- 优化：renderer 初始化候选数组时不再为重图帖子额外创建未使用的 `displayCandidates` 数组；无历史成功 URL 时 `prioritizeLoadedCandidates()` 直接复用候选池，减少帖子渲染初始化阶段的数组复制。
- 验证：`tools/verify.js` 补候选池无历史命中不复制、普通帖仍按显示上限切片、禁止恢复独立 `displayCandidates` 分配的静态回归。
- 涉及文件：renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.89 (2026-06-07)

- 优化：popup 日志导出摘要改为 `buildLogSummaryStats()` 单次遍历同时统计事件、host 和级别，避免导出前为三个摘要维度分别重复扫描日志和读取结构化字段。
- 验证：`tools/verify.js` 补摘要单次聚合、禁止恢复 `topCounts()` 多次扫描和复用预计算 counters 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.88 (2026-06-07)

- 优化：新增 `SharedUtils.forEachHrefValue()` 迭代式 href 扫描，并让 TXT 下载链接提取、资源链接提取和正则图片提取复用该路径，避免热路径先构造完整 href 数组。
- 验证：`tools/verify.js` 补 streaming href 迭代、资源/TXT 提取不回退 href 数组和正则图片 href 扫描的静态回归。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.87 (2026-06-07)

- 优化：`SharedUtils.extractResources()` 不再把正文文本和所有 `href` 值拼成一个大型 `scanText` 后再扫描；改为复用同一局部扫描 helper 分别处理正文和 href，减少长帖子或 TXT 附件资源提取时的大字符串分配和 GC 抖动。
- 验证：`tools/verify.js` 补资源扫描不再拼接全文与 href 列表的静态回归。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.86 (2026-06-07)

- 优化：popup 日志导出改为 `buildLogExportText()` 收集头部和日志行后一次性 `join`，避免导出较多日志时在循环里反复字符串追加。
- 验证：`tools/verify.js` 补导出文本集中构建、数组收集和禁止逐行 `text +=` 的静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.85 (2026-06-07)

- 修复：popup 日志刷新增加请求序号，较慢的旧日志读取返回时不再覆盖较新的搜索/过滤结果，避免快速输入或切换过滤器时显示过期日志。
- 优化：日志列表渲染改为集中循环拼接，避免 `map(renderLogEntry).join()` 产生额外中间数组。
- 验证：`tools/verify.js` 补日志异步序号、stale 结果忽略和批量渲染静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.84 (2026-06-07)

- 优化：popup 日志搜索输入改为 180ms debounce 后再读取 storage、过滤和渲染日志，避免连续输入时每个字符都触发一次日志读取、排序和 DOM 重绘；隐藏日志面板后已排队的刷新也会跳过。
- 验证：`tools/verify.js` 补日志搜索 debounce、集中调度和隐藏面板跳过刷新静态回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.83 (2026-06-07)

- 优化：`logScheduleState()` 现在把 active thread 扫描、队列计数、viewport pending stats 和重图渲染统计延迟到节流通过后再构造，避免频繁 `globalSchedule()` 调用在日志被 2 秒节流丢弃时仍重复做诊断聚合工作。
- 验证：`tools/verify.js` 补节流日志空事件跳过、schedule 诊断懒构造和无工作不写日志的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.82 (2026-06-07)

- 优化：重图渲染预算快照和恢复队列排序复用单次 viewport 几何快照，避免对同一 wrapper 连续读取范围、可见性、中心距离，以及在排序比较器里反复触发布局读取。
- 验证：`tools/verify.js` 补 viewport 几何快照、重图预算复用和恢复队列排序缓存的静态回归。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.81 (2026-06-07)

- 优化：列表页候选扫描在单次检测内缓存每个表格的 `separatorline` 查询，并先用标题文本判断服务帖，只有必要时才读取整行文本，减少滚动/Mutation 触发扫描时的重复 DOM 查询和大文本读取。
- 验证：`tools/verify.js` 补扫描器 separator 缓存、扫描上下文传递和标题优先判断的静态回归。
- 涉及文件：scanner.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.80 (2026-06-07)

- 修复：热重载和停用当前页面时，会在清空线程状态前先 flush 待写的图片 loaded URL 缓存，避免 `CACHE_FLUSH_PENDING` 还在但 `window.ATPState.threads` 已被清空导致本轮已加载 URL 丢失。
- 验证：`tools/verify.js` 补热重载清 DOM 前必须 flush pending cache、停用路径不得只清 cache timer 的静态回归。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.79 (2026-06-07)

- 优化：清理后台图片任务时会先 flush 当前聚合诊断摘要，避免热重载或停用页面后旧队列统计延迟写入并与新队列混在一起，同时同步清掉诊断摘要延迟 timer。
- 验证：`tools/verify.js` 补 `clearBgTasks()` 必须 flush 诊断摘要的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.78 (2026-06-07)

- 修复：缩略图 DOM 清理现在会同步关闭预览器，热重载或停用页面时会清理预览图片加载 timer、键盘监听和 `body` 滚动锁，避免预览器停留在旧线程状态。
- 验证：`tools/verify.js` 补缩略图清理必须关闭 previewer 的静态回归。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.77 (2026-06-07)

- 修复：页面卸载时 content cleanup 现在复用 `ATPLoader.removeGlobalVisListener()`，同步清理 loader 的 visibility listener、scroll listener 和 scroll idle timer，不再只手动移除单个 visibility listener。
- 验证：`tools/verify.js` 补卸载清理路径静态回归，禁止退回 `getVisListener()` 单点清理。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.76 (2026-06-07)

- 修复：预览器 `destroy()` 现在复用 `close()` 清理路径，销毁前会先清图片加载 timeout、递增加载 token、移除当前图片 `src` 并恢复 `body` 滚动状态，避免热重载或页面卸载时预览器打开导致 timer/overflow 残留。
- 验证：`tools/verify.js` 补 previewer 销毁路径复用 close 清理的静态回归。
- 涉及文件：previewer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.75 (2026-06-07)

- 修复：热重载缩略图时会同步清理 loader 的可见性监听、滚动监听和滚动 idle timer，避免旧 viewport 已销毁后仍有 loader 滚动回调残留；新线程注册时会按现有流程重新绑定。
- 验证：`tools/verify.js` 补热重载清理 loader 监听器的静态回归。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.74 (2026-06-07)

- 优化：隐藏页启用 `pauseWhenHidden` 暂停加载时，会同步清理已挂起的 background timeout/idle/retry timer，避免后台队列在暂停期间醒来空跑；恢复可见时仍由现有调度重新启动。
- 重构：background timer 清理集中到 `clearBackgroundTimers()`，公开 `clearBgTimer()` 复用同一路径。
- 验证：`tools/verify.js` 补隐藏页暂停清理 background timer 的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.73 (2026-06-07)

- 优化：当首屏或整帖完成触发 `flushCacheNow(threadId)` 后，如果没有其它待 flush 线程，会同步清理延迟 flush 定时器，避免 1 秒后再空跑一次缓存 flush。
- 验证：`tools/verify.js` 补缓存 flush 静态回归，确认即时单线程 flush 能检测空 pending 队列并清除 stale timer。
- 涉及文件：cache.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.72 (2026-06-07)

- 优化：图片成功加载后，线程内 `loadedUrls` 现在按规范化 preview URL 去重后再记录和触发缓存 flush，避免同一候选因重试/fallback 重复成功时造成状态数组膨胀和重复缓存写入。
- 验证：`tools/verify.js` 补 loader/renderer 静态回归，确认线程维护 loaded URL 去重表且成功路径按规范化 URL 去重。
- 涉及文件：renderer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.71 (2026-06-07)

- 优化：内容脚本批量处理帖子后，不再额外执行一次 `hasNearProcessCandidates()` 全页候选扫描；改用当前批次是否达到 `PROCESS_BATCH_LIMIT` 判断是否继续链式扫描，减少每批后的重复 DOM 查询。
- 验证：`tools/verify.js` 补扫描调度静态回归，防止批处理完成后重新引入额外全页扫描。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.70 (2026-06-07)

- 修复：读取旧文章缓存时会始终扫描并剔除 Discuz 临时 TXT 附件 URL，不再依赖旧 `hasTextAttachments` 状态，避免缓存归一化后这类临时入口被直接拿去解析而不是重新提取。
- 验证：`tools/verify.js` 补 fetcher 静态回归，禁止 Discuz TXT URL 清理条件退回到 `!cached.hasTextAttachments`。
- 涉及文件：fetcher.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.69 (2026-06-07)

- 修复：旧缓存 TXT 附件清洗后，`textAttachmentCount` 现在优先使用清洗后的附件数量，不再沿用过期计数；无附件且计数为 0 的脏 `hasTextAttachments` marker 会被清除。
- 验证：`tools/verify.js` 补脏计数覆盖和零计数 marker 清理回归，防止资源面板显示错误 TXT 数量或无依据重提取入口。
- 涉及文件：cache.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.68 (2026-06-07)

- 修复：文章缓存归一化清洗 TXT 附件后，会同步重算 `hasTextAttachments` 和 `textAttachmentCount`；当旧缓存只剩脏附件时清空状态和计数，保留 Discuz 需重提取的无 URL 标记语义。
- 验证：`tools/verify.js` 补 TXT 附件状态/计数行为回归和静态规则，覆盖有效附件自动保持可解析状态、脏附件清零、Discuz marker 保留。
- 涉及文件：cache.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.67 (2026-06-07)

- 修复：文章缓存归一化现在会清洗旧缓存里的 TXT 附件数组，过滤空 URL、非 http(s) 协议和重复附件，补齐安全默认 source/name，并按共享上限截断，避免脏附件继续进入 TXT 解析链路。
- 验证：`tools/verify.js` 补 `ATPCache.normalizeArticleData()` 行为回归和静态规则，覆盖脏 TXT 附件过滤、去重、名称清理、无效 pageUrl 丢弃和数量上限。
- 涉及文件：cache.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.66 (2026-06-07)

- 重构：`SharedUtils.hasResourcePayload()` 只统计已归一化后的资源组和密码，不再调用 `countResources()` 触发二次归一化，减少资源面板、renderer 和 loader 频繁判断时的重复清洗开销。
- 验证：`tools/verify.js` 补静态回归，防止 payload 判断退回二次归一化实现。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.65 (2026-06-07)

- 修复：密码归一化显式过滤中文无效占位（如“无”“无密码”“暂无”“见图”“看图”“见截图”），避免依赖乱码兼容正则导致旧缓存或异常来源中的 password-only 占位漏判。
- 验证：`tools/verify.js` 补 Unicode 中文占位过滤回归，同时确认真实密码值不会被误删。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.64 (2026-06-07)

- 修复：background 侧 TXT 附件中转页结果和最终缓存写入统一使用 `SharedUtils.hasResourcePayload()`，避免无效密码占位绕过归一化后仍被当作有效 password-only 资源缓存。
- 验证：`tools/verify.js` 补 background TXT payload 判断静态回归，禁止回退到原始 `passwords.length` 判断。
- 涉及文件：background.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.63 (2026-05-26)

- 修复：资源归一化会过滤旧缓存或异常来源中的无效密码占位（如“无”“无密码”“[emailprotected]”）和重复密码，避免旧 password-only 缓存被误判为有效资源但复制为空。
- 验证：`tools/verify.js` 补脏密码列表归一化和无效 password-only payload 不成立的行为回归。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.62 (2026-05-26)

- 修复：图片加载线程完成、重图 stop-loss 完成等路径写回完整缓存时，也会把 password-only 资源视为有效结果，避免仅密码资源在 loader 收尾阶段按“无资源”处理。
- 验证：`tools/verify.js` 补 loader 不再使用链接专用 `hasResources(ts.resources)` 判断线程完成缓存写回的静态回归。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.61 (2026-05-26)

- 修复：当“复制时附带密码”关闭且资源结果只有解压密码时，“复制密码”按钮不再走“复制全部”路径，避免复制空内容。
- 调整：资源面板将显式“复制密码”和“复制全部”拆分语义；前者始终复制有效密码，后者继续尊重“复制时附带密码”设置。
- 验证：`tools/verify.js` 补专用 password-only 复制路径和强制复制密码语义检查。
- 涉及文件：resource-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.60 (2026-05-26)

- 修复：TXT 附件只解析到解压密码、没有网盘/磁力/ED2K 链接时，现在会被视为有效资源结果，不再显示“未解析到资源链接”或保持可重试失败状态。
- 修复：资源面板和帖子内联资源栏支持 password-only 结果展示，并提供“复制密码”入口。
- 验证：`tools/verify.js` 补 password-only 资源有效性、渲染状态和资源面板复制入口的静态回归。
- 涉及文件：shared-utils.js、renderer.js、resource-panel.js、content.js、fetcher.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.59 (2026-05-26)

- 修复：content logger 维护 `atp_logs_content_keys` 时会过滤非字符串、索引 key 本身和不符合 `atp_logs_content_<timestamp>` 形态的脏值，避免旧污染索引在 `Logger.flush()` 时因 `key.indexOf` 抛错或被继续写回。
- 验证：`tools/verify.js` 补 content logger VM 脏索引回归，覆盖 `atp_logs_content_keys`、`null`、数字和非日志 key 不会进入新索引，当前日志 key 仍会保留。
- 涉及文件：logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.58 (2026-05-26)

- 修复：popup 读取脏日志索引时会忽略 `null`、数字等非字符串 key，避免 `getLogKeysForRead(false)` 因 `key.indexOf` 抛错导致日志面板读取失败。
- 验证：`tools/verify.js` 的 popup 脏日志索引回归新增 `null` 和数字条目，覆盖索引污染不会打断日志读取。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.57 (2026-05-26)

- 修复：popup 发现日志 key 时不再把 `atp_logs_content_keys` 索引本身当作日志 key，避免索引被写回索引、日志面板/导出混入空白条目和计数偏高。
- 修复：popup 读取日志数组时只合并对象 entry，脏索引或异常数组中的字符串/null 不再进入日志列表。
- 文档：`CLAUDE.md` 明确 `.claude/skills/` 只用于本地 Claude workflow，不再建议把仓库可复用 workflow 放进已忽略目录。
- 验证：`tools/verify.js` 补 popup 脏日志索引回归测试，并检查 `CLAUDE.md` 不再指向已忽略的仓库 workflow 目录。
- 涉及文件：popup.js、tools/verify.js、CLAUDE.md、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.56 (2026-05-26)

- 修复：日志对象 key 也会做 URL 脱敏，content/background 入库和 popup 旧日志导出不再保留 `{ "https://x/a.jpg?secret=...#h": 1 }` 这类 key 中的 query/hash。
- 兼容：对象值仍按原字段名判断 URL 类字段，避免 key 脱敏影响 `url`、`src`、`href` 等字段值处理；脱敏后 key 碰撞时会加短数字后缀，避免覆盖诊断字段。
- 验证：`tools/verify.js` 补 content/background 对象 key、嵌套对象 key、popup 旧 `fields` 和旧 JSON `data` 对象 key 的脱敏回归。
- 涉及文件：logger.js、background.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.55 (2026-05-26)

- 修复：content/background 普通字符串日志入库前也会脱敏协议相对 URL 和裸域名 URL，`//cdn.example/a.jpg?token=...`、`img.example/a.jpg?token=...`、`example.com?token=...` 不再把 query/hash 写入 `chrome.storage.local` 或控制台日志。
- 验证：`tools/verify.js` 补 content/background 普通字符串日志中 `https://`、`//`、裸域名路径和裸域名根路径的 query/hash 脱敏回归。
- 涉及文件：logger.js、background.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.54 (2026-05-26)

- 修复：popup 导出日志的头部摘要也会对旧日志做 URL 脱敏，避免事件统计、Host 统计、等级统计等摘要项重新带出 query/hash。
- 修复：popup 导出行和查看行的 `src`、`lv`、`type`、`sessionId`、`pageHost` 等旧日志元字段增加二次脱敏兜底，按不信任 storage 内容处理。
- 验证：`tools/verify.js` 补完整导出摘要、pageHost、session、type、src、level 等旧日志元字段的 query/hash 脱敏回归。
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.53 (2026-05-26)

- 修复：popup 日志查看和导出增加二次 URL 脱敏，旧日志中的 `fields`、JSON `data`、普通文本和消息里的 query/hash 不再原样导出。
- 修复：background logger 归一化结构化字段时增加循环引用保护，循环对象会保留已脱敏字段和 `[Circular]` 标记，不再降级成 `[object Object]` 丢失诊断上下文。
- 验证：`tools/verify.js` 新增 popup 旧日志导出脱敏行为测试，并补 background 循环对象 URL 脱敏和 `[Circular]` 标记检查。
- 涉及文件：popup.js、background.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.52 (2026-05-26)

- 修复：content logger 归一化结构化字段时增加循环引用保护，`Logger.debug/info/warn/error` 遇到循环对象会写入安全标记，不再因 `RangeError: Maximum call stack size exceeded` 打断业务路径。
- 验证：`tools/verify.js` 的 content 日志脱敏回归新增循环对象样例，确保循环对象中的 URL 字段仍会脱敏。
- 验证：新增 background logger VM sandbox，真实执行 `BGLOG` 并写入 `atp_logs_bg`，覆盖 object/string 中的 query/hash、空 URL、无协议 URL 和嵌套 URL 脱敏。
- 涉及文件：logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.51 (2026-05-26)

- 修复：`Logger.sanitizeUrl('')`、`undefined`、`null` 不再解析成当前页面 URL，避免空 `url/src/href` 字段误记为页面地址。
- 修复：无协议或非法 URL 日志字段不再借当前页面补全，只裁剪 query/hash 后保留原始路径形态，避免诊断误导。
- 文档：更新 `使用说明.md` 的本版更新说明，补齐 1.14.50/1.14.51 的结构化、嵌套、数组和普通文本 URL 脱敏说明。
- 验证：`tools/verify.js` 补空 URL、`undefined`、`null`、无协议 URL、非法 URL 的脱敏回归检查。
- 涉及文件：logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.50 (2026-05-26)

- 修复：content 日志结构化字段按 `url`、`pageUrl`、`link`、`src`、`href`、`referrer` 等 URL 类 key 统一去除 query/hash，避免 `image_done`、`fallback_pick`、`thread_registered` 等诊断字段继续暴露签名参数。
- 修复：content 普通字符串日志和 object fallback `data` 入库前也会扫描并脱敏内嵌 URL，避免 popup 导出从 `data` 字段漏出访问参数。
- 修复：background 日志入库前统一脱敏，并将 TXT 附件和文章抓取日志中的原始 URL 截断改为使用脱敏 URL。
- 验证：`tools/verify.js` 新增带 query/hash 的结构化字段、嵌套字段、数组字段和纯字符串日志脱敏回归检查。
- 涉及文件：logger.js、background.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.49 (2026-05-26)

- 修复：将 `.claude/`、`.opencode/`、`.codex/` 纳入忽略，并让验证脚本阻止 `.agents/`、`.claude/`、`.opencode/`、`.codex/` 被 Git 跟踪，降低本地工具配置误发布风险。
- 修复：`settings` 读取 storage 失败时改为安全停用，不再回退到默认启用，避免异常状态下继续自动处理页面。
- 修复：停用当前页时先显式 flush content 日志，再停止 flush timer，减少禁用操作前的诊断日志丢失。
- 增强：content/background 日志按字节预算裁剪，content 单 key 约 160KB、总量约 2MB，background 约 512KB；storage 写入失败时先裁旧日志并重试一次。
- 隐私：content 日志页 URL 和普通 debug/warn URL 去除 query/hash 并限制长度，popup 导出保持结构化字段兼容但减少敏感 URL 暴露。
- 涉及文件：.gitignore、shared-utils.js、logger.js、background.js、config.js、content.js、fetcher.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.48 (2026-05-25)

- 优化：根据 `image.imx.to` 慢图日志调整轻量缩略全重图 stop-loss；单图 stop-loss 超时从 1.8 秒放宽到 3.5 秒，仍保持低并发和短候选链，减少可用慢图被过早判失败。
- 优化：stop-loss 下的全重图首屏/手动重试仍只保留 2 次 fallback，但第二次允许使用既有深度跳跃采样探到候选池后段，避免 70+、100+ 候选只消耗前段坏/慢链。
- 增强：日志新增 `heavyStopLossDeepRescue`、`heavyStopLossDeepRescueEligible` 和 `maxHeavyStopLossDeepRescuePickedIndex`，用于确认 stop-loss 下是否命中后段探针。
- 保持：不提高全局并发，不改变普通图/弱图通道、资源提取、manifest 权限或设置项。
- 涉及文件：loader.js、logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.47 (2026-05-25)

- 优化：轻量缩略重图的近屏预热距离改为自适应，使用 `max(2400px, 4 * viewport height)`，让后台重图更早进入预热范围；普通图床和弱图床仍保持原 viewport 懒加载边界。
- 增强：viewport 和调度诊断新增 `pendingCreatedDistancePx`、`pendingCurrentDistancePx`、`preloadMissReason`、`pendingAgeByQueueKind`、预热注册/触发计数和自适应预热距离，便于判断 pending 拖尾是距离过远、未进预热范围、进范围无槽位，还是滚动后才触发。
- 保持：不提高全局并发，不改变普通图/弱图加载通道，不调整 host 冷却、stop-loss、fallback 或资源提取策略。
- 涉及文件：viewport-observer.js、loader.js、logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md、HANDOFF.md
- Breaking change：无

## 1.14.46 (2026-05-25)

- 文档：新增 `HANDOFF.md`，整理当前稳定基线、核心文件职责、今天围绕轻量缩略重图做过的优化、日志诊断字段、后续优化方向和交接注意事项，方便后续维护者快速接手。
- 保持：本版不改变图片加载、资源提取、渲染、并发、缓存、日志写入或设置项行为；当前功能逻辑沿用 1.14.45。
- 涉及文件：HANDOFF.md、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.45 (2026-05-25)

- 优化：轻量缩略重图新增独立近屏预热观察器，后台重图不再只等进入原 200px 懒加载边界才启动；预热只作用于“重图优化 + 轻量缩略 + 重图后台任务”，普通图床和弱图床仍保持原懒加载边界。
- 调整：轻量缩略重图在普通图仍有工作时，不再把高扇出重图通道硬压到 1，而是软保护到最多 3 路；普通图并发上限、总后台并发和重图 host 冷却降速仍继续生效。
- 增强：调度和 viewport 日志新增近屏预热、pending 年龄、stale pending、软保护命中等字段；popup 导出优先使用结构化 `fields`，减少 800 字符 `data` 截断导致的诊断缺失。
- 涉及文件：loader.js、viewport-observer.js、logger.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.44 (2026-05-25)

- 修复：轻量缩略模式下，后台重图任务如果在后台队列或 viewport pending 中等待超过 60 秒，真正开始加载时会进入 `stale_background` 快失败路径；单张超时收紧到 6 秒，并且不再额外尝试第二张高扇出重图 fallback，避免翻页或快速滚动后老任务集中占用重图通道十几秒。
- 增强：图片调度日志新增 `heavyStaleBackground`、`heavyStaleWaitMs`、`heavyStaleThresholdMs`、`heavyStaleTimeout`，`diagnostic_summary` 汇总 `heavyStaleBackground` 和 `maxHeavyStaleWaitMs`，方便继续判断加载慢是图床慢、队列堆积，还是过期 viewport 任务拖尾。
- 保持：普通图床、弱图床、首屏重图、均衡模式和手动重试不走这条过期后台快失败逻辑。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.43 (2026-05-25)

- 修复：诊断日志时间不再把 UTC 去掉 `Z` 后伪装成本地时间；content/background 新日志的 `ts` 改为本地时间，同时保留 `tsUtc`、`timezoneOffsetMinutes` 和 `timezone`，导出文件头也会同时显示本地时间、UTC 和时区。
- 修复：全重图轻量缩略页在 `image.imx.to` 这类高扇出 host 已冷却且首屏全失败时，后台补齐不再继续排队逐个验证坏链；线程会快速标记剩余重图为失败并释放后续通道，减少翻页时长期条纹占位和后台队列拖长。
- 增强：后台止损会记录 `heavy_bg_stop_loss`、`bgStopLossSkipped` 和 host 冷却字段，方便下一轮日志直接确认是否命中“全坏重图后台止损”。
- 涉及文件：logger.js、background.js、popup.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.42 (2026-05-24)

- 优化：在“重图优化 + 轻量缩略 + 全重图候选 + host 已冷却”的坏链密集场景下新增止损路径；当线程已有失败证据或该重图 host 失败数很高时，首屏/手动重试不再继续做 6 次深度救援，而是收敛为 2 次候选尝试并使用更短超时，减少全坏帖长时间占位和阻塞后续重图通道。
- 保持：普通图床、弱图床、混合帖中的普通候选优先、轻量缩略后台单槽补齐策略不变；本次止损只作用于冷却中的高扇出重图 host。
- 增强：图片调度日志新增 `heavyStopLoss`、`heavyStopLossLimit`、`heavyStopLossTimeout`、`timeoutMs` 和 `coolingTimeoutMode`，`diagnostic_summary` 统计止损触发次数，方便继续区分是坏链密集、host 冷却还是队列约束。
- 涉及文件：loader.js、logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.41 (2026-05-24)

- 增强：修复 fallback 明细日志被字段上限截断的问题。`pickedIndex`、`heavyDeepRescue`、`rescueStrategy`、`rescueAttempt`、`rescueSpan`、`heavyHostCooling`、`fallbackLimit` 等关键字段现在会优先保留，下一轮可以直接判断每个槽位是否跳到候选池后半段。
- 增强：content 日志字段上限从 45 提高到 80，并增加重图救援/host 冷却字段优先级，避免普通线程状态字段挤掉真正用于调优的 fallback 诊断。
- 保持：本版不改变普图、弱图、重图并发、候选救援次数和轻量缩略加载策略，只强化诊断可信度。
- 涉及文件：logger.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.40 (2026-05-24)

- 修复：全重图轻量缩略页在 `image.imx.to` 前段坏链密集时，冷却态救援不再只按顺序扫前几十张；首屏和手动重试会在原有受控次数内做跳跃采样，覆盖候选池后半段，减少 `0/10`、`2/10` 这类可用候选很多但过早失败的占位。
- 保持：轻量缩略后台补齐仍保持单槽 1 次保守救援；普通图床、弱图和混合帖的普通候选优先逻辑不变。
- 增强：fallback 日志新增 `heavyDeepRescue`、`rescueStrategy`、`rescueAttempt`、`rescueSpan`、`rescueStartIndex` 和 `sequentialFallbackIdx`；`diagnostic_summary` 新增深度救援次数和最深采样 index，方便判断是否扫到候选后半段。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.39 (2026-05-24)

- 修复：全重图轻量缩略页遇到 `image.imx.to` 坏链密集时，不再让首屏槽位只尝试 2 次救援后过早落成失败占位；当重图 host 已进入冷却且没有普通图床候选可替换时，首屏和手动重试可在受控上限内继续从后续重图候选里找可用图。
- 修复：重图 host 健康度现在会在单个候选失败、准备切换 fallback 候选时立即计数，而不是等整个缩略图槽位最终失败后才计数；这样坏链密集时能更早进入冷却和扩展救援。
- 保持：轻量缩略后台补齐仍维持单槽 1 次重图救援，普通图床和混合普通候选逻辑不变，避免后台重新把慢重图 host 打满。
- 增强：fallback 日志新增 `heavyCoolingRescue`，可直接确认本次救援次数是否来自重图 host 冷却后的扩展候选搜索。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.38 (2026-05-24)

- 优化：新增重图 host 健康度降速。`image.imx.to` 等高扇出重图 host 连续失败达到阈值后，不再继续按最高重图并发打满通道，而是在短冷却窗口内把有效重图通道降到小额并发；普通图床通道不受影响，手动重试仍可执行。
- 增强：图片调度、失败明细和 `diagnostic_summary` 补充 `heavyHostCooling`、`heavyHostLimited`、`heavyHostLimit`、`heavyHostFailures`、`heavyHostCooldownRemainingMs` 和 `maxHeavyHostCooldownRemainingMs`，方便下一轮判断是图床失败、重图 host 冷却，还是普通队列/viewport pending 堆积。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.37 (2026-05-24)

- 增强：失败图片日志补充任务年龄、排队等待、队列来源、fallback 次数/上限、线程加载状态、首屏/后台队列、viewport pending、重图通道和滚动延迟快照，便于判断是图床失败、队列堆积还是视口懒加载延后。
- 增强：viewport 懒加载失败/成功日志补充 `pendingAgeMs`、`pendingCountAtLoad`、`inViewport`、`forceLoadWhenHidden`、`slotRetries` 和可见性状态，方便确认快速滚动时图片是否离屏后才失败。
- 增强：`diagnostic_summary` 纳入 throttled 的 `schedule_state` / 滚动延迟事件，并汇总 `maxViewportPending`、`maxBgHeavyQueue`、`maxHeavyQueue`、`maxOrdinaryQueue` 等队列峰值。
- 涉及文件：loader.js、viewport-observer.js、renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.36 (2026-05-24)

- 优化：轻量缩略后台补齐的单槽重图救援从 2 次收紧为 1 次，坏链最长等待从约 24 秒降到约 16 秒；首批一行、均衡模式、普通图和手动重试仍保持原救援策略。
- 增强：`fallback_pick` / `fallback_skip` 日志补充 `lightweightHeavyMode` 和 `backgroundBatch`，便于区分轻量缩略后台坏链与普通失败。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.35 (2026-05-24)

- 优化：轻量缩略模式继续按普通图/弱图显示数量展示，但首批重图网络请求改为只启动一行，后续按行分批补齐，避免从 5 张直接扩到 10 张时把 `image.imx.to` 慢响应和失败一次性放大。
- 增强：线程注册日志补充 `lightweightHeavyMode`、`firstScreenTotal` 和 `stagedTotal`；轻量缩略后台补齐会记录 `lightweight_bg_batch` 调度快照，便于继续判断速度是否被分批策略限制。
- 保持：均衡模式和恢复原始预设仍走旧的一行代表图逻辑；轻量缩略 canvas 长边仍为 160px。
- 涉及文件：renderer.js、loader.js、settings-schema.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.34 (2026-05-24)

- 调整：重图优化开启且“重图缩略清晰度”为“轻量缩略”时，重图显示数量改为按普通图/弱图的列数、可见行数和显示上限展示。
- 保持：“均衡”模式继续沿用旧的一行重图代表图逻辑；“恢复原始预设”仍恢复为“均衡”，因此也回到旧的一行重图逻辑。
- 优化：轻量缩略 canvas 长边从 128px 提高到 160px，降低与普通图/弱图缩略图之间一眼可见的清晰度差距。
- 增强：日志摘要保留 `heavyLightweightPreviewMaxEdge`，验证脚本补充轻量/均衡显示数量和设置重载的回归检查。
- 涉及文件：renderer.js、viewport-observer.js、settings-schema.js、content.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.33 (2026-05-24)

- 调整：将“重图缩略清晰度”的第二档从“模糊优先”改为“轻量缩略”，默认仍为“均衡”。
- 优化：轻量缩略模式改用固定 128px 长边 canvas 缩略图，并移除强毛玻璃 blur 样式，让列表图保持“降细节缩略图”而不是大面积模糊。
- 兼容：旧版已保存的 `heavyThumbnailClarity: "blurred"` 会自动迁移为 `lightweight`；日志继续记录 `heavyThumbnailClarity`，并新增 `heavyLightweightPreviewMaxEdge`。
- 涉及文件：settings-schema.js、defaults.js、viewport-observer.js、content.css、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.32 (2026-05-24)

- 新增：重图优化下新增“重图缩略清晰度”，支持“均衡”和“模糊优先”两档。
- 说明：“均衡”保持 1.14.31 的清晰/毛玻璃预算恢复逻辑；“模糊优先”会在重图加载完成后保留毛玻璃缩略图，不再进入恢复清晰队列，点击缩略图仍打开原图预览。
- 增强：popup 和页面悬浮面板的“恢复原始预设”同步恢复为“均衡”，设置变更会即时应用到当前页面，并在重图渲染日志中记录 `heavyThumbnailClarity`。
- 涉及文件：settings-schema.js、viewport-observer.js、content.js、popup.js、floating-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.31 (2026-05-24)

- 新增：将“毛玻璃到清晰图”的重图恢复批量做成可配置项；低压恢复批量默认 2、范围 1-6，高压/兜底恢复批量默认 1、范围 1-4。
- 调整：重图兜底等待可测下限从 4 秒放宽到 1 秒，重图兜底上限可测范围从 820-1220MP 放宽到 820-2000MP。
- 增强：popup 和页面悬浮面板在“重图优化”旁新增“恢复原始预设”按钮，只重置重图相关调优参数，不影响普通图并发、后台速度和其他设置。
- 增强：恢复批次日志补充可配置的 `restoreFastBatchSize` / `restorePressureBatchSize`，便于判断当前清晰恢复速度是否受设置限制。
- 涉及文件：settings-schema.js、viewport-observer.js、popup.js、popup.css、floating-panel.js、floating-panel.css、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.30 (2026-05-24)

- 新增：将重图毛玻璃饥饿兜底的可见区 MP 上限做成设置项“重图兜底上限”，默认 820MP，可在 820-1220MP 内输入测试。
- 说明：该设置依赖“重图优化”，只影响 `visible_preview_starvation_grace` 单张兜底恢复；普通图和弱图页面不走这套重图恢复逻辑。
- 涉及文件：settings-schema.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.29 (2026-05-24)

- 新增：将重图毛玻璃 `visible_preview_starvation_grace` 饥饿兜底等待做成设置项“重图兜底等待”，默认 8 秒，可在 4-24 秒内输入测试。
- 调整：饥饿兜底不再固定等到 16 秒；配置时间到期后，如果普通/迟到兜底仍装不下漏网图，且当前没有重图正在恢复，可单张走约 820MP 上限。
- 说明：该设置依赖“重图优化”，关闭重图优化时 UI 会禁用；普通图/弱图页面不走重图毛玻璃恢复逻辑。
- 涉及文件：settings-schema.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.28 (2026-05-24)

- 调整：根据 1.14.27 实测反馈，将 `visible_preview_starvation_grace` 饥饿兜底等待从约 24 秒提前到约 16 秒。
- 说明：仍保持单张、无并行恢复限制；到达最后兜底窗口后，如果 680MP 上限仍装不下漏网图，才允许在约 820MP 上限内恢复。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.27 (2026-05-24)

- 优化：继续处理 1.14.26 后仍有少数可见毛玻璃长期残留的问题；新增更靠后的 `visible_preview_starvation_grace` 饥饿兜底。
- 调整：可见毛玻璃等待约 24 秒以上、且当前没有重图正在恢复时，允许单张图片在约 820MP 上限内恢复，避免固定 680MP 上限下少数图片一直卡住。
- 增强：诊断摘要新增 `visiblePreviewStarvation`，popup 图片日志过滤纳入 `content_start`，下一轮可更容易确认浏览器实际加载的扩展版本。
- 涉及文件：viewport-observer.js、loader.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.26 (2026-05-24)

- 优化：根据 1.14.25 日志继续减少少数长期毛玻璃残留；日志显示可见清晰量约 462MP、单图约 50.3MP，原 500MP 迟到兜底会被 512MP 投影卡住。
- 调整：迟到兜底改为分级上限，等待约 8 秒后允许到约 560MP，等待约 16 秒后允许 `visible_preview_last_chance` 到约 680MP；仍不启用可见清晰图轮换卸载。
- 增强：诊断摘要新增 `visiblePreviewLastChance`，用于确认最后兜底是否触发，以及是否还有更高 MP 的残留场景。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.25 (2026-05-24)

- 优化：继续处理 1.14.24 后满屏重图里少数长期毛玻璃残留；普通稳定 grace 仍保持保守，但可见毛玻璃等待超过约 8 秒后允许走 `visible_preview_late_grace`。
- 调整：迟到兜底 grace 的可见区上限约 500MP，仍不恢复“轮换卸载可见清晰图”的旧逻辑，避免为了补一张毛玻璃又把已经清晰的图打回模糊。
- 增强：诊断摘要新增 `visiblePreviewLateGrace`，并记录迟到兜底的等待时间和 MP 上限，方便继续判断漏网残留是预算仍不足还是图床/恢复失败。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.24 (2026-05-24)

- 修复：满屏重图时不再通过 `visible_preview_rotate_unload` 主动卸载当前可见清晰图来给其他毛玻璃占位腾预算，避免清晰图和毛玻璃在同一屏内反复来回闪。
- 优化：可见毛玻璃等待超过约 2.8 秒后改走受控的稳定 grace 恢复，允许在约 320MP 的上限内小幅超出普通可见预算，让新图逐步恢复，同时保住已经清晰的可见图。
- 增强：诊断摘要新增 `visiblePreviewStableGrace`，并保留 `visiblePreviewStuck`，方便后续区分“稳定超额恢复”与“仍被预算挡住”。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.23 (2026-05-24)

- 修复：全重图帖子中首批 `image.imx.to` 候选失败后不再直接显示 0/5 失败；若整帖没有普通图床候选，会在每个槽位内少量尝试后续重图候选作为救援补位。
- 优化：仍然优先选择普通图床候选补位；只有不存在普通候选时才允许高扇出重图补位，并将每个槽位的重图补位次数限制为 2，避免单个失败槽位长期占用重图通道。
- 增强：补充 `fallback_miss` / `fallback_skip` 诊断，并让 popup 图片日志过滤包含全部 `fallback_` 事件，便于继续判断是候选耗尽、槽位压力，还是图床本身失败。
- 涉及文件：loader.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.22 (2026-05-24)

- 修复：重图从毛玻璃恢复为清晰图后增加短暂稳定窗口，避免 `restore_loaded` 后马上被可见区预算释放，形成“原图 → 毛玻璃 → 原图 → 毛玻璃”的横条式来回闪烁。
- 优化：可见区预算释放和可见毛玻璃轮换腾位都会跳过刚恢复完成、仍处于稳定窗口内的清晰图；稳定后继续交给原有 `visibleLocked` 逻辑保护。
- 增强：诊断摘要新增 `maxHeavyVisibleRestoreSettlingMP`、`maxHeavyVisibleRestoreSettling`，方便判断当前卡顿/闪烁是否来自恢复后短暂保留的可见清晰图。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.21 (2026-05-24)

- 修复：恢复中的重图在真正露出清晰图前不再计入 `heavyVisibleMP` / `heavyRangeMP` 清晰图预算，避免“还在毛玻璃恢复中”的图片一边隐藏、一边占住可见区预算，导致后续可见占位更难恢复。
- 增强：可见毛玻璃等待统计纳入 `restoreLoading` 状态，并在摘要中补充 `maxHeavyVisibleRestoringMP`、`maxHeavyRangeRestoringMP`，方便区分“预算挡住”与“恢复请求仍在加载”。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.20 (2026-05-24)

- 修复：继续处理“完成 5/5 后部分可见缩略图仍长期毛玻璃”的情况；可见占位等待过久时会按小批次轮换释放一张较远的清晰重图，为超时占位腾出恢复预算。
- 优化：轮换释放后会短暂 hold，避免刚释放的清晰图立即重新排队、把恢复空间又抢回去；每轮最多处理 1 张，降低清晰图互相抢预算造成的闪烁。
- 增强：诊断摘要新增 `visiblePreviewRotateUnloaded`、`visiblePreviewStuck`，并补充 `visible_preview_rotate_unload` / `visible_preview_rotate_hold` 原因，方便判断是否仍有可见占位饥饿。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.19 (2026-05-24)

- 修复：可见重图被预算挡住后不再只显示毛玻璃等待下一次滚动；占位进入视口后会计时并定期触发恢复重试，避免恢复队列清空后长期停在模糊状态。
- 优化：可见毛玻璃等待超过短窗口后允许小幅 MP grace 恢复；普通重图仍走原预算，超大图等待更久，尽量避免重新引入滚动解码卡顿。
- 增强：诊断摘要新增 `maxVisiblePreviewWaitMS`、`maxVisiblePreviewWaiting`、`visiblePreviewGrace`、`visiblePreviewDeferred`，并补充 `visible_preview_defer` / `visible_preview_grace` 原因，方便继续判断是预算阻塞还是图床网络慢。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.18 (2026-05-24)

- 调整：低压状态下“毛玻璃预览 → 清晰图”的恢复速度再提高一倍；保持每批最多 2 张不变，把低压恢复间隔从约 180ms 降到约 90ms。
- 说明：本版不放宽滚动中保护、不提高单批解码数量、不调整高压/超大图预算；目标是在不明显增加卡顿的前提下缩短清晰图等待时间。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.17 (2026-05-24)

- 优化：在保留 1.14.16 滚动低卡顿策略的基础上，加快低压状态下“毛玻璃预览 → 清晰图”的恢复速度；滚动停止且 MP 压力低时，每批最多恢复 2 张小/中图。
- 优化：低压恢复间隔缩短到约 180ms；一旦遇到超大图、接近软预算或硬预算，立即回到单张慢恢复，避免重新带来滚动解码峰值。
- 增强：恢复批次日志增加 `restorePressure: "fast"`、`restoreFastBatchSize`、`restoreFastMP`，方便判断清晰图恢复慢是因为仍在压力保护，还是图床网络本身慢。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.16 (2026-05-24)

- 优化：继续压重图可见区清晰图峰值；可见区预算从约 260MP 收紧到 180MP，恢复硬预算从 220MP 收紧到 150MP，软压力前移到 110MP/120MP，降低滚动时同时露出的全尺寸解码量。
- 优化：重图加载完成后先进入渲染预算和预览生成，再移除 loading、露出清晰图；如果预算立即释放，则直接保留模糊预览，避免全尺寸图先闪出来再被卸载。
- 优化：重图恢复队列在当前视口内优先恢复低 MP 图片，让同样预算下先恢复更多小图，超大图更容易保持模糊预览等待压力下降；模糊预览 wrapper 也可直接点击打开大图预览。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.15 (2026-05-24)

- 修复：viewport 懒加载不再在图片真正完成前移除 loading 占位，避免重图初次进入当前可见区时出现空白卡住，直到滚出范围才有模糊预览。
- 优化：重图初始加载、恢复等待、预算/滚动延迟恢复时会保持低压玻璃占位；已有 canvas 时显示模糊预览，没有 canvas 时使用稳定静态占位，减少“当前区域没有反馈”的感觉。
- 增强：重图渲染诊断补充 `previewReady`、`previewActive`、`previewFallbackActive`、`unloaded`、`restoreLoading`，`diagnostic_summary` 汇总 fallback 占位出现次数，便于继续判断卡顿来自网络等待还是渲染预算。
- 涉及文件：loader.js、viewport-observer.js、content.css、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.14 (2026-05-24)

- 优化：重图首次加载完成后会立即预生成隐藏的 40px 模糊 canvas 预览，再进入渲染预算判断，避免只有滚出当前范围并触发释放后才出现玻璃预览。
- 优化：重图恢复成功后同步刷新预览缓存，下次被预算释放或恢复被挡时可以直接显示模糊预览，减少“卡在当前区域等滚动触发”的感觉。
- 增强：重图渲染诊断补充 `heavyPreviewPrewarm` 和 `preview_prewarm`，便于确认预览是否在释放前已经准备好。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.13 (2026-05-24)

- 优化：重图页高频图片/渲染诊断改为 2 秒聚合摘要；`image_start`、成功的 `image_done`、`image_defer`、常规 `render_unload` / `render_restore` / `render_state` 不再逐条写入 storage，降低日志打满和 storage 写入压力。
- 增强：新增 `diagnostic_summary` 事件，汇总窗口内事件数、reason/host/channel、host 加载耗时、重图可见/范围 MP 峰值、unload/restore 队列峰值、`previewKept` 和恢复错误数；失败、fallback、retry 和 `render_restore_error` 仍保留明细。
- 增强：popup 图片日志过滤纳入 `diagnostic_summary`，方便导出后直接看每 2 秒窗口的重图峰值和图床表现。
- 涉及文件：loader.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.12 (2026-05-23)

- 优化：根据 1.14.11 日志继续压重图渲染峰值；可见区清晰重图预算从约 320MP 收紧到 260MP，恢复硬预算从约 240MP 收紧到 220MP，软压力档前移到 180MP，80MP+ 超大图恢复间隔提高到 900ms。
- 优化：重图预算释放改为小批次处理，每轮最多释放 4 张并在 120ms 后继续 reconcile，避免同一瞬间生成多张模糊 canvas 预览和批量释放 `src` 造成滚动顿挫。
- 增强：重图渲染日志补充 `heavyUnloadBatchSize` 和 `budgetFollowup`；content 单会话日志上限从 500 提到 800，降低重图页 20 多秒就截断关键上下文的概率。
- 涉及文件：viewport-observer.js、logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.11 (2026-05-23)

- 新增：重图释放 `src` 前会尽量生成 40px 级别的 canvas 低压预览层，释放后保留模糊缩略图，避免图片已完成但列表只剩灰色空框。
- 优化：重图恢复期间继续显示模糊预览，原图重新 `load` 后再切回清晰图，减少恢复过程中的闪烁感。
- 增强：`render_unload` 日志新增 `previewKept` 字段；恢复失败会记录 `render_restore_error`，并保持预览/占位状态不污染重图 MP 预算。
- 涉及文件：viewport-observer.js、content.css、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.10 (2026-05-23)

- 优化：根据 1.14.9 实测继续收紧重图近屏恢复预算；恢复范围硬预算从约 300MP 降到 240MP，避免一批已恢复重图在滚入视口时形成 250MP+ 可见区峰值。
- 优化：恢复范围软压力档从约 240MP 前移到 200MP，接近新硬预算前更早放慢恢复节奏。
- 说明：本版不调整网络并发、图床识别和资源提取，只压重图恢复范围内的解码常驻量。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.9 (2026-05-23)

- 优化：阶段二第三步增加重图恢复软压力档；可见重图恢复量预计到 200MP 或恢复范围预计到 240MP 时，恢复间隔提前放慢到 650ms，硬预算仍保持 240MP/300MP 和 900ms。
- 增强：重图恢复批次日志新增 `restorePressure`、`projectedVisibleMP`、`projectedRangeMP` 和软预算字段，便于判断卡顿来自硬阻塞还是接近预算时的连续恢复。
- 增强：content 结构化日志字段上限从 30 提到 45，避免 `heavyVisibleLockDelayMS`、软预算和恢复压力字段在 popup/导出分析时被截断。
- 涉及文件：viewport-observer.js、logger.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.8 (2026-05-23)

- 优化：阶段二第二步改为“可见并稳定约 1.2 秒后才锁定重图”，避免刚进入视口的超大图因为过早保护而绕过 320MP 可见区预算。
- 优化：重图恢复加载期间不再计入“稳定可见”保护，恢复完成并真正显示后才重新开始稳定计时，降低 `heavyVisibleMP` 峰值反弹。
- 增强：重图渲染日志补充 `heavyVisibleLockDelayMS` 字段，便于判断 `visible_budget_unload` 是否按预期触发。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.7 (2026-05-23)

- 优化：阶段二第一步继续压重图可见区峰值；新增可见区 320MP 上限保护，刚进入视口且尚未稳定显示的重图如果会把可见解码量推得过高，会先保持稳定占位。
- 优化：已经稳定显示在视口内的重图会被标记保护，不作为本轮可见区压力释放对象，避免回到“正在看的图突然消失”的体验。
- 增强：重图渲染日志新增 `visible_budget_unload`、`heavyVisibleBudgetMP` 和 `heavyVisibleMinKeep` 字段，便于判断是否仍有 `heavyVisibleMP` 峰值。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.6 (2026-05-23)

- 优化：混合页中普通图和重图共享总 active 上限，避免普通图已经打满时重图额外叠加形成解码/网络峰值。
- 优化：重图可见区恢复增加 MP 压力预算，当前视口已有足够重图解码量时，新的可见重图先保持稳定占位，等压力下降后再恢复。
- 优化：重图恢复队列在可见/范围内 MP 压力过高时自动放慢节奏，减少 `render_restore` / `render_unload` 高频震荡。
- 增强：调度日志新增 `global_limit`，重图渲染日志新增 `visible_mp_defer` 和可见恢复预算字段，便于判断混合页卡顿来自并发叠加还是解码压力。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.5 (2026-05-23)

- 优化：重图渲染预算不再释放当前视口内已经显示的重图，避免滚动时可见缩略图突然消失再恢复。
- 优化：图片候选新增显示图/预览图双层模型；列表优先加载 `<img src>`、小 `srcset`、`data-thumb` 等轻量显示图，点击预览仍使用 `file`、`zoomfile`、`data-original` 或最大 `srcset` 原图。
- 优化：如果显示图和预览图不同，列表加载按显示图通道调度，不再因为预览原图属于重图图床就套用重图网络延迟；重图判定、重图模式和预览仍按原图 URL 判断。
- 增强：日志补充 `previewHost`、`previewUrl`，候选 fallback 按预览原图去重并优先避开高扇出原图。
- 涉及文件：shared-utils.js、cache.js、loader.js、renderer.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.4 (2026-05-23)

- 优化：重图离屏恢复从 `2 张/90ms` 收紧为单张慢恢复，并对 `80MP+` 超大图使用更长批次间隔，减少滚动停止后的解码峰值。
- 优化：新增重图渲染预算，默认同一恢复范围最多保留 8 张、约 300MP，超出预算的重图释放 `src` 保持占位，优先保留靠近视口中心的图片。
- 增强：重图渲染日志补充可见重图数量、可见/范围内 MP、最大单图 MP、预算上限、批次 MP、预算释放/跳过原因，调度日志同步输出重图渲染压力。
- 涉及文件：viewport-observer.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.3 (2026-05-23)

- 优化：重图离屏恢复改为滚动后小批量队列处理，滚动中只排队不立即恢复，减少同一瞬间 `image.imx.to` 大图批量解码导致的卡顿。
- 优化：重图离屏释放预取范围从约 1400px 收紧到约 900px，降低远离视口的大图提前恢复和常驻解码压力。
- 增强：图片完成日志补充 `naturalWidth`、`naturalHeight`、`decodedMP`、显示尺寸；调度日志补充 `heavyRestoreQueued`，便于判断卡顿来自网络、并发还是解码/渲染。
- 增强：content/background 控制台日志改为输出紧凑结构化字段，不再只显示折叠的 `Object`，方便直接从页面 console 读取 host、reason、active、MP 等细节。
- 涉及文件：logger.js、background.js、loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、全量 `node --check ...`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.14.2 (2026-05-23)

- 优化：重图图床缩略图加载完成后纳入离屏监控，离视口较远时释放 `src` 降低大图解码常驻压力，靠近视口再恢复。
- 优化：用户滚动期间暂缓新的重图图床加载启动，滚动停止约 240ms 后继续调度，减少滚动时大图同时解码造成的顿挫。
- 增强：调度日志新增 `heavyScrollDeferred`、`heavyUnloaded`，并记录 `render_unload`、`render_restore` 和滚动相关 `render_state` 事件；popup 图片日志过滤纳入 render 事件。
- 调整：重图缩略图关闭 hover 放大和阴影重绘，普通图缩略图交互保持不变。
- 涉及文件：loader.js、viewport-observer.js、content.css、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.14.1 (2026-05-23)

- 调整：按测试需要放开图片加载配置上限；首屏并发最高 30，普图后台并发最高 24，重图并发最高 12。
- 调整：后台加载速度新增“极速 (20ms)”和“很快 (50ms)”两档；原有快速 100ms、平衡 300ms、温和 800ms 保持不变。
- 说明：本版只调整配置范围和速度档位，不改变重图/普图分通道策略，也不改渲染逻辑。
- 涉及文件：settings-schema.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- Breaking change：无

## 1.14.0 (2026-05-23)

- 新增：重图优化开启时提供“重图并发”设置，默认 2，范围 1-3；关闭重图优化时该设置在 popup 和悬浮窗中禁用。
- 优化：普通图床和高扇出重图图床使用独立加载通道；普通图床继续受“普图后台并发”约束，重图图床不再占用普通通道。
- 优化：当普通图床仍有 active 或等待任务时，重图通道自动压到 1；普通图床空闲后，重图通道提升到用户配置值，避免纯重图阶段仍单张排队。
- 增强：调度日志继续输出普通/重图 active、queue 和重图配置上限，验证脚本补充重图并发设置和分通道调度回归检查。
- 涉及文件：settings-schema.js、loader.js、popup.js、floating-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.99 (2026-05-23)

- 增强：content 日志增加 `sessionId`、页面 URL/host、版本号、事件类型和结构化字段，保留原有文本日志 API，方便区分旧日志、页面会话和当前版本。
- 增强：图片调度链路新增结构化事件，覆盖扫描完成、帖子注册、调度快照、重图让路、图片开始/完成、no-referrer 重试和候选 fallback，便于判断普通图床与重图图床的 active/queue 状态。
- 增强：popup 日志面板增加最近会话、告警/错误、图片调度、重图相关过滤和 host/type 搜索；导出日志会附带级别、事件和 host 摘要。
- 涉及文件：logger.js、content.js、renderer.js、loader.js、viewport-observer.js、popup.html、popup.css、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.98 (2026-05-23)

- 修复：根据最新日志，1.13.97 后仍出现 `active 2/2 image.imx.to`；本版将高扇出重图图床收紧为单通道加载，避免它继续形成小型并发堵塞。
- 修复：高扇出重图候选失败后只允许补位到非高扇出普通图床候选；如果候选池里没有普通图床候选，则直接释放当前槽位，不再顺序 fallback 到另一张 `image.imx.to`。
- 修复：普通图床候选可能位于 fallback 游标之前时，重图补位会回扫完整候选池寻找可用普通图床，不再被候选顺序卡住。
- 增强：验证脚本补充高扇出单通道、禁止同高扇出 fallback、完整候选池普通图床回扫的静态回归检查。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.97 (2026-05-23)

- 修复：根据最新日志，重图图床仍会出现 `active 5/5 image.imx.to`，说明高扇出图床额度仍过宽；本版将高扇出图床收紧为小额专用并发，混合普通图床等待时只保留 1 个重图槽。
- 修复：重图候选失败后的补位优先选择非高扇出图床候选，避免 `image.imx.to` 失败后继续顺序尝试一串同图床重图，错过后面的普通图床候选。
- 增强：验证脚本补充高扇出小额并发、混合任务让路、重图 fallback 优先普通图床候选的静态回归检查。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.96 (2026-05-23)

- 优化：根据本地日志，高扇出重图让路已触发，但 `Image candidate fallback`、`图片无Referer重试` 和连续失败日志量过高；本版对高频图片 debug 日志做节流汇总，减少 storage 写入和日志查看开销。
- 优化：`image.imx.to` 这类高扇出图床使用更短的挂起超时，坏请求更快释放加载槽，避免重图慢响应继续拖住后续普通图床。
- 修复：高扇出重图任务即使暂时没有普通任务等待，也不再占满全部首屏并发槽，避免后续普通帖子出现时只能等重图超时。
- 修复：当高扇出 active 槽已超过限制时，重图候选不再继续在同一个 active 槽内补位延长占用。
- 增强：验证脚本补充高扇出短超时、日志节流、槽位保留和高压下停止重图补位的静态回归检查。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.95 (2026-05-23)

- 修复：`image.imx.to` 这类高扇出重图图床加载挂起时不再占满全部首屏调度槽；当后面还有普通图床任务等待时，重图任务会让出部分槽位，避免普通图片被一起卡住。
- 修复：重图候选补位不再在同一个 active 缩略图槽里连续尝试大量候选；重图槽位每轮只做有限补位，防止一个坏重图帖子把全局并发长期占住。
- 优化：viewport 懒加载和手动重试也纳入 active 槽位的高扇出图床统计，候选替换时同步更新当前槽位的图床类型。
- 增强：验证脚本补充高扇出槽位让路、重图补位次数上限、viewport 槽位统计的静态回归检查。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.94 (2026-05-23)

- 修复：普通/混合图片帖提取阶段保留少量隐藏候选用于坏图补位，但渲染仍严格按显示上限展示，不再把普通帖套成重图的一行逻辑。
- 修复：图片加载失败后的候选替换不再只限重图模式；只要当前帖子有隐藏候选，超时或错误会先换后续候选再进入最终失败占位，降低列表页大面积失败占位。
- 修复：普通帖点击缩略图预览时仍只使用已渲染候选，隐藏补位候选不会变相扩大普通帖预览范围；重图模式继续可预览完整候选池。
- 增强：验证脚本补充普通/混合帖隐藏候选池、普通帖显示上限不变、通用候选补位和普通预览不扩展的回归检查。
- 涉及文件：shared-utils.js、renderer.js、loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.93 (2026-05-23)

- 优化：正则图片提取路径按单个 `<img>` 只保留一个最佳候选，避免 background/无 DOMParser 环境把 `data-original`、`srcset` 和 `src` 缩略图变体一起加入加载队列。
- 修复：图片直链判断支持代理图片链接的身份参数（如 `url`、`src`、`image`、`pic`、`path`、`file`），`<a href="...proxy?url=...jpg">` 这类图片入口不再漏提取。
- 修复：DOM/正则图片去重将已存在的有效候选视为已处理，并避免无意义占位图提前占用去重键，减少缩略图变体和占位图干扰后续真图。
- 增强：验证脚本补充代理图片 `<a href>`、单 `<img>` 最佳候选、zoom 缩略图去重的回归检查。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.92 (2026-05-23)

- 优化：`srcset` 图片提取只选择当前 `img` 中最合适的候选，避免响应式小图/大图变体同时进入队列占满显示名额并拖慢加载。
- 修复：图片 URL 去重会保留代理图常见身份参数（如 `url`、`src`、`image`、`pic`、`path`），并对签名参数名做大小写归一、忽略 fragment，减少误去重漏图和无效重复请求。
- 优化：隐藏标签页关闭“不可见时暂停”后，接管已有 viewport 懒加载占位时按当前空闲加载槽推进，避免一次性给大量离屏占位创建重试 timer。
- 增强：验证脚本补充 `srcset` 最优候选、代理图参数、签名参数大小写归一、fragment 去重和隐藏页 pending 接管预算的回归检查。
- 涉及文件：shared-utils.js、loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.91 (2026-05-23)

- 修复：图片 URL 去重保留签名参数时改为大小写不敏感，并补充常见 `X-Amz-*`、`Policy`、`Key-Pair-Id` 等 CDN 签名参数，避免混合大小写签名图片被误合并漏图。
- 增强：验证脚本补充 `X-Amz-Signature` 大小写签名参数的图片去重回归检查。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.92 统一验证
- Breaking change：无

## 1.13.90 (2026-05-23)

- 修复：图片 URL 去重会保留常见签名/鉴权参数（如 `token`、`sign`、`signature`、`expires`），避免同一路径下不同签名图片被误判为重复而漏图。
- 增强：验证脚本补充同一路径不同 `token` 图片不能被去重丢弃的回归检查。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.91 统一验证
- Breaking change：无

## 1.13.89 (2026-05-23)

- 修复：外部设置更新后会同步 loader 的可见性暂停状态，切换“标签页不可见时暂停/继续加载”不再必须等待下一次 `visibilitychange` 才生效。
- 修复：磁力链接 hash 后面无空格直接跟“解压密码”等说明时也会裁掉说明，避免复制结果混入说明文本。
- 增强：验证脚本补充设置变更重算暂停状态、magnet hash 紧贴密码说明清理的回归检查。
- 涉及文件：content.js、loader.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.90 统一验证
- Breaking change：无

## 1.13.88 (2026-05-23)

- 修复：全局图片轮询调度入口先检查暂停状态，确保“标签页不可见时暂停”同时覆盖首屏图片和后台补齐图片，后台打开的隐藏页面不会继续抢占加载资源。
- 增强：验证脚本补充全局调度必须尊重暂停状态的静态回归检查。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.89 统一验证
- Breaking change：无

## 1.13.87 (2026-05-23)

- 修复：磁力链接后紧贴“，解压密码/提取码”等说明时，资源提取会裁掉说明文本但保留独立密码，避免复制出的 magnet URL 被中文说明污染。
- 修复：`ed2k` 清理优先按协议终止符 `|/` 截断尾随说明，继续保护文件名中的中文逗号等标点。
- 增强：验证脚本补充 magnet 尾随密码说明清理和 `ed2k` 终止符清理的回归检查。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.88 统一验证
- Breaking change：无

## 1.13.86 (2026-05-23)

- 修复：重图判定改为至少 3 张且占候选图片一半以上才触发，避免混合普通图帖只因少量重图图床链接被误套用一行重图展示策略。
- 修复：loader 注册可见性监听时会立即按当前标签页可见状态初始化暂停标记，后台打开且设置为“标签页不可见时暂停”的页面不会抢占图片加载并发。
- 增强：验证脚本补充混合普通图帖不扩展到重图候选池、隐藏启动页遵守暂停设置的回归检查。
- 涉及文件：shared-utils.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.85 (2026-05-23)

- 优化：隐藏标签页继续加载时，后台调度会在处理新后台任务前主动推进已接管的 viewport pending 占位，释放出并发槽后更快补上下一张，减少依赖占位重试 timer 造成的短暂停顿。
- 增强：验证脚本补充隐藏页后台调度主动 drain pending viewport 占位的静态回归检查。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.86 统一验证
- Breaking change：无

## 1.13.84 (2026-05-23)

- 修复：关闭“标签页不可见时暂停”后，如果切后台前已经创建了 viewport 懒加载占位，隐藏状态会主动接管这些 pending 占位继续加载，不再等回到可见页面或再次滚动才触发。
- 优化：隐藏接管的 pending 占位在隐藏时使用 eager/high 优先级；回到可见页面会清理强制标记，普通可见页仍保留 viewport lazy 策略。
- 增强：验证脚本补充隐藏页接管 pending viewport 占位、回可见清理标记的静态回归检查。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.83 (2026-05-23)

- 修复：中文标点尾随清理收紧到 HTTP/网盘/TXT/图片/附件直链场景，`ed2k` 和 `magnet` 只裁掉末尾包裹标点，不再误切文件名或展示名中的中文逗号。
- 增强：验证脚本补充 `ed2k` 文件名中文标点保护回归，避免 URL 清理为了减少坏请求而误伤协议链接。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.82 (2026-05-23)

- 修复：图片直链、TXT 下载链接、Discuz 附件链接和其他资源链接在进入 URL 解析前会清理中文句号、逗号、顿号、分号和闭合括号后的尾随说明，避免生成 `%EF%BC%8C...` 这类坏链接并浪费加载重试。
- 修复：正则图片提取补充扫描并清理所有 `<a href>` 图片直链，和 DOM 路径保持一致，避免直链后紧贴中文标点时漏图。
- 增强：验证脚本补充中文标点尾随图片/TXT/附件 URL 的回归检查。
- 涉及文件：shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.83 收紧并统一验证
- Breaking change：无

## 1.13.81 (2026-05-23)

- 修复：扫描延迟执行时如果另一轮扫描正在处理，会记录补扫请求；本轮恰好没有候选时也会消费补扫请求，避免滚动/DOM 更新落在极窄边界后不继续扫描。
- 修复：资源链接提取会清理网盘 URL 尾部的中文括号、中文标点和紧贴的“提取码/访问码”说明，避免把说明文字编码进链接，同时保留正确提取码绑定。
- 增强：验证脚本补充扫描空候选补扫、网盘 URL 中文标点清理的回归检查。
- 涉及文件：content.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools\verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools\verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.80 (2026-05-23)

- 修复：滚动触发扫描命中节流窗口时会补排节流到期后的扫描，避免用户停在新位置后因本次滚动被丢弃而短暂停住不加载后续帖子。
- 修复：隐藏标签页后台直载的 eager/high 优先级按每次调度的当前可见状态重新计算，避免失败重排后回到可见页面仍保留高优先级。
- 增强：验证脚本补充滚动节流补扫的静态回归检查。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：后续由 1.13.81 统一验证
- Breaking change：无

## 1.13.79 (2026-05-23)

- 修复：关闭“标签页不可见时暂停”后，隐藏标签页里的后台图片任务会绕过 viewport 懒加载和 pending 占位限制，按后台并发/速度继续直接加载，避免离屏占位让“后台继续加载”失效。
- 修复：临时空结果退避到期后同步清理该 URL 的失败次数，避免后续偶发慢响应继承旧次数直接进入更长退避，提升网络恢复后的重新抓取速度。
- 增强：验证脚本补充隐藏标签页后台直载、退避到期清零失败次数的静态回归检查。
- 涉及文件：content.js、loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js`、`node --check content.js loader.js viewport-observer.js shared-utils.js fetcher.js background.js renderer.js resource-panel.js previewer.js cache.js config.js defaults.js settings-schema.js logger.js floating-panel.js popup.js tools/verify.js`、`git diff --check` 通过（仅 LF/CRLF 提示）
- Breaking change：无

## 1.13.78 (2026-05-23)

- 优化：临时空结果自动重试改为按 URL 指数退避，连续失败从 15 秒逐步放大到最多 60 秒，成功或确定为空时清零，降低持续限流/后台慢响应时的反复抓取压力。
- 修复：TXT 下载中转页中的 `xia.ewrewej.la` 签名下载地址即使没有 `.txt` 后缀也能被提取，并能通过 content/background 的最终 URL 白名单校验。
- 增强：验证脚本补充临时空结果指数退避、签名 TXT 下载地址提取和 `xia.ewrewej.la` 最终 URL 放行的回归检查。
- 涉及文件：content.js、shared-utils.js、fetcher.js、background.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js`、`git diff --check` 通过
- Breaking change：无

## 1.13.77 (2026-05-23)

- 修复：多个帖子先后进入临时空结果退避时，重试扫描会按最早到期时间调度；如果扫描时遇到尚未到期的退避帖子，会重新安排后续唤醒，避免后进入退避的帖子被早到 timer 跳过后不再自动重试。
- 修复：提取码出现在第一个网盘链接前方、后面紧跟第二个网盘链接时，不再把该提取码继续向后串给第二个链接。
- 优化：截断 HTML 且没有提取到内容时仍不写负缓存，但不再按 15 秒短周期自动重试，避免对确定性截断空结果做无效反复抓取。
- 增强：验证脚本补充退避 timer 到期调度、前置提取码跨链接保护、截断空结果不短周期重试的回归检查。
- 涉及文件：content.js、fetcher.js、background.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js`、`git diff --check` 通过
- Breaking change：无

## 1.13.76 (2026-05-23)

- 修复：文章抓取遇到临时网络异常、HTTP 429/5xx 或 background 超时时，不再把列表行永久标记为已处理，改为 15 秒退避后重新扫描，减少偶发慢响应导致缩略图本页不再出现的问题。
- 修复：资源提取在多个网盘链接和多个提取码相邻时，会按当前链接就近匹配且不跨过下一个资源链接，避免把上一个/下一个链接的提取码串到错误网盘。
- 优化：资源提取补充识别裸域名和协议相对形式的常见 `www` 网盘链接，例如 `www.aliyundrive.com/s/...`、`www.pan.baidu.com/s/...`、`//www.pan.quark.cn/s/...`。
- 增强：验证脚本补充相邻提取码、`www` 网盘域名、临时空结果退避重试的回归检查。
- 涉及文件：content.js、fetcher.js、background.js、cache.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js`、`git diff --check` 通过
- Breaking change：无

## 1.13.75 (2026-05-23)

- 优化：content 初始化从只等待 `window.load` 改为 DOM 可用后即调度启动，并保留 `load` 兜底，减少页面图片/广告拖慢时插件首轮扫描的等待时间。
- 增强：验证脚本补充 DOM readiness 初始化和 load 兜底检查。
- 涉及文件：content.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.74 (2026-05-23)

- 优化：viewport 懒加载会记录占位是否仍在视口附近；并发槽位不足时的延迟重试不会在用户已经滚走后继续抢槽加载离屏图片，并会清理离屏占位的重试 timer。
- 增强：验证脚本补充 viewport 懒加载离屏重试保护检查。
- 涉及文件：viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.73 (2026-05-23)

- 修复：TXT 资源解析空结果、异常或附件链接重新提取失败后保留手动重试入口，不再让本次页面会话里的解析按钮直接消失。
- 修复：资源面板保留 TXT 解析失败/需手动下载等提示文案，不再被通用“未提取到资源链接”覆盖。
- 增强：验证脚本补充 TXT 资源可重试状态和资源面板提示保留的静态回归检查。
- 涉及文件：renderer.js、resource-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.72 (2026-05-23)

- 优化：后台图片队列在 Chrome/Edge 的 `requestIdleCallback` 路径也会遵守“后台加载速度”设置，不再绕过快/平衡/温和节奏。
- 优化：放宽后台懒加载占位 pending 预算，避免默认只有 3 个隐藏占位时卡住后续帖子后台队列，同时仍限制真实图片并发。
- 修复：资源提取会使用 `<a href>` 周边文本识别提取码，并向链接前方回看，避免“提取码在链接前面”时漏掉网盘访问码。
- 修复：TXT 下载中转页中的裸 `.txt#hash` 链接可以被识别并保留 hash。
- 增强：验证脚本补充后台调度节流、懒加载 pending 预算、链接前提取码和 TXT hash 链接回归检查。
- 涉及文件：loader.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.71 (2026-05-23)

- 修复：图片提取的正则和 DOM 路径都支持 `<a href="...jpg?token=...">` / `<a href="...jpg#hash">` 这类直链，避免签名图片链接被漏掉。
- 修复：预览大图增加超时保护，超时后先走一次 `no-referrer` 兜底，再失败才显示失败状态，避免大图一直停在“加载中”。
- 增强：验证脚本补充带 query 图片直链提取、预览超时和预览 no-referrer 共用兜底路径检查。
- 涉及文件：shared-utils.js、previewer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.70 (2026-05-23)

- 优化：统一缩略图 `<img>` 初始化逻辑，首屏图片和手动重试使用 `eager/high` 优先级，后台补齐图片使用 `lazy/low` 优先级，减少首屏和后台图片互相抢加载资源。
- 维护：viewport 懒加载复用 loader 的缩略图初始化，避免后续新增图片属性时两条路径不一致。
- 增强：验证脚本补充缩略图初始化统一、loading/fetchPriority 优先级和 viewport 复用检查。
- 涉及文件：loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.69 (2026-05-23)

- 优化：预览大图加载增加 token 保护，快速切换图片或关闭预览时会忽略旧加载回调和旧延迟赋值，避免计数已切换但旧图覆盖显示。
- 优化：预览大图加载失败时自动做一次 `no-referrer` 兜底重试，和缩略图加载策略保持一致。
- 增强：验证脚本补充预览 stale-load guard、预览 no-referrer 重试和 loader 可取消图片赋值检查。
- 涉及文件：loader.js、previewer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.68 (2026-05-23)

- 修复：后台图片命中域名熔断时，先创建缩略图 slot 再显示失败占位，不再直接吞掉任务导致用户看不到可点击重试入口。
- 增强：验证脚本补充 loader 域名熔断必须保留可重试占位的静态回归检查。
- 涉及文件：loader.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.67 (2026-05-22)

- 修复：重图候选扩展改为重图专属逻辑；普通图片帖子只按显示上限提取和打开，不再套用重图的宽候选池。
- 修复：content/background 抓取先按显示上限提取，只有首批候选已命中重图判定时才扩大到抓取上限用于失败补位。
- 增强：验证脚本补充“普通帖不扩展、重图帖才扩展”的回归检查，防止重图优化再次影响非重图帖子。
- 涉及文件：shared-utils.js、fetcher.js、content.js、background.js、renderer.js、settings-schema.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.66 (2026-05-22)

- 修复：重图优化拆分“抓取上限”和“显示上限”，抓取阶段不再被显示上限截断；重图模式仍只渲染一行，但可使用更大的原始候选池补位，降低前 10 张坏链导致整行失败的概率。
- 优化：重图候选会优先排列历史已成功加载的图片 URL，刷新或命中缓存时更容易先显示可用代表图。
- 更新：文章缓存前缀升级为 `article_cache_v9_`，避免旧缓存继续只保留过少候选。
- 增强：验证脚本补充抓取/显示上限分离、重图宽候选池和成功候选优先级检查。
- 涉及文件：shared-utils.js、fetcher.js、content.js、renderer.js、settings-schema.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.65 (2026-05-22)

- 修复：统一在 URL 解析前解码 HTML 实体，避免 background 正则提取路径把 Discuz 图片参数中的 `&amp;` 原样带入请求，导致跨 origin 帖子图片大面积加载失败。
- 修复：读取旧文章缓存时同步修复已缓存的实体编码图片 URL，并过滤不可加载图片候选，避免坏 URL 在缓存期内继续进入加载队列。
- 修复：域名熔断不再直接吞掉首屏图片和手动重试；懒加载图片被熔断跳过时保留失败占位，用户可以点击重试。
- 增强：验证脚本补充 HTML 实体 URL、首屏/手动重试不被熔断隐藏、懒加载熔断占位的回归检查。
- 涉及文件：shared-utils.js、cache.js、loader.js、viewport-observer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.64 (2026-05-22)

- 修复：热重载遇到旧扫描正在处理或已有旧延迟扫描时，会清理旧扫描定时器并在旧任务结束后补发新一轮扫描，避免页面清空后不重新渲染缩略图。
- 修复：content/background 抓取文章和 TXT 附件时会校验重定向后的最终 URL，拒绝未允许域名，收紧跨域代理和解析边界。
- 修复：统一清洗存储中的设置值，避免旧值、非法数字或异常 `siteConfigs` 类型导致 popup、悬浮面板或布局异常。
- 修复：图片候选过滤非 http(s) 协议和带查询参数的 SVG，避免无效或危险协议进入缩略图加载队列。
- 维护：悬浮面板在窗口尺寸变化时重新夹紧位置；验证脚本补充设置清洗、重定向边界、热重载补扫和图片协议过滤回归检查。
- 涉及文件：defaults.js、config.js、content.js、fetcher.js、background.js、shared-utils.js、floating-panel.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.63 (2026-05-22)

- 修复：预览大图复用缩略图加载器的 no-referrer 策略，避免特定图床缩略图可见但点击预览失败
- 修复：多个 TXT 附件同源直连时，单个空结果附件会继续走 background 兜底解析，不再被其他成功附件掩盖
- 修复：热重载或停用页面时通过 generation 令牌丢弃旧扫描、旧图片任务和旧 TXT 异步回调，避免旧任务回写新页面状态或重新入队
- 修复：扫描处理异常会写入日志并恢复处理状态，避免 Promise rejection 静默散落到控制台
- 修复：悬浮设置面板恢复历史位置时会夹紧到当前窗口内，避免换屏或缩小窗口后面板出现在屏幕外
- 增强：验证脚本补充预览加载策略、TXT 单附件兜底、generation 失效保护和悬浮位置夹紧的静态回归检查
- 涉及文件：fetcher.js、previewer.js、content.js、renderer.js、loader.js、viewport-observer.js、floating-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.62 (2026-05-22)

- 修复：`cacheIndex.rebuild()` 在 storage 扫描失败时继续返回失败状态，不再把失败伪装成空索引；content/background LRU 淘汰和 popup 清缓存会显式处理该失败路径
- 修复：页面初始化前的早期用户交互会先初始化 `ATPState`，避免快速点击或滚动触发空对象异常
- 修复：悬浮设置面板区分 storage 保存失败和页面应用回调失败；设置已写入但热重载异常时不再回滚成“保存失败”状态
- 增强：验证脚本补充 fake storage 行为测试，覆盖 `cacheIndex` 读取、重建和更新失败分支
- 涉及文件：shared-utils.js、cache.js、background.js、popup.js、config.js、floating-panel.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.61 (2026-05-22)

- 修复：跨域 background 抓取到的文章数据会写入文章缓存，避免刷新或重扫时反复抓取同一帖子；缓存写入会过滤 Discuz 临时附件 URL 并保留重新提取标记，后续按需解析会回到 background 重新提取附件入口
- 修复：窄屏下只有 TXT 附件、暂无已提取资源的帖子也会显示 inline `解析TXT` 入口，避免右侧资源栏隐藏后无法触发解析
- 修复：content/background 读取文章 HTML 和 TXT 附件正文时改用共享限长 reader，服务端缺少 `content-length` 时也会在超过上限后主动停止读取
- 修复：`cacheIndex` 区分 storage 读取失败和索引缺失；读取或扫描失败时不再把索引覆盖成空索引或单条不完整索引
- 增强：验证脚本补充跨域缓存、跨域 TXT 重新提取、inline TXT 入口、限长读取和 cacheIndex 失败保护的静态回归检查
- 涉及文件：content.js、resource-panel.js、fetcher.js、background.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.60 (2026-05-22)

- 修复：content/background 日志 flush 读取或写入 storage 失败时会把当前批次放回队列，最多重试 3 次，避免诊断日志在短暂 storage 异常时直接丢失
- 修复：资源面板 `attachThread()` 增加一次性绑定保护，并在复用 panel 时同步最新 threadState，避免重复注入或热重载路径累加 hover/click 监听、侧栏引用旧状态
- 维护：将 `.agents/` 标记为本地 agent 工具配置并加入 `.gitignore`，避免未跟踪工具文件混入产品改动
- 增强：验证脚本补充日志重入队、资源面板绑定保护和 panel 状态同步的静态回归检查
- 涉及文件：logger.js、background.js、resource-panel.js、tools/verify.js、.gitignore、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.59 (2026-05-22)

- 修复：popup 启动时只刷新日志数量，不再在日志面板隐藏时全量扫描 storage 或裁剪旧 content 日志，减少缓存接近上限时打开弹窗的卡顿和诊断日志误删风险
- 修复：popup 缓存清理、日志导出/清空、设置保存失败时会显示失败状态并回滚对应 UI，避免 Promise rejection 后按钮或设置停在无反馈状态
- 修复：background、content cache、config 和 cacheIndex 的 storage 读取/删除路径补充 `runtime.lastError` 处理，失败时回退为空缓存并写日志
- 维护：浮动设置面板销毁时清理消息/输入错误定时器，保存失败时提示并回滚输入；content 生命周期监听改为命名函数并在卸载时移除
- 增强：验证脚本补充资源提取 fixture、TXT 附件识别 fixture，以及 popup 启动不做完整日志加载的回归检查
- 涉及文件：popup.js、background.js、cache.js、config.js、content.js、floating-panel.js、shared-utils.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.58 (2026-05-22)

- 修复：popup 读取、导出和清空日志时合并日志索引与 storage 实际扫描结果，避免 content 日志索引并发丢 key 后漏读旧页面日志
- 增强：验证脚本补充 popup 日志 key 兜底发现规则检查
- 涉及文件：popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.57 (2026-05-21)

- 调整：首屏并发可配置上限从 8 提高到 16，后台并发可配置上限从 4 提高到 12，以支持高速网络下更积极的图片加载
- 保持默认值不变，避免升级后自动增加网络和图床压力
- 涉及文件：settings-schema.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.56 (2026-05-21)

- 修复：content 等待 background 解析 TXT 附件时改用共享超时预算，覆盖附件中转页最多 3 次读取，避免 15 秒前台超时先返回空资源；同步消息异常会立即清理等待 timer
- 修复：高扇出图床默认使用 `no-referrer` 后不再重复做同 URL `no-referrer` 重试，失败时更快进入候选替换或最终失败处理
- 修复：popup 清理缓存时合并 `cacheIndex` 和 storage 兜底扫描结果，避免索引陈旧或写入失败时清理不干净
- 增强：验证脚本补充 popup HTML/script/css 引用检查，并覆盖 TXT background 超时、no-referrer 重复重试和 popup 清缓存兜底规则
- 涉及文件：shared-utils.js、fetcher.js、loader.js、popup.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.55 (2026-05-20)

- 修复：`image.imx.to` 这类重图图床不再参与全局域名熔断，避免一个帖子失败 5 张后同图床后续帖子被直接跳过
- 修复：重图优化首批候选失败时会从原始候选列表继续替换尝试，避免前 5 张不可直连时直接显示 `完成 0/5 失败5`
- 修复：`no-referrer` 重试现在会先清空 `src` 再重新赋值，确保同 URL 真的重新发起请求
- 涉及文件：loader.js、viewport-observer.js、renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.54 (2026-05-20)

- 修复：图片连续失败 3 次后不再永久暂停帖子队列，避免重图优化帖子停在 `0/5 失败3` 或普通帖子剩余候选不再加载
- 增强：单张图片首次失败或超时时自动用 `no-referrer` 再试一次，降低外部图床 Referer 拦截导致的整帖失败率
- 增强：验证脚本增加 loader 暂停回归检查，防止失败队列再次因 stale pause 状态卡住
- 涉及文件：loader.js、viewport-observer.js、renderer.js、tools/verify.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.53 (2026-05-20)

- 重构：loader 状态判断拆出纯 helper，统一完成判断、状态分母和后台补齐数量计算，行为不变
- 涉及文件：loader.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.52 (2026-05-20)

- 新增：`tools/verify.js` 项目验证脚本，覆盖 JS 语法、manifest 引用、版本文档一致性、显示上限硬上限、跨域 timeout 和截断缓存关键规则
- 优化：content 日志写入维护 `atp_logs_content_keys` 索引，popup 读取/导出/清理日志优先走索引，减少全量扫描 storage
- 优化：popup 清理图片、文章、TXT、失败缓存时优先使用 `cacheIndex` 获取 key，降低缓存接近配额时打开和操作 popup 的开销
- 修复：`safeSetWithRetry` 回调现在会传递缓存写入成功/失败结果，淘汰后重试仍失败时不再被上层当作成功
- 涉及文件：tools/verify.js、shared-utils.js、logger.js、popup.js、cache.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：`node tools/verify.js` 通过
- Breaking change：无

## 1.13.51 (2026-05-20)

- 修复：每帖“显示上限”重新作为硬上限生效，不再额外追加 10 张预取候选，避免设置为 10 时状态显示并加载到 20 张
- 修复：显示上限等于首屏可见数量时，首屏加载完成后状态可正常完成，不会因多出的预取候选停在 `10/20`
- 涉及文件：shared-utils.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：语法检查通过，manifest/version 文档一致性检查通过
- Breaking change：无

## 1.13.50 (2026-05-20)

- 修复：文章 HTML 被截断解析时不再写负缓存，也不再把文章缓存标记为完整，避免截断点之后的图片、资源或 TXT 附件被缓存期内误丢弃
- 调整：文章缓存数据增加 `partial` 标记，loader 和资源补齐写回时会保留未完整状态
- 重构：background 分批大小和跨域等待超时常量统一到 `SharedUtils`，content 与 background 不再手动同步硬编码值
- 涉及文件：shared-utils.js、content.js、background.js、fetcher.js、cache.js、renderer.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：语法检查通过，manifest/version 文档一致性检查通过
- Breaking change：无

## 1.13.49 (2026-05-20)

- 修复：TXT 附件同源直连的硬失败状态改为单次解析局部状态，避免多个帖子并发解析时互相污染
- 修复：设置热重载时同步清理 loader 后台定时器和后台任务，避免旧任务继续向已清理的 DOM 写入
- 修复：跨域文章 background 抓取超时按分批数量计算，避免 4-5 个跨域帖子被固定 15 秒前台超时提前丢弃
- 修复：文章 HTML 增加 content-length 保护和解析前字符截断，降低超大页面拖慢 DOMParser/资源提取的风险
- 修复：popup 自动裁剪旧 content 日志 key，避免长期多页面日志堆积；cacheIndex 写入失败时输出告警
- 涉及文件：fetcher.js、content.js、background.js、shared-utils.js、popup.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：语法检查通过，manifest/version 文档一致性检查通过
- Breaking change：无

## 1.13.48 (2026-05-20)

- 修复：content 侧 TXT 附件临时异常不再写入失败缓存，避免同源直连失败后立即阻断 background 回退解析
- 修复：文章 HTML 正文读取纳入 fetch 超时窗口，避免响应头返回后正文卡住导致列表批处理挂起
- 修复：content 日志按页面写入独立 key，popup 统一聚合旧日志 key 和新前缀 key，减少多标签页并发 flush 覆盖日志
- 修复：BGLOG flush 串行化，避免同一 Service Worker 内重叠 flush 覆盖较新的批次
- 修复：资源复制 fallback 检查 `document.execCommand('copy')` 返回值，失败时显示复制失败而不是误报成功
- 涉及文件：fetcher.js、background.js、logger.js、popup.js、resource-panel.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：语法检查通过，manifest/version 文档一致性检查通过
- Breaking change：无

## 1.13.47 (2026-05-19)

- 修复：Popup 清除缓存遗漏 TXT 失败缓存前缀（TEXT_FAIL_BASE），三个清理入口均已补上
- 修复：cacheIndex read-modify-write 竞态导致索引丢失，改为串行队列写入（_enqueue/_drain），内部操作用 _writeNow/_rebuildNow 不再二次入队
- 修复：淘汰缓存 entries（lastRebuildEntries）在删除 key 后未失效，30 秒内再次淘汰会基于旧索引，现改为删除后立即清空
- 修复：并发淘汰时更高 baseline 被忽略，现记录 pendingEvictBaseline，淘汰完成后若更高则再跑一次
- 修复：BGLOG warn/error 级别即时 flush，onMessage 处理完成后也 flush，减少 Service Worker 终止导致日志丢失
- 修复：content.js sendMessage 回调未检查 chrome.runtime.lastError，现补上并记录日志
- 修复：Previewer 打开时 ArrowLeft/ArrowRight/Escape 未 preventDefault，导致页面同时滚动
- 修复：normalizeImageUrl 保留参数未排序，query 顺序不同会产生不同缓存键，现改为排序
- 涉及文件：shared-utils.js、cache.js、popup.js、background.js、content.js、previewer.js、manifest.json、CHANGELOG.md
- 验证：语法检查通过，队列逻辑模拟无死锁，淘汰 coalesce 模拟通过
- Breaking change：无

## 1.13.46 (2026-05-19)

- 修复：isDiscuzAttachmentUrl 去掉对全局 location.hostname 的硬依赖，改为可选 baseUrl 参数，调用处传入帖子 URL
- 修复：loader.js showFailedPlaceholder 中 settings 加空值保护（`|| {}`）
- 修复：extractTextAttachments 加 HTML 长度截断（1MB）和扫描时间保护（250ms），防止极端大页面卡顿
- 修复：content.js beforeunload 加 initialized 标志守卫，未初始化时跳过清理
- 清理：scanner.js 长正则拆为数组 join，提升可读性
- 清理：logger.js 技术债注释改为当前设计说明
- 涉及文件：shared-utils.js、loader.js、content.js、fetcher.js、renderer.js、scanner.js、logger.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.45 (2026-05-18)

- 重构：TXT 附件解析从"自动全量后台跑"改为"按需触发"（资源面板点击"解析资源"/"解析TXT"按钮触发）
- 新增：TXT 附件失败负缓存（atp_text_fail_v1），403/401/429/网络异常在 5 分钟内不再重试，跨域发送前预查
- 修复：403/401 判定为站点拒绝，直接终止重试，不继续 background fallback（含失败缓存命中场景）
- 修复：文章缓存停止长期存储 Discuz 附件入口 URL（forum.php?mod=attachment），按需解析后写回也过滤
- 修复：图片抓取上限按显示上限收敛（effective = min(fetchLimit, displayLimit + 10)），避免抓取 200 张仅显示 10 张
- 修复：pauseWhenHidden=false 不再自动提升后台并发到 6，仅控制标签页隐藏时是否暂停；移除 isEagerBackgroundMode 死代码
- 修复：registerThread() 中 data 变量作用域错误（ReferenceError）
- 修复：资源面板按钮在 hasTextAttachments=true 但 textAttachments 为空时正确显示；Discuz-only 帖子不被跳过
- 涉及文件：shared-utils.js、cache.js、fetcher.js、background.js、renderer.js、resource-panel.js、loader.js、settings-schema.js、content.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：pauseWhenHidden=false 不再自动提升并发，用户如需高速后台加载需手动调高后台并发设置项

## 1.13.44 (2026-05-18)

- 修复：background 代理请求 Discuz TXT 附件时携带帖子来源 referrer，避免附件接口返回 HTTP403
- 涉及文件：background.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.43 (2026-05-18)

- 修复：TXT 附件真实下载地址会跳转到 `xia.ewrewej.la` 签名链接时，background 代理可继续获取并解析
- 更新：host permissions 增加 `https://xia.ewrewej.la/*`，TXT 附件白名单同步允许该下载域的 `.txt` 文件
- 涉及文件：manifest.json、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.42 (2026-05-18)

- 修复：TXT 附件对象保留来源页面 URL，同源附件 fetch 会携带页面 referrer，更接近用户点击下载行为
- 修复：附件响应不是标准 HTML 但包含下载中转脚本/链接时，也会继续追踪真实附件链接
- 修复：旧文章缓存里的 TXT 附件缺少来源页面时，渲染线程会用当前帖子 URL 补齐，避免 referrer 回退到列表页
- 更新：background TXT 附件解析使用相同的下载中转识别逻辑
- 涉及文件：shared-utils.js、fetcher.js、background.js、renderer.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.41 (2026-05-18)

- 修复：TXT 附件返回 Discuz HTML 下载中转页时，content 直连路径会继续追踪真实附件下载链接
- 修复：TXT HTML 中转页内的 `forum.php?mod=attachment`、`attachment.php`、`misc.php?mod=attach` 附件链接可被继续追踪
- 修复：资源提取支持无协议的百度网盘、115 网盘、夸克网盘、阿里云盘链接，并自动补 `https://`
- 涉及文件：shared-utils.js、fetcher.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.40 (2026-05-18)

- 调整：关闭“标签页不可见时暂停”后进入 eager 后台加载模式，后台图片并发取 `Math.max(backgroundConcurrency, 6)`
- 修复：eager 模式不再受视口 pending 队列数量阻塞，首屏外图片会更积极地继续加载
- 更新：设置说明补充主动加载模式的并发语义
- 涉及文件：loader.js、settings-schema.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.39 (2026-05-18)

- 修复：关闭“标签页不可见时暂停”后，首屏外图片不再走 IntersectionObserver 懒加载，而是按后台并发继续主动加载
- 更新：设置说明补充关闭该选项后的主动加载行为
- 涉及文件：loader.js、settings-schema.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.38 (2026-05-18)

- 重构：模块级 `var` → `const` 迁移（SharedUtils、BGLOG、ATPConfig、ATP_DEFAULTS、Logger 等），函数内 `var` 保留不变避免作用域风险
- 修复：cache index 一致性 — evictLRU/checkAndEvict 淘汰前始终 rebuild() 避免 read-modify-write 并发丢项；write() 检查 lastError 避免静默失败；removeEntries 等回调完成；raw URL fallback 文件名改为 ±200 → ±800 → 1500 优先顺序与 anchor context 一致
- 涉及文件：shared-utils.js、background.js、defaults.js、config.js、logger.js、cache.js、manifest.json、CHANGELOG.md
- 验证：node --check 全部通过，manifest.json 解析通过
- Breaking change：无

## 1.13.37 (2026-05-18)

- 新增：cache index（`atp_cache_index_v1`）— `getCacheStats` 使用索引统计 count，写入时同步更新索引；`evictLRU`/`checkAndEvict` 淘汰前全量 rebuild 保证一致性，清缓存/popup/onInstalled 同步清理
- 新增 `SharedUtils.cacheIndex` 模块（read/write/updateEntry/removeEntries/rebuild/getStats），索引缺失或损坏时自动全量重建
- 涉及文件：shared-utils.js、cache.js、background.js、popup.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 全部通过，manifest.json 解析通过
- Breaking change：无

## 1.13.36 (2026-05-18)

- 重构：图片提取双轨收敛，新增 `SharedUtils.extractImages()` 统一入口，`extractImagesByDom` / `extractImagesByRegex` 按 DOMParser 可用性自动派发；fetcher.js 和 background.js 统一调用
- 涉及文件：shared-utils.js、fetcher.js、background.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 全部通过，manifest.json 解析通过
- Breaking change：无

## 1.13.35 (2026-05-18)

- 修复：context 候选附件文件名收窄匹配范围，优先 tag 属性（download/title/label）→ ±200 字符近距 → ±800 字符附件块 → 1500 字符窗口回退，避免多附件相邻时名称误配
- 涉及文件：shared-utils.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 通过，manifest.json 解析通过
- Breaking change：无

## 1.13.34 (2026-05-18)

- 重构：`extractTextAttachments` 三轮 `<a>` 扫描合并为单轮收集 + 合并阶段（direct → context → raw URL），行为语义不变
- 重构：`esc()` 统一到 `SharedUtils.escapeHtml(value)`，null/undefined 统一返回空字符串；popup/resource-panel/floating-panel 保留本地薄包装
- 涉及文件：shared-utils.js、popup.js、resource-panel.js、floating-panel.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 全部通过，manifest.json 解析通过
- Breaking change：无

## 1.13.33 (2026-05-18)

- 缓存淘汰从条目数（500条上限）改为字节水位淘汰
- 写入成功后检查 `chrome.storage.local.getBytesInUse(null)`，超过 85% 高水位触发淘汰，删至 75% 目标水位
- 新增 `estimateCacheEntryBytes(key, value)` 用于单条目相对排序；`getCacheStats` 改用 `getBytesInUse` 返回真实字节占用
- background.js 的 `setCachedTextResources` 补充淘汰逻辑；负缓存写入也触发水位检查
- 删除 `CACHE_MAX_ITEMS`、`CACHE_WRITE_COUNT`、`CACHE_EVICT_THRESHOLD`，不再依赖写计数器触发
- 写入配额失败时自动淘汰后重试一次；evictLRU 和 checkAndEvict 基准改用真实 bytesUsed 避免非缓存数据干扰
- 涉及文件：cache.js、background.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.32 (2026-05-18)

- 优化：scanner.js 排除 URL 模式数组和版务帖关键词正则提取为文件顶部常量（EXCLUDE_URL_PATTERNS、EXCLUDE_DOMAIN_RE 等），行为不变
- 优化：popup.html 标题移除 emoji，改为纯文本，避免跨平台渲染不一致
- 涉及文件：scanner.js、popup.html、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.31 (2026-05-17)

- 优化：图片正则提取逻辑从 background.js 移至 SharedUtils.extractImagesByRegex，content 和 background 共用同一实现；fetcher.js DOMParser 失败时回退到共享正则提取而非独立简版正则
- 优化：同源 TXT 附件优先 content 直连 fetch，跨域走 background 代理；同源直连无结果时自动回退 background fallback，保持缓存和资源合并语义不变
- 修复：LRU 淘汰优先级排序方向反转，负缓存优先级最高（3）却最后淘汰；改为降序排列，优先淘汰低价值缓存
- 修复：setupObserver 重试定时器回调后未置 null，禁用时 observerRetryCount 未重置
- 涉及文件：shared-utils.js、background.js、fetcher.js、cache.js、content.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.30 (2026-05-17)

- 修复：负缓存过期读取时不删除 storage key，条目无限累积；改为过期时主动 remove
- 修复：`evictLRU` 和 `getCacheStats` 不统计负缓存条目；改为纳入计数和淘汰（最低优先级）
- 修复：`setupObserver()` 找不到容器时 500ms 无限重试无退避无上限；改为指数退避 + 最大 20 次 + 存储定时器 ID + 禁用时清除
- 修复：Loader `visibilitychange` 监听在禁用当前页时不移除；新增 `removeGlobalVisListener()` 由 `disableCurrentPage()` 调用
- 修复：`background.js` onInstalled 旧缓存清理用硬编码基础前缀；改为引用 `SharedUtils.CACHE_PREFIXES.*_BASE`
- 修复：Previewer 大图加载失败只显示破碎图标；新增 onerror 处理显示"加载失败"提示
- 涉及文件：cache.js、content.js、loader.js、background.js、previewer.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.29 (2026-05-17)

- 修复：heavy 模式下视口懒加载路径点击缩略图预览时只显示受限子集图片，改为使用 `sourceCandidates` 以预览全部候选图
- 修复：Previewer close() 不移除 keydown 监听器，改为 open/close 配对管理；避免第二次打开后 Esc/方向键失效
- 修复：Logger flush 定时器在插件停用后仍运行，改为可控启停；初始加载时若插件已禁用则不启动定时器
- 修复：`contain-intrinsic-size` 硬编码 190px 与非默认行数/行高不匹配导致滚动跳动，改为 renderer 动态计算
- 修复：Popup 缓存清除使用硬编码前缀，改为引用 `SharedUtils.CACHE_PREFIXES`；同时覆盖旧版本前缀遗留键
- 修复：负缓存 TTL 恢复为独立 5 分钟短周期，不与 `cacheTTL` 联动
- 修复：手动重试失败缩略图绕过并发控制且可双击并发，改为 `acquireSlot` 守卫；获取失败时恢复 onclick 让用户可再次点击，获取成功后才清空 DOM 进入重试
- 修复：`contain-intrinsic-size` shorthand 单值影响宽度估算，改为 `contain-intrinsic-height: auto <height>` 仅提示高度
- 涉及文件：viewport-observer.js、previewer.js、logger.js、content.js、content.css、renderer.js、loader.js、popup.html、popup.js、shared-utils.js、cache.js、manifest.json、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.28 (2026-05-15)

- 修复：defaults.js 使用 `window.ATP_DEFAULTS` 在 MV3 Service Worker 中抛出 `ReferenceError: window is not defined`，导致后台脚本启动失败，影响跨域抓取和 TXT 附件读取；改为 `globalThis.ATP_DEFAULTS`
- 涉及文件：manifest.json、defaults.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，vm.runInNewContext 模拟 Service Worker 环境验证通过
- Breaking change：无

## 1.13.27 (2026-05-15)

- 修复：fetcher.js 网络异常（AbortError/TypeError/离线）不再写入负缓存，避免超时或断网导致帖子 5 分钟内被跳过
- 修复：页面隐藏/关闭时提前 flush 缓存，增加 `visibilitychange` 和 `pagehide` 监听，减少对 `beforeunload` 的依赖
- 修复：缓存 flush 节流从 2000ms 缩短到 1000ms，loadedUrls 更及时持久化
- 修复：`flushPendingData()` 改用 `ATPCache.flushCacheNow()` 正确清空 pending 状态，避免页面切换后缓存刷新被跳过
- 优化：background.js 正则扫描时间保护从 100ms 调到 250ms，降低超大 HTML 漏图风险
- 清理：defaults.js 包裹 IIFE，消除 `getDefaultsFromSchema` 全局泄漏
- 涉及文件：manifest.json、fetcher.js、content.js、cache.js、background.js、defaults.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.26 (2026-05-14)

- 新增：设置项“重图优化”，默认开启
- 优化：检测到 `image.imx.to` 等高分辨率重图候选时，每帖只加载一行代表图，减少原图解码和滚动重绘压力
- 优化：重图优化仅影响本次渲染/加载数量，文章缓存仍保留完整候选列表，避免破坏缓存语义
- 涉及文件：manifest.json、settings-schema.js、renderer.js、loader.js、content.css、content.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.25 (2026-05-14)

- 优化：扫描阶段默认跳过 `stickthread_*` 置顶帖和“版块主题”分隔线之前的管理/版务区域，减少无效抓取
- 优化：补充版务关键词过滤，跳过新人必看、问题专贴、通知教程、服务大厅、发布器、白名单等非资源主题
- 新增：设置项“跳过置顶/版务帖”，默认开启，可在需要处理置顶资源帖时关闭
- 涉及文件：manifest.json、settings-schema.js、scanner.js、content.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.24 (2026-05-14)

- 安全：popup.js 日志渲染 e.src/e.lv 补 `esc()` 转义；renderHelpFromSchema 和 renderSettingsGroup 全部动态插值统一转义
- 安全：floating-panel.js 新增 `_esc()` 方法，_renderField/_renderHelp/_renderSettings/_createPanel 所有动态插值统一转义
- 安全：resource-panel.js 新增 `esc()` 函数，renderThread/renderInline 中 textResourceMessage、data-type、label、count 等动态插值统一转义
- 可靠性：cache.js 关键 `chrome.storage.local.set` callback 检查 `chrome.runtime.lastError`，失败时 Logger.warn 记录
- 可靠性：logger.js flush 的 set callback 检查 `chrome.runtime.lastError`，失败时 `console.warn`（避免递归写日志）
- 可靠性：background.js BGLOG flush 的 set callback 检查 `chrome.runtime.lastError`，失败时 `console.warn`
- 涉及文件：manifest.json、popup.js、floating-panel.js、resource-panel.js、cache.js、logger.js、background.js、使用说明.md、CHANGELOG.md、PROJECT_OVERVIEW.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.23 (2026-05-14)

- 修复：文章缓存写入按缓存 key 串行化，`setCachedArticleData()` 与 `updateArticleLoadedUrls()` 写入前重新读取并合并，避免 TXT 补齐资源和 loadedUrls 交叉覆盖
- 修复：线程因连续失败暂停后，后续图片加载成功会自动清除 `paused` 并恢复调度
- 涉及文件：manifest.json、cache.js、loader.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.22 (2026-05-14)

- 优化：scanner 支持按调用方过滤候选并在收集到足够视口附近帖子后提前停止，避免长列表页后段帖子被前段候选截断
- 修复：资源面板启用判断接入 `ATPConfig.loaded`/`ATPConfig.isEnabled()`，与主流程初始化状态一致
- 修复：popup "清除图片缓存" 改为 "清除文章/图片缓存"，并且不再清除 TXT 资源缓存，避免按钮语义和实际行为不一致
- 清理：移除 `SharedUtils.TEXT_RESOURCE_CACHE_PREFIX` 死常量，统一使用 `SharedUtils.CACHE_PREFIXES.TEXT_RESOURCE`
- 涉及文件：manifest.json、scanner.js、content.js、resource-panel.js、shared-utils.js、popup.html、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.21 (2026-05-12)

- 优化：scanner 移除 50 条硬截断，content 侧视口过滤 + 小批量处理控制压力，避免长列表页视口附近帖子被截断
- 重构：缓存前缀常量集中到 `SharedUtils.CACHE_PREFIXES`，`cache.js` 和 `background.js onInstalled` 共用同一份定义，后续升级前缀只需改一处
- 修复：`ATPConfig.loaded` 初始化状态，`isEnabled()` 在设置未加载完毕前返回 false，避免提前启动扫描
- 清理：移除 `logger.js` 中无实际作用的 `unload` 事件监听
- 涉及文件：manifest.json、shared-utils.js、cache.js、scanner.js、config.js、background.js、logger.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.20 (2026-05-12)

- 修复：文章缓存语义分离，`images` 固定保存完整候选图片列表（含 source），新增 `loadedUrls` 独立存储已加载 URL 子集，避免 `flushCacheNow`/`beforeunload` 用已加载子集覆盖完整候选列表
- 修复：`fetcher.js` 提取 HTML 后立即缓存文章数据，不再仅对无图片帖子缓存，消除含图片帖子页面关闭前缓存缺失
- 新增：`ATPCache.updateArticleLoadedUrls()` 专门方法，只合并写入 `loadedUrls`，不改 `images`
- 重构：TXT 附件常量（`TEXT_ATTACHMENT_MAX_COUNT`/`BYTES`/`TIMEOUT`）和 `TEXT_RESOURCE_CACHE_PREFIX` 统一到 `SharedUtils`，消除 `fetcher.js` 和 `background.js` 中的重复定义
- 修复：popup 帮助面板补渲染"维护"分组（缓存清理按钮说明），此前因 schema 无此分组而被静默跳过
- 修复：`detectAndProcess` 保存 setTimeout 引用并在停用/卸载时清理，避免残留回调
- 修复：`sendMessage` 外层补 try/catch 并清理 timeout，避免同步异常导致 15s 定时器泄漏
- 涉及文件：manifest.json、shared-utils.js、cache.js、fetcher.js、background.js、content.js、renderer.js、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：文章缓存前缀从 `article_cache_v7_` 升级到 `article_cache_v8_`，旧文章缓存不兼容，会重新抓取

## 1.13.19 (2026-05-12)

- 优化：滚动期间扫描改为延迟触发，并统一节流到 1200ms，减少快速滚动时的 DOM 查询压力
- 优化：缩略图面板增加 `content-visibility: auto` 和固有尺寸提示，降低离屏面板绘制成本
- 优化：动态图片设置 `decoding="async"`，减少图片解码阻塞滚动的概率
- 涉及文件：manifest.json、content.js、content.css、loader.js、viewport-observer.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.18 (2026-05-12)

- 修复：无图片、无资源或权限受限的帖子会在本页会话内标记为已处理，避免小批量扫描反复处理同一批空结果帖子导致后续帖子不继续加载
- 涉及文件：manifest.json、content.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.17 (2026-05-12)

- 优化：视口预取范围从 1200px 放宽到 2000px，每轮处理帖子数从 3 个增加到 5 个，减少高图片密度页面加载到一半停住的情况
- 涉及文件：manifest.json、content.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.16 (2026-05-12)

- 优化：扫描时只处理视口附近帖子，并将每轮处理数量限制为 3 个，降低高图片密度板块滚动卡顿
- 优化：MutationObserver 忽略插件自己插入的缩略图、图片和资源按钮 DOM，避免自触发重复扫描
- 修复：TR 模式下已插入缩略图行的帖子不再重复进入扫描队列
- 涉及文件：manifest.json、content.js、scanner.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.15 (2026-05-11)

- 修复：资源栏从帖子缩略图区移动到右侧复制按钮时不再立即清空或回退，增加 hover 延迟保持和侧栏自身 hover 保持
- 涉及文件：manifest.json、resource-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.14 (2026-05-11)

- 修复：双态模式下 TXT 异步补齐不再在 mouseleave 后重新弹出侧栏，updateThread 改为仅刷新当前/固定/悬停中的线程
- 优化：popup schema 动态渲染支持未知分组，新增分组自动追加到已知组之后
- 涉及文件：manifest.json、resource-panel.js、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.13 (2026-05-11)

- 优化：侧栏断点 1280px → 1024px，减少窄屏时强制隐藏侧栏的场景
- 优化：onInstalled 在 install 也触发旧缓存清理（首次安装无副作用）
- 优化：scanner 收集到 100 条结果后提前退出，避免大量 DOM 节点时无意义扫描
- 涉及文件：manifest.json、content.css、background.js、scanner.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.12 (2026-05-11)

- 新增：资源栏鼠标悬停临时查看，点击固定（Pin），离开回退到固定帖或清空
- 涉及文件：manifest.json、resource-panel.js、content.css、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.11 (2026-05-11)

- 重构：popup 设置 UI 从硬编码改为 `SETTINGS_SCHEMA` 动态渲染，新增设置项仅需修改 schema，不再需要同步修改 HTML 和 JS
- 涉及文件：manifest.json、popup.html、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.10 (2026-05-11)

- 修复：页面关闭前刷新缓存时保留 TXT 附件列表，避免文章缓存丢失 `textAttachments`
- 修复：Content Script 与 Service Worker 日志改用独立 storage key，popup 合并展示，避免并发写入 `atp_logs` 互相覆盖
- 修复：跨域抓取默认图片上限统一为 100，避免漏传参数时退回 15
- 修复：HTML 实体解码支持 U+FFFF 以上字符，TXT 附件提取不再依赖 `this` 调用上下文
- 优化：失败占位不再整段覆盖 wrapper inline style；视口懒加载 slot 等待改为退避重试
- 优化：缓存 LRU 淘汰按图片、TXT 资源、文章缓存分级；后台图片正则扫描增加体积和时间保护；悬浮面板 CSS 加载失败时隐藏面板
- 涉及文件：manifest.json、content.js、cache.js、logger.js、background.js、popup.js、shared-utils.js、loader.js、viewport-observer.js、floating-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.13.9 (2026-05-11)

- 新增：资源栏在资源来自 TXT 附件时显示 `含 TXT 提取`，对应分类计数显示 `· TXT`
- 修复：正文和 TXT 中重复出现的同一链接按 URL 去重，只保留一条并合并来源为 `html+txt`
- 更新：文章缓存前缀升级为 `article_cache_v7_`，TXT 资源缓存前缀升级为 `txt_resource_cache_v2_`，负缓存前缀升级为 `atp_empty_v8_`，避免旧缓存缺少来源标记
- 涉及文件：manifest.json、shared-utils.js、resource-panel.js、content.css、cache.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，正文/TXT 重复链接去重和来源合并回归测试通过
- Breaking change：旧文章缓存和旧 TXT 资源缓存不兼容，会重新抓取以写入来源标记

## 1.13.8 (2026-05-11)

- 修复：`forum.php?mod=attachment...` 可能先返回 HTML 中转页，再由页面内链接/脚本跳到 CDN TXT；现在会从中转 HTML 里提取真实 `.txt` 下载地址并二次读取
- 涉及文件：manifest.json、shared-utils.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，HTML 中转页 TXT URL 提取回归测试通过
- Breaking change：无

## 1.13.7 (2026-05-11)

- 修复：同源 TXT 附件链接跳转到 `dl.ldkms.la` CDN 后，content script 直连可能被跨域重定向限制拦截，导致已识别附件但解析不到资源
- 更新：TXT 附件读取优先统一交给 background；background 无结果时再尝试同源直连回退
- 更新：文章缓存前缀升级为 `article_cache_v6_`，负缓存前缀升级为 `atp_empty_v7_`，避免复用旧的临时签名附件 URL
- 涉及文件：manifest.json、fetcher.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，TXT 附件后台优先路径回归测试通过
- Breaking change：无

## 1.13.6 (2026-05-11)

- 修复：帖子 TXT 附件真实下载地址位于 `dl.ldkms.la` CDN 时，附件已识别但 background 权限/白名单拒绝抓取，导致显示“识别到 TXT 附件 1 个，但未解析到资源链接”
- 更新：新增 `https://dl.ldkms.la/*` host permission，并且仅允许该域名下路径以 `.txt` 结尾的附件参与 TXT 资源读取
- 更新：文章缓存前缀升级为 `article_cache_v5_`，负缓存前缀升级为 `atp_empty_v6_`，避免复用旧的过期签名附件 URL
- 涉及文件：manifest.json、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，本地下载 TXT 可解析出 4 条 ED2K，CDN TXT 允许规则回归测试通过
- Breaking change：新增 host permission，需重新加载扩展后生效

## 1.13.5 (2026-05-11)

- 修复：Discuz 附件下载 URL 藏在 `onclick`、脚本属性或非 `href` 位置时仍可能无法识别 TXT 附件
- 新增：资源栏会显示 TXT 附件识别/解析状态，用于区分“未识别到附件”和“识别到附件但 TXT 内未解析到链接”
- 更新：文章缓存前缀升级为 `article_cache_v4_`，负缓存前缀升级为 `atp_empty_v5_`，避免旧空结果继续命中
- 涉及文件：manifest.json、shared-utils.js、cache.js、background.js、renderer.js、resource-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，raw attachment URL 识别和状态文案回归测试通过
- Breaking change：旧文章缓存不兼容，会重新抓取帖子以识别 TXT 附件

## 1.13.4 (2026-05-11)

- 修复：Discuz 附件文件名和真实下载链接分离时，TXT 附件仍可能漏识别；新增附件块上下文兜底匹配
- 修复：部分 PHP 下载接口可能返回 `text/html` Content-Type 但正文是纯 TXT，现在只按正文是否像 HTML 判断是否跳过
- 更新：文章缓存前缀升级为 `article_cache_v3_`，负缓存前缀升级为 `atp_empty_v4_`，避免刚才失败识别结果继续命中缓存
- 优化：资源栏在 TXT 附件异步读取期间显示 `TXT 资源解析中`
- 涉及文件：manifest.json、shared-utils.js、cache.js、fetcher.js、background.js、resource-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，分离式 Discuz TXT 附件识别和缓存前缀回归测试通过
- Breaking change：旧文章缓存不兼容，会重新抓取帖子以识别 TXT 附件

## 1.13.3 (2026-05-11)

- 修复：TXT 附件文件名或文件类型信息不在 `<a>` 标签内部时可能漏识别
- 修复：旧 `article_cache_v1_`、旧图片缓存 fallback 或旧负缓存可能阻止帖子重新抓取，导致新增 TXT 附件解析能力不生效
- 更新：文章缓存前缀升级为 `article_cache_v2_`，负缓存前缀升级为 `atp_empty_v3_`；升级时清理旧文章缓存和旧失败缓存
- 涉及文件：manifest.json、shared-utils.js、cache.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，Discuz 附件块 TXT 识别和缓存前缀回归测试通过
- Breaking change：旧文章缓存不兼容，会重新抓取帖子以识别 TXT 附件

## 1.13.2 (2026-05-11)

- 优化：TXT 附件资源读取改为渲染后异步补齐，帖子图片和正文资源不再等待 TXT 下载完成
- 新增：文章数据保留 TXT 附件列表，缓存命中后仍可继续异步补齐附件资源
- 更新：跨域后台抓取返回 TXT 附件列表，并新增 `FETCH_TEXT_RESOURCES` 用于异步读取跨域 TXT 附件
- 涉及文件：manifest.json、cache.js、fetcher.js、background.js、content.js、renderer.js、resource-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，文章数据附件保留和 TXT 资源缓存回归测试通过
- Breaking change：无

## 1.13.1 (2026-05-11)

- 新增：TXT 附件资源解析结果缓存，缓存期内复用已提取的资源和密码，避免重复下载同一附件
- 更新：缓存统计、LRU 淘汰、清除图片缓存、清除全部缓存和一键清空缓存均覆盖 `txt_resource_cache_`
- 涉及文件：manifest.json、shared-utils.js、cache.js、fetcher.js、background.js、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，TXT 附件缓存回归测试通过
- Breaking change：无

## 1.13.0 (2026-05-11)

- 新增：识别帖子正文中的 `.txt` 附件链接，每帖最多读取 3 个可访问文本附件
- 新增：从 TXT 附件内容中提取 ED2K、磁力、网盘链接、提取码和解压密码，并合并到资源栏
- 保护：TXT 附件读取限制单文件 512KB，遇到权限页、登录页、购买页、Cloudflare 拦截或 HTML 响应时静默跳过
- 涉及文件：manifest.json、shared-utils.js、fetcher.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，TXT 附件识别与资源合并回归测试通过
- Breaking change：无

## 1.12.8 (2026-05-11)

- 修复：`fetchArticleData` 在 HTTP 失败、非 HTML、登录重定向和 Cloudflare 拦截路径下返回 `[]`，导致列表处理访问 `.images.length` 时中断
- 涉及文件：manifest.json、fetcher.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过
- Breaking change：无

## 1.12.7 (2026-05-11)

- 修复：`mailto` 密码还原的前缀拼接过宽，避免把其他字段或旧文本中的 `1998` 拼到 `www.98T.la@`
- 修复：支持 `<a href="mailto:www.98T.la">...</a>@` 还原为 `www.98T.la@`
- 涉及文件：manifest.json、shared-utils.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，`1998 + mailto`、`mailto + @`、完整 mailto 和编码 mailto 回归测试通过
- Breaking change：无

## 1.12.6 (2026-05-11)

- 修复：ED2K 文件名中的 Cloudflare `__cf_email__` 邮箱保护会导致同一链接被文本版和 HTML 版重复提取
- 修复：资源扫描不再直接扫描整段原始 HTML，改为扫描页面文本和 `href` 属性，避免把 `<a ...>` 标签拼进 ED2K 链接
- 修复：资源归一化时按 URL 去重，避免旧缓存或重复数据导致资源数量虚高
- 修复：复制通用信息时兜底过滤 `...`、`……` 等无效解压密码占位值，兼容旧缓存中的错误密码
- 涉及文件：manifest.json、shared-utils.js、resource-panel.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，Cloudflare 邮箱保护 ED2K 去重和 `...` 密码过滤回归测试通过
- Breaking change：无

## 1.12.5 (2026-05-11)

- 修复：解压密码显示为 `...` 时，优先从字段附近的 `mailto`、`title`、`data-*` 属性还原真实密码
- 修复：支持未加引号的 `href=mailto:...` 和编码形式 `mailto%3A...%40...`
- 修复：过滤 `...`、`……`、`-` 等无效密码占位值，避免复制到通用信息
- 涉及文件：manifest.json、shared-utils.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，`...` 占位和 mailto/title/data 属性还原回归测试通过
- Breaking change：无

## 1.12.4 (2026-05-11)

- 新增：popup 维护区增加“一键清空缓存”按钮，用于测试时一次清理文章缓存、旧图片缓存、失败缓存和诊断日志
- 保留：一键清空缓存不会清除用户设置、站点禁用和悬浮窗位置
- 涉及文件：manifest.json、popup.html、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，清理 key 过滤规则检查通过
- Breaking change：无

## 1.12.3 (2026-05-11)

- 修复：`mailto:` 密码使用 `%40`、`&#64;`、`&commat;` 编码时无法还原真实 `@`
- 修复：过滤 `[email protected]` / `[email protected]` 论坛邮箱保护占位值，避免复制无效密码
- 涉及文件：manifest.json、shared-utils.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，`%40` / `&#64;` / `&commat;` / 前缀加 `mailto:` 回归测试通过
- Breaking change：无

## 1.12.2 (2026-05-11)

- 修复：解压密码字段附近的 `mailto:` 链接可还原为真实密码，例如 `1998` + `mailto:www.98T.la` 还原为 `1998@www.98T.la`
- 修复：HTML 密码提取优先于纯文本密码提取，避免论坛邮箱保护导致复制 `[email protected]`
- 涉及文件：manifest.json、shared-utils.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，mailto 密码还原回归测试通过
- Breaking change：无

## 1.12.1 (2026-05-11)

- 修复：解压密码字段带 `【】`、`[]`、`（）` 等包裹符时，复制结果残留 `] :` 前缀
- 修复：密码值清理保留 `@`、`!@#$` 等特殊符号，不因邮箱样式或符号截断
- 涉及文件：manifest.json、shared-utils.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，带包裹符密码提取回归测试通过
- Breaking change：无

## 1.12.0 (2026-05-11)

- 新增：从帖子 HTML 提取 ED2K、磁力、百度网盘、夸克网盘、阿里云盘、115 网盘等资源链接
- 新增：右侧“本帖资源”栏，按类型显示数量并支持复制单类或复制全部链接
- 新增：复制网盘链接时附带提取码，复制资源时可附带解压密码并保留特殊符号
- 新增：无图片但有资源链接的帖子也可显示资源面板
- 更新：文章缓存升级为 `article_cache_v1_`，缓存 `{ images, resources }` 数据结构，旧图片缓存仍兼容读取
- 更新：popup 和悬浮窗新增资源栏显示、复制时附带密码设置
- 涉及文件：manifest.json、settings-schema.js、shared-utils.js、cache.js、fetcher.js、background.js、content.js、renderer.js、loader.js、resource-panel.js、content.css、popup.html、popup.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，模拟 HTML 资源提取通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.6 (2026-05-11)

- 修复：视口懒加载和手动重试路径绕过域名熔断器，补充 success/failure 记录
- 修复：loader 暴露 shouldSkipDomain / recordDomainSuccess / recordDomainFailure 供跨模块调用
- 修复：视口懒加载增加二次 shouldSkipDomain 检查，覆盖入队后域名被熔断的时间窗口
- 修复：视口懒加载 shouldSkipDomain 时调用 threadImageDone(false)，避免线程状态卡死
- 新增：background onInstalled 更新时清理不带 v2 前缀的旧缓存
- 涉及文件：manifest.json、loader.js、viewport-observer.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：node --check 语法检查通过，manifest.json 解析通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.5 (2026-05-11)

- 修复：全局停用后当前页立即清理缩略图、队列、Observer 和悬浮窗
- 修复：enabled 设置变更触发当前标签页刷新，避免停用状态残留
- 修复：自动重试不再留下旧失败占位并追加新 wrapper
- 修复：手动重试成功后同步加载状态和缓存
- 修复：首屏全失败的帖子也标记为已处理，避免重复抓取
- 修复：后台 pending 满时的重试 timer 纳入统一清理，并补齐直接调度时的重试安排
- 修复：后台懒加载 DOM 已清理后不再继续加载脱离页面的 wrapper
- 修复：加载状态分母改为首屏/总数语义，避免 boolean 参与计算
- 涉及文件：manifest.json、popup.js、content.js、loader.js、viewport-observer.js、CHANGELOG.md、PROJECT_OVERVIEW.md、使用说明.md
- 验证：静态语法检查通过，manifest.json 解析通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.4 (2026-05-04)

- 优化：pending 满时暂停 idle 调度，500ms 后重试，避免空转
- 涉及文件：manifest.json、loader.js、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.3 (2026-05-04)

- 优化：后台懒加载限制 wrapper/Observer 数量，每轮最多出队 10 个，pending 上限为并发数 × 3
- 优化：pending 满时暂停 idle 调度，避免空转
- 修复：retryLoadImage 成功路径增加空值保护
- 文档：PROJECT_OVERVIEW.md 目录结构补齐拆分模块
- 涉及文件：manifest.json、loader.js、viewport-observer.js、PROJECT_OVERVIEW.md、使用说明.md、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.2 (2026-05-04)

- 修复：缓存 key 冲突，新增 normalizeArticleUrl 处理文章 URL，缓存前缀升级为 v2
- 修复：懒加载失败路径 loadingEl 为 null 导致 TypeError
- 修复：pauseWhenHidden 设置未生效，关闭后隐藏标签页不再暂停
- 修复：已处理 TR 仍被重复扫描，增加 classList.contains 检查
- 修复：scanner 多 selector 匹配同一元素，增加 Set 去重
- 修复：后台懒加载绕过并发控制，新增 acquireSlot/releaseSlot 接口
- 修复：跨域图片提取能力弱，补齐 data-original/data-src/srcset/img-src/link 规则
- 移除：scripting 权限（未使用）
- 涉及文件：manifest.json、shared-utils.js、cache.js、loader.js、scanner.js、viewport-observer.js、background.js、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：缓存前缀升级，旧缓存不兼容，建议清除缓存

## 1.11.1 (2026-05-04)

- 修复：isArticlePageUrl 检查逻辑反了，导致所有帖子链接被跳过（致命）
- 修复：恢复 Discuz! 专用图片提取逻辑（zoom[file]、data-original、data-src、srcset）
- 修复：重复 URL 导致冗余抓取，allUrls.push 移入去重条件内
- 修复：LRU 缓存淘汰改为计数器节流（每 50 次写入检查一次），避免 O(n²) 性能问题
- 修复：roundRobinSchedule 使用 filter 重建数组，避免 splice 原地修改问题
- 修复：beforeunload 中调用 previewer.destroy()
- 涉及文件：manifest.json、content.js、fetcher.js、cache.js、loader.js、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.11.0 (2026-05-04)

- 新增：图片预览器，点击缩略图弹出大图查看器，支持左右切换、键盘导航
- 优化：后台加载使用 requestIdleCallback，不与用户交互争抢 CPU，不支持时降级为 setTimeout
- 优化：LRU 缓存淘汰，限制缓存条目上限 500，超出时淘汰最久未使用
- 涉及文件：manifest.json、loader.js、viewport-observer.js、cache.js、previewer.js（新建）、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.10.0 (2026-05-04)

- 新增：域名级熔断器，同域名连续失败 5 次后暂停 2 分钟，避免图床故障拖慢全局
- 新增：缩略图视口虚拟化，后台图片使用 IntersectionObserver 懒加载，减少 DOM 节点
- 新增：免刷新热重载，修改布局参数后即时生效，无需刷新页面
- 涉及文件：manifest.json、content.js、loader.js、viewport-observer.js（新建）、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.9.3 (2026-05-04)

- 重构：content.js 模块化拆分为 scanner.js、cache.js、loader.js、renderer.js、fetcher.js、config.js
- 优化：每帖独立队列 + 轮询调度，首屏阶段各帖子并行出图，而非 FIFO 串行
- 优化：防饥饿机制，帖子连续失败 3 次后暂停该帖子
- 涉及文件：manifest.json、content.js、scanner.js（新建）、cache.js（新建）、loader.js（新建）、renderer.js（新建）、fetcher.js（新建）、config.js（新建）、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.9.2 (2026-05-04)

- 优化：MutationObserver 监控范围收窄至帖子容器，减少 90%+ 无意义回调
- 优化：图片加载失败显示占位符，支持点击重试
- 优化：URL 规范化（去除非必要 query 参数），提升缓存命中率
- 涉及文件：manifest.json、content.js、shared-utils.js、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.9.1 (2026-05-04)

- 重构：popup 帮助文本从 SETTINGS_SCHEMA 动态生成，删除硬编码 HTML
- 重构：defaults.js 从 SETTINGS_SCHEMA 生成默认值，保留 enabled/siteConfigs 特殊字段
- 重构：BGLOG API 统一为 debug/info/warn/error，与 Logger 一致
- 涉及文件：manifest.json、defaults.js、background.js、popup.js、popup.html、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.9.0 (2026-05-04)

- 重构：创建 shared-utils.js 共享模块，统一 resolveUrl、isMeaningfulImage、isBlockedPage、extractOgImage
- 重构：content.js 和 background.js 改用 SharedUtils，删除重复函数定义
- 修复：backgroundSpeed 无法从 popup 配置 → 添加 UI 控件和绑定
- 修复：ALLOWED_ORIGINS 硬编码 → 改为内联判断，与 manifest.json host_permissions 保持一致
- 涉及文件：manifest.json、content.js、background.js、popup.js、popup.html、shared-utils.js（新建）、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.8.5 (2026-05-04)

- 修复：isMeaningfulImage width/height 参数从未传递 → 移除无效参数，简化函数签名
- 修复：beforeunload 未 flush 待持久化的图片缓存 → 遍历 CACHE_FLUSH_PENDING 强制写入
- 修复：登录重定向/HTTP错误/Cloudflare拦截未设置负缓存 → 添加 setNegativeCache() 调用
- 修复：GET_SETTINGS 消息处理器死代码 → 删除未使用的消息处理分支
- 修复：updateStatus() 空方法 → 删除无效方法
- 修复：content.css 未使用样式 → 删除 .atp-thumbnail-error 和 .atp-tooltip-* 相关样式（约 43 行）
- 修复：btn-reset 刷新逻辑未使用 getNeedRefresh → 改用 getNeedRefresh(key) 判断
- 涉及文件：manifest.json、content.js、background.js、floating-panel.js、content.css、popup.js、CHANGELOG.md
- 验证：静态语法检查通过，未完成浏览器实际加载
- Breaking change：无

## 1.8.4 (2026-05-04)

- 修复：popup checkbox 使用 .value 而非 .checked → 统一用 `els[id].type === 'checkbox'` 判断
- 修复：popup.js 因缺少 #backgroundSpeed 元素中断 → 移除 ids 数组和 bind 调用中的 backgroundSpeed
- 修复：background.js 默认值重复定义 → 使用 `importScripts('defaults.js')` 引用统一默认值
- 修复：popup 无差别刷新页面 → 从 SETTINGS_SCHEMA 读取 immediate 字段判断是否需要刷新
- 修复：popup.html 未加载 settings-schema.js → 添加 script 引用
- 修复：popup.js LIMITS 死代码 → 删除未使用的 LIMITS 对象
- 修复：content.js extractImages O(n²) 去重 → 使用 seen 对象 O(1) 去重
- 修复：页面卸载时资源未清理 → 添加 beforeunload 清理 scroll 监听器、floatingPanel.destroy()
- 修复：floating-panel CSS 加载失败静默忽略 → 添加 console.error 日志
- 新增：.gitignore 文件
- 删除：过时的项目总结.txt（v1.3.2）
- 更新：使用说明.md 版本号
- 涉及文件：manifest.json、popup.js、popup.html、background.js、content.js、floating-panel.js、.gitignore（新建）、使用说明.md、CHANGELOG.md、PROJECT_OVERVIEW.md
- 验证：静态检查，未完成浏览器实际加载
- Breaking change：无

## 1.8.3 (2026-05-04)

- 修复：版本号硬编码不一致 → popup.js/content.js 使用 `chrome.runtime.getManifest().version`，popup.html 改为 JS 动态注入
- 修复：cookies 权限未使用 → 从 manifest.json 删除
- 修复：activeTab 权限冗余 → 从 manifest.json 删除
- 修复：initFloatPanel 无错误处理 → 添加依赖检查和 try-catch
- 修复：事件监听器未清理 → floating-panel.js 添加 `_listeners` 数组、`_addListener()`、`destroy()` 方法
- 修复：fcp 无效事件 → 从 USER_EVENTS 数组删除
- 修复：废弃 API substr → substring (content.js:395)
- 修复：Popup 无条件刷新页面 → saveSettings(needRefresh) 参数化，清除缓存不再刷新
- 修复：设置默认值重复定义 → 创建 `defaults.js`，popup.js/content.js 引用 `ATP_DEFAULTS`
- 修复：content.js Object.assign 污染默认值 → 改为 `Object.assign({}, ATP_DEFAULTS, ...)`
- 技术债标注：两套独立日志系统（logger.js vs background.js BGLOG）
- 涉及文件：manifest.json、popup.js、popup.html、content.js、floating-panel.js、defaults.js（新建）、logger.js、background.js、CHANGELOG.md、PROJECT_OVERVIEW.md
- 验证：静态检查确认变更落地，未完成 Edge 实际加载
- Breaking change：无
- 剩余风险：需在 Edge 中验证所有修复点

## 1.8.0 (2026-04-28)

- 重构悬浮窗：拆出 `floating-panel.js`、`floating-panel.css`、`settings-schema.js`
- 引入 Shadow DOM（`mode: 'open'`）隔离悬浮窗 UI 样式
- 设置项由 `SETTINGS_SCHEMA` 统一驱动，设置视图和帮助视图从 schema 生成
- 类名从 `atp-` 迁移至统一前缀 `bfp-`
- 保留原有 launcher、设置分组、帮助面板、参数校验、单项重置、保存提示
- 错误输入有视觉反馈（红色边框 + 抖动动画）
- 非法输入不回退、不保存
- 设置保存后统一提示可刷新或立即生效
- `content.js` 移除 ~280 行悬浮窗代码，通过 `FloatingPanel` 类 + adapter 接入
- `content.css` 移除 ~260 行悬浮窗样式
- 新增 `web_accessible_resources` 使 floating-panel.css 可被 fetch 注入 Shadow DOM
- 涉及文件：`settings-schema.js`（新建）、`floating-panel.js`（新建）、`floating-panel.css`（新建）、`content.js`（重构）、`content.css`（精简）、`manifest.json`（新增引用）
- 验证：大括号匹配检查通过，未实际浏览器加载
- 风险：需在浏览器中验证缩略图功能不回退，Shadow DOM 隔离不影响现有交互

## 1.8.1 (2026-04-28)

- 修复：保存设置覆盖非 schema 字段（enabled、siteConfigs）→ `setSettings` 合并旧值
- 修复：Shadow DOM 内点击输入框/select 误关闭面板 → 改用 `composedPath()` 判断
- 修复：任意设置保存都触发刷新 → 按 `changedKey` 判断该设置 `immediate` 标记
- 修复：启动日志仍输出 `v1.7.0` → 同步为 `v1.8.1`
- 恢复：误删的 `使用说明.md` 从 git 恢复
- 新增：`PROJECT_OVERVIEW.md`
- 涉及文件：`floating-panel.js`、`content.js`、`manifest.json`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`
- 验证：
  - `manifest.json` JSON 解析通过
  - 静态检查确认 1.8.1 修复点已落地
  - 未完成 Edge 实际加载验证
- Breaking change：无
- 剩余风险：仍需在 Edge 中验证悬浮窗交互、设置保存不丢字段、页面刷新逻辑、缩略图功能

## 1.8.2 (2026-04-28)

- 修复：帮助视图从面板内切换改为独立并排面板
- 点击 `?` 不再隐藏设置面板，改为在设置面板旁边打开独立帮助面板
- 用户可一边查看参数说明，一边直接修改设置值
- 主面板拖动时帮助面板实时跟随重新定位
- 帮助面板超出视口时自动贴边，不溢出
- 关闭主面板同时关闭帮助面板，关闭帮助面板不影响主面板
- 外部点击同时检查主面板和帮助面板
- 涉及文件：`floating-panel.js`、`floating-panel.css`、`manifest.json`、`content.js`、`CHANGELOG.md`、`PROJECT_OVERVIEW.md`、`使用说明.md`
- 验证：静态检查确认变更落地，未完成 Edge 实际加载
- Breaking change：无
- 剩余风险：需在 Edge 中验证并排帮助面板的显示、定位、关闭行为
