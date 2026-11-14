(function (root) {
  'use strict';

  function createRng(seed) {
    let a = ((Number(seed) || 0) ^ 0x9e3779b9) >>> 0;

    function nextU32() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    }

    function nextFloat() {
      return nextU32() / 4294967296;
    }

    function nextInt(min, max) {
      let lo = Math.trunc(Number(min));
      let hi = Math.trunc(Number(max));
      if (!Number.isFinite(lo)) lo = 0;
      if (!Number.isFinite(hi)) hi = lo;
      if (lo > hi) {
        const tmp = lo;
        lo = hi;
        hi = tmp;
      }
      const span = hi - lo + 1;
      return lo + Math.floor(nextFloat() * span);
    }

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = nextInt(0, i);
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }

    return { nextFloat, nextInt, shuffle };
  }

  function resolveRef(ref, fallbackMin, fallbackMax, env, rng) {
    if (ref !== undefined && ref !== null) {
      const s = String(ref).trim();
      if (s.length > 0) {
        if (/^-?\d+$/.test(s)) {
          return parseInt(s, 10);
        }
        if (env[s] !== undefined) {
          return Number(env[s]);
        }
        const exprMatch = /^([a-zA-Z_]\w*)\s*([+-])\s*(\d+)$/.exec(s);
        if (exprMatch && env[exprMatch[1]] !== undefined) {
          const base = Number(env[exprMatch[1]]);
          const offset = Number(exprMatch[3]);
          return exprMatch[2] === '+' ? base + offset : base - offset;
        }
      }
    }
    return rng.nextInt(fallbackMin, fallbackMax);
  }

  function generateDistinctInts(len, min, max, rng) {
    let lo = Math.trunc(Number(min));
    let hi = Math.trunc(Number(max));
    if (!Number.isFinite(lo)) lo = 1;
    if (!Number.isFinite(hi)) hi = lo + len;
    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    if (hi - lo + 1 < len) {
      hi = lo + len - 1;
    }
    const span = hi - lo + 1;
    if (span <= 2000) {
      const pool = [];
      for (let v = lo; v <= hi; v++) pool.push(v);
      rng.shuffle(pool);
      return pool.slice(0, len);
    }
    const seen = new Set();
    const out = [];
    while (out.length < len) {
      const v = rng.nextInt(lo, hi);
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  function generateTreeEdges(n, base, weighted, wMin, wMax, rng) {
    const perm = [];
    for (let i = 0; i < n; i++) perm.push(i + base);
    rng.shuffle(perm);

    const edges = [];
    for (let i = 1; i < n; i++) {
      const p = rng.nextInt(0, i - 1);
      let u = perm[p];
      let v = perm[i];
      if (rng.nextInt(0, 1) === 1) {
        const tmp = u;
        u = v;
        v = tmp;
      }
      if (weighted) {
        edges.push([u, v, rng.nextInt(wMin, wMax)]);
      } else {
        edges.push([u, v]);
      }
    }
    rng.shuffle(edges);
    return edges;
  }

  function generateGraphEdges(n, m, base, weighted, wMin, wMax, rng) {
    const maxEdges = Math.floor((n * (n - 1)) / 2);
    const targetM = Math.max(n - 1, Math.min(maxEdges, m));
    const treeEdges = generateTreeEdges(n, base, false, wMin, wMax, rng);
    const used = new Set();
    const edges = [];

    for (const [u, v] of treeEdges) {
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      used.add(`${a},${b}`);
      edges.push(weighted ? [u, v, rng.nextInt(wMin, wMax)] : [u, v]);
    }

    if (edges.length < targetM) {
      if (n <= 60 && targetM > maxEdges * 0.5) {
        const candidates = [];
        for (let u = base; u < base + n; u++) {
          for (let v = u + 1; v < base + n; v++) {
            if (!used.has(`${u},${v}`)) {
              candidates.push([u, v]);
            }
          }
        }
        rng.shuffle(candidates);
        for (const [u, v] of candidates) {
          if (edges.length >= targetM) break;
          const swap = rng.nextInt(0, 1) === 1;
          const a = swap ? v : u;
          const b = swap ? u : v;
          edges.push(weighted ? [a, b, rng.nextInt(wMin, wMax)] : [a, b]);
        }
      } else {
        while (edges.length < targetM) {
          const u = rng.nextInt(base, base + n - 1);
          const v = rng.nextInt(base, base + n - 1);
          if (u === v) continue;
          const a = Math.min(u, v);
          const b = Math.max(u, v);
          const key = `${a},${b}`;
          if (!used.has(key)) {
            used.add(key);
            edges.push(weighted ? [u, v, rng.nextInt(wMin, wMax)] : [u, v]);
          }
        }
      }
    }

    rng.shuffle(edges);
    return edges;
  }

  function generateSingleCase(fields, rng) {
    const env = {};
    const lines = [];

    for (let idx = 0; idx < fields.length; idx++) {
      const f = fields[idx];
      const type = f.type || 'int';

      if (type === 'int') {
        let min = Number(f.min ?? 1);
        let max = Number(f.max ?? 10);

        // Pre-clamp edge count m if referenced as edgesRef by a later graph field
        const graphConsumer = fields.slice(idx + 1).find(
          (gf) => gf.type === 'graph' && gf.edgesRef === f.name && gf.nodesRef && env[gf.nodesRef] !== undefined
        );
        if (graphConsumer) {
          const n = Math.max(2, Number(env[graphConsumer.nodesRef]) || 4);
          const maxPossible = Math.floor((n * (n - 1)) / 2);
          min = Math.max(min, n - 1);
          max = Math.max(min, Math.min(max, maxPossible));
        }

        const val = rng.nextInt(min, max);
        if (f.name) env[f.name] = val;
        lines.push(String(val));
      } else if (type === 'float') {
        const min = Number(f.min ?? 0);
        const max = Number(f.max ?? 10);
        const prec = Math.min(9, Math.max(0, Math.trunc(Number(f.precision ?? 4))));
        const val = min + rng.nextFloat() * (max - min);
        if (f.name) env[f.name] = val;
        lines.push(val.toFixed(prec));
      } else if (type === 'array') {
        const len = Math.max(1, resolveRef(f.lengthRef, f.minLen ?? 2, f.maxLen ?? 8, env, rng));
        const min = Number(f.min ?? -20);
        const max = Number(f.max ?? 20);
        const subtype = f.subtype || 'random';
        let arr = [];

        if (subtype === 'permutation') {
          const start = Number(f.min) === 0 ? 0 : 1;
          for (let i = 0; i < len; i++) arr.push(start + i);
          rng.shuffle(arr);
        } else if (subtype === 'distinct') {
          arr = generateDistinctInts(len, min, max, rng);
        } else if (subtype === 'sorted_asc') {
          for (let i = 0; i < len; i++) arr.push(rng.nextInt(min, max));
          arr.sort((a, b) => a - b);
        } else if (subtype === 'sorted_desc') {
          for (let i = 0; i < len; i++) arr.push(rng.nextInt(min, max));
          arr.sort((a, b) => b - a);
        } else {
          for (let i = 0; i < len; i++) arr.push(rng.nextInt(min, max));
        }

        lines.push(arr.join(' '));
      } else if (type === 'string') {
        const len = Math.max(1, resolveRef(f.lengthRef, f.min ?? 2, f.max ?? 8, env, rng));
        const subtype = f.subtype || 'lower';
        let alphabet = 'abcdefghijklmnopqrstuvwxyz';
        if (subtype === 'lower_small') alphabet = 'abcde';
        else if (subtype === 'binary') alphabet = '01';
        else if (subtype === 'upper') alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        else if (subtype === 'digits') alphabet = '0123456789';
        else if (subtype === 'custom' && f.customChars) alphabet = String(f.customChars);

        let s = '';
        for (let i = 0; i < len; i++) {
          s += alphabet[rng.nextInt(0, alphabet.length - 1)];
        }
        lines.push(s);
      } else if (type === 'matrix') {
        const rows = Math.max(1, resolveRef(f.rowsRef, 2, 5, env, rng));
        const cols = Math.max(1, resolveRef(f.colsRef, 2, 5, env, rng));
        const subtype = f.subtype || 'space_int';

        if (subtype === 'char_grid' || subtype === 'binary_grid') {
          const chars = subtype === 'binary_grid' ? '01' : '.#';
          for (let r = 0; r < rows; r++) {
            let rowStr = '';
            for (let c = 0; c < cols; c++) {
              rowStr += chars[rng.nextInt(0, chars.length - 1)];
            }
            lines.push(rowStr);
          }
        } else {
          const min = Number(f.min ?? 0);
          const max = Number(f.max ?? 9);
          for (let r = 0; r < rows; r++) {
            const row = [];
            for (let c = 0; c < cols; c++) {
              row.push(rng.nextInt(min, max));
            }
            lines.push(row.join(' '));
          }
        }
      } else if (type === 'pairs') {
        const count = Math.max(1, resolveRef(f.lengthRef, 2, 6, env, rng));
        const min = Number(f.min ?? 1);
        const max = Number(f.max ?? 15);
        for (let i = 0; i < count; i++) {
          let u = rng.nextInt(min, max);
          let v = rng.nextInt(min, max);
          if (f.subtype === 'ordered' && u > v) {
            const tmp = u;
            u = v;
            v = tmp;
          }
          lines.push(`${u} ${v}`);
        }
      } else if (type === 'tree') {
        const n = Math.max(2, resolveRef(f.lengthRef || f.nodesRef, 2, 8, env, rng));
        const base = Number(f.indexBase) === 0 ? 0 : 1;
        const wMin = Number(f.min ?? 1);
        const wMax = Number(f.max ?? 20);
        const edges = generateTreeEdges(n, base, Boolean(f.weighted), wMin, wMax, rng);
        for (const e of edges) {
          lines.push(e.join(' '));
        }
      } else if (type === 'graph') {
        const n = Math.max(2, resolveRef(f.nodesRef || f.lengthRef, 3, 7, env, rng));
        const maxEdges = Math.floor((n * (n - 1)) / 2);
        const rawM = resolveRef(f.edgesRef, n - 1, Math.min(maxEdges, 2 * n), env, rng);
        const base = Number(f.indexBase) === 0 ? 0 : 1;
        const wMin = Number(f.min ?? 1);
        const wMax = Number(f.max ?? 20);
        const edges = generateGraphEdges(n, rawM, base, Boolean(f.weighted), wMin, wMax, rng);
        for (const e of edges) {
          lines.push(e.join(' '));
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  function generateInputFromSchema(schema, seed = 1) {
    const s = schema || {};
    const fields = Array.isArray(s.fields) ? s.fields : [];
    if (fields.length === 0) return '';

    const rng = createRng(seed);
    if (s.hasT) {
      const t = rng.nextInt(Number(s.tMin ?? 1), Number(s.tMax ?? 3));
      const parts = [String(t)];
      for (let tc = 0; tc < t; tc++) {
        parts.push(generateSingleCase(fields, rng).trimEnd());
      }
      return parts.join('\n') + '\n';
    }
    return generateSingleCase(fields, rng);
  }

  // ---------------- C++ Input Parser ----------------

  function stripComments(code) {
    let out = '';
    let i = 0;
    const n = code.length;
    while (i < n) {
      if (code[i] === '/' && code[i + 1] === '/') {
        while (i < n && code[i] !== '\n') i++;
        continue;
      }
      if (code[i] === '/' && code[i + 1] === '*') {
        i += 2;
        while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
        i += 2;
        out += ' ';
        continue;
      }
      if (code[i] === '"' || code[i] === "'") {
        const quote = code[i];
        out += quote;
        i++;
        while (i < n) {
          if (code[i] === '\\' && i + 1 < n) {
            out += code[i] + code[i + 1];
            i += 2;
            continue;
          }
          out += code[i];
          if (code[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      out += code[i];
      i++;
    }
    return out;
  }

  function findMatchingBrace(str, openIdx) {
    let depth = 0;
    let inStr = null;
    for (let i = openIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function findMatchingParen(str, openIdx) {
    let depth = 0;
    let inStr = null;
    for (let i = openIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function extractFunctionBody(code, fnName) {
    const re = new RegExp(`\\b${fnName}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(code);
    if (!m) return null;
    const openBrace = code.indexOf('{', m.index);
    const closeBrace = findMatchingBrace(code, openBrace);
    if (openBrace === -1 || closeBrace === -1) return null;
    return code.slice(openBrace + 1, closeBrace);
  }

  function isSizeVarName(name) {
    return /^(?:n|m|k|q|r|c|h|w|len|sz|size|rows|cols|n1|n2|x|y)$/i.test(name);
  }

  function defaultRangeForVar(name) {
    if (/^(?:n|m|q|r|c|h|w|len|sz|size|rows|cols)$/i.test(name)) {
      return { min: 2, max: 7 };
    }
    if (/^k$/i.test(name)) {
      return { min: 1, max: 6 };
    }
    return { min: -20, max: 20 };
  }

  function extractVarTypes(code, varTypes, vectorSizes) {
    const cleaned = code.replace(/"(?:\\.|[^"\\])*"/g, '""');

    // Match declarations like: int n, m; long long a, b = 0; ll x; string s;
    const scalarRe = /\b(?:int|long\s+long|long|short|size_t|uint64_t|int64_t|ll|ld|double|float|string|char)\s+([^;(){}=]+(?:=[^;]+)?);/g;
    let m;
    while ((m = scalarRe.exec(cleaned)) !== null) {
      const full = m[0];
      let baseType = 'int';
      if (/^\s*(?:double|float|ld)\b/.test(full)) baseType = 'float';
      else if (/^\s*string\b/.test(full)) baseType = 'string';
      else if (/^\s*char\b/.test(full)) baseType = 'char';

      const declList = m[1].split(',');
      for (const item of declList) {
        const nameMatch = /^\s*\*?\s*([a-zA-Z_]\w*)/.exec(item);
        if (nameMatch && !varTypes[nameMatch[1]]) {
          varTypes[nameMatch[1]] = baseType;
        }
      }
    }

    // Match vectors: vector<int> a(n), vector<string> s(n), vector<vector<int>> g(n, vector<int>(m))
    const vecRe = /\bvector\s*<\s*(?:vector\s*<\s*([a-zA-Z_][\w\s]*)\s*>|([a-zA-Z_][\w\s]*))\s*>\s+([a-zA-Z_]\w*)(?:\s*\(\s*([^,)]+))?/g;
    while ((m = vecRe.exec(cleaned)) !== null) {
      const inner = (m[1] || m[2] || '').trim();
      const name = m[3];
      if (/string/.test(inner)) varTypes[name] = 'string_vec';
      else if (/double|float|ld/.test(inner)) varTypes[name] = 'float_vec';
      else if (/char/.test(inner)) varTypes[name] = 'char_vec';
      else varTypes[name] = 'int_vec';
      if (m[4]) {
        vectorSizes[name] = m[4].trim();
      }
    }
  }

  function cleanReadTarget(expr) {
    let s = expr.trim();
    s = s.replace(/^&/, '');
    s = s.replace(/\[[^\]]*\]/g, '');
    s = s.replace(/\.(?:first|second|a|b|u|v|l|r|w)\b/g, '');
    const idMatch = /^([a-zA-Z_]\w*)/.exec(s);
    return idMatch ? idMatch[1] : s;
  }

  function parseCinStatement(stmt) {
    const parts = stmt.split('>>').slice(1);
    const targets = [];
    for (const p of parts) {
      const cleaned = p.trim();
      if (!cleaned || /^ws$/.test(cleaned)) continue;
      targets.push({ raw: cleaned, name: cleanReadTarget(cleaned) });
    }
    return targets;
  }

  function parseScanfStatement(stmt) {
    const m = /\bscanf\s*\(\s*"([^"]*)"\s*,\s*([^)]+)\)/.exec(stmt);
    if (!m) return [];
    const fmt = m[1];
    const fmtSpecs = fmt.match(/%[a-zA-Z0-9.*]+/g) || [];
    const args = m[2].split(',').map((a) => a.trim());
    const targets = [];
    for (let i = 0; i < args.length; i++) {
      const name = cleanReadTarget(args[i]);
      if (!name) continue;
      const spec = fmtSpecs[i] || '';
      let hintType = null;
      if (/s$/.test(spec)) hintType = 'string';
      else if (/[fge]$/.test(spec)) hintType = 'float';
      else if (/c$/.test(spec)) hintType = 'char';
      targets.push({ raw: args[i], name, hintType });
    }
    return targets;
  }

  function extractLoopBound(headerKind, headerText, vectorSizes) {
    const h = headerText.trim();
    if (headerKind === 'for') {
      // Range-based for: for (auto &x : a)
      const rangeMatch = /^[^:]+:\s*([a-zA-Z_]\w*)\s*$/.exec(h);
      if (rangeMatch) {
        const vecName = rangeMatch[1];
        return vectorSizes[vecName] || 'n';
      }
      const parts = h.split(';');
      if (parts.length >= 2) {
        const cond = parts[1].replace(/\s+/g, '');
        // i < n  or  i <= n - 1  or  i < n - 1
        let cm = /^[a-zA-Z_]\w*<=([a-zA-Z_]\w*(?:[+-]\d+)?)$/.exec(cond);
        if (cm) return cm[1];
        cm = /^[a-zA-Z_]\w*<([a-zA-Z_]\w*(?:[+-]\d+)?)$/.exec(cond);
        if (cm) return cm[1];
        cm = /^[a-zA-Z_]\w*>=\s*(\d+)$/.exec(cond);
        if (cm && parts[0]) {
          const initM = /=\s*([a-zA-Z_]\w*(?:-\d+)?)/.exec(parts[0]);
          if (initM) return initM[1];
        }
      }
    } else if (headerKind === 'while') {
      const wm = /^([a-zA-Z_]\w*)--$|^--([a-zA-Z_]\w*)$/.exec(h.replace(/\s+/g, ''));
      if (wm) return wm[1] || wm[2];
    } else if (headerKind === 'rep' || headerKind === 'forn') {
      const args = h.split(',').map((s) => s.trim());
      if (headerKind === 'forn' && args.length >= 2) return args[1];
      if (headerKind === 'rep' && args.length >= 3) return args[2];
      if (args.length === 2) return args[1];
    }
    return 'n';
  }

  function parseBlock(body, ctx) {
    let i = 0;
    const len = body.length;

    while (i < len) {
      while (i < len && /\s/.test(body[i])) i++;
      if (i >= len) break;

      const rest = body.slice(i);

      // Check loop constructs: for (...), while (...), rep(...), forn(...)
      const loopMatch = /^(for|while|rep|forn|FOR)\s*\(/.exec(rest);
      if (loopMatch) {
        const kind = loopMatch[1].toLowerCase();
        const openParen = i + rest.indexOf('(');
        const closeParen = findMatchingParen(body, openParen);
        if (closeParen === -1) {
          i += loopMatch[0].length;
          continue;
        }
        const headerText = body.slice(openParen + 1, closeParen);
        const bound = extractLoopBound(kind, headerText, ctx.vectorSizes);

        let after = closeParen + 1;
        while (after < len && /\s/.test(body[after])) after++;

        let innerBody = '';
        let nextPos = after;
        if (body[after] === '{') {
          const closeBrace = findMatchingBrace(body, after);
          if (closeBrace !== -1) {
            innerBody = body.slice(after + 1, closeBrace);
            nextPos = closeBrace + 1;
          }
        } else {
          // Single-statement loop body
          const semi = body.indexOf(';', after);
          const nestedLoop = /^(for|while|rep|forn|FOR)\s*\(/.exec(body.slice(after));
          if (nestedLoop) {
            const nOpen = body.indexOf('(', after);
            const nClose = findMatchingParen(body, nOpen);
            if (nClose !== -1) {
              let nafter = nClose + 1;
              while (nafter < len && /\s/.test(body[nafter])) nafter++;
              if (body[nafter] === '{') {
                const nBrace = findMatchingBrace(body, nafter);
                if (nBrace !== -1) {
                  innerBody = body.slice(after, nBrace + 1);
                  nextPos = nBrace + 1;
                }
              } else {
                const nSemi = body.indexOf(';', nafter);
                if (nSemi !== -1) {
                  innerBody = body.slice(after, nSemi + 1);
                  nextPos = nSemi + 1;
                }
              }
            }
          } else if (semi !== -1) {
            innerBody = body.slice(after, semi + 1);
            nextPos = semi + 1;
          }
        }

        // Skip outer testcase loop wrapper itself and recurse into body
        if (ctx.hasT && ctx.tVar && (bound === ctx.tVar || new RegExp(`\\b${ctx.tVar}\\b`).test(headerText))) {
          parseBlock(innerBody, ctx);
        } else {
          analyzeLoop(bound, innerBody, ctx);
        }

        i = nextPos;
        continue;
      }

      // Check block { ... }
      if (body[i] === '{') {
        const closeBrace = findMatchingBrace(body, i);
        if (closeBrace !== -1) {
          parseBlock(body.slice(i + 1, closeBrace), ctx);
          i = closeBrace + 1;
          continue;
        }
      }

      // Read statement up to ';' or '{'
      let endStmt = i;
      let inStr = null;
      while (endStmt < len) {
        const ch = body[endStmt];
        if (inStr) {
          if (ch === '\\') {
            endStmt += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
          endStmt++;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inStr = ch;
          endStmt++;
          continue;
        }
        if (ch === ';' || ch === '{' || ch === '}') break;
        endStmt++;
      }

      const stmt = body.slice(i, endStmt).trim();
      if (stmt) {
        extractTopLevelReads(stmt, ctx);
      }
      i = endStmt + 1;
    }
  }

  function extractReadsFromText(text, ctx) {
    const reads = [];
    const stmts = text.split(';');
    for (const s of stmts) {
      if (/\bcin\s*>>/.test(s)) {
        for (const t of parseCinStatement(s)) reads.push(t);
      } else if (/\bscanf\s*\(/.test(s)) {
        for (const t of parseScanfStatement(s)) reads.push(t);
      } else if (/\bgetline\s*\(\s*cin\s*,/.test(s)) {
        const gm = /\bgetline\s*\(\s*cin\s*,\s*([a-zA-Z_]\w*)/.exec(s);
        if (gm) reads.push({ raw: gm[1], name: gm[1], hintType: 'string' });
      }
    }
    return reads;
  }

  function addScalarTarget(target, ctx) {
    const name = target.name;
    if (!name || ctx.seenVars.has(name)) return;
    if (ctx.hasT && name === ctx.tVar) return;

    const vType = target.hintType || ctx.varTypes[name] || 'int';
    ctx.seenVars.add(name);

    if (vType === 'string' || vType === 'string_vec') {
      ctx.fields.push({
        id: `f${ctx.fields.length + 1}`,
        name,
        type: 'string',
        lengthRef: ctx.lastSizeVar || '',
        min: 3,
        max: 8,
        subtype: 'lower',
      });
    } else if (vType === 'float' || vType === 'float_vec') {
      ctx.fields.push({
        id: `f${ctx.fields.length + 1}`,
        name,
        type: 'float',
        min: 1,
        max: 20,
        precision: 4,
      });
    } else {
      const range = defaultRangeForVar(name);
      ctx.fields.push({
        id: `f${ctx.fields.length + 1}`,
        name,
        type: 'int',
        min: range.min,
        max: range.max,
      });
      if (isSizeVarName(name)) {
        ctx.lastSizeVar = name;
        ctx.scalarInts.push(name);
      }
    }
  }

  function extractTopLevelReads(stmt, ctx) {
    // Strip trailing `if (!(cin >> n))` wrappers so `cin >> n` is parsed cleanly
    if (/\bcin\s*>>/.test(stmt)) {
      const cinIdx = stmt.indexOf('cin');
      const sub = stmt.slice(cinIdx).replace(/\)\s*$/, '');
      const targets = parseCinStatement(sub);
      for (const t of targets) addScalarTarget(t, ctx);
    } else if (/\bscanf\s*\(/.test(stmt)) {
      const targets = parseScanfStatement(stmt);
      for (const t of targets) addScalarTarget(t, ctx);
    } else if (/\bgetline\s*\(\s*cin\s*,/.test(stmt)) {
      const gm = /\bgetline\s*\(\s*cin\s*,\s*([a-zA-Z_]\w*)/.exec(stmt);
      if (gm) addScalarTarget({ raw: gm[1], name: gm[1], hintType: 'string' }, ctx);
    }
  }

  function analyzeLoop(bound, innerBody, ctx) {
    const cleanBound = (bound || 'n').replace(/\s+/g, '');

    // Check for nested 2D loop inside this loop
    const nestedMatch = /\b(for|while|rep|forn|FOR)\s*\(/.exec(innerBody);
    if (nestedMatch) {
      const nOpen = innerBody.indexOf('(', nestedMatch.index);
      const nClose = findMatchingParen(innerBody, nOpen);
      if (nClose !== -1) {
        const innerHeader = innerBody.slice(nOpen + 1, nClose);
        const innerBound = extractLoopBound(nestedMatch[1].toLowerCase(), innerHeader, ctx.vectorSizes).replace(/\s+/g, '');
        const innerRest = innerBody.slice(nClose + 1);
        const reads = extractReadsFromText(innerRest, ctx);

        // Make sure innerBound is a known variable or distinct from an inner variable read first
        const preInner = innerBody.slice(0, nestedMatch.index);
        const preReads = extractReadsFromText(preInner, ctx);
        if (preReads.length === 0 && reads.length > 0) {
          const tName = reads[0].name;
          const vType = reads[0].hintType || ctx.varTypes[tName] || 'int';
          const isChar = vType === 'char' || vType === 'char_vec';
          ctx.fields.push({
            id: `f${ctx.fields.length + 1}`,
            name: tName || 'grid',
            type: 'matrix',
            rowsRef: cleanBound,
            colsRef: innerBound,
            min: 0,
            max: 9,
            subtype: isChar ? 'char_grid' : 'space_int',
          });
          return;
        }
      }
    }

    const reads = extractReadsFromText(innerBody, ctx);
    if (reads.length === 0) return;

    if (reads.length === 1) {
      const target = reads[0];
      const vType = target.hintType || ctx.varTypes[target.name] || 'int';
      if (vType === 'string' || vType === 'string_vec') {
        const colsGuess = ctx.scalarInts.find((s) => s !== cleanBound && /^(?:m|c|w|k)$/i.test(s)) || '5';
        ctx.fields.push({
          id: `f${ctx.fields.length + 1}`,
          name: target.name || 'grid',
          type: 'matrix',
          rowsRef: cleanBound,
          colsRef: colsGuess,
          min: 0,
          max: 1,
          subtype: 'char_grid',
        });
      } else {
        ctx.fields.push({
          id: `f${ctx.fields.length + 1}`,
          name: target.name || 'a',
          type: 'array',
          lengthRef: cleanBound,
          min: -20,
          max: 20,
          subtype: 'random',
        });
      }
      return;
    }

    if (reads.length >= 2) {
      const v1 = reads[0].name;
      const v2 = reads[1].name;
      const weighted = reads.length >= 3;
      const nVar = ctx.scalarInts.find((s) => /^n$/i.test(s)) || ctx.scalarInts[0] || 'n';

      if (cleanBound === `${nVar}-1` || cleanBound === 'n-1') {
        ctx.fields.push({
          id: `f${ctx.fields.length + 1}`,
          name: 'edges',
          type: 'tree',
          lengthRef: nVar,
          indexBase: 1,
          weighted,
          min: 1,
          max: 20,
        });
        return;
      }

      const isIntervalNames = (v1 === 'l' && v2 === 'r') || (v1 === 'L' && v2 === 'R');
      const hasGraphCounts = ctx.scalarInts.includes('n') && ctx.scalarInts.includes('m') && cleanBound === 'm';

      if (hasGraphCounts && !isIntervalNames) {
        ctx.fields.push({
          id: `f${ctx.fields.length + 1}`,
          name: 'edges',
          type: 'graph',
          nodesRef: 'n',
          edgesRef: 'm',
          indexBase: 1,
          weighted,
          min: 1,
          max: 20,
        });
        return;
      }

      ctx.fields.push({
        id: `f${ctx.fields.length + 1}`,
        name: `${v1}_${v2}`,
        type: 'pairs',
        lengthRef: cleanBound,
        min: 1,
        max: 15,
        subtype: isIntervalNames ? 'ordered' : 'any',
      });
    }
  }

  function parseCppInput(code) {
    const stripped = stripComments(String(code || ''));
    const varTypes = {};
    const vectorSizes = {};
    extractVarTypes(stripped, varTypes, vectorSizes);

    const mainBody = extractFunctionBody(stripped, 'main');
    const solveBody = extractFunctionBody(stripped, 'solve');
    const hasSolveCall = Boolean(mainBody && solveBody && /\bsolve\s*\(\s*\)/.test(mainBody));
    const tSearchSpace = mainBody || stripped;

    // Detect multi-testcase wrapper: cin >> t; while (t--) or for (... < t ...)
    let hasT = false;
    let tVar = null;
    const tWhileRe = /\b(?:cin\s*>>\s*([a-zA-Z_]\w*)|scanf\s*\([^,]+,\s*&\s*([a-zA-Z_]\w*)\s*\))[\s\S]{0,120}?\bwhile\s*\(\s*(?:([a-zA-Z_]\w*)--|--([a-zA-Z_]\w*))(?:\s*>\s*0)?\s*\)/g;
    let tm;
    while ((tm = tWhileRe.exec(tSearchSpace)) !== null) {
      const readVar = tm[1] || tm[2];
      const loopVar = tm[3] || tm[4];
      if (readVar && readVar === loopVar && (hasSolveCall || /^(?:t|tc|test|tests)$/i.test(readVar))) {
        hasT = true;
        tVar = readVar;
        break;
      }
    }
    if (!hasT) {
      const tForRe = /\b(?:cin\s*>>\s*(t|tc|T)\b|scanf\s*\([^,]+,\s*&\s*(t|tc|T)\s*\))[\s\S]{0,120}?\bfor\s*\([^;]*;\s*[a-zA-Z_]\w*\s*<=?\s*(t|tc|T)\b/g;
      while ((tm = tForRe.exec(tSearchSpace)) !== null) {
        const readVar = tm[1] || tm[2];
        if (readVar && readVar === tm[3]) {
          hasT = true;
          tVar = readVar;
          break;
        }
      }
    }

    const ctx = {
      hasT,
      tVar,
      varTypes,
      vectorSizes,
      seenVars: new Set(),
      scalarInts: [],
      lastSizeVar: '',
      fields: [],
    };

    if (mainBody) {
      if (hasSolveCall) {
        parseBlock(solveBody, ctx);
      } else {
        parseBlock(mainBody, ctx);
      }
    } else {
      parseBlock(stripped, ctx);
    }

    if (ctx.fields.length === 0) {
      return {
        hasT: false,
        tMin: 1,
        tMax: 3,
        fields: [
          { id: 'f1', name: 'n', type: 'int', min: 2, max: 8 },
          { id: 'f2', name: 'a', type: 'array', lengthRef: 'n', min: -20, max: 20, subtype: 'random' },
        ],
      };
    }

    // Post-fix: if graph was detected, tune n and m default ranges slightly better
    for (const gf of ctx.fields) {
      if (gf.type === 'graph') {
        const nf = ctx.fields.find((f) => f.type === 'int' && f.name === gf.nodesRef);
        const mf = ctx.fields.find((f) => f.type === 'int' && f.name === gf.edgesRef);
        if (nf) {
          nf.min = Math.max(2, nf.min);
          nf.max = Math.min(8, Math.max(nf.min, nf.max));
        }
        if (mf) {
          mf.min = Math.max(1, mf.min);
          mf.max = Math.max(mf.min, 12);
        }
      }
    }

    return {
      hasT,
      tMin: 1,
      tMax: 3,
      fields: ctx.fields,
    };
  }

  // ---------------- Sample Input Learner & Generator ----------------

  function parseSampleLines(sampleText) {
    return String(sampleText || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((raw) => ({ raw, tokens: raw.split(/\s+/) }));
  }

  function isIntToken(tok) {
    if (!/^[+-]?\d+$/.test(tok)) return false;
    if (/^[+-]?0\d+$/.test(tok)) return false;
    return Number.isSafeInteger(Number(tok));
  }

  function isFloatToken(tok) {
    return /^[+-]?(?:\d+\.\d+|\.\d+)$/.test(tok) && Number.isFinite(Number(tok));
  }

  function inferAlphabet(strings) {
    const joined = strings.join('');
    if (!joined) return 'abc';
    const uniq = Array.from(new Set(joined.split('')));
    const allIn = (allowed) => uniq.every((c) => allowed.includes(c));

    if (allIn('01')) return '01';
    if (allIn('.#')) return '.#';
    if (allIn('()')) return '()';
    if (allIn('LRUD')) return 'LRUD';
    if (allIn('abcdefghijklmnopqrstuvwxyz')) {
      let maxCode = 'c'.charCodeAt(0);
      for (const ch of uniq) {
        if (ch.charCodeAt(0) > maxCode) maxCode = ch.charCodeAt(0);
      }
      if (maxCode - 'a'.charCodeAt(0) > 6) return 'abcdefghijklmnopqrstuvwxyz';
      let alpha = '';
      for (let c = 'a'.charCodeAt(0); c <= maxCode; c++) alpha += String.fromCharCode(c);
      return alpha;
    }
    if (allIn('ABCDEFGHIJKLMNOPQRSTUVWXYZ')) {
      let maxCode = 'C'.charCodeAt(0);
      for (const ch of uniq) {
        if (ch.charCodeAt(0) > maxCode) maxCode = ch.charCodeAt(0);
      }
      if (maxCode - 'A'.charCodeAt(0) > 6) return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let alpha = '';
      for (let c = 'A'.charCodeAt(0); c <= maxCode; c++) alpha += String.fromCharCode(c);
      return alpha;
    }
    if (allIn('0123456789')) return '0123456789';
    return uniq.join('');
  }

  function isPermutationValues(vals, startBase) {
    if (vals.length === 0) return false;
    const seen = new Set();
    for (const v of vals) {
      if (v < startBase || v >= startBase + vals.length || seen.has(v)) return false;
      seen.add(v);
    }
    return seen.size === vals.length;
  }

  function looksLikeSingleVariableCase(lines) {
    if (lines.length < 2) return false;
    const first = lines[0].tokens;
    if (first.length === 1 && isIntToken(first[0])) {
      const n = Number(first[0]);
      if (n >= 2 && (lines.length - 1 === n || lines.length - 1 === n - 1)) return true;
    }
    if (first.length >= 2 && first.every(isIntToken)) {
      const n = Number(first[0]);
      const m = Number(first[1]);
      if (lines.length - 1 === m || lines.length - 1 === n) return true;
    }
    return false;
  }

  function splitSampleIntoBlocks(lines, cppHint, hasCppCode) {
    if (lines.length >= 2 && lines[0].tokens.length === 1 && isIntToken(lines[0].tokens[0])) {
      const T = Number(lines[0].tokens[0]);
      const rest = lines.slice(1);
      const suppressT = hasCppCode && cppHint && cppHint.hasT === false;

      if (T >= 1 && T <= 100 && (!suppressT || cppHint.hasT)) {
        // 1. Variable-length block rule: header line with count (+ offset) followed by sub-lines
        if (!suppressT && !(cppHint.hasT === false && looksLikeSingleVariableCase(lines))) {
          for (const col of [0, 1]) {
            for (const offset of [0, -1, 1]) {
              let pos = 0;
              const blocks = [];
              let valid = true;
              let firstHeaderLen = null;
              for (let tc = 0; tc < T; tc++) {
                if (pos >= rest.length || rest[pos].tokens.length <= col || !isIntToken(rest[pos].tokens[col])) {
                  valid = false;
                  break;
                }
                if (firstHeaderLen === null) firstHeaderLen = rest[pos].tokens.length;
                if (rest[pos].tokens.length !== firstHeaderLen) {
                  valid = false;
                  break;
                }
                const subCount = Number(rest[pos].tokens[col]) + offset;
                if (subCount < 0 || pos + 1 + subCount > rest.length) {
                  valid = false;
                  break;
                }
                blocks.push(rest.slice(pos, pos + 1 + subCount));
                pos += 1 + subCount;
              }
              if (valid && pos === rest.length && !(T === 1 && !cppHint.hasT && looksLikeSingleVariableCase(lines))) {
                return { hasT: true, blocks };
              }
            }
          }
        }

        // 2. Fixed-length block rule
        if (rest.length % T === 0) {
          const linesPerBlock = rest.length / T;
          const allowFixed =
            linesPerBlock >= 2 ||
            (cppHint && cppHint.hasT === true) ||
            (T >= 2 && linesPerBlock === 1 && rest[0].tokens.length === 1);
          if (allowFixed) {
            const blocks = [];
            for (let tc = 0; tc < T; tc++) {
              blocks.push(rest.slice(tc * linesPerBlock, (tc + 1) * linesPerBlock));
            }
            return { hasT: true, blocks };
          }
        }
      }
    }

    return { hasT: false, blocks: [lines] };
  }

  function learnHeaderSublinesBlock(blocks) {
    const firstHeader = blocks[0][0].tokens;
    const K = firstHeader.length;
    if (K < 1 || K > 4) return null;

    for (const b of blocks) {
      if (b.length < 2 || b[0].tokens.length !== K || !b[0].tokens.every(isIntToken)) {
        return null;
      }
    }

    // Try finding (refCol, offset) where b.length - 1 === b[0][refCol] + offset across all blocks
    let matchedRule = null;
    for (let col = 0; col < K; col++) {
      for (const offset of [0, -1]) {
        const ok = blocks.every((b) => Number(b[0].tokens[col]) + offset === b.length - 1);
        if (ok) {
          // Avoid stealing 2-line [n, array_of_n] or [1, single_val] blocks as header + 1 subline
          if (blocks.every((b) => b.length === 2 && K === 1 && b[1].tokens.length === 1)) {
            continue;
          }
          if (blocks.every((b) => b.length === 2 && b[1].tokens.length === Number(b[0].tokens[0]) && Number(b[0].tokens[0]) !== 1)) {
            continue;
          }
          if (blocks.every((b) => b.length === 2) && blocks.some((b) => b[1].tokens.length > 3)) {
            continue;
          }
          matchedRule = { refCol: col, offset };
          break;
        }
      }
      if (matchedRule) break;
    }
    if (!matchedRule) return null;

    const headerSpecs = [];
    for (let col = 0; col < K; col++) {
      const vals = blocks.map((b) => Number(b[0].tokens[col]));
      const minObs = Math.min(...vals);
      const maxObs = Math.max(...vals);
      const isCountCol = col === matchedRule.refCol || (matchedRule.refCol === 1 && col === 0);
      const spec = {
        min: isCountCol ? Math.max(minObs >= 2 ? 2 : 1, Math.min(minObs, 2)) : (minObs >= 1 ? 1 : minObs === 0 ? 0 : Math.min(minObs, -10)),
        max: isCountCol ? Math.min(Math.max(maxObs, 6), 9) : Math.max(maxObs, 10),
        clampMaxCol: null,
      };
      if (col > 0 && blocks.every((b) => Number(b[0].tokens[col]) >= 0 && Number(b[0].tokens[col]) <= Number(b[0].tokens[0]))) {
        spec.clampMaxCol = 0;
      }
      headerSpecs.push(spec);
    }

    const subLines = [];
    for (const b of blocks) {
      for (let r = 1; r < b.length; r++) subLines.push(b[r]);
    }
    if (subLines.length === 0) return null;

    const allSubSingleStr = subLines.every((l) => l.tokens.length === 1 && (!isIntToken(l.tokens[0]) || /^[01]+$/.test(l.tokens[0])));
    const firstTokCount = subLines[0].tokens.length;
    const allSubSameIntLen = subLines.every((l) => l.tokens.length === firstTokCount && l.tokens.every(isIntToken));

    // Tree check
    if (matchedRule.offset === -1 && matchedRule.refCol === 0 && allSubSameIntLen && (firstTokCount === 2 || firstTokCount === 3)) {
      const allUV = [];
      const allW = [];
      let validTree = true;
      for (const b of blocks) {
        const n = Number(b[0].tokens[0]);
        for (let r = 1; r < b.length; r++) {
          const u = Number(b[r].tokens[0]);
          const v = Number(b[r].tokens[1]);
          if (u === v || u < 0 || v < 0 || u > n || v > n) validTree = false;
          allUV.push(u, v);
          if (firstTokCount === 3) allW.push(Number(b[r].tokens[2]));
        }
      }
      if (validTree) {
        const minUV = Math.min(...allUV);
        const wMin = allW.length ? Math.min(...allW) : 1;
        const wMax = allW.length ? Math.max(...allW) : 20;
        return {
          mode: 'header_sublines',
          headerSpecs,
          refCol: matchedRule.refCol,
          offset: matchedRule.offset,
          body: {
            kind: 'tree',
            indexBase: minUV === 0 ? 0 : 1,
            weighted: firstTokCount === 3,
            wMin: wMin >= 1 ? 1 : wMin === 0 ? 0 : Math.min(wMin, -10),
            wMax: Math.max(wMax, 15),
          },
        };
      }
    }

    // Graph or Pairs check
    if (allSubSameIntLen && (firstTokCount === 2 || firstTokCount === 3)) {
      const allUV = [];
      const allW = [];
      let allGraphNodes = K >= 2 && matchedRule.refCol === 1;
      let allOrdered = true;
      for (const b of blocks) {
        const n = Number(b[0].tokens[0]);
        for (let r = 1; r < b.length; r++) {
          const u = Number(b[r].tokens[0]);
          const v = Number(b[r].tokens[1]);
          if (u === v || u < 0 || v < 0 || u > n || v > n) allGraphNodes = false;
          if (u > v) allOrdered = false;
          allUV.push(u, v);
          if (firstTokCount === 3) allW.push(Number(b[r].tokens[2]));
        }
      }
      const minUV = Math.min(...allUV);
      const maxUV = Math.max(...allUV);
      const wMin = allW.length ? Math.min(...allW) : 1;
      const wMax = allW.length ? Math.max(...allW) : 20;

      if (allGraphNodes) {
        headerSpecs[0].min = Math.max(2, headerSpecs[0].min);
        headerSpecs[0].max = Math.min(7, Math.max(headerSpecs[0].min, headerSpecs[0].max));
        headerSpecs[1].clampMaxCol = null;
        return {
          mode: 'header_sublines',
          headerSpecs,
          refCol: matchedRule.refCol,
          offset: matchedRule.offset,
          body: {
            kind: 'graph',
            indexBase: minUV === 0 ? 0 : 1,
            weighted: firstTokCount === 3,
            wMin: wMin >= 1 ? 1 : wMin === 0 ? 0 : Math.min(wMin, -10),
            wMax: Math.max(wMax, 15),
          },
        };
      }

      const maxN = Math.max(...blocks.map((b) => Number(b[0].tokens[0])));
      return {
        mode: 'header_sublines',
        headerSpecs,
        refCol: matchedRule.refCol,
        offset: matchedRule.offset,
        body: {
          kind: 'pairs',
          cols: firstTokCount,
          ordered: firstTokCount === 2 && allOrdered,
          boundedByN: minUV >= 1 && maxUV <= maxN,
          min: minUV >= 1 ? 1 : minUV === 0 ? 0 : Math.min(minUV, -10),
          max: Math.max(maxUV, 15),
          wMin: wMin >= 1 ? 1 : wMin === 0 ? 0 : Math.min(wMin, -10),
          wMax: Math.max(wMax, 15),
        },
      };
    }

    // Matrix check (char grid or int grid)
    if (allSubSingleStr && (!subLines[0].tokens.every(isIntToken) || K >= 2)) {
      const strs = subLines.map((l) => l.tokens[0]);
      const colsCol = K >= 2 && blocks.every((b) => b[1].tokens[0].length === Number(b[0].tokens[1])) ? 1 : null;
      return {
        mode: 'header_sublines',
        headerSpecs,
        refCol: matchedRule.refCol,
        offset: matchedRule.offset,
        body: {
          kind: 'char_matrix',
          colsCol,
          fixedCols: strs[0].length,
          alphabet: inferAlphabet(strs),
        },
      };
    }

    if (allSubSameIntLen) {
      const vals = subLines.flatMap((l) => l.tokens.map(Number));
      const minV = Math.min(...vals);
      const maxV = Math.max(...vals);
      const colsCol = K >= 2 && blocks.every((b) => b[1].tokens.length === Number(b[0].tokens[1])) ? 1 : null;
      return {
        mode: 'header_sublines',
        headerSpecs,
        refCol: matchedRule.refCol,
        offset: matchedRule.offset,
        body: {
          kind: 'int_matrix',
          colsCol,
          fixedCols: firstTokCount,
          min: minV >= 1 ? 1 : minV === 0 ? 0 : Math.min(minV, -10),
          max: maxV <= 1 && minV >= 0 && vals.length >= 4 ? 1 : Math.max(maxV, 9),
        },
      };
    }

    return null;
  }

  function learnFromSample(sampleText, cppCode = '') {
    const lines = parseSampleLines(sampleText);
    const hasCppCode = Boolean(cppCode && cppCode.trim().length > 0);
    const cppHint = parseCppInput(cppCode);
    const cppHasString = /\b(?:string|char)\b/.test(cppCode || '');

    if (lines.length === 0) {
      return { mode: 'schema', schema: cppHint };
    }

    const split = splitSampleIntoBlocks(lines, cppHint, hasCppCode);
    const blocks = split.blocks;

    // Check if header + variable sub-lines structure fits
    const headerModel = learnHeaderSublinesBlock(blocks);
    if (headerModel) {
      return {
        ...headerModel,
        hasT: split.hasT,
        tMin: 1,
        tMax: 3,
      };
    }

    // Uniform line-by-line analysis across blocks
    const maxLineCount = Math.max(...blocks.map((b) => b.length));
    const lineSpecs = [];
    const scalarHistory = []; // { lineIdx, colIdx, values, spec }

    for (let li = 0; li < maxLineCount; li++) {
      const samplesForLine = blocks.map((b) => b[Math.min(li, b.length - 1)]);
      const singleTokEach = samplesForLine.every((l) => l.tokens.length === 1);

      // Find if a prior scalar matches string length / array length across all blocks
      const matchingStrLenScalar = singleTokEach
        ? scalarHistory.find((s) => s.values.every((v, bi) => v === samplesForLine[bi].tokens[0].length))
        : null;

      const hasNonInt = samplesForLine.some((l) => l.tokens.some((t) => !isIntToken(t) && !isFloatToken(t)));
      const hasBinaryStr =
        singleTokEach &&
        samplesForLine.some((l, bi) => {
          const tok = l.tokens[0];
          const expLen = matchingStrLenScalar ? matchingStrLenScalar.values[bi] : null;
          return /^[01]+$/.test(tok) && ((tok.length >= 2 && /^0/.test(tok)) || (expLen !== null && tok.length === expLen && cppHasString));
        });

      if (singleTokEach && (hasNonInt || hasBinaryStr)) {
        const strs = samplesForLine.map((l) => l.tokens[0]);
        if (matchingStrLenScalar) {
          matchingStrLenScalar.isSizeScalar = true;
        }
        const lens = strs.map((s) => s.length);
        lineSpecs.push({
          kind: 'string',
          lenScalarRef: matchingStrLenScalar ? { lineIdx: matchingStrLenScalar.lineIdx, colIdx: matchingStrLenScalar.colIdx } : null,
          minLen: Math.max(1, Math.min(...lens)),
          maxLen: Math.min(10, Math.max(...lens, 5)),
          alphabet: inferAlphabet(strs),
        });
        continue;
      }

      const hasFloat = samplesForLine.some((l) => l.tokens.some(isFloatToken));
      if (hasFloat) {
        const tokCounts = samplesForLine.map((l) => l.tokens.length);
        const allNums = samplesForLine.flatMap((l) => l.tokens.map(Number));
        const minV = Math.min(...allNums);
        const maxV = Math.max(...allNums);
        const maxFrac = Math.max(
          ...samplesForLine.flatMap((l) => l.tokens.map((t) => (t.includes('.') ? t.split('.')[1].length : 0)))
        );
        const matchingArrScalar = scalarHistory.find((s) => s.values.every((v, bi) => v === tokCounts[bi]));
        if (matchingArrScalar) matchingArrScalar.isSizeScalar = true;
        lineSpecs.push({
          kind: 'float_array',
          count: tokCounts[0],
          lenScalarRef: matchingArrScalar ? { lineIdx: matchingArrScalar.lineIdx, colIdx: matchingArrScalar.colIdx } : null,
          min: minV >= 0 ? 0 : Math.min(minV, -10),
          max: Math.max(maxV, 10),
          precision: Math.min(6, Math.max(2, maxFrac)),
        });
        continue;
      }

      const tokCounts = samplesForLine.map((l) => l.tokens.length);
      const sameCount = tokCounts.every((c) => c === tokCounts[0]);
      const matchingArrScalar =
        li > 0 ? scalarHistory.find((s) => s.values.every((v, bi) => v === tokCounts[bi])) : null;

      if (!sameCount || (matchingArrScalar && tokCounts[0] >= 1) || tokCounts[0] > 4) {
        if (matchingArrScalar) {
          matchingArrScalar.isSizeScalar = true;
        }
        const allVals = samplesForLine.flatMap((l) => l.tokens.map(Number));
        const minObs = Math.min(...allVals);
        const maxObs = Math.max(...allVals);

        let subtype = 'random';
        const hasLen2Plus = samplesForLine.some((l) => l.tokens.length >= 2);
        const allIdentity1 = samplesForLine.every((l) => l.tokens.map(Number).every((v, idx) => v === idx + 1));
        const allIdentity0 = samplesForLine.every((l) => l.tokens.map(Number).every((v, idx) => v === idx));
        if (hasLen2Plus && samplesForLine.every((l) => isPermutationValues(l.tokens.map(Number), 1)) && !(samplesForLine.length === 1 && allIdentity1)) {
          subtype = 'permutation';
        } else if (hasLen2Plus && samplesForLine.every((l) => isPermutationValues(l.tokens.map(Number), 0)) && !(samplesForLine.length === 1 && allIdentity0)) {
          subtype = 'permutation_0';
        }

        let min = minObs >= 1 ? 1 : minObs === 0 ? 0 : Math.min(minObs, -10);
        let max = maxObs <= 1 && minObs >= 0 && allVals.length >= 3 ? 1 : Math.max(maxObs, 10);

        lineSpecs.push({
          kind: 'array',
          subtype,
          lenScalarRef: matchingArrScalar ? { lineIdx: matchingArrScalar.lineIdx, colIdx: matchingArrScalar.colIdx } : null,
          minLen: Math.max(1, Math.min(...tokCounts)),
          maxLen: Math.min(10, Math.max(...tokCounts, 6)),
          min,
          max,
        });
        continue;
      }

      // Fixed-count scalar line
      const K = tokCounts[0];
      const cols = [];
      for (let c = 0; c < K; c++) {
        const vals = samplesForLine.map((l) => Number(l.tokens[c]));
        const minObs = Math.min(...vals);
        const maxObs = Math.max(...vals);
        const colSpec = {
          min: minObs >= 1 ? 1 : minObs === 0 ? 0 : Math.min(minObs, -10),
          max: maxObs <= 1 && minObs >= 0 && vals.length >= 3 ? 1 : Math.max(maxObs, 10),
          minObs,
          maxObs,
          clampMaxRef: null,
        };
        if (c > 0 && samplesForLine.every((l) => Number(l.tokens[c]) >= 0 && Number(l.tokens[c]) <= Number(l.tokens[0]))) {
          colSpec.clampMaxRef = { lineIdx: li, colIdx: 0 };
        }
        cols.push(colSpec);
        scalarHistory.push({ lineIdx: li, colIdx: c, values: vals, spec: colSpec, isSizeScalar: false });
      }
      lineSpecs.push({ kind: 'scalars', cols });
    }

    // Refine size scalars to compact stress-testing bounds
    for (const s of scalarHistory) {
      if (s.isSizeScalar) {
        const minSize = s.spec.minObs >= 2 ? 2 : 1;
        const maxSize = Math.min(10, Math.max(s.spec.maxObs, 6));
        s.spec.min = minSize;
        s.spec.max = Math.max(minSize, maxSize);
      }
    }

    return {
      mode: 'uniform_lines',
      hasT: split.hasT,
      tMin: 1,
      tMax: 3,
      lines: lineSpecs,
    };
  }

  function generateFromSampleBlock(model, rng) {
    if (model.mode === 'header_sublines') {
      const headerVals = [];
      for (let c = 0; c < model.headerSpecs.length; c++) {
        const spec = model.headerSpecs[c];
        let lo = spec.min;
        let hi = spec.max;
        if (spec.clampMaxCol !== null && headerVals[spec.clampMaxCol] !== undefined) {
          hi = Math.min(hi, headerVals[spec.clampMaxCol]);
          if (lo > hi) lo = hi;
        }
        if (model.body.kind === 'graph' && c === 1 && headerVals[0] !== undefined) {
          const n = headerVals[0];
          const maxE = Math.floor((n * (n - 1)) / 2);
          lo = Math.max(lo, n - 1);
          hi = Math.max(lo, Math.min(hi, maxE));
        }
        headerVals.push(rng.nextInt(lo, hi));
      }

      const out = [headerVals.join(' ')];
      const subCount = Math.max(0, headerVals[model.refCol] + model.offset);
      const b = model.body;

      if (b.kind === 'tree') {
        const edges = generateTreeEdges(headerVals[0], b.indexBase, b.weighted, b.wMin, b.wMax, rng);
        for (const e of edges) out.push(e.join(' '));
      } else if (b.kind === 'graph') {
        const edges = generateGraphEdges(headerVals[0], headerVals[1], b.indexBase, b.weighted, b.wMin, b.wMax, rng);
        for (const e of edges) out.push(e.join(' '));
      } else if (b.kind === 'pairs') {
        const hiVal = b.boundedByN ? headerVals[0] : b.max;
        for (let i = 0; i < subCount; i++) {
          let u = rng.nextInt(b.min, hiVal);
          let v = rng.nextInt(b.min, hiVal);
          if (b.ordered && u > v) {
            const tmp = u;
            u = v;
            v = tmp;
          }
          if (b.cols === 3) {
            out.push(`${u} ${v} ${rng.nextInt(b.wMin, b.wMax)}`);
          } else {
            out.push(`${u} ${v}`);
          }
        }
      } else if (b.kind === 'char_matrix') {
        const cols = b.colsCol !== null ? headerVals[b.colsCol] : b.fixedCols;
        for (let r = 0; r < subCount; r++) {
          let rowStr = '';
          for (let c = 0; c < cols; c++) {
            rowStr += b.alphabet[rng.nextInt(0, b.alphabet.length - 1)];
          }
          out.push(rowStr);
        }
      } else if (b.kind === 'int_matrix') {
        const cols = b.colsCol !== null ? headerVals[b.colsCol] : b.fixedCols;
        for (let r = 0; r < subCount; r++) {
          const row = [];
          for (let c = 0; c < cols; c++) row.push(rng.nextInt(b.min, b.max));
          out.push(row.join(' '));
        }
      }

      return out.join('\n') + '\n';
    }

    // uniform_lines
    const scalarVals = {}; // "lineIdx:colIdx" -> val
    const out = [];

    for (let li = 0; li < model.lines.length; li++) {
      const line = model.lines[li];
      if (line.kind === 'scalars') {
        const row = [];
        for (let ci = 0; ci < line.cols.length; ci++) {
          const colSpec = line.cols[ci];
          let lo = colSpec.min;
          let hi = colSpec.max;
          if (colSpec.clampMaxRef) {
            const refKey = `${colSpec.clampMaxRef.lineIdx}:${colSpec.clampMaxRef.colIdx}`;
            if (scalarVals[refKey] !== undefined) {
              hi = Math.min(hi, scalarVals[refKey]);
              if (lo > hi) lo = hi;
            }
          }
          const v = rng.nextInt(lo, hi);
          scalarVals[`${li}:${ci}`] = v;
          row.push(v);
        }
        out.push(row.join(' '));
      } else if (line.kind === 'string') {
        const refVal = line.lenScalarRef
          ? scalarVals[`${line.lenScalarRef.lineIdx}:${line.lenScalarRef.colIdx}`]
          : undefined;
        const len = Math.max(1, refVal !== undefined ? refVal : rng.nextInt(line.minLen, line.maxLen));
        let s = '';
        for (let k = 0; k < len; k++) {
          s += line.alphabet[rng.nextInt(0, line.alphabet.length - 1)];
        }
        out.push(s);
      } else if (line.kind === 'array') {
        const refVal = line.lenScalarRef
          ? scalarVals[`${line.lenScalarRef.lineIdx}:${line.lenScalarRef.colIdx}`]
          : undefined;
        const len = Math.max(1, refVal !== undefined ? refVal : rng.nextInt(line.minLen, line.maxLen));
        const arr = [];
        if (line.subtype === 'permutation' || line.subtype === 'permutation_0') {
          const start = line.subtype === 'permutation_0' ? 0 : 1;
          for (let k = 0; k < len; k++) arr.push(start + k);
          rng.shuffle(arr);
        } else {
          for (let k = 0; k < len; k++) arr.push(rng.nextInt(line.min, line.max));
        }
        out.push(arr.join(' '));
      } else if (line.kind === 'float_array') {
        const refVal = line.lenScalarRef
          ? scalarVals[`${line.lenScalarRef.lineIdx}:${line.lenScalarRef.colIdx}`]
          : undefined;
        const len = Math.max(1, refVal !== undefined ? refVal : line.count);
        const arr = [];
        for (let k = 0; k < len; k++) {
          const val = line.min + rng.nextFloat() * (line.max - line.min);
          arr.push(val.toFixed(line.precision));
        }
        out.push(arr.join(' '));
      }
    }

    return out.join('\n') + '\n';
  }

  function generateFromSampleModel(model, seed = 1) {
    if (!model) return '';
    if (model.mode === 'schema') {
      return generateInputFromSchema(model.schema, seed);
    }
    const rng = createRng(seed);
    if (model.hasT) {
      const t = rng.nextInt(Number(model.tMin ?? 1), Number(model.tMax ?? 3));
      const parts = [String(t)];
      for (let tc = 0; tc < t; tc++) {
        parts.push(generateFromSampleBlock(model, rng).trimEnd());
      }
      return parts.join('\n') + '\n';
    }
    return generateFromSampleBlock(model, rng);
  }

  const api = {
    createRng,
    generateInputFromSchema,
    parseCppInput,
    learnFromSample,
    generateFromSampleModel,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.SchemaEngine = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
