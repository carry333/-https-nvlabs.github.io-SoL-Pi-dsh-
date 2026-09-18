# dsh-solpack

**给 DeepSeek Harness (dsh) 的"观测经济 + 研究循环"插件**：把超大的工具输出从上下文里拿出来换成带稳定句柄的短摘要、把"改完就跑验证"合成一次调用、把压缩时机绑到计划步骤边界上。任务完成度不变，token 和成本下降。

思路来自 NVIDIA Labs 的 **SoL-Pi**（*Scaling Auto-Research Loops for Efficient Agent Harnesses*，[项目页](https://nvlabs.github.io/SoL-Pi/) / [代码](https://github.com/NVlabs/SoL-Pi)）。SoL-Pi 本身是 **Pi 的扩展**，依赖 Pi 的 extension API，装不到 dsh 上；这里按它的机制在 **dsh 自己的服务缝**上重写了一遍。

---

## 四个机制，全部落地

| SoL-Pi 的机制 | 本插件 | 挂在 dsh 的哪里 |
|---|---|---|
| **ObservationPack** | ✅ `solpack` 工具 + 结果替换 | `tools/post-execute` 瀑布：超过 `maxInlineBytes` 的纯文本结果 → 全文逐字节归档，模型只看到有界预览 + `obs-xxxxxxxxxx` 句柄；**同内容复用同句柄** |
| **Evidence-Preserving Reducer** | ✅ 确定性"收据" | 超大结果 → 头 + 尾 + 所有信号行（报错/栈帧/exit code）；**每行保留内容回归档逐字节比对通过才允许替换**，失败退回普通预览 |
| **Action Fusion** | ✅ `edit_verify` 工具 | `ctx.fs`（写）+ `ctx.shell`（跑）+ `ctx.approval`（放行）：一次调用完成"改文件 + 跑验证命令" |
| **Online Context Compact** | ✅ 经济性闸门 | `ctx.tokenMeter` 量压力 + `ctx.compaction.compactIfNeeded` 请求压缩：只在**压力足够 + 步数足够 + 冷却到期 + 预计节省达标**时才问 |

模型可见面共 **两个工具**（都不是四个，schema 开销恒定）：

```
solpack        op=read   → 逐字节精确的行窗口（from/to，1-based）
               op=grep   → 归档里的精确匹配行 + 行号（可带上下文）
               op=stat / op=list
edit_verify    path + verify（+ old_string/new_string 或 write=true）→ 改完立刻跑验证，一次往返
```

## 三条硬约束

- **bounded**：内联预览、单次回捞、融合结果、归档总量，每处都有字节上限
- **evidence-preserving**：不删任何东西；归档是原文逐字节副本，比会话活得久
- **fail-open / fail-closed，按风险分工**
  - 只读路径（打包、回捞、收据、压缩询问）**失败即退回原样**——插件出错绝不会把一次成功的工具调用变成失败
  - 会写会跑的那条（`edit_verify`）**失败即拒绝**：没有 `ctx.approval`、审批不是 `allowed-once`、编辑失败，都会**什么都不做**，并且结果里明说哪一半跑了

---

## 安装

```sh
dsh plugin --profile web add file:C:/Users/陈睿垲/Desktop/dsh工作/plugins/dsh-solpack
# 然后重启 dsh（patch 层要重新加载）
```

手工方式：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加
`"dsh-solpack": "file:C:/Users/陈睿垲/Desktop/dsh工作/plugins/dsh-solpack"`，
并把它加进同文件的 `dsh.profile.bundles`，然后在 `~/.dsh/profiles/web` 装依赖。

**卸载**：从 `dependencies` 和 `dsh.profile.bundles` 删掉这项，重启即可；归档在 `~/.dsh/solpack/`，需要时自己删。

## 配置

```yaml
- insert:
    - id: solpack
      name: dsh-solpack
      config:
        maxInlineBytes: 6000        # 超过这么多字节的纯文本结果才打包
        reduceAboveBytes: 48000     # 超过这么多 → 用「收据」
        previewBytes: 2000          # 内联预览预算（头+尾）
        maxReadBytes: 16000         # 单次 solpack 回捞硬上限

        enableFusion: true          # Action Fusion（默认 false）
        enableCompact: true         # Online Context Compact（默认 false）
```

### 打包 / 回捞

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 时整个插件空转 |
| `maxInlineBytes` | `6000` | 打包阈值 |
| `reduceAboveBytes` | `48000` | 收据（证据压缩）阈值 |
| `previewBytes` | `2000` | 预览字节预算 |
| `receiptHeadLines` / `receiptTailLines` | `40` / `20` | 收据头/尾行数 |
| `receiptSignalLines` | `120` | 收据最多保留多少信号行 |
| `maxReadBytes` | `16000` | 单次回捞上限 |
| `defaultReadLines` | `200` | 不写 `to` 时的默认页大小 |
| `maxArchiveBytes` | `256 MiB` | 单会话归档上限，超了就不再打包（保留内联原文） |
| `denyTools` / `allowTools` | `['solpack']` / `[]` | 不打包 / 只打包哪些工具 |
| `signalPattern` | 见 `lib/config.js` | 信号行正则（报错、exit code、栈帧…） |

### Action Fusion（`edit_verify`）

| 键 | 默认 | 作用 |
|---|---|---|
| `enableFusion` | `false` | 总开关 |
| `fusionToolName` | `edit_verify` | 注册的工具名 |
| `fusionRequireApproval` | `true` | 必须拿到 `allowed-once` 审批才动；`false` = 你自己承担绕过审批的风险 |
| `fusionTimeoutMs` | `120000` | 验证命令超时 |
| `fusionMaxOutputBytes` | `8000` | 结果内联上限（更大的会被本插件的打包机制接管） |

**为什么默认关**：它是这套东西里唯一会写文件、会跑命令的机制。开着它等于给模型多一个"写 + 跑"的入口（审批闸门还在），你自己决定要不要。

**为什么是独立工具，而不是给现有编辑工具加个字段**：两个原因——(1) dsh 按每个工具自己的 schema 校验参数，插件无法给不属于自己的工具增加 `thenRun` 字段；(2) dsh 没有公开的"工具里调工具"接口，嵌套派发是 registry 私有的，所以插件也无法包一层去调内置的编辑器工具。于是它直接走 `ctx.fs` / `ctx.shell` 这两个能力缝自己完成改动 + 验证（语义等价：一次调用完成改动 + 验证），沙箱与审批仍由 dsh 的服务承担。

### Online Context Compact

| 键 | 默认 | 作用 |
|---|---|---|
| `enableCompact` | `false` | 总开关 |
| `compactMinSteps` | `1` | 距上次尝试至少多少个完成的工具结果 |
| `compactCooldownMs` | `300000` | 两次询问的最小间隔 |
| `compactMinTokens` | `24000` | 表面压力低于此值不询问 |
| `compactKeepRatio` | `0.5` | 预计摘要后保留的表面比例 |
| `compactSummaryCostTokens` | `4000` | 摘要请求本身预计成本 |
| `compactMinSavingTokens` | `8000` | 预计节省低于此值不询问 |
| `compactTimeoutMs` | `120000` | 单次询问的取消期限 |
| `compactBoundaryTools` | `[]` | 非空时，只有这些工具的结果算"计划步骤边界" |

**它做什么、不做什么**：压缩本身仍然是 dsh 的 `ctx.compaction`（`dsh-compaction-basic`）在做——本插件**不总结任何东西**，只在"值得压缩的时刻"去问一次。`compactIfNeeded` 仍然有权拒绝；拒绝等于白问一次，什么都没变。询问走的是非关键路径（不阻塞工具结果返回）。

**为什么默认关**：这是对另一个子系统事务的策略，而且**没有实盘 loop 就无法验证**（见下）。

## 存储与安全

```
~/.dsh/solpack/<session>/objects/<ab>/obs-xxxxxxxxxx.txt   原文逐字节副本
~/.dsh/solpack/<session>/index.jsonl                       追加式索引
```

- 归档**按会话隔离**（句柄只在产生它的会话里可解析）
- 归档**不会自动删除**（证据优先，与上游一致）
- 打包/回捞/收据**全程不调用模型**，没有数据外发（上游 reducer 会把日志发给压缩模型，这里没有）
- 尊重 `DSH_HOME`（落 `$DSH_HOME/solpack`）
- `edit_verify` 不自己实现沙箱：写走 `ctx.fs`（沙箱感知 + 沿用 `fs/*-intent` 瀑布），命令走 `ctx.shell`（与 pwsh/bash 工具同一个执行器，沙箱默认值和上限由它施加）

## 验证情况

`npm test`（= `node test/smoke.mjs && node test/fusion-compact.mjs`）全绿，覆盖：

- **打包/回捞**：打包、字节级一致、`read` 精确分页与字节上限、`grep`/`stat`/`list`、同内容去重、非文本与混合内容不动、超大走收据、非法与未知句柄按提示降级
- **Action Fusion**：无能力 → 拒绝；**审批被拒 → 一个字都没写、一条命令都没跑**；write / 替换两条路径；缺 `old_string` → 拒绝；**编辑失败 → 命令不执行**；exit≠0 → `FAIL`
- **OCC**：低压不问、高压问一次、冷却到期再问、触发词是 `pressure`

另外：

- 两个工具的契约都通过了 **dsh 自己的** schema 校验器（`assertObjectJsonSchema` / `assertSupportedJsonSchema`）——参数落在 dsh 支持的子集内
- 压缩率实测（5010 行 / 316 KiB CI 日志）：普通预览 **2.4 KiB（−99.3%）**、收据 **4.7 KiB（−98.5%）**，收据里仍保留 `module not found` + 栈帧 + `exit code 1`

**还没验证的（照实说）**：

1. 插件**尚未在真实 dsh 进程里被 cordis loader 加载过**（本机没有可跑这一步的环境）。装完先看启动日志有没有 `solpack` 报错，失败基本只在两处：`dsh.bundle.patch` 路径 / `inject: ['tools']`。
2. `edit_verify` 的 dsh 服务调用是照着一方实现（`dsh-tool-fs` / `dsh-tool-pwsh`）写的，但**没有在真实 `ctx.fs`/`ctx.shell` 上跑过**；命令输出按 `ShellRunResult.stdout/stderr` 读取（`CollectedOutput`，兼容字符串与 `{text}` 两种形态）。真跑不通也是 fail-closed，不会误写误跑。
3. **OCC 无法在没有实盘 loop 的情况下验证**：闸门逻辑有测试，但它与 dsh 自身压缩调度的交错行为只能实测。这也是它默认关闭的原因。

## 目录结构

```
lib/config.js    配置默认值与钳制（dsh 的 JSON-Schema 子集没有 min/max，边界一律在代码里钳）
lib/store.js     会话级内容寻址归档：写入、账本、行索引、精确读取、grep、统计
lib/preview.js   字节安全头尾预览、确定性收据、锚点范围合并、证据比对
lib/tool.js      solpack 召回工具
lib/fusion.js    edit_verify：审批闸门 + ctx.fs 写入 + ctx.shell 执行
lib/compact.js   OCC 策略：步数/冷却/压力/经济学四道闸门
lib/index.js     插件入口：注册工具 + 挂 tools/post-execute
test/smoke.mjs   打包与回捞的端到端测试（临时 DSH_HOME）
test/fusion-compact.mjs  Action Fusion 与 OCC 的闸门测试（stub 掉 dsh 服务）
```