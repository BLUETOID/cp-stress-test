const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSession, abortSession, runStressTest, runSingleTest } = require('./src/runner');

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(payload);
}

function serveStatic(reqPath, res) {
  const cleanPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, cleanPath);

  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function createAppServer() {
  const activeSessions = new Set();

  function abortAllSessions() {
    for (const s of activeSessions) {
      abortSession(s);
    }
    activeSessions.clear();
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', compiler: 'g++' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/stop') {
      abortAllSessions();
      sendJson(res, 200, { stopped: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/stress') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }

      abortAllSessions();
      const session = createSession();
      activeSessions.add(session);

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let streamDone = false;
      res.on('close', () => {
        if (!streamDone) {
          abortSession(session);
        }
        activeSessions.delete(session);
      });

      const emit = (eventObj) => {
        if (!streamDone && !res.writableEnded) {
          res.write(JSON.stringify(eventObj) + '\n');
        }
      };

      try {
        await runStressTest(body, session, emit);
      } catch (err) {
        emit({
          type: 'verdict',
          verdict: 'ERROR',
          reason: `Internal runner error: ${err.message}`,
          stderr: err.stack || err.message,
        });
      } finally {
        streamDone = true;
        activeSessions.delete(session);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/run-single') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }

      const session = createSession();
      activeSessions.add(session);
      let finished = false;
      res.on('close', () => {
        if (!finished) abortSession(session);
        activeSessions.delete(session);
      });

      try {
        const result = await runSingleTest(body, session);
        finished = true;
        if (!res.writableEnded) {
          sendJson(res, 200, result);
        }
      } catch (err) {
        finished = true;
        if (!res.writableEnded) {
          sendJson(res, 500, {
            verdict: 'ERROR',
            reason: `Internal error: ${err.message}`,
            stderr: err.stack || err.message,
          });
        }
      } finally {
        activeSessions.delete(session);
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(pathname, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  });

  server.abortAllSessions = abortAllSessions;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`stressTest-CP listening on http://localhost:${port}`);
  });
}

module.exports = { createAppServer };

