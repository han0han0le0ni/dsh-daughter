// dsh-daughter 的浏览器侧入口：在侧边栏「面板」列表里加一个「脑星图」按钮，
// 点开后由宿主的主栏渲染一张同源 iframe（/star-map/），数据由插件自带的路由提供。
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
        '.dsh-dd-frame{display:block;width:100%;height:100%;min-height:100%;border:0;background:#06070b}';

      if (!React || !ctx.slots || !ctx.locale || typeof ctx.effect !== 'function') {
        console.warn('[dsh-daughter] 当前宿主没有面板插槽，脑星图只能通过 /star-map/ 访问');
        return;
      }

      const h = React.createElement;
      const PanelIcon = ({ size }) =>
        h(
          'svg',
          { width: size ?? 16, height: size ?? 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: '#6d5dfc', 'stroke-width': 1.4 }),
          h('circle', { cx: 8, cy: 8, r: 2.2, fill: '#f0a35a' }),
          h('circle', { cx: 13.2, cy: 4.4, r: 1.4, fill: '#a99cff' }),
        );
      const PanelPage = () => h('iframe', { className: 'dsh-dd-frame', title: '脑星图', src: '/star-map/' });

      ctx.effect(
        () => ctx.locale.register(NS, { zh: { panel: '脑星图' }, en: { panel: 'Star Map' } }),
        'dsh-daughter:dictionaries',
      );
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'daughter-starmap', locale: NS, inject: () => ({}) }, PanelPage),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'daughter-starmap', order: 31, locale: NS, label: () => t('panel') },
          PanelIcon,
        ),
      );
    };

    return module.exports;
  },
});
