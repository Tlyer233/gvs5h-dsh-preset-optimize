/**
 * /test-inject 工作区日志：路径 + 追加写盘。不含 workflow / cut。
 * @module commands/test-inject/log
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DIR = dirname(fileURLToPath(import.meta.url))
let lastLogPath = join(DIR, "test-inject.log")

/**
 * @description 记下当前工作区日志路径。
 * @param {string} logPath
 * @returns {void}
 */
export function setLastLogPath(logPath) {
  lastLogPath = logPath
}

/**
 * @description 当前写入路径（command 设过之后 workflow/cut 读这个）。
 * @returns {string}
 */
export function currentLogPath() {
  return lastLogPath
}

/**
 * @description Abort 握手专用日志：本目录 abort.log + 工作区 .fable/abort.log。不含每秒 CTX。
 * @param {string} line
 * @returns {void}
 */
export function writeAbort(line) {
  const row = new Date().toISOString() + " " + line + "\n"
  try { appendFileSync(join(DIR, "abort.log"), row) } catch (e) { }
  try { appendFileSync(join(dirname(lastLogPath), "abort.log"), row) } catch (e) { }
}

/**
 * @description 一行日志：工作区 .fable + 本目录副本。
 * @param {string} logPath
 * @param {string} line
 * @returns {void}
 */
export function writeLog(logPath, line) {
  const row = new Date().toISOString() + " " + line + "\n"
  try { appendFileSync(logPath, row) } catch (e) { }
  try { appendFileSync(join(DIR, "test-inject.log"), row) } catch (e) { }
}

/**
 * @description Resolve {{cwd}}/.fable/test-inject.log from the parent agent.
 * @param {object} parent
 * @returns {string}
 */
export function workspaceLog(parent) {
  const cwd = parent && parent.session && parent.session.header && parent.session.header.cwd
  if (cwd) {
    try { mkdirSync(join(cwd, ".fable"), { recursive: true }) } catch (e) { }
    return join(cwd, ".fable", "test-inject.log")
  }
  return join(DIR, "test-inject.log")
}
