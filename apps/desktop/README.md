# 电脑端 Linux 桌面应用(Tauri)

> 电脑端不再是「`start.sh` 起网页」,而是一个 **Linux 桌面应用**:打开即登录页(微信式),登录后进入日记。
> 前端就是现有 `apps/web` 的构建产物;`src-tauri/` 只是把它包成桌面窗口。

## 结构
```
apps/desktop/
  src-tauri/
    tauri.conf.json      # 指向 ../../web/dist(即 apps/web/dist),窗口与打包设置
    Cargo.toml           # tauri v2 依赖
    build.rs / src/      # Rust 宿主入口
    capabilities/default.json
    icons/               # 生成的图标(32/128/256)
  scripts/gen-icons.mjs  # 重新生成图标
  package.json           # tauri 脚本
  README.md
```

## 前提(在目标 Linux 机器上,一次性)
1. **Rust**:`rustup` 安装 stable 工具链。
2. **系统依赖**(Tauri Linux 前置,Debian/Ubuntu 示例):
   ```bash
   sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev build-essential \
     libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```
3. **Node ≥ 22.5** 已装好。

## 打包
```bash
cd <repo>
pnpm install            # 会拉取 @tauri-apps/cli
# 若要换图标: cd apps/desktop && node scripts/gen-icons.mjs

# 关键:把"服务端地址"烘焙进桌面应用(端点固定,非用户配置)
#   VITE_API_BASE = 云端服务端域名;VITE_LOCAL_FIRST=1 让桌面端本地优先(数据存本机,经中继加密同步)。
#   (本地/测试可把 VITE_API_BASE 改成本机 http://localhost:4520)
cat > apps/web/.env.production <<'EOF'
VITE_API_BASE=https://bluesheep.vip
VITE_LOCAL_FIRST=1
EOF

cd apps/desktop
pnpm build              # = tauri build(先 pnpm --filter @diary/web build,再 cargo build)
```
产物:`apps/desktop/src-tauri/target/release/bundle/{deb,appimage}`。

> `VITE_API_BASE` 会通过 `import.meta.env.VITE_API_BASE` 烘焙进前端;这样桌面应用打开即指向固定服务端,不需要用户再配地址。本地测试填本机;上云填域名。
> 首次 `cargo build` 从 crates.io 拉依赖;若是国内网络,可在 `~/.cargo/config.toml` 加镜像:
> ```toml
> [source.crates-io]
> replace-with = "rsproxy"
> [source.rsproxy]
> registry = "https://rsproxy.cn/crates.io-index"
> [net]
> git-fetch-with-cli = true
> ```

## 登录页流程(桌面应用内,后端已就绪并自测通过)
1. 打开 → 前端发现无 token → 显示 **AuthGate 登录页**;
2. 选「**扫码登录**」→ 调 `POST /api/auth/login-qr` 显示二维码(内容 `diary-login:<qrId>`,轮询 `/api/auth/login-qr/:qrId`);
3. **手机**「扫登录码」→ 确认(调 `POST /api/auth/scan-confirm {qrId}`,带手机 token);
4. 桌面应用轮询到 `confirmed` → 存下 token → 进入日记;
5. 或直接用「用户名 + 密码」登录(两者皆可)。

## 说明
- 桌面端与手机端一样**本地优先**:日记存本机(IndexedDB),云端只做**账号身份 + 加密中继 + AI**(`CLOUD_MODE=1`,不存日记)。
- 两台设备先「显示配对码 / 扫码」建立同一同步密钥,之后经云端**加密中继**双向同步(端到端加密,服务器看不到明文)。
- 未安装 Rust 前无法在本机 `cargo build`;本目录已给出**可构建脚手架**,在有 Rust + 系统依赖的机器上执行上述命令即可出包。
