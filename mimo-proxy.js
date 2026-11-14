#!/usr/bin/env node
/**
 * Hunyuan Proxy
 *
 * Expõe o modelo Hunyuan da Tencent via API compatível com OpenAI.
 * Recebe requisições no formato OpenAI, converte para o formato da Tencent,
 * e traduz a resposta (incluindo tool calls) de volta para OpenAI.
 */

import { createServer } from 'node:http';
import { config, validateConfig } from './src/config.js';
import { reverseProxy } from './src/routes.js';
import { accountManager } from './src/account-manager.js';

validateConfig();

const server = createServer(reverseProxy);

server.on('error', (err) => {
  console.error('[Server] Erro:', err);
});

const PORT = config.port;
server.listen(PORT, config.host, () => {
  console.log(`[Server] Hunyuan Proxy rodando em http://${config.host}:${PORT}`);
  console.log(`[Server] Endpoint: POST /v1/chat/completions`);
  console.log(`[Server] Modelos: hunyuan-turbo, hunyuan-pro, hunyuan-lite`);

  // Aquece a sessão da primeira conta
  if (accountManager.accounts.length > 0) {
    accountManager.getOrCreateSession(accountManager.accounts[0]).catch(e => console.error(e));
  }

  // Loga estatísticas iniciais
  if (config.accounts.enabled) {
    const stats = accountManager.getStats();
    console.log(`[AccountManager] Contas carregadas: ${stats.totalAccounts}`);
    console.log(`[AccountPool] Pool inicializado (max: ${config.accounts.poolSize})`);
  } else {
    console.log('[AccountManager] Modo single-account ativo');
  }
});

process.on('SIGTERM', () => {
  console.log('[Server] Recebido SIGTERM. Fechando...');
  server.close(() => {
    console.log('[Server] Servidor fechado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] Recebido SIGINT. Fechando...');
  server.close(() => {
    console.log('[Server] Servidor fechado');
    process.exit(0);
  });
});