// @vitest-environment jsdom
import { join } from 'node:path'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountApp, ready, type Ui } from './harness'

let ui: Ui | undefined
afterEach(() => {
  ui?.done()
  ui = undefined
})

describe('v0.6 UI: menus grouped by what people do, basic and advanced', () => {
  it('someone new: the first save turns on the basic menus, and the start screen opens', async () => {
    ui = await mountApp()
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '민우' } })
    fireEvent.click(screen.getAllByRole('button', { name: '시작하기' }).find((b) => !b.classList.contains('nav'))!)
    await ui.refresh()
    expect(ui.eng.config.uiMode).toBe('basic')
    expect(screen.getByText('쓰고 있는 AI 로그인하기')).toBeTruthy()
    expect(screen.getByText('첫 일 맡기기')).toBeTruthy()
    // the everyday menus only
    expect(screen.getByText('내가 할 일')).toBeTruthy()
    expect(screen.queryByText('CEO 위원회')).toBeNull()
    expect(screen.queryByText('협업')).toBeNull()
  })

  it('the switch shows every menu', async () => {
    ui = await mountApp((eng, dir) => {
      ready(eng, dir)
      eng.saveSettings({ uiMode: 'basic' })
    })
    expect(screen.queryByText('메시지 · 메모리')).toBeNull()
    fireEvent.click(screen.getByText('고급 메뉴 보기'))
    await ui.refresh()
    expect(ui.eng.config.uiMode).toBe('advanced')
    expect(screen.getByText('CEO 위원회')).toBeTruthy()
    expect(screen.getByText('메시지 · 메모리')).toBeTruthy()
  })

  it('people from before v0.6 keep every menu', async () => {
    ui = await mountApp((eng, dir) => void ready(eng, dir))
    expect(ui.eng.config.uiMode).toBeUndefined()
    expect(screen.getByText('CEO 위원회')).toBeTruthy()
  })

  it('the start screen gives a first task in plain words', async () => {
    ui = await mountApp((eng, dir) => {
      eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), uiMode: 'basic' })
    })
    expect(screen.getByText('첫 일 맡기기')).toBeTruthy()
    fireEvent.click(screen.getAllByText(/단위 변환기 웹페이지를 만들어줘/)[0])
    fireEvent.click(screen.getByText('맡기기'))
    await ui.refresh()
    expect(ui.eng.hive.listTasks().map((t) => t.title)).toEqual(['단위 변환기 웹페이지를 만들어줘'])
  })

  it('the start screen lets you pick the folder, offers git for a plain one, and says where the result goes', async () => {
    let git: string = 'none'
    ui = await mountApp(
      (eng, dir) => {
        eng.saveSettings({ memberName: 'alice', workspace: join(dir, 'ws'), uiMode: 'basic' })
      },
      {
        pickFolder: () => '/tmp/my-app',
        folderGit: () => git,
        initFolderGit: () => ((git = 'ok'), { ok: true, message: 'git 폴더로 만들었어요 (파일 3개를 첫 기록으로 저장).' }),
        startFirstTask: () => ({ ok: true, id: 'x', dir: '/tmp/my-app' })
      }
    )
    fireEvent.click(screen.getByRole('button', { name: '폴더 고르기' }))
    await ui.refresh()
    expect(screen.getByText(/아직 git 폴더가 아니에요/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'git 폴더로 만들기' }))
    fireEvent.click(screen.getByRole('button', { name: /^정말 git 폴더로 만들기/ }))
    await ui.refresh()
    expect(screen.getByText(/파일 3개를 첫 기록으로 저장/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(/단위 변환기 웹페이지/), { target: { value: '계산기 만들어줘' } })
    fireEvent.click(screen.getByRole('button', { name: '맡기기' }))
    await ui.refresh()
    expect(screen.getByRole('button', { name: '결과가 생길 폴더 열기' })).toBeTruthy()
  })
})
