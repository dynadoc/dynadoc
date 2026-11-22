import type { Editor } from '@tiptap/core'
import type { ContextMenuItem } from '../../../components/common/contextMenu/utils/utils'
import { GenericFormatingEditorCommands } from '../../../components/common/actions/formatting'
import { AI_TRACKING_PLUGIN_KEY } from '../CustomAIExtension/utils/aiTracking'

type AIBridge = { server?: { ai?: { abort?: () => void } } }

/** Stops the running AI generation and clears its tracking marks in `editor`. */
export function abortAIGeneration(editor: Editor | null): void {
  ;(window as unknown as AIBridge).server?.ai?.abort?.()
  if (editor) {
    const tr = editor.state.tr.setMeta(AI_TRACKING_PLUGIN_KEY, { action: 'clear' })
    editor.view.dispatch(tr)
  }
}

/**
 * The AI menu, item for item as the former sparkle button (CustomAIToolbar)
 * showed it. Labels are i18n keys: ContextMenuRow translates them.
 */
export function buildAIMenuItems(opts: {
  hasSelection: boolean
  generating: boolean
  abort: () => void
}): ContextMenuItem[] {
  const { hasSelection, generating, abort } = opts
  const needsSelection = (
    label: string,
    icon: string,
    action: () => unknown,
    group: number
  ): ContextMenuItem => ({
    label,
    icon,
    action: () => void action(),
    disabled: !hasSelection,
    tooltip: 'Select text to enable',
    group
  })

  return [
    {
      label: 'Generate',
      icon: 'ph-bold ph-sparkle',
      group: 1,
      children: [
        {
          label: 'Text',
          icon: 'ph-bold ph-text-t',
          action: () => void GenericFormatingEditorCommands.generateWithAI()
        },
        {
          label: 'Slides',
          icon: 'ph-bold ph-presentation',
          action: () => void GenericFormatingEditorCommands.generateSlidesWithAI()
        },
        {
          label: 'Spreadsheet',
          icon: 'ph-bold ph-table',
          action: () => void GenericFormatingEditorCommands.generateSpreadsheetWithAI()
        },
        {
          label: 'Design',
          icon: 'ph-bold ph-shapes',
          action: () => void GenericFormatingEditorCommands.generateDesignWithAI()
        },
        {
          label: 'LaTeX Project',
          icon: 'ph-bold ph-code',
          action: () => void GenericFormatingEditorCommands.generateLatexWithAI()
        }
      ]
    },
    needsSelection(
      'Summarize',
      'ph-bold ph-text-indent',
      () => GenericFormatingEditorCommands.summarizeWithAI(),
      1
    ),
    needsSelection(
      'Translate',
      'ph-bold ph-translate',
      () => GenericFormatingEditorCommands.translateWithAI(),
      1
    ),
    needsSelection(
      'Translate To',
      'ph-bold ph-translate',
      () => GenericFormatingEditorCommands.translateToWithAI(),
      1
    ),
    needsSelection(
      'Rewrite',
      'ph-bold ph-pen-nib',
      () => GenericFormatingEditorCommands.rewriteWithAI(),
      2
    ),
    {
      label: 'Business Presets',
      icon: 'ph-bold ph-briefcase',
      action: () => {},
      disabled: true,
      group: 2
    },
    needsSelection(
      'Executive Summary',
      'ph-bold ph-briefcase',
      () => GenericFormatingEditorCommands.executiveSummaryWithAI(),
      2
    ),
    needsSelection(
      'Investor Tone',
      'ph-bold ph-chart-line-up',
      () => GenericFormatingEditorCommands.investorToneWithAI(),
      2
    ),
    needsSelection(
      'Technical Rewrite',
      'ph-bold ph-code',
      () => GenericFormatingEditorCommands.technicalRewriteWithAI(),
      2
    ),
    needsSelection(
      'Expand',
      'ph-bold ph-plus-circle',
      () => GenericFormatingEditorCommands.expandWithAI(),
      2
    ),
    needsSelection(
      'Shorten',
      'ph-bold ph-minus-circle',
      () => GenericFormatingEditorCommands.shortenWithAI(),
      2
    ),
    needsSelection(
      'Fix Grammar',
      'ph-bold ph-check-circle',
      () => GenericFormatingEditorCommands.fixGrammarWithAI(),
      2
    ),
    needsSelection(
      'Bulletize',
      'ph-bold ph-list-bullets',
      () => GenericFormatingEditorCommands.bulletizeWithAI(),
      3
    ),
    needsSelection(
      'Outline',
      'ph-bold ph-list-numbers',
      () => GenericFormatingEditorCommands.outlineWithAI(),
      3
    ),
    needsSelection(
      'Action Items',
      'ph-bold ph-check-square',
      () => GenericFormatingEditorCommands.extractActionItemsWithAI(),
      3
    ),
    needsSelection(
      'Simplify',
      'ph-bold ph-wind',
      () => GenericFormatingEditorCommands.simplifyWithAI(),
      3
    ),
    {
      label: 'Insert AI Block',
      icon: 'ph-bold ph-cursor-text',
      action: () => void GenericFormatingEditorCommands.insertAI(),
      group: 4
    },
    {
      label: 'Stop Generation',
      icon: 'ph-bold ph-stop-circle',
      action: abort,
      disabled: !generating,
      group: 4
    }
  ]
}
