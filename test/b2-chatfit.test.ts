import { describe, expect, it } from 'vitest'
import { installedFit, speedLine, recommendTier } from '../src/shared/localai'

const pc = { platform: 'darwin', arch: 'arm64', ramGB: 16, cores: 8, appleSilicon: true }

describe('B2: chat shows how a model of this PC fits and how fast it was', () => {
  it('reads the fit from the listed size or the name', () => {
    const advice = recommendTier(pc)
    expect(installedFit({ name: 'qwen2.5-coder:7b', sizeBytes: 4.7e9 }, advice)).toBe('잘 맞아요')
    expect(installedFit({ name: 'qwen2.5-coder:32b', sizeBytes: 20e9 }, advice)).toBe('이 PC엔 무거워요')
    expect(installedFit({ name: 'mystery' }, advice)).toBeUndefined()
    expect(installedFit({ name: 'qwen2.5-coder:7b' }, undefined)).toBeUndefined()
  })
  it('says nothing about speed until it was measured and marks guesses', () => {
    expect(speedLine(undefined)).toBeUndefined()
    expect(speedLine({ firstMs: 800, perSec: 22.34, estimated: false })).toBe('첫 응답 800ms · 초당 22.3')
    expect(speedLine({ firstMs: 2500, perSec: 8, estimated: true })).toBe('첫 응답 2.5초 · 초당 8.0(추정)')
  })
})
