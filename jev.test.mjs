import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = process.env.PI_TEST_PACKAGE_DIR
  ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const requirePi = createRequire(join(packageRoot, 'package.json'));
const { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  'typebox/value': fileURLToPath(import.meta.resolve('typebox/value')),
  'typebox': fileURLToPath(import.meta.resolve('typebox')),
} });
const { evaluate, readApiKey } = await jiti.import('./client.ts');
const { buildRequest, canonicalOptions, parseDecision } = await jiti.import('./decision.ts');
const { loadExtensions } = await import(`${packageRoot}/dist/core/extensions/loader.js`);
const { readGlobalConfig, writeGlobalConfig } = await jiti.import('./config.ts');

const baseInput = {
  question: 'Which support team should receive the ticket?',
  context: {
    observed: ['The customer reports a duplicated card charge and requests a refund.'],
    constraints: ['Choose only a team that handles the reported problem.'],
    unknowns: [],
  },
  options: [
    {
      id: 'billing',
      action: 'Route to billing.',
      evidenceFor: ['The message is about a duplicated charge and refund.'],
      evidenceAgainst: [],
    },
    {
      id: 'shipping',
      action: 'Route to shipping.',
      evidenceFor: [],
      evidenceAgainst: ['No delivery problem is reported.'],
    },
  ],
  stakes: 'low',
};

function responseFor(input, values = {}) {
  const ordered = canonicalOptions(input);
  const choice = values.choice ?? 'billing';
  const probabilities = values.probabilities ?? { billing: 0.92, shipping: 0.08 };
  const support = values.support ?? { billing: 0.91, shipping: 0.04 };
  return {
    model: 'jev-fixture',
    answers: {
      decision: {
        type: 'choice',
        choice,
        confidence: values.confidence ?? 0.86,
        probabilities,
      },
      evidence_sufficient: { type: 'noul', noul: values.sufficiency ?? 0.9 },
      ...Object.fromEntries(ordered.map((option, index) => [
        `support_${index}`,
        { type: 'noul', noul: support[option.id] ?? 0 },
      ])),
    },
    usage: { input_tokens: 100, output_tokens: 30 },
  };
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.TYPESAFE_API_KEY;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let configDirectory;
let instances;

beforeEach(async () => {
  process.env.TYPESAFE_API_KEY = 'synthetic-credential-only';
  configDirectory = await mkdtemp(join(tmpdir(), 'jev-test-home-'));
  process.env.PI_CODING_AGENT_DIR = configDirectory;
  instances = [];
});

afterEach(async () => {
  for (const instance of instances) await instance.emit('session_shutdown');
  await rm(configDirectory, { recursive: true });
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function runtimeFixture({ idle = true } = {}) {
  const loaded = await loadExtensions([new URL('./index.ts', import.meta.url).pathname], new URL('.', import.meta.url).pathname);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let tools = ['read', 'fm_watch_arm_pi', 'other_tool', 'jev_decide'];
  let thinking = 'high';
  const notifications = [];
  Object.assign(loaded.runtime, {
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => { thinking = level; },
    getActiveTools: () => tools,
    setActiveTools: (next) => { tools = next; },
  });
  const context = {
    hasUI: true,
    model: { provider: 'test', id: 'executor', reasoning: true },
    isIdle: () => idle,
    sessionManager: { getBranch: () => [], getSessionId: () => 'session-a' },
    ui: { notify: (message) => notifications.push(message), setStatus: () => {} },
  };
  const instance = {
    notifications,
    context,
    level: () => thinking,
    tools: () => tools,
    command: (text) => extension.commands.get('jev').handler(text, context),
    emit: async (event, value = {}) => {
      const results = [];
      for (const handler of extension.handlers.get(event) ?? []) results.push(await handler(value, context));
      return results;
    },
    execute: (params = baseInput, signal) => extension.tools.get('jev_decide').definition.execute('call', params, signal, undefined, context),
    definition: extension.tools.get('jev_decide').definition,
  };
  instances.push(instance);
  return instance;
}

test('request uses structured state, atomic judgments, and caller-order-independent options', () => {
  const forward = buildRequest(baseInput);
  const reverse = buildRequest({ ...baseInput, options: [...baseInput.options].reverse() });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.state.decision.observed, baseInput.context.observed);
  assert.equal(forward.questions.decision.type, 'choice');
  assert.equal(forward.questions.evidence_sufficient.type, 'noul');
  assert.equal(Object.keys(forward.questions).length, 4);
  assert.throws(() => buildRequest({ ...baseInput, options: [baseInput.options[0], baseInput.options[0]] }), /unique/);
  assert.throws(() => buildRequest({ ...baseInput, question: ' ' }), /blank/);
});

test('policy recommends only a sufficiently supported low-stakes choice', () => {
  const result = parseDecision(responseFor(baseInput), baseInput);
  assert.equal(result.status, 'recommend');
  assert.equal(result.recommendation, 'billing');
  assert.equal(result.candidateSupport, 0.91);
  assert.deepEqual(result.reasons, []);
});

test('policy abstains when the choice is close or evidence is weak', () => {
  const raw = responseFor(baseInput, {
    probabilities: { billing: 0.52, shipping: 0.48 },
    confidence: 0.35,
    sufficiency: 0.45,
    support: { billing: 0.58, shipping: 0.42 },
  });
  const result = parseDecision(raw, baseInput);
  assert.equal(result.status, 'abstain');
  assert.equal(result.recommendation, null);
  assert.ok(result.reasons.includes('top_probability_below_threshold'));
  assert.ok(result.reasons.includes('choice_margin_below_threshold'));
  assert.ok(result.reasons.includes('evidence_insufficient'));
});

test('high-stakes choices always require review even with concentrated probabilities', () => {
  const input = { ...baseInput, stakes: 'high' };
  const result = parseDecision(responseFor(input), input);
  assert.equal(result.status, 'review_required');
  assert.equal(result.recommendation, null);
  assert.equal(result.candidate, 'billing');
  assert.ok(result.reasons.includes('high_stakes_require_review'));
});

test('parser rejects unknown choices, incomplete distributions, and incomplete answer sets', () => {
  const unknown = responseFor(baseInput);
  unknown.answers.decision.choice = 'unknown';
  assert.throws(() => parseDecision(unknown, baseInput), /no decision accepted/);
  const incomplete = responseFor(baseInput);
  delete incomplete.answers.decision.probabilities.shipping;
  assert.throws(() => parseDecision(incomplete, baseInput), /no decision accepted/);
  const missingJudgment = responseFor(baseInput);
  delete missingJudgment.answers.evidence_sufficient;
  assert.throws(() => parseDecision(missingJudgment, baseInput), /no decision accepted/);
});

test('HTTP boundary sends the structured request and returns a policy result', async () => {
  globalThis.fetch = async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-credential-only');
    assert.deepEqual(JSON.parse(request.body), buildRequest(baseInput));
    return Response.json(responseFor(baseInput));
  };
  const result = await evaluate(baseInput, process.env.TYPESAFE_API_KEY);
  assert.equal(result.status, 'recommend');
  assert.equal(result.recommendation, 'billing');
});

test('HTTP errors, malformed JSON, oversized responses, cancellation, and credential echo are rejected', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('secret body', { status: 429, headers: { 'retry-after': '30' } }); };
  await assert.rejects(evaluate(baseInput, process.env.TYPESAFE_API_KEY), /^Error: Jev: HTTP 429; no decision accepted\. Retry after 30s\.$/);
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response('not JSON');
  await assert.rejects(evaluate(baseInput, process.env.TYPESAFE_API_KEY), /not JSON/);
  globalThis.fetch = async () => new Response('x'.repeat(32_769));
  await assert.rejects(evaluate(baseInput, process.env.TYPESAFE_API_KEY), /exceeded 32 KiB/);
  const credentialInput = structuredClone(baseInput);
  credentialInput.context.observed = [process.env.TYPESAFE_API_KEY];
  await assert.rejects(evaluate(credentialInput, process.env.TYPESAFE_API_KEY), /credential/);
  globalThis.fetch = async () => { throw new Error('must not reach network'); };
  await assert.rejects(evaluate(baseInput, process.env.TYPESAFE_API_KEY, AbortSignal.abort()), /abort/i);
});

test('credential reader parses dotenv without executing shell syntax', async () => {
  delete process.env.TYPESAFE_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), 'jev-env-'));
  try {
    const file = join(directory, '.env');
    await writeFile(file, 'UNRELATED=hidden\nTYPESAFE_API_KEY="$(echo never-execute)"\n');
    assert.equal(await readApiKey(file), '$(echo never-execute)');
    await assert.rejects(readApiKey(join(directory, 'absent')), /unavailable/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('on and off expose only the bounded judge and never change native thinking', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start');
  assert.equal(app.level(), 'high');
  assert.deepEqual(app.tools(), ['read', 'fm_watch_arm_pi', 'other_tool']);
  await assert.rejects(app.execute(), /Jev is off/);
  await app.command('on');
  assert.equal(app.level(), 'high');
  assert.equal(app.tools().filter((name) => name === 'jev_decide').length, 1);
  assert.match(app.definition.promptSnippet, /bounded semantic choice/);
  assert.ok(app.definition.promptGuidelines.some((line) => line.includes('deterministic rules')));
  await app.command('off');
  assert.equal(app.level(), 'high');
  assert.deepEqual(app.tools(), ['read', 'fm_watch_arm_pi', 'other_tool']);
});

test('global config controls fresh instances and defers changes while an agent is busy', async () => {
  const first = await runtimeFixture();
  const second = await runtimeFixture();
  await first.emit('session_start');
  await second.emit('session_start');
  await first.command('on');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.ok(second.tools().includes('jev_decide'));
  second.context.isIdle = () => false;
  await first.command('off');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.ok(second.tools().includes('jev_decide'));
  second.context.isIdle = () => true;
  await second.emit('agent_settled');
  assert.ok(!second.tools().includes('jev_decide'));
  assert.equal(second.level(), 'high');
});

test('global config is atomic, private, rejects malformed values, and defaults absent to off', async () => {
  const path = join(configDirectory, 'jev.json');
  assert.deepEqual(await readGlobalConfig(path), { enabled: false });
  await writeGlobalConfig(path, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(configDirectory), ['jev.json']);
  for (const value of ['{', '{"enabled":"true"}', '{"enabled":true,"unknown":1}']) {
    await writeFile(path, value);
    await assert.rejects(readGlobalConfig(path), /Jev:/);
  }
});

test('shutdown cancels in-flight HTTP work and rejects a stale judgment', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start');
  await app.command('on');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (_url, request) => {
    entered();
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const pending = app.execute();
  await started;
  await app.emit('session_shutdown');
  await assert.rejects(pending, /cancelled/);
  assert.equal(app.level(), 'high');
  assert.ok(!app.tools().includes('jev_decide'));
});
