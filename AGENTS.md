# AGENTS.md — dsh-plugin-zen-runtime

给在本仓工作的 Agent 的说明。人类读者请看 [README.md](README.md)。

## 这是什么

DSH（DeepSeek Harness）的运行时补丁插件，让 OpenCode ZEN 的免费模型可用。
宿主半是纯 ESM、**零依赖**。

## 硬约束

- `lib/index.js` **不得出现任何 `import`**（宿主半零依赖是红线）。
- **不得读取、写入或删除任何文件**，不得读取凭据。插件只改内存中的请求。
- 只对 `config.hosts` 白名单内的主机改写请求；其余请求必须原样转发，并保持
  `input` / `init` 的**对象同一性**。
- 作用域判定只能基于**解析后的 hostname**，不要退回按整串 URL 匹配——那会让
  `https://example.com/?ref=opencode` 这类无关请求也带上身份头。
- **传输错误必须向上抛出**，不得被 `catch` 后重发；重发会产生一个未经改写、
  必然 403 的重复 POST。
- `package.json` **不得声明 `dsh.bundle`**：本包以显式 patch 行挂载，声明 bundle
  会参与 bundle 叠加对账并产生重复行。

## 自检

```sh
node test/runtime.spec.mjs     # 35 项，零依赖、不联网
```

改了行为就补用例。修 bug 时先确认**用例在 bug 存在时确实失败**（把 bug 改回去跑一遍），
否则等于没覆盖——本项目就有一个 bug 藏在完全没测到的 `Request` 输入路径里。

## 网关契约

`lib/index.js` 头部注释与 [`docs/zen-gateway.md`](docs/zen-gateway.md) 记录了四项必需条件
（UA 含 `opencode/<版本>`、`x-opencode-session` 是按 `Identifier` 算法**铸出**的 id
而非随机 hex、工具集含 `bash` 与 `read`、`body.stream` 为 `true`）。

改这里等于改对外契约，**三处必须同步**：源码头部注释、`docs/zen-gateway.md`、
README 的实测表。这三处曾经口径不一致，独立复核时被判为问题。

## 提交前

1. `node test/runtime.spec.mjs` 全绿。
2. 若动了网关契约或默认行为，README / docs / 源码注释三处同步。
3. 提交信息写明「为什么」，而不是复述 diff。
