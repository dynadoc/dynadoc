/**
 * Pure logic behind the editor mode bar (mode, @ Variables, AI).
 *
 * No imports on purpose: tests/smoke/editor-mode-bar.test.mjs bundles this
 * file alone and runs it under plain Node.
 */

export type ReviewMode = 'edit' | 'suggest' | 'view'

export type MarkupMode = 'all' | 'simple' | 'none' | 'original'

export const REVIEW_MODES: readonly ReviewMode[] = ['edit', 'suggest', 'view'] as const

/**
 * The mode shown by the bar, from the editor's review storage and the
 * document's review settings. Same rules as the former ReviewQuickModeWidget:
 * the editor's own flag wins over the document config, then a hidden markup
 * means "view", anything else is "edit".
 */
export function resolveReviewMode(input: {
  editorTrackChanges?: boolean | null
  configTrackChanges?: boolean | null
  markupMode?: string | null
}): ReviewMode {
  const enabled = input.editorTrackChanges ?? input.configTrackChanges
  const markup = input.markupMode || 'all'
  if (enabled) return 'suggest'
  if (markup === 'original' || markup === 'none') return 'view'
  return 'edit'
}

/** What selecting a mode does: track changes on or off, and the markup shown. */
export function reviewModeCommands(mode: ReviewMode): {
  trackChanges: boolean
  markupMode: MarkupMode
} {
  if (mode === 'suggest') return { trackChanges: true, markupMode: 'all' }
  if (mode === 'view') return { trackChanges: false, markupMode: 'original' }
  return { trackChanges: false, markupMode: 'all' }
}

/** The mode after this one, in bar order (used by the compact segmented control). */
export function nextReviewMode(mode: ReviewMode): ReviewMode {
  const index = REVIEW_MODES.indexOf(mode)
  return REVIEW_MODES[(index + 1) % REVIEW_MODES.length]
}

export type ReviewModeMeta = {
  mode: ReviewMode
  /** i18n key of the short label shown on the button. */
  labelKey: string
  /** i18n key of the one-line explanation shown in the menu. */
  hintKey: string
  /** Phosphor icon class. */
  icon: string
  /** Suggest mode tints the button so the reader sees they are in review. */
  tone: 'neutral' | 'review'
}

const MODE_META: Record<ReviewMode, ReviewModeMeta> = {
  edit: {
    mode: 'edit',
    labelKey: 'modeBar.mode.edit',
    hintKey: 'modeBar.mode.editHint',
    icon: 'ph-bold ph-pencil-simple',
    tone: 'neutral'
  },
  suggest: {
    mode: 'suggest',
    labelKey: 'modeBar.mode.suggest',
    hintKey: 'modeBar.mode.suggestHint',
    icon: 'ph-bold ph-chat-centered-text',
    tone: 'review'
  },
  view: {
    mode: 'view',
    labelKey: 'modeBar.mode.view',
    hintKey: 'modeBar.mode.viewHint',
    icon: 'ph-bold ph-eye',
    tone: 'neutral'
  }
}

export function reviewModeMeta(mode: ReviewMode): ReviewModeMeta {
  return MODE_META[mode] ?? MODE_META.edit
}

/** i18n key of the status shown next to the AI button while it works, or null when idle. */
export function aiPhaseLabelKey(phase: string | null | undefined): string | null {
  switch (phase) {
    case 'running':
      return 'Generating'
    case 'repairing':
      return 'Repairing JSON'
    case 'long-running':
      return 'Still working'
    case 'error':
      return 'Error'
    default:
      return null
  }
}

/** Everything the @ Variables switch needs to render a given state. */
export function variablesSwitchState(on: boolean): {
  ariaChecked: 'true' | 'false'
  stateKey: string
  descriptionKey: string
} {
  return on
    ? {
        ariaChecked: 'true',
        stateKey: 'modeBar.vars.on',
        descriptionKey: 'modeBar.vars.onHint'
      }
    : {
        ariaChecked: 'false',
        stateKey: 'modeBar.vars.off',
        descriptionKey: 'modeBar.vars.offHint'
      }
}

/** Narrow window or touch screen: the bar folds into one button and a bottom sheet. */
export const COMPACT_MEDIA_QUERY = '(max-width: 600px), (pointer: coarse)'

export function isCompactLayout(input: { width: number; coarsePointer: boolean }): boolean {
  return input.coarsePointer || input.width <= 600
}

/**
 * Next index for arrow-key navigation in a menu, skipping disabled entries.
 * Returns the current index when nothing else is enabled.
 */
export function moveMenuFocus(
  current: number,
  direction: 1 | -1 | 'first' | 'last',
  disabled: readonly boolean[]
): number {
  const count = disabled.length
  if (count === 0) return -1
  if (direction === 'first' || direction === 'last') {
    const order = [...Array(count).keys()]
    if (direction === 'last') order.reverse()
    const found = order.find((i) => !disabled[i])
    return found ?? current
  }
  for (let step = 1; step <= count; step++) {
    const i = (((current + direction * step) % count) + count) % count
    if (!disabled[i]) return i
  }
  return current
}
