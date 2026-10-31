# osu! Tournament Data

从 osu! 官方多人对局记录和用户上传的图池 CSV 生成赛后数据 PPT，保留可在 PowerPoint/WPS 中编辑的文本、形状与图片。

## 制作贡献

PPT 模板制作和 Rating 计算由 **Old Pigeon** 完成。

## 支持的比赛

| 比赛 | 固定人数 | PPT 模板 |
| --- | --- | --- |
| OWC | 4v4 | 已支持 |
| MWC4k | 3v3 | 已支持 |
| CWC | 3v3 | 待配置 |
| TWC | 2v2 | 待配置 |
| MWC7k | 2v2 | 待配置 |

## 下载与启动

可选择以下任意一种方式。两种方式均使用公开依赖，直接编辑模板内的 OOXML，保留可编辑的文本、形状、图片和母版。

### 方式一：免安装运行包

在仓库的 [Releases 页面](https://github.com/ToiletWater1234/osu-tournament-data/releases)下载 `osu-tournament-data-windows-x64.zip`，完整解压到可写文件夹，再双击 `一键启动.bat`。运行包包含 Node.js 和所需公开依赖，无需另行安装 Node.js 或执行 npm 命令。不要直接在压缩包内启动，也不要只解压 BAT 文件。

首次使用需要配置自己的 osu! OAuth；字体可从 `assets` 文件夹右键安装。运行包不包含作者的 OAuth 凭据。

### 方式二：从源码运行

需要 Windows、Node.js 22 或更高版本，以及以下依赖：

- `jszip`：读写 PPTX 压缩文件。
- `@xmldom/xmldom`：编辑 PPTX 内的 XML，复用原模板对象和样式。
- `sharp`：处理曲绘及图片尺寸。

直接双击 **`一键安装依赖.bat`**：已有完整依赖时会直接验证；缺少依赖时按锁文件安装；缺少兼容的 Node.js 或 npm 时，会从 Node.js 官网下载 Node.js 24 LTS，校验 SHA256 后放入项目内的 `runtime/`，再安装依赖。无需管理员权限，不修改系统 PATH。完成后双击 `一键启动.bat`。

首次安装需要联网，请先关闭正在运行的本地服务。失败窗口会保留提示，日志位于 `.tmp/dependency-install.log`。免安装运行包通常不需要执行此步骤。

若希望手动操作，可在项目目录执行：

```powershell
npm ci
npm run check:dependencies
npm test
npm start
```

浏览器访问 `http://127.0.0.1:4173`。也可双击 `一键启动.bat`，或用 `start.ps1` 在终端运行。应用内部路径均相对项目目录解析。

字体位于 `assets/TORUS-REGULAR.OTF` 和 `assets/TORUS-BOLD.OTF`，首次使用可右键选择安装，供 PowerPoint/WPS 显示 PPT 使用。

如果旧版本提示缺少 `@oai/artifact-tool`，请更新到此版本并重新执行 `npm ci`。新版已移除此私有依赖，不需要下载、复制或安装该包。启动脚本会先检查公开依赖，避免填写比赛后才发现依赖缺失。

维护者可在 Windows 上运行 `npm run build:portable` 构建免安装 ZIP；输出位于 `dist/`。构建过程按锁文件安装公开依赖，不打包本机 `.local`、测试输出或私有模块。运行包与源码应使用相同 CPU 架构的 Node.js 构建。

## OAuth 与数据目录

首次使用在页面中填写自己的 osu! OAuth Client ID 和 Client Secret。配置会在本机加密保存，Secret 不会回填到页面。

- 私有配置位于项目内的 `.local/`，生成文件位于 `outputs/`。
- `.local/`、依赖、临时文件和生成文件均由 `.gitignore` 排除。

## 使用流程

1. 选择比赛，再上传图池 CSV。
2. 填写比赛信息，或导入比赛信息 CSV。
3. 从 mplink 分析正式赛图；未手动分析时，生成前会自动分析。
4. 填写 Roll 和 BP，生成可编辑 PPTX。

## CSV 格式与示例

应用读取两种独立文件：**图池 CSV 为必选**，定义图池编号与谱面 ID 的对应关系；**比赛信息 CSV 为可选**，用于批量填写表单。先选择比赛类型、读取图池，再导入比赛信息；导入后仍可手动修改。

CSV 使用英文逗号分隔，建议保存为 UTF-8 编码。Excel 可选择“CSV UTF-8（逗号分隔）”；也可用文本编辑器保存为 `.csv`。值中含逗号时，用英文双引号包住整个值；值中的双引号写成两个双引号。不要用中文逗号、分号或制表符代替分隔符。

### 图池 CSV：首行为表头，每行一张谱面

| 列名 | 必填 | 含义与匹配方式 |
| --- | --- | --- |
| `id` 或 `code` | 是 | 图池编号，如 `RC1`、`LN2`、`NM1`、`HD1`、`HR1`、`DT1`、`FM1`、`TB`。这是 BP 下拉框和 PPT 显示的编号，不是官网谱面 ID。 |
| `map id` 或 `beatmap_id` | 是 | 官网单张难度的数字 beatmap ID。必须与 mplink 中游玩的谱面 ID 一致。填写纯数字，不填整条链接或 beatmapset ID。 |
| `artist - title [difficulty]` 或 `title` | 否 | 便于人工查看的谱面名称；正式展示的谱面资料仍从 osu! 官网获取。 |

列的顺序可以变化，表头不区分大小写，会去除首尾空白。每类字段只需选择一种列名，不要同时填写两种别名。没有有效编号或数字谱面 ID 的行会被忽略。其他列可以保留，但不会用于填写选手成绩。

例如，链接 `https://osu.ppy.sh/beatmapsets/123456#mania/7654321` 中，应填 `7654321`，而不是 `123456`。图池编号建议统一使用大写、不要重复；BP 的值必须与图池编号完全一致，`RC1` 与 `rc1` 不作为同一个选项。

以下图池示例中的 ID **仅演示文件结构**，请替换为实际比赛的谱面 ID；它们不代表所列编号对应的真实赛图，也不是完整比赛图池。

MWC4k 图池示例 `mwc4k_mappool.csv`：

```csv
id,map id
RC6,7654301
RC7,7654302
RC8,7654303
LN1,7654304
LN4,7654305
HB1,7654306
TB,7654307
```

OWC 图池示例 `owc_mappool.csv`，使用另一组等价列名，并添加可选标题：

```csv
code,beatmap_id,title
NM1,7654401,Example Artist - NM Map [Insane]
NM4,7654402,Example Artist - Another NM Map [Expert]
HD1,7654403,Example Artist - HD Map [Expert]
HD2,7654404,Example Artist - Another HD Map [Expert]
HR1,7654405,Example Artist - HR Map [Expert]
DT1,7654406,Example Artist - DT Map [Insane]
DT3,7654407,Example Artist - Another DT Map [Insane]
FM1,7654408,"Example Artist - Song, Part II [Expert]"
TB,7654409,Example Artist - Tiebreaker [Extra]
```

应用按 mplink 的正式对局顺序逐张对照数字谱面 ID，不按 CSV 行序决定选图顺序，也不靠歌曲名称猜测。请使用与该场比赛相同轮次的完整图池，否则会跳过无法匹配的正常谱面。对局中途被删除的赛图会保留，无法获取的资料显示 `?`。

### 比赛信息 CSV：不加表头，每行一个字段

使用 `字段名,值` 的纵向结构，一份文件描述一场比赛。**不要写 `key,value` 表头，也不要把所有字段放在一行横向表头中。** 行的顺序不限，字段名不区分大小写并会去除首尾空白；建议直接使用下面列出的英文名称。

| 字段名 | 对应内容 | 填写示例与说明 |
| --- | --- | --- |
| `tournament_type` | 比赛类型 | `OWC`、`MWC4k`、`CWC`、`TWC`、`MWC7k`；推荐显式填写。目前只有 OWC、MWC4k 可生成。 |
| `tournament_name` | PPT 比赛名称 | `osu! World Cup 2025`；这是显示名称，与比赛类型字段不同。 |
| `round` | 比赛轮次 | `Round of 16`、`Quarterfinals`、`Semifinals`、`Finals`、`Grand Finals`。OWC 的 Ban 数量按此字段识别，请使用英文轮次。 |
| `bracket` | 分组/赛段文字 | 如 `Winners Bracket`、`Losers Bracket`、`Losers Final`、`Grand Final`、`Bracket Reset`，也可填写其他文字。 |
| `best_of` | Best of X | 只填数字 `7`、`9`、`11`、`13`、`15`，不要写成 `BO13`。 |
| `match_time` | 星期、日期、时间、时区 | 如 `Sun 14 Dec @20:10(UTC+0)`；具体格式见下文。 |
| `mplink` | 官方多人对局记录 | 填纯数字 `119328425` 或完整链接 `https://osu.ppy.sh/community/matches/119328425`。纯数字会自动拼接为完整链接。 |
| `red_team` / `blue_team` | 红队/蓝队名称 | 如 `China`、`United States`；按实际房间红蓝方填写。 |
| `red_seed` / `blue_seed` | 红队/蓝队种子 | 如 `#1`、`#22`；按希望在 PPT 上显示的文字填写。 |
| `red_roll` / `blue_roll` | 两队 Roll | 填非负整数，或填写 `win` / `lose`；关键字不区分大小写。 |
| `red_protect` / `blue_protect` | 两队 Protect | 仅 MWC4k 使用，例如 `RC7`、`LN1`。OWC 不使用 Protect。 |
| `red_ban` / `blue_ban` | 两队第一张 Ban | 必须填图池中的编号，如 `RC8` 或 `HD1`。 |
| `red_ban_2` / `blue_ban_2` | 两队第二张 Ban | OWC 从 Quarterfinals 起使用。字段名的 `_2` 前有下划线。 |
| `first_pick_team` | OWC 实际首选方 | 只填小写 `red` 或 `blue`，不填队名；Roll 胜者可以选择由哪队首选。MWC4k 由 Roll 决定。 |
| `first_ban_team` | OWC 实际先 Ban 方 | 只填小写 `red` 或 `blue`，不填队名；按实际比赛填写。 |

导入时还兼容 `tournament`、`mode` 作为比赛类型字段的别名，优先级为 `tournament_type` → `tournament` → `mode`。若没有显式填写类型，会尝试根据比赛名称中的 `osu! World Cup`、`OWC`、`mania`、`catch`、`taiko` 等文字识别；为避免识别错误，推荐始终填写 `tournament_type`。

`match_time` 使用英文星期、月份缩写和 24 小时制，格式为：

```text
Sun 14 Dec @20:10(UTC+0)
Fri 21 Aug @08:00(UTC+8)
Sat 20 Sep @15:00(UTC-5)
```

星期为 `Mon Tue Wed Thu Fri Sat Sun`；月份为 `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`。分钟必须为两位，时区填 UTC 偏移量；界面允许 -12 到 +14、以 0.5 为步长。星期后也允许逗号，此时推荐采用标准 CSV 引号写法：

```csv
match_time,"Sat, 20 Sep @15:00(UTC+0)"
```

时间字段只拆分并填写表单，不会换算时区或根据日期推算星期；请确保各项与实际比赛一致。无法识别的时间不会覆盖已有时间，请在表单中补填。

没有填写或值为空的普通表单字段会保留当前值，并不会自动清空；未列出的字段不会自动匹配中文名或任意相似名称。字段名不要重复。导入后务必检查表单，尤其是 BP：编号必须存在于已上传的图池中，否则不会成为有效选项，需重新选择。红队字段始终表示红队、蓝队字段始终表示蓝队，不按谁先 Ban 调换。

#### 示例 1：MWC4k，数字 Roll，双方各一张 Protect 和 Ban

`mwc4k_match.csv`，以 China 对 United States 的比赛信息为例；需另行上传该轮次的完整图池：

```csv
tournament_type,MWC4k
tournament_name,osu!mania 4K World Cup 2025
round,Finals
bracket,Winners Bracket
best_of,13
match_time,"Sat, 20 Sep @15:00(UTC+0)"
mplink,119328425
red_team,China
red_seed,#1
blue_team,United States
blue_seed,#2
red_roll,46
blue_roll,13
red_protect,RC7
blue_protect,LN1
red_ban,RC8
blue_ban,LN4
```

该示例中红队 Roll 更高，因此红队 Protect → 蓝队 Protect → 蓝队 Ban → 红队 Ban，再由红队开始交替选图。若只知道 Roll 结果，可将两行改为：

```csv
red_roll,win
blue_roll,lose
```

PPT 会显示 `win` / `lose`，并按 `win` 大于 `lose` 判定首选方。

#### 示例 2：OWC Round of 16，每队一张 Ban

`owc_ro16_match.csv`，以下为填写格式演示，队伍、时间、BP 和 mplink 请替换为真实比赛信息：

```csv
tournament_type,OWC
tournament_name,osu! World Cup 2025
round,Round of 16
bracket,Winners Bracket
best_of,9
match_time,Sun 16 Nov @18:00(UTC+0)
mplink,123456789
red_team,Team Red
red_seed,#3
blue_team,Team Blue
blue_seed,#14
red_roll,win
blue_roll,lose
red_ban,HD1
blue_ban,HR1
first_pick_team,blue
first_ban_team,red
```

OWC 没有 Protect。此例虽然红队赢得 Roll，实际首选方仍按 `first_pick_team,blue` 填写；不要直接用 Roll 大小替代 OWC 的首选决定。

#### 示例 3：OWC Grand Finals / Bracket Reset，每队两张 Ban

`owc_bracket_reset_match.csv`，以 United States 对 Poland 的比赛信息为例：

```csv
tournament_type,OWC
tournament_name,osu! World Cup 2025
round,Grand Finals
bracket,Bracket Reset
best_of,13
match_time,Sun 14 Dec @20:10(UTC+0)
mplink,https://osu.ppy.sh/community/matches/120078716
red_team,United States
red_seed,#2
blue_team,Poland
blue_seed,#1
red_roll,2
blue_roll,21
red_ban,HD1
blue_ban,HD2
red_ban_2,NM4
blue_ban_2,DT3
first_pick_team,blue
first_ban_team,red
```

OWC 当前按 `round` 中的 `quarter`、`semi`、`final`、`grand` 或 `bracket reset` 识别每队两张 Ban；仅修改 `bracket` 不会改变 Ban 数量。此例红队先 Ban 时，执行顺序为红队 Ban 1 → 蓝队 Ban 1 → 蓝队 Ban 2 → 红队 Ban 2。CSV 行的排列顺序不影响此流程。

比赛信息 CSV 只负责填写表单，不用于导入玩家分数、判定、Rating、谱面属性或手动选图顺序。这些数据仍由 mplink 和官网谱面资料读取或计算；导入完成后可先点击“从 mplink 读取比赛数据”检查自动选图结果，未手动分析时生成前也会自动分析。

## 数据与展示规则

- 每次生成重新读取官方 mplink；玩家、成绩、判定和游玩谱面 ID 均不采用本地测试数据。
- 选图按正式对局顺序严格匹配图池谱面 ID，非图池谱面跳过；中途删除的赛图保留，缺失信息显示 `?`。
- 赛点达成后停止计分，不将后续表演赛纳入正式赛图。
- OWC 的星数使用对应模组的官方属性；时长、BPM、CS、AR、OD 按模组换算。
- RSI 为 `(个人得分 / 本局败方队伍均分)^1.5`。双方共用分母，保留三位小数；低于 0.750 标红，高于 1.500 标绿。缺少上场选手数据、平局或分母为零时显示 `?`。
- OWC 不使用 Protect；每队 Ban 数量按比赛阶段区分，首选方、先 Ban 方按实际比赛填写。MWC4k 使用对应的 Protect/Ban 与 Roll 规则。
- Roll 可填写数字或 `win`/`lose`。
- 仅 Pick 页展示曲绘和图池编号，二者是独立对象；异常或过大的曲绘跳过。
- OWC 每图 7 页，MWC4k 每图 6 页。PPT 生成在独立进程执行，进度查询保持响应。
- 分组可选择预设或手动输入；支持 BO7/9/11/13/15。
- 切换为平滑，时长 1 秒、等待 4 秒。
