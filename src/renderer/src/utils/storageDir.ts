import Platform from '../libs/platform'

let cachedStorageDir: Promise<string> | null = null

export async function getStorageDirCached(): Promise<string> {
  if (cachedStorageDir) return cachedStorageDir
  if (Platform.getPlatform() === Platform.SUPPORTED_PLATFORMS.web) {
    cachedStorageDir = Promise.resolve('drive')
    return cachedStorageDir
  }
  cachedStorageDir = (async () => {
    try {
      return await window.api.getStorageDir()
    } catch {
      return 'drive'
    }
  })()
  return cachedStorageDir
}
