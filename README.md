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

## 开发环境

需要 Windows、Node.js 22 或更高版本，以及以下依赖：

- `jszip`、`sharp`：运行 `npm install` 安装。
- `@oai/artifact-tool` 2.8.103：当前使用的 PPT 引擎为非公开依赖，不在 npm 公共仓库，也不随本源码仓库提供。需要自行提供有权使用的该依赖；已有本地运行环境可继续使用。

准备依赖后执行：

```powershell
npm run check:dependencies
npm test
npm start
```

浏览器访问 `http://127.0.0.1:4173`。也可双击 `一键启动.bat`，或用 `start.ps1` 在终端运行。应用内部路径均相对项目目录解析。

字体位于 `assets/TORUS-REGULAR.OTF` 和 `assets/TORUS-BOLD.OTF`，首次使用可右键选择安装，供 PowerPoint/WPS 显示 PPT 使用。

## OAuth 与数据目录

首次使用在页面中填写自己的 osu! OAuth Client ID 和 Client Secret。配置会在本机加密保存，Secret 不会回填到页面。

- 私有配置位于项目内的 `.local/`，生成文件位于 `outputs/`。
- `.local/`、依赖、临时文件和生成文件均由 `.gitignore` 排除。

## 使用流程

1. 选择比赛，再上传图池 CSV。
2. 填写比赛信息，或导入比赛信息 CSV。
3. 从 mplink 分析正式赛图；未手动分析时，生成前会自动分析。
4. 填写 Roll 和 BP，生成可编辑 PPTX。

图池 CSV 支持 `id`/`code` 与 `map id`/`beatmap_id` 列。比赛信息 CSV 使用每行 `字段名,值` 的形式，支持比赛、轮次、队伍、种子、时间、Roll、BP、首选方和先 Ban 方；`mplink` 可为完整链接或数字 ID，`tournament_type` 可为上表中的比赛名称。

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

## 提交源码

提交源码、模板、字体、测试和启动脚本。不要提交 `.local/`、`node_modules/`、`.tmp/`、`outputs/`、`dist/` 或个人凭据。此仓库不包含个人 OAuth 配置及运行生成的数据。
