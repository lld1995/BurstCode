// Extract the cooked webview <script> from ChatViewProvider.ts and check its syntax.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'ChatViewProvider.ts'), 'utf8');

// Find the big template literal: `return /* html */ \`` ... closing backtick
const startMarker = 'return /* html */ `';
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) { console.error('Cannot find template start'); process.exit(1); }

// Scan from after the opening backtick to find the matching closing backtick.
// We must track: nested ${...} expressions (which may contain their own
// template literals / strings / braces), and escaped backticks \`.
let i = startIdx + startMarker.length; // position after the opening backtick
let depth = 0; // ${...} nesting depth
let cooked = '';
let raw = '';

while (i < src.length) {
  const ch = src[i];

  // Handle escape sequences inside the template literal
  if (ch === '\\') {
    const next = src[i + 1];
    // Cooked: \n -> newline, \t -> tab, \\ -> \, \` -> `, etc.
    if (next === 'n') cooked += '\n';
    else if (next === 't') cooked += '\t';
    else if (next === 'r') cooked += '\r';
    else if (next === '\\') cooked += '\\';
    else if (next === '`') cooked += '`';
    else if (next === '$') cooked += '$';
    else if (next === '/') cooked += '/';
    else if (next === 'u') {
      // \u0000 style
      const hex = src.slice(i + 2, i + 6);
      cooked += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      cooked += next; // unknown escape: keep the char
    }
    i += 2;
    continue;
  }

  // Handle ${...} expressions
  if (ch === '$' && src[i + 1] === '{') {
    // Replace expression with a placeholder string
    cooked += '"__EXPR__"';
    i += 2;
    depth = 1;
    // Skip until matching }
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      // Skip strings inside expressions (to avoid counting braces in strings)
      else if (c === "'" || c === '"') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++; // skip escaped char
          i++;
        }
      } else if (c === '`') {
        // Nested template literal - skip to its end (simplified)
        let nd = 1;
        i++;
        while (i < src.length && nd > 0) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '`') nd--;
          else if (src[i] === '$' && src[i+1] === '{') {
            // nested ${} inside nested template - simplified skip
            i++;
            let bd = 1;
            while (i < src.length && bd > 0) {
              if (src[i] === '{') bd++;
              else if (src[i] === '}') bd--;
              i++;
            }
            continue;
          }
          i++;
        }
        i++; // skip closing backtick
        continue;
      }
      i++;
    }
    continue;
  }

  // Closing backtick
  if (ch === '`') {
    break;
  }

  cooked += ch;
  i++;
}

// Extract <script> content
const scriptMatch = cooked.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('No <script> found in cooked HTML');
  process.exit(1);
}

const script = scriptMatch[1];
const outPath = path.join(__dirname, '.burstcode-webview-script.js');
fs.writeFileSync(outPath, script);
console.log('Extracted script to', outPath, '(' + script.length + ' chars)');
