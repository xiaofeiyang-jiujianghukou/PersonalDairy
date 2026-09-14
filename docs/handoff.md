# 交接文档：同步链路与桌面端疑难问题

> 用途：把当前项目里**尚未解决**与**已解决但有坑**的问题、以及我掌握的全部证据移交出来。
> 版本：0.16.58（提交 `5056c4a`）。项目路径 `/home/xiaofeiyang/AIWorkSpace/PersonalDairy`。

---

## 一、项目架构（先读这段，能省一小时）

**产品**：本地优先的私人日记「我的日记」。多终端：Tauri 桌面端（Linux deb）、Capacitor 安卓 APK、iOS 已生成工程未上架。

**铁律（用户明确要求，不可违背）**：
1. **日记内容只存在终端上**。服务端**不保存任何日记内容**，只做加密中转。
2. 端到端加密：同步密钥由 `deriveSyncKey(密码, uid)`（PBKDF2 150k）派生，任何设备同账号同密码得到同一把钥匙，服务端无法解密。
3. 服务端**不承担存储**：消息投进收件方信箱，**取走即删**；服务端只保留「账号的多端状态」。
4. 同步模型是**纯时间区间协商**，协议里**没有游标**（历史上有过，见第三节复盘）。
5. **所有终端必须保持同版本**：链路里任何一端过旧，都可能成为瓶颈（已真实发生过两次）。

**同步链路（当前实现）**：
```
写入端: 本地落盘 → broadcastDelta(把增量投进其它端的信箱) + notify(广播水位/向量/条目数)
接收端: WebSocket 推 {type:'wake'} → 取走自己的信箱(/api/relay/mbox) → 解密 → 按 id 做 LWW 合并
对账:   登录/重连/回前台 → hello 交换水位向量 → 缺哪段就 need(origin, 我的, 他的] → 对方 serveRange 补传
主端:   水位最新者；相同则先登录者（用户规则原话）
唤醒:   WebSocket 为主；断线由 25s 服务端 JSON 心跳 + 客户端 45s 看门狗发现并重连
收件:   每设备信箱（Redis LIST），原子取出（Lua LRANGE+LTRIM），取走即删，7 天 TTL 兜底
```

**Redis 只剩两项**：`trans:{uid}:reg`（多端状态）、`trans:{uid}:mbox:{device}`（未取走的信）。

---

## 二、尚未解决的问题（**核心，请优先看**）

### 现象
手机写一条日记 → **桌面端永远收不到**，两端条数从此分叉。

### 现场证据（全部来自电脑端本地日志，读法见第四节）
```
16:37:28.067 [sync:536bb952] hello 水位=...15:43:43  向量={...,"14c2b856":"2026-09-14T15:43:43.807Z",...}  主端=536bb952
16:37:28.104 [sync:536bb952] ✖ 取件 drainMailbox: Cannot read properties of undefined (reading 'id')
16:37:28.104 [sync:536bb952]   ↳ 抛出物类型: object | 字段: [] | 原始值: {}
16:37:28.121 [sync:536bb952] ✖ 取件 drainMailbox: Cannot read properties of undefined (reading 'id')
```
更早一轮（电脑端主动索取时）：
```
16:35:35.612 need 14c2b856 origin=14c2b856 区间(2026-09-14T15:43:43.807Z, 2026-09-14T16:29:24.565Z]  ← 索取正确
16:35:35.644 ✖ 取件 drainMailbox: Cannot read properties of undefined (reading 'id')   ← 26ms 后炸
16:35:35.644 同步结束:合并 0 条
```
服务端看到的状态（证明服务端与网络都没问题）：
```
手机 14c2b856  条目=43  水位=2026-09-14T16:29:24.565Z  在线
电脑 536bb952  条目=42  水位=2026-09-14T15:43:43.807Z  在线
```

### 已排除的可能（都做过实验，别再重复）
| 假设 | 实验 | 结论 |
|---|---|---|
| 服务端没投递 | 探针调用 `/api/relay/need` 索取手机区间 | `reachable=true delivered=true` —— **服务端投进手机信箱了** ✅ |
| 数据过大 | 探针打印请求体 | **235 字节** —— 无关 ✅ |
| 手机被系统冻结 | 用户确认「一直打开着、没息屏」 | 排除 ✅ |
| 手机版本旧、无兜底 | 用户报版本 `0.16.43`，20:44 后已升级 | 该因素已消除，问题依旧 ✅ |
| Tauri HTTP 插件（`@tauri-apps/plugin-http`）在大响应上崩 | 改成 `globalThis.fetch` | **报错完全没变** ✅（因为 **Tauri v2 会把 `window.fetch` 整个替换成插件实现**，写 `globalThis.fetch` 拿到的还是插件） |
| 同上，改用 XHR 彻底绕开插件 | `drainMailbox` 改成 `XMLHttpRequest` | **报错依然一模一样** ✅ |
| 是普通异常、有堆栈可查 | `fail()` 里记录 `e.stack` 前两帧 | **堆栈为空** ✅ |
| 抛出物是某个库的错误对象 | 记录 `typeof` / `Object.keys` / `JSON.stringify` | **`object` / 字段 `[]` / `{}`** —— 一个**空对象被抛出** ✅ |

### 关键矛盾（最值得pro注意的地方）
1. **同一个 `need` 请求走同一个 transport 成功了**（`16:35:35.612` 那行 need 没报错），
   而紧接着的 `drainMailbox` 就炸 —— 两者只差 URL 与 HTTP 方法（need=POST 无 query，mbox=GET 带 query）。
2. 报错**发生在调用后 26~33ms**，像一个真实的网络往返（本机到云端约 20~40ms），
   说明**请求已经发出去了**，是**响应处理阶段**抛的。
3. 但抛出物是**空对象、无堆栈**，而且 `drain()` 里的 `catch` 位置在 `transport.drainMailbox` 调用上，
   `const msgs = page.messages ?? []` 之类的代码**在 try 之外**。

### 建议下一步（我未做完的排查）
1. 在 `drain()` 里把 `page` 原样打印（`JSON.stringify(page).slice(0,500)`）—— 看服务端到底回了什么。
2. 把 `transport.drainMailbox` 换成**最小复现**：在浏览器控制台/独立页面直接 `fetch('/api/relay/mbox?...')`，看是否同样抛空对象。
3. 检查 `/api/relay/mbox` 的**响应头/状态码**（是否被 nginx 拦截、是否 200 但 body 异常）。
4. 怀疑方向：**服务端 `/api/relay/mbox` 返回体里某个字段**触发了 webview 的序列化/解包问题
   （该端点返回 `{ messages: [{seq,kind,from,to,payload}], remaining }`，其中 `payload` 是**加密串**，可能很长）。

### 相关代码位置
- 引擎收件循环：`packages/shared/src/syncEngine.ts` → `async drain()`
- 传输实现：`apps/web/src/api.ts` → `makeEngineTransport()` 里的 `drainMailbox` / `need`
- 服务端端点：`apps/server/src/index.ts` → `app.get('/api/relay/mbox', ...)`
- 服务端信箱：`apps/server/src/relayRedis.ts` → `mboxPush / mboxDrain / mboxLen`

---

## 三、已解决但值得知道的历史坑（避免重蹈）

1. **协议里的"游标"是错误设计**（已彻底删除）
   原方案：共享 Stream + 每端游标。真实故障：服务端会过滤「不是给我的」消息，客户端却用「这一页是否满」判断是否读完 → **游标被钉死在 47，永远追不上**。
   现方案：**每设备信箱，取走即删**，协议里没有位置概念。用户原话：「服务端基本不存消息！取走就删！」

2. **"在线"判定必须是应用层信号**
   协议层 `ws.ping/pong` 由网络栈自动应答，**证明不了 JS 活着**。现方案：客户端每 15s 发 JSON ping，服务端 40s 无则断开 + 独立的 `/api/relay/presence` 心跳（30s）。

3. **半开连接（移动网络必现）不会触发 onclose**
   网络路径静默失效时客户端以为自己还连着 → **重连逻辑永不触发** → 数据永远不来。
   现方案：服务端每 25s 发**客户端可见的** JSON 心跳；客户端 45s 没收到任何东西就主动 close 触发重连。

4. **桌面端（Linux Tauri + WebKitGTK）视频：一整串坑，已全部解决，过程见下**
   - 绿条纹花屏 → **AMD VA-API 硬解码**问题，`main.rs` 里设 `GST_PLUGIN_FEATURE_RANK=avdec_h264:MAX` 强制软解**治本**。
   - "无法播放/黑框" → **Tauri 自定义源 `tauri://localhost` 下 `<video>` 不接受 `blob:` URL**（错误码 4 = `MEDIA_ERR_SRC_NOT_SUPPORTED`）→ 视频一律改用 **data URL**。
   - 播放按钮看不见 → 我给 canvas 设了 `z-index:1`，把按钮盖住了（按钮要有更高 z-index）。
   - **方向随机翻转**（最耗时的坑）→ 日志抓到：**WebKit 随机地把「未旋转的帧」或「已旋转的帧」交给 JS**，而代码对两种情况都统一再转 90° → 已转过的就被转成 180° 倒立。修法：**逐帧归一**——文件标注需要旋转「且」当前帧仍是竖的才转，否则直接铺满；画布尺寸**只依据文件里的 MP4 `tkhd` 矩阵**，绝不信 WebKit 汇报的 `videoWidth/Height`（它会中途变化）。
   - 教训：**先加诊断日志、先复现、再改**。上面每个结论都是拿到证据后才动手的；前六版凭猜测改，全是白费。

5. **桌面端图片/视频全部打不开** → `resolveImageRef/resolveVideoRef` 只在手机模式读本地，桌面端去问服务端，而**服务端不保存内容** → 404。修法：所有平台**先读本机媒体库**。

6. **构建慢** → `Cargo.toml` 里 `lto = true` 是主因（每次都全依赖树全局优化）。关闭 LTO + `codegen-units=16` + `incremental` + 链接器换 `mold`：全量 40s，**日常迭代 3s**。

7. **打包顺序的坑**：`tauri.conf.json` 配了 `beforeBuildCommand: pnpm --filter @diary/web build`，但**手动先 `desktop build` 而没重建前端**时，deb 里会是**旧前端**（我因此白测了两轮）。

---

## 四、环境与排查手法（pro 直接用）

**云端**：`https://bluesheep.vip`（阿里云，nginx 反代 → 后端端口 **3000**，PM2 进程 `diary-server`，部署目录 `/deploy/PersonalDairy`）。
部署：`cd /deploy/PersonalDairy && git pull && pnpm install && pm2 restart diary-server`
账号：`xiaofeiyang / 123456`（uid 数值 **2**）。
真机：手机 `14c2b856-…`、电脑 `536bb952-…`。
> 服务端无 SSH 权限，**所有服务端命令由用户执行**。

**构建**（本机 Linux，Android SDK 与 JDK21 已在仓库根目录 `.android-sdk/`、`.jdk21/`）：
```bash
# 网页
HOME=$PWD/.pnpm-home pnpm --filter @diary/web build
# 安卓
cd apps/web && pnpm exec cap sync android && cd android && \
  JAVA_HOME=$PWD/../../.jdk21/jdk-21.0.12.1+1 ANDROID_HOME=$PWD/../../.android-sdk \
  ./gradlew assembleDebug --no-daemon
# 桌面（必须先 build 前端，或依赖 beforeBuildCommand）
pnpm --filter @diary/desktop build
# 自测（需 redis：docker run -d --rm -p 6399:6379 redis:alpine）
HOME=$PWD/.pnpm-home pnpm --filter @diary/server test:sync   # 46 项
HOME=$PWD/.pnpm-home pnpm --filter @diary/server test:ws     # 19 项
```

**排查手法（这套非常有效，强烈建议保留）**：
1. **前端把关键状态写进 localStorage**，我从磁盘直接读：
   - `diary.synclog`：同步全过程（hello / 索取 / 取件 / 合并 / 报错）
   - `diary.videolog`：视频播放状态变化
   读法：`~/.local/share/com.personaldiary.desktop/localstorage/*.localstorage`（sqlite，`ItemTable`，值是 UTF-16）。
2. **自己复现而不是靠用户描述**：`xdotool` 点击 + `ffmpeg -f x11grab` 截屏（本机 DISPLAY=:0）。
3. **媒体文件可以直接验**：桌面端媒体块在 `~/.local/share/com.personaldiary.desktop/databases/indexeddb/v1/tauri_localhost_0/*/NNN.blob`，用 `ffprobe/ffmpeg` 查编码、旋转矩阵、抽帧比对方向。
4. **探针脚本**：`apps/server` 下临时写 `tsx` 脚本，用同一账号登录后直接调 `/api/relay/*`，能模拟任意终端。
   ⚠️ **探针会在用户账号里留下设备号**（我因此被用户投诉过）——脚本结束务必用 `/api/relay/revoke` 清掉。

---

## 五、用户明确表达的偏好（影响方案选择）

- 界面**极简**：讨厌冗余按钮、讨厌弹窗、讨厌手动操作；能自动化就自动化。
- **数据安全第一**：非常在意丢数据；服务端不得保存内容；丢手机要能"下线"该终端。
- 要**可验证**：喜欢看到版本号、条数、水位、在线状态这类真实数字。
- **先给证据再改代码**：多次强调「仔细排查」「记日志」；反感"没证据就改"。
- 中文交流；会贴终端输出与截图。

---

## 六、当前版本与产物

```
0.16.58   versionCode 100
dist/PersonalDiary_0.16.58_amd64.deb    桌面端
dist/PersonalDiary-0.16.58-debug.apk    安卓端
```
> `dist/` 与安装包**不进 git**（已在 `.gitignore` 显式排除），远端 gitee + github 均已推送。
