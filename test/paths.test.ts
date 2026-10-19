import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapFile, migrateToHome, readBootstrap, resolveUserData, setTempRoot, tempDir, writeBootstrap } from '../src/main/paths'

const roots: string[] = []
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hd-paths-'))
  roots.push(d)
  return d
}
afterEach(() => {
  setTempRoot(null)
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('one-folder mode paths', () => {
  it('is off unless the bootstrap file says so', () => {
    const d = mk()
    const f = bootstrapFile(d)
    expect(readBootstrap(f)).toBeNull()
    writeFileSync(f, '{broken')
    expect(readBootstrap(f)).toBeNull()
    expect(resolveUserData(null, '/default')).toBe('/default')
    writeBootstrap(f, { oneFolder: true, homeDir: join(d, 'H') })
    const b = readBootstrap(f)
    expect(resolveUserData(b, '/default')).toBe(join(d, 'H', 'data'))
  })

  it('tempDir uses the system temp when off and <home>/tmp when on', () => {
    const off = tempDir('hd-x-')
    roots.push(off)
    expect(off.startsWith(tmpdir())).toBe(true)
    const home = mk()
    setTempRoot(join(home, 'tmp'))
    const on = tempDir('hd-x-')
    expect(on.startsWith(join(home, 'tmp'))).toBe(true)
    expect(existsSync(on)).toBe(true)
  })

  it('migration copies, keeps the originals, and never overwrites', () => {
    const old = mk()
    const home = join(mk(), 'HiveDesk')
    writeFileSync(join(old, 'config.json'), '{"a":1}')
    writeFileSync(join(old, 'local-models.json'), '[]')
    const r = migrateToHome(old, home)
    expect(r).toMatchObject({ ok: true, copied: ['config.json', 'local-models.json'], leftBehind: old })
    expect(readFileSync(join(old, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(readFileSync(join(home, 'data', 'config.json'), 'utf8')).toBe('{"a":1}')
    writeFileSync(join(old, 'config.json'), '{"a":2}')
    const again = migrateToHome(old, home)
    expect(again.skipped).toContain('config.json')
    expect(readFileSync(join(home, 'data', 'config.json'), 'utf8')).toBe('{"a":1}')
  })

  it('a failed migration keeps the original and leaves no partial copy', () => {
    const old = mk()
    writeFileSync(join(old, 'config.json'), '{"a":1}')
    mkdirSync(join(old, 'local-models.json')) // a directory cannot be copied as a file
    const home = join(mk(), 'HiveDesk')
    const r = migrateToHome(old, home)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(readFileSync(join(old, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(readdirSync(join(home, 'data'))).toEqual([])
  })
})
