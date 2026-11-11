# MyPaste 代码扩展

[English](README.md) · 简体中文

为 [MyPaste](https://github.com/zhanghuid/mypaste-go) 提供的独立代码格式化与
跨设备同步扩展。

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
- **二进制能力包**（`plugins/com.mypaste.ferry`、`plugins/com.mypaste.sql`、
  `plugins/com.mypaste.link-mime`）——编译后的 Go 程序，由
  `scripts/build-official.py` 构建。
- **设置页包**（`plugins/com.mypaste.sync`、`plugins/com.mypaste.data-settings`）
  ——手写 `panel.html`，sync 另加编译后的 Go runtime，由
  `scripts/build-official.py` 构建。
- **表面包**（`plugins/com.mypaste.code-card`、`plugins/com.mypaste.code-edit`、
  `plugins/com.mypaste.diff-view`、`plugins/com.mypaste.image-edit`、
  `plugins/com.mypaste.json`、`plugins/com.mypaste.timestamp`、
  `plugins/com.mypaste.link-inspector`）——各自一个页面；code-edit 另带
  runtime 与内部命令；json 把引擎打进页面；link-inspector 经注册表调用
  链接识别能力并直接渲染链接；见下文「表面包」。
- **官方包**（`plugins/com.mypaste.*`）——上面的二进制与表面，由
  `scripts/build-official.py` 构建；见下文「官方包」。
  `scripts/official_packages.py` 是这份清单的唯一所有者；
  `scripts/package.py` 从不打包或校验它们。

### 脚本能力包

每种语言有一个格式化包：

| 语言 | 格式化 |
| --- | --- |
| PHP | `mypaste.format-php` |
| JSON | `mypaste.format-json` |
| JavaScript | `mypaste.format-javascript` |
| TypeScript | `mypaste.format-typescript` |
| HTML | `mypaste.format-html` |
| Python | `mypaste.format-python` |
| Go | `mypaste.format-go` |
| Rust | `mypaste.format-rust` |

每个都只申请 `entity.read`。格式化返回文本，从不写剪贴板。它不能读历史、用
文件、联网或执行任意命令。它不声明 `placement`，宿主因此从不直接展示：由
表面通过注册表集成。语言是包自己的内部概念，宿主从不推断。语法高亮不再作为
能力包存在：code-edit 与 code-card 两个表面用自己的分词器渲染（见「表面包」），
`com.mypaste.sql` 仍返回 SQL token。

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
之前会检查它，而表面集成正是把缓冲区当作管道输入交过去——所以每个格式化器
都在这里重复声明 `entity.read`。它只能收窄包的授权，不能扩大。

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
`backup.schedule`、`boards.control`、`saved-searches.control`、`backup.sync`、
`data.read`、`asset.read`、`settings.data`。`surface.network` 是唯一只向官方包
开放的页面授权：放宽本包表面文档的页面策略，让页面加载它要渲染的内容
（宿主 D-1100）。

`scripts/package.py` 拒绝缺少或误用这些字段的包，也拒绝仍带 v2 词汇
（`surface: "editor"`、`appliesTo`、`global`、`menus`、`workbench`、
`languages`）的 manifest：读不懂的声明在构建时失败，而不是带着问题上架。

## 表面包

`com.mypaste.code-card`、`com.mypaste.code-edit`、`com.mypaste.diff-view`、
`com.mypaste.image-edit`、`com.mypaste.json`、`com.mypaste.timestamp` 与
`com.mypaste.link-inspector` 各自交付一个页面。code-edit 另外交付 runtime 与
内部命令，用于自带格式化（3.3.0）；json（3.3.1）是纯表面包：Prettier 的
standalone 构建加 babel、estree 两个插件打进页面本身，格式化、转换与过滤都在
文档内完成，不需要 Node，也没有 runtime。工作区是两列：左侧只读显示条目原文，
右侧接收全部结果（打开时的美化、压缩、转义、XML、TypeScript、过滤结果与粘贴
转换），原文既不会被改写，也不会被自己的结果盖住。link-inspector 同样是纯表面
包：它经注册表调用 `com.mypaste.link-mime`，再按 MIME 选渲染器把链接显示出来
（见下文「链接类型」）。宿主读取表面文档的上限是 1 MiB（宿主仓库 D-1091），
构建出的页面都在此之内。其余包不运行进程：

```json
"surface": {
  "entry": "preview.html",
  "forms": ["text"],
  "role": "open",
  "chrome": "page"
}
```

`forms` 声明表面适配的实体，`role` 是以下之一：

- `open`——「打开这个实体」的目标（卡片被双击、且它是默认表面时）。
  code-card（6.3.0）、code-edit、diff-view、image-edit、json、timestamp 与
  link-inspector 声明它。
- `preview`——画进剪切坞的卡片预览。目前没有包声明它：code-card 一直声明它，
  6.0.0 起改为以自己的整页打开。

`chrome` 可选，且只有 `open` 表面能声明 `"page"`：卡片外框整块归页面，宿主
隐藏自己的页眉与页脚，页面经桥的 `close` 请求关闭。省略时保留宿主卡片
（`"host"`）。code-card（6.3.0）、code-edit（3.7.1）、diff-view（3.2.1）、
json（3.3.1）与 link-inspector（1.0.0）声明 `"page"`；image-edit 与
timestamp 保留宿主卡片。

宿主把页面放进沙箱 frame，并中介这些操作：读取本次调用的条目、把文本或图片
另存为一条新历史、复制文本或图片、关闭。别的什么都到不了它——没有宿主绑定、
没有资产路径、没有别的条目。需要与相邻条目对比的表面声明 `companion.read`
并主动索取；相邻条目由宿主挑选，页面没有任何浏览历史的途径。

v3 移除了宿主工作台：没有缓冲区交换、没有宿主画的编辑器工具栏、也没有宿主画
的文档动作行（宿主 D-1065、D-1068）。每个页面自己画控件。例如 code-edit 的
页面按 GitHub 网页编辑器画整条 chrome：可编辑标题的标签页，一条工具栏（「语言」
与「格式化」两个下拉 + 复制与保存图标），行号槽与代码面，底部状态栏。高亮对比
与 JSON 编辑器沿用同一条 chrome。对照页的工具栏是语言徽标加复制、保存；
JSON 页把同一行铺成一排图标——美化、压缩、转义为字符串、XML、TypeScript 与
复制——行尾是「保留转义」开关，决定右侧结果把 `\uXXXX` 与 `\/` 显示为字符还是
按转义写法重新生成；
表达式过滤框放在「原始」面板的标题行里。「格式化」
下拉把注册表变成一张扁平菜单，「语言」下拉决定分词器与内置操作。「格式化」
始终带有编辑器自带的、针对识别语言的内置操作——Go、
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
语法高亮是页面自己的分词器，覆盖全部十二种语言——与卡片预览同一个——所以
从不依赖已安装的包。选区动作由页面切片、对切片调用同一条全文命令、再拼回缓冲区，
能力本身不需要知道选区。当前不适用的动作（没有选区的选区动作、没有关键字的
语言里的关键字大小写）留在菜单里置灰，而不是消失。当前
宿主会用 `forms` 补全缺省的 `output`，token 命令在线上也是文本；在线上出现
「是否声明」之前，code-edit 仍把协议固定的 `highlight` id 挡在格式化列表之外
（`highlight` 命令返回 render token 而非文本——`com.mypaste.sql`），并只把
`format` / `compress` 当作文本。

- `{v: 1, type: "registry", requestId, forms}` → `{v: 1, type: "result",
  requestId, ok, commands: [{pluginId, commandId, title, description?,
  output?}]}`——适配这些实体形态的能力命令。
- `{v: 1, type: "invoke", requestId, pluginId, commandId, text}` → `{v: 1,
  type: "result", requestId, ok, output?, diagnostics?, render?}`——对当前
  缓冲区运行一条命令。格式化消费 `output`；宿主转交的 `render` 携带
  有界的 `{text, kind}` token，本页面不使用，因为自己的分词器是唯一的
  高亮。

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

关闭属于画卡片的一方。默认的宿主外框下，MyPaste 画唯一一个关闭控件，页面不得
再画第二个；三个页面外框的表面自己在标签条右端画一个方形关闭按钮，经桥请求
关闭。Escape 同样请求桥关闭，但先退出页面自己的模式：打开的下拉，或对比页面的
编辑模式。页面遵循宿主的视觉规则（宿主 D-1099）：圆角只来自同一套阶梯——控件
6px、卡片与弹出层 10px、面板与对话框 14px，指示条与滚动条是胶囊；只有圆就是
形状本意的地方（如状态点）才用 50%。

### 链接类型

`com.mypaste.link-inspector` 与 `com.mypaste.link-mime` 是同一个功能的两半，
也是 v3 组合路径的示例：识别器是二进制包，命令没有 `placement`，宿主不把它
列进任何菜单，只有别的表面来问时才调用。检查器打开一条 `link` 条目，先问
注册表有哪些能力适配链接，再在宿主返回的答案里找到识别器的
`{pluginId, commandId}` 对，用它和链接文本发起调用。页面从不自己拼命令名；
识别器缺失或停用是页面上的一种可见状态，而不是一次失败的调用。

识别器离线推断 MIME，只依据 URL 文本，顺序是：`data:` URL 自带媒体类型、
协议（`mailto:` → `message/rfc822`，`magnet:` → `application/x-bittorrent`）、
路径扩展名（`.png` → `image/png`，`.docx` → OOXML 文档类型）、仅在扩展名无法
识别时查已知站点、查询参数里的文件名提示（`?filename=…`、`?format=…`），
最后是 `http(s)` 的网页默认值或 `file:` 的 `application/octet-stream`。类型、
站点、协议与各自的标签都只在同一份数据文件
（`src/internal/linkmime/mime-types.json`）里，并嵌入二进制；优先级与结果文档
由 Go 代码所有。它不抓取链接本身：`network.outbound` 只能到达已声明的主机，
而从 URL 推断是无需联网时唯一诚实的答案。结果带 `confidence` 与 `evidence`
列表，页面用只读查表把这两个封闭词集翻成中文；版本更新的结果文档整份拒绝，
不画一半。

类型确定之后，检查器负责渲染。它声明宿主只向官方扩展开放的
`surface.network` 能力（宿主 D-1100）：这条能力只放宽**这一个表面文档**的
策略，别的页面、菜单与插件路径都不变，页面因此可以自己加载链接。图片、视频
与音频交给浏览器自己的 `<img>`、`<video>`、`<audio>`；`data:` 内容在本地
解码，不经过网络；JSON、XML、HTML、CSV 等文本抓回来后格式化再画——JSON 能
解析就缩进，HTML 只显示源码、从不执行，每份内容最多显示 20 万个字符。PDF、
压缩包没有页面内渲染器，跨域的 JSON 端点可能拒绝读取（CORS），主机也可能
超时；这些情况都会把预览区换成一张卡片，写清尝试了什么、为什么停下，并提供
重试与复制链接。识别器仍然不抓任何东西：两半各守其职，只有被要求显示链接的
页面才联网。

### 代码卡片

代码卡片把条目画在 canvas 上并导出一张 PNG；不联网，页面也没有宿主绑定。
6.0.0 让页面自己就是卡片：声明 `"role": "open"` 与 `"chrome": "page"`，宿主
不再画页眉和底部动作条，页面在最右画自己的关闭按钮（方块 X），Esc 也归页面
——先关打开的浮层，再按一次才经桥关闭。工作台沿用 5.0.0 的 Carbon 编辑器
（carbon.now.sh）布局：40 px 工具栏上是主题与语言两条下拉、设置、复制、导出
拆分按钮与关闭按钮；中间一块画布把卡片连同导出留白一起居中；316 px 的设置
浮层上方是背景条（宿主的底色、透明和 Carbon 的八个颜色），下方紧跟十六进制
输入，再往下是「窗口 / 编辑器」两栏。背景只在浮层里选：5.0.0 工具栏上的色块
重复了同一组十个选项，已经去掉。卡片沿用 Carbon 的尺寸：48 px 窗口带、
16 / 18 / 18 px 内边距、133% 行高和 20 px / 68 px 投影，圆角则取宿主的阶梯。
默认配色仍是 4.0.0 的「跟随宿主」：它读宿主的代码表面与语法令牌，所以导出的
图片和读者正在看的编辑器一致；另有七套内置配色（三浅四深）供刻意选择。侧栏
可选 macOS / Windows / 无窗口、行号、11–20 px 字号、100–200% 行高、两轴各
16–128 px 留白、投影偏移与模糊、自适应或固定宽度，以及透明或十六进制背景；
导出为 1× 或 2×。

6.0.0 还修好了文字进入卡片的路径。分行时曾经丢掉每个词元的 kind，于是每张卡
都被画成一种颜色；现在 kind 跟着词元走，画布上用的是该类词元的调色板颜色。
宽字符（中日韩文字、全角符号、emoji）在量宽与绘制时各占两格，中文不再压住
后面的文字，也不再提前换行。每条条目按自己的内容判读：新条目到达时语言下拉
回到「自动识别」，不会用上一条选过的语言去扫描这一条。单行内容在绘制前重新
排版——JSON 走自己的解析器，HTML 与 CSS 走保守的大括号与标签重排器，括号或
标签不闭合、以及含 `script`、`style`、`pre`、`textarea` 这类原样文本元素的
文档一律原样返回，不做修补；本来就有换行的内容是作者自己的排版，照原样绘制，
JavaScript、TypeScript、Go、Rust、PHP、SQL 以及空白有语义的语言永不重排。
整个页面仍是一个文档加一段打包脚本：没有 runtime，没有网络，也不下载字体。
没有照搬 Carbon 的部分：SVG 导出（卡片只在 canvas 上量一次、画一次）、图片或
渐变背景（文件输入会多出一条数据路径）、下载字体与上百种语言包（每种语言都是
页面自己持有的一张小关键字表）。

6.1.0 让窗口按真正画出的字形定宽。自适应宽度以前把字符数乘以固定的 0.602 em
字宽，字体比它窄时卡片右边就会空出一条，比它宽时右侧内边距又会被吃掉；现在
布局向画布要每个词元的 `measureText`，绘制也按同一份量值推进，所以卡片就是
文本本身加 16 / 18 px 内边距，极短的源码只保留窗口控件所需的 96 px 下限。
工具栏同理：下拉的宽度跟着它最长的选项走，不再固定在 216 / 168 px 的空盒子里，
标签不会再被一段空工具栏围住；选中一项之后也不会留下浏览器在 40 px 控件里画的
2 px 强调色描边——聚焦只体现为抬起的底面和被点亮的图示，一个指示，没有边框。

6.2.0 让长行折在页面里，而不是把页面撑宽。工作台按舞台真正给出的宽度排版，
长行就在那里折行——有空格时断在空格处，只有整行都放不下的词才被切断——页面
因此不再出现横向滚动条；「编辑器」栏的「自动换行」可以关掉，保留一条长行。
同一版把内容变成可编辑：工具栏的铅笔在卡片上方展开编辑区，边打边重绘，Tab
缩进两个空格，Esc 只收起编辑区、不关闭面板。改动只属于这一次打开——不写回
条目，关掉之后历史保持原样。

源码：

```
plugins/com.mypaste.code-card/
6.3.0 把编辑放进卡片本身。点一下卡片，光标就落在点到的字符上——布局记下每
一行画出的文字在源码里的起点，折过行也照样对得准——卡片当场换成同一张卡片：
调色后的正文后面压着一个透明文本框，位置和字号都不动，也不再展开第二块区域；
Tab 缩进两个空格，Esc 或点卡片外面回到画布。工具栏的铅笔进入的是同一处，宽度
依旧跟着输入走。

  mypaste.plugin.json
  src/main.ts          入口、控件、状态行
  src/bridge.ts        宿主桥（页面一侧的视角）
  src/card.ts          调色板、布局与画布绘制
  src/tokenize.ts      卡片自己的分词器与语言表
  src/format.ts        单行内容的重新排版（JSON、HTML、CSS）
  src/preview.html     标记、样式与 <!--bundle--> 占位
  preview.html         生成物：归档里带的页面

plugins/com.mypaste.code-edit/   编辑器（自己的分词器、语言表与桥；
                                 可编辑标题的标签页 + 「语言」与「格式化」
                                 两个下拉，后者由注册表驱动；cmd/ 是
                                 runtime，engines/ 是随包交付的格式化脚本）
plugins/com.mypaste.diff-view/   对比页面（自己的 diff 引擎与语言表；
                                 读取 companion）
plugins/com.mypaste.image-edit/  图片编辑器（自己的画布工具）
plugins/com.mypaste.json/        JSON 编辑器页面（Prettier 打进文档，另有自己
                                 的 XML / YAML / TypeScript 转换与表达式求值；
                                 没有 runtime，只复制）
plugins/com.mypaste.link-inspector/ 链接类型页面（打开链接、在注册表里找识别
                                 器、画它返回的文档并渲染链接；无 runtime，
                                 只复制，会加载远程内容）
plugins/com.mypaste.link-mime/   链接识别器（Go，无 placement：只凭 URL 文本
                                 推断 MIME；类型表与站点表是同一份嵌入的 JSON
                                 文件）
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

`com.mypaste.link-mime` 是最小的二进制包：runtime 读一条 `{type, text}` 调用、
解析 URL 后退出，只声明 `entity.read`，只构建宿主首个交付平台。`detect` 命令
没有 `placement`，任何菜单都不列出它；调用它的是纯表面包
`com.mypaste.link-inspector`，经注册表找到命令。类型表嵌入二进制，归档里只有
manifest 与一个可执行文件。

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

`com.mypaste.data-settings`——设置窗口的「数据」页——是没有 runtime 的菜单
包：归档里只有 manifest 和 `data.panel`（顺序 51）指名的手写 `panel.html`。
页面只经 `settings.data` 与宿主往来；选文件、检查归档与所有写入都在宿主侧
完成。页面字节就是应用内嵌的那份，所以从扩展市场安装后它仍是随包扩展。

`com.mypaste.sql`——SQL 工具包扩展（七方言的语法高亮、语法诊断、格式化与
压缩，词法分析用 [chroma](https://github.com/alecthomas/chroma)）——同样以
编译二进制交付。它是纯能力：只暴露 `highlight`、`format` 与 `compress`
命令，没有 UI。压缩会去掉注释并把空白折叠成一行，原样保留字符串、引号标识符
与 `/*+ */` 优化器提示；有语法错误时拒绝结果而不是写出去。它的 Go 源码在
`plugins/com.mypaste.sql/src/`（独立 `go.mod`）；归档里只有 manifest 与构建
出的二进制，绝无源码树。它的规格声明了 `targets` 列表，归档按平台在
`bin/<goos>/<goarch>/` 下嵌套每平台一个二进制（Windows 为 `.exe`）；宿主按
这个布局解析声明的入口（宿主 D-1057）。

`com.mypaste.code-edit` 是组合型官方包：`kind` 为 `"ui"`，同时交付
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

`com.mypaste.json` 是纯表面包（3.5.1）：归档里只有 manifest 与一份
`preview.html`，不运行任何进程。页面左侧是条目原文，每一步结果写在右侧；两侧
是同一套面板——可编辑、带行号与语法高亮。长行默认在面板内自动换行（工具栏的
「自动换行」开关关闭后恢复横向滚动；换行的逻辑行只在首行标一次号，续行留空，
行号仍对应它命名的行）。右侧是左侧的预览：改动原文后，选中的
那一步会在短暂停顿后重新生成结果；直接在右侧动笔，它就成了自己的文档，直到再
选一次动作。两侧都会就地报错：出错的字符画上波浪线，所在行号标红，说明文字写在
面板下方；原文解析不了时，右侧保留上一份好结果。Prettier 的
standalone 构建连同 babel、estree 两个插件打进页面，美化不离开文档，也不需要
Node。Prettier 会保留源文的转义写法，所以页面自己整理：`\uXXXX` 与 `\/`
还原为字符，工具栏的「保留转义」开关则让右侧按转义写法重新生成。宿主读取表面
文档的上限是
1 MiB（宿主仓库 D-1091），构建出的页面在此
之内。粘贴 URL 参数、XML 或 YAML、压缩、转义、JSON→XML 与 JSON→TypeScript
都写入这个结果面板；「原始」面板标题行里的过滤框对条目原文
求值一个很小的
JavaScript 子集（成员访问、下标、数组方法、比较，以及以点开头的简写）。页面
没有数据库或文件访问，也不发起网络请求；复制是 `copy` 桥消息，由宿主执行。

供应链：Prettier 3.6.2 是这个包里唯一的第三方库（它早已为 code-edit 固定并随
包分发，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。XML 读写、YAML
子集读取、TypeScript interface 生成与表达式求值器都写在本仓库：它们各自很小，
页面在 CSP 下不能用 `eval`，引入解析库反而比被替代的代码带来更大的审查面。
求值器有自己的词法分析与语法分析，只放行具名的数组与字符串方法，拒绝
`__proto__`/`constructor` 一类键，并在固定步数后停止。

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
4. 语法高亮：在 code-edit 或 code-card 表面里打开代码条目，各自用自己的
   分词器渲染。

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
固定版本的 Prettier 构建，以及打进 json 页面的同一构建，见上。
