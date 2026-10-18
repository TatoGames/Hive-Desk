// A stand-in for `claude -p --output-format stream-json`: prints real-format events with small
// delays so tests can observe progress mid-run. Scenario is chosen by words in the prompt.
const fs = require('fs')
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = (o) => process.stdout.write(JSON.stringify({ session_id: 'sess-1', ...o }) + '\n')
  const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const tool = (name, inp) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' + Math.random(), name, input: inp }] } })
  const result = (text, extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: text, permission_denials: [], ...extra })
  const argv = process.argv.slice(2)

  out({ type: 'system', subtype: 'init' })
  if (input.includes('SCENARIO:fail')) {
    process.stderr.write('boom')
    process.exit(3)
  }
  if (input.includes('New instructions from the human')) {
    const ins = (input.match(/New instructions from the human[^\n]*\n([^\n]*)/) || [])[1]
    say('[[ACK: ' + ins + ']]')
    result('Resumed with: ' + (argv.includes('--resume') ? 'SESSION' : 'REPLAY') + '\n' + ins + '\n[[ACK: ' + ins + ']]\n[[DID: continued]]')
    return
  }
  if (input.includes('The human replied')) {
    say('Thanks, continuing.')
    result('Resumed with: ' + (argv.includes('--resume') ? 'SESSION' : 'REPLAY') + '\n' + (input.match(/The human replied:\n([^\n]*)/) || [])[1] + '\n[[DID: continued]]')
    return
  }
  if (input.includes('SCENARIO:need')) {
    say('[[PLAN: look | ask]]')
    tool('Read', { file_path: 'spec.md' })
    result('I cannot continue.\n[[NEED: please attach the design spec]]')
    return
  }
  if (input.includes('SCENARIO:deny')) {
    tool('Write', { file_path: '/etc/x', content: 'no' })
    result('could not write', { permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/etc/x' } }] })
    return
  }
  say('[[PLAN: read the code | write the file | report]]')
  tool('Read', { file_path: 'a.txt' })
  say('[[STEP: 1]]')
  tool('Write', { file_path: 'out.txt', content: 'ok\nline2\n' })
  fs.writeFileSync('out.txt', 'ok\nline2\n')
  tool('Bash', { command: 'npm test' })
  await sleep(input.includes('SCENARIO:slow') ? 900 : 250)
  say('[[STEP: 2]]')
  result('All done.\n[[DID: wrote out.txt]]\n[[FILES: out.txt]]\n[[VERIFY: cat out.txt]]\n[[RISK: none]]\n[[NEXT: none]]')
})
