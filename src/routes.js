import http from 'node:http'
import { URL } from 'node:url'
import {
  upstream,
  SERVER_AUTH,
  SERVER_URL,
  CORS_ORIGIN,
} from './config.js'
import { isAuthorized } from './auth.js'
import { openAIModels } from './openai.js'
import { fetchHunyuan } from './hunyuan-client.js'

export function reverseProxy(clientReq, clientRes) {
  // CORS Headers
  clientRes.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  clientRes.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, X-API-Key, Content-Type'
  );
  clientRes.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS, PATCH'
  );
  clientRes.setHeader('Access-Control-Max-Age', '86400');

  if (clientReq.method === 'OPTIONS') {
    clientRes.writeHead(204);
    clientRes.end();
    return;
  }

  if (clientReq.url === '/v1/models' || clientReq.url === '/v1/models/') {
    if (!isAuthorized(clientReq)) {
      clientRes.writeHead(401, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const models = ['hunyuan-turbo', 'hunyuan-pro', 'hunyuan-lite'];
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ data: models.map(id => ({ id, object: 'model' })) }));
    return;
  }

  if (clientReq.url.startsWith('/v1/chat/completions')) {
    if (!isAuthorized(clientReq)) {
      clientRes.writeHead(401, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let body = '';
    clientReq.on('data', c => body += c);
    clientReq.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const result = await fetchHunyuan(clientRes, data);
        if (result !== null && result !== undefined) {
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(result));
        }
      } catch (e) {
        if (!clientRes.headersSent) {
          clientRes.writeHead(500, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: e.message }));
        }
      }
    });
    return;
  }

  // Proxy other requests to upstream
  const targetPath = clientReq.url
  const headers = { ...clientReq.headers }
  headers['host'] = upstream.host
  if (SERVER_AUTH) headers['authorization'] = SERVER_AUTH

  const options = {
    method: clientReq.method,
    hostname: upstream.hostname,
    port: upstream.port,
    path: targetPath,
    headers,
    timeout: 120000,
  }

  const proxyReq = http.request(options, (proxyRes) => {
    const out = { ...proxyRes.headers }
    if (proxyRes.headers['transfer-encoding']) delete out['content-length']
    clientRes.writeHead(proxyRes.statusCode || 502, out)
    proxyRes.pipe(clientRes, { end: true })
  })

  proxyReq.on('error', (err) => {
    console.error('Upstream error:', err.message)
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(
        JSON.stringify({ error: 'Bad gateway' }),
      )
    }
  })

  clientReq.pipe(proxyReq, { end: true })
}