/**
 * v6 8-1: ten small edits with a check each, to measure what a model on this PC can really do (time and pass/fail).
 * The model gets the file and the request and returns the whole new file; the app runs the check. This is the
 * "app leads the edit" way (design 4-5): the model needs no tools.
 */
export interface BenchTask {
  id: string
  title: string
  /** The file as it is now (empty = write it new). */
  start: string
  ask: string
  /** Node script run next to `solution.js` (CommonJS); exit code 0 = passed. */
  test: string
}

const T = (id: string, title: string, start: string, ask: string, test: string): BenchTask => ({ id, title, start, ask, test })

export const BENCH_TASKS: BenchTask[] = [
  T('sum-off-by-one', '합계가 하나 모자라는 버그 고치기', 'function sum(arr) {\n  let t = 0\n  for (let i = 0; i < arr.length - 1; i++) t += arr[i]\n  return t\n}\nmodule.exports = { sum }\n', '`sum`이 배열의 모든 값을 더하도록 고쳐 주세요.', "const {sum}=require('./solution');const a=require('assert');a.strictEqual(sum([1,2,3]),6);a.strictEqual(sum([]),0);a.strictEqual(sum([5]),5)"),
  T('palindrome', '회문 판별 함수 만들기', '', '`isPalindrome(s)`를 만들어 내보내 주세요. 대소문자와 글자·숫자가 아닌 문자는 무시하고 앞뒤가 같으면 true입니다.', "const {isPalindrome:p}=require('./solution');const a=require('assert');a.strictEqual(p('A man, a plan, a canal: Panama'),true);a.strictEqual(p('hello'),false);a.strictEqual(p(''),true)"),
  T('greet-param', '인자 하나 추가하기', "function greet(name) {\n  return 'Hello, ' + name + '!'\n}\nmodule.exports = { greet }\n", '`greet(name, punct)`로 바꿔 주세요. 두 번째 인자는 끝에 붙는 문장부호이고, 주지 않으면 기본값은 `!`입니다.', "const {greet:g}=require('./solution');const a=require('assert');a.strictEqual(g('Kim'),'Hello, Kim!');a.strictEqual(g('Kim','?'),'Hello, Kim?')"),
  T('rename', '함수 이름 바꾸기', 'function calc(items) {\n  return items.reduce((s, x) => s + x.price * x.qty, 0)\n}\nmodule.exports = { calc }\n', '함수 `calc`의 이름을 `totalPrice`로 바꿔 주세요(동작은 그대로, `calc`는 더 내보내지 않습니다).', "const m=require('./solution');const a=require('assert');a.strictEqual(typeof m.totalPrice,'function');a.strictEqual(m.calc,undefined);a.strictEqual(m.totalPrice([{price:2,qty:3},{price:1,qty:1}]),7)"),
  T('average-empty', '빈 배열에서 NaN이 나오는 버그', 'function average(arr) {\n  return arr.reduce((a, b) => a + b, 0) / arr.length\n}\nmodule.exports = { average }\n', '`average`가 빈 배열이면 NaN 대신 0을 돌려주도록 고쳐 주세요.', "const {average:v}=require('./solution');const a=require('assert');a.strictEqual(v([2,4]),3);a.strictEqual(v([]),0)"),
  T('group-by', 'groupBy 만들기', '', '`groupBy(arr, fn)`을 만들어 내보내 주세요. `fn(item)`의 결과를 키로 해서 `{키: [항목들]}` 객체를 돌려줍니다(입력 순서 유지).', "const {groupBy:g}=require('./solution');const a=require('assert');a.deepStrictEqual(g([1,2,3,4,5],x=>x%2?'odd':'even'),{odd:[1,3,5],even:[2,4]});a.deepStrictEqual(g([],x=>x),{})"),
  T('promisify', '콜백을 Promise로', "function readLater(value, cb) {\n  setTimeout(() => cb(null, value), 1)\n}\nmodule.exports = { readLater }\n", '`readLater(value)`가 콜백 대신 Promise를 돌려주도록 바꿔 주세요(값으로 이행).', "const {readLater:r}=require('./solution');const a=require('assert');const p=r(7);a.ok(p&&typeof p.then==='function');p.then(v=>{a.strictEqual(v,7)}).catch(e=>{console.error(e);process.exit(1)})"),
  T('csv-line', '따옴표가 있는 CSV 한 줄 나누기', '', '`parseCsvLine(line)`을 만들어 내보내 주세요. 쉼표로 나누되 큰따옴표로 감싼 값 안의 쉼표는 나누지 않고, 값을 감싼 따옴표는 지웁니다.', "const {parseCsvLine:p}=require('./solution');const a=require('assert');a.deepStrictEqual(p('a,b,c'),['a','b','c']);a.deepStrictEqual(p('a,\"b,c\",d'),['a','b,c','d']);a.deepStrictEqual(p(''),[''])"),
  T('uniq-order', '중복 제거(순서 유지)', 'function uniq(arr) {\n  return arr.sort().filter((x, i, a) => a.indexOf(x) === i)\n}\nmodule.exports = { uniq }\n', '`uniq`가 처음 나온 순서를 유지하고 원본 배열을 바꾸지 않도록 고쳐 주세요.', "const {uniq:u}=require('./solution');const a=require('assert');const src=[3,1,3,2,1];a.deepStrictEqual(u(src),[3,1,2]);a.deepStrictEqual(src,[3,1,3,2,1])"),
  T('divide-guard', '0으로 나누면 오류', 'function divide(a, b) {\n  return a / b\n}\nmodule.exports = { divide }\n', '`b`가 0이면 `RangeError`를 던지도록 고쳐 주세요(메시지는 자유).', "const {divide:d}=require('./solution');const a=require('assert');a.strictEqual(d(6,3),2);a.throws(()=>d(1,0),RangeError)")
]

/** The request sent to the model for one task. */
export function benchPrompt(t: BenchTask): string {
  return [
    '아래 파일 `solution.js`를 요청에 맞게 고치세요. 설명 없이, 고친 파일 전체를 ```js 코드 블록 하나로만 돌려주세요.',
    '',
    t.start ? '현재 파일:\n```js\n' + t.start + '```' : '현재 파일: (비어 있음, 새로 만드세요)',
    '',
    '요청: ' + t.ask
  ].join('\n')
}

/** The last fenced code block of an answer (or the whole answer when it has none and looks like code). */
export function extractCode(text: string): string | undefined {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1])
  if (blocks.length) return blocks[blocks.length - 1]
  return /\b(function|module\.exports|const |=>)/.test(text) ? text : undefined
}

export interface BenchRow {
  id: string
  title: string
  ok: boolean
  ms: number
  /** Output tokens per second, if the engine said. */
  perSec?: number
  reason?: string
}

export interface BenchSummary {
  model: string
  at: string
  passed: number
  total: number
  totalMs: number
  medianMs: number
  rows: BenchRow[]
}

export function summarizeBench(model: string, at: string, rows: BenchRow[]): BenchSummary {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  return {
    model,
    at,
    passed: rows.filter((r) => r.ok).length,
    total: rows.length,
    totalMs: rows.reduce((s, r) => s + r.ms, 0),
    medianMs: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : 0,
    rows
  }
}
