import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = process.env.PI_TEST_PACKAGE_DIR
  ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const cli = join(packageRoot, 'dist/cli.js');
const extension = new URL('../index.ts', import.meta.url).pathname;
const model = process.env.JEV_AGENT_MODEL ?? 'azure-openai-responses/gpt-6-astra';
const cases = [
  {
    id: 'semantic_choice_uses_jev',
    expectCalls: 1,
    prompt: [
      'Escolha o texto de um botão para uma etapa opcional de onboarding.',
      'Fatos observados: usuários iniciantes querem orientação, mas abandonam textos longos. A tela já explica que a etapa pode ser pulada.',
      'Restrições: o botão deve ser curto e não pode prometer conclusão.',
      'Alternativas materialmente plausíveis: “Continuar” enfatiza fluidez, enquanto “Configurar agora” explicita a ação mas é mais longo.',
      'Não há regra determinística que escolha entre elas. Use a ferramenta apropriada se o contrato dela se aplicar e responda com a decisão.',
    ].join(' '),
  },
  {
    id: 'deterministic_arithmetic_skips_jev',
    expectCalls: 0,
    prompt: 'Calcule 17 + 25 e responda apenas com o número.',
  },
];

for (const evaluation of cases) {
  const run = spawnSync('/usr/bin/node', [
    cli,
    '--offline',
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-extensions',
    '--no-builtin-tools',
    '--no-session',
    '--mode', 'json',
    '--model', model,
    '--thinking', 'high',
    '-e', extension,
    evaluation.prompt,
  ], {
    cwd: new URL('../', import.meta.url).pathname,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${evaluation.id}: Pi exited ${run.status}: ${run.stderr.trim()}`);
  let calls = 0;
  let finalText = '';
  for (const line of run.stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'tool_execution_start' && event.toolName === 'jev_decide') calls++;
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      for (const block of event.message.content ?? []) if (block.type === 'text') finalText += block.text;
    }
  }
  const passed = evaluation.expectCalls === 0 ? calls === 0 : calls >= evaluation.expectCalls;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${evaluation.id}: jev_calls=${calls} final=${JSON.stringify(finalText.slice(0, 160))}`);
  if (!passed) process.exitCode = 1;
}
