export const CODEX_DELIMITER_RE = /^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/i;

export type CodexOutputFormat = 'stream-json' | 'codex-block' | 'plain-text';

export interface CodexToolCallObservation {
  name: string;
  command: string | null;
  arguments: Record<string, unknown> | string | null;
  isSetupInvocation: boolean;
  argv: string[];
}

export interface ParsedCodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface JsonObject { [key: string]: unknown }

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function parseObject(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function stringField(value: unknown, key: string): string | null {
  const object = asObject(value);
  return object && typeof object[key] === 'string' ? object[key] as string : null;
}

function parseArguments(value: unknown): Record<string, unknown> | string | null {
  if (typeof value !== 'string') return asObject(value) || null;
  try {
    return asObject(JSON.parse(value)) || value;
  } catch {
    return value;
  }
}

function shellArgv(command: string): string[] {
  // Observation only: preserve quoted groups without pretending to execute or
  // fully emulate a shell grammar.
  return [...command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)]
    .map((match) => match[0].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
}

function isSetupInvocation(command: string): boolean {
  return /(?:^|\s)(?:node\s+)?(?:[^\s"']*[/\\])?setup\.(?:js|ts)(?:\s|$)/.test(command);
}

function toolCallFromObject(event: JsonObject): CodexToolCallObservation | null {
  const item = asObject(event.item) || event;
  const type = typeof item.type === 'string' ? item.type : '';
  const rawName = typeof item.name === 'string'
    ? item.name
    : typeof item.tool === 'string'
      ? item.tool
      : type === 'command_execution' ? 'shell' : '';
  if (!['command_execution', 'function_call', 'tool_call', 'mcp_tool_call', 'tool_use'].includes(type)
      && !rawName) return null;

  const args = parseArguments(item.arguments ?? item.parameters ?? item.input);
  const command = typeof item.command === 'string'
    ? item.command
    : stringField(args, 'command') ?? stringField(args, 'cmd');
  const name = rawName || type;
  const argv = command ? shellArgv(command) : [];
  return {
    name,
    command,
    arguments: args,
    isSetupInvocation: Boolean(command && isSetupInvocation(command)),
    argv,
  };
}

export function observeCodexToolCallStream(
  streamLine: string,
  mode: 'codex-block' | 'stream-json',
): CodexToolCallObservation | null {
  const trimmed = streamLine.trim();
  if (!trimmed) return null;
  const parsed = parseObject(trimmed);
  if (parsed) return toolCallFromObject(parsed);
  if (mode === 'codex-block' && isSetupInvocation(trimmed)) {
    return {
      name: 'shell',
      command: trimmed,
      arguments: { command: trimmed },
      isSetupInvocation: true,
      argv: shellArgv(trimmed),
    };
  }
  return null;
}

function looksLikeStreamEvent(object: JsonObject): boolean {
  const type = typeof object.type === 'string' ? object.type : '';
  return Boolean(type && (
    type.includes('.')
    || ['assistant', 'result', 'tool_call', 'function_call'].includes(type)
  ));
}

export function detectOutputFormat(output: string): CodexOutputFormat {
  const lines = output.split(/\r?\n/);
  if (lines.some((line) => {
    const parsed = parseObject(line.trim());
    return parsed ? looksLikeStreamEvent(parsed) : false;
  })) return 'stream-json';
  if (lines.some((line) => CODEX_DELIMITER_RE.test(line.trim()))) return 'codex-block';
  return 'plain-text';
}

function collectText(target: string[], content: unknown): void {
  if (typeof content === 'string') {
    target.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block === 'string') target.push(block);
    else {
      const object = asObject(block);
      if (object && typeof object.text === 'string') target.push(object.text);
    }
  }
}

function extractStreamAssistant(lines: string[]): string {
  const completed: string[] = [];
  const fallback: string[] = [];
  for (const line of lines) {
    const event = parseObject(line.trim());
    if (!event) continue;
    const item = asObject(event.item);
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      collectText(completed, item.text ?? item.content);
    } else if (event.type === 'assistant') {
      const message = asObject(event.message);
      collectText(fallback, message?.content ?? event.content);
    } else if (event.type === 'result' && typeof event.result === 'string') {
      fallback.push(event.result);
    } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      fallback.push(event.text);
    }
  }
  return (completed.length ? completed : fallback).join('\n');
}

function extractCodexBlocks(lines: string[]): string {
  const parts: string[] = [];
  let inCodex = false;
  for (const line of lines) {
    if (CODEX_DELIMITER_RE.test(line.trim())) {
      inCodex = /^codex\s*$/i.test(line.trim());
    } else if (inCodex) {
      parts.push(line);
    }
  }
  return parts.join('\n').trim();
}

export function extractAssistantContent(output: string): string {
  const lines = output.split(/\r?\n/);
  switch (detectOutputFormat(output)) {
    case 'stream-json': return extractStreamAssistant(lines);
    case 'codex-block': return extractCodexBlocks(lines);
    default: {
      const nonEmpty = lines.filter((line) => line.trim());
      if (nonEmpty.length && nonEmpty.every((line) => parseObject(line.trim()) !== null)) {
        return extractStreamAssistant(lines);
      }
      return output;
    }
  }
}

export function collectCodexToolCalls(output: string): CodexToolCallObservation[] {
  const mode = detectOutputFormat(output);
  if (mode === 'plain-text') return [];
  const observations = output.split(/\r?\n/)
    .map((line) => observeCodexToolCallStream(line, mode))
    .filter((observation): observation is CodexToolCallObservation => observation !== null);
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = JSON.stringify([observation.name, observation.command, observation.arguments]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractCodexUsage(output: string): ParsedCodexUsage {
  const totals: ParsedCodexUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  for (const line of output.split(/\r?\n/)) {
    const event = parseObject(line.trim());
    if (!event) continue;
    const usage = asObject(event.usage)
      || asObject(asObject(event.response)?.usage)
      || asObject(asObject(event.result)?.usage);
    if (!usage) continue;
    totals.input_tokens += Number(usage.input_tokens || 0);
    totals.output_tokens += Number(usage.output_tokens || 0);
    totals.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens || 0);
    totals.cache_read_input_tokens += Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0);
  }
  return totals;
}
