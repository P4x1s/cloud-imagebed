/**
 * CloudImageBed — 单文件 Cloudflare Worker
 * 前端页面 + 后端 API 一体化，GitHub 仓库作为存储后端。
 *
 * ============================ 部署步骤 ============================
 * 1. 准备一个 GitHub 仓库（建议新建一个专用空仓库，可设为私有）。
 * 2. 生成 Personal Access Token (classic)，勾选 repo 权限（私有仓库）
 *    或 public_repo（公开仓库）。fine-grained token 需给对应仓库 Contents 读写。
 * 3. wrangler.toml 里把 vars 改成你的值（REPO / BRANCH / DIR_PREFIX 等）。
 * 4. 在 Worker 的 Settings → Variables and Secrets 添加 Secret：
 *      GITHUB_TOKEN  = 上一步的 token
 *      ACCESS_PASSWORD = 访问口令（前端登录用）
 *    （本地开发则写进 .dev.vars）
 * 5. 部署：wrangler deploy   或  推送到 GitHub 触发 Actions。
 *    注意：wrangler deploy 必须带 --keep-vars，否则会清空 Dashboard 上的 Secret。
 *
 * ============================ API ============================
 *  GET  /                       前端页面
 *  GET  /api/config             公开配置（是否需登录、上限等）
 *  POST /api/login              { password } → 签发会话 Cookie
 *  POST /api/logout             清除会话 Cookie
 *  GET  /api/list               列出已上传文件
 *  POST /api/upload             multipart/form-data, field=file → 上传
 *  GET  /api/download?path=...  代理下载（服务端带 token 访问 raw）
 *  DELETE /api/file?path=&sha=  删除文件
 * =============================================================
 */

import uiHtml from './ui.html';

const APP_VERSION = '1.0.0';
const SESSION_TTL = 7 * 24 * 3600; // 会话有效期 7 天（秒）
const COOKIE_NAME = 'cfib_session';

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
async function isAuthed(request, env) {
  if (!env.ACCESS_PASSWORD) return true; // 未设口令 → 公开
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

/* 图片的公开直链：优先用户自定义 CDN 前缀，否则 raw.githubusercontent.com。
 * 注意：私有仓库的 raw 直链需鉴权，此时前端应走 /api/download 代理，
 * 因此当未配置 PUBLIC_BASE 且是私有仓库时，url 留空，前端自动回退到代理接口。 */
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

/* 路径工具：统一放到 [DIR_PREFIX/]YYYY/MM/ 下（年月优先），文件名做安全清洗 */
function safeName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'file';
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
    txt: 'text/plain', md: 'text/markdown', js: 'text/javascript', css: 'text/css',
    html: 'text/html', mp3: 'audio/mpeg', wav: 'audio/wav',
  };
  return map[ext] || 'application/octet-stream';
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

/* ---------------- 路由处理 ---------------- */
async function handleConfig(request, env) {
  const authed = await isAuthed(request, env);
  return json({
    ok: true,
    needAuth: Boolean(env.ACCESS_PASSWORD),
    authed,
    maxUploadMB: Number(env.MAX_UPLOAD_MB) || 25,
    demo: false,
    storage: 'github',
    publicBase: env.PUBLIC_BASE || '',
    configured: authEnabled(env),
    version: APP_VERSION,
  });
}

async function handleLogin(request, env) {
  if (!env.ACCESS_PASSWORD) return json({ ok: true }); // 未启用口令
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求格式错误' }, 400); }
  if (body.password !== env.ACCESS_PASSWORD) {
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
  if (!r.ok) {
    const t = await r.text();
    return json({ ok: false, error: `读取仓库失败 (${r.status}): ${t.slice(0, 200)}` }, 502);
  }
  const data = await r.json();
  if (data.truncated) {
    // 仓库过大时 Git Trees 会截断，提示但尽量返回已有数据
  }
  const items = (data.tree || [])
    .filter((n) => n.type === 'blob')
    .filter((n) => !prefix || n.path.startsWith(prefix + '/'))
    // 排除仓库自带的说明文件
    .filter((n) => /\.[a-z0-9]{1,8}$/i.test(n.path))
    .map((n) => {
      const name = n.path.split('/').pop();
      // 文件名格式为 <时间戳>-<随机串>-<原名>，还原上传时间与显示名
      const m = name.match(/^(\d{13})-[a-z0-9]{6,10}-(.+)$/);
      const ts = name.match(/^(\d{13})-/);
      const uploadedAt = ts ? Number(ts[1]) : Date.now();
      const displayName = m ? m[2] : name;
      return withUrls(env, {
        name: displayName,
        path: n.path,
        size: n.size,
        sha: n.sha,
        type: guessMime(name),
        uploadedAt,
      });
    })
    .sort((a, b) => b.name.localeCompare(a.name));

  return json({ ok: true, items, truncated: Boolean(data.truncated) });
}

/* 上传：小文件用 Contents API（一次提交）；大文件用 Git Data API（blob → tree → commit → ref） */
async function handleUpload(request, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  let form;
  try { form = await request.formData(); } catch (e) { return json({ ok: false, error: '表单解析失败' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ ok: false, error: '缺少文件字段 file' }, 400);

  const maxBytes = (Number(env.MAX_UPLOAD_MB) || 25) * 1048576;
  if (file.size > maxBytes) {
    return json({ ok: false, error: `文件超过 ${env.MAX_UPLOAD_MB || 25}MB 上限` }, 413);
  }

  const now = Date.now();
  // internal: DIR_PREFIX 为可选手动前缀；主结构按年月 YYYY/MM 归档（年月优先）
  const prefix = (env.DIR_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const rand = Math.random().toString(36).slice(2, 10);
  const base = `${now}-${rand}-${safeName(file.name)}`;
  const path = [prefix, new Date(now).getUTCFullYear(),
    String(new Date(now).getUTCMonth() + 1).padStart(2, '0'), base].filter(Boolean).join('/');

  const buf = await file.arrayBuffer();
  const branch = env.BRANCH || 'main';
  const message = `upload: ${file.name}`;

  // 阈值：GitHub Contents API 建议 < 1MB 走 put，更大走 Git Data API
  const DIRECT_LIMIT = 1048576;
  if (file.size <= DIRECT_LIMIT) {
    const payload = {
      message,
      content: abToBase64(buf),
      branch,
    };
    const r = await fetch(`${apiBase(env)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      return json({ ok: false, error: `上传失败 (${r.status}): ${t.slice(0, 240)}` }, 502);
    }
    const d = await r.json();
    return json({
      ok: true,
      item: withUrls(env, {
        name: file.name, path, size: file.size, type: file.type || guessMime(file.name),
        sha: d.content && d.content.sha, uploadedAt: now,
      }),
    });
  }

  // 大文件：Git Data API
  const blobRes = await fetch(`${apiBase(env)}/git/blobs`, {
    method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: abToBase64(buf), encoding: 'base64' }),
  });
  if (!blobRes.ok) {
    const t = await blobRes.text();
    return json({ ok: false, error: `创建大文件 blob 失败 (${blobRes.status}): ${t.slice(0, 240)}` }, 502);
  }
  const blob = await blobRes.json();

  // 取当前分支最新 commit sha 与根 tree sha
  const refRes = await fetch(`${apiBase(env)}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: ghHeaders(env) });
  if (!refRes.ok) return json({ ok: false, error: '获取分支引用失败' }, 502);
  const refData = await refRes.json();
  const commitSha = refData.object.sha;

  const commitRes = await fetch(`${apiBase(env)}/git/commits/${commitSha}`, { headers: ghHeaders(env) });
  if (!commitRes.ok) return json({ ok: false, error: '获取最新提交失败' }, 502);
  const commitData = await commitRes.json();
  const rootTreeSha = commitData.tree.sha;

  const treeRes = await fetch(`${apiBase(env)}/git/trees`, {
    method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      base_tree: rootTreeSha,
      tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  });
  if (!treeRes.ok) {
    const t = await treeRes.text();
    return json({ ok: false, error: `创建 tree 失败 (${treeRes.status}): ${t.slice(0, 240)}` }, 502);
  }
  const treeData = await treeRes.json();

  const newCommitRes = await fetch(`${apiBase(env)}/git/commits`, {
    method: 'POST', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, tree: treeData.sha, parents: [commitSha] }),
  });
  if (!newCommitRes.ok) {
    const t = await newCommitRes.text();
    return json({ ok: false, error: `创建提交失败 (${newCommitRes.status}): ${t.slice(0, 240)}` }, 502);
  }
  const newCommit = await newCommitRes.json();

  const updateRes = await fetch(`${apiBase(env)}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH', headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  if (!updateRes.ok) {
    const t = await updateRes.text();
    return json({ ok: false, error: `更新引用失败 (${updateRes.status}): ${t.slice(0, 240)}` }, 502);
  }

  return json({
    ok: true,
    item: withUrls(env, {
      name: file.name, path, size: file.size, type: file.type || guessMime(file.name),
      sha: blob.sha, uploadedAt: now,
    }),
  });
}

/* 删除文件：Contents API DELETE 需要 sha */
async function handleDelete(url, env) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  const path = url.searchParams.get('path');
  const sha = url.searchParams.get('sha');
  if (!path || !sha) return json({ ok: false, error: '缺少 path 或 sha' }, 400);
  if (path.indexOf('..') >= 0) return json({ ok: false, error: '非法路径' }, 400);

  const branch = env.BRANCH || 'main';
  const resp = await fetch(
    `${apiBase(env)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'DELETE',
      headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: `delete: ${path.split('/').pop()}`, sha, branch }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text();
    return json({ ok: false, error: `删除失败 (${resp.status}): ${t.slice(0, 240)}` }, 502);
  }
  return json({ ok: true });
}

/* 下载/预览：服务端带 token 取 raw 内容，前端拿到二进制 */
async function handleDownload(url, env, request) {
  if (!authEnabled(env)) return json({ ok: false, error: '服务端未配置' }, 500);
  const path = url.searchParams.get('path');
  if (!path || path.indexOf('..') >= 0) return json({ ok: false, error: '非法路径' }, 400);
  const branch = env.BRANCH || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${env.REPO}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(rawUrl, { headers: { 'User-Agent': 'CloudImageBed', 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } });
  if (!r.ok) return json({ ok: false, error: `下载失败 (${r.status})` }, 502);
  const name = path.split('/').pop();
  const mime = guessMime(name);
  // 图片走内联以便预览，其余走附件下载
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

/* ---------------- Worker 入口 ---------------- */
export default {
  async fetch(request, env) {
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

    // 以下 API 需要鉴权（config/login 例外由各自处理）
    if (path === '/api/config' && request.method === 'GET') return handleConfig(request, env);
    if (path === '/api/login' && request.method === 'POST') return handleLogin(request, env);
    if (path === '/api/logout' && request.method === 'POST') return handleLogout();

    if (!(await isAuthed(request, env))) return json({ ok: false, error: '未授权' }, 401);

    try {
      if (path === '/api/list' && request.method === 'GET') return await handleList(env);
      if (path === '/api/upload' && request.method === 'POST') return await handleUpload(request, env);
      if (path === '/api/file' && request.method === 'DELETE') return await handleDelete(url, env);
      if (path === '/api/download' && request.method === 'GET') return await handleDownload(url, env, request);
    } catch (e) {
      return json({ ok: false, error: '服务端异常: ' + (e && e.message ? e.message : String(e)) }, 500);
    }

    return json({ ok: false, error: 'Not Found' }, 404);
  },
};
