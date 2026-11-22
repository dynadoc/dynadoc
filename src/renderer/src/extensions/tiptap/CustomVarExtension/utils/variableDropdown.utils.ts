import type { Variable } from '../stores/variableManipulator'
import { getVariableDisplayValue } from './variableDisplay.utils'
import { rankVariableMatches } from './variableMenu.utils'

export type VarDropdownItem = {
  id?: string
  name: string
  displayName?: string
  value?: any
  type?: string
  aliases?: string[]
  rawValue?: any
  displayValue?: string
  source?: string
}

export function buildVarDropdownItems(vars: Variable[], query: string): VarDropdownItem[] {
  // Spreadsheet pointers name a whole sheet file, not a value: inserting one
  // showed its path. Cell refs are inserted from the spreadsheet cell view.
  const items = (vars || [])
    .filter((v) => v.rawValue?.type !== 'spreadsheet')
    .map((v) => ({
      id: v.name,
      name: v.rawValue?.name || v.name,
      displayName: v.rawValue?.name || v.name,
      value: v.value,
      type: v.rawValue?.type,
      aliases: v.rawValue?.aliases || [],
      rawValue: v.rawValue,
      displayValue: getVariableDisplayValue(v, { plainText: true }),
      source: v.rawValue?.source || 'user'
    }))
  // What was typed starts the name (or an alias, or a word of the name).
  return rankVariableMatches(items, query)
}
