# 手机端 / 多端同步路线图

> 目标设备:华为 Mate70(HarmonyOS 4.3.0,兼容安卓 APK)
> 目标形态:**手机本地存数据 + 多端同步**(数据在自己手里,像微信一样)

## 一、当前已完成(本仓库内)

- 前端已做**移动端适配**:窄屏布局、≥42px 触控目标、刘海/挖孔屏安全区(`env(safe-area-inset-*)`)、去双击缩放延迟。
- 已具备 **PWA 可安装外壳**:`manifest.webmanifest`、三个尺寸图标(由 `scripts/make-icons.mjs` 生成)、保守版 Service Worker(`sw.js`,只缓存带 hash 的 `/assets/*`,不碰 `/api`;仅在 https/localhost 安全上下文下注册)。
- 验证:构建后 `/manifest.webmanifest`、`/icons/*.png`、`/sw.js` 均正常伺服。

## 二、必须认清的硬约束(为什么"装到手机"这步要分机器)

| 事项 | 状态 |
|---|---|
| 编译 Android APK | 需要 Android SDK + Gradle;**本开发沙箱无 SDK、且无法访问外网**,编译不出 APK |
| PWA 真正"可安装 + 离线" | 需要 **HTTPS**(安全上下文);本地局域网 HTTP 只能当网页用 |
| 手机访问本机 | 需手机与该主机在同一网络,或主机可被公网/隧道访问 |
| 鸿蒙原生 App | 需 DevEco Studio + ArkTS,且仅适配鸿蒙 NEXT;当前是鸿蒙 4.3 用不到 |

**结论**:本仓库能把"代码 + 打包配置"全部就绪;真正产出 APK / 部署 HTTPS,需要在你的一台**具备 Android SDK 的电脑**(或一台常开服务器)上执行,步骤见下文。

## 三、两条可落地路径

### 路径 A:PWA 网页 App(最快,今天可用)

适合"电脑开着、手机连同一 Wi-Fi"时使用;或部署到一台 HTTPS 主机后彻底可安装。

1. 电脑上启动日记服务(生产模式):`pnpm build && pnpm start`,监听 `0.0.0.0:4520`。
2. 手机与电脑连**同一 Wi-Fi**;手机浏览器打开 `http://<电脑局域网IP>:4520`。
   - 查电脑 IP:`hostname -I`(选非 172/192.168.250 桥接网段那个)。
3. 在浏览器菜单选「**添加到主屏幕 / 添加到桌面**」,即可像 App 一样从桌面进入(图标已就绪)。
4. 想要**真正的可安装 PWA + 离线**:把服务挂到一台 **HTTPS** 主机(自建或云),或给局域网配 HTTPS。

> 局限:此形态数据存在电脑端;手机是客户端。符合"多端同步"的**过渡阶段**。

### 路径 B:Capacitor 打包安卓 APK(需要一台装了 Android Studio 的电脑)

在**具备 Android SDK / Android Studio 的电脑**上,于本仓库目录执行:

```bash
# 1) 构建前端(产物在 apps/web/dist)
pnpm install && pnpm build

# 2) 在 web 包内引入 Capacitor
cd apps/web
pnpm add @capacitor/core
pnpm add -D @capacitor/cli @capacitor/android

# 3) 初始化并生成安卓工程(会生成 android/ 目录)
npx cap init "我的日记" "com.yourname.diary" --web-dir=dist
npx cap add android

# 4) 同步前端产物并构建 APK
npx cap sync
cd android && ./gradlew assembleDebug
# 产物: android/app/build/outputs/apk/debug/app-debug.apk
```

把 APK 传到 Mate70(鸿蒙 4.3 兼容安卓)安装即可。

> 说明:数据库在手机端需要一个本地存储。短期可用 Capacitor SQLite 插件复用同一套 SQLite 代码;APK 内嵌本地 Web 服务方案另见同步架构。

## 四、"手机本地数据 + 多端同步"架构设计(路线图主干)

原则:**本地优先(Local-first)、每设备独立存储、授权后才同步、传输/落盘加密**。

### 1. 数据模型改造(同步就绪,建议尽快做)

当前 `entries.id` 是自增整数,多设备各自自增必然撞号。要同步必须先改:

- `id`:改为 **UUID**(v4),全局唯一;
- 增加 `deleted_at`(可空):删除不真删,写墓碑(tombstone)以便传播;
- `updated_at` 已有;同步合并采用**每条目最后写入者胜出**(按 `updated_at`,必要时加设备时钟偏置补偿);
- 图片:文件以内容哈希命名 + 引用,同步时按需传输;
- `summaries`(月度小结):属于派生数据,**不参与同步**,各设备可依据本地条目重新生成。

### 2. 同步协议(设计)

- 锚点:每设备记录「上次成功同步的条目时间戳集合」;
- 增量交换:设备 A 把 `updated_at > 锚点` 的条目(含墓碑)发给 B;B 合并(按 updated_at 取新),回传自己的增量;
- 冲突:同一条目两边都改 → 按 updated_at 胜出;可后续升级为字段级合并/CRDT;
- 传输通道:同网直连(手机 ↔ 电脑 HTTP)或经中继(未来,如自建小服务器 / Tailscale 类组网);中继只见密文。

### 3. 加密(隐私是底线)

- 每条日记正文落盘用**设备主密钥**(AES-256-GCM)加密;
- 多端同步时,条目用**端到端密钥**加密后传输,授权新设备时通过既有设备交换密钥(或用户输入口令派生的恢复密钥);
- 图片一并加密存储与传输。

### 4. 分期实施

| 阶段 | 内容 | 交付 |
|---|---|---|
| ① 已做 | 移动端 UI 适配 + PWA 外壳 | 手机浏览器可用 |
| ② 数据模型 | entries 改 UUID + 墓碑 + updated_at | 为同步打地基(改动小,建议尽早) |
| ③ 手机可用 | 路径 A 让 Mate70 用上(电脑当主机或 HTTPS 部署) | 今天/近期 |
| ④ APK | 在带 Android SDK 的机器跑路径 B | 可安装软件 |
| ⑤ 手机本地 | Capacitor SQLite 本地库 + 本地写、后台同步 | 数据在手机 |
| ⑥ 端到端加密 + 中继 | 多端互不同网也能同步,全程密文 | 随时随地 |

## 五、下一步建议

1. 若你要**今天就先用上**:在电脑上 `pnpm build && pnpm start`,手机连同一 Wi-Fi 打开访问(路径 A)。
2. 若你接受为未来打地基:我先实施 **阶段②数据模型改造**(改 UUID/墓碑),这样将来打包 APK、做同步时不用返工。
3. APK 与 HTTPS 部署:需要你在具备 Android SDK 的电脑 / 一台常开服务器上执行(沙箱无此条件)。
