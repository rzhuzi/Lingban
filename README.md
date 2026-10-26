<img src="assets/images/icon.png" width="88" height="88" alt="零伴图标">

# 零伴 · Lingban

简体中文 · [English](README.en.md)

[![CI](https://github.com/rzhuzi/Lingban/actions/workflows/ci.yml/badge.svg)](https://github.com/rzhuzi/Lingban/actions/workflows/ci.yml)

一个可以自定义角色、记忆和模型的 Android AI 聊天应用。

**0.1.1 · 公开测试版。** Android APK 与校验和见 [0.1.1 发布页](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1)。需要自行配置兼容的模型接口和 API Key，模型调用费用由相应服务商收取。

## 功能

- **角色整套配置**：名字、人设、头像、封面、记忆、模型和提示词一起保存，切换角色即可使用。
- **模型管理**：支持 DeepSeek、Kimi、百炼、智谱连接模板和自定义兼容接口，可获取模型列表、搜索选择和测试连接。
- **日常聊天**：流式回复、停止生成、失败重试、可展开的服务端思考内容，以及聊天历史与搜索。
- **提示词配置**：普通提示词、可编辑的第三方指令预设，以及限定端点/型号的官方思考前缀配置。
- **本地数据**：保存聊天和角色资料，提供聊天 JSON 导出及本机数据清理。
- **黑白界面**：浅色、深色和跟随系统。

## 开始使用

1. 从 [0.1.1 发布页](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1) 下载 Android APK，核对校验和及安装说明后安装；也可按下方“本地开发”自行构建。
2. 打开右上角菜单，进入“模型库”，添加接口地址与自己的 API Key。
3. 获取并选择可用模型，使用“测试连接”检查配置。
4. 打开“角色与记忆”，选择或新建角色，绑定模型并保存。
5. 回到聊天页开始对话。初次使用可保持思维配置“关闭”，人设和记忆仍会参与请求。

连接模板不代表所有型号都完成联调；第三方指令为实验性文本，详见[模型与提示词说明](docs/COMPATIBILITY.md)。

## 数据与隐私

Android 的聊天和配置保存在本机，API Key 使用系统安全存储。发起对话时，相关人设、记忆、历史消息和本次输入会发送给你配置的模型服务。聊天导出包含正文及请求配置摘要，分享前请检查私人内容。

完整说明见[数据与隐私](PRIVACY.md)。

## 本地开发

需要 Node.js 22.13 或更新版本；Android 调试还需要 JDK 和 Android SDK。

```sh
git clone https://github.com/rzhuzi/Lingban.git
cd Lingban
npm ci
npm run android
```

Web 可用于界面预览，API Key 仅在当前页面会话内保留：

```sh
npm run web
```

```sh
npm run lint
npm run typecheck
npm test
```

构建、签名与开发约定见[开发指南](docs/DEVELOPMENT.md)，版本变化见[更新日志](CHANGELOG.md)。

## 当前限制

- 仍在测试阶段；真实设备和各服务商账号的兼容性需要继续验证。
- 大量历史消息的分页与搜索优化尚未完成。
- 未发送的草稿按会话和角色分别保存在当前运行内存中，关闭应用后不恢复。
- 官方思考前缀和第三方格式标记有各自适用条件，不能保证任意模型支持。
- 聊天导出不是全量配置备份，当前没有对应的导入恢复功能。

反馈可提交到 [Issues](https://github.com/rzhuzi/Lingban/issues)，请按[贡献指南](CONTRIBUTING.md)提供复现步骤，并移除 API Key 和私人聊天内容。

## 许可

项目代码沿用 MIT 许可，保留原 Expo 模板版权声明。资源与依赖说明见 [NOTICE](NOTICE.md) 和 [LICENSE](LICENSE)。
