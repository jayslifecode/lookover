import { redact } from '../util/redact.js';

/**
 * What the page reports for an element: `selector`, the one `buildSelector` prefers, and `path`,
 * the fallback. `stableSelector` chooses between them.
 */
export interface SelectorCandidate {
  selector: string;
  path: string;
}

/**
 * Builds the selectors a later replay uses to find `el` again. `selector` is the first candidate
 * that matches exactly one element in the document, and that element is `el`:
 *
 * 1. `[data-testid="…"]`
 * 2. `#id`, unless the id is generated per render or digits only. Generated: React `useId` in every
 *    format so far, client and server (`:r1:`/`:R1:` up to 19.0, `«r1»`/`«R1»` in 19.1,
 *    `_r_1_`/`_R_1_` from 19.2), Radix, Headless UI, MUI and React Aria
 * 3. `tag[name="…"]`
 * 4. `tag[aria-label="…"]`
 * 5. `a[href="…"]` (the attribute as written, not the resolved URL)
 * 6. a `tag:nth-of-type(n)` path down from the nearest ancestor with a unique test id or stable
 *    id, else from `body`
 *
 * `path` is the same kind of path, always from `body`: tag names and positions only, no id, no test
 * id, no attribute value, so it can never hold a secret. It is what a caller falls back to when
 * `selector` would not survive redaction (see `stableSelector`).
 *
 * An attribute value (test id, id, name, aria-label, href) that holds an `@` or starts with
 * `mailto:` or `tel:` is never used for `selector`, nor for an ancestor it is anchored at: the map
 * must never hold an address, and an address escaped in an id (`#a\@b\.co`) is one that redaction
 * would not even recognise. Such an element gets the next candidate, or the path. Everything else
 * redaction rewrites (tokens, keys) is left to `stableSelector`, which asks `redact` itself, so the
 * rules are not copied into the page.
 *
 * It runs in the page (CDP `Runtime.callFunctionOn`, Playwright `page.evaluate`) from its source
 * text, so it must stay self-contained: no imports, no references to module scope.
 *
 * Elements inside a shadow tree cannot be reached by a document-level selector; for those the
 * path stops at the shadow root and does not resolve, which callers check for.
 */
function buildSelector(el: Element): SelectorCandidate {
  const GENERATED_ID = /^(:r|:R|«r|«R|_r_|_R_|radix-|headlessui-|mui-|react-aria)/;
  const DIGITS_ONLY = /^\d+$/;
  const CONTACT_SCHEME = /^\s*(mailto|tel):/i;

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
  /** No email address and no `mailto:` or `tel:` link: see the note on addresses above. */
  const isRedactionSafe = (value: string): boolean => !value.includes('@') && !CONTACT_SCHEME.test(value);
  const tagOf = (node: Element): string => CSS.escape(node.localName);
  const attributeSelector = (node: Element, name: string, prefix: string): string | null => {
    const value = node.getAttribute(name);
    return value === null || !isRedactionSafe(value) ? null : `${prefix}[${name}=${quote(value)}]`;
  };
  const testIdSelector = (node: Element): string | null => attributeSelector(node, 'data-testid', '');
  const idSelector = (node: Element): string | null => {
    const { id } = node;
    const isStable = id !== '' && !GENERATED_ID.test(id) && !DIGITS_ONLY.test(id) && isRedactionSafe(id);
    return isStable ? `#${CSS.escape(id)}` : null;
  };
  const firstUniqueFor = (node: Element, candidates: readonly (string | null)[]): string | null =>
    candidates.find((candidate): candidate is string => candidate !== null && isUniqueFor(node, candidate)) ??
    null;
  /** The step above `node` that a path starts from, or `null` to keep climbing. */
  type Anchor = (node: Element) => string | null;
  const stableAnchor: Anchor = (node) =>
    node === document.body ? 'body' : firstUniqueFor(node, [testIdSelector(node), idSelector(node)]);
  const bodyAnchor: Anchor = (node) => (node === document.body ? 'body' : null);
  const stepTo = (node: Element): string => {
    const siblings = node.parentElement === null ? [node] : Array.from(node.parentElement.children);
    const sameType = siblings.filter((sibling) => sibling.localName === node.localName);
    return `${tagOf(node)}:nth-of-type(${sameType.indexOf(node) + 1})`;
  };
  const pathTo = (node: Element, anchor: Anchor): string => {
    const parent = node.parentElement;
    if (parent === null) {
      return stepTo(node);
    }
    return `${anchor(parent) ?? pathTo(parent, anchor)} > ${stepTo(node)}`;
  };

  const direct = firstUniqueFor(el, [
    testIdSelector(el),
    idSelector(el),
    attributeSelector(el, 'name', tagOf(el)),
    attributeSelector(el, 'aria-label', tagOf(el)),
    el.localName === 'a' ? attributeSelector(el, 'href', 'a') : null,
  ]);
  return { selector: direct ?? pathTo(el, stableAnchor), path: pathTo(el, bodyAnchor) };
}

/**
 * The source of an in-page `(el: Element) => SelectorCandidate` that returns the selectors for `el`
 * (see `buildSelector`). Call it as `(${BUILD_SELECTOR_SOURCE})(el)` in `page.evaluate`, or wrap it
 * as `function () { return (${BUILD_SELECTOR_SOURCE})(this); }` for `Runtime.callFunctionOn`. The
 * caller applies `stableSelector` to what comes back.
 */
export const BUILD_SELECTOR_SOURCE: string = buildSelector.toString();

/**
 * The selector to store for `candidate`: `selector` when redaction leaves it as it is, else `path`
 * when redaction leaves that as it is, else `null` (the element cannot be found again from the
 * stored map, so the caller leaves it out). The stored map is redacted, and a selector that
 * redaction changes (`a[href="/reset?token=[redacted]"]`) would match nothing in the live page.
 */
export function stableSelector(candidate: SelectorCandidate): string | null {
  return [candidate.selector, candidate.path].find(isUnchangedByRedaction) ?? null;
}

function isUnchangedByRedaction(selector: string): boolean {
  return redact(selector) === selector;
}
