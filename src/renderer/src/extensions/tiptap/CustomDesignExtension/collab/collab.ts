import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import Utils from '../../../../utils/Utils'
import EditorHelpers from '../../../../utils/EditorHelpers'
import { v4 as uuidv4 } from 'uuid'
import { DocumentModel } from '../../../../models/Document'
import { createCanvas, type CollaborativeCanvas } from '../../../../utils/canvas.utils'
import { copyDriveRootStore, isDriveRootAssetPath } from '../../../../utils/assetRoot'
import { writeFileEnsuringDirAsync } from '../../../../utils/documentFileUtils'
import { nodeApi } from '../../../../utils/shims/node'

// import { nodeApi } from '../../../../utils/shims/node'
// const COMPACT_AFTER = 50

/* export interface CollaborativeCanvas {
    id: string
    path: string
    ydoc: Y.Doc
    provider: WebsocketProvider
    shapes: Y.Map<any>
    texts: Y.Map<Y.XmlFragment>
    designMeta: Y.Map<any>
    awareness: Awareness,
    newlyCreated: boolean
} */

/* export function serializeYDoc(ydoc: Y.Doc): string {
    const update = Y.encodeStateAsUpdate(ydoc)
    return Buffer.from(update).toString('base64')
}

/* export function loadYDoc(ydoc: Y.Doc, base64: string) {
    const update = Uint8Array.from(Buffer.from(base64, 'base64'))
    Y.applyUpdate(ydoc, update)
} +/

export function loadYDoc(ydoc: Y.Doc, base64?: string) {
    if (!base64) return
    const update = Uint8Array.from(Buffer.from(base64, 'base64'))
    Y.applyUpdate(ydoc, update)
}





function serializeUpdate(update: Uint8Array): string {
    return Buffer.from(update).toString('base64')
}

function deserializeUpdate(base64: string): Uint8Array {
    return Uint8Array.from(Buffer.from(base64, 'base64'))
}


export function encodeSnapshot(ydoc: Y.Doc): string {
    return serializeUpdate(Y.encodeStateAsUpdate(ydoc))
}
 */

export async function createDesign(designId?: string, designPath?: string, parentDoc?: any, userInfo?: { name: string, color: string }): Promise<CollaborativeCanvas> {
    return await createCanvas(DocumentModel.AssetType.DESIGN, designId, designPath, {}, parentDoc, userInfo)
}

/**
 * Before #149 every design on the web was given `assets/design/<name>.json`
 * at the drive root, one file for all of them. For a design still pointing
 * there, copies that file into its document's own `assets/design/` folder and
 * returns the new path; null when there is nothing to move. The shared file
 * is left in place, so nothing is lost, whichever design opens first. Each
 * design gets every shape the shared file holds, other designs' included.
 *
 * The copy is named after the design's id: it can never land on another
 * design's file, and a design whose new `src` was not saved finds its own
 * copy again on the next open instead of copying the shared file anew.
 */
export async function ownDesignStore(
    designId?: string,
    src?: string,
    documentPath?: string
): Promise<string | null> {
    const type = DocumentModel.AssetType.DESIGN
    if (!designId || !documentPath || !isDriveRootAssetPath(src, type)) return null
    const target = (
        await DocumentModel.getAssetFilePathFromDocument(type, documentPath, `design-${designId}.json`)
    )?.filePath
    return copyDriveRootStore(src, target, type, {
        exists: async (filePath) => Boolean(await nodeApi.fsPromises.exists(filePath)),
        readFile: async (filePath) => String(await nodeApi.fsPromises.readFile(filePath, 'utf-8')),
        writeFile: async (filePath, data) => {
            await writeFileEnsuringDirAsync(filePath, data, 'utf-8')
        }
    })
}

/* export function createDesign(designId?: string, designPath?: string): CollaborativeCanvas {

    return createCanvas(designId, designPath)

    // Create one if not provided
    designId = designId || uuidv4()
    designPath = designPath || (DocumentModel.getAssetFilePathFromDocument(DocumentModel.AssetType.DESIGN))?.filePath


    const ydoc = new Y.Doc()
    let newlyCreated = true

    // ------------------------------------
    // 1️⃣ Load from disk (SAFE)
    // ------------------------------------
    let persisted = { snapshot: null, updates: [] as string[] }

    if (nodeApi.fs.existsSync(designPath)) {
        persisted = JSON.parse(await nodeApi.fsPromises.readFile(designPath, 'utf-8'))
    } else {
        EditorHelpers.writeFileEnsuringDir(designPath, JSON.stringify(persisted))
    }

    // 1️⃣ Apply snapshot first
    if (persisted.snapshot) {
        Y.applyUpdate(ydoc, deserializeUpdate(persisted.snapshot))
        newlyCreated = false
    }

    // 2️⃣ Apply incremental updates
    for (const u of persisted.updates) {
        Y.applyUpdate(ydoc, deserializeUpdate(u))
    }

    // ------------------------------------
    // 2️⃣ WebSocket provider (collab)
    // ------------------------------------
    const provider = new WebsocketProvider(
        'ws://localhost:1234',
        // `design-1`,
        `design:${designPath}`,
        // `design:${nodeApi.path.basename(designPath)}`,
        // `design-${designId}`,
        ydoc
    )

    // ------------------------------------
    // 3️⃣ Shared types (canonical)
    // ------------------------------------
    const shapes = ydoc.getMap<any>('shapes')
    const texts = ydoc.getMap<Y.XmlFragment>('texts')
    const meta = ydoc.getMap<any>('meta')

    // ------------------------------------
    // 4️⃣ Persistence (NO DROPPED UPDATES)
    // ------------------------------------
    ydoc.on('update', update => {
        persisted.updates.push(serializeUpdate(update))

        // Compact periodically
        if (persisted.updates.length >= COMPACT_AFTER) {
            persisted.snapshot = encodeSnapshot(ydoc)
            persisted.updates = []
        }

        EditorHelpers.writeFileEnsuringDir(
            designPath,
            JSON.stringify(persisted)
        )
    })

    // ------------------------------------
    // 5️⃣ Return API
    // ------------------------------------
    return {
        id: designId,
        path: designPath,
        ydoc,
        provider,
        shapes,
        texts,
        meta,
        awareness: provider.awareness,
        newlyCreated
    }
} */
