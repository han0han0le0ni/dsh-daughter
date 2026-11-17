// dsh-daughter 的浏览器侧入口：侧边栏只保留「脑星图」；
// 「daughter设置」与「意见反馈」都放在 DSH 设置弹窗的同一个分区里。
// 模式与 dsh-thoughtdag / dsh-synapse 一致：window.__ModuleLoader__.load +
// inject 声明依赖的客户端服务。
window.__ModuleLoader__.load({
  id: 'dsh-daughter',
  factory: (require) => {
    const module = { exports: {} };

    let React = null;
    try {
      React = require('react');
    } catch {
      React = null;
    }

    module.exports.inject = ['slots', 'locale'];
    module.exports.apply = (ctx) => {
      const NS = 'dsh-daughter';
      const CSS_ID = 'dsh-daughter/client.css';
      let style = document.head.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
      if (!style) {
        style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-daughter');
        style.setAttribute('data-plugin-css', CSS_ID);
        document.head.append(style);
      }
      style.textContent =
        '.dsh-dd-frame{display:block;width:100%;height:100%;min-height:100%;border:0;background:transparent}';

      if (!React || !ctx.slots || !ctx.locale || typeof ctx.effect !== 'function') {
        console.warn('[dsh-daughter] 当前宿主没有面板插槽，页面只能通过 /star-map/、/feedback/、/daughter-settings/ 访问');
        return;
      }

      const h = React.createElement;
      const StarIcon = ({ size }) =>
        h(
          'svg',
          { width: size ?? 16, height: size ?? 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: '#6d5dfc', 'stroke-width': 1.4 }),
          h('circle', { cx: 8, cy: 8, r: 2.2, fill: '#f0a35a' }),
          h('circle', { cx: 13.2, cy: 4.4, r: 1.4, fill: '#a99cff' }),
        );
      const StarPage = () => h('iframe', { className: 'dsh-dd-frame', title: '脑星图', src: '/star-map/' });
      const SettingsPage = () => h('iframe', { className: 'dsh-dd-frame', title: 'daughter设置', src: '/daughter-settings/' });

      ctx.effect(
        () => ctx.locale.register(NS, {
          zh: { panel: '脑星图', settings: 'daughter设置' },
          en: { panel: 'Star Map', settings: 'daughter Settings' },
        }),
        'dsh-daughter:dictionaries',
      );
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'daughter-starmap', locale: NS, inject: () => ({}) }, StarPage),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'daughter-starmap', order: 31, locale: NS, label: () => t('panel') },
          StarIcon,
        ),
      );
      // DSH 原生设置弹窗左侧的一级分区：功能开关 + 意见反馈
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-daughter-settings',
            order: 152,
            locale: NS,
            label: () => t('settings'),
            inject: () => ({}),
          },
          SettingsPage,
        );
      });
    };

    return module.exports;
  },
});
