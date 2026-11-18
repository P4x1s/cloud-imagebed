# CloudImageBed — 基于 Cloudflare Worker + GitHub 的图床 / 文件床

一个可直接用的图床与文件存储程序：**前端页面 + 后端 API 合并在一个 Cloudflare Worker 里**，用 **GitHub 仓库**做存储。支持图片即时预览、任意文件上传、下载、删除、复制链接。

---

## 一、先体验 Demo（零配置，30 秒）

直接双击打开 [`demo.html`](./demo.html)。

- 这是**纯前端体验版**：输入任意口令即可进入。
- 上传、预览、下载、删除、搜索、筛选、视图切换等交互与线上版**完全一致**。
- 数据只存在你的浏览器里（localStorage），不会上传到任何服务器。刷新后仍在，清除浏览器数据即消失。

> 用途：先确认界面和交互是否符合你的预期，再决定是否部署线上版。

已实现的功能（v2.2.1，界面为克制的工具风格，无营销文案与无效开关）：
- **多种上传方式**：拖拽、点击选择、`Ctrl/⌘ + V` 剪贴板粘贴、选择整个文件夹、URL 一键转存
- **并发上传队列**：可选 1/3/5/10 并发，实时进度
- **默认 WebP 视觉无损压缩**：上传图片默认转为 WebP 并**同时保留原图**（两份都存）；保持原始分辨率不缩放，小图质量 0.92、大于 1MB 的图质量 0.95（高清完整）；也可手动切 JPEG / PNG / 原图。GIF 等动图与原样文件不转换
- **CDN 线路切换**：默认 raw / jsDelivr / 国内镜像 / Worker 中继（自定义 `PUBLIC_BASE` 时多一项）；直链加载失败自动降级中继
- **图片即时缩略图预览 + 大图灯箱**（← → 切换、Esc 关闭）
- **一键复制 4 种格式**：直链 / Markdown / HTML / BBCode
- **批量管理**：多选文件后批量删除，支持 `Shift` 范围选（部分失败逐项报告）
- **`Ctrl/⌘ + K`** 全局聚焦搜索；按文件名/扩展名搜索、图片/视频/文件筛选、4 种排序、网格/列表视图
- **PicGo 兼容**：`POST /api/upload` 支持 `Authorization: Bearer <口令>`，响应带顶层 `url` 字段（PicGo / PicList / Typora 可直接接入）
- **安全加固**：魔数校验（防伪装）+ 禁 SVG（防 XSS）、口令常量时间比对、CORS 白名单（默认仅同源）、Content-Length 前置拦截、错误码人话化
- 深浅双主题切换，适配桌面与手机；内置开放 API 文档面板

---

## 二、部署线上版

### 架构

```
浏览器 ──HTTPS──> Cloudflare Worker ──GitHub API──> GitHub 仓库
   │                    │                              │
   └─ 页面来自 Worker ──┘                   文件以 commit 形式存储
                                            图片走 raw / jsDelivr 直链预览
```

- 上传 ≤1MB：GitHub Contents API 一次提交
- 上传 >1MB：Git Data API（blob → tree → commit → ref）
- 访问口令校验后签发 HMAC 签名的 HttpOnly Cookie（7 天有效）
- 服务端持 GitHub Token，前端永不接触
- **v2.2 起：图床文件直接存进项目仓库的 `gallery/` 子目录**（源码与文件同仓库）。`deploy.yml` 用 `paths-ignore: gallery/**` 排除上传，避免每次传图触发一次部署。

### 步骤

**1. 准备存储仓库**
- 新建一个 GitHub 仓库（建议空仓库，可设为私有）。
- 生成 Personal Access Token：
  - Classic token：勾选 `repo`（私有仓库）或 `public_repo`（公开仓库）。
  - Fine-grained token：给对应仓库的 **Contents: read & write** 权限。

**2. 改配置** — 编辑 `wrangler.toml` 的 `[vars]`：
| 变量 | 说明 | 示例 |
|------|------|------|
| `REPO` | 存储仓库（本项目=源码仓库本身） | `zhangsan/my-project` |
| `BRANCH` | 分支 | `main` |
| `DIR_PREFIX` | 图床根目录（仓库内文件夹） | `gallery`（上传落 `gallery/YYYY/MM/`，留空=仓库根目录） |
| `MAX_UPLOAD_MB` | 单文件上限（GitHub 建议 ≤50MB，硬上限 100MB；base64 膨胀约 1/3） | `50` |
| `PUBLIC_BASE` | 图片直链前缀 | 留空用 raw；或 `https://cdn.jsdelivr.net/gh/zhangsan/my-project@main/gallery` |
| `ALLOWED_ORIGINS` | CORS 白名单，逗号分隔具体域名；留空=仅同源（最严格，推荐） | `https://a.example,https://b.example` |

> 若 `REPO` 指向源码仓库并设了 `DIR_PREFIX`，记得在 `.github/workflows/deploy.yml` 的 `push` 里加 `paths-ignore: '<DIR_PREFIX>/**'`，否则每次上传图片都会触发一次部署。本仓库已按 `gallery` 配好。

**3. 设置 Secret（二选一）**
- 本地开发：复制 `.dev.vars.example` 为 `.dev.vars`，填入真实值，运行 `wrangler dev`。
- 线上：在 Dashboard → Worker → Settings → Variables and Secrets 添加：
  - `GITHUB_TOKEN` = 上面的 token
  - `ACCESS_PASSWORD` = 自定义访问口令

**4. 部署**
```bash
# 本地命令行部署（务必带 --keep-vars）
wrangler deploy --keep-vars
```
或推送到 GitHub 触发 `.github/workflows/deploy.yml` 自动部署（需先在仓库 Secrets 配 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）。

> ⚠️ **关键提醒**：`wrangler deploy` 默认会清空 Dashboard 上的全部变量和 Secret。必须带 `--keep-vars`，否则 `GITHUB_TOKEN` / `ACCESS_PASSWORD` 会丢失，图床立刻不可用。GitHub Actions 里已内置该参数。

**5. 访问**
- 打开 `https://<你的worker名>.<你的子域>.workers.dev`，输入访问口令即可。

### 关于图片预览直链

- 若存储仓库是**公开**的：留空 `PUBLIC_BASE`，图片用 `raw.githubusercontent.com` 直链即可预览。为加速国内访问，可填 jsDelivr CDN 前缀。
- 若存储仓库是**私有**的：raw 直链需鉴权，此时留空 `PUBLIC_BASE`，前端会自动走 `/api/download` 代理接口预览（服务端带 token 访问）。

---

## 三、API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 前端页面 |
| GET | `/health` | 健康检查（含版本指纹） |
| GET | `/api/config` | 公开配置 |
| POST | `/api/login` | 登录，`{ password }` |
| POST | `/api/logout` | 登出 |
| GET | `/api/list` | 列出文件（需登录） |
| POST | `/api/upload` | 上传（需登录），multipart 字段 `file` |
| POST | `/api/upload-url` | URL 转存（需登录），`{ url }`，含 SSRF 防护 |
| GET | `/api/download?path=` | 代理下载（需登录） |
| DELETE | `/api/file?path=&sha=` | 删除单个文件（需登录） |
| POST | `/api/files/batch-delete` | 批量删除（需登录），`{ items:[{path,sha}] }` |

### PicGo / PicList / Typora 接入

上传接口同时兼容第三方客户端：

- **上传地址**：`https://<你的worker域>/api/upload`
- **表单字段**：`file`（PicGo 自定义图床里字段名填 `file`）
- **鉴权**：请求头加 `Authorization: Bearer <你的访问口令>`（无需 Cookie）
- **返回**：`{ "ok": true, "url": "https://raw...", "item": { ... } }`，顶层 `url` 即图片直链

PicGo 自定义图床配置示例：URL 填上面地址，请求头加一行 `Authorization: Bearer 你的口令`，上传字段名 `file`，返回数据在 JSON 的 `url` 字段。

---

## 四、目录结构

```
cf-imagebed/
├── demo.html              # 零配置体验版（双击打开）
├── src/
│   ├── ui.html            # 前端页面源码（Demo 与线上共用）
│   └── worker.js          # Worker 后端源码
├── wrangler.toml          # Worker 配置
├── .dev.vars.example      # 本地 Secret 模板
├── .github/workflows/     # 自动部署
├── tests/                 # 回归测试（构建 + API 全链路，mock GitHub）
│   ├── build-check.cjs
│   └── worker.test.mjs
└── dist/                  # 本地验证产物（可忽略）
```

回归测试（可选，需本机装了 esbuild 与 Node）：
```bash
node tests/build-check.cjs   # 验证 Worker 可打包、语法无误
node tests/worker.test.mjs   # 验证鉴权/上传/列出/下载/删除全链路（含大文件分支）
```

---

## 五、后续可迭代方向（待你的体验反馈）

- 生成缩略图 / 按目录分组浏览（省 GitHub 空间、便于管理）
- 自定义短链 / 随机文件名映射
- 上传白名单（限制文件类型 / MIME）与去重
- 访问口令多次输错限速（配合 Turnstile 人机验证）
- 图床外链防盗链、水印
- 过期文件自动清理（GitHub 存储需配合定时任务）
