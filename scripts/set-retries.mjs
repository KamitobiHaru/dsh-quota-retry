#!/usr/bin/env node
/**
 * Change the quota-retry retry count from the command line.
 *
 * The persistent target is `$DSH_HOME/.env`, which DSH loads at boot. DSH
 * refuses `DSH_*` names in a `.env` file, so this script writes
 * `HARNESS_QUOTA_RETRY_MAX_RETRIES` and removes the `DSH_*` alias line if it is
 * present. A variable exported in the launching shell (or set in the invoking
 * directory's `.env`) wins over the Harness-home file; `--show` prints that
 * precedence.
 *
 * Usage:
 *   node scripts/set-retries.mjs 12
 *   node scripts/set-retries.mjs --show
 *   node scripts/set-retries.mjs --unset
 *   node scripts/set-retries.mjs 12 --home /path/to/.dsh
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MAX_RETRIES_ENV,
  MAX_RETRIES_ENV_ALIAS,
  MAX_RETRIES_LIMIT,
  parseMaxRetries,
} from '../env.js'

const KEYS = new Set([MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS])
const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const positional = argv.filter((value, index) => (
  !value.startsWith('--')
  && !(index > 0 && (argv[index - 1] === '--home'))
))

const usage = [
  'usage: node scripts/set-retries.mjs <count>',
  '       node scripts/set-retries.mjs --help',
  '       node scripts/set-retries.mjs --show',
  '       node scripts/set-retries.mjs --unset',
  '       node scripts/set-retries.mjs <count|--show|--unset> --home <dsh-home>',
  '',
  `  count  integer 0..${MAX_RETRIES_LIMIT}; 0 disables retries`,
].join('\n')

const home = resolve(option('home') ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
const file = join(home, '.env')

/** Parse a `.env` file into its entries; missing/unreadable files read as empty. */
function readLayer(path) {
  if (!existsSync(path)) return new Map()
  const entries = new Map()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = ENTRY.exec(line)
    if (match === null) continue
    const value = line.slice(match[0].length).trim()
    entries.set(match[1], value)
  }
  return entries
}

/** The layer value for the documented name, then the shell alias. */
function layerValue(entries) {
  for (const key of [MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS]) {
    if (entries.has(key)) return { key, raw: entries.get(key) }
  }
  return undefined
}

/** Describe one layer's contribution without pretending an invalid value applies. */
function describe(entries) {
  const found = layerValue(entries)
  if (found === undefined) return 'unset'
  const parsed = parseMaxRetries(found.raw)
  if (parsed.kind === 'value') return `${parsed.value} (${found.key})`
  return `${JSON.stringify(found.raw)} (${found.key}, invalid; ignored at boot)`
}

function show() {
  const shell = new Map()
  for (const key of [MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS]) {
    if (process.env[key] !== undefined) shell.set(key, process.env[key])
  }
  const invoking = readLayer(resolve(process.cwd(), '.env'))
  const homeLayer = readLayer(file)
  const layers = [
    ['launching shell', shell],
    [`invoking directory ${resolve(process.cwd(), '.env')}`, invoking],
    [file, homeLayer],
  ]
  console.log(`quota-retry retry count in ${file}:`)
  for (const [label, entries] of layers) console.log(`  ${label}: ${describe(entries)}`)
  const effective = [shell, invoking, homeLayer]
    .map(entries => layerValue(entries))
    .find(found => found !== undefined)
  const parsed = effective === undefined ? { kind: 'unset' } : parseMaxRetries(effective.raw)
  if (parsed.kind === 'value') {
    console.log(`  effective at next boot: ${parsed.value} (from ${effective.key})`)
  } else if (parsed.kind === 'invalid') {
    console.log(`  effective at next boot: invalid ${effective.key}; the plugin falls back to config/provider policy`)
  } else {
    console.log('  effective at next boot: config maxRetries, else the provider retryPolicy.maxRetries (harness default 5)')
  }
  console.log('')
  console.log(`set it with: node scripts/set-retries.mjs <0..${MAX_RETRIES_LIMIT}>`)
  console.log('environment variables are read once at boot; restart the dsh process to apply a change.')
}

/** Rewrite the home `.env` without the two keys, preserving every other line. */
function rewrite(lines) {
  const next = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  if (next === '' && !existsSync(file)) return
  writeFileSync(file, next, { mode: 0o600 })
  chmodSync(file, 0o600)
}

if (flag('help') || argv.includes('-h')) {
  console.log(usage)
  console.log('')
  console.log(`writes ${MAX_RETRIES_ENV} to $DSH_HOME/.env; restart the dsh process to apply it.`)
  process.exit(0)
}

if (flag('show')) {
  show()
  process.exit(0)
}

const existingLines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
const retained = existingLines.filter((line) => {
  const match = ENTRY.exec(line)
  return match === null || !KEYS.has(match[1])
})
while (retained.length > 0 && retained[retained.length - 1].trim() === '') retained.pop()

if (flag('unset')) {
  rewrite(retained)
  console.log(`removed the quota-retry retry count from ${file}`)
  const shell = [MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS].filter(key => process.env[key] !== undefined)
  if (shell.length > 0) {
    console.log(`warning: the launching shell still sets ${shell.join(', ')}; unset it there too.`)
  }
  const invoking = layerValue(readLayer(resolve(process.cwd(), '.env')))
  if (invoking !== undefined) {
    console.log(`warning: the invoking directory's .env still sets ${invoking.key}; it wins over the Harness-home file.`)
  }
  console.log('restart the dsh process to return to config/provider policy.')
  process.exit(0)
}

const raw = positional.find(value => value !== '--unset' && value !== '--show')
if (raw === undefined) {
  console.error(usage)
  process.exit(2)
}
const parsed = parseMaxRetries(raw)
if (parsed.kind !== 'value') {
  console.error(`retry count must be an integer from 0 through ${MAX_RETRIES_LIMIT}, got ${JSON.stringify(raw)}`)
  console.error(usage)
  process.exit(2)
}

mkdirSync(home, { recursive: true })
retained.push(`${MAX_RETRIES_ENV}=${parsed.value}`)
rewrite(retained)

console.log(`wrote ${file}:`)
console.log(`  ${MAX_RETRIES_ENV}=${parsed.value}`)
if (parsed.value === 0) console.log('  (0 = quota/429 failures are not retried by this plugin)')
console.log('')
console.log('environment variables are read once at boot; restart the dsh process to apply it.')
console.log(`for a one-off launch without editing .env: ${MAX_RETRIES_ENV}=${parsed.value} dsh web`)