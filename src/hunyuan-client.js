import {
  extractToolCalls,
  removeToolCallsFromText,
  detectFakeToolCalls,
  hasIncompleteToolCall,
  buildToolsSystemPrompt,
} from './tool-handler.js';
import { genId, calculateUsage, openAICompletion } from './openai.js';

const TENCENT_API_URL = process.env.TENCENT_API_URL || 'https://api.hy.tencent.ai/api/new-portal/chat';
const TENCENT_LOGIN_URL = process.env.TENCENT_LOGIN_URL || 'https://aistudio.tencent.ai';

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
  return `[Resultado da Ferramenta para ${toolId}]: ${content}`;
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
    prompt += `[Sistema]:\n${systemParts.join('\n\n')}\n\n`;
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const role = msg?.role;
      if (!role || role === 'system') continue;
      if (role === 'user') {
        prompt += `[Usuário]:\n${contentToText(msg.content)}\n\n`;
      } else if (role === 'assistant') {
        prompt += `[Assistente]:\n${formatAssistantMessage(msg)}\n\n`;
      } else if (role === 'tool') {
        prompt += `[Ferramenta]:\n${formatToolMessage(msg)}\n\n`;
      } else {
        prompt += `[${role}]:\n${contentToText(msg.content)}\n\n`;
      }
    }
  }

  prompt += '[Assistente]:';
  return prompt;
}

function buildTencentPayload(prompt, requestData) {
  return {
    model: 'gpt_175B_0404',
    prompt,
    displayPrompt: prompt,
    displayPromptType: 1,
    plugin: 'Adaptive',
    options: {
      imageIntention: { needIntentionModel: true, backendUpdateFlag: 2 },
    },
    targetLang: null,
    targetLangLabel: null,
    sourceLang: null,
    sourceLangLabel: null,
    translateModelList: [],
    podcast: { voices: [] },
    effort: 'high',
    displayImageIntentionLabels: [],
    multimedia: [],
    agentId: 'HunyuanDefault',
    customParams: {
      max_output_tokens: requestData.max_tokens ?? 65536,
      repetition_penalty: requestData.repetition_penalty ?? 1,
      temperature: requestData.temperature ?? 0.7,
      top_p: requestData.top_p ?? 1,
    },
    supportHint: 1,
    version: 'v2',
    chatModelId: 'hy4-g',
  };
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
      // ignore malformed chunks
    }
  }
}

function buildFinalCompletion(requestData, fullText) {
  const model = requestData.model || 'hunyuan-turbo';
  const id = genId();
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = extractToolCalls(fullText);
  const cleanText = removeToolCallsFromText(fullText);
  const fakeDetection = detectFakeToolCalls(fullText, requestData.tools);

  if (toolCalls.length > 0) {
    const usage = calculateUsage(requestData.messages, '', toolCalls);
    const completion = openAICompletion(id, model, created, null, toolCalls, usage);
    completion.choices[0].finish_reason = 'tool_calls';
    return completion;
  }

  let content = cleanText;
  if (fakeDetection.fake && requestData.tools?.length > 0) {
    content += `\n\n[Proxy] O modelo mencionou ferramentas (${fakeDetection.mentionedTools.join(', ')}) em texto, mas não emitiu chamadas estruturadas.`;
  }
  const usage = calculateUsage(requestData.messages, content, null);
  return openAICompletion(id, model, created, content || '', null, usage);
}

async function getSessionId(page) {
  try {
    return await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('chat') || key.includes('session') || key.includes('conversation'))) {
          try {
            const val = JSON.parse(localStorage.getItem(key) || '{}');
            if (val.id) return val.id;
            if (val.chatId) return val.chatId;
            if (val.sessionId) return val.sessionId;
          } catch {}
        }
      }
      const meta = document.querySelector('meta[name="chat-id"], meta[name="session-id"], meta[property="chat:id"]');
      if (meta) return meta.getAttribute('content');
      const bodyChatId = document.body.getAttribute('data-chat-id') || document.body.getAttribute('data-session-id');
      if (bodyChatId) return bodyChatId;
      const urlMatch = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      if (urlMatch) return urlMatch[1];
      return null;
    });
  } catch (e) {
    console.log('[Hunyuan] Error getting session ID:', e.message);
    return null;
  }
}

export async function fetchHunyuan(response, requestData) {
  const stream = requestData?.stream !== false;
  const messages = Array.isArray(requestData?.messages) ? requestData.messages : [];
  const tools = Array.isArray(requestData?.tools) ? requestData.tools : null;
  const toolChoice = requestData?.tool_choice ?? 'auto';

  console.log('[Hunyuan] Request', { model: requestData?.model, stream, tools: tools?.length || 0, messages: messages.length });

  const { accountManager } = await import('./account-manager.js');
  const account = accountManager.accounts[0];
  if (!account) throw new Error('Nenhuma conta cadastrada');

  let session = await accountManager.getOrCreateSession(account);

  const ensureSession = async () => {
    const browser = session.browser?.browser?.();
    const isBrowserValid = browser && browser.isConnected();
    const isPageValid = session.page && !session.page.isClosed();
    let isLoggedIn = false;
    if (isBrowserValid && isPageValid) {
      try {
        isLoggedIn = await session.page.evaluate(() => {
          return document.querySelector('textarea[placeholder="Ask me anything"]') !== null ||
            document.querySelector('div[contenteditable="true"]') !== null ||
            document.querySelector('button[aria-label*="new" i]') !== null;
        });
      } catch {
        isLoggedIn = false;
      }
    }
    if (!isBrowserValid || !isPageValid || !isLoggedIn) {
      try { accountManager.releaseSession(session.sessionId); } catch {}
      session = await accountManager.getOrCreateSession(account);
    }
  };

  await ensureSession();

  try {
    session.page.on('close', () => { try { accountManager.releaseSession(session.sessionId); } catch {} });
    const b = session.browser?.browser?.();
    if (b) b.on('disconnected', () => { try { accountManager.releaseSession(session.sessionId); } catch {} });
  } catch {}

  const prompt = buildHunyuanPrompt(messages, tools, toolChoice);
  const payload = buildTencentPayload(prompt, requestData || {});
  const conversationId = getConversationId(`${requestData?.model || 'hunyuan'}_${Date.now().toString().slice(0, -4)}`);

  let sessionId = null;
  try {
    await session.page.goto('https://aistudio.tencent.ai/chat/new', { waitUntil: 'domcontentloaded' });
    await session.page.waitForTimeout(4000);
    await session.page.goto('https://api.hy.tencent.ai', { waitUntil: 'domcontentloaded' });
    await session.page.waitForTimeout(1500);
    await session.page.goto('https://aistudio.tencent.ai/chat/new', { waitUntil: 'domcontentloaded' });
    await session.page.waitForTimeout(2500);
    sessionId = await getSessionId(session.page);
  } catch (e) {
    console.log('[Hunyuan] UI navigation/session warning:', e.message);
  }
  if (!sessionId) sessionId = await getSessionId(session.page);

  const finalApiUrl = sessionId ? `${TENCENT_API_URL}/${sessionId}` : TENCENT_API_URL;

  if (stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const queue = [];
    let resolver = null;
    const funcName = `__sendChunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await session.page.exposeFunction(funcName, (chunk) => {
      queue.push(chunk);
      if (resolver) { resolver(); resolver = null; }
      return Promise.resolve();
    });

    try {
      const currentUrl = session.page.url();
      if (!currentUrl.includes('aistudio.tencent.ai')) {
        await session.page.goto(TENCENT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
        await session.page.waitForTimeout(3000);
      }
    } catch {}

    const chatId = `chatcmpl-${conversationId}`;
    const created = Math.floor(Date.now() / 1000);
    const model = requestData?.model || 'hunyuan-turbo';
    response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, { role: 'assistant' }))}\n\n`);

    const evalPromise = session.page.evaluate(async ({ payload, funcName, apiUrl, sessionId }) => {
      const sendChunk = globalThis[funcName];
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300000);
        const res = await fetch(apiUrl, {
          signal: controller.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Accept': 'text/event-stream',
            'X-AgentId': 'HunyuanDefault/' + sessionId,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Source': 'web',
            'chat_version': 'v1',
          },
          body: JSON.stringify(payload),
          credentials: 'include',
          mode: 'cors',
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status} ${errText.slice(0, 500)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sendChunk(decoder.decode(value, { stream: true }));
        }
        clearTimeout(timeout);
        sendChunk(null);
      } catch (e) {
        sendChunk('ERROR:' + (e?.message || String(e)));
        sendChunk(null);
      }
    }, { payload, funcName, apiUrl: finalApiUrl, sessionId });

    let evalError = null;
    evalPromise.catch(e => { evalError = e; if (resolver) resolver(); });

    const streamTimeout = setTimeout(() => { try { response.end(); } catch {} }, 300000);

    try {
      let fullText = '';
      let sentContentLen = 0;

      while (true) {
        if (queue.length === 0) {
          await new Promise((r) => { resolver = r; });
        }
        if (evalError) throw evalError;
        const raw = queue.shift();
        if (raw === null) break;
        if (typeof raw === 'string' && raw.startsWith('ERROR:')) throw new Error(raw.slice(6));

        parseTencentSSE(raw, ({ data }) => {
          if (data?.type === 'text' && typeof data.msg === 'string') {
            fullText += data.msg;

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
          }
        });
      }

      const toolCalls = extractToolCalls(fullText);
      if (toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          response.write(`data: ${JSON.stringify(createOpenAIChunk(chatId, model, created, {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: tc.function,
            }],
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
      await evalPromise.catch(() => {});
      clearTimeout(streamTimeout);
      try { response.end(); } catch {}
    } catch (e) {
      console.error('[Hunyuan] Stream error:', e.message);
      clearTimeout(streamTimeout);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      } else {
        try { response.end(); } catch {}
      }
    }

    return null;
  }

  // Non-streaming (stream=false)
  try {
    const result = await session.page.evaluate(async ({ payload, apiUrl, sessionId }) => {
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Accept': 'text/event-stream',
            'X-AgentId': 'HunyuanDefault/' + sessionId,
            'X-Requested-With': 'XMLHttpRequest',
            'X-Source': 'web',
            'chat_version': 'v1',
          },
          credentials: 'include',
          mode: 'cors',
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status} ${errText.slice(0, 500)}`);
        }

        const text = await res.text();
        let fullContent = '';
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('event:')) continue;
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'text' && typeof data.msg === 'string') fullContent += data.msg;
          } catch {}
        }
        return { status: res.status, text: fullContent };
      } catch (e) {
        return { status: 0, text: e?.message || String(e) };
      }
    }, { payload, apiUrl: finalApiUrl, sessionId });

    if (result.status < 200 || result.status >= 300) {
      throw new Error('Hunyuan retornou erro: ' + (result.text || 'unknown'));
    }

    return buildFinalCompletion(requestData || {}, result.text || '');
  } catch (e) {
    console.error('[Hunyuan] Non-stream error:', e.message);
    throw e;
  }
}
