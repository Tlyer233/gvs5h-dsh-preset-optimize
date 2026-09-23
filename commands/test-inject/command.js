/**
 * /test-inject — slash + 锁父 agent 进 workflow。cut 见 cut.js。
 * @module commands/test-inject/command
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { bindCutSupervisor } from "./cut.js"
import { setLastLogPath, workspaceLog, writeLog } from "./log.js"
import { ensureCreateUserMessage, userTurn } from "./llm.js"

export const name = "command-test-inject"
export const inject = ["commands", "systemPrompt", "workflowEngine", "agents"]

const DIR = dirname(fileURLToPath(import.meta.url))
const LOOP = join(DIR, "loop.js")
const MARKER = "TEST_INJECT_RUN"
const armed = new WeakSet()

const TEST_SECTION = [
  "LOCKED PIPELINE (MODE A-GVS) — TEST-INJECT. The human typed /test-inject. No other branches.",
  "This is a cut_supervisor test. You MUST end in exactly one workflow call. Skipping workflow is a protocol failure.",
  "Do not inspect files. Do not ask. Do not spawn subagent yourself. Do not write files. Do not solve.",
  "First and only tool call: workflow.",
  "- meta: { \"name\": \"test-inject\", \"description\": \"TEST cut inject/steer/cancel two hard cwd dumps\", \"phases\": [{ \"title\": \"hard-1\" }, { \"title\": \"hard-2\" }] }",
  "The user text is everything after the first " + MARKER + " line. Copy it VERBATIM into args.task. Do not rewrite it.",
  "- args: { \"task\": <verbatim text after " + MARKER + "> }",
  "- script: the BOOTSTRAP below, copied VERBATIM. It loads " + LOOP + " from disk.",
  "If you are about to send a normal assistant message and workflow has not run this user-turn, STOP and call workflow instead.",
  "<BOOTSTRAP>",
  "const NL = String.fromCharCode(10)",
  "const proc = Object.getPrototypeOf(agent).constructor(\"return process\")()",
  "const fs = proc.getBuiltinModule(\"fs\")",
  "const src = fs.readFileSync(" + JSON.stringify(LOOP) + ", \"utf8\")",
  "const Fn = Object.getPrototypeOf(agent).constructor",
  "const run = Fn(\"agent\", \"phase\", \"log\", \"args\", \"return (async function () {\" + NL + src + NL + \"})()\")",
  "return await run(agent, phase, log, args)",
  "</BOOTSTRAP>",
  "FINAL MESSAGE: after workflow returns, one short line: hard-a / hard-b outcomes (text or null if cancelled). Then the JSON value. This is a test.",
].join("\n")

/**
 * @description Register /test-inject and lock the parent to workflow.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "test-inject:pipeline",
    order: 511,
    interpolate: false,
    text: function (context) {
      if (context.agent === undefined) return ""
      if (!armed.has(context.agent)) return ""
      return TEST_SECTION
    }
  })

  ctx.on("agent/status", function (payload) {
    if (payload.status === "idle") armed.delete(payload.agent)
  })

  bindCutSupervisor(ctx)

  ctx.commands.register({
    name: "test-inject",
    description: "TEST: two children; cut@15k inject / 20k steer / 25k cancel+inject / 30k cancel+steer / 50k cancel",
    input: { hint: "<task>", attachments: true },
    handler: async function (invocation) {
      invocation.signal.throwIfAborted()
      const task = invocation.rawInput.trim()
      if (task.length === 0) {
        return { kind: "success", text: "Usage: /test-inject <task>\nBoth children receive that text verbatim." }
      }
      const logPath = workspaceLog(invocation.agent)
      setLastLogPath(logPath)
      writeLog(logPath, "COMMAND /test-inject parent=" + invocation.agent.id)
      await ensureCreateUserMessage()
      armed.add(invocation.agent)
      invocation.agent.steer(userTurn({
        content: [...invocation.attachments, { type: "text", text: MARKER + "\n" + task }]
      }))
      return { kind: "success", text: "test-inject started. Watch hard-1 / hard-2. log: " + logPath }
    }
  })
}
