/**
 * Scans `input` character-by-character and, while inside a JSON string
 * literal, escapes any raw control characters (bytes < 0x20) that the
 * LLM emitted literally.  Returns the repaired string when at least one
 * control character was fixed, or `null` when nothing was changed (so the
 * caller can surface the original parse error verbatim).
 */
/**
 * Second-pass repair: scans a JSON string that may contain UNESCAPED `"`
 * characters inside string values (e.g. Python triple-quote docstrings).
 *
 * Heuristic: when inside a JSON string and we encounter a `"`, peek at the
 * next non-whitespace character.  If it is a valid JSON token that can follow
 * a string (`,` `}` `]` `:` or EOF) we treat it as the genuine end of the
 * string.  Otherwise we assume it is an embedded literal quote and escape it
 * as `\"`.  This correctly handles `"""` triple-quote sequences embedded in
 * `newText` / file-content values.
 *
 * Returns the repaired string when at least one quote was escaped, or `null`
 * when nothing was changed.
 */
export function repairJsonUnescapedQuotes(input: string): string | null {
  const validAfterString = new Set([',', '}', ']', ':']);
  let out = '';
  let i = 0;
  let changed = false;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '"') { out += ch; i++; continue; }

    // Opening quote of a string value / key.
    out += ch; i++;
    while (i < input.length) {
      const sc = input[i];
      if (sc === '\\') {
        out += sc; i++;
        if (i < input.length) { out += input[i]; i++; }
        continue;
      }
      if (sc.charCodeAt(0) < 0x20) {
        // Control char — escape it (shouldn't appear here if repairJsonControlChars
        // ran first, but be safe).
        const code = sc.charCodeAt(0);
        if      (code === 0x09) out += '\\t';
        else if (code === 0x0a) out += '\\n';
        else if (code === 0x0d) out += '\\r';
        else if (code === 0x08) out += '\\b';
        else if (code === 0x0c) out += '\\f';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        changed = true; i++; continue;
      }
      if (sc === '"') {
        // Look-ahead: find next non-whitespace character.
        let j = i + 1;
        while (j < input.length && (input[j] === ' ' || input[j] === '\t' ||
               input[j] === '\n' || input[j] === '\r')) j++;
        const next = j < input.length ? input[j] : '';
        if (validAfterString.has(next) || next === '') {
          // Genuine end of string.
          out += sc; i++; break;
        } else {
          // Embedded quote — escape it.
          out += '\\"'; changed = true; i++; continue;
        }
      }
      out += sc; i++;
    }
  }
  return changed ? out : null;
}

export function repairJsonControlChars(input: string): string | null {
  let out = '';
  let inString = false;
  let escape = false;
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const code = ch.charCodeAt(0);
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') { out += ch; escape = true; continue; }
      if (ch === '"')  { out += ch; inString = false; continue; }
      if (code < 0x20) {
        changed = true;
        if      (code === 0x09) out += '\\t';
        else if (code === 0x0a) out += '\\n';
        else if (code === 0x0d) out += '\\r';
        else if (code === 0x08) out += '\\b';
        else if (code === 0x0c) out += '\\f';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
  }
  return changed ? out : null;
}
