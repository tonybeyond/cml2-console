const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const { randomUUID } = require('crypto');

const CML_HOST = process.env.CML_HOST;
if (!CML_HOST) {
  console.error('ERROR: CML_HOST environment variable is required (e.g. export CML_HOST=192.168.1.1)');
  process.exit(1);
}
const CML_BASE = `https://${CML_HOST}/api/v0`;
const PORT = process.env.PORT || 3000;

// Accept CML2 self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const cml = axios.create({
  baseURL: CML_BASE,
  httpsAgent,
  timeout: 15000,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));

// --- Config (exposes CML host to frontend) ---
app.get('/api/config', (_req, res) => {
  res.json({ cmlHost: CML_HOST });
});

// --- Authentication ---
app.post('/api/auth', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { data } = await cml.post('/authenticate', { username, password });
    // CML2 returns the JWT token as a plain string
    res.json({ token: data });
  } catch (err) {
    const msg = err.response?.data || err.message;
    res.status(401).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
});

// --- Labs list with details ---
app.get('/api/labs', async (req, res) => {
  try {
    const token = extractToken(req);
    const headers = authHeader(token);

    const { data: labIds } = await cml.get('/labs', { headers });

    // /labs may return IDs (strings) or full objects depending on CML2 version
    const ids = labIds.map((entry) => (typeof entry === 'string' ? entry : entry.id));

    const labs = await Promise.all(
      ids.map(async (id) => {
        try {
          const { data } = await cml.get(`/labs/${id}`, { headers });
          // CML2 uses "lab_title" in the lab object; normalise to "title"
          return {
            id: data.id ?? id,
            title: data.lab_title || data.title || id,
            state: data.state || 'UNKNOWN',
            description: data.description || '',
          };
        } catch {
          return { id, title: id, state: 'UNKNOWN' };
        }
      })
    );

    res.json(labs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Console key for a node (CML2 2.10+ uses /keys/console) ---
app.get('/api/labs/:labId/nodes/:nodeId/keys/console', async (req, res) => {
  try {
    const token = extractToken(req);
    const { labId, nodeId } = req.params;
    const { data } = await cml.get(`/labs/${labId}/nodes/${nodeId}/keys/console`, {
      headers: authHeader(token),
    });
    console.log(`[keys] Node ${nodeId} console key raw response:`, JSON.stringify(data).slice(0, 200));
    res.json(data);
  } catch (err) {
    console.error(`[keys] Error:`, err.response?.status, err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// --- Nodes for a lab ---
app.get('/api/labs/:labId/nodes', async (req, res) => {
  try {
    const token = extractToken(req);
    const headers = authHeader(token);
    const { labId } = req.params;

    const { data: nodeIds } = await cml.get(`/labs/${labId}/nodes`, { headers });

    const nodes = await Promise.all(
      nodeIds.map(async (id) => {
        try {
          const { data } = await cml.get(`/labs/${labId}/nodes/${id}`, { headers });
          return data;
        } catch {
          return { id, label: id, state: 'UNKNOWN' };
        }
      })
    );

    res.json(nodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Server ---
const server = http.createServer(app);

// --- WebSocket Console Proxy ---
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/console') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (clientWs, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const labId = url.searchParams.get('lab');
  const nodeId = url.searchParams.get('node');
  const token = url.searchParams.get('token');

  if (!labId || !nodeId || !token) {
    clientWs.close(1008, 'Missing parameters');
    return;
  }

  // CML2 2.10+: fetch a one-time console key, then connect to wss://host/ws/{key}
  let consoleKey;
  try {
    const { data } = await cml.get(`/labs/${labId}/nodes/${nodeId}/keys/console`, {
      headers: authHeader(token),
    });
    // Log the raw response shape so we can debug key extraction
    console.log(`[console] keys/console raw response for ${nodeId}:`, JSON.stringify(data).slice(0, 200));
    // CML2 2.10 returns [{console_key: "...", device_number: N}] (array per serial line)
    const item = Array.isArray(data) ? data[0] : data;
    consoleKey = typeof item === 'string'
      ? item
      : (item?.console_key || item?.key || item?.token || item?.id);
    console.log(`[console] Extracted key: ${consoleKey ? `***${String(consoleKey).slice(-6)}` : 'NONE'}`);
  } catch (err) {
    const msg = `Failed to get console key: ${err.response?.status ?? err.message}`;
    console.error(`[console] ${msg}`, err.response?.data || '');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, msg);
    }
    return;
  }

  if (!consoleKey) {
    clientWs.close(1011, 'No console key in CML2 response');
    return;
  }

  // CML2 2.10 WebSocket console endpoint
  const cmlWsUrl = `wss://${CML_HOST}/ws/dispatch/frontend/console?cml_client=WebUI&action=lab_exec&uuid=${encodeURIComponent(consoleKey)}`;
  console.log(`[console] Connecting → /ws/dispatch/frontend/console?…uuid=***${String(consoleKey).slice(-6)}`);

  const cmlWs = new WebSocket(cmlWsUrl, { rejectUnauthorized: false });

  cmlWs.on('open', () => {
    // CML2 requires auth message immediately after WebSocket open
    const authMsg = JSON.stringify({ client_uuid: randomUUID(), token });
    cmlWs.send(authMsg);
    console.log(`[console] Connected + auth sent: node=${nodeId}`);
  });

  cmlWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  cmlWs.on('close', (code, reason) => {
    console.log(`[console] CML closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code);
    }
  });

  cmlWs.on('error', (err) => {
    console.error(`[console] CML WS error: ${err.message}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, err.message);
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (cmlWs.readyState === WebSocket.OPEN) {
      cmlWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('close', () => {
    if (cmlWs.readyState !== WebSocket.CLOSED && cmlWs.readyState !== WebSocket.CLOSING) {
      cmlWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error(`[console] Client WS error: ${err.message}`);
  });
});

// --- Helpers ---
function extractToken(req) {
  return (req.headers.authorization || '').replace('Bearer ', '');
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

server.listen(PORT, () => {
  console.log(`CML2 Console Manager → http://localhost:${PORT}`);
  console.log(`CML2 host: ${CML_HOST}`);
});
