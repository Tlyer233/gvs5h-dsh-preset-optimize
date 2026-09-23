/**
 * createUserMessage：slash steer 与 cut steer 共用，不碰占用/日志。
 * @module commands/test-inject/llm
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

let makeUser = null

/**
 * @description Resolve dsh-llm the same way /gvs5h does.
 * @returns {string}
 */
function llmEntry() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh")
  const rel = join("node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
  const tries = [join(home, "profiles", rel), join(home, rel)]
  for (const p of tries) { if (existsSync(p)) return p }
  throw new Error("command-test-inject: @deepseek-ai/dsh-llm not found under " + home)
}

/**
 * @description ESM-load createUserMessage.
 * @returns {Promise<(input: object) => object>}
 */
export function loadCreateUserMessage() {
  return import(pathToFileURL(llmEntry()).href).then(function (mod) {
    return mod.createUserMessage
  })
}

loadCreateUserMessage().then(function (fn) { makeUser = fn }).catch(function () { })

/**
 * @description Ensure factory is loaded (slash handler awaits this).
 * @returns {Promise<(input: object) => object>}
 */
export async function ensureCreateUserMessage() {
  if (!makeUser) makeUser = await loadCreateUserMessage()
  return makeUser
}

/**
 * @description Build a user-role message for inject/steer.
 * @param {string} text
 * @returns {object|null}
 */
export function userMsg(text) {
  if (!makeUser) return null
  return makeUser({
    content: [{ type: "text", text: text }],
    source: { kind: "user" }
  })
}

/**
 * @description Build a steered user turn (attachments + marker text).
 * @param {{ content: object[] }} input
 * @returns {object}
 */
export function userTurn(input) {
  if (!makeUser) throw new Error("command-test-inject: createUserMessage not loaded")
  return makeUser({
    content: input.content,
    source: { kind: "user" }
  })
}
