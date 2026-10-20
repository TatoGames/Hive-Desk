// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
afterEach(cleanup)
import { cleanup, render, screen } from '@testing-library/react'
import { PermissionSelect } from '../../src/renderer/src/views/Materials'

describe('v0.8.2 UI: the default permission of a CLI that cannot be enforced says what to do for file work', () => {
  it('agy: read-only default plus a hint to choose "파일 수정"', () => {
    render(<PermissionSelect value={undefined} onChange={() => {}} adapter="agy" />)
    expect(screen.getByRole('option', { name: /기본 — 읽기만.*파일 수정/ })).toBeTruthy()
  })
  it('claude: plain editing default, no hint', () => {
    render(<PermissionSelect value={undefined} onChange={() => {}} adapter="claude" />)
    expect(screen.getByRole('option', { name: /^기본 — 파일 수정/ }).textContent).not.toContain('읽기로 시작해요')
  })
})
