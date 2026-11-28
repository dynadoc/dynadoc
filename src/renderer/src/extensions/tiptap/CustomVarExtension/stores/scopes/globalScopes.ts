// The variables a document sees beyond its own: the Desktop scope and the
// Organization scope, behind one set of calls. A variable goes to the scope
// its visibility names, and leaves the other one when its visibility moves
// it.
import { desktopScope } from '../globalVariables'
import { isOrganizationVisibility } from '../../utils/sheetVariables.utils'
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

/** Desktop and Organization variables together; an id lives in one scope only. */
export function getGlobalVariables(): Record<string, StoredVariable> {
  return { ...desktopScope.list(), ...organizationScope.list() }
}

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

/** Changes made elsewhere, in either scope. */
export function onGlobalVariablesChange(fn: (changes: ScopeChange[]) => void): () => void {
  const unsubscribe = scopes.map((scope) => scope.onChange(fn))
  return () => unsubscribe.forEach((off) => off())
}
