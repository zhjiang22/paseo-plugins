import { t } from '../shared/text';
/**
 * One set of address rules for the panel, the browser Agent and restored tabs.
 * Link-local and cloud metadata addresses are refused here and again inside Chromium (see blockedHostResolverRules),
 * so pages cannot reach them by script, redirect, frame or form either. Host names that only resolve to such
 * addresses through DNS are not recognised.
 */
const BLOCKED_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);
const BLOCKED_IPV6 = new Set(['fd00:ec2::254', '::ffff:6464:64c8']);

/** hostname as URL parses it: IPv4 in dotted form, IPv6 in brackets, names in lower case. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_NAMES.has(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || host === '100.100.100.200') return true;
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const ipv6 = host.slice(1, -1);
  if (BLOCKED_IPV6.has(ipv6)) return true;
  // IPv4-mapped and IPv4-compatible forms of 169.254.0.0/16 (URL writes ::ffff:169.254.1.2 as ::ffff:a9fe:102).
  if (/^::(?:ffff:)?a9fe:[0-9a-f]{1,4}$/.test(ipv6)) return true;
  // fe80::/10, link-local.
  const first = ipv6.split(':')[0];
  return /^[0-9a-f]{1,4}$/.test(first) && (Number.parseInt(first, 16) & 0xffc0) === 0xfe80;
}

/** Chromium --host-resolver-rules that make the same addresses fail to resolve for every request the browser makes. */
export function blockedHostResolverRules(): string {
  return [
    '169.254.*', '100.100.100.200', '::ffff:a9fe:*', '::a9fe:*', '::ffff:6464:64c8', 'fe8?:*', 'fe9?:*', 'fea?:*', 'feb?:*', 'fd00:ec2::254',
    ...[...BLOCKED_NAMES].flatMap(name => [name, `${name}.`]),
  ].map(host => `MAP ${host} ~NOTFOUND`).join(', ');
}

/** localhost, *.localhost, or an IP literal (URL hostnames keep IPv6 in brackets). */
function isLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

export function normalizeNavigationUrl(value: string): string {
  const trimmed = value.trim(); if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) throw new Error(t('navigation.invalidAddress'));
  const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed), hostWithPort = /^(localhost|[\w.-]+):\d+(?:[/?#]|$)/i.test(trimmed);
  const url = new URL(explicitScheme && !hostWithPort ? trimmed : `https://${trimmed}`);
  // A bare local address is almost always a dev server without TLS, so it gets http:// as in a browser's address bar.
  if (!(explicitScheme && !hostWithPort) && isLocalAddress(url.hostname)) url.protocol = 'http:';
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('navigation.httpOnly'));
  if (url.username || url.password) throw new Error(t('navigation.noCredentials'));
  if (isBlockedHost(url.hostname)) throw new Error(t('navigation.blockedAddress'));
  return url.toString();
}

/**
 * Parameter names that usually carry a one-time or secret value: OAuth codes, state and assertions, tokens, signatures and
 * hashes, tickets, session ids, one-time passwords, PINs, verification and invite codes, and magic links. A heuristic on the
 * lower-case name with "-" read as "_", checked once as it is and once with a camelCase boundary read as "_" too (oobCode is
 * oob_code, passWord stays password); names that only describe a place, language or currency (country_code, zipCode…) are ordinary.
 */
const SECRET_NAMES = new Set(['code', 'state', 'token', 'auth', 'key', 'sig', 'signature', 'ticket', 'session', 'sid', 'otp', 'ott', 'magic', 'password', 'passwd', 'pwd', 'pass', 'pin', 'hash', 'secret', 'nonce', 'jwt']);
const SECRET_PARTS = /token|secret|passw|passcode|passphrase|signature|credential|session|sessid|saml|assertion|hmac|totp|magic|verifier|api_?key|access_?key|private_?key|auth_?code|otp_|_otp|_code$|^code_/;
const ORDINARY_CODES = new Set(['country_code', 'region_code', 'area_code', 'zip_code', 'postal_code', 'currency_code', 'language_code', 'lang_code', 'locale_code']);
export function isSecretParameter(name: string): boolean {
  const plain = name.toLowerCase().replace(/-/g, '_'), split = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/-/g, '_');
  return [plain, split].some(key => SECRET_NAMES.has(key) || (!ORDINARY_CODES.has(key) && SECRET_PARTS.test(key)));
}

/**
 * A page address for viewers and the Agent: never the account and password an address can carry ("https://user:pass@host/").
 * The rest stays (query and fragment included): Playwright MCP shows the Agent full tab addresses in its own replies anyway.
 */
export function withoutCredentials(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  if (!url.username && !url.password) return value;
  url.username = ''; url.password = '';
  return url.toString();
}

function parameterName(raw: string): string {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
}

/**
 * The address a tab may be saved and reopened with: HTTP(S) only, no credentials, no fragment, and no query or path
 * parameter (";jsessionid=…") that looks like a one-time credential. Other parameters stay so ordinary pages reopen as they were.
 */
export function restorableUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isBlockedHost(url.hostname)) return null;
  url.hash = '';
  // Filter the raw query and path so the parameters that stay keep their exact encoding.
  url.pathname = url.pathname.split('/').map(segment => segment.split(';').filter((part, index) => index === 0 || !isSecretParameter(parameterName(part.split('=')[0]))).join(';')).join('/');
  const kept = url.search.slice(1).split('&').filter(part => !isSecretParameter(parameterName(part.split('=')[0])));
  url.search = kept.some(Boolean) ? `?${kept.join('&')}` : '';
  return url.toString();
}
