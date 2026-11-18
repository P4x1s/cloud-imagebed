/**
 * Worker 逻辑测试：mock GitHub API + env，直接调用 worker.fetch
 * 验证 config/login/upload/list/download/delete 全链路。
 */
import workerDefault from '../dist/worker.bundle.mjs';

const env = {
  REPO: 'test/repo',
  BRANCH: 'main',
  DIR_PREFIX: 'images',
  MAX_UPLOAD_MB: '25',
  PUBLIC_BASE: '',
  GITHUB_TOKEN: 'ghp_fake',
  ACCESS_PASSWORD: 'secret123',
};

// 内存 mock GitHub 仓库
const store = new Map(); // path -> { content(base64), sha }
let shaCounter = 1000;
let trees404 = false; // 模拟空仓库（无提交）→ git/trees 返回 404
let turnstileValid = true; // 模拟 siteverify 结果
let turnstileCalls = 0; // 记录 siteverify 调用次数
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers || {});
  const body = opts.body ? (typeof opts.body === 'string' ? opts.body : '') : '';

  function resp(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }
  function rawResp(bytes, status = 200) {
    return new Response(bytes, { status });
  }

  // Turnstile siteverify
  if (url.includes('challenges.cloudflare.com/turnstile/v0/siteverify')) {
    turnstileCalls++;
    return resp({ success: turnstileValid, hostname: 'example.workers.dev' });
  }
  // Git Trees 递归列出
  if (url.includes('/git/trees/') && url.includes('recursive=1') && method === 'GET') {
    if (trees404) return resp({ message: 'Not Found', status: '404' }, 404);
    const tree = [...store.entries()].map(([path, o]) => ({ path, type: 'blob', sha: o.sha, size: o.size }));
    return resp({ tree, truncated: false });
  }
  // Contents API: PUT (小文件上传)
  if (url.includes('/contents/') && method === 'PUT') {
    const path = decodeURIComponent(url.split('/contents/')[1]);
    const d = JSON.parse(body);
    const sha = 'blob' + (++shaCounter);
    store.set(path, { content: d.content, sha, size: Math.ceil(d.content.length * 3 / 4) });
    return resp({ content: { sha } }, 201);
  }
  // Contents API: DELETE
  if (url.includes('/contents/') && method === 'DELETE') {
    const path = decodeURIComponent(url.split('/contents/')[1]);
    if (!store.has(path)) return resp({ message: 'Not Found' }, 404);
    store.delete(path);
    return resp({ content: null }, 200);
  }
  // Git Data API: blobs
  if (url.endsWith('/git/blobs') && method === 'POST') {
    const d = JSON.parse(body);
    const sha = 'blob' + (++shaCounter);
    store.set('__pending_blob__', { content: d.content, sha, size: Math.ceil(d.content.length * 3 / 4) });
    return resp({ sha }, 201);
  }
  // Git Data API: ref/heads
  if (url.includes('/git/ref/heads/') && method === 'GET') {
    return resp({ object: { sha: 'commit_root' } });
  }
  // Git Data API: commits/<sha> GET
  if (url.match(/\/git\/commits\/[^/]+$/) && method === 'GET') {
    return resp({ tree: { sha: 'tree_root' } });
  }
  // Git Data API: trees POST
  if (url.endsWith('/git/trees') && method === 'POST') {
    const d = JSON.parse(body);
    const added = d.tree[0];
    // 把 pending blob 落到具体路径
    const pending = store.get('__pending_blob__');
    store.delete('__pending_blob__');
    store.set(added.path, { content: pending.content, sha: added.sha, size: pending.size });
    return resp({ sha: 'tree_new' }, 201);
  }
  // Git Data API: commits POST
  if (url.endsWith('/git/commits') && method === 'POST') {
    return resp({ sha: 'commit_new' }, 201);
  }
  // Git Data API: refs PATCH
  if (url.includes('/git/refs/heads/') && method === 'PATCH') {
    return resp({ object: { sha: 'commit_new' } });
  }
  // 远程 URL 转存（/api/upload-url）：mock 一个公网图片源
  if (url.startsWith('https://example.com/') || url.startsWith('https://cdn.test/')) {
    if (url.includes('redirect')) {
      return new Response(null, { status: 302, headers: { Location: 'https://cdn.test/final-image.png' } });
    }
    const pngish = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    return new Response(pngish, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  // raw download
  if (url.includes('raw.githubusercontent.com')) {
    const parts = url.split('/main/');
    const path = parts[1] ? decodeURIComponent(parts[1]) : '';
    const o = store.get(path);
    if (!o) return rawResp(new Uint8Array(), 404);
    const bin = atob(o.content);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return rawResp(arr, 200);
  }
  return resp({ error: 'unmatched ' + method + ' ' + url }, 404);
};

const worker = workerDefault;
function req(path, opts = {}) {
  return new Request('https://example.workers.dev' + path, opts);
}
const results = [];
function check(name, cond, extra = '') {
  results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' :: ' + extra : ''));
}

// 1) config 未登录
let r = await worker.fetch(req('/api/config'), env);
let d = await r.json();
check('config needAuth', d.needAuth === true, JSON.stringify(d));
check('config authed=false', d.authed === false);

// 2) 未登录访问 list → 401
r = await worker.fetch(req('/api/list'), env);
check('list unauthorized 401', r.status === 401, 'status=' + r.status);

// 3) 错误口令 → 401
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'wrong' }),
}), env);
check('wrong password 401', r.status === 401, 'status=' + r.status);

// 4) 正确口令 → Cookie
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'secret123' }),
}), env);
const cookie = r.headers.get('Set-Cookie') || '';
check('login 200', r.status === 200);
check('set-cookie HttpOnly', cookie.includes('HttpOnly') && cookie.includes('cfib_session'));
const session = cookie.split(';')[0]; // cfib_session=xxx

// 5) 带 Cookie 上传小文件
const smallContent = 'hello-imagebed';
const fd = new FormData();
fd.append('file', new Blob([smallContent], { type: 'text/plain' }), 'hello.txt');
r = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fd }), env);
d = await r.json();
check('upload small ok', d.ok === true, JSON.stringify(d).slice(0, 200));
const uploadedPath = d.item && d.item.path;
check('upload path year-month first', uploadedPath && /^images\/\d{4}\/\d{2}\//.test(uploadedPath), uploadedPath);
const uploadedName = uploadedPath && uploadedPath.split('/').pop();
check('upload filename is timestamp', uploadedName && /^\d{16}\.txt$/.test(uploadedName), uploadedName);
check('upload has url', !!(d.item && d.item.url));

// 6) 列目录
r = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
d = await r.json();
check('list ok', d.ok === true);
check('list has 1 item', d.items && d.items.length === 1, 'count=' + (d.items || []).length);
check('list display name = timestamp', d.items && d.items[0].name === uploadedName, d.items && d.items[0].name);
check('list uploadedAt restored', d.items && Math.abs(d.items[0].uploadedAt - Date.now()) < 60000, d.items && d.items[0].uploadedAt);

// 7) 下载
r = await worker.fetch(req('/api/download?path=' + encodeURIComponent(uploadedPath), { headers: { Cookie: session } }), env);
const dlText = await r.text();
check('download content matches', dlText === smallContent, 'got=' + dlText);

// 8) 删除
const sha = d.items[0].sha;
r = await worker.fetch(req('/api/file?path=' + encodeURIComponent(uploadedPath) + '&sha=' + encodeURIComponent(sha), {
  method: 'DELETE', headers: { Cookie: session },
}), env);
d = await r.json();
check('delete ok', d.ok === true, JSON.stringify(d));
r = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
d = await r.json();
check('list empty after delete', d.items.length === 0, 'count=' + d.items.length);

// 9) 首页与 health
r = await worker.fetch(req('/'), env);
check('homepage html', r.headers.get('Content-Type').includes('text/html') && (await r.text()).includes('CloudImageBed'));
r = await worker.fetch(req('/health'), env);
d = await r.json();
check('health version', d.version === '2.5.0');

// 10) 年月优先目录（线上真实配置：DIR_PREFIX 为空）—— 所有类型都落到 YYYY/MM/
const envClean = { ...env, DIR_PREFIX: '' };
const typeCases = ['photo.PNG', 'clip.mp4', 'song.mp3', 'doc.pdf', 'pack.zip', 'app.exe', 'font.woff2', 'mystery.xyzabc'];
for (const fname of typeCases) {
  const fdT = new FormData();
  fdT.append('file', new Blob(['x'], { type: 'application/octet-stream' }), fname);
  const rr = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fdT }), envClean);
  const dd = await rr.json();
  const fn = dd.item && dd.item.path.split('/').pop();
  const ext = fname.split('.').pop().toLowerCase();
  check('year-month dir ' + fname, dd.ok === true && /^\d{4}\/\d{2}\//.test(dd.item.path), dd.item && dd.item.path);
  check('timestamp filename ' + fname, !!fn && new RegExp('^\\d{16}\\.' + ext + '$').test(fn), fn);
}


// 10) 大文件走 Git Data API 分支
const bigBytes = new Uint8Array(1048576 + 100); // >1MB
for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = i % 251;
const fdBig = new FormData();
fdBig.append('file', new Blob([bigBytes], { type: 'application/octet-stream' }), 'big.bin');
r = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fdBig }), env);
d = await r.json();
check('upload big(git-data) ok', d.ok === true && !!d.item, JSON.stringify(d).slice(0, 160));
const bigName = d.item && d.item.path.split('/').pop();
check('big filename is timestamp', !!bigName && /^\d{16}\.bin$/.test(bigName), bigName);
r = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
d = await r.json();
const bigItem = (d.items || []).find((x) => x.name === bigName);
check('big file listed', !!bigItem, 'items=' + (d.items || []).map((x) => x.name).join(','));
if (bigItem) {
  r = await worker.fetch(req('/api/download?path=' + encodeURIComponent(bigItem.path), { headers: { Cookie: session } }), env);
  const dlBytes = new Uint8Array(await r.arrayBuffer());
  let same = dlBytes.length === bigBytes.length;
  if (same) for (let i = 0; i < bigBytes.length; i++) { if (dlBytes[i] !== bigBytes[i]) { same = false; break; } }
  check('big file roundtrip', same, 'dlLen=' + dlBytes.length + ' origLen=' + bigBytes.length);
}

// 11) config v2 新字段
r = await worker.fetch(req('/api/config'), env);
d = await r.json();
check('config version 2', d.version === '2.5.0');
check('config maxUploadMB default', d.maxUploadMB === 25, 'maxUploadMB=' + d.maxUploadMB);
check('config repo/branch', d.repo === 'test/repo' && d.branch === 'main');
check('config features', !!(d.features && d.features.urlUpload && d.features.batchDelete && d.features.cdnSwitch && d.features.convert && d.features.paste));

// 12) URL 转存（含 302 重定向跟随）
r = await worker.fetch(req('/api/upload-url', {
  method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com/pic/redirect' }),
}), env);
d = await r.json();
check('upload-url ok', d.ok === true, JSON.stringify(d).slice(0, 180));
check('upload-url name from final url', d.item && /^\d{16}\.png$/.test(d.item.name), d.item && d.item.name);
const urlPath = d.item && d.item.path;

// 13) SSRF 防护：内网/本地地址必须拒绝
const badUrls = ['http://127.0.0.1/x.png', 'http://localhost/a', 'http://192.168.1.1/secret',
  'http://10.0.0.5/a', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data'];
for (const bad of badUrls) {
  const rr = await worker.fetch(req('/api/upload-url', {
    method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: bad }),
  }), env);
  const dd = await rr.json();
  const isSsrfMsg = /内网|本地|仅支持 http/.test(dd.error || '');
  check('SSRF blocked ' + bad, dd.ok === false && rr.status === 400 && isSsrfMsg, JSON.stringify(dd).slice(0, 100));
}

// 14) 批量删除：混用 1 个真实 + 1 个不存在
const listR = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
const listD = await listR.json();
const realItem = listD.items.find((x) => x.path === urlPath) || listD.items[0];
r = await worker.fetch(req('/api/files/batch-delete', {
  method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [
    { path: realItem.path, sha: realItem.sha },
    { path: '2026/11/nope.txt', sha: 'fakesha' },
  ] }),
}), env);
d = await r.json();
check('batch-delete ok', d.ok === true && d.count === 1, JSON.stringify(d).slice(0, 160));
check('batch-delete partial fail reported', d.failed && d.failed.length === 1, 'failed=' + (d.failed || []).length);
r = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
d = await r.json();
check('batch-delete removed real item', !d.items.some((x) => x.path === realItem.path));

// 15) 空仓库：git/trees 返回 404 → 列表应正常返回空（而不是 502）
trees404 = true;
r = await worker.fetch(req('/api/list', { headers: { Cookie: session } }), env);
d = await r.json();
check('empty repo list status 200', r.status === 200, 'status=' + r.status);
check('empty repo list ok + empty items', d.ok === true && Array.isArray(d.items) && d.items.length === 0, JSON.stringify(d).slice(0, 160));
trees404 = false;

// 16) PicGo 兼容：Bearer 口令鉴权 + 顶层 url 字段
const fdP = new FormData();
fdP.append('file', new Blob(['x'], { type: 'application/octet-stream' }), 'picgo.png');
r = await worker.fetch(req('/api/upload', {
  method: 'POST', headers: { Authorization: 'Bearer secret123' }, body: fdP,
}), env);
d = await r.json();
check('picgo bearer auth upload ok', d.ok === true && !!d.url, JSON.stringify(d).slice(0, 160));
check('picgo top-level url == item.url', d.url === d.item.url);
r = await worker.fetch(req('/api/upload', {
  method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: fdP,
}), env);
check('picgo wrong bearer 401', r.status === 401, 'status=' + r.status);

// 17) config 新字段：cdnMirrors / picgo / features.picgo
r = await worker.fetch(req('/api/config'), env);
d = await r.json();
check('config cdnMirrors present', Array.isArray(d.cdnMirrors) && d.cdnMirrors.length >= 1);
check('config picgo.enabled', !!(d.picgo && d.picgo.enabled && d.features.picgo));

// 18) 魔数校验：声明 image/png 但内容不是 PNG → 415 拒绝
const fdFake = new FormData();
fdFake.append('file', new Blob(['not-a-real-png'], { type: 'image/png' }), 'fake.png');
r = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fdFake }), env);
d = await r.json();
check('magic mismatch rejected 415', r.status === 415 && /魔数/.test(d.error || ''), JSON.stringify(d));
// 真 PNG 魔数 → 通过
const realPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
const fdReal = new FormData();
fdReal.append('file', new Blob([realPng], { type: 'image/png' }), 'real.png');
r = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fdReal }), env);
check('real png magic accepted', r.status === 200, 'status=' + r.status);

// 19) SVG 拒绝（XSS 防护）
const fdSvg = new FormData();
fdSvg.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'bad.svg');
r = await worker.fetch(req('/api/upload', { method: 'POST', headers: { Cookie: session }, body: fdSvg }), env);
d = await r.json();
check('svg rejected 415', r.status === 415 && /SVG/.test(d.error || ''), JSON.stringify(d));

// 20) CORS：白名单外的 Origin 不加头；白名单内回显
const envCors = { ...env, ALLOWED_ORIGINS: 'https://good.example' };
r = await worker.fetch(req('/api/config', { headers: { Origin: 'https://evil.example' } }), envCors);
check('cors origin not allowed -> no header', !r.headers.get('Access-Control-Allow-Origin'));
r = await worker.fetch(req('/api/config', { headers: { Origin: 'https://good.example' } }), envCors);
check('cors origin allowed -> echoed', r.headers.get('Access-Control-Allow-Origin') === 'https://good.example');
check('cors never wildcard', r.headers.get('Access-Control-Allow-Origin') !== '*');
r = await worker.fetch(req('/api/config', { method: 'OPTIONS', headers: { Origin: 'https://good.example' } }), envCors);
check('cors preflight 204', r.status === 204);

// 21) config 暴露 Turnstile 公开配置（站点密钥公开、是否启用看 Secret）
r = await worker.fetch(req('/api/config'), env);
d = await r.json();
check('config turnstile siteKey public', d.turnstile && d.turnstile.siteKey === '0x4AAAAAAGHCDGptGjnrqwmc', JSON.stringify(d.turnstile));
check('config turnstile disabled without secret', d.turnstile && d.turnstile.enabled === false);

// 22) Turnstile：未配置 Secret 时登录不校验（向后兼容）
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'secret123' }),
}), env);
check('login works without turnstile secret', r.status === 200 && turnstileCalls === 0, 'status=' + r.status + ' calls=' + turnstileCalls);

// 23) Turnstile：配置 Secret 后，缺 token → 403，且不签发 Cookie
const envT = { ...env, TURNSTILE_SECRET_KEY: 'fake-turnstile-secret-for-test' };
r = await worker.fetch(req('/api/config'), envT);
d = await r.json();
check('config turnstile enabled with secret', d.turnstile && d.turnstile.enabled === true);
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'secret123' }),
}), envT);
check('login missing turnstile token 403', r.status === 403, 'status=' + r.status);
check('login missing token no cookie', !(r.headers.get('Set-Cookie') || '').includes('cfib_session'));

// 24) Turnstile：校验失败 → 403
turnstileValid = false;
const callsBefore = turnstileCalls;
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'secret123', cfTurnstileResponse: 'bad-token' }),
}), envT);
check('login invalid turnstile 403', r.status === 403, 'status=' + r.status);
check('siteverify called', turnstileCalls === callsBefore + 1, 'delta=' + (turnstileCalls - callsBefore));

// 25) Turnstile：校验通过 + 正确口令 → 200 且签发 Cookie
turnstileValid = true;
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'secret123', cfTurnstileResponse: 'good-token' }),
}), envT);
check('login valid turnstile 200', r.status === 200, 'status=' + r.status);
check('login valid turnstile sets cookie', (r.headers.get('Set-Cookie') || '').includes('cfib_session'));
// 口令错误但 Turnstile 通过 → 仍 401
r = await worker.fetch(req('/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'wrong', cfTurnstileResponse: 'good-token' }),
}), envT);
check('wrong password still 401 with valid turnstile', r.status === 401, 'status=' + r.status);

globalThis.fetch = origFetch;
console.log('\n==== WORKER TEST RESULTS ====');
results.forEach((x) => console.log(x));
const failed = results.filter((x) => x.startsWith('FAIL'));
console.log('\nTOTAL=' + results.length + ' FAILED=' + failed.length);
if (failed.length) process.exit(1);
