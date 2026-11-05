import { createHost } from './dist/host.js';

// webServer 用于星图面板；tools 用于注册 desktop_observe
export const inject = ['webServer', 'tools'];

export function apply(ctx, config) {
  createHost(ctx, config ?? {}, import.meta.dirname);
}
