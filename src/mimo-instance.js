// src/mimo-instance.js
import { exec } from 'child_process';
import { promisify } from 'util';
import { accountDB } from './database.js';
import { config } from './config.js';
import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const execAsync = promisify(exec);

// Cria o diretório de perfis se não existir
const profilesDir = path.join(path.dirname(config.dbPath), 'mimo-profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir, { recursive: true });
}

// Portas disponíveis para instâncias do `mimo serve`
let nextPort = 4096;

export async function startMimoInstance(account) {
  // Gera um ID de sessão único
  const sessionId = `mimo-session-${account.id}-${Date.now()}`;

  // Define a porta para esta instância
  const port = nextPort++;
  if (nextPort > 5000) nextPort = 4096; // Reutiliza portas

  // Caminho para o perfil desta conta
  const profilePath = path.join(profilesDir, `account-${account.id}`);

  // Comando para iniciar o `mimo serve` com autenticação
  // NOTA: O MiMo Code pode não ter opção de autenticação por linha de comando.
  // Se não tiver, você precisará usar automação com Playwright (veja alternativa abaixo)
  const command = `mimo serve --port ${port} --profile ${profilePath}`;

  console.log(`[MimoInstance] Iniciando instância para ${account.email} na porta ${port}`);

  try {
    // Inicia o processo
    const child = exec(command, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIMO_EMAIL: account.email,
        MIMO_PASSWORD: account.password,
      },
    });

    // Aguarda um pouco para a instância subir
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verifica se a instância está respondendo
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'GET',
      timeout: 5000,
    });

    if (response.ok) {
      console.log(`[MimoInstance] Instância ${sessionId} pronta na porta ${port}`);
      return {
        sessionId,
        port,
        pid: child.pid,
        accountId: account.id,
        url: `http://127.0.0.1:${port}`,
      };
    } else {
      throw new Error('Instância não respondeu ao health check');
    }
  } catch (error) {
    console.error(`[MimoInstance] Falha ao iniciar instância: ${error.message}`);
    return null;
  }
}
async function checkMimoHealth(url) {
  try {
    const response = await fetch(`${url}/healthz`, { timeout: 5000 });
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Argumentos para evitar detecção de automação
const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--window-position=0,0',
  '--window-size=1280,800',
];

// Função para esperar intervenção humana (captcha + código email)
async function waitForHumanIntervention(page, timeoutMs = 300000) {
  console.log('[HunyuanInstance] ==========================================');
  console.log('[HunyuanInstance] INTERVENÇÃO HUMANA NECESSÁRIA');
  console.log('[HunyuanInstance] 1. Resolva o captcha (slide puzzle)');
  console.log('[HunyuanInstance] 2. Digite o código de verificação recebido por email');
  console.log('[HunyuanInstance] 3. Clique em enviar/confirmar');
  console.log('[HunyuanInstance] Aguardando até ' + (timeoutMs/1000) + ' segundos...');
  console.log('[HunyuanInstance] ==========================================');
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    // Verificar se textarea "Ask me anything" apareceu (login sucesso)
    const loggedIn = await page.evaluate(() => {
      const textarea = document.querySelector('textarea[placeholder="Ask me anything"]');
      return textarea !== null;
    });
    
    if (loggedIn) {
      console.log('[HunyuanInstance] Login detectado! Textarea "Ask me anything" encontrado.');
      return true;
    }
    
    // Verificar se ainda há captcha visível
    const captchaVisible = await page.locator('#tcWrap, .tc-captcha, iframe[src*="captcha"]').first().isVisible().catch(() => false);
    if (captchaVisible) {
      console.log('[HunyuanInstance] Captcha ainda visível, aguardando resolução...');
    }
    
    await page.waitForTimeout(5000);
  }
  
  throw new Error('Timeout aguardando intervenção humana (captcha + código email)');
}

// Alternativa: Se o `mimo serve` não aceita autenticação por linha de comando,
// você pode usar Playwright para fazer login automático:
export async function startMimoInstanceWithPlaywright(account) {
  const profilePath = path.join(profilesDir, `account-${account.id}`);
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
  const sessionId = `mimo-session-${account.id}-${Date.now()}`;
  const context = await chromium.launchPersistentContext(profilePath, { headless: false });
  const page = context.pages()[0] || await context.newPage();

  // Faz login no Mistral
  await page.goto('https://chat.mistral.ai/');

  // Se já logado, pula login (verifica se o campo de input do chat está visível)
  if (await page.locator('div.ProseMirror[contenteditable="true"]').first().isVisible().catch(() => false)) {
    return { sessionId, browser: context, context, page };
  }
  
  // 1. Clica no botão "Aceitar e continuar" (termos)
  const acceptTermsBtn = page.locator('button:has-text("Aceitar e continuar")');
  if (await acceptTermsBtn.isVisible().catch(() => false)) {
    await acceptTermsBtn.click();
    await page.waitForTimeout(500);
  }

  // 2. Clica no botão "Entrar"
  const signInBtn = page.locator('button:has-text("Entrar")');
  if (await signInBtn.isVisible().catch(() => false)) {
    await signInBtn.click();
    await page.waitForTimeout(1000);
  }

  // 3. Preenche email
  const emailInput = page.locator('input[name="email"], input[type="email"][placeholder="you@example.com"]');
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(account.email);
    await page.waitForTimeout(500);
  }

  // 4. Clica no botão "Continuar" abaixo do email
  const continueEmailBtn = page.locator('button[type="submit"]:has-text("Continuar")');
  if (await continueEmailBtn.isVisible().catch(() => false)) {
    await continueEmailBtn.click();
    await page.waitForTimeout(1500);
  }

  // 5. Preenche senha
  const passwordInput = page.locator('input[name="password"], input[type="password"][autocomplete="current-password"]');
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(account.password);
    await page.waitForTimeout(500);
  }

  // 6. Clica no botão "Continuar com senha"
  const continuePasswordBtn = page.locator('button[type="submit"]:has-text("Continuar com senha")');
  if (await continuePasswordBtn.isVisible().catch(() => false)) {
    await continuePasswordBtn.click();
  }

  // 7. Aguarda o campo de chat aparecer (verificação de sucesso)
  await page.waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 0 });

  // Extrair tokens de autenticação do localStorage (Mistral pode usar tokens em vez de apenas cookies)
  const authData = await page.evaluate(() => {
    const tokens = {};
    // Verifica localStorage por tokens de auth
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access'))) {
        tokens[key] = localStorage.getItem(key);
      }
    }
    // Também verifica sessionStorage
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access'))) {
        tokens[key] = sessionStorage.getItem(key);
      }
    }
    return tokens;
  });

  const cookies = await context.cookies();

  return { sessionId, browser: context, context, page, authData, cookies };
}

// Nova função para Hunyuan (Tencent AI Studio) - fluxo exato conforme especificado
export async function startHunyuanInstanceWithPlaywright(account) {
  const profilePath = path.join(profilesDir, `account-${account.id}`);
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
  const sessionId = `hunyuan-session-${account.id}-${Date.now()}`;
  
  const context = await chromium.launchPersistentContext(profilePath, { 
    headless: false,
    args: LAUNCH_ARGS,
    viewport: { width: 1280, height: 800 },
  });
  
  const page = context.pages()[0] || await context.newPage();

  const loginUrl = process.env.TENCENT_LOGIN_URL || "https://aistudio.tencent.ai";
  
  console.log('[HunyuanInstance] Navegando para:', loginUrl);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Verificar se já está logado (textarea "Ask me anything")
  const isLoggedIn = await page.evaluate(() => {
    return document.querySelector('textarea[placeholder="Ask me anything"]') !== null;
  });

  if (isLoggedIn) {
    console.log('[HunyuanInstance] Já logado (textarea encontrado)');
    return { sessionId, browser: context, context, page };
  }

  console.log('[HunyuanInstance] Não logado, iniciando fluxo de login...');
  
  // ===== PASSO 1: Clicar no botão "Log In" =====
  console.log('[HunyuanInstance] Procurando botão "Log In"...');
  const loginBtn = page.locator('button.side-menu-layout__r__btn:has-text("Log In"), button:has-text("Log In")').first();
  if (await loginBtn.isVisible().catch(() => false)) {
    console.log('[HunyuanInstance] Clicando em "Log In"');
    await loginBtn.click();
    await page.waitForTimeout(2000);
  } else {
    console.log('[HunyuanInstance] Botão "Log In" não encontrado, tentando seletores alternativos...');
    // Fallback seletores
    const altSelectors = [
      'button:has-text("Sign in")',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'a:has-text("Log In")',
      'a:has-text("Sign in")',
    ];
    for (const selector of altSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        console.log('[HunyuanInstance] Clicando em login alternativo:', selector);
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }
  }
  
  // ===== PASSO 2: Preencher email =====
  console.log('[HunyuanInstance] Procurando input de email...');
  const emailInput = page.locator('input[type="email"][placeholder="mail@domain.com"], input.Oik6u2AxDeR6psNnkJD9[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    console.log('[HunyuanInstance] Preenchendo email:', account.email);
    await emailInput.fill(account.email);
    await page.waitForTimeout(500);
  } else {
    // Fallback
    const altEmail = page.locator('input[type="email"]').first();
    if (await altEmail.isVisible().catch(() => false)) {
      console.log('[HunyuanInstance] Preenchendo email (fallback)');
      await altEmail.fill(account.email);
      await page.waitForTimeout(500);
    }
  }
  
  // ===== PASSO 3: Clicar botão "Send" para enviar código de verificação =====
  console.log('[HunyuanInstance] Procurando botão "Send"...');
  const sendBtn = page.locator('button.BMrF95RoZzWYgPCu6a2m:has-text("Send"), button:has-text("Send")').first();
  if (await sendBtn.isVisible().catch(() => false)) {
    console.log('[HunyuanInstance] Clicando "Send" para enviar código de verificação');
    await sendBtn.click();
    await page.waitForTimeout(3000);
  } else {
    console.log('[HunyuanInstance] Botão "Send" não encontrado, tentando alternativas...');
    const altSend = page.locator('button:has-text("Enviar"), button:has-text("Send code"), button[type="button"]').first();
    if (await altSend.isVisible().catch(() => false)) {
      await altSend.click();
      await page.waitForTimeout(3000);
    }
  }
  
  // ===== PASSO 4: Marcar checkbox de política de privacidade =====
  console.log('[HunyuanInstance] Procurando checkbox de política de privacidade...');
  const privacyCheckbox = page.locator('input.t-checkbox__former[type="checkbox"], input[type="checkbox"].t-checkbox__former').first();
  if (await privacyCheckbox.isVisible().catch(() => false)) {
    const isChecked = await privacyCheckbox.isChecked().catch(() => false);
    if (!isChecked) {
      console.log('[HunyuanInstance] Marcando checkbox de privacidade');
      await privacyCheckbox.check();
      await page.waitForTimeout(500);
    }
  } else {
    // Fallback: qualquer checkbox visível na área de login
    const altCheckbox = page.locator('input[type="checkbox"]').first();
    if (await altCheckbox.isVisible().catch(() => false)) {
      const isChecked = await altCheckbox.isChecked().catch(() => false);
      if (!isChecked) {
        console.log('[HunyuanInstance] Marcando checkbox alternativo');
        await altCheckbox.check();
        await page.waitForTimeout(500);
      }
    }
  }
  
  // ===== PASSO 5: Clicar novamente no botão Send/Confirmar e AGUARDAR HUMANO =====
  console.log('[HunyuanInstance] Checkbox marcado. Clicando novamente para prosseguir...');
  const sendBtn2 = page.locator('button.BMrF95RoZzWYgPCu6a2m:has-text("Send"), button:has-text("Send"), button:has-text("Confirm"), button:has-text("Continuar"), button[type="submit"]').first();
  if (await sendBtn2.isVisible().catch(() => false)) {
    await sendBtn2.click();
    await page.waitForTimeout(3000);
  }
  
  // ===== AGUARDAR INTERVENÇÃO HUMANA: Captcha + Código Email =====
  console.log('[HunyuanInstance] Aguardando intervenção humana (captcha + código de email)...');
  await waitForHumanIntervention(page, 300000); // 5 minutos
  
  // ===== VERIFICAÇÃO FINAL: Textarea "Ask me anything" =====
  console.log('[HunyuanInstance] Verificando se textarea "Ask me anything" apareceu...');
  try {
    await page.waitForSelector('textarea[placeholder="Ask me anything"]', { timeout: 30000 });
    console.log('[HunyuanInstance] SUCESSO: Textarea "Ask me anything" encontrado! Login completo.');
  } catch (e) {
    // Última verificação via evaluate
    const finalCheck = await page.evaluate(() => {
      return document.querySelector('textarea[placeholder="Ask me anything"]') !== null;
    });
    if (!finalCheck) {
      throw new Error('Textarea "Ask me anything" não encontrado após intervenção humana');
    }
    console.log('[HunyuanInstance] SUCESSO: Textarea encontrado (verificação final)');
  }
  
  // Extrair cookies e tokens
  const authData = await page.evaluate(() => {
    const tokens = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access') || key.includes('cookie'))) {
        tokens[key] = localStorage.getItem(key);
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key.includes('auth') || key.includes('token') || key.includes('session') || key.includes('access') || key.includes('cookie'))) {
        tokens[key] = sessionStorage.getItem(key);
      }
    }
    return tokens;
  });

  const cookies = await context.cookies();
  console.log('[HunyuanInstance] Cookies obtidos:', cookies.length);
  console.log('[HunyuanInstance] Sessão pronta para uso!');

  return { sessionId, browser: context, context, page, authData, cookies };
}

// Função auxiliar: importar cookies de um navegador já logado
export async function importCookiesFromBrowser(cookieString) {
  const cookies = cookieString.split('; ').map(c => {
    const [name, ...rest] = c.split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain: '.tencent.com', path: '/' };
  });
  return cookies;
}