import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (label, extra = '') => console.log(`  [OK]   ${label}${extra ? `  ${extra}` : ''}`);
const bad = (label, extra = '') => console.log(`  [FAIL] ${label}${extra ? `  ${extra}` : ''}`);
const warn = (label, extra = '') => console.log(`  [WARN] ${label}${extra ? `  ${extra}` : ''}`);

let failed = 0;

console.log('环境检查\n');

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major > 22 || (major === 22 && minor >= 5)) ok('Node.js', `v${process.versions.node}`);
else { bad('Node.js 版本太低', `当前 v${process.versions.node}，需要 >= 22.5`); failed += 1; }

try {
  const sqlite = await import('node:sqlite');
  if (typeof sqlite.DatabaseSync === 'function') ok('node:sqlite 可用');
  else { bad('node:sqlite 不可用', '登录状态没法落盘'); failed += 1; }
} catch (error) {
  bad('node:sqlite 不可用', error.message);
  failed += 1;
}

if (existsSync(path.join(ROOT, 'node_modules'))) ok('依赖已安装');
else { bad('依赖未安装', '先运行 install.bat 或 npm install'); failed += 1; }

try {
  const mod = await import('douyin-im');
  if (typeof mod.createClient === 'function') ok('douyin-im 可加载');
  else { bad('douyin-im 缺少 createClient'); failed += 1; }
} catch (error) {
  bad('douyin-im 加载失败', error.message);
  failed += 1;
}

const configFile = path.join(ROOT, 'data', 'config.json');
if (existsSync(configFile)) {
  try {
    const raw = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(configFile, 'utf8')));
    ok('配置文件可读', configFile);
    if (raw?.deepseek?.apiKey) ok('DeepSeek API Key 已配置', `尾号 ${String(raw.deepseek.apiKey).slice(-4)}`);
    else warn('DeepSeek API Key 还没填', '打开界面 → 设置 → API Key');
    console.log(`         模型：${raw?.deepseek?.model ?? '(默认)'}`);
  } catch (error) {
    bad('配置文件解析失败', error.message);
    failed += 1;
  }
} else {
  warn('配置文件还没生成', '第一次启动会自动创建');
}

console.log('');
if (failed) {
  console.log(`检查没通过，${failed} 项要处理。`);
  process.exitCode = 1;
} else {
  console.log('检查通过，可以双击 start.bat 启动。');
}
