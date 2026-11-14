/**
 * Output comparators for Competitive Programming stress testing.
 */

function truncate(str, maxLen = 40) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Split text into whitespace-delimited tokens while preserving 1-based line and column metadata.
 */
function tokenize(text) {
  const tokens = [];
  let line = 1;
  let col = 1;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\v' || ch === '\f') {
      if (ch === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
      continue;
    }

    const startLine = line;
    const startCol = col;
    let start = i;
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\v' || c === '\f') {
        break;
      }
      i++;
      col++;
    }

    tokens.push({
      value: text.slice(start, i),
      line: startLine,
      col: startCol,
      index: tokens.length + 1,
    });
  }

  return tokens;
}

function checkLengthMismatch(expTokens, actTokens) {
  if (actTokens.length < expTokens.length) {
    const missing = expTokens[actTokens.length];
    const lastActLine = actTokens.length > 0 ? actTokens[actTokens.length - 1].line : 1;
    return {
      ok: false,
      reason: `Token #${actTokens.length + 1} (line ${lastActLine}) mismatch: expected "${truncate(missing.value)}", got EOF`,
      diffLine: lastActLine,
      expectedLine: missing.line,
      tokenIndex: actTokens.length + 1,
      expectedToken: missing.value,
      actualToken: '<EOF>',
    };
  }
  if (actTokens.length > expTokens.length) {
    const extra = actTokens[expTokens.length];
    const lastExpLine = expTokens.length > 0 ? expTokens[expTokens.length - 1].line : 1;
    return {
      ok: false,
      reason: `Extra token #${expTokens.length + 1} (line ${extra.line}): expected EOF, got "${truncate(extra.value)}"`,
      diffLine: extra.line,
      expectedLine: lastExpLine,
      tokenIndex: expTokens.length + 1,
      expectedToken: '<EOF>',
      actualToken: extra.value,
    };
  }
  return null;
}

/**
 * Token-by-token comparison (equivalent to Codeforces wcmp).
 */
function compareTokens(expectedText, actualText) {
  const expTokens = tokenize(expectedText);
  const actTokens = tokenize(actualText);
  const minLen = Math.min(expTokens.length, actTokens.length);

  for (let i = 0; i < minLen; i++) {
    if (expTokens[i].value !== actTokens[i].value) {
      return {
        ok: false,
        reason: `Token #${i + 1} (line ${actTokens[i].line}) mismatch: expected "${truncate(expTokens[i].value)}", got "${truncate(actTokens[i].value)}"`,
        diffLine: actTokens[i].line,
        expectedLine: expTokens[i].line,
        tokenIndex: i + 1,
        expectedToken: expTokens[i].value,
        actualToken: actTokens[i].value,
      };
    }
  }

  const lenMismatch = checkLengthMismatch(expTokens, actTokens);
  if (lenMismatch) return lenMismatch;

  return {
    ok: true,
    reason: `All ${expTokens.length} tokens matched`,
  };
}

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Floating-point token comparison with absolute/relative error tolerance (Codeforces ncmp).
 */
function compareFloats(expectedText, actualText, eps = 1e-6) {
  const expTokens = tokenize(expectedText);
  const actTokens = tokenize(actualText);
  const minLen = Math.min(expTokens.length, actTokens.length);

  for (let i = 0; i < minLen; i++) {
    const eVal = expTokens[i].value;
    const aVal = actTokens[i].value;

    if (FLOAT_RE.test(eVal) && FLOAT_RE.test(aVal)) {
      const ev = Number(eVal);
      const av = Number(aVal);
      if (Number.isFinite(ev) && Number.isFinite(av)) {
        const err = Math.abs(ev - av) / Math.max(1.0, Math.abs(ev));
        if (err <= eps) continue;
        return {
          ok: false,
          reason: `Float #${i + 1} (line ${actTokens[i].line}) mismatch: expected "${truncate(eVal)}", got "${truncate(aVal)}" (err=${err.toExponential(2)} > ${eps})`,
          diffLine: actTokens[i].line,
          expectedLine: expTokens[i].line,
          tokenIndex: i + 1,
          expectedToken: eVal,
          actualToken: aVal,
        };
      }
    }

    if (eVal !== aVal) {
      return {
        ok: false,
        reason: `Token #${i + 1} (line ${actTokens[i].line}) mismatch: expected "${truncate(eVal)}", got "${truncate(aVal)}"`,
        diffLine: actTokens[i].line,
        expectedLine: expTokens[i].line,
        tokenIndex: i + 1,
        expectedToken: eVal,
        actualToken: aVal,
      };
    }
  }

  const lenMismatch = checkLengthMismatch(expTokens, actTokens);
  if (lenMismatch) return lenMismatch;

  return {
    ok: true,
    reason: `All ${expTokens.length} tokens matched (eps=${eps})`,
  };
}

/**
 * Exact line-by-line comparison (normalizes CRLF and trailing EOF newline).
 */
function compareExact(expectedText, actualText) {
  const normExp = expectedText.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const normAct = actualText.replace(/\r\n/g, '\n').replace(/\n$/, '');

  if (normExp === normAct) {
    const lineCount = normExp === '' ? 0 : normExp.split('\n').length;
    return {
      ok: true,
      reason: `Exact match (${lineCount} lines)`,
    };
  }

  const expLines = normExp.split('\n');
  const actLines = normAct.split('\n');
  const maxLines = Math.max(expLines.length, actLines.length);

  for (let i = 0; i < maxLines; i++) {
    const eLine = i < expLines.length ? expLines[i] : undefined;
    const aLine = i < actLines.length ? actLines[i] : undefined;
    if (eLine !== aLine) {
      return {
        ok: false,
        reason: `Line ${i + 1} differs: expected "${truncate(eLine ?? '<EOF>')}", got "${truncate(aLine ?? '<EOF>')}"`,
        diffLine: Math.min(i + 1, actLines.length),
        expectedLine: Math.min(i + 1, expLines.length),
        expectedToken: eLine ?? '<EOF>',
        actualToken: aLine ?? '<EOF>',
      };
    }
  }

  return { ok: true, reason: 'Exact match' };
}

module.exports = {
  tokenize,
  compareTokens,
  compareFloats,
  compareExact,
};

