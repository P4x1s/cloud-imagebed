# CloudImageBed — 基于 Cloudflare Workers + GitHub 的免费图床 / 文件床

一个**零成本、免服务器**的图床与文件存储程序：前端页面 + 后端 API 合并在**单个 Cloudflare Worker** 里，用 **GitHub 仓库**做存储后端。适合博客图床、笔记附件、个人文件中转等场景。

- **完全免费**：Cloudflare Workers 免费额度 + GitHub 仓库存储，无需购买任何服务
- **单文件部署**：整个应用就是 `src/worker.js` 一个文件（内嵌前端页面），没有数据库、没有依赖服务
- **自动压缩**：图片上传时自动转为 WebP 格式（压缩产物不超过 1MB），非图片文件原样保存

---

## 一、先体验 Demo（零配置，30 秒）

直接双击打开 [`demo.html`](./demo.html)。

- 这是**纯前端体验版**：输入任意口令即可进入。
- 上传、预览、下载、删除、搜索、筛选等交互与线上版**完全一致**。
- 数据只存在你的浏览器里（localStorage），不会上传到任何服务器。

> 用途：先确认界面和交互是否符合预期，再决定是否部署线上版。

---

## 二、功能一览

- **多种上传方式**：拖拽、点击选择、`Ctrl/⌘ + V` 剪贴板粘贴、选择整个文件夹、URL 一键转存
- **智能压缩（v2.5.0）**：
  - 只压缩**图片**：PNG/WebP/BMP/GIF 等走 WASM（libwebp）真无损转 WebP；JPEG 源用 95% 高质量转码（源本身已有损）
  - **压缩后的 WebP 保证不超过 1MB**：无损结果超限时自动「降级有损 → 降低质量 → 缩小尺寸」逐档重压，直到达标
  - **GIF 动图 → 动图 WebP**：逐帧解码再编码，动画、时序、循环完整保留；超限时同样自动降档
  - **非图片文件（视频/文档/压缩包等）不压缩**，原样上传保存
  - URL 转存不压缩，保留远程文件的原始格式
- **登录人机验证（可选）**：接入 Cloudflare Turnstile，未配置时自动关闭
- **并发上传队列**：可选 1/3/5/10 并发，队列项带缩略图与实时进度
- **CDN 线路切换**：raw 直链 / jsDelivr / 国内镜像 / Worker 中继；直链加载失败自动降级中继
- **图片即时预览 + 大图灯箱**（← → 切换、Esc 关闭）
- **一键复制 5 种格式**：URL / HTML / BBCode / Markdown / Markdown 带链接
- **批量管理**：多选批量删除，支持 `Shift` 范围选
- **`Ctrl/⌘ + K`** 全局搜索；WebP/图片/视频/文件筛选、4 种排序、网格/列表视图
- **PicGo / PicList / Typora 兼容**：`POST /api/upload` 支持 Bearer 口令鉴权，可直接接入
- **安全加固**：文件魔数校验（防伪装）、禁 SVG（防 XSS）、口令常量时间比对、CORS 白名单、URL 转存 SSRF 防护
- 深浅双主题，适配桌面与手机；内置开放 API 文档面板

---

## 三、部署教程（从零开始，小白可照抄）

### 架构

```
浏览器 ──HTTPS──> Cloudflare Worker（页面 + API）──GitHub API──> 你的 GitHub 仓库
                                                            （文件以 commit 形式存储）
```

- 上传 ≤1MB 走 GitHub Contents API；更大走 Git Data API（blob → tree → commit → ref）
- 访问口令校验后签发 HttpOnly 签名 Cookie（7 天有效）；GitHub Token 只存在服务端，前端永不接触
- 上传的文件存进仓库的 `gallery/` 子目录（按 `年/月` 自动分目录）

### 准备工作

1. 一个 **GitHub 账号**
2. 一个 **Cloudflare 账号**（免费注册即可）

### 第 1 步：准备仓库与 Token

1. **Fork 本项目**到你自己的账号（或新建仓库后把源码传上去）。
2. 新建 GitHub Personal Access Token，给 Worker 存取文件用：
   - 打开 GitHub → 右上角头像 → **Settings → Developer settings → Personal access tokens → Tokens (classic)** → **Generate new token (classic)**
   - 勾选 **`repo`** 权限（整个大类）
   - 生成后**立即复制** `ghp_...`（页面关掉就看不到了），后面记作 **`<GITHUB_TOKEN>`**

> ⚠️ 如果你用的是 Fork 仓库：打开 `.github/workflows/deploy.yml`，把其中的 `if: github.repository_owner == '...'` 这一行删除或改成你的用户名，否则自动部署不会触发。

### 第 2 步：修改 wrangler.toml

编辑 `wrangler.toml` 的 `[vars]`，改成你自己的值：

| 变量 | 说明 | 示例 |
|------|------|------|
| `REPO` | 存储文件的仓库（建议就填 Fork 出来的仓库本身） | `your-name/your-repo` |
| `BRANCH` | 分支 | `main` |
| `DIR_PREFIX` | 文件存储目录（仓库内文件夹），留空=仓库根目录 | `gallery` |
| `MAX_UPLOAD_MB` | 单文件上限（GitHub 硬上限 100MB，建议 ≤50） | `50` |
| `PUBLIC_BASE` | 图片直链前缀，留空用 raw 直链 | 留空，或 `https://cdn.jsdelivr.net/gh/your-name/your-repo@main` |
| `ALLOWED_ORIGINS` | CORS 白名单，留空=仅同源（推荐） | 留空 |

> 若 `REPO` 填的是源码仓库本身且 `DIR_PREFIX=gallery`，无需其他改动——`deploy.yml` 已用 `paths-ignore: gallery/**` 排除上传文件触发的重复部署。

### 第 3 步：配置 GitHub Actions（自动部署用）

打开你的仓库 → **Settings → Secrets and variables → Actions**，添加两条 **Secret**：

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，见下方获取方法 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

获取方法：

- **API Token**：打开 Cloudflare Dashboard → 右上角头像 → **My Profile → API Tokens → Create Token** → 选模板 **Edit Cloudflare Workers** → Create → 复制。
- **Account ID**：Cloudflare Dashboard 首页右侧栏，或任意 Worker 页面 URL 里那串 32 位字符。

### 第 4 步：触发部署

把改动推送到仓库 `main` 分支（Fork 后改完 `wrangler.toml` 提交即可），或到仓库 **Actions** 页面手动 **Run workflow**。

等 1–2 分钟变绿 ✅ 即部署成功。之后每次 push 源码都会自动重新部署（上传图片不会触发）。

### 第 5 步：配置 Worker 运行时密钥

首次部署后，Cloudflare Dashboard → **Workers & Pages** → 找到你的 Worker → **Settings → Variables and Secrets**，添加：

| Name | 类型 | 必填 | 说明 |
|------|------|------|------|
| `GITHUB_TOKEN` | **Secret** | ✅ | 第 1 步的 `<GITHUB_TOKEN>` |
| `ACCESS_PASSWORD` | **Secret** | ✅ | 自定义访问口令（前端登录用） |
| `TURNSTILE_SITE_KEY` | Variable | ⬜ | Turnstile **站点密钥**（启用登录人机验证才需要） |
| `TURNSTILE_SECRET_KEY` | **Secret** | ⬜ | Turnstile **密钥**（与站点密钥配对使用） |

> 🔐 **Turnstile（可选）**：到 Cloudflare Dashboard → **Turnstile** → Add site，创建一个组件，拿到站点密钥（公开，前端用）和密钥（保密，服务端用），分别填入上面两处。两项都配置后登录页会出现人机验证；不配置则自动跳过该验证。
>
> ⚠️ **这几条必须在 Cloudflare Dashboard 配**，不要写进仓库文件。

### 第 6 步：访问

打开 `https://<你的worker名>.<你的子域>.workers.dev`，输入访问口令即可使用。

### 替代方式：本地命令行部署

不想用 GitHub Actions，也可以本地部署：

```bash
npm install -g wrangler
wrangler login
wrangler secret put GITHUB_TOKEN      # 粘贴 <GITHUB_TOKEN>
wrangler secret put ACCESS_PASSWORD   # 粘贴你的口令
wrangler deploy --keep-vars
```

> ⚠️ **关键提醒**：`wrangler deploy` 默认会清空 Dashboard 上的全部变量和 Secret，必须带 `--keep-vars`。

---

## 四、使用说明

### 上传与压缩规则（v2.5.0）

| 你上传的内容 | 实际存储结果 |
|------|------|
| PNG / WebP / BMP 等静态图 | WebP（优先真无损；超过 1MB 自动降为高质量有损/缩放，保证 ≤1MB） |
| JPEG | WebP（95% 高质量转码；超过 1MB 自动降档，保证 ≤1MB） |
| GIF 动图 | 动图 WebP（动画完整保留；超过 1MB 自动降档，保证 ≤1MB） |
| 视频 / 文档 / 压缩包等 | **原样存储，不做任何处理** |
| URL 转存 | **原样存储**（保留远程文件原始格式，不压缩） |

上传完成后队列和提示会显示压缩前后体积（如 `2.3MB→890.4KB（WebP）`）。

### 日常操作

- **复制链接**：文件卡片悬停 → 链接图标，或点开大图后「复制链接」；5 种格式一键复制
- **切换 CDN 线路**：上传设置里选「默认线路 / jsDelivr / 国内镜像 / Worker 中继」，影响生成的直链地址
- **删除**：单删或开「批量管理」多选删除（不可恢复，谨慎操作）
- **搜索**：`Ctrl/⌘ + K` 快速聚焦搜索框

### 存储仓库是公开还是私有？

- **公开仓库**：raw / jsDelivr 直链可直接访问（图床最常用）。
- **私有仓库**：raw 直链需鉴权，前端会自动走 `/api/download` 服务端代理预览，功能不受影响，但图片无法作为外链使用。

### 接入 PicGo / PicList / Typora

- **上传地址**：`https://<你的worker域>/api/upload`
- **表单字段**：`file`
- **鉴权**：请求头 `Authorization: Bearer <你的访问口令>`
- **返回**：JSON 顶层 `url` 字段即图片直链

---

## 五、API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 前端页面 |
| GET | `/health` | 健康检查（含版本号） |
| GET | `/api/config` | 公开配置 |
| POST | `/api/login` | 登录，`{ password }` |
| POST | `/api/logout` | 登出 |
| GET | `/api/list` | 列出文件（需登录） |
| POST | `/api/upload` | 上传（需登录），multipart 字段 `file` |
| POST | `/api/upload-url` | URL 转存（需登录），`{ url }`，含 SSRF 防护 |
| GET | `/api/download?path=` | 代理下载（需登录） |
| DELETE | `/api/file?path=&sha=` | 删除单个文件（需登录） |
| POST | `/api/files/batch-delete` | 批量删除（需登录），`{ items:[{path,sha}] }` |

---

## 六、常见问题

**Q：部署后打开是「未配置」报错？**
A：第 5 步的 `GITHUB_TOKEN` / `REPO` 没配好。确认 Dashboard Secret 已加、`wrangler.toml` 的 `REPO` 指向你自己的仓库，然后重新部署。

**Q：登录后上传报 401 / 失败？**
A：检查 `GITHUB_TOKEN` 是否有效、是否勾了 `repo` 权限、`REPO` 是否写对（`用户名/仓库名`）。

**Q：`wrangler deploy` 之后登录不了？**
A：大概率忘了 `--keep-vars`，Dashboard 上的 Secret 被清空了。重新添加第 5 步的密钥即可。

**Q：Actions 部署失败？**
A：99% 是第 3 步密钥没配或配错，看 Actions 日志的具体报错。Fork 仓库还要确认删除了 `deploy.yml` 里的 owner 限制行。

**Q：GIF 没有转成 WebP？**
A：编码器加载失败、或所有降档后仍超过 1MB 时，会保留原 GIF（非 WebP 产物不受 1MB 约束）。这是兜底策略，保证文件不丢。

**Q：图片直链在国内打开很慢？**
A：前端切换「jsDelivr / 国内镜像」线路；或把 `PUBLIC_BASE` 配成 jsDelivr 前缀。注意 CDN 有缓存，新文件可能几分钟才生效。

**Q：文件存在哪里？能看到吗？**
A：存在你配置的 GitHub 仓库 `gallery/年/月/` 目录下，文件名为北京时间时间戳；在仓库页面可以直接浏览。

---

## 七、目录结构与测试

```
├── demo.html              # 零配置体验版（双击打开）
├── src/
│   ├── ui.html            # 前端页面源码（Demo 与线上共用）
│   └── worker.js          # Worker 后端源码（单文件应用）
├── wrangler.toml          # Worker 配置
├── .dev.vars.example      # 本地开发 Secret 模板
├── .github/workflows/     # GitHub Actions 自动部署
└── tests/                 # 回归测试
```

本地回归测试（可选，需 Node.js）：

```bash
node tests/build-check.cjs    # 验证 Worker 可打包、语法无误
node tests/worker.test.mjs    # 验证鉴权/上传/列出/下载/删除全链路（mock GitHub）
```

---

## 八、备份与安全建议

- 上传的文件就是 GitHub 仓库里的 commit，天然有版本历史；重要数据建议定期把 `gallery/` 目录备份到本地或其他存储。
- 务必设置强 `ACCESS_PASSWORD`；开启了 Turnstile 后可有效拦截脚本刷口令。
- `GITHUB_TOKEN` 等所有密钥只放在 Cloudflare Dashboard / GitHub Secrets，**永远不要提交进仓库**。
