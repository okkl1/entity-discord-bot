/**
 * machugi.io 역공학 기반 API 클라이언트.
 *
 * - 검색: Typesense ("quiz" 컬렉션, 공개 읽기 전용 키)
 * - 문제 상세: Firebase Firestore REST API (quiz/{quizId}/question/{qId})
 *   - Authorization에 익명 Firebase JWT 필요 (signUp으로 발급)
 */

import { fileURLToPath } from "node:url"
import { FirebaseAuth } from "./firebase-auth.js"

const DEFAULT_REFERER = "https://machugi.io/"
const DEFAULT_ORIGIN = "https://machugi.io"

// machugi.io의 category_type: 2 === "음악"
export const MUSIC_CATEGORY_TYPE = 2

export async function searchMusicQuizzes({
  host,
  apiKey,
  query = "",
  page = 1,
  perPage = 20,
  sortBy = "hits:desc",
} = {}) {
  const params = new URLSearchParams({
    q: query || "*",
    query_by: "title,description",
    filter_by: `question_type:music && public:=true`,
    sort_by: sortBy,
    per_page: String(perPage),
    page: String(page),
  })

  const url = `https://${host}/collections/quiz/documents/search?${params.toString()}`
  const res = await fetch(url, { headers: { "X-TYPESENSE-API-KEY": apiKey }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    throw new Error(`Typesense search failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return {
    found: data.found,
    hits: (data.hits ?? []).map((h) => h.document),
  }
}

/**
 * 퀴즈 상세 정보(questionIds 포함)를 machugi.io의 Next.js SSR 데이터에서 추출.
 */
export async function fetchQuizDetail(quizId) {
  const res = await fetch(`${DEFAULT_ORIGIN}/quiz/${encodeURIComponent(quizId)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (machugi-bot)",
      Accept: "text/html",
    },
  })
  if (!res.ok) throw new Error(`Failed to fetch quiz page: ${res.status}`)
  const html = await res.text()
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/,
  )
  if (!match) throw new Error("Could not find __NEXT_DATA__ in quiz page")
  const data = JSON.parse(match[1])
  const quiz = data?.props?.pageProps?.quizType
  if (!quiz) throw new Error("Quiz data missing in page")
  return quiz
}

// 익명 Firebase JWT 캐시
const firebaseAuth = new FirebaseAuth({ cacheFile: fileURLToPath(new URL("../../data/machugi/auth.json", import.meta.url)) })

async function getFirebaseAnonToken(apiKey) {
  return firebaseAuth.getToken(apiKey)
}

function firestoreValueToJs(v) {
  if (v == null) return null
  if ("stringValue" in v) return v.stringValue
  if ("integerValue" in v) return Number(v.integerValue)
  if ("doubleValue" in v) return v.doubleValue
  if ("booleanValue" in v) return v.booleanValue
  if ("nullValue" in v) return null
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(firestoreValueToJs)
  if ("mapValue" in v) {
    const out = {}
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      out[k] = firestoreValueToJs(val)
    }
    return out
  }
  if ("timestampValue" in v) return new Date(v.timestampValue)
  return null
}

function parseFirestoreDoc(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = firestoreValueToJs(v)
  return out
}

export async function fetchMusicQuestion({
  firebaseApiKey,
  firebaseProjectId,
  quizId,
  questionId,
}) {
  const token = await getFirebaseAnonToken(firebaseApiKey)
  const url =
    `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}` +
    `/databases/(default)/documents/quiz/${encodeURIComponent(quizId)}` +
    `/question/${encodeURIComponent(questionId)}`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: DEFAULT_REFERER,
      Origin: DEFAULT_ORIGIN,
    },
  })
  if (!res.ok) {
    throw new Error(`Firestore fetch failed: ${res.status} ${await res.text()}`)
  }
  const doc = await res.json()
  return parseFirestoreDoc(doc)
}

export async function fetchMusicQuestions({
  firebaseApiKey,
  firebaseProjectId,
  quizId,
  questionIds,
}) {
  // 인증 실패는 문제 없음으로 숨기지 않고 한 번만 요청한 뒤 전달한다.
  await getFirebaseAnonToken(firebaseApiKey)
  const results = new Array(questionIds.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, questionIds.length) }, async () => {
    while (cursor < questionIds.length) {
      const index = cursor++
      results[index] = await fetchMusicQuestion({
        firebaseApiKey,
        firebaseProjectId,
        quizId,
        questionId: questionIds[index],
      }).catch(() => null)
    }
  }))
  return results.filter(Boolean)
}

