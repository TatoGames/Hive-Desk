// A stand-in for an AI CLI: reads the prompt on stdin and prints a scripted reply.
// Behavior is chosen by a keyword inside the prompt, so tests stay deterministic.
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (input.includes('SCENARIO:fail')) {
    process.stderr.write('boom')
    process.exit(3)
  }
  if (input.includes('SCENARIO:hang')) {
    setTimeout(() => {}, 60000)
    return
  }
  if (input.includes('SCENARIO:ask')) {
    console.log('I prepared the migration.')
    console.log('[[APPROVAL: about to drop the old table]]')
    return
  }
  if (input.includes('SCENARIO:report') || input.includes('SCENARIO:write')) {
    if (input.includes('SCENARIO:write')) {
      const fs = require('fs')
      fs.writeFileSync('out.txt', 'hello\n')
      fs.appendFileSync('a.txt', 'changed\n')
      fs.rmSync('gone.txt', { force: true })
    }
    console.log('All finished.')
    console.log('[[DID: wrote the files]]')
    console.log('[[FILES: out.txt')
    console.log('a.txt]]')
    console.log('[[VERIFY: open out.txt]]')
    console.log('[[RISK: none]]')
    console.log('[[NEXT: add tests]]')
    return
  }
  console.log('Done: ' + (input.match(/## Your task\n(.*)/) || [])[1])
  console.log('[[MEMORY: project uses pnpm]]')
  console.log('[[MSG to=bob-tester: please test the login page]]')
  console.log('PROMPT_LEN=' + input.length)
  if (input.includes('project uses pnpm')) console.log('SAW_MEMORY')
})
