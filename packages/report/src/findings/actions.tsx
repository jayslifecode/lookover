import type { Decision, Finding } from '@jayslifecode/lookover-core';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, postDecision, postReplay } from '@/data/api';
import type { ReportState } from '@/data/reduce';
import { decisionOf } from '@/data/selectors';
import { applyDecisions } from '@/data/store';
import { cn } from '@/lib/utils';
import { notify } from '@/shell/toast';
import type { DecisionRequest } from '../../node/api';
import { ON_GLASS_FOCUS, PANEL_SECTION, PRIMARY_BUTTON, SECONDARY_BUTTON } from './panel-styles';

/*
 * What the reader can do with a finding (spec §11, the motion study's `.actions`): copy its fix prompt
 * for a coding agent, replay it in a fresh browser, or mark it intended with an optional note. Marking is
 * optimistic: the finding shows as intended at once, with an Undo, and goes back if the server refuses.
 * An intended finding shows its note and the Undo instead of the actions; a rejected one says it is not
 * listed with the findings (its attribution and note are in the verdict above). A worth-a-look entry can
 * be copied and replayed but not decided: decisions apply to findings.
 */

const CONFLICT = 409;
const NOTE_MAX_LENGTH = 280;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DecisionControl {
  readonly decision: Decision | null;
  readonly isDeciding: boolean;
  decide(status: 'intended' | null, note: string): Promise<void>;
}

function requestOf(findingId: string, status: 'intended' | null, note: string): DecisionRequest {
  return status === null || note === '' ? { findingId, status } : { findingId, status, note };
}

/** The finding's decision as shown: the one being made, else the report's. */
function useDecision(report: ReportState, finding: Finding): DecisionControl {
  // `undefined`: nothing decided here yet, so the report's decisions say.
  const [made, setMade] = useState<Decision | null | undefined>(undefined);
  const [isDeciding, setDeciding] = useState(false);
  const decision = made === undefined ? decisionOf(report, finding) : made;

  const decide = async (status: 'intended' | null, rawNote: string) => {
    const before = made;
    const note = rawNote.trim();
    setMade(
      status === null ? null : { status, at: new Date().toISOString(), note: note === '' ? null : note },
    );
    setDeciding(true);
    try {
      const { decisions } = await postDecision(requestOf(finding.id, status, note));
      applyDecisions(decisions);
      setMade(Object.hasOwn(decisions, finding.id) ? (decisions[finding.id] ?? null) : null);
    } catch (error) {
      setMade(before);
      const what = status === null ? 'Could not undo the decision' : 'Could not mark the finding intended';
      notify(`${what}: ${messageOf(error)}`);
    } finally {
      setDeciding(false);
    }
  };
  return { decision, isDeciding, decide };
}

type ReplayState = { readonly isRunning: boolean; readonly message: string | null };

function useReplay(findingId: string) {
  const [state, setState] = useState<ReplayState>({ isRunning: false, message: null });
  const replay = async () => {
    setState({ isRunning: true, message: null });
    try {
      const { reproduced, of } = await postReplay({ findingId });
      setState({ isRunning: false, message: `Reproduced ${reproduced} of ${of}` });
    } catch (error) {
      const isBusy = error instanceof ApiError && error.status === CONFLICT;
      const message = isBusy ? 'A replay is already running' : `The replay failed: ${messageOf(error)}`;
      setState({ isRunning: false, message });
    }
  };
  return { ...state, replay };
}

function CopyAndReplay({ finding }: { readonly finding: Finding }) {
  const [isPromptShown, setPromptShown] = useState(false);
  const { isRunning, message, replay } = useReplay(finding.id);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(finding.fixPrompt);
      setPromptShown(false);
      notify('Fix prompt copied');
    } catch {
      // Refused (no permission, no clipboard on an insecure page): the prompt is shown to copy by hand.
      setPromptShown(true);
      notify('Could not copy; select the prompt below');
    }
  };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button className={PRIMARY_BUTTON} onClick={() => void copy()}>
          Copy fix prompt
        </Button>
        <Button
          variant="ghost"
          className={SECONDARY_BUTTON}
          disabled={isRunning}
          onClick={() => void replay()}
        >
          {isRunning ? 'Replaying…' : 'Replay'}
        </Button>
      </div>
      <p role="status" className="m-0 mt-1.5 min-h-[1lh] text-[12.5px]">
        {message}
      </p>
      {isPromptShown ? (
        // A labelled region that takes focus, so the keyboard can scroll it and select the prompt.
        <section
          aria-label="Fix prompt"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached with the keyboard
          tabIndex={0}
          className={cn(
            'mt-1.5 max-h-48 overflow-auto rounded-[8px] border border-line-strong bg-bg-2 p-2 text-ink',
            ON_GLASS_FOCUS,
          )}
        >
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px]">
            {finding.fixPrompt}
          </pre>
        </section>
      ) : null}
    </>
  );
}

function MarkIntended({
  isDeciding,
  onMark,
}: {
  readonly isDeciding: boolean;
  readonly onMark: (note: string) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState('');
  return (
    <form
      className="mt-2 flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onMark(note);
      }}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={noteId} className="mb-1 block font-medium text-[12px]">
          Note (optional)
        </label>
        <Input
          id={noteId}
          value={note}
          maxLength={NOTE_MAX_LENGTH}
          onChange={(event) => setNote(event.target.value)}
          className={cn('h-8 border-line-strong bg-bg-2 text-[12.5px] text-ink', ON_GLASS_FOCUS)}
        />
      </div>
      <Button type="submit" variant="ghost" className={SECONDARY_BUTTON} disabled={isDeciding}>
        Mark intended
      </Button>
    </form>
  );
}

function IntendedBlock({ control }: { readonly control: DecisionControl }) {
  const { decision, isDeciding, decide } = control;
  return (
    <div className={`flex items-start justify-between gap-3 ${PANEL_SECTION}`}>
      <div className="min-w-0 text-[12.5px]">
        <p className="m-0 font-semibold">Marked intended</p>
        <p className="m-0 mt-0.5">{decision?.note ?? 'No note was given.'}</p>
      </div>
      <Button
        variant="ghost"
        className={SECONDARY_BUTTON}
        disabled={isDeciding}
        onClick={() => void decide(null, '')}
      >
        Undo
      </Button>
    </div>
  );
}

interface FindingActionsProps {
  readonly report: ReportState;
  readonly finding: Finding;
  /** `false` for a worth-a-look entry: decisions apply to findings only, so it can be copied and replayed. */
  readonly canDecide: boolean;
}

export function FindingActions({ report, finding, canDecide }: FindingActionsProps) {
  if (!canDecide) {
    return (
      <div className={PANEL_SECTION}>
        <CopyAndReplay finding={finding} />
      </div>
    );
  }
  return <DecidableActions report={report} finding={finding} />;
}

function DecidableActions({ report, finding }: { readonly report: ReportState; readonly finding: Finding }) {
  const control = useDecision(report, finding);
  if (control.decision !== null) return <IntendedBlock control={control} />;
  if (finding.status === 'rejected') {
    return (
      <p className={`m-0 font-semibold text-[12.5px] ${PANEL_SECTION}`}>
        Rejected: not listed with the findings
      </p>
    );
  }
  return (
    <div className={PANEL_SECTION}>
      <CopyAndReplay finding={finding} />
      <MarkIntended
        isDeciding={control.isDeciding}
        onMark={(note) => void control.decide('intended', note)}
      />
    </div>
  );
}
