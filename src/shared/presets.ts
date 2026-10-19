/**
 * v0.6.1: starting rules for a kind of project — put into the project's briefing (every employee reads it before
 * working). The person can edit the text afterwards.
 */
export interface ProjectPreset {
  id: string
  name: string
  description: string
  briefing: string
}

export const PROJECT_PRESETS: ProjectPreset[] = [
  {
    id: 'electron',
    name: 'Electron 데스크톱 앱',
    description: '보안 기본값, 폴더 구조, 앱이 자동으로 확인할 수 있는 스크립트',
    briefing: [
      'This is an Electron desktop app (TypeScript preferred). Follow these rules.',
      '',
      'Structure: src/main (main process), src/preload (the only bridge), src/renderer (the UI), src/shared (types used by both). Keep the main process free of UI code and the renderer free of Node APIs.',
      '',
      'Security defaults — never weaken them: contextIsolation: true, nodeIntegration: false, sandbox where possible. The renderer talks to the main process only through a small preload API made with contextBridge (one function per action, no raw ipcRenderer exposed). Validate every argument in ipcMain handlers. Never load remote content into a window with Node access; set a Content-Security-Policy; open external links with shell.openExternal after checking the URL.',
      '',
      'Scripts in package.json (the HiveDesk app runs them by itself after your work, so they must exist and pass): "typecheck" (tsc --noEmit), "test" (a real test runner such as vitest — not the npm placeholder), "build" (produces what electron starts), and "lint" if the project has a linter. Keep tests free of network and of a real window where possible: put logic in src/shared or src/main modules that can be tested alone.',
      '',
      'Never start the app, a dev server or a watch mode yourself — it would never end. The app checks that Electron starts and the first window shows no uncaught errors.',
      '',
      'When planning, split the job along these seams: window and menu, main↔renderer messages (preload API), storage and settings (userData folder, never the app folder), the UI screens, packaging (electron-builder) last.',
      '',
      'Keep dependencies few and mainstream; say in RISK when you add one.'
    ].join('\n')
  },
  {
    id: 'web',
    name: '웹 페이지 (HTML/CSS/JS)',
    description: '빌드 도구 없이 index.html 중심',
    briefing: [
      'This is a small web page: plain HTML, CSS and JavaScript, no build step, opens by double-clicking index.html.',
      'Keep it in few files (index.html, style.css, app.js). No external services or API keys; a CDN script is fine only when you name it in RISK. Data that must stay goes in localStorage.',
      'The page must work when opened from the file system. Add a short README.md saying how to use it.'
    ].join('\n')
  },
  {
    id: 'python',
    name: '파이썬 프로그램',
    description: '명령줄 프로그램·스크립트, pytest',
    briefing: [
      'This is a Python program (3.10+). Standard library first; every third-party package goes into requirements.txt and is named in RISK.',
      'Put logic in importable functions and keep the command-line part thin. Add pytest tests for the logic (the HiveDesk app runs `python -m pytest` after your work). Never run anything that waits for input or never ends.',
      'Write README.md with how to install and run it, in the language of the task.'
    ].join('\n')
  }
]

export function presetById(id: string): ProjectPreset | undefined {
  return PROJECT_PRESETS.find((p) => p.id === id)
}
