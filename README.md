# dsh-quota-retry

给 DSH（DeepSeek Harness）补一层**配额 / 429 重试**：当 provider 把限流错误包成 `429` + `quota exceeded` 之类文案时，DSH 会把它分类成 `QUOTA`；内置的 `@deepseek-ai/dsh-llm-retry` 默认只重试 `RATE_LIMIT` / `TRANSPORT` / `SERVER` / `TIMEOUT` / `EMPTY_RESPONSE`，`QUOTA` 不在其中，于是一次短暂限流就会直接结束当前回合。

本插件在 `agent/request-error` 瀑布上接管这些 **provider 策略尚未覆盖** 的 code，并按该 provider 自己的 `retryPolicy` 重试——也就是连接错误（`TRANSPORT`）使用的那套策略：模式、次数、退避、`Retry-After` 全部一致。重试写入官方 `llm/retry` / `llm/retry-started` 事件，Web 里显示标准重试行，不需要自定义 UI。

## 为什么不是改 provider 配置

`retryPolicy` 属于 profile 里的 `llm-pi-ai` provider 配置。Cordis patch 的 `config` 是整体替换，而 profile patch 层又排在 bundle 层之后，所以一个 bundle 无法覆盖用户 profile 里的 provider 列表。

插件改成运行时扩展：

- provider 已经覆盖的 code → 完全交给 `llm-retry`，插件不介入；
- provider 未覆盖的 code（默认 `QUOTA`、`HTTP_429`）→ 插件按同一份 `retryPolicy` 接管；
- 原 failure 的 `code` / `message` / `status` 不改写，重试耗尽后仍是原来的错误。

## 工作原理

1. `ctx.on('agent/request-error', …)` 先调用下游 `next()`：
   - 下游（`llm-retry` 的 normal/always 策略）已经决定重试 → 直接透传，不重复计时；
   - 否则检查本插件是否接管。
2. 接管条件：
   - 插件启用；
   - provider 在 `providers` 列表内（空列表 = 全部）；
   - 该 provider 的 `retryPolicy` 没有覆盖 failure 的 code（`mode: always` 或 `retryableCodes` 含该 code 都算覆盖）；
   - failure 的 code 在 `codes` 里，或 `failure.status === 429` 且 `status429` 打开。
3. 重试参数来自 provider 的 `retryPolicy`（没有 policy 时用 harness 默认值），按 `(session, turn, step, provider)` 计数；turn/step/provider 变化时从 1 重新计数。
4. 等待前写 `llm/retry` 事件，等待成功后写 `llm/retry-started`，返回 `{ kind: 'retry' }`；达到上限后返回 `undefined`，原始错误抛给上层。
5. 回合取消、插件卸载都会取消等待；事件写入失败只记 warning，不阻断重试。

> 它不新增 session 事件类型，也不修改 compaction、工具或预设。

## 命令行修改重试次数

环境变量在 DSH **启动时读一次**，改完重启 `dsh web` 生效。

### 一次性（推荐先在命令行试）

```sh
HARNESS_QUOTA_RETRY_MAX_RETRIES=12 dsh web
```

### 持久化到 `$DSH_HOME/.env`

```sh
cd <本插件目录>

node scripts/set-retries.mjs 12          # 12 次
node scripts/set-retries.mjs 0           # 关闭本插件的重试（仍保留其它重试策略）
node scripts/set-retries.mjs --show      # 查看 .env / 启动 shell / 调用目录各自的值与最终生效值
node scripts/set-retries.mjs --unset     # 删除覆盖，回到 config / provider 策略
node scripts/set-retries.mjs --help      # 查看全部参数
node scripts/set-retries.mjs 12 --home /path/to/.dsh   # 指定 Harness home
```

`package.json` 也带了同名脚本：`npm run set-retries -- 12`。

- 写入 `$DSH_HOME/.env` 的 `HARNESS_QUOTA_RETRY_MAX_RETRIES=<n>`，文件权限 0600，保留无关行；
- 同时清理 `DSH_QUOTA_RETRY_MAX_RETRIES` 行（DSH 不允许 `.env` 里出现 `DSH_*`，该名字只用于启动 shell 的别名）；
- 校验 `0..10000` 的整数，非法值以 exit 2 退出；
- `--show` 会说明 DSH 的加载顺序：**继承环境 > 调用目录 `.env` > `$DSH_HOME/.env`**，所以启动 shell 的导出值或项目 `.env` 会盖过持久化文件；
- 结束提示重启；插件读不到合法值时会 warn 一次并回退，不会因为 `.env` 写错而装载失败。

### 优先级（从高到低）

1. `HARNESS_QUOTA_RETRY_MAX_RETRIES`（再回退 `DSH_QUOTA_RETRY_MAX_RETRIES` 别名）；
2. 插件行的 `config.maxRetries`；
3. provider `retryPolicy.maxRetries`；
4. provider 没有 policy 时，harness 默认 5 次。

`maxRetries: 0` 表示本插件不重试；`--unset` 表示回到 config/provider 策略。`provider.retryPolicy.mode: always` 时下游已经负责所有失败，本插件不会介入，命令行次数也不影响它。

## 配置

插件行在 `cordis.patch.yml` 里只有 `id` / `name`，下面字段都可选（改 profile 后重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时完全交给其它重试策略 |
| `codes` | `['QUOTA', 'HTTP_429']` | 要接管的 failure code；1–32 个非空字符串 |
| `providers` | `[]` | 只处理这些 provider；空 = 全部 |
| `status429` | `true` | failure 带 `status: 429` 时，即使 code 不在 `codes` 里也接管 |
| `maxRetries` | `null` | 次数覆盖；null = 跟随 provider 策略；`0..10000` |

例：

```yaml
- id: quota-retry
  name: 'dsh-quota-retry'
  config:
    codes: ['QUOTA']
    maxRetries: 12
```

## 安装

从 GitHub 安装（推荐）：

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-quota-retry#v0.1.0
```

或从本地目录安装：

```sh
dsh plugin --profile web add /root/harness-plugin-dev/dsh-quota-retry
```

或在 GUI 的「插件」页安装同一个目录，或让 DSH 里的 agent 用 `plugin_manager` 的 `install_bundle`，target 填绝对目录。

> 安装/更新 bundle 后请重启一次 `dsh web`。Host 行本身可以热加载，但环境变量与 `.env` 只在 boot 读取；当前运行中的会话也可能在安装 bundle 时短暂失去工具。

## 验证

```sh
node --check index.js
node --check env.js
node --check scripts/set-retries.mjs
node --test test/*.test.js
```

测试覆盖：`QUOTA` 接管与次数耗尽、provider 已覆盖时让行、下游已重试时透传、`status: 429` 兜底、provider 过滤、`maxRetries: 0`、等待中取消、卸载、非法 env 回退、配置校验，以及 CLI 的写入 / `--show` / `--unset` / `--help` / 保留无关行 / 非法值。

装好后用 `plugin_manager` 的 `list_plugins` 看 `include:quota-retry` 的 `fiberPhase` 是否为 `active`，或看 `dsh --profile web --dump-config` 里的 `quota-retry` 行。`Config.listConfigs` 会把这个插件手写的 Standard Schema 标成 `unsupported`（它只投影 Schemastery 原生 schema），这是检查器限制，不是装载失败。真实的 429 重试行只会在下一次 provider 返回配额/429 时出现。

## 已知限制

- **永久配额耗尽不会凭空恢复**：重试次数用完后仍以原始 `QUOTA` 失败结束。默认窗口是 provider 策略（5 次 / 最多 10s 一次）；需要更长窗口就用 CLI 提高次数，或改 provider 的 `retryPolicy.maxRetries` / `backoff`。
- **backoff 跟随 provider 策略**：本插件不单独配置退避；provider 没有 policy 时使用 harness 默认 `500ms` 起步、`10s` 上限、`0.1` jitter。
- **按全局一个次数覆盖**：命令行值对所有 provider 生效；provider 级差异仍由各自的 `retryPolicy` 表达。
- **不是错误重分类**：`QUOTA` 仍是 `QUOTA`，日志与最终错误文案不变。
- **不处理其它终态错误**：`AUTH`、`INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED` 等不会被这个插件重试。
- **`.env` 只写 `HARNESS_*`**：`DSH_*` 是 DSH 的 bootstrap-only 前缀，写进 `.env` 会让启动报错；需要 `DSH_` 拼写时只在启动 shell 里 export。

## 卸载

```sh
dsh plugin --profile web remove dsh-quota-retry
```

或在 GUI 的「插件」页移除，然后重启。移除后 `.env` 里的 `HARNESS_QUOTA_RETRY_MAX_RETRIES` 可以保留（不再有消费者），也可以 `node scripts/set-retries.mjs --unset` 清掉。

## License

MIT，见 [LICENSE](LICENSE)。