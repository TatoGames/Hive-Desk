import type { HiveApi } from '../../preload/index'

declare global {
  interface Window {
    hive: HiveApi
  }
}

export {}
