# MyPaste 代码扩展

[English](README.md) · 简体中文

为 [MyPaste](https://github.com/zhanghuid/mypaste-go) 提供的独立代码格式化、
语法高亮与跨设备同步扩展。

本仓库与 MyPaste 应用有意分开。扩展是本地的 `.mypaste-plugin` 包，由用户显式
安装，并按 manifest 摘要逐次授予能力。这里的任何东西都不会自动更新、自动
运行、在运行期下载代码，或直接写剪贴板。

## 包的种类

本仓库有三类包：

- **脚本包**（`plugins/mypaste.*`）——run-script 扩展，由 `scripts/package.py`
  从纯源码打包；语言表见下文。
- **工作台包**（`plugins/com.mypaste.code-card`、`plugins/com.mypaste.code-edit`、
  `plugins/com.mypaste.diff-view`、`plugins/com.mypaste.image-edit`）——一个
  HTML 文档，由 MyPaste 显示在工作台卡片里。它们不运行进程、不声明能力；
  见下文「工作台包」。
- **官方包**（`plugins/com.mypaste.*`）——编译后的 Go 二进制与工作台文档，
  带更宽的能力，由 `scripts/build-official.py` 构建；见下文「官方包」。
  `scripts/official_packages.py` 是这份清单的唯一所有者；
  `scripts/package.py` 从不打包或校验它们。

### 脚本包

每种语言有两个可独立安装的包：

| 语言 | 格式化 | 高亮 |
| --- | --- | --- |
| PHP | `mypaste.format-php` | `mypaste.highlight-php` |
| JSON | `mypaste.format-json` | `mypaste.highlight-json` |
| JavaScript | `mypaste.format-javascript` | `mypaste.highlight-javascript` |
| TypeScript | `mypaste.format-typescript` | `mypaste.highlight-typescript` |
| HTML | `mypaste.format-html` | `mypaste.highlight-html` |
| Python | `mypaste.format-python` | `mypaste.highlight-python` |
| Go | `mypaste.format-go` | `mypaste.highlight-go` |
| Rust | `mypaste.format-rust` | `mypaste.highlight-rust` |

格式化包申请 `selection.read` 与 `clipboard.write`。高亮包只申请
`selection.render`；它们不能写剪贴板、读历史、用文件、联网或执行任意命令。

## 命令声明

每个包都声明自己的命令作用于什么：

```json
"commands": [{
  "id": "format",
  "appliesTo": ["text", "rich_text"],
  "languages": ["go"],
  "capabilities": ["selection.read", "clipboard.write"],
  "...": "..."
}]
```

`appliesTo` 是封闭集合——`text`、`rich_text`、`image`、`link`、`file`、
`color`；`languages` 列出命令处理的代码语言。只有文本命令可以声明语言。
MyPaste 只对匹配的条目在 Cmd+K 命令面板里提供该命令，把它归到所声明的语言
下，并在运行前重查声明。没有声明时，包仍会被发现、可以安装，但它的命令
不会被提供。

`scripts/package.py` 拒绝命令缺失或误用这些字段的包：读不懂的声明在构建时
失败，而不是带着问题上架。

## 工作台包

`com.mypaste.code-card`、`com.mypaste.code-edit`、`com.mypaste.diff-view` 与
`com.mypaste.image-edit` 交付的是文档而不是进程。MyPaste 读取 manifest 的
`workbench.document`，包上自己的 CSP，放进沙箱 frame 显示；文档只能读取命令
所作用的条目，把文本或图片另存为一条新历史、复制文本或图片，然后关闭。
别的什么都到不了它——没有宿主绑定、没有资产路径、没有别的条目。

文档遵循宿主的视觉规则（宿主 D-1045）：不画圆角盒子。卡片、面板、按钮与
工具片一律直角；只有圆就是形状本意的地方（如状态点）才允许圆。

```json
"workbench": {"title": "代码卡片", "document": "workbench.html"},
"commands": [{
  "id": "clipboard.code-card",
  "title": "导出代码卡片",
  "appliesTo": ["text", "rich_text"],
  "workbench": true
}]
```

需要第二段文本才能工作的文档在工作台块里声明，宿主自己把相邻条目送来：

```json
"workbench": {
  "title": "高亮对比",
  "document": "workbench.html",
  "companion": "previous-text"
}
```

`"previous-text"` 是唯一被接受的词（D-1040）。宿主从可见列表里挑相邻条目——
有文本、不是图片、不是被调用的条目——优先前一条，否则取后一条；
`com.mypaste.code-edit` 与 `com.mypaste.image-edit` 声明了它；
`com.mypaste.code-card` 与 `com.mypaste.diff-view` 有意不声明。

每个包保留自己的 `src/`，彼此不共享代码；每个包都从自己这一侧声明桥协议与
自己的高亮或 diff 引擎。文本另存与复制以精确键的消息过桥
（`{v: 1, type: "save", requestId, text, title}` 与
`{v: 1, type: "copy", requestId, text}`）；宿主对文本再校验一次——1 MiB、
UTF-8、无控制字符——并按 `requestId` 把结果报回。另存写入一条新历史条目，
从不替换原条目。

宿主在 `ready` 之后带回 `item`（声明了 `companion` 时附带），并立即再发
`{v: 1, type: "theme", scheme: "light" | "dark", tokens: {"surface": "…"}}`
（D-1042、D-1043）。这个 scheme 是 MyPaste 从自己的外观设置解析出来的，
沙箱 frame 的 `prefers-color-scheme` 看不到它，所以文档按 `:root[data-scheme]`
上色，媒体查询只作为消息到达前显示的值。`tokens` 带的是该 scheme 解析出的
值——颜色与两个字体栈——键是宿主自己的 CSS 自定义属性名去掉 `--`。两个文档
把每个值镜像为 `--mp-<name>` 并在 CSS 里优先使用，自己的调色板作为旧宿主的
回退。读者在文档打开期间改外观或主题时，宿主会重发整对消息。

对比文档就地编辑：在任一窗格的任何位置——文本、行号、表头或最后一行之下的
空白——单击一次就打开该侧的编辑器；点击落在已渲染的行上时，光标在指针下，
否则在该侧末尾；拖选文本仍是选择。输入时只重绘另一列，最多每 150 ms 一次
（长文本重绘本身变慢时进一步退避），编辑器从不等 diff。两个窗格是一个
两列网格，行号各归各侧。

关闭属于宿主卡片。MyPaste 在工作台 chrome 里画唯一一个关闭控件，文档不得
再画第二个；文档仍可为 Escape 键请求桥关闭，但 Escape 先退出编辑模式
（对比文档正是这样用的）。

源码：

```
plugins/com.mypaste.code-card/
  mypaste.plugin.json
  src/main.ts          入口、控件、状态行
  src/bridge.ts        宿主桥（文档一侧的视角）
  src/card.ts          调色板、布局与画布绘制
  src/tokenize.ts      卡片自己的分词器与语言表
  src/workbench.html   标记、样式与 <!--bundle--> 占位
  workbench.html       生成物：归档里带的文档

plugins/com.mypaste.code-edit/   浮层编辑器（自己的分词器、
                                 语言表与桥）
plugins/com.mypaste.diff-view/   对比文档（自己的 diff 引擎
                                 与语言表；声明 companion）
```

单个文档用 `bun run build:workbenches` 构建（esbuild 把 `src/main.ts` 打成
片段）。`scripts/build-official.py` 往 staging 目录取同样的构建，归档里
永远不会有过期的输出。

## 官方包

`com.mypaste.ferry`——跨设备同步扩展——以编译二进制而不是运行脚本交付。
它的 Go 源码在 `plugins/com.mypaste.ferry/src/`（独立 `go.mod`）；归档里只有
manifest、`menu.html` 与构建出的 `ferry` 二进制，绝无源码树。它对话的中继
服务在 `servers/mypaste-relay/`（独立 `go.mod`），是一个独立的 HTTPS 服务，
不是插件包，单独部署。Ferry 需要运行脚本白名单之外的能力（`entry.payload`、
`network.outbound`（配置的主机）、`storage.plugin`、触发器）；MyPaste 在
安装确认里逐项列出，唯一的启用开关就是全部的许可决定（宿主 D-1039）。
没有签名或可信层级可取得。

`com.mypaste.sql`——SQL 工具包扩展（七方言的语法高亮、语法诊断与格式化，
词法分析用
[chroma](https://github.com/alecthomas/chroma)）——同样以编译二进制交付。
它的 Go 源码在 `plugins/com.mypaste.sql/src/`（独立 `go.mod`）；归档里只有
manifest 与构建出的二进制，绝无源码树。它的规格声明了 `targets` 列表，
归档按平台在 `bin/<goos>/<goarch>/` 下嵌套每平台一个二进制（Windows 为
`.exe`）；宿主按这个布局解析声明的入口（宿主 D-1057）。

本地构建官方包：

```sh
python3 scripts/build-official.py
python3 scripts/build-official.py --only com.mypaste.ferry
```

一步完成构建、测试与发布用 `sh scripts/release.sh`
（见[发布](#发布)）。

构建是确定性的——固定的 Go flags、固定的 zip 时间戳、每包一个入口——同一
份源码产出同一个归档与同一个 SHA-256 供审查。feed 带这个摘要；它不带签名，
MyPaste 遇到旧 feed 里的签名会忽略。

官方二进制为 macOS arm64 构建（`CGO_ENABLED=0`、`-trimpath`），与应用的
首发平台一致；声明了 `targets` 列表的包对列出的每个平台按同样方式构建。
应用交付更多平台时，再把目标加进 `scripts/official_packages.py`。

## 构建

要求：打包脚本需要 Bun 1.2+ 与 Python 3.11+；官方包需要 Go 1.27+。

```sh
bun install                                                # esbuild + tsc
bun run test                                               # Python 测试
bun run typecheck                                          # 两个包的 TS
bun run build:workbenches                                  # 两个文档
bun run build                                              # 脚本包
python3 scripts/build-official.py                          # 官方包
sh scripts/release.sh                                      # 构建、测试、发布
```

`dist/` 里每个包有一个 ZIP 根的 `.mypaste-plugin`。归档根必须是
`mypaste.plugin.json` 加入口脚本；工作台包则是 manifest 加它声明的那个文档。

## 发布

没有签名密钥：安装就是信任决定，MyPaste 授予安装确认里列出的能力，直到
扩展被停用（宿主 D-1039）。发布只有一条命令：

```sh
sh scripts/release.sh
```

它构建官方包、对着 feed 跑 `bun run test`、把 `dist/` 折进当前提交、
快进 `main` 并推送——MyPaste 读的 feed 就是 `main/dist/index.json`。
加 `--no-push` 可以停在发布之前。

脚本要求工作树干净且所在分支从 `main` 派生，否则拒绝启动。它在第一个失败
处停下：测试失败会把重建出的 `dist/` 留在树里，但什么都不提交、不推送。
先提交包、文档与 manifest 的改动：脚本会 amend 当前提交，使其成为发布提交。
工作台包与所有其他包一样，仍需宿主的安装确认才能运行。

## 本地安装

1. 打开 MyPaste Go -> 偏好设置 -> 扩展 -> 第三方。
2. 二选一：
   - 「导入整个文件夹…」并选择仓库根。MyPaste 递归发现 `dist/` 里的包并
     逐一安装。
   - 「安装 / 更新插件…」并选择一个 `.mypaste-plugin` 文件。
3. 刷新列表，只授予每个包声明的能力，然后在剪贴板命令面板里使用命令。
4. 高亮：选中一个代码条目并预览。没有授予高亮插件时，MyPaste 用内置的
   高亮器。

文件夹导入接受嵌套的包目录，跳过隐藏目录、`node_modules` 与 `.git`，
忽略符号链接，并逐包报告结果。部分失败不回滚已成功安装的包。

## 格式化依赖

源码仓库不自带编译工具链。格式化适配器使用用户已安装的工具，依赖缺失时
返回可见、可操作的错误。当前适配器：

- JSON：Python 标准库 `json`
- JavaScript / TypeScript / HTML：`node` 加本地、经审查的格式化代码
- PHP：`php`（语法感知的 token 格式化，无网络安装）
- Python：`python3` 加本地格式化模块
- Go：`gofmt`
- Rust：`rustfmt`

所有格式化器从 stdin 读一个 JSON 请求，返回纯文本。它们从不执行被格式化的
代码。发布新版本前，跑一遍语言夹具与归档校验器。

## 安全模型

- 高亮返回 token；从不返回 HTML。
- MyPaste 在宿主边界再次校验语言与 token 类型白名单、token 数量与总字节。
- 格式化失败保留原文；不完整的输出被拒绝。
- 本仓库没有脚本包申请网络、文件或进程能力。官方同步包申请
  `network.outbound`（HTTPS、配置的主机）与 `storage.plugin`；MyPaste 把
  两者挡在可信来源之后，并在安装对话框里展示。
- 应用的插件能力列表是授予上限，不是操作系统级沙箱。

提交进仓库的 `dist/` 目录就是 MyPaste 读取的固定 raw-GitHub feed：

```text
dist/
  index.json
  mypaste.format-go-2.0.0.mypaste-plugin
  mypaste.format-go-2.0.0.mypaste-plugin.sha256
  ...
```

`index.json` 是确定性生成的：`scripts/package.py` 写脚本包条目并沿用官方
条目，`scripts/build-official.py` 写（或刷新）官方条目。每个条目列出包的
ID、显示名、版本、描述、归档文件名、SHA-256 与运行协议，且每个条目都带
项目的 `repository` 地址
（`https://github.com/zhanghuid/mypaste-code-extensions`，由
`scripts/index_metadata.py` 持有），市场详情页靠它链接回源码。feed 不带
签名（D-1039）。`repository` 只存在于索引里，从不进包 manifest：宿主对
manifest 严格校验，旧宿主不认识的 manifest 字段会让整个包在那里判为无效。
同理，宿主忽略索引里它不认识的字段——旧 MyPaste 只是不显示仓库链接。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 宿主安装该插件所用的插件 ID。 |
| `name` | 是 | 显示名。 |
| `version` | 是 | 包版本。 |
| `description` | 是 | 一行描述。 |
| `fileName` | 是 | `dist/` 内的归档名。 |
| `sha256` | 是 | 归档摘要，宿主安装前校验。 |
| `runtimeProtocol` | 是 | 包使用的运行协议（`2`；无运行时的工作台包为 `0`）。 |
| `repository` | 否 | 项目地址，HTTPS，显示在市场详情页。宿主只在自己持有的这份索引里按插件 ID 解析出地址后才打开它——页面永远不提供 URL。 |

应用只抓取
`https://raw.githubusercontent.com/zhanghuid/mypaste-code-extensions/main/dist/index.json`，
然后在这个固定目录里解析包；它从不接受页面给的 URL 或文件系统路径。每次
包改动后提交 `dist/`，并用仓库的 annotated tag 发布。

参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与
[../mypaste-go/docs/PLUGINS.md](../mypaste-go/docs/PLUGINS.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。各工具链依赖仍归其自身许可所有；格式化适配器
调用本地安装的工具，不重新分发它们。
