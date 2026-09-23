/**
 * createUserMessage：slash steer 与 cut steer 共用。
 * @module commands/gvs5h/llm
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

let makeUser = null

/**
 * @description 解析 dsh-llm。本文件在 ~/.dsh/.agent-presets，裸 import 走不到 harness 的 node_modules。
 * @returns {string} dsh-llm lib/index.js 绝对路径
 */
function llmEntry() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh")
  const rel = join("node_modules", "@deepseek-ai", "dsh-llm", "lib", "index.js")
  const tries = [join(home, "profiles", rel), join(home, rel)]
  for (const p of tries) {
    if (existsSync(p)) return p
  }
  throw new Error("command-gvs5h: @deepseek-ai/dsh-llm not found under " + home)
}

/**
 * @description ESM 加载已安装包里的 createUserMessage。
 * @returns {Promise<(input: object) => object>}
 */
export function loadCreateUserMessage() {
  return import(pathToFileURL(llmEntry()).href).then(function (mod) {
    return mod.createUserMessage
  })
}

loadCreateUserMessage().then(function (fn) { makeUser = fn }).catch(function () { })

/**
 * @description 保证 factory 已加载。
 * @returns {Promise<(input: object) => object>}
 */
export async function ensureCreateUserMessage() {
  if (!makeUser) makeUser = await loadCreateUserMessage()
  return makeUser
}

/**
 * @description 给 cut steer 造一条 user 消息。factory 未就绪时返回 null。
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
