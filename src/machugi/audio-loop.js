// Trim once and repeat decoded samples, without reopening YouTube each time.
export function clipLoopFilter(startSeconds, duration) {
  const samples = Math.max(1, Math.round(duration * 48000))
  return `atrim=start=${startSeconds}:duration=${duration},asetpts=PTS-STARTPTS,` +
    `aresample=48000,aloop=loop=-1:size=${samples}:start=0`
}
