/**
 * 连接器令牌：本机其它进程（桌宠 MOD、独立壳、桌面桥）访问插件端点时的唯一凭据。
 *
 * 为什么需要它：桥接端点监听在 127.0.0.1，但**任何本机网页**都能向它发请求。
 * `POST /vpet/ingest` 能往记忆里写任意文本，`GET /vpet/events` 能把对话内容读走，
 * 桌面连接器的 `/screenshot`、`/input` 更是屏幕与键鼠。环回地址不是权限边界。
 *
 * 三条规则：
 * 1. **默认拒绝**：拿不到令牌（文件建不出来、配置为空且无文件）时，服务端一律 503，
 *    不因为"本机来的"就放行。
 * 2. **浏览器来源直接拒绝**：连接器从不带 `Origin` / `Sec-Fetch-*`，带了就说明是网页发起的，
 *    即便令牌碰巧泄露也不认（挡掉 CSRF 与 DNS rebinding 这类同机跨源）。
 * 3. **常量时间比较**：先各自 sha256 再比对，避免按前缀长度猜令牌。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../util.js';

/** 请求头名。大小写不敏感，Node 会把收到的头统一转小写。 */
export const CONNECTOR_TOKEN_HEADER = 'x-dsh-token';
/** 令牌文件位置（相对 data_root）。放在脑干的"安全协议"区，和运行时数据一起被 gitignore。 */
export const CONNECTOR_TOKEN_FILE = join('brain', 'brainstem', 'connector_token');
/** 低于这个长度的令牌视为无效（手填时拦掉 `123456` 这种） */
export const CONNECTOR_TOKEN_MIN_LENGTH = 16;

export interface ConnectorTokenState {
  /** 空字符串表示拿不到令牌：此时服务端必须拒绝所有连接器请求 */
  token: string;
  source: 'config' | 'file' | 'created' | 'unavailable';
  /** 令牌文件绝对路径，便于日志与排查 */
  path: string;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length >= CONNECTOR_TOKEN_MIN_LENGTH ? raw : null;
  } catch {
    return null;
  }
}

function writeTokenFile(path: string): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const token = generateToken();
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    // Windows 上 mode 基本无效，但仍显式收紧一次：Unix 上这一步是真正的 0600
    try {
      chmodSync(path, 0o600);
    } catch {
      /* 文件系统不支持就跳过 */
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * 取得连接器令牌，顺序是「配置 > 已有文件 > 新建文件」。
 *
 * 配置里显式给了就用配置（便于多机/容器固定），否则读文件，文件不存在就生成一份 0600。
 * 三步都失败时返回 `unavailable`，调用方必须据此拒绝服务，**不能退化成无认证**。
 */
export function ensureConnectorToken(
  dataRoot: string,
  explicit: string | undefined,
  logger?: Partial<Logger>,
): ConnectorTokenState {
  const path = join(dataRoot, CONNECTOR_TOKEN_FILE);
  const configured = String(explicit ?? '').trim();
  if (configured.length >= CONNECTOR_TOKEN_MIN_LENGTH) {
    return { token: configured, source: 'config', path };
  }
  if (configured.length > 0) {
    logger?.warn?.('dsh-daughter: security.connector_token 太短，已忽略并使用文件令牌', {
      minLength: CONNECTOR_TOKEN_MIN_LENGTH,
    });
  }

  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: 'file', path };

  const created = writeTokenFile(path);
  if (created) {
    logger?.info?.('dsh-daughter: 已生成连接器令牌', { path });
    return { token: created, source: 'created', path };
  }

  logger?.warn?.('dsh-daughter: 连接器令牌不可用，桥接端点将拒绝所有请求', { path });
  return { token: '', source: 'unavailable', path };
}

/** 出站调用用的请求头：本插件自己的工具访问桥接端点时带上 */
export function tokenHeader(token: string): Record<string, string> {
  return token ? { [CONNECTOR_TOKEN_HEADER]: token } : {};
}

/** 从请求里取令牌：优先专用头，其次 `Authorization: Bearer`（方便 curl / 通用客户端） */
export function readIncomingToken(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const direct = req.headers[CONNECTOR_TOKEN_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (matched?.[1]) return matched[1].trim();
  }
  return null;
}

/**
 * 是否浏览器发起。连接器用 `fetch`/`HttpClient`，不会带这些头；
 * 带了就说明是页面里的脚本（或 `<img src>` 之类），一律不认。
 *
 * 注意**不能**用 `sec-fetch-mode` 判断：Node 自带的 fetch（undici）也会发
 * `sec-fetch-mode: cors`，用它会把插件自己的工具误判成浏览器。
 * 浏览器在跨源请求上必带 `Origin`，在导航/子资源上必带 `Sec-Fetch-Site`，
 * 这两个才是可靠的区分点。
 */
export function isBrowserInitiated(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const { headers } = req;
  if (headers.origin !== undefined) return true;
  if (headers['sec-fetch-site'] !== undefined) return true;
  const referer = headers.referer;
  if (typeof referer === 'string' && /^https?:/i.test(referer.trim())) return true;
  return false;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 常量时间比较：长度不同也走同一路径，避免按响应时间区分 */
export function tokenMatches(expected: string, actual: string | null): boolean {
  if (!expected || !actual) return false;
  return timingSafeEqual(digest(expected), digest(actual));
}

export interface ConnectorAuthVerdict {
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * 连接器端点统一判定。返回 `ok: false` 时调用方直接回 `status`，不要再往下走。
 *
 * - 浏览器来源 → 403（即使带了正确令牌）
 * - 服务端没令牌 → 503（fail closed）
 * - 令牌缺失/不匹配 → 401
 */
export function authorizeConnectorRequest(
  req: { headers: Record<string, string | string[] | undefined> },
  expectedToken: string,
): ConnectorAuthVerdict {
  if (isBrowserInitiated(req)) {
    return { ok: false, status: 403, reason: 'browser_origin' };
  }
  if (!expectedToken) {
    return { ok: false, status: 503, reason: 'token_unavailable' };
  }
  if (!tokenMatches(expectedToken, readIncomingToken(req))) {
    return { ok: false, status: 401, reason: 'token_mismatch' };
  }
  return { ok: true };
}
