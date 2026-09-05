# 我的日记 (Personal Diary)

一本**只属于你**的、本地优先、越记越懂你的私人日记。

> 不为建立文件夹目录,不为打分分类。打开就写,写完按「时间」自然回看:
> 今天记了什么、上个月发生了什么、这个月过得怎么样。

## 设计原则

- **零负担记录**:不建目录、不打分、不分类,只有自由文字(Markdown)。
- **按时间生长**:日记天然按天、按月组织,时间轴 + 日历回看。
- **被动情绪小结**:AI 在你写完文字后自动归纳月度情绪小结,你不需要额外做任何动作。
- **隐私是底线**:数据只存在你自己的设备上,只有你能看,无账号、无分享。

## 功能(v1)

- 写日记(默认今天,支持 Markdown,一天可记多条)
- 插入图片(粘贴或选择文件),回看时直接显示
- 「今天 / 日历 / 搜索」三种回看方式
- AI 月度情绪小结(可插拔供应商,被动生成,自动缓存)
- 全文搜索(LIKE 子串,对你这个量级永远够用)
- 一键导出全部日记为 Markdown / JSON
- 数据本地存储(SQLite,Node 内置引擎,零原生依赖)

## 快速开始

要求:**Node.js ≥ 22.5**(本项目使用 Node 内置的 `node:sqlite`)。

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式(前端热更新 + 后端热重载)
pnpm dev
# 前端: http://localhost:5173  (自动代理 /api 到后端)

# 3. 生产模式(单进程,前后端一起伺服)
pnpm build
pnpm start
# 打开: http://localhost:4520
```

### 配置 AI(可选)

复制 `.env.example` 为 `.env`,填写你的模型密钥。**不填也能用**,只是情绪小结会显示占位提示。

```env
# 任选其一(都是 OpenAI 兼容接口):
#   豆包 Doubao:  AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
#   DeepSeek:     AI_BASE_URL=https://api.deepseek.com
#   通义 Qwen:    AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=你的密钥
# 纯文字模型(无图时使用) / 视觉模型(含图时自动切换)
AI_TEXT_MODEL=deepseek-v4-pro
AI_VISION_MODEL=deepseek-v4-flash-vision-exp
AI_THINKING=disabled
```

AI 供应商是**可插拔**的:实现 `AiProvider` 接口即可换模型,业务代码零改动
(见 `apps/server/src/ai/provider.ts`)。

### 数据存在哪

默认 `~/.local/share/personal-diary/diary.db`,与代码仓库分离,升级不丢数据。
可用 `DIARY_DATA_DIR` 环境变量改到任意位置。

## 项目结构

```
apps/
  server/          # Node + Fastify 后端(内置 node:sqlite,零原生依赖)
    src/ai/        # 可插拔 AI 供应商 + 月度情绪小结
  web/             # React + Vite 前端
packages/
  shared/          # 前后端共享的类型与 API 契约(唯一事实源)
```

## 技术选型(面向 10 年)

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈 | 一套语言贯穿网页 → 手机(PWA/RN) → 桌面(Tauri) |
| 存储 | SQLite(内置) | 每用户一份独立库,隐私隔离;零原生依赖、易迁移 |
| 搜索 | LIKE 子串 | 个人日记体量(十年≈几千条)永远够用,行为直观 |
| AI | 可插拔适配器 | 换模型不重写业务;将来可换本地模型 |

## 路线图

- [ ] **v1(当前)**:单机本地日记 + 月度情绪小结
- [ ] AI 陪伴对话:基于你自己的全部记录,能安慰、开导你
- [ ] 移动端:PWA → 原生 App,随时随地记
- [ ] 多端端到端加密同步:授权后才开,同步后数据仍以加密态落在本地
