<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onMount, onDestroy } from 'svelte'
  import { createDesign, ownDesignStore } from '../collab/collab'
  import { createCanvasCommands, type CanvasCommands } from '../../../../commands/canvasCommands'
  import { _$_canvasCommands } from '../../../../stores/canvas.store'
  import SkiaCanva from './canvas/SkiaCanva.svelte'
  import { NodeViewWrapper } from 'svelte-tiptap'
  import { _$_wysiwygEditorsList, _$_documentEditorsList } from '../../../../stores/editor.store'
  import { CustomDesignExtensionProps } from '../utils/common.utils'
  import type { CollaborativeCanvas } from '../../../../utils/canvas.types'
  import { show, showOnly, showOnlyPrimarySidebarContent } from '../../../../stores/common.store'
  import Resizer from '../../../../components/app/editor/components/display/Resizer.svelte'
  import { GenericFormatingEditorCommands } from '../../../../components/common/actions/formatting/commands/GenericFormatingEditorCommands.svelte'
  import { get } from 'svelte/store'
  import { authStore } from '../../../../stores/auth.store'
  import { resolveLocalCollabPresence } from '../../../../utils/collabPresence'
  import { buildCollabDocId, resolveShareContext } from '../../../../utils/collabUtils'
  import {
    showNodeviewContextMenu,
    type NodeviewMenuEntry
  } from '../../../../utils/nodeviewContextMenu'
  import Platform from '../../../../libs/platform'
  import { fitHeightToPage, PAGE_CONTENT_HEIGHT_VAR } from '../../CustomPaginationExtension/pageFit'

  interface Props {
    node?: any
    view?: any
    getPos?: () => number
    updateAttributes?: (attrs: Record<string, any>) => void
    selected?: boolean
    extension?: any
    // The '?' here marks them as optional in the type system
    useNodeViewWrapper?: boolean
    isMirror?: boolean
    __src?: string

    __designId?: string
    // __designPath?: string
    __designHeight?: number
    __designWidth?: number
    __maxPageHeight?: number
    __maxPageWidth?: number
    __wysiwygEditorIdToUpdate?: string
  }

  let {
    node, // The Prosemirror node (contains attributes)
    view, // The editor view
    getPos, // Function to get the current position
    updateAttributes, // Function to update node attributes
    selected, // Boolean: is the node selected?
    extension, // The extension instance
    useNodeViewWrapper = true, // Default to true for normal Tiptap use
    isMirror = false,
    __src, //make it optional
    __designId,
    // __designPath,

    __designHeight,
    __designWidth,
    __maxPageHeight,
    __maxPageWidth,
    __wysiwygEditorIdToUpdate
  }: Props = $props()

  const DEFAULT_DESIGN_WIDTH = 800
  // const DEFAULT_DESIGN_HEIGHT = 100
  const DEFAULT_DESIGN_HEIGHT = 1200
  const DEFAULT_DESIGN_BG = '#fff'

  // Derived values: Use the prop if passed, otherwise fall back to the Tiptap node attribute
  let _designId = $derived(__designId || node?.attrs?.id)
  let _src = $derived(__src ?? node?.attrs?.src)
  const _maxPageHeight = $derived(__maxPageHeight || node?.attrs?.maxPageHeight)
  const _maxPageWidth = $derived(__maxPageWidth ?? node?.attrs?.maxPageWidth)

  const _designHeight = $derived.by(() => {
    const requested =
      __designHeight ?? node?.attrs?.designHeight ?? _maxPageHeight ?? DEFAULT_DESIGN_HEIGHT
    return _paginated ? fitToPage(requested) : requested
  })
  const _designWidth = $derived(
    __designWidth ?? node?.attrs?.designWidth ?? _maxPageWidth ?? DEFAULT_DESIGN_WIDTH
  )
  const _layout = $derived(node?.attrs?.layout ?? 'inline')
  const _offsetX = $derived(Number(node?.attrs?.offsetX ?? 0))
  const _offsetY = $derived(Number(node?.attrs?.offsetY ?? 0))

  const _wysiwygEditorIdToUpdate = $derived(
    __wysiwygEditorIdToUpdate ?? node?.attrs?.wysiwygEditorIdToUpdate
  )
  const _parentDoc = $derived(get(_$_documentEditorsList.get(_wysiwygEditorIdToUpdate))?.document)

  const _userInfo = $derived.by(() => {
    const authState = get(authStore)
    const shareContext = resolveShareContext(_parentDoc)
    const presence = resolveLocalCollabPresence({
      docId: _collabDocId || 'design-init',
      authUser: authState?.authenticated ? authState.user : null,
      forceAnonymous: Boolean(shareContext)
    })
    return { name: presence.name, color: presence.color }
  })

  const paginationStore = _$_wysiwygEditorsList.getPaginationOptionsStore(_wysiwygEditorIdToUpdate)
  // Now $derived will track $paginationStore correctly!
  let _editorPaginationOptions = $derived($paginationStore || null)
  const _paginated = $derived(Boolean(_editorPaginationOptions?.enabled))

  // In a paginated document the canvas must fit in a page's content area,
  // header and footer excluded: maxPageHeight only estimates them, and a
  // block taller than the area fits between no two page breaks (#117). The
  // pagination extension keeps the measured area on the editor
  // (PAGE_CONTENT_HEIGHT_VAR); the node view adds its margins and border,
  // and 10px are left to spare.
  const NODEVIEW_VERTICAL_CHROME = 42
  let _pageContentHeight = $state<number | null>(null)
  function readPageContentHeight(): void {
    const dom = view?.dom as HTMLElement | undefined
    const value = parseFloat(dom?.style?.getPropertyValue(PAGE_CONTENT_HEIGHT_VAR) ?? '')
    const next = Number.isFinite(value) && value > 0 ? value : null
    if (next !== _pageContentHeight) _pageContentHeight = next
  }
  readPageContentHeight()
  function fitToPage(height: number | string): number {
    const value = typeof height === 'number' ? height : parseFloat(String(height))
    return fitHeightToPage(value, _pageContentHeight, NODEVIEW_VERTICAL_CHROME)
  }
  const _fittedMaxPageHeight = $derived(
    _paginated && _maxPageHeight != null ? fitToPage(_maxPageHeight) : _maxPageHeight
  )
  let _pageAreaObserver: MutationObserver | null = null

  // IMPORTANT: If isMirror is true, we MUST force useNodeViewWrapper to false
  const _shouldWrap = $derived(useNodeViewWrapper && !isMirror)

  let _collabDocId = $state('')
  $effect(() => {
    if (_parentDoc && _src) {
      buildCollabDocId(_parentDoc, _src).then((id) => {
        _collabDocId = id
      })
    }
  })

  // Which panes show (Design tools or the regular activity bar and sidebar) is
  // derived by ActivityBar and SecondarySideBar from the active node view.

  // export let __designId = "id1"
  // export let __designPath = "~/Library/Application Support/ddoc-office/ddoc-office/test/assets/design/Design.json"
  // export let __designHeight: number = null
  // export let __designWidth: number = null
  // export let __maxPageHeight: number = null
  // export let __maxPageWidth: number = null
  // export let __wysiwygEditorIdToUpdate: string = null

  let _design: CollaborativeCanvas = $state(null)
  let _commands: CanvasCommands
  let _containeEl: HTMLElement
  let _nodeViewRoot: HTMLDivElement | null = null
  let _isVisible = $state(false)
  let _observer: IntersectionObserver | null = null
  let _initStarted = false

  function setActiveNodeview() {
    if (!_wysiwygEditorIdToUpdate || !_designId) return
    _$_wysiwygEditorsList.registerNodeview(_wysiwygEditorIdToUpdate, {
      id: _designId,
      type: CustomDesignExtensionProps.name,
      collaborativeCanvas: _design,
      isActive: false
    })
    _$_wysiwygEditorsList.setActiveNodeview(_wysiwygEditorIdToUpdate, _designId)
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault()
    // The document's own text menu would open on top of this one otherwise.
    event.stopPropagation()
    setActiveNodeview()
    const layout = (value: string) => () =>
      GenericFormatingEditorCommands.setActiveNodeviewLayout?.(value)
    const nudge = (dx: number, dy: number) => () =>
      GenericFormatingEditorCommands.nudgeActiveNodeview?.(dx, dy)

    // A right-click on an object selects it first (SkiaCanva), so the
    // selection is what the object entries act on.
    const selectedIds = _commands?.getSelectedIds?.() ?? []
    const objectEntries: NodeviewMenuEntry[] = selectedIds.length
      ? [
          {
            label: $_('Duplicate'),
            run: () => selectedIds.forEach((id) => _commands?.duplicateShape(id))
          },
          { label: $_('Bring forward'), run: () => _commands?.bringForward() },
          { label: $_('Send backward'), run: () => _commands?.sendBackward() },
          { label: $_('Delete'), run: () => _commands?.deleteSelected() },
          { separator: true }
        ]
      : []

    // Plain entries: the menu helper turns them into a clone-safe template
    // for the native menu and keeps the handlers here (#100).
    showNodeviewContextMenu(
      [
        ...objectEntries,
        { label: $_('In line with text'), run: layout('inline') },
        { separator: true },
        { label: $_('Center'), run: layout('center') },
        { label: $_('Full width'), run: layout('full') },
        { label: $_('Float left'), run: layout('float-left') },
        { label: $_('Float right'), run: layout('float-right') },
        { separator: true },
        { label: $_('In front of text'), run: layout('front') },
        { label: $_('Behind text'), run: layout('behind') },
        { separator: true },
        { label: $_('Nudge left'), run: nudge(-10, 0) },
        { label: $_('Nudge right'), run: nudge(10, 0) },
        { label: $_('Nudge up'), run: nudge(0, -10) },
        { label: $_('Nudge down'), run: nudge(0, 10) },
        {
          label: $_('Reset position'),
          run: () => GenericFormatingEditorCommands.resetActiveNodeviewPosition?.()
        }
      ],
      Platform.isDesktopPlatform
    )
  }

  const _placeholderHeight = $derived(
    (() => {
      const raw = _designHeight ?? _fittedMaxPageHeight ?? 320
      const value = typeof raw === 'number' ? raw : parseFloat(String(raw))
      return Number.isFinite(value) ? value : 320
    })()
  )
  const _layoutTakesSpace = $derived(!['front', 'behind'].includes(_layout))
  const _positionStyle = $derived(() => {
    const pieces = [`--nodeview-offset-x: ${_offsetX}px`, `--nodeview-offset-y: ${_offsetY}px`]
    if (_layoutTakesSpace) {
      pieces.push(`min-height: ${_placeholderHeight}px`)
    }
    return pieces.join('; ')
  })

  // A web design still on the drive-root store of before #149 gets its own
  // copy in its document folder, and points to it from now on.
  async function moveOffDriveRootStore(): Promise<void> {
    if (Platform.isDesktopPlatform) return
    const moved = await ownDesignStore(_designId, _src, _parentDoc?.path)
    if (!moved) return
    _src = moved
    updateAttributes?.({ [CustomDesignExtensionProps.tagAttributeSrc]: moved })
  }

  const initializeDesign = async () => {
    await moveOffDriveRootStore()
    _design = await createDesign(_designId, _src, _parentDoc, _userInfo)

    _designId = _designId || _design.id
    _src = _src || _design.path
    console.log('Syncing shapes createDesign...', {
      _design,
      __designId: _designId,
      _src,
      '_design.shapes': _design.shapes._length
    })

    const designMeta = _design.ydoc.getMap('meta')

    _commands = createCanvasCommands(_design.shapes, _design.texts, designMeta)

    // 🔑 expose commands globally (same as before)
    _$_canvasCommands.set(_designId, _commands)

    // Awareness scoped to this design
    _design.awareness.setLocalStateField('designId', _designId)

    // Register the nodeview
    _$_wysiwygEditorsList.registerNodeview(_wysiwygEditorIdToUpdate, {
      id: _designId,
      type: CustomDesignExtensionProps.name,
      collaborativeCanvas: _design,
      isActive: false
    })
    // Set only this to active, desactive others
    _$_wysiwygEditorsList.setActiveNodeview(_wysiwygEditorIdToUpdate, _designId)

    console.log(
      'yes focus registerNodeview',
      _wysiwygEditorIdToUpdate,
      _$_wysiwygEditorsList.getList(),
      _$_wysiwygEditorsList.getEntry(_wysiwygEditorIdToUpdate)
    )

    // Make the element focusable
    _containeEl.tabIndex = 0

    _containeEl.addEventListener('pointerdown', (e) => {
      _containeEl.focus()
      // onPointerDown(e)
    })
    _containeEl.addEventListener('click', (e) => {
      // _containeEl.addEventListener('focus', (e) => {
      console.log('yes click _containeEl', e)

      // Make sure designing toolbars are shown
      show('leftSidebar')
      show('secondarySidebar')

      // Set this nodeview as active
      _$_wysiwygEditorsList.setActiveNodeview(
        _wysiwygEditorIdToUpdate,
        // _$_wysiwygEditorsList.getActiveEntry().id
        _designId
      )
      // console.log('yes focus active', _$_wysiwygEditorsList.getActiveEntry())
    })
    _containeEl.addEventListener('blur', (e) => {
      console.log('yes blur _containeEl', e)
      // Unset this DESIGN
      // _$_wysiwygEditorsList.unsetActiveNodeview(__wysiwygEditorIdToUpdate, __DESIGNId)
    })
  }

  const ensureVisible = async () => {
    if (_isVisible) return
    _isVisible = true
    _observer?.disconnect()
    _observer = null
    if (_initStarted) return
    _initStarted = true
    await initializeDesign()
  }

  onMount(async () => {
    // The area changes with the page size, header and footer.
    readPageContentHeight()
    if (view?.dom && typeof MutationObserver !== 'undefined') {
      _pageAreaObserver = new MutationObserver(readPageContentHeight)
      _pageAreaObserver.observe(view.dom, { attributes: true, attributeFilter: ['style'] })
    }

    if (typeof IntersectionObserver === 'undefined') {
      await ensureVisible()
      return
    }

    _observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          ensureVisible()
        }
      },
      {
        root: view?.dom?.parentElement ?? null,
        rootMargin: '600px 0px'
      }
    )

    if (_nodeViewRoot) {
      _observer.observe(_nodeViewRoot)
    }
  })

  onDestroy(() => {
    _pageAreaObserver?.disconnect()
    _pageAreaObserver = null
    _observer?.disconnect()
    _observer = null
    _design?.provider.destroy()
    _design?.ydoc.destroy()
  })

  function onDesignCreated(width: number, height: number) {
    if (_design?.newlyCreated) {
      _commands.createDefaultCanvasContent(width, height)
    }
  }
</script>

{#if node && _shouldWrap}
  <NodeViewWrapper>
    <Resizer
      __width={_maxPageWidth}
      __height={_fittedMaxPageHeight}
      __direction="both"
      __lockAspectRatio={false}
      __updateAttributes={(newAttrs) => {}}
    >
      <div
        class="node-view-{CustomDesignExtensionProps.name} nodeview-position"
        data-layout={_layout}
        style={_positionStyle}
        bind:this={_nodeViewRoot}
        oncontextmenu={handleContextMenu}
      >
        <!-- <div> -->
        <!-- <div
      bind:this={_containeEl}
      tabindex="0"
      class="items-center max-w-[{_maxPageWidth}px] h-[{_maxPageHeight}px]
   max-h-[{_maxPageHeight}px] relative
   m-auto border border-dashed dark:border-dark rounded-[5px]
   "
    > -->
        <div
          bind:this={_containeEl}
          tabindex="0"
          class="items-center relative m-auto border border-dashed dark:border-dark rounded-[5px]"
          style:max-width={_editorPaginationOptions?.enabled ? `${_maxPageWidth}px` : 'none'}
          style:max-height={_paginated ? `${_fittedMaxPageHeight}px` : 'none'}
          style:width={_editorPaginationOptions?.enabled ? `${_maxPageWidth}px` : '100%'}
          style:height={_paginated ? `${_fittedMaxPageHeight}px` : 'auto'}
        >
          {#if _isVisible && _design}
            <SkiaCanva
              __canvaCommands={_commands}
              __canvaId={_designId}
              __canvaPath={_src}
              __shapes={_design.shapes}
              __texts={_design.texts}
              __provider={_design.provider}
              __awareness={_design.awareness}
              __canvaWidth={_designWidth}
              __canvaHeight={_designHeight}
              __maxPageWidth={_maxPageWidth}
              __maxPageHeight={_fittedMaxPageHeight}
              __wysiwygEditorIdToUpdate={_wysiwygEditorIdToUpdate}
              __onCreate={(w, h) => onDesignCreated(w, h)}
              __onSelect={(id, evt) => {
                if (!id) {
                  _commands.clearSelection()
                  _$_canvasCommands.set(_designId, _commands)
                  return
                }
                _commands.select(id, {
                  toggle: evt?.shiftKey || evt?.metaKey
                })
                _$_canvasCommands.set(_designId, _commands)
              }}
            />
          {:else}
            <div class="design-placeholder" style={`height: ${_placeholderHeight}px`}>
              {$_('Loading...')}
            </div>
          {/if}
        </div>
      </div>
    </Resizer>
  </NodeViewWrapper>
{:else}
  <!-- <div
    class="p-4 items-center max-w-[{_maxPageWidth}px]
   max-h-[{_maxPageHeight}px] relative
   m-auto border border-ligt dark:border-dark rounded-[5px]
   "
  > -->
  <Resizer
    __width={_maxPageWidth}
    __height={_fittedMaxPageHeight}
    __direction="both"
    __lockAspectRatio={false}
    __updateAttributes={(newAttrs) => {}}
  >
    <div
      class="node-view-{CustomDesignExtensionProps.name} nodeview-position"
      data-layout={_layout}
      style={_positionStyle}
      bind:this={_nodeViewRoot}
      oncontextmenu={handleContextMenu}
    >
      <div bind:this={_containeEl}>
        {#if _isVisible && _design}
          <SkiaCanva
            __canvaCommands={_commands}
            __canvaId={_designId}
            __canvaPath={_src}
            __shapes={_design.shapes}
            __texts={_design.texts}
            __provider={_design.provider}
            __awareness={_design.awareness}
            __canvaWidth={_designWidth}
            __canvaHeight={_designHeight}
            __maxPageWidth={_maxPageWidth}
            __maxPageHeight={_fittedMaxPageHeight}
            __wysiwygEditorIdToUpdate={_wysiwygEditorIdToUpdate}
            __onCreate={(w, h) => onDesignCreated(w, h)}
            __onSelect={(id, evt) => {
              if (!id) {
                _commands.clearSelection()
                _$_canvasCommands.set(_designId, _commands)
                return
              }
              _commands.select(id, {
                toggle: evt?.shiftKey || evt?.metaKey
              })
              _$_canvasCommands.set(_designId, _commands)
            }}
          />
        {:else}
          <div class="design-placeholder" style={`height: ${_placeholderHeight}px`}>
            {$_('Loading...')}
          </div>
        {/if}
      </div>
    </div>
  </Resizer>
{/if}

<style>
  .design-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed rgba(0, 0, 0, 0.2);
    color: #6f6f6f;
    background: rgba(0, 0, 0, 0.02);
  }
</style>
