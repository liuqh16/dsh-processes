// Vitest config for the standalone dsh-processes package. Deliberately
// dependency-free (no imports): the vitest binary and all @deepseek-ai/dsh-*
// packages come from the DeepSeek Harness checkout named below, so this file
// only needs Node builtins. It maps every harness package name to its BUILT
// lib entry (decorators already compiled, third-party deps resolving from the
// harness tree) through one generated alias table.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HARNESS = process.env.DSH_HARNESS ?? '/vePFS-Mindverse/user/liuqihan/code/side-project/deepseek-harness'

/** Resolve one exports target (string or { default | import | require | types }) to a path under dir. */
function resolveExport(dir, target) {
  const value = typeof target === 'string'
    ? target
    : (target?.default ?? target?.import ?? target?.require ?? target?.types)
  if (value === undefined) return undefined
  return join(dir, value)
}

/** Build alias entries for one package manifest; returns { find, replacement } sorted by specificity. */
function aliasesFor(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const name = manifest.name
  if (typeof name !== 'string') return []
  const exports = manifest.exports
  if (exports === undefined) return []
  const entries = []
  for (const [key, target] of Object.entries(exports)) {
    const replacement = resolveExport(dir, target)
    if (replacement === undefined) continue
    if (key === '.') {
      entries.push({ find: name, replacement })
    } else {
      entries.push({ find: name + key.slice(1), replacement })
    }
  }
  return entries
}

const aliases = []
for (const group of readdirSync(join(HARNESS, 'packages'))) {
  const groupDir = join(HARNESS, 'packages', group)
  if (!statSync(groupDir).isDirectory()) continue
  for (const pkg of readdirSync(groupDir)) {
    const dir = join(groupDir, pkg)
    if (existsSync(join(dir, 'package.json'))) aliases.push(...aliasesFor(dir))
  }
}
for (const vendor of readdirSync(join(HARNESS, 'vendor'))) {
  const dir = join(HARNESS, 'vendor', vendor)
  if (existsSync(join(dir, 'package.json'))) aliases.push(...aliasesFor(dir))
}
// Longest find first so subpath exports win over the bare package name.
aliases.sort((a, b) => b.find.length - a.find.length)

export default {
  resolve: { alias: aliases },
  test: {
    root: here,
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
}