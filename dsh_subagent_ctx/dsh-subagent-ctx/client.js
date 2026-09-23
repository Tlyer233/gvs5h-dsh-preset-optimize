// 一次性子代理 composer 位：盖掉官方只读废话条，实时显示 ctx / tps / 缓存命中。
// chain 按 priority 升序选第一个非 null；官方 SubagentReadOnlyComposer 是 -10，我们用 -20 抢到。

window.__ModuleLoader__.load({
  id: "dsh-subagent-ctx",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useState, useEffect } = React;

    const STATUS_URL = "/ext/dsh-subagent-ctx/status";
    const POLL_MS = 500;

    const CSS = [
      ".scx-frame{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);min-height:54px;color:var(--dsw-alias-label-tertiary);border-radius:14px;justify-content:center;align-items:center;gap:10px;margin:0 24px 20px;padding:10px 16px;font-size:13px;line-height:20px;display:flex;flex-wrap:wrap}",
      ".scx-frame strong{color:var(--dsw-alias-label-primary);font-weight:510}",
      ".scx-sep{color:var(--dsw-alias-label-tertiary)}",
    ].join("");

    const TAG_ID = "dsh-subagent-ctx/css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + TAG_ID + "\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-subagent-ctx";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** tokens / 1024 → k */
    function fmtTok(n) {
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2).replace(/\.00$/, "") + "M";
      if (n >= 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + "k";
      return String(Math.round(n));
    }

    function fmtTps(n) {
      if (!Number.isFinite(n) || n <= 0) return "-";
      return n.toFixed(1);
    }

    function fmtHit(n) {
      if (!Number.isFinite(n) || n < 0) return null;
      if (n >= 99.95) return "100%";
      if (n >= 10) return n.toFixed(0) + "%";
      return n.toFixed(1) + "%";
    }

    /**
     * 只抢官方只读 composer 会抢的会话：one-shot，或父会话离线的可继续子代理。
     * @param {{ sessionId?: string, session?: object }} owner
     */
    function selectReadOnlySubagent(owner) {
      const subagent = owner.session && owner.session.subagent;
      if (subagent === undefined || subagent === null) return null;
      if (subagent.address && subagent.address.mode === "one-shot") {
        return { sessionId: owner.sessionId, reason: "one-shot" };
      }
      if (subagent.parentAvailable !== false) return null;
      if (owner.session && owner.session.running === true) return null;
      return { sessionId: owner.sessionId, reason: "parent-unavailable" };
    }

    function SubagentCtxComposer(props) {
      const sessionId = props.matched && props.matched.sessionId;
      const [data, setData] = useState(null);

      useEffect(() => {
        if (!sessionId) return undefined;
        let stopped = false;
        const tick = async () => {
          try {
            const res = await fetch(STATUS_URL + "?session=" + encodeURIComponent(sessionId), { cache: "no-store" });
            const json = res.ok ? await res.json() : null;
            if (!stopped && json && json.ok) {
              setData((prev) => {
                const ctx = Number.isFinite(json.ctx) && json.ctx > 0 ? json.ctx : (prev && prev.ctx) || 0;
                const tps = Number.isFinite(json.tps) && json.tps > 0 ? json.tps : (prev && prev.tps) || 0;
                const hit = json.hit != null ? json.hit : (prev && prev.hit);
                return { ctx: ctx, tps: tps, hit: hit, status: json.status };
              });
            }
          } catch (e) { }
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        };
        let timer = setTimeout(tick, 0);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [sessionId]);

      const ctxN = data && Number.isFinite(data.ctx) ? data.ctx : 0;
      const tpsN = data && Number.isFinite(data.tps) ? data.tps : 0;
      const hitText = data ? fmtHit(data.hit) : null;
      const kids = [
        h("strong", { key: "ctx" }, "ctx: " + fmtTok(ctxN)),
        h("span", { key: "s1", className: "scx-sep", "aria-hidden": true }, ";"),
        h("span", { key: "tps" }, "tps: " + fmtTps(tpsN)),
      ];
      if (hitText) {
        kids.push(h("span", { key: "s2", className: "scx-sep", "aria-hidden": true }, ";"));
        kids.push(h("span", { key: "hit" }, "缓存命中: " + hitText));
      }

      return h("div", {
        className: "scx-frame",
        role: "status",
        title: "ctx 按 1024；死后保留最后一次；缓存命中来自 session tokenUsage",
      }, kids);
    }

    function apply(ctx) {
      ctx.inject(["slots"], (sctx) => {
        sctx.slots.inject("conversation.composer", () => sctx.slots.register({
          name: "conversation.composer",
          priority: -20,
          select: selectReadOnlySubagent,
        }, SubagentCtxComposer));
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
