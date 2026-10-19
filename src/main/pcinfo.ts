import { execFile } from 'node:child_process'
import * as os from 'node:os'
import type { PcInfo } from '../shared/localai'

export type Exec = (cmd: string, args: string[]) => Promise<string>

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (one line per card, MiB). */
export function parseNvidia(out: string): PcInfo['gpu'] | undefined {
  let best: PcInfo['gpu'] | undefined
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*,\s*(\d+)\s*$/)
    if (!m) continue
    const vramGB = Math.round((Number(m[2]) / 1024) * 10) / 10
    if (!best || vramGB > best.vramGB) best = { name: m[1], vramGB }
  }
  return best
}

/** Memory, cores, system and — where the system tells — the graphics memory. Never throws; unknown stays empty. */
export async function diagnosePc(run: Exec = defaultExec, sys: Pick<typeof os, 'totalmem' | 'cpus' | 'platform' | 'arch'> = os): Promise<PcInfo> {
  const cpus = sys.cpus()
  const platform = sys.platform()
  const arch = sys.arch()
  const info: PcInfo = {
    platform,
    arch,
    ramGB: Math.round((sys.totalmem() / 1024 ** 3) * 10) / 10,
    cores: cpus.length,
    appleSilicon: platform === 'darwin' && arch === 'arm64'
  }
  if (!info.appleSilicon) {
    try {
      info.gpu = parseNvidia(await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']))
    } catch {
      /* no NVIDIA card or no driver: the memory is used */
    }
  }
  return info
}
