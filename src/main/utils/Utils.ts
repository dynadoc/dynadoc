import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { ZipFile } from 'yazl'
import * as yauzl from 'yauzl'
import { pipeline as pipelineCb } from 'stream'
import { promisify } from 'util'

const pipeline = promisify(pipelineCb)

export default class Utils {
  static DDOC_EXTENSIONS = {
    default: '.xddoc',
    secured: '.sddoc'
  }

  static MAIN_DOCUMENT_FILE = 'index.html'

  static async ddocify(
    _pipelineStream: typeof pipeline,
    folderPath: string,
    outputFile: string,
    shouldSecured?: boolean
  ): Promise<string> {
    let finalOutput = outputFile
    const ext = path.extname(outputFile).toLowerCase()
    if (ext !== this.DDOC_EXTENSIONS.default && ext !== this.DDOC_EXTENSIONS.secured) {
      finalOutput = outputFile + (shouldSecured ? this.DDOC_EXTENSIONS.secured : this.DDOC_EXTENSIONS.default)
    }

    const stats = await fsp.stat(folderPath)
    let sourcePath = folderPath
    if (stats.isFile()) {
      const baseName = path.basename(folderPath, path.extname(folderPath))
      const parentDir = path.dirname(folderPath)
      const tempDir = path.join(parentDir, baseName)
      await fsp.mkdir(tempDir, { recursive: true })
      const destFile = path.join(tempDir, this.MAIN_DOCUMENT_FILE)
      try {
        await fsp.access(destFile)
      } catch {
        await fsp.copyFile(folderPath, destFile)
      }
      sourcePath = tempDir
    }

    // Write next to the target, then rename over it. A save interrupted half
    // way (a crash, a full disk, a source file that vanished) used to leave a
    // truncated archive in place of the user's document; now the document on
    // disk is either the previous version or the new one, never half of each.
    // The temporary file lives in the target's own directory so the final
    // rename stays on one filesystem, and it is written by this process only:
    // the renderer never sees or names it.
    const resolvedFinal = path.resolve(finalOutput)
    const partial = `${resolvedFinal}.${process.pid}-${Date.now().toString(36)}.partial`
    try {
      await this.zipDirectory(sourcePath, partial, [resolvedFinal])
      await fsp.rename(partial, resolvedFinal)
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => {})
      throw error
    }
    return finalOutput
  }

  static async unddocify(
    _pipelineStream: typeof pipeline,
    inputFile: string,
    outputDir: string,
    _isSecured?: boolean
  ): Promise<string> {
    const destDir = path.join(outputDir)
    await fsp.mkdir(destDir, { recursive: true })
    return await this.unzipToDir(inputFile, destDir)
  }

  private static resolveExtractedRoot(
    destDir: string,
    topLevelEntries: Set<string>,
    topLevelFiles: Set<string>
  ) {
    if (topLevelEntries.size === 1 && topLevelFiles.size === 0) {
      return path.join(destDir, Array.from(topLevelEntries)[0])
    }
    return destDir
  }

  private static async zipDirectory(
    sourceDir: string,
    outputFile: string,
    alsoExclude: readonly string[] = []
  ) {
    const resolvedOutputFile = path.resolve(outputFile)
    const excluded = new Set([resolvedOutputFile, ...alsoExclude.map((p) => path.resolve(p))])
    await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true })
    const zipfile = new ZipFile()
    const out = fs.createWriteStream(resolvedOutputFile)

    const done = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        out.destroy()
        reject(error)
      }
      out.on('close', () => resolve())
      out.on('error', fail)
      zipfile.outputStream.on('error', fail)
      // yazl reports a file it cannot read on the ZipFile itself. Unheard,
      // that was an uncaught exception in the main process (an error dialog)
      // and a save that never returned.
      zipfile.on('error', fail)
    })

    zipfile.outputStream.pipe(out)

    const addFolder = async (currentPath: string, basePath = ''): Promise<void> => {
      const items = await fsp.readdir(currentPath, { withFileTypes: true })
      for (const item of items) {
        const fullPath = path.join(currentPath, item.name)
        const relPath = path.join(basePath, item.name)

        // Skip the output file if it's inside the source directory
        if (excluded.has(path.resolve(fullPath))) {
          continue
        }

        if (item.isDirectory()) {
          await addFolder(fullPath, relPath)
        } else if (item.isFile()) {
          // Streamed without a declared size. addFile() records the size at
          // stat time and fails the whole archive when the file changes before
          // it is read, which is what an editor writing its debounced content
          // during a save did.
          const stats = await fsp.stat(fullPath)
          zipfile.addReadStreamLazy(relPath, { mtime: stats.mtime, mode: stats.mode }, (cb) => {
            const stream = fs.createReadStream(fullPath)
            stream.on('error', (error) => zipfile.emit('error', error))
            cb(null, stream)
          })
        }
      }
    }

    await addFolder(sourceDir)
    zipfile.end()
    await done
  }

  private static async unzipToDir(zipPath: string, destDir: string) {
    await fsp.mkdir(destDir, { recursive: true })
    const topLevelEntries = new Set<string>()
    const topLevelFiles = new Set<string>()

    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err || new Error('Unable to open archive'))
        zip.readEntry()
        zip.on('entry', (entry) => {
          const fileName = entry.fileName
          const normalizedName = fileName.replace(/\\/g, '/').replace(/^\/+/, '')
          const [firstSegment] = normalizedName.split('/').filter(Boolean)
          if (firstSegment) {
            topLevelEntries.add(firstSegment)
            if (!normalizedName.includes('/')) {
              topLevelFiles.add(firstSegment)
            }
          }
          const destPath = path.join(destDir, fileName)
          if (/\/$/.test(fileName)) {
            fsp
              .mkdir(destPath, { recursive: true })
              .then(() => zip.readEntry())
              .catch(reject)
            return
          }
          fsp
            .mkdir(path.dirname(destPath), { recursive: true })
            .then(() => {
              zip.openReadStream(entry, (err2, readStream) => {
                if (err2 || !readStream) return reject(err2 || new Error('Missing stream'))
                const writeStream = fs.createWriteStream(destPath)
                pipeline(readStream, writeStream)
                  .then(() => zip.readEntry())
                  .catch(reject)
              })
            })
            .catch(reject)
        })
        zip.on('end', () => resolve())
        zip.on('error', reject)
      })
    })

    return this.resolveExtractedRoot(destDir, topLevelEntries, topLevelFiles)
  }
}
