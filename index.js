import z from '@deepseek-ai/schemastery';
import { loadConfig } from './dist/config.js';
import { createHost } from './dist/host.js';
import { SETTINGS_FIELDS } from './dist/runtime/settings-ui.js';

// webServer 用于星图与意见反馈面板；tools 用于注册 desktop_observe；connection 用于接口的宿主准入
export const inject = ['webServer', 'tools', 'connection'];

export function apply(ctx, config) {
  createHost(ctx, config ?? {}, import.meta.dirname);
}

/**
 * DSH 0.1.7+ 用 plugin.Config 生成「插件配置」表单，并把 simplify(config) 写回。
 * simplify 会丢掉未声明字段，所以这里按 config.yaml 的实际值声明整棵树；
 * 只有下面这些常用开关对用户界面可见，其余字段 hidden 但仍参与往返，避免保存表单时把配置洗掉。
 */
const VISIBLE = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.path, field.label]));
const LIMITS = Object.fromEntries(
  SETTINGS_FIELDS.filter((field) => field.type === 'number').map((field) => [field.path, [field.min, field.max]]),
);

const visibleKeys = Object.keys(VISIBLE);
const hasVisibleChild = (path) => visibleKeys.some((key) => key.startsWith(`${path}.`));

function fieldSchema(value, path) {
  let schema;
  if (typeof value === 'boolean') {
    schema = z.boolean();
  } else if (typeof value === 'number') {
    schema = z.number();
    const limits = LIMITS[path];
    if (limits) schema = schema.min(limits[0]).max(limits[1]);
  } else if (typeof value === 'string') {
    schema = z.string();
  } else if (Array.isArray(value)) {
    schema = z.array(z.any());
  } else if (value && typeof value === 'object') {
    schema = z.object(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fieldSchema(child, path ? `${path}.${key}` : key)])),
    );
  } else {
    schema = z.any();
  }

  schema = schema.default(value);
  if (VISIBLE[path]) return schema.description(VISIBLE[path]);
  // 分组下还有可见字段时不能隐藏，否则子字段一起从表单消失
  if (value && typeof value === 'object' && !Array.isArray(value) && hasVisibleChild(path)) return schema;
  return schema.hidden(true);
}

const baseConfig = loadConfig(import.meta.dirname);
export const Config = z
  .object(Object.fromEntries(Object.entries(baseConfig).map(([key, value]) => [key, fieldSchema(value, key)])))
  .loose();
