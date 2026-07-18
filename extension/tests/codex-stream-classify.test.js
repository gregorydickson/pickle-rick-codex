// @tier: fast
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCodexToolCalls,
  detectOutputFormat,
  extractAssistantContent,
  extractCodexUsage,
  observeCodexToolCallStream,
} from '../services/classifier-utils.js';
import { runCommand } from '../services/codex.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realJsonl = fs.readFileSync(path.join(fixtures, 'codex-exec-real.jsonl'), 'utf8');
const codexBlock = fs.readFileSync(path.join(fixtures, 'codex-block.txt'), 'utf8');

test('detectOutputFormat discriminates real Codex JSONL, codex blocks, and prose', () => {
  assert.equal(detectOutputFormat(realJsonl), 'stream-json');
  assert.equal(detectOutputFormat(codexBlock), 'codex-block');
  assert.equal(detectOutputFormat('ordinary assistant prose'), 'plain-text');
});

test('real Codex exec JSONL extracts assistant text, usage, and command observations', () => {
  assert.match(extractAssistantContent(realJsonl), /Runtime validated/);
  assert.doesNotMatch(extractAssistantContent(realJsonl), /node .*setup/);
  assert.deepEqual(extractCodexUsage(realJsonl), {
    input_tokens: 120,
    output_tokens: 18,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40,
  });
  const calls = collectCodexToolCalls(realJsonl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].isSetupInvocation, true);
  assert.deepEqual(calls[0].argv.slice(0, 3), ['node', './bin/setup.js', '--resume']);
});

test('codex-block parsing keeps only codex content and observes serialized tool calls', () => {
  assert.equal(extractAssistantContent(codexBlock), 'Runtime validated from block output.\n<promise>WORKER_DONE</promise>');
  const toolLine = codexBlock.split('\n').find((line) => line.startsWith('{'));
  const observation = observeCodexToolCallStream(toolLine, 'codex-block');
  assert.equal(observation?.isSetupInvocation, true);
  assert.equal(observation?.command, 'node bin/setup.js --resume /tmp/session');
});

test('assistant extraction tolerates variant JSONL content blocks and fallback event shapes', () => {
  const completed = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', content: ['first', { text: 'second' }, null] } }),
    JSON.stringify({ type: 'assistant', message: { content: 'ignored fallback' } }),
  ].join('\n');
  assert.equal(extractAssistantContent(completed), 'first\nsecond');

  const fallback = [
    JSON.stringify({ type: 'assistant', message: { content: [{ text: 'assistant block' }] } }),
    JSON.stringify({ type: 'result', result: 'result block' }),
    JSON.stringify({ type: 'response.output_text.done', text: 'response block' }),
  ].join('\n');
  assert.equal(extractAssistantContent(fallback), 'assistant block\nresult block\nresponse block');

  assert.equal(extractAssistantContent('{"metadata":true}\n{"alsoMetadata":1}'), '');
});

test('tool-call observation tolerates malformed arguments and deduplicates equivalent calls', () => {
  const direct = observeCodexToolCallStream('node bin/setup.js --resume "/tmp/session path"', 'codex-block');
  assert.deepEqual(direct?.argv, ['node', 'bin/setup.js', '--resume', '/tmp/session path']);
  assert.equal(direct?.isSetupInvocation, true);

  const malformed = JSON.stringify({
    type: 'function_call',
    name: 'custom',
    arguments: '{not-json',
  });
  const parsed = observeCodexToolCallStream(malformed, 'stream-json');
  assert.equal(parsed?.arguments, '{not-json');
  assert.equal(parsed?.command, null);
  assert.equal(observeCodexToolCallStream('ordinary codex prose', 'codex-block'), null);

  const command = JSON.stringify({
    type: 'command_execution',
    command: 'node ./bin/setup.ts --resume',
    input: ['ignored-non-object'],
  });
  const calls = collectCodexToolCalls([command, command, malformed, '{bad-json'].join('\n'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'shell');
  assert.equal(calls[0].isSetupInvocation, true);
  assert.equal(calls[1].name, 'custom');
});

test('usage extraction accumulates direct and nested counters while ignoring non-object events', () => {
  const output = [
    JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 4, cached_input_tokens: 5 } }),
    JSON.stringify({ response: { usage: { input_tokens: 7, cache_read_input_tokens: 11 } } }),
    JSON.stringify({ result: { usage: { output_tokens: 13 } } }),
    JSON.stringify(['ignored']),
    'not-json',
  ].join('\n');
  assert.deepEqual(extractCodexUsage(output), {
    input_tokens: 9,
    output_tokens: 16,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 16,
  });
});

test('codex runner results and success checks expose classified events without replacing raw stdout', async () => {
  let observed = null;
  const result = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.CODEX_FIXTURE || "")'],
    env: { CODEX_FIXTURE: realJsonl },
    successCheck: (context) => {
      observed = context;
      return context.assistantContent.includes('WORKER_DONE');
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputFormat, 'stream-json');
  assert.match(result.stdout, /thread\.started/);
  assert.match(result.assistantContent, /WORKER_DONE/);
  assert.equal(result.toolCalls[0].isSetupInvocation, true);
  assert.equal(result.usage.cache_read_input_tokens, 40);
  assert.equal(observed?.outputFormat, 'stream-json');
});
