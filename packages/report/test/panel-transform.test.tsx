import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FIXED_PANEL_QUERY } from '../src/findings/finding-panel';
import { usePanelTransform } from '../src/findings/use-panel-transform';
import { REDUCED_MOTION, stubMatchMedia } from './media';
import {
  type StubbedAnimation,
  stubAnimations,
  stubLayout,
  stubServer,
  unstubAnimations,
} from './panel-helpers';
import {
  DASHBOARD,
  loadScreenshot,
  ORGANISATIONS,
  placementsOn,
  show,
  stepFindingsOn,
  stubImageSizes,
} from './screens-helpers';

/*
 * The pin → panel container transform as the Screens view drives it: first the hook on a bare stage (pins,
 * a panel and the ghost it renders), then the Screens view itself. Animations are stood in for by
 * `stubAnimations`; the panel is the fixed box it is from `xl` unless a test says otherwise.
 */

let animations: StubbedAnimation[];

beforeEach(() => {
  animations = stubAnimations();
  stubLayout();
  stubServer();
  stubMatchMedia({ [FIXED_PANEL_QUERY]: true });
});

afterEach(() => {
  cleanup();
  unstubAnimations();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PINS = ['a', 'b', 'c'];

/** The hook on a stage of three pins and a panel showing the finding it is told to (or `summary`). */
function Stage({ findingId }: { readonly findingId: string | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const { shownId, ghost, contentRef, ghostRef } = usePanelTransform(findingId, stage);
  return (
    <div ref={stage}>
      {PINS.map((id) => (
        <button key={id} type="button" data-pin-findings={id}>
          {id}
        </button>
      ))}
      <aside data-finding-panel="" aria-label="Panel">
        <div ref={contentRef}>{shownId ?? 'summary'}</div>
      </aside>
      {ghost === null ? null : (
        <div key={ghost.findingId} ref={ghostRef} data-ghost={ghost.findingId}>
          <div>{ghost.findingId}</div>
        </div>
      )}
    </div>
  );
}

const shown = () => screen.getByRole('complementary', { name: 'Panel' }).textContent;
const ghostElement = () => document.querySelector<HTMLElement>('[data-ghost]');
/** The ghost's grow (its first animation), or its fade out (its second). */
const ghostAnimation = (element: Element | null, index = 0) =>
  animations.filter((animation) => animation.element === element)[index];

async function land(element: Element | null): Promise<void> {
  await act(async () => ghostAnimation(element)?.finish());
  await act(async () => ghostAnimation(element, 1)?.finish());
}

test('from the summary, a pinned finding grows out of its pin; the summary stays until the copy lands', async () => {
  const { rerender } = render(<Stage findingId={null} />);
  expect(shown()).toBe('summary');

  rerender(<Stage findingId="b" />);

  const ghost = ghostElement();
  expect(ghost?.dataset.ghost).toBe('b');
  expect(shown()).toBe('summary');
  expect(ghostAnimation(ghost)?.keyframes[0]?.clipPath).toBe('inset(0 round 999px)');
  await land(ghost);
  expect(shown()).toBe('b');
  expect(ghostElement()).toBeNull();
});

test('a second choice while a copy is on its way lands that one at once and grows the next from its own pin', async () => {
  const { rerender } = render(<Stage findingId="a" />);
  rerender(<Stage findingId="b" />);
  const first = ghostElement();
  expect(first?.dataset.ghost).toBe('b');

  rerender(<Stage findingId="c" />);

  expect(ghostAnimation(first)?.cancel).toHaveBeenCalled();
  expect(shown()).toBe('b');
  const second = ghostElement();
  expect(second?.dataset.ghost).toBe('c');
  expect(ghostAnimation(second)?.cancel).not.toHaveBeenCalled();
  await land(second);
  expect(shown()).toBe('c');
  expect(ghostElement()).toBeNull();
});

test('shown at once: no finding, a finding without a pin, the same finding, on a phone, under reduced motion', () => {
  const media = stubMatchMedia({ [FIXED_PANEL_QUERY]: true });
  const { rerender } = render(<Stage findingId="a" />);
  const grows = () => animations.length;

  rerender(<Stage findingId={null} />);
  expect([shown(), grows()]).toEqual(['summary', 0]);
  rerender(<Stage findingId="unpinned" />);
  expect([shown(), grows()]).toEqual(['unpinned', 0]);
  rerender(<Stage findingId="unpinned" />);
  expect(grows()).toBe(0);

  // On a phone the panel is inline and sized by its content: nothing grows into it.
  media.set(FIXED_PANEL_QUERY, false);
  rerender(<Stage findingId="a" />);
  expect([shown(), grows()]).toEqual(['a', 0]);

  media.set(FIXED_PANEL_QUERY, true);
  media.set(REDUCED_MOTION, true);
  rerender(<Stage findingId="b" />);
  expect([shown(), grows(), ghostElement()]).toEqual(['b', 0, null]);
});

test("in the Screens view the panel shows the route's finding, and the run's summary with none chosen", () => {
  const [step] = stepFindingsOn(DASHBOARD);
  if (step === undefined) throw new Error('The dashboard has no step finding');
  stubImageSizes();
  const { rerender } = render(show(DASHBOARD));
  expect(screen.getByRole('complementary', { name: 'Run summary' })).toBeDefined();

  rerender(show(DASHBOARD, step.id));

  expect(screen.getByRole('complementary', { name: step.title })).toBeDefined();
});

function organisationsPins() {
  const [first, second] = placementsOn(ORGANISATIONS).map(({ members }) => members[0]?.finding);
  if (first === undefined || second === undefined)
    throw new Error('The organisations screen has too few pins');
  return [first, second] as const;
}

test('in the Screens view another pinned finding grows the panel out of its pin; the old one stays until the copy lands', async () => {
  stubImageSizes();
  const [first, second] = organisationsPins();
  const { rerender } = render(show(ORGANISATIONS, first.id));
  loadScreenshot();
  const panel = () => screen.getByRole('complementary');

  rerender(show(ORGANISATIONS, second.id));

  // The copy holds the new finding and is hidden from assistive technology; the panel keeps the old one.
  const ghost = document.querySelector('[inert]');
  expect(ghost?.getAttribute('aria-hidden')).toBe('true');
  expect(ghost?.textContent).toContain(second.id);
  expect(ghost?.hasAttribute('data-glass')).toBe(false);
  expect(panel().textContent).toContain(first.id);
  expect(ghostAnimation(ghost)?.keyframes[0]?.clipPath).toBe('inset(0 round 999px)');

  await land(ghost);
  expect(panel().textContent).toContain(second.id);
  expect(document.querySelector('[inert]')).toBeNull();
});

test('in the Screens view a pin chosen from the summary grows the panel too; the summary fades as it comes', async () => {
  stubImageSizes();
  const [first] = organisationsPins();
  const { rerender } = render(show(ORGANISATIONS));
  loadScreenshot();
  const summary = screen.getByRole('complementary', { name: 'Run summary' });

  rerender(show(ORGANISATIONS, first.id));

  const ghost = document.querySelector('[inert]');
  expect(ghost?.textContent).toContain(first.id);
  expect(screen.getByRole('complementary', { name: 'Run summary' })).toBe(summary);
  // The summary's content is what fades out.
  const content = summary.querySelector('[data-panel-body]')?.parentElement;
  const fade = animations.find((animation) => animation.element === content);
  expect(fade?.keyframes.at(-1)).toMatchObject({ opacity: 0 });

  await land(ghost);
  expect(screen.getByRole('complementary', { name: first.title })).toBeDefined();
});
