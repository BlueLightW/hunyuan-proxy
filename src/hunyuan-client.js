import { extractToolCalls, removeToolCallsFromText, detectFakeToolCalls } from './tool-handler.js';
import { config } from './config.js';

const TENCENT_API_URL = process.env.TENCENT_API_URL || "https://api.hy.tencent.ai/api/new-portal/chat";
const TENCENT_LOGIN_URL = process.env.TENCENT_LOGIN_URL || "https://aistudio.tencent.ai";
const TENCENT_USER_AGENT = process.env.TENCENT_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function getConversationId(base) {
    return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractSystemPrompt(messages) {
    for (const m of messages) {
        if (m.role === 'system' && typeof m.content === 'string') {
            return m.content;
        }
    }
    return null;
}

function buildHunyuanPrompt(messages, tools, toolChoice) {
    let formattedPrompt = "";
    
    if (tools && tools.length > 0) {
        const toolsJson = JSON.stringify(tools, null, 2);
        formattedPrompt += `\n\n<tools>\n${toolsJson}\n</tools>\nInstrucao: Se precisar usar uma ferramenta, retorne estritamente um bloco JSON no formato: {"name": "...", "arguments": {...}}\n`;
    }

    for (const msg of messages) {
        const role = msg.role;
        const content = msg.content || "";
        if (role === 'system') {
            formattedPrompt += `[Sistema]: ${content}\n`;
        } else if (role === 'user') {
            formattedPrompt += `[Usuario]: ${content}\n`;
        } else if (role === 'assistant') {
            formattedPrompt += `[Assistente]: ${content}\n`;
        } else if (role === 'tool') {
            formattedPrompt += `[Resultado da Ferramenta]: ${content}\n`;
        }
    }

    formattedPrompt += "\n[Assistente]: ";
    return formattedPrompt;
}

function buildTencentPayload(prompt, requestData) {
    // Payload format based on actual Tencent API
    return {
        model: "gpt_175B_0404",
        prompt: prompt,
        displayPrompt: prompt,
        displayPromptType: 1,
        plugin: "Adaptive",
        options: {
            imageIntention: {
                needIntentionModel: true,
                backendUpdateFlag: 2
            }
        },
        targetLang: null,
        targetLangLabel: null,
        sourceLang: null,
        sourceLangLabel: null,
        translateModelList: [],
        podcast: { voices: [] },
        effort: "high",
        displayImageIntentionLabels: [],
        multimedia: [],
        agentId: "HunyuanDefault",
        customParams: {
            max_output_tokens: 65536,
            repetition_penalty: 1,
            temperature: requestData.temperature ?? 0.7,
            top_p: requestData.top_p ?? 1
        },
        supportHint: 1,
        version: "v2",
        chatModelId: "hy4-g"
    };
}

function createOpenAIChunk(chatId, model, created, delta, finishReason = null) {
    return {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };
}

function extractToolCallsFromStreamText(text) {
    const toolCalls = [];
    const seen = new Set();
    let index = 0;

    // Pattern 1: JSON tool call in the format {"name": "...", "arguments": {...}}
    const re1 = /{"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})}/g;
    let m;
    while ((m = re1.exec(text)) !== null) {
        try {
            const name = m[1].trim();
            const argsStr = m[2].trim();
            const key = name + ":" + argsStr;
            if (!seen.has(key)) {
                seen.add(key);
                toolCalls.push({
                    id: "call_" + Date.now() + "_" + index++,
                    type: "function",
                    function: { name, arguments: argsStr }
                });
            }
        } catch {}
    }

    // Pattern 2: XML tool_call format
    const re2 = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
    while ((m = re2.exec(text)) !== null) {
        try {
            const name = m[1].trim();
            const argsStr = m[2].trim();
            const key = name + ":" + argsStr;
            if (!seen.has(key)) {
                seen.add(key);
                toolCalls.push({
                    id: "call_" + Date.now() + "_" + index++,
                    type: "function",
                    function: { name, arguments: argsStr }
                });
            }
        } catch {}
    }

    return toolCalls;
}

// Extract session ID from page (localStorage, meta, or URL)
async function getSessionId(page) {
    try {
        const sessionId = await page.evaluate(() => {
            // Try localStorage
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
            // Try meta tags
            const meta = document.querySelector('meta[name="chat-id"], meta[name="session-id"], meta[property="chat:id"]');
            if (meta) return meta.getAttribute('content');
            // Try data attributes
            const bodyChatId = document.body.getAttribute('data-chat-id') || document.body.getAttribute('data-session-id');
            if (bodyChatId) return bodyChatId;
            // Try URL
            const urlMatch = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
            if (urlMatch) return urlMatch[1];
            return null;
        });
        return sessionId;
    } catch (e) {
        console.log('[Hunyuan] Error getting session ID:', e.message);
        return null;
    }
}

export async function fetchHunyuan(response, requestData) {
    console.log('[Hunyuan] >>> fetchHunyuan START');
    console.log('[Hunyuan Request] Model:', requestData.model);
    console.log('[Hunyuan Request] Stream:', requestData.stream);
    console.log('[Hunyuan Request] Tools count:', requestData.tools?.length || 0);
    if (requestData.tools?.length > 0) {
        console.log('[Hunyuan Request] Tool names:', requestData.tools.map(t => t.function?.name).join(', '));
    }
    console.log('[Hunyuan Request] Messages count:', requestData.messages?.length || 0);
    console.log('[Hunyuan] Using API URL:', TENCENT_API_URL);

    const { accountManager } = await import('./account-manager.js');
    
    const account = accountManager.accounts[0];
    if (!account) throw new Error('Nenhuma conta cadastrada');
    
    console.log('[Hunyuan] Getting session...');
    let session = await accountManager.getOrCreateSession(account);
    console.log('[Hunyuan] Got session:', session.sessionId);
    
    // Verifica se o browser/página ainda estão válidos
    const browser = session.browser?.browser?.();
    const isBrowserValid = browser && browser.isConnected();
    const isPageValid = session.page && !session.page.isClosed();
    
    if (!isBrowserValid || !isPageValid) {
        console.log('[Hunyuan] Browser/page inválido, recriando sessão...');
        accountManager.releaseSession(session.sessionId);
        session = await accountManager.getOrCreateSession(account);
        console.log('[Hunyuan] Nova sessão:', session.sessionId);
    }
    
    // Valida se a sessão ainda está logada
    console.log('[Hunyuan] Checking if logged in...');
    let isLoggedIn = false;
    try {
        isLoggedIn = await session.page.evaluate(() => {
            return document.querySelector('textarea[placeholder="Ask me anything"]') !== null ||
                   document.querySelector('div[contenteditable="true"]') !== null ||
                   document.querySelector('button[aria-label*="new" i]') !== null;
        });
    } catch (e) {
        console.log('[Hunyuan] Erro ao verificar login, assumindo não logado:', e.message);
        isLoggedIn = false;
    }
    
    console.log('[Hunyuan] isLoggedIn:', isLoggedIn);
    
    if (!isLoggedIn) {
        console.log('[Hunyuan] Sessão expirada, reiniciando login...');
        accountManager.releaseSession(session.sessionId);
        session = await accountManager.getOrCreateSession(account);
        console.log('[Hunyuan] Nova sessão após re-login:', session.sessionId);
    }
    
    // Listener para detectar se browser/page fecha
    session.page.on('close', () => {
        console.log('[Hunyuan] Página fechada, liberando sessão');
        accountManager.releaseSession(session.sessionId);
    });
    if (browser) {
        browser.on('disconnected', () => {
            console.log('[Hunyuan] Browser desconectado, liberando sessão');
            accountManager.releaseSession(session.sessionId);
        });
    }
    
    // Capturar logs do browser
    session.page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'log' || type === 'error' || type === 'warning') {
            console.log(`[Browser] ${text}`);
        }
    });
    session.page.on('pageerror', err => {
        console.error('[Browser Page Error]', err.message);
    });

    const tools = requestData.tools || null;
    const toolChoice = requestData.tool_choice || 'auto';
    
    // Constrói query com suporte a tools
    const prompt = buildHunyuanPrompt(requestData.messages, tools, toolChoice);
    const conversationId = getConversationId(`${requestData.model}_${Date.now().toString().slice(0, -4)}`);
    
    // Extrai componentes da mensagem
    const systemPrompt = extractSystemPrompt(requestData.messages);
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\nUser: ${prompt}` : prompt;
    
    const payload = buildTencentPayload(fullPrompt, requestData);

    // Get or create chat session ID - always create new chat to get fresh session
    let sessionId = null;
    console.log('[Hunyuan] Creating new chat session via UI...');
    try {
        // Navigate to new chat page to create fresh session
        await session.page.goto('https://aistudio.tencent.ai/chat/new', { waitUntil: "domcontentloaded" });
        await session.page.waitForTimeout(5000);
        
        // Also visit API domain to ensure cookies are set
        await session.page.goto('https://api.hy.tencent.ai', { waitUntil: "domcontentloaded" });
        await session.page.waitForTimeout(2000);
        
        // Go back to chat page
        await session.page.goto('https://aistudio.tencent.ai/chat/new', { waitUntil: "domcontentloaded" });
        await session.page.waitForTimeout(3000);
        
        sessionId = await getSessionId(session.page);
        console.log('[Hunyuan] New session ID after UI navigation:', sessionId);
    } catch (e) {
        console.log('[Hunyuan] UI navigation failed:', e.message);
    }
    
    // Fallback: if still no session ID, try localStorage
    if (!sessionId) {
        sessionId = await getSessionId(session.page);
        console.log('[Hunyuan] Fallback session ID from localStorage:', sessionId);
    }
    
    const finalApiUrl = sessionId ? `${TENCENT_API_URL}/${sessionId}` : TENCENT_API_URL;
    console.log('[Hunyuan] Using API URL:', finalApiUrl);

    // ----------------------------------------
    // STREAMING
    // ----------------------------------------
    if (requestData.stream) {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        let queue = [];
        let resolver = null;
        
        const funcName = `__sendChunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await session.page.exposeFunction(funcName, (chunk) => {
            queue.push(chunk);
            if (resolver) { resolver(); resolver = null; }
            return Promise.resolve();
        });
        
        // Garante que estamos na página do chat
        let currentUrl = session.page.url();
        console.log('[Hunyuan] Current URL:', currentUrl);
        
        // Se não estamos na página do chat, navegar para lá
        if (!currentUrl.includes('aistudio.tencent.ai')) {
            console.log('[Hunyuan] Navegando para aistudio.tencent.ai...');
            await session.page.goto(TENCENT_LOGIN_URL, { waitUntil: "domcontentloaded" });
            await session.page.waitForTimeout(3000);
            currentUrl = session.page.url();
            console.log('[Hunyuan] Nova URL:', currentUrl);
        }
        
        const chatId = `chatcmpl-${conversationId}`;
        const created = Math.floor(Date.now() / 1000);
        
        // Enviar role inicial
        response.write('data: ' + JSON.stringify(createOpenAIChunk(chatId, requestData.model, created, { role: 'assistant' })) + '\n\n');
        
        const evalPromise = session.page.evaluate(async ({ payload, funcName, apiUrl, sessionId }) => {
            const sendChunk = globalThis[funcName];
            console.log('[Browser] >>> evaluate START');
            try {
                console.log('[Browser] Iniciando fetch para API:', apiUrl);
                console.log('[Browser] URL atual:', window.location.href);
                console.log('[Browser] Cookies:', document.cookie);
                console.log('[Browser] Origin:', window.location.origin);
                
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                
                const res = await fetch(apiUrl, {
                    signal: controller.signal,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'Accept': 'text/event-stream',
                        'X-AgentId': 'HunyuanDefault/' + sessionId,
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Source': 'web',
                        'chat_version': 'v1'
                    },
                    body: JSON.stringify(payload),
                    credentials: 'include',
                    mode: 'cors'
                });
                
                console.log('[Browser] Response status:', res.status);
                console.log('[Browser] Response headers:', [...res.headers.entries()]);
                
                if (!res.ok) {
                    const errText = await res.text();
                    console.error('[Browser] Error response body:', errText);
                    throw new Error('HTTP ' + res.status + ' ' + errText.slice(0, 500));
                }
                
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const decoded = decoder.decode(value, { stream: true });
                    sendChunk(decoded);
                }
                clearTimeout(timeout);
                sendChunk(null);
                console.log('[Browser] >>> evaluate END - success');
            } catch (e) {
                console.error('[Browser] Fetch error:', e.message);
                console.log('[Browser] >>> evaluate END - error:', e.message);
                sendChunk('ERROR:' + e.message);
                sendChunk(null);
            }
        }, { payload, funcName, apiUrl: finalApiUrl, sessionId });
        
        console.log('[Node] page.evaluate called, waiting...');
        await new Promise(r => setTimeout(r, 100));
        console.log('[Node] after initial wait');
        
        let evalError = null;
        evalPromise.catch(e => {
            evalError = e;
            console.error('[Node] Browser evaluate error:', e.message);
            if (resolver) resolver();
        });
        
        const streamTimeout = setTimeout(() => {
            if (!response.headersSent) {
                response.writeHead(504, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: "Stream timeout" }));
            } else {
                response.end();
            }
        }, 300000);
        
        let finished = false;
        
        try {
            let contentBuffer = '';
            
            while (true) {
                if (queue.length === 0) {
                    await new Promise((r) => { resolver = r; });
                }
                if (evalError) throw evalError;
                const raw = queue.shift();
                if (raw === null) break;
                if (typeof raw === 'string' && raw.startsWith('ERROR:')) {
                    throw new Error(raw.slice(6));
                }
                
                // Parse do stream SSE do Hunyuan
                for (const line of raw.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    
                    if (trimmed.startsWith('event:')) {
                        continue;
                    }
                    
                    if (!trimmed.startsWith('data:')) continue;
                    
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') {
                        finished = true;
                        continue;
                    }
                    
                    try {
                        const data = JSON.parse(dataStr);
                        
                        if (data.type === 'text' && data.msg && typeof data.msg === 'string') {
                            // Add to buffer first
                            contentBuffer += data.msg;
                            
                            // Check if buffer contains a complete tool call
                            const toolCalls = extractToolCallsFromStreamText(contentBuffer);
                            if (toolCalls.length > 0) {
                                // Send tool calls instead of content
                                for (const tc of toolCalls) {
                                    response.write('data: ' + JSON.stringify(createOpenAIChunk(chatId, requestData.model, created, {
                                        tool_calls: [{
                                            index: 0,
                                            id: tc.id,
                                            type: 'function',
                                            function: tc.function
                                        }]
                                    })) + '\n\n');
                                }
                                contentBuffer = '';
                            } else {
                                // Heuristic: if buffer looks like it might be a tool call, hold back
                                const buf = contentBuffer.trim();
                                const looksLikeToolCall = buf.startsWith('{') && 
                                    (buf.includes('"name"') || buf.includes('name":') || buf.includes('name:') || buf.includes('name'));
                                if (!looksLikeToolCall) {
                                    // Safe to send as content
                                    response.write('data: ' + JSON.stringify(createOpenAIChunk(chatId, requestData.model, created, { content: data.msg })) + '\n\n');
                                    contentBuffer = '';
                                }
                                // If it looks like a tool call, keep buffering
                            }
                        }
                    } catch (e) {
                        // Ignorar erros de parse
                    }
                }
            }
            
            // Send any remaining content
            if (contentBuffer) {
                const toolCalls = extractToolCallsFromStreamText(contentBuffer);
                if (toolCalls.length === 0) {
                    response.write('data: ' + JSON.stringify(createOpenAIChunk(chatId, requestData.model, created, { content: contentBuffer })) + '\n\n');
                }
            }
            
            if (!finished) {
                response.write('data: ' + JSON.stringify(createOpenAIChunk(chatId, requestData.model, created, null, 'stop')) + '\n\n');
                response.write('data: [DONE]\n\n');
            }
            
            await evalPromise;
            clearTimeout(streamTimeout);
            response.end();
        } catch (e) {
            console.error('[Hunyuan] Stream error:', e.message);
            clearTimeout(streamTimeout);
            if (!response.headersSent) {
                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: e.message }));
            } else {
                response.end();
            }
        }
        
        return null;
    }
    
    // ----------------------------------------
    // NON-STREAMING
    // ----------------------------------------
    try {
        const result = await session.page.evaluate(async ({ payload, apiUrl, sessionId }) => {
            try {
                console.log('[Browser Non-stream] Iniciando fetch para API:', apiUrl);
                console.log('[Browser Non-stream] URL atual:', window.location.href);
                
                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain;charset=UTF-8',
                        'X-AgentId': 'HunyuanDefault/' + sessionId,
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Source': 'web',
                        'chat_version': 'v1'
                    },
                    credentials: 'include',
                    mode: 'cors',
                    body: JSON.stringify(payload),
                });
                
                if (!res.ok) {
                    const errText = await res.text();
                    console.error('[Browser Non-stream] Error response body:', errText);
                    throw new Error('HTTP ' + res.status + ' ' + errText.slice(0, 500));
                }
                
                const text = await res.text();
                let fullContent = '';
                
                // Parse SSE response
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (trimmed.startsWith('event:')) continue;
                    if (!trimmed.startsWith('data:')) continue;
                    
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') continue;
                    
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === 'text' && data.msg && typeof data.msg === 'string') {
                            fullContent += data.msg;
                        }
                    } catch {}
                }
                
                return { status: res.status, text: fullContent };
            } catch (e) {
                return { status: 0, text: e.message };
            }
        }, { payload, apiUrl: finalApiUrl, sessionId });
        
        // Validação de erro
        if (result.status < 200 || result.status >= 300) {
            throw new Error('Hunyuan retornou erro: ' + result.text);
        }
        
        // Extrai tool calls do texto completo
        const toolCalls = extractToolCallsFromStreamText(result.text);
        const cleanText = removeToolCallsFromText(result.text);
        
        console.log('[Hunyuan Debug] Raw text length:', result.text.length);
        console.log('[Hunyuan Debug] Tool calls found:', toolCalls.length);
        console.log('[Hunyuan Debug] Raw snippet:', result.text.substring(0, 500));
        
        // Detecta "fake tool calls"
        const fakeDetection = detectFakeToolCalls(result.text, requestData.tools);
        if (fakeDetection.fake) {
            console.warn('[Hunyuan] WARNING:', fakeDetection.hint);
        }
        
        const chatId = `chatcmpl-${conversationId}`;
        const created = Math.floor(Date.now() / 1000);
        
        // Se há tool calls, retorna no formato OpenAI
        if (toolCalls.length > 0) {
            return {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: toolCalls
                    },
                    finish_reason: 'tool_calls'
                }]
            };
        }
        
        // Se o modelo mencionou tools mas não chamou
        if (fakeDetection.fake && requestData.tools && requestData.tools.length > 0) {
            const hint = `\n\n[Proxy] O modelo Hunyuan mencionou as tools (${fakeDetection.mentionedTools.join(', ')}) em texto natural, mas nao emitiu chamadas estruturadas.`;
            return {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: cleanText + hint
                    },
                    finish_reason: 'stop'
                }]
            };
        }
        
        // Senão, retorna como texto normal
        return { 
            choices: [{ 
                message: { 
                    role: 'assistant', 
                    content: cleanText 
                },
                finish_reason: 'stop'
            }] 
        };
    } catch (e) {
        console.error('[Hunyuan] Non-stream error:', e.message);
        throw e;
    }
}