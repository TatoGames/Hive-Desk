import { useState } from 'react'
import type { Snapshot } from '@shared/types'
import { ACCESS_LABEL, MCP_PRESETS, SUGGESTED_SITES, type ExtAccess, type ExtConnection, type ExtView } from '@shared/external'
import { fmtTime } from '../store'

type Conn = ExtView['connections'][number]

const OUTCOME: Record<string, string> = {
  allowed: '허용',
  denied: '거부',
  approved: '승인',
  edited: '고쳐서 승인',
  rejected: '거절',
  timeout: '시간 초과',
  auto: '자동'
}

/** Who may use one connection: every employee of the company (and every rank), none / read / write with or without approval. */
function AccessTable({ snap, c }: { snap: Snapshot; c: Conn }): JSX.Element {
  const levels: ExtAccess[] = c.kind === 'web' ? ['none', 'read'] : ['none', 'read', 'write-approve', 'write-auto']
  const ranks = snap.company.company?.ranks ?? []
  const set = (key: string, a: ExtAccess): void => void window.hive.setConnectionAccess(c.id, key, a)
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>누가</th>
          <th>AI</th>
          <th>권한</th>
        </tr>
      </thead>
      <tbody>
        {ranks.map((r) => (
          <tr key={'r' + r.id}>
            <td>
              직급: <b>{r.name}</b> <span className="muted small">(직원별 설정이 없으면 이 값)</span>
            </td>
            <td>—</td>
            <td>
              <select value={c.access[`rank:${r.id}`] ?? 'none'} onChange={(e) => set(`rank:${r.id}`, e.target.value as ExtAccess)}>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {ACCESS_LABEL[l]}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
        {snap.roster.map((r) => {
          const own = c.access[`agent:${r.id}`]
          const viaRank = !own && r.rankId ? c.access[`rank:${r.rankId}`] : undefined
          return (
            <tr key={r.id} className={r.adapter === 'claude' ? '' : 'faint'}>
              <td>
                {r.name} <span className="muted small">{r.owner}</span>
              </td>
              <td>{r.adapter}</td>
              <td>
                <select value={own ?? 'none'} onChange={(e) => set(`agent:${r.id}`, e.target.value as ExtAccess)}>
                  {levels.map((l) => (
                    <option key={l} value={l}>
                      {l === 'none' && viaRank ? `직급대로 (${ACCESS_LABEL[viaRank]})` : ACCESS_LABEL[l]}
                    </option>
                  ))}
                </select>
                {r.adapter !== 'claude' && <div className="muted small">지금은 Claude 직원만 직접 써요. 이 직원은 앱이 대신 읽어 준 웹페이지만 봐요.</div>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function WebCard({ snap, c }: { snap: Snapshot; c?: Conn }): JSX.Element {
  const [site, setSite] = useState('')
  if (!c) {
    return (
      <section className="panel">
        <h2>웹 (읽기만)</h2>
        <p className="muted small">AI가 웹을 검색하거나 정한 사이트의 페이지를 읽게 해요. 글 올리기, 폼 제출, 로그인한 사이트 조작은 하지 않아요.</p>
        <button className="primary" onClick={() => void window.hive.saveConnection({ kind: 'web', name: '웹', web: { search: false, fetch: false, sites: [] } })}>
          웹 연결 만들기
        </button>
      </section>
    )
  }
  const w = c.web!
  const save = (patch: Partial<NonNullable<ExtConnection['web']>>): void => void window.hive.saveConnection({ ...c, web: { ...w, ...patch } })
  const add = (s: string): void => {
    if (!s.trim()) return
    save({ sites: [...w.sites, s.trim()] })
    setSite('')
  }
  return (
    <section className="panel">
      <div className="row between">
        <h2>웹 (읽기만)</h2>
        <span className={'tag' + (w.search || w.fetch ? '' : ' warn')}>{w.search || w.fetch ? '켜짐' : '꺼짐'}</span>
      </div>
      <div className="row">
        <label>
          <input type="checkbox" checked={w.search} onChange={(e) => save({ search: e.target.checked })} /> 웹 검색
        </label>
        <label>
          <input type="checkbox" checked={w.fetch} onChange={(e) => save({ fetch: e.target.checked })} /> 웹페이지 읽기
        </label>
      </div>
      <h3>허용 사이트</h3>
      <p className="muted small">이 사이트(와 그 하위 주소)는 묻지 않고 읽어요. 목록 밖의 사이트는 실행 중에 결재함으로 물어보고, 승인할 때 [항상 허용]을 고를 수 있어요.</p>
      <div className="chips">
        {w.sites.map((s) => (
          <span key={s} className="chip">
            {s}{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), save({ sites: w.sites.filter((x) => x !== s) }))}>
              ✕
            </a>
          </span>
        ))}
        {!w.sites.length && <span className="muted small">아직 없어요.</span>}
      </div>
      <div className="row">
        <input placeholder="docs.godotengine.org" value={site} onChange={(e) => setSite(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(site)} />
        <button onClick={() => add(site)}>추가</button>
      </div>
      <div className="row small">
        추천:
        {SUGGESTED_SITES.filter((s) => !w.sites.includes(s)).map((s) => (
          <button key={s} className="sm ghost" onClick={() => add(s)}>
            + {s}
          </button>
        ))}
      </div>
      <p className="muted small">
        웹 내용은 자료일 뿐 지시가 아니라고 AI에게 알려 줘요. 웹을 읽은 실행에서는 다른 앱에 쓰는 일이 &apos;쓰기(자동)&apos;여도 결재로 바뀌어요. 업무 상세에서 주소를 붙이면 앱이 직접
        페이지를 읽어 첨부해 줘서 어떤 AI든 볼 수 있어요.
      </p>
      <h3>누가 쓸 수 있나요</h3>
      <AccessTable snap={snap} c={c} />
      <div className="row end">
        <button className="sm danger" onClick={() => confirm('웹 연결을 지울까요?') && void window.hive.deleteConnection(c.id)}>
          연결 지우기
        </button>
      </div>
    </section>
  )
}

function GithubCard({ snap, c }: { snap: Snapshot; c?: Conn }): JSX.Element {
  const gh = snap.ext.gh
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [label, setLabel] = useState(c?.github?.issueLabel ?? '')
  const [log, setLog] = useState('')
  const run = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(key)
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <section className="panel">
      <div className="row between">
        <h2>GitHub</h2>
        <span className={'tag' + (gh?.loggedIn ? '' : ' warn')}>{!gh ? '확인 전' : gh.loggedIn ? '로그인됨' : gh.found ? '로그인 필요' : 'gh 없음'}</span>
      </div>
      <div className="muted small">{gh ? `${gh.message} (확인: ${fmtTime(gh.at)})` : '각자 `gh auth login`으로 로그인해요. 무료 계정으로 충분해요.'}</div>
      <div className="row">
        {gh && !gh.found && (
          <button
            className="primary"
            disabled={busy === 'install'}
            onClick={() =>
              void run('install', async () => {
                const r = await window.hive.installGh()
                setLog(r.ok ? '' : r.log)
                return r.message
              })
            }
          >
            {busy === 'install' ? '설치 중… (1~2분)' : 'GitHub CLI 설치'}
          </button>
        )}
        {gh?.found && !gh.loggedIn && (
          <button className="primary" onClick={() => void run('login', async () => (await window.hive.ghLogin()).message)}>
            GitHub 로그인
          </button>
        )}
        <button disabled={busy === 'check'} onClick={() => void run('check', async () => (await window.hive.checkGithub()).message)}>
          {busy === 'check' ? '확인 중…' : '로그인 확인'}
        </button>
        {!c && (
          <button className="primary" onClick={() => void window.hive.saveConnection({ kind: 'github', name: 'GitHub', github: { autoPr: true } })}>
            GitHub 연결 만들기
          </button>
        )}
        {c && (
          <button disabled={busy === 'poll'} onClick={() => void run('poll', async () => { const r = await window.hive.githubPoll(); return `이슈 ${r.imported}건을 가져오고 PR ${r.updated}건을 새로 고쳤어요.` })}>
            {busy === 'poll' ? '확인 중…' : '지금 GitHub 확인'}
          </button>
        )}
      </div>
      {msg && <div className="small">{msg}</div>}
      {log && <pre className="out small-log">{log}</pre>}
      {c && (
        <>
          <p className="muted small">
            git·GitHub 작업은 AI가 아니라 앱이 직접 해요 (AI에게는 push와 gh를 막아요). 프로젝트에 저장소를 지정하면 그 프로젝트의 업무는 <code>hive/업무-이름</code> 브랜치에서
            실행하고 끝날 때마다 보고서를 커밋 메시지로 커밋해요. 기본 브랜치(main)에는 직접 올리지 않아요.
          </p>
          <label className="small">
            <input type="checkbox" checked={c.github?.autoPr !== false} onChange={(e) => void window.hive.saveConnection({ ...c, github: { ...c.github!, autoPr: e.target.checked } })} /> 사람
            확인을 통과하면 결재 없이 브랜치를 올리고 PR 만들기 (머지는 항상 결재)
          </label>
          <div className="row">
            <span className="small">이 라벨이 붙은 이슈를 업무로 가져오기</span>
            <input placeholder="hive" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button onClick={() => void window.hive.saveConnection({ ...c, github: { ...c.github!, issueLabel: label.trim() || undefined } })}>저장</button>
          </div>
          <h3>프로젝트 저장소</h3>
          <ProjectRepos snap={snap} />
          <div className="row end">
            <button className="sm danger" onClick={() => confirm('GitHub 연결을 지울까요? (저장소와 PR은 그대로예요)') && void window.hive.deleteConnection(c.id)}>
              연결 지우기
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function ProjectRepos({ snap }: { snap: Snapshot }): JSX.Element {
  const [edit, setEdit] = useState<Record<string, { repo: string; base: string }>>({})
  const [err, setErr] = useState('')
  if (!snap.projects.length) return <div className="muted small">프로젝트가 없어요. 프로젝트 탭에서 만든 뒤 저장소를 지정하세요.</div>
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>프로젝트</th>
          <th>저장소 (owner/repo)</th>
          <th>기본 브랜치</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {snap.projects.map((p) => {
          const v = edit[p.id] ?? { repo: p.github?.repo ?? '', base: p.github?.base ?? 'main' }
          const set = (patch: Partial<typeof v>): void => setEdit({ ...edit, [p.id]: { ...v, ...patch } })
          return (
            <tr key={p.id}>
              <td>
                {p.name}
                {!snap.projectPaths[p.id] && <div className="warn-text small">이 컴퓨터의 폴더가 지정되지 않았어요</div>}
              </td>
              <td>
                <input value={v.repo} placeholder="TatoGames/Hive-Desk" onChange={(e) => set({ repo: e.target.value })} />
              </td>
              <td>
                <input value={v.base} onChange={(e) => set({ base: e.target.value })} />
              </td>
              <td>
                <button
                  className="sm"
                  onClick={async () => {
                    setErr('')
                    try {
                      await window.hive.setProjectGithub(p.id, v.repo, v.base)
                    } catch (e) {
                      setErr((e as Error).message)
                    }
                  }}
                >
                  저장
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
      {err && (
        <tfoot>
          <tr>
            <td colSpan={4} className="warn-text small">
              {err}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

function AppCard({ snap, c }: { snap: Snapshot; c: Conn }): JSX.Element {
  const m = c.mcp!
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const preset = MCP_PRESETS.find((p) => p.id === m.preset)
  const run = async (key: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(key)
    setMsg('')
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <section className="panel">
      <div className="row between">
        <h2>{c.name}</h2>
        <span className={'tag' + (m.auth === 'token' && !c.hasSecret ? ' warn' : '')}>
          {m.auth === 'token' ? (c.hasSecret ? '로그인 정보 있음' : '토큰 필요') : '로그인 없음'} · 도구 {m.tools.length}개
        </span>
      </div>
      <div className="muted small">
        {m.transport === 'http' ? m.url : [m.command, ...(m.args ?? [])].join(' ')}
        {preset && <div>{preset.note}</div>}
      </div>
      {m.auth === 'token' && (
        <div className="row">
          <input type="password" placeholder={c.hasSecret ? '새 토큰으로 바꾸기' : '토큰 붙여 넣기'} value={token} onChange={(e) => setToken(e.target.value)} />
          <button
            disabled={!token.trim() || !snap.ext.secureStorage}
            onClick={() =>
              void run('token', async () => {
                await window.hive.setConnectionSecret(c.id, token)
                setToken('')
                return '이 컴퓨터의 보안 저장소에 저장했어요. 팀에는 공유되지 않아요.'
              })
            }
          >
            저장
          </button>
          {c.hasSecret && (
            <button className="ghost" onClick={() => void run('token', async () => (await window.hive.setConnectionSecret(c.id, null), '토큰을 지웠어요.'))}>
              토큰 지우기
            </button>
          )}
          {!snap.ext.secureStorage && <span className="warn-text small">이 컴퓨터는 보안 저장소를 쓸 수 없어서 토큰을 저장할 수 없어요.</span>}
        </div>
      )}
      <div className="row">
        <button disabled={busy === 'tools'} onClick={() => void run('tools', async () => (await window.hive.refreshMcpTools(c.id)).message)}>
          {busy === 'tools' ? '읽는 중…' : '도구 목록 읽기 (연결 확인)'}
        </button>
        {m.toolsAt && <span className="muted small">마지막으로 읽은 때 {fmtTime(m.toolsAt)}</span>}
      </div>
      {msg && <div className="small">{msg}</div>}
      {!!m.tools.length && (
        <details>
          <summary className="small">
            도구 {m.tools.length}개 · 쓰기 {m.tools.filter((t) => t.write).length}개 (읽기 전용 표시가 없는 도구는 쓰기로 봐요)
          </summary>
          <table className="tbl">
            <tbody>
              {m.tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                    {t.description && <div className="muted small">{t.description}</div>}
                  </td>
                  <td>
                    <select value={t.write ? 'w' : 'r'} onChange={(e) => void window.hive.setMcpToolWrite(c.id, t.name, e.target.value === 'w')}>
                      <option value="r">읽기</option>
                      <option value="w">쓰기</option>
                    </select>
                    {t.manual && <span className="muted small"> 직접 정함</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <h3>누가 쓸 수 있나요</h3>
      <AccessTable snap={snap} c={c} />
      <div className="row end">
        <button className="sm danger" onClick={() => confirm(`${c.name} 연결을 지울까요?`) && void window.hive.deleteConnection(c.id)}>
          연결 지우기
        </button>
      </div>
    </section>
  )
}

function AddApp({ onDone }: { onDone: () => void }): JSX.Element {
  const [preset, setPreset] = useState(MCP_PRESETS[0].id)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('http')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [tokenEnv, setTokenEnv] = useState('')
  const [auth, setAuth] = useState<'none' | 'token'>('none')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const p = MCP_PRESETS.find((x) => x.id === preset)
  const add = async (): Promise<void> => {
    setErr('')
    try {
      if (p) {
        await window.hive.saveConnection({
          kind: 'mcp',
          name: name.trim() || p.name,
          mcp: { preset: p.id, transport: p.transport, command: p.command, args: p.args, url: p.url, auth: p.auth, tokenEnv: p.tokenEnv, env: fields, tools: [] }
        })
      } else {
        const parts = command.trim().split(/\s+/).filter(Boolean)
        if (!name.trim()) throw new Error('이름을 적어 주세요.')
        await window.hive.saveConnection({
          kind: 'mcp',
          name: name.trim(),
          mcp: transport === 'http' ? { transport, url: url.trim(), auth, tools: [] } : { transport, command: parts[0], args: parts.slice(1), auth, tokenEnv: tokenEnv.trim() || undefined, tools: [] }
        })
      }
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <section className="panel">
      <h2>앱 추가 (MCP)</h2>
      <div className="row">
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {MCP_PRESETS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          <option value="">직접 입력</option>
        </select>
        <input placeholder={p ? p.name : '이름'} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {p ? (
        <>
          <p className="muted small">{p.note}</p>
          {Object.entries(p.fields ?? {}).map(([k, label]) => (
            <div key={k} className="row">
              <span className="small">{label}</span>
              <input value={fields[k] ?? ''} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="row">
            <select value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
              <option value="http">원격 서버 (URL)</option>
              <option value="stdio">로컬 서버 (명령)</option>
            </select>
            {transport === 'http' ? (
              <input placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
            ) : (
              <input placeholder="npx -y some-mcp-server" value={command} onChange={(e) => setCommand(e.target.value)} />
            )}
          </div>
          <div className="row">
            <select value={auth} onChange={(e) => setAuth(e.target.value as 'none' | 'token')}>
              <option value="none">로그인 없음</option>
              <option value="token">토큰</option>
            </select>
            {auth === 'token' && transport === 'stdio' && <input placeholder="토큰을 넣을 환경 변수 (예: API_TOKEN)" value={tokenEnv} onChange={(e) => setTokenEnv(e.target.value)} />}
            {auth === 'token' && transport === 'http' && <span className="muted small">토큰은 Authorization: Bearer 헤더로 보내요.</span>}
          </div>
          <p className="muted small">OAuth 로그인만 되는 서버는 아직 연결할 수 없어요 (AI가 화면 없이 실행돼서 로그인 창을 띄울 수 없어요). 토큰 방식을 쓰세요.</p>
        </>
      )}
      {err && <div className="warn-text small">{err}</div>}
      <div className="row end">
        <button onClick={onDone}>취소</button>
        <button className="primary" onClick={() => void add()}>
          추가
        </button>
      </div>
    </section>
  )
}

export default function External({ snap }: { snap: Snapshot }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const conns = snap.ext.connections
  const web = conns.find((c) => c.kind === 'web')
  const github = conns.find((c) => c.kind === 'github')
  const apps = conns.filter((c) => c.kind === 'mcp')
  const name = (id: string): string => snap.roster.find((r) => r.id === id)?.name ?? (id === 'app' ? '앱' : id)
  const task = (id: string): string => snap.tasks.find((t) => t.id === id)?.title ?? ''
  return (
    <div className="page">
      <header className="page-head">
        <h1>외부 연결</h1>
      </header>
      <p className="muted">
        웹(읽기만), GitHub, 다른 앱(MCP)을 이 회사에 연결해요. 연결을 만들어도 직원에게 권한을 주기 전에는 아무도 못 써요. 다른 회사의 AI에게는 보이지도 않아요. 외부에 쓰는
        일은 기본으로 실행 도중 결재함에서 물어봐요. 로그인 정보(토큰)는 이 컴퓨터의 보안 저장소에만 두고 팀에는 &ldquo;어떤 연결을 쓰는지&rdquo;만 공유돼요.
      </p>
      <WebCard snap={snap} c={web} />
      <GithubCard snap={snap} c={github} />
      <h2 className="sec">다른 앱 (MCP)</h2>
      {apps.map((c) => (
        <AppCard key={c.id} snap={snap} c={c} />
      ))}
      {adding ? (
        <AddApp onDone={() => setAdding(false)} />
      ) : (
        <div className="row" style={{ marginBottom: 14 }}>
          <button onClick={() => setAdding(true)}>+ 앱 추가</button>
        </div>
      )}
      <section className="panel">
        <h2>기록</h2>
        <p className="muted small">AI와 앱이 외부 연결로 읽고 쓴 것, 거절된 것까지 모두 남아요. 외부에 한 일은 HiveDesk의 되돌리기로 되돌릴 수 없어요.</p>
        {!snap.ext.log.length && <div className="empty">아직 기록이 없어요.</div>}
        {!!snap.ext.log.length && (
          <table className="tbl">
            <thead>
              <tr>
                <th>내용</th>
                <th>시각</th>
                <th>연결</th>
                <th>누가</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {snap.ext.log.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.write && <span className="tag warn">쓰기</span>}
                    {e.summary}
                    {task(e.taskId) && <div className="muted small">{task(e.taskId)}</div>}
                    {e.reason && <div className="muted small">{e.reason}</div>}
                  </td>
                  <td>{fmtTime(e.at)}</td>
                  <td>{e.connectionName}</td>
                  <td>
                    {name(e.agentId)}
                    {e.by && e.by !== name(e.agentId) && <div className="muted small">결정: {e.by}</div>}
                  </td>
                  <td>{OUTCOME[e.outcome] ?? e.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
