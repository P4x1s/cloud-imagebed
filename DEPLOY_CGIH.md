# CloudImageBed 部署说明（P4x1s/cloud-imagebed）

> ✅ **最终线上状态（2026-11-18 更新）——以下为当前真实配置，下方历史步骤仅作背景参考：**
>
> | 项目 | 当前状态 |
> |------|----------|
> | 访问地址 | **`https://cloud-imagebed.cashkeven.workers.dev`**（旧 `cgih` Worker 已删除）|
> | 源码仓库 | `P4x1s/cloud-imagebed`（仅项目文件，main 分支；原名 CGIH）|
> | **文件存储仓库** | **`P4x1s/cloud-imagebed-file`（公开、main 分支；原名 CGIH-FILE）** |
> | Worker 名称 | `cloud-imagebed`（REPO=`P4x1s/cloud-imagebed-file`、`BRANCH=main`）|
> | 目录结构 | 年月优先：`<YYYY>/<MM>/<时间戳>-<随机>-<文件名>`，如 `2026/11/179498...-a1b2c3d4-pic.png` |
> | 图片直链 | `https://raw.githubusercontent.com/P4x1s/cloud-imagebed-file/main/<YYYY>/<MM>/<文件>` |
> | 已完成清理 | 旧 `CGIH/storage` 分支已删除（SHA `d9db408...` 可恢复）；两个仓库已重命名 |
> | 迁移清单 | 见 `MIGRATION_MANIFEST.md`、`REPO_MIGRATION_PLAN.md` |
>
> 下文第 1–6 步是**最初的搭建历史记录**（当时用 CGIH 的 storage 分支存文件、Worker 名为 cgih）。
> 现已全面升级：独立文件仓库 + 仓库改名 + Worker 改名 + 年月优先目录。
> 那些步骤里的 `storage` 分支、`P4x1s/CGIH`、`cgih` 等**不再适用**，仅作背景参考。

## 当前进度（已自动完成的部分）

| 项目 | 状态 |
|------|------|
| 代码推送到 `main` 分支（9 个文件，逐字节校验一致） | ✅ 已完成 |
| 创建 `storage` 分支（供 Worker 存文件） | ✅ 已完成 |
| `wrangler.toml` 配置（REPO=`P4x1s/CGIH`、BRANCH=`storage`）| ✅ 已完成 |
| Actions workflow（含 `--keep-vars`、owner 限制）| ✅ 已完成 |
| GitHub 侧 2 个部署密钥 | ⏳ 待你配置（第 2 步）|
| Cloudflare 侧 2 个运行时密钥 | ⏳ 待你配置（第 3 步）|

> 注：首次 push 后 Actions 会跑一次并失败（因缺密钥），这是正常的。配好密钥后 Re-run 即可。

---

## 工作原理（先看懂，操作更稳）

```
你在浏览器上传图片
      │
      ▼
Cloudflare Worker（前端页面 + 后端 API 一体）
      │  用 GITHUB_TOKEN 调 GitHub API
      ▼
P4x1s/CGIH 仓库的 storage 分支  ← 文件存这里（与源码 main 隔离）
      │
      ▼
raw.githubusercontent.com/P4x1s/CGIH/storage/...  ← 图片直链即时预览
```

- **源码分支 `main`**：放项目代码，push 后触发 Actions 自动部署到 Cloudflare。
- **存储分支 `storage`**：Worker 把上传的文件作为 commit 提交到这里。两者互不污染。
- **密钥分层**：`GITHUB_TOKEN`、`ACCESS_PASSWORD` 放在 **Cloudflare**（Worker 运行时用）；`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 放在 **GitHub**（Actions 部署用）。两边不能互换。

---

## 第 0 步：准备 GitHub Personal Access Token（给 Worker 存文件用）

1. 打开 https://github.com/settings/tokens → **Generate new token (classic)**。
2. Note 填 `CGIH-imagebed`，Expiration 建议选 **No expiration**（或按需设长期）。
3. 勾选权限：**`repo`**（整个大类勾上）。CGIH 是公开仓库，若只想最小化权限，可只勾 `public_repo` + `workflow`，但为省事建议直接勾 `repo`。
4. 生成后**立即复制**那串 `ghp_...`（页面关闭后无法再查看）。→ 记为 **【GITHUB_TOKEN】**，第 3 步要用。

---

## 第 1 步：把代码推送到 CGIH 的 main 分支 ✅ 已完成

代码已通过 GitHub API 推送完毕，`main` 与 `storage` 两个分支均已创建，9 个文件逐字节校验一致。**本步可跳过。**

以下为留档（如需手动重推才用）：

在本机找一个目录，执行（把 `<...>` 换成你的）：

```bash
git clone https://github.com/P4x1s/CGIH.git
cd CGIH
```

把本项目 `cf-imagebed` 目录下的这些文件/文件夹复制到 `CGIH` 里（**.git 不要复制**）：

```
src/ui.html
src/worker.js
wrangler.toml
.github/workflows/deploy.yml
.gitignore
README.md
demo.html
```

然后提交：

```bash
git add .
git commit -m "init: CloudImageBed"
git branch -M main
git push -u origin main
```

> 推送成功后，**先别管 Actions 会不会失败**——因为第 2、3 步的密钥还没配，第一次部署失败是正常的。

---

## 第 2 步：在 GitHub 配置 Actions 部署密钥（给 Actions 部署用）

打开 https://github.com/P4x1s/CGIH → **Settings → Secrets and variables → Actions**：

1. 点 **New repository secret**，添加两条：

| Name | Value | 获取方式 |
|------|-------|----------|
| `CLOUDFLARE_API_TOKEN` | CF API Token | 见下方 2.1 |
| `CLOUDFLARE_ACCOUNT_ID` | CF Account ID | 见下方 2.2 |

**2.1 获取 Cloudflare API Token**
- 打开 https://dash.cloudflare.com/profile/api-tokens → **Create Token**。
- 选模板 **Edit Cloudflare Workers** → Use template。
- Account Resources 选你的账户，Zone Resources 可保持默认（Workers 不需要具体域名）。
- Create Token → 复制 → 记为 `CLOUDFLARE_API_TOKEN`。

**2.2 获取 Cloudflare Account ID**
- 打开 https://dash.cloudflare.com → 右侧边栏或 Worker 页面 URL 里有一串 32 位十六进制字符，即为 Account ID。
- 或在 API Tokens 页面下方 **Account ID** 处直接复制。

2. 在同一个 **Secrets and variables → Actions** 页面，切到 **Variables** 标签，点 **New repository variable**，添加一条（用于部署后自检，可选但推荐）：

| Name | Value |
|------|-------|
| `WORKER_URL` | 第 4 步拿到的 Worker 地址，如 `https://cloud-imagebed.<你的子域>.workers.dev` |

> `WORKER_URL` 可以在第 4 步部署成功后再回来填，填了之后下次部署会自动做线上健康检查。

---

## 第 3 步：在 Cloudflare 配置 Worker 运行时密钥（给 Worker 存文件 / 登录用）

打开 https://dash.cloudflare.com → **Workers & Pages** → 找到 `cloud-imagebed`（首次部署后会出现）→ **Settings → Variables and Secrets** → **Add**，添加两条 **Secret**（务必选 Secret 类型，不要选 Variable）：

| Name | Value | 说明 |
|------|-------|------|
| `GITHUB_TOKEN` | 第 0 步的 `ghp_...` | Worker 用它在 storage 分支读写文件 |
| `ACCESS_PASSWORD` | 你自定义的口令 | 前端登录用，例如 `MyImgBed@2026` |

> ⚠️ 这两条**必须在 Cloudflare 配**，不能只放 GitHub。`wrangler.toml` 里刻意没写它们，Actions 部署时带了 `--keep-vars`，不会清空。

**关于其他变量**：`REPO=P4x1s/CGIH`、`BRANCH=storage`、`MAX_UPLOAD_MB=25` 等已在 `wrangler.toml` 里配好，Actions 部署会自动写入，无需在 Dashboard 重复配置。

---

## 第 4 步：触发部署

回到 GitHub 仓库 **Actions** 标签：

1. 如果第 1 步 push 后已有一次失败的运行，点进去 **Re-run all jobs**。
2. 或到 **Actions → Deploy CloudImageBed to Cloudflare Workers → Run workflow** 手动触发。

等待约 1–2 分钟，绿色✅即部署成功。点开运行日志，应能看到 `wrangler deploy` 成功的输出。

> 如果报权限错（`CLOUDFLARE_API_TOKEN` 相关），回第 2 步检查 Token 是否勾选了 Workers 编辑权限。

---

## 第 5 步：创建 storage 分支（存文件用）✅ 已完成

`storage` 分支已创建并指向初始 commit，Worker 后续会自动往该分支提交文件。**本步可跳过。**

以下为留档（如需手动创建才用）：

Worker 上传的文件要提交到 `storage` 分支。用命令行在本机 CGIH 目录执行：

```bash
cd CGIH
git fetch origin
# 从 main 创建一个空的 storage 分支并推上去
git checkout -b storage origin/main
git push origin storage
git checkout main
```

或者在 GitHub 网页：仓库 → 分支下拉框 → 输入 `storage` → Create branch（基于 main）。

> 为什么单独建分支：让源码提交和文件提交分开，互不污染。文件提交历史集中在 storage 分支，main 保持干净。

---

## 第 6 步：访问使用

1. 打开你的 Worker 地址：`https://cloud-imagebed.<你的子域>.workers.dev`
2. 输入第 3 步设的 `ACCESS_PASSWORD` 登录。
3. 上传一张图片试试——成功后：
   - Worker 会把它提交到 `storage` 分支（在 GitHub 仓库切到 storage 分支能看到文件）。
   - 图片以直链即时预览，点「复制链接」拿到的是 `https://raw.githubusercontent.com/P4x1s/CGIH/storage/...`。

---

## 常见问题

**Q：图片直链在国内打开很慢？**
A：把 `wrangler.toml` 里的 `PUBLIC_BASE` 改成 jsDelivr CDN：
```toml
PUBLIC_BASE = "https://cdn.jsdelivr.net/gh/P4x1s/CGIH@storage"
```
然后重新 push 触发部署。注意 jsDelivr 有缓存，新上传的文件可能几分钟后才刷新。

**Q：想让文件不公开（私有）？**
A：CGIH 现在是公开仓库，文件直链任何人可读。若要私有，需把仓库设为 Private，并：
- 第 0 步 Token 权限改为完整 `repo`；
- `PUBLIC_BASE` 留空，前端会自动走 `/api/download` 服务端代理预览（Worker 带 token 访问，前端拿不到直链）。

**Q：单文件超过 25MB？**
A：改 `wrangler.toml` 的 `MAX_UPLOAD_MB`（GitHub 单文件硬上限 100MB，建议不超过 50MB 以免 base64 后请求体过大）。

**Q：第一次 Actions 部署失败？**
A：99% 是第 2 步密钥没配或配错。到 Actions 日志看具体报错，常见：
- `CLOUDFLARE_API_TOKEN` 无效 → 重新生成 Token（勾选 Edit Cloudflare Workers 模板）。
- `Account ID` 不对 → 从 CF Dashboard 重新复制。

**Q：登录后上传报 401 / 上传失败？**
A：检查 Cloudflare 的 `GITHUB_TOKEN` 是否配好、是否有 CGIH 的写权限；Token 过期也会导致失败。

---

## 配置核对清单

部署前按此逐项确认：

- [ ] GitHub Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 已添加
- [ ] GitHub Variables：`WORKER_URL`（可选）
- [ ] Cloudflare Secrets：`GITHUB_TOKEN`、`ACCESS_PASSWORD` 已添加
- [ ] GitHub 已有 `storage` 分支
- [ ] `wrangler.toml` 的 REPO=`P4x1s/CGIH`、BRANCH=`storage`
- [ ] Actions 部署运行成功（绿色）
- [ ] 访问 Worker 地址能打开登录页

全部打勾后即可正常使用。
