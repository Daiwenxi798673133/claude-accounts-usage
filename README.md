# claude-accounts-usage

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)账号的订阅用量,并在账号之间切换。

它**不接管** `anthropic` auth provider,因此可以和 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) **共存** —— ex-machina 继续负责 OAuth 登录与请求注入,本插件只在工具层做"账号档案 + 切换 + 用量展示"。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示所有已保存账号的用量(5h / 7d / 7d-Sonnet 三个窗口,带进度条与重置倒计时) |
| `/switch` | 弹框选择账号并切换为当前账号(下次对话生效) |
| `/account-add` | 把当前 ex-machina 登录的账号保存进列表 |

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

1. 用 ex-machina 登录第一个账号:`opencode auth login` → Claude Pro/Max。
2. 在 OpenCode 里运行 `/account-add`,把当前账号存进列表(默认标签 `Account 1`)。
3. 再用 ex-machina 登录第二个账号,重复 `/account-add`(`Account 2`)……
4. 之后用 `/switch` 在账号间切换,用 `/usage` 查看全部用量。

> 标签想改名?直接编辑 `~/.config/opencode/claude-accounts.json` 里对应账号的 `label`。

## 工作原理

- 账号档案保存在 `~/.config/opencode/claude-accounts.json`(权限 `0600`),包含每个账号的 OAuth `refresh` / `access` / `expires` 和 `label`。
- **切换**:把目标账号的 token 写入 `auth.json` 的 `anthropic` 条目。ex-machina 的请求处理器每次请求都会重新读取 `auth.json`,所以切换在下次对话即生效,无需重启。
- **查看用量**:对每个账号调用 Anthropic 的 `oauth/usage` 接口;若 access token 过期,会用 refresh token 刷新并回写档案。
- 始终只读 / 谨慎写 `auth.json` 的 `anthropic` 一项,保留其他 provider 条目不动。

## 已知限制

- 用户标识(label)需手动命名;Anthropic 的 OAuth token 不携带邮箱信息。
- 若你绕过本插件、直接用 ex-machina 重新登录了一个**新身份**,请运行一次 `/account-add` 让列表跟上。

## License

MIT
