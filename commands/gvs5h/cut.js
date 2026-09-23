/**
 * 宿主侧 cut：对齐 test-inject（userMsg + child.steer / cancel+steer / cancel）。
 * @module commands/gvs5h/cut
 */
import { userMsg } from "./llm.js"

/**
 * @description 只 steer，不打断当前 generate。
 * @param {object} child
 * @param {string} text
 * @returns {void}
 */
export function steerChild(child, text) {
  const msg = userMsg(text)
  if (!msg) throw new Error("gvs5h steer: createUserMessage not ready")
  child.steer(msg)
}

/**
 * @description cancel 当前 turn（保留 inbox）再 steer 下一轮。
 * @param {object} child
 * @param {string} text
 * @param {string} [reason]
 * @returns {void}
 */
export function cancelThenSteer(child, text, reason) {
  const msg = userMsg(text)
  if (!msg) throw new Error("gvs5h cancel+steer: createUserMessage not ready")
  child.cancel({ kind: "hook", reason: reason || "gvs5h cancel+steer" }, { keepInbox: true })
  child.steer(msg)
}

/**
 * @description cancel 当前 turn，默认清 inbox，不 steer。
 * @param {object} child
 * @param {string} [reason]
 * @returns {void}
 */
export function cancelChild(child, reason) {
  child.cancel({ kind: "hook", reason: reason || "gvs5h cut" })
}
