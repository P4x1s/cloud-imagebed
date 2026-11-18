/**
 * 构建验证：用 esbuild 模拟 Wrangler 打包，确认 worker.js 语法正确、
 * ui.html 文本导入正常。需从项目根目录运行：node tests/build-check.cjs
 */
const esbuild = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
esbuild.build({
  entryPoints: [path.join(root, 'src/worker.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  loader: { '.html': 'text' },
  logLevel: 'info',
}).then((r) => {
  const out = r.outputFiles[0].text;
  console.log('BUILD_OK bytes=' + out.length);
  console.log('has_ui_html_marker=' + out.includes('CloudImageBed'));
  console.log('has_fetch_handler=' + out.includes('fetch(request, env)'));
  console.log('has_api_config=' + out.includes('/api/config'));
  fs.writeFileSync(path.join(root, 'dist/worker.bundle.mjs'), out);
}).catch((e) => {
  console.error('BUILD_FAIL', e.message);
  process.exit(1);
});
