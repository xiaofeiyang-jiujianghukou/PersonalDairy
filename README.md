# 我的日记 (Personal Diary)

一本**只属于你**的、**本地优先 + 多端对等同步**的私人日记。数据永远存你自己的设备,同步是设备↔设备的**点对点 + 增量 + 端到端加密**,没有中心内容服务器。

> 不为建立文件夹目录,不为打分分类。打开就写,写完按「时间」自然回看:
> 今天记了什么、上个月发生了什么、这个月过得怎么样。

## 核心原则

- **数据私有存本地**:每台设备各自存完整一份(电脑 = 本机 SQLite / 文件,手机 = IndexedDB),日记内容只在你自己的设备上。
- **多端对等同步**:电脑、手机是**对等终端**;设备之间**点对点**互相同步,按时间取新合并,**无内容服务器**。
- **增量 + 加密 + 自动**:只传"自上次同步以来的改动",用量小;同步负载 **AES-256-GCM 端到端加密**;打开/保存后**自动同步**。
- **被动情绪小结**:AI 在你写完文字后归纳月度情绪小结,你无需额外操作。
- 零负担记录:不建目录、不打分、不分类,只有自由 Markdown。

## 当前功能

- 写日记(默认今天,Markdown,**块式编辑器**保留换行与缩进,一天可记多条)
- 插入图片(粘贴 / 选文件;**内容寻址 `diary-img:<hash>`** 存储,两端一致、离线可显示)
- 「今天 / 日历 / 搜索」三种回看方式;按月小结
- **AI 月度情绪小结** —— 已做成**独立服务端接口 `/api/summarize`**(自包含、可部署/上云;纯文字用 deepseek-v4-pro、含图自动切视觉模型)
- **AI 陪伴对话** —— 顶栏「陪伴」,AI 读过你最近写下的日记陪你聊天、安抚心情;服务端接口 `/api/companion`(自包含、可部署,不落盘内容)
- **多端同步** —— 扫码配对 → **双向、增量、端到端加密、自动**同步
- **数据备份 / 迁移包** —— 设置里一键**导出/导入**全部日记+图片为单个文件(可选口令 AES-256 加密),支持手机↔手机迁移,或电脑服务端备份
- 全文搜索(LIKE 子串,个人量级永远够用)、一键导出 Markdown / JSON
- **手机端可安装 APK**(Capacitor 打包;本地优先,离线可写)

## 一键启动

```bash
# Windows:双击 start.bat      Linux/macOS:./start.sh     或命令行: pnpm app
./start.sh            # 启动 + 自动打开浏览器 http://localhost:4520
./start.sh stop       # 停止
./start.sh restart    # 重启(先停再启,重新构建)
./start.sh status     # 查看是否运行
```
要求 **Node.js ≥ 22.5**。首次会自动 `pnpm install`;之后秒开,数据在仓库 `data/` 目录(可用 `DIARY_DATA_DIR` 改)。

> 开发模式:`pnpm dev`(前端 5173 + 后端 4520,热更新)。

## 配置 AI(可选)

复制 `.env.example` 为 `.env`,填模型密钥。**不填也能用**,小结降级为占位提示。

```env
AI_PROVIDER=openai-compatible       # 豆包/DeepSeek/Qwen 通用(OpenAI 兼容)
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=你的密钥
AI_TEXT_MODEL=deepseek-v4-pro        # 纯文字(无图)
AI_VISION_MODEL=deepseek-v4-flash-vision-exp  # 含图自动切视觉模型
AI_THINKING=disabled
```
AI 供应商可插拔(见 `apps/server/src/ai/provider.ts`)。

## 多端同步怎么用

1. **电脑端**:`./start.sh` 启动;浏览器打开,点顶栏「配对」→ 显示二维码。
2. **手机端**:重装 APK(本地优先)→「配对」→「扫描电脑二维码」→ 完成配对(二维码含同步密钥)。
3. 之后**自动**双向增量加密同步;电脑、手机各自留存一份,谁写都能同步到另一台。

> 跨网络(手机流量)需一个**加密连接器**(Tailscale / 你自建中继),属可选附件,只转发密文、不存储你的数据。

## 数据 & 密钥

- 数据默认在仓库 `data/`(`diary.db` + `images/` + `uploads/`),已 gitignore,升级不丢;可用 `DIARY_DATA_DIR` 改位置。
- 同步密钥存电脑 `data/synckey` + 手机 localStorage,扫码配对时建立;同步负载 AES-256-GCM 加密,仅两端能解。
- AI 密钥在 `.env`,不入库、不进 Git。

## 云端部署(可选)

> 架构原则:服务端只持**账号身份 + 加密中继/AI**,不存日记内容。用下面的 `CLOUD_MODE=1` 一键满足。

```bash
# 在阿里云 ECS(装好 Node ≥ 22.5)上:
git clone <repo> && cd <repo> && pnpm install
CLOUD_MODE=1 PORT=3000 pnpm --filter @diary/server start   # 或用 PM2/systemd 常驻
```

- **`CLOUD_MODE=1`**:禁用 `/api/entries|search|images|uploads|export|import|summary|sync|qr`(返回 403),
  只保留 `health` / `auth`(身份)/ `relay`(加密中继)/ `summarize` / `companion`(AI)——**日记内容不上云**。
- **必须 HTTPS**:令牌走 Bearer,中继是端到端加密的,但 token 不能走明文。用 **Nginx 反代 + Let's Encrypt**(`certbot --nginx -d 你的域名`)。
- **安全组**放行 80/443;前端构建烘焙 `VITE_API_BASE=https://你的域名`(端点固定,非用户配置)。
- 健康检查用 **`/api/health`**(带 `/api` 前缀)。

### Mode B:内容只在 PC/手机,云端纯中继/AI
- **两端都本地优先**:手机 App(Capacitor)与桌面端(Tauri,构建烘焙 `VITE_LOCAL_FIRST=1`)数据都存本机。
- **配对**:任一台点「显示配对码」(生成 `diary-sync:<key>`),另一台「扫描二维码」→ 建立同一同步密钥。
- **同步**:经云端 `/api/relay` **加密中继**双向(`A推B取、B推A取、每条只投递一次`),内容端到端加密,服务器只看得到密文。

## 项目结构

```
apps/
  server/          # Node + Fastify(本机即一个终端,暴露自己那份数据 /api/sync + 公共能力 /api/summarize)
    src/ai/        # 可插拔 AI 供应商 + 月度小结
    src/images.ts  # 内容寻址图片(哈希存/读/归一化)
  web/             # React + Vite 前端(桌面浏览器 / 手机 APK 共用;本地优先用 IndexedDB)
  web/android/     # Capacitor 安卓工程(可打 APK)
packages/
  shared/          # 类型契约 + 同步引擎(sync) + 图片协议(images) + 加密(syncCrypto)
start.sh / start.bat  # 一键启停
```

## 技术选型(面向 10 年)

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈 | 一套语言贯穿网页 → 手机(PWA/RN)→ 桌面 |
| 存储 | SQLite(内置)/ IndexedDB | 每终端一份独立本地库,隐私隔离、零原生依赖 |
| 同步 | P2P 增量 + LWW + 墓碑 + 端到端加密 | 无中心服务器、数据只在设备间 |
| 图片 | 内容寻址(SHA-256) | 两端一致、离线可显示、去重 |
| AI | 可插拔适配器 + 独立服务端接口 | 换模型不重写;可单独部署/上云 |

## 路线图

- [x] v1:单机日记 + AI 月小结 + 内容寻址图片 + 一键启停
- [x] v2:多端**本地私有 + 点对点**同步(增量、加密、自动、扫码配对)+ 手机端 APK
- [ ] **三端协作(电脑端 / 服务端 / 手机端)**:微信式"手机扫码登录电脑端",服务端负责**加密传输 & AI 通信**,同网络点对点互传 —— 见 `docs/THREE_TIER.md`
- [x] v2.5:P1 账号鉴权(username+password)+ 微信式扫码登录(手机号/微信预留)+ P2 服务端加密中继(`/api/relay`,点对点不可达时自动降级经中继)
- [x] **AI 陪伴对话**(`/api/companion`,读过你的日记陪你聊;公共能力、服务端可部署、不落盘)
- [x] 手机↔手机迁移(设置里**导出/导入迁移包**,可选口令加密,合并 LWW)
- [ ] 手机↔手机在线对传(设备间直连,跳过中继)
- [ ] 跨网络"加密连接器"(Tailscale / 自建中继,可选)
