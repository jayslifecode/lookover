const REDACTED = '[redacted]';

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Specific token shapes. Order matters: these run before the generic
// `key: value` rule, which therefore also hides the value of any placeholder
// they leave behind (`token=jay@example.com` ends up as `token=[redacted]`).
//
// Patterns that start with an open-ended character class carry a lookbehind so
// they only try to match at the start of a run. Without it, a long run of
// matching characters with no terminator is rescanned from every position
// (quadratic time on page text and log lines).
const TOKEN_RULES: readonly RedactionRule[] = [
  // The canonical casing is a strong signal, so any token length is redacted.
  { pattern: /\bBearer\s+[\w.~+/=-]+/g, replacement: 'Bearer [token]' },
  // The HTTP scheme is case-insensitive; other casings need a realistic token
  // length so prose such as "the bearer of news" is left alone.
  { pattern: /\bbearer\s+[\w.~+/=-]{8,}/gi, replacement: 'Bearer [token]' },
  { pattern: /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g, replacement: '[jwt]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[aws-key]' },
  { pattern: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, replacement: '[api-key]' },
  { pattern: /sb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g, replacement: '[api-key]' },
  { pattern: /sbp_[a-f0-9]{40}/g, replacement: '[api-key]' },
  {
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    replacement: '[email]',
  },
];

// `key`, a separator (closing key quote, `:` or `=`), then the value, which is
// one of: a double- or single-quoted string (backslash escapes allowed), an
// unterminated quote (taken to the end of the line), an existing `[placeholder]`,
// or an unquoted run that stops at whitespace, quotes or `} ] ) & , ;`.
const GENERIC_SECRET_PATTERN =
  /(api[_-]?key|secret|token|password)(["']?\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|["'][^\r\n]*|\[[\w-]+\]|[^\s"'}\])&,;]+)/gi;

// Keeps the key, the separator and the value's own quotes; only the content goes.
function redactGenericValue(match: string, key: string, separator: string): string {
  const value = match.slice(key.length + separator.length);
  const first = value.charAt(0);
  const quote = first === '"' || first === "'" ? first : '';
  const closing = quote !== '' && value.length > 1 && value.endsWith(quote) ? quote : '';
  return `${key}${separator}${quote}${REDACTED}${closing}`;
}

export function redact(text: string): string {
  const masked = TOKEN_RULES.reduce((current, rule) => current.replace(rule.pattern, rule.replacement), text);
  return masked.replace(GENERIC_SECRET_PATTERN, redactGenericValue);
}

// Object keys (compared lowercase, without `-` and `_`) whose string values are
// secrets. `tokens` (design tokens) must not match, so suffixes are exact.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'apisecret',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'sessionid',
  'privatekey',
  'accesskey',
  'credential',
  'credentials',
]);

const SENSITIVE_KEY_SUFFIXES: readonly string[] = ['password', 'secret', 'token', 'apikey'];

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  return (
    SENSITIVE_KEYS.has(normalised) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// `isSensitive` is true for a string (or an array of strings, such as a
// `set-cookie` header list) found directly under a sensitive key. Nested
// objects reset it: their own keys decide.
function redactNode(value: unknown, isSensitive: boolean): unknown {
  if (typeof value === 'string') return isSensitive ? REDACTED : redact(value);
  if (Array.isArray(value)) return value.map((item) => redactNode(item, isSensitive));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactNode(child, isSensitiveKey(key))]),
    );
  }
  return value;
}

/**
 * Redacts a JSON-like value. Every string is passed through `redact`; a string
 * under a sensitive key (`password`, `x-api-key`, `refreshToken`, `set-cookie`,
 * ...) is replaced outright. Builds new arrays and plain objects, so the input
 * is never mutated. Keys, non-string primitives and non-plain objects (Date,
 * Buffer) are returned as-is.
 */
export function redactDeep<T>(value: T): T {
  return redactNode(value, false) as T;
}
