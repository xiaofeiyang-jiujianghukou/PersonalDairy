# 电脑端 Linux 桌面应用(Tauri)搭建方案

> 电脑端不再是"`start.sh` 起网页",而是一个 **Linux 桌面应用**:**打开即登录页**(微信式),登录后进入日记。
> 前端仍是 `apps/web`(React,已登录门控);Tauri 只是把构建好的前端包成桌面窗口。

## 为什么用 Tauri
- 轻量(不打包 Chromium,用系统 WebView),Linux 单文件小;
- 前端零改动(就是现有的 `apps/web` 构建产物 `dist/`);
- 可打 `.deb` / `.rpm` / AppImage。

## 结构
```
apps/desktop/
  src-tauri/            # Rust(tauri)宿主
    tauri.conf.json     # 指向 ../web/dist,窗口标题,权限
    Cargo.toml
    src/main.rs
    icons/
  package.json          # 打包脚本
```

## 关键配置 `tauri.conf.json`
```jsonc
{
  "productName": "我的日记",
  "identifier": "com.personaldiary.desktop",
  "build": {
    "beforeDevCommand": "pnpm --filter @diary/web dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm --filter @diary/web build",
    "frontendDist": "../web/dist"
  },
  "app": {
    "windows": [{ "title": "我的日记", "width": 900, "height": 700 }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": ["deb", "appimage"] }
}
```

## 打包(在装了 Rust + 系统依赖的机器上)
```bash
pnpm install
# 一次性:创建 tauri 脚手架
cd apps/desktop && pnpm add -D @tauri-apps/cli
npx tauri init --app-name "我的日记" --window-title "我的日记" --frontend-dist ../web/dist --dev-url http://localhost:5173
npx tauri build
# 产物: apps/desktop/src-tauri/target/release/bundle/{deb,appimage,AppImage}
```
> Linux 需系统依赖(`webkit2gtk` 等),见 Tauri 官方 Linux 前置条件;在装好 Rust 的机器上执行。

## 登录页流程(桌面应用内)
1. 打开 → 前端发现无 token → 显示 **AuthGate 登录页**;
2. 选「**扫码登录**」→ 调 `POST /api/auth/login-qr` 显示二维码(内容 `diary-login:<qrId>`,调 `GET /api/auth/login-qr/:qrId` 轮询);
3. **手机**「扫登录码」→ 确认(调 `POST /api/auth/scan-confirm {qrId}` 带手机 token);
4. 桌面应用轮询到 `confirmed` → 拿到 token → 存下 → 进入日记;
5. 或直接用「用户名 + 密码」登录(两者皆可)。

> 后端已就绪并自测通过(`/api/auth/login-qr`、`/api/auth/scan-confirm`、`/api/auth/login-qr/:qrId`);桌面壳按上面配置打包即可。
