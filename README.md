# 生活之书 · 上海公园

一个纯静态的城市绿地书架：首页是一册《上海公园》，翻开后是一张可筛选、可定位、可按距离排序的上海公园地图。

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
│   │   │   └── parks.css       # 地图页、Leaflet、移动端布局
│   │   ├── js/
│   │   │   ├── shelf.js        # 首页读取公园数量
│   │   │   └── parks.js        # 地图、筛选、排序、定位、详情
│   │   └── favicon.svg
│   └── parks/
│       ├── index.html          # 上海公园地图页
│       └── data/
│           └── parks.json      # 16 条公园数据
└── README.md
```

## 功能

- **书架首页**：纯 CSS 书封，点击整本书进入地图页。
- **公园地图**：Leaflet 1.9.4 + OpenStreetMap 瓦片，初始中心 `31.23, 121.47`；手机默认 zoom 12，桌面 zoom 11。
- **搜索与标签**：名称 / 区域 / 简介 / 标签实时搜索；标签可多选，多个标签取并集，再与搜索条件组合。
- **距离排序**：`navigator.geolocation` 定位后用 Haversine 公式计算直线距离；定位成功后默认切换为距离排序，也可切回名称排序。
- **定位精度与校正**：定位始终请求新鲜坐标（`maximumAge: 0`），并展示浏览器返回的精度半径；精度较低时会提示“距离仅供参考”。蓝色位置点支持直接拖动校正，校正后立即重新计算距离与排序。
- **定位兜底**：拒绝授权、超时、设备不支持时显示明确提示；“距离排序”选项保持禁用，地图与列表仍可正常使用。
- **详情**：点击列表项飞到对应标记并打开 Leaflet 弹窗；点击“查看详情”打开原生 `<dialog>`。详情也支持分享链接 `?id=century-park`。
- **数据驱动**：新增公园只需在 `parks.json` 追加一条记录，列表、标记、搜索与首页计数都会自动更新。

## 修改公园数据

编辑 `docs/parks/data/parks.json`，每条记录至少包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识，用于 URL 和地图联动 |
| `name` | string | 公园名称 |
| `lat` / `lng` | number | 经纬度 |
| `history` | string | 简短历史 / 背景 |
| `area` | string | 面积，带单位 |
| `hours` | string | 开放时间 |
| `tags` | string[] | 类型与特色标签 |

可选字段：`englishName`、`district`、`address`、`highlight`。

字段为空时详情会显示“暂无信息”，不会报错。标签筛选栏内置了常用标签（动物园、植物园、森林公园、郊野公园、滨江绿地、水域、露营、烧烤、沙滩等）；新增公园使用这些标签即可直接出现在筛选结果中。

> 公园面积、开放时间与历史信息为静态资料整理，最终以各园区公告为准。

## GitHub Pages 部署

本项目选择 **main 分支 `/docs` 目录** 发布，不需要构建步骤。`docs/.nojekyll` 会让 GitHub Pages 跳过 Jekyll，避免出现 `assets/css/style.scss` 或 `/github/workspace/docs` 相关的构建错误。

1. 将整个 `life-book` 目录推送到 GitHub 仓库的 `main` 分支，确保 `docs/index.html` 和 `docs/parks/` 已提交。
2. 打开仓库 **Settings → Pages**。
3. 在 **Build and deployment** 中，Source 选择 **Deploy from a branch**。
4. Branch 选择 **main**，目录选择 **/docs**，点击 **Save**。
5. 等待 Actions 完成，访问 `https://<用户名>.github.io/life-book/`。

> 如果 Pages 目前误设为 **/ (root)**，站点会找不到根目录的 `index.html`；请把发布目录改为 **/docs**。
> 错误日志中的 `No such file or directory @ dir_chdir0 - /github/workspace/docs` 正是“发布目录选了 `/docs`，但仓库里没有该目录”导致的；现在 `docs/` 已存在并包含完整站点。

所有站内链接均使用相对路径，因此可以正常部署在 `/<仓库名>/` 子路径下。Leaflet 和 OpenStreetMap 瓦片通过 CDN 加载，访问时需要网络；定位功能在 GitHub Pages 的 HTTPS 环境下可用。

## 移动端适配摘要

- `768px` 断点：由左右分栏切换为「筛选区 → 地图 → 列表」纵向结构，列表占剩余高度并独立滚动。
- 页面高度使用 `100dvh`，地图为 `46dvh`（短屏 `42dvh`），避免移动浏览器地址栏变化导致内容被截断。
- 按钮、标签 chip、排序框、marker、弹窗关闭按钮均保持至少 `44×44px` 触控区域。
- 手机端保留双指缩放；弹出 marker 弹窗时临时隐藏“缩放 / 全览 / 定位”浮层，避免小地图上的浮层互相遮挡。
- 详情在手机上为底部抽屉，使用原生 `<dialog>` 置于顶层，不会被下方列表遮挡；Leaflet 弹窗启用 `autoPan` 并限制内部高度。
- 首页在 `900px` 以下切换单列，`768px` 以下隐藏装饰性便笺，保留唯一一本书的完整操作区。

## 地图与数据版权

- 地图瓦片 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- 地图库 [Leaflet](https://leafletjs.com/)
