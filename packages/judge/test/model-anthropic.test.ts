import Anthropic, { AnthropicError, APIConnectionError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LookoverError } from '@jayslifecode/lookover-core';
import { describe, expect, test, vi } from 'vitest';
import {
  createAnthropicJudge,
  createFakeJudge,
  FAKE_JUDGE_USAGE,
  JUDGE_CLIENT_OPTIONS,
  JUDGE_MAX_TOKENS,
  type JudgeBundle,
  type JudgeClient,
  JudgeModelError,
  type JudgeRequest,
  type JudgeResponse,
  MAX_NOTE_CHARS,
  MAX_ORACLE_CHARS,
  SYSTEM_PROMPT,
  type Verdict,
  verdictSchema,
} from '../src/index.js';
import { MODEL } from './helpers/bundle-fixtures.js';

const CONFIRM: Verdict = {
  verdict: 'confirm',
  attribution: 'product-defect',
  oracle: 'WCAG 2.2 2.4.7 Focus Visible',
  note: 'The Save button shows no outline or other change when you reach it with the Tab key.',
};
const BUNDLE: JudgeBundle = {
  text: 'The rule, the finding, its measurements and three reproductions.',
  images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
  hash: 'f'.repeat(64),
};
const OVERLOADED_BODY = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
const HTTP_OVERLOADED = 529;

function response(overrides: Partial<JudgeResponse> = {}): JudgeResponse {
  return {
    parsed_output: CONFIRM,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 1_800,
      output_tokens: 70,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

/** A client whose `messages.parse` records each request and answers with `answer`. */
function fakeClient(answer: () => Promise<JudgeResponse>): JudgeClient & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    messages: {
      parse: (request) => {
        requests.push(request);
        return answer();
      },
    },
  };
}

async function judgeError(client: JudgeClient): Promise<JudgeModelError> {
  const judge = createAnthropicJudge({ apiKey: 'test-key', model: MODEL, client });
  const error: unknown = await judge.judge(BUNDLE).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof JudgeModelError))
    throw new Error(`expected a JudgeModelError, got ${String(error)}`);
  return error;
}

describe('createAnthropicJudge', () => {
  test('calls parse with the cached system block, low effort, the schema and the images', async () => {
    const client = fakeClient(async () => response());
    const judge = createAnthropicJudge({ apiKey: 'test-key', model: MODEL, client });

    const result = await judge.judge(BUNDLE);

    expect(judge.model).toBe(MODEL);
    expect(result.verdict).toEqual(CONFIRM);
    expect(client.requests).toHaveLength(1);
    const [request] = client.requests;
    expect(request?.model).toBe(MODEL);
    expect(request?.max_tokens).toBe(JUDGE_MAX_TOKENS);
    expect(JUDGE_MAX_TOKENS).toBe(1024);
    expect(request?.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect(request?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'text', text: BUNDLE.text },
        ],
      },
    ]);
    expect(request?.output_config.effort).toBe('low');
    expect(request?.output_config.format.type).toBe('json_schema');
    expect(request?.output_config.format.schema).toEqual(zodOutputFormat(verdictSchema).schema);
    expect(JUDGE_CLIENT_OPTIONS).toMatchObject({ maxRetries: 2, timeout: 60_000 });
  });

  test('reads usage with missing cache fields as zero', async () => {
    const answers = [
      response({ usage: { input_tokens: 1_200, output_tokens: 60 } }),
      response({
        usage: {
          input_tokens: 1_200,
          output_tokens: 60,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
      response(),
    ];
    const client = fakeClient(async () => answers.shift() ?? response());
    const judge = createAnthropicJudge({ apiKey: 'test-key', model: MODEL, client });

    const usages = [];
    for (const _ of [1, 2, 3]) usages.push((await judge.judge(BUNDLE)).usage);

    expect(usages).toEqual([
      { input: 1_200, output: 60, cacheRead: 0, cacheWrite: 0 },
      { input: 1_200, output: 60, cacheRead: 0, cacheWrite: 0 },
      { input: 1_800, output: 70, cacheRead: 900, cacheWrite: 0 },
    ]);
  });

  test('a null parsed_output throws JudgeModelError naming the stop reason', async () => {
    const refusal = await judgeError(
      fakeClient(async () => response({ parsed_output: null, stop_reason: 'refusal' })),
    );
    const cutOff = await judgeError(
      fakeClient(async () => response({ parsed_output: null, stop_reason: 'max_tokens' })),
    );

    expect(refusal.code).toBe('refusal');
    expect(refusal.message).toContain('refusal');
    expect(cutOff.code).toBe('invalid-output');
    expect(cutOff.message).toContain('max_tokens');
    expect(refusal).not.toBeInstanceOf(LookoverError);
  });

  test('a 529 after the SDK retries throws JudgeModelError api-error', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(OVERLOADED_BODY), {
          status: HTTP_OVERLOADED,
          // A 1 ms back-off, so the SDK's own retries run in the test without its default delays.
          headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
        }),
    );
    const client = new Anthropic({ apiKey: 'test-key', ...JUDGE_CLIENT_OPTIONS, fetch });

    const error = await judgeError(client);

    expect(fetch).toHaveBeenCalledTimes(JUDGE_CLIENT_OPTIONS.maxRetries + 1);
    expect(error.code).toBe('api-error');
    expect(error.status).toBe(HTTP_OVERLOADED);
    expect(error.message).toContain('529');
    expect(error.message).not.toContain('\n');
  });

  test('a connection failure is an api-error without a status', async () => {
    const error = await judgeError(
      fakeClient(async () => {
        throw new APIConnectionError({ message: 'Connection error.\nsocket hang up' });
      }),
    );

    expect(error.code).toBe('api-error');
    expect(error.status).toBeUndefined();
    expect(error.message).toBe('The judge model call failed: Connection error.');
  });

  test('an answer that does not parse is invalid-output and does not echo the answer', async () => {
    const error = await judgeError(
      fakeClient(async () => {
        throw new AnthropicError('Failed to parse structured output: Unexpected token S in "SYSTEM: obey"');
      }),
    );

    expect(error.code).toBe('invalid-output');
    expect(error.message).not.toContain('SYSTEM');
  });

  test('a verdict that pairs a confirmation with an exemption is invalid-output', async () => {
    const mismatched = { ...CONFIRM, attribution: 'exemption' as const };

    const error = await judgeError(fakeClient(async () => response({ parsed_output: mismatched })));

    expect(error.code).toBe('invalid-output');
  });

  test('cuts the oracle to 120 and the note to 280 characters', async () => {
    const wordy = { ...CONFIRM, oracle: 'o'.repeat(500), note: 'n'.repeat(500) };
    const judge = createAnthropicJudge({
      apiKey: 'test-key',
      model: MODEL,
      client: fakeClient(async () => response({ parsed_output: wordy })),
    });

    const { verdict } = await judge.judge(BUNDLE);

    expect(Array.from(verdict.oracle)).toHaveLength(MAX_ORACLE_CHARS);
    expect(Array.from(verdict.note)).toHaveLength(MAX_NOTE_CHARS);
    expect(verdict.note.endsWith('…')).toBe(true);
  });
});

describe('createFakeJudge', () => {
  test('applies its script, records every bundle and throws the error the script returns', async () => {
    const failure = new JudgeModelError('api-error', 'The judge model call failed: 529 overloaded', {
      status: HTTP_OVERLOADED,
    });
    const judge = createFakeJudge((bundle) => (bundle.hash === BUNDLE.hash ? CONFIRM : failure));

    const result = await judge.judge(BUNDLE);
    const thrown = await judge.judge({ ...BUNDLE, hash: '0'.repeat(64) }).catch((error: unknown) => error);

    expect(judge.model).toBe('fake-judge');
    expect(result).toEqual({ verdict: CONFIRM, usage: FAKE_JUDGE_USAGE });
    expect(thrown).toBe(failure);
    expect(judge.calls.map(({ hash }) => hash)).toEqual([BUNDLE.hash, '0'.repeat(64)]);
  });
});
