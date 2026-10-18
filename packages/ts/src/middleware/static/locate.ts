import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { UhttpError } from '../../errors.js'

const READ_WITHOUT_BLOCKING = constants.O_RDONLY | constants.O_NONBLOCK

function insideFolder(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
}

async function walk(root: string, segments: readonly string[]): Promise<string | undefined> {
  let current = root
  for (const segment of segments) {
    const names = await readdir(current)
    if (!names.includes(segment)) return undefined
    const next = join(current, segment)
    const target = (await lstat(next)).isSymbolicLink() ? await realpath(next) : next
    if (!insideFolder(root, target)) return undefined
    current = target
  }
  return current
}

/**
 * Returns the real path of a file inside a folder. When the real path differs from the joined
 * path, because of a symlink or because a case-insensitive filesystem matched another spelling,
 * the function checks the path one segment at a time. It keeps a segment only when the folder
 * contains an entry with that exact spelling, and it follows a symlink only when the target is
 * inside the folder.
 *
 * @param root - The middleware passes the real path of its folder.
 * @param segments - The middleware passes the decoded segments below the folder.
 * @returns The function returns the real path, or `undefined` when no such file exists inside the folder.
 * @internal
 */
export async function locate(root: string, segments: readonly string[]): Promise<string | undefined> {
  const expected = join(root, ...segments)
  try {
    const real = await realpath(expected)
    return real === expected ? real : await walk(root, segments)
  } catch {
    return undefined
  }
}

/**
 * Returns the details of a regular file, which the function takes from an open descriptor, so that
 * it reports the details of the file that it opened even when another file replaces the path in
 * between. It opens the file without blocking, so that the call returns at once for a named pipe
 * and blocks no thread of the pool.
 *
 * @param path - The middleware passes the real path of the file.
 * @returns The function returns the details, or `undefined` for anything other than a regular file
 * or for a file that the process can't open.
 * @internal
 */
export async function regularFile(path: string): Promise<Stats | undefined> {
  try {
    const handle = await open(path, READ_WITHOUT_BLOCKING)
    try {
      const stats = await handle.stat()
      return stats.isFile() ? stats : undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Opens a file again and returns its handle, after checking that it is still the file whose details
 * the middleware took, with the same device, inode, size, and modification time.
 *
 * @param path - The middleware passes the real path of the file.
 * @param expected - The middleware passes the details that it took before.
 * @returns The function returns the open handle, which the caller closes.
 * @throws {@link UhttpError} with the code `INTERNAL_ERROR` when the file changed in between, so
 * that the package closes the connection.
 * @internal
 */
export async function reopen(path: string, expected: Stats): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, READ_WITHOUT_BLOCKING)
  const stats = await handle.stat().catch(async (error: unknown) => {
    await handle.close()
    throw error
  })
  if (
    stats.dev !== expected.dev ||
    stats.ino !== expected.ino ||
    stats.size !== expected.size ||
    stats.mtimeMs !== expected.mtimeMs
  ) {
    await handle.close()
    throw new UhttpError('INTERNAL_ERROR', 'The file changed between the headers and the body of the response.')
  }
  return handle
}
