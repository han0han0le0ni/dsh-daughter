/**
 * Android ADB 动作层。
 *
 * 只负责把受限动作编译成 adb 参数并执行，不直接暴露 shell 给模型，
 * 避免命令注入；所有动作必须命中 ACTIONS 白名单。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ACTIONS = [
  'devices',
  'open_app',
  'tap',
  'swipe',
  'text',
  'key',
  'screenshot',
  'foreground',
];

const PACKAGE_RE = /^[A-Za-z0-9_.]+$/;
const ACTIVITY_RE = /^[A-Za-z0-9_.$]+$/;

function requireNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是数字`);
  return String(Math.round(number));
}

function requirePackage(value) {
  const pkg = String(value ?? '').trim();
  if (!PACKAGE_RE.test(pkg)) throw new Error('package 必填且只能包含字母、数字、下划线和点');
  return pkg;
}

/** `input text` 不接受空格与 shell 元字符，这里做白名单清洗并转义空格 */
export function escapeInputText(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9\u4e00-\u9fa5@.,!?:_/+=%\- ]/g, '');
  if (!text.trim()) throw new Error('text 不能为空');
  return text.replace(/ /g, '%s');
}

/** 根据动作与参数生成 adb 参数数组；serial 为空时交给 adb 选择默认设备 */
export function buildAdbArgs(action, params = {}, serial = '') {
  const prefix = serial ? ['-s', String(serial)] : [];

  switch (action) {
    case 'devices':
      return [...prefix, 'devices', '-l'];

    case 'open_app': {
      const pkg = requirePackage(params.package);
      const activity = String(params.activity ?? '').trim();
      if (activity) {
        if (!ACTIVITY_RE.test(activity)) throw new Error('activity 只能包含字母、数字、点、下划线和 $');
        return [...prefix, 'shell', 'am', 'start', '-n', `${pkg}/${activity}`];
      }
      return [
        ...prefix,
        'shell',
        'monkey',
        '-p',
        pkg,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ];
    }

    case 'tap':
      return [...prefix, 'shell', 'input', 'tap', requireNumber(params.x, 'x'), requireNumber(params.y, 'y')];

    case 'swipe':
      return [
        ...prefix,
        'shell',
        'input',
        'swipe',
        requireNumber(params.x1, 'x1'),
        requireNumber(params.y1, 'y1'),
        requireNumber(params.x2, 'x2'),
        requireNumber(params.y2, 'y2'),
        requireNumber(params.duration ?? 300, 'duration'),
      ];

    case 'text':
      return [...prefix, 'shell', 'input', 'text', escapeInputText(params.text)];

    case 'key': {
      const key = String(params.key ?? '').trim();
      if (!/^(KEYCODE_[A-Z0-9_]+|[0-9]+)$/.test(key)) throw new Error('key 必须是 KEYCODE_* 或数字');
      return [...prefix, 'shell', 'input', 'keyevent', key];
    }

    case 'screenshot':
      return [...prefix, 'exec-out', 'screencap', '-p'];

    case 'foreground':
      return [...prefix, 'shell', 'dumpsys', 'activity', 'activities'];

    default:
      throw new Error(`未知动作：${action}；可用动作：${ACTIONS.join(', ')}`);
  }
}

/** 解析 `adb devices -l` 输出 */
export function parseDevices(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices'))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      return { serial, state, detail: rest.join(' ') || undefined };
    })
    .filter((device) => device.serial && device.state);
}

/** 从 `dumpsys activity activities` 输出提取前台包名/Activity */
export function parseForeground(output) {
  const text = String(output ?? '');
  const patterns = [
    /mResumedActivity:.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /topResumedActivity=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    /ResumedActivity:.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      return {
        package: matched[1],
        activity: matched[2],
        key: `${matched[1]}/${matched[2]}`,
      };
    }
  }
  return null;
}

/** 创建真实 adb 执行器；测试可注入假的 runner 替换它 */
export function createAdbRunner({ adbPath = process.env.ADB_PATH || 'adb', timeoutMs = 15000 } = {}) {
  return async (args) => {
    const { stdout, stderr } = await execFileAsync(adbPath, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    });
    return { stdout, stderr };
  };
}
