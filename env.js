/**
 * Shared environment-variable contract for the quota-retry Host plugin and its
 * command-line script.
 *
 * DSH refuses `DSH_*` names in a `.env` file, so the persistent knob is a
 * `HARNESS_*` name; the `DSH_*` spelling is accepted only from the launching
 * shell as a convenience alias. Environment variables are read once at boot.
 * @module dsh-quota-retry/env
 */

/** Persistent knob written to `$DSH_HOME/.env` and read at boot. */
export const MAX_RETRIES_ENV = 'HARNESS_QUOTA_RETRY_MAX_RETRIES'
/** Launching-shell alias; `.env` files must not set this name. */
export const MAX_RETRIES_ENV_ALIAS = 'DSH_QUOTA_RETRY_MAX_RETRIES'
/** Largest accepted override; keeps a typo from becoming an accidental infinite loop. */
export const MAX_RETRIES_LIMIT = 10000

/**
 * Parse one raw environment value (or an absent value).
 * @param raw - raw value from `process.env` or `.env`; `undefined`/`null`/empty
 *   all mean "not set".
 * @returns `{kind:'unset'}`, `{kind:'value', value}`, or `{kind:'invalid', raw}`.
 */
export function parseMaxRetries(raw) {
  if (raw === undefined || raw === null) return { kind: 'unset' }
  const text = String(raw).trim()
  if (text === '') return { kind: 'unset' }
  if (!/^\d+$/.test(text)) return { kind: 'invalid', raw: String(raw) }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value > MAX_RETRIES_LIMIT) {
    return { kind: 'invalid', raw: String(raw) }
  }
  return { kind: 'value', value }
}

/**
 * Resolve the configured retry-count override for one plugin activation.
 *
 * Precedence: valid environment value (the documented name first, then the
 * shell alias) > row `config.maxRetries` > provider policy. An invalid
 * environment value is reported once through `warning` and skipped; a typo in
 * `.env` must never prevent the plugin from loading.
 * @param config - validated plugin config; `maxRetries` is `null` when absent.
 * @param env - environment to read; defaults to `process.env`.
 * @returns `{ value, source, warning? }`; `value` is `null` when the provider
 *   policy should decide.
 */
export function resolveMaxRetries(config, env = process.env) {
  let warning
  for (const key of [MAX_RETRIES_ENV, MAX_RETRIES_ENV_ALIAS]) {
    const parsed = parseMaxRetries(env?.[key])
    if (parsed.kind === 'value') return { value: parsed.value, source: `env:${key}`, ...warning === undefined ? {} : { warning } }
    if (parsed.kind === 'invalid') {
      warning = `${key}=${JSON.stringify(parsed.raw)} is not an integer from 0 through ${MAX_RETRIES_LIMIT}; ignoring it`
    }
  }
  if (config.maxRetries !== null) {
    return { value: config.maxRetries, source: 'config', ...warning === undefined ? {} : { warning } }
  }
  return { value: null, source: 'provider', ...warning === undefined ? {} : { warning } }
}