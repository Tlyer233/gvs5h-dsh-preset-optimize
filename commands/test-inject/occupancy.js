/**
 * 子 agent 占用：落盘投影 + 当前 think/输出。cut 用 ctx；tps 用 dsh sessionStats 平均。
 * @module commands/test-inject/occupancy
 */

const CHARS_PER_TOKEN = 4 // 拉丁启发式；CJK 按 1 字 ≈ 1 token

/**
 * @description Heuristic tokens for one streamed fragment (CJK ≈ 1, latin ≈ 1/4).
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
 * @description Apply one assistant-stream frame onto rec (usage / heur).
 * @param {object} rec
 * @param {object} frame
 * @returns {void}
 */
export function applyStreamFrame(rec, frame) {
  if (!frame) return
  if (frame.type === "start" || frame.type === "end") {
    rec.streamTok = 0
    rec.usageOut = 0
    return
  }
  if (frame.type !== "chunk" || !frame.chunk) return
  const c = frame.chunk
  if (c.type === "reasoning-delta" || c.type === "text-delta") rec.streamTok += streamTokOf(c.text)
  else if (c.type === "tool-call-delta") rec.streamTok += streamTokOf(c.argumentsDelta)
  else if (c.type === "usage" && c.usage) rec.usageOut = c.usage.outputTokens || c.usage.reasoningTokens || 0
}

/**
 * @description 落盘上下文 + dsh 平均 tps（decodeTokens / decodeMs）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} child
 * @returns {{ settled: number, tps: number }}
 */
function dshSnap(ctx, child) {
  const out = { settled: 0, tps: 0 }
  try {
    const sp = ctx.reflect && ctx.reflect.get("sessionProjections", false)
    const snap = sp && child.session && sp.snapshot(child.session)
    const values = snap && snap.values
    const p = values && values.contextPressure
    const br = values && values.contextBreakdown
    const st = values && values.sessionStats
    if (p && typeof p.projectedTokens === "number" && p.projectedTokens > 0) out.settled = p.projectedTokens
    else if (p && typeof p.pressureTokens === "number" && p.pressureTokens > 0) out.settled = p.pressureTokens
    else if (br) {
      const n = (br.systemTokens || 0) + (br.toolsTokens || 0) + (br.messageTokens || 0)
      if (n > 0) out.settled = n
    }
    if (st && st.decodeMs > 0) out.tps = st.decodeTokens / (st.decodeMs / 1000)
  } catch (e) { }
  if (!out.settled) {
    try {
      const tm = ctx.reflect && ctx.reflect.get("tokenMeter", false)
      const m = tm && child.session && tm.measure(child.session)
      if (m && typeof m.totalTokens === "number" && m.totalTokens > 0) out.settled = m.totalTokens
    } catch (e) { }
  }
  return out
}

/**
 * @description Snapshot occupancy: ctx = settled + in-flight think; tps = dsh session average.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} child
 * @param {object} rec
 * @returns {{ ctx: number, tok: number, tps: number }}
 */
export function occupancy(ctx, child, rec) {
  const snap = dshSnap(ctx, child)
  const heur = rec && rec.streamTok ? Math.ceil(rec.streamTok) : 0
  const usage = rec && rec.usageOut ? rec.usageOut : 0
  const inflight = usage > heur ? usage : heur
  const ctxTok = snap.settled + inflight
  return { ctx: ctxTok, tok: ctxTok, tps: snap.tps }
}
