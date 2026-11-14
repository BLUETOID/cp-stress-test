(() => {
  const STORAGE_KEY = 'stresstest_cp_simple_v2';

  const DEFAULT_SAMPLE = `4
1 5 2 -3
`;

  const DEFAULT_SOLUTION = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    if (!(cin >> n)) return 0;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];

    sort(a.begin(), a.end());
    cout << a[n - 1] * a[n - 2] << "\\n";
    return 0;
}
`;

  const DEFAULT_CORRECT = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    if (!(cin >> n)) return 0;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];

    long long ans = LLONG_MIN;
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            ans = max(ans, a[i] * a[j]);
        }
    }
    cout << ans << "\\n";
    return 0;
}
`;

  const statusText = document.getElementById('statusText');
  const runBtn = document.getElementById('runBtn');
  const stopBtn = document.getElementById('stopBtn');
  const sampleInputEl = document.getElementById('sampleInput');
  const errorSection = document.getElementById('errorSection');
  const errorOut = document.getElementById('errorOut');
  const inputOut = document.getElementById('inputOut');
  const actualOut = document.getElementById('actualOut');
  const expectedOut = document.getElementById('expectedOut');

  let isRunning = false;
  let activeAbortController = null;

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const saved = loadSaved();

  function createEditor(id, initialValue) {
    const cm = CodeMirror.fromTextArea(document.getElementById(id), {
      mode: 'text/x-c++src',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      extraKeys: {
        Tab: (inst) => {
          if (inst.somethingSelected()) {
            inst.indentSelection('add');
          } else {
            inst.replaceSelection('    ', 'end');
          }
        },
        'Ctrl-Enter': () => {
          if (!isRunning) runStressTest();
        },
        'Cmd-Enter': () => {
          if (!isRunning) runStressTest();
        },
      },
    });
    cm.setValue(initialValue);
    return cm;
  }

  sampleInputEl.value = saved?.sampleInput ?? DEFAULT_SAMPLE;
  const solutionEditor = createEditor('solutionEditor', saved?.solution ?? DEFAULT_SOLUTION);
  const correctEditor = createEditor('correctEditor', saved?.correct ?? DEFAULT_CORRECT);

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sampleInput: sampleInputEl.value,
          solution: solutionEditor.getValue(),
          correct: correctEditor.getValue(),
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 250);
  }
  sampleInputEl.addEventListener('input', scheduleSave);
  solutionEditor.on('change', scheduleSave);
  correctEditor.on('change', scheduleSave);

  function setStatus(text, kind = '') {
    statusText.textContent = text;
    statusText.className = kind ? `status ${kind}` : 'status';
  }

  function setRunning(running) {
    isRunning = running;
    runBtn.disabled = running;
    stopBtn.hidden = !running;
  }

  function handleVerdict(evt) {
    const verdict = evt.verdict || 'ERROR';
    const isOk = verdict === 'PASSED' || verdict === 'AC';
    const isError =
      verdict === 'CE' ||
      verdict === 'RE' ||
      verdict === 'GEN_ERROR' ||
      verdict === 'BRUTE_ERROR' ||
      verdict === 'ERROR';

    inputOut.textContent = evt.input ?? '';
    actualOut.textContent = evt.actual ?? '';
    expectedOut.textContent = evt.expected ?? '';

    const errText = evt.compilerOutput || evt.stderr || '';
    if (isError && errText.trim()) {
      errorOut.textContent = errText;
      errorSection.hidden = false;
    } else {
      errorOut.textContent = '';
      errorSection.hidden = true;
    }

    if (isOk) {
      setStatus(evt.reason || 'Passed all tests.', 'status-ok');
    } else if (verdict === 'STOPPED') {
      setStatus(evt.reason || 'Stopped.');
    } else {
      setStatus(evt.reason || verdict, 'status-wa');
    }
  }

  async function runStressTest() {
    if (isRunning) return;
    saveState();

    const sampleInput = sampleInputEl.value;
    const solutionCode = solutionEditor.getValue();
    const correctCode = correctEditor.getValue();
    const inputSchema = window.SchemaEngine.parseCppInput(solutionCode.trim() ? solutionCode : correctCode);

    setRunning(true);
    errorSection.hidden = true;
    errorOut.textContent = '';
    inputOut.textContent = '';
    actualOut.textContent = '';
    expectedOut.textContent = '';
    setStatus('Compiling...');

    activeAbortController = new AbortController();

    try {
      const resp = await fetch('/api/stress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleInput,
          solutionCode,
          correctCode,
          genMode: 'schema',
          inputSchema,
          cppStd: 'gnu++20',
          comparator: 'token',
          maxTests: 500,
          timeLimitMs: 1000,
        }),
        signal: activeAbortController.signal,
      });

      if (!resp.ok || !resp.body) {
        const msg = await resp.text();
        setStatus(`Server error (${resp.status}): ${msg}`, 'status-err');
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;

          const evt = JSON.parse(line);
          if (evt.type === 'status') {
            setStatus(evt.message || 'Running...');
          } else if (evt.type === 'progress') {
            setStatus(`Running test #${evt.testNum} / ${evt.maxTests}...`);
          } else if (evt.type === 'verdict') {
            handleVerdict(evt);
          }
        }
      }

      if (buffer.trim()) {
        const evt = JSON.parse(buffer.trim());
        if (evt.type === 'verdict') handleVerdict(evt);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus('Stopped.');
      } else {
        setStatus(`Connection error: ${err.message}`, 'status-err');
      }
    } finally {
      activeAbortController = null;
      setRunning(false);
    }
  }

  async function stopStressTest() {
    if (!isRunning) return;
    try {
      await fetch('/api/stop', { method: 'POST' });
    } catch {}
    if (activeAbortController) {
      activeAbortController.abort();
    }
  }

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = prev; }, 900);
      } catch {
        // Ignore clipboard errors
      }
    });
  });

  runBtn.addEventListener('click', runStressTest);
  stopBtn.addEventListener('click', stopStressTest);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!isRunning) runStressTest();
    } else if (e.key === 'Escape' && isRunning) {
      e.preventDefault();
      stopStressTest();
    }
  });

  if (new URLSearchParams(window.location.search).get('demo') === '1') {
    handleVerdict({
      verdict: 'WA',
      reason: 'Wrong Answer on test #4 (token #1: got "-6", expected "15")',
      input: '4\n-5 -3 1 2\n',
      actual: '-6\n',
      expected: '15\n',
    });
  }
})();
