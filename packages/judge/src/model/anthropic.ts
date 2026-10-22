import Anthropic, { AnthropicError, APIError, type AutoParseableOutputFormat } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { TokenUsage } from '@jayslifecode/lookover-core';
import type { JudgeBundle } from './bundle.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { readVerdict, type Verdict, verdictSchema } from './schema.js';

/** A verdict is four short fields; this is room for them and nothing else. */
export const JUDGE_MAX_TOKENS = 1024;
export const JUDGE_EFFORT = 'low';
/**
 * How the default client is built: two retries (the SDK retries 408, 409, 429, 5xx and connection
 * errors), a 60 s timeout per attempt, and the SDK's own logging off, so no request (which carries page
 * text) is ever logged, whatever `ANTHROPIC_LOG` says.
 */
export const JUDGE_CLIENT_OPTIONS = { maxRetries: 2, timeout: 60_000, logLevel: 'off' } as const;

const VERDICT_FORMAT = zodOutputFormat(verdictSchema);
const STOP_REFUSAL = 'refusal';
const NOT_A_VERDICT = 'The judge model answered with something that is not a verdict';

/** The model side of the judge: one verdict for one bundle, and what it cost in tokens. */
export interface JudgeModel {
  readonly model: string;
  judge(bundle: JudgeBundle): Promise<{ verdict: Verdict; usage: TokenUsage }>;
}

export type JudgeModelErrorCode = 'api-error' | 'refusal' | 'invalid-output';

/**
 * The judge model gave no usable verdict: the API failed (after the SDK's retries), the model refused,
 * or its answer was not a verdict. Not a `LookoverError`: the pipeline keeps the finding the harness
 * decided and notes the failure, so the run goes on. The message never quotes the model's answer.
 */
export class JudgeModelError extends Error {
  override readonly name = 'JudgeModelError';
  readonly code: JudgeModelErrorCode;
  /** The HTTP status, for an API error that had one. */
  readonly status?: number;

  constructor(
    code: JudgeModelErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** The one request shape the judge sends. */
export interface JudgeRequest extends Anthropic.MessageCreateParamsNonStreaming {
  output_config: { format: AutoParseableOutputFormat<Verdict>; effort: typeof JUDGE_EFFORT };
}

/** What the judge reads of a response; the cache counts may be missing or `null`. */
export interface JudgeResponse {
  readonly parsed_output: Verdict | null;
  readonly stop_reason: string | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  };
}

/** The part of the SDK client the judge uses; an `Anthropic` client is one, and so is a test's stub. */
export interface JudgeClient {
  readonly messages: { parse(request: JudgeRequest): PromiseLike<JudgeResponse> };
}

export interface AnthropicJudgeOptions {
  apiKey: string;
  model: string;
  /** Defaults to an `Anthropic` client built from `apiKey` with `JUDGE_CLIENT_OPTIONS`. */
  client?: JudgeClient;
}

/**
 * A judge that asks `model` through `client.messages.parse`: the system prompt as one cached block, the
 * bundle's crops and text as the user turn, the verdict schema as the output format at low effort.
 */
export function createAnthropicJudge(options: AnthropicJudgeOptions): JudgeModel {
  const { model } = options;
  const client = options.client ?? defaultClient(options.apiKey);
  return { model, judge: (bundle) => judgeWith(client, model, bundle) };
}

function defaultClient(apiKey: string): JudgeClient {
  // An empty key would let the SDK fall back to other credentials on the machine; the caller decides.
  if (apiKey.trim() === '') throw new Error('createAnthropicJudge needs an API key');
  return new Anthropic({ apiKey, ...JUDGE_CLIENT_OPTIONS });
}

async function judgeWith(
  client: JudgeClient,
  model: string,
  bundle: JudgeBundle,
): Promise<{ verdict: Verdict; usage: TokenUsage }> {
  const response = await send(client, requestFor(model, bundle));
  return { verdict: verdictOf(response), usage: usageOf(response.usage) };
}

function requestFor(model: string, { images, text }: JudgeBundle): JudgeRequest {
  return {
    model,
    max_tokens: JUDGE_MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          ...images.map(({ mediaType, data }) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: mediaType, data },
          })),
          { type: 'text', text },
        ],
      },
    ],
    output_config: { format: VERDICT_FORMAT, effort: JUDGE_EFFORT },
  };
}

async function send(client: JudgeClient, request: JudgeRequest): Promise<JudgeResponse> {
  try {
    return await client.messages.parse(request);
  } catch (error) {
    throw asJudgeModelError(error);
  }
}

/** SDK errors become `JudgeModelError`s; anything else is a bug and stays as it is. */
function asJudgeModelError(error: unknown): unknown {
  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? { status: error.status } : {};
    return new JudgeModelError('api-error', `The judge model call failed: ${firstLine(error.message)}`, {
      ...status,
      cause: error,
    });
  }
  if (error instanceof AnthropicError) {
    // The SDK's parse error quotes the answer, which can quote the page: the message stays generic.
    return new JudgeModelError('invalid-output', NOT_A_VERDICT, { cause: error });
  }
  return error;
}

function verdictOf({ parsed_output, stop_reason }: JudgeResponse): Verdict {
  if (parsed_output === null) {
    const reason = stop_reason ?? 'unknown';
    const code = reason === STOP_REFUSAL ? 'refusal' : 'invalid-output';
    throw new JudgeModelError(code, `The judge model stopped without a verdict (stop reason: ${reason})`);
  }
  const reading = readVerdict(parsed_output);
  if (!reading.ok) {
    throw new JudgeModelError(
      'invalid-output',
      `The judge model's verdict cannot be used: ${reading.problem}`,
    );
  }
  return reading.verdict;
}

function usageOf(usage: JudgeResponse['usage']): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim();
}
