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

/**
 * Third-pass repair for the "concatenated tool-call arguments" bug: some
 * models emit TWO (or more) JSON objects back-to-back into a SINGLE tool
 * call's `arguments` string, e.g.
 *
 *     {"query":"a","glob":"x"}{"query":"b","glob":"y","maxResults":5}
 *
 * `JSON.parse` rejects this with "Unexpected non-whitespace character after
 * JSON at position N". This scanner walks the input tracking brace/bracket
 * depth (while respecting string literals + escapes) and returns the FIRST
 * complete top-level JSON object/array. Trailing content after it is dropped
 * — it belonged to a second call the model failed to split out, and the best
 * recovery is to honor the first object so the conversation can continue.
 *
 * Returns the extracted first-object substring when the input contained a
 * complete leading object/array FOLLOWED by extra non-whitespace, or `null`
 * when there is nothing extra to strip (so callers fall through to the
 * original parse error).
 */
export function extractFirstJsonObject(input: string): string | null {
  let i = 0;
  // Skip leading whitespace.
  while (i < input.length && /\s/.test(input[i])) i++;
  const startCh = input[i];
  if (startCh !== '{' && startCh !== '[') return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let endExclusive = -1;
  for (let j = i; j < input.length; j++) {
    const ch = input[j];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { endExclusive = j + 1; break; }
    }
  }
  if (endExclusive < 0) return null; // never closed — truncated, not concatenated.

  // Is there any non-whitespace AFTER the first complete object?
  let k = endExclusive;
  while (k < input.length && /\s/.test(input[k])) k++;
  if (k >= input.length) return null; // nothing trailing — input was already a single object.

  return input.slice(i, endExclusive);
}
