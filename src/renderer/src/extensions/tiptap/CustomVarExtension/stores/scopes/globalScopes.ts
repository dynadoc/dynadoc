// The variables a document sees beyond its own: the Desktop scope and the
// Organization scope, behind one set of calls. A variable goes to the scope
// its visibility names, and leaves the other one when its visibility moves
// it.
import { desktopScope } from '../globalVariables'
import { isOrganizationVisibility, layerGlobals } from '../../utils/sheetVariables.utils'
import { organizationScope, startOrganizationSync } from './organizationScope'
import type { ScopeChange, StoredVariable, VariableScopeDriver } from './types'

const scopes: VariableScopeDriver[] = [desktopScope, organizationScope]

const scopeFor = (value: { visibility?: unknown } | null | undefined): VariableScopeDriver =>
  isOrganizationVisibility(value?.visibility) ? organizationScope : desktopScope

/** Loads both scopes once; `force` reads them again. */
export async function loadGlobalVariables(force = false): Promise<Record<string, StoredVariable>> {
  startOrganizationSync()
  await Promise.all(scopes.map((scope) => scope.load(force)))
  return getGlobalVariables()
}

/**
 * Desktop and Organization variables together. On a name clash the Desktop
 * one wins (document, then desktop, then organization).
 */
export function getGlobalVariables(): Record<string, StoredVariable> {
  return layerGlobals(desktopScope.list(), organizationScope.list())
}

/**
 * Stores a variable in the scope its visibility names. Moving it from the
 * Organization to the Desktop scope removes it from the organization: the UI
 * asks first (utils/organizationGuard.ts).
 */
export function setGlobalVariable(id: string, value: object): void {
  if (!id || !value) return
  const target = scopeFor(value as { visibility?: unknown })
  for (const scope of scopes) {
    if (scope !== target && scope.list()[id]) scope.remove(id)
  }
  target.set(id, value as StoredVariable)
}

export function deleteGlobalVariable(id: string): void {
  for (const scope of scopes) {
    if (scope.list()[id]) scope.remove(id)
  }
}

// The organization ids a document may see: not shadowed by a Desktop
// variable of the same id or name.
const visibleOrganizationIds = (layered: Record<string, StoredVariable>): Set<string> => {
  const desktop = desktopScope.list()
  return new Set(
    Object.keys(organizationScope.list()).filter((id) => id in layered && !(id in desktop))
  )
}

/**
 * Changes made elsewhere, in either scope, as a document sees them: an
 * organization variable shadowed by a Desktop one is reported as gone, and
 * comes back when the Desktop one goes.
 */
export function onGlobalVariablesChange(fn: (changes: ScopeChange[]) => void): () => void {
  let visible = visibleOrganizationIds(getGlobalVariables())
  const relay = (changes: ScopeChange[]): void => {
    const layered = getGlobalVariables()
    const out = new Map<string, StoredVariable | null>()
    for (const { id } of changes) out.set(id, layered[id] ?? null)
    const next = visibleOrganizationIds(layered)
    for (const id of next) if (!visible.has(id)) out.set(id, layered[id])
    for (const id of visible) if (!next.has(id) && !(id in layered)) out.set(id, null)
    visible = next
    if (out.size) fn([...out].map(([id, value]) => ({ id, value })))
  }
  const unsubscribe = scopes.map((scope) => scope.onChange(relay))
  return () => unsubscribe.forEach((off) => off())
}
