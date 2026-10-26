# 更新日志

## 0.1.1 — 2026-10-26

- 修复首次发送创建会话时丢失后来输入的草稿；会话和角色的新聊天草稿在本次运行中独立保留。
- 修复放弃或替换已编辑的临时模型后，角色配置无法保存的问题。
- 修复从另一角色的历史聊天中选择活动角色后，实际会话未切换的问题。
- 修复手动展开思考后，正文首段到达时被自动收起的问题；主动滚回底部可恢复流式回复跟随。
- 为独立模型编辑页添加未保存离开保护，防止误返回丢失输入。
- 加粗右上角导航菜单中的新建聊天、聊天、历史会话、角色与记忆和设置文字。
- 提供 ARM64-v8a 和通用版两个 Android 安装包，以及对应的 SHA256 校验和。

This release preserves unsent drafts across screen changes, fixes temporary-model saves and persona switching, keeps manually expanded reasoning open, restores streaming follow after deliberate scrolling to the bottom, protects unsaved model edits, and bolds the navigation menu labels. ARM64-v8a and universal Android APKs are available with SHA256 checksums.

## 0.1.0 — 源码发布 / Source release

- 整合聊天、角色整套配置、人设记忆、模型管理、提示词、历史及数据管理功能。
- 统一黑白界面、字体层级和圆角断环图标。
- 提供中英文使用说明、隐私与兼容性说明、开发指南和问题反馈入口。

0.1.0 仅提供源码，没有预构建 APK。

The source release includes persona profiles, memory, model connections, chat, prompt configuration, history and local data management, with a monochrome interface and bilingual documentation. No prebuilt APK is provided for 0.1.0.
