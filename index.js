/**
 * dsh-quota-retry Host half: extend a provider's own retry policy to quota and
 * HTTP 429 failures.
 *
 * DSH's provider adapters classify a 429 whose body says "quota exceeded" (or
 * "usage limit exceeded") as `QUOTA` before they look at the status. The
 * built-in `dsh-llm-retry` policy retries `RATE_LIMIT`, `TRANSPORT`, `SERVER`,
 * `TIMEOUT`, and `EMPTY_RESPONSE` by default but not `QUOTA`, so such a failure
 * ends the step even though the provider is usually only rate-limiting.
 *
 * This plugin listens on `agent/request-error` and owns recovery for the codes
 * the provider policy does not already cover. It uses the same policy the
 * provider uses for connection errors (mode, retry count, backoff, provider
 * retry-after), records the retry through the official `llm/retry` and
 * `llm/retry-started` events, and leaves the original failure code intact.
 *
 * The retry count can be overridden from the command line through
 * `HARNESS_QUOTA_RETRY_MAX_RETRIES` (see `scripts/set-retries.mjs`).
 * @module dsh-quota-retry
 */

import { randomUUID } from 'node:crypto'
import { MAX_RETRIES_LIMIT, resolveMaxRetries } from './env.js'

/** Cordis plugin name. */
export const name = 'quota-retry'
/** Framework services this Host half requires. */
export const inject = ['agents']

/** Codes retried when the provider policy does not already cover them. */
export const DEFAULT_CODES = Object.freeze(['QUOTA', 'HTTP_429'])

const DEFAULT_CONFIG = Object.freeze({
  /** Global switch; while false the plugin delegates every failure. */
  enabled: true,
  /** Failure codes to recover when the provider policy does not retry them. */
  codes: DEFAULT_CODES,
  /** Provider routes to handle; empty means every route. */
  providers: Object.freeze([]),
  /** Also recover a failure that carries HTTP status 429 under an unknown code. */
  status429: true,
  /** Retry-count override; null follows the provider policy. */
  maxRetries: null,
})

/** Harness defaults, used when the adapter supplied no retry policy. */
const HARNESS_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
})

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

/**
 * Validate one raw loader-row config, applying defaults.
 * @param value - raw config from the loader row, possibly undefined.
 * @returns a Standard Schema v1 result: `{ value }` or `{ issues }`.
 */
export function validateConfig(value) {
  if (value !== undefined && value !== null && !isRecord(value)) {
    return { issues: [{ message: 'quota-retry config must be an object' }] }
  }
  const record = isRecord(value) ? value : {}
  const issues = []
  const pushIssue = (message) => { issues.push({ message }) }
  const resolved = { ...DEFAULT_CONFIG, codes: [...DEFAULT_CONFIG.codes], providers: [] }

  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) pushIssue(`unknown config field ${JSON.stringify(key)}`)
  }
  for (const field of ['enabled', 'status429']) {
    const raw = record[field]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') pushIssue(`${field} must be a boolean`)
    else resolved[field] = raw
  }
  if (record.codes !== undefined) {
    const raw = record.codes
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
      pushIssue('codes must be an array of 1 through 32 failure-code strings')
    } else if (raw.some(code => !isNonEmptyString(code))) {
      pushIssue('codes must contain only non-empty strings')
    } else if (new Set(raw).size !== raw.length) {
      pushIssue('codes must not contain duplicates')
    } else {
      resolved.codes = [...raw]
    }
  }
  if (record.providers !== undefined) {
    const raw = record.providers
    if (!Array.isArray(raw) || raw.length > 64) {
      pushIssue('providers must be an array of at most 64 provider names')
    } else if (raw.some(provider => !isNonEmptyString(provider))) {
      pushIssue('providers must contain only non-empty strings')
    } else if (new Set(raw).size !== raw.length) {
      pushIssue('providers must not contain duplicates')
    } else {
      resolved.providers = [...raw]
    }
  }
  if (record.maxRetries !== undefined) {
    const raw = record.maxRetries
    if (raw !== null && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_RETRIES_LIMIT)) {
      pushIssue(`maxRetries must be null or an integer from 0 through ${MAX_RETRIES_LIMIT}`)
    } else {
      resolved.maxRetries = raw
    }
  }
  return issues.length > 0 ? { issues } : { value: resolved }
}

/** Standard Schema v1 validating face read by the Loader. */
export const Config = {
  '~standard': {
    version: 1,
    validate(value) { return validateConfig(value) },
  },
}

/** Whether the provider policy already retries this failure code. */
export function policyHandles(policy, code) {
  if (policy?.mode === 'always') return true
  return Array.isArray(policy?.retryableCodes) && policy.retryableCodes.includes(code)
}

/**
 * Whether this failure belongs to the plugin.
 * @param input - failure, resolved provider policy, provider route, and config.
 * @returns true only when the failure is selected and the provider policy does
 *   not already own its recovery.
 */
export function selectFailure({ failure, policy, provider, config }) {
  if (!isRecord(failure) || !isNonEmptyString(failure.code)) return false
  if (config.enabled !== true) return false
  if (config.providers.length > 0 && !config.providers.includes(provider)) return false
  if (policyHandles(policy, failure.code)) return false
  if (config.codes.includes(failure.code)) return true
  return config.status429 === true && failure.status === 429
}

/**
 * Resolve the retry shape from the provider policy, applying the optional
 * command-line/config count override.
 * @param policy - resolved provider policy, possibly undefined.
 * @param maxRetriesOverride - explicit count, or null/undefined to use the policy.
 * @returns immutable retry parameters with harness defaults filled in.
 */
export function recoveryPolicy(policy, maxRetriesOverride) {
  const source = isRecord(policy) ? policy : HARNESS_POLICY
  const mode = source.mode === 'always' ? 'always' : 'normal'
  const resolved = {
    mode,
    initialDelayMs: positive(source.initialDelayMs, HARNESS_POLICY.initialDelayMs),
    maxDelayMs: positive(source.maxDelayMs, HARNESS_POLICY.maxDelayMs),
    jitterRatio: typeof source.jitterRatio === 'number' && Number.isFinite(source.jitterRatio)
      ? Math.min(1, Math.max(0, source.jitterRatio))
      : HARNESS_POLICY.jitterRatio,
  }
  if (mode === 'normal') {
    const count = maxRetriesOverride !== null && maxRetriesOverride !== undefined
      ? maxRetriesOverride
      : Number.isSafeInteger(source.maxRetries) && source.maxRetries >= 0 ? source.maxRetries : HARNESS_POLICY.maxRetries
    resolved.maxRetries = count
  }
  return Object.freeze(resolved)
}

/** Local exponential backoff with symmetric jitter, capped at `maxDelayMs`. */
export function localDelay(policy, retry, random) {
  const exponent = Math.min(Math.max(retry - 1, 0), 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/**
 * Delay before one retry: a valid provider retry-after wins unless it exceeds
 * the policy cap; otherwise local exponential backoff is used.
 * @returns the delay in milliseconds, or undefined when a normal-mode policy
 *   refuses a provider delay longer than its own cap.
 */
export function delayFor(policy, retry, failure, random) {
  const requested = failure?.providerRetryAfterMs
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    if (requested > policy.maxDelayMs) {
      if (policy.mode === 'normal') return undefined
      return localDelay(policy, retry, random)
    }
    return requested
  }
  return localDelay(policy, retry, random)
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Per-session retry counters, reset when the turn/step/provider boundary moves. */
function createTracker() {
  const states = new Map()
  return {
    next(sessionId, turn, step, provider) {
      let state = states.get(sessionId)
      if (state === undefined || state.turn !== turn || state.step !== step || state.provider !== provider) {
        state = { turn, step, provider, retry: 0, retryId: randomUUID() }
        states.set(sessionId, state)
        if (states.size > 256) {
          const oldest = states.keys().next().value
          if (oldest !== undefined && oldest !== sessionId) states.delete(oldest)
        }
      }
      state.retry += 1
      return state
    },
    clear() { states.clear() },
  }
}

function retryPolicyKey(provider, policy, codes) {
  return policy.mode === 'always'
    ? JSON.stringify(['quota-retry', provider, 'always', policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
      'quota-retry',
      provider,
      'normal',
      policy.maxRetries,
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      [...codes].sort(),
    ])
}

/**
 * Install the recovery listener.
 * @param ctx - Cordis context owning the listener and its lifetime.
 * @param config - raw row config; the Loader normally validates it through `Config`.
 * @param internals - test hooks: environment snapshot and random source.
 */
export async function apply(ctx, config, internals = {}) {
  const check = validateConfig(config)
  if (check.issues !== undefined) {
    throw new Error(`quota-retry config rejected: ${check.issues.map(issue => issue.message).join('; ')}`)
  }
  const options = check.value
  const env = isRecord(internals.env) ? internals.env : process.env
  const random = typeof internals.random === 'function' ? internals.random : Math.random
  const resolved = resolveMaxRetries(options, env)
  if (resolved.warning !== undefined) {
    ctx.logger?.warn?.(`quota-retry: ${resolved.warning}`)
  }

  const tracker = createTracker()
  const lifetime = new AbortController()
  const active = new Set()

  const append = (agent, type, data) => {
    try {
      agent.session.append(type, data)
    } catch (error) {
      ctx.logger?.warn?.(`quota-retry: recording ${type} failed: ${String(error)}`)
    }
  }

  async function recover({ agent, turn, step, provider, failure, retryPolicy, signal }, next) {
    if (lifetime.signal.aborted) return next()
    if (agent?.session === undefined || !selectFailure({ failure, policy: retryPolicy, provider, config: options })) {
      return next()
    }
    const downstream = await next()
    if (lifetime.signal.aborted) return undefined
    if (downstream?.kind === 'retry') return downstream
    if (signal?.aborted === true) return undefined

    const policy = recoveryPolicy(retryPolicy, resolved.value)
    const state = tracker.next(String(agent.session.id), turn, step, provider)
    if (policy.mode === 'normal' && state.retry > policy.maxRetries) return downstream
    const delayMs = delayFor(policy, state.retry, failure, random)
    if (delayMs === undefined) return downstream

    const policyKey = retryPolicyKey(provider, policy, options.codes)
    append(agent, 'llm/retry', policy.mode === 'normal'
      ? {
          retryId: state.retryId,
          turn,
          step,
          provider,
          mode: 'normal',
          policyKey,
          retry: state.retry,
          maxRetries: policy.maxRetries,
          delayMs,
          failure,
        }
      : {
          retryId: state.retryId,
          turn,
          step,
          provider,
          mode: 'always',
          policyKey,
          retry: state.retry,
          delayMs,
          failure,
        })

    const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    if (!await cancellableDelay(delayMs, fused)) return undefined
    if (lifetime.signal.aborted) return undefined
    append(agent, 'llm/retry-started', { retryId: state.retryId, turn, step, retry: state.retry })
    ctx.logger?.debug?.(
      'quota-retry: retrying %s after %s (%d/%d, %dms)',
      failure.code,
      provider,
      state.retry,
      policy.mode === 'normal' ? policy.maxRetries : Infinity,
      delayMs,
    )
    return { kind: 'retry' }
  }

  const listener = (payload, next) => {
    const operation = recover(payload, next).finally(() => { active.delete(operation) })
    active.add(operation)
    return operation
  }

  ctx.effect(() => {
    const dispose = ctx.on('agent/request-error', listener)
    return async () => {
      dispose()
      lifetime.abort(new Error('quota-retry plugin disposed'))
      await Promise.allSettled([...active])
    }
  }, 'quota-retry: request recovery')
}

/** Pure helpers exported for `node --test`; not part of the plugin contract. */
export const __testables = {
  DEFAULT_CONFIG,
  HARNESS_POLICY,
  validateConfig,
  selectFailure,
  policyHandles,
  recoveryPolicy,
  localDelay,
  delayFor,
  retryPolicyKey,
  createTracker,
}