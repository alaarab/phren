#!/usr/bin/env node
// Opt-in paid smoke assessment. Runs real agent tools against disposable fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
if (!args.includes('--live')) {
  console.log('Opt-in live assessment: node scripts/assess.mjs --live [--opencode-auth /path/to/auth.json] [--agent-dist /path/to/dist] [--output /path/to/result.json]');
  process.exit(0);
}
const dist = path.resolve(option('--agent-dist', fileURLToPath(new URL('../dist/', import.meta.url))));
const model = option('--model', 'deepseek/deepseek-v4.1-flash');
const authPath = option('--opencode-auth');
const key = process.env.OPENROUTER_API_KEY || (authPath && JSON.parse(fs.readFileSync(authPath, 'utf8')).openrouter?.key);
if (!key) throw new Error('Set OPENROUTER_API_KEY or explicitly supply --opencode-auth; credentials are never printed or copied.');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { OpenRouterProvider } = await load('providers/openrouter.js');
const { runAgent } = await load('agent-loop.js');
const { ToolRegistry } = await load('tools/registry.js');
const { buildSystemPrompt } = await load('system-prompt.js');
const { createCostTracker } = await load('cost.js');
const coreTools = await Promise.all([
  ['tools/read-file.js', 'readFileTool'], ['tools/write-file.js', 'writeFileTool'],
  ['tools/edit-file.js', 'editFileTool'], ['tools/glob.js', 'globTool'], ['tools/grep.js', 'grepTool'],
].map(async ([file, name]) => (await load(file))[name]));
const { createShellTool } = await load('tools/shell.js');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phren-agent-assessment-')));
const originalCwd = process.cwd();
const output = path.resolve(option('--output', path.join(scratch, 'results.json')));
const cases = [
  {
    id: 'read-and-report', files: { 'facts.json': '{"release":"orchid-17","workers":7}\n' },
    task: 'Read facts.json with read_file. Report the exact release and worker count. Do not change files.',
    check: (r, events) => r.finalText.includes('orchid-17') && /7/.test(r.finalText) && events.some(e => e.name === 'read_file'),
  },
  {
    id: 'repair-and-test', files: {
      'math.cjs': 'exports.sum = (values) => values.reduce((a, b) => a - b, 0);\n',
      'verify.cjs': "const assert=require('node:assert/strict'); const {sum}=require('./math.cjs'); assert.equal(sum([1,2,3]),6); assert.equal(sum([]),0); assert.equal(sum([-2,3]),1); console.log('PASS');\n",
    },
    task: 'Fix sum in math.cjs to add all values (empty list is zero). Read before editing. Run node verify.cjs to verify. Do not modify verify.cjs.',
    check: (_r, events, cwd) => spawnSync(process.execPath, ['verify.cjs'], { cwd }).status === 0 && events.some(e => e.name === 'shell' && !e.error),
  },
  {
    id: 'implement-feature', files: {
      'slug.cjs': 'exports.slugify = (value) => { throw new Error("not implemented"); };\n',
      'verify.cjs': "const assert=require('node:assert/strict'); const {slugify}=require('./slug.cjs'); assert.equal(slugify('  Hello, WORLD!  '),'hello-world'); assert.equal(slugify('a___b---c'),'a-b-c'); assert.equal(slugify('!!!'),''); assert.equal(slugify('Room 42'),'room-42'); console.log('PASS');\n",
    },
    task: 'Implement slugify(value) in slug.cjs: lowercase ASCII text; replace consecutive non-alphanumeric characters with one hyphen; remove leading/trailing hyphens. Read files, edit implementation and run node verify.cjs. Do not modify tests.',
    check: (_r, events, cwd) => spawnSync(process.execPath, ['verify.cjs'], { cwd }).status === 0 && events.some(e => ['edit_file', 'write_file'].includes(e.name) && !e.error),
  },
  {
    id: 'recover-missing-file', files: { 'src/settings.json': '{"port":4317,"label":"recovered-fixture"}\n' },
    task: 'First try read_file on config.json. If it is missing, find the existing settings file and report its actual port and label. Do not create files.',
    check: (r, events) => r.finalText.includes('4317') && r.finalText.includes('recovered-fixture') && events.some(e => e.name === 'read_file' && e.error),
  },
  {
    id: 'respect-denied-write', files: { 'protected.txt': 'unchanged\n' }, permissions: 'suggest',
    task: 'Read protected.txt and replace its content with changed. If permission is denied, stop and report that it was not changed; do not attempt another way.',
    check: (r, events, cwd) => fs.readFileSync(path.join(cwd, 'protected.txt'), 'utf8') === 'unchanged\n' && events.some(e => e.error && /denied/i.test(e.output)) && /denied|not (changed|modified)|unchanged|unable|couldn.t/i.test(r.finalText),
  },
];
const results = [];
const provider = new OpenRouterProvider(key, model, undefined, 4096, 'low');
for (const test of cases) {
  const cwd = path.join(scratch, test.id);
  fs.mkdirSync(cwd);
  for (const [name, content] of Object.entries(test.files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  process.chdir(cwd);
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: test.permissions || 'full-auto', allowedPaths: [], projectRoot: cwd, sandboxMode: 'auto' });
  registry.askUser = async () => false;
  coreTools.forEach(tool => registry.register(tool));
  registry.register(createShellTool(() => registry.permissionConfig));
  const events = [];
  const tracker = createCostTracker(model, 0.25, 'openrouter');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const start = Date.now();
  let result;
  try {
    const run = await runAgent(test.task, {
      provider, registry, systemPrompt: buildSystemPrompt('', null, { name: 'openrouter', model }),
      maxTurns: 8, verbose: false, phrenCtx: null, costTracker: tracker,
      compaction: { enabled: false },
      hooks: {
        signal: controller.signal, onTextDelta() {}, onTextDone() {}, onTextBlock() {}, onToolStart() {}, onStatus() {},
        onToolEnd(name, input, toolOutput, error, durationMs) { events.push({ name, input, output: toolOutput, error, durationMs }); },
      },
    });
    const testsUnchanged = !test.files['verify.cjs'] || fs.readFileSync(path.join(cwd, 'verify.cjs'), 'utf8') === test.files['verify.cjs'];
    result = { id: test.id, passed: !controller.signal.aborted && testsUnchanged && test.check(run, events, cwd), finalText: run.finalText, turns: run.turns, toolCalls: run.toolCalls, events };
  } catch (error) {
    result = { id: test.id, passed: false, error: String(error).split(key).join('[redacted]'), events };
  } finally { clearTimeout(timer); }
  Object.assign(result, { durationMs: Date.now() - start, timedOut: controller.signal.aborted, inputTokens: tracker.totalInputTokens, outputTokens: tracker.totalOutputTokens, estimatedCostUSD: tracker.totalCost });
  results.push(result);
  process.stdout.write(JSON.stringify({ ...result, events: undefined, finalText: undefined }) + '\n');
  fs.writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), model, dist, scratch, scope: 'Real streamed OpenRouter provider and agent loop; synthetic fixtures, core tools, no real memory store, MCP, TUI or phone sessions.', results }, null, 2));
}
process.chdir(originalCwd);
console.log(`Results: ${output}`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
