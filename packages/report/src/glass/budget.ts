/*
 * Spec §11: never more than three glass layers on screen (the top bar, the finding panel, the toast);
 * stacked `backdrop-filter`s are what makes glass interfaces stutter. In development a watcher counts the
 * mounted `Glass` surfaces (each sets `data-glass` on its root) and throws as soon as there are more.
 */

export const MAX_GLASS_LAYERS = 3;
const GLASS_SELECTOR = '[data-glass]';

export class GlassBudgetError extends Error {
  readonly count: number;

  constructor(count: number) {
    super(
      `${count} glass surfaces are mounted; the report allows at most ${MAX_GLASS_LAYERS} ` +
        '(the top bar, the finding panel and the toast). Make the new surface solid.',
    );
    this.name = 'GlassBudgetError';
    this.count = count;
  }
}

export function countGlassLayers(root: ParentNode): number {
  return root.querySelectorAll(GLASS_SELECTOR).length;
}

/**
 * In development, watches `root` and throws a `GlassBudgetError` (an uncaught error the browser shows)
 * whenever a change leaves more than `MAX_GLASS_LAYERS` surfaces mounted, once per new count. In a
 * production build it does nothing. Returns the function that stops watching.
 */
export function watchGlassBudget(root: Node & ParentNode = document.body): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  let reported = 0;
  const check = () => {
    const count = countGlassLayers(root);
    if (count <= MAX_GLASS_LAYERS) {
      reported = 0;
      return;
    }
    if (count === reported) return;
    reported = count;
    throw new GlassBudgetError(count);
  };
  const observer = new MutationObserver(check);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-glass'],
  });
  return () => observer.disconnect();
}
