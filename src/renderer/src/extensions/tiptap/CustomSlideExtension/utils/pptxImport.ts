import { PowerPointParser, PPTXParser } from '@cliftonc/pptx-to-json'
import { convertPresentationToSlidesHtml } from './presentationImport'
import { pptxToPresentation } from './pptxMapping'
import { checkZipLimits } from '../../../../shared/zipLimits'
import { nodeApi } from '../../../../utils/shims/node'

// const fs = nodeApi.fs
// const path = nodeApi.path

// const fs = window.node?.fs
// const path = window.node?.path

// const nodeApi =
//   typeof window !== 'undefined' ? (window as any)?.api?.node || (window as any)?.node : null
// const fs = nodeApi?.fs
// const path = nodeApi?.path

type AssetPathResolver = (
  assetType: string,
  mainFilePath?: string,
  fileName?: string
) => Promise<{ filePath: string } | null>

export async function convertPptxToSlidesHtml(
  pptxPath: string,
  tempDir: string,
  mainFilePath: string,
  resolveAssetPath: AssetPathResolver,
  slideAssetType: string
): Promise<string> {
  // Parsed here with @cliftonc/pptx-to-json: text with its runs, positions,
  // shapes, images (as data: URIs), notes, and the slide backgrounds read from
  // the raw parts. pptxMapping.ts turns that into the presentation shape the
  // slide files are written from.
  const bytes = new Uint8Array(await nodeApi.fsPromises.readFile(pptxPath))
  // The parser inflates the whole archive in memory: refuse oversized ones first.
  const problem = checkZipLimits(bytes)
  if (problem) throw new Error(problem)
  const raw = await new PPTXParser().buffer2json(bytes)
  const parsed = await new PowerPointParser().parseJson(raw)
  return convertPresentationToSlidesHtml(
    pptxToPresentation(parsed, raw),
    tempDir,
    mainFilePath,
    resolveAssetPath,
    slideAssetType
  )
}
