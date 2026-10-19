import { describe, expect, it } from 'vitest'
import { appBaseDir, detectPortable, PORTABLE_DATA, PORTABLE_FLAG, portableNotice } from '../src/main/portable'

const files = (...f: string[]) => (p: string): boolean => f.includes(p)
const yes = (): boolean => true

describe('detectPortable', () => {
  it('Windows portable exe: PORTABLE_EXECUTABLE_DIR wins over the temp execPath', () => {
    const r = detectPortable({
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_DIR: 'E:\\Tools' },
      execPath: 'C:\\Users\\a\\AppData\\Local\\Temp\\abc\\HiveDesk.exe',
      exists: files(),
      canWrite: yes
    })
    expect(r).toMatchObject({ portable: true, reason: 'env', baseDir: 'E:\\Tools', homeDir: `E:\\Tools\\${PORTABLE_DATA}` })
  })
  it('ignores the variable on other platforms and is off without markers', () => {
    const r = detectPortable({ platform: 'linux', env: { PORTABLE_EXECUTABLE_DIR: '/x' }, execPath: '/opt/hive/HiveDesk', exists: files(), canWrite: yes })
    expect(r.portable).toBe(false)
    expect(r.reason).toBe('none')
    expect(r.homeDir).toBeNull()
  })
  it('portable.flag next to the exe', () => {
    const r = detectPortable({ platform: 'win32', env: {}, execPath: 'D:\\Hive\\HiveDesk.exe', exists: files(`D:\\Hive\\${PORTABLE_FLAG}`), canWrite: yes })
    expect(r).toMatchObject({ portable: true, reason: 'flag', homeDir: 'D:\\Hive\\HiveDesk-data' })
  })
  it('existing HiveDesk-data folder', () => {
    const r = detectPortable({ platform: 'linux', env: {}, execPath: '/opt/hive/HiveDesk', exists: files(`/opt/hive/${PORTABLE_DATA}`), canWrite: yes })
    expect(r).toMatchObject({ portable: true, reason: 'data-folder', homeDir: '/opt/hive/HiveDesk-data' })
  })
  it('macOS: the base is the folder that holds the .app bundle', () => {
    const exe = '/Volumes/USB/HiveDesk/HiveDesk.app/Contents/MacOS/HiveDesk'
    expect(appBaseDir(exe, 'darwin')).toBe('/Volumes/USB/HiveDesk')
    const r = detectPortable({ platform: 'darwin', env: {}, execPath: exe, exists: files('/Volumes/USB/HiveDesk/portable.flag'), canWrite: yes })
    expect(r).toMatchObject({ portable: true, homeDir: '/Volumes/USB/HiveDesk/HiveDesk-data' })
    // a flag inside Contents/MacOS must not count
    const r2 = detectPortable({ platform: 'darwin', env: {}, execPath: exe, exists: files('/Volumes/USB/HiveDesk/HiveDesk.app/Contents/MacOS/portable.flag'), canWrite: yes })
    expect(r2.portable).toBe(false)
    expect(appBaseDir('/Applications/HiveDesk.app/Contents/MacOS/HiveDesk', 'darwin')).toBe('/Applications')
  })
  it('read-only folder: falls back to normal mode with a Korean warning', () => {
    const r = detectPortable({ platform: 'darwin', env: {}, execPath: '/Volumes/RO/HiveDesk.app/Contents/MacOS/HiveDesk', exists: files('/Volumes/RO/portable.flag'), canWrite: () => false })
    expect(r.portable).toBe(false)
    expect(r.reason).toBe('read-only')
    expect(r.homeDir).toBeNull()
    expect(r.warning).toContain('쓸 수 없어요')
  })
  it('notice text', () => {
    expect(portableNotice('/a/HiveDesk-data')).toBe('휴대용 모드예요: 데이터는 /a/HiveDesk-data에만 있어요')
  })
})
