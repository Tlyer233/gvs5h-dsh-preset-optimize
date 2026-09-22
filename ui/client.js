window.__ModuleLoader__.load({
  id: '@local/fable-gvs5h-icon',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PATH = 'M1047.36 0h-222.24L1230.4 1024h222.24L1047.36 0zM405.28 0L0 1024h226.624l82.88-215.04h424l82.88 215.04h226.624L637.728 0h-232.448z m-22.464 618.784l138.688-359.872 138.688 359.872h-277.376z';
    function GvsIcon(props) {
      const size = props.size || 16;
      return h('svg', {
        viewBox: '0 0 1472 1024',
        width: size,
        height: size,
        className: props.className,
        'aria-hidden': true,
        preserveAspectRatio: 'xMidYMid meet',
      }, h('path', { d: PATH, fill: 'currentColor' }));
    }
    return {
      inject: ['commandUi'],
      apply(ctx) {
        const ui = ctx.commandUi;
        const orig = ui.candidates.bind(ui);
        ctx.effect(function () {
          ui.candidates = async function (session, req) {
            const rows = await orig(session, req);
            return rows.map(function (row) {
              if (row.name !== 'gvs5h') return row;
              return Object.assign({}, row, { icon: GvsIcon });
            });
          };
          return function () {
            ui.candidates = orig;
          };
        });
      },
    };
  },
});
