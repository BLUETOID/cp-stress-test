const assert = require('assert');
const { createAppServer } = require('../server');
const SchemaEngine = require('../public/schemaEngine');

async function postStress(baseUrl, payload) {
  const resp = await fetch(`${baseUrl}/api/stress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(resp.status, 200, `Expected HTTP 200, got ${resp.status}`);
  const text = await resp.text();
  const events = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const verdictEvent = [...events].reverse().find((e) => e.type === 'verdict');
  assert.ok(verdictEvent, `No verdict event received. Events: ${JSON.stringify(events)}`);
  return { events, verdictEvent };
}

async function postSingle(baseUrl, payload) {
  const resp = await fetch(`${baseUrl}/api/run-single`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(resp.status, 200, `Expected HTTP 200, got ${resp.status}`);
  return resp.json();
}

async function runTests() {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('[1/7] Testing WA detection with buggy greedy solution...');
    const waRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      sanitize: false,
      comparator: 'token',
      maxTests: 200,
      timeLimitMs: 1000,
      baseSeed: 12345,
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    sort(a.begin(), a.end());
    cout << a[n - 1] * a[n - 2] << "\\n";
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    long long ans = LLONG_MIN;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            ans = max(ans, a[i] * a[j]);
    cout << ans << "\\n";
}`,
      generatorCode: `#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    mt19937_64 rng(stoull(argv[1]));
    int n = uniform_int_distribution<int>(2, 8)(rng);
    cout << n << "\\n";
    for (int i = 0; i < n; i++) {
        cout << uniform_int_distribution<int>(-20, 20)(rng) << (i + 1 == n ? "\\n" : " ");
    }
}`,
    });
    assert.strictEqual(waRes.verdictEvent.verdict, 'WA');
    assert.ok(waRes.verdictEvent.testNum >= 1);
    assert.ok(waRes.verdictEvent.input.trim().length > 0);
    assert.ok(waRes.verdictEvent.expected.trim().length > 0);
    assert.ok(waRes.verdictEvent.actual.trim().length > 0);
    assert.ok(waRes.verdictEvent.diff && waRes.verdictEvent.diff.tokenIndex === 1);
    console.log(`  PASS: Found WA on test #${waRes.verdictEvent.testNum}: ${waRes.verdictEvent.reason}`);

    console.log('[2/7] Testing full C++ (<bits/stdc++.h>, __int128, PBDS) + testlib.h generator...');
    const pbdsRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      sanitize: false,
      comparator: 'token',
      maxTests: 25,
      timeLimitMs: 1000,
      baseSeed: 99,
      solutionCode: `#include <bits/stdc++.h>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>
using namespace std;
using namespace __gnu_pbds;
using ordered_set = tree<pair<long long, int>, null_type, less<pair<long long, int>>, rb_tree_tag, tree_order_statistics_node_update>;

int main() {
    int n; cin >> n;
    ordered_set os;
    __int128 inv = 0;
    for (int i = 0; i < n; i++) {
        long long x; cin >> x;
        int less_or_eq = (int)os.order_of_key({x, INT_MAX});
        inv += (long long)os.size() - less_or_eq;
        os.insert({x, i});
    }
    cout << (long long)inv << "\\n";
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    long long inv = 0;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (a[i] > a[j]) inv++;
    cout << inv << "\\n";
}`,
      generatorCode: `#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    registerGen(argc, argv, 1);
    int n = rnd.next(1, 20);
    println(n);
    vector<int> a(n);
    for (int i = 0; i < n; i++) a[i] = rnd.next(-100, 100);
    println(a);
}`,
    });
    assert.strictEqual(pbdsRes.verdictEvent.verdict, 'PASSED');
    assert.strictEqual(pbdsRes.verdictEvent.testNum, 25);
    console.log(`  PASS: ${pbdsRes.verdictEvent.reason}`);

    console.log('[3/7] Testing ASan + UBSan runtime error detection...');
    const reRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      sanitize: true,
      comparator: 'token',
      maxTests: 10,
      timeLimitMs: 2000,
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<int> a(n, 1);
    cout << a[n] << "\\n";
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    cout << 1 << "\\n";
}`,
      generatorCode: `#include <bits/stdc++.h>
using namespace std;
int main() { cout << 5 << "\\n"; }`,
    });
    assert.strictEqual(reRes.verdictEvent.verdict, 'RE');
    assert.ok(reRes.verdictEvent.stderr.length > 0, 'Expected non-empty sanitizer stderr');
    console.log(`  PASS: Caught RE (${reRes.verdictEvent.reason})`);

    console.log('[4/7] Testing TLE detection...');
    const tleRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      sanitize: false,
      comparator: 'token',
      maxTests: 10,
      timeLimitMs: 200,
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    volatile int x = 0;
    while (true) x++;
    return x;
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() { cout << 0 << "\\n"; }`,
      generatorCode: `#include <bits/stdc++.h>
using namespace std;
int main() { cout << 1 << "\\n"; }`,
    });
    assert.strictEqual(tleRes.verdictEvent.verdict, 'TLE');
    console.log(`  PASS: Caught TLE (${tleRes.verdictEvent.reason})`);

    console.log('[5/7] Testing Custom testlib.h Checker (PASSED & WA)...');
    const customChecker = `#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    int a = ouf.readInt();
    int b = ouf.readInt();
    if (a + b != n) quitf(_wa, "a+b=%d != n=%d", a + b, n);
    quitf(_ok, "Valid pair (%d, %d)", a, b);
}`;
    const customGen = `#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    mt19937 rng(stoi(argv[1]));
    cout << uniform_int_distribution<int>(2, 50)(rng) << "\\n";
}`;
    const chkPass = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'custom',
      maxTests: 15,
      timeLimitMs: 1000,
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() { int n; cin >> n; cout << 1 << " " << (n - 1) << "\\n"; }`,
      bruteCode: '',
      generatorCode: customGen,
      checkerCode: customChecker,
    });
    assert.strictEqual(chkPass.verdictEvent.verdict, 'PASSED');

    const chkFail = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'custom',
      maxTests: 15,
      timeLimitMs: 1000,
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() { int n; cin >> n; cout << 1 << " " << n << "\\n"; }`,
      bruteCode: '',
      generatorCode: customGen,
      checkerCode: customChecker,
    });
    assert.strictEqual(chkFail.verdictEvent.verdict, 'WA');
    assert.ok(chkFail.verdictEvent.reason.includes('!='), `Unexpected checker reason: ${chkFail.verdictEvent.reason}`);
    console.log(`  PASS: Custom checker passed valid output and caught invalid output (${chkFail.verdictEvent.reason})`);

    console.log('[6/7] Testing /api/run-single...');
    const singleWa = await postSingle(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'token',
      timeLimitMs: 1000,
      customInput: '4\n-10 -9 1 2\n',
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    sort(a.begin(), a.end());
    cout << a[n - 1] * a[n - 2] << "\\n";
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    long long ans = LLONG_MIN;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            ans = max(ans, a[i] * a[j]);
    cout << ans << "\\n";
}`,
    });
    assert.strictEqual(singleWa.verdict, 'WA');
    assert.strictEqual(singleWa.expected.trim(), '90');
    assert.strictEqual(singleWa.actual.trim(), '2');

    const singleAc = await postSingle(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'token',
      timeLimitMs: 1000,
      customInput: '4\n-10 -9 1 2\n',
      solutionCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    sort(a.begin(), a.end());
    cout << max(a[0] * a[1], a[n - 1] * a[n - 2]) << "\\n";
}`,
      bruteCode: `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<long long> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];
    long long ans = LLONG_MIN;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            ans = max(ans, a[i] * a[j]);
    cout << ans << "\\n";
}`,
    });
    assert.strictEqual(singleAc.verdict, 'PASSED');
    console.log('  PASS: /api/run-single verified both WA and PASSED.');

    console.log('[7/10] Testing Float comparator (1e-6) and CE detection...');
    const floatPass = await postSingle(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'float_1e6',
      timeLimitMs: 1000,
      customInput: '',
      solutionCode: `#include <bits/stdc++.h>
int main() { std::cout << "3.14159265\\n"; }`,
      bruteCode: `#include <bits/stdc++.h>
int main() { std::cout << "3.141593\\n"; }`,
    });
    assert.strictEqual(floatPass.verdict, 'PASSED');

    const ceRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'token',
      genMode: 'cpp',
      solutionCode: `int main() { undefined_symbol(); }`,
      bruteCode: `int main() {}`,
      generatorCode: `int main() {}`,
    });
    assert.strictEqual(ceRes.verdictEvent.verdict, 'CE');
    assert.strictEqual(ceRes.verdictEvent.failedFile, 'solution.cpp');
    console.log('  PASS: Float comparator and CE detection verified.');

    console.log('[8/10] Testing SchemaEngine.parseCppInput on CP patterns...');
    const parsedArr = SchemaEngine.parseCppInput(`
      #include <bits/stdc++.h>
      using namespace std;
      int main() {
          int n; cin >> n;
          vector<long long> a(n);
          for (int i = 0; i < n; i++) cin >> a[i];
      }
    `);
    assert.strictEqual(parsedArr.hasT, false);
    assert.strictEqual(parsedArr.fields[0].type, 'int');
    assert.strictEqual(parsedArr.fields[0].name, 'n');
    assert.strictEqual(parsedArr.fields[1].type, 'array');
    assert.strictEqual(parsedArr.fields[1].lengthRef, 'n');

    const parsedMultiT = SchemaEngine.parseCppInput(`
      #include <bits/stdc++.h>
      using namespace std;
      void solve() {
          int n; string s;
          cin >> n >> s;
      }
      int main() {
          int t; cin >> t;
          while (t--) solve();
      }
    `);
    assert.strictEqual(parsedMultiT.hasT, true);
    assert.strictEqual(parsedMultiT.fields[0].type, 'int');
    assert.strictEqual(parsedMultiT.fields[0].name, 'n');
    assert.strictEqual(parsedMultiT.fields[1].type, 'string');
    assert.strictEqual(parsedMultiT.fields[1].lengthRef, 'n');

    const parsedGraph = SchemaEngine.parseCppInput(`
      #include <bits/stdc++.h>
      using namespace std;
      int main() {
          int n, m; cin >> n >> m;
          for (int i = 0; i < m; i++) {
              int u, v; cin >> u >> v;
          }
      }
    `);
    assert.strictEqual(parsedGraph.fields[0].name, 'n');
    assert.strictEqual(parsedGraph.fields[1].name, 'm');
    assert.strictEqual(parsedGraph.fields[2].type, 'graph');
    assert.strictEqual(parsedGraph.fields[2].nodesRef, 'n');
    assert.strictEqual(parsedGraph.fields[2].edgesRef, 'm');

    const parsedTree = SchemaEngine.parseCppInput(`
      #include <bits/stdc++.h>
      using namespace std;
      int main() {
          int n; cin >> n;
          for (int i = 0; i < n - 1; i++) {
              int u, v; cin >> u >> v;
          }
      }
    `);
    assert.strictEqual(parsedTree.fields[0].name, 'n');
    assert.strictEqual(parsedTree.fields[1].type, 'tree');
    assert.strictEqual(parsedTree.fields[1].lengthRef, 'n');

    const parsedMatrix = SchemaEngine.parseCppInput(`
      #include <bits/stdc++.h>
      using namespace std;
      int main() {
          int n, m; cin >> n >> m;
          vector<vector<int>> g(n, vector<int>(m));
          for (int i = 0; i < n; i++)
              for (int j = 0; j < m; j++)
                  cin >> g[i][j];
      }
    `);
    assert.strictEqual(parsedMatrix.fields[2].type, 'matrix');
    assert.strictEqual(parsedMatrix.fields[2].rowsRef, 'n');
    assert.strictEqual(parsedMatrix.fields[2].colsRef, 'm');
    console.log('  PASS: SchemaEngine.parseCppInput parsed scalar+array, t-loop+string, graph, tree, and matrix.');

    console.log('[9/10] Testing SchemaEngine.generateInputFromSchema invariants...');
    const permSample1 = SchemaEngine.generateInputFromSchema({
      hasT: false,
      fields: [
        { name: 'n', type: 'int', min: 6, max: 6 },
        { name: 'p', type: 'array', lengthRef: 'n', min: 1, max: 6, subtype: 'permutation' },
      ],
    }, 42);
    const permSample2 = SchemaEngine.generateInputFromSchema({
      hasT: false,
      fields: [
        { name: 'n', type: 'int', min: 6, max: 6 },
        { name: 'p', type: 'array', lengthRef: 'n', min: 1, max: 6, subtype: 'permutation' },
      ],
    }, 42);
    assert.strictEqual(permSample1, permSample2, 'Schema generation must be deterministic for same seed');
    const permLines = permSample1.trim().split('\n');
    assert.strictEqual(permLines[0], '6');
    const permNums = permLines[1].split(' ').map(Number).sort((a, b) => a - b);
    assert.deepStrictEqual(permNums, [1, 2, 3, 4, 5, 6]);

    const treeSample = SchemaEngine.generateInputFromSchema({
      hasT: false,
      fields: [
        { name: 'n', type: 'int', min: 5, max: 5 },
        { name: 'edges', type: 'tree', lengthRef: 'n', indexBase: 1 },
      ],
    }, 77);
    const treeLines = treeSample.trim().split('\n');
    assert.strictEqual(treeLines.length, 5); // 1 line for n=5 + 4 edges
    for (let i = 1; i < treeLines.length; i++) {
      const [u, v] = treeLines[i].split(' ').map(Number);
      assert.ok(u >= 1 && u <= 5 && v >= 1 && v <= 5 && u !== v);
    }

    const graphSample = SchemaEngine.generateInputFromSchema({
      hasT: false,
      fields: [
        { name: 'n', type: 'int', min: 5, max: 5 },
        { name: 'm', type: 'int', min: 7, max: 7 },
        { name: 'edges', type: 'graph', nodesRef: 'n', edgesRef: 'm', indexBase: 1 },
      ],
    }, 88);
    const graphLines = graphSample.trim().split('\n');
    assert.strictEqual(graphLines[0], '5');
    assert.strictEqual(graphLines[1], '7');
    assert.strictEqual(graphLines.length, 9); // n + m + 7 edges
    const edgeSet = new Set();
    for (let i = 2; i < graphLines.length; i++) {
      const [u, v] = graphLines[i].split(' ').map(Number);
      assert.ok(u >= 1 && u <= 5 && v >= 1 && v <= 5 && u !== v);
      const key = `${Math.min(u, v)},${Math.max(u, v)}`;
      assert.ok(!edgeSet.has(key), 'Graph edges must be simple (no duplicates)');
      edgeSet.add(key);
    }
    console.log('  PASS: SchemaEngine.generateInputFromSchema determinism, permutation, tree, and simple graph verified.');

    console.log('[10/10] Testing end-to-end stress test in schema mode (no generator.cpp)...');
    const buggySol = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int t; cin >> t;
    while (t--) {
        int n; cin >> n;
        vector<long long> a(n);
        for (int i = 0; i < n; i++) cin >> a[i];
        sort(a.begin(), a.end());
        cout << a[n - 1] * a[n - 2] << "\\n";
    }
}`;
    const acSol = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int t; cin >> t;
    while (t--) {
        int n; cin >> n;
        vector<long long> a(n);
        for (int i = 0; i < n; i++) cin >> a[i];
        long long ans = LLONG_MIN;
        for (int i = 0; i < n; i++)
            for (int j = i + 1; j < n; j++)
                ans = max(ans, a[i] * a[j]);
        cout << ans << "\\n";
    }
}`;
    const autoSchema = SchemaEngine.parseCppInput(buggySol);
    assert.strictEqual(autoSchema.hasT, true);
    const schemaStressRes = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'token',
      genMode: 'schema',
      inputSchema: autoSchema,
      maxTests: 200,
      timeLimitMs: 1000,
      baseSeed: 555,
      solutionCode: buggySol,
      correctCode: acSol,
    });
    assert.strictEqual(schemaStressRes.verdictEvent.verdict, 'WA');
    assert.ok(schemaStressRes.verdictEvent.input.trim().length > 0);
    assert.ok(schemaStressRes.verdictEvent.expected.trim().length > 0);
    assert.ok(schemaStressRes.verdictEvent.actual.trim().length > 0);
    console.log(`  PASS: Auto-detected schema mode found WA on test #${schemaStressRes.verdictEvent.testNum}: ${schemaStressRes.verdictEvent.reason}`);

    console.log('[11/11] Testing sample-guided learning (learnFromSample + generateFromSampleModel + /api/stress)...');
    const posSample = '3\n4\n1 5 2 4\n3\n2 8 1\n2\n6 3\n';
    const posModel = SchemaEngine.learnFromSample(posSample, buggySol);
    assert.strictEqual(posModel.hasT, true);
    for (let seed = 1; seed <= 10; seed++) {
      const genText = SchemaEngine.generateFromSampleModel(posModel, seed);
      const glines = genText.trim().split('\n');
      const tCount = Number(glines[0]);
      assert.ok(tCount >= 1 && tCount <= 3);
      let ptr = 1;
      for (let tc = 0; tc < tCount; tc++) {
        const nVal = Number(glines[ptr++]);
        const nums = glines[ptr++].split(' ').map(Number);
        assert.strictEqual(nums.length, nVal);
        assert.ok(nums.every((v) => v >= 1), `Expected positive values only, got ${nums}`);
      }
      assert.strictEqual(ptr, glines.length);
    }

    const binSample = '2\n5\n01101\n3\n101\n';
    const binModel = SchemaEngine.learnFromSample(binSample, 'int t; cin >> t; while (t--) { int n; string s; cin >> n >> s; }');
    assert.strictEqual(binModel.hasT, true);
    const binGen = SchemaEngine.generateFromSampleModel(binModel, 77);
    const blines = binGen.trim().split('\n');
    const bt = Number(blines[0]);
    let bptr = 1;
    for (let tc = 0; tc < bt; tc++) {
      const nVal = Number(blines[bptr++]);
      const str = blines[bptr++];
      assert.strictEqual(str.length, nVal);
      assert.ok(/^[01]+$/.test(str), `Expected binary string, got ${str}`);
    }

    const permSample = '2\n4\n2 4 1 3\n3\n3 1 2\n';
    const permModel = SchemaEngine.learnFromSample(permSample, buggySol);
    const permGen = SchemaEngine.generateFromSampleModel(permModel, 99);
    const plines = permGen.trim().split('\n');
    const pt = Number(plines[0]);
    let pptr = 1;
    for (let tc = 0; tc < pt; tc++) {
      const nVal = Number(plines[pptr++]);
      const pArr = plines[pptr++].split(' ').map(Number).sort((a, b) => a - b);
      const expectedPerm = Array.from({ length: nVal }, (_, i) => i + 1);
      assert.deepStrictEqual(pArr, expectedPerm);
    }

    // End-to-end /api/stress with positive-only sampleInput:
    // Candidate assumes all elements are distinct (prints n), passes sample [1,5,2] and [2,6,3,4], fails when duplicates occur!
    const posDupBuggy = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int t; cin >> t;
    while (t--) {
        int n; cin >> n;
        vector<int> a(n);
        for (int i = 0; i < n; i++) cin >> a[i];
        cout << n << "\\n";
    }
}`;
    const posDupCorrect = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int t; cin >> t;
    while (t--) {
        int n; cin >> n;
        vector<int> a(n);
        for (int i = 0; i < n; i++) cin >> a[i];
        sort(a.begin(), a.end());
        int distinct = unique(a.begin(), a.end()) - a.begin();
        cout << distinct << "\\n";
    }
}`;
    const sampleGuidedWa = await postStress(baseUrl, {
      cppStd: 'gnu++20',
      comparator: 'token',
      genMode: 'schema',
      sampleInput: '2\n3\n1 5 2\n4\n2 6 3 4\n',
      maxTests: 200,
      timeLimitMs: 1000,
      baseSeed: 321,
      solutionCode: posDupBuggy,
      correctCode: posDupCorrect,
    });
    assert.strictEqual(sampleGuidedWa.verdictEvent.verdict, 'WA');
    // Verify the failing test generated positive integers matching the sample format
    const failLines = sampleGuidedWa.verdictEvent.input.trim().split('\n');
    const failT = Number(failLines[0]);
    let fptr = 1;
    for (let tc = 0; tc < failT; tc++) {
      const fn = Number(failLines[fptr++]);
      const farr = failLines[fptr++].split(' ').map(Number);
      assert.strictEqual(farr.length, fn);
      assert.ok(farr.every((x) => x >= 1));
    }
    console.log(`  PASS: Sample-guided stress test caught WA on test #${sampleGuidedWa.verdictEvent.testNum} while keeping sample constraints.`);

    console.log('\nALL 11 VERIFICATION SUITES PASSED!');
  } finally {
    server.abortAllSessions();
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});

