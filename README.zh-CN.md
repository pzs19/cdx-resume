# cdx-resume

[English](README.md)

`cdx-resume` 是一个非官方的自动恢复代理，支持 macOS Codex Desktop，以及 macOS/Linux 上的交互式 Codex CLI。它解决切换账号后，账号绑定的 `encrypted_content` 无法解密、导致任务不能继续的问题。

仓库同时提供 Codex 插件。插件负责发现、安装和状态检查；真正的恢复由本地代理自动完成，不需要模型参与。

它**不会修改 `app.asar`、App 签名或真正的 Codex 可执行文件**。桌面版使用 `CODEX_CLI_PATH`，CLI 使用原生 `--remote unix://...` app-server 通道接入本地代理。

## 功能

- 自动识别 `encrypted_content` 或解密失败错误。
- 原进程读取历史超过 5 秒或失败时，使用独立的只读 app-server 连接重试（最多 30 秒），避免恢复卡在旧会话上。
- 使用当前账号创建一个新任务。
- 将可见的用户消息和助手回复复制到新任务，同时重建持久化的界面回合和分页索引，支持向上翻看旧消息。
- 丢弃加密内容、隐藏推理和工具执行状态。
- 在新任务中重试最后一条用户请求并自动打开它。
- CLI 会自动关闭失败的 TUI，并在恢复后的任务上重新打开。
- 继承源任务已经解析出的权限配置、审批策略、工作区根目录、环境及可用的 capability 配置。
- 如果代理来不及观察源任务的运行时设置，则从最近一次持久化的 `turn_context` 读取作为兜底。

原任务不会被删除或修改。

## 恢复修复

JSON-RPC 只按 ASCII LF 分包，保留消息文本里的 U+2028/U+2029。Node readline 会把这些合法 JSON 字符拆成多行，造成历史读取超时。回归测试覆盖这两种字符和主读取超时的备用路径。

## 兼容性

测试环境：

- macOS Codex Desktop
- Linux `codex-cli 0.159.2`
- macOS `codex-cli 0.161.0`

本项目依赖内部 app-server 协议。Codex Desktop 升级后可能需要适配，升级后建议重新运行测试。

## 安装

### 作为个人插件安装

将本仓库加入个人或私有 Git marketplace，安装 **Codex Resume**，再让其管理 Skill 运行安装脚本。CLI 需要新开一个 shell；macOS 桌面版还需使用 `Cmd+Q` 完全退出并重新打开。

### 直接安装代理

先安装 Codex CLI，然后运行：

```bash
git clone https://github.com/pzs19/cdx-resume.git ~/.codex/safe-switch-proxy
cd ~/.codex/safe-switch-proxy
./install.sh
```

安装后新开一个 shell。macOS 上如果使用桌面版，还需使用 `Cmd+Q` 完全退出并重新打开。

macOS 上安装脚本还会创建 LaunchAgent，使桌面版拦截在重新登录或重启后自动恢复。

## 使用

无需输入命令。代理识别到解密失败后会自动执行恢复。

## 更新

```bash
cd ~/.codex/safe-switch-proxy
git pull --ff-only
./install.sh
```

然后新开一个 shell；macOS 桌面版还需完全退出并重新打开。

## 测试

```bash
./test/install.test.sh
```

安装脚本会自动运行恢复、权限继承、已删除命令透传和安装生命周期测试。测试使用模拟 Codex
进程，不会操作真实任务。

## 卸载

仅停用功能，保留仓库和日志：

```bash
./uninstall.sh
```

同时删除克隆的仓库：

```bash
./uninstall.sh --remove-files
```

之后新开一个 shell；macOS 桌面版还需完全退出并重新打开。

## 隐私与安全

- 不要复制或发布整个 `~/.codex`，其中可能包含账号凭据和聊天数据。
- 迁移时只需要本仓库。
- 复制可见上下文和写入错误日志前，会遮盖常见格式的密钥与令牌。
- 历史图片和音频不会复制，只会放入省略提示。
- 本地日志位于 `~/.codex/safe-switch-proxy/logs/proxy.log`，并已从 Git 排除。

## 实现原理

1. Codex Desktop 通过 `CODEX_CLI_PATH` 进入包装器；交互式 CLI 通过 `PATH` 进入包装器。
2. 桌面版直接转发 JSON-RPC；CLI TUI 通过本地 Unix WebSocket 桥接入同一套代理逻辑。
3. 代理启动真正的 Codex app-server 并转发 JSON-RPC。
4. 从 `thread/start`、`thread/resume`、`thread/settings/updated` 捕获已经解析的任务设置；冷启动时以持久化的 `turn_context` 兜底。
5. 遇到匹配错误后创建干净任务、复制可见历史并恢复权限。桌面版直接重试回合；CLI 自动在恢复后的任务上重启原生 TUI 并重试请求。

本项目是非官方工具，不由 OpenAI 提供支持。

## 许可证

MIT
