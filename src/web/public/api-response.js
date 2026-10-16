export async function readApiResponse(response) {
  let data;
  try { data = JSON.parse(await response.text()); }
  catch {
    const message = [502, 503, 504].includes(response.status)
      ? '웹방 연결이 지연되거나 끊겼습니다. 봇 실행과 인터넷 연결을 확인한 뒤 다시 시도해주세요.'
      : [401, 403].includes(response.status) ? '웹방 접근이 차단됐습니다. 디스코드의 웹방 입장 버튼으로 다시 참가해주세요.'
      : '웹방에서 올바른 응답을 받지 못했습니다. 봇 실행을 확인하고 페이지를 새로고침해주세요.';
    throw new Error(message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('웹방 응답을 읽지 못했습니다. 페이지를 새로고침해주세요.');
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '웹방 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
  return data;
}
