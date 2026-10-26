# 开发与构建

## 环境与运行

技术栈为 Expo SDK 58、React Native 0.88、TypeScript 和 Expo Router。使用 Node.js 22.13 或更新版本及 npm；原生 Android 还需要兼容的 JDK、Android SDK 和设备或模拟器。

```sh
npm ci
npm run android
```

`npm run android` 生成原生目录并启动本地调试构建，包含 SQLite、SecureStore 等依赖。原生目录不纳入 Git，新增原生依赖后需要重新构建。

```sh
npm run web
npm run lint
npm run typecheck
npm test
```

Web 是独立存储的预览环境。测试脚本跨平台枚举所有 `scripts/test-*.cjs`，不依赖 shell 展开通配符。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/app/` | Expo Router 路由 |
| `src/features/` | 聊天、角色、模型与设置界面 |
| `src/lib/api/` | 接口地址、模型发现、SSE 与网络请求 |
| `src/lib/chat/`、`src/lib/cot/` | 会话编排与提示词/参数配置 |
| `src/lib/db/`、`src/stores/` | 本地存储、迁移和状态写入 |
| `assets/branding/`、`assets/icons/` | 品牌源图与功能图标 |
| `scripts/` | 回归、图标生成与构建检查 |

运行 `npm run generate:icons` 从 SVG 生成六个图标资源，sharp 为开发依赖。

## Android 安装包与签名

eas.json 提供生成 APK 的 preview profile。配置 Expo 项目和签名后可执行：

```sh
npx eas-cli@latest build --platform android --profile preview
```

这会使用 EAS 云端服务，需要相应的 Expo 账号、项目配置与签名凭据。

本地构建可先运行 `npx expo prebuild --platform android --no-install`，再使用生成目录中的 Gradle。Windows 遇到 CMake 路径长度限制时使用较短路径和物理依赖副本，避免构建目录通过 junction 混用其他项目依赖。

正式发行的 APK 使用专用发布签名。Expo 生成的本地工程可能默认使用 debug 签名，发布前应核对实际证书。签名密钥与恢复凭据需要妥善备份，不提交 Git；后续版本保持相同的包名和发布证书，以支持覆盖升级。

发布证书 SHA256：`a7006c46131a75f9c9aaec11703b7709fdff6bdfe8c0761a429744db0c0f1aa5`。

构建后使用 scripts/verify-android-bundle.cjs 检查 sourcemap 中 React、React Native、Expo 和 Safe Area 是否各一份，并核对包名、版本、证书和 APK 对齐。

0.1.1 提供 ARM64-v8a（`lingban-0.1.1-arm64-v8a.apk`）与通用版（`lingban-0.1.1-android.apk`）两个 APK。前者适用于支持 64 位 ARM 的安卓设备，后者包含 arm64-v8a、armeabi-v7a、x86、x86_64 四种架构。

两种包保持相同的应用版本、versionCode、包名和发布证书，并分别核对实际架构、签名、对齐及 SHA256。下载入口与校验和见 [0.1.1 发布页](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1)，发布前按[发布检查清单](RELEASE-CHECKLIST.md)核对。

参考：[Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)、[APK 构建](https://docs.expo.dev/build-reference/apk/)、[应用签名](https://docs.expo.dev/app-signing/app-credentials/)。

## 版本

当前版本为 0.1.1，Android versionCode 为 15，包名为 `com.lingban.app`。发布新版本时同步更新应用配置、package.json 和 lock 文件中的版本号，并递增 versionCode。

公开版本的产品变化记录在[更新日志](../CHANGELOG.md)。
