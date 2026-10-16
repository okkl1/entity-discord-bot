import bundledFfmpeg from 'ffmpeg-static';
import { existsSync } from 'node:fs';

export function resolveFfmpegPath({ env = process.env, platform = process.platform, exists = existsSync, bundled = bundledFfmpeg } = {}) {
  if (env.FFMPEG_PATH?.trim()) return env.FFMPEG_PATH.trim();
  // Debian's dynamically linked build avoids the bundled static binary's
  // platform/DNS incompatibilities and receives system security updates.
  if (platform === 'linux' && exists('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  return bundled || 'ffmpeg';
}
export const ffmpegPath = resolveFfmpegPath();

export function ffmpegFailure(code, signal, { bytes, stderr = '' } = {}) {
  const details = `code=${code}, signal=${signal || 'none'}${bytes == null ? '' : `, bytes=${bytes}`}`;
  const hint = signal === 'SIGKILL' ? '서버 자원 제한 또는 외부 종료 여부를 확인해주세요.'
    : signal ? '서버의 FFmpeg 실행 파일과 호환성을 확인해주세요.' : '';
  const error = new Error(`오디오 변환 실패 (${details}). ${hint}${stderr ? ` ${stderr.trim().slice(-500)}` : ''}`.trim());
  return Object.assign(error, { code: signal ? 'AUDIO_PROCESS_TERMINATED' : 'AUDIO_CONVERSION_FAILED', exitCode: code, signal });
}
