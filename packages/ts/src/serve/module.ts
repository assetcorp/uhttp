import { App } from '../app.js'
import { UhttpError } from '../errors.js'

/**
 * Returns the app that a module exports. The default export of the module is the app from
 * {@link createApp}, or a function that returns the app or a promise of it.
 *
 * @param url - You pass the URL of the module.
 * @returns The promise resolves to the app.
 * @throws {@link UhttpError} with the code `APP_START_FAILED` when the import or the function
 * throws, with that error as the cause, or when the default export yields no app.
 * @internal
 */
export async function importApp(url: URL): Promise<App> {
  let created: unknown
  try {
    const module: unknown = await import(url.href)
    const exported: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
    created = typeof exported === 'function' ? await exported() : exported
  } catch (error) {
    throw new UhttpError('APP_START_FAILED', `The app module at ${url.href} threw while it built the app.`, {
      cause: error,
    })
  }
  if (!(created instanceof App)) {
    throw new UhttpError(
      'APP_START_FAILED',
      `Export the app from createApp(), or a function that returns it, as the default export of ${url.href}.`,
    )
  }
  return created
}
