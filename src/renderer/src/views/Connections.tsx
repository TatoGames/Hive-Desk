import { Hint, Term } from './Help'
import { useEffect, useState } from 'react'
import type { AdapterInfo, Snapshot } from '@shared/types'
import type { ConnectionView, ModelAgentView } from '@shared/connections'
import { TIER_LABEL } from '@shared/company'
import { fmtTime } from '../store'
import LocalAi from './LocalAi'

const STATUS: Record<ModelAgentView['status'], string> = { ok: '✓ 쓸 수 있어요', unavailable: '✗ 쓸 수 없어요', unchecked: '확인 전' }

function Card({ info, view, snap }: { info?: AdapterInfo; view?: ConnectionView; snap: Snapshot }): JSX.Element {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const adapter = (info?.id ?? view?.adapter)!
  const run = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(key)
    try {
      setMsg(await fn())
    } finally {
      setBusy('')
    }
  }
  const name = (id: string): string => snap.companies.find((c) => c.id === id)?.name ?? id
  const move = (i: number, d: number): void => {
    if (!view) return
    const o = [...view.order]
    const j = i + d
    if (j < 0 || j >= o.length) return
    ;[o[i], o[j]] = [o[j], o[i]]
    void window.hive.setCompanyOrder(o, adapter)
  }
  return (
    <section className="panel">
      <div className="row between">
        <h2>{info?.label ?? adapter}</h2>
        <span className={'tag' + (view?.check?.ok ? '' : ' warn')}>
          {view?.check ? (view.check.ok ? '연결됨' : '연결 안 됨') : info?.found ? '확인 전' : '설치 안 됨'}
        </span>
      </div>
      {view?.check && (
        <div className="muted small">
          마지막 확인 {fmtTime(view.check.at)} — {view.check.message}
        </div>
      )}
      {view?.limit && <div className="warn-text small">사용 한도에 걸렸어요 — {fmtTime(view.limit.until)}까지 쉬어요.</div>}
      <div className="row">
        <button disabled={busy === 'check'} onClick={() => void run('check', async () => (await window.hive.checkCli(adapter)).message)}>
          {busy === 'check' ? '확인 중…' : '연결 확인'}
        </button>
        {!info?.found && info?.canInstall && (
          <button disabled={busy === 'install'} onClick={() => void run('install', async () => (await window.hive.installCli(adapter)).message)}>
            설치
          </button>
        )}
        <button className="ghost" onClick={() => void window.hive.openLogin(adapter)}>
          로그인
        </button>
        {view?.canList && (
          <button className="ghost" disabled={busy === 'list'} onClick={() => void run('list', async () => (await window.hive.refreshAccountModels(adapter)).message)}>
            계정 모델 불러오기
          </button>
        )}
        {view && view.models.length > 0 && (
          <button className="ghost" disabled={busy === 'all'} onClick={() => void run('all', async () => {
            const r = await window.hive.verifyAllModels(adapter)
            return `${r.checked}개를 새로 확인했어요 (쓸 수 있는 모델 ${r.ok}개). 확인할 때마다 사용량이 조금 들어요.`
          })}>
            {busy === 'all' ? '모두 확인 중…' : '모든 모델 확인'}
          </button>
        )}
      </div>
      {msg && <div className="small">{msg}</div>}
      {view && (
        <>
          <table className="tbl">
            <thead>
              <tr>
                <th>모델 에이전트</th>
                <th>체급</th>
                <th>한도 무게</th>
                <th>이 계정</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.models.map((m) => (
                <tr key={m.id} draggable={m.status !== 'unavailable'} onDragStart={(e) => e.dataTransfer.setData('text/model-agent', m.id)}>
                  <td>
                    <b>{m.label}</b> {m.verified ? null : <span className="tag warn">미확인</span>}
                  </td>
                  <td>{TIER_LABEL[m.tier]}</td>
                  <td>{m.weight}</td>
                  <td className={m.status === 'unavailable' ? 'warn-text small' : 'small'}>
                    {STATUS[m.status]}
                    {m.status === 'unavailable' && m.message ? <div className="muted">{m.message.slice(0, 80)}</div> : null}
                  </td>
                  <td>
                    <button className="sm" disabled={m.status === 'unavailable'} onClick={() => void window.hive.hire({ modelAgentId: m.id })} title="지금 보고 있는 회사의 직원으로 채용해요">
                      채용
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {snap.companies.length > 1 && (
            <div className="small">
              <b>한도 우선순위</b> <span className="muted">(이 계정의 한도를 나눠 쓸 때, 한도에 한 번 걸린 뒤에는 위쪽 회사가 먼저 일해요)</span>
              {view.order.map((id, i) => (
                <div key={id} className="row">
                  <span>
                    {i + 1}. {name(id)}
                  </span>
                  <button className="sm ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button className="sm ghost" disabled={i === view.order.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default function Connections({ snap }: { snap: Snapshot }): JSX.Element {
  const [infos, setInfos] = useState<AdapterInfo[]>([])
  useEffect(() => {
    void window.hive.detectAdapters().then((l) => setInfos(l.filter((i) => i.id !== 'custom')))
  }, [])
  return (
    <div className="page">
      <header className="page-head">
        <h1>AI 연결</h1>
      </header>
      <Hint id="connections"><Term k="연결" />은 구독 계정마다 한 번만 하면 돼요. 연결 하나로 여러 <Term k="직원" />을 둘 수 있어요. 둘 이상 연결하면 서로 검토하고, <Term k="한도" />가 차면 <Term k="이어받기" />를 해요.</Hint>
      <p className="muted small">
        연결 = AI 프로그램 + 내 계정이에요. 연결이 확인되면 쓸 수 있는 모델마다 <b>모델 에이전트</b>가 하나씩 만들어져요. 모델 에이전트를
        <b> 채용</b>하면 지금 보고 있는 회사의 직원이 되고(회사마다 따로, 역할·메모리·대화가 분리돼요), 회사 탭에서 자리에 끌어다 놓을 수도 있어요.
      </p>
      {infos.map((i) => (
        <Card key={i.id} info={i} view={snap.connections.find((c) => c.adapter === i.id)} snap={snap} />
      ))}
      <LocalAi />
    </div>
  )
}
