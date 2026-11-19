# CloudImageBed 安全审计报告

> 审计日期：2026-11-19 · 版本：v2.7.0 · 范围：全量源码 + 线上部署配置
> 结论：**发现 4 个安全问题（1 中危 / 3 低危），已全部修复并上线**；其余检查项通过。

---

## 一、审计范围与方法

| 对象 | 内容 |
|------|------|
| `src/worker.js`（770 行） | 路由、鉴权、会话、GitHub API、SSRF 防护、上传/删除/下载 |
| `src/ui.html`（1659 行） | 前端渲染、DOM 操作、剪贴板、WASM 加载 |
| `wrangler.toml` / `.github/workflows/deploy.yml` | 变量/Secret 隔离、CI 触发条件、依赖版本 |
| 敏感信息扫描 | Token / 口令 / 站点密钥 / 账户 ID 全仓库检索 |
| 线上渗透测试 | 会话伪造、越权访问、安全响应头、CORS 预检（本地 bundle 复刻线上逻辑） |

方法：**静态代码审计 + 运行时渗透测试（黑盒 payload）+ 配置审计**三层交叉验证。

---

## 二、发现的问题与修复

### 🔴 中危 · SSRF 过滤可被绕过（URL 转存接口）

**问题**：`urlDanger()` 仅用正则匹配字面量 IPv4，以下 payload 可绕过黑名单访问内网/云元数据：

- IPv4-mapped IPv6：`http://[::ffff:127.0.0.1]/`、`http://[::ffff:7f00:1]/`、`http://[::ffff:169.254.169.254]/`
- DNS rebinding：`http://127.0.0.1.nip.io/`、`http://demo.sslip.io/`
- IPv6 私网段：此前未覆盖 `fc00::/7`（ULA）、`fe80::/10`（链路本地）

攻击者若登录后可借此让服务端请求内网资源（如云主机元数据接口），造成信息泄露。

**修复**：重写为「展开 IPv6 为 8 组 → 屏蔽 `::`/`::1`/ULA/链路本地 → 提取 IPv4-mapped/compatible 内嵌地址复查私网规则 → 动态 DNS 域名黑名单」的多层校验。12 类绕过 payload 已加入回归测试，全部拦截；正常公网地址不受影响。

### 🟡 低危 · 会话 Cookie 缺少 Secure 标志

**问题**：`sessionCookie()` 注释声称"仅 https 加 Secure"，但代码从未实现。会话令牌可能在明文链路泄露。

**修复**：Cookie 无条件附加 `Secure`（配合原有 `HttpOnly` + `SameSite=Lax`）。

### 🟡 低危 · 缺少安全响应头

**问题**：所有响应无 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、CSP，存在 MIME 嗅探、点击劫持、Referer 信息泄露风险。

**修复**：新增统一安全响应头并注入全部响应路径：

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy`：脚本源限定为 self + Turnstile + 白名单 CDN；下载代理用 `default-src 'none'; sandbox`

### 🟡 低危 · 上传队列 DOM XSS（需登录）

**问题**：`renderQueue()` 将 `q.error`（服务端错误消息）未经转义插入 `innerHTML`，若错误消息包含 HTML 标签可在登录用户浏览器执行。

**修复**：改为 `esc(q.error)` 转义。已复核其余全部 `innerHTML` 拼接点均经过转义，`toast` 使用 `textContent`，无 `eval`/`new Function`。

---

## 三、确认安全的现存设计（未改动）

| 检查项 | 结论 |
|--------|------|
| 会话令牌 | HMAC-SHA256 签名 + 7 天 exp 过期，伪造/篡改/过期 token 渗透测试均被拒（401） |
| 口令比对 | 常量时间比对 `safeEqual`，防时序侧信道 |
| 鉴权覆盖 | 所有写/列举操作前统一鉴权；config/login/logout 为设计性例外 |
| 第三方客户端 | 支持 `Authorization: Bearer` 鉴权（PicGo 等） |
| 路径穿越 | delete / batch-delete / download 均检查 `..`；文件名 `safeName` 过滤危险字符 |
| CORS | 严格白名单，无 `*`，Vary: Origin 防缓存污染；恶意 Origin 预检被拒（403） |
| 上传安全 | SVG 拒绝（防 XSS 脚本）、图片魔数校验、体积前置拦截、Content-Disposition 文件名编码 |
| SSRF 基础 | 仅 http/https、内网 IPv4 全段、169.254 元数据、重定向逐跳校验（≤4 跳）、长度双校验 |
| 密钥管理 | GITHUB_TOKEN / ACCESS_PASSWORD / TURNSTILE_SECRET_KEY 均为 Dashboard Secret，源码零硬编码 |
| CI 安全 | Actions 仅 push 触发（无 `pull_request_target` fork 攻击面）+ 仓库 Owner 校验 |

---

## 四、验证结果

| 测试套件 | 结果 |
|----------|------|
| 安全静态审计 `security_test.cjs` | **55 / 55 通过** |
| 运行时渗透测试 `pentest.cjs` | **8 / 8 通过** |
| Worker 全链路回归 | **79 / 79 通过** |
| UI 管线像素比对 | **10 / 10 通过** |
| 压缩限高专项 | **9 / 9 通过** |
| 线上部署验证 | Actions `success`，CF API 确认 v2.7.0 含全部 10 项安全特征 |

---

## 五、残余风险与建议

1. **登录爆破**：已有 Turnstile 人机校验（配置密钥时强制）；未配置密钥的私有部署建议自行在 CDN 层加速率限制。
2. **动态 DNS SSRF**：已屏蔽常见 rebinding 域名；新型动态 DNS 服务仍可能出现，属持续对抗，建议定期复审黑名单。
3. **依赖供应链**：WASM 编码器从 CDN 加载且固定版本 `@jsquash/webp@1.5.0`；如需极致安全可改为自托管并加 SRI。
4. **权限最小化**：Cloudflare API Token 与 GitHub Token 建议按实际用途定期轮换，遵循最小权限。

---

*本报告仅描述项目自身安全状态，不含任何真实凭据。部署配置请以占位符教程（README.md）为准。*
