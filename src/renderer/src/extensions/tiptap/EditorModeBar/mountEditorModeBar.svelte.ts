import { mount, unmount } from 'svelte'
import type { Editor } from '@tiptap/core'
import EditorModeBar from './components/EditorModeBar.svelte'

/**
 * One mode bar per editor container.
 *
 * Two extensions contribute to it: CustomReviewExtension (the mode button)
 * and CustomAIExtension (@ Variables and AI). Each calls
 * attachEditorModeBar from its onCreate; the first call mounts the bar and
 * the second only turns its section on, so the editor shows a single bar.
 *
 * The host is placed just before the scrolling editor shell, not inside it:
 * a zero-height block there lets the bar float over the top of the editor
 * area without scrolling away with the page and without taking a column of
 * the page layout (the former AI button was a 48px wide flex child of the
 * shell). In spreadsheets the same host becomes a docked strip, see
 * EditorModeBar.svelte.
 */

type Section = 'review' | 'ai'

type Entry = {
  editor: Editor
  host: HTMLElement
  props: { editor: Editor; review: boolean; ai: boolean; root: HTMLElement; host: HTMLElement }
  component: ReturnType<typeof mount>
}

const entries = new WeakMap<HTMLElement, Entry>()

export function attachEditorModeBar(
  editor: Editor,
  root: HTMLElement | null | undefined,
  section: Section
): void {
  if (!root) return
  let existing = entries.get(root)
  if (existing && existing.editor !== editor && existing.editor.isDestroyed) {
    // The container outlived its editor (re-created editor): start over.
    unmount(existing.component)
    existing.host.remove()
    entries.delete(root)
    existing = undefined
  }
  if (existing) {
    // A second editor resolving to the same container (the review extension
    // falls back to the active editor's container for nested editors such as
    // slide text boxes) must not stack a second bar there: the bar's commands
    // already act on the active editor.
    if (existing.editor !== editor) return
    existing.props[section] = true
    return
  }

  const host = document.createElement('div')
  host.className = 'app-component-no-print editor-mode-bar-host'
  const parent = root.parentElement
  if (parent) parent.insertBefore(host, root)
  else root.prepend(host)

  const props = $state({
    editor,
    review: section === 'review',
    ai: section === 'ai',
    root,
    host
  })
  const component = mount(EditorModeBar, { target: host, props })
  entries.set(root, { editor, host, props, component })

  editor.on('destroy', () => {
    const entry = entries.get(root)
    if (entry?.component !== component) return
    entries.delete(root)
    unmount(component)
    host.remove()
  })
}
