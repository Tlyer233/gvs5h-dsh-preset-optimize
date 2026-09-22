// GVS5H frozen loop. args: { problem, ws, cwd, roleSrc, maxRounds, radix? }
// Stop conditions, ledger paths, and SGLang SSS/SES are owned HERE.
// oneShot POSTs /sss and /ses only when radix is on (see radixEnabled).
const NL = String.fromCharCode(10)
const WS = args.ws
const CWD = args.cwd
const ROLE = args.roleSrc
const MAX = args.maxRounds || 10
const RADIX_HOST = "100.85.98.34"
const RADIX_PORT = 8000
const opens = []

/**
 * @description Node process from the workflow VM. runtime.ts does vm.createContext({})
 * and injects host-realm agent; getPrototypeOf(agent).constructor is the host Function.
 * Guest PTC is ESM so require is undefined; use process.getBuiltinModule.
 * @returns {NodeJS.Process}
 */
function nodeProcess() {
  if (typeof process === "object" && process && typeof process.getBuiltinModule === "function") return process
  return Object.getPrototypeOf(agent).constructor("return process")()
}

/**
 * @description Load a Node builtin without require/import.
 * @param {string} name module id, e.g. fs or http
 * @returns {any}
 */
function nodeBuiltin(name) {
  return nodeProcess().getBuiltinModule(name)
}

/**
 * @description Sleep using the timers builtin.
 * @param {number} ms delay
 * @returns {Promise<void>}
 */
function sleep(ms) {
  const t = nodeBuiltin("timers").setTimeout
  return new Promise(function (ok) { t(ok, ms) })
}

/**
 * @description Narrate via log() and append one line to the workspace radix log.
 * @param {string} line message
 * @returns {void}
 */
function appendRadix(line) {
  log(line)
  try {
    const fs = nodeBuiltin("fs")
    try { fs.mkdirSync(WS, { recursive: true }) } catch (e) {}
    fs.appendFileSync(WS + "/radix.log", line + NL)
  } catch (e) {
    log("radix.log write failed: " + String(e))
  }
}

/**
 * @description Engine success is HTTP 2xx and JSON success=true.
 * @param {string} text response body
 * @returns {boolean}
 */
function radixOk(text) {
  try {
    const j = JSON.parse(text)
    return j && j.success === true
  } catch (e) {
    return false
  }
}

/**
 * @description POST /sss or /ses through Node http, not vm fetch.
 * @param {string} name sss or ses
 * @returns {Promise<{status: number, text: string}>}
 */
function radixPost(name) {
  const http = nodeBuiltin("http")
  return new Promise(function (ok, bad) {
    const r = http.request({
      host: RADIX_HOST,
      port: RADIX_PORT,
      path: "/" + name,
      method: "POST"
    }, function (res) {
      let b = ""
      res.on("data", function (c) { b += c })
      res.on("end", function () {
        ok({ status: res.statusCode, text: b })
      })
    })
    r.on("error", function (e) { bad(e) })
    r.end()
  })
}

/**
 * @description Retry until 2xx+success. Busy or in-flight SES returns failure; wait and POST again.
 * @param {string} name sss or ses
 * @param {string} label subagent label
 * @returns {Promise<string>} response body
 */
async function radix(name, label) {
  let last = ""
  for (let i = 0; i < 40; i++) {
    try {
      const r = await radixPost(name)
      last = r.text
      if (r.status >= 200 && r.status < 300 && radixOk(last)) {
        appendRadix(name + " " + label + " " + last)
        return last
      }
      appendRadix(name + " " + label + " retry status=" + String(r.status) + " " + last)
    } catch (e) {
      last = String(e)
      appendRadix(name + " " + label + " error " + last)
    }
    await sleep(500)
  }
  throw new Error("radix " + name + " " + label + " failed: " + last)
}

/**
 * @description Whether this run should POST /sss and /ses.
 * Order: args.radix, env FABLE_RADIX, file <preset>/radix.enabled, default on.
 * @returns {boolean}
 */
function radixEnabled() {
  const v = args && args.radix // workflow arg override
  if (v === false || v === 0 || v === "0" || v === "off" || v === "false") return false // explicit off
  if (v === true || v === 1 || v === "1" || v === "on" || v === "true") return true // explicit on
  try {
    const env = nodeProcess().env && nodeProcess().env.FABLE_RADIX // process env
    if (env !== undefined && String(env).trim() !== "") {
      const e = String(env).trim().toLowerCase() // normalize
      if (e === "off" || e === "0" || e === "false") return false // env off
      if (e === "on" || e === "1" || e === "true") return true // env on
    }
  } catch (e) {}
  try {
    const fs = nodeBuiltin("fs") // disk flag beside this preset
    const presetDir = ROLE.slice(0, ROLE.length - "/roles".length) // .../fable-optimize-sglang
    const raw = fs.readFileSync(presetDir + "/radix.enabled", "utf8").trim().toLowerCase() // on|off
    if (raw === "off" || raw === "0" || raw === "false") return false // file off
    if (raw === "on" || raw === "1" || raw === "true") return true // file on
  } catch (e) {}
  return true // this preset defaults to SGLang radix on
}

/**
 * @description One subagent with SSS before and SES after when radix is on. SES runs even if agent throws.
 * @param {string} n label
 * @param {string} p prompt
 * @returns {Promise<string|null>}
 */
async function oneShot(n, p) {
  const on = radixEnabled() // snapshot once per subagent
  if (on) await radix("sss", n) // bookmark + lock
  else appendRadix("sss " + n + " skipped (radix off)") // so radix.log still explains the skip
  let x = null
  try {
    x = await agent(p, { label: n })
  } finally {
    if (on) await radix("ses", n) // cut unique branch
    else appendRadix("ses " + n + " skipped (radix off)")
  }
  return x
}

function harvest(t) {
  if (!t) return
  const lines = t.split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.indexOf("- OPEN:") === 0) opens.push(s)
  }
}

function cap(s, n) {
  if (!s) return ""
  if (s.length <= n) return s
  return s.slice(0, n) + NL + "...[truncated]..."
}

function snippet(t) {
  if (!t) return ""
  if (t.length <= 9000) return t
  return t.slice(0, 3500) + NL + "...[middle omitted]..." + NL + t.slice(t.length - 5500)
}

function role(n) {
  return "You are a delegated subagent in role " + n + "." + NL
    + "First action: read " + ROLE + "/" + n + ".md ; it is your role contract; follow it exactly." + NL
    + "Never call the workflow tool. Never spawn or delegate to other subagents." + NL
    + NL
}

async function call(n, body) {
  const p = role(n) + body
  let x = await oneShot(n, p)
  if (x === null || x.indexOf("### ") < 0) x = await oneShot(n + "-retry", p)
  harvest(x)
  return x
}

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

function statusHead(status) {
  const lines = (status || "").split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim().toLowerCase()
    if (s === "done" || s.indexOf("done ") === 0) return "done"
    if (s === "continue" || s.indexOf("continue ") === 0) return "continue"
  }
  return "continue"
}

function firstTodo(tasks) {
  const lines = (tasks || "").split(NL)
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.indexOf("- [todo]") === 0) return s.slice(8).trim()
    if (s.indexOf("- [ ]") === 0) return s.slice(5).trim()
  }
  return ""
}

function checksBad(text) {
  const line = (sec(text, "CHECKS") || "").split(NL)[0].trim().toUpperCase()
  return line.indexOf("FAILED") === 0 || line.indexOf("NONE") === 0 || line === ""
}

/**
 * @description Empty this round's ledger after history compact succeeds. history is kept. CWD deliverables are not touched.
 * @returns {void}
 */
function wipeLedger() {
  const fs = nodeBuiltin("fs") // host fs inside the workflow VM
  const names = ["task.md", "plan.md", "tasks.json", "notes.md", "checks.md", "deliverable.md"] // working ledger only
  for (let i = 0; i < names.length; i++) { // one file per ledger name
    const p = WS + "/" + names[i] // path under .fable
    try {
      if (fs.existsSync(p)) fs.writeFileSync(p, "") // truncate; do not create a missing file
    } catch (e) {
      log("ledger wipe failed: " + names[i] + " " + String(e)) // leave the rest of the wipe to continue
    }
  }
}

phase("plan")
const plan = await call("predominant_manager",
  "WS: " + WS + NL + "CWD: " + CWD + NL + NL
  + "HISTORY: if " + WS + "/history exists, read it and decide MODE." + NL + NL
  + "PROBLEM:" + NL + args.problem)
const PLAN = sec(plan, "PLAN")

let last
phase("ideate")
last = await call("idea_worker", // every turn, including continue; check stays after laborer
  "WS: " + WS + NL + "CWD: " + CWD + NL + NL
  + "PROBLEM:" + NL + args.problem + NL + NL
  + "Do not read plan.md. You are the fresh-perspective worker.")

phase("solve")
let prev = null
let rounds = 0
let outcome = null
for (let i = 0; i < MAX; i++) {
  rounds = i + 1
  const d = await call("decision_manager",
    "WS: " + WS + NL + "CWD: " + CWD + NL + NL
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "PLAN:" + NL + cap(PLAN, 4000) + NL + NL
    + "LATEST WORKER RESULT:" + NL + cap(last, 6000))
  if (!d) {
    outcome = { done: false, rounds: rounds, reason: "decision unavailable" }
    break
  }
  const STATUS = sec(d, "STATUS")
  let NEXT = sec(d, "NEXT")
  const TASKS = sec(d, "TASKS")
  let head = statusHead(STATUS)
  if (head === "done" && checksBad(last)) {
    head = "continue"
    if (!NEXT) NEXT = "Checks failed or there is no deliverable yet. Fix the failing check, or produce the deliverable under CWD — never under .fable."
  }
  if (head === "done") {
    outcome = { done: true, rounds: rounds, reason: "manager done", checks: sec(last, "CHECKS") }
    break
  }
  if (!NEXT) NEXT = firstTodo(TASKS) || "Implement the most promising approach from notes.md under CWD (project root), never under .fable."
  if (prev !== null && NEXT.trim().toLowerCase() === prev.trim().toLowerCase()) {
    outcome = { done: false, rounds: rounds, reason: "no progress" }
    break
  }
  prev = NEXT
  let w = await call("laborer_worker",
    "WS: " + WS + NL + "CWD: " + CWD + NL + NL
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "PLAN:" + NL + cap(PLAN, 4000) + NL + NL
    + "YOUR TASK: " + NEXT)
  if (!sec(w, "STATUS")) {
    w = await call("summary_worker",
      "WS: " + WS + NL + "CWD: " + CWD + NL + NL
      + "TASK: " + NEXT + NL + NL
      + "CUT-OFF ATTEMPT:" + NL + snippet(w || ""))
  }
  last = await call("check_worker",
    "WS: " + WS + NL + "CWD: " + CWD + NL + NL
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "LATEST LABOR:" + NL + cap((sec(w, "STATUS") + NL + sec(w, "DELIVERABLE") + NL + sec(w, "NOTES")), 4000))
}

if (!outcome) {
  last = await call("laborer_worker",
    "WS: " + WS + NL + "CWD: " + CWD + NL + NL
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "PLAN:" + NL + cap(PLAN, 4000) + NL + NL
    + "YOUR TASK: Produce the DEFINITIVE deliverable now under CWD, using all notes and current work. Never write it under .fable.")
  last = await call("check_worker",
    "WS: " + WS + NL + "CWD: " + CWD + NL + NL
    + "PROBLEM:" + NL + args.problem + NL + NL
    + "LATEST LABOR:" + NL + cap(last || "", 4000))
  outcome = { done: false, rounds: rounds, reason: "max rounds", checks: sec(last, "CHECKS") }
}

phase("wrap")
const hist = await call("history_worker",
  "WS: " + WS + NL + "CWD: " + CWD + NL + NL
  + "DIGEST SHAPE: read " + ROLE + "/adhd.md in full and follow every rule in it. Do not shorten it." + NL + NL // external shape file, not an inlined summary
  + "ROUND OUTCOME:" + NL + JSON.stringify(outcome) + NL + NL
  + "LAST CHECKS:" + NL + (sec(last, "CHECKS") || "(none)"))

outcome.digest = sec(hist, "DIGEST") || hist
if (sec(hist, "DIGEST")) wipeLedger() // ledger is empty only after the compact landed
else log("ledger wipe skipped: history digest missing")
const uniq = []
for (let i = 0; i < opens.length; i++) {
  if (uniq.indexOf(opens[i]) < 0) uniq.push(opens[i])
}
outcome.open = uniq
return outcome
