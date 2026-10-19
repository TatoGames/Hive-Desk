import { useCallback, useEffect, useState } from 'react'
import type { EngineStatus } from '../../../main/ollamaEngine'
import { ConfirmButton } from './Materials'

const fmt = (n?: number): string => (n ? (n >= 1e9 ? (n / 1e9).toFixed(1) + 'GB' : Math.round(n / 1e6) + 'MB') : '용량 미확인')
const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** HiveDesk's own Ollama: downloaded into the HiveDesk folder (no installer), started and stopped from here. */
export default function OllamaEngineCard({ onChanged }: { onChanged?: () => void }): JSX.Element | null {
  const [st, setSt] = useState<EngineStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => setSt(await window.hive.localEngineStatus()), [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    let timer: number | undefined
    const off = window.hive.onEvent((e) => {
      if (e.type !== 'local' || timer) return
      timer = window.setTimeout(() => {
        timer = undefined
        void load()
      }, 200)
    })
    return () => {
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [load])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setErr(clean(e as Error))
    } finally {
      setBusy(false)
      await load()
      onChanged?.()
    }
  }

  if (!st) return null
  const job = st.job
  const working = job?.state === 'downloading' || job?.state === 'verifying' || job?.state === 'extracting'
  const failure = err ?? st.lastError ?? (job?.state === 'failed' ? job.error : undefined)

  return (
    <div className="local-ep ollama-engine">
      <div className="row">
        <b>HiveDesk 전용 Ollama</b>
        {st.installed && <span className="chip">{`설치됨 · ${st.installedVersion}`}</span>}
        {st.running && <span className="chip ok">{`켜져 있어요 · 포트 ${st.port}`}</span>}
      </div>

      {!st.installed && (
        <>
          <p className="muted small">
            설치 프로그램 없이 HiveDesk 폴더({st.engineDir})에 Ollama를 직접 받아요. 모델도 그 옆({st.modelsDir})에 저장돼요. 이미 있는 <code>~/.ollama</code>는 건드리지 않아요.
          </p>
          <ul className="muted small">
            <li>용량이 커요: 이 PC용은 약 {fmt(st.sizeBytes)}예요{st.host ? ` (${st.host}에서 받아요)` : ''}.</li>
            <li>받은 파일은 sha256이 맞을 때만 풀고 실행해요. 그래도 백신이 새 실행 파일을 검사하느라 느려지거나 잘못 의심할 수 있어요.</li>
            <li>macOS는 처음 실행할 때 보안 경고를 띄울 수 있어요. 막히면 나오는 메시지를 그대로 보여 드려요.</li>
          </ul>
        </>
      )}

      {st.foreignOnDefaultPort && !st.running && (
        <p className="small">
          이미 Ollama가 켜져 있어요(포트 {st.defaultPort}). 그걸 그대로 쓰거나(위의 Ollama 버튼), HiveDesk 전용으로 따로 받을 수 있어요. 따로 켜면 다른 포트를 써요.
        </p>
      )}

      {st.unavailable && !st.installed && <div className="warn-text small">{st.unavailable}</div>}

      <div className="row">
        {!st.installed && !working && (
          <button className="primary" disabled={busy || !!st.unavailable} onClick={() => void act(() => window.hive.localEngineInstall())}>
            {`HiveDesk에 Ollama 설치하기 (약 ${fmt(st.sizeBytes)})`}
          </button>
        )}
        {working && (
          <button className="sm ghost" onClick={() => void window.hive.localEngineCancel()}>
            중지
          </button>
        )}
        {st.installed && !st.running && (
          <button className="primary" disabled={busy} onClick={() => void act(() => window.hive.localEngineStart())}>
            {busy ? '켜는 중…' : '시작'}
          </button>
        )}
        {st.running && (
          <button className="sm" disabled={busy} onClick={() => void act(() => window.hive.localEngineStop())}>
            중지
          </button>
        )}
        {st.installed && !working && !busy && <ConfirmButton label="엔진 지우기" onConfirm={() => act(() => window.hive.localEngineRemove())} />}
      </div>

      {job && job.state !== 'failed' && (
        <div className="small">
          {job.text}
          {working && job.fraction !== undefined && <progress value={job.fraction} max={1} style={{ marginLeft: 8 }} />}
        </div>
      )}
      {st.running && st.portNote && <div className="small">{st.portNote}</div>}
      {st.installed && (
        <div className="muted small">
          엔진만 지워져요. 모델은 {st.modelsDir}에 남아요 — 개별 삭제는 아래 모델의 지우기를 쓰거나 그 폴더를 직접 지워 주세요.
        </div>
      )}
      {failure && (
        <div className="warn-text small" style={{ whiteSpace: 'pre-wrap' }}>
          {failure}
          {st.installed && !st.running && /EACCES|EPERM|damaged|quarantine|허용|Operation not permitted|꺼졌/i.test(failure)
            ? '\nmacOS가 막은 것이라면 시스템 설정 → 개인정보 보호 및 보안에서 허용할 수 있어요. 위 메시지가 실제 원인이에요.'
            : ''}
        </div>
      )}
    </div>
  )
}
