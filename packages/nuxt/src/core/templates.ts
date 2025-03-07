import { genArrayFromRaw, genDynamicImport, genExport, genImport, genObjectFromRawEntries, genString, genSafeVariableName } from 'knitwork'
import { isAbsolute, join, relative, resolve } from 'pathe'
import { resolveSchema, generateTypes } from 'untyped'
import escapeRE from 'escape-string-regexp'
import { hash } from 'ohash'
import { camelCase } from 'scule'
import { resolvePath } from 'mlly'
import { filename } from 'pathe/utils'
import type { Nuxt, NuxtApp, NuxtTemplate } from 'nuxt/schema'

export interface TemplateContext {
  nuxt: Nuxt
  app: NuxtApp
}

export const vueShim: NuxtTemplate = {
  filename: 'types/vue-shim.d.ts',
  getContents: () =>
    [
      'declare module \'*.vue\' {',
      '  import { DefineComponent } from \'vue\'',
      '  const component: DefineComponent<{}, {}, any>',
      '  export default component',
      '}'
    ].join('\n')
}

// TODO: Use an alias
export const appComponentTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'app-component.mjs',
  getContents: ctx => genExport(ctx.app.mainComponent!, ['default'])
}
// TODO: Use an alias
export const rootComponentTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'root-component.mjs',
  getContents: ctx => genExport(ctx.app.rootComponent!, ['default'])
}
// TODO: Use an alias
export const errorComponentTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'error-component.mjs',
  getContents: ctx => genExport(ctx.app.errorComponent!, ['default'])
}
// TODO: Use an alias
export const testComponentWrapperTemplate = {
  filename: 'test-component-wrapper.mjs',
  getContents: (ctx: TemplateContext) => genExport(resolve(ctx.nuxt.options.appDir, 'components/test-component-wrapper'), ['default'])
}

export const cssTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'css.mjs',
  getContents: ctx => ctx.nuxt.options.css.map(i => genImport(i)).join('\n')
}

export const clientPluginTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'plugins/client.mjs',
  getContents (ctx) {
    const clientPlugins = ctx.app.plugins.filter(p => !p.mode || p.mode !== 'server')
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of clientPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(plugin.src)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return [
      ...imports,
      `export default ${genArrayFromRaw(exports)}`
    ].join('\n')
  }
}

export const serverPluginTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'plugins/server.mjs',
  getContents (ctx) {
    const serverPlugins = ctx.app.plugins.filter(p => !p.mode || p.mode !== 'client')
    const exports: string[] = []
    const imports: string[] = []
    for (const plugin of serverPlugins) {
      const path = relative(ctx.nuxt.options.rootDir, plugin.src)
      const variable = genSafeVariableName(filename(path)).replace(/_(45|46|47)/g, '_') + '_' + hash(path)
      exports.push(variable)
      imports.push(genImport(plugin.src, variable))
    }
    return [
      ...imports,
      `export default ${genArrayFromRaw(exports)}`
    ].join('\n')
  }
}

export const pluginsDeclaration: NuxtTemplate<TemplateContext> = {
  filename: 'types/plugins.d.ts',
  getContents: (ctx) => {
    const EXTENSION_RE = new RegExp(`(?<=\\w)(${ctx.nuxt.options.extensions.map(e => escapeRE(e)).join('|')})$`, 'g')
    const tsImports = ctx.app.plugins.map(p => (isAbsolute(p.src) ? relative(join(ctx.nuxt.options.buildDir, 'types'), p.src) : p.src).replace(EXTENSION_RE, ''))

    return `// Generated by Nuxt'
import type { Plugin } from '#app'

type Decorate<T extends Record<string, any>> = { [K in keyof T as K extends string ? \`$\${K}\` : never]: T[K] }

type InjectionType<A extends Plugin> = A extends Plugin<infer T> ? Decorate<T> : unknown

type NuxtAppInjections = \n  ${tsImports.map(p => `InjectionType<typeof ${genDynamicImport(p, { wrapper: false })}.default>`).join(' &\n  ')}

declare module '#app' {
  interface NuxtApp extends NuxtAppInjections { }
}

declare module 'vue' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}
// TODO: remove when webstorm has support for augumenting 'vue' directly
declare module '@vue/runtime-core' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

export { }
`
  }
}

const adHocModules = ['router', 'pages', 'imports', 'meta', 'components', 'nuxt-config-schema']
export const schemaTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'types/schema.d.ts',
  getContents: async ({ nuxt }) => {
    const moduleInfo = nuxt.options._installedModules.map(m => ({
      ...m.meta || {},
      importName: m.entryPath || m.meta?.name
    })).filter(m => m.configKey && m.name && !adHocModules.includes(m.name))

    const relativeRoot = relative(resolve(nuxt.options.buildDir, 'types'), nuxt.options.rootDir)
    const getImportName = (name: string) => (name.startsWith('.') ? './' + join(relativeRoot, name) : name).replace(/\.\w+$/, '')
    const modules = moduleInfo.map(meta => [genString(meta.configKey), getImportName(meta.importName)])

    return [
      "import { NuxtModule, RuntimeConfig } from 'nuxt/schema'",
      "declare module 'nuxt/schema' {",
      '  interface NuxtConfig {',
      ...modules.map(([configKey, importName]) =>
        `    [${configKey}]?: typeof ${genDynamicImport(importName, { wrapper: false })}.default extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`
      ),
      modules.length > 0 ? `    modules?: (undefined | null | false | NuxtModule | string | [NuxtModule | string, Record<string, any>] | ${modules.map(([configKey, importName]) => `[${genString(importName)}, Exclude<NuxtConfig[${configKey}], boolean>]`).join(' | ')})[],` : '',
      '  }',
      generateTypes(await resolveSchema(Object.fromEntries(Object.entries(nuxt.options.runtimeConfig).filter(([key]) => key !== 'public'))),
        {
          interfaceName: 'RuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2
        }),
      generateTypes(await resolveSchema(nuxt.options.runtimeConfig.public),
        {
          interfaceName: 'PublicRuntimeConfig',
          addExport: false,
          addDefaults: false,
          allowExtraKeys: false,
          indentation: 2
        }),
      '}',
      `declare module 'vue' {
        interface ComponentCustomProperties {
          $config: RuntimeConfig
        }
      }`,
      // TODO: remove when webstorm has support for augumenting 'vue' directly
      `declare module '@vue/runtime-dom' {
        interface ComponentCustomProperties {
          $config: RuntimeConfig
        }
      }`
    ].join('\n')
  }
}

// Add layouts template
export const layoutTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'layouts.mjs',
  getContents ({ app }) {
    const layoutsObject = genObjectFromRawEntries(Object.values(app.layouts).map(({ name, file }) => {
      return [name, genDynamicImport(file, { interopDefault: true })]
    }))
    return [
      `export default ${layoutsObject}`
    ].join('\n')
  }
}

// Add middleware template
export const middlewareTemplate: NuxtTemplate<TemplateContext> = {
  filename: 'middleware.mjs',
  getContents ({ app }) {
    const globalMiddleware = app.middleware.filter(mw => mw.global)
    const namedMiddleware = app.middleware.filter(mw => !mw.global)
    const namedMiddlewareObject = genObjectFromRawEntries(namedMiddleware.map(mw => [mw.name, genDynamicImport(mw.path)]))
    return [
      ...globalMiddleware.map(mw => genImport(mw.path, genSafeVariableName(mw.name))),
      `export const globalMiddleware = ${genArrayFromRaw(globalMiddleware.map(mw => genSafeVariableName(mw.name)))}`,
      `export const namedMiddleware = ${namedMiddlewareObject}`
    ].join('\n')
  }
}

export const clientConfigTemplate: NuxtTemplate = {
  filename: 'nitro.client.mjs',
  getContents: () => `
export const useRuntimeConfig = () => window?.__NUXT__?.config || {}
`
}

export const appConfigDeclarationTemplate: NuxtTemplate = {
  filename: 'types/app.config.d.ts',
  getContents: ({ app, nuxt }) => {
    return `
import type { CustomAppConfig } from 'nuxt/schema'
import type { Defu } from 'defu'
${app.configs.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id.replace(/(?<=\w)\.\w+$/g, ''))}`).join('\n')}

declare const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}
type ResolvedAppConfig = Defu<typeof inlineConfig, [${app.configs.map((_id: string, index: number) => `typeof cfg${index}`).join(', ')}]>
type IsAny<T> = 0 extends 1 & T ? true : false

type MergedAppConfig<Resolved extends Record<string, any>, Custom extends Record<string, any>> = {
  [K in keyof Resolved]: K extends keyof Custom
    ? IsAny<Custom[K]> extends true
      ? Resolved[K]
      : Custom[K] extends Record<string, any>
        ? Resolved[K] extends Record<string, any>
          ? MergedAppConfig<Resolved[K], Custom[K]>
          : Exclude<Custom[K], undefined>
        : Exclude<Custom[K], undefined>
    : Resolved[K]
}

declare module 'nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
declare module '@nuxt/schema' {
  interface AppConfig extends MergedAppConfig<ResolvedAppConfig, CustomAppConfig> { }
}
`
  }
}

export const appConfigTemplate: NuxtTemplate = {
  filename: 'app.config.mjs',
  write: true,
  getContents: async ({ app, nuxt }) => {
    return `
import { defuFn } from '${await _resolveId('defu')}'

const inlineConfig = ${JSON.stringify(nuxt.options.appConfig, null, 2)}

${app.configs.map((id: string, index: number) => `import ${`cfg${index}`} from ${JSON.stringify(id)}`).join('\n')}

export default /* #__PURE__ */ defuFn(${app.configs.map((_id: string, index: number) => `cfg${index}`).concat(['inlineConfig']).join(', ')})
`
  }
}

export const publicPathTemplate: NuxtTemplate = {
  filename: 'paths.mjs',
  async getContents ({ nuxt }) {
    return [
      `import { joinURL } from '${await _resolveId('ufo')}'`,
      !nuxt.options.dev && 'import { useRuntimeConfig } from \'#internal/nitro\'',

      nuxt.options.dev
        ? `const appConfig = ${JSON.stringify(nuxt.options.app)}`
        : 'const appConfig = useRuntimeConfig().app',

      'export const baseURL = () => appConfig.baseURL',
      'export const buildAssetsDir = () => appConfig.buildAssetsDir',

      'export const buildAssetsURL = (...path) => joinURL(publicAssetsURL(), buildAssetsDir(), ...path)',

      'export const publicAssetsURL = (...path) => {',
      '  const publicBase = appConfig.cdnURL || appConfig.baseURL',
      '  return path.length ? joinURL(publicBase, ...path) : publicBase',
      '}',

      // On server these are registered directly in packages/nuxt/src/core/runtime/nitro/renderer.ts
      'if (process.client) {',
      '  globalThis.__buildAssetsURL = buildAssetsURL',
      '  globalThis.__publicAssetsURL = publicAssetsURL',
      '}'
    ].filter(Boolean).join('\n')
  }
}

// Allow direct access to specific exposed nuxt.config
export const nuxtConfigTemplate = {
  filename: 'nuxt.config.mjs',
  getContents: (ctx: TemplateContext) => {
    return [
      ...Object.entries(ctx.nuxt.options.app).map(([k, v]) => `export const ${camelCase('app-' + k)} = ${JSON.stringify(v)}`),
      `export const devPagesDir = ${ctx.nuxt.options.dev ? JSON.stringify(ctx.nuxt.options.dir.pages) : 'null'}`
    ].join('\n\n')
  }
}

// TODO: Move to kit
function _resolveId (id: string) {
  return resolvePath(id, {
    url: [
      // @ts-ignore
      global.__NUXT_PREPATHS__,
      import.meta.url,
      process.cwd(),
      // @ts-ignore
      global.__NUXT_PATHS__
    ]
  })
}
