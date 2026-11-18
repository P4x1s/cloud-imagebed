# CloudImageBed — 基于 Cloudflare Worker + GitHub 的图床 / 文件床

一个可直接用的图床与文件存储程序：**前端页面 + 后端 API 合并在一个 Cloudflare Worker 里**，用 **GitHub 仓库**做存储。支持图片即时预览、任意文件上传、下载、删除、复制链接。

---

## 一、先体验 Demo（零配置，30 秒）

直接双击打开 [`demo.html`](./demo.html)。

- 这是**纯前端体验版**：输入任意口令即可进入。
- 上传、预览、下载、删除、搜索、筛选、视图切换等交互与线上版**完全一致**。
- 数据只存在你的浏览器里（localStorage），不会上传到任何服务器。刷新后仍在，清除浏览器数据即消失。

> 用途：先确认界面和交互是否符合你的预期，再决定是否部署线上版。

已实现的功能：
- 拖拽 / 点击 / 多选上传，带进度队列
- 图片即时缩略图预览 + 大图灯箱（支持 ← → 切换、Esc 关闭）
- 视频 / PDF / 任意格式文件的图标占位
- 一键复制「直链 / Markdown / HTML」三种格式
- 下载（图片内联预览，其他文件强制下载）
- 按文件名搜索、图片/文件筛选、网格/列表视图切换
- 暗色主题，适配桌面与手机

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

### 步骤

**1. 准备存储仓库**
- 新建一个 GitHub 仓库（建议空仓库，可设为私有）。
- 生成 Personal Access Token：
  - Classic token：勾选 `repo`（私有仓库）或 `public_repo`（公开仓库）。
  - Fine-grained token：给对应仓库的 **Contents: read & write** 权限。

**2. 改配置** — 编辑 `wrangler.toml` 的 `[vars]`：
| 变量 | 说明 | 示例 |
|------|------|------|
| `REPO` | 存储仓库 | `zhangsan/my-imagebed` |
| `BRANCH` | 分支 | `main` |
| `DIR_PREFIX` | 仓库内目录前缀 | `images`（留空=根目录） |
| `MAX_UPLOAD_MB` | 单文件上限 | `25` |
| `PUBLIC_BASE` | 图片直链前缀 | 留空用 raw；或 `https://cdn.jsdelivr.net/gh/zhangsan/my-imagebed@main` |

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
| GET | `/api/download?path=` | 代理下载（需登录） |
| DELETE | `/api/file?path=&sha=` | 删除（需登录） |

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

- 上传前图片压缩 / 生成缩略图（省 GitHub 空间）
- 自定义短链 / 随机文件名映射
- 批量删除、文件夹管理
- 上传白名单（限制文件类型 / MIME）
- 访问口令多次输错限速（配合 Turnstile 人机验证）
- 图床外链防盗链、水印
