interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Order matters: specific token shapes run first, the generic `key: value`
// rule runs last and keeps the key name while hiding only the value.
const REDACTION_RULES: readonly RedactionRule[] = [
  { pattern: /\bBearer\s+[\w.~+/=-]+/g, replacement: 'Bearer [token]' },
  { pattern: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: '[jwt]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[aws-key]' },
  { pattern: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, replacement: '[api-key]' },
  { pattern: /sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g, replacement: '[api-key]' },
  { pattern: /sbp_[a-f0-9]{40}/g, replacement: '[api-key]' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, replacement: '[email]' },
  {
    pattern: /(api[_-]?key|secret|token|password)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    replacement: '$1$2[redacted]',
  },
];

export function redact(text: string): string {
  return REDACTION_RULES.reduce((current, rule) => current.replace(rule.pattern, rule.replacement), text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactNode(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactNode);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactNode(child)]));
  }
  return value;
}

/**
 * Applies `redact` to every string in a JSON-like value. Builds new arrays and
 * plain objects; the input is never mutated. Non-plain objects (Date, Buffer)
 * and non-string primitives are returned as-is. Object keys are not redacted.
 */
export function redactDeep<T>(value: T): T {
  return redactNode(value) as T;
}
