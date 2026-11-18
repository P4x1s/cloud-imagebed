/**
 * CloudImageBed v2 — 单文件 Cloudflare Worker
 * 前端页面 + 后端 API 一体化，GitHub 仓库作为存储后端。
 *
 * ============================ 部署步骤 ============================
 * 1. 准备一个 GitHub 仓库（建议新建一个专用空仓库）。
 * 2. 生成 Personal Access Token (classic)，勾选 repo 权限。
 *    注意：fine-grained token 对 Contents API 写操作会 403，不要用。
 * 3. wrangler.toml 里把 vars 改成你的值（REPO / BRANCH / DIR_PREFIX 等）。
 * 4. 在 Worker 的 Settings → Variables and Secrets 添加 Secret：
 *      GITHUB_TOKEN          = 上一步的 classic PAT
 *      ACCESS_PASSWORD       = 访问口令（前端登录用）
 *      TURNSTILE_SECRET_KEY  = Cloudflare Turnstile 密钥（前端登录人机校验）
 * 5. 部署：wrangler deploy --keep-vars  或  推送到 GitHub 触发 Actions。
 *    必须带 --keep-vars，否则会清空 Dashboard 上的 Secret。
 *
 * ============================ API ============================
 *  GET    /                          前端页面
 *  GET    /health                    健康检查 + 版本指纹
 *  GET    /api/config                公开配置（是否需登录、上限、线路等）
 *  POST   /api/login                 { password } → 签发会话 Cookie
 *  POST   /api/logout                清除会话 Cookie
 *  GET    /api/list                  列出已上传文件
 *  POST   /api/upload                multipart/form-data, field=file → 上传
 *  POST   /api/upload-url            { url, format? } → 远程 URL 转存（含 SSRF 防护）
 *  GET    /api/download?path=...     代理下载（服务端带 token 访问 raw）
 *  DELETE /api/file?path=&sha=       删除单个文件
 *  POST   /api/files/batch-delete    { items:[{path,sha}] } → 批量删除
 *  POST   /api/upload                PicGo 兼容：额外支持 Bearer 口令 + 返回顶层 url 字段
 * =============================================================
 */

import uiHtml from './ui.html';

const APP_VERSION = '2.6.2';
const SESSION_TTL = 7 * 24 * 3600; // 会话有效期 7 天（秒）
const COOKIE_NAME = 'cfib_session';
// Turnstile 站点密钥是公开的（下发给前端渲染组件）；密钥是 Secret，只放在服务端。
// 站点密钥可用环境变量 TURNSTILE_SITE_KEY 覆盖（部署自己的 Turnstile 时在 Dashboard
// 加同名 Variable 即可，见 handleConfig）；不设置则使用内置默认值。
const DEFAULT_TURNSTILE_SITE_KEY = '0x4AAAAAAGHCDGptGjnrqwmc';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// GitHub 单文件建议上限 50MB（硬上限 100MB）；base64 后请求体膨胀约 1/3，
// 且 Workers 单请求内存约 128MB，50MB 是兼顾稳定与安全的最大值。
const DEFAULT_MAX_MB = 50;
const DIRECT_LIMIT = 1048576; // ≤1MB 走 Contents API，更大走 Git Data API
const REMOTE_TIMEOUT_MS = 30000;

/* ---------------- 工具函数 ---------------- */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function b64uEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8Encode(s) { return new TextEncoder().encode(s); }
function utf8Decode(b) { return new TextDecoder().decode(b); }

async function hmacKey(secret) {
  return await crypto.subtle.importKey(
    'raw', utf8Encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}
async function signToken(payloadB64u, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, utf8Encode(payloadB64u));
  return payloadB64u + '.' + b64uEncode(new Uint8Array(sig));
}
async function verifyToken(token, secret) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64uDecode(sig), utf8Encode(payload));
    if (!ok) return null;
    const data = JSON.parse(utf8Decode(b64uDecode(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (e) { return null; }
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
/* 常量时间字符串比对：避免用 === 比对口令造成时序侧信道。 */
function safeEqual(a, b) {
  const x = utf8Encode(String(a == null ? '' : a));
  const y = utf8Encode(String(b == null ? '' : b));
  if (x.length !== y.length) {
    // 长度不同也逐字节跑一遍，尽量抹平时序差异
    let d = 1;
    for (let i = 0; i < x.length; i++) d |= x[i] ^ 0;
    for (let i = 0; i < y.length; i++) d |= y[i] ^ 0;
    return false;
  }
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function isAuthed(request, env) {
  if (!env.ACCESS_PASSWORD) return true; // 未设口令 → 公开
  // PicGo / PicList / 脚本等无 Cookie 场景：Authorization: Bearer <访问口令>
  const auth = request.headers.get('Authorization') || '';
  if (/^Bearer\s+/i.test(auth)) {
    const bearer = auth.replace(/^Bearer\s+/i, '').trim();
    if (safeEqual(bearer, env.ACCESS_PASSWORD)) return true;
  }
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return (await verifyToken(token, env.ACCESS_PASSWORD)) !== null;
}
function sessionCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL}`,
  ];
  // 仅 https 请求加 Secure，便于本地 http 调试
  return parts.join('; ');
}

/* ---------------- Turnstile 人机校验 ----------------
 * 只校验 Cloudflare 官方 siteverify 返回的 success，密钥不出服务端。
 * 未配置 TURNSTILE_SECRET_KEY 时视为未启用（向后兼容 / 本地开发）。
 */
function turnstileEnabled(env) {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}
async function verifyTurnstile(token, secret, remoteip) {
  if (!token || !secret) return false;
  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', String(token));
    if (remoteip) form.set('remoteip', String(remoteip));
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d && d.success === true;
  } catch (e) {
    return false;
  }
}

/* ---------------- GitHub API 封装 ---------------- */
function ghHeaders(env, extra = {}) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CloudImageBed',
    ...extra,
  };
}
function apiBase(env) {
  return `https://api.github.com/repos/${env.REPO}`;
}
function authEnabled(env) {
  return Boolean(env.GITHUB_TOKEN && env.REPO);
}
function maxBytes(env) {
  const n = Number(env.MAX_UPLOAD_MB) || DEFAULT_MAX_MB;
  return Math.max(1, Math.min(100, n)) * 1048576;
}

/* 图片的公开直链：优先用户自定义 CDN 前缀，否则 raw.githubusercontent.com。 */
function publicUrl(env, path) {
  const branch = env.BRANCH || 'main';
  const enc = path.split('/').map(encodeURIComponent).join('/');
  if (env.PUBLIC_BASE) {
    return `${env.PUBLIC_BASE.replace(/\/+$/, '')}/${enc}`;
  }
  return `https://raw.githubusercontent.com/${env.REPO}/${encodeURIComponent(branch)}/${enc}`;
}
function withUrls(env, item) {
  item.url = publicUrl(env, item.path);
  item.downloadUrl = `/api/download?path=${encodeURIComponent(item.path)}`;
  return item;
}

/* 路径工具：统一放到 [DIR_PREFIX/]YYYY/MM/ 下（年月优先） */
function safeName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'file';
}

/* 北京时间(UTC+8)的 YYYYMMDDhhmmss + 2 位毫秒，如 2026111815365012。 */
function stampTime(now) {
  const d = new Date(now + 8 * 3600 * 1000);
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `${p(Math.floor(d.getUTCMilliseconds() / 10))}`; // 毫秒取前 2 位（百分秒）
}

/* 生成时间戳文件名：YYYYMMDDhhmmssNN + 原扩展名，如 2026111815365012.png */
function stampName(name, now) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const suffix = /^[a-z0-9]{1,10}$/.test(ext) && String(name).includes('.') ? '.' + ext : '';
  return stampTime(now) + suffix;
}

/* 从文件名还原上传时间与显示名（兼容新旧两种格式） */
function parseStamp(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.[a-z0-9]{1,10})?$/);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6], +m[7] * 10);
    return { name, uploadedAt: ms };
  }
  const old = name.match(/^(\d{13})-[a-z0-9]{6,10}-(.+)$/);
  if (old) return { name: old[2], uploadedAt: Number(old[1]) };
  return { name, uploadedAt: Date.now() };
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    tiff: 'image/tiff', psd: 'image/vnd.adobe.photoshop', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    pdf: 'application/pdf', zip: 'application/zip', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', json: 'application/json',
    txt: 'text/plain', md: 'text/markdown', js: 'text/javascript', css: 'text/css',
    html: 'text/html', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}

/* 文件魔数校验：只放行声明的图片类型且内容签名匹配；SVG 一律拒绝（防 XSS）。
 * 非图片文件（文档/压缩包/音视频等）不做签名校验，仍可正常上传。 */
function validateMagic(buf, name, declaredMime) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const sigs = {
    png: [[0x89, 0x50, 0x4e, 0x47]],
    jpg: [[0xff, 0xd8, 0xff]],
    jpeg: [[0xff, 0xd8, 0xff]],
    gif: [[0x47, 0x49, 0x46, 0x38]],
    webp: [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP（只验前缀，够用）
    bmp: [[0x42, 0x4d]],
    avif: [[0x00, 0x00, 0x00], [0x66, 0x74, 0x79, 0x70]], // ftyp box
  };
  if (ext === 'svg' || ext === 'svgz' || /svg/i.test(String(declaredMime))) {
    return '出于安全考虑不支持 SVG 上传（可能含可执行脚本）';
  }
  const candidates = sigs[ext];
  // 只对「扩展名是图片 且 声明为图片 MIME」做签名校验。
  // 声明为 application/octet-stream 的（如第三方脚本/CLI）按普通文件处理，避免误伤。
  if (!candidates || !/^image\//i.test(String(declaredMime))) return null;
  const b = new Uint8Array(buf);
  const ok = candidates.some((sig) => sig.every((v, i) => b[i] === v));
  if (!ok) return `文件内容与扩展名不符（${ext.toUpperCase()} 魔数校验失败）`;
  return null;
}

/* 把上游状态码翻译成人话，避免只甩 status code。 */
function friendlyError(status, fallback) {
  const map = {
    400: '请求有误，请检查参数后重试',
    401: '登录已失效，请重新输入访问口令',
    403: '没有权限：GitHub Token 可能无效或缺少该仓库的写权限',
    404: '资源不存在（仓库可能为空或路径有误）',
    409: '文件冲突，请重试',
    413: '文件太大，超出单文件上限',
    422: 'GitHub 拒绝了这次写入（可能文件名冲突或内容不合法）',
    429: '操作太频繁，已触发 GitHub 速率限制，请稍后再试',
    500: '服务端开小差了，请稍后重试',
    502: '存储服务暂时不可用，请稍后重试',
  };
  return map[status] || fallback || '操作失败，请稍后重试';
}

/* 把 ArrayBuffer 转 base64（分片避免栈溢出） */
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ---------------- URL 上传：SSRF 防护 ---------------- */
function urlDanger(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return 'URL 格式不正确'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '仅支持 http / https 链接';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) return '不允许访问本地地址';
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2], c = +ipv4[3];
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 88 && c === 99) || (a === 198 && b >= 18 && b <= 19)) {
      return '不允许访问内网地址';
    }
  }
  if (host.startsWith('[')) {
    const ip6 = host.slice(1, -1).toLowerCase();
    if (ip6 === '::1' || ip6 === '::' || /^(fc|fd|fe[89ab])/.test(ip6)) return '不允许访问内网地址';
  }
  return null;
}

/* 手动跟随重定向，每一跳都重新做安全校验，最多 4 跳 */
async function fetchRemote(rawUrl, limit) {
  let current = String(rawUrl || '').trim();
  for (let i = 0; i < 4; i++) {
    const danger = urlDanger(current);
    if (danger) throw new Error(danger);
    let r;
    try {
      r = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        headers: { 'User-Agent': 'CloudImageBed/2.0', 'Accept': '*/*' },
      });
    } catch (e) {
      throw new Error('无法获取该链接：' + (e && e.message ? e.message : String(e)));
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('Location');
      if (!loc) throw new Error('重定向缺少目标地址');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!r.ok) throw new Error(`远程服务器返回 ${r.status}`);
    const declared = Number(r.headers.get('Content-Length') || 0);
    if (declared > limit) throw new Error(`远程文件超过 ${Math.round(limit / 1048576)}MB 上限`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > limit) throw new Error(`远程文件超过 ${Math.round(limit / 1048576)}MB 上限`);
    if (buf.byteLength === 0) throw new Error('远程文件为空');
    return { buf, type: r.headers.get('Content-Type') || '', finalUrl: current };
  }
  throw new Error('重定向次数过多');
}

function nameFromUrl(raw, type) {
  let name = 'remote-file';
  try {
    const u = new URL(raw);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) name = decodeURIComponent(seg);
  } catch (e) { /* 已在上游校验 */ }
  if (!/\.[a-z0-9]{1,10}$/i.test(name) && type) {
    const ext = String(type).split(';')[0].split('/').pop();
    if (ext && /^[a-z0-9]{1,10}$/i.test(ext)) name += '.' + ext.replace('jpeg', 'jpg');
  }
  return safeName(name);
}

/* ---------------- 路由处理 ---------------- */
async function handleConfig(request, env) {
  const authed = await isAuthed(request, env);
  return json({
    ok: true,
    needAuth: Boolean(env.ACCESS_PASSWORD),
    authed,
    maxUploadMB: Number(env.MAX_UPLOAD_MB) || DEFAULT_MAX_MB,
    demo: false,
    storage: 'github',
    publicBase: env.PUBLIC_BASE || '',
    repo: env.REPO || '',
    branch: env.BRANCH || 'main',
    maxRemoteMB: Math.min(Number(env.MAX_UPLOAD_MB) || DEFAULT_MAX_MB, DEFAULT_MAX_MB),
    // 国内可用的 jsDelivr 镜像备选（前端线路切换用），主线路仍是 raw
    cdnMirrors: [
      { id: 'jsdelivr', label: 'jsDelivr', base: 'https://cdn.jsdelivr.net/gh/' },
      { id: 'jsdmirror', label: 'jsDelivr 镜像', base: 'https://cdn.jsdmirror.cn/gh/' },
    ],
    picgo: {
      enabled: true,
      // 第三方客户端用 Bearer 口令鉴权；提示占位，不回传真实口令
      endpoint: '/api/upload',
    },
    turnstile: {
      enabled: turnstileEnabled(env),
      siteKey: env.TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY,
    },
    features: { urlUpload: true, batchDelete: true, cdnSwitch: true, convert: true, paste: true, picgo: true },
    configured: authEnabled(env),
    version: APP_VERSION,
  });
}

async function handleLogin(request, env) {
  if (!env.ACCESS_PASSWORD) return json({ ok: true }); // 未启用口令
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求格式错误' }, 400); }
  // 人机校验：仅当服务端配置了 Turnstile 密钥时强制。
  if (turnstileEnabled(env)) {
    const token = body.cfTurnstileResponse || body['cf-turnstile-response'];
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, ip))) {
      return json({ ok: false, error: '人机验证未通过，请刷新后重试' }, 403);
    }
  }
  if (!safeEqual(body.password, env.ACCESS_PASSWORD)) {
    return json({ ok: false, error: '口令错误' }, 401);
  }
  const payload = b64uEncode(utf8Encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
  })));
  const token = await signToken(payload, env.ACCESS_PASSWORD);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function handleLogout() {
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  });
}

/* 列出文件：用 Git Trees API 一次递归取全部 blob，避免逐目录请求 */
async function handleList(env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置 GITHUB_TOKEN / REPO' }, 500);
  const branch = env.BRANCH || 'main';
  const prefix = (env.DIR_PREFIX || '').replace(/^\/+|\/+$/g, '');

  const r = await fetch(`${apiBase(env)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
    headers: ghHeaders(env),
  });
  if (r.status === 404) {
    // 空仓库（还没有任何提交）没有 tree，属于正常状态：视为暂无文件
    return json({ ok: true, items: [], truncated: false });
  }
  if (!r.ok) {
    return json({ ok: false, error: friendlyError(r.status, `读取仓库失败 (${r.status})`) }, 502);
  }
  const data = await r.json();
  const items = (data.tree || [])
    .filter((n) => n.type === 'blob')
    .filter((n) => !prefix || n.path.startsWith(prefix + '/'))
    .filter((n) => /\.[a-z0-9]{1,8}$/i.test(n.path))
    .map((n) => {
      const name = n.path.split('/').pop();
      const parsed = parseStamp(name);
      return withUrls(env, {
        name: parsed.name,
        path: n.path,
        size: n.size,
        sha: n.sha,
        type: guessMime(name),
        uploadedAt: parsed.uploadedAt,
      });
    })
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  return json({ ok: true, items, truncated: Boolean(data.truncated) });
}

/* 把二进制内容写入 GitHub：小文件 Contents API，大文件 Git Data API。
 * 同时兼容 422（目标已存在）→ 时间戳 +10ms 重试，避免同百分秒覆盖。 */
async function storeFile(env, buf, originalName, mimeType, size) {
  const branch = env.BRANCH || 'main';
  const prefix = (env.DIR_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const message = `upload: ${originalName}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now() + attempt * 10;
    const bj = new Date(now + 8 * 3600 * 1000);
    const base = stampName(originalName, now);
    const path = [prefix, bj.getUTCFullYear(),
      String(bj.getUTCMonth() + 1).padStart(2, '0'), base].filter(Boolean).join('/');
    const encPath = path.split('/').map(encodeURIComponent).join('/');

    if (size <= DIRECT_LIMIT) {
      const payload = { message, content: abToBase64(buf), branch };
      const r = await fetch(`${apiBase(env)}/contents/${encPath}`, {
        method: 'PUT', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (r.status === 422 && attempt < 4) continue; // 同时间戳冲突 → 换 10ms 重试
      if (!r.ok) {
        const t = await r.text();
        return { error: `上传失败 (${r.status}): ${t.slice(0, 240)}`, status: 502 };
      }
      const d = await r.json();
      return { item: withUrls(env, {
        name: base, path, size, type: mimeType || guessMime(base),
        sha: d.content && d.content.sha, uploadedAt: now,
      }) };
    }

    // 大文件：Git Data API（blob → tree → commit → ref）
    const blobRes = await fetch(`${apiBase(env)}/git/blobs`, {
      method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content: abToBase64(buf), encoding: 'base64' }),
    });
    if (!blobRes.ok) {
      const t = await blobRes.text();
      return { error: `创建大文件 blob 失败 (${blobRes.status}): ${t.slice(0, 240)}`, status: 502 };
    }
    const blob = await blobRes.json();

    const refRes = await fetch(`${apiBase(env)}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: ghHeaders(env) });
    if (!refRes.ok) return { error: '获取分支引用失败', status: 502 };
    const commitSha = (await refRes.json()).object.sha;

    const commitRes = await fetch(`${apiBase(env)}/git/commits/${commitSha}`, { headers: ghHeaders(env) });
    if (!commitRes.ok) return { error: '获取最新提交失败', status: 502 };
    const rootTreeSha = (await commitRes.json()).tree.sha;

    const treeRes = await fetch(`${apiBase(env)}/git/trees`, {
      method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        base_tree: rootTreeSha,
        tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
      }),
    });
    if (!treeRes.ok) {
      const t = await treeRes.text();
      return { error: `创建 tree 失败 (${treeRes.status}): ${t.slice(0, 240)}`, status: 502 };
    }
    const treeData = await treeRes.json();

    const newCommitRes = await fetch(`${apiBase(env)}/git/commits`, {
      method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message, tree: treeData.sha, parents: [commitSha] }),
    });
    if (!newCommitRes.ok) {
      const t = await newCommitRes.text();
      return { error: `创建提交失败 (${newCommitRes.status}): ${t.slice(0, 240)}`, status: 502 };
    }
    const newCommit = await newCommitRes.json();

    const updateRes = await fetch(`${apiBase(env)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
    if (!updateRes.ok) {
      const t = await updateRes.text();
      return { error: `更新引用失败 (${updateRes.status}): ${t.slice(0, 240)}`, status: 502 };
    }
    return { item: withUrls(env, {
      name: base, path, size, type: mimeType || guessMime(base),
      sha: blob.sha, uploadedAt: now,
    }) };
  }
  return { error: '文件名冲突，请稍后重试', status: 409 };
}

/* 上传：multipart/form-data, field=file */
async function handleUpload(request, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  let form;
  try { form = await request.formData(); } catch (e) { return json({ ok: false, error: '表单解析失败' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ ok: false, error: '缺少文件字段 file' }, 400);
  const limit = maxBytes(env);
  // 前置拦截：先看请求头声明的长度，超限直接 413，避免把大 body 读进内存吃满 CPU
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit * 1.4) {
    return json({ ok: false, error: `文件超过 ${Math.round(limit / 1048576)}MB 上限` }, 413);
  }
  if (file.size > limit) {
    return json({ ok: false, error: `文件超过 ${Math.round(limit / 1048576)}MB 上限` }, 413);
  }
  const buf = await file.arrayBuffer();
  const mime = file.type || guessMime(file.name);
  const magicErr = validateMagic(buf, file.name, mime);
  if (magicErr) return json({ ok: false, error: magicErr }, 415);
  const out = await storeFile(env, buf, file.name, mime, file.size);
  if (out.error) return json({ ok: false, error: friendlyError(out.status, out.error) }, out.status || 502);
  // 顶层 url 字段：兼容 PicGo / PicList / Typora 等第三方客户端
  return json({ ok: true, url: out.item.url, item: out.item });
}

/* URL 转存：服务端拉取远程文件后按普通文件存储 */
async function handleUploadUrl(request, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求格式错误' }, 400); }
  const raw = String(body.url || '').trim();
  if (!raw) return json({ ok: false, error: '请填写图片或文件链接' }, 400);
  try {
    const { buf, type, finalUrl } = await fetchRemote(raw, maxBytes(env));
    const name = nameFromUrl(finalUrl, type);
    const mime = type.split(';')[0] || guessMime(name);
    const magicErr = validateMagic(buf, name, mime);
    if (magicErr) return json({ ok: false, error: magicErr }, 415);
    const out = await storeFile(env, buf, name, mime, buf.byteLength);
    if (out.error) return json({ ok: false, error: friendlyError(out.status, out.error) }, out.status || 502);
    return json({ ok: true, url: out.item.url, item: out.item });
  } catch (e) {
    return json({ ok: false, error: e && e.message ? e.message : String(e) }, 400);
  }
}

/* 删除文件：Contents API DELETE 需要 sha */
async function deleteOne(env, path, sha) {
  const branch = env.BRANCH || 'main';
  const resp = await fetch(
    `${apiBase(env)}/contents/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'DELETE',
      headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: `delete: ${String(path).split('/').pop()}`, sha, branch }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`删除失败 (${resp.status}): ${t.slice(0, 160)}`);
  }
  return true;
}

async function handleDelete(url, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  const path = url.searchParams.get('path');
  const sha = url.searchParams.get('sha');
  if (!path || !sha) return json({ ok: false, error: '缺少 path 或 sha' }, 400);
  if (path.indexOf('..') >= 0) return json({ ok: false, error: '非法路径' }, 400);
  try {
    await deleteOne(env, path, sha);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

/* 批量删除：逐项执行，单项失败不影响其它项 */
async function handleBatchDelete(request, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求格式错误' }, 400); }
  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  if (!items.length) return json({ ok: false, error: '没有待删除的文件' }, 400);
  const deleted = [];
  const failed = [];
  for (const it of items) {
    const path = it && it.path, sha = it && it.sha;
    if (!path || !sha || String(path).indexOf('..') >= 0) {
      failed.push({ path: path || '', error: '参数不完整' });
      continue;
    }
    try { await deleteOne(env, path, sha); deleted.push(path); }
    catch (e) { failed.push({ path, error: e.message }); }
  }
  return json({ ok: true, deleted, failed, count: deleted.length });
}

/* 下载/预览：服务端带 token 取 raw 内容，前端拿到二进制 */
async function handleDownload(url, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  const path = url.searchParams.get('path');
  if (!path || path.indexOf('..') >= 0) return json({ ok: false, error: '非法路径' }, 400);
  const branch = env.BRANCH || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${env.REPO}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(rawUrl, { headers: { 'User-Agent': 'CloudImageBed', 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } });
  if (!r.ok) return json({ ok: false, error: friendlyError(r.status, `下载失败 (${r.status})`) }, 502);
  const name = path.split('/').pop();
  const mime = guessMime(name);
  const disposition = mime.startsWith('image/') ? 'inline' : 'attachment';
  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/* CORS：严格白名单，默认只允许同源。绝不返回 "*"。
 * 只有 Origin 命中 ALLOWED_ORIGINS（逗号分隔）才回显该域名。 */
function applyCors(resp, request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return resp;
  const allow = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.includes(origin)) return resp; // 不在白名单 → 不加头，浏览器自动拦截
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Credentials', 'true');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

/* ---------------- Worker 入口 ---------------- */
export default {
  async fetch(request, env) {
    // CORS 预检：白名单内才放行
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      const allow = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (origin && allow.includes(origin)) {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        } });
      }
      return new Response(null, { status: 403 });
    }
    const resp = await route(request, env);
    return applyCors(resp, request, env);
  },
};

async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 前端页面
    if (path === '/' || path === '/index.html') {
      return new Response(uiHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    // 健康检查 + 版本指纹（供部署自检用）
    if (path === '/health') {
      return json({ ok: true, app: 'CloudImageBed', version: APP_VERSION });
    }

    // config/login 例外，由各自处理鉴权
    if (path === '/api/config' && request.method === 'GET') return handleConfig(request, env);
    if (path === '/api/login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/logout' && request.method === 'POST') return handleLogout();

    if (!(await isAuthed(request, env))) return json({ ok: false, error: '未授权' }, 401);

    try {
      if (path === '/api/list' && request.method === 'GET') return await handleList(env);
      if (path === '/api/upload' && request.method === 'POST') return await handleUpload(request, env);
      if (path === '/api/upload-url' && request.method === 'POST') return await handleUploadUrl(request, env);
      if (path === '/api/file' && request.method === 'DELETE') return await handleDelete(url, env);
      if (path === '/api/files/batch-delete' && request.method === 'POST') return await handleBatchDelete(request, env);
      if (path === '/api/download' && request.method === 'GET') return await handleDownload(url, env);
    } catch (e) {
      return json({ ok: false, error: '服务端异常: ' + (e && e.message ? e.message : String(e)) }, 500);
    }

    return json({ ok: false, error: 'Not Found' }, 404);
}
