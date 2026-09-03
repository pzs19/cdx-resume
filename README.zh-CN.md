# cdx-resume

[English](README.md)

`cdx-resume` 是一个非官方的 macOS Codex Desktop 会话恢复代理。它解决切换账号后，旧任务中的账号绑定 `encrypted_content` 无法解密、导致任务不能继续的问题。

它**不会修改 `app.asar`，也不会破坏 App 签名**。它通过 `CODEX_CLI_PATH`，在桌面 App 与内置 Codex CLI 之间增加一个 JSON-RPC 代理。

## 功能

- 自动识别 `encrypted_content` 或解密失败错误。
- 使用当前账号创建一个新任务。
- 将可见的用户消息和助手回复复制到新任务。
- 丢弃加密内容、隐藏推理和工具执行状态。
- 在新任务中重试最后一条用户请求并自动打开它。
- 支持手动输入 `/goanyway` 强制恢复。
- 使用 App 自带的 Custom Prompt 功能，在 `/` 菜单加入 `/prompts:goanyway`。

原任务不会被删除或修改。

## 兼容性

最初测试环境：

- Codex Desktop `26.831.21537`
- 内置 `codex-cli 0.152.1`
- macOS

本项目依赖内部 app-server 协议。Codex Desktop 升级后可能需要适配，升级后建议重新运行测试。

## 安装

先将 Codex Desktop 安装到 `/Applications`，然后运行：

```bash
git clone https://github.com/pzs19/cdx-resume.git ~/.codex/safe-switch-proxy
cd ~/.codex/safe-switch-proxy
./install.sh
```

安装完成后，使用 `Cmd+Q` 完全退出 Codex Desktop，再重新打开。仅关闭窗口不会让主进程重新加载 Custom Prompt。

安装脚本还会创建当前用户的 LaunchAgent，使 `CODEX_CLI_PATH` 在重新登录或重启后自动恢复。

## 使用

- 自动恢复：正常使用即可，识别到解密失败后会自动执行。
- 手动兜底：在出问题的原任务中输入 `/goanyway`。
- 菜单入口：从 `/` 菜单选择 `/prompts:goanyway`，然后发送。

当前 App 的 Custom Prompt 界面会强制添加 `prompts:` 前缀。若要让菜单精确显示 `/goanyway`，必须修改已签名的前端包；本项目刻意不这样做。

## 更新

```bash
cd ~/.codex/safe-switch-proxy
git pull --ff-only
./install.sh
```

然后完全退出并重新打开 Codex Desktop。

## 测试

```bash
./test/install.test.sh
```

安装脚本也会自动运行自动恢复、手动 `/goanyway` 和菜单入口测试。测试使用模拟 Codex 进程，不会操作真实任务。

## 卸载

仅停用功能，保留仓库和日志：

```bash
./uninstall.sh
```

同时删除克隆的仓库：

```bash
./uninstall.sh --remove-files
```

之后完全退出并重新打开 Codex Desktop。

## 隐私与安全

- 不要复制或发布整个 `~/.codex`，其中可能包含账号凭据和聊天数据。
- 迁移时只需要本仓库以及安装脚本生成的 Prompt 文件。
- 复制可见上下文和写入错误日志前，会遮盖常见格式的密钥与令牌。
- 历史图片和音频不会复制，只会放入省略提示。
- 本地日志位于 `~/.codex/safe-switch-proxy/logs/proxy.log`，并已从 Git 排除。

## 实现原理

1. Codex Desktop 通过 `CODEX_CLI_PATH` 启动仓库中的 `codex` 包装器。
2. 包装器使用 App 内置 Node.js 启动 `proxy.mjs`。
3. 代理启动真正的内置 Codex CLI，并双向转发逐行 JSON-RPC 消息。
4. 遇到匹配错误或 `/goanyway` 后，依次调用 `thread/read`、`thread/start`、`thread/inject_items`、`thread/name/set` 和 `turn/start`。

本项目是非官方工具，不由 OpenAI 提供支持。

## 许可证

MIT
