/**
 * Host cut_supervisor：按占用 cut。只走 dsh cancel/steer，不碰引擎 abort/摘槽。
 * @module commands/test-inject/cut
 */
import { currentLogPath, writeAbort, writeLog } from "./log.js"
import { userMsg } from "./llm.js"
import { applyStreamFrame, occupancy } from "./occupancy.js"

const META = "test-inject"
const POLL_MS = 1000
const THRESH_INJECT = 15000
const THRESH_STEER = 16000
const THRESH_CANCEL_INJECT = 17000
const THRESH_CANCEL_STEER = 19000
const THRESH_CANCEL = 20000

const MSG_INJECT = "[INJECT] this is a test, continue you work!"
const MSG_STEER = "[STEER] this is a test, continue you work!"
const MSG_CANCEL_INJECT = "[CANCEL_INJECT] this is a test, continue you work!"
const MSG_CANCEL_STEER = "[CANCEL_STEER] this is a test, continue you work!"

const live = new Map()

/**
 * @description 距本轮 cancel 的毫秒；未 cancel 为 -1。
 * @param {object} rec
 * @returns {number}
 */
function dtAbort(rec) {
  return rec.abortAt ? (Date.now() - rec.abortAt) : -1
}

/**
 * @description 记下 cancel 起点，供 abort.log 算 dt。
 * @param {object} rec
 * @param {string} act
 * @param {number} tok
 * @returns {void}
 */
function markAbort(rec, act, tok) {
  rec.abortAt = Date.now()
  rec.abortAct = act
  rec.abortWaiting = true
  writeAbort("CANCEL_CALL label=" + rec.label + " child=" + rec.childId + " act=" + act + " ctx=" + tok)
}

/**
 * @description 只 steer，不打断当前 generate。
 * @param {object} child
 * @param {object} rec
 * @param {string} text
 * @param {string} act
 * @param {number} tok
 * @returns {void}
 */
function steerTagged(child, rec, text, act, tok) {
  const msg = userMsg(text)
  if (!msg) {
    writeLog(rec.logPath, "ACT-FAIL " + act + " no createUserMessage")
    return
  }
  try {
    child.steer(msg)
    writeLog(rec.logPath, "ACT " + act + " tok=" + tok + " label=" + rec.label)
  } catch (e) {
    writeLog(rec.logPath, "ACT-FAIL " + act + " " + String(e))
  }
}

/**
 * @description cancel 当前 turn（保留 inbox）再 steer 下一轮。
 * @param {object} child
 * @param {object} rec
 * @param {string} text
 * @param {string} act
 * @param {number} tok
 * @param {number} thresh
 * @returns {void}
 */
function cancelThenSteer(child, rec, text, act, tok, thresh) {
  const msg = userMsg(text)
  if (!msg) {
    writeLog(rec.logPath, "ACT-FAIL " + act + " no createUserMessage")
    return
  }
  try {
    markAbort(rec, act, tok)
    const t0 = Date.now()
    child.cancel({ kind: "hook", reason: "cut_supervisor tok>=" + thresh }, { keepInbox: true })
    writeAbort("CANCEL_RET label=" + rec.label + " child=" + rec.childId + " act=" + act + " cancel_ms=" + (Date.now() - t0) + " status=" + child.status)
    child.steer(msg)
    writeAbort("STEER_OK label=" + rec.label + " child=" + rec.childId + " act=" + act + " dt_abort_ms=" + dtAbort(rec) + " status=" + child.status)
    writeLog(rec.logPath, "ACT " + act + " tok=" + tok + " label=" + rec.label)
  } catch (e) {
    writeAbort("CANCEL_FAIL label=" + rec.label + " act=" + act + " " + String(e))
    writeLog(rec.logPath, "ACT-FAIL " + act + " " + String(e))
  }
}

/**
 * @description 五档：inject → steer → cancel+inject → cancel+steer → cancel。
 * @param {object} child
 * @param {object} rec
 * @param {{ tok: number }} occ
 * @returns {void}
 */
function maybeCut(child, rec, occ) {
  const tok = occ.tok
  if (tok >= THRESH_INJECT && !rec.didInject) {
    rec.didInject = true
    steerTagged(child, rec, MSG_INJECT, "inject", tok)
  }
  if (tok >= THRESH_STEER && !rec.didSteer) {
    rec.didSteer = true
    steerTagged(child, rec, MSG_STEER, "steer", tok)
  }
  if (tok >= THRESH_CANCEL_INJECT && !rec.didCancelInject) {
    rec.didCancelInject = true
    cancelThenSteer(child, rec, MSG_CANCEL_INJECT, "cancel+inject", tok, THRESH_CANCEL_INJECT)
  }
  if (tok >= THRESH_CANCEL_STEER && !rec.didCancelSteer) {
    rec.didCancelSteer = true
    cancelThenSteer(child, rec, MSG_CANCEL_STEER, "cancel+steer", tok, THRESH_CANCEL_STEER)
  }
  if (tok >= THRESH_CANCEL && !rec.didCancel) {
    rec.didCancel = true
    try {
      markAbort(rec, "cancel", tok)
      const t0 = Date.now()
      child.cancel({ kind: "hook", reason: "cut_supervisor tok>=" + THRESH_CANCEL })
      writeAbort("CANCEL_RET label=" + rec.label + " child=" + rec.childId + " act=cancel cancel_ms=" + (Date.now() - t0) + " status=" + child.status)
      writeLog(rec.logPath, "ACT cancel tok=" + tok + " label=" + rec.label)
    } catch (e) {
      writeAbort("CANCEL_FAIL label=" + rec.label + " act=cancel " + String(e))
      writeLog(rec.logPath, "ACT-FAIL cancel " + String(e))
    }
  }
}

/**
 * @description 汇总本子 agent 触发过的 cut 档位。
 * @param {object} rec
 * @returns {string}
 */
function cutSummary(rec) {
  const parts = []
  if (rec.didInject) parts.push("inject")
  if (rec.didSteer) parts.push("steer")
  if (rec.didCancelInject) parts.push("cancel+inject")
  if (rec.didCancelSteer) parts.push("cancel+steer")
  if (rec.didCancel) parts.push("cancel")
  return parts.length ? parts.join(",") : "none"
}

/**
 * @description 登记 live 孩子并每秒采样；只跟 meta.name === test-inject。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function bindCutSupervisor(ctx) {
  ctx.on("agent/assistant-stream", function (payload) {
    const rec = live.get(payload && payload.agent && payload.agent.id)
    if (!rec) return
    const frame = payload.frame
    applyStreamFrame(rec, frame)
    if (!frame || !rec.abortWaiting) return
    if (frame.type === "end") {
      writeAbort("STREAM_END label=" + rec.label + " child=" + rec.childId + " after=" + rec.abortAct + " dt_abort_ms=" + dtAbort(rec))
    }
    if (frame.type === "start") {
      writeAbort("STREAM_START label=" + rec.label + " child=" + rec.childId + " after=" + rec.abortAct + " dt_abort_ms=" + dtAbort(rec) + " status=" + (payload.agent && payload.agent.status))
      rec.abortWaiting = false
    }
  })

  ctx.on("agent/status", function (payload) {
    const rec = live.get(payload && payload.agent && payload.agent.id)
    if (!rec || !rec.abortWaiting) return
    writeAbort("STATUS label=" + rec.label + " child=" + rec.childId + " status=" + payload.status + " after=" + rec.abortAct + " dt_abort_ms=" + dtAbort(rec))
  })

  ctx.on("workflow/start", function (info) {
    writeLog(currentLogPath(), "WF-START name=" + (info && info.meta && info.meta.name) + " id=" + (info && info.id))
  })

  ctx.on("workflow/agent-start", function (info, started) {
    const metaName = info && info.meta && info.meta.name
    const childId = started && started.childId
    const logPath = currentLogPath()
    writeLog(logPath, "START meta=" + metaName + " label=" + (started && started.label) + " phase=" + String(started && started.phase) + " childId=" + childId)
    if (metaName !== META) return
    try {
      const child = ctx.agents.get(childId)
      writeLog(logPath, "GOT agent=" + (!!child) + " status=" + (child && child.status))
      if (!child) {
        writeLog(logPath, "CTX missing agents.get(" + childId + ")")
        return
      }
      const rec = {
        logPath: logPath,
        childId: childId,
        label: started.label,
        abortAt: 0,
        abortAct: "",
        abortWaiting: false,
        didInject: false,
        didSteer: false,
        didCancelInject: false,
        didCancelSteer: false,
        didCancel: false,
        streamTok: 0,
        usageOut: 0,
        timer: null
      }
      const tick = function () {
        try {
          const occ = occupancy(ctx, child, rec)
          writeLog(rec.logPath, "CTX label=" + rec.label + " ctx=" + occ.ctx + " tps=" + occ.tps.toFixed(1))
          maybeCut(child, rec, occ)
        } catch (e) {
          writeLog(rec.logPath, "CTX-FAIL " + String(e))
        }
      }
      tick()
      rec.timer = setInterval(tick, POLL_MS)
      live.set(childId, rec)
    } catch (e) {
      writeLog(logPath, "START-FAIL " + String(e && e.stack || e))
    }
  })

  ctx.on("workflow/agent-end", function (info, ended) {
    const childId = ended && ended.childId
    const rec = live.get(childId)
    writeLog(currentLogPath(), "WF-END meta=" + (info && info.meta && info.meta.name) + " childId=" + childId + " outcome=" + (ended && ended.outcome))
    if (!rec) return
    clearInterval(rec.timer)
    live.delete(childId)
    writeLog(rec.logPath, "END label=" + rec.label + " outcome=" + ended.outcome + " cut=" + cutSummary(rec))
  })
}
