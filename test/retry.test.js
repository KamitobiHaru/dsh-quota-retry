import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, __testables } from '../index.js'
import {
  MAX_RETRIES_ENV,
  MAX_RETRIES_ENV_ALIAS,
  parseMaxRetries,
  resolveMaxRetries,
} from '../env.js'

const POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['RATE_LIMIT']),
  initialDelayMs: 1,
  maxDelayMs: 2,
  jitterRatio: 0,
})

function fakeContext() {
  const listeners = new Map()
  const effects = []
  const warnings = []
  const ctx = {
    on(event, listener) {
      assert.equal(listeners.has(event), false)
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      debug() {},
    },
  }
  return { ctx, listeners, effects, warnings }
}

function fakeAgent(id = 's1') {
  const events = []
  return {
    id,
    events,
    session: {
      id,
      append(type, data) { events.push({ type, data }) },
    },
  }
}

function payload(agent, overrides = {}) {
  return {
    agent,
    turn: 1,
    step: 2,
    provider: 'p',
    failure: { message: 'quota exceeded', code: 'QUOTA' },
    retryPolicy: POLICY,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('a QUOTA failure is retried up to the provider policy count', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()

  const first = await listener(payload(agent), async () => undefined)
  assert.deepEqual(first, { kind: 'retry' })
  assert.equal(agent.events.length, 2)
  assert.equal(agent.events[0].type, 'llm/retry')
  assert.equal(agent.events[0].data.mode, 'normal')
  assert.equal(agent.events[0].data.retry, 1)
  assert.equal(agent.events[0].data.maxRetries, 2)
  assert.equal(agent.events[0].data.policyKey.includes('quota-retry'), true)
  assert.equal(agent.events[1].type, 'llm/retry-started')
  assert.equal(agent.events[1].data.retry, 1)

  const second = await listener(payload(agent), async () => undefined)
  assert.deepEqual(second, { kind: 'retry' })
  assert.equal(agent.events[2].data.retry, 2)
  assert.equal(agent.events[3].data.retry, 2)

  const third = await listener(payload(agent), async () => undefined)
  assert.equal(third, undefined)
  assert.equal(agent.events.length, 4, 'exhaustion records no new retry')
})

test('a code the provider policy already retries is delegated untouched', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  let calls = 0
  const result = await listener(
    payload(agent, { failure: { message: 'slow down', code: 'RATE_LIMIT' } }),
    async () => { calls += 1; return undefined },
  )
  assert.equal(calls, 1)
  assert.equal(result, undefined)
  assert.equal(agent.events.length, 0)
})

test('a downstream retry decision is passed through without a second wait', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  const result = await listener(payload(agent), async () => ({ kind: 'retry' }))
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(agent.events.length, 0)
})

test('unknown codes are retried only when status429 selects them', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  const failure = { message: 'too many requests', code: 'HTTP_429', status: 429 }

  const retried = await listener(payload(agent, { failure }), async () => undefined)
  assert.deepEqual(retried, { kind: 'retry' })

  const other = fakeAgent('s2')
  const notSelected = await listener(
    payload(other, { failure: { ...failure, code: 'UNKNOWN_429', status: 500 } }),
    async () => undefined,
  )
  assert.equal(notSelected, undefined)
  assert.equal(other.events.length, 0)
})

test('disabled, provider-filtered, and unselected failures delegate', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, { enabled: false }, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  assert.equal(await listener(payload(fakeAgent()), async () => undefined), undefined)

  const second = fakeContext()
  await apply(second.ctx, { providers: ['other'] }, { env: {}, random: () => 0.5 })
  const filtered = second.listeners.get('agent/request-error')
  assert.equal(await filtered(payload(fakeAgent()), async () => undefined), undefined)

  const third = fakeContext()
  await apply(third.ctx, { codes: ['SOMETHING_ELSE'], status429: false }, { env: {}, random: () => 0.5 })
  const unknown = third.listeners.get('agent/request-error')
  assert.equal(await unknown(payload(fakeAgent()), async () => undefined), undefined)
})

test('maxRetries 0 disables the plugin retry', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, { maxRetries: 0 }, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  assert.equal(await listener(payload(agent), async () => undefined), undefined)
  assert.equal(agent.events.length, 0)
})

test('aborting during the delay cancels the retry', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  const controller = new AbortController()
  const slow = { ...POLICY, maxRetries: 3, initialDelayMs: 50, maxDelayMs: 50 }
  const pending = listener(payload(agent, { signal: controller.signal, retryPolicy: slow }), async () => undefined)
  setTimeout(() => controller.abort(), 5)
  assert.equal(await pending, undefined)
  assert.equal(agent.events.length, 1, 'the scheduled retry is durable, the started transition is not')
  assert.equal(agent.events[0].data.retry, 1)
})

test('disposing the plugin cancels recovery', async () => {
  const { ctx, listeners, effects } = fakeContext()
  await apply(ctx, {}, { env: {}, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  await effects[0]()
  const agent = fakeAgent()
  assert.equal(await listener(payload(agent), async () => undefined), undefined)
  assert.equal(agent.events.length, 0)
})

test('an invalid environment override warns once and falls back to config', async () => {
  const { ctx, warnings } = fakeContext()
  await apply(ctx, { maxRetries: 3 }, { env: { [MAX_RETRIES_ENV]: 'many' }, random: () => 0.5 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ignoring it/)
})

test('configuration validation applies defaults and rejects bad values', async () => {
  const defaults = __testables.validateConfig(undefined).value
  assert.equal(defaults.enabled, true)
  assert.deepEqual(defaults.codes, ['QUOTA', 'HTTP_429'])
  assert.deepEqual(defaults.providers, [])
  assert.equal(defaults.status429, true)
  assert.equal(defaults.maxRetries, null)

  assert.ok(__testables.validateConfig({ nope: true }).issues)
  assert.ok(__testables.validateConfig({ codes: [] }).issues)
  assert.ok(__testables.validateConfig({ codes: [''] }).issues)
  assert.ok(__testables.validateConfig({ codes: ['A', 'A'] }).issues)
  assert.ok(__testables.validateConfig({ providers: ['', 'x'] }).issues)
  assert.ok(__testables.validateConfig({ maxRetries: -1 }).issues)
  assert.ok(__testables.validateConfig({ maxRetries: 1.5 }).issues)
  assert.ok(__testables.validateConfig({ maxRetries: 10001 }).issues)

  const configured = __testables.validateConfig({
    enabled: false,
    codes: ['QUOTA'],
    providers: ['p'],
    status429: false,
    maxRetries: 0,
  }).value
  assert.deepEqual(configured, {
    enabled: false,
    codes: ['QUOTA'],
    providers: ['p'],
    status429: false,
    maxRetries: 0,
  })
})

test('apply rejects an invalid row config', async () => {
  const { ctx } = fakeContext()
  await assert.rejects(() => apply(ctx, { maxRetries: -2 }), /config rejected/)
})

test('parseMaxRetries accepts 0 and rejects malformed or oversized values', () => {
  assert.deepEqual(parseMaxRetries('0'), { kind: 'value', value: 0 })
  assert.deepEqual(parseMaxRetries('12'), { kind: 'value', value: 12 })
  assert.deepEqual(parseMaxRetries(''), { kind: 'unset' })
  assert.deepEqual(parseMaxRetries(undefined), { kind: 'unset' })
  for (const raw of ['-1', '1.5', 'abc', '10001']) {
    assert.equal(parseMaxRetries(raw).kind, 'invalid', raw)
  }
})

test('resolveMaxRetries prefers env, then config, then the provider policy', () => {
  const config = __testables.validateConfig({ maxRetries: 3 }).value
  assert.equal(resolveMaxRetries(config, { [MAX_RETRIES_ENV]: '7' }).value, 7)
  assert.equal(resolveMaxRetries(config, { [MAX_RETRIES_ENV_ALIAS]: '9' }).value, 9)
  assert.equal(resolveMaxRetries(config, {}).value, 3)
  assert.equal(resolveMaxRetries(config, {}).source, 'config')
  assert.equal(resolveMaxRetries({ ...config, maxRetries: null }, {}).value, null)

  const invalid = resolveMaxRetries(config, { [MAX_RETRIES_ENV]: 'abc' })
  assert.equal(invalid.value, 3)
  assert.match(invalid.warning, /ignoring it/)
})

test('recoveryPolicy fills harness defaults and honours the override', () => {
  const fallback = __testables.recoveryPolicy(undefined, null)
  assert.deepEqual(fallback, {
    mode: 'normal',
    initialDelayMs: 500,
    maxDelayMs: 10000,
    jitterRatio: 0.1,
    maxRetries: 5,
  })
  assert.equal(__testables.recoveryPolicy(POLICY, 0).maxRetries, 0)
  assert.equal(__testables.recoveryPolicy(POLICY, 12).maxRetries, 12)
  assert.deepEqual(__testables.recoveryPolicy({ mode: 'always' }, null), {
    mode: 'always',
    initialDelayMs: 500,
    maxDelayMs: 10000,
    jitterRatio: 0.1,
  })
})

test('delayFor prefers provider retry-after and caps it by policy mode', () => {
  const policy = { ...__testables.recoveryPolicy(POLICY, null) }
  assert.equal(__testables.delayFor(policy, 1, { providerRetryAfterMs: 1 }, () => 0.5), 1)
  assert.equal(__testables.delayFor(policy, 1, { providerRetryAfterMs: 1_000 }, () => 0.5), undefined)
  const always = { ...__testables.recoveryPolicy({ mode: 'always' }, null) }
  assert.equal(typeof __testables.delayFor(always, 1, { providerRetryAfterMs: 1_000 }, () => 0.5), 'number')
  assert.equal(__testables.delayFor(policy, 3, {}, () => 0), 2, 'exponential delay is capped by maxDelayMs')
})

test('localDelay grows exponentially with zero jitter and caps', () => {
  const policy = { initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 }
  assert.equal(__testables.localDelay(policy, 1, () => 0), 10)
  assert.equal(__testables.localDelay(policy, 2, () => 0), 20)
  assert.equal(__testables.localDelay(policy, 4, () => 0), 80)
  assert.equal(__testables.localDelay(policy, 5, () => 0), 100)
})
test('the environment override becomes the event maximum', async () => {
  const { ctx, listeners } = fakeContext()
  await apply(ctx, {}, { env: { [MAX_RETRIES_ENV]: '4' }, random: () => 0.5 })
  const listener = listeners.get('agent/request-error')
  const agent = fakeAgent()
  assert.deepEqual(await listener(payload(agent), async () => undefined), { kind: 'retry' })
  assert.equal(agent.events[0].data.maxRetries, 4)
})
