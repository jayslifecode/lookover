import type { InstrumentedPage } from '../browser/session.js';
import { BUILD_SELECTOR_SOURCE } from './selectors.js';
import type { ElementRef, FieldInfo, FormInfo } from './types.js';

type SelectorBuilder = (el: Element) => string;
type SubmitControl = HTMLButtonElement | HTMLInputElement;
type LabelSource = NonNullable<FieldInfo['labelSource']>;

/*
 * Everything from here to `FORMS_SOURCE` runs in the page, not in Node. The functions are plain
 * top-level declarations so TypeScript checks them, but they are stringified and joined into one
 * scope: they may call each other by name and nothing else from this module (no imports, no
 * constants). Add any new helper to `IN_PAGE_FUNCTIONS`.
 *
 * Attributes are read through `Element.prototype.getAttribute` because a control named like a
 * form property (`<input name="getAttribute">`) shadows that property on the `<form>`.
 */

function attr(el: Element, name: string): string | null {
  return Element.prototype.getAttribute.call(el, name);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The attribute's text, whitespace collapsed; `''` when it is absent or blank. */
function attrText(el: Element, name: string): string {
  return collapse(attr(el, name) ?? '');
}

/** The attribute lowercased; `fallback` when it is absent or empty. */
function lowerAttr(el: Element, name: string, fallback: string): string {
  const value = attr(el, name)?.toLowerCase();
  return value === undefined || value === '' ? fallback : value;
}

function firstNonEmpty(texts: readonly string[]): string {
  return texts.find((text) => text !== '') ?? '';
}

/** The text of `node` without the subtree of `skip`: a wrapping label must not include its field's value. */
function textWithout(node: Node, skip: Element): string {
  if (node === skip) {
    return '';
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? '';
  }
  return Array.from(node.childNodes, (child) => textWithout(child, skip)).join('');
}

/** The text of every `<label>` that `<label for>` or wrapping associates with the field. */
function labelElementText(el: Element): string {
  const labels = (el as Partial<HTMLInputElement>).labels ?? [];
  return collapse(Array.from(labels, (label) => textWithout(label, el)).join(' '));
}

/** The text of the elements `aria-labelledby` points to, in the order of the ids; unknown ids are skipped. */
function labelledByText(el: Element): string {
  const ids = (attr(el, 'aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '');
  const referenced = ids.flatMap((id) => document.getElementById(id) ?? []);
  return collapse(referenced.map((node) => textWithout(node, el)).join(' '));
}

/** The first label source with text, in the order a person reads them; blank sources fall through. */
function resolveLabel(el: Element): Pick<FieldInfo, 'label' | 'labelSource'> {
  const sources: readonly (readonly [LabelSource, string])[] = [
    ['label', labelElementText(el)],
    ['aria-label', attrText(el, 'aria-label')],
    ['aria-labelledby', labelledByText(el)],
    ['placeholder', attrText(el, 'placeholder')],
  ];
  const found = sources.find(([, text]) => text !== '');
  return found === undefined
    ? { label: null, labelSource: null }
    : { label: found[1], labelSource: found[0] };
}

/** `minlength`/`maxlength` as a number; `null` when absent or not a non-negative integer. */
function lengthLimit(el: Element, name: string): number | null {
  const raw = attr(el, name);
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isNaN(value) || value < 0 ? null : value;
}

/** Everything the page selects is a field, except the `<input>`s that are buttons or hold no user value. */
function isField(el: Element): boolean {
  if (el.localName !== 'input') {
    return true;
  }
  return !['hidden', 'submit', 'button', 'reset', 'image'].includes(lowerAttr(el, 'type', 'text'));
}

function fieldType(el: Element): string {
  switch (el.localName) {
    case 'input':
      return lowerAttr(el, 'type', 'text');
    case 'select':
      return (el as HTMLSelectElement).multiple ? 'select-multiple' : 'select';
    case 'textarea':
      return 'textarea';
    default:
      return attr(el, 'role') ?? 'text';
  }
}

/** The `<form>` the control belongs to, through its ancestors or its `form` attribute; `null` for none. */
function ownerForm(el: Element): HTMLFormElement | null {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLButtonElement
  ) {
    return el.form;
  }
  return el.closest('form');
}

function describeField(el: Element, selectorOf: SelectorBuilder): FieldInfo {
  return {
    selector: selectorOf(el),
    name: attr(el, 'name'),
    ...resolveLabel(el),
    type: fieldType(el),
    required: attr(el, 'required') !== null || attr(el, 'aria-required') === 'true',
    pattern: attr(el, 'pattern'),
    minLength: lengthLimit(el, 'minlength'),
    maxLength: lengthLimit(el, 'maxlength'),
    min: attr(el, 'min'),
    max: attr(el, 'max'),
    inputMode: attr(el, 'inputmode'),
  };
}

/** The box is in document coordinates (viewport rect plus scroll offset), as in `ElementRef` elsewhere. */
function describeSubmit(control: SubmitControl, selectorOf: SelectorBuilder): ElementRef {
  const rect = control.getBoundingClientRect();
  return {
    selector: selectorOf(control),
    role: 'button',
    name: firstNonEmpty([
      attrText(control, 'aria-label'),
      collapse(control.textContent ?? ''),
      collapse(control.value),
    ]),
    tag: control.localName,
    box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
    disabled: control.disabled,
    focusable: !control.disabled,
  };
}

function collectForms(selectorOf: SelectorBuilder): FormInfo[] {
  const owned = Array.from(
    document.querySelectorAll('input, select, textarea, [role="textbox"], [role="combobox"]'),
  )
    .filter(isField)
    .map((el) => ({ el, owner: ownerForm(el) }));
  const submitControls = Array.from(
    document.querySelectorAll<SubmitControl>('button[type=submit], input[type=submit], button:not([type])'),
  );
  const fieldsOf = (owner: HTMLFormElement | null): FieldInfo[] =>
    owned.filter((field) => field.owner === owner).map(({ el }) => describeField(el, selectorOf));

  const forms: FormInfo[] = Array.from(document.querySelectorAll('form'), (form) => {
    const submit = submitControls.find((control) => control.form === form);
    return {
      selector: selectorOf(form),
      action: attr(form, 'action'),
      method: lowerAttr(form, 'method', 'get'),
      fields: fieldsOf(form),
      submit: submit === undefined ? null : describeSubmit(submit, selectorOf),
    };
  });
  const looseFields = fieldsOf(null);
  return looseFields.length === 0
    ? forms
    : [...forms, { selector: 'body', action: null, method: 'none', fields: looseFields, submit: null }];
}

const IN_PAGE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  attr,
  collapse,
  attrText,
  lowerAttr,
  firstNonEmpty,
  textWithout,
  labelElementText,
  labelledByText,
  resolveLabel,
  lengthLimit,
  isField,
  fieldType,
  ownerForm,
  describeField,
  describeSubmit,
  collectForms,
];

const FORMS_SOURCE = `(() => {
${IN_PAGE_FUNCTIONS.map((fn) => fn.toString()).join('\n')}
return collectForms(${BUILD_SELECTOR_SOURCE});
})()`;

/**
 * What the main frame's forms declare: per `<form>`, its action, method, fields and first submit
 * control; plus one virtual form (`selector: 'body'`, `method: 'none'`, no submit) for fields that
 * belong to no form, only when there are such fields.
 *
 * Fields are `input` (not hidden, submit, button, reset or image), `select`, `textarea` and anything
 * with `role="textbox"` or `role="combobox"`, hidden ones included: the form declares them, and
 * whether a person can reach them is for later lenses to decide. Constraint attributes are copied
 * as written, not as the browser normalises them. A control belongs to a form through its ancestors
 * or its `form` attribute; the submit control is the first `button[type=submit]`,
 * `input[type=submit]` or `button` without a type that belongs to the form.
 *
 * One in-page evaluation, so the cost does not grow with the number of fields. Fields in shadow
 * trees and other frames are not reached.
 */
export async function extractForms(ipage: InstrumentedPage): Promise<FormInfo[]> {
  return ipage.page.evaluate<FormInfo[]>(FORMS_SOURCE);
}
