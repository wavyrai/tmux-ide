/** Split `text` into chunks each at most `maxBytes` UTF-8 bytes, never breaking
 *  a code point — for send-keys -H, whose per-command length tmux caps. */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (curBytes + b > maxBytes && cur.length > 0) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}
