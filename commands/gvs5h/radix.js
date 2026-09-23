// SSS/SES 封装。由 command.js BOOTSTRAP 加载，返回 call(n, p)。
// 工作流 VM 不能 require/import；用闭包里的 agent、log、args。
const NL = String.fromCharCode(10)
const WS = args.ws
const ROLE = args.roleSrc
const RADIX_HOST = "100.85.98.34"
const RADIX_PORT = 8000

/**
 * @description 取宿主 Node process。VM 是空 context，guest 没有 require。
 * @returns {NodeJS.Process}
 */
function nodeProcess() {
  if (typeof process === "object" && process && typeof process.getBuiltinModule === "function") return process
  return Object.getPrototypeOf(agent).constructor("return process")()
}

/**
 * @description 加载 Node 内置模块（fs / http / timers）。
 * @param {string} name 模块名
 * @returns {any}
 */
function nodeBuiltin(name) {
  return nodeProcess().getBuiltinModule(name)
}

/**
 * @description 用 timers 内置 sleep。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  const t = nodeBuiltin("timers").setTimeout
  return new Promise(function (ok) { t(ok, ms) })
}

/**
 * @description 打 log，并追加一行到 WS/radix.log。
 * @param {string} line 内容
 * @returns {void}
 */
function appendRadix(line) {
  log(line)
  try {
    const fs = nodeBuiltin("fs")
    try { fs.mkdirSync(WS, { recursive: true }) } catch (e) { }
    fs.appendFileSync(WS + "/radix.log", line + NL)
  } catch (e) {
    log("radix.log write failed: " + String(e))
  }
}

/**
 * @description HTTP 2xx 且 JSON success=true 才算引擎成功。
 * @param {string} text 响应体
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
 * @description 用 Node http POST /sss 或 /ses，不用 VM fetch。
 * @param {string} name sss 或 ses
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
 * @description 直到 2xx+success。忙或 SES 进行中会失败，等 500ms 再 POST。
 * @param {string} name sss 或 ses
 * @param {string} label subagent 标签
 * @returns {Promise<string>} 响应体
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
 * @description 本轮要不要 POST /sss /ses。
 * 优先级：args.radix → 环境变量 FABLE_RADIX → config/config.json 的 radix → 默认开。
 * @returns {boolean}
 */
function radixEnabled() {
  const v = args && args.radix // workflow 参数覆盖
  if (v === false || v === 0 || v === "0" || v === "off" || v === "false") return false // 显式关
  if (v === true || v === 1 || v === "1" || v === "on" || v === "true") return true // 显式开
  try {
    const env = nodeProcess().env && nodeProcess().env.FABLE_RADIX
    if (env !== undefined && String(env).trim() !== "") {
      const e = String(env).trim().toLowerCase()
      if (e === "off" || e === "0" || e === "false") return false // 环境关
      if (e === "on" || e === "1" || e === "true") return true // 环境开
    }
  } catch (e) { }
  try {
    const fs = nodeBuiltin("fs")
    const presetDir = ROLE.slice(0, ROLE.length - "/roles".length)
    const j = JSON.parse(fs.readFileSync(presetDir + "/config/config.json", "utf8"))
    const r = j && j.radix
    if (r === false || r === 0 || r === "0" || r === "off" || r === "false") return false // 文件关
    if (r === true || r === 1 || r === "1" || r === "on" || r === "true") return true // 文件开
  } catch (e) { }
  return true // 本预设默认开
}

/**
 * @description 对外唯一入口：call 前 SSS，call 后 SES；agent 抛错也跑 SES。
 * @param {string} n 标签
 * @param {string} p 提示词
 * @returns {Promise<string|null>}
 */
return async function call(n, p) {
  const on = radixEnabled() // 每个 subagent 拍一次
  if (on) await radix("sss", n) // 打点 + 锁
  else appendRadix("sss " + n + " skipped (radix off)")
  let x = null
  try {
    x = await agent(p, { label: n })
  } finally {
    if (on) await radix("ses", n) // 切独特分支
    else appendRadix("ses " + n + " skipped (radix off)")
  }
  return x
}
