import test from "node:test"
import assert from "node:assert/strict"
import { resolveYtDlpPath } from "../src/machugi/yt-dlp-path.js"

test("a stale path copied from another bot falls back to the bundled executable", () => {
  const bundled = "C:/봇/엔티티/bin/yt-dlp.exe"
  assert.equal(resolveYtDlpPath("C:/봇/machugi/bin/yt-dlp.exe", bundled,
    path => path === bundled), bundled)
})

test("a valid custom executable is preserved; empty settings use the bundle", () => {
  assert.equal(resolveYtDlpPath("custom.exe", "bundled.exe", () => true), "custom.exe")
  assert.equal(resolveYtDlpPath("", "bundled.exe", () => true), "bundled.exe")
})

test("missing executables fail with an actionable message", () => {
  assert.throws(() => resolveYtDlpPath("missing.exe", "missing-bundle.exe", () => false), /bin 폴더 또는 YT_DLP_PATH/)
})
