/**
 * machugi.io 방식으로 답을 정규화/비교.
 * 사이트는 공백 제거 + 소문자 + 여러 정답 중 하나라도 일치하면 정답 처리함.
 */

export function normalizeAnswer(raw) {
  if (!raw) return ""
  return String(raw)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?~"'()[\]{}<>:;·・…]/g, "")
    .trim()
}

export function isCorrect(userInput, answers) {
  if (!Array.isArray(answers) || answers.length === 0) return false
  const u = normalizeAnswer(userInput)
  if (!u) return false
  return answers.some((a) => normalizeAnswer(a) === u)
}
