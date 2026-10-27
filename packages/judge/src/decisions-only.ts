import {
  applyDecisions,
  type DecisionsFile,
  type Finding,
  type FindingsFile,
  type Judge,
  type JudgeOutcome,
  type RunContext,
  type RunEventBody,
} from '@jayslifecode/lookover-core';

export interface DecisionsOnlyOptions {
  ctx: RunContext;
  decisions: DecisionsFile;
  /** The time each decision is applied at. Default now, as an ISO string. */
  now?: () => string;
}

/** What a `--no-judge` run logs when the judge is attached. */
const JUDGE_OFF_MESSAGE = 'The judge was turned off with --no-judge';

/**
 * The judge of a `--no-judge` run: it reproduces and asks nothing, and only applies the user's decisions,
 * so a finding marked intended does not come back as a candidate. Each inspected screen's candidates are
 * split by the decisions as the pipeline splits them (`applyDecisions`): an intended one is logged as
 * `finding.judged` at once, the first time its id is seen. `drain` moves the intended candidates from
 * `findings` into `intended` (after the ones the file already has, in the order of `findings`, once per
 * id) and leaves everything else as the inspection found it, unjudged: `judge` and `environment` are
 * `null`. Worth-a-look entries are left where they are, as the pipeline leaves them. `attach` never uses
 * the session; it logs, once, that the judge was turned off (`judge.unavailable`, reason `disabled`), as
 * the pipeline logs that it has no key, so the report can say the candidates will not be reproduced.
 */
export function createDecisionsOnlyJudge(options: DecisionsOnlyOptions): Judge {
  const { ctx, decisions } = options;
  const now = options.now ?? (() => new Date().toISOString());
  /** The intended findings, by id, as first logged. */
  let intended: ReadonlyMap<string, Finding> = new Map();
  let lastWrite: Promise<void> = Promise.resolve();
  let writeFailure: { error: unknown } | null = null;
  let isAttached = false;

  /** Queues a log write the caller cannot wait for; `drain` waits for it and throws if it failed. */
  const logSoon = (body: RunEventBody): void => {
    lastWrite = ctx.log.append(body).then(
      () => undefined,
      (error: unknown) => {
        writeFailure ??= { error };
      },
    );
  };

  return {
    attach: () => {
      if (isAttached) return;
      isAttached = true;
      logSoon({ type: 'judge.unavailable', reason: 'disabled', message: JUDGE_OFF_MESSAGE });
    },
    onScreenInspected: (_screen, findings, _worthALook) => {
      const fresh = findings.filter((finding) => !intended.has(finding.id));
      const decided = applyDecisions(fresh, decisions, now()).intended;
      intended = new Map([...intended, ...decided.map((finding) => [finding.id, finding] as const)]);
      for (const finding of decided) logSoon({ type: 'finding.judged', finding });
    },
    drain: async (file: FindingsFile): Promise<JudgeOutcome> => {
      await lastWrite;
      if (writeFailure !== null) throw writeFailure.error;
      return { file: withIntendedMoved(file, intended) };
    },
  };
}

/** `file` with its candidates whose id is in `intended` moved to `intended`, with the user's judgement. */
function withIntendedMoved(file: FindingsFile, intended: ReadonlyMap<string, Finding>): FindingsFile {
  const decided = file.findings.flatMap((candidate, index, all): Finding[] => {
    const decision = intended.get(candidate.id);
    const isFirst = all.findIndex(({ id }) => id === candidate.id) === index;
    if (decision === undefined || !isFirst) return [];
    return [{ ...candidate, status: 'intended', judgement: decision.judgement }];
  });
  return {
    ...file,
    findings: file.findings.filter((finding) => !intended.has(finding.id)),
    intended: [...file.intended, ...decided],
    judge: null,
    environment: null,
  };
}
