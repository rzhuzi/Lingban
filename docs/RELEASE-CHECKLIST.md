# 0.1.1 安装包发布核对

0.1.1 已通过现有仓库 https://github.com/rzhuzi/Lingban 正式发行。发布入口为 [v0.1.1](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1)，提供 ARM64-v8a 和通用版两个下载选项，以下按实际完成情况核对。

## 已有源码基线

- [x] 从内部 0.7.1 提取业务源码、图标与现有回归。
- [x] 统一显示版本、npm 与 lock 根版本为 0.1.0，Android versionCode 为 14。
- [x] 排除旧 Git 历史、阶段报告、本机配置、Expo 示例资源与重置脚本。
- [x] 保留数据迁移、旧审计读取及其回归，保护数据兼容性。
- [x] 整理使用、隐私、兼容性、开发、许可与反馈材料。

以上为 0.1.0 源码整理结果，历史本机检查见[本地整理记录](LOCAL-PREPARATION.md)。0.1.0 没有构建或发布 APK，不应把旧内部安装包改名作为该版本产物。

## 源码协作

- [x] 维护者创建同名 GitHub 仓库并授权上传源码。
- [x] 准备完整中英文 README、Issue 和 PR 模板。
- [x] 配置 Ubuntu/Windows 的自动 lint、类型检查与回归测试。
- [x] 启用 GitHub 私密漏洞报告，并更新 SECURITY。

## 0.1.1 代码与材料

- [x] 修复首次发送及页面切换中的草稿丢失，按会话和角色隔离当前运行中的草稿。
- [x] 修复临时模型编辑残留、历史会话中的角色切换，以及思考展开和流式跟随行为。
- [x] 为独立模型编辑页添加未保存离开保护，并加粗右上角导航菜单文字。
- [x] 本地自动回归 387 项通过，lint 与类型检查通过。
- [x] 更新中英文 README、变更记录、兼容性与发布入口说明。
- [x] 最终核对应用、npm 和 lock 根版本均为 0.1.1，Android versionCode 为 15。

## 构建、签名与发布

- [ ] 确认 assets/icons/ 的来源和再分发授权，参见 NOTICE。
- [x] 按维护者选择生成专用发布签名，在仓库外保存本机签名与可迁移恢复备份；已说明不能覆盖内部 0.7.1 测试包，卸载会清除数据。
- [x] 检查提交身份、待推送内容和密钥扫描结果。
- [x] 从本仓库冻结输入，构建实际显示为 0.1.1/code15 的 APK。
- [x] 检查 sourcemap 依赖单例、包名、版本、专用发布签名和 16 KB APK 对齐，计算 SHA256。
- [ ] 真机确认安装、模型配置、连续聊天、角色切换、重启保留数据和导出。
- [ ] 为公开页面准备不含私人内容的真实界面截图。
- 源码协作入口：[PR #1](https://github.com/rzhuzi/Lingban/pull/1)。合并和必需的双平台 CI 结果以该 PR 为准。
- 版本标签、APK、校验和及签名/升级说明：[v0.1.1 发布页](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1)。公开状态以发布页为准。

## 安装包与验证记录

- ARM64-v8a：`lingban-0.1.1-arm64-v8a.apk`，供支持 64 位 ARM 的安卓设备使用。
- 通用版 Universal：`lingban-0.1.1-android.apk`，包含四种架构；保留原文件名和下载链接。

两个包功能相同，选择一个安装即可。ARM64-v8a 的构建验证记录、文件大小与校验和以 [v0.1.1 发布页](https://github.com/rzhuzi/Lingban/releases/tag/v0.1.1) 为准；以下为已完成的通用版核验记录。

- 文件：`lingban-0.1.1-android.apk`，107,685,827 字节。
- 包名：`com.lingban.app`；显示版本 `0.1.1`，versionCode `15`，最低 Android API `24`。
- CPU 架构：arm64-v8a、armeabi-v7a、x86、x86_64。
- APK SHA256：`4e14fada0cdd97fe159be78deaef7bdc6208cc465edb6f805864cda503f1e984`。
- 发布证书 SHA256：`a7006c46131a75f9c9aaec11703b7709fdff6bdfe8c0761a429744db0c0f1aa5`；v2、v3 签名验证通过。
- Gradle Release 构建、四项依赖单例、版本/证书及 16 KB zip alignment 校验通过。

发布说明必须区分自动检查、构建产物校验和真实设备验收范围。未执行的检查保留未完成状态，不移动已经公开的 v0.1.0 标签。
