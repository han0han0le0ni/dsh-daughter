#!/usr/bin/env node
/**
 * 连接器令牌工具：打印、导出、轮换。
 *
 * 桥接端点（47612）与桌面 / 安卓连接器（47614 / 47613）都要求令牌，
 * VPet MOD、独立壳、第三方脚本需要拿到同一个值才能连上。
 *
 * 这里直接用 dist/ 里的实现，所以 npm 安装的用户也能用：
 *   npx dsh-daughter-token
 *   npx dsh-daughter-token --write-to "<MOD 目录>"
 *   npx dsh-daughter-token --rotate
 *
 * 参数：
 *   --data-root <目录>  指定数据根目录（宿主把 storage.data_root 改到别处时必须传，
 *                       否则会在这里新造一个令牌，和插件实际用的那个对不上）
 *   --write-to <目录>   同时写入 <目录>/token.txt（MOD / 壳直接读）
 *   --rotate            删掉旧令牌重新生成（所有连接器都要换新值）
 *   --json              机器可读
 *
 * 从源码仓库运行时等价于 `npm run connector:token`。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveDataRoot } from '../dist/config.js';
import { CONNECTOR_TOKEN_FILE, ensureConnectorToken } from '../dist/runtime/connector-auth.js';
import { silentLogger } from '../dist/util.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

// 插件根目录：bin/ 的上一级
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const config = loadConfig(pluginRoot, silentLogger);

// 宿主可能用 storage.data_root 覆盖 config.yaml 里的值；这里允许显式指定，
// 避免在包目录里新造一个令牌，而插件实际读的是另一个位置
const dataRootOverride = String(value('data-root', process.env.DSH_DAUGHTER_DATA_ROOT ?? '')).trim();
const dataRoot = dataRootOverride ? resolve(pluginRoot, dataRootOverride) : resolveDataRoot(pluginRoot, config);
const tokenPath = join(dataRoot, CONNECTOR_TOKEN_FILE);

if (has('rotate')) {
  if (existsSync(tokenPath)) rmSync(tokenPath, { force: true });
  console.error('已删除旧令牌，下面输出的是新生成的值。');
}

const state = ensureConnectorToken(dataRoot, config.security?.connector_token);
if (!state.token) {
  console.error(`无法取得连接器令牌：${state.path}`);
  console.error('  检查目录是否可写，或在 config.yaml 的 security.connector_token 里显式指定（≥16 字符）。');
  process.exit(1);
}

const writeTo = value('write-to', '');
const written = [];
if (writeTo) {
  const target = resolve(writeTo, 'token.txt');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${state.token}\n`, { encoding: 'utf8', mode: 0o600 });
  written.push(target);
}

if (has('json')) {
  console.log(JSON.stringify({ token: state.token, source: state.source, path: state.path, files: written }, null, 2));
} else {
  console.log(`令牌来源：${state.source}`);
  console.log(`令牌文件：${state.path}`);
  console.log('');
  console.log(state.token);
  for (const file of written) console.log(`\n已写入：${file}`);
  console.log('');
  console.log('把它交给连接器：');
  console.log('  · VPet MOD：放到 MOD 的 plugin 目录下的 token.txt，或设置环境变量 DSH_DAUGHTER_TOKEN');
  console.log('  · 独立壳 / 桥接脚本：--token <值>，或设置 DSH_DAUGHTER_TOKEN');
  console.log('提示：令牌只在本机使用，不要提交进仓库。');
}

// 打印完立即退出，避免残留句柄把命令挂住
process.exit(0);
