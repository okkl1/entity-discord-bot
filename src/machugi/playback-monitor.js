import { ffmpegFailure } from '../ffmpeg.js';
// Wait for real PCM output, then report later playback failures to the round.
export function monitorPlayback(player, ff, source, stream, {
  timeoutMs = 20_000, onFailure = () => {},
} = {}) {
  let intentional = false
  let started = false
  let failed = false
  let bytes = 0
  let resolveReady, rejectReady, resolveFailure
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // Resolves instead of rejecting, so a failure during setup cannot go unhandled.
  const failure = new Promise(resolve => { resolveFailure = resolve })
  const listeners = []
  const listen = (target, event, fn) => {
    if (!target) return
    target.on(event, fn)
    listeners.push(() => target.off(event, fn))
  }
  const fail = err => {
    if (intentional || failed) return
    failed = true
    onFailure()
    clearTimeout(timer)
    rejectReady(err)
    resolveFailure(err)
  }
  const timer = setTimeout(() => fail(new Error("오디오 출력 대기 시간 초과")), timeoutMs)
  listen(ff.stdout, "data", chunk => {
    bytes += chunk.length
    if (!started && bytes >= 3840) {
      started = true
      clearTimeout(timer)
      resolveReady()
    }
  })
  listen(ff, "error", fail)
  listen(source, "error", fail)
  listen(stream, "error", fail)
  listen(player, "error", fail)
  listen(ff, "close", (code, signal) => {
    if (code !== 0 || !started) fail(ffmpegFailure(code, signal, { bytes }))
  })
  listen(source, "close", code => {
    if (code !== 0) fail(new Error(`영상 다운로드 실패 (code=${code})`))
  })
  return {
    ready, failure,
    cleanup() {
      intentional = true
      clearTimeout(timer)
      for (const remove of listeners) remove()
    },
  }
}
