import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const packageRoot = process.env.PI_TEST_PACKAGE_DIR ?? '/home/shiv/.local/lib/node_modules/@earendil-works/pi-coding-agent';
const requirePi = createRequire(join(packageRoot, 'package.json'));
const { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  'typebox/value': join(packageRoot, 'node_modules/typebox/build/value/index.mjs'),
  'typebox': join(packageRoot, 'node_modules/typebox/build/index.mjs'),
} });
const { evaluate, buildRequest, parseDecision, readApiKey, NEED_EVIDENCE } = await jiti.import('./client.ts');
const { loadExtensions } = await import(`${packageRoot}/dist/core/extensions/loader.js`);
const { readGlobalConfig, writeGlobalConfig } = await jiti.import('./config.ts');
const input = {
  question: 'Qual o próximo passo para identificar a falha?',
  context: 'O teste falhou, mas a mensagem de erro não foi lida.',
  options: [
    { id: 'read_error', description: 'Ler a mensagem do teste antes de editar' },
    { id: 'change_code', description: 'Mudar código sem conhecer a falha' },
  ],
};
const fixture = () => ({
  model: 'jev-fixture',
  answers: { decision: { type: 'choice', choice: 'read_error', confidence: 0.9,
    probabilities: { read_error: 0.95, change_code: 0.02, [NEED_EVIDENCE]: 0.03 } } },
  usage: { input_tokens: 100, output_tokens: 20 },
});
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

async function runtimeFixture({ entries = [], sessionId = 'session-a', clamp = false, supportsOff = true, initialThinking = 'high' } = {}) {
  const loaded = await loadExtensions([new URL('./index.ts', import.meta.url).pathname], new URL('.', import.meta.url).pathname);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let thinking = initialThinking;
  let tools = ['read', 'fm_watch_arm_pi', 'other_tool', 'jev_decide'];
  const notifications = [];
  Object.assign(loaded.runtime, {
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => { thinking = clamp && level === 'off' ? 'minimal' : level; },
    getActiveTools: () => tools,
    setActiveTools: (next) => { tools = next; },
    appendEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
  });
  const context = {
    hasUI: true, model: { provider: 'test', id: 'executor', reasoning: true, thinkingLevelMap: { off: supportsOff ? 'none' : null } },
    isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
    ui: { notify: (message) => notifications.push(message), setStatus: () => {} },
  };
  const instance = {
    entries, notifications, context,
    level: () => thinking, setLevel: (value) => { thinking = value; }, tools: () => tools,
    command: (text) => extension.commands.get('jev').handler(text, context),
    emit: async (event, value = {}) => {
      const results = [];
      for (const handler of extension.handlers.get(event) ?? []) results.push(await handler(value, context));
      return results;
    },
    execute: (params = input, signal) => extension.tools.get('jev_decide').definition.execute('call', params, signal, undefined, context),
  };
  instances.push(instance);
  return instance;
}

test('request carries only explicit evidence and preserves a no-match outcome', () => {
  const body = buildRequest(input);
  assert.deepEqual(body.state, { evidence: input.context });
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.decision.type, 'choice');
  assert.ok(body.questions.decision.criteria[NEED_EVIDENCE]);
  assert.throws(() => buildRequest({ ...input, options: [input.options[0], input.options[0]] }), /unique/);
  assert.throws(() => buildRequest({ ...input, context: ' ' }), /blank/);
  assert.throws(() => buildRequest({ ...input, context: 'x'.repeat(12001) }), /invalid/);
});

test('parser rejects unknown choices, incomplete distributions and invalid probabilities', () => {
  for (const change of [
    (answer) => { answer.choice = 'execute_unlisted'; },
    (answer) => { delete answer.probabilities.change_code; },
    (answer) => { answer.probabilities.change_code = 0.9; },
    (answer) => { answer.confidence = 2; },
    (answer) => { answer.choice = 'change_code'; },
  ]) {
    const raw = fixture(); change(raw.answers.decision);
    assert.throws(() => parseDecision(raw, input), /no decision accepted/);
  }
  const raw = fixture();
  raw.answers.decision.choice = NEED_EVIDENCE;
  raw.answers.decision.probabilities = { read_error: 0, change_code: 0, [NEED_EVIDENCE]: 1 };
  assert.equal(parseDecision(raw, input).needsMoreEvidence, true);
});

test('HTTP boundary is fixed, abortable, redirect-refusing and returns measured usage', async () => {
  globalThis.fetch = async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer synthetic-credential-only');
    assert.deepEqual(JSON.parse(request.body), buildRequest(input));
    assert.ok(request.signal);
    return Response.json(fixture());
  };
  const result = await evaluate(input, process.env.TYPESAFE_API_KEY);
  assert.equal(result.recommendation, 'read_error');
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(result.cost, 'not reported by API');
});

test('HTTP errors do not leak response bodies or retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('secret body', { status: 429, headers: { 'retry-after': '30' } }); };
  await assert.rejects(evaluate(input, process.env.TYPESAFE_API_KEY), /^Error: Jev: HTTP 429; no decision accepted\. Retry after 30s\.$/);
  assert.equal(calls, 1);
});

test('bad JSON, oversized response, cancellation and credential echo are rejected', async () => {
  globalThis.fetch = async () => new Response('not JSON');
  await assert.rejects(evaluate(input, process.env.TYPESAFE_API_KEY), /not JSON/);
  globalThis.fetch = async () => new Response('x'.repeat(32769));
  await assert.rejects(evaluate(input, process.env.TYPESAFE_API_KEY), /exceeded 32 KiB/);
  await assert.rejects(evaluate({ ...input, context: process.env.TYPESAFE_API_KEY }, process.env.TYPESAFE_API_KEY), /credential/);
  globalThis.fetch = async () => { throw new Error('must not reach network'); };
  await assert.rejects(evaluate(input, process.env.TYPESAFE_API_KEY, AbortSignal.abort()), /abort/i);
});

test('credential reader parses dotenv without executing shell syntax', async () => {
  delete process.env.TYPESAFE_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), 'jev-env-'));
  try {
    const file = join(directory, '.env');
    await writeFile(file, 'UNRELATED=hidden\nTYPESAFE_API_KEY="$(echo never-execute)"\n');
    assert.equal(await readApiKey(file), '$(echo never-execute)');
    await assert.rejects(readApiKey(join(directory, 'absent')), /unavailable/);
  } finally { await rm(directory, { recursive: true }); }
});

test('on/off restores thinking and never removes other tools or base instructions', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start');
  assert.equal(app.level(), 'high');
  assert.deepEqual(app.tools(), ['read', 'fm_watch_arm_pi', 'other_tool']);
  await assert.rejects(app.execute(), /Jev is off/);
  await app.command('on');
  await app.command('on');
  assert.equal(app.level(), 'off');
  assert.equal(app.tools().filter((name) => name === 'jev_decide').length, 1);
  const [result] = await app.emit('before_agent_start', { systemPrompt: 'ORIGINAL INSTRUCTIONS' });
  assert.ok(result.systemPrompt.startsWith('ORIGINAL INSTRUCTIONS\n\n'));
  await app.command('off');
  assert.equal(app.level(), 'high');
  assert.deepEqual(await app.emit('before_agent_start', { systemPrompt: 'ORIGINAL' }), [undefined]);
  assert.deepEqual(app.tools(), ['read', 'fm_watch_arm_pi', 'other_tool']);
});

test('unsupported off restores the old level and leaves Jev unavailable', async () => {
  const app = await runtimeFixture({ clamp: true });
  await app.emit('session_start');
  await app.command('on');
  assert.equal(app.level(), 'high');
  assert.ok(!app.tools().includes('jev_decide'));
  assert.ok(app.notifications.some((message) => message.includes('thinking off did not take effect')));
});

test('global config controls resumed and new sessions instead of a stale session flag', async () => {
  const original = await runtimeFixture();
  await original.emit('session_start'); await original.command('on');
  await original.emit('session_shutdown');
  assert.equal(original.level(), 'high');
  const enabledEntries = structuredClone(original.entries);
  const resumed = await runtimeFixture({ entries: structuredClone(enabledEntries) });
  await resumed.emit('session_start');
  assert.equal(resumed.level(), 'off');
  const fresh = await runtimeFixture({ sessionId: 'different-session' });
  await fresh.emit('session_start');
  assert.equal(fresh.level(), 'off');
  await resumed.command('off');
  assert.equal(resumed.level(), 'high');
  const recovered = await runtimeFixture({ entries: enabledEntries, initialThinking: 'off' });
  await recovered.emit('session_start');
  assert.equal(recovered.level(), 'high');
  assert.ok(!recovered.tools().includes('jev_decide'));
});

test('model changes obey global activation and explicit thinking changes are preserved', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start'); await app.command('on');
  app.context.model = { provider: 'test', id: 'other', reasoning: true, thinkingLevelMap: { off: null } };
  app.setLevel('high');
  await app.emit('model_select');
  assert.ok(app.tools().includes('jev_decide'));
  assert.equal(app.level(), 'high');
  app.setLevel('low');
  await app.emit('thinking_level_select', { level: 'low' });
  assert.ok(app.tools().includes('jev_decide'));
  await app.command('off');
  assert.equal(app.level(), 'low');
});

test('unsupported native off keeps Jev available with the original thinking level and an explicit warning', async () => {
  const app = await runtimeFixture({ supportsOff: false });
  await app.emit('session_start'); await app.command('on');
  assert.equal(app.level(), 'high');
  assert.ok(app.tools().includes('jev_decide'));
  assert.ok(app.notifications.some((message) => message.includes('não oferece thinking off')));
  await app.command('off');
  assert.equal(app.level(), 'high');
});

test('concurrent activation and shutdown preserve the baseline and prevent stale activation', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start');
  await Promise.all([app.command('on'), app.command('on')]);
  await app.command('off');
  assert.equal(app.level(), 'high');
  const pending = app.command('on');
  await app.emit('session_shutdown');
  await pending;
  assert.equal(app.level(), 'high');
  assert.ok(!app.tools().includes('jev_decide'));
});

test('global on/off propagates to another idle agent by polling and defers changes during work', async () => {
  const first = await runtimeFixture();
  const second = await runtimeFixture({ sessionId: 'second-agent' });
  await first.emit('session_start'); await second.emit('session_start');
  await first.command('on');
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'jev.json'), 'utf8')), { enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(second.tools().includes('jev_decide'));
  second.context.isIdle = () => false;
  await first.command('off');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(second.tools().includes('jev_decide'));
  second.context.isIdle = () => true;
  await second.emit('agent_settled');
  assert.ok(!second.tools().includes('jev_decide'));
  assert.equal(second.level(), 'high');
});

test('global config is atomic, private, rejects malformed values and defaults absent to off', async () => {
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

test('invalid global config disables Jev safely and reports one diagnostic per error episode', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start'); await app.command('on');
  await writeFile(join(configDirectory, 'jev.json'), '{');
  await app.emit('agent_settled'); await app.emit('agent_settled');
  assert.equal(app.level(), 'high');
  assert.ok(!app.tools().includes('jev_decide'));
  assert.equal(app.notifications.filter((message) => message.includes('not valid JSON')).length, 1);
});

test('shutdown cancels in-flight HTTP work and rejects a stale judgment', async () => {
  const app = await runtimeFixture();
  await app.emit('session_start'); await app.command('on');
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
});
