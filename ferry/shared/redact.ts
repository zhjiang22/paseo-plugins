// Credential-shaped text is replaced before a conversation goes to another provider. Redaction runs on full text,
// before anything is shortened, so a cut can never leave half a key behind. It is a safety net for common formats,
// not a guarantee: the preview shows exactly what will be sent.

const MASK = "[REDACTED]";

const RULES: readonly (readonly [RegExp, string])[] = [
  // PEM and PGP private keys, through their END line (or the end of the text when it was cut).
  [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[REDACTED PRIVATE KEY]"],
  // Provider and forge tokens.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, MASK],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, MASK],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK],
  // Authorization headers, any case.
  [/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${MASK}`],
  // Passwords in URLs: scheme://user:password@host. The scheme is bounded, so a long run of letters and dots stays linear.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // name=value and "name": "value" where a part of the name says it is secret: API_KEY, DB_PASSWORD, client_secret,
  // AWS_SECRET_ACCESS_KEY, access_token. The parts around the word are bounded, so the scan stays linear.
  [/(\b(?:[A-Za-z0-9]{1,32}[_.-]){0,6}(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)(?:[_.-][A-Za-z0-9]{1,32}){0,3}["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${MASK}`],
];

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}
