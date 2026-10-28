# 生活之书

一个纯静态的城市生活书架：第一本《上海公园》是一张可筛选、可定位、可按面积或距离排序、可全屏查看，并可一键跳转高德导航的上海公园地图；第二本《上海地铁找厕所》先选线路方向、再选当前站，按设施条件用有向加权图估算到达时间。

## 本地预览

站点的发布根目录是 `docs/`，在仓库根目录运行：

```bash
python -m http.server 8000 --directory docs
```

然后访问 <http://localhost:8000/>。不要直接双击 `index.html` 用 `file://` 打开，否则浏览器会拦截 `fetch` 加载 JSON。

## 目录结构

```
life-book/
├── docs/                       # GitHub Pages 发布目录
│   ├── .nojekyll               # 跳过 Jekyll 构建，按纯静态文件发布
│   ├── index.html              # 书架首页
│   ├── assets/
│   │   ├── css/
│   │   │   ├── base.css        # 通用变量、重置、可访问性
│   │   │   ├── bookshelf.css   # 书架与纯 CSS 书封
│   │   │   ├── parks.css       # 地图页、高德地图、移动端布局
│   │   │   └── toilets.css     # 地铁找厕所查询页
│   │   ├── js/
│   │   │   ├── shelf.js        # 首页读取公园数量
│   │   │   ├── parks.js        # 地图、筛选、排序、定位、详情
│   │   │   └── toilets.js      # 有向图 Dijkstra、厕所筛选与渲染
│   │   └── favicon.svg
│   ├── parks/
│   │   ├── index.html          # 上海公园地图页
│   │   └── data/
│   │       └── parks.json      # 119 条公园数据
│   └── toilets/
│       ├── index.html          # 上海地铁找厕所查询页
│       └── data/
│           ├── toilets.json    # 415 个站点、602 处厕所
│           ├── lines.json      # 24 条线路的站序与平均站间耗时
│           └── transfers.json  # 换乘默认值与“站点:线路对”覆盖值
├── scripts/
│   └── fetch-amap-coords.mjs   # 高德坐标拾取脚本
└── README.md
```

## 功能

- **书架首页**：纯 CSS 书封，点击整本书进入地图页。
- **公园地图**：高德地图 JavaScript API 2.0，初始中心 `[121.47, 31.23]`；手机默认 zoom 12，桌面 zoom 11。
- **搜索与标签**：名称 / 区域 / 简介 / 标签实时搜索；标签可多选，多个标签取并集，再与搜索条件组合。
- **面积排序**：支持按记录中的面积从大到小排序，兼容公顷、平方公里、亩等写法；没有面积数字的记录排在最后。
- **全屏地图**：地图左上角提供“全屏/退出”按钮，手机上可用整屏操作地图；按 `Esc` 也可退出。
- **距离排序**：`AMap.Geolocation` 定位后用 Haversine 公式计算直线距离；定位成功后默认切换为距离排序，也可切回名称排序。
- **定位精度与校正**：定位会展示高德返回的精度半径；精度较低时会提示“距离仅供参考”。蓝色位置点支持直接拖动校正，校正后立即重新计算距离与排序。
- **定位兜底**：拒绝授权、超时、设备不支持时显示明确提示；“距离排序”选项保持禁用，地图与列表仍可正常使用。
- **详情与导航**：点击列表项缩放到对应标记并打开高德信息窗体；点击“查看详情”打开原生 `<dialog>`。信息窗体和详情页都有“导航”按钮，可唤起高德 App 或打开网页路线。详情也支持分享链接 `?id=century-park`。
- **数据驱动**：新增公园只需在 `parks.json` 追加一条记录，列表、标记、搜索与首页计数都会自动更新。

## 修改公园数据

编辑 `docs/parks/data/parks.json`，每条记录至少包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识，用于 URL 和地图联动 |
| `name` | string | 公园名称 |
| `lat` / `lng` | number | 高德 GCJ-02 坐标 |
| `history` | string | 简短历史 / 背景 |
| `area` | string | 面积，带单位 |
| `hours` | string | 开放时间 |
| `tags` | string[] | 类型与特色标签 |

可选字段：`englishName`、`district`、`address`、`highlight`。个别公园在高德的 POI 名称与展示名不同时，可加 `amapQuery`（搜索词）和 `amapMatch`（匹配名称）供坐标脚本使用。

> 坐标统一使用高德坐标拾取器获取的 **GCJ-02**，前端不再做 WGS-84 转换。新增公园时请从高德坐标拾取器复制经纬度，避免直接使用 OSM / GPS 的 WGS-84 坐标。

字段为空时详情会显示“暂无信息”，不会报错。标签筛选栏内置了常用标签（动物园、植物园、森林公园、郊野公园、滨江绿地、水域、露营、烧烤、沙滩等）；新增公园使用这些标签即可直接出现在筛选结果中。

### 自动更新公园坐标

[scripts/fetch-amap-coords.mjs](scripts/fetch-amap-coords.mjs) 可以调用高德坐标拾取器同源的搜索接口，按公园名称获取 GCJ-02 坐标：

```bash
# 1. 在已登录高德开放平台的浏览器中复制 Cookie
# 2. 先预览，不修改 JSON
AMAP_PICKER_COOKIE='你的Cookie' node scripts/fetch-amap-coords.mjs

# 3. 确认候选名称、区域和坐标无误后写回
AMAP_PICKER_COOKIE='你的Cookie' node scripts/fetch-amap-coords.mjs --write
```

只补录新增记录中经纬度为 `0` 或缺失的公园：

```bash
AMAP_PICKER_COOKIE='你的Cookie' node scripts/fetch-amap-coords.mjs --missing
AMAP_PICKER_COOKIE='你的Cookie' node scripts/fetch-amap-coords.mjs --missing --write
```

未登录时接口只返回 2 位小数，脚本会拒绝写入。Cookie 只从环境变量 `AMAP_PICKER_COOKIE` 或 `--cookie-file` 读取，不会写入仓库。可用 `--only=century-park` 只处理指定公园。

> 公园面积、开放时间与历史信息为静态资料整理，最终以各园区公告为准。

## 上海地铁找厕所

页面：`docs/toilets/index.html`  
数据：`docs/toilets/data/`

当前覆盖 24 条线路、415 个站点、602 处厕所：

- 1–18 号线
- 5 / 10 / 11 号线支线
- 浦江线、磁浮线、市域机场线

站点厕位描述来自公开站厕资料整理；家庭卫生间、母婴室、无障碍设施与开放状态以现场为准。

> 线路站序与站厕位置参考公开的上海地铁站厕资料（[madneal/subway-shanghai](https://github.com/madneal/subway-shanghai)）整理；站间耗时和换乘时间为项目估算值，不是官方时刻表。

筛选条件：接受换乘（默认开启，关闭后只看直达）、仅站内厕所、需要家庭/母婴设施。

### 时间算法

使用 **有向加权图 + Dijkstra**：

1. 节点是 `(线路, 站点, 行驶方向)`，同一座车站在不同线路、不同方向上都是不同节点。
2. 乘车边只指向当前方向的下一站，权重为 `lines.json` 中的 `avgMinutesPerStop`；4 号线按环线处理。
3. 换乘边连接同一站点的不同线路/方向，权重查 `transfers.json` 的 `overrides[站点名:线路A-线路B]`；线路号排序后匹配，未配置则用 `default`。
4. 从起点额外加两条虚拟边：当前方向 0 分钟，反方向 5 分钟。反方向这条边只走一次，就是“往回坐加 5 分钟”。
5. 一次 Dijkstra 得到起点到所有站点的最短时间，再筛选厕所并按时间升序排列；第一张卡片就是当前条件下的最优结果。

结果中的“约 X 分钟（估算）”包含站间运行和换乘，不含站内步行、安检、候车、首末班车限制。厕所位置与设施均标注“以现场为准”。

### 数据维护说明

**新增一个站点**

1. 在 `toilets.json` 追加一条记录：

```json
{
  "stationId": "example-station",
  "stationName": "示例站",
  "lines": ["1", "2"],
  "toilets": [
    {
      "id": "example-1",
      "type": "inside",
      "location": "2号线站厅层，靠近3号口",
      "nearExit": "3号口",
      "hasFamily": true,
      "hasBabyCare": false,
      "accessible": true,
      "note": "以现场为准"
    }
  ]
}
```

2. 确认 `lines.json` 中每条 `lines` 对应的线路都存在，并且该站名已经按真实顺序放入对应线路的 `stations` 数组。站名必须与 `toilets.json` 完全一致，否则该站点会被忽略。
3. 若该站需要特殊换乘时间，在 `transfers.json` 的 `overrides` 中按“站点名:线路A-线路B”增加一条；线路号程序会先排序，因此只配一个方向即可，其他线路对自动使用 `default`。
4. 刷新页面即可，无需构建。新增站点会自动出现在“当前站点”下拉框，并参与 Dijkstra 计算。

**调整某条线路的站间耗时**

编辑 `lines.json` 对应线路的 `avgMinutesPerStop`。例如把 2 号线从 2.5 分钟改为 3 分钟：

```json
"2": { "avgMinutesPerStop": 3, "stations": ["徐泾东", "..."] }
```

**补充换乘耗时**

编辑 `transfers.json`：

```json
{
  "default": 6,
  "overrides": {
    "娄山关路:2-15": 9,
    "景洪路:15-机场": 14,
    "人民广场:1-2": 8,
    "人民广场:1-8": 3,
    "人民广场:2-8": 7
  }
}
```

键的格式是 `站点名:线路A-线路B`。程序会把两条线路排序后拼键，所以 `人民广场:1-8` 同时匹配 1→8 和 8→1，不需要重复配置；未配置的线路对使用 `default`。

**注意事项**

- 站序决定方向和站数：顺序写反会直接改变“往回坐”的判断。
- 4 号线使用 `"loop": true`；其他线路默认按首末站线性处理。
- 支线（5a / 10a / 11a）在图中是独立线路键，但在支线接轨站配置了 0 分钟贯通换乘，不显示为一次换乘。
- 当前数据覆盖运营中的 24 条线路；后续新开线路按上面步骤继续追加站点和线路即可。

## GitHub Pages 部署

本项目选择 **main 分支 `/docs` 目录** 发布，不需要构建步骤。`docs/.nojekyll` 会让 GitHub Pages 跳过 Jekyll，避免出现 `assets/css/style.scss` 或 `/github/workspace/docs` 相关的构建错误。

1. 将整个 `life-book` 目录推送到 GitHub 仓库的 `main` 分支，确保 `docs/index.html`、`docs/parks/` 和 `docs/toilets/` 已提交。
2. 打开仓库 **Settings → Pages**。
3. 在 **Build and deployment** 中，Source 选择 **Deploy from a branch**。
4. Branch 选择 **main**，目录选择 **/docs**，点击 **Save**。
5. 等待 Actions 完成，访问 `https://<用户名>.github.io/life-book/`。

> 如果 Pages 目前误设为 **/ (root)**，站点会找不到根目录的 `index.html`；请把发布目录改为 **/docs**。
> 错误日志中的 `No such file or directory @ dir_chdir0 - /github/workspace/docs` 正是“发布目录选了 `/docs`，但仓库里没有该目录”导致的；现在 `docs/` 已存在并包含完整站点。

所有站内链接均使用相对路径，因此可以正常部署在 `/<仓库名>/` 子路径下。高德地图 JS API 通过 `webapi.amap.com` 加载，访问时需要网络；定位功能在 GitHub Pages 的 HTTPS 环境下可用。

> 高德 Key 与 securityJsCode 会出现在前端，纯静态站无法真正隐藏；仅限个人非商业项目使用，并请在控制台配置安全域名与配额。

## 移动端适配摘要

- `768px` 断点：由左右分栏切换为「筛选区 → 地图 → 列表」纵向结构，列表占剩余高度并独立滚动。
- 页面高度使用 `100dvh`，地图为 `46dvh`（短屏 `42dvh`），避免移动浏览器地址栏变化导致内容被截断。
- 按钮、标签 chip、排序框、marker、弹窗关闭按钮均保持至少 `44×44px` 触控区域。
- 手机端保留双指缩放；弹出 marker 弹窗时临时隐藏“缩放 / 全览 / 定位”浮层，避免小地图上的浮层互相遮挡。
- 详情在手机上为底部抽屉，使用原生 `<dialog>` 置于顶层，不会被下方列表遮挡；高德信息窗体限制内部高度并自动移动到可见区域。
- 首页在 `900px` 以下切换单列，`768px` 以下隐藏装饰性便笺，两本书完整保留操作区。

## 地图与数据版权

- 地图底图与 API © [高德地图](https://lbs.amap.com/)
- 高德地图 JavaScript API 2.0
