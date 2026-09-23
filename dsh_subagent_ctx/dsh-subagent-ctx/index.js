/**
 * dsh-subagent-ctx — 宿主半边。
 * 跟踪每个 live agent 的流式 think/输出，按 occupancy.js 口径算 ctx + tps。
 * 结束后冻结最后一次快照，不删。
 * GET /ext/dsh-subagent-ctx/status?session=<id>
 */

export const name = "dsh-subagent-ctx"
export const inject = ["agents"]

const STATUS_PATH = "/ext/dsh-subagent-ctx/status"
const CHARS_PER_TOKEN = 4
const recs = new Map()

/**
 * @description CJK ≈ 1 token，拉丁 ≈ 1/4。
 * @param {string} text
 * @returns {number}
 */
function streamTokOf(text) {
  let n = 0
  if (!text) return 0
  for (let i = 0; i < text.length; i++) n += text.charCodeAt(i) > 255 ? 1 : 1 / CHARS_PER_TOKEN
  return n
}

/**
 * @description cacheRead / (uncached + cacheRead + cacheWrite)，没有输入则 null。
 * @param {object} usage
 * @returns {number | null} 0–100
 */
function hitOfUsage(usage) {
  if (!usage) return null
  const read = Number(usage.cacheReadTokens) || 0
  const uncached = Number(usage.uncachedInputTokens != null ? usage.uncachedInputTokens : usage.inputTokens) || 0
  const write = Number(usage.cacheWriteTokens) || 0
  const billed = uncached + read + write
  if (billed <= 0) return null
  return (read * 100) / billed
}

/**
 * @description 把一帧 assistant-stream 累到 rec。end 不在这里清 inflight（先由 freeze）。
 * @param {object} rec
 * @param {object} frame
 * @returns {void}
 */
function applyStreamFrame(rec, frame) {
  if (!frame) return
  if (frame.type === "start") {
    rec.streamTok = 0
    rec.usageOut = 0
    return
  }
  if (frame.type === "end") return
  if (frame.type !== "chunk" || !frame.chunk) return
  const c = frame.chunk
  if (c.type === "reasoning-delta" || c.type === "text-delta") rec.streamTok += streamTokOf(c.text)
  else if (c.type === "tool-call-delta") rec.streamTok += streamTokOf(c.argumentsDelta)
  else if (c.type === "usage" && c.usage) {
    rec.usageOut = c.usage.outputTokens || c.usage.reasoningTokens || 0
    const h = hitOfUsage(c.usage)
    if (h != null) rec.hitCall = h
  }
}

/**
 * @description 取或建 rec。last* 是死后仍展示的冻结值。
 * @param {string} id
 * @returns {object}
 */
function recOf(id) {
  let rec = recs.get(id)
  if (!rec) {
    rec = { streamTok: 0, usageOut: 0, hitCall: null, lastCtx: 0, lastTps: 0, lastHit: null, frozen: false }
    recs.set(id, rec)
  }
  return rec
}

/**
 * @description 落盘上下文 + sessionStats 平均 tps + tokenUsage 缓存命中。
 * @param {object} hostCtx
 * @param {object} child
 * @returns {{ settled: number, tps: number, hit: number | null }}
 */
function dshSnap(hostCtx, child) {
  const out = { settled: 0, tps: 0, hit: null }
  const worlds = []
  if (child && child.ctx) worlds.push(child.ctx)
  if (hostCtx) worlds.push(hostCtx)
  for (let w = 0; w < worlds.length; w++) {
    const ctx = worlds[w]
    try {
      const sp = ctx.reflect && ctx.reflect.get("sessionProjections", false)
      const snap = sp && child.session && sp.snapshot(child.session)
      const values = snap && snap.values
      const p = values && values.contextPressure
      const br = values && values.contextBreakdown
      const st = values && values.sessionStats
      const tu = values && values.tokenUsage
      if (p && typeof p.projectedTokens === "number" && p.projectedTokens > 0) out.settled = p.projectedTokens
      else if (p && typeof p.pressureTokens === "number" && p.pressureTokens > 0) out.settled = p.pressureTokens
      else if (br) {
        const n = (br.systemTokens || 0) + (br.toolsTokens || 0) + (br.messageTokens || 0)
        if (n > 0) out.settled = n
      }
      if (st && st.decodeMs > 0) out.tps = st.decodeTokens / (st.decodeMs / 1000)
      const h = hitOfUsage(tu)
      if (h != null) out.hit = h
    } catch (e) { }
    if (!out.settled) {
      try {
        const tm = ctx.reflect && ctx.reflect.get("tokenMeter", false)
        const m = tm && child.session && tm.measure(child.session)
        if (m && typeof m.totalTokens === "number" && m.totalTokens > 0) out.settled = m.totalTokens
        if (out.hit == null && m) {
          const h = hitOfUsage(m)
          if (h != null) out.hit = h
        }
      } catch (e) { }
    }
    if (out.settled) break
  }
  return out
}

/**
 * @description ctx = 落盘 + 在飞 think/输出；tps = session 平均。
 * @param {object} hostCtx
 * @param {object} child
 * @param {object} rec
 * @returns {{ ctx: number, tps: number, hit: number | null }}
 */
function occupancy(hostCtx, child, rec) {
  const snap = dshSnap(hostCtx, child)
  const heur = rec && rec.streamTok ? Math.ceil(rec.streamTok) : 0
  const usage = rec && rec.usageOut ? rec.usageOut : 0
  const inflight = usage > heur ? usage : heur
  const hit = snap.hit != null ? snap.hit : (rec && rec.hitCall != null ? rec.hitCall : null)
  return { ctx: snap.settled + inflight, tps: snap.tps, hit: hit }
}

/**
 * @description 写入 last*，死后继续用。
 * @param {object} rec
 * @param {{ ctx: number, tps: number, hit: number | null }} occ
 * @returns {void}
 */
function remember(rec, occ) {
  if (!occ) return
  if (occ.ctx > 0) rec.lastCtx = occ.ctx
  if (occ.tps > 0) rec.lastTps = occ.tps
  if (occ.hit != null) rec.lastHit = occ.hit
}

/**
 * @param {object} ctx
 * @param {object} child
 * @param {object} rec
 * @returns {void}
 */
function freeze(ctx, child, rec) {
  try {
    remember(rec, occupancy(ctx, child, rec))
  } catch (e) { }
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {object}
 */
function measure(ctx, sessionId) {
  const child = ctx.agents && ctx.agents.get(sessionId)
  const rec = recOf(sessionId)
  if (!child || rec.frozen) {
    return {
      ok: true,
      session: sessionId,
      ctx: rec.lastCtx || 0,
      tps: rec.lastTps || 0,
      hit: rec.lastHit,
      running: false,
      status: rec.frozen ? "ended" : "gone"
    }
  }
  const occ = occupancy(ctx, child, rec)
  remember(rec, occ)
  return {
    ok: true,
    session: sessionId,
    ctx: occ.ctx,
    tps: occ.tps,
    hit: occ.hit,
    running: child.status === "running",
    status: String(child.status || "")
  }
}

/**
 * @param {object} ctx
 * @returns {void}
 */
export function apply(ctx) {
  ctx.on("agent/assistant-stream", function (payload) {
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (!id) return
    const rec = recOf(id)
    const frame = payload.frame
    if (frame && frame.type === "end") freeze(ctx, agent, rec)
    applyStreamFrame(rec, frame)
    if (frame && frame.type === "end") {
      rec.streamTok = 0
      rec.usageOut = 0
    }
  })
  ctx.on("agent/disposed", function (payload) {
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (!id) return
    const rec = recOf(id)
    freeze(ctx, agent, rec)
    rec.frozen = true
  })

  ctx.inject(["webServer"], function (wctx) {
    if (!wctx.webServer || typeof wctx.webServer.register !== "function") return
    wctx.effect(function () {
      const send = function (res, code, obj) {
        const payload = JSON.stringify(obj)
        res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
        res.end(payload)
      }
      const dispose = wctx.webServer.register({
        kind: "exact",
        path: STATUS_PATH,
        handler: function (req, res) {
          try {
            const session = new URL(req.url || "/", "http://x").searchParams.get("session") || ""
            if (!session) {
              send(res, 200, { ok: false, error: "missing session", ctx: 0, tps: 0, hit: null, running: false })
              return
            }
            send(res, 200, measure(ctx, session))
          } catch (error) {
            send(res, 200, { ok: false, error: String(error && error.message ? error.message : error), ctx: 0, tps: 0, hit: null, running: false })
          }
        }
      })
      return dispose
    }, "dsh-subagent-ctx: status")
  })
}
