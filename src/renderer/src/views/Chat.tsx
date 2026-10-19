import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot, Task } from '@shared/types'
import type { TaskDraft } from '@shared/chatTask'
import { TIER_LABEL } from '@shared/company'
import { sameModel, type Chat as ChatT, type ChatMessage, type ChatModel, type ChatSummary } from '@shared/chat'
import type { ChatModelInfo } from '../../../main/chat'
import { fmtTime } from '../store'
import { Hint } from './Help'
import { ConfirmButton } from './Materials'

const modelId = (m: ChatModel): string => (m.kind === 'cli' ? `cli:${m.adapter}:${m.modelId}` : `local:${m.endpointId}:${m.model}`)

/** v6 챗: a plain conversation with a model you pick. It never changes files; a change is handed to a task. */
export default function Chat({ snap, openId, goConnections, goBoard }: { snap: Snapshot; openId?: string | null; goConnections: () => void; goBoard?: () => void }): JSX.Element {
  const [list, setList] = useState<ChatSummary[]>([])
  const [models, setModels] = useState<ChatModelInfo[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatT | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  /** A model change that costs much more against the limit, waiting for a yes. */
  const [ask, setAsk] = useState<{ model: ChatModel; label: string; factor: number; retry: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  /** 챗-2: the draft of a task from this conversation (`ids` = the picked messages), waiting for the person. */
  const [draft, setDraft] = useState<{ ids?: string[] } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // another screen sent the person here ("이 업무에 대해 물어보기")
  useEffect(() => {
    if (openId) setSel(openId)
  }, [openId])

  const load = useCallback(async (id: string | null) => {
    const [l, m] = await Promise.all([window.hive.chatList(), window.hive.chatModels()])
    setList(l)
    setModels(m)
    if (id) setChat(await window.hive.chatGet(id))
  }, [])

  useEffect(() => {
    void load(sel)
    // models of this PC: ask the engines what they have now
    void window.hive.localRefresh().then(() => load(sel))
  }, [load, sel, snap.company.company?.name])

  // the answer comes in while it is written: read the conversation again on each change
  useEffect(() => {
    let timer: number | undefined
    const off = window.hive.onEvent((e) => {
      if (e.type !== 'chat') return
      if (timer) return
      timer = window.setTimeout(() => {
        timer = undefined
        void load(sel)
      }, 120)
    })
    return () => {
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [load, sel])

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' })
  }, [chat?.messages.length, chat?.messages[chat.messages.length - 1]?.text])

  const info = (m: ChatModel): ChatModelInfo | undefined => models.find((x) => sameModel(x.model, m))
  const running = !!chat?.messages.some((m) => m.status === 'streaming')

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const newChat = async (model?: ChatModel): Promise<ChatT | null> => {
    let made: ChatT | null = null
    await run(async () => {
      made = await window.hive.chatCreate(model ? { model } : undefined)
      setSel(made.id)
      setChat(made)
      await load(made.id)
    })
    return made
  }

  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    let id = sel
    if (!id) {
      const made = await newChat()
      if (!made) return
      id = made.id
    }
    setText('')
    // the call returns when the answer is complete; the screen follows through the events
    void run(async () => {
      await window.hive.chatSend(id!, t)
      await load(id)
    })
    window.setTimeout(() => void load(id), 60)
  }

  const changeModel = async (model: ChatModel, retry = false): Promise<void> => {
    if (!chat) return
    const label = info(model)?.label ?? ''
    const c = await window.hive.chatCostOfChange(chat.id, model)
    if (c.confirmAt > 0 && c.factor >= c.confirmAt) return setAsk({ model, label, factor: c.factor, retry })
    await applyModel(model, retry)
  }

  const applyModel = async (model: ChatModel, retry: boolean): Promise<void> => {
    if (!chat) return
    setAsk(null)
    await run(async () => {
      if (retry) {
        const id = chat.id
        void window.hive.chatRetry(id, model).then(() => load(id))
        window.setTimeout(() => void load(id), 60)
      } else {
        setChat(await window.hive.chatSetModel(chat.id, model))
        await load(chat.id)
      }
    })
  }

  const alternatives = models.filter((m) => m.ok && !m.limitUntil && chat && !sameModel(m.model, chat.model)).slice(0, 4)
  const noModels = models.length === 0

  return (
    <div className="page chat-page">
      <header className="page-head">
        <h1>챗</h1>
        <button className="primary" onClick={() => void newChat()} disabled={noModels}>
          + 새 대화
        </button>
      </header>
      <Hint id="chat">
        AI와 바로 대화하는 곳이에요. 위에서 <b>모델</b>을 고르고 물어보세요. 챗은 <b>파일을 바꾸지 않아요</b> — 바꿔야 하면 업무로 맡기세요. 대화는 이 컴퓨터에만 저장돼요.
      </Hint>
      {noModels && (
        <div className="panel empty">
          쓸 수 있는 AI가 없어요. AI 연결에서 로그인하고 연결 확인을 눌러 주세요.{' '}
          <button className="sm" onClick={goConnections}>
            AI 연결로 가기
          </button>
        </div>
      )}
      {!noModels && (
        <div className="chat-grid">
          <aside className="chat-list">
            {!list.length && <div className="muted small">아직 대화가 없어요.</div>}
            {list.map((c) => (
              <button key={c.id} className={'chat-item' + (sel === c.id ? ' on' : '')} onClick={() => (setSel(c.id), setAsk(null), setErr(null))}>
                <b>{c.title}</b>
                <span className="muted small">
                  {c.streaming ? '답을 쓰는 중…' : c.last || '비어 있어요'} · {fmtTime(c.updatedAt)}
                </span>
              </button>
            ))}
          </aside>

          <section className="chat-main">
            {chat && (
              <div className="chat-bar">
                {renaming !== null ? (
                  <input
                    autoFocus
                    value={renaming}
                    onChange={(e) => setRenaming(e.target.value)}
                    onBlur={() => (void window.hive.chatRename(chat.id, renaming).then(() => load(chat.id)), setRenaming(null))}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <b className="chat-title" title="눌러서 이름 바꾸기" onClick={() => setRenaming(chat.title)}>
                    {chat.title}
                  </b>
                )}
                <div className="row">
                  <button className="sm" title="이 대화에서 업무 초안을 만들어요. 확인하기 전에는 아무것도 맡기지 않아요" onClick={() => setDraft({})}>
                    이 대화로 업무 만들기
                  </button>
                  <button
                    className="sm"
                    title="이 폴더를 읽기만 하면서 답해요"
                    onClick={async () => {
                      const p = await window.hive.pickFolder()
                      if (p) {
                        await window.hive.chatSetFolders(chat.id, [...new Set([...chat.folderRefs, p])])
                        await load(chat.id)
                      }
                    }}
                  >
                    📂 폴더 참고
                  </button>
                  <button className="sm" onClick={() => void window.hive.chatExport(chat.id)}>
                    내보내기
                  </button>
                  <ConfirmButton label="삭제" onConfirm={async () => (await window.hive.chatDelete(chat.id), setSel(null), setChat(null), await load(null))} />
                </div>
              </div>
            )}

            <div className="chat-model row">
              <label className="small">
                모델{' '}
                <select
                  value={chat ? modelId(chat.model) : models[0] ? modelId(models[0].model) : ''}
                  disabled={running}
                  onChange={(e) => {
                    const m = models.find((x) => modelId(x.model) === e.target.value)
                    if (!m) return
                    if (chat) void changeModel(m.model)
                  }}
                >
                  {models.map((m) => (
                    <option key={modelId(m.model)} value={modelId(m.model)}>
                      {m.label} · {TIER_LABEL[m.tier]}
                      {m.where === 'local' ? ' · 내 PC' : ''}
                      {m.fit ? ` · ${m.fit}` : ''}
                      {m.limitUntil ? ' · 한도' : ''}
                      {!m.ok ? ' · 확인 전' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {chat && info(chat.model)?.speed && <span className="muted small">⏱ {info(chat.model)!.speed}</span>}
              {chat && info(chat.model)?.note && <span className="muted small">⚠ {info(chat.model)!.note}</span>}
              {chat?.folderRefs.map((f) => (
                <span key={f} className="chip" title={f}>
                  📂 {f.split(/[\\/]/).pop()}{' '}
                  <button className="x" aria-label="폴더 빼기" onClick={() => void window.hive.chatSetFolders(chat.id, chat.folderRefs.filter((x) => x !== f)).then(() => load(chat.id))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            {ask && (
              <div className="chat-ask small">
                {ask.label}은(는) 지금 모델보다 한도를 약 {ask.factor.toFixed(1)}배 더 써요. {ask.retry ? '이 모델로 다시 보낼까요?' : '바꿀까요?'}{' '}
                <button className="sm primary" onClick={() => void applyModel(ask.model, ask.retry)}>
                  {ask.retry ? '다시 보내기' : '바꾸기'}
                </button>{' '}
                <button className="sm ghost" onClick={() => setAsk(null)}>
                  취소
                </button>
              </div>
            )}

            <div className="chat-msgs">
              {!chat && <div className="muted chat-empty">모델을 고르고 아래에 질문을 적어 보세요. 첫 질문을 보내면 새 대화가 만들어져요.</div>}
              {chat?.messages.map((m) => (
                <Message
                  key={m.id}
                  m={m}
                  label={m.model ? info(m.model)?.label : undefined}
                  alternatives={alternatives}
                  onMakeTask={m.role === 'user' ? () => setDraft({ ids: [m.id] }) : undefined}
                  onRetry={(model) => (model ? void changeModel(model, true) : void run(async () => { void window.hive.chatRetry(chat.id).then(() => load(chat.id)); window.setTimeout(() => void load(chat.id), 60) }))}
                />
              ))}
              <div ref={bottom} />
            </div>
            {err && <div className="warn-text small">{err}</div>}
            {draft && chat && (
              <DraftDialog
                snap={snap}
                chat={chat}
                ids={draft.ids}
                onClose={() => setDraft(null)}
                onMade={() => void load(chat.id)}
                goBoard={goBoard}
              />
            )}
            <div className="chat-input">
              <textarea
                rows={3}
                placeholder="질문을 적고 Enter로 보내요 (줄바꿈은 Shift+Enter)"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              {running ? (
                <button className="danger" onClick={() => chat && void window.hive.chatStop(chat.id)}>
                  중지
                </button>
              ) : (
                <button className="primary" disabled={!text.trim()} onClick={() => void send()}>
                  보내기
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Message({ m, label, alternatives, onRetry, onMakeTask }: { m: ChatMessage; label?: string; alternatives: ChatModelInfo[]; onRetry: (model?: ChatModel) => void; onMakeTask?: () => void }): JSX.Element {
  if (m.role === 'system') return <div className="chat-mark">── {m.text} ──</div>
  const mine = m.role === 'user'
  return (
    <div className={'chat-msg ' + (mine ? 'me' : 'ai')}>
      {!mine && label && <div className="muted small">{label}</div>}
      <div className={'chat-bubble' + (m.status === 'failed' || m.status === 'limit' ? ' bad' : '')}>
        {m.text || (m.status === 'streaming' ? '…' : '')}
        {m.status === 'streaming' && m.text && <span className="chat-caret">▍</span>}
      </div>
      {onMakeTask && (
        <div>
          <button className="sm ghost" onClick={onMakeTask}>
            이 메시지로 업무 만들기
          </button>
        </div>
      )}
      {m.status === 'stopped' && <div className="muted small">중지했어요.</div>}
      {m.status === 'failed' && (
        <div className="small">
          <span className="warn-text">{m.error ?? '답을 받지 못했어요.'}</span>{' '}
          <button className="sm" onClick={() => onRetry()}>
            다시 보내기
          </button>
        </div>
      )}
      {m.status === 'limit' && (
        <div className="small">
          <span className="warn-text">
            이 모델은 사용 한도예요{m.limitUntil ? ` (${new Date(m.limitUntil).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}쯤 풀려요)` : ''}. 다른 모델로 이어서 보낼까요?
          </span>{' '}
          {alternatives.map((a) => (
            <button key={modelId(a.model)} className="sm" onClick={() => onRetry(a.model)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 챗-2: the task draft. The app fills it by rules from the conversation (no AI); the person edits it and presses
 * "이 내용으로 맡길게요" — only then a task is made. Nothing is handed over before that.
 */
function DraftDialog({ snap, chat, ids, onClose, onMade, goBoard }: { snap: Snapshot; chat: ChatT; ids?: string[]; onClose: () => void; onMade: () => void; goBoard?: () => void }): JSX.Element {
  const [base, setBase] = useState<(TaskDraft & { projectId?: string; folders: string[] }) | null>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [project, setProject] = useState('')
  const [agent, setAgent] = useState('')
  const [withFolders, setWithFolders] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [made, setMade] = useState<Task | null>(null)
  const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  useEffect(() => {
    let alive = true
    void window.hive.chatTaskDraft(chat.id, ids).then((d) => {
      if (!alive) return
      setBase(d)
      setTitle(d.title)
      setDesc(d.description)
      setProject(d.projectId ?? '')
    })
    return () => {
      alive = false
    }
  }, [chat.id, ids])

  const polish = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.hive.chatPolishDraft(chat.id, { title, description: desc, empty: false })
      setTitle(r.title)
      setDesc(r.description)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      setMade(
        await window.hive.chatMakeTask(chat.id, {
          confirmed: true,
          title,
          description: desc,
          projectId: project || undefined,
          agentId: agent || undefined,
          refDirs: withFolders && base ? base.folders : undefined
        })
      )
      onMade()
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="업무 초안" onClick={(e) => e.stopPropagation()}>
        {made ? (
          <>
            <h2>업무를 맡겼어요</h2>
            <p className="small">"{made.title}" 업무가 보드에 올라갔어요. 챗에서 만든 업무라고 기록에 남겨요.</p>
            <div className="row end">
              {goBoard && (
                <button className="primary" onClick={() => (onClose(), goBoard())}>
                  보드 보기
                </button>
              )}
              <button onClick={onClose}>닫기</button>
            </div>
          </>
        ) : (
          <>
            <h2>업무 초안</h2>
            {!base && <p className="muted small">초안을 만드는 중이에요…</p>}
            {base?.empty && <p className="small">이 대화에는 업무로 만들 요청이 아직 없어요. 먼저 하고 싶은 일을 대화로 적어 주세요.</p>}
            {base && !base.empty && (
              <>
                <p className="muted small">대화에서 앱이 채운 초안이에요(AI를 쓰지 않았어요). 고친 뒤 맡기면 업무가 만들어져요. 맡기기 전에는 아무것도 실행되지 않아요.</p>
                <label className="small">
                  제목
                  <input className="grow" aria-label="업무 제목" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="small">
                  설명
                  <textarea rows={8} aria-label="업무 설명" value={desc} onChange={(e) => setDesc(e.target.value)} />
                </label>
                <div className="row">
                  <select aria-label="프로젝트" value={project} onChange={(e) => setProject(e.target.value)}>
                    <option value="">프로젝트 없음</option>
                    {snap.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select aria-label="담당" value={agent} onChange={(e) => setAgent(e.target.value)}>
                    <option value="">담당은 앱이 정해요</option>
                    {snap.roster.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.owner}
                      </option>
                    ))}
                  </select>
                </div>
                {!!base.folders.length && (
                  <label className="small row">
                    <input type="checkbox" checked={withFolders} onChange={(e) => setWithFolders(e.target.checked)} />
                    챗에서 참고한 폴더를 읽기용으로 붙이기 ({base.folders.map((f) => f.split(/[\\/]/).pop()).join(', ')})
                  </label>
                )}
              </>
            )}
            {err && <div className="warn-text small">{err}</div>}
            <div className="row end">
              <button className="ghost" onClick={onClose}>
                취소
              </button>
              {base && !base.empty && (
                <>
                  <button disabled={busy || !title.trim()} title="이 대화의 모델이 업무 문장으로 다듬어요(AI를 한 번 써요). 결과를 보고 고칠 수 있어요" onClick={() => void polish()}>
                    AI로 정리하기
                  </button>
                  <button className="primary" disabled={busy || !title.trim()} onClick={() => void confirm()}>
                    이 내용으로 맡길게요
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
