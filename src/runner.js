const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { compareTokens, compareFloats, compareExact } = require('./comparators');
const { generateInputFromSchema, learnFromSample, generateFromSampleModel } = require('../public/schemaEngine');

const CACHE_DIR = path.join(os.tmpdir(), 'stresstest-cp-cache');
const INCLUDE_DIR = path.resolve(__dirname, '..', 'include');
const ALLOWED_STDS = new Set(['gnu++17', 'gnu++20', 'gnu++23']);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB cap per stream

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Raise stack limit to unlimited so child C++ processes can recurse deeply without segfaulting.
try {
  execFileSync('prlimit', ['--pid', String(process.pid), '--stack=unlimited:unlimited']);
} catch {
  try {
    execFileSync('prlimit', ['--pid', String(process.pid), '--stack=unlimited']);
  } catch {
    // Ignore if environment forbids raising stack limit
  }
}

const inflightCompiles = new Map();

function createSession() {
  return {
    aborted: false,
    activeChildren: new Set(),
  };
}

function abortSession(session) {
  if (!session || session.aborted) return;
  session.aborted = true;
  for (const child of session.activeChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already have exited
    }
  }
  session.activeChildren.clear();
}

function normalizeStd(cppStd) {
  return ALLOWED_STDS.has(cppStd) ? cppStd : 'gnu++20';
}

/**
 * Compile C++ source with content-addressed binary caching.
 */
function compileCpp(code, { cppStd = 'gnu++20', sanitize = false }, session) {
  const std = normalizeStd(cppStd);
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ code, std, sanitize: Boolean(sanitize), includeDir: INCLUDE_DIR }))
    .digest('hex');

  const binPath = path.join(CACHE_DIR, `${hash}.bin`);
  if (fs.existsSync(binPath)) {
    return Promise.resolve({ ok: true, binPath, cached: true });
  }

  if (inflightCompiles.has(hash)) {
    return inflightCompiles.get(hash);
  }

  const compilePromise = new Promise((resolve) => {
    const nonce = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const srcPath = path.join(CACHE_DIR, `${hash}_${nonce}.cpp`);
    const tmpBinPath = path.join(CACHE_DIR, `${hash}_${nonce}.bin.tmp`);

    fs.writeFileSync(srcPath, code, 'utf8');

    const args = ['-O2', `-std=${std}`, `-I${INCLUDE_DIR}`, '-Wno-unused-result', srcPath, '-o', tmpBinPath];
    if (sanitize) {
      args.push('-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g', '-D_GLIBCXX_DEBUG');
    }

    const child = spawn('g++', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    session.activeChildren.add(child);

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });

    const cleanupTemp = () => {
      try { fs.unlinkSync(srcPath); } catch {}
      try { fs.unlinkSync(tmpBinPath); } catch {}
    };

    child.on('error', (err) => {
      session.activeChildren.delete(child);
      cleanupTemp();
      resolve({ ok: false, stderr: `Failed to invoke g++: ${err.message}` });
    });

    child.on('close', (codeExit) => {
      session.activeChildren.delete(child);
      if (codeExit === 0 && fs.existsSync(tmpBinPath)) {
        try {
          fs.renameSync(tmpBinPath, binPath);
          try { fs.unlinkSync(srcPath); } catch {}
          resolve({ ok: true, binPath, cached: false });
          return;
        } catch (err) {
          cleanupTemp();
          resolve({ ok: false, stderr: `Failed to store compiled binary: ${err.message}` });
          return;
        }
      }
      cleanupTemp();
      resolve({
        ok: false,
        stderr: stderr || stdout || `g++ exited with code ${codeExit}`,
      });
    });
  }).finally(() => {
    inflightCompiles.delete(hash);
  });

  inflightCompiles.set(hash, compilePromise);
  return compilePromise;
}

/**
 * Execute a compiled binary with timeout, output cap, and session tracking.
 */
function runBinary(binPath, args, inputText, timeoutMs, session) {
  return new Promise((resolve) => {
    if (session.aborted) {
      resolve({ exitCode: null, signal: 'SIGKILL', timedOut: false, aborted: true, stdout: '', stderr: '', timeMs: 0 });
      return;
    }

    const startNs = process.hrtime.bigint();
    const child = spawn(binPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ASAN_OPTIONS: 'detect_leaks=0',
      },
    });
    session.activeChildren.add(child);

    let stdoutChunks = [];
    let stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
        if (chunk.length > remaining) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
        if (chunk.length > remaining) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE when child exits before consuming all stdin
    });

    if (inputText && inputText.length > 0) {
      child.stdin.write(inputText);
    }
    child.stdin.end();

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.activeChildren.delete(child);
      const timeMs = Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
      resolve({
        exitCode: -1,
        signal: null,
        timedOut: false,
        aborted: session.aborted,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `Execution error: ${err.message}`,
        timeMs,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.activeChildren.delete(child);
      const timeMs = Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);

      let stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdoutTruncated) stdout += '\n...[output truncated at 2MB]';
      if (stderrTruncated) stderr += '\n...[stderr truncated at 2MB]';

      resolve({
        exitCode,
        signal,
        timedOut,
        aborted: session.aborted,
        stdout,
        stderr,
        timeMs,
      });
    });
  });
}

async function evaluateOutput({ comparator, expected, actual, input, checkerBin, checkerWorkDir, session }) {
  if (comparator === 'custom') {
    const inputPath = path.join(checkerWorkDir, 'input.txt');
    const actualPath = path.join(checkerWorkDir, 'actual.txt');
    const expectedPath = path.join(checkerWorkDir, 'expected.txt');

    fs.writeFileSync(inputPath, input, 'utf8');
    fs.writeFileSync(actualPath, actual, 'utf8');
    fs.writeFileSync(expectedPath, expected || '', 'utf8');

    const chkRes = await runBinary(checkerBin, [inputPath, actualPath, expectedPath], '', 5000, session);
    if (chkRes.aborted) {
      return { ok: false, aborted: true };
    }
    const msg = (chkRes.stderr || chkRes.stdout || '').trim();
    if (chkRes.timedOut) {
      return { ok: false, reason: 'Custom checker timed out (>5000ms)' };
    }
    if (chkRes.exitCode !== 0 || chkRes.signal) {
      return {
        ok: false,
        reason: msg || `Checker failed (exit code ${chkRes.exitCode ?? chkRes.signal})`,
      };
    }
    return { ok: true, reason: msg || 'Checker passed (_ok)' };
  }

  if (comparator === 'float_1e6') return compareFloats(expected, actual, 1e-6);
  if (comparator === 'float_1e9') return compareFloats(expected, actual, 1e-9);
  if (comparator === 'exact') return compareExact(expected, actual);
  return compareTokens(expected, actual);
}

/**
 * Compile required sources and execute the stress-testing loop.
 */
async function runStressTest(config, session, emit) {
  const solutionCode = String(config.solutionCode || '');
  const bruteCode = String(config.correctCode ?? config.bruteCode ?? '');
  const generatorCode = String(config.generatorCode || '');
  const checkerCode = String(config.checkerCode || '');
  const sampleInput = String(config.sampleInput || '');
  const hasSample = sampleInput.trim().length > 0;
  const genMode = config.genMode
    ? (config.genMode === 'cpp' ? 'cpp' : 'schema')
    : (hasSample || config.inputSchema ? 'schema' : 'cpp');
  const inputSchema = config.inputSchema || null;

  const cppStd = normalizeStd(config.cppStd);
  const sanitize = Boolean(config.sanitize);
  const comparator = config.comparator || 'token';
  const maxTests = Math.min(100000, Math.max(1, Math.floor(Number(config.maxTests) || 500)));
  const timeLimitMs = Math.min(15000, Math.max(50, Math.floor(Number(config.timeLimitMs) || 1000)));
  const baseSeed = Number.isFinite(Number(config.baseSeed))
    ? Math.floor(Number(config.baseSeed))
    : Math.floor(Date.now() % 1000000000);

  const needBrute = comparator !== 'custom' || bruteCode.trim().length > 0;
  const needChecker = comparator === 'custom';

  if (!solutionCode.trim()) {
    emit({ type: 'verdict', verdict: 'CE', failedFile: 'solution.cpp', reason: 'solution.cpp is empty', compilerOutput: 'solution.cpp cannot be empty.' });
    return;
  }
  if (genMode === 'cpp' && !generatorCode.trim()) {
    emit({ type: 'verdict', verdict: 'CE', failedFile: 'generator.cpp', reason: 'generator.cpp is empty', compilerOutput: 'generator.cpp cannot be empty when generator.cpp mode is active.' });
    return;
  }
  if (genMode === 'schema' && !hasSample && (!inputSchema || !Array.isArray(inputSchema.fields) || inputSchema.fields.length === 0)) {
    emit({ type: 'verdict', verdict: 'GEN_ERROR', testNum: 0, reason: 'Provide a Sample Input or an Input Schema to generate tests.' });
    return;
  }
  if (needBrute && !bruteCode.trim()) {
    emit({ type: 'verdict', verdict: 'CE', failedFile: 'correct.cpp', reason: 'correct.cpp is empty', compilerOutput: 'correct.cpp cannot be empty unless using a Custom Checker.' });
    return;
  }
  if (needChecker && !checkerCode.trim()) {
    emit({ type: 'verdict', verdict: 'CE', failedFile: 'checker.cpp', reason: 'checker.cpp is empty', compilerOutput: 'checker.cpp cannot be empty when Custom Checker is selected.' });
    return;
  }

  emit({ type: 'status', phase: 'COMPILING', message: `Compiling C++ sources (${cppStd}${sanitize ? ', ASan+UBSan' : ''})...` });

  const compileJobs = [
    { file: 'solution.cpp', promise: compileCpp(solutionCode, { cppStd, sanitize }, session) },
  ];
  if (genMode === 'cpp') {
    compileJobs.push({ file: 'generator.cpp', promise: compileCpp(generatorCode, { cppStd, sanitize }, session) });
  }
  if (needBrute) {
    compileJobs.push({ file: 'correct.cpp', promise: compileCpp(bruteCode, { cppStd, sanitize }, session) });
  }
  if (needChecker) {
    compileJobs.push({ file: 'checker.cpp', promise: compileCpp(checkerCode, { cppStd, sanitize: false }, session) });
  }

  const results = await Promise.all(compileJobs.map(async (job) => ({ file: job.file, res: await job.promise })));

  if (session.aborted) {
    emit({ type: 'verdict', verdict: 'STOPPED', testNum: 0, reason: 'Stopped during compilation' });
    return;
  }

  const failedCompile = results.find((item) => !item.res.ok);
  if (failedCompile) {
    emit({
      type: 'verdict',
      verdict: 'CE',
      failedFile: failedCompile.file,
      reason: `Compilation Error in ${failedCompile.file}`,
      compilerOutput: failedCompile.res.stderr,
    });
    return;
  }

  const bins = Object.fromEntries(results.map((item) => [item.file, item.res.binPath]));
  const genBin = bins['generator.cpp'] || null;
  const solBin = bins['solution.cpp'];
  const bruteBin = bins['correct.cpp'] || null;
  const chkBin = bins['checker.cpp'] || null;

  let checkerWorkDir = null;
  if (needChecker) {
    checkerWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stresstest-chk-'));
  }

  const loopStart = Date.now();
  let lastEmit = 0;
  let maxSolTimeMs = 0;
  let lastInput = '';
  let lastExpected = '';
  let lastActual = '';

  const sampleModel = (genMode === 'schema' && hasSample)
    ? learnFromSample(sampleInput, solutionCode || bruteCode)
    : null;

  try {
    emit({ type: 'status', phase: 'RUNNING', message: `Running up to ${maxTests} tests...` });

    for (let testNum = 1; testNum <= maxTests; testNum++) {
      if (session.aborted) {
        emit({
          type: 'verdict',
          verdict: 'STOPPED',
          testNum: testNum - 1,
          elapsedMs: Date.now() - loopStart,
          reason: `Stopped by user after ${testNum - 1} tests`,
        });
        return;
      }

      let input = '';
      if (genMode === 'schema') {
        if (sampleModel) {
          input = testNum === 1 ? sampleInput.trim() + '\n' : generateFromSampleModel(sampleModel, baseSeed + testNum);
        } else {
          input = generateInputFromSchema(inputSchema, baseSeed + testNum);
        }
      } else {
        const seed = String(baseSeed + testNum);
        const genRes = await runBinary(genBin, [seed, String(testNum)], '', 5000, session);

        if (session.aborted || genRes.aborted) {
          emit({
            type: 'verdict',
            verdict: 'STOPPED',
            testNum: testNum - 1,
            elapsedMs: Date.now() - loopStart,
            reason: `Stopped by user at test #${testNum}`,
          });
          return;
        }

        if (genRes.timedOut || genRes.exitCode !== 0 || genRes.signal) {
          emit({
            type: 'verdict',
            verdict: 'GEN_ERROR',
            testNum,
            reason: genRes.timedOut
              ? `Generator timed out on test #${testNum}`
              : `Generator failed on test #${testNum} (${genRes.signal || 'Exit ' + genRes.exitCode})`,
            stderr: genRes.stderr || genRes.stdout,
          });
          return;
        }
        input = genRes.stdout;
      }
      const bruteTimeoutMs = Math.max(timeLimitMs * 4, 5000);

      const [solRes, bruteRes] = await Promise.all([
        runBinary(solBin, [], input, timeLimitMs, session),
        bruteBin ? runBinary(bruteBin, [], input, bruteTimeoutMs, session) : Promise.resolve(null),
      ]);

      if (session.aborted || solRes.aborted || (bruteRes && bruteRes.aborted)) {
        emit({
          type: 'verdict',
          verdict: 'STOPPED',
          testNum: testNum - 1,
          elapsedMs: Date.now() - loopStart,
          reason: `Stopped by user at test #${testNum}`,
        });
        return;
      }

      if (solRes.timeMs > maxSolTimeMs) maxSolTimeMs = solRes.timeMs;

      const expected = bruteRes ? bruteRes.stdout : '';
      const actual = solRes.stdout;

      if (solRes.timedOut) {
        emit({
          type: 'verdict',
          verdict: 'TLE',
          testNum,
          timeMs: solRes.timeMs,
          maxSolTimeMs,
          elapsedMs: Date.now() - loopStart,
          input,
          expected,
          actual,
          stderr: solRes.stderr,
          reason: `Time Limit Exceeded on Test #${testNum} (>${timeLimitMs}ms)`,
        });
        return;
      }

      if (solRes.exitCode !== 0 || solRes.signal) {
        emit({
          type: 'verdict',
          verdict: 'RE',
          testNum,
          timeMs: solRes.timeMs,
          maxSolTimeMs,
          elapsedMs: Date.now() - loopStart,
          input,
          expected,
          actual,
          stderr: solRes.stderr,
          reason: `Runtime Error on Test #${testNum} (${solRes.signal || 'Exit code ' + solRes.exitCode})`,
        });
        return;
      }

      if (bruteRes && (bruteRes.timedOut || bruteRes.exitCode !== 0 || bruteRes.signal)) {
        emit({
          type: 'verdict',
          verdict: 'BRUTE_ERROR',
          testNum,
          elapsedMs: Date.now() - loopStart,
          input,
          expected,
          actual,
          stderr: bruteRes.stderr || (bruteRes.timedOut ? 'Brute force timed out' : `Exit code ${bruteRes.exitCode}`),
          reason: bruteRes.timedOut
            ? `Brute force timed out on Test #${testNum} (>${bruteTimeoutMs}ms)`
            : `Brute force crashed on Test #${testNum} (${bruteRes.signal || 'Exit code ' + bruteRes.exitCode})`,
        });
        return;
      }

      const cmp = await evaluateOutput({
        comparator,
        expected,
        actual,
        input,
        checkerBin: chkBin,
        checkerWorkDir,
        session,
      });

      if (cmp.aborted) {
        emit({
          type: 'verdict',
          verdict: 'STOPPED',
          testNum: testNum - 1,
          elapsedMs: Date.now() - loopStart,
          reason: `Stopped by user at test #${testNum}`,
        });
        return;
      }

      if (!cmp.ok) {
        emit({
          type: 'verdict',
          verdict: 'WA',
          testNum,
          timeMs: solRes.timeMs,
          maxSolTimeMs,
          elapsedMs: Date.now() - loopStart,
          input,
          expected,
          actual,
          stderr: solRes.stderr,
          reason: `Wrong Answer on Test #${testNum} — ${cmp.reason}`,
          diff: cmp,
        });
        return;
      }

      lastInput = input;
      lastExpected = expected;
      lastActual = actual;

      const now = Date.now();
      if (testNum === 1 || testNum === maxTests || now - lastEmit >= 45) {
        lastEmit = now;
        const elapsedMs = now - loopStart;
        const testsPerSec = elapsedMs > 0 ? Math.round((testNum / elapsedMs) * 1000) : testNum;
        emit({
          type: 'progress',
          testNum,
          maxTests,
          elapsedMs,
          testsPerSec,
          lastTimeMs: solRes.timeMs,
          maxSolTimeMs,
        });
      }
    }

    const totalElapsed = Date.now() - loopStart;
    const testsPerSec = totalElapsed > 0 ? Math.round((maxTests / totalElapsed) * 1000) : maxTests;
    emit({
      type: 'verdict',
      verdict: 'PASSED',
      testNum: maxTests,
      maxTests,
      elapsedMs: totalElapsed,
      testsPerSec,
      maxSolTimeMs,
      input: lastInput,
      expected: lastExpected,
      actual: lastActual,
      reason: `Passed all ${maxTests} tests in ${(totalElapsed / 1000).toFixed(2)}s (peak ${maxSolTimeMs}ms)`,
    });
  } finally {
    if (checkerWorkDir) {
      try {
        fs.rmSync(checkerWorkDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * Compile and run solution (and optional brute/checker) once against custom input.
 */
async function runSingleTest(config, session) {
  const solutionCode = String(config.solutionCode || '');
  const bruteCode = String(config.correctCode ?? config.bruteCode ?? '');
  const checkerCode = String(config.checkerCode || '');
  const customInput = String(config.customInput ?? '');

  const cppStd = normalizeStd(config.cppStd);
  const sanitize = Boolean(config.sanitize);
  const comparator = config.comparator || 'token';
  const timeLimitMs = Math.min(15000, Math.max(50, Math.floor(Number(config.timeLimitMs) || 1000)));

  const needBrute = bruteCode.trim().length > 0;
  const needChecker = comparator === 'custom';

  if (!solutionCode.trim()) {
    return { verdict: 'CE', failedFile: 'solution.cpp', reason: 'solution.cpp is empty', compilerOutput: 'solution.cpp cannot be empty.' };
  }
  if (needChecker && !checkerCode.trim()) {
    return { verdict: 'CE', failedFile: 'checker.cpp', reason: 'checker.cpp is empty', compilerOutput: 'checker.cpp cannot be empty when Custom Checker is selected.' };
  }

  const compileJobs = [
    { file: 'solution.cpp', promise: compileCpp(solutionCode, { cppStd, sanitize }, session) },
  ];
  if (needBrute) {
    compileJobs.push({ file: 'correct.cpp', promise: compileCpp(bruteCode, { cppStd, sanitize }, session) });
  }
  if (needChecker) {
    compileJobs.push({ file: 'checker.cpp', promise: compileCpp(checkerCode, { cppStd, sanitize: false }, session) });
  }

  const results = await Promise.all(compileJobs.map(async (job) => ({ file: job.file, res: await job.promise })));
  const failedCompile = results.find((item) => !item.res.ok);
  if (failedCompile) {
    return {
      verdict: 'CE',
      failedFile: failedCompile.file,
      reason: `Compilation Error in ${failedCompile.file}`,
      compilerOutput: failedCompile.res.stderr,
    };
  }

  const bins = Object.fromEntries(results.map((item) => [item.file, item.res.binPath]));
  const solBin = bins['solution.cpp'];
  const bruteBin = bins['correct.cpp'] || null;
  const chkBin = bins['checker.cpp'] || null;

  const bruteTimeoutMs = Math.max(timeLimitMs * 4, 5000);
  const [solRes, bruteRes] = await Promise.all([
    runBinary(solBin, [], customInput, timeLimitMs, session),
    bruteBin ? runBinary(bruteBin, [], customInput, bruteTimeoutMs, session) : Promise.resolve(null),
  ]);

  const expected = bruteRes ? bruteRes.stdout : '';
  const actual = solRes.stdout;

  if (solRes.timedOut) {
    return {
      verdict: 'TLE',
      timeMs: solRes.timeMs,
      input: customInput,
      expected,
      actual,
      stderr: solRes.stderr,
      reason: `Time Limit Exceeded (>${timeLimitMs}ms)`,
    };
  }

  if (solRes.exitCode !== 0 || solRes.signal) {
    return {
      verdict: 'RE',
      timeMs: solRes.timeMs,
      input: customInput,
      expected,
      actual,
      stderr: solRes.stderr,
      reason: `Runtime Error (${solRes.signal || 'Exit code ' + solRes.exitCode})`,
    };
  }

  if (bruteRes && (bruteRes.timedOut || bruteRes.exitCode !== 0 || bruteRes.signal)) {
    return {
      verdict: 'BRUTE_ERROR',
      timeMs: solRes.timeMs,
      input: customInput,
      expected,
      actual,
      stderr: bruteRes.stderr || (bruteRes.timedOut ? 'Brute force timed out' : `Exit code ${bruteRes.exitCode}`),
      reason: bruteRes.timedOut
        ? `Brute force timed out (>${bruteTimeoutMs}ms)`
        : `Brute force crashed (${bruteRes.signal || 'Exit code ' + bruteRes.exitCode})`,
    };
  }

  if (!bruteBin && !needChecker) {
    return {
      verdict: 'PASSED',
      timeMs: solRes.timeMs,
      input: customInput,
      expected: '',
      actual,
      stderr: solRes.stderr,
      reason: `Executed solution.cpp in ${solRes.timeMs}ms (no brute.cpp provided to compare)`,
    };
  }

  let checkerWorkDir = null;
  try {
    if (needChecker) {
      checkerWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stresstest-single-'));
    }
    const cmp = await evaluateOutput({
      comparator,
      expected,
      actual,
      input: customInput,
      checkerBin: chkBin,
      checkerWorkDir,
      session,
    });

    if (!cmp.ok) {
      return {
        verdict: 'WA',
        timeMs: solRes.timeMs,
        input: customInput,
        expected,
        actual,
        stderr: solRes.stderr,
        reason: `Wrong Answer — ${cmp.reason}`,
        diff: cmp,
      };
    }

    return {
      verdict: 'PASSED',
      timeMs: solRes.timeMs,
      input: customInput,
      expected,
      actual,
      stderr: solRes.stderr,
      reason: `Accepted (${solRes.timeMs}ms) — ${cmp.reason}`,
    };
  } finally {
    if (checkerWorkDir) {
      try {
        fs.rmSync(checkerWorkDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = {
  createSession,
  abortSession,
  compileCpp,
  runBinary,
  runStressTest,
  runSingleTest,
};

