import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const JS_EXTENSION = '.js'
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(JS_EXTENSION) && PATH_SPECIFIER.test(specifier)) {
      const target = new URL(specifier, context.parentURL ?? import.meta.url)
      if (target.protocol === 'file:' && !existsSync(fileURLToPath(target))) {
        const source = new URL(`${target.href.slice(0, -JS_EXTENSION.length)}.ts`)
        if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
