/**
 * Builds the selector a later replay uses to find `el` again: the first candidate that matches
 * exactly one element in the document, and that element is `el`:
 *
 * 1. `[data-testid="…"]`
 * 2. `#id`, unless the id is generated per render (React `useId`, Radix, Headless UI, MUI,
 *    React Aria) or digits only
 * 3. `tag[name="…"]`
 * 4. `tag[aria-label="…"]`
 * 5. `a[href="…"]` (the attribute as written, not the resolved URL)
 * 6. a `tag:nth-of-type(n)` path down from the nearest ancestor with a unique test id or stable
 *    id, else from `body`
 *
 * It runs in the page (CDP `Runtime.callFunctionOn`, Playwright `page.evaluate`) from its source
 * text, so it must stay self-contained: no imports, no references to module scope.
 *
 * Elements inside a shadow tree cannot be reached by a document-level selector; for those the
 * path stops at the shadow root and does not resolve, which callers check for.
 */
function buildSelector(el: Element): string {
  const GENERATED_ID = /^(:r|radix-|headlessui-|mui-|react-aria)/;
  const DIGITS_ONLY = /^\d+$/;

  /** A CSS string literal. `CSS.escape` is for identifiers and would turn `/orgs` into `\/orgs`. */
  const quote = (value: string): string => {
    const escaped = value
      .replace(/["\\]/g, '\\$&')
      .replace(/[\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
    return `"${escaped}"`;
  };
  const isUniqueFor = (target: Element, selector: string): boolean => {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === target;
  };
  const tagOf = (node: Element): string => CSS.escape(node.localName);
  const attributeSelector = (node: Element, name: string, prefix: string): string | null => {
    const value = node.getAttribute(name);
    return value === null ? null : `${prefix}[${name}=${quote(value)}]`;
  };
  const testIdSelector = (node: Element): string | null => attributeSelector(node, 'data-testid', '');
  const idSelector = (node: Element): string | null => {
    const { id } = node;
    const isStable = id !== '' && !GENERATED_ID.test(id) && !DIGITS_ONLY.test(id);
    return isStable ? `#${CSS.escape(id)}` : null;
  };
  const firstUniqueFor = (node: Element, candidates: readonly (string | null)[]): string | null =>
    candidates.find((candidate): candidate is string => candidate !== null && isUniqueFor(node, candidate)) ??
    null;
  const anchorFor = (node: Element): string | null =>
    node === document.body ? 'body' : firstUniqueFor(node, [testIdSelector(node), idSelector(node)]);
  const stepTo = (node: Element): string => {
    const siblings = node.parentElement === null ? [node] : Array.from(node.parentElement.children);
    const sameType = siblings.filter((sibling) => sibling.localName === node.localName);
    return `${tagOf(node)}:nth-of-type(${sameType.indexOf(node) + 1})`;
  };
  const pathTo = (node: Element): string => {
    const parent = node.parentElement;
    if (parent === null) {
      return stepTo(node);
    }
    return `${anchorFor(parent) ?? pathTo(parent)} > ${stepTo(node)}`;
  };

  const direct = firstUniqueFor(el, [
    testIdSelector(el),
    idSelector(el),
    attributeSelector(el, 'name', tagOf(el)),
    attributeSelector(el, 'aria-label', tagOf(el)),
    el.localName === 'a' ? attributeSelector(el, 'href', 'a') : null,
  ]);
  return direct ?? pathTo(el);
}

/**
 * The source of an in-page `(el: Element) => string` that returns a unique selector for `el` (see
 * `buildSelector`). Call it as `(${BUILD_SELECTOR_SOURCE})(el)` in `page.evaluate`, or wrap it as
 * `function () { return (${BUILD_SELECTOR_SOURCE})(this); }` for `Runtime.callFunctionOn`.
 */
export const BUILD_SELECTOR_SOURCE: string = buildSelector.toString();
