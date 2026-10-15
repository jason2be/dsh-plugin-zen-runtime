# dsh-plugin-zen-runtime

让 DSH（DeepSeek Harness）能用 **OpenCode ZEN 免费模型**的运行时补丁插件——**不修改磁盘上任何文件**。

```sh
node test/runtime.spec.mjs        # 35 项自检，零依赖、不联网
```

> 网关凭什么判定"请求来自 OpenCode"的完整实测记录见
> [`docs/zen-gateway.md`](docs/zen-gateway.md)。那四项必需条件不是推测，
> 是抓包加单变量剥离量出来的。

## 为什么需要它

DSH 内置的 `requestHeaders()` 会先剔除与 attribution 头同名的 provider 头，再把
attribution 覆盖上去。结果是：**provider 里配的 `User-Agent` 永远发不出去**，请求只能以
`deepseek-harness/...` 的身份出网。而 ZEN 网关要求 UA 含 `opencode/<版本>`，于是回
`403 FreeTierError`（"free tier can only be used from within OpenCode"）。

社区已有的 `dsh-plugin-zen-useragent` 靠**改写磁盘文件**解决（替换
`dsh-llm-pi-ai/lib/index.js` 的 `requestHeaders`、替换 pi-ai 的 `openai-completions.js`）。
这在 **DSH 桌面应用里无法工作**：桌面版把所有包放在签名且逐文件校验 SHA-256 的
`app.asar` 内，只读，改不动。

本插件改在**运行时**拦截：启动时包装一次 `globalThis.fetch`，只对白名单主机的请求
补上身份与工具，其余请求原样透传。不读、不写、不打补丁，因此 **DSH 升级后依然有效**。

## 它做了什么

对目标主机的请求：

1. 把 `user-agent` 换成 `opencode/<版本>`（若调用方已带 opencode UA 则不动）；
2. 补上 `x-opencode-client` / `x-opencode-project` / `x-opencode-session` / `x-opencode-request`；
3. 若 `body.tools` 里缺 `bash` 或 `read`，补上对应的桩工具；
4. body 被改写时删掉 `content-length`（否则过期长度会让请求挂起）。

`x-opencode-session` 每进程一条并复用，`x-opencode-request` 每请求一条，与官方客户端一致：
**按 opencode `Identifier` 的算法铸**——`(毫秒 * 4096 + 同毫秒计数) % 2**48`，
session 取 48 位反码（`descending()`）、message 取原值（`ascending()`），
再拼 12 位小写 hex 与 14 位 base62。网关会回读那 12 位 hex，**随机 hex 只有 64/4096 能过**
（§3.2 有实测边界）；`x-opencode-request` 本身不参与判定。

第 4 项必需条件是 `body.stream: true`（§3.4）。而 DSH 的 `openai-completions` 每个请求本来就发`"stream": true`，所以不用特意处理。

## 装配（以 DSH 桌面应用的 `desktop` profile 为例）

桌面应用的 profile **不能由 `dsh` CLI 管理**（`rejectElectronProfile`），因此手工接线，三处改动：

1. 包放进 profile 的 `node_modules`（软链即可，改源码后重启生效）：

   ```sh
   ln -sfn /path/to/dsh-plugin-zen-runtime \
     ~/.dsh/profiles/desktop/node_modules/dsh-plugin-zen-runtime
   ```

2. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 声明它：

   ```json
   { "dsh-plugin-zen-runtime": "link:/path/to/dsh-plugin-zen-runtime" }
   ```

3. `~/.dsh/profiles/desktop/cordis.patch.yml` 插一行（本包**不声明 `dsh.bundle`**，
   故意不参与 bundle 叠加，避免被 plugin-manager 对账后出现重复行）：

   ```yaml
   - insert:
       - id: zen-runtime
         name: dsh-plugin-zen-runtime
   ```

重启 DSH 后，终端/日志应出现 `[zen-runtime] fetch hook active — ...`；
没有这行就说明行没挂上。

> bundle 列表与客户端产物在进程启动时定格，改这两类必须重启；本插件没有客户端半，
> 但行本身是新挂的，所以首次装配要重启一次。

## provider 配置

ZEN 的 API key 放 DSH 凭据存储（`apiKeyEnv` 指向的名字即可）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencodezen:
        displayName: OpenCode ZEN (free)
        apiKeyEnv: OPENCODEZEN_API_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/v1
        models:
          - id: mimo-v2.6-flash-free
            name: mimo-v2.6-flash-free
```

**provider 里不用配 headers**：配了 `User-Agent` 也会被 `requestHeaders()` 剥掉，
身份由本插件在 fetch 层补齐——那一层之后没有任何东西会覆盖它。

## 行配置（可选）

`cordis.patch.yml` 里的行 `config` 可覆盖以下键；patch 会整体替换 `config`，
保留哪些键就要重新写全。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.18` | 发往目标主机的 `user-agent`；置空字符串则不改写 |
| `referer` | `https://opencode.ai` | 仅在请求没有该头时补；置空则不补 |
| `project` | `global` | `x-opencode-project`；置空则不发送 |
| `hosts` | `["opencode.ai"]` | 生效主机的白名单；条目同时匹配其子域 |
| `ensureTools` | `true` | 是否补齐网关要求的 `bash` 与 `read` |

```yaml
- insert:
    - id: zen-runtime
      name: dsh-plugin-zen-runtime
      config:
        userAgent: opencode/1.18.23
        hosts: [opencode.ai, my-gateway.internal]
```

## 实现要点

- **按 hostname 匹配，不按整串 URL。** 用 `/opencode/i` 匹配整条 URL 会让
  `https://example.com/?ref=opencode` 这类请求也被注入身份头与工具；白名单只认
  解析后的主机名。
- **发送不在改写失败的回退范围内。** 传输错误如实抛给调用方，不会被 catch 后
  重发一次未经改写的请求。
- **钩子会重新挂载。** 若有别的库替换或还原了 `globalThis.fetch`，比对 wrapper
  引用后重新安装，避免静默失效。
- **零依赖、无服务端代码。** 不读凭据、不落盘、不联网（除被包装的请求本身）。

## 已知边界

- 只对 `hosts` 白名单内的主机生效；其余请求的原参数原样转发。
- 免费额度是按账号/按 IP 计的**每日**限制，与本插件无关；用尽后网关同样会拒绝，
  等到额度重置即可。
- 上游随时可能改变校验策略；那时的失效表现会是重新出现 `403 FreeTierError`。
- 本插件只作用于 ZEN 目录里零成本的免费模型，凭据仍是你自己的 key。详见
  [`docs/zen-gateway.md`](docs/zen-gateway.md) 的「边界与风险」。

## 许可

[MIT](LICENSE)。

---

**English.** A runtime-only DSH plugin that makes OpenCode ZEN's free
(`*-free`) models work in DeepSeek Harness without patching any file on disk.
It wraps `globalThis.fetch` once per process and, for allow-listed hostnames
only, restores the `opencode/<version>` user agent, adds the `x-opencode-*`
identity headers (with session and message ids minted by OpenCode's own
identifier scheme, not random hex), and appends the `bash`/`read` tool stubs the
gateway requires. See [`docs/zen-gateway.md`](docs/zen-gateway.md) for the
measured evidence behind those four requirements. MIT licensed.
