// Sizes are counted in UTF-8 bytes and text is shortened on character boundaries. No TextEncoder or Buffer: this runs
// wherever shared code runs.

/**
 * Bytes per token, set low on purpose: English text runs near four bytes a token and Chinese near three, so counts
 * made with this come out high rather than low.
 */
export const BYTES_PER_TOKEN = 3;

export const tokensOf = (bytes: number): number => Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN);

export function byteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** The longest prefix of `text` within `max` bytes, never splitting a character. */
function prefixWithin(text: string, max: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > max) break;
    bytes += size;
    index += pair ? 2 : 1;
  }
  return text.slice(0, index);
}

/** The longest suffix of `text` within `max` bytes, never splitting a character. */
function suffixWithin(text: string, max: number): string {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    const code = text.charCodeAt(index - 1);
    const pair = code >= 0xdc00 && code <= 0xdfff && index - 2 >= 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > max) break;
    bytes += size;
    index -= pair ? 2 : 1;
  }
  return text.slice(index);
}

/** `text` within `max` bytes: the beginning, with a note of what was cut. */
export function clipHead(text: string, max: number): string {
  const total = byteLength(text);
  if (total <= max) return text;
  // The note's length is reserved with the largest count it can show; the real count is never longer.
  const head = prefixWithin(text, Math.max(0, max - byteLength(` …[${total} more bytes]`)));
  return `${head} …[${total - byteLength(head)} more bytes]`;
}

/** `text` within `max` bytes: a third from the beginning and the rest from the end, where results and errors are. */
export function clipMiddle(text: string, max: number): string {
  const total = byteLength(text);
  if (total <= max) return text;
  const room = Math.max(0, max - byteLength(`\n…[${total} bytes omitted]…\n`));
  const head = prefixWithin(text, Math.floor(room / 3));
  const tail = suffixWithin(text, room - byteLength(head));
  return `${head}\n…[${total - byteLength(head) - byteLength(tail)} bytes omitted]…\n${tail}`;
}
