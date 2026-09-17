import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';

const root = new URL('../', import.meta.url).pathname;
const packageRoot = process.env.PI_TEST_PACKAGE_DIR
  ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const requirePi = createRequire(join(packageRoot, 'package.json'));
const { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  'typebox/value': fileURLToPath(import.meta.resolve('typebox/value')),
  'typebox': fileURLToPath(import.meta.resolve('typebox')),
} });
const { evaluate, readApiKey } = await jiti.import(join(root, 'client.ts'));
const { buildRequest } = await jiti.import(join(root, 'decision.ts'));

const repeats = Number.parseInt(process.env.JEV_EVAL_REPEATS ?? '3', 10);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('JEV_EVAL_REPEATS must be an integer from 1 to 10');
const output = process.argv[2] ?? join(root, 'eval/results/latest.json');
const key = await readApiKey(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'), '.env'));
const results = [];

for (const evaluation of cases) {
  const reversed = { ...evaluation.input, options: [...evaluation.input.options].reverse() };
  if (JSON.stringify(buildRequest(evaluation.input)) !== JSON.stringify(buildRequest(reversed))) {
    throw new Error(`${evaluation.id}: request changes when caller option order changes`);
  }
  const samples = [];
  for (let index = 0; index < repeats; index++) {
    const result = await evaluate(index % 2 === 0 ? evaluation.input : reversed, key);
    samples.push(result);
  }
  const passed = samples.every((sample) => sample.status === evaluation.expectedStatus
    && (evaluation.expectedRecommendation === undefined || sample.recommendation === evaluation.expectedRecommendation));
  results.push({
    id: evaluation.id,
    expectedStatus: evaluation.expectedStatus,
    expectedRecommendation: evaluation.expectedRecommendation ?? null,
    passed,
    samples,
  });
}

const summary = {
  model: [...new Set(results.flatMap((result) => result.samples.map((sample) => sample.model)))],
  repeats,
  cases: results.length,
  passed: results.filter((result) => result.passed).length,
  inputTokens: results.reduce((total, result) => total + result.samples.reduce((sum, sample) => sum + sample.usage.input_tokens, 0), 0),
  outputTokens: results.reduce((total, result) => total + result.samples.reduce((sum, sample) => sum + sample.usage.output_tokens, 0), 0),
  elapsedMs: results.reduce((total, result) => total + result.samples.reduce((sum, sample) => sum + sample.elapsedMs, 0), 0),
  results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
for (const result of results) {
  const observed = result.samples.map((sample) => `${sample.status}:${sample.recommendation ?? sample.candidate}`).join(', ');
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}: ${observed}`);
}
console.log(`summary: ${summary.passed}/${summary.cases} cases, ${summary.inputTokens} input tokens, ${summary.elapsedMs} ms`);
if (summary.passed !== summary.cases) process.exitCode = 1;
