import { describe, expect, it } from 'vitest'
import { installChoices, isStaffCandidate, parseLibrary } from '../src/shared/ollamaLibrary'
import { searchLibrary } from '../src/main/ollamaLibrary'

// A made-up page in the shape the library page is known to have (links to /library/<name>, tags as text).
const PAGE = `
<ul>
<li><a href="/library/qwen2.5-coder"><div><h2><span>qwen2.5-coder</span></h2><p>The latest series of Code-Specific Qwen models, with significant improvements</p></div>
<div><span>tools</span><span>0.5b</span><span>7b</span><span>14b</span><span>32b</span></div><div><span>22.3M</span><span>Pulls</span></div></a></li>
<li><a href="/library/nomic-embed-text"><h2>nomic-embed-text</h2><p>A high-performing open embedding model with a large token context window.</p><span>embedding</span><span>91.1M</span></a></li>
<li><a href="/library/llava"><h2>llava</h2><p>Vision-language model combining a visual encoder and a language model.</p><span>vision</span><span>7b</span><span>13b</span></a></li>
<li><a href="/library/gemma3"><h2>gemma3</h2><p>The current, most capable model that runs on a single GPU.</p><span>vision</span><span>tools</span><span>270m</span><span>4b</span><span>12b</span><span>1,2M</span></a></li>
<li><a href="/library/qwen2.5-coder">dup</a></li>
</ul>`

describe('J4: library search', () => {
  it('reads names, descriptions, capabilities and sizes, once per model', () => {
    const items = parseLibrary(PAGE)
    expect(items.map((i) => i.name)).toEqual(['qwen2.5-coder', 'nomic-embed-text', 'llava', 'gemma3'])
    const q = items[0]
    expect(q.caps).toEqual(['tools'])
    expect(q.sizes).toEqual(['0.5b', '7b', '14b', '32b'])
    expect(q.description).toContain('Code-Specific')
    expect(q.pulls).toBe('22.3M')
  })
  it('keeps only models fit for staff work and offers name:size to install', () => {
    const items = parseLibrary(PAGE)
    expect(items.filter(isStaffCandidate).map((i) => i.name)).toEqual(['qwen2.5-coder', 'gemma3'])
    expect(installChoices(items[0])).toEqual(['qwen2.5-coder:0.5b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen2.5-coder:32b'])
    expect(installChoices({ name: 'foo', description: '', caps: [], sizes: [] })).toEqual(['foo'])
  })
  it('gives an empty list for pages that look different', () => {
    expect(parseLibrary('')).toEqual([])
    expect(parseLibrary('<html><body>maintenance</body></html>')).toEqual([])
    expect(parseLibrary('<a href="/library/../etc">x</a>')).toEqual([])
  })
  it('search returns null (the screen hides the search) when the page cannot be read', async () => {
    const ok = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch
    expect((await searchLibrary('coder', ok(PAGE)))?.length).toBe(4)
    expect(await searchLibrary('coder', ok('x', 503))).toBeNull()
    expect(await searchLibrary('coder', ok('<p>nothing</p>'))).toBeNull()
    expect(await searchLibrary('coder', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
  })
})
