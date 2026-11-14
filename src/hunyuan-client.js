import {
  extractToolCalls,
  removeToolCallsFromText,
  detectFakeToolCalls,
  hasIncompleteToolCall,
  buildToolsSystemPrompt,
} from './tool-handler.js';
import { genId, calculateUsage, openAICompletion } from './openai.js';

const TENCENT_LOGIN_URL = (process.env.TENCENT_LOGIN_URL || 'https://aistudio.tencent.ai').replace(/\/$/, '');

function getConversationId(base) {
  return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      if (part.type === 'tool_result' && typeof part.content === 'string') return part.content;
      try { return JSON.stringify(part); } catch { return ''; }
    }).join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content);
}

function formatAssistantMessage(msg) {
  let text = contentToText(msg.content).trim();
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const calls = msg.tool_calls.map(tc => {
      const name = tc?.function?.name || tc?.name || 'unknown_tool';
      let args = tc?.function?.arguments ?? tc?.arguments ?? {};
      if (typeof args !== 'string') {
        try { args = JSON.stringify(args); } catch { args = '{}'; }
      }
      return `<tool_call>\n<name>${name}</name>\n<arguments>${args}</arguments>\n</tool_call>`;
    }).join('\n');
    text = text ? `${text}\n${calls}` : calls;
  }
  return text;
}

function formatToolMessage(msg) {
  const toolId = msg.tool_call_id || msg.toolCallId || msg.id || 'unknown';
  const content = contentToText(msg.content);
  return `[Tool result for ${toolId}]: ${content}`;
}

export function buildHunyuanPrompt(messages, tools, toolChoice = 'auto') {
  let prompt = '';
  const systemParts = [];

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg?.role === 'system') {
        const t = contentToText(msg.content).trim();
        if (t) systemParts.push(t);
      }
    }
  }

  const toolsBlock = buildToolsSystemPrompt(tools, toolChoice);
  if (toolsBlock) systemParts.push(toolsBlock.trim());

  if (systemParts.length > 0) {
    prompt += `[System]\n${systemParts.join('\n\n')}\n\n`;
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const role = msg?.role;
      if (!role || role === 'system') continue;
      if (role === 'user') {
        prompt += `[User]\n${contentToText(msg.content)}\n\n`;
      } else if (role === 'assistant') {
        prompt += `[Assistant]\n${formatAssistantMessage(msg)}\n\n`;
      } else if (role === 'tool') {
        prompt += `[Tool]\n${formatToolMessage(msg)}\n\n`;
      } else {
        prompt += `[${role}]\n${contentToText(msg.content)}\n\n`;
      }
    }
  }

  prompt += '[Assistant]\n';
  return prompt;
}

function createOpenAIChunk(chatId, model, created, delta, finishReason = null) {
  return {
    id: chatId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function extractTextFromEventData(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.type === 'text' && typeof data.msg === 'string') return data.msg;
  if (typeof data.msg === 'string' && (data.type === 'msg' || data.type === 'delta' || data.type === 'chunk' || data.type === 'reply')) return data.msg;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  if (typeof data.delta?.content === 'string') return data.delta.content;
  if (typeof data.delta?.text === 'string') return data.delta.text;
  if (Array.isArray(data.delta?.content)) {
    return data.delta.content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  }
  return '';
}

function extractErrorFromEventData(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'error' || data.type === 'fail' || data.type === 'failed') {
    return data.msg || data.message || data.error?.message || (typeof data.error === 'string' ? data.error : null) || JSON.stringify(data);
  }
  if (data.error) {
    if (typeof data.error === 'string') return data.error;
    return data.error.message || data.error.msg || JSON.stringify(data.error);
  }
  const code = data.code ?? data.status ?? data.errCode ?? data.ret;
  if (code !== undefined && code !== 0 && code !== 200 && code !== '0' && code !== '200' && code !== 'success' && code !== 'ok') {
    const msg = data.msg || data.message || data.errMsg || data.desc || data.reason;
    if (msg) return `${msg} (code: ${code})`;
  }
  return null;
}

function parseTencentSSE(raw, onEvent) {
  if (!raw || typeof raw !== 'string') return;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('event:')) continue;
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) continue;
    if (dataStr === '[DONE]') {
      onEvent({ done: true });
      continue;
    }
    try {
      onEvent({ data: JSON.parse(dataStr) });
    } catch {
      // ignore non-json
    }
  }
}

function buildFinalCompletion(requestData, fullText) {
  const model = requestData?.model || 'hunyuan-turbo';
  const id = genId();
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = extractToolCalls(fullText);
  const cleanText = removeToolCallsFromText(fullText);
  const fakeDetection = detectFakeToolCalls(fullText, requestData?.tools);

  if (toolCalls.length > 0) {
    const usage = calculateUsage(requestData?.messages, '', toolCalls);
    const completion = openAICompletion(id, model, created, null, toolCalls, usage);
    completion.choices[0].finish_reason = 'tool_calls';
    return completion;
  }

  let content = cleanText;
  if (fakeDetection.fake && requestData?.tools?.length > 0) {
    content += `\n\n[Proxy] O modelo mencionou ferramentas (${fakeDetection.mentionedTools.join(', ')}) em texto, mas não emitiu chamadas estruturadas.`;
  }
  const usage = calculateUsage(requestData?.messages, content, null);
  return openAICompletion(id, model, created, content || '', null, usage);
}

async function ensureLoggedInSession(accountManager) {
  const account = accountManager.accounts[0];
  if (!account) throw new Error('Nenhuma conta cadastrada');

  let session = await accountManager.getOrCreateSession(account);

  const isUsable = async (s) => {
    const browser = s.browser?.browser?.();
    const browserOk = browser && browser.isConnected();
    const pageOk = s.page && !s.page.isClosed();
    if (!browserOk || !pageOk) return false;
    try {
      return await s.page.evaluate(() => {
        return !!(
          document.querySelector('textarea[placeholder="Ask me anything"]') ||
          document.querySelector('textarea[placeholder*="Ask" i]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('[contenteditable="true"][role="textbox"]') ||
          document.querySelector('.hy-chat-input-send-btn')
        );
      });
    } catch {
      return false;
    }
  };

  if (!(await isUsable(session))) {
    try { accountManager.releaseSession(session.sessionId); } catch {}
    session = await accountManager.getOrCreateSession(account);
  }

  return session;
}

async function prepareChatPage(page) {
  const current = String(page.url() || '');
  if (!current.startsWith(TENCENT_LOGIN_URL)) {
    console.log('[Hunyuan] Navigating to chat page:', TENCENT_LOGIN_URL);
    await page.goto(TENCENT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);

  const inputSelectors = [
    'textarea[placeholder="Ask me anything"]',
    'textarea[placeholder*="Ask" i]',
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]',
  ];

  for (const sel of inputSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 12000, state: 'visible' });
      console.log('[Hunyuan] Found chat input:', sel);
      return sel;
    } catch {}
  }

  console.log('[Hunyuan] Input not found, reloading chat page...');
  await page.goto(TENCENT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (const sel of inputSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 15000, state: 'visible' });
      console.log('[Hunyuan] Found chat input after reload:', sel);
      return sel;
    } catch {}
  }

  throw new Error('Não foi possível localizar o campo de entrada do chat no Hunyuan (UI pode ter mudado ou sessão não está logada).');
}

async function installNetworkInterceptor(page, token) {
  await page.evaluate((token) => {
    window.__hyIntercept = window.__hyIntercept || {};
    window.__hyIntercept[token] = { active: true, startedAt: Date.now() };
    if (window.__hyNetHooked) return;
    window.__hyNetHooked = true;

    const shouldCapture = (url) => {
      if (!url) return false;
      return /\/api\/new-portal\/chat|\/api\/chat|hy\.tencent\.ai\/api/i.test(url);
    };
    const activeTokens = () => Object.keys(window.__hyIntercept || {}).filter(k => window.__hyIntercept[k]?.active);
    const emitMeta = (url) => { for (const t of activeTokens()) { try { window[`__hy_meta_${t}`]?.(url); } catch {} } };
    const emitChunk = (chunk) => { for (const t of activeTokens()) { try { window[`__hy_chunk_${t}`]?.(chunk); } catch {} } };
    const emitDone = () => { for (const t of activeTokens()) { try { window[`__hy_done_${t}`]?.(); } catch {} } };
    const emitErr = (msg) => { for (const t of activeTokens()) { try { window[`__hy_err_${t}`]?.(msg); } catch {} } };

    // Hook fetch
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const res = await origFetch.apply(this, args);
      try {
        if (activeTokens().length > 0 && shouldCapture(url) && res && res.body) {
          emitMeta(url);
          const clone = res.clone();
          (async () => {
            try {
              const reader = clone.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                emitChunk(decoder.decode(value, { stream: true }));
              }
              emitDone();
            } catch (e) {
              emitErr(e?.message || String(e));
            }
          })();
        }
      } catch {}
      return res;
    };

    // Hook XHR (site uses XHR for SSE in some flows)
    const OrigXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OrigXHR();
      let url = '';
      let seen = 0;
      let capturing = false;
      const origOpen = xhr.open;
      xhr.open = function(method, u, ...rest) {
        url = String(u || '');
        return origOpen.call(this, method, u, ...rest);
      };
      const origSend = xhr.send;
      xhr.send = function(...sendArgs) {
        try {
          if (activeTokens().length > 0 && shouldCapture(url)) {
            capturing = true;
            emitMeta(url);
            xhr.addEventListener('progress', () => {
              try {
                const text = xhr.responseText || '';
                if (text.length > seen) {
                  const chunk = text.slice(seen);
                  seen = text.length;
                  if (chunk) emitChunk(chunk);
                }
              } catch {}
            });
            xhr.addEventListener('loadend', () => {
              try {
                const text = xhr.responseText || '';
                if (text.length > seen) {
                  const chunk = text.slice(seen);
                  seen = text.length;
                  if (chunk) emitChunk(chunk);
                }
              } catch {}
              if (capturing) emitDone();
            });
            xhr.addEventListener('error', () => { if (capturing) emitErr('XHR network error'); });
            xhr.addEventListener('abort', () => { if (capturing) emitErr('XHR aborted'); });
          }
        } catch {}
        return origSend.apply(this, sendArgs);
      };
      return xhr;
    }
    WrappedXHR.prototype = OrigXHR.prototype;
    try { Object.setPrototypeOf(WrappedXHR, OrigXHR); } catch {}
    window.XMLHttpRequest = WrappedXHR;
  }, token);
}

async function sendPromptViaUI(page, inputSelector, prompt) {
  const input = page.locator(inputSelector).first();

  const tagName = await input.evaluate(el => el.tagName?.toLowerCase() || '').catch(() => '');
  const isContentEditable = await input.evaluate(el => !!el.isContentEditable).catch(() => false);

  await input.click({ timeout: 10000 }).catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(async () => { await page.keyboard.press('Backspace').catch(() => {}); });
  await page.waitForTimeout(100);

  if (tagName === 'textarea' || tagName === 'input') {
    await input.fill('').catch(() => {});
    await input.fill(prompt);
  } else if (isContentEditable) {
    let filled = false;
    try { await input.fill(prompt); filled = true; } catch {}
    if (!filled) {
      try {
        await page.evaluate(({ selector, text }) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error('Input element not found');
          el.focus();
          if (el.isContentEditable) {
            el.innerHTML = '';
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if ('value' in el) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { selector: inputSelector, text: prompt });
        filled = true;
      } catch {}
    }
    if (!filled) await page.keyboard.insertText(prompt);
  } else {
    try { await input.fill(prompt); } catch { await page.keyboard.insertText(prompt); }
  }

  console.log('[Hunyuan] Prompt filled, attempting send...');
  await page.waitForTimeout(600);

  const sendSelectors = [
    '.hy-chat-input-send-btn',
    'div.hy-chat-input-send-btn',
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="发送" i]',
    'button:has-text("Send")',
    'button:has-text("发送")',
  ];

  for (const sel of sendSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible().catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
      const className = (await btn.getAttribute('class').catch(() => '')) || '';
      const isDisabled = disabled || ariaDisabled === 'true' || /(^|\s)disabled(\s|$)/i.test(className);
      console.log('[Hunyuan] Send candidate:', sel, 'disabled=', isDisabled);
      if (!isDisabled) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 5000, force: true }).catch(async () => {
          await btn.click({ timeout: 3000 }).catch(() => {});
        });
        console.log('[Hunyuan] Clicked send button:', sel);
        return;
      }
    }
  }

  console.log('[Hunyuan] No enabled send button found, falling back to Enter');
  await page.keyboard.press('Enter').catch(async () => {
    await page.keyboard.press('Control+Enter').catch(() => {});
  });
}

let __hunyuanRequestQueue = Promise.resolve();

async function withHunyuanQueue(fn) {
  const run = __hunyuanRequestQueue.then(fn, fn);
  __hunyuanRequestQueue = run.catch(() => {});
  return run;
}

export async function fetchHunyuan(response, requestData) {
  return withHunyuanQueue(() => fetchHunyuanImpl(response, requestData));
}

async function fetchHunyuanImpl(response, requestData) {
  const stream = requestData?.stream !== false;
  const messages = Array.isArray(requestData?.messages) ? requestData.messages : [];
  const tools = Array.isArray(requestData?.tools) ? requestData.tools : null;
  const toolChoice = requestData?.tool_choice ?? 'auto';
  const model = requestData?.model || 'hunyuan-turbo';

  console.log('[Hunyuan] Request', { model, stream, tools: tools?.length || 0, messages: messages.length });

  const { accountManager } = await import('./account-manager.js');
  console.log('[Hunyuan] Ensuring session...');
  const session = await ensureLoggedInSession(accountManager);
  console.log('[Hunyuan] Session ready, preparing chat page...');

  try {
    session.page.on('close', () => { try { accountManager.releaseSession(session.sessionId); } catch {} });
    const b = session.browser?.browser?.();
    if (b) b.on('disconnected', () => { try { accountManager.releaseSession(session.sessionId); } catch {} });
  } catch {}

  const prompt = buildHunyuanPrompt(messages, tools, toolChoice);
  const conversationId = getConversationId(`${model}_${Date.now().toString().slice(0, -4)}`);
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const queue = [];
  let resolver = null;
  let sawChatResponse = false;
  let capturedUrl = null;
  let captureError = null;

  const push = (item) => {
    queue.push(item);
    if (resolver) { resolver(); resolver = null; }
  };

  const safeExpose = async (name, fn) => {
    try { await session.page.exposeFunction(name, fn); } catch {}
  };
  await safeExpose(`__hy_meta_${token}`, (url) => {
    capturedUrl = url;
    sawChatResponse = true;
    console.log('[Hunyuan] Captured chat stream URL:', url);
  });
  await safeExpose(`__hy_chunk_${token}`, (chunk) => push(chunk));
  await safeExpose(`__hy_done_${token}`, () => push(null));
  await safeExpose(`__hy_err_${token}`, (msg) => {
    captureError = msg;
    console.warn('[Hunyuan] Captured stream transport error:', msg);
  });

  const inputSelector = await prepareChatPage(session.page);
  console.log('[Hunyuan] Installing network interceptor...');
  await installNetworkInterceptor(session.page, token);
  await session.page.evaluate((t) => {
    window.__hyIntercept = window.__hyIntercept || {};
    window.__hyIntercept[t] = { active: true, startedAt: Date.now() };
  }, token);

  console.log('[Hunyuan] Sending prompt via UI...');
  await sendPromptViaUI(session.page, inputSelector, prompt);
  console.log('[Hunyuan] Waiting for chat response capture...');

  const waitForFirstChunk = async (timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (queue.length > 0) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return queue.length > 0;
  };

  const gotFirst = await waitForFirstChunk(60000);
  if (!gotFirst) {
    await session.page.evaluate((t) => { if (window.__hyIntercept?.[t]) window.__hyIntercept[t].active = false; }, token).catch(() => {});
    const extra = captureError ? ` Último erro de transporte: ${captureError}` : (sawChatResponse ? ' Resposta do chat detectada, mas sem dados SSE.' : '');
    throw new Error(`Não foi possível capturar a resposta do Hunyuan via UI.${extra}`);
  }

  const chatId = `chatcmpl-${conversationId}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, { role: 'assistant' }))}\n\n`);
  }

  const streamDeadline = Date.now() + 300000;
  let fullText = '';
  let sentContentLen = 0;

  try {
    while (true) {
      if (Date.now() > streamDeadline) throw new Error('Stream timeout');

      if (queue.length === 0) {
        await Promise.race([
          new Promise((r) => { resolver = r; }),
          new Promise((r) => setTimeout(r, 400)),
        ]);
        if (queue.length === 0) continue;
      }

      const raw = queue.shift();
      if (raw === null) break;
      if (typeof raw === 'string' && raw.startsWith('ERROR:')) throw new Error(raw.slice(6));

      parseTencentSSE(raw, ({ data, done }) => {
        if (done) return;
        const err = extractErrorFromEventData(data);
        if (err) throw new Error(err);

        const chunkText = extractTextFromEventData(data);
        if (!chunkText) return;

        fullText += chunkText;

        if (!stream) return;
        if (hasIncompleteToolCall(fullText)) return;
        const toolCalls = extractToolCalls(fullText);
        if (toolCalls.length > 0) return;

        const clean = removeToolCallsFromText(fullText);
        if (clean.length > sentContentLen) {
          const delta = clean.slice(sentContentLen);
          if (delta) {
            response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, { content: delta }))}\n\n`);
            sentContentLen = clean.length;
          }
        }
      });
    }

    await session.page.evaluate((t) => { if (window.__hyIntercept?.[t]) window.__hyIntercept[t].active = false; }, token).catch(() => {});

    if (stream) {
      const toolCalls = extractToolCalls(fullText);
      if (toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, {
            tool_calls: [{ index: i, id: tc.id, type: 'function', function: tc.function }],
          }))}\n\n`);
        }
        response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, {}, 'tool_calls'))}\n\n`);
      } else {
        const clean = removeToolCallsFromText(fullText);
        if (clean.length > sentContentLen) {
          const delta = clean.slice(sentContentLen);
          if (delta) response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, { content: delta }))}\n\n`);
        }
        response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, {}, 'stop'))}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      try { response.end(); } catch {}
      return null;
    }

    return buildFinalCompletion(requestData || {}, fullText || '');
  } catch (e) {
    await session.page.evaluate((t) => { if (window.__hyIntercept?.[t]) window.__hyIntercept[t].active = false; }, token).catch(() => {});
    console.error('[Hunyuan] UI capture/stream error:', e.message, capturedUrl ? `(url: ${capturedUrl})` : '');
    if (stream) {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      } else {
        try { response.end(); } catch {}
      }
      return null;
    }
    throw e;
  }
}
