import { v4 as uuidv4 } from 'uuid'
import EditorHelpers from '../../../utils/EditorHelpers'

import { Editor, Node, mergeAttributes } from '@tiptap/core'
import { mount, unmount } from 'svelte'
// const nodeApi =
//   typeof window !== 'undefined' ? (window as any)?.api?.node || (window as any)?.node : null
// const fs = nodeApi?.fs
// const path = nodeApi?.path

// import SpreadsheetEditor from './components/react/SpreadsheetEditor'
import SpreadsheetEditor from './components/SpreadsheetEditor.svelte'
import { SvelteNodeViewRenderer } from 'svelte-tiptap';
import { CustomSpreadsheetExtensionProps } from './utils/common.utils';
import { DocumentModel } from '../../../models/Document'
import { ensureNodeViewSrc } from '../utils/utils'
import { nodeApi } from '../../../utils/shims/node'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
// import { ReactNodeViewRenderer } from '@tiptap/react'


export interface PaginationOptions {
    maxPageHeight: number
    maxPageWidth: number
    wysiwygEditorIdToUpdate: string
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        CustomSpreadsheetExtension: {
            insertSpreadsheet: (attrs?) => ReturnType
        }
    }
}


let extensionName = CustomSpreadsheetExtensionProps.name
let extensionTagName = CustomSpreadsheetExtensionProps.tagName
let extensionTagAttributeSrc = CustomSpreadsheetExtensionProps.tagAttributeSrc

// let extensionName = 'sheet'
// let extensionTagName = 'sheet'
// let extensionTagAttributeSrc = 'src'

const defaultOptions: PaginationOptions = {
    maxPageHeight: null,
    maxPageWidth: null,
    wysiwygEditorIdToUpdate: null
}
// True when the editor's selection is the whole <sheet> node.
function isSheetNodeSelected(state): boolean {
    const { selection } = state
    return selection instanceof NodeSelection && selection.node?.type?.name === extensionName
}

// A spreadsheet document is one <sheet> and nothing else but empty
// paragraphs. Read from the editor's own document, not from the active
// document's kind, which belongs to whichever tab is in front.
function isSpreadsheetDocument(doc): boolean {
    let sheets = 0
    let other = false
    doc?.forEach?.((child) => {
        if (child.type.name === extensionName) sheets++
        else if (!(child.isTextblock && child.content.size === 0)) other = true
    })
    return sheets === 1 && !other
}

// True when the selection covers a <sheet> node: a node selection on it, or a
// range such as Ctrl+A that contains it.
function selectionHoldsSheet(state): boolean {
    if (isSheetNodeSelected(state)) return true
    const { from, to, empty } = state.selection
    if (empty) return false
    let found = false
    state.doc.nodesBetween(from, to, (node, pos) => {
        if (found) return false
        if (node.type.name === extensionName && pos >= from && pos + node.nodeSize <= to) {
            found = true
        }
        return !found
    })
    return found
}

// Whether input that would replace the selection must be dropped. In a
// spreadsheet document nothing may replace the sheet; in a text document,
// typing or pasting over a selected sheet is refused too, since one key would
// remove a whole workbook from the page.
function mustKeepSheet(state): boolean {
    if (isSpreadsheetDocument(state.doc)) return selectionHoldsSheet(state)
    return isSheetNodeSelected(state)
}

export const CustomSpreadsheetExtension = Node.create({
    name: extensionName,
    group: 'block',
    // atom: true,
    // selectable: false,
    // content: 'inline*',

    // group: 'inline',
    // inline: true,
    // draggable: true,
    // atom: true,
    // selectable: true,


    // atom: true,        // Required: Treats the node as a single unit
    selectable: true,  // Required: Allows the node to be "active"
    draggable: true,

    addAttributes() {
        return {
            [EditorHelpers.uuidAttributeName]: {
                default: () => uuidv4(),
                parseHTML: (element) =>
                    element.getAttribute(EditorHelpers.uuidAttributeName) ||
                    element.getAttribute(EditorHelpers.dataUuidAttributeName),
                renderHTML: (attributes) =>
                    attributes?.[EditorHelpers.uuidAttributeName]
                        ? {
                            [EditorHelpers.uuidAttributeName]: attributes[EditorHelpers.uuidAttributeName],
                            [EditorHelpers.dataUuidAttributeName]: attributes[EditorHelpers.uuidAttributeName]
                        }
                        : {}
            },
            id: { default: '' },
            type: { default: 'text' },
            label: { default: '' },
            name: { default: '' },
            placeholder: { default: '' },
            value: { default: '' },
            options: { default: [] },
            required: { default: false },
            [extensionTagAttributeSrc]: { default: '' },
            layout: { default: 'inline' },
            offsetX: { default: 0 },
            offsetY: { default: 0 },
            // src: node.attrs[extensionTagAttributeSrc],
            maxPageHeight: { default: this.options.maxPageHeight },
            maxPageWidth: { default: this.options.maxPageWidth },
            wysiwygEditorIdToUpdate: { default: this.options.wysiwygEditorIdToUpdate },
        }
    },
    
    // INNOVATIVE: Enhanced Event Handling for Spreadsheet Deletion
    // Allows keyboard events to bubble up so deletion works correctly
    stopEvent(event) {
        // Allow Backspace/Delete to propagate when the node is selected
        if (event.type === 'keydown') {
            const keyEvent = event as KeyboardEvent;
            // Check if Backspace or Delete is pressed
            if (keyEvent.code === 'Backspace' || keyEvent.code === 'Delete' || keyEvent.key === 'Backspace' || keyEvent.key === 'Delete') {
                // Don't stop the event - let it bubble to the editor for deletion handling
                return false;
            }
        }
        
        // For mouse events inside the spreadsheet, let them be handled by the spreadsheet
        // Only prevent them if absolutely necessary
        if (event.type === 'mousedown' || event.type === 'click') {
            // Allow clicks inside to focus the spreadsheet
            return false;
        }
        
        return true; // Stop other events from propagating
    },

    addOptions() {
        return defaultOptions;
    },

    parseHTML() {
        return [{ tag: extensionName }]
    },

    renderHTML({ HTMLAttributes }) {
        return [extensionName, mergeAttributes(HTMLAttributes)]
    },



    onCreate({ editor }) {
        // console.log("CustomSpreadsheetExtension onCreate", this.options.maxPageHeight)
    },

    onUpdate({ editor }) {

    },
    addNodeView() {
        return SvelteNodeViewRenderer(SpreadsheetEditor);

        // return ReactNodeViewRenderer(SpreadsheetEditor)
        // return {
        // ReactNodeViewRenderer(SpreadsheetEditor)
        // destroy,
        // }
    },

    // ✅ Pure NodeView that manually mounts a Svelte component
    // addNodeView() {
    //     return ({ node, editor, getPos }) => {
    //             return ReactNodeViewRenderer(SpreadsheetEditor)
    //         //   return SvelteNodeViewRenderer(SpreadsheetEditor);

    //         /* const nodeId = node.attrs.id
    //         // const nodeId = node.attrs.id || uuidv4()
    //         // const nodeId = node.attrs.id || cryptoRandomUUID()
    //         const dom = document.createElement('span')
    //         dom.classList.add('sheet-wrapper')

    //         // Create reactive props object
    //         const props = $state({
    //             __src: node.attrs[extensionTagAttributeSrc],
    //             __maxPageHeight: this.options.maxPageHeight,
    //             __maxPageWidth: this.options.maxPageWidth,
    //             __wysiwygEditorIdToUpdate: this.options.wysiwygEditorIdToUpdate,

    //         })
    //         //  initNodeFieldValues()

    //         // Mount Svelte component (Svelte 5)
    //         //  const { destroy: unmountComponent } = mount(FormFieldView, {
    //         const component = mount(SpreadsheetEditor, {
    //             target: dom,
    //             props
    //         })


    //         const destroy = () => {
    //             if (component) unmount(component)
    //             // component.$destroy()
    //             // component.destroy?.()
    //         }

    //         return {
    //             dom,
    //             // contentDOM: null, // Tells ProseMirror this is non editable
    //             contentDOM: component, // Tells ProseMirror this is editable
    //             // update,
    //             destroy,
    //         } */
    //     }
    // },


    // Typing or pasting with the sheet node selected replaced the whole
    // workbook block with text, which the next autosave wrote as the document
    // (dynadoc#133). Keys meant for a cell that reach ProseMirror instead are
    // dropped here.
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('sheetNodeGuard'),
                props: {
                    handleTextInput: (view) => mustKeepSheet(view.state),
                    handlePaste: (view) => mustKeepSheet(view.state),
                    handleKeyDown: (view, event) => {
                        // Backspace and Delete still remove a sheet embedded in
                        // a text document; in a spreadsheet document they must not.
                        if (event.key !== 'Backspace' && event.key !== 'Delete') return false
                        return isSpreadsheetDocument(view.state.doc) && selectionHoldsSheet(view.state)
                    },
                    handleDOMEvents: {
                        // Cutting a sheet out of a text document is a move; out
                        // of a spreadsheet document it would empty the document.
                        cut: (view, event) => {
                            if (!isSpreadsheetDocument(view.state.doc) || !selectionHoldsSheet(view.state)) {
                                return false
                            }
                            event.preventDefault()
                            return true
                        }
                    }
                }
            })
        ]
    },

    addCommands() {
        return {
            // INNOVATIVE: Delete Spreadsheet Command
            // Allows proper deletion even when focus is inside the spreadsheet
            deleteSpreadsheet: () => ({ editor, state }) => {
                const { selection } = state;
                let foundPos = -1;
                
                // Find the spreadsheet node at the current selection
                state.doc.descendants((node, pos) => {
                    if (node.type.name === extensionName) {
                        // Check if the cursor is at or near this node
                        if (pos <= selection.from && pos + node.nodeSize >= selection.to) {
                            foundPos = pos;
                            return false; // Stop searching
                        }
                    }
                });
                
                if (foundPos > -1) {
                    // Delete the spreadsheet node at the found position
                    editor.chain()
                        .focus()
                        .setNodeSelection(foundPos)
                        .deleteSelection()
                        .run();
                    return true;
                }
                
                return false;
            },
            
            insertSpreadsheet1:
                (attrs = {}) =>
                    // ({ state, dispatch, editor }) => {
                    ({ chain, state }) => {
                        // 1. Generate ID immediately so it's locked to this specific action
                        const id = uuidv4();
                        // editor.chain().focus().insertContent({
                        chain().focus().insertContent({
                            type: this.name, // or extensionName
                            // attrs: attrs || {
                            attrs: {
                                ...attrs,
                                id: id,
                                // [extensionTagAttributeSrc]: src,
                                parentFilePath: this.options.wysiwygEditorIdToUpdate,
                            },
                            // attrs: attrs,
                            /* attrs: {
                              type: type,
                              label: 'Name',
                              placeholder: 'Enter your name',
                            }, */
                        }).run()
                        // .focus()
                        return true
                    },

            insertSpreadsheet: (attrs = null) => ({ editor }) => {
                // 1. Generate ID immediately so it's locked to this specific action
                const id = (attrs && (attrs as any).id) || uuidv4();

                // 2. Start the async work in the background
                (async () => {
                    try {
                        // Fetch the asset path
                        const src = await ensureNodeViewSrc(
                            '',
                            'spreadsheet',
                            DocumentModel.AssetType.SHEET,
                            undefined,
                            undefined,
                            ''
                        );

                        // 3. SAFETY CHECK: Ensure editor wasn't destroyed during the await
                        if (editor.isDestroyed) return;

                        // 4. Dispatch the content insertion
                        // We use editor.commands to ensure a fresh transaction
                        editor.chain()
                            .focus()
                            .insertContent({
                                type: this.name, // or extensionName
                                attrs: {
                                    ...(attrs || {}),
                                    id: id,
                                    [extensionTagAttributeSrc]: src,
                                    parentFilePath: this.options.wysiwygEditorIdToUpdate,
                                }
                            })
                            .run();

                    } catch (error) {
                        console.error("Failed to fetch spreadsheet path:", error);
                    }
                })();

                // 5. Return true synchronously to notify Tiptap the command was handled
                return true;
            },

        }
    },

    // INNOVATIVE: Enhanced Keyboard Shortcuts for Spreadsheet Management
    addKeyboardShortcuts() {
        return {
            // Allow Escape to deselect the spreadsheet and allow normal backspace
            'Escape': ({ editor }) => {
                const { state } = editor;
                const { selection } = state;
                
                // Check if a spreadsheet node is currently selected
                let isSpreadsheetSelected = false;
                state.doc.descendants((node, pos) => {
                    if (node.type.name === extensionName && 
                        pos <= selection.from && 
                        pos + node.nodeSize >= selection.to) {
                        isSpreadsheetSelected = true;
                        return false;
                    }
                });
                
                if (isSpreadsheetSelected) {
                    // Move cursor outside the spreadsheet to allow normal editing
                    const node = state.doc.nodeAt(selection.from);
                    if (node && node.type.name === extensionName) {
                        // Focus after the spreadsheet
                        editor.chain().focus(selection.from + node.nodeSize + 1).run();
                    }
                    return true;
                }
                
                return false;
            },
            
            // Custom handling for backspace when spreadsheet is selected
            'Backspace': ({ editor }) => {
                if (isSpreadsheetDocument(editor.state.doc)) return false

                const { state } = editor;
                const { selection } = state;
                
                // Check if we're adjacent to or inside a spreadsheet node
                let adjacentSpreadsheetPos = -1;
                
                // Search for spreadsheet node before cursor
                state.doc.nodesBetween(Math.max(0, selection.from - 50), selection.from, (node, pos) => {
                    if (node.type.name === extensionName && pos + node.nodeSize >= selection.from) {
                        adjacentSpreadsheetPos = pos;
                    }
                });
                
                if (adjacentSpreadsheetPos > -1) {
                    // Select and delete the spreadsheet
                    editor.chain()
                        .focus()
                        .setNodeSelection(adjacentSpreadsheetPos)
                        .deleteSelection()
                        .run();
                    return true;
                }
                
                return false;
            },

            // Custom handling for delete key
            'Delete': ({ editor }) => {
                if (isSpreadsheetDocument(editor.state.doc)) return false

                const { state } = editor;
                const { selection } = state;
                
                // Check if we're adjacent to or inside a spreadsheet node
                let adjacentSpreadsheetPos = -1;
                
                // Search for spreadsheet node after cursor
                state.doc.nodesBetween(selection.to, Math.min(state.doc.content.size, selection.to + 50), (node, pos) => {
                    if (node.type.name === extensionName && pos <= selection.to) {
                        adjacentSpreadsheetPos = pos;
                        return false;
                    }
                });
                
                if (adjacentSpreadsheetPos > -1) {
                    // Select and delete the spreadsheet
                    editor.chain()
                        .focus()
                        .setNodeSelection(adjacentSpreadsheetPos)
                        .deleteSelection()
                        .run();
                    return true;
                }
                
                return false;
            }
        };
    },

})
