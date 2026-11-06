# Codex → DeepSeek Harness bridge

Codex 派发与 review，DeepSeek Harness 执行并组织子代理。v0.2.0 默认连接正在运行的桌面客户端：任务在对应工作区下以“Codex · …”显示，真实对话、工具调用、子代理和后续 review 都保存在同一桌面会话。

## 本机使用

需要 Windows、Node.js 22+、已安装并登录的 DeepSeek Harness。

1. 安装项目依赖后运行 `npm run install:desktop`。安装器备份 desktop profile 的 patch，再添加本项目插件；不修改客户端安装包、系统权限或用户默认模型。
2. 打开 DeepSeek Harness。桌面配置通常会自动重载；连接不可用时检查插件是否加载，必要时重启客户端。
3. 让 Codex 启动 `node src/server.js`，环境变量 `DSH_BRIDGE_DATA` 指向本项目的绝对 `.bridge` 目录。桌面插件与 MCP 必须使用同一目录。
4. 如果 Codex 已经启动旧版 MCP，需重新加载该连接或重新打开 Codex 后再派发新任务。运行中的旧进程不会自动加载新源码。

桌面插件通过仅监听 127.0.0.1 的随机端口提供受随机令牌保护的连接；连接信息存于被 Git 忽略的 `.bridge/desktop-endpoint.json`，不要分享。插件只允许操作它登记的任务，不提供任意代码执行或其他会话访问接口。关闭客户端后派发会明确报错，不会静默退回不可见的 headless 执行。

## 工具与流程

- `dsh_dispatch`：注册/复用 cwd 对应工作区，创建可见的原生会话并提交任务，返回 taskId。执行模型仅对此会话设置为 deepseek-account / deepseek-flash。
- `dsh_status`：读取真实状态及子代理活动；`input_required` 时到桌面处理审批或问题；`awaiting_review` 不代表已获 Codex 批准。
- `dsh_history`：读取原生事件和工具结果，返回 records、cursor、hasMore；需要时用 beforeSeq 向前翻页。旧 headless 任务仍返回 runs。
- `dsh_feedback`：在同一会话继续执行，requestId 必须是 UUID；重试使用相同 requestId。新反馈在执行中会被拒绝。
- `dsh_cancel`：请求停止当前主代理轮次；原生 API 可能保留队列及子代理，之后必须查询状态。

任务持久化记录保存 transport，后续调用按任务自身路由。升级前未标记 transport 的任务按旧版默认 headless 处理，不会自动登记到工作区；实测重启桌面后旧任务出现在“未分组”中。显式设置 `DSH_TRANSPORT=headless` 可保留原执行方式；http 是旧的实验适配器，需要 DSH_URL / DSH_TOKEN，不用于桌面默认连接。

## 验证

`npm test` 覆盖 MCP 握手、参数边界、桌面注册、连接认证、无关会话拒绝、反馈去重、子代理活动、失败与待审批状态。

2026-11-06 桌面真实 MCP 联调通过，任务 `00166020-b40e-4ae4-b096-97c940d35e27`：

- 客户端 test-output 分组显示任务，打开后能看到两轮真实对话和 1 个子智能体。
- 实际调用子代理 `719f3045-3b87-4bf3-894e-6d6dc80b73f8` 检查文件。
- Codex review 后实际文件 `test-output/desktop-visible.txt` 精确等于“桌面 Review 修改成功”（UTF-8 26 字节，无末尾换行）。
- 桌面重启后会话、子代理及 review 仍可见；重复反馈 requestId 返回 duplicate，事件游标不变。
- 本地证据：`.local/desktop-live-evidence.json`。`scripts/desktop-call.js` 可经新的真实 MCP 进程调用五个工具，用于人工诊断。

## 边界

- 本次仅验证原生文件操作和子代理；没有运行 PowerShell，也没有修改系统权限。此前发现的 Windows shell 权限问题不在本次修复范围，不能据此保证构建和测试命令可执行。
- 桌面服务使用本地安装版的 sessionController/workspaceRegistry 接口，客户端升级后应重新验证兼容性。
- 桌面配置的其它插件仍可能按其现有规则记录会话；bridge 不改变这些设置。
- review 通过结论尚未写入原生状态，Codex 需独立核验实际产物。
- `.bridge` 保存任务、连接及归属记录；`.local` 保存备份和验证证据，均不提交。
- 目前不支持多个 MCP 服务同时修改同一任务；不承诺跨进程写锁。桌面插件重载或关闭连接时，原生任务不因 MCP 连接断开而取消。

## 卸载桌面连接

从 desktop profile 的 cordis.patch.yml 中删除 id 为 codex-desktop-bridge 的插入项，或恢复安装器保存的备份。备份恢复前先检查之后是否有其它配置修改。随后重新加载 MCP；如需继续 headless，显式设置 DSH_TRANSPORT=headless。
