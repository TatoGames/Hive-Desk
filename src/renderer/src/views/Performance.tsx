import { useEffect, useMemo, useState } from 'react'
import type { Snapshot } from '@shared/types'
import { performance, type PerfRow } from '@shared/performance'

function Table({ title, rows, showLoad }: { title: string; rows: PerfRow[]; showLoad?: boolean }): JSX.Element {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {!rows.length ? (
        <div className="empty">기록이 없어요.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>이름</th>
              <th>업무</th>
              <th>완료</th>
              <th>실패</th>
              <th>통과</th>
              <th>수정 요청</th>
              {showLoad && <th>AI 실행</th>}
              {showLoad && <th>시간(분)</th>}
              {showLoad && <th>한도 사용량</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{r.tasks}</td>
                <td>{r.done}</td>
                <td>{r.failed}</td>
                <td>{r.passed}</td>
                <td>{r.changeRounds}</td>
                {showLoad && <td>{r.runs}</td>}
                {showLoad && <td>{r.minutes}</td>}
                {showLoad && <td>{r.load}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default function Performance({ snap }: { snap: Snapshot }): JSX.Element {
  const p = useMemo(
    () =>
      performance({
        tasks: snap.tasks,
        aptitude: snap.company.aptitude,
        catalog: snap.company.catalog,
        agents: Object.fromEntries(
          snap.roster.map((r) => [r.id, { name: r.name, unitId: snap.company.seats.find((s) => s.agentId === r.id)?.unitId }])
        ),
        units: Object.fromEntries(snap.company.units.map((u) => [u.id, u.name]))
      }),
    [snap.tasks, snap.company, snap.roster]
  )
  const [qt, setQt] = useState<Awaited<ReturnType<typeof window.hive.quickTable>>>([])
  useEffect(() => {
    let alive = true
    void window.hive.quickTable().then((t) => alive && setQt(t))
    return () => {
      alive = false
    }
  }, [snap.company.aptitude])
  return (
    <div className="page">
      <header className="page-head">
        <h1>성과</h1>
      </header>
      <p className="muted small">
        누가·어느 팀이·어느 모델이 얼마나 했고 얼마나 잘했는지 보여줘요. &lsquo;한도 사용량&rsquo;은 AI 실행 횟수에 모델의 한도 가중치(큰 모델일수록
        큼)를 곱한 값이라, 구독 한도를 어디에 쓰고 있는지 비교할 수 있어요. 모델 × 분야 점수와 재배치 추천은 회사 탭에 있어요.
      </p>
      <Table title="에이전트별" rows={p.agents} />
      <Table title="조직(팀)별" rows={p.units} />
      <Table title="모델별" rows={p.models} showLoad />
      <section className="panel">
        <h2>일 종류별 (빠른 배정이 참고해요)</h2>
        {!qt.length ? (
          <div className="empty">빠른 배정으로 끝난 일이 아직 없어요.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>모델</th>
                <th>일 종류</th>
                <th>건수</th>
                <th>첫 통과율</th>
                <th>평균 실행</th>
                <th>평균 사용량</th>
              </tr>
            </thead>
            <tbody>
              {qt.map((r) => (
                <tr key={r.modelKey + r.kind}>
                  <td>{r.label}</td>
                  <td>{r.kindLabel}</td>
                  <td>{r.tasks}</td>
                  <td>{Math.round(r.firstPass * 100)}%</td>
                  <td>{r.avgRuns.toFixed(1)}회</td>
                  <td>{r.avgUsage.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
