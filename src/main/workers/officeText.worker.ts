/**
 * Worker thread for the multi-file search: extracts the text of one .docx or
 * .xlsx per message, off the Electron main process (#136). See
 * src/main/search/officeWorker.ts for the other side.
 */
import { parentPort } from 'worker_threads'
import { extractOfficeText } from '../search/officeText'
import type { OfficeWorkerRequest, OfficeWorkerResponse } from '../search/officeWorker'

parentPort?.on('message', (request: OfficeWorkerRequest) => {
  let response: OfficeWorkerResponse
  try {
    response = { id: request.id, extraction: extractOfficeText(request.bytes, request.kind) }
  } catch {
    response = { id: request.id, extraction: { ok: false, reason: 'extraction failed' } }
  }
  parentPort?.postMessage(response)
})
