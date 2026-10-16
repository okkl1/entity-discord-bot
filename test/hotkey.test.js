import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

const source = await readFile(new URL("../hotkey/browser-extension/shift-n.js", import.meta.url), "utf8")
test("browser Shift+N activates the quiz button and ignores other shortcuts", () => {
  let handler, clicked = 0, prevented = 0, stopped = 0
  const button = { textContent: "⏭️스킵", disabled: false, click() { clicked++ } }
  const message = { textContent: "machugi.io · 채팅으로 정답을 입력하세요!", querySelectorAll: () => [button] }
  vm.runInNewContext(source, { document: {
    addEventListener: (type, callback) => { assert.equal(type, "keydown"); handler = callback },
    querySelectorAll: () => [message],
  } })
  const key = overrides => ({
    code: "KeyN", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false,
    preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++, ...overrides,
  })
  handler(key({ ctrlKey: true }))
  assert.equal(clicked, 0)
  handler(key())
  assert.equal(clicked, 1)
  handler(key({ repeat: true }))
  assert.equal(clicked, 1)
  assert.equal(prevented, 2)
  assert.equal(stopped, 2)
  button.disabled = true
  handler(key())
  assert.equal(prevented, 2)
})

test("browser Shift+N uses next question on the answer screen", () => {
  let handler, clicked = false
  const button = { textContent: "▶️次", disabled: false, click() { throw Error("wrong button") } }
  const next = { textContent: "▶️다음문제", disabled: false, click() { clicked = true } }
  vm.runInNewContext(source, { document: {
    addEventListener: (_, callback) => { handler = callback },
    querySelectorAll: () => [{ textContent: "machugi.io · 1 / 10", querySelectorAll: () => [button, next] }],
  } })
  handler({ code: "KeyN", shiftKey: true, preventDefault() {}, stopImmediatePropagation() {} })
  assert.equal(clicked, true)
})
