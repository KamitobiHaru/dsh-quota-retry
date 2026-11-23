import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS } from '../env.js'

const SCRIPT = new URL('../scripts/set-retries.mjs', import.meta.url).pathname

/** Minimal environment: the test process must not leak a real override into the child. */
function childEnv() {
  const env = { PATH: process.env.PATH }
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  return env
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-quota-retry-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd, file: join(home, '.env') }
}

function run(args, dirs, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dirs.cwd,
    env: { ...childEnv(), ...extraEnv },
    encoding: 'utf8',
  })
}

test('writes a persistent override while preserving unrelated lines', () => {
  const dirs = workspace()
  writeFileSync(dirs.file, [
    'FOO=bar',
    `${MAX_RETRIES_ENV}=3`,
    '# keep this comment',
    `${MAX_RETRIES_ENV_ALIAS}=4`,
    '',
  ].join('\n'))

  const result = run(['12', '--home', dirs.home], dirs)
  assert.equal(result.status, 0, result.stderr)
  const text = readFileSync(dirs.file, 'utf8')
  assert.match(text, /^FOO=bar$/m)
  assert.match(text, /^# keep this comment$/m)
  assert.match(text, new RegExp(`^${MAX_RETRIES_ENV}=12$`, 'm'))
  assert.equal(text.includes(MAX_RETRIES_ENV_ALIAS), false)
  assert.equal(statSync(dirs.file).mode & 0o777, 0o600)
  assert.match(result.stdout, /restart/)
})

test('--show reports the file value and the effective source', () => {
  const dirs = workspace()
  writeFileSync(dirs.file, `${MAX_RETRIES_ENV}=8\n`)
  const result = run(['--show', '--home', dirs.home], dirs)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /: 8 \(HARNESS_QUOTA_RETRY_MAX_RETRIES\)/)
  assert.match(result.stdout, /effective at next boot: 8/)
})

test('a shell export wins over the home file', () => {
  const dirs = workspace()
  writeFileSync(dirs.file, `${MAX_RETRIES_ENV}=8\n`)
  const result = run(['--show', '--home', dirs.home], dirs, { [MAX_RETRIES_ENV]: '4' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /effective at next boot: 4 \(from HARNESS_QUOTA_RETRY_MAX_RETRIES\)/)
})

test('--unset removes only the retry keys', () => {
  const dirs = workspace()
  writeFileSync(dirs.file, `FOO=bar\n${MAX_RETRIES_ENV}=8\nBAZ=1\n`)
  const result = run(['--unset', '--home', dirs.home], dirs)
  assert.equal(result.status, 0, result.stderr)
  const text = readFileSync(dirs.file, 'utf8')
  assert.equal(text.includes(MAX_RETRIES_ENV), false)
  assert.match(text, /^FOO=bar$/m)
  assert.match(text, /^BAZ=1$/m)
})

test('--unset is a no-op when no file exists', () => {
  const dirs = workspace()
  const result = run(['--unset', '--home', dirs.home], dirs)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(dirs.file), false)
})

test('invalid counts are refused with exit code 2', () => {
  const dirs = workspace()
  for (const raw of ['-1', '1.5', 'abc', '10001']) {
    const result = run([raw, '--home', dirs.home], dirs)
    assert.equal(result.status, 2, `${raw}: ${result.stderr}`)
    assert.match(result.stderr, /integer from 0 through 10000/)
  }
})
test('--help prints usage to stdout and exits 0', () => {
  const dirs = workspace()
  const result = run(['--help', '--home', dirs.home], dirs)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /usage: node scripts\/set-retries\.mjs <count>/)
  assert.match(result.stdout, /--home <dsh-home>/)
  assert.equal(existsSync(dirs.file), false, 'help must not write the .env file')
})
