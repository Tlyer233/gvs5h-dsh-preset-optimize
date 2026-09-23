/**
 * gvs-solve laborer 监督：结构抄 test-inject/cut.js（stream + 1s occupancy + steer/cancel）。
 * 阈值仍是 config 里相对 contextWindow 的比例。
 * @module commands/gvs5h/pressure
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyStreamFrame, occupancy as occTok } from "../test-inject/occupancy.js"
import { cancelChild, cancelThenSteer, steerChild } from "./cut.js"
import { ensureCreateUserMessage } from "./llm.js"

const META = "gvs-solve"
const POLL_MS = 1000
const DIR = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(DIR, "..", "..", "config", "config.json")
const HOST_LOG = join(DIR, "pressure.log")
const live = new Map()
const lastByWf = new Map()

const MSG = {
  laborer: {
    soft: "[HOST PRESSURE] light\nContext crossed the first threshold. Park a short NOTES dump if you can; you may keep working.\nDo not invent a pressure grade. Host owns the grade.",
    firm: "[HOST PRESSURE] moderate\nYou MUST wrap this turn now: required sections, NOTES, deliverable pointer.\nThe next threshold will abort you with no wrap. Do not invent a pressure grade."
  },
  try: {
    soft: "[HOST PRESSURE] light\nContext crossed the first threshold. Write down what you already established; you may keep probing.\nDo not invent a pressure grade. Host owns the grade.",
    firm: "[HOST PRESSURE] moderate\nStop probing now and reply with ### RESULT / ### ARTIFACTS / ### NEXT. Name the smaller probe in NEXT.\nThe next threshold will abort you with no reply. Do not invent a pressure grade."
  }
}

/**
 * @returns {{ soft: number, firm: number, hard: number }}
 */
function loadThresh() {
  const out = { soft: 0.5, firm: 0.6, hard: 0.7 }
  try {
    const j = JSON.parse(readFileSync(CONFIG, "utf8"))
    const p = j && j.pressure
    if (!p) return out
    if (typeof p.soft === "number") out.soft = p.soft
    if (typeof p.firm === "number") out.firm = p.firm
    if (typeof p.hard === "number") out.hard = p.hard
  } catch (e) { }
  return out
}

/**
 * @param {string} line
 * @returns {void}
 */
function writeLog(line) {
  const row = new Date().toISOString() + " " + line + "\n"
  try { appendFileSync(HOST_LOG, row) } catch (e) { }
}

/**
 * @param {object} child
 * @returns {string}
 */
function sessionIdOf(child) {
  const s = child && child.session
  if (!s) return ""
  return s.id || s.sessionId || ""
}

/**
 * 只量这个 child 自己的 session。plugin 是单例，严禁落到 parent / 上一个 sibling。
 * @param {object} ctx
 * @param {object} child
 * @returns {object|null}
 */
function worldOf(ctx, child) {
  if (child && child.ctx) return child.ctx
  return ctx
}

/**
 * @param {object} ctx
 * @param {object} child
 * @returns {number}
 */
function contextWindow(ctx, child) {
  try {
    const sp = ctx.reflect && ctx.reflect.get("sessionProjections", false)
    const snap = sp && child.session && sp.snapshot(child.session)
    const p = snap && snap.values && snap.values.contextPressure
    if (p && typeof p.contextWindow === "number" && p.contextWindow > 0) return p.contextWindow
  } catch (e) { }
  return 0
}

/**
 * @param {object} ctx
 * @param {object} child
 * @param {object} rec
 * @returns {{ tok: number, ctx: number, window: number, pct: number, tps: number }}
 */
function occupancy(ctx, child, rec) {
  const sid = sessionIdOf(child)
  if (sid && rec.childId && sid !== rec.childId) {
    writeLog("SKIP mixed-session label=" + rec.label + " childId=" + rec.childId + " sess=" + sid)
    return { tok: 0, ctx: 0, window: 0, pct: 0, tps: 0 }
  }
  let world = worldOf(ctx, child)
  let o = occTok(world, child, rec)
  let window = contextWindow(world, child)
  if (!(o.tok > 0) && !(window > 0) && world !== ctx) {
    o = occTok(ctx, child, rec)
    window = contextWindow(ctx, child)
  }
  const tok = o.tok
  const pct = window > 0 ? tok / window : 0
  return { tok: tok, ctx: o.ctx, window: window, pct: pct, tps: o.tps }
}

/**
 * @description 受三档 cut 的角色：laborer / try。其余角色不 cut。
 * @param {string} label
 * @returns {"laborer"|"try"|null}
 */
function cutKind(label) {
  if (typeof label !== "string") return null
  if (label.indexOf("laborer_worker") === 0) return "laborer"
  if (label.indexOf("try_worker") === 0) return "try"
  return null
}

function isCheck(label) {
  return typeof label === "string" && label.indexOf("check_worker") === 0
}

function dropRec(childId) {
  const rec = live.get(childId)
  if (!rec) return
  if (rec.timer) clearInterval(rec.timer)
  rec.timer = null
  live.delete(childId)
}

function sweepLive() {
  for (const id of Array.from(live.keys())) dropRec(id)
}

function pressurePath(child) {
  const cwd = (child && child.cwd)
    || (child && child.session && (child.session.cwd || child.session.workingDirectory))
  if (!cwd) return null
  return join(cwd, ".fable", "pressure.json")
}

function writePressure(snap, path) {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(snap, null, 2))
  } catch (e) { }
}

function gradeOf(peak) {
  if (peak === "hard") return "severe"
  if (peak === "firm") return "moderate"
  if (peak === "soft") return "light"
  return "none"
}

function needsCheckInject(snap) {
  if (!snap) return false
  if (snap.interrupt) return true
  const g = snap.grade || "none"
  const p = snap.peak || "none"
  return g !== "none" && p !== "none"
}

function recordPeak(rec, peak, occ) {
  rec.peak = peak
  rec.events.push(peak)
  rec.pct = occ.pct
  rec.ctx = occ.tok
  rec.window = occ.window
  const snap = {
    childId: rec.childId,
    label: rec.label,
    peak: rec.peak,
    grade: gradeOf(rec.peak),
    pct: rec.pct,
    ctx: rec.ctx,
    window: rec.window,
    events: rec.events.slice(),
    interrupt: rec.peak === "hard"
  }
  writePressure(snap, rec.path)
  lastByWf.set(rec.wfId, snap)
}

function injectCheck(child, snap) {
  const g = (snap && snap.grade) || "none"
  const pct = snap && Number.isFinite(snap.pct) ? (snap.pct * 100).toFixed(1) + "%" : "?"
  const lines = [
    "[HOST PRESSURE] ground truth. Ignore any laborer self-report.",
    "grade=" + g + " peak=" + ((snap && snap.peak) || "none") + " pct=" + pct
    + " ctx=" + ((snap && snap.ctx) || 0) + " window=" + ((snap && snap.window) || 0)
  ]
  if (snap && snap.interrupt) {
    lines.push("Laborer was hard-aborted (abnormal interrupt). Fill INTERRUPT with leftover CWD/WS edits. FEEDBACK goes to the manager.")
  } else {
    lines.push("No hard abort. INTERRUPT: none. Write FEEDBACK for the manager from this grade.")
  }
  steerChild(child, lines.join("\n"))
}

/**
 * 抄 test-inject maybeCut：用 tok 比阈值。soft 只 steer（能看见注入），firm cancel+steer，hard cancel。
 * @param {object} child
 * @param {object} rec
 * @param {{ tok: number, window: number, pct: number }} occ
 * @returns {void}
 */
function maybeCut(child, rec, occ) {
  const tok = occ.tok
  const win = occ.window
  if (!(win > 0) || !(tok > 0)) return
  if (!rec.armed) {
    rec.baseTok = tok
    rec.armed = true
    writeLog("BASE label=" + rec.label + " childId=" + rec.childId + " base=" + tok + " window=" + win)
    return
  }
  if (tok <= rec.baseTok + 512) return
  const tSoft = win * rec.thresh.soft
  const tFirm = win * rec.thresh.firm
  const tHard = win * rec.thresh.hard
  if (tok >= tHard && rec.peak !== "hard") {
    recordPeak(rec, "hard", occ)
    writeLog("ACT hard label=" + rec.label + " tok=" + tok + " t=" + tHard)
    cancelChild(child, "gvs5h pressure hard tok>=" + tHard)
    return
  }
  if (tok >= tFirm && rec.peak !== "firm" && rec.peak !== "hard") {
    recordPeak(rec, "firm", occ)
    writeLog("ACT firm label=" + rec.label + " tok=" + tok + " t=" + tFirm)
    cancelThenSteer(child, MSG[rec.kind].firm, "gvs5h pressure firm tok>=" + tFirm)
    return
  }
  if (tok >= tSoft && !rec.peak) {
    recordPeak(rec, "soft", occ)
    writeLog("ACT soft label=" + rec.label + " tok=" + tok + " t=" + tSoft)
    steerChild(child, MSG[rec.kind].soft)
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function bindLaborerPressure(ctx) {
  const thresh = loadThresh()
  writeLog("BIND thresh=" + JSON.stringify(thresh))
  ensureCreateUserMessage().catch(function () { })

  ctx.on("agent/assistant-stream", function (payload) {
    const rec = live.get(payload && payload.agent && payload.agent.id)
    if (!rec) return
    applyStreamFrame(rec, payload.frame)
  })

  ctx.on("workflow/start", function (info) {
    sweepLive()
    lastByWf.delete((info && info.id) || "gvs")
    writeLog("WF-START name=" + (info && info.meta && info.meta.name) + " id=" + (info && info.id))
  })

  ctx.on("workflow/agent-start", function (info, started) {
    const metaName = info && info.meta && info.meta.name
    if (metaName !== META) return
    const childId = started && started.childId
    const label = started && started.label
    try {
      const child = ctx.agents.get(childId)
      if (!child) {
        writeLog("MISS agents.get(" + childId + ") label=" + label)
        return
      }
      const wfId = (info && info.id) || "gvs"
      if (isCheck(label)) {
        const snap = lastByWf.get(wfId)
        if (!needsCheckInject(snap)) {
          writeLog("CHECK skip label=" + label + " grade=" + ((snap && snap.grade) || "none"))
          return
        }
        writeLog("CHECK inject label=" + label + " from=" + snap.label + " grade=" + snap.grade + " peak=" + snap.peak)
        try { injectCheck(child, snap) } catch (e) {
          writeLog("CHECK fail " + String(e))
        }
        return
      }
      const kind = cutKind(label)
      if (!kind) return
      dropRec(childId)
      const rec = {
        childId: childId,
        label: label,
        kind: kind,
        wfId: wfId,
        path: pressurePath(child),
        thresh: thresh,
        peak: "",
        events: [],
        pct: 0,
        ctx: 0,
        window: 0,
        streamTok: 0,
        usageOut: 0,
        baseTok: 0,
        armed: false,
        timer: null
      }
      const empty = {
        childId: childId,
        label: label,
        peak: "none",
        grade: "none",
        pct: 0,
        ctx: 0,
        window: 0,
        events: [],
        interrupt: false
      }
      writePressure(empty, rec.path)
      lastByWf.set(wfId, empty)
      live.set(childId, rec)
      writeLog("WATCH label=" + label + " childId=" + childId + " kind=" + kind)
      const tick = function () {
        if (live.get(childId) !== rec) return
        try {
          const occ = occupancy(ctx, child, rec)
          maybeCut(child, rec, occ)
        } catch (e) {
          writeLog("TICK-FAIL " + String(e && e.stack || e))
        }
      }
      tick()
      rec.timer = setInterval(tick, POLL_MS)
    } catch (e) {
      writeLog("START-FAIL " + String(e && e.stack || e))
    }
  })

  ctx.on("workflow/agent-end", function (info, ended) {
    const childId = ended && ended.childId
    const rec = live.get(childId)
    if (!rec) return
    dropRec(childId)
    const snap = {
      childId: rec.childId,
      label: rec.label,
      peak: rec.peak || "none",
      grade: gradeOf(rec.peak),
      pct: rec.pct,
      ctx: rec.ctx,
      window: rec.window,
      events: rec.events.slice(),
      interrupt: rec.peak === "hard"
    }
    writePressure(snap, rec.path)
    lastByWf.set(rec.wfId, snap)
    writeLog("END label=" + rec.label + " peak=" + snap.peak + " grade=" + snap.grade + " outcome=" + (ended && ended.outcome) + " base=" + rec.baseTok)
  })
}
