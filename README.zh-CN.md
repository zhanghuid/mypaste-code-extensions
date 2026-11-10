# MyPaste 代码扩展

[English](README.md) · 简体中文

为 [MyPaste](https://github.com/zhanghuid/mypaste-go) 提供的独立代码格式化、
语法高亮与跨设备同步扩展。

本仓库与 MyPaste 应用有意分开。扩展是本地的 `.mypaste-plugin` 包，由用户显式
安装，并按 manifest 摘要逐次授予能力。这里的任何东西都不会自动更新、自动
运行、在运行期下载代码，或直接写剪贴板。

## 包的种类

所有包都使用 MyPaste 插件协议 v3。v3 有两种角色：

- **表面**——有 UI。交付一个页面，页面自己画界面，只通过表面桥接触宿主。
  除非 manifest 同时声明 `runtime`，表面不运行进程；code-edit 声明了，用于
  它自带的格式化。
- **能力**——没有 UI，只有命令。声明了展示位的命令由宿主展示，其余由表面
  通过注册表集成。

每个 manifest 还声明 `kind`（`"ui"` 或 `"command"`），表明包的构建形态。
打包脚本拒绝 `kind` 与形态不符的 manifest，feed（`dist/index.json`）也带
这个字段。

本仓库包含：

- **脚本能力包**（`plugins/mypaste.*`）——run-script 扩展，由
  `scripts/package.py` 从纯源码打包；语言表见下文。
- **二进制能力包**（`plugins/com.mypaste.ferry`、`plugins/com.mypaste.sql`）
  ——编译后的 Go 程序，由 `scripts/build-official.py` 构建。
- **设置页包**（`plugins/com.mypaste.sync`）——手写 `panel.html` 加编译后的
  Go runtime，由 `scripts/build-official.py` 构建。
- **表面包**（`plugins/com.mypaste.code-card`、`plugins/com.mypaste.code-edit`、
  `plugins/com.mypaste.diff-view`、`plugins/com.mypaste.image-edit`、
  `plugins/com.mypaste.json`、`plugins/com.mypaste.timestamp`）——一个 HTML
  页面，不运行进程；见下文「表面包」。
- **官方包**（`plugins/com.mypaste.*`）——上面的二进制与表面，由
  `scripts/build-official.py` 构建；见下文「官方包」。
  `scripts/official_packages.py` 是这份清单的唯一所有者；
  `scripts/package.py` 从不打包或校验它们。

### 脚本能力包

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

两类都只申请 `entity.read`。格式化返回文本，从不写剪贴板；高亮返回有界的
token 数组，从不返回 HTML 或 CSS。两者都不能读历史、用文件、联网或执行任意
命令。它们都不声明 `placement`，宿主因此从不直接展示：由表面通过注册表集成。
语言是包自己的内部概念，宿主从不推断。

## manifest 版本 3

所有 manifest 都是 `"manifestVersion": 3`，每条命令声明它作用于哪些实体形态：

```json
"commands": [{
  "id": "format",
  "title": "格式化 JSON",
  "forms": ["text"],
  "output": ["text"],
  "capabilities": ["entity.read"]
}]
```

`forms` 使用宿主的实体树：`text`（`plain`、`rich`）、`link`、`color`、
`media`（`image`、`audio`、`video`）与 `file`（`document`、`archive`、
`folder`、`other`）。声明匹配整棵子树，所以 `text` 同时覆盖纯文本与富文本。

`output` 声明命令产出的实体；宿主据此裁决结果能否另存或复制。缺省与
`forms` 相同。

命令上的 `capabilities` 声明这一条命令自己需要哪些服务。宿主在把实体交给命令
之前会检查它，而表面集成正是把缓冲区当作管道输入交过去——所以每个格式化器与
高亮器都在这里重复声明 `entity.read`。它只能收窄包的授权，不能扩大。

`placement` 声明宿主自己在哪里展示命令：

| placement | 出现位置 |
| --- | --- |
| `palette` | Cmd+K 命令面板 |
| `card-action` | 当前实体卡片/预览的动作行 |
| `trigger` | 后台触发器（宿主 D-1024），不占界面 |

命令可以不声明 `placement`：那它就是**纯能力**，宿主从不展示，只由表面通过
注册表（0/1/N，命中键只有实体类型）集成。

`kind` 对交付 `surface` 的包是 `"ui"`，其余是 `"command"`。manifest 可以
省略它（宿主按形态推导），但写了就必须一致。`ui` 包还可以声明 `runtime` 与
没有 `placement` 的内部命令；runtime 使用 v2 行协议，只有该包自己的表面
能看到或调用这些命令。

能力使用宿主的封闭服务清单，并只申请足以完成工作的最小一项：
`entity.read`、`entity.save`、`copy`、`clipboard.write`、`entry.payload`、
`secret.read`、`network.outbound`、`storage.plugin`、`companion.read`、
`history.exchange`。

`scripts/package.py` 拒绝缺少或误用这些字段的包，也拒绝仍带 v2 词汇
（`surface: "editor"`、`appliesTo`、`global`、`menus`、`workbench`、
`languages`）的 manifest：读不懂的声明在构建时失败，而不是带着问题上架。

## 表面包

`com.mypaste.code-card`、`com.mypaste.code-edit`、`com.mypaste.diff-view`、
`com.mypaste.image-edit`、`com.mypaste.json` 与 `com.mypaste.timestamp` 各自交付
一个页面。code-edit 另外交付 runtime 与内部命令，用于自带格式化（3.3.0）；
json 把固定版本的 Prettier（standalone 加 babel、estree 两个插件）打进页面；
其余四个不运行进程：

```json
"surface": {
  "entry": "preview.html",
  "forms": ["text"],
  "role": "open"
}
```

`forms` 声明表面适配的实体，`role` 是以下之一：

- `open`——「打开这个实体」的目标（卡片被双击、且它是默认表面时）。
  code-edit、diff-view、image-edit、json 与 timestamp 声明它。
- `preview`——画进剪切坞的卡片预览。code-card 声明它。

宿主把页面放进沙箱 frame，并中介这些操作：读取本次调用的条目、把文本或图片
另存为一条新历史、复制文本或图片、关闭。别的什么都到不了它——没有宿主绑定、
没有资产路径、没有别的条目。需要与相邻条目对比的表面声明 `companion.read`
并主动索取；相邻条目由宿主挑选，页面没有任何浏览历史的途径。

v3 移除了宿主工作台：没有缓冲区交换、没有宿主画的编辑器工具栏、也没有宿主画
的文档动作行（宿主 D-1065、D-1068）。每个页面自己画控件。例如 code-edit 的
页面自己画「复制文本」与「保存为新条目」，把注册表变成头部的「格式化」菜单与
「高亮」下拉。「格式化」始终带有编辑器自带的、针对识别语言的内置操作——Go、
JavaScript、TypeScript、Python、Rust、PHP、HTML、CSS、JSON、YAML、SQL 与
Shell，外加 SQL 压缩——通过本包 runtime 以 `format.go`、`compress.sql` 之类
的命令 id 调用，因此不安装任何其他包也能格式化；所有语言都在扩展内完成，
不依赖本机是否安装 gofmt、rustfmt、Python、Prettier 或其它工具。每个操作
各生成「全文」与
「选区」两个动作，按格式化 / 压缩分组（未知能力 id 进入「其它」）；关键字
大小写是「本地」动作，不需要 runtime。其他包提供的格式化能力会作为额外一行
加入菜单并标注来源，但内置已经为该语言提供的操作绝不重复出现：内置优先。
声明了 placement 的命令属于宿主的卡片动作，不会成为这里的菜单行。没有任何
适用操作时（纯文本没有格式化器），菜单用一行说明，而不是声称缺少能力包。
token 命令进入「高亮」，默认与失败回退都用页面自己的分词器；高亮从不依赖
已安装的包。选区动作由页面切片、对切片调用同一条全文命令、再拼回缓冲区，
能力本身不需要知道选区。当前不适用的动作（没有选区的选区动作、没有关键字的
语言里的关键字大小写）留在菜单里置灰，而不是消失。当前
宿主会用 `forms` 补全缺省的 `output`，两种命令在线上都是文本；在线上出现
「是否声明」之前，code-edit 也接受协议固定的 `format` / `compress` /
`highlight` 命令 id 作为声明形态。

- `{v: 1, type: "registry", requestId, forms}` → `{v: 1, type: "result",
  requestId, ok, commands: [{pluginId, commandId, title, description?,
  output?}]}`——适配这些实体形态的能力命令。
- `{v: 1, type: "invoke", requestId, pluginId, commandId, text}` → `{v: 1,
  type: "result", requestId, ok, output?, diagnostics?, render?}`——对当前
  缓冲区运行一条命令。宿主转交的 `render.tokens` 是有界的 `{text, kind}`
  序列；页面只在它们拼回发出的缓冲区时采用，否则保留自己的高亮。

文本另存与复制以精确键的消息过桥（`{v: 1, type: "save", requestId, text,
title}` 与 `{v: 1, type: "copy", requestId, text}`）；宿主对文本再校验一次
——1 MiB、UTF-8、无控制字符——并按 `requestId` 把结果报回。另存写入一条新
历史条目，从不替换原条目。

宿主在页面的 `{v: 1, type: "ready"}` 之后带回 `item`，并立即再发
`{v: 1, type: "theme", scheme: "light" | "dark", tokens: {"surface": "…"}}`
（宿主 D-1042、D-1043）。这个 scheme 是 MyPaste 从自己的外观设置解析出来的，
沙箱 frame 的 `prefers-color-scheme` 看不到它，所以页面按 `:root[data-scheme]`
上色，媒体查询只作为消息到达前显示的值。`tokens` 带的是该 scheme 解析出的
值——颜色与两个字体栈——键是宿主自己的 CSS 自定义属性名去掉 `--`。每个页面
把每个值镜像为 `--mp-<name>` 并在 CSS 里优先使用，自己的调色板作为旧宿主的
回退。读者在页面打开期间改外观或主题时，宿主会重发整对消息。

对比文档就地编辑：在任一窗格的任何位置——文本、行号、表头或最后一行之下的
空白——单击一次就打开该侧的编辑器；点击落在已渲染的行上时，光标在指针下，
否则在该侧末尾；拖选文本仍是选择。输入时只重绘另一列，最多每 150 ms 一次
（长文本重绘本身变慢时进一步退避），编辑器从不等 diff。两个窗格是一个
两列网格，行号各归各侧。

关闭属于宿主容器。MyPaste 在表面 chrome 里画唯一一个关闭控件，页面不得再画
第二个；页面仍可为 Escape 键请求桥关闭，但 Escape 先退出编辑模式（对比页面
正是这样用的）。页面遵循宿主的视觉规则（宿主 D-1045）：不画圆角盒子。卡片、
面板、按钮与工具片一律直角；只有圆就是形状本意的地方（如状态点）才允许圆。

源码：

```
plugins/com.mypaste.code-card/
  mypaste.plugin.json
  src/main.ts          入口、控件、状态行
  src/bridge.ts        宿主桥（页面一侧的视角）
  src/card.ts          调色板、布局与画布绘制
  src/tokenize.ts      卡片自己的分词器与语言表
  src/preview.html     标记、样式与 <!--bundle--> 占位
  preview.html         生成物：归档里带的页面

plugins/com.mypaste.code-edit/   编辑器（自己的分词器、语言表与桥；
                                 注册表驱动的「格式化」与「高亮」下拉；
                                 cmd/ 是 runtime，engines/ 是随包交付的
                                 格式化脚本）
plugins/com.mypaste.diff-view/   对比页面（自己的 diff 引擎与语言表；
                                 读取 companion）
plugins/com.mypaste.image-edit/  图片编辑器（自己的画布工具）
plugins/com.mypaste.json/        JSON 页面（Prettier 的 json 解析器与页面自己
                                 的 tokenizer 一起打进页面；只复制，无 runtime）
plugins/com.mypaste.timestamp/   时间戳页面（自己的解析与格式化；只复制，
                                 无 runtime）
```

用 `bun run build:surfaces` 构建每个页面（esbuild 把 `src/main.ts` 打成完整
文档）。`scripts/build-official.py` 往 staging 目录取同样的构建，归档里永远
不会有过期的输出。

## 官方包

`com.mypaste.ferry`——跨设备同步扩展——以编译二进制而不是运行脚本交付。
它的 Go 源码在 `plugins/com.mypaste.ferry/src/`（独立 `go.mod`）；归档里只有
manifest 与构建出的 `ferry` 二进制，绝无源码树。它对话的中继服务在
`servers/mypaste-relay/`（独立 `go.mod`），是一个独立的 HTTPS 服务，不是
插件包，单独部署。Ferry 需要运行脚本白名单之外的能力（`entry.payload`、
`network.outbound`（配置的主机）、`storage.plugin`、触发器）；MyPaste 在
安装确认里逐项列出，唯一的启用开关就是全部的许可决定（宿主 D-1039）。
没有签名或可信层级可取得。

`com.mypaste.sync`——S3 快照扩展——是有自己 runtime 的 UI 包：设置窗口的
「同步」菜单（`sync.panel`，顺序 50）是手写的 `panel.html`，所有动作都在编译
后的 `sync` runtime 里完成。runtime 经宿主只读的 `data.read` / `asset.read`
读取历史与资产，重建与宿主导出一致的 `.mypaste-backup` 归档，按
`MYPaste-Sync/1` 加密（PBKDF2-HMAC-SHA256 210000 次、16 字节盐、AES-256-GCM，
头部作 AAD），自己用 SigV4 签 ListObjectsV2 / PutObject / 分段 GetObject，
每次传输都经宿主的 `backup.sync` 服务。凭据、盐与口令只存在包的私有
`storage.plugin` 目录（0600），不进入页面或日志。定时触发每 15 分钟检查一次
保存的计划；失败从 15 分钟起倍增至 24 小时。两个 darwin 二进制按
`bin/<goos>/<goarch>/` 交付（宿主 D-1057），归档就是宿主未改动的
`.mypaste-backup` 格式，两边可以互相恢复。Go 源码在
`plugins/com.mypaste.sync/src/`（独立 `go.mod`）。

`com.mypaste.sql`——SQL 工具包扩展（七方言的语法高亮、语法诊断、格式化与
压缩，词法分析用 [chroma](https://github.com/alecthomas/chroma)）——同样以
编译二进制交付。它是纯能力：只暴露 `highlight`、`format` 与 `compress`
命令，没有 UI。压缩会去掉注释并把空白折叠成一行，原样保留字符串、引号标识符
与 `/*+ */` 优化器提示；有语法错误时拒绝结果而不是写出去。它的 Go 源码在
`plugins/com.mypaste.sql/src/`（独立 `go.mod`）；归档里只有 manifest 与构建
出的二进制，绝无源码树。它的规格声明了 `targets` 列表，归档按平台在
`bin/<goos>/<goarch>/` 下嵌套每平台一个二进制（Windows 为 `.exe`）；宿主按
这个布局解析声明的入口（宿主 D-1057）。

`com.mypaste.code-edit` 是两个组合型官方包之一：`kind` 为 `"ui"`，同时交付
页面与编译后的 runtime，并声明不带 `placement`、`output: ["text"]` 的内部
格式化命令。协议 v3 只让本包自己的表面看到这些命令；它们不会出现在 Cmd+K
命令面板或其他表面的注册表里。runtime 在 stdin/stdout 上使用与 v2 进程相同
的逐行 JSON 协议。格式化在编译进 runtime 的代码里完成：Go 用 `go/format`，
JSON 用 `encoding/json`，SQL 用共享的 `sqlkit`，CSS 用按花括号层级重排的
缩进器，其余语言只整理换行与行尾空白、绝不重排缩进层级。运行时不会在机器上
查找 gofmt、rustfmt、php、python3、tidy、shfmt 或 Prettier CLI，因此本机没有
安装任何格式化工具也能用。若本机恰好有 Node，runtime 可以改用归档自带的
辅助脚本：经过审查的 `js_format.mjs`（从 `shared/` 复制，测试保证逐字节一致）
与 CSS、YAML 用的固定版本 Prettier 3.6.2 standalone 构建
（`engines/prettier/`，MIT，见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）；没有 Node 时由内置引擎
回答。请求文本只走 stdin，从不经过 shell，runtime 也不读取自己目录以外的
任何文件。SQL 只有一个所有者：
`shared/sqlkit` 是一个 Go 模块，`com.mypaste.sql` 与 code-edit runtime 都
`replace` 到同一份源码，因此两个包编译并交付同一套分析、格式化与压缩实现，
不会各自漂移。

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
bun run typecheck                                          # 每个包的 TS
bun run build:surfaces                                     # 每个表面页面
bun run build                                              # 脚本包
python3 scripts/build-official.py                          # 官方包
sh scripts/release.sh                                      # 构建、测试、发布
```

`dist/` 里每个包有一个 ZIP 根的 `.mypaste-plugin`。归档根必须是
`mypaste.plugin.json` 加入口脚本；表面包则是 manifest 加 `surface.entry`
声明的那个页面。

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
先提交包、页面与 manifest 的改动：脚本会 amend 当前提交，使其成为发布提交。
表面包与所有其他包一样，仍需宿主的安装确认才能运行。

## 本地安装

1. 打开 MyPaste Go -> 偏好设置 -> 扩展 -> 第三方。
2. 二选一：
   - 「导入整个文件夹…」并选择仓库根。MyPaste 递归发现 `dist/` 里的包并
     逐一安装。
   - 「安装 / 更新插件…」并选择一个 `.mypaste-plugin` 文件。
3. 刷新列表，只授予每个包声明的能力，然后在剪贴板命令面板里使用命令。
4. 高亮：在集成注册表的表面里打开代码条目，或从命令面板运行高亮命令。

文件夹导入接受嵌套的包目录，跳过隐藏目录、`node_modules` 与 `.git`，
忽略符号链接，并逐包报告结果。部分失败不回滚已成功安装的包。

## 格式化依赖

独立的能力包（`mypaste.format-*`）使用用户已安装的工具，依赖缺失时返回
可见、可操作的错误。当前适配器：

- JSON：Python 标准库 `json`
- JavaScript / TypeScript / HTML：`node` 加本地、经审查的格式化代码
- PHP：`php`（语法感知的 token 格式化，无网络安装）
- Python：`python3` 加本地格式化模块
- Go：`gofmt`
- Rust：`rustfmt`

组合包 `com.mypaste.code-edit` 不依赖其中任何一项：格式化编译在它自己的
runtime 里，Node 只是让它启用归档内自带的辅助脚本（见上）。所有格式化器
从 stdin 读一个 JSON 请求，返回纯文本。它们从不执行被格式化的
代码。发布新版本前，跑一遍语言夹具与归档校验器。

## 安全模型

- 高亮返回 token；从不返回 HTML。
- MyPaste 在宿主边界再次校验实体形态与 token 类型白名单、token 数量与总字节。
- 格式化失败保留原文；不完整的输出被拒绝。
- 本仓库没有脚本包申请网络、文件或进程能力。官方同步包申请
  `network.outbound`（HTTPS、配置的主机）与 `storage.plugin`；MyPaste 在
  安装对话框里逐项展示。
- 应用的插件能力列表是授予上限，不是操作系统级沙箱。

提交进仓库的 `dist/` 目录就是 MyPaste 读取的固定 raw-GitHub feed：

```text
dist/
  index.json
  mypaste.format-go-3.0.0.mypaste-plugin
  mypaste.format-go-3.0.0.mypaste-plugin.sha256
  ...
```

`index.json` 是确定性生成的：`scripts/package.py` 写脚本包条目并沿用官方
条目，`scripts/build-official.py` 写（或刷新）官方条目。每个条目列出包的
ID、显示名、版本、类型、描述、归档文件名、SHA-256 与运行协议，且每个条目都带
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
| `kind` | 是 | `ui` 或 `command`，与包的形态一致。 |
| `description` | 是 | 一行描述。 |
| `fileName` | 是 | `dist/` 内的归档名。 |
| `sha256` | 是 | 归档摘要，宿主安装前校验。 |
| `runtimeProtocol` | 是 | 包使用的运行协议（`2`；无运行时的包为 `0`）。 |
| `repository` | 否 | 项目地址，HTTPS，显示在市场详情页。宿主只在自己持有的这份索引里按插件 ID 解析出地址后才打开它——页面永远不提供 URL。 |

应用只抓取
`https://raw.githubusercontent.com/zhanghuid/mypaste-code-extensions/main/dist/index.json`，
然后在这个固定目录里解析包；它从不接受页面给的 URL 或文件系统路径。每次
包改动后提交 `dist/`，并用仓库的 annotated tag 发布。

参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与
[../mypaste-go/docs/PLUGINS.md](../mypaste-go/docs/PLUGINS.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。各工具链依赖仍归其自身许可所有；独立格式化
适配器调用本地安装的工具，不重新分发它们；唯一随包分发的是 code-edit 内
固定版本的 Prettier 构建，见上。
