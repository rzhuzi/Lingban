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

eas.json 提供生成 APK 的 preview profile。维护者配置自己的 Expo 项目和签名后可执行：

```sh
npx eas-cli@latest build --platform android --profile preview
```

这会使用 EAS 云端服务并可能要求登录、创建项目与管理签名，属于单独的发布操作。具体版本的构建方式与验证范围以对应 GitHub Release 说明为准。

本地构建可先运行 `npx expo prebuild --platform android --no-install`，再使用生成目录中的 Gradle。Windows 遇到 CMake 路径长度限制时使用较短路径和物理依赖副本，避免构建目录通过 junction 混用其他项目依赖。

公开 APK 应先确定专用发布签名并离线备份。Expo 生成的本地工程默认可能把 release 指向 debug 签名，不能据此视为已完成公开发布准备。密钥及凭据不提交 Git。签名改变会影响已安装内部测试包的覆盖升级，发布前需确认迁移方案。

构建后使用 scripts/verify-android-bundle.cjs 检查 sourcemap 中 React、React Native、Expo 和 Safe Area 是否各一份，并核对包名、版本、证书和 APK 对齐。

参考：[Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)、[APK 构建](https://docs.expo.dev/build-reference/apk/)、[应用签名](https://docs.expo.dev/app-signing/app-credentials/)。

## 版本与基线

本仓库以内部 0.7.1 的源码为基线，来源提交为 `b6d50609120013877a39acf00b468ba6e7b4a996`；业务源码与数据格式沿用该基线。当前公开版本为 0.1.1，Android versionCode 为 15，包名保持 com.lingban.app。

0.1.0 是仅提供源码的历史测试版，没有对应 APK。0.1.1 的安装包与校验和见 [GitHub Release](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1)。当前本地自动回归为 387 项通过，lint 与类型检查通过；安装、升级、真机交互和真实模型账号验证应单独记录，不能由自动检查推定完成。

内部仓库保留完整开发历史，本仓库从新的本地初始提交开始，不携带旧阶段报告、安装包或旧 Git 历史。数据迁移及相关测试保留，不能按“旧版本残留”删除。
