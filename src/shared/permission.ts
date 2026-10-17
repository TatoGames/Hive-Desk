import type { AdapterId, PermissionLevel } from './types'

/** CLIs whose own flags enforce the permission level. The others only get an instruction. */
const ENFORCED: AdapterId[] = ['claude', 'codex']

export function isEnforced(adapter?: AdapterId): boolean {
  return !adapter || ENFORCED.includes(adapter)
}

/**
 * The level a task runs with when nobody chose one. Enforced CLIs may edit the work folder;
 * the others start read-only because HiveDesk cannot stop them from doing more.
 */
export function defaultPermission(adapter?: AdapterId): PermissionLevel {
  return isEnforced(adapter) ? 'edit' : 'read'
}
