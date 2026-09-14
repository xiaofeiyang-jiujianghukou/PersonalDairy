# iOS 版说明（构建 / 上架）

> 现状：iOS 工程已生成并配置好（`apps/web/ios/`），代码层面**同一套**（Capacitor 8 + 同一份 Web 代码 + 同一套同步协议）。
> **但 iOS 只能在 macOS 上用 Xcode 编译打包** —— Linux 上无法产出 `.ipa`。

## 一、必须先具备
| 项 | 说明 |
|---|---|
| **一台 Mac + Xcode**（建议 Xcode 16+） | 编译、签名、上传都只能在这里做 |
| **Apple 开发者账号**（$99/年） | TestFlight 与 App Store 都需要 |
| macOS 上的 Node 20+ 与 pnpm | 用来跑 `cap sync` |

## 二、在 Mac 上的构建步骤
```bash
# 1) 拉代码 + 装依赖
git clone <repo> && cd PersonalDairy
pnpm install

# 2) 构建 Web 产物并同步进 iOS 工程
pnpm --filter @diary/web build
pnpm --filter @diary/web exec cap sync ios

# 3) 打开 Xcode
pnpm --filter @diary/web exec cap open ios
```
在 Xcode 里：
1. **Signing & Capabilities** → 选择你的 Team（自动管理签名）
2. **Bundle Identifier**：默认 `com.personaldiary.app`（若已被占用就改一个，例如 `vip.bluesheep.diary`）
3. 选一台真机或模拟器 → Run
   - 模拟器**没有相机**：拍照/扫码请在真机上测
4. 归档上传：**Product → Archive → Distribute App → App Store Connect**

> 首次在真机上跑需要到「设置 → 通用 → VPN与设备管理」里信任你的开发者证书。

## 三、iOS 与 Android 的差异（已处理/需注意）
| 项 | 处理情况 |
|---|---|
| 页面源 | 已把 `iosScheme` 设为 `http`（与 Android 一致）→ 页面跑在 `http://localhost`，这是**安全上下文**，`navigator.mediaDevices` 才可用 ✅ |
| 权限文案 | `Info.plist` 已写入相机 / 麦克风 / 相册（读+写）的中文用途说明 —— **缺了会直接闪退** ✅ |
| 出口合规 | 已声明 `ITSAppUsesNonExemptEncryption = false`（只用 HTTPS/AES 标准加密）✅ |
| 局域网/明文 | 已允许 `NSAllowsArbitraryLoads`（与 Android 的 cleartext 一致）✅ |
| 版本号 | `MARKETING_VERSION = 0.16.1`、`CURRENT_PROJECT_VERSION = 43`（与 Android 对齐）✅ |
| 相机实现 | **iOS 端目前走 Web 相机**（`getUserMedia`）：应用内拍照/录像、以及扫码都用网页实现（JS 里 `nativeCameraAvailable()` 只在 Android 返回 true）。功能可用，但不如原生顺滑 —— 想要和 Android 一样的原生相机，需要在 Mac 上写一个 Swift 插件（AVFoundation + PHPicker） |
| 后台冻结 | 与 Android 相同：App 进后台后 JS 被系统冻结，消息会**安全地留在信箱里**，回到前台自动对账补齐 ✅ |
| 安全区 | 样式已含 `env(safe-area-inset-*)`，适配刘海与底部小黑条 ✅ |

## 四、App Store 上架检查清单（重要）
1. **账号删除入口**（硬性要求）：只要 App 能注册账号，就必须在 App 内提供**删除账号**的功能。
   目前 App 内有「退出登录」但没有「删除账号」→ **上架前必须补**（我可以加）。
2. **隐私政策 URL** + App Store Connect 的**隐私标签**：
   - 服务器保存：账号信息（用户名/邮箱哈希）、**端到端加密的消息中转**、设备多端状态；
   - **不保存日记内容**（这是我们架构的卖点，务必在隐私说明里写清楚）；
   - AI 功能：调用模型时会话内容会**短暂经过**服务端（不落盘），需在隐私说明中披露。
3. **AI 心理导师的合规风险**（重点）：
   - App Store 对"心理健康类 AI"审核较严，**不能出现诊断/治疗宣称**。
   - 我们已做：提示词写死"不做诊断、不贴标签、不预测、不推荐药物"，危机情况引导到专业帮助与 **12356** 热线，界面上也有同样声明。
   - 建议再加一个**首次使用弹窗**明确"本功能不是医疗服务"，进一步降低被拒风险。
4. **Sign in with Apple**：如果你之后上线「绑定微信登录」，苹果要求**同时**提供 Sign in with Apple；只用自建账号体系则不需要。
5. **测试账号**：审核时需要在 App Store Connect 里提供可登录的测试账号（否则审核员进不去）。

## 五、不想等上架？两条更快的路
| 方式 | 说明 |
|---|---|
| **TestFlight** | 内测分发，最多 1 万测试者；仍需开发者账号，但审核比正式上架快得多 |
| **PWA（今天就能用）** | iPhone 用 Safari 打开 `https://bluesheep.vip` → 分享 → **添加到主屏幕** → 像 App 一样使用（含拍照/扫码，Safari 支持 `getUserMedia`）。零成本、零审核，适合先给朋友试用 |

## 六、建议的推进顺序
1. 先用 **PWA** 让 iOS 用户今天就能用（0 成本验证体验）；
2. 同时办**开发者账号**、准备**隐私政策**与**删除账号**功能；
3. 在 Mac 上跑通 Xcode 构建 → **TestFlight** 内测；
4. 稳定后再提 **App Store** 正式审核；
5. 如果 iOS 用户反馈"相机不够顺" → 再补 Swift 原生相机插件。
