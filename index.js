import { createHost } from './dist/host.js';

// webServer 用于星图面板；tools 用于注册 desktop_observe；connection 用于星图接口的宿主准入
export const inject = ['webServer', 'tools', 'connection'];

export function apply(ctx, config) {
  createHost(ctx, config ?? {}, import.meta.dirname);
}
