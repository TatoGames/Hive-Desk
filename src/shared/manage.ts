/**
 * Management commands typed into the board ("작업 모두 정지하고 개발 시작해"): they must not become new tasks.
 * Rules only, no AI: a clause is a command when it holds a stopping word about work in general
 * and is not itself a job to build something ("취소 버튼 만들어줘").
 */
const STOP = /(정지|멈춰|멈추|멈춤|중단|중지|그만|취소|다\s*지워|전부\s*지워|스톱|\bstop\b|\bcancel\b|\bhalt\b|\babort\b)/i
const ABOUT_WORK = /(작업|업무|일\b|일을|진행|실행|전부|모두|다\s|전체|지금까지|돌아가|돌고|묶음|계획|모든)/i
const BUILD = /(기능|버튼|화면|메뉴|옵션|api|로직|구현|추가|만들|개발해|작성|코드|함수|클래스|ui\b|페이지|처리해|예외|핸들러)/i
const SPLIT = /(?<=하고|해서|한 뒤|한 뒤에|한 다음|하고서|한 후|한 후에)\s+|[,，.。\n]+\s*/

export interface InputClass {
  kind: 'task' | 'command' | 'mixed'
  /** The part that is a management command. */
  command: string
  /** What is left over as a real job (empty for a pure command). */
  rest: string
}

export function classifyInput(text: string): InputClass {
  const clauses = text.split(SPLIT).map((c) => c.trim()).filter(Boolean)
  const cmd: string[] = []
  const rest: string[] = []
  for (const c of clauses) {
    const isCmd = STOP.test(c) && ABOUT_WORK.test(c) && !BUILD.test(c)
    ;(isCmd ? cmd : rest).push(c)
  }
  if (!cmd.length) return { kind: 'task', command: '', rest: text.trim() }
  return { kind: rest.length ? 'mixed' : 'command', command: cmd.join(' '), rest: rest.join(' ') }
}
