import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BrowserSession,
  ConsoleObserver,
  configSchema,
  createRun,
  DECISIONS_FILE,
  type LookoverConfig,
  LookoverError,
  RequestObserver,
  type RunContext,
  TextObserver,
} from '@jayslifecode/lookover-core';
import { JudgePipeline } from '@jayslifecode/lookover-judge';
import { InteractionLens } from '@jayslifecode/lookover-lenses';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type CreateJudgeOptions, createJudge, pipelineOptions } from '../src/commands/run-judge.js';
import { EXIT_INVALID, exitCodeFor } from '../src/ui.js';
import { findingsFile, screen, stepCandidate } from './run-fixtures.js';

const VERSION = '1.2.3';
const KEY = 'sk-ant-test-key';

const CONFIG: LookoverConfig = configSchema.parse({
  baseUrl: 'http://localhost:3000',
  interaction: 'full',
  acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-22T00:00:00.000Z' },
  viewports: [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ],
});

describe('createJudge', () => {
  let dir: string;
  let ctx: RunContext;
  const lenses = [new InteractionLens()];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lookover-run-judge-'));
    ctx = await createRun({ cwd: dir, config: CONFIG });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function options(overrides: Partial<CreateJudgeOptions> = {}): CreateJudgeOptions {
    return {
      ctx,
      lenses,
      config: CONFIG,
      env: { ANTHROPIC_API_KEY: KEY },
      flags: { isJudged: true, judgeModel: undefined },
      lookoverVersion: VERSION,
      ...overrides,
    };
  }

  async function decisionsAre(content: string): Promise<void> {
    await mkdir(ctx.lookoverDir, { recursive: true });
    await writeFile(join(ctx.lookoverDir, DECISIONS_FILE), content, 'utf8');
  }

  describe('with --no-judge', () => {
    const noJudge = { flags: { isJudged: false, judgeModel: undefined } };
    /** Fails the test the moment anything on it is used: a --no-judge run reproduces nothing. */
    const untouchableSession = new Proxy({} as BrowserSession, {
      get: (_target, property) => {
        throw new Error(`The --no-judge judge used the session (${String(property)})`);
      },
    });

    test('is a judge that only applies the decisions, with or without a key', async () => {
      for (const env of [{ ANTHROPIC_API_KEY: KEY }, {}]) {
        const judge = await createJudge(options({ ...noJudge, env }));

        expect(judge).toBeDefined();
        expect(judge).not.toBeInstanceOf(JudgePipeline);
      }
    });

    test('leaves out the findings marked intended and never reproduces the others', async () => {
      const decided = stepCandidate({ ruleId: 'interaction.focus-visible-missing', selector: '#decided' });
      const other = stepCandidate({ ruleId: 'interaction.target-size' });
      const decision = { status: 'intended', at: '2026-10-22T00:00:00.000Z', note: 'on purpose' };
      await decisionsAre(JSON.stringify({ version: 1, decisions: { [decided.id]: decision } }));
      const judge = await createJudge(options(noJudge));

      judge?.attach(untouchableSession);
      judge?.onScreenInspected(screen(), [decided, other], []);
      const outcome = await judge?.drain(findingsFile([decided, other]));

      expect(outcome?.file.findings).toEqual([other]);
      expect(outcome?.file.intended).toMatchObject([
        { id: decided.id, status: 'intended', judgement: { decidedBy: 'user', note: 'on purpose' } },
      ]);
      expect(outcome?.file.judge).toBeNull();
    });

    test('fails with E_RUN_FAILED when the decisions cannot be read', async () => {
      await decisionsAre('{ not json');

      await expect(createJudge(options(noJudge))).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
    });
  });

  describe('with the judge on', () => {
    test('is a judge pipeline', async () => {
      expect(await createJudge(options())).toBeInstanceOf(JudgePipeline);
      expect(await createJudge(options({ env: {} }))).toBeInstanceOf(JudgePipeline);
    });

    test('asks the configured judge model when ANTHROPIC_API_KEY is set', async () => {
      const pipeline = await pipelineOptions(options());

      expect(pipeline?.model?.model).toBe('claude-sonnet-5-5');
      expect(pipeline?.unavailable).toBeNull();
    });

    test('asks the model of model.judge in the config', async () => {
      const config = { ...CONFIG, model: { ...CONFIG.model, judge: 'claude-opus-5-5' } };

      const pipeline = await pipelineOptions(options({ config }));

      expect(pipeline?.model?.model).toBe('claude-opus-5-5');
    });

    test('--judge-model overrides model.judge', async () => {
      const flags = { isJudged: true, judgeModel: 'claude-haiku-5-5' };

      const pipeline = await pipelineOptions(options({ flags }));

      expect(pipeline?.model?.model).toBe('claude-haiku-5-5');
    });

    test.each([
      ['is not set', {}],
      ['is empty', { ANTHROPIC_API_KEY: '' }],
      ['is only whitespace', { ANTHROPIC_API_KEY: '  \n' }],
    ])('decides by the harness alone when ANTHROPIC_API_KEY %s', async (_what, env) => {
      const pipeline = await pipelineOptions(options({ env }));

      expect(pipeline?.model).toBeNull();
      expect(pipeline?.unavailable).toBe('no-api-key');
    });

    test('--judge-model without a key still decides by the harness alone', async () => {
      const flags = { isJudged: true, judgeModel: 'claude-haiku-5-5' };

      const pipeline = await pipelineOptions(options({ env: {}, flags }));

      expect(pipeline?.model).toBeNull();
      expect(pipeline?.unavailable).toBe('no-api-key');
    });

    test("hands over the run, the lenses, the config's viewports and interaction, and Lookover's version", async () => {
      const pipeline = await pipelineOptions(options());

      expect(pipeline?.ctx).toBe(ctx);
      expect(pipeline?.lenses).toBe(lenses);
      expect(pipeline?.viewports).toEqual(CONFIG.viewports);
      expect(pipeline?.interaction).toBe('full');
      expect(pipeline?.lookoverVersion).toBe(VERSION);
    });

    test('gives each attempt fresh console, request and text observers', async () => {
      const pipeline = await pipelineOptions(options());

      const first = pipeline?.observers() ?? [];
      const second = pipeline?.observers() ?? [];

      expect(first.map((observer) => observer.constructor)).toEqual([
        ConsoleObserver,
        RequestObserver,
        TextObserver,
      ]);
      expect(second).toHaveLength(first.length);
      second.forEach((observer, index) => {
        expect(observer).not.toBe(first[index]);
      });
    });

    test('has no decisions when the project has none yet', async () => {
      const pipeline = await pipelineOptions(options());

      expect(pipeline?.decisions).toEqual({ version: 1, decisions: {} });
    });

    test("reads the project's decisions", async () => {
      const decisions = {
        version: 1,
        decisions: {
          abc123def456: { status: 'intended', at: '2026-10-22T00:00:00.000Z', note: 'on purpose' },
        },
      };
      await decisionsAre(JSON.stringify(decisions));

      const pipeline = await pipelineOptions(options());

      expect(pipeline?.decisions).toEqual(decisions);
    });

    test('fails with E_RUN_FAILED when the decisions cannot be read', async () => {
      await decisionsAre('{ not json');

      await expect(createJudge(options())).rejects.toMatchObject({ code: 'E_RUN_FAILED' });
    });

    test('a config with no viewports fails as an invalid config, which exits 2', async () => {
      const config = { ...CONFIG, viewports: [] };

      const failure = await createJudge(options({ config, env: {} })).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(LookoverError);
      expect(failure).toMatchObject({
        code: 'E_CONFIG_INVALID',
        message: 'lookover.config.json lists no viewports, so there is nothing to capture screens at',
      });
      expect(exitCodeFor(failure)).toBe(EXIT_INVALID);
    });
  });
});
