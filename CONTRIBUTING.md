# 参与与反馈

报告问题时说明应用版本、Android 版本和设备型号，并提供复现步骤、预期与实际结果。模型相关问题注明厂商、模型 ID、是否流式及提示词模式；不要提供 API Key。

截图、日志、聊天导出和请求审计可能含私人内容，请先脱敏。安全问题见 [SECURITY.md](SECURITY.md)。

修改代码前阅读[开发指南](docs/DEVELOPMENT.md)。请聚焦具体问题，保留用户自定义内容、会话归属、数据迁移和已有测试。调整厂商协议时附官方依据，分别说明本地验证与真实账号联调范围。

提交前运行：

```sh
npm run lint
npm run typecheck
npm test
```

在变更说明中写清具体行为、验证方式及限制，新增资源应注明来源和适用许可。

## GitHub 流程

从 main 创建工作分支，完成修改和本地检查后提交 Pull Request。GitHub Actions 会在 Ubuntu 和 Windows 上运行 lint、类型检查与完整回归；此流程不构建或发布安装包。

一般变更使用 squash merge 合入 main，合并后清理工作分支。发布源代码版本与生成 APK 分开进行，安装包和签名凭据不提交到仓库。

Create a working branch from main, run the local checks and open a pull request. CI runs lint, type checking and regression tests on Ubuntu and Windows without building or publishing an APK. Prefer squash merges and remove merged working branches. Keep installers and signing credentials out of Git.
