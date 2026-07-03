# claude-accounts-usage

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)账号的订阅用量、在账号之间切换,并查看本地 OpenCode 的用量统计仪表盘(`/stats`)。

它**不接管** `anthropic` auth provider,因此可以和 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) **共存** —— ex-machina 继续负责 OAuth 登录与请求注入,本插件只在工具层做"账号档案 + 切换 + 用量展示"。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示所有账号的用量(5h / 7d / 7d-Sonnet 三个窗口,带进度条与重置倒计时),并可直接切号与删号:`↑↓` 选择、`enter` 切换(立即生效)、`m` 标记/取消"不自动切"(被标记的账号不参与自动切号,面板中显示"不自动切")、`d` 删除账号(再按一次 `d` 确认,当前账号不可删)、`esc` 关闭 |
| `/stats` | 弹框显示本地 OpenCode 的用量统计仪表盘:总览 / 模型 / 提供方三个分页,含活跃热力图与 token 折线图,可切 All / 7天 / 30天 范围 |

账号会在**插件加载时**以及每次 `/usage` 时**自动收录**当前 ex-machina 登录的账号,无需手动添加。

## 用量统计仪表盘(`/stats`)

直接读取本地 OpenCode 会话库(`opencode.db`)做统计,**只读、不联网**:

- **三个分页**:`总览`(整体 token / 花费 / 会话 / 消息 / 活跃天数 + 连续天数,GitHub 风格活跃热力图)、`模型`、`提供方`(各自的 token 折线图与明细,`j/k` 选择条目)。
- **时间范围**:`All` / `7天` / `30天`,打开时一次性扫描全表、之后切范围走内存聚合,切换即时无卡顿。
- **快捷键**:`tab` / `←→` / `h l` 切页 · `r` 或 `1/2/3` 切范围 · `j/k` 选条目 · `q` / `esc` 关闭。

> 数据来源是 OpenCode 自身记录的会话库,与 `/usage` 的"订阅额度"是两回事:`/usage` 看的是 Anthropic 订阅窗口剩余额度,`/stats` 看的是你本地累计的 token / 花费统计。

## 限流自动切号(自动重试)

当**当前账号撞到订阅额度上限**(5h 窗口或周/全模型窗口的 429)时,插件会**中断当前请求、自动切到下一个可用账号,并在原 session 上自动发 `continue` 续接**,无需手动干预。该能力**始终开启**。

工作方式:

- **检测**:主要监听 OpenCode 的 `session.status` 的 retry 事件(同时也注册 `session.next.retried` / `session.error` 作为补充,但 TUI 插件通常只能收到 `session.status`),只在命中 Anthropic 订阅额度签名(`anthropic-ratelimit-unified-*: rejected`,或响应体/消息含 `rate_limit_error` + 额度文案,或 429 状态码)时触发;529 过载等会被排除,避免误切号。
- **选号**:优先按用量挑剩余额度最多的账号(用 `/usage` 时缓存的数据,TTL 10 分钟),无缓存则轮询下一个;跳过正在冷却(已知额度未恢复)的账号。
- **不自动切**:被标记为"不自动切"的账号**不会被自动切号选中**;当所有**未标记**账号都撞限/冷却时,自动切号会**停下**(绝不自动切到标记号)。标记号仍可在 `/usage` 里手动 `enter` 切换;被标记的当前账号撞限时仍会自动切**走**到未标记号。标记保存在 `~/.config/opencode/claude-accounts.json` 对应账号的 `"excluded": true`(可手动编辑)。
- **续接**:命中订阅额度限流时,插件**中断当前请求 → 切到可用账号 → 在原 session 上自动发 `continue` 续接**(等价于手动"按两次 esc 再发 continue");若该轮尚无任何输出,则自动重发你的原始消息。
- **不回退**:这一轮已改动的文件、已完成的工具进度**全部保留**,新账号带完整上下文接着干,**无需手动按键**。
- **冷却**:撞限的账号进入冷却,恢复时刻优先取限流响应头给出的 reset;拿不到响应头时,退而用该账号真实的按窗口 `resets_at`(由 `/usage` 缓存,并在切号后的那次刷新里回填)。两者都拿不到时,账号仍会被排除出自动选号,但**不编造任何倒计时**、也**不安排恢复提醒**,直到后续某次用量刷新拿到真实 reset 才安排精确恢复。已知 reset 的冷却持久化在 `tui.json` 的 KV 中;账号下次成功使用后自动解除冷却。
- **耗尽**:当所有账号都在冷却时停止切换,并弹出最近恢复时间的倒计时提示(仅当至少有一个账号有已知 reset 时才显示倒计时,否则只提示已达上限)。
- **恢复提醒**:冷却账号到达其真实恢复时刻(来自响应头或缓存的 `resets_at`)后,弹出**常驻提示框**(需按键确认才关闭)告知该账号额度应已恢复、可切回使用;多个账号同时恢复会合并为一条。恢复时刻未知时不会安排该提示。

## 日志与排查

插件日志写入 OpenCode 内建日志文件 `~/.local/share/opencode/log/opencode.log`,每条都带 `claude-accounts-usage` 标记,方便单独筛出来。

查看:

```bash
grep "claude-accounts-usage" ~/.local/share/opencode/log/opencode.log
```

想看更详细的 debug 级日志(比如限流检测的原始样本):启动 opencode 时加上 `OPENCODE_LOG_LEVEL=DEBUG`(或 `--log-level DEBUG`),并设环境变量 `CLAUDE_AUTOSWITCH_DEBUG=1`。两者配合才会输出 debug 级别的诊断信息。

提 issue 时:把相关日志行 grep 出来,贴到 <https://github.com/Daiwenxi798673133/claude-accounts-usage/issues>,并附上复现步骤。日志已对 token 做脱敏处理,但仍建议你粘贴前自查一遍,确认没有夹带敏感信息。

## 前置条件

- 已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。
- **无需移除 ex-machina**,两者共存。

## 安装

TUI 插件只在 `~/.config/opencode/tui.json` 配置,**不要**放进 `opencode.json`。

### 方式一:npm(推荐)

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["claude-accounts-usage@0.2.2"]
}
```

OpenCode 会自动解析并安装该包,无需手动 `npm install`。

> `0.2.2` 是当前**最新稳定版**(在 0.2.1 基础上修复了某些账号状态下打开 `/usage` 会崩溃的问题;此前含 `/stats` 仪表盘、自动切号数据丢失修复,以及当前账号 token 刷新竞态修复——根治那个会导致需重新登录的 `invalid_grant` 故障)。
>
> **建议带上版本号**。OpenCode 按"含版本号的包名"建独立缓存目录:写死版本号后,以后升级只需把后缀改成新版本号;若不带版本号,会被首次安装的版本锁住,发布新版也不会自动更新。

### 方式二:本地 clone(开发/离线)

```bash
git clone https://github.com/Daiwenxi798673133/claude-accounts-usage.git
cd claude-accounts-usage && bun install
```

然后让 `tui.json` 指向克隆下来的 `tui.tsx` 绝对路径:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/绝对路径/claude-accounts-usage/tui.tsx"]
}
```

修改配置后**完全退出并重新打开** OpenCode。

## 账号管理流程

1. 用 ex-machina 登录账号 A:`opencode auth login` → Claude Pro/Max。
2. 打开 OpenCode,插件自动收录账号 A(标签为其邮箱)。
3. 想加更多账号:用 ex-machina 登录账号 B,然后重新打开 OpenCode 或运行一次 `/usage`,插件自动收录 B。
4. 之后用 `/usage` 查看全部用量,并在面板里 `↑↓` 选号、`enter` 切换。

> 标签默认是账号邮箱。想改名?直接编辑 `~/.config/opencode/claude-accounts.json` 里对应账号的 `label`(自动收录不会覆盖你改过的标签)。

## 工作原理

- 账号档案保存在 `~/.config/opencode/claude-accounts.json`(权限 `0600`),每个账号含 OAuth `refresh` / `access` / `expires`、邮箱 `label`,以及来自 Anthropic profile 的账号 `uuid`。
- **自动收录**:读 `auth.json` 当前账号 → 调 `oauth/profile` 拿到稳定的账号 `uuid` 和邮箱 → 按 `uuid` upsert。`uuid` 跨 token 刷新保持不变,因此同一账号只会被更新(不重复),换成新账号则自动新增。
- **切换**:把目标账号的 token 写入 `auth.json` 的 `anthropic` 条目。ex-machina 每次请求都会重新读取 `auth.json`,所以切换立即生效(下一条消息就用新账号),无需重启。
- **查看用量**:对每个账号调用 Anthropic 的 `oauth/usage` 接口;若 access token 过期,会用 refresh token 刷新并回写档案。
- 始终只读 / 谨慎写 `auth.json` 的 `anthropic` 一项,保留其他 provider 条目不动。

## 已知限制

- ex-machina 同一时刻只持有一个账号,所以一个新账号必须先用 ex-machina 登录过一次,插件才能在下次加载/操作时收录它。
- 自动切号依赖 OpenCode 的 `session.status` 事件(辅以 `session.next.retried` / `session.error`),因此只对经由 OpenCode(及 ex-machina)发出的 Anthropic 请求生效;额度恢复后的解除冷却需要该账号成功跑过一次对话。

## License

MIT
