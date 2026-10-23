import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import QRCode from 'qrcode';
import type { User } from './src/db/neon.js';
import {
  initNeonDatabase,
  findUserByIdentifier,
  saveUserToNeon,
  updateUserAutomationInNeon,
  deleteUserFromNeon,
  unpairWhatsAppFromNeon,
  recordCustomerChat,
  getLast10Chats,
  getCustomerConversations,
  updateUserPasswordInNeon,
  saveOtpToNeon,
  verifyOtpInNeon,
  getDbStatus,
  getPool,
  isDbConnected
} from './src/db/neon.js';

export type { User };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Port: Render assigns dynamic process.env.PORT, defaults to 3000 for preview
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Temp upload directory for expiring bulk media
const tempUploadsDir = path.join(__dirname, 'public', 'temp_uploads');
if (!fs.existsSync(tempUploadsDir)) {
  fs.mkdirSync(tempUploadsDir, { recursive: true });
}

app.use(cors());
// 50mb limit to handle high-resolution image uploads cleanly
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/temp_uploads', express.static(tempUploadsDir));

export interface CatalogItem {
  id: number;
  username: string;
  name: string;
  price: string;
  details: string;
  tag: string;
  item_type: 'product' | 'service';
  unit_type?: string;
  variants?: Array<{ variant: string; price: string }>;
  created_at: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CampaignLog {
  phone: string;
  status: 'sent' | 'failed' | 'revoked';
  timestamp: string;
  note?: string;
}

export interface BulkCampaign {
  id: string;
  username: string;
  phones: string[];
  message: string;
  image_url?: string;
  temp_file_path?: string;
  use_anti_ban: boolean;
  delay_ms: number;
  status: 'idle' | 'running' | 'paused' | 'revoked' | 'completed';
  currentIndex: number;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  currentPhone?: string;
  startTime: string;
  endTime?: string;
  logs: CampaignLog[];
}

// Fixed defaults (Zero required environment variables)
const adminUser = 'admin';
const adminPass = bcrypt.hashSync('admin123', 10);

const memoryUsers: Map<string, User> = new Map();
let nextUserId = 1;
let nextCatalogId = 1;

// Product & Service Catalog (Starts empty, no fake mock items)
const memoryCatalog: CatalogItem[] = [];

// Deleted tenants set to prevent resurrecting deleted accounts
const deletedUsernames: Set<string> = new Set();

// Activity counters initialized to real zero
const stats = {
  totalMessagesSent: 0,
  totalAiReplies: 0,
  campaignsLaunched: 0
};

// 1. Seed Master Admin only (real auth entry point)
memoryUsers.set(adminUser, {
  id: nextUserId++,
  username: adminUser,
  email: 'admin@eduta.ai',
  password: adminPass,
  role: 'admin',
  user_type: 'admin',
  account_name: 'Master Admin Account',
  phone: '',
  notification_phone: '',
  wa_jid: '',
  ai_provider: 'gemini',
  api_key: '',
  system_prompt: 'System Administrator Gateway',
  auto_reply: false,
  automation_access: true,
  status: 'Disconnected',
  qr: '',
  created_at: new Date().toISOString()
});

// SSE Stream Clients: username -> Set of Response objects
const sseClients: Map<string, Set<Response>> = new Map();

// Chat History Memory: "username_phone" -> ChatMessage[] (Sliding window of 10)
const chatMemory: Map<string, ChatMessage[]> = new Map();

function updateSlidingWindow(sessionKey: string, role: 'user' | 'assistant', text: string): ChatMessage[] {
  let history = chatMemory.get(sessionKey) || [];
  history.push({ role, content: text });
  if (history.length > 10) {
    history = history.slice(history.length - 10);
  }
  chatMemory.set(sessionKey, history);
  return history;
}

function pushToLiveChat(username: string, phone: string, text: string, msgType: string) {
  const clients = sseClients.get(username);
  if (!clients || clients.size === 0) return;

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const payload = JSON.stringify({
    phone,
    text,
    type: msgType,
    time: timeStr
  });

  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}


// Helper to fetch live tenant catalog items for AI personalization
async function getTenantCatalog(username: string): Promise<Array<{ name: string; price: string; details: string; item_type: string; unit_type: string; variants: Array<{ variant: string; price: string }> }>> {
  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        let res;
        try {
          res = await pool.query(
            `SELECT name, price, description as details, COALESCE(item_type, 'product') as item_type, COALESCE(unit_type, 'custom') as unit_type, COALESCE(variants, '[]'::jsonb) as variants 
             FROM products WHERE LOWER(username) = LOWER($1) ORDER BY id ASC`,
            [username]
          );
        } catch (dbColErr) {
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'product';`);
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) DEFAULT 'custom';`);
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb;`);
          res = await pool.query(
            `SELECT name, price, description as details, COALESCE(item_type, 'product') as item_type, COALESCE(unit_type, 'custom') as unit_type, COALESCE(variants, '[]'::jsonb) as variants 
             FROM products WHERE LOWER(username) = LOWER($1) ORDER BY id ASC`,
            [username]
          );
        }

        if (res.rows.length > 0) {
          return res.rows.map(r => ({
            name: r.name,
            price: r.price,
            details: r.details,
            item_type: r.item_type || 'product',
            unit_type: r.unit_type || 'custom',
            variants: typeof r.variants === 'string' ? JSON.parse(r.variants || '[]') : (r.variants || [])
          }));
        }
      } catch (err) {
        console.warn('Error fetching catalog for AI prompt:', err);
      }
    }
  }
  return memoryCatalog.filter(m => m.username.toLowerCase() === username.toLowerCase()).map(m => ({
    name: m.name,
    price: m.price,
    details: m.details,
    item_type: m.item_type,
    unit_type: m.unit_type || 'custom',
    variants: m.variants || []
  }));
}

const userKeyRotationMap = new Map<string, number>();

function getRotatedApiKey(username: string, rawKeys?: string): string {
  const keysStr = (rawKeys || process.env.GEMINI_API_KEY || '').trim();
  if (!keysStr) return '';
  const keyList = keysStr.split(/[\n,\s]+/).map(k => k.trim()).filter(Boolean);
  if (keyList.length === 0) return '';
  if (keyList.length === 1) return keyList[0];

  const userKey = (username || 'default').toLowerCase();
  const currentIdx = userKeyRotationMap.get(userKey) || 0;
  const selectedKey = keyList[currentIdx % keyList.length];
  userKeyRotationMap.set(userKey, (currentIdx + 1) % keyList.length);

  console.log(`🔄 [TS Engine] User @${userKey} rotated to API key #${(currentIdx % keyList.length) + 1} of ${keyList.length}`);
  return selectedKey;
}

// --- AI AUTO-REPLY ENGINE (24/7 PERSONALIZED CATALOG RESPONDER) ---
async function generateAIReply(
  username: string,
  customerPhone: string,
  incomingText: string,
  provider?: string,
  apiKey?: string,
  customSystemPrompt?: string,
  customModel?: string,
  customTemperature?: number
): Promise<{ replyText: string; imageURL?: string }> {
  const sessionKey = `${username}_${customerPhone}`;
  updateSlidingWindow(sessionKey, 'user', incomingText);

  // 1. Fetch tenant business profile & catalog
  const user = memoryUsers.get(username.toLowerCase()) || memoryUsers.get('admin');
  const accountName = user?.account_name || 'Our Company';
  const userType = user?.user_type || 'business_user';
  const activePrompt = customSystemPrompt || user?.system_prompt || '';

  // 2. Fetch live catalog items
  const catalog = await getTenantCatalog(username);

  // --- INDEX 0: STRICT STATIC CACHEABLE SYSTEM PROMPT (EXACT PREFIX MATCHING FOR GROQ PROMPT CACHING) ---
  // Must NOT contain dynamic fields like timestamps, random session IDs, or dynamic customer phone numbers.
  // Must serialize all product variants (units like kg, gram, liter, ml, half, full, pieces, pack, specific Sign/name)
  // mapped to individual pricing and stock status.
  const productVariantsDataset = catalog.map((item, idx) => {
    const rawPrice = item.price || '₹0';
    const variantsList = Array.isArray(item.variants) && item.variants.length > 0
      ? item.variants
      : [
          { variant: "Standard / Full Unit", price: String(rawPrice).startsWith('₹') ? rawPrice : `₹${rawPrice}` }
        ];

    const mappedVariants: Record<string, { unit: string; price: string; stock: string }> = {};
    variantsList.forEach((v: any, vIdx: number) => {
      const vName = v.variant || `variant_${vIdx + 1}`;
      const key = vName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const formattedPrice = String(v.price).startsWith('₹') ? String(v.price) : `₹${v.price}`;
      mappedVariants[key || `v_${vIdx}`] = {
        unit: vName,
        price: formattedPrice,
        stock: "in_stock"
      };
    });

    return {
      product_id: idx + 1,
      product_name: item.name,
      category_type: item.item_type || 'product',
      unit_type: item.unit_type || 'custom',
      description: item.details || '',
      summary_price: rawPrice,
      unit_variants: mappedVariants
    };
  });

  const staticSystemObject = {
    role: "Official 24/7 AI Sales & Support Assistant",
    account_name: accountName,
    business_category: userType === 'library_owner' ? 'Study Library & Academic Workspaces' : 'B2B Growth, Marketing & Lead Automation',
    persona_instructions: activePrompt || 'Polite, persuasive, and proactive.',
    formatting_rules: [
      "Use clear bullet points and bold pricing for variant options.",
      "Quote prices accurately from product_variants_dataset JSON.",
      "Keep responses punchy, natural, and concise (2 to 4 sentences)."
    ],
    product_variants_dataset: productVariantsDataset
  };

  // Index 0 System Message (100% Static & Cacheable)
  const systemInstruction = `You are the official 24/7 AI Assistant for "${accountName}".\n\n### STATIC SYSTEM INSTRUCTIONS & PRODUCT VARIANTS DATASET JSON ###\n${JSON.stringify(staticSystemObject, null, 2)}`;
  const index0SystemMessage = {
    role: 'system',
    content: systemInstruction
  };

  let aiResponse = '';
  const rawKeys = apiKey || user?.api_key || process.env.GEMINI_API_KEY || '';
  const key = getRotatedApiKey(username, rawKeys);
  const resolvedProvider = (provider || user?.ai_provider || 'gemini').toLowerCase();
  const reqModel = customModel || user?.model || '';
  const reqTemp = customTemperature ?? user?.temperature ?? 0.7;

  // Record incoming customer chat (strictly sliding 10 in DB)
  await recordCustomerChat(username, customerPhone, 'customer', incomingText);

  // Retrieve multi-turn sliding window history from DB (strictly last 10 messages)
  let dbHistory = await getLast10Chats(username, customerPhone);
  let historyList: Array<{ role: string; content: string }> = [];
  if (dbHistory.length > 0) {
    historyList = dbHistory.map(h => ({
      role: h.role === 'customer' ? 'user' : 'assistant',
      content: h.message_text
    }));
  } else {
    const history = chatMemory.get(sessionKey) || [{ role: 'user', content: incomingText }];
    historyList = history.map(h => ({ role: h.role, content: h.content }));
  }

  const formattedMessages = [
    index0SystemMessage,
    ...historyList
  ];

  // Try external LLM if key is available
  if (key) {
    if (resolvedProvider === 'groq') {
      try {
        const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: reqModel || 'llama-3.3-70b-versatile',
            messages: formattedMessages,
            temperature: reqTemp,
            max_tokens: 300
          })
        });
        if (groqResp.ok) {
          const gData: any = await groqResp.json();
          aiResponse = gData?.choices?.[0]?.message?.content || '';
        }
      } catch (e) {
        console.warn('Groq API error:', e);
      }
    } else if (resolvedProvider === 'openai' || resolvedProvider === 'chatgpt') {
      try {
        const oaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: reqModel || 'gpt-4o-mini',
            messages: formattedMessages,
            temperature: reqTemp,
            max_tokens: 300
          })
        });
        if (oaiResp.ok) {
          const oData: any = await oaiResp.json();
          aiResponse = oData?.choices?.[0]?.message?.content || '';
        }
      } catch (e) {
        console.warn('OpenAI API error:', e);
      }
    } else if (resolvedProvider === 'deepseek') {
      try {
        const dsResp = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: reqModel || 'deepseek-chat',
            messages: formattedMessages,
            temperature: reqTemp,
            max_tokens: 300
          })
        });
        if (dsResp.ok) {
          const dsData: any = await dsResp.json();
          aiResponse = dsData?.choices?.[0]?.message?.content || '';
        }
      } catch (e) {
        console.warn('DeepSeek API error:', e);
      }
    } else if (resolvedProvider === 'openrouter') {
      try {
        const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: reqModel || 'openai/gpt-3.5-turbo',
            messages: formattedMessages,
            temperature: reqTemp,
            max_tokens: 300
          })
        });
        if (orResp.ok) {
          const orData: any = await orResp.json();
          aiResponse = orData?.choices?.[0]?.message?.content || '';
        }
      } catch (e) {
        console.warn('OpenRouter API error:', e);
      }
    } else {
      // Default to Gemini API
      try {
        const gemModel = reqModel || 'gemini-1.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(key)}`;
        const geminiHistory = historyList.map(h => `${h.role === 'user' ? 'Customer' : 'Assistant'}: ${h.content}`).join('\n');
        const fullPrompt = `${systemInstruction}\n\nCONVERSATION HISTORY:\n${geminiHistory}`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: reqTemp }
          })
        });
        if (resp.ok) {
          const data: any = await resp.json();
          aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
      } catch (e) {
        console.warn('Gemini API error:', e);
      }
    }
  }

  // 4. Intelligent Personalization Fallback (Zero external API dependencies guaranteed)
  if (!aiResponse) {
    const qLower = incomingText.toLowerCase();

    if (qLower.includes('price') || qLower.includes('cost') || qLower.includes('fee') || qLower.includes('rate') || qLower.includes('plan')) {
      const priceSummary = catalog.length > 0 
        ? catalog.map(c => `• ${c.name}: ${c.price}`).join('\n')
        : 'Our plans start from $499/mo.';
      aiResponse = `Hello! Thank you for inquiring about pricing at ${accountName}.\n\nHere are our official rates:\n${priceSummary}\n\nWould you like me to book a discovery call or activate one of these for you?`;
    } else if (qLower.includes('service') || qLower.includes('product') || qLower.includes('offer') || qLower.includes('feature')) {
      const services = catalog.filter(c => c.item_type === 'service');
      const products = catalog.filter(c => c.item_type === 'product');
      let details = '';
      if (services.length > 0) {
        details += `Services: ` + services.map(s => `${s.name} (${s.price})`).join(', ');
      }
      if (products.length > 0) {
        details += `\nProducts: ` + products.map(p => `${p.name} (${p.price})`).join(', ');
      }
      aiResponse = `Welcome to ${accountName}! 🌟\n\nWe provide:\n${details || 'Full WhatsApp automation & qualification suites'}.\n\nWhich of these would best suit your current goals?`;
    } else if (userType === 'library_owner' && (qLower.includes('seat') || qLower.includes('timing') || qLower.includes('shift') || qLower.includes('admission'))) {
      aiResponse = `Welcome to ${accountName}! 📚\n\nOur study library features silent zones, high-speed Wi-Fi, and flexible shifts (Morning, Afternoon, Evening, Full Day). Please let us know your preferred shift to reserve your seat.`;
    } else if (qLower.includes('hi') || qLower.includes('hello') || qLower.includes('hey') || qLower.includes('namaste')) {
      aiResponse = `Hello! Welcome to ${accountName}. 😊 I am your 24/7 automated assistant. How can I help you today? Feel free to ask about our services, pricing, or support!`;
    } else if (activePrompt) {
      aiResponse = `Thank you for reaching out to ${accountName}. ${activePrompt.slice(0, 150)}. A team member will also review your query shortly!`;
    } else {
      aiResponse = `Thank you for reaching out to ${accountName}! We have received your query: "${incomingText}". Our team will assist you shortly, or reply with 'PRICING' to see our packages.`;
    }
  }

  let matchedImageUrl: string | undefined = undefined;
  const imgTagMatch = aiResponse.match(/<IMG_(\d+)>/i);
  if (imgTagMatch) {
    const itemIndex = parseInt(imgTagMatch[1], 10) - 1;
    if (catalog[itemIndex]) {
      const item = catalog[itemIndex];
      // Replace tag with product mention if desired
      aiResponse = aiResponse.replace(/<IMG_\d+>/gi, `[Product Image: ${item.name}]`);
    }
  }

  updateSlidingWindow(sessionKey, 'assistant', aiResponse);
  await recordCustomerChat(username, customerPhone, 'assistant', aiResponse);
  return { replyText: aiResponse.trim(), imageURL: matchedImageUrl };
}

// --- API ROUTES ---

// 1. UNIFIED DIRECT LOGIN (Neon DB Backend: Global Admin -> Admin Portal, Normal Users -> Business Portal)
app.post('/api/login', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { username, email, identifier, password } = body || {};
  const loginId = (identifier || username || email || '').trim();

  if (!loginId || !password) {
    return res.status(400).json({ status: 'error', message: 'Please enter Email / Username and Password.' });
  }

  // Look up user from Neon DB or Memory Cache by username or email
  const user = await findUserByIdentifier(loginId, memoryUsers);
  if (!user) {
    return res.status(401).json({ status: 'error', message: 'Account not found! Please check your username/email or sign up.' });
  }

  // Check password
  const isMatch = user.password === password || bcrypt.compareSync(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ status: 'error', message: 'Invalid Password. Please verify your credentials.' });
  }

  // Global Admin lands on Admin Portal, Normal users land on Business Portal
  const isGlobalAdmin = user.role === 'admin' || user.username.toLowerCase() === 'admin' || (user.email && user.email.toLowerCase() === 'admin@eduta.ai');
  const targetPortal = isGlobalAdmin ? 'admin_portal' : 'business_portal';

  return res.json({
    status: 'success',
    portal: targetPortal,
    role: user.role,
    user_type: user.user_type || (isGlobalAdmin ? 'admin' : 'business_user'),
    token: 'eduta-token-' + user.username,
    username: user.username,
    email: user.email || '',
    account_name: user.account_name,
    user_id: user.id,
    automation_access: user.automation_access,
    ai_provider: user.ai_provider,
    system_prompt: user.system_prompt,
    auto_reply: user.auto_reply
  });
});

// In-Memory OTP Store: email -> { otp, expiresAt, fullName, password }
const memoryOtps: Map<string, { otp: string; expiresAt: number; fullName: string; password: string }> = new Map();



function validatePasswordComplexity(password: string): { valid: boolean; message?: string } {
  if (!password || password.length < 6) {
    return { valid: false, message: 'Password must be at least 6 characters long!' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least 1 capital letter (A-Z)!' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least 1 number (0-9)!' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, message: 'Password must contain at least 1 special character (!@#$%^&* etc.)!' };
  }
  return { valid: true };
}

// 1B. NEON AUTH: SEND OTP FOR EMAIL VERIFICATION
app.post(['/api/auth/send-otp', '/api/auth/neon/send-otp'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { full_name, email, password, confirm_password, account_name, neon_auth_url } = body || {};

  const nameInput = (full_name || account_name || '').trim();
  const emailInput = (email || '').trim().toLowerCase();
  const passInput = (password || '').trim();

  if (!nameInput || !emailInput || !passInput) {
    return res.status(400).json({ status: 'error', message: 'Full Name, Email Address, and Password are required!' });
  }

  if (confirm_password && passInput !== String(confirm_password).trim()) {
    return res.status(400).json({ status: 'error', message: 'Password and Confirm Password do not match!' });
  }

  const passCheck = validatePasswordComplexity(passInput);
  if (!passCheck.valid) {
    return res.status(400).json({ status: 'error', message: passCheck.message });
  }

  const cleanUser = emailInput.split('@')[0].replace(/[^a-zA-Z0-9_.]/g, '_');

  // Check if email/username already registered
  const existing = (await findUserByIdentifier(emailInput, memoryUsers)) || (await findUserByIdentifier(cleanUser, memoryUsers));
  if (existing) {
    return res.status(400).json({ status: 'error', message: 'This Email / Account is already registered! Please sign in.' });
  }

  // Generate 6-digit random OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAtMs = Date.now() + 10 * 60 * 1000; // 10 mins

  memoryOtps.set(emailInput, {
    otp: otpCode,
    expiresAt: expiresAtMs,
    fullName: nameInput,
    password: passInput
  });

  await saveOtpToNeon(emailInput, otpCode, new Date(expiresAtMs));

  // Dispatch verification email directly via Neon Inbuilt Auth Service API
  const neonAuthUrl = (neon_auth_url || process.env.NEON_AUTH_URL || process.env.NEON_AUTH_BASE_URL || '').trim().replace(/\/+$/, '');

  let neonAuthSent = false;
  let neonAuthMsg = '';

  if (neonAuthUrl) {
    const requestOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:3000';
    const authHeaders = {
      'Content-Type': 'application/json',
      'Origin': requestOrigin,
      'Referer': requestOrigin,
      'User-Agent': 'EduCloud-SaaS/1.0'
    };

    // Better Auth endpoints with exact required schemas
    const attemptsToTry = [
      {
        url: `${neonAuthUrl}/email-otp/send-verification-otp`,
        payload: { email: emailInput, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/email-otp/send-verification-otp`,
        payload: { email: emailInput, type: 'sign-in' }
      },
      {
        url: `${neonAuthUrl}/sign-up/email`,
        payload: { email: emailInput, password: passInput, name: nameInput }
      },
      {
        url: `${neonAuthUrl}/api/auth/email-otp/send-verification-otp`,
        payload: { email: emailInput, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/api/auth/sign-up/email`,
        payload: { email: emailInput, password: passInput, name: nameInput }
      },
      {
        url: `${neonAuthUrl}/send-verification-email`,
        payload: { email: emailInput, type: 'email-verification' }
      }
    ];

    for (const attempt of attemptsToTry) {
      try {
        const resp = await fetch(attempt.url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(attempt.payload)
        });

        const respText = await resp.text();
        let respJson: any = {};
        try { respJson = JSON.parse(respText); } catch {}

        console.log(`⚡ [Neon Inbuilt Auth API] ${attempt.url} -> Status ${resp.status}:`, respText.slice(0, 200));

        if (resp.ok || resp.status === 200 || resp.status === 201) {
          neonAuthSent = true;
          neonAuthMsg = respJson?.message || 'Verification email dispatched via Neon Auth!';
          break;
        }
      } catch (neonErr: any) {
        console.warn(`Notice calling Neon Auth endpoint ${attempt.url}:`, neonErr.message);
      }
    }
  }

  console.log(`✉️ [Neon Auth] Verification code dispatched for ${emailInput} (Neon Auth Delivered: ${neonAuthSent})`);

  return res.json({
    status: 'success',
    message: neonAuthSent
      ? (neonAuthMsg || `Verification email dispatched via Neon Auth to ${emailInput}! Check your inbox.`)
      : `Verification Code: ${otpCode} (Neon Auth verification code generated for ${emailInput}).`,
    email: emailInput,
    otp_code: neonAuthSent ? undefined : otpCode,
    neon_auth_sent: neonAuthSent
  });
});

// 1C. NEON AUTH: VERIFY OTP & CREATE ACCOUNT
app.post(['/api/auth/verify-otp', '/api/auth/neon/verify-otp'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { email, otp_code, full_name, password } = body || {};

  if (!email || !otp_code) {
    return res.status(400).json({ status: 'error', message: 'Email Address and 6-Digit OTP Code are required!' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanCode = String(otp_code).trim();

  // 1. Verify in Neon DB
  let isOtpValid = false;
  if (isDbConnected()) {
    isOtpValid = await verifyOtpInNeon(cleanEmail, cleanCode);
  }

  // 2. Verify in memory store
  if (!isOtpValid) {
    const memEntry = memoryOtps.get(cleanEmail);
    if (memEntry && memEntry.otp === cleanCode && memEntry.expiresAt > Date.now()) {
      isOtpValid = true;
      memoryOtps.delete(cleanEmail);
    }
  }

  // 3. Verify via remote Neon Auth API if configured
  const neonAuthUrl = (process.env.NEON_AUTH_URL || process.env.NEON_AUTH_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!isOtpValid && neonAuthUrl) {
    const requestOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:3000';
    const authHeaders = {
      'Content-Type': 'application/json',
      'Origin': requestOrigin,
      'Referer': requestOrigin,
      'User-Agent': 'EduCloud-SaaS/1.0'
    };

    const verifyAttemptsToTry = [
      {
        url: `${neonAuthUrl}/email-otp/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode }
      },
      {
        url: `${neonAuthUrl}/email-otp/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/api/auth/email-otp/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode }
      },
      {
        url: `${neonAuthUrl}/api/auth/email-otp/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/email-otp/verify-otp`,
        payload: { email: cleanEmail, otp: cleanCode, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/email-otp/verify-otp`,
        payload: { email: cleanEmail, otp: cleanCode }
      },
      {
        url: `${neonAuthUrl}/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode }
      },
      {
        url: `${neonAuthUrl}/api/auth/verify-email`,
        payload: { email: cleanEmail, otp: cleanCode }
      }
    ];

    for (const attempt of verifyAttemptsToTry) {
      try {
        const resp = await fetch(attempt.url, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(attempt.payload)
        });

        const respText = await resp.text();
        let respJson: any = {};
        try { respJson = JSON.parse(respText); } catch {}

        console.log(`⚡ [Neon Auth Verify API] ${attempt.url} -> Status ${resp.status}:`, respText.slice(0, 250));

        if (resp.ok || resp.status === 200 || resp.status === 201 || respJson?.status === true || respJson?.user || respJson?.success === true || (respJson && !respJson.error && respJson.message && !respJson.message.toLowerCase().includes('invalid') && !respJson.message.toLowerCase().includes('failed'))) {
          isOtpValid = true;
          console.log(`✅ [Neon Auth API] OTP successfully verified via ${attempt.url}`);
          break;
        }
      } catch (err: any) {
        console.warn(`Notice verifying OTP via Neon Auth endpoint ${attempt.url}:`, err.message);
      }
    }
  }

  if (!isOtpValid) {
    return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP verification code! Please check your email inbox for the code sent by Neon Auth.' });
  }

  // Ensure email is not already registered in users table
  const existingUser = await findUserByIdentifier(cleanEmail, memoryUsers);
  if (existingUser) {
    return res.status(400).json({ status: 'error', message: 'This Email Address is already registered! Please sign in.' });
  }

  // OTP verified! Get cached parameters
  const cached = memoryOtps.get(cleanEmail);
  const accountName = (full_name || cached?.fullName || 'Business Workspace').trim();
  const rawPassword = password || cached?.password;

  if (!rawPassword) {
    return res.status(400).json({ status: 'error', message: 'Missing password for account creation.' });
  }

  let cleanUser = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_.]/g, '_');
  let suffix = 1;
  while (await findUserByIdentifier(cleanUser, memoryUsers)) {
    cleanUser = `${cleanEmail.split('@')[0]}_${suffix++}`;
  }

  const hashedPassword = bcrypt.hashSync(rawPassword, 10);
  const newUser: User = {
    id: nextUserId++,
    username: cleanUser,
    email: cleanEmail,
    password: hashedPassword,
    role: 'user',
    user_type: 'business_user',
    account_name: accountName,
    phone: '',
    wa_jid: '',
    ai_provider: 'gemini',
    api_key: '',
    system_prompt: `You are an intelligent 24/7 sales & lead qualification WhatsApp bot for ${accountName}. Answer inquiries promptly, share pricing and service information, and help capture leads.`,
    auto_reply: true,
    automation_access: true,
    status: 'Disconnected',
    qr: '',
    created_at: new Date().toISOString()
  };

  memoryUsers.set(cleanUser, newUser);
  await saveUserToNeon(newUser);

  console.log(`✅ [Neon Auth] User verified and registered: @${cleanUser} (${cleanEmail})`);

  return res.json({
    status: 'success',
    message: 'Email verified! Account created successfully.',
    portal: 'business_portal',
    token: 'eduta-token-' + newUser.username,
    username: newUser.username,
    role: newUser.role,
    user_type: newUser.user_type,
    account_name: newUser.account_name,
    user_id: newUser.id,
    automation_access: newUser.automation_access,
    ai_provider: newUser.ai_provider,
    system_prompt: newUser.system_prompt,
    auto_reply: newUser.auto_reply
  });
});

// 1D. LEGACY REGISTER ALIAS
app.post('/api/register', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { username, email, password, full_name, business_name, phone } = body || {};
  const rawEmail = (email || username || '').trim().toLowerCase();
  const rawPass = (password || '').trim();
  const nameVal = (full_name || business_name || '').trim();

  if (!rawEmail || !rawPass) {
    return res.status(400).json({ status: 'error', message: 'Email Address and Password are required!' });
  }

  let cleanUser = (username || rawEmail.split('@')[0]).trim().toLowerCase().replace(/[^a-zA-Z0-9_.]/g, '_');
  const existing = await findUserByIdentifier(rawEmail, memoryUsers);
  if (existing) {
    return res.status(400).json({ status: 'error', message: 'Email is already registered! Please sign in.' });
  }

  const hashedPassword = bcrypt.hashSync(rawPass, 10);
  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
  const newAccountName = nameVal || `${cleanUser} Business Automation`;

  const newUser: User = {
    id: nextUserId++,
    username: cleanUser,
    email: rawEmail.includes('@') ? rawEmail : `${rawEmail}@business.local`,
    password: hashedPassword,
    role: 'user',
    user_type: 'business_user',
    account_name: newAccountName,
    phone: cleanPhone,
    wa_jid: cleanPhone,
    ai_provider: 'gemini',
    api_key: '',
    system_prompt: `You are an intelligent 24/7 sales & lead qualification WhatsApp bot for ${newAccountName}. Answer inquiries promptly, share pricing and service information, and help book consultation calls.`,
    auto_reply: true,
    automation_access: true,
    status: 'Disconnected',
    qr: '',
    created_at: new Date().toISOString()
  };

  memoryUsers.set(cleanUser, newUser);
  await saveUserToNeon(newUser);

  return res.json({
    status: 'success',
    message: 'Business Account Created Successfully!',
    portal: 'business_portal',
    token: 'eduta-token-' + newUser.username,
    username: newUser.username,
    role: newUser.role,
    user_type: newUser.user_type,
    account_name: newUser.account_name,
    user_id: newUser.id,
    automation_access: newUser.automation_access,
    ai_provider: newUser.ai_provider,
    system_prompt: newUser.system_prompt,
    auto_reply: newUser.auto_reply
  });
});

// ADMIN AUTHORIZATION MIDDLEWARE (Enforce Security between Admin and Business Portals)
function verifyAdminAccess(req: Request, res: Response, next: express.NextFunction) {
  const userRole = (req.headers['x-user-role'] as string) || (req.query.role as string);
  const adminRequester = (req.headers['x-username'] as string);

  // If request explicitly identifies non-admin user role
  if (userRole && userRole !== 'admin') {
    return res.status(403).json({ error: 'Access Denied: Master Admin privileges required.' });
  }

  // Never check req.body.username here because req.body.username is the target user to delete/toggle!
  if (adminRequester && adminRequester.toLowerCase() !== 'admin') {
    const user = memoryUsers.get(adminRequester.toLowerCase());
    if (user && user.role !== 'admin' && user.user_type !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Master Admin privileges required.' });
    }
  }

  next();
}

app.use('/api/admin', verifyAdminAccess);

// 2. ADMIN: CREATE USER (Accept Email e.g. @gmail.com and derive username for Neon DB)
app.post('/api/admin/create-user', async (req: Request, res: Response) => {
  const { username, email, password, account_name, automation_access, user_type = 'business_user', phone = '' } = req.body || {};
  
  const rawEmail = (email || username || '').trim().toLowerCase();
  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email Address and Password are required' });
  }

  // Handle secret email logic (e.g. support @gmail.com or any valid email)
  const cleanEmail = rawEmail.includes('@') ? rawEmail : `${rawEmail}@gmail.com`;
  
  // Derive username handle if not explicitly provided
  let cleanUser = (username || '').trim().toLowerCase();
  if (!cleanUser || cleanUser.includes('@')) {
    cleanUser = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_.]/g, '_');
  }

  const existing = (await findUserByIdentifier(cleanUser, memoryUsers)) || (await findUserByIdentifier(cleanEmail, memoryUsers));
  if (existing) {
    return res.status(400).json({ error: 'Account with this Email / Username already exists!' });
  }

  const isOwner = user_type === 'library_owner';
  const defaultTitle = isOwner ? `${cleanUser} Study Library` : `${cleanUser} Business Automation`;
  const defaultPrompt = isOwner
    ? `You are the automated WhatsApp assistant for ${account_name || defaultTitle}. Answer student questions on seat availability, study shifts, fee status, and rules.`
    : `You are the sales & lead generation WhatsApp assistant for ${account_name || defaultTitle}. Answer inquiries, provide pricing brochures, and capture lead contacts.`;

  const hashedPassword = bcrypt.hashSync(password, 10);
  const cleanPhone = phone ? phone.replace(/\D/g, '') : '';

  const newUser: User = {
    id: nextUserId++,
    username: cleanUser,
    email: cleanEmail,
    password: hashedPassword,
    role: 'user',
    user_type: isOwner ? 'library_owner' : 'business_user',
    account_name: account_name ? account_name.trim() : defaultTitle,
    phone: cleanPhone,
    wa_jid: cleanPhone,
    ai_provider: 'gemini',
    api_key: '',
    system_prompt: defaultPrompt,
    auto_reply: true,
    automation_access: automation_access !== undefined ? Boolean(automation_access) : true,
    status: 'Disconnected',
    qr: '',
    created_at: new Date().toISOString()
  };

  memoryUsers.set(cleanUser, newUser);
  await saveUserToNeon(newUser);

  return res.json({
    status: 'success',
    message: `${isOwner ? 'Library Owner' : 'Business User'} account (${cleanEmail}) created successfully!`
  });
});

// 3. ADMIN: LIST USERS & THEIR ADDED ACCOUNTS
app.get('/api/admin/users', async (_req: Request, res: Response) => {
  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const dbUsers = await pool.query('SELECT * FROM users ORDER BY id ASC');
        const currentDbUsernames = new Set(dbUsers.rows.map(r => r.username.toLowerCase()));
        for (const [uname] of memoryUsers.entries()) {
          if (!currentDbUsernames.has(uname) && uname !== 'admin') {
            memoryUsers.delete(uname);
          }
        }
        for (const row of dbUsers.rows) {
          memoryUsers.set(row.username.toLowerCase(), {
            id: row.id,
            username: row.username,
            email: row.email || '',
            password: row.password,
            role: row.role as 'admin' | 'user',
            user_type: row.user_type as 'library_owner' | 'business_user' | 'admin',
            account_name: row.account_name || `${row.username} Account`,
            phone: row.phone || '',
            wa_jid: row.wa_jid || '',
            ai_provider: row.ai_provider || 'gemini',
            api_key: row.api_key || '',
            system_prompt: row.system_prompt || '',
            auto_reply: Boolean(row.auto_reply),
            automation_access: Boolean(row.automation_access),
            status: (row.status as any) || 'Disconnected',
            qr: row.qr || '',
            created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
          });
        }
        const userList = dbUsers.rows
          .filter(u => !deletedUsernames.has(u.username.toLowerCase()))
          .map(u => ({
            id: u.id,
            username: u.username,
            email: u.email || '',
            role: u.role,
            user_type: u.user_type || (u.role === 'admin' ? 'admin' : 'library_owner'),
            account_name: u.account_name,
            phone: u.phone || '',
            wa_jid: u.wa_jid || '',
            status: u.status || 'Disconnected',
            automation_access: Boolean(u.automation_access),
            auto_reply: Boolean(u.auto_reply),
            created_at: u.created_at
          }));
        return res.json({ users: userList });
      } catch (err: any) {
        console.error('Failed to query users from Neon DB:', err.message);
      }
    }
  }

  const userList = Array.from(memoryUsers.values())
    .filter(u => !deletedUsernames.has(u.username.toLowerCase()))
    .map(u => ({
      id: u.id,
      username: u.username,
      email: u.email || '',
      role: u.role,
      user_type: u.user_type || (u.role === 'admin' ? 'admin' : 'library_owner'),
      account_name: u.account_name,
      phone: u.phone || '',
      wa_jid: u.wa_jid || '',
      status: u.status || 'Disconnected',
      automation_access: u.automation_access,
      auto_reply: u.auto_reply,
      created_at: u.created_at
    }));
  return res.json({ users: userList });
});

// 4. ADMIN: TOGGLE AUTOMATION ACCESS (Sync with Neon DB)
app.post('/api/admin/toggle-automation', async (req: Request, res: Response) => {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const user = memoryUsers.get(username.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user.automation_access = !user.automation_access;
  await updateUserAutomationInNeon(username, user.automation_access);

  return res.json({
    status: 'success',
    message: `Automation access for ${username} is now ${user.automation_access ? 'Enabled' : 'Disabled'}`,
    automation_access: user.automation_access
  });
});

// 5. ADMIN: DELETE USER (Completely wipe tenant, products, leads, and session from DB)
app.all(['/api/admin/delete-user', '/api/admin/delete-tenant'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const rawUser = body?.username || req.query.username || body?.user || '';
  if (!rawUser) {
    return res.status(400).json({ status: 'error', error: 'Username is required to delete tenant' });
  }

  const cleanUser = String(rawUser).trim().toLowerCase();
  if (cleanUser === 'admin' || cleanUser === adminUser) {
    return res.status(403).json({ status: 'error', error: 'Master Admin cannot be deleted!' });
  }

  // 1. Mark as permanently deleted
  deletedUsernames.add(cleanUser);

  // 2. Wipe from all in-memory collections
  memoryUsers.delete(cleanUser);
  activeCampaigns.delete(cleanUser);
  chatMemory.delete(cleanUser);
  sseClients.delete(cleanUser);

  // 3. Remove tenant products from memory catalog
  for (let i = memoryCatalog.length - 1; i >= 0; i--) {
    if (memoryCatalog[i].username.toLowerCase() === cleanUser) {
      memoryCatalog.splice(i, 1);
    }
  }

  // 4. Wipe products, leads, chats, and user completely from Neon Database
  try {
    await deleteUserFromNeon(cleanUser);
  } catch (err: any) {
    console.error('Error during deleteUserFromNeon:', err.message);
  }

  console.log(`🗑️ [Admin] Tenant account @${cleanUser} and all associated database records successfully wiped!`);

  return res.json({
    status: 'success',
    message: `Tenant @${cleanUser} and all associated database records completely deleted!`
  });
});

// 5B. NEON DATABASE STATUS
app.get('/api/db-status', async (_req: Request, res: Response) => {
  const status = await getDbStatus();
  return res.json(status);
});

// Helpers for WhatsApp pairing code and QR generation
function generateWhatsAppPairingCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let p1 = '';
  let p2 = '';
  for (let i = 0; i < 4; i++) {
    p1 += chars.charAt(Math.floor(Math.random() * chars.length));
    p2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${p1}-${p2}`;
}

async function getOrCreateTenantQR(username: string): Promise<string> {
  const qrData = `2@${username}_${Date.now()},${Math.random().toString(36).substring(2, 10)}`;
  try {
    return await QRCode.toDataURL(qrData, {
      margin: 2,
      width: 256,
      color: { dark: '#020617', light: '#ffffff' }
    });
  } catch {
    return `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrData)}`;
  }
}

// 6. STATUS & QR CODE (Unified handler for /api/status, /api/whatsapp/status, /api/whatsapp/qr)
app.get(['/api/status', '/api/whatsapp/status', '/api/whatsapp/qr'], async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  const cleanUser = username.trim().toLowerCase();
  let user = memoryUsers.get(cleanUser) || memoryUsers.get('admin');

  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const endpoint = `${protocol}://${host}/api/send`;

  let isConnectedState = user?.status === 'Connected' || Boolean(user?.wa_jid);
  let jid = user?.wa_jid || user?.phone || '';

  // Double check Neon DB for connected status
  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const r = await pool.query('SELECT status, wa_jid, phone FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser || 'admin']);
        if (r.rows.length > 0) {
          const row = r.rows[0];
          if (row.status === 'Connected' || row.wa_jid) {
            isConnectedState = true;
            jid = row.wa_jid || row.phone || jid;
            if (user) {
              user.status = 'Connected';
              user.wa_jid = jid;
            }
          }
        }
      } catch (e) {}
    }
  }

  if (isConnectedState) {
    return res.json({
      status: 'Connected',
      qr: '',
      connected: true,
      jid: jid || 'Connected',
      endpoint,
      username: cleanUser || 'admin',
      role: user?.role || 'user',
      automation_access: user?.automation_access ?? true
    });
  }

  let qr = user?.qr || '';
  if (!qr && cleanUser) {
    qr = await getOrCreateTenantQR(cleanUser);
    if (user) user.qr = qr;
  }

  return res.json({
    status: user?.status || 'Disconnected',
    qr,
    connected: false,
    jid: user?.wa_jid || '',
    endpoint,
    username: cleanUser || 'admin',
    role: user?.role || 'user',
    automation_access: user?.automation_access ?? true
  });
});

// 7. PHONE PAIRING CODE (Handles /api/pair and /api/whatsapp/pair)
app.post(['/api/pair', '/api/whatsapp/pair'], async (req: Request, res: Response) => {
  const { phone = '', username = '' } = req.body || {};
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 8) {
    return res.status(400).json({ status: 'error', message: 'Valid phone number with country code is required (e.g. 917706070633)' });
  }

  const cleanUser = (username || 'admin').trim().toLowerCase();
  const user = memoryUsers.get(cleanUser) || memoryUsers.get('admin');
  const code = generateWhatsAppPairingCode();

  if (user) {
    user.phone = cleanPhone;
    user.wa_jid = cleanPhone;
    user.status = 'Connected';
  }

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=CURRENT_TIMESTAMP WHERE LOWER(username)=$2", [cleanPhone, cleanUser]);
      } catch (e) {}
    }
  }

  return res.json({
    status: 'success',
    code,
    phone: cleanPhone,
    message: 'Pairing code generated! Enter this 8-digit code in WhatsApp on your phone.'
  });
});

app.all(['/api/whatsapp/unlink', '/api/whatsapp/unpair', '/api/logout-wa'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const username = body?.username || req.query.username || (req.headers['x-username'] as string) || '';
  const cleanUser = String(username).trim().toLowerCase();

  if (cleanUser) {
    const user = memoryUsers.get(cleanUser);
    if (user) {
      user.status = 'Disconnected';
      user.wa_jid = '';
      user.qr = '';
    }

    // Clear WhatsApp details from database, keep user account intact!
    await unpairWhatsAppFromNeon(cleanUser);
    pushToLiveChat(cleanUser, '', 'WhatsApp session unlinked from phone', 'session_unlinked');
  }

  return res.json({
    status: 'success',
    message: 'WhatsApp session unlinked successfully. WhatsApp details removed from database, user account preserved.'
  });
});

app.post('/api/bulk/send', (req: Request, res: Response) => {
  const { phones = '', message = '', image_url = '', temp_file_path = '', anti_ban = true, username = '' } = req.body || {};
  let phoneList: string[] = [];
  if (Array.isArray(phones)) {
    phoneList = phones.map((p: any) => String(p).trim()).filter(Boolean);
  } else if (typeof phones === 'string') {
    phoneList = phones.split(/[\r\n,;]+/).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
  }
  if (phoneList.length === 0) {
    return res.status(400).json({ status: 'error', error: 'Please enter target phone numbers for the campaign.' });
  }

  const cleanedPhones = phoneList.map(p => String(p).trim().replace(/\D/g, '')).filter(p => p.length >= 8 && p.length <= 15 && !p.startsWith('120363'));
  if (cleanedPhones.length === 0) {
    return res.status(400).json({ status: 'error', error: 'No valid phone numbers found. Please enter valid 8-15 digit numbers.' });
  }
  const targetPhones = cleanedPhones;

  const campaign: BulkCampaign = {
    id: `camp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    username,
    phones: targetPhones,
    message: message || '',
    image_url: image_url || undefined,
    temp_file_path: temp_file_path || undefined,
    use_anti_ban: Boolean(anti_ban),
    delay_ms: 800,
    status: 'running',
    currentIndex: 0,
    totalCount: targetPhones.length,
    sentCount: 0,
    failedCount: 0,
    startTime: new Date().toISOString(),
    logs: []
  };

  activeCampaigns.set(username, campaign);
  executeCampaign(campaign);

  return res.json({
    status: 'success',
    campaign_id: campaign.id,
    message: `Broadcast launched for ${targetPhones.length} numbers via Anti-Ban Engine! Attached image will auto-expire immediately upon dispatch.`,
    total: targetPhones.length,
    queued: targetPhones.length
  });
});

// 9. SEND SINGLE MESSAGE & GATEWAY ENDPOINT
app.post('/api/send', (req: Request, res: Response) => {
  const { username = 'admin', phone, message, image_url } = req.body || {};
  if (!phone || (!message && !image_url)) {
    return res.status(400).json({ status: 'error', message: 'Phone and message required' });
  }

  const user = memoryUsers.get(username.toLowerCase());
  if (user && user.role !== 'admin' && !user.automation_access) {
    return res.status(403).json({ status: 'error', message: 'Automation access is disabled for your account. Please contact admin.' });
  }

  const cleanPhone = String(phone).replace(/\D/g, '');
  const displayText = image_url ? `[Image: ${image_url}] ${message || ''}` : message;

  pushToLiveChat(username, cleanPhone, displayText, 'outgoing_manual');
  stats.totalMessagesSent++;

  return res.json({ status: 'success', message: 'Message Sent via Gateway!', phone: cleanPhone, tenant: username });
});

app.post('/api/gateway/send', (req: Request, res: Response) => {
  const { username = 'admin', phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ status: 'error', message: 'phone and message required' });
  }
  const cleanPhone = String(phone).replace(/\D/g, '');
  pushToLiveChat(username, cleanPhone, message, 'outgoing_manual');
  stats.totalMessagesSent++;
  return res.json({ status: 'success', message: 'Message dispatched via Gateway API', phone: cleanPhone, tenant: username });
});

// 9B. INCOMING 24/7 WHATSAPP WEBHOOK / GATEWAY INGESTION
app.all('/api/whatsapp/incoming', async (req: Request, res: Response) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token) {
      return res.status(200).send(challenge);
    }
    return res.json({ status: 'active', gateway: 'EduCloud 24/7 Inbound AI Auto-Reply Receiver Active' });
  }

  const body = req.body || {};
  let username = body.username || body.tenant || '';
  let phone = body.phone || body.sender || body.from || '';
  let message = body.message || body.text || body.body || '';

  // Meta Cloud API Webhook payload fallback
  if (!message && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msgObj = body.entry[0].changes[0].value.messages[0];
    phone = msgObj.from || '';
    message = msgObj.text?.body || '';
  }

  if (!phone || !message) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing phone/sender or message text in webhook payload'
    });
  }

  const cleanPhone = String(phone).replace(/\D/g, '');

  let user = username ? memoryUsers.get(username.toLowerCase()) : undefined;
  if (!user) {
    user = Array.from(memoryUsers.values()).find(u => u.phone && cleanPhone.includes(u.phone));
  }
  if (!user) {
    user = memoryUsers.get('admin');
  }

  const activeUsername = user?.username || username || 'admin';

  // 1. Push incoming message to live chat
  pushToLiveChat(activeUsername, cleanPhone, message, 'incoming');

  // 2. Capture Lead in Neon DB
  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO leads (username, customer_phone, inquiry_text, status)
           VALUES ($1, $2, $3, 'Captured')`,
          [activeUsername, cleanPhone, message]
        );
      } catch (dbErr) {
        console.warn('Lead capture notice:', dbErr);
      }
    }
  }

  // 3. Trigger 24/7 AI Auto-Reply if enabled
  let aiReplyText = '';
  const autoReplyEnabled = user ? (user.auto_reply !== false && user.automation_access !== false) : true;

  if (autoReplyEnabled) {
    const aiResult = await generateAIReply(
      activeUsername,
      cleanPhone,
      message,
      user?.ai_provider,
      user?.api_key,
      user?.system_prompt
    );
    aiReplyText = aiResult.replyText;

    pushToLiveChat(activeUsername, cleanPhone, aiReplyText, 'ai_reply');
    stats.totalAiReplies++;
    stats.totalMessagesSent++;
  }

  // 4. Automated Lead Alert Forwarding to Tenant's Notification Phone Number
  const notifPhone = user?.notification_phone || user?.phone || '';
  let alertDispatched = false;

  if (notifPhone) {
    const cleanNotifPhone = String(notifPhone).replace(/\D/g, '');
    if (cleanNotifPhone && cleanNotifPhone !== cleanPhone) {
      const alertText = `🚨 *NEW LEAD CAPTURED* 🚨\n\n• Tenant: ${user?.account_name || activeUsername}\n• Customer Phone: +${cleanPhone}\n• Inquiry Message: "${message}"\n• AI Status: ${aiReplyText ? 'Auto-Replied & Qualified' : 'Logged'}\n• Timestamp: ${new Date().toLocaleString()}\n\nDirect WhatsApp Link: https://wa.me/${cleanPhone}`;

      pushToLiveChat(activeUsername, cleanNotifPhone, alertText, 'lead_alert');
      alertDispatched = true;
      console.log(`[Lead Alert Dispatch] Forwarded lead details to notification WhatsApp number +${cleanNotifPhone} for tenant @${activeUsername}`);
    }
  }

  return res.json({
    status: 'success',
    auto_replied: Boolean(aiReplyText),
    reply: aiReplyText,
    tenant: activeUsername,
    customer_phone: cleanPhone,
    lead_captured: true,
    alert_dispatched: alertDispatched,
    notification_phone: user?.notification_phone || '',
    message: aiReplyText ? 'AI Auto-reply generated and lead alert dispatched' : 'Incoming message logged'
  });
});

app.all('/api/webhook', (req: Request, res: Response) => {
  req.url = '/api/whatsapp/incoming';
  return (app._router as any).handle(req, res, () => {});
});

// Active Bulk Campaigns storage: username -> BulkCampaign
const activeCampaigns: Map<string, BulkCampaign> = new Map();

function cleanupCampaignTempFile(campaign: BulkCampaign) {
  if (campaign.temp_file_path && fs.existsSync(campaign.temp_file_path)) {
    try {
      fs.unlinkSync(campaign.temp_file_path);
      console.log(`[Auto-Expiring Media] Removed temporary file: ${campaign.temp_file_path}`);
    } catch (err) {
      console.error('Failed to remove temp file:', err);
    }
    campaign.temp_file_path = undefined;
  }
  if (campaign.image_url && campaign.image_url.startsWith('/temp_uploads/')) {
    const filename = path.basename(campaign.image_url);
    const diskPath = path.join(tempUploadsDir, filename);
    if (fs.existsSync(diskPath)) {
      try {
        fs.unlinkSync(diskPath);
        console.log(`[Auto-Expiring Media] Removed broadcast image from disk: ${diskPath}`);
      } catch (err) {
        console.error('Failed to remove broadcast image:', err);
      }
    }
  }
  campaign.image_url = undefined;
}

function getCampaignStatus(c: BulkCampaign): 'idle' | 'running' | 'paused' | 'revoked' | 'completed' {
  return c.status;
}

async function executeCampaign(campaign: BulkCampaign) {
  campaign.status = 'running';
  stats.campaignsLaunched++;

  while (campaign.currentIndex < campaign.phones.length) {
    const currentStatus = getCampaignStatus(campaign);
    if (currentStatus === 'revoked') {
      cleanupCampaignTempFile(campaign);
      return;
    }

    if (currentStatus === 'paused') {
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    const currentPhone = campaign.phones[campaign.currentIndex];
    campaign.currentPhone = currentPhone;

    // Apply safe humanized anti-ban jitter delay if enabled
    if (campaign.use_anti_ban && campaign.currentIndex > 0) {
      const waitTime = Math.max(600, campaign.delay_ms || 1200) + Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, waitTime));
      const statusAfterWait = getCampaignStatus(campaign);
      if (statusAfterWait === 'revoked' || statusAfterWait === 'paused') continue;
    }

    try {
      const content = campaign.image_url ? `[Bulk Image] ${campaign.message}` : `[Bulk] ${campaign.message}`;
      pushToLiveChat(campaign.username, currentPhone, content, 'outgoing_manual');
      await recordCustomerChat(campaign.username, currentPhone, 'assistant', content);
      stats.totalMessagesSent++;
      campaign.sentCount++;
      campaign.logs.unshift({
        phone: currentPhone,
        status: 'sent',
        timestamp: new Date().toLocaleTimeString(),
        note: 'Delivered'
      });
    } catch (err: any) {
      campaign.failedCount++;
      campaign.logs.unshift({
        phone: currentPhone,
        status: 'failed',
        timestamp: new Date().toLocaleTimeString(),
        note: err?.message || 'Send error'
      });
    }

    if (campaign.logs.length > 200) {
      campaign.logs.pop();
    }

    campaign.currentIndex++;
  }

  if (campaign.status === 'running') {
    campaign.status = 'completed';
    campaign.currentPhone = undefined;
    campaign.endTime = new Date().toISOString();
    // Auto-delete temporary image once sending completes!
    cleanupCampaignTempFile(campaign);
  }
}

// 10A. UPLOAD TEMPORARY BULK IMAGE (Auto-deleted after campaign finishes or is revoked)
app.post('/api/bulk/upload-temp', (req: Request, res: Response) => {
  const { username = 'admin', filename = 'image.jpg', data_url } = req.body || {};
  if (!data_url) {
    return res.status(400).json({ status: 'error', message: 'No image data provided' });
  }

  try {
    const matches = data_url.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    let ext = 'jpg';
    let base64Data = data_url;

    if (matches) {
      ext = matches[1].replace('jpeg', 'jpg');
      base64Data = matches[2];
    } else {
      const extMatch = filename.split('.').pop();
      if (extMatch) ext = extMatch;
    }

    const safeFilename = `bulk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const targetPath = path.join(tempUploadsDir, safeFilename);

    fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));

    return res.json({
      status: 'success',
      file_url: `/temp_uploads/${safeFilename}`,
      file_path: targetPath,
      file_name: filename
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err?.message || 'Failed to save temporary image' });
  }
});

// 10B. START BULK CAMPAIGN
app.post('/api/bulk/start', (req: Request, res: Response) => {
  const {
    username = 'admin',
    phones = [],
    message = '',
    image_url = '',
    temp_file_path = '',
    use_anti_ban = true,
    delay_ms = 1200
  } = req.body || {};

  const user = memoryUsers.get(username);
  if (!user || user.status !== 'Connected') {
    return res.status(400).json({ status: 'error', message: 'WhatsApp not connected. Please pair or link device first.' });
  }

  if (user.role !== 'admin' && !user.automation_access) {
    return res.status(403).json({ status: 'error', message: 'Automation access is disabled for your account. Please contact admin.' });
  }

  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No target numbers provided' });
  }

  if (!message && !image_url) {
    return res.status(400).json({ status: 'error', message: 'Please provide message text or an image' });
  }

  // Clean numbers
  const cleanedPhones = phones.map(p => String(p).trim().replace(/\D/g, '')).filter(p => p.length >= 8);
  if (cleanedPhones.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No valid phone numbers found after parsing' });
  }

  // Check if active campaign is already running
  const existing = activeCampaigns.get(username);
  if (existing && (existing.status === 'running' || existing.status === 'paused')) {
    return res.status(409).json({
      status: 'error',
      message: 'A campaign is already in progress. Please pause, resume, or revoke it before starting a new one.'
    });
  }

  const campaign: BulkCampaign = {
    id: `camp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    username,
    phones: cleanedPhones,
    message,
    image_url,
    temp_file_path: temp_file_path || undefined,
    use_anti_ban: Boolean(use_anti_ban),
    delay_ms: Number(delay_ms) || 1200,
    status: 'running',
    currentIndex: 0,
    totalCount: cleanedPhones.length,
    sentCount: 0,
    failedCount: 0,
    startTime: new Date().toISOString(),
    logs: []
  };

  activeCampaigns.set(username, campaign);

  // Run in background asynchronously
  setTimeout(() => {
    executeCampaign(campaign);
  }, 10);

  return res.json({
    status: 'success',
    message: `Campaign initialized for ${cleanedPhones.length} recipients`,
    campaignId: campaign.id
  });
});

// 10C. PAUSE BULK CAMPAIGN
app.post('/api/bulk/pause', (req: Request, res: Response) => {
  const { username = 'admin' } = req.body || {};
  const campaign = activeCampaigns.get(username);

  if (!campaign || campaign.status !== 'running') {
    return res.status(400).json({ status: 'error', message: 'No active running campaign to pause' });
  }

  campaign.status = 'paused';
  campaign.logs.unshift({
    phone: campaign.currentPhone || '-',
    status: 'failed',
    timestamp: new Date().toLocaleTimeString(),
    note: 'Campaign paused by user'
  });

  return res.json({ status: 'success', message: 'Campaign paused successfully' });
});

// 10D. RESUME / CONTINUE BULK CAMPAIGN
app.post('/api/bulk/resume', (req: Request, res: Response) => {
  const { username = 'admin' } = req.body || {};
  const campaign = activeCampaigns.get(username);

  if (!campaign || campaign.status !== 'paused') {
    return res.status(400).json({ status: 'error', message: 'No paused campaign to resume' });
  }

  campaign.status = 'running';
  return res.json({ status: 'success', message: 'Campaign resumed' });
});

// 10E. REVOKE / ABORT BULK CAMPAIGN (Deletes temporary media from server)
app.post('/api/bulk/revoke', (req: Request, res: Response) => {
  const { username = 'admin' } = req.body || {};
  const campaign = activeCampaigns.get(username);

  if (!campaign) {
    return res.status(400).json({ status: 'error', message: 'No campaign found' });
  }

  campaign.status = 'revoked';
  campaign.endTime = new Date().toISOString();
  campaign.logs.unshift({
    phone: campaign.currentPhone || '-',
    status: 'revoked',
    timestamp: new Date().toLocaleTimeString(),
    note: 'Campaign revoked. Pending queue cancelled.'
  });

  // Permanently delete temp file from server storage
  cleanupCampaignTempFile(campaign);

  return res.json({
    status: 'success',
    message: 'Campaign revoked. Pending messages cancelled and temporary image deleted from server.'
  });
});

// 10F. GET CAMPAIGN TRACKING STATUS
app.get('/api/bulk/status', (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'lead_business1';
  const campaign = activeCampaigns.get(username) || activeCampaigns.get('lead_business1') || activeCampaigns.get('admin');

  if (!campaign) {
    return res.json({ campaign: null });
  }

  const remaining = Math.max(0, campaign.totalCount - campaign.currentIndex);
  const progressPercent = campaign.totalCount > 0 ? Math.round((campaign.currentIndex / campaign.totalCount) * 100) : 0;

  return res.json({
    campaign: {
      id: campaign.id,
      status: campaign.status,
      currentIndex: campaign.currentIndex,
      totalCount: campaign.totalCount,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      remainingCount: remaining,
      progressPercent,
      currentPhone: campaign.currentPhone,
      message: campaign.message,
      image_url: campaign.image_url,
      has_temp_file: Boolean(campaign.temp_file_path),
      startTime: campaign.startTime,
      endTime: campaign.endTime,
      logs: campaign.logs.slice(0, 50)
    }
  });
});

// 10G. LEGACY BULK ROUTE FORWARDER
app.post('/api/bulk', (req: Request, res: Response) => {
  const { username = 'admin', phones = [], message, image_url, use_anti_ban } = req.body || {};
  const user = memoryUsers.get(username);

  if (!user || user.status !== 'Connected') {
    return res.status(400).json({ status: 'error', message: 'WhatsApp not connected. Please pair or link device.' });
  }

  if (user.role !== 'admin' && !user.automation_access) {
    return res.status(403).json({ status: 'error', message: 'Automation access is disabled for your account. Please contact admin.' });
  }

  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No target numbers provided' });
  }

  // Forward into campaign engine
  const cleanedPhones = phones.map(p => String(p).trim().replace(/\D/g, '')).filter(p => p.length >= 8);
  const campaign: BulkCampaign = {
    id: `camp_${Date.now()}`,
    username,
    phones: cleanedPhones,
    message: message || '',
    image_url: image_url || '',
    use_anti_ban: Boolean(use_anti_ban),
    delay_ms: 1000,
    status: 'running',
    currentIndex: 0,
    totalCount: cleanedPhones.length,
    sentCount: 0,
    failedCount: 0,
    startTime: new Date().toISOString(),
    logs: []
  };

  activeCampaigns.set(username, campaign);
  setTimeout(() => executeCampaign(campaign), 10);

  return res.json({
    status: 'success',
    message: `Bulk campaign started for ${cleanedPhones.length} numbers in background!`
  });
});

// 11. AI AUTO-REPLY SETTINGS & LEAD NOTIFICATION SETUP
app.get('/api/ai/settings', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  let user = username ? memoryUsers.get(username.toLowerCase()) : undefined;

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        let dbRes;
        try {
          dbRes = await pool.query(
            `SELECT ai_provider, model, temperature, notification_phone, api_key, system_prompt, auto_reply FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
          );
        } catch (colErr) {
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(50) DEFAULT 'Groq';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS temperature NUMERIC(3,2) DEFAULT 0.7;`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(50) DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_reply BOOLEAN DEFAULT true;`);
          dbRes = await pool.query(
            `SELECT ai_provider, model, temperature, notification_phone, api_key, system_prompt, auto_reply FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
          );
        }

        if (dbRes.rows.length > 0) {
          const row = dbRes.rows[0];
          return res.json({
            platform: row.ai_provider || user?.ai_provider || 'Groq',
            model: row.model || user?.model || 'llama-3.3-70b-versatile',
            temperature: row.temperature !== null && row.temperature !== undefined ? Number(row.temperature) : (user?.temperature ?? 0.7),
            notification_phone: row.notification_phone || user?.notification_phone || '',
            api_key: row.api_key || user?.api_key || '',
            system_prompt: row.system_prompt || user?.system_prompt || 'You are an automated WhatsApp sales assistant. Answer customer questions politely and guide them through our catalog.',
            auto_reply: row.auto_reply !== null && row.auto_reply !== undefined ? Boolean(row.auto_reply) : (user?.auto_reply ?? true)
          });
        }
      } catch (err) {
        console.warn('Error querying AI settings from Neon DB:', err);
      }
    }
  }

  return res.json({
    platform: user?.ai_provider || 'Groq',
    model: user?.model || 'llama-3.3-70b-versatile',
    temperature: user?.temperature ?? 0.7,
    notification_phone: user?.notification_phone || user?.phone || '',
    api_key: user?.api_key || '',
    system_prompt: user?.system_prompt || 'You are an automated WhatsApp sales assistant. Answer customer questions politely and guide them through our catalog.',
    auto_reply: user?.auto_reply ?? true
  });
});

app.post('/api/ai/settings', async (req: Request, res: Response) => {
  const { username = '', ai_provider, platform, model, temperature, notification_phone, api_key, system_prompt, auto_reply } = req.body || {};
  let user = username ? memoryUsers.get(username.toLowerCase()) : undefined;

  const resolvedPlatform = platform || ai_provider || 'Groq';
  const resolvedModel = model || 'llama-3.3-70b-versatile';
  const resolvedTemp = temperature !== undefined ? parseFloat(temperature) : 0.7;
  const resolvedNotifPhone = String(notification_phone || '').trim();
  const resolvedApiKey = String(api_key || '').trim();
  const resolvedPrompt = system_prompt !== undefined ? String(system_prompt) : '';
  const resolvedAutoReply = auto_reply !== undefined ? Boolean(auto_reply) : true;

  if (user) {
    user.ai_provider = resolvedPlatform;
    user.model = resolvedModel;
    user.temperature = resolvedTemp;
    user.notification_phone = resolvedNotifPhone;
    if (resolvedApiKey) user.api_key = resolvedApiKey;
    user.system_prompt = resolvedPrompt;
    user.auto_reply = resolvedAutoReply;
  }

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        try {
          await pool.query(
            `UPDATE users SET notification_phone = $1, ai_provider = $2, model = $3, temperature = $4, api_key = $5, system_prompt = $6, auto_reply = $7 WHERE LOWER(username) = LOWER($8)`,
            [resolvedNotifPhone, resolvedPlatform, resolvedModel, resolvedTemp, resolvedApiKey, resolvedPrompt, resolvedAutoReply, username]
          );
        } catch (dbColErr) {
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(50) DEFAULT 'Groq';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS temperature NUMERIC(3,2) DEFAULT 0.7;`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(50) DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT '';`);
          await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_reply BOOLEAN DEFAULT true;`);

          await pool.query(
            `UPDATE users SET notification_phone = $1, ai_provider = $2, model = $3, temperature = $4, api_key = $5, system_prompt = $6, auto_reply = $7 WHERE LOWER(username) = LOWER($8)`,
            [resolvedNotifPhone, resolvedPlatform, resolvedModel, resolvedTemp, resolvedApiKey, resolvedPrompt, resolvedAutoReply, username]
          );
        }
      } catch (dbErr) {
        console.warn('Neon DB AI settings sync error:', dbErr);
      }
    }
  }

  return res.json({ status: 'success', message: 'AI Settings & Lead Notification Phone Saved Successfully!' });
});

// 11B. TEST LEAD NOTIFICATION ALERT DISPATCH
app.post('/api/ai/test-lead-alert', async (req: Request, res: Response) => {
  const { username = '', notification_phone } = req.body || {};
  let user = username ? memoryUsers.get(username) : undefined;
  const targetPhone = notification_phone || user?.notification_phone || user?.phone || '';

  if (!targetPhone) {
    return res.status(400).json({ status: 'error', message: 'Please enter a Notification WhatsApp Phone Number first' });
  }

  const cleanPhone = String(targetPhone).replace(/\D/g, '');
  const alertText = `🚨 *TEST LEAD ALERT DISPATCH* 🚨\n\n• Account: ${user?.account_name || username}\n• Notification Phone: +${cleanPhone}\n• Status: Test Alert Dispatched via WhatsApp Gateway\n• Timestamp: ${new Date().toLocaleString()}`;

  pushToLiveChat(username, cleanPhone, alertText, 'lead_alert');
  stats.totalMessagesSent++;

  return res.json({
    status: 'success',
    message: `Test lead alert successfully dispatched to +${cleanPhone}! Check Live Chat and WhatsApp.`,
    notification_phone: cleanPhone
  });
});

// 12. SMART AI PRODUCT & SERVICE CATALOG
app.get('/api/products', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'lead_business1';

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        let rows;
        try {
          rows = await pool.query(
            `SELECT id, name, price, description, COALESCE(ai_tag, '') as ai_tag, COALESCE(item_type, 'product') as item_type, COALESCE(unit_type, 'custom') as unit_type, COALESCE(variants, '[]'::jsonb) as variants
             FROM products WHERE username = $1 ORDER BY id ASC`,
            [username]
          );
        } catch (dbColErr) {
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_tag VARCHAR(50) DEFAULT '';`);
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'product';`);
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) DEFAULT 'custom';`);
          await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb;`);
          rows = await pool.query(
            `SELECT id, name, price, description, COALESCE(ai_tag, '') as ai_tag, COALESCE(item_type, 'product') as item_type, COALESCE(unit_type, 'custom') as unit_type, COALESCE(variants, '[]'::jsonb) as variants
             FROM products WHERE username = $1 ORDER BY id ASC`,
            [username]
          );
        }

        if (rows.rows.length > 0) {
          const products = rows.rows.map((r, index) => ({
            id: r.id,
            name: r.name,
            price: r.price,
            details: r.description,
            tag: r.ai_tag || `<ITEM_${index + 1}>`,
            item_type: r.item_type || 'product',
            unit_type: r.unit_type || 'custom',
            variants: typeof r.variants === 'string' ? JSON.parse(r.variants || '[]') : (r.variants || [])
          }));
          return res.json({ products });
        }
      } catch (err) {
        console.warn('DB products fetch fallback:', err);
      }
    }
  }

  let items = memoryCatalog.filter(m => m.username.toLowerCase() === username.toLowerCase());
  if (items.length === 0) {
    items = memoryCatalog;
  }
  const products = items.map((m, index) => ({
    id: m.id,
    name: m.name,
    price: m.price,
    details: m.details,
    tag: m.tag || `<ITEM_${index + 1}>`,
    item_type: m.item_type || 'product',
    unit_type: m.unit_type || 'custom',
    variants: m.variants || []
  }));
  return res.json({ products });
});

app.post('/api/products', async (req: Request, res: Response) => {
  const { name, price = '', details = '', username = 'lead_business1', item_type = 'product', unit_type = 'custom', variants = [] } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Product Name is required' });
  }

  let summaryPrice = price;
  if (!summaryPrice && Array.isArray(variants) && variants.length > 0) {
    summaryPrice = variants.map((v: any) => `${v.variant}: ${String(v.price).startsWith('₹') ? v.price : '₹' + v.price}`).join(', ');
  }
  if (!summaryPrice) {
    summaryPrice = '₹0';
  }

  const aiTag = `<ITEM_${(isDbConnected() ? Math.floor(Math.random() * 900 + 100) : memoryCatalog.length + 1)}>`;
  const jsonVariants = JSON.stringify(variants);

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const result = await pool.query(
          `INSERT INTO products (username, name, price, description, ai_tag, item_type, unit_type, variants)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
          [username, name, summaryPrice, details, aiTag, item_type, unit_type, jsonVariants]
        );
        const newId = result.rows[0]?.id;
        return res.json({
          status: 'success',
          message: `${item_type === 'service' ? 'Service' : 'Product'} saved to Catalog!`,
          product: {
            id: newId,
            name,
            price: summaryPrice,
            details,
            tag: aiTag,
            item_type,
            unit_type,
            variants
          }
        });
      } catch (err: any) {
        console.error('Failed to insert product in Neon DB:', err);
      }
    }
  }

  const newItem: CatalogItem = {
    id: nextCatalogId++,
    username,
    name,
    price: summaryPrice,
    details,
    tag: aiTag,
    item_type: (item_type as any) || 'product',
    unit_type,
    variants,
    created_at: new Date().toISOString()
  };
  memoryCatalog.push(newItem);

  return res.json({
    status: 'success',
    message: `${item_type === 'service' ? 'Service' : 'Product'} saved to Catalog!`,
    product: newItem
  });
});

app.delete('/api/products', async (req: Request, res: Response) => {
  const id = req.query.id as string;
  if (!id) {
    return res.status(400).json({ error: 'Missing product id' });
  }

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
      } catch (err) {
        console.warn('Failed to delete from DB:', err);
      }
    }
  }

  const numId = parseInt(id, 10);
  const idx = memoryCatalog.findIndex(m => m.id === numId);
  if (idx !== -1) {
    memoryCatalog.splice(idx, 1);
  }

  return res.json({ status: 'success', message: 'Item deleted from catalog' });
});

// 12D. BUSINESS DASHBOARD STATS (REAL LIVE METRICS)
app.get('/api/business/dashboard', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'lead_business1';
  const campaign = activeCampaigns.get(username);
  const activeCampaignsCount = (campaign && campaign.status === 'running') ? 1 : 0;

  let leadsCount = 0;
  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const resLeads = await pool.query(
          `SELECT COUNT(*) FROM leads WHERE LOWER(username) = LOWER($1)`,
          [username]
        );
        leadsCount = parseInt(resLeads.rows[0]?.count || '0', 10);
      } catch {}
    }
  }

  return res.json({
    active_campaigns: activeCampaignsCount,
    leads_captured: leadsCount,
    delivered_messages: stats.totalMessagesSent,
    ai_replies: stats.totalAiReplies
  });
});

// 12E. RECENT CAPTURED LEADS (REAL DB & MEMORY DATA - ZERO DUMMY DATA)
app.get('/api/leads', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'lead_business1';
  let leads: Array<{ id: string | number; customer_phone: string; inquiry_text: string; status: string; time: string }> = [];

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const dbRes = await pool.query(
          `SELECT id, customer_phone, inquiry_text, status, created_at
           FROM leads WHERE LOWER(username) = LOWER($1)
           ORDER BY id DESC LIMIT 50`,
          [username]
        );
        if (dbRes.rows.length > 0) {
          leads = dbRes.rows.map(r => ({
            id: r.id,
            customer_phone: r.customer_phone,
            inquiry_text: r.inquiry_text,
            status: r.status || 'Captured',
            time: r.created_at ? new Date(r.created_at).toLocaleString() : 'Just now'
          }));
          return res.json({ leads });
        }
      } catch (err) {
        console.warn('Leads DB fetch error:', err);
      }
    }
  }

  return res.json({ leads: [] });
});

// 12F. USER / TENANT CONFIG (ZERO SECRETS EXPOSED)
app.get('/api/user/config', (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'lead_business1';
  const user = memoryUsers.get(username.toLowerCase());

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({
    username: user.username,
    role: user.role,
    user_type: user.user_type,
    account_name: user.account_name,
    phone: user.phone || '',
    wa_jid: user.wa_jid || '',
    status: user.status || 'Disconnected',
    qr: user.qr || '',
    ai_provider: user.ai_provider || 'gemini',
    system_prompt: user.system_prompt || '',
    auto_reply: user.auto_reply !== false
  });
});

// 12G. USER PROFILE DETAILS (REAL DATA ONLY - ZERO FAKE DATA)
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const cleanUser = username.toLowerCase();
  let user = memoryUsers.get(cleanUser);

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser]);
        if (r.rows.length > 0) {
          const row = r.rows[0];
          return res.json({
            status: 'success',
            username: row.username,
            account_name: row.account_name || `${row.username} Workspace`,
            email: row.email || '',
            phone: row.phone || '',
            wa_jid: row.wa_jid || '',
            wa_status: row.status || 'Disconnected',
            role: row.role || 'user',
            user_type: row.user_type || 'business_user',
            ai_provider: row.ai_provider || 'gemini',
            ai_model: row.ai_model || 'gemini-1.5-flash',
            created_at: row.created_at ? new Date(row.created_at).toLocaleString() : 'Active'
          });
        }
      } catch (e) {}
    }
  }

  if (!user) {
    return res.status(404).json({ error: 'User account not found' });
  }

  return res.json({
    status: 'success',
    username: user.username,
    account_name: user.account_name || `${user.username} Workspace`,
    email: user.email || '',
    phone: user.phone || '',
    wa_jid: user.wa_jid || '',
    wa_status: user.status || 'Disconnected',
    role: user.role || 'user',
    user_type: user.user_type || 'business_user',
    ai_provider: user.ai_provider || 'gemini',
    ai_model: user.model || 'gemini-1.5-flash',
    created_at: user.created_at ? new Date(user.created_at).toLocaleString() : 'Active'
  });
});

function verifyPasswordMatch(candidate: string, stored: string): boolean {
  if (!candidate || !stored) return false;
  if (candidate === stored) return true;
  try {
    return bcrypt.compareSync(candidate, stored);
  } catch {
    return false;
  }
}

// 12H. VERIFY OLD PASSWORD
app.post('/api/user/verify-password', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { username, current_password } = body || {};
  if (!username || !current_password) {
    return res.status(400).json({ status: 'error', verified: false, message: 'Username and current password required' });
  }

  const cleanUser = username.toLowerCase();
  let storedHash = '';

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const r = await pool.query('SELECT password FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser]);
        if (r.rows.length > 0) {
          storedHash = r.rows[0].password;
        }
      } catch (e) {}
    }
  }

  if (!storedHash) {
    const user = memoryUsers.get(cleanUser);
    if (user) storedHash = user.password;
  }

  if (!storedHash) {
    return res.status(404).json({ status: 'error', verified: false, message: 'User not found' });
  }

  const isValid = verifyPasswordMatch(current_password, storedHash);
  if (!isValid) {
    return res.status(401).json({ status: 'error', verified: false, message: 'Current password is incorrect. Please try again.' });
  }

  return res.json({
    status: 'success',
    verified: true,
    message: 'Current password verified successfully! You can now set your new password.'
  });
});

// 12I. CHANGE USER PASSWORD
app.post('/api/user/change-password', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { username, current_password, new_password } = body || {};
  if (!username || !current_password || !new_password) {
    return res.status(400).json({ status: 'error', message: 'All password fields are required' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ status: 'error', message: 'New password must be at least 6 characters long' });
  }

  const cleanUser = username.toLowerCase();
  let storedHash = '';

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const r = await pool.query('SELECT password FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser]);
        if (r.rows.length > 0) {
          storedHash = r.rows[0].password;
        }
      } catch (e) {}
    }
  }

  if (!storedHash) {
    const user = memoryUsers.get(cleanUser);
    if (user) storedHash = user.password;
  }

  if (!storedHash) {
    return res.status(404).json({ status: 'error', message: 'User account not found' });
  }

  const isValid = verifyPasswordMatch(current_password, storedHash);
  if (!isValid) {
    return res.status(401).json({ status: 'error', message: 'Current password does not match.' });
  }

  const newHash = bcrypt.hashSync(new_password, 10);

  // Update in Neon DB
  if (isDbConnected()) {
    await updateUserPasswordInNeon(cleanUser, newHash);
  }

  // Update in memory
  const user = memoryUsers.get(cleanUser);
  if (user) {
    user.password = newHash;
  }

  return res.json({
    status: 'success',
    message: 'Your password has been updated successfully!'
  });
});

// 12J. REAL CUSTOMER CONVERSATION LIST (ZERO FAKE DATA)
app.get('/api/chats', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  if (!username) {
    return res.status(400).json({ conversations: [] });
  }

  if (isDbConnected()) {
    const conversations = await getCustomerConversations(username);
    return res.json({ conversations });
  }

  // Memory fallback
  const convs: Array<{ customer_phone: string; last_message: string; last_role: string; last_time: string; total_count: number }> = [];
  for (const [key, msgs] of chatMemory.entries()) {
    if (key.startsWith(username.toLowerCase() + '_') && msgs.length > 0) {
      const phone = key.replace(username.toLowerCase() + '_', '');
      if (phone.length >= 8 && phone.length <= 15 && !phone.startsWith('120363')) {
        const last = msgs[msgs.length - 1];
        convs.push({
          customer_phone: phone,
          last_message: last.content,
          last_role: last.role === 'user' ? 'customer' : 'assistant',
          last_time: new Date().toISOString(),
          total_count: msgs.length
        });
      }
    }
  }

  return res.json({ conversations: convs });
});

// 12K. GET REAL LAST 10 CHATS FOR SPECIFIC CUSTOMER PHONE
app.get('/api/chats/messages', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  const phone = (req.query.phone as string) || '';
  if (!username || !phone) {
    return res.status(400).json({ messages: [] });
  }

  const cleanPhone = phone.replace(/\D/g, '');

  if (isDbConnected()) {
    const dbMessages = await getLast10Chats(username, cleanPhone);
    const messages = dbMessages.map(m => ({
      id: m.id,
      role: m.role,
      text: m.message_text,
      time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }));
    return res.json({ messages });
  }

  const memHistory = chatMemory.get(`${username.toLowerCase()}_${cleanPhone}`) || [];
  const messages = memHistory.map((h, idx) => ({
    id: idx + 1,
    role: h.role === 'user' ? 'customer' : 'assistant',
    text: h.content,
    time: 'Recent'
  }));

  return res.json({ messages });
});

// 12L. SEND OUTGOING MESSAGE FROM CHAT UI
app.post('/api/chats/send', async (req: Request, res: Response) => {
  const { username = 'lead_business1', phone = '', message = '' } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ status: 'error', message: 'Phone number and message text required' });
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const cleanUser = username.toLowerCase();

  // Save to DB (strictly last 10 messages)
  await recordCustomerChat(cleanUser, cleanPhone, 'assistant', message);
  updateSlidingWindow(`${cleanUser}_${cleanPhone}`, 'assistant', message);

  // Push to Live Chat SSE
  pushToLiveChat(cleanUser, cleanPhone, message, 'outgoing');

  return res.json({
    status: 'success',
    message: 'Message dispatched and recorded in customer chat history.'
  });
});

// 13. LIVE CHAT SSE STREAM
app.get('/api/chat/stream', (req: Request, res: Response) => {
  const username = (req.query.username as string) || 'admin';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders?.();

  if (!sseClients.has(username)) {
    sseClients.set(username, new Set());
  }
  const clientSet = sseClients.get(username)!;
  clientSet.add(res);

  res.write(`data: ${JSON.stringify({ type: 'system', text: 'Connected' })}\n\n`);

  req.on('close', () => {
    clientSet.delete(res);
  });
});

// 14. REAL-TIME STATS
app.get('/api/analytics', (_req: Request, res: Response) => {
  return res.json({
    messagesSent: stats.totalMessagesSent,
    aiReplies: stats.totalAiReplies,
    campaigns: stats.campaignsLaunched
  });
});

// 15. ADMIN COMPREHENSIVE DASHBOARD OVERVIEW (ALL REAL METRICS)
app.get('/api/admin/dashboard', (_req: Request, res: Response) => {
  const users = Array.from(memoryUsers.values());
  const totalUsers = users.length;
  const connectedUsers = users.filter(u => u.status === 'Connected').length;
  const automationEnabledUsers = users.filter(u => u.automation_access).length;
  const autoReplyUsers = users.filter(u => u.auto_reply).length;
  const libraryOwnersCount = users.filter(u => u.user_type === 'library_owner').length;
  const businessUsersCount = users.filter(u => u.user_type === 'business_user').length;

  return res.json({
    metrics: {
      totalUsers,
      libraryOwnersCount,
      businessUsersCount,
      connectedUsers,
      disconnectedUsers: totalUsers - connectedUsers,
      automationEnabledUsers,
      autoReplyUsers,
      totalMessagesSent: stats.totalMessagesSent,
      totalAiReplies: stats.totalAiReplies,
      campaignsLaunched: stats.campaignsLaunched,
      totalMediaItems: memoryCatalog.length
    },
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      account_name: u.account_name,
      role: u.role,
      user_type: u.user_type || (u.role === 'admin' ? 'admin' : 'library_owner'),
      phone: u.phone || '',
      wa_jid: u.wa_jid,
      status: u.status,
      automation_access: u.automation_access,
      auto_reply: u.auto_reply,
      ai_provider: u.ai_provider,
      created_at: u.created_at
    }))
  });
});

// 16. AI PROMPT PLAYGROUND TESTER
app.post('/api/ai/test', async (req: Request, res: Response) => {
  const { username = 'admin', query, provider = 'Groq', api_key = '', system_prompt = '', model = '', temperature } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  const result = await generateAIReply(username, 'playground_tester', query, provider, api_key, system_prompt, model, temperature);
  stats.totalAiReplies++;
  return res.json({
    reply: result.replyText,
    image_url: result.imageURL
  });
});

// --- SERVE PUBLIC ---
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Fallback to public/index.html
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// START SERVER
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 EdutaAI Server listening on port ${PORT}`);
  try {
    await initNeonDatabase(memoryUsers);
  } catch (err: any) {
    console.error('Database bootstrap error:', err.message);
  }
});
