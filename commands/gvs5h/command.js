/**
 * 本预设的 `/gvs5h`。注册斜杠命令，只在当前 /gvs5h 回合给父会话注入流水线提示。
 * 普通聊天拼装得到空段。
 * @module commands/gvs5h/command
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureCreateUserMessage } from "./llm.js"
import { bindLaborerPressure } from "./pressure.js"

export const name = "command-gvs5h" // Cordis 插件名，对齐 yaml 行 id
export const inject = ["commands", "systemPrompt", "workflowEngine", "agents"]

const DIR = dirname(fileURLToPath(import.meta.url)) // commands/gvs5h
const LOOP = join(DIR, "loop.js") // 冻结循环体
const RADIX = join(DIR, "radix.js") // SSS/SES；BOOTSTRAP 注入 call
const MARKER = "GVS5H_RUN" // 转写入用户任务的首行；不是提示词闸门
const USAGE = [
  "Usage: /gvs5h <task>",
  "Starts one GVS5H optimize + ledger turn for this message only.",
  "Ordinary chat does not start it. Follow-ups need /gvs5h again.",
].join("\n") // 界面文案，不是模型消息
const armed = new WeakSet() // 当前正在跑 /gvs5h 的父 agent
const GVS_SECTION = [
  "LOCKED PIPELINE (MODE A-GVS) — injected only because the human typed /gvs5h. No other branches.",
  "You are not a coder this turn. You MUST end in exactly one workflow call. Skipping workflow is a protocol failure.",
  "Solving, planning, writing code, writing a loop, calling subagent, or sending a solution BEFORE workflow returns is a protocol failure.",
  "Never adapt, minify, or replace the bootstrap. radix.js on disk owns SSS/SES around every call(); loop.js only uses the injected call.",
  "The user text is everything after the first " + MARKER + " line.",
  "1) INSPECT. First tool call: read /Users/xi/.dsh/.agent-presets/fable-optimize-sglang/roles/optimize_manager.md and follow it. Then read every file path and list every directory path in the user text after " + MARKER + " (@, backticks, quotes, 完成这个任务, 文件夹, bare paths). File: read contents. Directory: top level only; read README, 任务.md, TODO*, and files the user named. Do not dump a whole repo into PROBLEM. Allowed tools in this step only: read, bash (ls/stat/find/cat; no mkdir/write/rm/git). Forbidden: write, subagent, subagent_fork, present, workflow (not yet).",
  "2) ALIGN. Call ask_user_question at most once, at most three questions, recommended option first, and only if a user-owned choice BLOCKS work and inspection cannot answer it. Skip ask when: goal+success are already clear; the user said 你定 / 直接做 / 不用问; this is an unambiguous follow-up. Never ask where code lives. ask_user_question is a tool in THIS turn; do not wait for another /gvs5h.",
  "3) COMPOSE. Build args.problem with the exact section headers in optimize_manager.md (GOAL/CONSTRAINTS/SUCCESS/IN SCOPE/OUT OF SCOPE/INPUTS/USER DECISIONS/RAW). Strip the " + MARKER + " line from RAW. That text is a workflow argument, not a user-visible reply.",
  "4) WORKFLOW — MANDATORY. After inspect (and after ask returns, if you asked), the next tool call MUST be workflow. Call it even if the task looks trivial. Do not skip. Do not inline a GVS loop. Do not call subagent instead. Do not write files.",
  "- meta: { \"name\": \"gvs-solve\", \"description\": \"GVS5H ledger loop for one user turn\" }",
  "- args: { \"problem\": <COMPOSE output>, \"ws\": \"{{cwd}}/.fable\", \"cwd\": \"{{cwd}}\", \"roleSrc\": \"/Users/xi/.dsh/.agent-presets/fable-optimize-sglang/roles\" }",
  "- script: the BOOTSTRAP below, copied VERBATIM. It loads " + RADIX + " then " + LOOP + " from disk.",
  "If you are about to send a normal assistant message and workflow has not run this user-turn, STOP and call workflow instead.",
  "Ledger lives in {{cwd}}/.fable (task/plan/notes/checks/history only). User-facing files live in {{cwd}}, never inside .fable.",
  "At most one workflow call per /gvs5h turn.",
  "<BOOTSTRAP>",
  "const NL = String.fromCharCode(10)",
  "const proc = Object.getPrototypeOf(agent).constructor(\"return process\")()",
  "const fs = proc.getBuiltinModule(\"fs\")",
  "const radixSrc = fs.readFileSync(" + JSON.stringify(RADIX) + ", \"utf8\")",
  "const loopSrc = fs.readFileSync(" + JSON.stringify(LOOP) + ", \"utf8\")",
  "const Fn = Object.getPrototypeOf(agent).constructor",
  "const call = Fn(\"agent\", \"log\", \"args\", \"return (function () {\" + NL + radixSrc + NL + \"})()\")(agent, log, args)",
  "const run = Fn(\"agent\", \"phase\", \"log\", \"args\", \"call\", \"return (async function () {\" + NL + loopSrc + NL + \"})()\")",
  "return await run(agent, phase, log, args, call)",
  "</BOOTSTRAP>",
  "FINAL MESSAGE: only AFTER workflow returns, relay result.digest verbatim (user-facing summary, in the problem's language). Then one short line: rounds used, done/reason, checks. If result.open is non-empty, append those '- OPEN:' lines AFTER the digest. Never dump the raw STATUS/TASKS blob. The next ordinary user message is normal chat. Another GVS turn requires /gvs5h again.",
].join("\n") // 仅 armed 时注入；否则空串

/**
 * @description 注册 `/gvs5h`；未 armed 时提示段为空。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function apply(ctx) {
  bindLaborerPressure(ctx)
  ctx.systemPrompt.section({
    name: "gvs5h:pipeline",
    order: 510, // persona 前缀之后，靠近 plan 策略
    interpolate: true, // 展开 ledger 路径里的 {{cwd}}
    text: function (context) {
      if (context.agent === undefined) return ""
      if (!armed.has(context.agent)) return "" // 聊天 / subagent / 已卸
      return GVS_SECTION // 仅父会话 /gvs5h 回合
    }
  })
  ctx.on("agent/status", function (payload) {
    if (payload.status === "idle") armed.delete(payload.agent) // 回合结束卸掉 GVS 提示
  })
  ctx.commands.register({
    name: "gvs5h",
    description: "Run one GVS5H optimize + ledger turn",
    input: { hint: "<task>", attachments: true },
    handler: async function (invocation) {
      invocation.signal.throwIfAborted()
      const task = invocation.rawInput.trim()
      if (task.length === 0) { // 光打 /gvs5h
        return { kind: "success", text: USAGE }
      }
      const createUserMessage = await ensureCreateUserMessage()
      const text = MARKER + "\n" + task
      armed.add(invocation.agent) // 先 arm 再 steer，第一次拼装就能看到 GVS_SECTION
      invocation.agent.steer(createUserMessage({
        content: [...invocation.attachments, { type: "text", text: text }],
        source: { kind: "user" }
      }))
      return { kind: "success", text: "GVS5H started. Follow-ups need /gvs5h again." }
    }
  })
}
