import { extname } from 'node:path'

const OFFICE = ['.xlsx', '.xls', '.xlsm', '.docx', '.doc', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.hwp', '.hwpx', '.pages', '.numbers', '.key']
const GAME = ['.unity', '.prefab', '.asset', '.mat', '.controller', '.anim', '.tscn', '.uasset', '.umap']
const BINARY = ['.psd', '.ai', '.blend', '.fbx', '.obj', '.glb', '.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.dmg', '.msi', '.dll', '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg']

/** A hint for formats the AI cannot open directly; `null` when the file is fine as it is (text, code, PDF, images). */
export function attachmentAdvice(name: string): string | null {
  const ext = extname(name).toLowerCase()
  if (['.xlsx', '.xls', '.xlsm', '.ods', '.numbers'].includes(ext)) {
    return `${name}: 엑셀 파일은 AI가 바로 읽지 못할 수 있어요. CSV나 PDF로 저장해서 함께 첨부하면 좋아요.`
  }
  if (OFFICE.includes(ext)) {
    return `${name}: 이 문서 형식은 AI가 바로 읽지 못할 수 있어요. PDF나 텍스트(.md/.txt)로 바꿔서 첨부하면 좋아요.`
  }
  if (GAME.includes(ext)) {
    return `${name}: 게임 엔진 씬·프리팹 파일은 매우 길고 복잡해요. 필요한 부분만 텍스트로 적거나 스크린샷을 함께 첨부하면 더 정확해요.`
  }
  if (BINARY.includes(ext)) {
    return `${name}: AI가 열 수 없는 형식이에요. 내용을 설명하는 텍스트나 스크린샷(이미지)을 함께 첨부해 주세요.`
  }
  return null
}
