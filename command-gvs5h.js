/**
 * Agent-scoped `/gvs5h` for fable-optimize-sglang.
 * Registers the slash command and injects the GVS pipeline prompt only while
 * that agent is armed for the current /gvs5h turn. Chat assemblies get "".
 * @module command-gvs5h
 */
import { existsSync } from "node:fs" // locate the installed dsh-llm entry
import { homedir } from "node:os" // fallback when DSH_HOME is unset
import { join } from "node:path" // join home + package path
import { pathToFileURL } from "node:url" // ESM-import an absolute file

export const name = "command-gvs5h" // Cordis plugin name; matches the yaml row id
export const inject = ["commands", "systemPrompt"] // slash registry + per-assembly section

const MARKER = "GVS5H_RUN" // first line of the steered user task; not the prompt gate
const USAGE = [
  "Usage: /gvs5h <task>",
  "Starts one GVS5H optimize + ledger turn for this message only.",
  "Ordinary chat does not start it. Follow-ups need /gvs5h again.",
].join("\n") // UI text; not a model message
const armed = new WeakSet() // parent agents currently in a /gvs5h running turn
const GVS_SECTION = [
  "LOCKED PIPELINE (MODE A-GVS) — injected only because the human typed /gvs5h. No other branches.",
  "You are not a coder this turn. You MUST end in exactly one workflow call. Skipping workflow is a protocol failure.",
  "Solving, planning, writing code, writing a loop, calling subagent, or sending a solution BEFORE workflow returns is a protocol failure.",
  "Never adapt, minify, or replace the bootstrap. loop.js on disk owns SSS/SES around every agent().",
  "The user text is everything after the first " + MARKER + " line.",
  "1) INSPECT. First tool call: read /Users/xi/.dsh/.agent-presets/fable-optimize-sglang/roles/optimize_manager.md and follow it. Then read every file path and list every directory path in the user text after " + MARKER + " (@, backticks, quotes, 完成这个任务, 文件夹, bare paths). File: read contents. Directory: top level only; read README, 任务.md, TODO*, and files the user named. Do not dump a whole repo into PROBLEM. Allowed tools in this step only: read, bash (ls/stat/find/cat; no mkdir/write/rm/git). Forbidden: write, subagent, subagent_fork, present, workflow (not yet).",
  "2) ALIGN. Call ask_user_question at most once, at most three questions, recommended option first, and only if a user-owned choice BLOCKS work and inspection cannot answer it. Skip ask when: goal+success are already clear; the user said 你定 / 直接做 / 不用问; this is an unambiguous follow-up. Never ask where code lives. ask_user_question is a tool in THIS turn; do not wait for another /gvs5h.",
  "3) COMPOSE. Build args.problem with the exact section headers in optimize_manager.md (GOAL/CONSTRAINTS/SUCCESS/IN SCOPE/OUT OF SCOPE/INPUTS/USER DECISIONS/RAW). Strip the " + MARKER + " line from RAW. That text is a workflow argument, not a user-visible reply.",
  "4) WORKFLOW — MANDATORY. After inspect (and after ask returns, if you asked), the next tool call MUST be workflow. Call it even if the task looks trivial. Do not skip. Do not inline a GVS loop. Do not call subagent instead. Do not write files.",
  "- meta: { \"name\": \"gvs-solve\", \"description\": \"GVS5H ledger loop for one user turn\" }",
  "- args: { \"problem\": <COMPOSE output>, \"ws\": \"{{cwd}}/.fable\", \"cwd\": \"{{cwd}}\", \"roleSrc\": \"/Users/xi/.dsh/.agent-presets/fable-optimize-sglang/roles\", \"maxRounds\": 10 }",
  "- script: the BOOTSTRAP below, copied VERBATIM. Four lines. It loads /Users/xi/.dsh/.agent-presets/fable-optimize-sglang/loop.js from disk and runs it.",
  "If you are about to send a normal assistant message and workflow has not run this user-turn, STOP and call workflow instead.",
  "Ledger lives in {{cwd}}/.fable (task/plan/notes/checks/history only). User-facing files live in {{cwd}}, never inside .fable.",
  "At most one workflow call per /gvs5h turn.",
  "<BOOTSTRAP>",
  "const NL = String.fromCharCode(10)",
  "const proc = Object.getPrototypeOf(agent).constructor(\"return process\")()",
  "const fs = proc.getBuiltinModule(\"fs\")",
  "const src = fs.readFileSync(\"/Users/xi/.dsh/.agent-presets/fable-optimize-sglang/loop.js\", \"utf8\")",
  "const Fn = Object.getPrototypeOf(agent).constructor",
  "const run = Fn(\"agent\", \"phase\", \"log\", \"args\", \"return (async function () {\" + NL + src + NL + \"})()\")",
  "return await run(agent, phase, log, args)",
  "</BOOTSTRAP>",
  "FINAL MESSAGE: only AFTER workflow returns, relay result.digest verbatim (user-facing summary, in the problem's language). Then one short line: rounds used, done/reason, checks. If result.open is non-empty, append those '- OPEN:' lines AFTER the digest. Never dump the raw STATUS/TASKS blob. The next ordinary user message is normal chat. Another GVS turn requires /gvs5h again.",
].join("\n") // injected only while armed; empty string otherwise

/**
 * @description Resolve dsh-llm. This file sits under ~/.dsh/.agent-presets, so
 * a bare `import '@deepseek-ai/dsh-llm'` cannot walk to the harness node_modules.
 * @returns {string} absolute path to dsh-llm lib/index.js
 */
function llmEntry() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh") // harness home
  const rel = join("node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js") // package main
  const tries = [join(home, "profiles", rel), join(home, rel)] // profiles first, then ~/.dsh
  for (const p of tries) { // probe each candidate
    if (existsSync(p)) return p // first existing entry
  }
  throw new Error("command-gvs5h: @deepseek-ai/dsh-llm not found under " + home) // fail loud
}

/**
 * @description ESM-load createUserMessage from the installed harness package.
 * @returns {Promise<(input: object) => object>} createUserMessage
 */
function loadCreateUserMessage() {
  return import(pathToFileURL(llmEntry()).href).then(function (mod) { // file URL, not a package name
    return mod.createUserMessage // named export used by /plan and /goal
  })
}

/**
 * @description Register `/gvs5h` and a prompt section that is empty unless armed.
 * @param {import('@deepseek-ai/cordis').Context} ctx agent-scoped context
 * @returns {void}
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "gvs5h:pipeline", // unique section id for this preset
    order: 510, // after persona prefix (0), near plan policy (500)
    interpolate: true, // expand {{cwd}} in ledger paths
    text: function (context) {
      if (context.agent === undefined) return "" // no agent → no GVS text
      if (!armed.has(context.agent)) return "" // chat / subagent / disarmed
      return GVS_SECTION // parent /gvs5h turn only
    }
  })
  ctx.on("agent/status", function (payload) {
    if (payload.status === "idle") armed.delete(payload.agent) // drop GVS prompt when the turn ends
  })
  ctx.commands.register({
    name: "gvs5h", // slash name without the leading /
    description: "Run one GVS5H optimize + ledger turn", // command palette copy
    input: { hint: "<task>", attachments: true }, // free text plus composer files
    handler: async function (invocation) {
      invocation.signal.throwIfAborted() // honor UI cancel before side effects
      const task = invocation.rawInput.trim() // bytes after `/gvs5h`
      if (task.length === 0) { // bare `/gvs5h`
        return { kind: "success", text: USAGE } // no steer, no model turn
      }
      const createUserMessage = await loadCreateUserMessage() // harness constructor
      const text = MARKER + "\n" + task // task payload; pipeline lives in the prompt section
      armed.add(invocation.agent) // arm BEFORE steer so the first assemble sees GVS_SECTION
      invocation.agent.steer(createUserMessage({
        content: [...invocation.attachments, { type: "text", text: text }], // files then marked text
        source: { kind: "user" } // same source /plan uses for steered input
      }))
      return { kind: "success", text: "GVS5H started. Follow-ups need /gvs5h again." } // UI-only result
    }
  })
}
