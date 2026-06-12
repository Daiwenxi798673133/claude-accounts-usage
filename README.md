# claude-accounts-usage

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)账号的订阅用量,并在账号之间切换。

它**不接管** `anthropic` auth provider,因此可以和 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) **共存** —— ex-machina 继续负责 OAuth 登录与请求注入,本插件只在工具层做"账号档案 + 切换 + 用量展示"。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示所有账号的用量(5h / 7d / 7d-Sonnet 三个窗口,带进度条与重置倒计时) |
| `/switch` | 弹框选择账号并切换为当前账号(下次对话生效) |

账号会在**插件加载时**以及每次 `/usage`、`/switch` 时**自动收录**当前 ex-machina 登录的账号,无需手动添加。

## 前置条件

- 已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。
- **无需移除 ex-machina**,两者共存。

## 安装

在 `~/.config/opencode/tui.json` 注册(TUI 插件只在 `tui.json` 配置,不要放 `opencode.json`):

```json
{
  "plugin": [
    ["/Users/你的用户名/Desktop/claude-accounts-usage/tui.tsx", {}]
  ]
}
```

修改配置后完全退出并重新打开 OpenCode。

## 账号管理流程

1. 用 ex-machina 登录账号 A:`opencode auth login` → Claude Pro/Max。
2. 打开 OpenCode,插件自动收录账号 A(标签为其邮箱)。
3. 想加更多账号:用 ex-machina 登录账号 B,然后重新打开 OpenCode 或运行一次 `/usage` / `/switch`,插件自动收录 B。
4. 之后用 `/switch` 在账号间切换,用 `/usage` 查看全部用量。

> 标签默认是账号邮箱。想改名?直接编辑 `~/.config/opencode/claude-accounts.json` 里对应账号的 `label`(自动收录不会覆盖你改过的标签)。

## 工作原理

- 账号档案保存在 `~/.config/opencode/claude-accounts.json`(权限 `0600`),每个账号含 OAuth `refresh` / `access` / `expires`、邮箱 `label`,以及来自 Anthropic profile 的账号 `uuid`。
- **自动收录**:读 `auth.json` 当前账号 → 调 `oauth/profile` 拿到稳定的账号 `uuid` 和邮箱 → 按 `uuid` upsert。`uuid` 跨 token 刷新保持不变,因此同一账号只会被更新(不重复),换成新账号则自动新增。
- **切换**:把目标账号的 token 写入 `auth.json` 的 `anthropic` 条目。ex-machina 每次请求都会重新读取 `auth.json`,所以切换在下次对话即生效,无需重启。
- **查看用量**:对每个账号调用 Anthropic 的 `oauth/usage` 接口;若 access token 过期,会用 refresh token 刷新并回写档案。
- 始终只读 / 谨慎写 `auth.json` 的 `anthropic` 一项,保留其他 provider 条目不动。

## 已知限制

- ex-machina 同一时刻只持有一个账号,所以一个新账号必须先用 ex-machina 登录过一次,插件才能在下次加载/操作时收录它。

## License

MIT
