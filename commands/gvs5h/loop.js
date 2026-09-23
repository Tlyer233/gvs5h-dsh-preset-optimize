// GVS5H 冻结循环。args: { problem, ws, cwd, roleSrc, radix? }
// 停环条件和 ledger 路径归本文件。
// SSS/SES 在 radix.js；BOOTSTRAP 注入 call(n, p)。
const NL = String.fromCharCode(10)
const WS = args.ws
const CWD = args.cwd
const ROLE = args.roleSrc
const HEAD = "WS: " + WS + NL + "CWD: " + CWD + NL + NL
const opens = []

/**
 * @description 取宿主 Node process。VM 是空 context，guest 没有 require。
 * @returns {NodeJS.Process}
 */
function nodeProcess() {
  if (typeof process === "object" && process && typeof process.getBuiltinModule === "function") return process
  return Object.getPrototypeOf(agent).constructor("return process")()
}

/**
 * @description 加载 Node 内置模块。
 * @param {string} name 模块名
 * @returns {any}
 */
function nodeBuiltin(name) {
  return nodeProcess().getBuiltinModule(name)
}

/**
 * @description 读 config/config.json 的数字字段；缺失或非法用缺省。
 * @param {string} key
 * @param {number} dflt
 * @returns {number}
 */
function cfg(key, dflt) {
  try {
    const presetDir = ROLE.slice(0, ROLE.length - "/roles".length)
    const j = JSON.parse(nodeBuiltin("fs").readFileSync(presetDir + "/config/config.json", "utf8"))
    const v = j && j[key]
    if (typeof v === "number" && v >= 0) return v
  } catch (e) { }
  return dflt
}

const PLAN_ROUNDS = Math.max(1, cfg("planRounds", 8))
const REPLAN_MAX = cfg("replanMax", 2)

/** 从回复里收集 `- OPEN:` 行。 */
function harvest(t) {
  if (!t) return
  const lines = t.split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.indexOf("- OPEN:") === 0) opens.push(s)
  }
}

/** 合同文件名：去掉 #序号 和 -retry。 */
function roleFile(n) {
  return String(n).replace(/-retry$/, "").replace(/#\d+$/, "")
}

const callSeq = Object.create(null)
/** 每次 spawn 用唯一 label，侧栏才能分清 laborer#2 / try#1。 */
function liveLabel(n) {
  const k = String(n)
  callSeq[k] = (callSeq[k] || 0) + 1
  return callSeq[k] === 1 ? k : k + "#" + callSeq[k]
}

/** 角色合同前缀：首行必须是 label，dsh 用它当会话标题。 */
function role(n) {
  const file = roleFile(n)
  return n + NL
    + "You are a delegated subagent in role " + file + "." + NL
    + "First action: read " + ROLE + "/" + file + ".md ; it is your role contract; follow it exactly." + NL
    + "Never call the workflow tool. Never spawn or delegate to other subagents." + NL
    + NL
}

/**
 * @description 读宿主写入的 pressure.json；没有文件返回 null。
 * @returns {object|null}
 */
function pressureSnap() {
  try {
    return JSON.parse(nodeBuiltin("fs").readFileSync(WS + "/pressure.json", "utf8"))
  } catch (e) {
    return null
  }
}

/** 宿主压迫峰值；没有文件当 none。 */
function pressurePeak() {
  const j = pressureSnap()
  return (j && j.peak) || "none"
}

/** 给 predominant 的地面事实行。 */
function pressureLine() {
  const j = pressureSnap()
  if (!j) return "HOST PRESSURE: peak=none grade=none"
  const pct = typeof j.pct === "number" ? (j.pct * 100).toFixed(1) + "%" : "?"
  return "HOST PRESSURE: peak=" + (j.peak || "none") + " grade=" + (j.grade || "none") + " pct=" + pct
    + (j.interrupt ? " (hard abort: abnormal interrupt)" : "")
}

/**
 * @description 走注入的 call（自动 SSS/SES）；无 ### 则带 -retry 再打一次。
 * @param {string} n 角色名
 * @param {string} body 任务正文
 * @returns {Promise<string|null>}
 */
async function roleCall(n, body) {
  const label = liveLabel(n)
  const p = role(label) + body
  let x = await call(label, p)
  if (x === null || x.indexOf("### ") < 0) {
    const r = label + "-retry"
    x = await call(r, role(r) + body)
  }
  harvest(x)
  return x
}

/**
 * @description 受宿主 cut 的角色：hard 视为异常中断，禁止 -retry，残稿原样返回。
 * @param {string} n laborer_worker 或 try_worker
 * @param {string} body
 * @returns {Promise<string|null>}
 */
async function cutCall(n, body) {
  const label = liveLabel(n)
  const p = role(label) + body
  let x = await call(label, p)
  if (pressurePeak() === "hard") {
    harvest(x)
    return x
  }
  if (x === null || x.indexOf("### ") < 0) {
    const r = label + "-retry"
    x = await call(r, role(r) + body)
  }
  harvest(x)
  return x
}

/** 抽出 `### k` 段，直到下一个 `### `。 */
function sec(t, k) {
  if (!t) return ""
  const head = "### " + k
  const lines = t.split(NL)
  let i = 0
  while (i < lines.length && lines[i].trim() !== head) i++
  if (i >= lines.length) return ""
  i++
  const buf = []
  while (i < lines.length && lines[i].trim().indexOf("### ") !== 0) {
    buf.push(lines[i])
    i++
  }
  return buf.join(NL).trim()
}

/** decision STATUS 首行：done / replan / continue。 */
function statusHead(status) {
  const lines = (status || "").split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim().toLowerCase()
    if (s === "done" || s.indexOf("done ") === 0) return "done"
    if (s === "replan" || s.indexOf("replan ") === 0) return "replan"
    if (s === "continue" || s.indexOf("continue ") === 0) return "continue"
  }
  return "continue"
}

/** predominant STATUS 首行：ready / continue。 */
function planHead(status) {
  const lines = (status || "").split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim().toLowerCase()
    if (s === "ready" || s.indexOf("ready ") === 0) return "ready"
    if (s === "continue" || s.indexOf("continue ") === 0) return "continue"
  }
  return "continue"
}

/** 任务表里第一条 todo。 */
function firstTodo(tasks) {
  const lines = (tasks || "").split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.indexOf("- [todo]") === 0) return s.slice(8).trim()
    if (s.indexOf("- [ ]") === 0) return s.slice(5).trim()
  }
  return ""
}

/** TRY 段是否为空（none / 空）。 */
function noTry(t) {
  const s = (t || "").trim().toLowerCase()
  return s === "" || s === "none" || s === "- none"
}

/**
 * @description history compact 成功后清空本轮 ledger；history 保留；不碰 CWD 产物。
 * @returns {void}
 */
function wipeLedger() {
  const fs = nodeBuiltin("fs")
  const names = ["task.md", "plan.md", "tasks.json", "notes.md", "checks.md", "deliverable.md"]
  for (let i = 0; i < names.length; i++) {
    const p = WS + "/" + names[i]
    try {
      if (fs.existsSync(p)) fs.writeFileSync(p, "") // 截断；缺文件不创建
    } catch (e) {
      log("ledger wipe failed: " + names[i] + " " + String(e))
    }
  }
}

/**
 * @description 删探针产物：try_scripts/、probes.json、pressure.json。起点和终点都跑，保证幂等。
 * @returns {void}
 */
function wipeProbe() {
  const fs = nodeBuiltin("fs")
  const targets = ["try_scripts", "probes.json", "pressure.json"]
  for (let i = 0; i < targets.length; i++) {
    try {
      fs.rmSync(WS + "/" + targets[i], { recursive: true, force: true })
    } catch (e) {
      log("probe wipe failed: " + targets[i] + " " + String(e))
    }
  }
}

let planCalls = 0
let tryCalls = 0

/**
 * @description predominant ↔ try_worker 接地环；ready、TRY 缺失、TRY 重复或到上限即返回。
 * @param {string} seed LAST TRY 或 REPLAN 正文
 * @returns {Promise<string|null>} 最后一份 predominant 回复
 */
async function planRing(seed) {
  let p = null
  let feed = seed
  let prevTry = null
  for (let i = 1; i <= PLAN_ROUNDS; i++) {
    const final = i === PLAN_ROUNDS
    planCalls++
    p = await roleCall("predominant_manager", HEAD
      + "HISTORY: if " + WS + "/history exists, read it and decide MODE." + NL
      + "PLAN ROUND " + i + "/" + PLAN_ROUNDS + NL
      + (final ? "FINAL ROUND: return STATUS ready with the best grounded PLAN; list every unresolved unknown as - OPEN in TASKS." + NL : "")
      + NL + "PROBLEM:" + NL + args.problem + NL + NL + feed)
    if (!p) return p
    if (planHead(sec(p, "STATUS")) === "ready") return p
    const t = sec(p, "TRY")
    if (noTry(t)) return p
    if (prevTry !== null && t.trim() === prevTry.trim()) {
      log("plan ring: identical TRY twice, leaving plan ring")
      return p
    }
    prevTry = t
    tryCalls++
    const r = await cutCall("try_worker", HEAD + "YOUR TRY:" + NL + t)
    feed = "LAST TRY:" + NL + pressureLine() + NL + (r || "(abnormal interrupt; no wrap)")
  }
  return p
}

phase("plan")
wipeProbe()
let p = await planRing("LAST TRY: (none)")
let PLAN = sec(p, "PLAN")
let last = p || "(planner unavailable)"

phase("solve")
let prev = null
let rounds = 0
let replans = 0
let outcome = null
for (; ;) {
  rounds++
  const d = await roleCall("decision_manager", HEAD
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "PLAN:" + NL + PLAN + NL + NL
    + "REPLAN BUDGET LEFT: " + Math.max(0, REPLAN_MAX - replans) + NL + NL
    + "LATEST WORKER RESULT:" + NL + last)
  if (!d) {
    outcome = { done: false, rounds: rounds, reason: "decision unavailable" }
    break
  }
  const STATUS = sec(d, "STATUS")
  let NEXT = sec(d, "NEXT")
  const TASKS = sec(d, "TASKS")
  const head = statusHead(STATUS)
  if (head === "done") {
    outcome = { done: true, rounds: rounds, reason: "manager done" }
    break
  }
  if (head === "replan") {
    if (replans >= REPLAN_MAX) {
      outcome = { done: false, rounds: rounds, reason: "replan budget exhausted" }
      break
    }
    replans++
    phase("replan")
    p = await planRing("REPLAN FROM DECISION:" + NL + (sec(d, "REPLAN") || STATUS))
    PLAN = sec(p, "PLAN") || PLAN
    last = p || last
    prev = null
    phase("solve")
    continue
  }
  if (!NEXT) NEXT = firstTodo(TASKS) || "Implement the most promising approach from notes.md under CWD (project root), never under .fable."
  if (prev !== null && NEXT.trim().toLowerCase() === prev.trim().toLowerCase()) {
    outcome = { done: false, rounds: rounds, reason: "no progress" }
    break
  }
  prev = NEXT
  const w = await cutCall("laborer_worker", HEAD
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "PLAN:" + NL + PLAN + NL + NL
    + "YOUR TASK: " + NEXT)
  last = await roleCall("check_worker", HEAD
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "TASK: " + NEXT + NL + NL
    + "LATEST LABOR (may be truncated if the host hard-aborted):" + NL + (w || "(abnormal interrupt; no wrap)") + NL + NL
    + "HOST PRESSURE is ground truth (injected message and/or WS/pressure.json). Do not let the laborer self-report override it." + NL
    + "If peak=hard the laborer was abnormally interrupted: inventory leftover CWD/WS edits in INTERRUPT; FEEDBACK is for decision_manager." + NL
    + "If the work is a batch, report per-item counts and failure classes in the first EVIDENCE bullet." + NL
    + "Your full reply (CHECKS + PRESSURE + INTERRUPT + FEEDBACK) is the next manager brief. Do not spawn anyone.")
}

outcome.replans = replans
outcome.planCalls = planCalls
outcome.tryCalls = tryCalls

phase("wrap")
const hist = await roleCall("history_worker", HEAD
  + "DIGEST SHAPE: read " + ROLE + "/adhd.md in full and follow every rule in it. Do not shorten it." + NL + NL
  + "ROUND OUTCOME:" + NL + JSON.stringify(outcome) + NL + NL
  + "LAST LABOR:" + NL + (last || "(none)"))

outcome.digest = sec(hist, "DIGEST") || hist
outcome.promoted = sec(hist, "PROMOTE") || "none"
if (sec(hist, "DIGEST")) {
  wipeLedger() // compact 落地才清空 ledger
  wipeProbe()
} else log("ledger wipe skipped: history digest missing")
const uniq = []
for (let i = 0; i < opens.length; i++) {
  if (uniq.indexOf(opens[i]) < 0) uniq.push(opens[i])
}
outcome.open = uniq
return outcome
