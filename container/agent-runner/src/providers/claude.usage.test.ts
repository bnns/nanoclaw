import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { finalUsageFromTranscripts } from './claude.js';

const SID = '11111111-2222-3333-4444-555555555555';
let tmp: string;
let prevConfigDir: string | undefined;

function entry(id: string, output: number, cache5m = 0) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: 2,
        output_tokens: output,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: cache5m,
        cache_creation: { ephemeral_5m_input_tokens: cache5m, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  fs.mkdirSync(path.join(tmp, 'projects', '-workspace-agent', SID, 'subagents'), { recursive: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('finalUsageFromTranscripts', () => {
  it('returns final counts from main and subagent transcripts, last entry wins', () => {
    const dir = path.join(tmp, 'projects', '-workspace-agent');
    fs.writeFileSync(
      path.join(dir, `${SID}.jsonl`),
      ['{"partial', JSON.stringify({ type: 'user' }), entry('msg_a', 1), entry('msg_a', 87, 43885), entry('msg_other', 5)].join('\n'),
    );
    fs.writeFileSync(path.join(dir, SID, 'subagents', 'agent-1.jsonl'), entry('msg_sub', 300) + '\n');

    const found = finalUsageFromTranscripts(SID, new Set(['msg_a', 'msg_sub', 'msg_missing']));
    expect(found.get('msg_a')).toEqual({ input: 2, output: 87, cacheRead: 10, cacheWrite5m: 43885, cacheWrite1h: 0 });
    expect(found.get('msg_sub')?.output).toBe(300);
    expect(found.has('msg_other')).toBe(false);
    expect(found.has('msg_missing')).toBe(false);
  });

  it('returns nothing for an unknown session', () => {
    expect(finalUsageFromTranscripts('no-such-session', new Set(['x'])).size).toBe(0);
  });
});
