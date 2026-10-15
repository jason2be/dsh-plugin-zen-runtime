# OpenCode ZEN 免费额度的客户端校验：实测记录

这份文档记录一件事：**OpenCode ZEN 网关凭什么判断"这个请求来自 OpenCode 客户端"**。
结论全部来自抓包与单变量剥离，不是推测，也不来自任何未经验证的二手说法。

写下来是因为流传的说法里至少有两处是错的，而按错的去做会一直在错的方向上调试。

---

## 1. 现象

用 OpenCode ZEN 的 API key 在第三方 harness 里请求免费模型（`*-free`），网关返回：

```http
HTTP/1.1 403
```

```json
{"type":"error","error":{
  "type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode"
}}
```

同一把 key、同一个模型，用官方 `opencode` CLI 请求则正常返回。所以差异不在凭据，
而在请求本身。

## 2. 测量方法

### 2.1 抓取真实客户端的请求

让官方 CLI 把请求发到本地抓包服务器（覆盖 provider 的 `baseURL`），逐字节落盘：

```sh
OPENCODE_CONFIG_CONTENT='{"provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:19400/v1"}}}}' \
  opencode run --model opencode/mimo-v2.6-flash-free "reply ok"
```

> 注意：opencode 启动时还会为 `gpt-5.4-nano` 发一次内部 `/v1/responses` 请求。
> 抓到的多条记录要按 body 里的 `model` 字段过滤，否则会拿错样本。
> `*-free` 目录一直在换（初版用的 `ling-3.0-flash-fin-free` 已下架），取当前在售的免费模型即可。

抓到的样本：11 个工具、33799 字节 body、`stream: true`，头里同时带
`x-opencode-session` 与 `x-opencode-session-id`。

**客户端的 id 必须一起抓。** 头相关的实验要固定使用抓到的原 id，或按 §3.2 的算法
**铸出来**的 id：把 id 换成自己随机凑的、格式却"看起来对"的值，网关会拒绝，
这一步混淆曾让人把"值不对"误判成"头不对"。

### 2.2 单变量剥离

以抓到的原始请求为基准，**每次只改一个变量**发回真实网关，观察 403/200。

## 3. 必需项

四项任一缺失都是 403。

### 3.1 `User-Agent` 必须含 `opencode/<版本>`

| User-Agent | 结果 |
| --- | --- |
| `opencode/1.18.18` | **200** |
| `opencode/1.18.23 ai-sdk/... runtime/bun/1.3.14`（官方原值） | **200** |
| `deepseek-harness/0.1.7-rc.2`（其余全部正确） | **403** |

**这是最容易漏掉的一项。** 很多 harness 会把 provider 配置里的 `User-Agent` 覆盖掉，
于是不管怎么补 `x-opencode-*` 头都仍然 403。

### 3.2 `x-opencode-session` 必须是客户端**铸出来的** id，不只是"形状对"

值的形状是 `ses_` + 12 位小写十六进制 + 14 位 base62，但**被判定的是这 12 位的数值**：

```text
value   = (毫秒时间戳 * 4096 + 同毫秒自增计数) % 2**48     # 计数从 1 起
session = ~value（48 位内取反，descending）
message = value（原样，ascending）
id      = prefix + "_" + hex(value).padStart(12, "0") + base62 随机 14 位
```

OpenCode 的 `Identifier.create` 就是这样铸 id 的：session 用 `descending()`、
message 用 `ascending()`，两者共用同一个时钟与计数器。网关只回读那 12 位 hex。

实测边界（其余条件全部正确、`stream:true`，只改前 12 位）：

| 前 12 位 hex | 结果 |
| --- | --- |
| 低 12 位 `0xFFF` / `0xFE0` / `0xFC1` / `0xFC0`（高 36 位随便填） | **200** |
| 低 12 位 `0xFBF` / `0xE00` / `0x800` / `0x000` | **403** |
| 12 位**随机** hex（形状对、值随机） | **403**，命中率只有 64/4096 |
| 时间戳任意（`ms = 0`、几十年前、未来） | **200** —— 只校验低 12 位，不校验时间新旧 |
| 大写 hex | **403** |
| 尾串长度 ≠ 14 | **403** |
| `session` 用 ascending 铸（方向错） | **403** |

即：**形状对但值随机的 id 有 98.4% 会被拒**，看起来像"网关不认头"。判定规则在
老版本文档里被记成"前 12 位是十六进制即可"，那是把"形状"当成了"值"——
两者在 1.18.35 的对照实验里可以清晰区分：12 位随机 hex 基本必挂，同一时刻按上式
铸出的 id 必过。

### 3.3 `body.tools` 必须同时含 `bash` 与 `read`

| 工具集 | 结果 |
| --- | --- |
| 完整 11 个 OpenCode 工具 | **200** |
| `read` + `bash`（只要这两个） | **200** |
| 仅 `bash` | **403** |
| 仅 `read` | **403** |
| `edit` `glob` `grep` `read` `skill` `write`（无 `bash`） | **403** |
| 11 个减去 `bash` | **403** |
| 11 个减去 `webfetch` / 减去 `websearch` | **200** |

网关只检查**工具名是否存在**，不看描述与 schema。所以补两个名字正确的桩工具即可。

### 3.4 `body.stream` 必须是 `true`

同一组头、同一个 body，**只改 `stream`**：

| body | 结果 |
| --- | --- |
| `"stream": true` | **200** |
| `"stream": false` | **403** |
| 没有 `stream` 键（OpenAI SDK 同步调用的默认形态） | **403** |

自带脚本最容易漏这一项：`client.chat.completions.create(...)` 不传 `stream=True`
就是非流式，于是头全对也照样 403。客户端侧不受影响——官方 CLI 与 DSH 的
`openai-completions` 调用都是 `"stream": true`（还带 `stream_options.include_usage`）。

## 4. 非必需项

以下实测去掉仍是 200。本插件照样发送，只因为官方客户端会发，对齐它没有代价：

| 项 | 实测 |
| --- | --- |
| `x-opencode-client` | 去掉仍 200 |
| `x-opencode-project` | 去掉仍 200 |
| `x-opencode-request` | 去掉仍 200；取值填 `msg_` + 垃圾（甚至不是 id）也仍 200，**完全不校验** |
| `x-opencode-session-id` | 1.18.35 起客户端会发（与 `x-opencode-session` 同值），去掉仍 200 |
| `Referer` | 未参与判定 |
| 系统提示词 | **完全无关**：删掉 64 KB 的官方提示词、或压到 18 字符，都仍 200 |
| 精确的 UA 字符串 | `opencode/1.18.18` 与官方长 UA 都是 200，只要含 `opencode/<semver>` |

## 5. 官方客户端实际发出的完整头部

抓包所得（provider id 以 `opencode` 开头时，1.18.35）：

```http
User-Agent: opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: <project id>
x-opencode-session: ses_<12 hex><14 base62>          # descending() 铸出
x-opencode-session-id: <与 x-opencode-session 同值>   # 1.18.35 起
x-opencode-request: msg_<12 hex><14 base62>          # ascending() 铸出
```

`x-opencode-client` 的取值来自 `OPENCODE_CLIENT` 环境变量，默认 `cli`。

## 6. 三处常见误判

1. **不存在 `x-opencode-request-id`。** 官方客户端发的是 `x-opencode-request`。
   服务端事件元数据里出现的 `x-opencode-request-id` 是它内部归一化后的字段名，
   不是线上头名。按错的名字补头不会生效。
2. **`x-opencode-ticket` / `x-opencode-directory` / `x-opencode-workspace` /
   `x-opencode-sync` / `x-opencode-title` 与 ZEN 网关无关**——它们是 opencode
   **本地服务**（`opencode serve` / API / PTY）用的头。
3. **"形状对"不等于"值对"。** 12 位随机 hex + 14 位随机字母数字*看起来*完全合规，
   网关却有 98.4% 的概率直接 403：它回读那 12 位，只接受 `Identifier` 铸出的值。
   同理，"前 12 位是小写十六进制"这条老结论会把 id 的问题推给"网关不认头"，
   方向就全错了（见 §3.2）。

另外，`x-opencode-project` 在真实客户端里是**条件发送**的：`InstanceState.context`
里有 project id 才带。子代理场景还会带 `x-parent-session-id`。

## 7. 复现实验

任何 HTTP 客户端都可以。最小可用形状（把 `$KEY` 换成自己的 key）。
**注意 `x-opencode-session` 必须现场铸**（§3.2 的算法），随机 hex 会被拒：

```sh
NOW=$(date +%s%3N)
RAW=$(( (NOW * 4096 + 1) % 281474976710656 ))        # 2**48
HEX=$(printf '%012x' $(( 281474976710655 - RAW )))   # 48 位取反 → descending
TAIL=$(openssl rand -base64 24 | tr -dc '0-9A-Za-z' | head -c 14)

curl -sS https://opencode.ai/zen/v1/chat/completions \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -H "user-agent: opencode/1.18.18" \
  -H "x-opencode-client: cli" \
  -H "x-opencode-session: ses_${HEX}${TAIL}" \
  -d '{"model":"mimo-v2.6-flash-free","stream":true,
       "messages":[{"role":"user","content":"reply ok"}],
       "tools":[{"type":"function","function":{"name":"bash","parameters":{"type":"object","properties":{}}}},
                {"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{}}}}]}'
```

要依次验证哪一项必需，就用上面的基准**每次只改一处**：把 UA 换成别串、把
`x-opencode-session` 换成随机 hex、把 `stream` 去掉、把一个工具去掉。四处各会得到 403。

## 8. 边界与风险

- **免费额度是按账号/按 IP 计的每日限额**，与本插件无关。额度用尽时网关同样会拒绝，
  等额度重置即可。这与本文描述的客户端校验是两个独立机制。
- **上游随时可能改变校验策略。** 本文记录的是测量当时的行为；那之后网关若收紧
  （换校验字段、上更强的指纹、把这项检查移到边缘节点），本插件可能失效。
- **本插件不提供、不绕过任何付费内容。** 它只作用于 ZEN 目录里 `cost.input == 0`
  的免费模型，凭据仍是你自己的 OpenCode key，额度与计费规则不受影响。
- **网关加客户端校验的用意就是把这部分免费额度限制在 OpenCode 内。** 本插件让请求
  看起来来自该客户端。是否使用请自行判断，并自行承担上游封禁或策略变更的风险。
- 请勿把 key 写进仓库、issue 或聊天记录。

## 9. 变更记录

- 2026-09：初版。基于 opencode 1.18.23（`/opt/homebrew` 安装）与 ZEN
  `/zen/v1/chat/completions` 的实测。
- 2026-10：复核，必要项从三项变四项。
  - 新增：`body.stream` 必须为 `true`（§3.4）；
  - 修正：`x-opencode-session` 校验的不是"前 12 位是 hex"，而是这 12 位里的
    **值**——必须由 `Identifier` 铸出（低 12 位 ≥ `0xFC0`），随机 hex 会被拒（§3.2）。
    ID 方案从 opencode 1.18.35 的 bun bundle 还原，并用对照实验验证；
  - 补充：`x-opencode-request` 完全不校验；`x-opencode-session-id` 是 1.18.35 新增的
    非必需头（§4、§5）；
  - 更新：§2.1 抓包样本、§6 误判清单、§7 复现脚本（旧脚本用随机 hex 铸 id，本身
    就只有 1.6% 的成功率）。
