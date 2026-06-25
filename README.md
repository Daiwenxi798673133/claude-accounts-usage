# claude-accounts-usage

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)账号的订阅用量,并在账号之间切换。

它**不接管** `anthropic` auth provider,因此可以和 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) **共存** —— ex-machina 继续负责 OAuth 登录与请求注入,本插件只在工具层做"账号档案 + 切换 + 用量展示"。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示所有账号的用量(5h / 7d / 7d-Sonnet 三个窗口,带进度条与重置倒计时),并可直接切号与删号:`↑↓` 选择、`enter` 切换(立即生效)、`d` 删除账号(再按一次 `d` 确认,当前账号不可删)、`esc` 关闭 |

账号会在**插件加载时**以及每次 `/usage` 时**自动收录**当前 ex-machina 登录的账号,无需手动添加。

## 限流自动切号(自动重试)

当**当前账号撞到订阅额度上限**(5h 窗口或周/全模型窗口的 429)时,插件会**自动切到下一个可用账号并重发刚才失败的那条消息**,无需手动干预。该能力**始终开启**。

工作方式:

- **检测**:主要监听 OpenCode 的 `session.status` 的 retry 事件(同时也注册 `session.next.retried` / `session.error` 作为补充,但 TUI 插件通常只能收到 `session.status`),只在命中 Anthropic 订阅额度签名(`anthropic-ratelimit-unified-*: rejected`,或响应体/消息含 `rate_limit_error` + 额度文案,或 429 状态码)时触发;529 过载等会被排除,避免误切号。
- **选号**:优先按用量挑剩余额度最多的账号(用 `/usage` 时缓存的数据,TTL 10 分钟),无缓存则轮询下一个;跳过正在冷却(已知额度未恢复)的账号。
- **重发**:切号后将会话回退到失败的那条用户消息并用新账号重发(`revert` + `promptAsync`)。注意:若该轮中途已产生文件改动,回退会一并撤销并整轮重做。
- **冷却**:撞限的账号按响应头给出的 reset 时间(缺省 60 分钟)进入冷却,持久化在 `tui.json` 的 KV 中;账号下次成功使用后自动解除冷却。
- **耗尽**:当所有账号都在冷却时停止切换,并弹出最近恢复时间的倒计时提示。
- **恢复提醒**:冷却账号到达预估恢复时间后,弹出**常驻提示框**(需按键确认才关闭)告知该账号额度应已恢复、可切回使用;多个账号同时恢复会合并为一条。该提示基于响应头的 reset 估计,不会二次请求校验。

> 调试:设环境变量 `CLAUDE_AUTOSWITCH_DEBUG=1` 可把未命中谓词的 429 样本追加到 `~/.config/opencode/claude-autoswitch.log`,便于校准检测规则。

## 前置条件

- 已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。
- **无需移除 ex-machina**,两者共存。

## 安装

TUI 插件只在 `~/.config/opencode/tui.json` 配置,**不要**放进 `opencode.json`。

### 方式一:npm(推荐)

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["claude-accounts-usage@0.1.5"]
}
```

OpenCode 会自动解析并安装该包,无需手动 `npm install`。

> **建议带上版本号**(如 `@0.1.5`)。OpenCode 按"含版本号的包名"建独立缓存目录:写死版本号后,以后升级只需把后缀改成新版本号;若不带版本号,会被首次安装的版本锁住,发布新版也不会自动更新。

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
