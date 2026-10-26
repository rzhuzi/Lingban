# 更新日志

## 0.1.1 — 2026-10-26 · 公开测试版 / Public test release

- 修复首次发送创建会话时丢失后来输入的草稿；会话和角色的新聊天草稿在本次运行中独立保留。
- 修复放弃或替换已编辑的临时模型后，角色配置无法保存的问题。
- 修复从另一角色的历史聊天中选择活动角色后，实际会话未切换的问题。
- 修复手动展开思考后，正文首段到达时被自动收起的问题；主动滚回底部可恢复流式回复跟随。
- 为独立模型编辑页添加未保存离开保护，防止误返回丢失输入。
- 加粗右上角导航菜单中的新建聊天、聊天、历史会话、角色与记忆和设置文字。
- 版本更新为 0.1.1，Android versionCode 为 15；APK、校验和与安装说明通过 GitHub Release 提供。
- 本地自动回归 387 项通过，lint 与类型检查通过；这不代表已完成真机或真实厂商账号验收。

This test release preserves unsent drafts across screen changes, fixes temporary-model saves and persona switching, keeps manually expanded reasoning open, restores streaming follow after deliberate scrolling to the bottom, protects unsaved model edits, and bolds the navigation menu labels. It includes 387 passing automated regression tests; real-device and live-provider validation remain separate.

## 0.1.0 — 源码测试版 / Source preview

- 整合聊天、角色整套配置、人设记忆、模型管理、提示词、历史及数据管理功能。
- 统一黑白界面、字体层级和圆角断环图标。
- 新建独立源码仓库，统一应用与 npm 版本为 0.1.0；Android 内部版本号为 14。
- 重写使用、隐私、开发、兼容性和发布材料。
- 移除内部阶段报告、本机配置、Expo 示例图片和重置模板脚本。
- 提供完整中英文 README、双语问题/PR 模板，以及 Ubuntu/Windows 的自动代码检查。

本版本来自内部开发基线 0.7.1。原有数据迁移和相应用例保留。0.1.0 仅发布源码，暂不提供 APK。

The first source preview includes persona profiles, memory, model connections, chat, prompt configuration, history and local data management. It also includes the monochrome interface, bilingual READMEs and automated checks. No prebuilt APK is provided for 0.1.0.
