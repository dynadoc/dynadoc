// What the variable UI says about the Organization scope: how current its
// copy is, and who changed a variable last. Message keys and values only;
// the component translates them. Pure, with no imports but types, so
// tests/smoke/organization-variables.test.mjs can bundle it.
import type { OrgStatus, OrgVariableRecord } from '../stores/scopes/organizationScope.core'

export type Message = { key: string; values: Record<string, string | number> }

const defaultTime = (ms: number): string => new Date(ms).toLocaleString()

/** The line shown beside organization variables, or null when the copy is current. */
export function orgStatusLine(
  status: OrgStatus,
  formatTime: (ms: number) => string = defaultTime
): Message | null {
  const time = status.syncedAt ? formatTime(status.syncedAt) : ''
  if (status.conflicts > 0) {
    return {
      key: 'Organization variables: {count} change(s) refused because someone changed them first',
      values: { count: status.conflicts }
    }
  }
  if (status.state === 'unavailable') {
    return { key: 'Organization variables are not available here', values: {} }
  }
  if (status.state === 'offline') {
    return time
      ? {
          key: 'Offline: organization variables as of {time}. Changes are sent when the connection is back.',
          values: { time }
        }
      : { key: 'Offline: organization variables cannot be read yet.', values: {} }
  }
  if (status.state === 'stale') {
    if (status.reason === 'unauthorized') {
      return {
        key: 'Organization variables as of {time}: sign in again to update them.',
        values: { time }
      }
    }
    return { key: 'Organization variables may be out of date (as of {time}).', values: { time } }
  }
  if (status.lastWriteError?.kept) {
    return {
      key: 'Not added to the organization: {message}. It is kept in All my files.',
      values: { message: status.lastWriteError.message }
    }
  }
  if (status.lastWriteError) {
    return {
      key: 'The last change to an organization variable was refused: {message}',
      values: { message: status.lastWriteError.message }
    }
  }
  return null
}

const nameOf = (user: OrgVariableRecord['updatedBy']): string =>
  user?.name || user?.email || user?.id || '?'

/** A value as one line of text, for "Previous value". */
export function previewValue(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null
  const raw = value.value ?? value.prompt ?? value.url ?? ''
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/** Who changed an organization variable last, when, and its value before. */
export function orgChangeLine(
  record: OrgVariableRecord,
  formatTime: (ms: number) => string = defaultTime
): Message & { previous: string | null } {
  const at = Date.parse(record.updatedAt)
  const time = Number.isFinite(at) ? formatTime(at) : record.updatedAt
  return {
    key: record.previous ? 'Changed by {name} on {time}' : 'Created by {name} on {time}',
    values: { name: nameOf(record.updatedBy), time },
    previous: record.previous ? previewValue(record.previous.value) : null
  }
}
