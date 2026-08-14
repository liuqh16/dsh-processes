/**
 * Bundle the browser half of dsh-processes-web into the module-loader
 * contract: a closure factory that receives the injected module-table require
 * and returns the client plugin exports. Externals (react and the
 * @deepseek-ai/dsh-client-* platform modules) resolve through that require.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '/vePFS-Mindverse/user/liuqihan/code/side-project/deepseek-harness/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js'

const here = dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [join(here, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: ['es2020'],
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  write: false,
  logLevel: 'warning',
})
const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
	id: 'dsh-processes-web',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		${body}
		return module.exports;
	}
});
`
const out = join(here, 'dist/client.js')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, wrapped)
console.log('bundle written:', out, (wrapped.length / 1024).toFixed(1) + ' KiB')
