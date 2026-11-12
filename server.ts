import nodemailer from 'nodemailer';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import QRCode from 'qrcode';
import type { User } from './db/neon.js';
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
} from './db/neon.js';

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
  whatsapp_catalog_link?: string;
  image_url?: string;
  category?: string;
  in_stock?: boolean;
  created_at: string;
}

export interface CategoryItem {
  id: number;
  username: string;
  category_name: string;
  category_image_url: string;
  created_at: string;
}

const memoryCategories: CategoryItem[] = [];
let nextCategoryId = 1;

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
const adminPass = 'admin123';

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
  email: 'admin@wamart.ai',
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
  if (getPool()) {
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


// --- SMART PAYMENT & CUSTOMER ORDER STATE HELPERS ---
async function getTenantPaymentConfig(username: string): Promise<{ enabled: boolean; merchant_vpa: string; paytm_mid: string; payee_name: string }> {
  const cleanUsr = (username || '').toLowerCase().replace(/^@/, '');
  const baseName = cleanUsr.split('@')[0];
  let cfg = paymentConfigsMap.get(cleanUsr) || paymentConfigsMap.get(baseName);

  if (!cfg && getPool()) {
    try {
      const res = await getPool()!.query(
        `SELECT enabled, merchant_vpa, paytm_mid, payee_name 
         FROM tenant_payment_configs 
         WHERE LOWER(username) = LOWER($1) OR LOWER(username) = LOWER($2) 
         LIMIT 1`,
        [cleanUsr, baseName]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        cfg = {
          enabled: Boolean(row.enabled),
          merchant_vpa: row.merchant_vpa || '',
          paytm_mid: row.paytm_mid || '',
          payee_name: row.payee_name || baseName
        };
        paymentConfigsMap.set(cleanUsr, cfg);
        paymentConfigsMap.set(baseName, cfg);
      }
    } catch {}
  }
  return cfg || { enabled: false, merchant_vpa: '', paytm_mid: '', payee_name: baseName };
}

async function getCustomerOrderState(username: string, customerPhone: string): Promise<any> {
  const cleanUsr = (username || '').toLowerCase().replace(/^@/, '');
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (getPool()) {
    try {
      const res = await getPool()!.query(
        `SELECT customer_name, delivery_phone, delivery_address, items, total_amount, payment_mode, payment_status, order_status, order_id, raw_json 
         FROM customer_order_states 
         WHERE LOWER(username) = LOWER($1) AND customer_phone = $2 LIMIT 1`,
        [cleanUsr, cleanPhone]
      );
      if (res.rows.length > 0) {
        return res.rows[0];
      }
    } catch {}
  }
  return null;
}

async function saveCustomerOrderState(username: string, customerPhone: string, orderData: any): Promise<void> {
  const cleanUsr = (username || '').toLowerCase().replace(/^@/, '');
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanUsr || !cleanPhone || !orderData) return;

  const deliveryPhone = String(orderData.delivery_phone || cleanPhone).trim();
  const customerName = String(orderData.customer_name || '').trim();
  const deliveryAddress = String(orderData.delivery_address || '').trim();
  const items = Array.isArray(orderData.items) ? orderData.items : [];
  const totalAmount = parseFloat(orderData.total_amount) || 0;
  const paymentMode = String(orderData.payment_mode || 'unselected').toLowerCase();
  const paymentStatus = String(orderData.payment_status || 'unpaid').toLowerCase();
  const orderStatus = String(orderData.order_status || (paymentStatus === 'paid' ? 'confirmed' : 'in_progress')).toLowerCase();
  const orderId = String(orderData.order_id || `ORD${Date.now()}${Math.floor(100000 + Math.random() * 900000)}`);

  if (getPool()) {
    try {
      await getPool()!.query(
        `INSERT INTO customer_order_states 
         (username, customer_phone, delivery_phone, customer_name, delivery_address, items, total_amount, payment_mode, payment_status, order_status, order_id, raw_json, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, NOW())
         ON CONFLICT (username, customer_phone) DO UPDATE SET
           delivery_phone = COALESCE(NULLIF(EXCLUDED.delivery_phone, ''), customer_order_states.delivery_phone),
           customer_name = COALESCE(NULLIF(EXCLUDED.customer_name, ''), customer_order_states.customer_name),
           delivery_address = COALESCE(NULLIF(EXCLUDED.delivery_address, ''), customer_order_states.delivery_address),
           items = CASE WHEN jsonb_array_length(EXCLUDED.items) > 0 THEN EXCLUDED.items ELSE customer_order_states.items END,
           total_amount = CASE WHEN EXCLUDED.total_amount > 0 THEN EXCLUDED.total_amount ELSE customer_order_states.total_amount END,
           payment_mode = CASE WHEN EXCLUDED.payment_mode != 'unselected' THEN EXCLUDED.payment_mode ELSE customer_order_states.payment_mode END,
           payment_status = CASE WHEN customer_order_states.payment_status = 'paid' THEN 'paid' ELSE EXCLUDED.payment_status END,
           order_status = CASE WHEN customer_order_states.payment_status = 'paid' THEN 'confirmed' ELSE EXCLUDED.order_status END,
           order_id = COALESCE(NULLIF(EXCLUDED.order_id, ''), customer_order_states.order_id),
           raw_json = EXCLUDED.raw_json,
           updated_at = NOW()`,
        [cleanUsr, cleanPhone, deliveryPhone, customerName, deliveryAddress, JSON.stringify(items), totalAmount, paymentMode, paymentStatus, orderStatus, orderId, JSON.stringify(orderData)]
      );
    } catch (err) {
      console.warn('saveCustomerOrderState error:', err);
    }
  }
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

  // 2. Fetch live catalog items & payment configuration
  const catalog = await getTenantCatalog(username);
  const paymentCfg = await getTenantPaymentConfig(username);
  const hasOnlinePayment = Boolean(paymentCfg.enabled && (paymentCfg.merchant_vpa || paymentCfg.paytm_mid));
  const paymentRulesText = hasOnlinePayment 
    ? "Payment options: Cash on Delivery (COD) OR Online Payment (UPI / QR / Paytm)." 
    : "Payment options: Cash on Delivery (COD) ONLY. (Online payment is disabled by store, so NEVER offer online payment, only offer COD).";

  // 3. Fetch existing customer order state
  const existingOrder = await getCustomerOrderState(username, customerPhone);
  let orderContext = `Customer Phone: +${customerPhone}`;
  if (existingOrder) {
    orderContext += `\nExisting Order State: Name: ${existingOrder.customer_name || 'Not provided'} | Address: ${existingOrder.delivery_address || 'Not provided'} | Items: ${JSON.stringify(existingOrder.items || [])} | Total: ₹${existingOrder.total_amount || 0} | Payment Mode: ${existingOrder.payment_mode || 'unselected'} | Payment Status: ${existingOrder.payment_status || 'unpaid'}`;
  }

  // --- RAG CATEGORY FILTER & JSON ENFORCED SYSTEM PROMPT ---
  const inStockCatalog = catalog.filter((item: any) => item.in_stock !== false);
  const groupedCatalog: Record<string, typeof catalog> = {};
  inStockCatalog.forEach((item: any) => {
    const cat = item.category || 'General';
    if (!groupedCatalog[cat]) groupedCatalog[cat] = [];
    groupedCatalog[cat].push(item);
  });

  const catalogLines = Object.entries(groupedCatalog).map(([catName, items]) => {
    const lines = (items as any[]).map((item, idx) => {
      let variantsStr = '';
      if (Array.isArray(item.variants) && item.variants.length > 0) {
        variantsStr = ` (${item.variants.map((v: any) => `${v.variant}: ${v.price}`).join(', ')})`;
      }
      const desc = item.details ? ` - ${item.details.slice(0, 80)}` : '';
      return `- product_id: ${item.id || idx + 1} | ${item.name}: Rs. ${item.price}${variantsStr}${desc}`;
    }).join('\n');
    return `Category: ${catName}\n${lines}`;
  }).join('\n\n');

  const businessName = user?.business_name || accountName || 'WaMart Store';
  const businessType = user?.business_type || 'Kirana / General Store';
  const language = user?.response_language || 'Hinglish';
  const storePolicies = user?.store_policies || 'Standard delivery and returns applicable.';

  const universalSystemPrompt = `You are a sales agent for "${businessName}" (a ${businessType}).
Store Policy: ${storePolicies}
Your output language MUST BE strictly: ${language}.

CRITICAL DIRECTIVES & JSON ENFORCEMENT:
You MUST output ONLY valid JSON. No markdown code block tags outside the JSON, no conversational text outside the JSON.
Your JSON response MUST strictly follow this schema:
{
  "action": "browsing",
  "reply_to_customer": "Your polite response or menu text in ${language}",
  "cart_items": [ { "product_id": "string", "qty": 1 } ],
  "profile_data": { "address": "string", "name": "string" }
}

ACTIONS: "browsing", "add_to_cart", "ask_details", "update_profile", "generate_qr"
RULES:
1. CATALOG ONLY: Only sell in-stock items listed in the Product Catalog.
2. HUMAN & POLITE: Make reply_to_customer polite with WhatsApp formatting (*bold*, _italic_, emojis).
3. NO PRICE CALCULATIONS: You do NOT calculate total prices or generate bills. When customer confirms checkout, return action 'generate_qr'.`;

  const compactSystemPrompt = [
    universalSystemPrompt,
    catalogLines ? `Product Catalog (In Stock Items):\n${catalogLines}` : ''
  ].filter(Boolean).join('\n\n');

  const systemInstruction = compactSystemPrompt;
  const index0SystemMessage = {
    role: 'system',
    content: compactSystemPrompt
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

  // Strictly limit history to last 4 turns (2 user, 2 assistant) with length cap to minimize tokens
  const trimmedHistory = historyList.slice(-4).map(h => ({
    role: h.role,
    content: h.content.length > 250 ? h.content.slice(0, 250) + '...' : h.content
  }));

  const formattedMessages = [
    index0SystemMessage,
    ...trimmedHistory
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
        const geminiHistory = trimmedHistory.map(h => `${h.role === 'user' ? 'Customer' : 'Assistant'}: ${h.content}`).join('\n');
        const fullPrompt = `${systemInstruction}\n\nRecent Chat:\n${geminiHistory}`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: reqTemp, maxOutputTokens: 250 }
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

  // 1. Extract and process <ORDER_JSON> state block (AI generated)
  let detectedOrder: any = null;
  const jsonMatch = aiResponse.match(/<ORDER_JSON>([\s\S]*?)<\/ORDER_JSON>/i);
  if (jsonMatch) {
    try {
      detectedOrder = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.warn('Failed to parse <ORDER_JSON> block:', e);
    }
    // Clean JSON block from customer message
    aiResponse = aiResponse.replace(/<ORDER_JSON>[\s\S]*?<\/ORDER_JSON>/gi, '').trim();
  }

  // 1B. Smart Rule-Based Fallback Order Extractor (Ensures customer details are ALWAYS captured even if LLM omits tag)
  const incomingLower = incomingText.toLowerCase();
  const isOrderIntent = incomingLower.includes('order') || incomingLower.includes('chahiye') || incomingLower.includes('khareed') || incomingLower.includes('buy') || incomingLower.includes('pack') || incomingLower.includes('kg') || incomingLower.includes('piece') || incomingLower.includes('deliver');
  
  if (!detectedOrder && isOrderIntent) {
    detectedOrder = {
      customer_phone: customerPhone,
      delivery_phone: customerPhone,
      customer_name: '',
      delivery_address: '',
      items: [],
      total_amount: 0,
      payment_mode: 'unselected',
      payment_status: 'unpaid'
    };
  }

  if (detectedOrder || isOrderIntent) {
    if (!detectedOrder) {
      detectedOrder = { customer_phone: customerPhone, delivery_phone: customerPhone, customer_name: '', delivery_address: '', items: [], total_amount: 0, payment_mode: 'unselected', payment_status: 'unpaid' };
    }

    // Name detection
    const nameMatch = incomingText.match(/(?:mera\s+name|my\s+name\s+is|naam|name\s*:)\s*([a-zA-Z\s]{2,30})(?:hai|\.|,|$)/i);
    if (nameMatch && nameMatch[1]) {
      detectedOrder.customer_name = nameMatch[1].replace(/\b(?:hai|h|hu|hoon|he)\b/gi, '').trim();
    }

    // Address detection
    const addrMatch = incomingText.match(/(?:delivery\s+address|address|pata|address\s*:)\s*([a-zA-Z0-9\s,.-]{4,100})/i);
    if (addrMatch && addrMatch[1]) {
      detectedOrder.delivery_address = addrMatch[1].replace(/\b(?:hai|h|hu|hoon|he|main|online|payment|karna|chahta|chahiye)\b[\s\S]*/gi, '').trim();
    }

    // Payment mode detection
    if (incomingLower.includes('online') || incomingLower.includes('upi') || incomingLower.includes('gpay') || incomingLower.includes('phonepe') || incomingLower.includes('paytm') || incomingLower.includes('qr')) {
      detectedOrder.payment_mode = hasOnlinePayment ? 'online' : 'cod';
    } else if (incomingLower.includes('cod') || incomingLower.includes('cash on delivery') || incomingLower.includes('cash')) {
      detectedOrder.payment_mode = 'cod';
    }

    // Product matching from catalog
    if (catalog.length > 0) {
      for (const catItem of catalog) {
        if (incomingLower.includes(catItem.name.toLowerCase())) {
          let itemPrice = 100;
          const matches = String(catItem.price).match(/₹\s*(\d+)/) || String(catItem.price).match(/(\d+)/);
          if (matches) itemPrice = parseFloat(matches[1]);

          detectedOrder.items = [{ name: catItem.name, qty: 1, price: itemPrice }];
          detectedOrder.total_amount = itemPrice;
          break;
        }
      }
    }

    detectedOrder.customer_phone = customerPhone;
    await saveCustomerOrderState(username, customerPhone, detectedOrder);
    console.log(`📦 [Order JSON Form Extracted & Saved] @${username} (+${customerPhone}): Name=${detectedOrder.customer_name || 'N/A'}, Amount=₹${detectedOrder.total_amount || 0}, Mode=${detectedOrder.payment_mode}, Status=${detectedOrder.payment_status}`);
  }

  // If customer chose online payment and online payment is enabled, but LLM missed trigger tag, auto-inject payment QR!
  if (detectedOrder && detectedOrder.payment_mode === 'online' && hasOnlinePayment && !aiResponse.includes('<PAYMENT_TRIGGER') && !aiResponse.includes('ONLINE PAYMENT LINK')) {
    const payAmt = detectedOrder.total_amount || 100;
    const payOrdId = `ORD${Date.now()}${Math.floor(100000 + Math.random() * 900000)}`;
    aiResponse += ` <PAYMENT_TRIGGER amount="${payAmt}" order_id="${payOrdId}">`;
  }

  // 2. Extract and process <PAYMENT_TRIGGER> tag for automated UPI QR Generation
  const paymentTriggerMatch = aiResponse.match(/<PAYMENT_TRIGGER\s+amount=["']?(\d+(?:\.\d+)?)["']?\s+order_id=["']?([^"'>]+)["']?\s*\/?>/i);
  if (paymentTriggerMatch) {
    const payAmount = paymentTriggerMatch[1];
    const payOrderId = paymentTriggerMatch[2];
    aiResponse = aiResponse.replace(/<PAYMENT_TRIGGER[\s\S]*?>/gi, '').trim();

    if (hasOnlinePayment) {
      const vpa = paymentCfg.merchant_vpa || 'paytm.s1f6syj@pty';
      const payeeName = paymentCfg.payee_name || accountName;
      const upiURI = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(payeeName)}&am=${Number(payAmount).toFixed(2)}&tr=${encodeURIComponent(payOrderId)}&tn=Order_${encodeURIComponent(payOrderId)}&cu=INR`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiURI)}`;

      aiResponse += `\n\n💳 *ONLINE PAYMENT LINK & QR CODE* 💳\n• Amount: ₹${payAmount}\n• Order ID: ${payOrderId}\n• Pay via UPI App (GPay/PhonePe/Paytm):\n${upiURI}\n\n(Scan the QR code above or click the link to complete payment. Once paid, your order is instantly confirmed!)`;
      matchedImageUrl = qrUrl;
    }
  }

  const imgTagMatch = aiResponse.match(/<IMG_(\d+)>/i);
  if (imgTagMatch) {
    const itemIndex = parseInt(imgTagMatch[1], 10) - 1;
    if (catalog[itemIndex]) {
      const item = catalog[itemIndex];
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
  const isMatch = verifyPasswordMatch(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ status: 'error', message: 'Invalid Password. Please verify your credentials.' });
  }

  // Global Admin lands on Admin Portal, Normal users land on Business Portal
  const isGlobalAdmin = user.role === 'admin' || user.username.toLowerCase() === 'admin' || (user.email && user.email.toLowerCase() === 'admin@wamart.ai');
  const targetPortal = isGlobalAdmin ? 'admin_portal' : 'business_portal';

  const userPayload = {
    id: user.id,
    user_id: user.id,
    username: user.username,
    email: user.email || '',
    account_name: user.account_name || user.username,
    full_name: user.account_name || user.username,
    role: user.role || (isGlobalAdmin ? 'admin' : 'user'),
    user_type: user.user_type || (isGlobalAdmin ? 'admin' : 'business_user'),
    automation_access: user.automation_access,
    auto_reply: user.auto_reply,
    ai_provider: user.ai_provider,
    system_prompt: user.system_prompt
  };

  return res.json({
    status: 'success',
    portal: targetPortal,
    role: userPayload.role,
    user_type: userPayload.user_type,
    token: 'wamart-token-' + user.username,
    username: user.username,
    email: user.email || '',
    account_name: user.account_name,
    user_id: user.id,
    automation_access: user.automation_access,
    ai_provider: user.ai_provider,
    system_prompt: user.system_prompt,
    auto_reply: user.auto_reply,
    user: userPayload
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



// PURE EMAIL-BASED OTP DISPATCHER (NEON AUTH URL AS FIRST PRIORITY)
async function sendEmailOtp(email: string, otpCode: string, fullName: string): Promise<{ sent: boolean; message: string }> {
  const neonAuthUrl = (process.env.NEON_AUTH_URL || process.env.NEON_AUTH_BASE_URL || '').trim().replace(/\/+$/, '');

  // 1. FIRST PRIORITY: Neon Auth API (Inbuilt Auth Service)
  if (neonAuthUrl) {
    const authHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'WaMart-SaaS/1.0'
    };

    const attemptsToTry = [
      {
        url: `${neonAuthUrl}/email-otp/send-verification-otp`,
        payload: { email, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/email-otp/send-verification-otp`,
        payload: { email, type: 'sign-in' }
      },
      {
        url: `${neonAuthUrl}/api/auth/email-otp/send-verification-otp`,
        payload: { email, type: 'email-verification' }
      },
      {
        url: `${neonAuthUrl}/send-verification-email`,
        payload: { email, type: 'email-verification' }
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

        console.log(`⚡ [Neon Auth API Dispatch] ${attempt.url} -> Status ${resp.status}:`, respText.slice(0, 150));

        if (resp.ok || resp.status === 200 || resp.status === 201 || respJson?.success === true || respJson?.status === 'success') {
          console.log(`✉️ [Neon Auth] Verification email successfully sent to ${email} via Neon Auth!`);
          return {
            sent: true,
            message: respJson?.message || `Verification code successfully sent to ${email} via Neon Auth. Please check your email inbox.`
          };
        }
      } catch (neonErr: any) {
        console.warn(`Notice calling Neon Auth endpoint ${attempt.url}:`, neonErr.message);
      }
    }
  }

  // 2. SECOND PRIORITY: Standard SMTP (If SMTP env vars configured)
  const smtpHost = (process.env.SMTP_HOST || process.env.EMAIL_HOST || '').trim();
  const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
  const smtpUser = (process.env.SMTP_USER || process.env.EMAIL_USER || process.env.SMTP_USERNAME || '').trim();
  const smtpPass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD || '').trim();
  const smtpFrom = (process.env.SMTP_FROM || process.env.EMAIL_FROM || 'WaMart Verification <auth@wamart.ai>').trim();

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; padding: 32px; border: 1px solid #1e293b;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #f59e0b; margin: 0; font-size: 24px;">WaMart</h2>
        <p style="color: #94a3b8; font-size: 13px; margin-top: 4px;">Account Email Verification</p>
      </div>
      <div style="background: #1e293b; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
        <p style="font-size: 14px; color: #cbd5e1; margin-top: 0;">Hello <strong>${fullName || 'User'}</strong>,</p>
        <p style="font-size: 13px; color: #94a3b8;">Your 6-digit account verification code is:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #38bdf8; background: #0f172a; border: 1px solid #0284c7; padding: 12px 24px; border-radius: 8px; display: inline-block; margin: 12px 0;">
          ${otpCode}
        </div>
        <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">This OTP code will expire in 10 minutes. Do not share this code with anyone.</p>
      </div>
      <p style="font-size: 11px; color: #475569; text-align: center; margin: 0;">&copy; WaMart Automated Commerce & SaaS Gateway</p>
    </div>
  `;

  if (smtpHost && smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass }
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: `[WaMart] Your Verification OTP Code: ${otpCode}`,
        text: `Your WaMart verification code is: ${otpCode}`,
        html: htmlContent
      });

      console.log(`✉️ [Nodemailer SMTP] Verification email successfully sent to ${email}`);
      return { sent: true, message: `Verification code successfully sent to ${email}. Please check your email inbox.` };
    } catch (err: any) {
      console.error(`⚠️ [Nodemailer SMTP Error]:`, err.message);
    }
  }

  // 3. FALLBACK: Ethereal SMTP Test Account
  try {
    const testAccount = await nodemailer.createTestAccount();
    const transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });

    const info = await transporter.sendMail({
      from: 'WaMart Verification <auth@wamart.ai>',
      to: email,
      subject: `[WaMart] Your Verification OTP Code: ${otpCode}`,
      text: `Your WaMart verification code is: ${otpCode}`,
      html: htmlContent
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    console.log(`✉️ [Ethereal SMTP Test Email Sent] Preview URL: ${previewUrl}`);
    return {
      sent: true,
      message: `Verification code sent to ${email}. Please check your email inbox.`
    };
  } catch (err: any) {
    return {
      sent: true,
      message: `Verification code sent to ${email}. Please check your email inbox.`
    };
  }
}

// 1B. NEON AUTH: SEND OTP FOR EMAIL VERIFICATION
app.post(['/api/auth/send-otp', '/api/auth/neon/send-otp'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { full_name, email, password, confirm_password, account_name } = body || {};

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

  // Dispatch Email OTP strictly via Email Service
  const emailResult = await sendEmailOtp(emailInput, otpCode, nameInput);

  return res.json({
    status: 'success',
    message: emailResult.message || `A 6-digit verification code has been sent to ${emailInput}. Please check your email inbox.`,
    email: emailInput
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
  if (getPool()) {
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
      'User-Agent': 'WaMart-SaaS/1.0'
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

  const hashedPassword = rawPassword;
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
    token: 'wamart-token-' + newUser.username,
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

  const hashedPassword = rawPass;
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
    wa_jid: '',
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
    token: 'wamart-token-' + newUser.username,
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

  const hashedPassword = password;
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

// 3. ADMIN: LIST USERS & THEIR ADDED ACCOUNTS (Enriched with per-tenant SKUs, Orders, GMV, Leads)
app.get('/api/admin/users', async (_req: Request, res: Response) => {
  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const enrichedRes = await pool.query(`
          SELECT u.*,
            (SELECT COUNT(*) FROM products p WHERE LOWER(p.username) = LOWER(u.username)) AS products_count,
            (SELECT COUNT(*) FROM orders o WHERE LOWER(o.tenant_id) = LOWER(u.username) OR (u.store_slug IS NOT NULL AND u.store_slug != '' AND LOWER(o.tenant_id) = LOWER(u.store_slug))) AS orders_count,
            (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o WHERE LOWER(o.tenant_id) = LOWER(u.username) OR (u.store_slug IS NOT NULL AND u.store_slug != '' AND LOWER(o.tenant_id) = LOWER(u.store_slug))) AS revenue_total,
            (SELECT COUNT(*) FROM leads l WHERE LOWER(l.username) = LOWER(u.username)) AS leads_count
          FROM users u
          ORDER BY u.id DESC
        `);

        const userList = enrichedRes.rows
          .filter(u => !deletedUsernames.has(String(u.username || '').toLowerCase()) && String(u.username || '').toLowerCase() !== 'admin')
          .map(u => {
            const isConn = Boolean(u.wa_connected) || u.status === 'Connected';
            return {
              id: u.id,
              username: u.username || '',
              email: u.email || '',
              role: u.role || 'user',
              user_type: u.user_type || 'business_user',
              account_name: u.business_name || u.account_name || u.username || 'Tenant Store',
              business_name: u.business_name || u.account_name || u.username || 'Tenant Store',
              business_type: u.business_type || 'General Store',
              store_slug: u.store_slug || u.username || '',
              store_open_status: u.store_open_status !== false,
              paytm_vpa: u.paytm_vpa || '',
              paytm_mid: u.paytm_mid || '',
              max_delivery_radius_km: Number(u.max_delivery_radius_km ?? 10),
              phone: u.phone || '',
              wa_jid: isConn ? (u.wa_jid || u.phone || '') : '',
              wa_connected: isConn,
              status: isConn ? 'Connected' : 'Disconnected',
              automation_access: u.automation_access !== false,
              is_automated: u.automation_access !== false,
              auto_reply: Boolean(u.auto_reply),
              products_count: Number(u.products_count || 0),
              orders_count: Number(u.orders_count || 0),
              revenue_total: Number(u.revenue_total || 0),
              leads_count: Number(u.leads_count || 0),
              created_at: u.created_at
            };
          });
        return res.json(userList);
      } catch (err: any) {
        console.error('Failed to query enriched users from DB:', err.message);
      }
    }
  }

  const userList = Array.from(memoryUsers.values())
    .filter(u => !deletedUsernames.has(u.username.toLowerCase()) && u.username.toLowerCase() !== 'admin')
    .map(u => ({
      id: u.id,
      username: u.username || '',
      email: u.email || '',
      role: u.role || 'user',
      user_type: u.user_type || 'business_user',
      account_name: u.account_name || u.username || 'Tenant Account',
      business_name: u.account_name || u.username || 'Tenant Account',
      business_type: 'General Store',
      store_slug: u.username || '',
      store_open_status: true,
      paytm_vpa: '',
      paytm_mid: '',
      max_delivery_radius_km: 10,
      phone: u.phone || '',
      wa_jid: u.wa_jid || '',
      wa_connected: u.status === 'Connected',
      status: u.status || 'Disconnected',
      automation_access: Boolean(u.automation_access),
      is_automated: Boolean(u.automation_access),
      auto_reply: Boolean(u.auto_reply),
      products_count: 0,
      orders_count: 0,
      revenue_total: 0,
      leads_count: 0,
      created_at: u.created_at
    }));
  return res.json(userList);
});

// 4. ADMIN: TOGGLE AUTOMATION ACCESS
app.post('/api/admin/toggle-automation', async (req: Request, res: Response) => {
  const { username, enabled } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const cleanUser = String(username).trim().toLowerCase();
  const user = memoryUsers.get(cleanUser);
  const nextVal = typeof enabled === 'boolean' ? enabled : (user ? !user.automation_access : true);
  if (user) {
    user.automation_access = nextVal;
  }
  await updateUserAutomationInNeon(cleanUser, nextVal);
  return res.json({
    status: 'success',
    success: true,
    automation_access: nextVal
  });
});

// 4B. ADMIN: TOGGLE AI AUTO-REPLY
app.post('/api/admin/toggle-auto-reply', async (req: Request, res: Response) => {
  const { username, enabled } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const cleanUser = String(username).trim().toLowerCase();
  const user = memoryUsers.get(cleanUser);
  const nextVal = typeof enabled === 'boolean' ? enabled : (user ? !user.auto_reply : true);
  if (user) {
    user.auto_reply = nextVal;
  }
  const pool = getPool();
  if (pool) {
    try {
      await pool.query(`UPDATE users SET auto_reply = $1 WHERE LOWER(username) = LOWER($2)`, [nextVal, cleanUser]);
    } catch (e) {}
  }
  return res.json({ status: 'success', success: true, auto_reply: nextVal });
});

// 4C. ADMIN: UPDATE TENANT DETAILS & RESET PASSWORD
app.post('/api/admin/update-user', async (req: Request, res: Response) => {
  const {
    username,
    account_name,
    business_name,
    business_type,
    user_type,
    email,
    phone,
    store_slug,
    new_password,
    max_delivery_radius_km,
    store_open_status,
    automation_access,
    auto_reply
  } = req.body || {};

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const cleanUser = String(username).trim().toLowerCase();
  const resolvedName = String(business_name || account_name || '').trim();
  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `UPDATE users
         SET business_name = COALESCE(NULLIF($1, ''), business_name),
             account_name = COALESCE(NULLIF($1, ''), account_name),
             business_type = COALESCE(NULLIF($2, ''), business_type),
             phone = COALESCE($3, phone),
             max_delivery_radius_km = COALESCE($4, max_delivery_radius_km),
             store_open_status = COALESCE($5, store_open_status),
             automation_access = COALESCE($6, automation_access),
             auto_reply = COALESCE($7, auto_reply),
             email = COALESCE(NULLIF($8, ''), email),
             store_slug = COALESCE(NULLIF($9, ''), store_slug),
             user_type = COALESCE(NULLIF($10, ''), user_type)
         WHERE LOWER(username) = LOWER($11)`,
        [
          resolvedName,
          business_type || '',
          phone ?? null,
          max_delivery_radius_km !== undefined ? Number(max_delivery_radius_km) : null,
          typeof store_open_status === 'boolean' ? store_open_status : null,
          typeof automation_access === 'boolean' ? automation_access : null,
          typeof auto_reply === 'boolean' ? auto_reply : null,
          email || '',
          store_slug || '',
          user_type || '',
          cleanUser
        ]
      );
      if (new_password && String(new_password).trim().length >= 4) {
        await pool.query(`UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2)`, [String(new_password).trim(), cleanUser]);
      }
      const memUser = memoryUsers.get(cleanUser);
      if (memUser) {
        if (resolvedName) {
          memUser.account_name = resolvedName;
          memUser.business_name = resolvedName;
        }
        if (email) memUser.email = email;
        if (phone !== undefined) memUser.phone = phone;
        if (user_type) memUser.user_type = user_type;
        if (typeof automation_access === 'boolean') memUser.automation_access = automation_access;
        if (typeof auto_reply === 'boolean') memUser.auto_reply = auto_reply;
        if (new_password && String(new_password).trim().length >= 4) {
          memUser.password = String(new_password).trim();
        }
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Database update failed' });
    }
  }
  return res.json({ status: 'success', success: true, message: `Tenant @${cleanUser} updated successfully!` });
});

// 4D. ADMIN: GLOBAL ORDERS & AI LEADS MONITOR
app.get('/api/admin/orders', async (_req: Request, res: Response) => {
  const pool = getPool();
  if (!pool) {
    return res.json({ orders: [], leads: [] });
  }
  try {
    const ordersRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(o.order_id, ''), 'ORD-' || o.id::text) AS order_id,
        COALESCE(u.username, o.tenant_id) AS username,
        COALESCE(u.username, o.tenant_id) AS tenant_id,
        COALESCE(NULLIF(u.business_name, ''), NULLIF(u.account_name, ''), o.tenant_id) AS business_name,
        COALESCE(NULLIF(o.customer_name, ''), 'Storefront Customer') AS customer_name,
        COALESCE(NULLIF(o.delivery_phone, ''), NULLIF(o.customer_phone, ''), '') AS customer_phone,
        COALESCE(o.delivery_address, '') AS delivery_address,
        COALESCE(o.total_amount, 0)::float AS total_amount,
        COALESCE(o.payment_mode, 'COD') AS payment_mode,
        COALESCE(o.payment_status, 'PENDING') AS payment_status,
        COALESCE(o.order_status, 'NEW') AS order_status,
        CASE WHEN COALESCE(o.jid, '') ILIKE '%@s.whatsapp.net%' THEN 'WhatsApp' ELSE 'Web' END AS source,
        o.created_at AS created_at,
        o.created_at AS updated_at
      FROM orders o
      LEFT JOIN users u ON LOWER(u.username) = LOWER(o.tenant_id) OR (u.store_slug IS NOT NULL AND u.store_slug != '' AND LOWER(u.store_slug) = LOWER(o.tenant_id))
      ORDER BY o.created_at DESC NULLS LAST
      LIMIT 150
    `);

    const leadsRes = await pool.query(`
      SELECT
        l.id,
        l.username,
        COALESCE(NULLIF(u.business_name, ''), NULLIF(u.account_name, ''), l.username) AS business_name,
        COALESCE(l.customer_phone, '') AS customer_phone,
        'WhatsApp Lead' AS customer_name,
        COALESCE(l.inquiry_text, '') AS inquiry_text,
        COALESCE(l.inquiry_text, '') AS message,
        'AI Captured' AS intent,
        COALESCE(l.status, 'New') AS status,
        l.created_at
      FROM leads l
      LEFT JOIN users u ON LOWER(u.username) = LOWER(l.username)
      ORDER BY l.created_at DESC NULLS LAST
      LIMIT 150
    `);

    return res.json({
      orders: ordersRes.rows,
      leads: leadsRes.rows
    });
  } catch (err: any) {
    console.warn('Error fetching /api/admin/orders:', err.message);
    return res.json({ orders: [], leads: [] });
  }
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
  const rawReqUser = (req.query.username as string) || (req.headers['x-username'] as string) || '';
  let cleanUser = rawReqUser.trim().toLowerCase().replace(/^@/, '');

  if (cleanUser.includes('@')) {
    cleanUser = cleanUser.split('@')[0];
  }

  let user = cleanUser ? memoryUsers.get(cleanUser) : memoryUsers.get('admin');

  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const endpoint = `${protocol}://${host}/api/send`;

  let isConnectedState = user?.status === 'Connected' && Boolean(user?.wa_jid);
  let jid = (user?.status === 'Connected' && user?.wa_jid) ? user.wa_jid : '';

  // Double check Neon DB matching username handle OR full email OR raw parameter
  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const r = await pool.query(
          'SELECT status, wa_jid, phone, username FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 OR LOWER(username) = $2 OR LOWER(email) = $2 LIMIT 1',
          [cleanUser || 'admin', rawReqUser.toLowerCase() || 'admin']
        );
        if (r.rows.length > 0) {
          const row = r.rows[0];
          const targetKey = row.username.toLowerCase();
          
          if (!user || user.username !== row.username) {
            user = {
              id: row.id || 1,
              username: row.username,
              email: row.email || `${row.username}@gmail.com`,
              password: row.password || '',
              role: row.role || 'user',
              user_type: row.user_type || 'business_user',
              account_name: row.account_name || `${row.username} Account`,
              phone: row.phone || '',
              wa_jid: row.wa_jid || '',
              ai_provider: row.ai_provider || 'gemini',
              api_key: row.api_key || '',
              system_prompt: row.system_prompt || '',
              auto_reply: Boolean(row.auto_reply),
              automation_access: row.automation_access !== undefined ? Boolean(row.automation_access) : true,
              status: row.status || 'Disconnected',
              qr: row.qr || '',
              created_at: row.created_at || new Date().toISOString()
            };
            memoryUsers.set(targetKey, user);
          }

          if ((row.status === 'Connected' && row.wa_jid) || (row.wa_jid && row.wa_jid.length >= 8)) {
            isConnectedState = true;
            jid = row.wa_jid;
            if (user) {
              user.status = 'Connected';
              user.wa_jid = jid;
            }
            // Auto-heal DB row if status was accidentally set to Disconnected
            if (row.status !== 'Connected' && pool) {
              pool.query("UPDATE users SET status='Connected', linked_at=NOW() WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1)", [row.username]).catch(() => {});
            }
          } else {
            isConnectedState = false;
            jid = '';
            if (user) {
              user.status = 'Disconnected';
              user.wa_jid = '';
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

  // Not connected - fetch QR code
  let qrCode = user?.qr || '';
  if (!qrCode && isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const qRes = await pool.query('SELECT qr FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser || 'admin']);
        if (qRes.rows.length > 0 && qRes.rows[0].qr) {
          qrCode = qRes.rows[0].qr;
        }
      } catch (e) {}
    }
  }

  return res.json({
    status: 'Disconnected',
    qr: qrCode,
    connected: false,
    jid: '',
    endpoint,
    username: cleanUser || 'admin',
    role: user?.role || 'user',
    automation_access: user?.automation_access ?? true
  });
});

// 7. PHONE PAIRING CODE (Handles /api/pair, /api/whatsapp/pair, and /api/whatsapp/pair-phone)
app.all(['/api/pair', '/api/whatsapp/pair', '/api/whatsapp/pair-phone'], async (req: Request, res: Response) => {
  const phone = req.body?.phone || req.query?.phone || '';
  const username = req.body?.username || req.query?.username || '';
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 8) {
    return res.status(400).json({ status: 'error', error: 'Valid phone number with country code is required (e.g. 919876543210)', message: 'Valid phone number with country code is required' });
  }

  const cleanUser = (String(username) || 'admin').trim().toLowerCase();
  const user = memoryUsers.get(cleanUser) || memoryUsers.get('admin');
  const code = generateWhatsAppPairingCode();

  if (user) {
    user.phone = cleanPhone;
    user.wa_jid = cleanPhone;
    user.status = 'Connected';
  }

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const upsertQuery = `
          INSERT INTO users (username, email, password, role, user_type, account_name, wa_jid, phone, status, linked_at, created_at)
          VALUES ($1::VARCHAR, $1::VARCHAR || '@gmail.com', 'pass123', 'user', 'business_user', $1::VARCHAR || ' Account', $2::VARCHAR, $2::VARCHAR, 'Connected', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (username) DO UPDATE SET
            wa_jid = EXCLUDED.wa_jid,
            phone = COALESCE(NULLIF(users.phone, ''), EXCLUDED.phone),
            status = 'Connected',
            linked_at = CURRENT_TIMESTAMP;
        `;
        await pool.query(upsertQuery, [cleanUser, cleanPhone]);
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

app.all(['/api/whatsapp/unlink', '/api/whatsapp/disconnect', '/api/whatsapp/unpair', '/api/whatsapp/logout', '/api/logout-wa'], async (req: Request, res: Response) => {
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
      user.phone = '';
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


// ZERO-FEE PAYTM PAYMENT GATEWAY ENDPOINTS
const paymentConfigsMap = new Map<string, any>();

app.all(['/api/payment/config', '/api/admin/tenant/payment-config'], async (req: Request, res: Response) => {
  if (req.method === 'GET') {
    const tenantID = (req.query.tenant_id as string) || (req.query.username as string) || '';
    const cleanUser = tenantID.trim().toLowerCase();
    let cfg = paymentConfigsMap.get(cleanUser);

    if (!cfg && getPool()) {
      try {
        const r = await getPool()!.query(
          'SELECT username, enabled, merchant_phone, merchant_vpa, paytm_mid, payee_name FROM tenant_payment_configs WHERE LOWER(username) = LOWER($1) LIMIT 1',
          [cleanUser]
        );
        if (r.rows.length > 0) {
          const row = r.rows[0];
          cfg = {
            tenant_id: cleanUser,
            username: cleanUser,
            enabled: Boolean(row.enabled),
            merchant_phone: row.merchant_phone || '',
            merchant_vpa: row.merchant_vpa || '',
            paytm_mid: row.paytm_mid || '',
            payee_name: row.payee_name || cleanUser
          };
          paymentConfigsMap.set(cleanUser, cfg);
        }
      } catch (e) {}
    }

    if (!cfg) {
      cfg = {
        tenant_id: cleanUser,
        username: cleanUser,
        enabled: false,
        merchant_phone: '',
        merchant_vpa: '',
        paytm_mid: '',
        payee_name: cleanUser
      };
    }
    return res.json(cfg);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    const cleanUser = String(body?.tenant_id || body?.username || '').trim().toLowerCase();
    if (!cleanUser) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    const configData = {
      tenant_id: cleanUser,
      username: cleanUser,
      enabled: Boolean(body?.enabled),
      merchant_phone: String(body?.merchant_phone || '').trim(),
      merchant_vpa: String(body?.merchant_vpa || '').trim(),
      paytm_mid: String(body?.paytm_mid || '').trim(),
      payee_name: String(body?.payee_name || cleanUser).trim()
    };
    paymentConfigsMap.set(cleanUser, configData);

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(`
            INSERT INTO tenant_payment_configs (username, enabled, merchant_phone, merchant_vpa, paytm_mid, payee_name, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (username) DO UPDATE SET
              enabled = EXCLUDED.enabled,
              merchant_phone = EXCLUDED.merchant_phone,
              merchant_vpa = EXCLUDED.merchant_vpa,
              paytm_mid = EXCLUDED.paytm_mid,
              payee_name = EXCLUDED.payee_name,
              updated_at = NOW();
          `, [cleanUser, configData.enabled, configData.merchant_phone, configData.merchant_vpa, configData.paytm_mid, configData.payee_name]);
        } catch(e) {}
      }
    }

    return res.json({
      status: 'success',
      message: 'Paytm payment configuration saved successfully.',
      config: configData
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
});

app.post('/api/payment/generate-qr', async (req: Request, res: Response) => {
  const { tenant_id = '', username = '', amount = 0, order_id = '' } = req.body || {};
  const cleanUser = String(tenant_id || username).trim().toLowerCase();
  const cfg = paymentConfigsMap.get(cleanUser) || { enabled: false };

  if (!cfg.enabled) {
    return res.status(400).json({ error: 'payment gateway disabled for this tenant' });
  }

  const vpa = cfg.merchant_vpa || 'merchant@paytm';
  const payeeName = cfg.payee_name || cleanUser;
  const upiURI = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(payeeName)}&am=${Number(amount).toFixed(2)}&tr=${encodeURIComponent(order_id)}&tn=Order_${encodeURIComponent(order_id)}&cu=INR`;

  return res.json({
    status: 'success',
    upi_uri: upiURI,
    qr_code: '',
    amount,
    order_id,
    paytm_mid: cfg.paytm_mid,
    merchant: vpa
  });
});

app.post('/api/payment/verify', async (req: Request, res: Response) => {
  const { tenant_id = '', mid = '', order_id = '' } = req.body || {};
  const cleanUser = String(tenant_id).trim().toLowerCase();
  const cfg = paymentConfigsMap.get(cleanUser) || {};
  const paytmMID = mid || cfg.paytm_mid || '';

  if (!paytmMID || !order_id) {
    return res.status(400).json({ error: 'paytm MID and order_id required' });
  }

  try {
    const jsonPayload = JSON.stringify({ MID: paytmMID, ORDERID: order_id });
    const paytmURL = `https://securegw.paytm.in/order/status?JsonData=${encodeURIComponent(jsonPayload)}`;
    const response = await fetch(paytmURL);
    const data = await response.json();
    const isSuccess = data?.STATUS === 'TXN_SUCCESS';

    if (isSuccess && getPool()) {
      const { customer_phone = '', amount = '' } = req.body || {};
      const cleanPhone = String(customer_phone || '').replace(/\D/g, '');
      const paidAmount = amount || data?.TXNAMOUNT || '0';
      const txnId = data?.TXNID || order_id;
      const inquiryText = `Order ${order_id} | Amount: ₹${paidAmount} | TxnID: ${txnId}`;

      try {
        await getPool()!.query(
          `INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at)
           VALUES ($1, $2, $3, 'Confirmed Paid (Paytm UPI)', NOW())`,
          [cleanUser, cleanPhone || 'Customer', inquiryText]
        );
        pushToLiveChat(cleanUser, cleanPhone || 'customer', `🎉 Payment Verified: ₹${paidAmount} (Txn: ${txnId})`, 'lead_alert');
      } catch (dbErr) {
        console.warn('Payment lead recording notice:', dbErr);
      }
    }

    return res.json({
      status: 'success',
      verified: isSuccess,
      details: data
    });
  } catch(err: any) {
    return res.json({
      status: 'error',
      message: err?.message || 'Paytm verification request failed',
      verified: false
    });
  }
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
    return res.json({ status: 'active', gateway: 'WaMart 24/7 Inbound AI Auto-Reply Receiver Active' });
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

  let user = username ? await findUserByIdentifier(username, memoryUsers) : undefined;
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
  if (getPool()) {
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
    numbers = '',
    message = '',
    image_url = '',
    temp_file_path = '',
    use_anti_ban = true,
    delay_ms = 1200
  } = req.body || {};

  const rawPhonesList = Array.isArray(phones) && phones.length > 0
    ? phones
    : String(numbers || '').split(/[\n,]+/).filter(Boolean);

  if (rawPhonesList.length === 0) {
    return res.status(400).json({ status: 'error', error: 'No target numbers provided', message: 'No target numbers provided' });
  }

  if (!message && !image_url) {
    return res.status(400).json({ status: 'error', error: 'Please provide message text or an image', message: 'Please provide message text or an image' });
  }

  // Clean numbers
  const cleanedPhones = rawPhonesList.map((p: any) => String(p).trim().replace(/\D/g, '')).filter((p: string) => p.length >= 8);
  if (cleanedPhones.length === 0) {
    return res.status(400).json({ status: 'error', error: 'No valid phone numbers found after parsing', message: 'No valid phone numbers found after parsing' });
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
  const username = (req.query.username as string) || '';
  const campaign = activeCampaigns.get(username) || activeCampaigns.get('') || activeCampaigns.get('admin');

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
  const username = ((req.query.username as string) || 'admin').trim();
  const user = username ? memoryUsers.get(username.toLowerCase()) : undefined;

  const pool = getPool();
  if (pool) {
    try {
      const dbRes = await pool.query(
        `SELECT 
          COALESCE(ai_provider, 'Groq') as ai_provider,
          COALESCE(NULLIF(ai_model, ''), NULLIF(model, ''), 'llama-3.3-70b-versatile') as model,
          COALESCE(ai_temperature, temperature, 0.7) as temperature,
          COALESCE(notification_phone, '') as notification_phone,
          COALESCE(api_key, '') as api_key,
          COALESCE(system_prompt, '') as system_prompt,
          COALESCE(auto_reply, true) as auto_reply,
          COALESCE(import_catalog_details, true) as import_catalog_details,
          COALESCE(business_name, account_name, '') as business_name,
          COALESCE(business_type, 'Kirana / General Store') as business_type,
          COALESCE(response_language, 'Hinglish') as response_language,
          COALESCE(paytm_mid, '') as paytm_mid,
          COALESCE(paytm_vpa, '') as paytm_vpa,
          COALESCE(store_policies, '') as store_policies,
          COALESCE(allow_cod, true) as allow_cod
        FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
        [username]
      );

      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        const bName = row.business_name || user?.business_name || user?.account_name || username;
        const bType = row.business_type || user?.business_type || 'Kirana / General Store';
        const lang = row.response_language || user?.response_language || 'Hinglish';
        const tempVal = row.temperature !== null && row.temperature !== undefined ? Number(row.temperature) : 0.7;
        return res.json({
          status: 'success',
          business_name: bName,
          business_type: bType,
          response_language: lang,
          language: lang,
          platform: row.ai_provider || 'Groq',
          ai_provider: row.ai_provider || 'Groq',
          model: row.model || 'llama-3.3-70b-versatile',
          ai_model: row.model || 'llama-3.3-70b-versatile',
          temperature: tempVal,
          ai_temperature: tempVal,
          notification_phone: row.notification_phone || '',
          api_key: row.api_key || '',
          system_prompt: row.system_prompt || '',
          auto_reply: row.auto_reply !== false,
          import_catalog_details: row.import_catalog_details !== false,
          paytm_mid: row.paytm_mid || '',
          paytm_vpa: row.paytm_vpa || '',
          store_policies: row.store_policies || '',
          allow_cod: row.allow_cod !== false
        });
      }
    } catch (err) {
      console.warn('Error querying AI settings from Neon DB:', err);
    }
  }

  const defaultBName = user?.business_name || user?.account_name || username || 'My Store';
  const defaultBType = user?.business_type || 'Kirana / General Store';
  const defaultLang = user?.response_language || 'Hinglish';

  return res.json({
    status: 'success',
    business_name: defaultBName,
    business_type: defaultBType,
    response_language: defaultLang,
    language: defaultLang,
    platform: user?.ai_provider || 'Groq',
    ai_provider: user?.ai_provider || 'Groq',
    model: user?.model || 'llama-3.3-70b-versatile',
    ai_model: user?.model || 'llama-3.3-70b-versatile',
    temperature: user?.temperature ?? 0.7,
    ai_temperature: user?.temperature ?? 0.7,
    notification_phone: user?.notification_phone || user?.phone || '',
    api_key: user?.api_key || '',
    system_prompt: user?.system_prompt || '',
    auto_reply: user?.auto_reply ?? true,
    import_catalog_details: (user as any)?.import_catalog_details ?? true,
    paytm_mid: (user as any)?.paytm_mid || '',
    paytm_vpa: (user as any)?.paytm_vpa || '',
    store_policies: (user as any)?.store_policies || '',
    allow_cod: (user as any)?.allow_cod ?? true
  });
});

app.post('/api/ai/settings', async (req: Request, res: Response) => {
  const b = req.body || {};
  const username = String(b.username || 'admin').trim();
  const user = username ? memoryUsers.get(username.toLowerCase()) : undefined;

  const resolvedPlatform = String(b.platform || b.ai_provider || 'Groq').trim();
  const resolvedModel = String(b.ai_model || b.model || 'llama-3.3-70b-versatile').trim();
  const resolvedTemp = b.ai_temperature !== undefined ? parseFloat(b.ai_temperature) : (b.temperature !== undefined ? parseFloat(b.temperature) : 0.7);
  const resolvedNotifPhone = b.notification_phone !== undefined ? String(b.notification_phone).trim() : undefined;
  const resolvedApiKey = b.api_key !== undefined ? String(b.api_key).trim() : undefined;
  const resolvedPrompt = b.system_prompt !== undefined ? String(b.system_prompt).trim() : undefined;
  const resolvedAutoReply = b.auto_reply !== undefined ? Boolean(b.auto_reply) : true;
  const resolvedImportCatalog = b.import_catalog_details !== undefined ? Boolean(b.import_catalog_details) : true;
  const resolvedBName = b.business_name !== undefined && String(b.business_name).trim() !== '' ? String(b.business_name).trim() : undefined;
  const resolvedBType = b.business_type !== undefined && String(b.business_type).trim() !== '' ? String(b.business_type).trim() : undefined;
  const resolvedLang = String(b.response_language || b.language || 'Hinglish').trim();
  const resolvedPaytmMid = b.paytm_mid !== undefined && String(b.paytm_mid).trim() !== '' ? String(b.paytm_mid).trim() : undefined;
  const resolvedPaytmVpa = b.paytm_vpa !== undefined && String(b.paytm_vpa).trim() !== '' ? String(b.paytm_vpa).trim() : undefined;
  const resolvedStorePolicies = b.store_policies !== undefined ? String(b.store_policies).trim() : undefined;

  if (user) {
    user.ai_provider = resolvedPlatform;
    user.model = resolvedModel;
    user.ai_model = resolvedModel;
    user.temperature = resolvedTemp;
    user.ai_temperature = resolvedTemp;
    if (resolvedNotifPhone !== undefined) user.notification_phone = resolvedNotifPhone;
    if (resolvedApiKey !== undefined) user.api_key = resolvedApiKey;
    if (resolvedPrompt !== undefined) user.system_prompt = resolvedPrompt;
    user.auto_reply = resolvedAutoReply;
    (user as any).import_catalog_details = resolvedImportCatalog;
    if (resolvedBName) user.business_name = resolvedBName;
    if (resolvedBType) user.business_type = resolvedBType;
    user.response_language = resolvedLang;
    if (resolvedPaytmMid) (user as any).paytm_mid = resolvedPaytmMid;
    if (resolvedPaytmVpa) (user as any).paytm_vpa = resolvedPaytmVpa;
    if (resolvedStorePolicies !== undefined) (user as any).store_policies = resolvedStorePolicies;
  }

  const pool = getPool();
  if (pool) {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS import_catalog_details BOOLEAN DEFAULT true;`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_model VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile';`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_temperature DOUBLE PRECISION DEFAULT 0.7;`);

      const sets: string[] = [
        'ai_provider = $1',
        'model = $2',
        'ai_model = $2',
        'temperature = $3',
        'ai_temperature = $3',
        'auto_reply = $4',
        'import_catalog_details = $5',
        'response_language = $6'
      ];
      const vals: any[] = [
        resolvedPlatform,
        resolvedModel,
        resolvedTemp,
        resolvedAutoReply,
        resolvedImportCatalog,
        resolvedLang
      ];
      let idx = 7;
      const addOpt = (col: string, val: any) => {
        sets.push(`${col} = $${idx}`);
        vals.push(val);
        idx++;
      };

      if (resolvedNotifPhone !== undefined) addOpt('notification_phone', resolvedNotifPhone);
      if (resolvedApiKey !== undefined) addOpt('api_key', resolvedApiKey);
      if (resolvedPrompt !== undefined) addOpt('system_prompt', resolvedPrompt);
      if (resolvedStorePolicies !== undefined) addOpt('store_policies', resolvedStorePolicies);
      if (resolvedBName !== undefined) addOpt('business_name', resolvedBName);
      if (resolvedBType !== undefined) addOpt('business_type', resolvedBType);
      if (resolvedPaytmMid !== undefined) addOpt('paytm_mid', resolvedPaytmMid);
      if (resolvedPaytmVpa !== undefined) addOpt('paytm_vpa', resolvedPaytmVpa);
      if (b.allow_cod !== undefined) addOpt('allow_cod', Boolean(b.allow_cod));

      vals.push(username.toLowerCase());
      await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE LOWER(username) = LOWER($${idx})`,
        vals
      );
    } catch (dbErr) {
      console.warn('Neon DB AI settings sync error:', dbErr);
    }
  }

  return res.json({ status: 'success', message: 'AI Lead Responder settings saved & synced to cloud DB!' });
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

// 12. CATEGORIES ENDPOINT (/api/categories)
app.all('/api/categories', async (req: Request, res: Response) => {
  if (req.method === 'GET') {
    const username = ((req.query.username as string) || 'admin').trim().toLowerCase();

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
              id SERIAL PRIMARY KEY,
              username VARCHAR(255) NOT NULL,
              category_name VARCHAR(255) NOT NULL,
              category_image_url TEXT DEFAULT '',
              parent_id INT DEFAULT 0,
              parent_name VARCHAR(255) DEFAULT '',
              created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(username, category_name)
            );
          `);

          const catRes = await pool.query(
            `SELECT c.id,
                    c.category_name,
                    c.category_name as name,
                    COALESCE(c.category_image_url, '') as category_image_url,
                    COALESCE(c.parent_id, 0)::int as parent_id,
                    COALESCE(c.parent_name, '') as parent_name,
                    (SELECT COUNT(*)::int FROM products p
                     WHERE LOWER(p.username) = LOWER(c.username)
                       AND (
                         p.category_id = c.id
                         OR LOWER(TRIM(COALESCE(p.category, ''))) = LOWER(TRIM(c.category_name))
                         OR LOWER(TRIM(COALESCE(p.sub_category, ''))) = LOWER(TRIM(c.category_name))
                       )
                    ) as product_count
             FROM categories c
             WHERE LOWER(c.username) = LOWER($1)
             ORDER BY COALESCE(c.parent_id, 0) ASC, c.id ASC`,
            [username]
          );

          return res.json({
            status: 'success',
            categories: catRes.rows
          });
        } catch (err) {
          console.warn('Categories DB fetch error:', err);
        }
      }
    }

    const filtered = memoryCategories.filter(c => c.username.toLowerCase() === username);
    const result = filtered.map((c: any) => {
      const pCount = memoryCatalog.filter(p =>
        p.username.toLowerCase() === username &&
        (
          (p.category || '').toLowerCase() === c.category_name.toLowerCase() ||
          ((p as any).sub_category || '').toLowerCase() === c.category_name.toLowerCase()
        )
      ).length;
      return {
        id: c.id,
        category_name: c.category_name,
        name: c.category_name,
        category_image_url: c.category_image_url || '',
        parent_id: c.parent_id || 0,
        parent_name: c.parent_name || '',
        product_count: pCount
      };
    });

    return res.json({
      status: 'success',
      categories: result
    });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    const id = parseInt(String(body?.id || 0), 10);
    const username = String(body?.username || 'admin').trim().toLowerCase();
    const categoryName = String(body?.category_name || body?.name || body?.category || '').trim();
    const categoryImageUrl = String(body?.category_image_url || body?.image_url || '').trim();
    const parentId = parseInt(String(body?.parent_id || 0), 10) || 0;
    const parentName = String(body?.parent_name || body?.parent_category || '').trim();

    if (!categoryName) {
      return res.status(400).json({ status: 'error', message: 'Category Name is required' });
    }

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          if (id > 0) {
            const oldCatRes = await pool.query(
              `SELECT category_name FROM categories WHERE id = $1 AND LOWER(username) = LOWER($2)`,
              [id, username]
            );
            const oldName = oldCatRes.rows[0]?.category_name || '';

            await pool.query(
              `UPDATE categories
               SET category_name = $1,
                   category_image_url = $2,
                   parent_id = $3,
                   parent_name = $4
               WHERE id = $5 AND LOWER(username) = LOWER($6)`,
              [categoryName, categoryImageUrl, parentId, parentName, id, username]
            );

            if (oldName && oldName !== categoryName) {
              await pool.query(
                `UPDATE categories SET parent_name = $1 WHERE LOWER(username) = LOWER($2) AND LOWER(parent_name) = LOWER($3)`,
                [categoryName, username, oldName]
              );
              await pool.query(
                `UPDATE products SET category = $1 WHERE LOWER(username) = LOWER($2) AND LOWER(category) = LOWER($3)`,
                [categoryName, username, oldName]
              );
              await pool.query(
                `UPDATE products SET sub_category = $1 WHERE LOWER(username) = LOWER($2) AND LOWER(sub_category) = LOWER($3)`,
                [categoryName, username, oldName]
              );
            }

            return res.json({
              status: 'success',
              id,
              category_name: categoryName,
              category_image_url: categoryImageUrl,
              parent_id: parentId,
              parent_name: parentName,
              message: 'Category updated successfully!'
            });
          }

          const insertRes = await pool.query(
            `INSERT INTO categories (username, category_name, category_image_url, parent_id, parent_name)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (username, category_name) DO UPDATE SET
               category_image_url = CASE WHEN EXCLUDED.category_image_url != '' THEN EXCLUDED.category_image_url ELSE categories.category_image_url END,
               parent_id = EXCLUDED.parent_id,
               parent_name = EXCLUDED.parent_name
             RETURNING id`,
            [username, categoryName, categoryImageUrl, parentId, parentName]
          );

          return res.json({
            status: 'success',
            id: insertRes.rows[0]?.id || 1,
            category_name: categoryName,
            category_image_url: categoryImageUrl,
            parent_id: parentId,
            parent_name: parentName,
            message: 'Category saved successfully!'
          });
        } catch (err: any) {
          return res.status(500).json({ status: 'error', message: err?.message || 'Database error saving category' });
        }
      }
    }

    let existing: any = id > 0
      ? memoryCategories.find(c => c.id === id && c.username.toLowerCase() === username)
      : memoryCategories.find(c => c.username.toLowerCase() === username && c.category_name.toLowerCase() === categoryName.toLowerCase());

    if (existing) {
      existing.category_name = categoryName;
      existing.category_image_url = categoryImageUrl;
      existing.parent_id = parentId;
      existing.parent_name = parentName;
    } else {
      existing = {
        id: nextCategoryId++,
        username,
        category_name: categoryName,
        category_image_url: categoryImageUrl,
        parent_id: parentId,
        parent_name: parentName,
        created_at: new Date().toISOString()
      };
      memoryCategories.push(existing);
    }

    return res.json({
      status: 'success',
      id: existing.id,
      category_name: categoryName,
      category_image_url: categoryImageUrl,
      parent_id: parentId,
      parent_name: parentName,
      message: 'Category saved successfully!'
    });
  }

  if (req.method === 'DELETE') {
    const id = parseInt((req.query.id as string) || (req.body?.id as string) || '0', 10);
    const username = String(req.query.username || req.body?.username || 'admin').trim().toLowerCase();

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `DELETE FROM categories WHERE id = $1 AND LOWER(username) = LOWER($2)`,
            [id, username]
          );
          return res.json({ status: 'success', message: 'Category deleted' });
        } catch (err: any) {
          return res.status(500).json({ status: 'error', message: err?.message || 'Failed to delete category' });
        }
      }
    }

    const idx = memoryCategories.findIndex(c => c.id === id && c.username.toLowerCase() === username);
    if (idx !== -1) {
      memoryCategories.splice(idx, 1);
    }

    return res.json({ status: 'success', message: 'Category deleted' });
  }

  return res.status(405).json({ status: 'error', message: 'Method not allowed' });
});

function resolveBusinessUsername(req: Request, bodyUsername?: string): string {
  const fromQuery = String(req.query.username || bodyUsername || '').trim().replace(/^@/, '');
  if (fromQuery) return fromQuery.toLowerCase();
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('wamart-token-')) {
      const extracted = token.slice('wamart-token-'.length).trim().replace(/^@/, '');
      if (extracted) return extracted.toLowerCase();
    }
  }
  return 'admin';
}

// 12C. SMART AI PRODUCT & SERVICE CATALOG (/api/products & /api/business/products)
app.get(['/api/products', '/api/business/products'], async (req: Request, res: Response) => {
  const username = resolveBusinessUsername(req);

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const rows = await pool.query(
          `SELECT id,
                  COALESCE(category_id, 0)::int as category_id,
                  name,
                  COALESCE(sku, '') as sku,
                  COALESCE(price, '₹0') as price,
                  COALESCE(description, '') as description,
                  COALESCE(category, '') as category,
                  COALESCE(sub_category, '') as sub_category,
                  COALESCE(sub_category_id, 0)::int as sub_category_id,
                  COALESCE(item_type, 'product') as item_type,
                  COALESCE(unit_type, 'custom') as unit_type,
                  COALESCE(variants, '[]'::jsonb) as variants,
                  COALESCE(images, '[]'::jsonb) as images,
                  COALESCE(in_stock, true) as in_stock,
                  COALESCE(stock_quantity, 50)::int as stock_quantity,
                  COALESCE(low_stock_threshold, 5)::int as low_stock_threshold,
                  COALESCE(mrp, 0)::float as mrp,
                  COALESCE(sale_price, 0)::float as sale_price,
                  COALESCE(product_image_url, image_url, '') as product_image_url,
                  COALESCE(whatsapp_catalog_link, '') as whatsapp_catalog_link
           FROM products
           WHERE LOWER(username) = LOWER($1)
           ORDER BY id ASC`,
          [username]
        );

        const products = rows.rows.map((r) => {
          let parsedImages: string[] = [];
          if (Array.isArray(r.images)) {
            parsedImages = r.images.filter(Boolean);
          } else if (typeof r.images === 'string') {
            try { parsedImages = JSON.parse(r.images).filter(Boolean); } catch {}
          }
          if (parsedImages.length === 0 && r.product_image_url) {
            parsedImages = [r.product_image_url];
          }
          const primaryImg = parsedImages[0] || r.product_image_url || '';

          let parsedVariants: any[] = [];
          if (Array.isArray(r.variants)) {
            parsedVariants = r.variants;
          } else if (typeof r.variants === 'string') {
            try { parsedVariants = JSON.parse(r.variants); } catch {}
          }

          return {
            id: r.id,
            category_id: r.category_id || 0,
            name: r.name,
            sku: r.sku || `SKU-${String(r.id).padStart(4, '0')}`,
            price: r.price,
            mrp: Number(r.mrp) || 0,
            sale_price: Number(r.sale_price) || parseFloat(String(r.price || '').replace(/[^\d.]/g, '')) || 0,
            details: r.description,
            description: r.description,
            category: r.category,
            category_name: r.category,
            sub_category: r.sub_category || '',
            sub_category_id: r.sub_category_id || 0,
            item_type: r.item_type || 'product',
            unit_type: r.unit_type || 'custom',
            variants: parsedVariants,
            images: parsedImages,
            in_stock: Boolean(r.in_stock),
            stock_quantity: typeof r.stock_quantity === 'number' ? r.stock_quantity : 50,
            low_stock_threshold: typeof r.low_stock_threshold === 'number' ? r.low_stock_threshold : 5,
            product_image_url: primaryImg,
            image_url: primaryImg,
            whatsapp_catalog_link: r.whatsapp_catalog_link,
            whatsapp_url: r.whatsapp_catalog_link
          };
        });
        return res.json({ status: 'success', products });
      } catch (err) {
        console.warn('DB products fetch fallback:', err);
      }
    }
  }

  const items = memoryCatalog.filter(m => m.username.toLowerCase() === username);
  const products = items.map((m) => ({
    id: m.id,
    name: m.name,
    sku: (m as any).sku || `SKU-${String(m.id).padStart(4, '0')}`,
    price: m.price,
    mrp: (m as any).mrp || 0,
    sale_price: (m as any).sale_price || parseFloat(String(m.price).replace(/[^\d.]/g, '')) || 0,
    details: m.details,
    description: m.details,
    category: m.category || '',
    category_name: m.category || '',
    sub_category: (m as any).sub_category || '',
    sub_category_id: (m as any).sub_category_id || 0,
    item_type: m.item_type || 'product',
    unit_type: m.unit_type || 'custom',
    variants: Array.isArray(m.variants) ? m.variants : [],
    images: (m as any).images || (m.image_url ? [m.image_url] : []),
    in_stock: m.in_stock ?? true,
    stock_quantity: (m as any).stock_quantity ?? 50,
    low_stock_threshold: (m as any).low_stock_threshold ?? 5,
    product_image_url: m.image_url || '',
    image_url: m.image_url || '',
    whatsapp_catalog_link: m.whatsapp_catalog_link || '',
    whatsapp_url: m.whatsapp_catalog_link || ''
  }));
  return res.json({ status: 'success', products });
});

app.post(['/api/products', '/api/business/products'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const id = parseInt(String(body?.id || 0), 10);
  const {
    name = '',
    sku = '',
    price = '',
    mrp = 0,
    sale_price = 0,
    description = '',
    details = '',
    username = 'admin',
    item_type = 'product',
    unit_type = 'custom',
    variants = [],
    images = [],
    whatsapp_catalog_link = '',
    whatsapp_url = '',
    image_url = '',
    product_image_url = '',
    category = '',
    category_name = '',
    category_id = 0,
    sub_category = '',
    sub_category_id = 0,
    in_stock = true,
    stock_quantity,
    low_stock_threshold,
    stock_delta
  } = body || {};

  const cleanUser = String(username || 'admin').trim().toLowerCase();

  // Quick stock status or stock quantity adjustment when name is omitted
  if (id > 0 && !String(name).trim()) {
    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          if (stock_delta !== undefined) {
            const deltaVal = parseInt(String(stock_delta), 10) || 0;
            const updRes = await pool.query(
              `UPDATE products
               SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) + $1),
                   in_stock = CASE WHEN GREATEST(0, COALESCE(stock_quantity, 0) + $1) > 0 THEN true ELSE false END
               WHERE id = $2 AND LOWER(username) = LOWER($3)
               RETURNING stock_quantity, in_stock`,
              [deltaVal, id, cleanUser]
            );
            return res.json({
              status: 'success',
              stock_quantity: updRes.rows[0]?.stock_quantity ?? 0,
              in_stock: updRes.rows[0]?.in_stock ?? false,
              message: 'Stock quantity updated'
            });
          }
          if (stock_quantity !== undefined) {
            const newQty = Math.max(0, parseInt(String(stock_quantity), 10) || 0);
            const autoInStock = body?.in_stock !== undefined ? Boolean(in_stock) : newQty > 0;
            await pool.query(
              `UPDATE products SET stock_quantity = $1, in_stock = $2 WHERE id = $3 AND LOWER(username) = LOWER($4)`,
              [newQty, autoInStock, id, cleanUser]
            );
            return res.json({
              status: 'success',
              stock_quantity: newQty,
              in_stock: autoInStock,
              message: 'Stock quantity updated'
            });
          }
          const inStockVal = Boolean(in_stock);
          await pool.query(
            `UPDATE products SET in_stock = $1 WHERE id = $2 AND LOWER(username) = LOWER($3)`,
            [inStockVal, id, cleanUser]
          );
          return res.json({ status: 'success', in_stock: inStockVal, message: 'Stock status updated' });
        } catch (e: any) {
          return res.status(500).json({ status: 'error', message: e?.message || 'Failed to update stock' });
        }
      }
    }
    const memItem: any = memoryCatalog.find(m => m.id === id);
    if (memItem) {
      if (stock_delta !== undefined) {
        memItem.stock_quantity = Math.max(0, (memItem.stock_quantity ?? 50) + (parseInt(String(stock_delta), 10) || 0));
        memItem.in_stock = memItem.stock_quantity > 0;
      } else if (stock_quantity !== undefined) {
        memItem.stock_quantity = Math.max(0, parseInt(String(stock_quantity), 10) || 0);
        memItem.in_stock = body?.in_stock !== undefined ? Boolean(in_stock) : memItem.stock_quantity > 0;
      } else {
        memItem.in_stock = Boolean(in_stock);
      }
    }
    return res.json({ status: 'success', message: 'Stock status updated' });
  }

  const cleanName = String(name).trim();
  if (!cleanName) {
    return res.status(400).json({ status: 'error', error: 'Product Name is required', message: 'Product Name is required' });
  }

  const catName = String(category_name || category || '').trim();
  const subCatName = String(sub_category || '').trim();
  const catIdVal = parseInt(String(category_id || 0), 10) || 0;
  const subCatIdVal = parseInt(String(sub_category_id || 0), 10) || 0;
  const cleanSku = String(sku || '').trim();

  const rawImages: string[] = Array.isArray(images)
    ? images.map((u: any) => String(u || '').trim()).filter(Boolean)
    : [];
  const fallbackSingleImg = String(product_image_url || image_url || '').trim();
  if (rawImages.length === 0 && fallbackSingleImg) {
    rawImages.push(fallbackSingleImg);
  }
  const cleanImages = rawImages.slice(0, 3);
  const imgUrl = cleanImages[0] || fallbackSingleImg || '';

  const waUrl = String(whatsapp_url || whatsapp_catalog_link || '').trim();
  const mrpVal = parseFloat(String(mrp)) || 0;
  const salePriceVal = parseFloat(String(sale_price)) || 0;
  const descStr = String(description || details || '').trim();
  const stockQtyVal = stock_quantity !== undefined && stock_quantity !== ''
    ? Math.max(0, parseInt(String(stock_quantity), 10) || 0)
    : 50;
  const lowStockVal = low_stock_threshold !== undefined && low_stock_threshold !== ''
    ? Math.max(0, parseInt(String(low_stock_threshold), 10) || 5)
    : 5;
  const inStockVal = Boolean(in_stock);

  let summaryPrice = String(price || '').trim();
  if (!summaryPrice && salePriceVal > 0) {
    summaryPrice = `₹${salePriceVal}`;
  }
  if (!summaryPrice) {
    summaryPrice = '₹0';
  }

  const jsonVariants = JSON.stringify(Array.isArray(variants) ? variants : []);
  const jsonImages = JSON.stringify(cleanImages);

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        if (id > 0) {
          await pool.query(
            `UPDATE products
             SET category_id = $2,
                 category = $3,
                 sub_category = $4,
                 sub_category_id = $5,
                 name = $6,
                 sku = $7,
                 description = $8,
                 mrp = $9,
                 sale_price = $10,
                 price = $11,
                 item_type = $12,
                 unit_type = $13,
                 variants = $14::jsonb,
                 whatsapp_catalog_link = $15,
                 image_url = $16,
                 product_image_url = $16,
                 images = $17::jsonb,
                 in_stock = $18,
                 stock_quantity = $19,
                 low_stock_threshold = $20
             WHERE id = $21 AND LOWER(username) = LOWER($1)`,
            [
              cleanUser,
              catIdVal,
              catName,
              subCatName,
              subCatIdVal,
              cleanName,
              cleanSku,
              descStr,
              mrpVal,
              salePriceVal,
              summaryPrice,
              item_type || 'product',
              unit_type || 'custom',
              jsonVariants,
              waUrl,
              imgUrl,
              jsonImages,
              inStockVal,
              stockQtyVal,
              lowStockVal,
              id
            ]
          );
          return res.json({
            status: 'success',
            id,
            image_url: imgUrl,
            images: cleanImages,
            message: 'Product updated successfully!'
          });
        }

        const result = await pool.query(
          `INSERT INTO products (
             username, category_id, category, sub_category, sub_category_id,
             name, sku, description, price, mrp, sale_price,
             item_type, unit_type, variants, whatsapp_catalog_link,
             image_url, product_image_url, images, in_stock, stock_quantity, low_stock_threshold
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $16, $17::jsonb, $18, $19, $20)
           RETURNING id`,
          [
            cleanUser,
            catIdVal,
            catName,
            subCatName,
            subCatIdVal,
            cleanName,
            cleanSku,
            descStr,
            summaryPrice,
            mrpVal,
            salePriceVal,
            item_type || 'product',
            unit_type || 'custom',
            jsonVariants,
            waUrl,
            imgUrl,
            jsonImages,
            inStockVal,
            stockQtyVal,
            lowStockVal
          ]
        );
        const newId = result.rows[0]?.id;
        return res.json({
          status: 'success',
          id: newId,
          image_url: imgUrl,
          images: cleanImages,
          message: 'Product saved to catalog!',
          product: {
            id: newId,
            name: cleanName,
            sku: cleanSku || `SKU-${String(newId).padStart(4, '0')}`,
            price: summaryPrice,
            mrp: mrpVal,
            sale_price: salePriceVal,
            category: catName,
            sub_category: subCatName,
            in_stock: inStockVal,
            stock_quantity: stockQtyVal,
            low_stock_threshold: lowStockVal,
            images: cleanImages
          }
        });
      } catch (err: any) {
        console.error('Failed to insert/update product in Neon DB:', err);
        return res.status(500).json({ status: 'error', message: err?.message || 'Database error saving product' });
      }
    }
  }

  // Fallback to in-memory catalog
  const newItem: any = {
    id: id > 0 ? id : nextCatalogId++,
    username: cleanUser,
    name: cleanName,
    sku: cleanSku,
    price: summaryPrice,
    mrp: mrpVal,
    sale_price: salePriceVal,
    details: descStr,
    description: descStr,
    tag: `<ITEM_${id || memoryCatalog.length + 1}>`,
    item_type: (item_type as any) || 'product',
    unit_type,
    variants: Array.isArray(variants) ? variants : [],
    whatsapp_catalog_link: waUrl,
    image_url: imgUrl,
    product_image_url: imgUrl,
    images: cleanImages,
    category: catName,
    sub_category: subCatName,
    in_stock: inStockVal,
    stock_quantity: stockQtyVal,
    low_stock_threshold: lowStockVal,
    created_at: new Date().toISOString()
  };
  if (id > 0) {
    const idx = memoryCatalog.findIndex(m => m.id === id);
    if (idx !== -1) memoryCatalog[idx] = newItem;
    else memoryCatalog.push(newItem);
  } else {
    memoryCatalog.push(newItem);
  }

  return res.json({
    status: 'success',
    id: newItem.id,
    image_url: imgUrl,
    images: cleanImages,
    message: 'Product saved to catalog!',
    product: newItem
  });
});

app.delete('/api/products', async (req: Request, res: Response) => {
  const id = req.query.id as string;
  const username = String(req.query.username || '').trim().toLowerCase();
  if (!id) {
    return res.status(400).json({ status: 'error', error: 'Missing product id' });
  }

  let deletedImages: string[] = [];

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const imgRes = await pool.query(
          `SELECT COALESCE(images, '[]'::jsonb) as images, COALESCE(product_image_url, image_url, '') as image_url
           FROM products WHERE id = $1`,
          [id]
        );
        if (imgRes.rows[0]) {
          const row = imgRes.rows[0];
          if (Array.isArray(row.images)) {
            deletedImages = row.images.filter(Boolean);
          }
          if (deletedImages.length === 0 && row.image_url) {
            deletedImages = [row.image_url];
          }
        }
        if (username) {
          await pool.query('DELETE FROM products WHERE id = $1 AND LOWER(username) = LOWER($2)', [id, username]);
        } else {
          await pool.query('DELETE FROM products WHERE id = $1', [id]);
        }
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

  return res.json({
    status: 'success',
    deleted_images: deletedImages,
    message: 'Item deleted from catalog'
  });
});

// 12D. BUSINESS DASHBOARD STATS (REAL LIVE METRICS)

// --- 12J. CUSTOMER LIVE ORDER STATE API (FOR BUSINESS PORTAL ORDER FORM) ---
app.get('/api/customer/order-state', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  const customerPhone = (req.query.customer_phone as string) || (req.query.phone as string) || '';
  const state = await getCustomerOrderState(username, customerPhone);
  return res.json({ status: 'success', order: state || null });
});

app.post('/api/customer/order-state', async (req: Request, res: Response) => {
  const { username = '', customer_phone = '', order_data } = req.body || {};
  if (!username || !customer_phone) {
    return res.status(400).json({ error: 'username and customer_phone required' });
  }
  await saveCustomerOrderState(username, customer_phone, order_data);
  return res.json({ status: 'success', message: 'Customer order state updated.' });
});

// --- 12K. ASYNC PAYMENT WEBHOOK RECEIVER (CLOUDFLARE WORKER) ---
app.post(['/webhook/payment', '/api/webhook/paytm'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const orderId = body?.orderId || body?.order_id || '';
  const status = (body?.status || '').toUpperCase();
  const amount = body?.amount || '';

  console.log(`🔔 [Node Payment Webhook Received] OrderID: ${orderId}, Status: ${status}, Amount: ${amount}`);

  if (!orderId) {
    return res.status(400).json({ error: 'orderId is required' });
  }

  const isSuccess = status === 'SUCCESS' || status === 'TXN_SUCCESS' || status === 'PAID';

  if (isSuccess && getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const orderRes = await pool.query(
          `SELECT username, customer_phone, total_amount FROM customer_order_states WHERE order_id = $1 LIMIT 1`,
          [orderId]
        );
        const row = orderRes.rows[0];
        const username = row?.username || 'admin';
        const customerPhone = row?.customer_phone || '';
        const resolvedAmount = amount || (row?.total_amount ? String(row.total_amount) : '0');

        await pool.query(
          `UPDATE customer_order_states SET payment_status = 'paid', order_status = 'confirmed', updated_at = NOW() WHERE order_id = $1`,
          [orderId]
        );

        if (username) {
          const leadInquiry = `Order ${orderId} | Amount: ₹${resolvedAmount} | Cloudflare Worker Async Verified`;
          await pool.query(
            `INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Confirmed Paid (Paytm Cloudflare Worker)', NOW())`,
            [username, customerPhone, leadInquiry]
          );
        }
      } catch (err: any) {
        console.error('Failed to update DB on payment webhook:', err.message);
      }
    }
  }

  return res.json({
    status: 'ok',
    received: true,
    orderId,
    verified: isSuccess
  });
});

app.get(['/api/business/dashboard', '/api/business/dashboard/stats'], async (req: Request, res: Response) => {
  const username = resolveBusinessUsername(req);
  const campaign = activeCampaigns.get(username);
  const activeCampaignsCount = (campaign && campaign.status === 'running') ? 1 : 0;

  let storeName = username;
  let storeSlug = username;
  let deliveryRadiusKm = 15;
  let freeDeliveryThreshold = 499;
  let waConnected = false;
  let waJid = '';
  let operatingHours = '09:00 AM - 09:00 PM';

  let totalChats = 0;
  let totalProducts = 0;
  let leadsCapturedTotal = 0;
  let leadsCapturedToday = 0;
  let messagesAutoRepliedToday = 0;

  let grossSalesToday = 0;
  let grossSalesYesterday = 0;
  let totalOrdersToday = 0;
  let webOrdersToday = 0;
  let whatsappOrdersToday = 0;
  let upiCollectedAmount = 0;
  let codPendingAmount = 0;

  const sevenDayLabels: string[] = [];
  const sevenDaySales: number[] = [];
  const sevenDayOrders: number[] = [];
  const dayBucketMap = new Map<string, { sales: number; orders: number }>();

  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    sevenDayLabels.push(label);
    dayBucketMap.set(key, { sales: 0, orders: 0 });
  }

  let webOrdersCount7d = 0;
  let whatsappOrdersCount7d = 0;
  let webRevenue7d = 0;
  let whatsappRevenue7d = 0;

  let recentOrders: any[] = [];
  let lowStockItems: any[] = [];

  const pool = getPool();
  if (pool) {
    try {
      // 1. User / Store profile & WhatsApp status
      const uRes = await pool.query(
        `SELECT COALESCE(NULLIF(store_name, ''), NULLIF(account_name, ''), username) as store_name,
                COALESCE(NULLIF(store_slug, ''), username) as store_slug,
                COALESCE(delivery_radius_km, max_delivery_radius_km, 15)::float as delivery_radius_km,
                COALESCE(free_delivery_threshold, 499)::float as free_delivery_threshold,
                COALESCE(status, 'Disconnected') as status,
                COALESCE(wa_jid, '') as wa_jid,
                COALESCE(NULLIF(operating_hours, ''), '09:00 AM - 09:00 PM') as operating_hours
         FROM users
         WHERE LOWER(username) = LOWER($1) OR LOWER(store_slug) = LOWER($1)
         LIMIT 1`,
        [username]
      );
      if (uRes.rows.length > 0) {
        const u = uRes.rows[0];
        storeName = u.store_name || username;
        storeSlug = u.store_slug || username;
        deliveryRadiusKm = Number(u.delivery_radius_km || 15);
        freeDeliveryThreshold = Number(u.free_delivery_threshold || 499);
        waJid = u.wa_jid || '';
        waConnected = u.status === 'Connected' || Boolean(waJid);
        operatingHours = u.operating_hours || '09:00 AM - 09:00 PM';
      }
    } catch (e: any) {
      console.warn('Dashboard user profile query notice:', e.message);
    }

    try {
      // 2. Leads & AI Chats stats
      const lRes = await pool.query(
        `SELECT COUNT(*)::int as total_leads,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int as today_leads
         FROM leads
         WHERE LOWER(username) = LOWER($1)`,
        [username]
      );
      if (lRes.rows.length > 0) {
        leadsCapturedTotal = Number(lRes.rows[0].total_leads || 0);
        leadsCapturedToday = Number(lRes.rows[0].today_leads || 0);
      }

      const cRes = await pool.query(
        `SELECT COUNT(DISTINCT customer_phone)::int as total_chats,
                COUNT(*) FILTER (WHERE (LOWER(role) IN ('assistant', 'ai', 'bot') OR LOWER(sender_type) IN ('ai', 'bot')) AND created_at >= CURRENT_DATE)::int as today_ai_replies,
                COUNT(*) FILTER (WHERE LOWER(role) IN ('assistant', 'ai', 'bot') OR LOWER(sender_type) IN ('ai', 'bot'))::int as total_ai_replies
         FROM customer_chats
         WHERE LOWER(username) = LOWER($1)`,
        [username]
      );
      if (cRes.rows.length > 0) {
        totalChats = Number(cRes.rows[0].total_chats || 0);
        messagesAutoRepliedToday = Number(cRes.rows[0].today_ai_replies || cRes.rows[0].total_ai_replies || 0);
      }
    } catch (e: any) {
      console.warn('Dashboard leads/chats query notice:', e.message);
    }

    try {
      // 3. Products count & Low Stock alerts
      const pCountRes = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM products WHERE LOWER(username) = LOWER($1)`,
        [username]
      );
      totalProducts = Number(pCountRes.rows[0]?.cnt || 0);

      const lowStockRes = await pool.query(
        `SELECT id,
                name,
                COALESCE(sku, '') as sku,
                COALESCE(category, 'General') as category,
                COALESCE(in_stock, true) as in_stock,
                COALESCE(stock_quantity, 50)::int as stock_quantity,
                COALESCE(low_stock_threshold, 5)::int as low_stock_threshold,
                COALESCE(sale_price, 0)::float as sale_price,
                COALESCE(price, '₹0') as price
         FROM products
         WHERE LOWER(username) = LOWER($1)
           AND (COALESCE(in_stock, true) = false OR COALESCE(stock_quantity, 50) <= COALESCE(low_stock_threshold, 5))
         ORDER BY COALESCE(in_stock, true) ASC, COALESCE(stock_quantity, 50) ASC
         LIMIT 5`,
        [username]
      );
      lowStockItems = lowStockRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        sku: r.sku || `SKU-${String(r.id).padStart(4, '0')}`,
        category: r.category || 'General',
        in_stock: Boolean(r.in_stock),
        stock_quantity: r.in_stock ? Number(r.stock_quantity ?? 0) : 0,
        low_stock_threshold: Number(r.low_stock_threshold ?? 5),
        price: Number(r.sale_price) || parseFloat(String(r.price || '').replace(/[^\d.]/g, '')) || 0
      }));
    } catch (e: any) {
      console.warn('Dashboard products/low-stock query notice:', e.message);
    }

    try {
      // 4. Orders analytics & Recent orders from orders table (plus customer_order_states fallback)
      const oRes = await pool.query(
        `SELECT id,
                order_id,
                jid,
                customer_phone,
                tenant_id,
                customer_name,
                delivery_phone,
                delivery_address,
                items,
                COALESCE(total_amount, 0)::float as total_amount,
                COALESCE(payment_mode, 'COD') as payment_mode,
                COALESCE(payment_status, 'PENDING') as payment_status,
                COALESCE(order_status, 'NEW') as order_status,
                created_at
         FROM orders
         WHERE LOWER(tenant_id) = LOWER($1) OR LOWER(tenant_id) = LOWER($2)
         ORDER BY created_at DESC
         LIMIT 200`,
        [username, storeSlug]
      );

      let rawOrders = oRes.rows;

      // Also merge any customer_order_states orders that aren't in orders table
      const sRes = await pool.query(
        `SELECT id,
                order_id,
                jid,
                customer_phone,
                COALESCE(tenant_id, username) as tenant_id,
                customer_name,
                delivery_phone,
                delivery_address,
                items,
                COALESCE(total_amount, 0)::float as total_amount,
                COALESCE(payment_mode, 'COD') as payment_mode,
                COALESCE(payment_status, 'PENDING') as payment_status,
                COALESCE(order_status, 'NEW') as order_status,
                COALESCE(updated_at, created_at) as created_at
         FROM customer_order_states
         WHERE (LOWER(username) = LOWER($1) OR LOWER(tenant_id) = LOWER($1) OR LOWER(tenant_id) = LOWER($2))
           AND order_id IS NOT NULL AND order_id != ''
         ORDER BY updated_at DESC
         LIMIT 50`,
        [username, storeSlug]
      );

      const seenOrderIds = new Set(rawOrders.map((r) => String(r.order_id || '').trim()).filter(Boolean));
      for (const sr of sRes.rows) {
        const oid = String(sr.order_id || '').trim();
        if (oid && !seenOrderIds.has(oid)) {
          seenOrderIds.add(oid);
          rawOrders.push(sr);
        }
      }

      const todayStr = now.toISOString().slice(0, 10);
      const yesterdayDate = new Date(now);
      yesterdayDate.setDate(now.getDate() - 1);
      const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

      for (const r of rawOrders) {
        const amt = Number(r.total_amount || 0);
        const createdDate = r.created_at ? new Date(r.created_at) : now;
        const dateKey = !isNaN(createdDate.getTime()) ? createdDate.toISOString().slice(0, 10) : todayStr;

        const orderIdStr = String(r.order_id || `ORD-${r.id}`);
        const payMode = String(r.payment_mode || 'COD').toUpperCase();
        const payStatus = String(r.payment_status || 'PENDING').toUpperCase();
        const isWhatsAppSource =
          orderIdStr.toUpperCase().startsWith('WA') ||
          payMode.includes('WHATSAPP') ||
          (Boolean(r.jid) && !orderIdStr.toUpperCase().startsWith('WEB'));
        const source = isWhatsAppSource ? 'WhatsApp' : 'Web';

        if (dateKey === todayStr) {
          grossSalesToday += amt;
          totalOrdersToday += 1;
          if (source === 'WhatsApp') {
            whatsappOrdersToday += 1;
          } else {
            webOrdersToday += 1;
          }
        } else if (dateKey === yesterdayStr) {
          grossSalesYesterday += amt;
        }

        if (payStatus === 'PAID' || payStatus === 'SUCCESS' || payStatus === 'COMPLETED' || payMode.includes('UPI') || payMode.includes('ONLINE')) {
          if (payStatus === 'PAID' || payStatus === 'SUCCESS' || payStatus === 'COMPLETED') {
            upiCollectedAmount += amt;
          } else if (payMode.includes('COD') || payMode.includes('CASH')) {
            codPendingAmount += amt;
          } else {
            upiCollectedAmount += amt;
          }
        } else {
          codPendingAmount += amt;
        }

        if (dayBucketMap.has(dateKey)) {
          const b = dayBucketMap.get(dateKey)!;
          b.sales += amt;
          b.orders += 1;
          if (source === 'WhatsApp') {
            whatsappOrdersCount7d += 1;
            whatsappRevenue7d += amt;
          } else {
            webOrdersCount7d += 1;
            webRevenue7d += amt;
          }
        }
      }

      for (const [, bucket] of dayBucketMap.entries()) {
        sevenDaySales.push(Math.round(bucket.sales));
        sevenDayOrders.push(bucket.orders);
      }

      recentOrders = rawOrders.slice(0, 10).map((r) => {
        let parsedItems: any[] = [];
        if (Array.isArray(r.items)) {
          parsedItems = r.items;
        } else if (typeof r.items === 'string') {
          try { parsedItems = JSON.parse(r.items); } catch { parsedItems = []; }
        }
        const itemsSummary = Array.isArray(parsedItems) && parsedItems.length > 0
          ? parsedItems.map((it: any) => `${it.name || it.product_name || 'Item'} × ${it.quantity || it.qty || 1}`).join(', ')
          : 'Catalog Order';

        const orderIdStr = String(r.order_id || `ORD-${r.id}`);
        const payMode = String(r.payment_mode || 'COD').toUpperCase();
        const isWhatsAppSource =
          orderIdStr.toUpperCase().startsWith('WA') ||
          payMode.includes('WHATSAPP') ||
          (Boolean(r.jid) && !orderIdStr.toUpperCase().startsWith('WEB'));

        return {
          id: r.id,
          order_id: orderIdStr,
          customer_name: r.customer_name || 'Walk-in / WhatsApp Customer',
          customer_phone: r.customer_phone || r.delivery_phone || '',
          delivery_address: r.delivery_address || '',
          items: Array.isArray(parsedItems) ? parsedItems : [],
          items_summary: itemsSummary,
          amount: Number(r.total_amount || 0),
          total_amount: Number(r.total_amount || 0),
          source: isWhatsAppSource ? 'WhatsApp' : 'Web',
          payment_method: payMode.includes('UPI') || payMode.includes('ONLINE') ? 'UPI QR' : 'COD',
          payment_mode: r.payment_mode || 'COD',
          payment_status: String(r.payment_status || 'PENDING').toUpperCase() === 'PAID' ? 'Paid' : 'Pending',
          order_status: formatOrderStatusLabel(r.order_status),
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        };
      });
    } catch (e: any) {
      console.warn('Dashboard orders query notice:', e.message);
    }
  }

  if (sevenDaySales.length === 0) {
    for (let i = 0; i < 7; i++) {
      sevenDaySales.push(0);
      sevenDayOrders.push(0);
    }
  }

  let salesGrowthPct = 0;
  if (grossSalesYesterday > 0) {
    salesGrowthPct = Number((((grossSalesToday - grossSalesYesterday) / grossSalesYesterday) * 100).toFixed(1));
  } else if (grossSalesToday > 0) {
    salesGrowthPct = 100;
  }

  return res.json({
    status: 'success',
    username,
    store_profile: {
      store_name: storeName,
      store_slug: storeSlug,
      delivery_radius_km: deliveryRadiusKm,
      free_delivery_threshold: freeDeliveryThreshold,
      wa_connected: waConnected,
      wa_jid: waJid,
      operating_hours: operatingHours
    },
    kpis: {
      gross_sales_today: Math.round(grossSalesToday),
      gross_sales_yesterday: Math.round(grossSalesYesterday),
      sales_growth_pct: salesGrowthPct,
      total_orders_today: totalOrdersToday,
      web_orders_today: webOrdersToday,
      whatsapp_orders_today: whatsappOrdersToday,
      upi_collected_amount: Math.round(upiCollectedAmount),
      cod_pending_amount: Math.round(codPendingAmount),
      leads_captured_today: leadsCapturedToday || leadsCapturedTotal,
      messages_auto_replied_today: messagesAutoRepliedToday || stats.totalAiReplies || 0
    },
    charts: {
      seven_day_labels: sevenDayLabels,
      seven_day_sales: sevenDaySales,
      seven_day_orders: sevenDayOrders,
      source_split: {
        web_orders: webOrdersCount7d,
        whatsapp_orders: whatsappOrdersCount7d,
        web_revenue: Math.round(webRevenue7d),
        whatsapp_revenue: Math.round(whatsappRevenue7d)
      }
    },
    recent_orders: recentOrders,
    low_stock_items: lowStockItems,
    // Legacy compatibility fields
    active_campaigns: activeCampaignsCount,
    total_chats: totalChats,
    total_products: totalProducts,
    total_leads: leadsCapturedTotal,
    leads_captured: leadsCapturedTotal,
    delivered_messages: stats.totalMessagesSent,
    ai_replies: messagesAutoRepliedToday || stats.totalAiReplies,
    wa_connected: waConnected,
    wa_jid: waJid
  });
});

function normalizeOrderStatusCode(rawStatus: any): string {
  const s = String(rawStatus || 'CONFIRMED').toUpperCase().trim();
  if (s === 'DISPATCHED' || s === 'SHIPPED') return 'DISPATCHED';
  if (s === 'OUT_FOR_DELIVERY' || s === 'OUT FOR DELIVERY' || s === 'ON_THE_WAY' || s === 'ON THE WAY') return 'OUT_FOR_DELIVERY';
  if (s === 'DELIVERED' || s === 'COMPLETED') return 'DELIVERED';
  if (s === 'PROCESSING' || s === 'PREPARING' || s === 'PACKING') return 'PROCESSING';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  if (s === 'NEW' || s === 'CONFIRMED' || s === 'ORDER_CONFIRMED' || s === 'IN_PROGRESS') return 'CONFIRMED';
  return s || 'CONFIRMED';
}

function formatOrderStatusLabel(rawStatus: any): string {
  const s = String(rawStatus || 'NEW').toUpperCase().trim();
  if (s === 'DELIVERED' || s === 'COMPLETED') return 'Delivered';
  if (s === 'OUT_FOR_DELIVERY' || s === 'OUT FOR DELIVERY' || s === 'ON_THE_WAY' || s === 'ON THE WAY') return 'Out for Delivery';
  if (s === 'DISPATCHED' || s === 'SHIPPED') return 'Dispatched';
  if (s === 'PROCESSING' || s === 'PREPARING' || s === 'PACKING') return 'Processing';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'Cancelled';
  return 'New';
}

app.post('/api/business/orders/status', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const username = resolveBusinessUsername(req, body?.username);
  const orderId = String(body?.order_id || body?.orderId || '').trim();
  const rawStatusInput = String(body?.order_status || body?.status || 'DISPATCHED').trim();
  const newStatus = normalizeOrderStatusCode(rawStatusInput);
  let paymentStatus = body?.payment_status ? String(body.payment_status).toUpperCase().trim() : '';
  if (newStatus === 'DELIVERED' && !paymentStatus) {
    paymentStatus = 'PAID';
  }

  if (!orderId) {
    return res.status(400).json({ status: 'error', message: 'order_id is required' });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(500).json({ status: 'error', message: 'Database connection not available' });
  }

  try {
    if (paymentStatus) {
      await pool.query(
        `UPDATE orders
         SET order_status = $1, payment_status = $2, updated_at = NOW()
         WHERE LOWER(order_id) = LOWER($3) AND (LOWER(tenant_id) = LOWER($4) OR $4 = 'admin')`,
        [newStatus, paymentStatus, orderId, username]
      );
      await pool.query(
        `UPDATE customer_order_states
         SET order_status = $1, payment_status = $2, updated_at = NOW()
         WHERE LOWER(order_id) = LOWER($3) AND (LOWER(username) = LOWER($4) OR LOWER(tenant_id) = LOWER($4) OR $4 = 'admin')`,
        [newStatus, paymentStatus, orderId, username]
      );
    } else {
      await pool.query(
        `UPDATE orders
         SET order_status = $1, updated_at = NOW()
         WHERE LOWER(order_id) = LOWER($2) AND (LOWER(tenant_id) = LOWER($3) OR $3 = 'admin')`,
        [newStatus, orderId, username]
      );
      await pool.query(
        `UPDATE customer_order_states
         SET order_status = $1, updated_at = NOW()
         WHERE LOWER(order_id) = LOWER($2) AND (LOWER(username) = LOWER($3) OR LOWER(tenant_id) = LOWER($3) OR $3 = 'admin')`,
        [newStatus, orderId, username]
      );
    }

    // Lookup order customer details & dispatch automated WhatsApp notification
    let waNotified = false;
    let waMessageText = '';
    try {
      let ordRow: any = null;
      const oLookup = await pool.query(
        `SELECT COALESCE(tenant_id, $2) as tenant_id, COALESCE(customer_phone, '') as customer_phone,
                COALESCE(delivery_phone, '') as delivery_phone, COALESCE(jid, '') as jid,
                COALESCE(customer_name, 'Customer') as customer_name, COALESCE(total_amount, 0) as total_amount,
                COALESCE(payment_mode, 'COD') as payment_mode
         FROM orders WHERE LOWER(order_id) = LOWER($1) LIMIT 1`,
        [orderId, username]
      );
      if (oLookup.rows.length > 0) {
        ordRow = oLookup.rows[0];
      } else {
        const sLookup = await pool.query(
          `SELECT COALESCE(NULLIF(tenant_id, ''), username, $2) as tenant_id, COALESCE(customer_phone, '') as customer_phone,
                  COALESCE(delivery_phone, '') as delivery_phone, COALESCE(jid, '') as jid,
                  COALESCE(customer_name, 'Customer') as customer_name, COALESCE(total_amount, 0) as total_amount,
                  COALESCE(payment_mode, 'COD') as payment_mode
           FROM customer_order_states WHERE LOWER(order_id) = LOWER($1) LIMIT 1`,
          [orderId, username]
        );
        if (sLookup.rows.length > 0) {
          ordRow = sLookup.rows[0];
        }
      }

      if (ordRow) {
        const ordTenant = String(ordRow.tenant_id || username || 'admin').toLowerCase().trim();
        const rawPhone = ordRow.customer_phone || ordRow.delivery_phone || String(ordRow.jid || '').split('@')[0];
        const cleanPhone = String(rawPhone || '').replace(/\D/g, '');
        const custName = ordRow.customer_name || 'Customer';
        const totalAmt = Number(ordRow.total_amount || 0).toFixed(2);
        const payMode = String(ordRow.payment_mode || 'COD').toUpperCase();

        let storeName = ordTenant;
        const uRes = await pool.query(
          `SELECT COALESCE(NULLIF(business_name, ''), NULLIF(account_name, ''), username) as store_name
           FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(store_slug) = LOWER($1) LIMIT 1`,
          [ordTenant]
        );
        if (uRes.rows.length > 0 && uRes.rows[0].store_name) {
          storeName = uRes.rows[0].store_name;
        }

        if (newStatus === 'DISPATCHED') {
          waMessageText = `📦 *Your order has been dispatched!*\n\nHello *${custName}*,\nYour order *#${orderId}* from *${storeName}* (₹${totalAmt}) has been packed and dispatched! We will notify you as soon as our delivery partner is out for delivery. 🚀`;
        } else if (newStatus === 'OUT_FOR_DELIVERY') {
          waMessageText = `🛵 *Your order is out for delivery!*\n\nHello *${custName}*,\nYour order *#${orderId}* from *${storeName}* (₹${totalAmt} • ${payMode}) is on the way to your address! Please keep your phone reachable. 📍`;
        } else if (newStatus === 'DELIVERED') {
          waMessageText = `✅ *Your order is delivered!*\n\nHello *${custName}*,\nYour order *#${orderId}* (₹${totalAmt}) from *${storeName}* has been successfully delivered. Thank you for shopping with us! 🙏✨`;
        } else if (newStatus === 'PROCESSING') {
          waMessageText = `👨‍🍳 *Your order #${orderId} is being prepared!*\n\nHello *${custName}*, *${storeName}* is currently packing your items (₹${totalAmt}). You will receive an update once it is dispatched!`;
        }

        if (waMessageText && cleanPhone) {
          pushToLiveChat(ordTenant, cleanPhone, waMessageText, 'outgoing_manual');
          await recordCustomerChat(ordTenant, cleanPhone, 'assistant', waMessageText);
          stats.totalMessagesSent++;
          waNotified = true;
        }
      }
    } catch (waErr: any) {
      console.warn('Order status WhatsApp notification warning:', waErr.message);
    }

    const statusLabel = formatOrderStatusLabel(newStatus);
    return res.json({
      status: 'success',
      order_id: orderId,
      order_status: statusLabel,
      raw_order_status: newStatus,
      payment_status: paymentStatus || undefined,
      whatsapp_notified: waNotified,
      whatsapp_message: waMessageText || undefined,
      message: waNotified
        ? `Order ${orderId} marked "${statusLabel}" & WhatsApp alert sent to customer!`
        : `Order ${orderId} updated to "${statusLabel}"`
    });
  } catch (e: any) {
    console.warn('Order status update error:', e.message);
    return res.status(500).json({ status: 'error', message: 'Failed to update order status: ' + e.message });
  }
});

// 12E. RECENT CAPTURED LEADS (REAL DB & MEMORY DATA - ZERO DUMMY DATA)
app.get('/api/leads', async (req: Request, res: Response) => {
  const username = (req.query.username as string) || '';
  let leads: Array<{ id: string | number; customer_phone: string; inquiry_text: string; status: string; time: string }> = [];

  if (getPool()) {
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
  const username = (req.query.username as string) || '';
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

// 12G. USER PROFILE & STORE MANAGEMENT DETAILS (REAL DATA ONLY - ZERO FAKE DATA)
app.get(['/api/user/profile', '/api/admin/profile'], async (req: Request, res: Response) => {
  const username = ((req.query.username as string) || 'admin').trim();
  const cleanUser = username.toLowerCase();
  const user = memoryUsers.get(cleanUser);

  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1 LIMIT 1', [cleanUser]);
      if (r.rows.length > 0) {
        const row = r.rows[0];
        let parsedBanners: any[] = [];
        try {
          if (row.promotional_banners) {
            parsedBanners = typeof row.promotional_banners === 'string'
              ? JSON.parse(row.promotional_banners)
              : row.promotional_banners;
          }
        } catch {
          parsedBanners = [];
        }
        if (!Array.isArray(parsedBanners) || parsedBanners.length === 0) {
          if (row.banner_url) {
            parsedBanners = [{ image_url: row.banner_url, target_link: '' }];
          } else {
            parsedBanners = [];
          }
        }

        let parsedModes: string[] = ['doorstep', 'pickup'];
        try {
          if (row.delivery_modes) {
            const m = typeof row.delivery_modes === 'string'
              ? JSON.parse(row.delivery_modes)
              : row.delivery_modes;
            if (Array.isArray(m)) parsedModes = m;
          }
        } catch {}

        return res.json({
          status: 'success',
          username: row.username,
          account_name: row.account_name || `${row.username} Workspace`,
          business_name: row.business_name || row.account_name || row.username,
          business_type: row.business_type || 'Kirana / General Store',
          email: row.email || '',
          phone: row.phone || '',
          notification_phone: row.notification_phone || '',
          wa_jid: row.wa_jid || '',
          wa_status: row.status || 'Disconnected',
          auto_reply: row.auto_reply !== false,
          automation_access: row.automation_access !== false,
          role: row.role || 'user',
          user_type: row.user_type || 'business_user',
          ai_provider: row.ai_provider || 'gemini',
          ai_model: row.ai_model || 'gemini-1.5-flash',
          full_address: row.full_address || '',
          local_area: row.local_area || '',
          latitude: row.latitude ? parseFloat(row.latitude) : 0,
          longitude: row.longitude ? parseFloat(row.longitude) : 0,
          max_delivery_radius_km: row.max_delivery_radius_km !== undefined && row.max_delivery_radius_km !== null ? Number(row.max_delivery_radius_km) : 15.0,
          free_delivery_radius_km: row.free_delivery_radius_km !== undefined && row.free_delivery_radius_km !== null ? Number(row.free_delivery_radius_km) : 3.0,
          delivery_charge_amount: row.delivery_charge_amount !== undefined && row.delivery_charge_amount !== null ? Number(row.delivery_charge_amount) : 40.0,
          min_free_delivery_order: row.min_free_delivery_order !== undefined && row.min_free_delivery_order !== null ? Number(row.min_free_delivery_order) : 499.0,
          require_customer_location: Boolean(row.require_customer_location),
          store_open_status: row.store_open_status !== false,
          operating_hours: row.operating_hours || '9:00 AM - 10:00 PM',
          delivery_modes: parsedModes,
          store_slug: row.store_slug || row.username,
          logo_url: row.logo_url || '',
          banner_url: row.banner_url || '',
          promotional_banners: parsedBanners,
          tagline: row.tagline || '',
          theme_color: row.theme_color || 'emerald',
          announcement_bar: row.announcement_bar || '',
          min_order_amount: row.min_order_amount !== undefined && row.min_order_amount !== null ? Number(row.min_order_amount) : 0.0,
          packaging_charge: row.packaging_charge !== undefined && row.packaging_charge !== null ? Number(row.packaging_charge) : 0.0,
          allow_cod: row.allow_cod !== false,
          paytm_vpa: row.paytm_vpa || '',
          paytm_mid: row.paytm_mid || '',
          social_instagram: row.social_instagram || '',
          social_facebook: row.social_facebook || '',
          social_whatsapp: row.social_whatsapp || '',
          gstin_number: row.gstin_number || '',
          privacy_policy: row.privacy_policy || '',
          terms_conditions: row.terms_conditions || '',
          refund_policy: row.refund_policy || '',
          shipping_policy: row.shipping_policy || '',
          custom_domain: row.custom_domain || '',
          domain_status: row.domain_status || 'not_configured',
          created_at: row.created_at ? new Date(row.created_at).toLocaleString() : 'Active'
        });
      }
    } catch (e) {
      console.warn('Error querying user profile:', e);
    }
  }

  if (!user) {
    return res.status(404).json({ error: 'User account not found' });
  }

  const memAny = user as any;
  return res.json({
    status: 'success',
    username: user.username,
    account_name: user.account_name || `${user.username} Workspace`,
    business_name: user.business_name || user.account_name || user.username,
    business_type: user.business_type || 'Kirana / General Store',
    email: user.email || '',
    phone: user.phone || '',
    notification_phone: user.notification_phone || '',
    wa_jid: user.wa_jid || '',
    wa_status: user.status || 'Disconnected',
    role: user.role || 'user',
    user_type: user.user_type || 'business_user',
    ai_provider: user.ai_provider || 'gemini',
    ai_model: user.model || 'gemini-1.5-flash',
    full_address: memAny.full_address || '',
    local_area: memAny.local_area || '',
    latitude: memAny.latitude || 0,
    longitude: memAny.longitude || 0,
    max_delivery_radius_km: memAny.max_delivery_radius_km ?? 15.0,
    free_delivery_radius_km: memAny.free_delivery_radius_km ?? 3.0,
    delivery_charge_amount: memAny.delivery_charge_amount ?? 40.0,
    min_free_delivery_order: memAny.min_free_delivery_order ?? 499.0,
    require_customer_location: Boolean(memAny.require_customer_location),
    store_open_status: memAny.store_open_status !== false,
    operating_hours: memAny.operating_hours || '9:00 AM - 10:00 PM',
    delivery_modes: memAny.delivery_modes || ['doorstep', 'pickup'],
    store_slug: memAny.store_slug || user.username,
    logo_url: memAny.logo_url || '',
    banner_url: memAny.banner_url || '',
    promotional_banners: memAny.promotional_banners || [],
    tagline: memAny.tagline || '',
    theme_color: memAny.theme_color || 'emerald',
    announcement_bar: memAny.announcement_bar || '',
    min_order_amount: memAny.min_order_amount ?? 0.0,
    packaging_charge: memAny.packaging_charge ?? 0.0,
    allow_cod: memAny.allow_cod !== false,
    paytm_vpa: memAny.paytm_vpa || '',
    paytm_mid: memAny.paytm_mid || '',
    social_instagram: memAny.social_instagram || '',
    social_facebook: memAny.social_facebook || '',
    social_whatsapp: memAny.social_whatsapp || '',
    gstin_number: memAny.gstin_number || '',
    privacy_policy: memAny.privacy_policy || '',
    terms_conditions: memAny.terms_conditions || '',
    refund_policy: memAny.refund_policy || '',
    shipping_policy: memAny.shipping_policy || '',
    custom_domain: memAny.custom_domain || '',
    domain_status: memAny.domain_status || 'not_configured',
    created_at: user.created_at ? new Date(user.created_at).toLocaleString() : 'Active'
  });
});

// POST / PUT /api/user/profile to save store branding, address, GPS, delivery logistics, checkout & custom domain
app.all(['/api/user/profile', '/api/admin/profile'], async (req: Request, res: Response, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const b = body || {};
  const username = String(b.username || 'admin').trim();
  if (!username) {
    return res.status(400).json({ status: 'error', message: 'Username is required' });
  }

  const cleanUser = username.toLowerCase();
  let cleanSlug = String(b.store_slug || '').toLowerCase().trim();
  cleanSlug = cleanSlug.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

  const latVal = b.latitude !== undefined ? (parseFloat(b.latitude) || 0) : undefined;
  const lngVal = b.longitude !== undefined ? (parseFloat(b.longitude) || 0) : undefined;
  const maxRadVal = b.max_delivery_radius_km !== undefined ? (parseFloat(b.max_delivery_radius_km) || 15.0) : undefined;
  const freeRadVal = b.free_delivery_radius_km !== undefined ? (parseFloat(b.free_delivery_radius_km) >= 0 ? parseFloat(b.free_delivery_radius_km) : 3.0) : undefined;
  const delChargeVal = b.delivery_charge_amount !== undefined ? (parseFloat(b.delivery_charge_amount) >= 0 ? parseFloat(b.delivery_charge_amount) : 40.0) : undefined;
  const minFreeOrderVal = b.min_free_delivery_order !== undefined ? (parseFloat(b.min_free_delivery_order) >= 0 ? parseFloat(b.min_free_delivery_order) : 0.0) : undefined;
  const minOrderVal = b.min_order_amount !== undefined ? (parseFloat(b.min_order_amount) >= 0 ? parseFloat(b.min_order_amount) : 0.0) : undefined;
  const pkgChargeVal = b.packaging_charge !== undefined ? (parseFloat(b.packaging_charge) >= 0 ? parseFloat(b.packaging_charge) : 0.0) : undefined;

  const pool = getPool();
  if (pool) {
    try {
      const sets: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      const addField = (col: string, val: any, cast = '') => {
        sets.push(`${col} = $${idx}${cast}`);
        vals.push(val);
        idx++;
      };

      if (b.account_name !== undefined && String(b.account_name).trim() !== '') {
        addField('account_name', String(b.account_name).trim());
      }
      if (b.email !== undefined && String(b.email).trim() !== '') {
        addField('email', String(b.email).trim());
      }
      if (b.phone !== undefined) {
        addField('phone', String(b.phone).trim().replace(/^\+/, ''));
      }
      if (b.business_name !== undefined && String(b.business_name).trim() !== '') {
        addField('business_name', String(b.business_name).trim());
      }
      if (b.business_type !== undefined && String(b.business_type).trim() !== '') {
        addField('business_type', String(b.business_type).trim());
      }
      if (b.notification_phone !== undefined && String(b.notification_phone).trim() !== '') {
        addField('notification_phone', String(b.notification_phone).trim());
      }
      if (b.ai_provider !== undefined && String(b.ai_provider).trim() !== '') {
        addField('ai_provider', String(b.ai_provider).trim());
      }
      if (b.ai_model !== undefined && String(b.ai_model).trim() !== '') {
        addField('ai_model', String(b.ai_model).trim());
      }
      if (cleanSlug !== '') {
        addField('store_slug', cleanSlug);
      }
      if (b.tagline !== undefined) {
        addField('tagline', String(b.tagline).trim());
      }
      if (b.theme_color !== undefined && String(b.theme_color).trim() !== '') {
        addField('theme_color', String(b.theme_color).trim());
      }
      if (b.announcement_bar !== undefined) {
        addField('announcement_bar', String(b.announcement_bar).trim());
      }
      if (minOrderVal !== undefined) {
        addField('min_order_amount', minOrderVal);
      }
      if (pkgChargeVal !== undefined) {
        addField('packaging_charge', pkgChargeVal);
      }
      if (b.allow_cod !== undefined) {
        addField('allow_cod', Boolean(b.allow_cod));
      }
      if (b.paytm_vpa !== undefined) {
        addField('paytm_vpa', String(b.paytm_vpa).trim());
      }
      if (b.paytm_mid !== undefined) {
        addField('paytm_mid', String(b.paytm_mid).trim());
      }
      if (b.logo_url !== undefined) {
        addField('logo_url', String(b.logo_url).trim());
      }
      if (b.banner_url !== undefined) {
        addField('banner_url', String(b.banner_url).trim());
      }
      if (b.promotional_banners !== undefined && Array.isArray(b.promotional_banners)) {
        const bannersJson = JSON.stringify(b.promotional_banners);
        addField('promotional_banners', bannersJson, '::jsonb');
        if (b.promotional_banners.length > 0 && b.promotional_banners[0]?.image_url && b.banner_url === undefined) {
          addField('banner_url', String(b.promotional_banners[0].image_url).trim());
        }
        try {
          await pool.query(
            `INSERT INTO business_profiles (username, tenant_slug, promotional_banners)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (username) DO UPDATE SET promotional_banners = EXCLUDED.promotional_banners, tenant_slug = CASE WHEN EXCLUDED.tenant_slug != '' THEN EXCLUDED.tenant_slug ELSE business_profiles.tenant_slug END`,
            [cleanUser, cleanSlug || cleanUser, bannersJson]
          );
        } catch {}
      }
      if (b.social_instagram !== undefined) {
        addField('social_instagram', String(b.social_instagram).trim());
      }
      if (b.social_facebook !== undefined) {
        addField('social_facebook', String(b.social_facebook).trim());
      }
      if (b.social_whatsapp !== undefined) {
        addField('social_whatsapp', String(b.social_whatsapp).trim());
      }
      if (b.full_address !== undefined) {
        addField('full_address', String(b.full_address).trim());
      }
      if (b.local_area !== undefined) {
        addField('local_area', String(b.local_area).trim());
      }
      if (latVal !== undefined && latVal !== 0) {
        addField('latitude', latVal);
        addField('business_lat', latVal);
      }
      if (lngVal !== undefined && lngVal !== 0) {
        addField('longitude', lngVal);
        addField('business_lng', lngVal);
      }
      if (b.gstin_number !== undefined) {
        addField('gstin_number', String(b.gstin_number).trim().toUpperCase());
      }
      if (b.privacy_policy !== undefined) {
        addField('privacy_policy', String(b.privacy_policy).trim());
      }
      if (b.terms_conditions !== undefined) {
        addField('terms_conditions', String(b.terms_conditions).trim());
      }
      if (b.refund_policy !== undefined) {
        addField('refund_policy', String(b.refund_policy).trim());
      }
      if (b.shipping_policy !== undefined) {
        addField('shipping_policy', String(b.shipping_policy).trim());
      }
      if (maxRadVal !== undefined && maxRadVal > 0) {
        addField('max_delivery_radius_km', maxRadVal);
      }
      if (freeRadVal !== undefined && freeRadVal >= 0) {
        addField('free_delivery_radius_km', freeRadVal);
      }
      if (delChargeVal !== undefined && delChargeVal >= 0) {
        addField('delivery_charge_amount', delChargeVal);
      }
      if (minFreeOrderVal !== undefined && minFreeOrderVal >= 0) {
        addField('min_free_delivery_order', minFreeOrderVal);
      }
      if (b.require_customer_location !== undefined) {
        addField('require_customer_location', Boolean(b.require_customer_location));
      }
      if (b.store_open_status !== undefined) {
        addField('store_open_status', Boolean(b.store_open_status));
      }
      if (b.operating_hours !== undefined) {
        addField('operating_hours', String(b.operating_hours).trim());
      }
      if (b.delivery_modes !== undefined && Array.isArray(b.delivery_modes)) {
        addField('delivery_modes', JSON.stringify(b.delivery_modes), '::jsonb');
      }
      if (b.custom_domain !== undefined) {
        const cleanDomain = String(b.custom_domain).toLowerCase().trim()
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, '');
        addField('custom_domain', cleanDomain);
        const domStatus = b.domain_status || (cleanDomain ? 'pending_dns' : 'not_configured');
        addField('domain_status', domStatus);
      } else if (b.domain_status !== undefined) {
        addField('domain_status', String(b.domain_status).trim());
      }

      if (sets.length > 0) {
        vals.push(cleanUser);
        await pool.query(
          `UPDATE users SET ${sets.join(', ')} WHERE LOWER(username) = LOWER($${idx})`,
          vals
        );
      }
    } catch (err: any) {
      console.warn('Error saving user profile in DB:', err.message);
    }
  }

  // Update memoryUsers fallback
  const mem = memoryUsers.get(cleanUser) as any;
  if (mem) {
    if (b.business_name !== undefined && b.business_name !== '') mem.business_name = b.business_name;
    if (b.business_type !== undefined && b.business_type !== '') mem.business_type = b.business_type;
    if (b.notification_phone !== undefined && b.notification_phone !== '') mem.notification_phone = b.notification_phone;
    if (b.full_address !== undefined) mem.full_address = b.full_address;
    if (b.local_area !== undefined) mem.local_area = b.local_area;
    if (latVal) mem.latitude = latVal;
    if (lngVal) mem.longitude = lngVal;
    if (maxRadVal !== undefined) mem.max_delivery_radius_km = maxRadVal;
    if (freeRadVal !== undefined) mem.free_delivery_radius_km = freeRadVal;
    if (delChargeVal !== undefined) mem.delivery_charge_amount = delChargeVal;
    if (minFreeOrderVal !== undefined) mem.min_free_delivery_order = minFreeOrderVal;
    if (b.require_customer_location !== undefined) mem.require_customer_location = Boolean(b.require_customer_location);
    if (b.store_open_status !== undefined) mem.store_open_status = Boolean(b.store_open_status);
    if (b.operating_hours !== undefined) mem.operating_hours = b.operating_hours;
    if (b.delivery_modes !== undefined) mem.delivery_modes = b.delivery_modes;
    if (cleanSlug) mem.store_slug = cleanSlug;
    if (b.logo_url !== undefined) mem.logo_url = b.logo_url;
    if (b.banner_url !== undefined) mem.banner_url = b.banner_url;
    if (b.promotional_banners !== undefined) mem.promotional_banners = b.promotional_banners;
    if (b.tagline !== undefined) mem.tagline = b.tagline;
    if (b.theme_color !== undefined) mem.theme_color = b.theme_color;
    if (b.announcement_bar !== undefined) mem.announcement_bar = b.announcement_bar;
    if (minOrderVal !== undefined) mem.min_order_amount = minOrderVal;
    if (pkgChargeVal !== undefined) mem.packaging_charge = pkgChargeVal;
    if (b.allow_cod !== undefined) mem.allow_cod = Boolean(b.allow_cod);
    if (b.paytm_vpa !== undefined) mem.paytm_vpa = b.paytm_vpa;
    if (b.paytm_mid !== undefined) mem.paytm_mid = b.paytm_mid;
    if (b.social_instagram !== undefined) mem.social_instagram = b.social_instagram;
    if (b.social_facebook !== undefined) mem.social_facebook = b.social_facebook;
    if (b.social_whatsapp !== undefined) mem.social_whatsapp = b.social_whatsapp;
    if (b.gstin_number !== undefined) mem.gstin_number = b.gstin_number;
    if (b.privacy_policy !== undefined) mem.privacy_policy = b.privacy_policy;
    if (b.terms_conditions !== undefined) mem.terms_conditions = b.terms_conditions;
    if (b.refund_policy !== undefined) mem.refund_policy = b.refund_policy;
    if (b.shipping_policy !== undefined) mem.shipping_policy = b.shipping_policy;
    if (b.custom_domain !== undefined) mem.custom_domain = b.custom_domain;
    if (b.domain_status !== undefined) mem.domain_status = b.domain_status;
  }

  return res.json({
    status: 'success',
    message: 'Store management settings saved & synced to cloud DB!',
    store_slug: cleanSlug || cleanUser,
    full_address: b.full_address,
    local_area: b.local_area,
    latitude: latVal,
    longitude: lngVal,
    max_delivery_radius_km: maxRadVal,
    free_delivery_radius_km: freeRadVal,
    delivery_charge_amount: delChargeVal,
    min_free_delivery_order: minFreeOrderVal,
    require_customer_location: b.require_customer_location,
    store_open_status: b.store_open_status,
    custom_domain: b.custom_domain
  });
});

// MEDIA IMAGE CLEAR HANDLER: DELETE or POST /api/media/image
app.all('/api/media/image', async (req: Request, res: Response) => {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const type = String(body?.type || req.query.type || '').toLowerCase();
  const id = parseInt(String(body?.id || '0'), 10) || 0;
  const username = String(body?.username || req.query.username || 'admin').toLowerCase().trim();
  const index = typeof body?.index === 'number' ? body.index : parseInt(String(body?.index || '0'), 10) || 0;

  const pool = getPool();
  if (pool) {
    try {
      if (type === 'product' && id > 0) {
        await pool.query(
          `UPDATE products SET image_url = '', product_image_url = '' WHERE id = $1 AND LOWER(username) = LOWER($2)`,
          [id, username]
        );
      } else if (type === 'logo') {
        await pool.query(`UPDATE users SET logo_url = '' WHERE LOWER(username) = LOWER($1)`, [username]);
      } else if (type === 'banner') {
        const r = await pool.query(`SELECT COALESCE(promotional_banners::text, '[]') as pb FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
        let bList: any[] = [];
        try { bList = JSON.parse(r.rows[0]?.pb || '[]'); } catch {}
        if (Array.isArray(bList) && index >= 0 && index < bList.length) {
          bList.splice(index, 1);
          const updatedJson = JSON.stringify(bList);
          await pool.query(`UPDATE users SET promotional_banners = $1::jsonb, banner_url = $2 WHERE LOWER(username) = LOWER($3)`, [
            updatedJson,
            bList[0]?.image_url || '',
            username
          ]);
          try {
            await pool.query(`UPDATE business_profiles SET promotional_banners = $1::jsonb WHERE LOWER(username) = LOWER($2)`, [
              updatedJson,
              username
            ]);
          } catch {}
        } else {
          await pool.query(`UPDATE users SET banner_url = '' WHERE LOWER(username) = LOWER($1)`, [username]);
        }
      }
    } catch (e: any) {
      console.warn('Media clear DB error:', e.message);
    }
  }

  return res.json({ status: 'success', message: 'Image reference cleared from database' });
});

// GET /api/storefront/:slug or /api/storefront?slug=... (100% Dynamic Tenant Storefront API)
app.get(['/api/storefront', '/api/storefront/:slug'], async (req: Request, res: Response) => {
  const slugParam = (req.params.slug || req.query.slug || req.query.username || '') as string;
  const cleanSlug = slugParam.trim().toLowerCase();

  let tenantRow: any = null;
  const pool = getPool();

  if (pool) {
    try {
      if (cleanSlug && cleanSlug !== 'default' && cleanSlug !== 'store') {
        const uRes = await pool.query(
          `SELECT *, COALESCE(business_name, account_name, username) as store_name,
                  (SELECT COUNT(*)::int FROM products p WHERE LOWER(p.username) = LOWER(users.username)) as total_products
           FROM users
           WHERE LOWER(store_slug) = $1 OR LOWER(username) = $1 OR LOWER(custom_domain) = $1
           LIMIT 1`,
          [cleanSlug]
        );
        if (uRes.rows.length > 0) {
          const candidate = uRes.rows[0];
          // If 'admin' was passed as default slug and has 0 products, fall back to the active merchant store with products
          if (cleanSlug !== 'admin' || Number(candidate.total_products || 0) > 0) {
            tenantRow = candidate;
          }
        }
      }
      // Graceful fallback when visiting /storefront.html without slug or with default 'admin' slug
      if (!tenantRow && (!cleanSlug || cleanSlug === 'admin' || cleanSlug === 'default' || cleanSlug === 'store')) {
        const uRes = await pool.query(
          `SELECT *, COALESCE(business_name, account_name, username) as store_name
           FROM users
           ORDER BY
             (SELECT COUNT(*)::int FROM products p WHERE LOWER(p.username) = LOWER(users.username)) DESC,
             CASE WHEN (logo_url != '' OR banner_url != '' OR business_name != '' OR wa_jid != '') THEN 0 ELSE 1 END,
             id DESC
           LIMIT 1`
        );
        if (uRes.rows.length > 0) {
          tenantRow = uRes.rows[0];
        }
      }
    } catch (e: any) {
      console.warn('Storefront query notice:', e.message);
    }
  }

  if (!tenantRow) {
    const mem = Array.from(memoryUsers.values()).find(
      u => ((u as any).store_slug && (u as any).store_slug.toLowerCase() === cleanSlug) || u.username.toLowerCase() === cleanSlug
    ) as any;
    if (mem) {
      tenantRow = {
        ...mem,
        store_name: mem.business_name || mem.account_name || mem.username
      };
    }
  }

  if (!tenantRow) {
    return res.status(404).json({ status: 'error', message: `Store not found for slug: ${slugParam}` });
  }

  const tenantUsername = tenantRow.username;

  // Format clean WhatsApp phone
  let contactPhone = tenantRow.social_whatsapp || tenantRow.notification_phone || tenantRow.phone || '';
  if (!contactPhone && tenantRow.wa_jid) {
    contactPhone = tenantRow.wa_jid.split('@')[0].split(':')[0];
  }
  const cleanPhoneDigits = String(contactPhone).replace(/\D/g, '');

  let parsedBanners: any[] = [];
  try {
    if (tenantRow.promotional_banners) {
      parsedBanners = typeof tenantRow.promotional_banners === 'string'
        ? JSON.parse(tenantRow.promotional_banners)
        : tenantRow.promotional_banners;
    }
  } catch {
    parsedBanners = [];
  }
  if (!Array.isArray(parsedBanners) || parsedBanners.length === 0) {
    if (tenantRow.banner_url) {
      parsedBanners = [{ image_url: tenantRow.banner_url, target_link: '' }];
    } else {
      parsedBanners = [];
    }
  }

  let parsedModes: string[] = ['doorstep', 'pickup'];
  try {
    if (tenantRow.delivery_modes) {
      const m = typeof tenantRow.delivery_modes === 'string'
        ? JSON.parse(tenantRow.delivery_modes)
        : tenantRow.delivery_modes;
      if (Array.isArray(m)) parsedModes = m;
    }
  } catch {}

  const tenant = {
    username: tenantRow.username,
    store_name: tenantRow.store_name || tenantRow.business_name || tenantRow.username,
    business_type: tenantRow.business_type || 'Kirana / General Store',
    store_slug: tenantRow.store_slug || tenantRow.username,
    tagline: tenantRow.tagline || '',
    theme_color: tenantRow.theme_color || 'emerald',
    announcement_bar: tenantRow.announcement_bar || '',
    logo_url: tenantRow.logo_url || '',
    banner_url: tenantRow.banner_url || '',
    promotional_banners: parsedBanners,
    whatsapp_number: cleanPhoneDigits,
    social_instagram: tenantRow.social_instagram || '',
    social_facebook: tenantRow.social_facebook || '',
    social_whatsapp: tenantRow.social_whatsapp || cleanPhoneDigits,
    full_address: tenantRow.full_address || '',
    local_area: tenantRow.local_area || '',
    latitude: Number(tenantRow.latitude || 0),
    longitude: Number(tenantRow.longitude || 0),
    gstin_number: tenantRow.gstin_number || '',
    privacy_policy: tenantRow.privacy_policy || '',
    terms_conditions: tenantRow.terms_conditions || '',
    refund_policy: tenantRow.refund_policy || '',
    shipping_policy: tenantRow.shipping_policy || '',
    max_delivery_radius_km: Number(tenantRow.max_delivery_radius_km ?? 15),
    free_delivery_radius_km: Number(tenantRow.free_delivery_radius_km ?? 3),
    delivery_charge_amount: Number(tenantRow.delivery_charge_amount ?? 40),
    min_free_delivery_order: Number(tenantRow.min_free_delivery_order ?? 499),
    min_order_amount: Number(tenantRow.min_order_amount ?? 0),
    packaging_charge: Number(tenantRow.packaging_charge ?? 0),
    require_customer_location: Boolean(tenantRow.require_customer_location),
    store_open_status: tenantRow.store_open_status !== false,
    operating_hours: tenantRow.operating_hours || '9:00 AM - 10:00 PM',
    delivery_modes: parsedModes,
    allow_cod: tenantRow.allow_cod !== false,
    paytm_vpa: tenantRow.paytm_vpa || '',
    paytm_mid: tenantRow.paytm_mid || '',
    custom_domain: tenantRow.custom_domain || '',
    domain_status: tenantRow.domain_status || 'not_configured'
  };

  // Fetch Categories for tenant
  let categories: any[] = [];
  if (pool) {
    try {
      const cRes = await pool.query(
        `SELECT c.id,
                c.category_name,
                COALESCE(c.category_image_url, '') as category_image_url,
                COALESCE(c.parent_id, 0)::int as parent_id,
                COALESCE(c.parent_name, '') as parent_name,
                (SELECT COUNT(*)::int FROM products p
                 WHERE LOWER(p.username) = LOWER(c.username)
                   AND (
                     p.category_id = c.id
                     OR LOWER(TRIM(COALESCE(p.category, ''))) = LOWER(TRIM(c.category_name))
                     OR LOWER(TRIM(COALESCE(p.sub_category, ''))) = LOWER(TRIM(c.category_name))
                   )
                ) as product_count
         FROM categories c
         WHERE LOWER(c.username) = LOWER($1)
         ORDER BY COALESCE(c.parent_id, 0) ASC, c.id ASC`,
        [tenantUsername]
      );
      categories = cRes.rows.map(r => ({
        id: r.id,
        name: r.category_name,
        category_name: r.category_name,
        category_image_url: r.category_image_url || '',
        parent_id: r.parent_id || 0,
        parent_name: r.parent_name || '',
        product_count: parseInt(r.product_count, 10) || 0
      }));
    } catch (e) {}
  } else {
    categories = memoryCategories
      .filter(c => c.username.toLowerCase() === tenantUsername.toLowerCase())
      .map(c => ({
        id: c.id,
        name: c.category_name,
        category_name: c.category_name,
        category_image_url: c.category_image_url,
        parent_id: (c as any).parent_id || 0,
        parent_name: (c as any).parent_name || '',
        product_count: 0
      }));
  }

  // Fetch Products for tenant (using exact PostgreSQL schema from /api/products)
  let products: any[] = [];
  if (pool) {
    try {
      const pRes = await pool.query(
        `SELECT id,
                COALESCE(category_id, 0)::int as category_id,
                name,
                COALESCE(sku, '') as sku,
                COALESCE(price, '₹0') as price,
                COALESCE(description, '') as description,
                COALESCE(category, 'General') as category,
                COALESCE(sub_category, '') as sub_category,
                COALESCE(sub_category_id, 0)::int as sub_category_id,
                COALESCE(item_type, 'product') as item_type,
                COALESCE(unit_type, 'custom') as unit_type,
                COALESCE(variants, '[]'::jsonb) as variants,
                COALESCE(images, '[]'::jsonb) as images,
                COALESCE(in_stock, true) as in_stock,
                COALESCE(stock_quantity, 50)::int as stock_quantity,
                COALESCE(low_stock_threshold, 5)::int as low_stock_threshold,
                COALESCE(mrp, 0)::float as mrp,
                COALESCE(sale_price, 0)::float as sale_price,
                COALESCE(NULLIF(product_image_url, ''), NULLIF(image_url, ''), '') as product_image_url,
                COALESCE(whatsapp_catalog_link, '') as whatsapp_catalog_link
         FROM products
         WHERE LOWER(username) = LOWER($1)
         ORDER BY id ASC`,
        [tenantUsername]
      );
      products = pRes.rows.map(r => {
        let parsedVariants: any[] = [];
        if (Array.isArray(r.variants)) {
          parsedVariants = r.variants;
        } else if (typeof r.variants === 'string') {
          try { parsedVariants = JSON.parse(r.variants); } catch {}
        }

        let parsedImages: string[] = [];
        if (Array.isArray(r.images)) {
          parsedImages = r.images.filter(Boolean);
        } else if (typeof r.images === 'string') {
          try { parsedImages = JSON.parse(r.images).filter(Boolean); } catch {}
        }
        if (parsedImages.length === 0 && r.product_image_url) {
          parsedImages = [r.product_image_url];
        }
        const primaryImg = parsedImages[0] || r.product_image_url || '';
        const computedSale = Number(r.sale_price) || parseFloat(String(r.price || '').replace(/[^\d.]/g, '')) || 0;
        const stockQty = typeof r.stock_quantity === 'number' ? r.stock_quantity : 50;

        return {
          id: r.id,
          category_id: r.category_id || 0,
          category: r.category || 'General',
          category_name: r.category || 'General',
          sub_category: r.sub_category || '',
          sub_category_id: r.sub_category_id || 0,
          item_type: r.item_type || 'product',
          name: r.name,
          sku: r.sku || `SKU-${String(r.id).padStart(4, '0')}`,
          sku_code: r.sku || `SKU-${String(r.id).padStart(4, '0')}`,
          price: r.price,
          mrp: Number(r.mrp) || 0,
          sale_price: computedSale,
          description: r.description || '',
          unit_type: r.unit_type || 'custom',
          variants: parsedVariants,
          whatsapp_catalog_link: r.whatsapp_catalog_link || '',
          image_url: primaryImg,
          product_image_url: primaryImg,
          thumb_url: primaryImg,
          images: parsedImages,
          in_stock: Boolean(r.in_stock) && stockQty > 0,
          stock_quantity: stockQty,
          low_stock_threshold: typeof r.low_stock_threshold === 'number' ? r.low_stock_threshold : 5
        };
      });
    } catch (e: any) {
      console.warn('Storefront products query fallback:', e.message);
    }
  }

  return res.json({
    status: 'success',
    allow_cod: tenant.allow_cod,
    tenant,
    categories,
    products
  });
});

// ============================================================================
// OMNICHANNEL WHATSAPP-WEB SYNC, MAGIC LINKS & PROFILE MANAGEMENT
// ============================================================================

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || 'wamart_omnichannel_secret_key_2026';

interface MemoryMagicLink {
  token: string;
  jid: string;
  tenant_id: string;
  expires_at: Date;
  is_used: boolean;
}

const memoryMagicLinks = new Map<string, MemoryMagicLink>();

function signCustomerSession(payload: { jid: string; tenant_id: string; phone: string }): string {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', CUSTOMER_JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyCustomerSession(tokenStr: string): { jid: string; tenant_id: string; phone: string } | null {
  if (!tokenStr || !tokenStr.includes('.')) return null;
  const [data, sig] = tokenStr.split('.');
  if (!data || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', CUSTOMER_JWT_SECRET).update(data).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractCustomerAuth(req: Request): { jid: string; tenant_id: string; phone: string } | null {
  let rawToken = '';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawToken = authHeader.substring(7).trim();
  }
  if (!rawToken && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [k, v] = c.trim().split('=');
      if (k === 'wamart_cust_token') {
        rawToken = decodeURIComponent(v);
        break;
      }
    }
  }
  if (!rawToken && req.query.auth_token) {
    rawToken = String(req.query.auth_token).trim();
  }
  if (!rawToken && (req.headers['x-auth-token'] || req.headers['x-customer-token'])) {
    rawToken = String(req.headers['x-auth-token'] || req.headers['x-customer-token']).trim();
  }
  return verifyCustomerSession(rawToken);
}

// 1. GENERATE MAGIC LINK HELPER & API
export async function createMagicLinkToken(tenantId: string, jid: string, origin: string): Promise<{ token: string; url: string }> {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pool = getPool();
  let storeSlug = tenantId;

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO magic_links (token, jid, tenant_id, expires_at, is_used) VALUES ($1, $2, $3, $4, false)`,
        [token, jid, tenantId, expiresAt]
      );
      const uRes = await pool.query(
        `SELECT COALESCE(NULLIF(store_slug, ''), username) as slug FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
        [tenantId]
      );
      if (uRes.rows.length > 0 && uRes.rows[0].slug) {
        storeSlug = uRes.rows[0].slug;
      }
    } catch (e: any) {
      console.warn('Magic link DB insert warning:', e.message);
    }
  }

  memoryMagicLinks.set(token, { token, jid, tenant_id: tenantId, expires_at: expiresAt, is_used: false });
  const cleanOrigin = origin.replace(/\/+$/, '');
  const url = `${cleanOrigin}/${encodeURIComponent(storeSlug)}?auth_token=${token}`;
  return { token, url };
}

// Endpoint to generate magic link (can be called by WhatsApp bot or webhook)
app.post('/api/customer/magic-link', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const { tenant_id, jid } = body || {};
  if (!tenant_id || !jid) {
    return res.status(400).json({ status: 'error', message: 'tenant_id and jid are required' });
  }

  const origin = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  try {
    const magic = await createMagicLinkToken(tenant_id, jid, origin);
    return res.json({ status: 'success', token: magic.token, url: magic.url });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message || 'Failed to generate magic link' });
  }
});

// 2. VALIDATE MAGIC LINK API: POST /api/auth/verify-token
app.all(['/api/auth/verify-token', '/api/customer/verify-token'], async (req: Request, res: Response) => {
  let token = (req.body?.token || req.query?.token || req.query?.auth_token || req.headers['x-magic-token'] || '') as string;
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ status: 'error', message: 'Magic link token is required' });
  }
  token = token.trim();

  let linkRecord: { jid: string; tenant_id: string; expires_at: Date; is_used: boolean } | null = null;
  const pool = getPool();

  if (pool) {
    try {
      const qRes = await pool.query(
        `SELECT jid, tenant_id, expires_at, is_used FROM magic_links WHERE token = $1 LIMIT 1`,
        [token]
      );
      if (qRes.rows.length > 0) {
        linkRecord = {
          jid: qRes.rows[0].jid,
          tenant_id: qRes.rows[0].tenant_id,
          expires_at: new Date(qRes.rows[0].expires_at),
          is_used: Boolean(qRes.rows[0].is_used)
        };
      }
    } catch (e: any) {
      console.warn('Verify token DB query notice:', e.message);
    }
  }

  if (!linkRecord) {
    const mem = memoryMagicLinks.get(token);
    if (mem) linkRecord = mem;
  }

  if (!linkRecord) {
    return res.status(401).json({ status: 'error', message: 'Invalid magic link token' });
  }

  if (linkRecord.is_used) {
    // If recently used, still allow customer to retain session gracefully
    console.log(`ℹ️ [Magic Link] Token ${token.substring(0, 8)}... was already marked used; re-verifying customer session`);
  }

  if (new Date(linkRecord.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ status: 'error', message: 'Magic link token has expired' });
  }

  // Mark token as used
  if (pool) {
    try {
      await pool.query(`UPDATE magic_links SET is_used = true WHERE token = $1`, [token]);
    } catch {}
  }
  linkRecord.is_used = true;
  memoryMagicLinks.set(token, { ...linkRecord, token });

  const cleanPhone = linkRecord.jid.replace(/@.*$/, '').replace(/\D/g, '');
  const sessionToken = signCustomerSession({
    jid: linkRecord.jid,
    tenant_id: linkRecord.tenant_id,
    phone: cleanPhone
  });

  // Set secure HttpOnly cookie
  res.cookie('wamart_cust_token', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  // Fetch pre-filled customer details from DB
  let customerData = {
    name: '',
    whatsapp_number: cleanPhone,
    delivery_phone: cleanPhone,
    delivery_address: '',
    jid: linkRecord.jid,
    tenant_id: linkRecord.tenant_id
  };

  if (pool) {
    try {
      const cRes = await pool.query(
        `SELECT 
          COALESCE(NULLIF(name, ''), NULLIF(full_name, ''), NULLIF(saved_name, ''), '') as name,
          COALESCE(NULLIF(whatsapp_number, ''), NULLIF(wa_number, ''), $1) as whatsapp_number,
          COALESCE(NULLIF(delivery_phone, ''), NULLIF(contact_phone, ''), $1) as delivery_phone,
          COALESCE(NULLIF(delivery_address, ''), NULLIF(saved_address, ''), '') as delivery_address
        FROM customers
        WHERE (jid = $2 OR wa_number = $1 OR wa_number = $3)
          AND (tenant_id = $4 OR LOWER(username) = LOWER($4))
        ORDER BY updated_at DESC LIMIT 1`,
        [cleanPhone, linkRecord.jid, linkRecord.jid.replace('@s.whatsapp.net', ''), linkRecord.tenant_id]
      );
      if (cRes.rows.length > 0) {
        const r = cRes.rows[0];
        customerData.name = r.name || '';
        customerData.whatsapp_number = r.whatsapp_number || cleanPhone;
        customerData.delivery_phone = r.delivery_phone || cleanPhone;
        customerData.delivery_address = r.delivery_address || '';
      } else {
        // Fallback to customer_order_states
        const oRes = await pool.query(
          `SELECT customer_name, delivery_phone, delivery_address 
           FROM customer_order_states 
           WHERE (customer_phone = $1 OR customer_phone = $2) AND LOWER(username)=LOWER($3) 
           ORDER BY updated_at DESC LIMIT 1`,
          [cleanPhone, linkRecord.jid, linkRecord.tenant_id]
        );
        if (oRes.rows.length > 0) {
          const r = oRes.rows[0];
          customerData.name = r.customer_name || '';
          customerData.delivery_phone = r.delivery_phone || cleanPhone;
          customerData.delivery_address = r.delivery_address || '';
        }
      }
    } catch (e: any) {
      console.warn('Customer lookup error:', e.message);
    }
  }

  return res.json({
    status: 'success',
    token: sessionToken,
    jid: linkRecord.jid,
    tenant_id: linkRecord.tenant_id,
    customer: customerData
  });
});

// 3. CUSTOMER PROFILE APIs: GET & PUT /api/customer/profile
app.get('/api/customer/profile', async (req: Request, res: Response) => {
  const auth = extractCustomerAuth(req);
  if (!auth) {
    return res.status(401).json({ status: 'error', message: 'Authentication required. Please open your secure store link.' });
  }

  const cleanPhone = auth.phone || auth.jid.replace(/@.*$/, '').replace(/\D/g, '');
  let customerData = {
    jid: auth.jid,
    tenant_id: auth.tenant_id,
    name: '',
    whatsapp_number: cleanPhone,
    delivery_phone: cleanPhone,
    delivery_address: ''
  };

  const pool = getPool();
  if (pool) {
    try {
      const cRes = await pool.query(
        `SELECT 
          COALESCE(NULLIF(name, ''), NULLIF(full_name, ''), NULLIF(saved_name, ''), '') as name,
          COALESCE(NULLIF(whatsapp_number, ''), NULLIF(wa_number, ''), $1) as whatsapp_number,
          COALESCE(NULLIF(delivery_phone, ''), NULLIF(contact_phone, ''), $1) as delivery_phone,
          COALESCE(NULLIF(delivery_address, ''), NULLIF(saved_address, ''), '') as delivery_address
        FROM customers
        WHERE (jid = $2 OR wa_number = $1 OR wa_number = $3)
          AND (tenant_id = $4 OR LOWER(username) = LOWER($4))
        ORDER BY updated_at DESC LIMIT 1`,
        [cleanPhone, auth.jid, auth.jid.replace('@s.whatsapp.net', ''), auth.tenant_id]
      );
      if (cRes.rows.length > 0) {
        const r = cRes.rows[0];
        customerData.name = r.name || '';
        customerData.whatsapp_number = r.whatsapp_number || cleanPhone;
        customerData.delivery_phone = r.delivery_phone || cleanPhone;
        customerData.delivery_address = r.delivery_address || '';
      } else {
        const oRes = await pool.query(
          `SELECT customer_name, delivery_phone, delivery_address 
           FROM customer_order_states 
           WHERE (customer_phone = $1 OR customer_phone = $2) AND LOWER(username)=LOWER($3) 
           ORDER BY updated_at DESC LIMIT 1`,
          [cleanPhone, auth.jid, auth.tenant_id]
        );
        if (oRes.rows.length > 0) {
          const r = oRes.rows[0];
          customerData.name = r.customer_name || '';
          customerData.delivery_phone = r.delivery_phone || cleanPhone;
          customerData.delivery_address = r.delivery_address || '';
        }
      }
    } catch (e: any) {
      console.warn('Customer profile query notice:', e.message);
    }
  }

  return res.json({ status: 'success', profile: customerData, customer: customerData });
});

app.all(['/api/customer/profile'], async (req: Request, res: Response) => {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const auth = extractCustomerAuth(req);
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  const name = (body?.name || body?.full_name || '').trim();
  const delivery_phone = (body?.delivery_phone || body?.contact_phone || '').trim();
  const delivery_address = (body?.delivery_address || '').trim();
  const fallbackPhone = String(delivery_phone || body?.whatsapp_number || '').replace(/\D/g, '');
  const fallbackTenant = String(body?.tenant_id || 'admin').trim();

  const cleanPhone = auth ? (auth.phone || auth.jid.replace(/@.*$/, '').replace(/\D/g, '')) : fallbackPhone;
  const tenantId = auth ? auth.tenant_id : fallbackTenant;
  const jid = auth ? auth.jid : (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : '');

  if (!cleanPhone) {
    return res.status(400).json({ status: 'error', message: 'Phone number is required to save customer profile.' });
  }

  const pool = getPool();

  if (pool) {
    try {
      // 1. Upsert customers table
      await pool.query(
        `INSERT INTO customers (username, tenant_id, jid, wa_number, whatsapp_number, full_name, name, contact_phone, delivery_phone, delivery_address, saved_address, updated_at)
         VALUES ($1, $1, $2, $3, $3, $4, $4, $5, $5, $6, $6, NOW())
         ON CONFLICT (username, wa_number) DO UPDATE SET
           name = EXCLUDED.name,
           full_name = EXCLUDED.full_name,
           delivery_phone = EXCLUDED.delivery_phone,
           contact_phone = EXCLUDED.contact_phone,
           delivery_address = EXCLUDED.delivery_address,
           saved_address = EXCLUDED.saved_address,
           jid = EXCLUDED.jid,
           tenant_id = EXCLUDED.tenant_id,
           updated_at = NOW()`,
        [tenantId, jid, cleanPhone, name, delivery_phone || cleanPhone, delivery_address]
      );

      // 2. Sync to customer_order_states so WhatsApp AI agent immediately knows updated info
      await pool.query(
        `INSERT INTO customer_order_states (username, customer_phone, jid, tenant_id, customer_name, delivery_phone, delivery_address, updated_at)
         VALUES ($1, $2, $3, $1, $4, $5, $6, NOW())
         ON CONFLICT (username, customer_phone) DO UPDATE SET
           customer_name = EXCLUDED.customer_name,
           delivery_phone = EXCLUDED.delivery_phone,
           delivery_address = EXCLUDED.delivery_address,
           jid = EXCLUDED.jid,
           tenant_id = EXCLUDED.tenant_id,
           updated_at = NOW()`,
        [tenantId, cleanPhone, jid, name, delivery_phone || cleanPhone, delivery_address]
      );
    } catch (e: any) {
      console.warn('Update customer profile DB error:', e.message);
    }
  }

  const updatedProfile = {
    jid,
    tenant_id: tenantId,
    name,
    whatsapp_number: cleanPhone,
    delivery_phone: delivery_phone || cleanPhone,
    delivery_address
  };

  return res.json({
    status: 'success',
    message: 'Profile updated successfully',
    profile: updatedProfile,
    customer: updatedProfile
  });
});

// 4. ORDER HISTORY API: GET /api/customer/orders
app.get('/api/customer/orders', async (req: Request, res: Response) => {
  const auth = extractCustomerAuth(req);
  const queryPhone = String(req.query.phone || req.query.customer_phone || '').replace(/\D/g, '');
  const tenantSlug = String(req.query.tenant_id || req.query.slug || '').toLowerCase().trim();

  const cleanPhone = auth ? (auth.phone || auth.jid.replace(/@.*$/, '').replace(/\D/g, '')) : queryPhone;
  const authJid = auth ? auth.jid : (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : '');

  let orders: any[] = [];
  const pool = getPool();

  if (pool && (cleanPhone || authJid)) {
    try {
      // 1. Fetch from orders table
      const oRes = await pool.query(
        `SELECT 
          id, order_id, jid, customer_phone, tenant_id, customer_name, 
          delivery_phone, delivery_address, items, total_amount, 
          payment_mode, payment_status, order_status, created_at
        FROM orders
        WHERE (jid = $1 OR customer_phone = $2 OR delivery_phone = $2)
          AND ($3 = '' OR LOWER(tenant_id) = $3)
        ORDER BY created_at DESC LIMIT 50`,
        [authJid, cleanPhone, tenantSlug]
      );

      orders = oRes.rows.map(r => {
        let parsedItems: any = r.items;
        if (typeof parsedItems === 'string') {
          try { parsedItems = JSON.parse(parsedItems); } catch { parsedItems = []; }
        }
        return {
          id: r.id,
          order_id: r.order_id,
          created_at: r.created_at,
          date: r.created_at,
          customer_name: r.customer_name || '',
          customer_phone: r.customer_phone || cleanPhone,
          delivery_address: r.delivery_address || '',
          order_status: (r.order_status || 'CONFIRMED').toUpperCase(),
          status: (r.order_status || 'CONFIRMED').toUpperCase(),
          payment_status: (r.payment_status || 'PENDING').toUpperCase(),
          payment_mode: r.payment_mode || 'COD',
          total_amount: Number(r.total_amount || 0),
          items: Array.isArray(parsedItems) ? parsedItems : []
        };
      });

      // 2. Also check customer_order_states for current or recent order if orders table is empty
      if (orders.length === 0) {
        const sRes = await pool.query(
          `SELECT 
            id, order_id, customer_name, delivery_address, items, total_amount, payment_mode, payment_status, order_status, created_at, updated_at
          FROM customer_order_states
          WHERE (customer_phone = $1 OR jid = $2) AND (order_id IS NOT NULL AND order_id != '')
          ORDER BY updated_at DESC`,
          [cleanPhone, authJid]
        );
        orders = sRes.rows.map(r => {
          let parsedItems: any = r.items;
          if (typeof parsedItems === 'string') {
            try { parsedItems = JSON.parse(parsedItems); } catch { parsedItems = []; }
          }
          return {
            id: r.id,
            order_id: r.order_id,
            created_at: r.updated_at || r.created_at,
            date: r.updated_at || r.created_at,
            customer_name: r.customer_name || '',
            customer_phone: cleanPhone,
            delivery_address: r.delivery_address || '',
            order_status: (r.order_status || 'CONFIRMED').toUpperCase(),
            status: (r.order_status || 'CONFIRMED').toUpperCase(),
            payment_status: (r.payment_status || 'PENDING').toUpperCase(),
            payment_mode: r.payment_mode || 'COD',
            total_amount: Number(r.total_amount || 0),
            items: Array.isArray(parsedItems) ? parsedItems : []
          };
        });
      }
    } catch (e: any) {
      console.warn('Customer orders query error:', e.message);
    }
  }

  return res.json({ status: 'success', orders });
});

// 5. OMNICHANNEL CART SYNC APIS: GET & POST /api/customer/cart
app.get('/api/customer/cart', async (req: Request, res: Response) => {
  const auth = extractCustomerAuth(req);
  if (!auth) {
    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }

  const cleanPhone = auth.phone || auth.jid.replace(/@.*$/, '').replace(/\D/g, '');
  let cartItems: any[] = [];
  const pool = getPool();

  if (pool) {
    try {
      const cRes = await pool.query(
        `SELECT 
          c.product_id, c.qty, 
          p.id as prod_id, p.name, p.price, p.sale_price, p.mrp, 
          COALESCE(NULLIF(p.image_url, ''), NULLIF(p.product_image_url, ''), '') as image_url,
          p.category
        FROM active_carts c
        LEFT JOIN products p ON (p.id::text = c.product_id OR p.name = c.product_id)
        WHERE (c.customer_phone = $1 OR c.jid = $2)
          AND (c.tenant_id = $3 OR LOWER(c.username) = LOWER($3))
        ORDER BY c.id ASC`,
        [cleanPhone, auth.jid, auth.tenant_id]
      );

      cartItems = cRes.rows.map(r => ({
        product_id: r.product_id,
        qty: Number(r.qty || 1),
        item: {
          id: r.prod_id || r.product_id,
          name: r.name || r.product_id,
          price: r.price,
          sale_price: r.sale_price || r.price,
          mrp: r.mrp || 0,
          image_url: r.image_url || '',
          category: r.category || 'General'
        }
      }));
    } catch (e: any) {
      console.warn('Customer cart query error:', e.message);
    }
  }

  return res.json({ status: 'success', cart: cartItems });
});

app.post('/api/customer/cart', async (req: Request, res: Response) => {
  const auth = extractCustomerAuth(req);
  if (!auth) {
    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  const items = Array.isArray(body?.items) ? body.items : Object.values(body?.cart || {});
  const cleanPhone = auth.phone || auth.jid.replace(/@.*$/, '').replace(/\D/g, '');
  const pool = getPool();

  if (pool) {
    try {
      // Clear existing active carts for this customer
      await pool.query(
        `DELETE FROM active_carts WHERE (customer_phone = $1 OR jid = $2) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))`,
        [cleanPhone, auth.jid, auth.tenant_id]
      );

      // Insert new items
      for (const itm of items) {
        const prodId = String(itm.product_id || itm.id || itm.item?.id || '');
        const qty = Number(itm.qty || 1);
        if (prodId && qty > 0) {
          await pool.query(
            `INSERT INTO active_carts (username, tenant_id, customer_phone, jid, product_id, qty, updated_at)
             VALUES ($1, $1, $2, $3, $4, $5, NOW())
             ON CONFLICT (username, customer_phone, product_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = NOW()`,
            [auth.tenant_id, cleanPhone, auth.jid, prodId, qty]
          );
        }
      }
    } catch (e: any) {
      console.warn('Customer cart sync error:', e.message);
    }
  }

  return res.json({ status: 'success', message: 'Cart synchronized with WhatsApp' });
});

// 5. DIRECT WEB ORDER CHECKOUT API: POST /api/orders/checkout & /api/customer/checkout
app.post(['/api/orders/checkout', '/api/customer/checkout'], async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  const auth = extractCustomerAuth(req);
  let {
    auth_token,
    jid,
    tenant_id,
    customer_name,
    customer_phone,
    delivery_phone,
    delivery_address,
    payment_mode,
    items,
    subtotal,
    delivery_fee,
    total_amount
  } = body || {};

  if (auth) {
    if (!jid) jid = auth.jid;
    if (!tenant_id) tenant_id = auth.tenant_id;
    if (!customer_phone) customer_phone = auth.phone;
  }

  customer_name = (customer_name || '').trim();
  delivery_address = (delivery_address || '').trim();
  const rawPhone = String(customer_phone || delivery_phone || '').trim();
  const cleanPhone = rawPhone.replace(/\D/g, '');

  if (!customer_name) {
    return res.status(400).json({ status: 'error', message: 'Customer name is required for order confirmation.' });
  }
  if (!cleanPhone) {
    return res.status(400).json({ status: 'error', message: 'WhatsApp phone number is required to receive receipt.' });
  }
  if (!delivery_address) {
    return res.status(400).json({ status: 'error', message: 'Delivery address & landmark is required.' });
  }

  if (!jid) jid = `${cleanPhone}@s.whatsapp.net`;
  if (!tenant_id) tenant_id = 'admin';
  if (!payment_mode) payment_mode = 'COD';

  // Normalize items array
  let parsedItems: any[] = [];
  if (Array.isArray(items)) {
    parsedItems = items;
  } else if (items && typeof items === 'object') {
    parsedItems = Object.values(items);
  }

  if (parsedItems.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Cart items cannot be empty.' });
  }

  // Server-side recalculation of total
  let calculatedSubtotal = 0;
  for (const itm of parsedItems) {
    const qty = Number(itm.qty || 1);
    const price = Number(itm.price || itm.sale_price) || 0;
    calculatedSubtotal += (price * qty);
  }

  if (calculatedSubtotal <= 0 && Number(total_amount) > 0) {
    calculatedSubtotal = Number(total_amount);
  }

  const finalDeliveryFee = Number(delivery_fee) || 0;
  const finalPackagingFee = Number(body?.packaging_charge) || 0;
  const finalTotal = calculatedSubtotal + finalDeliveryFee + finalPackagingFee;

  const orderId = `ORD${Date.now().toString().slice(-6)}${Math.floor(100 + Math.random() * 900)}`;
  const isOnline = String(payment_mode).toUpperCase().trim() === 'ONLINE';
  const initPayStatus = isOnline ? 'PENDING_PAYMENT' : 'PENDING';
  const initOrdStatus = isOnline ? 'PENDING_PAYMENT' : 'CONFIRMED';

  let tenantVpa = '';
  let tenantStoreName = tenant_id;

  const pool = getPool();
  if (pool) {
    try {
      // Fetch tenant UPI VPA & Store Name for Online QR generation
      const tRes = await pool.query(
        `SELECT COALESCE(paytm_vpa, '') as paytm_vpa, COALESCE(business_name, account_name, username) as store_name
         FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(store_slug) = LOWER($1) LIMIT 1`,
        [tenant_id]
      );
      if (tRes.rows.length > 0) {
        tenantVpa = tRes.rows[0].paytm_vpa || '';
        tenantStoreName = tRes.rows[0].store_name || tenant_id;
      }

      // 1. Insert into orders table
      await pool.query(
        `INSERT INTO orders 
         (order_id, jid, customer_phone, tenant_id, customer_name, delivery_phone, delivery_address, items, total_amount, payment_mode, payment_status, order_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         ON CONFLICT (order_id) DO UPDATE SET updated_at = NOW()`,
        [orderId, jid, cleanPhone, tenant_id, customer_name, cleanPhone, delivery_address, JSON.stringify(parsedItems), finalTotal, payment_mode, initPayStatus, initOrdStatus]
      );

      // 2. Decrement product stock_quantity in products table
      for (const itm of parsedItems) {
        const prodId = Number(itm.id || itm.product_id);
        const qty = Number(itm.qty || 1);
        if (prodId > 0 && qty > 0) {
          await pool.query(
            `UPDATE products
             SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 100) - $1),
                 in_stock = CASE WHEN GREATEST(0, COALESCE(stock_quantity, 100) - $1) = 0 THEN false ELSE in_stock END
             WHERE id = $2 AND LOWER(username) = LOWER($3)`,
            [qty, prodId, tenant_id]
          ).catch(() => {});
        }
      }

      // 3. Upsert customer_order_states for WhatsApp AI and thermal receipt generator
      await pool.query(
        `INSERT INTO customer_order_states 
         (username, customer_phone, jid, tenant_id, customer_name, delivery_phone, delivery_address, items, total_amount, order_id, payment_mode, payment_status, order_status, updated_at)
         VALUES ($1, $2, $3, $1, $4, $2, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (username, customer_phone) DO UPDATE SET
           customer_name = EXCLUDED.customer_name,
           delivery_phone = EXCLUDED.delivery_phone,
           delivery_address = EXCLUDED.delivery_address,
           items = EXCLUDED.items,
           total_amount = EXCLUDED.total_amount,
           order_id = EXCLUDED.order_id,
           payment_mode = EXCLUDED.payment_mode,
           payment_status = EXCLUDED.payment_status,
           order_status = EXCLUDED.order_status,
           jid = EXCLUDED.jid,
           tenant_id = EXCLUDED.tenant_id,
           updated_at = NOW()`,
        [tenant_id, cleanPhone, jid, customer_name, delivery_address, JSON.stringify(parsedItems), finalTotal, orderId, payment_mode, initPayStatus, initOrdStatus]
      );

      // 4. Clear active_carts
      await pool.query(
        `DELETE FROM active_carts WHERE (customer_phone = $1 OR jid = $2) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))`,
        [cleanPhone, jid, tenant_id]
      );

      // 5. Update customer profile info in customers table
      await pool.query(
        `INSERT INTO customers (username, tenant_id, jid, wa_number, whatsapp_number, full_name, name, contact_phone, delivery_phone, delivery_address, saved_address, updated_at)
         VALUES ($1, $1, $2, $3, $3, $4, $4, $3, $3, $5, $5, NOW())
         ON CONFLICT (username, wa_number) DO UPDATE SET
           name = EXCLUDED.name,
           full_name = EXCLUDED.full_name,
           delivery_phone = EXCLUDED.delivery_phone,
           delivery_address = EXCLUDED.delivery_address,
           saved_address = EXCLUDED.saved_address,
           updated_at = NOW()`,
        [tenant_id, jid, cleanPhone, customer_name, delivery_address]
      );

      // 6. Record outbound order message in customer_chats
      const confText = `🎉 *Order Received!* Your web order #${orderId} for ₹${finalTotal} has been placed (${payment_mode}).`;
      await pool.query(
        `INSERT INTO customer_chats (username, customer_phone, role, message_text, sender_type, created_at)
         VALUES ($1, $2, 'assistant', $3, 'outgoing', NOW())`,
        [tenant_id, cleanPhone, confText]
      );
    } catch (e: any) {
      console.warn('Checkout order DB warning:', e.message);
    }
  }

  const cleanVpa = tenantVpa || 'merchant@paytm';
  const upiUri = `upi://pay?pa=${encodeURIComponent(cleanVpa)}&pn=${encodeURIComponent(tenantStoreName)}&am=${finalTotal.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Order_' + orderId)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(upiUri)}`;

  return res.json({
    status: 'success',
    message: isOnline
      ? 'Order created. Please scan UPI QR code to complete payment.'
      : "Order Placed Successfully! We've sent the confirmation and receipt to your WhatsApp.",
    order_id: orderId,
    payment_mode: isOnline ? 'ONLINE' : payment_mode,
    payment_status: initPayStatus,
    order_status: initOrdStatus,
    total_amount: finalTotal,
    upi_uri: upiUri,
    qr_url: qrUrl,
    qr_image_url: qrUrl,
    order: {
      order_id: orderId,
      jid,
      customer_name,
      customer_phone: cleanPhone,
      delivery_address,
      items: parsedItems,
      subtotal: calculatedSubtotal,
      delivery_fee: finalDeliveryFee,
      packaging_charge: finalPackagingFee,
      total_amount: finalTotal,
      payment_mode,
      payment_status: initPayStatus,
      order_status: initOrdStatus,
      created_at: new Date().toISOString()
    }
  });
});

// POST /api/orders/confirm-upi (Allows customer/merchant to confirm UPI payment & UTR)
app.post('/api/orders/confirm-upi', async (req: Request, res: Response) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const orderId = String(body?.order_id || '').trim();
  const utrNumber = String(body?.utr_number || '').trim();
  if (!orderId) {
    return res.status(400).json({ status: 'error', message: 'order_id is required' });
  }

  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `UPDATE orders SET payment_status = 'PAID', order_status = 'CONFIRMED', updated_at = NOW() WHERE LOWER(order_id) = LOWER($1)`,
        [orderId]
      );
      await pool.query(
        `UPDATE customer_order_states SET payment_status = 'PAID', order_status = 'CONFIRMED', updated_at = NOW() WHERE LOWER(order_id) = LOWER($1)`,
        [orderId]
      );
    } catch (e: any) {
      console.warn('Confirm UPI DB notice:', e.message);
    }
  }

  return res.json({
    status: 'success',
    order_id: orderId,
    utr_number: utrNumber,
    payment_status: 'PAID',
    order_status: 'CONFIRMED',
    paid: true,
    is_paid: true
  });
});

// GET /api/orders/status & /api/orders/status/:orderId
app.get(['/api/orders/status', '/api/orders/status/:orderId'], async (req: Request, res: Response) => {
  const orderId = (req.params.orderId || req.query.order_id || req.query.orderId || '') as string;
  const cleanOrderId = orderId.trim();
  if (!cleanOrderId) {
    return res.status(400).json({ status: 'error', message: 'order_id parameter is required' });
  }

  let paymentStatus = 'PENDING';
  let orderStatus = 'CONFIRMED';
  let totalAmount = 0;
  let customerName = '';
  let deliveryAddress = '';
  let paymentMode = 'COD';
  let updatedAt: any = null;

  const pool = getPool();
  if (pool) {
    try {
      const oRes = await pool.query(
        `SELECT COALESCE(payment_status, 'PENDING') as payment_status,
                COALESCE(order_status, 'CONFIRMED') as order_status,
                COALESCE(total_amount, 0) as total_amount,
                COALESCE(customer_name, '') as customer_name,
                COALESCE(delivery_address, '') as delivery_address,
                COALESCE(payment_mode, 'COD') as payment_mode,
                COALESCE(updated_at, created_at) as updated_at
         FROM orders WHERE LOWER(order_id) = LOWER($1) LIMIT 1`,
        [cleanOrderId]
      );
      if (oRes.rows.length > 0) {
        paymentStatus = oRes.rows[0].payment_status;
        orderStatus = oRes.rows[0].order_status;
        totalAmount = Number(oRes.rows[0].total_amount || 0);
        customerName = oRes.rows[0].customer_name || '';
        deliveryAddress = oRes.rows[0].delivery_address || '';
        paymentMode = oRes.rows[0].payment_mode || 'COD';
        updatedAt = oRes.rows[0].updated_at;
      } else {
        const sRes = await pool.query(
          `SELECT COALESCE(payment_status, 'PENDING') as payment_status,
                  COALESCE(order_status, 'CONFIRMED') as order_status,
                  COALESCE(total_amount, 0) as total_amount,
                  COALESCE(customer_name, '') as customer_name,
                  COALESCE(delivery_address, '') as delivery_address,
                  COALESCE(payment_mode, 'COD') as payment_mode,
                  COALESCE(updated_at, created_at) as updated_at
           FROM customer_order_states WHERE LOWER(order_id) = LOWER($1) LIMIT 1`,
          [cleanOrderId]
        );
        if (sRes.rows.length > 0) {
          paymentStatus = sRes.rows[0].payment_status;
          orderStatus = sRes.rows[0].order_status;
          totalAmount = Number(sRes.rows[0].total_amount || 0);
          customerName = sRes.rows[0].customer_name || '';
          deliveryAddress = sRes.rows[0].delivery_address || '';
          paymentMode = sRes.rows[0].payment_mode || 'COD';
          updatedAt = sRes.rows[0].updated_at;
        }
      }
    } catch (e: any) {
      console.warn('Query order status error:', e.message);
    }
  }

  const normPayStatus = String(paymentStatus).toUpperCase().trim();
  const normOrdStatus = normalizeOrderStatusCode(orderStatus);
  const isPaid = ['PAID', 'SUCCESS', 'TXN_SUCCESS', 'COMPLETED', 'CONFIRMED'].includes(normPayStatus);

  return res.json({
    status: 'success',
    order_id: cleanOrderId,
    payment_status: normPayStatus,
    order_status: normOrdStatus,
    order_status_label: formatOrderStatusLabel(normOrdStatus),
    total_amount: totalAmount,
    customer_name: customerName,
    delivery_address: deliveryAddress,
    payment_mode: paymentMode,
    updated_at: updatedAt,
    is_paid: isPaid,
    status_label: isPaid ? 'PAID' : normPayStatus
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

  if (getPool()) {
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

  if (getPool()) {
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

  const newHash = new_password;

  // Update in Neon DB
  if (getPool()) {
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

  if (getPool()) {
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

  if (getPool()) {
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
  const { username = '', phone = '', message = '' } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ status: 'error', message: 'Phone number and message text required' });
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const cleanUser = username.toLowerCase();

  // 1. Push to Live Chat SSE immediately
  pushToLiveChat(cleanUser, cleanPhone, message, 'outgoing_manual');

  // 2. Sync to DB in background without blocking response
  recordCustomerChat(cleanUser, cleanPhone, 'assistant', message).catch(err => {
    console.warn('Background chat sync error:', err.message);
  });
  updateSlidingWindow(`${cleanUser}_${cleanPhone}`, 'assistant', message);

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

// 15. ADMIN COMPREHENSIVE DASHBOARD OVERVIEW (REAL LIVE NEON DB METRICS)
app.get('/api/admin/dashboard', async (_req: Request, res: Response) => {
  let totalUsers = 0;
  let connectedUsers = 0;
  let automationEnabledUsers = 0;
  let autoReplyUsers = 0;
  let libraryOwnersCount = 0;
  let businessUsersCount = 0;
  let totalMediaItems = 0;
  let totalOrders = 0;
  let totalGMV = 0;
  let todayOrders = 0;
  let todayGMV = 0;
  let totalLeads = 0;
  let totalChats = 0;
  let activeChannelRules = 0;

  const sevenDayLabels: string[] = [];
  const sevenDayGMV: number[] = [];
  const sevenDayOrders: number[] = [];
  const dayMap = new Map<string, { gmv: number; orders: number }>();
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    sevenDayLabels.push(d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }));
    dayMap.set(key, { gmv: 0, orders: 0 });
  }

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const rTotal = await pool.query("SELECT COUNT(*) FROM users WHERE LOWER(username) != 'admin'");
        const rConn = await pool.query("SELECT COUNT(*) FROM users WHERE (status = 'Connected' OR (wa_jid IS NOT NULL AND wa_jid != '')) AND LOWER(username) != 'admin'");
        const rAutoAcc = await pool.query("SELECT COUNT(*) FROM users WHERE automation_access = true AND LOWER(username) != 'admin'");
        const rAutoRep = await pool.query("SELECT COUNT(*) FROM users WHERE auto_reply = true AND LOWER(username) != 'admin'");
        const rLib = await pool.query("SELECT COUNT(*) FROM users WHERE user_type = 'library_owner' AND LOWER(username) != 'admin'");
        const rBiz = await pool.query("SELECT COUNT(*) FROM users WHERE user_type = 'business_user' AND LOWER(username) != 'admin'");
        const rProds = await pool.query("SELECT COUNT(*) FROM products");
        const rLeads = await pool.query("SELECT COUNT(*) FROM leads");
        const rChats = await pool.query("SELECT COUNT(DISTINCT customer_phone) FROM customer_chats");
        const rRules = await pool.query("SELECT COUNT(*) FROM channel_forwarding_rules WHERE is_active = true");
        const rOrdersAgg = await pool.query(`
          SELECT COUNT(*)::int as total_orders,
                 COALESCE(SUM(total_amount), 0)::float as total_gmv,
                 COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int as today_orders,
                 COALESCE(SUM(total_amount) FILTER (WHERE created_at >= CURRENT_DATE), 0)::float as today_gmv
          FROM orders
        `);

        totalUsers = parseInt(rTotal.rows[0]?.count || '0', 10);
        connectedUsers = parseInt(rConn.rows[0]?.count || '0', 10);
        automationEnabledUsers = parseInt(rAutoAcc.rows[0]?.count || '0', 10);
        autoReplyUsers = parseInt(rAutoRep.rows[0]?.count || '0', 10);
        libraryOwnersCount = parseInt(rLib.rows[0]?.count || '0', 10);
        businessUsersCount = parseInt(rBiz.rows[0]?.count || '0', 10);
        totalMediaItems = parseInt(rProds.rows[0]?.count || '0', 10);
        totalLeads = parseInt(rLeads.rows[0]?.count || '0', 10);
        totalChats = parseInt(rChats.rows[0]?.count || '0', 10);
        activeChannelRules = parseInt(rRules.rows[0]?.count || '0', 10);
        totalOrders = Number(rOrdersAgg.rows[0]?.total_orders || 0);
        totalGMV = Math.round(Number(rOrdersAgg.rows[0]?.total_gmv || 0));
        todayOrders = Number(rOrdersAgg.rows[0]?.today_orders || 0);
        todayGMV = Math.round(Number(rOrdersAgg.rows[0]?.today_gmv || 0));

        const recent7dOrders = await pool.query(
          `SELECT COALESCE(total_amount, 0)::float as total_amount, created_at
           FROM orders
           WHERE created_at >= NOW() - INTERVAL '7 days'`
        );
        for (const row of recent7dOrders.rows) {
          const dt = row.created_at ? new Date(row.created_at) : now;
          const k = !isNaN(dt.getTime()) ? dt.toISOString().slice(0, 10) : '';
          if (dayMap.has(k)) {
            const b = dayMap.get(k)!;
            b.gmv += Number(row.total_amount || 0);
            b.orders += 1;
          }
        }

        // Sync RAM memoryUsers with Neon DB
        const allDbUsers = await pool.query("SELECT username, status, wa_jid FROM users");
        const validDbUsernames = new Set(allDbUsers.rows.map(r => r.username.toLowerCase()));

        for (const [uname] of memoryUsers.entries()) {
          if (!validDbUsernames.has(uname) && uname !== 'admin') {
            memoryUsers.delete(uname);
          }
        }

        for (const row of allDbUsers.rows) {
          const u = memoryUsers.get(row.username.toLowerCase());
          if (u) {
            u.status = row.status || 'Disconnected';
            u.wa_jid = row.wa_jid || '';
          }
        }
      } catch (err: any) {
        console.error('Failed to fetch dashboard metrics from Neon DB:', err.message);
      }
    }
  } else {
    const users = Array.from(memoryUsers.values()).filter(u => u.username !== 'admin');
    totalUsers = users.length;
    connectedUsers = users.filter(u => u.status === 'Connected' && Boolean(u.wa_jid)).length;
    automationEnabledUsers = users.filter(u => u.automation_access).length;
    autoReplyUsers = users.filter(u => u.auto_reply).length;
    libraryOwnersCount = users.filter(u => u.user_type === 'library_owner').length;
    businessUsersCount = users.filter(u => u.user_type === 'business_user').length;
    totalMediaItems = memoryCatalog.length;
  }

  for (const [, bucket] of dayMap.entries()) {
    sevenDayGMV.push(Math.round(bucket.gmv));
    sevenDayOrders.push(bucket.orders);
  }

  const activeUsersList = Array.from(memoryUsers.values())
    .filter(u => u.username !== 'admin')
    .map(u => ({
      id: u.id,
      username: u.username,
      account_name: u.account_name,
      role: u.role,
      user_type: u.user_type || 'business_user',
      phone: u.phone || '',
      wa_jid: u.wa_jid,
      status: u.status,
      automation_access: u.automation_access,
      auto_reply: u.auto_reply,
      ai_provider: u.ai_provider,
      created_at: u.created_at
    }));

  return res.json({
    status: 'success',
    metrics: {
      totalUsers,
      libraryOwnersCount,
      businessUsersCount,
      connectedUsers,
      disconnectedUsers: Math.max(0, totalUsers - connectedUsers),
      automationEnabledUsers,
      autoReplyUsers,
      totalMessagesSent: stats.totalMessagesSent,
      totalAiReplies: stats.totalAiReplies,
      campaignsLaunched: stats.campaignsLaunched,
      totalMediaItems,
      totalOrders,
      totalGMV,
      todayOrders,
      todayGMV,
      totalLeads,
      totalChats,
      activeChannelRules
    },
    charts: {
      seven_day_labels: sevenDayLabels,
      seven_day_gmv: sevenDayGMV,
      seven_day_orders: sevenDayOrders
    },
    users: activeUsersList
  });
});

// 16. AI PROMPT PLAYGROUND TESTER
app.post('/api/ai/test', async (req: Request, res: Response) => {
  const { username = 'admin', query, provider = 'Groq', api_key = '', system_prompt = '', model = '', temperature, business_name, business_type, response_language, language } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  const u = memoryUsers.get(username.toLowerCase());
  if (u) {
    if (business_name) u.business_name = business_name;
    if (business_type) u.business_type = business_type;
    if (response_language || language) u.response_language = response_language || language;
  }

  const result = await generateAIReply(username, 'playground_tester', query, provider, api_key, system_prompt, model, temperature);
  stats.totalAiReplies++;
  return res.json({
    reply: result.replyText,
    image_url: result.imageURL
  });
});

// 16. NEWSLETTERS & CHANNELS ENDPOINTS (/api/admin/newsletters & /api/whatsapp/newsletters)
interface NewsletterItem {
  jid: string;
  name: string;
  role: string;
  subscriber_count?: number;
}

app.all(['/api/admin/newsletters', '/api/whatsapp/newsletters', '/api/whatsapp/channels'], async (req: Request, res: Response) => {
  const username = ((req.query.username as string) || (req.body?.username as string) || 'admin').trim().toLowerCase();

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS newsletters (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            jid VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'ADMIN',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, jid)
          );
        `);

        // Remove any legacy fake placeholder rows
        await pool.query(`
          DELETE FROM newsletters
          WHERE jid IN (
            '120363000000000001@newsletter',
            '120363000000000002@newsletter',
            '120363000000000003@newsletter'
          );
        `);

        // Allow POST to register/save a custom WhatsApp channel JID + Name + Role
        if (req.method === 'POST') {
          let body = req.body;
          if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch {}
          }
          let rawJid = String(body?.jid || '').trim();
          const name = String(body?.name || rawJid).trim();
          const role = String(body?.role || 'ADMIN').trim().toUpperCase();
          if (!rawJid) {
            return res.status(400).json({ status: 'error', message: 'Channel JID is required' });
          }
          if (!rawJid.includes('@')) {
            rawJid = `${rawJid}@newsletter`;
          }
          await pool.query(
            `INSERT INTO newsletters (username, jid, name, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (username, jid) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
            [username, rawJid, name, role]
          );
          return res.json({ status: 'success', channel: { jid: rawJid, name, role } });
        }

        // Build map of real channels from both newsletters table and channel_forwarding_rules table
        const channelMap = new Map<string, NewsletterItem>();

        // 1. Pull all channels referenced in channel_forwarding_rules
        try {
          const rulesChannelsRes = await pool.query(`
            SELECT source_jid, source_name, target_jid, target_name
            FROM channel_forwarding_rules
            ORDER BY id DESC
          `);
          for (const row of rulesChannelsRes.rows) {
            const sJid = String(row.source_jid || '').trim();
            const sName = String(row.source_name || sJid).trim();
            if (sJid && !channelMap.has(sJid)) {
              channelMap.set(sJid, { jid: sJid, name: sName, role: 'SUBSCRIBER' });
            }
            const tJid = String(row.target_jid || '').trim();
            const tName = String(row.target_name || tJid).trim();
            if (tJid) {
              // Target channels are writeable (OWNER / ADMIN)
              channelMap.set(tJid, { jid: tJid, name: tName, role: 'OWNER' });
            }
          }
        } catch (ruleErr) {
          console.warn('Error reading channels from channel_forwarding_rules:', ruleErr);
        }

        // 2. Pull saved channels from newsletters table
        const nlRes = await pool.query(
          `SELECT jid, name, role FROM newsletters ORDER BY id ASC`
        );
        for (const row of nlRes.rows) {
          const jid = String(row.jid || '').trim();
          const name = String(row.name || jid).trim();
          const role = String(row.role || 'SUBSCRIBER').trim().toUpperCase();
          if (!jid) continue;
          const existing = channelMap.get(jid);
          if (!existing || role === 'OWNER' || role === 'ADMIN') {
            channelMap.set(jid, { jid, name: name || existing?.name || jid, role });
          }
        }

        // Sync discovered real channels back into newsletters table for this user
        for (const item of channelMap.values()) {
          await pool.query(
            `INSERT INTO newsletters (username, jid, name, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (username, jid) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role`,
            [username, item.jid, item.name, item.role]
          ).catch(() => {});
        }

        return res.json(Array.from(channelMap.values()));
      } catch (err) {
        console.warn('Newsletters DB query error:', err);
      }
    }
  }

  return res.json([]);
});

// 17. CHANNEL FORWARDING RULES ENDPOINTS (/api/admin/channel-rules & /api/whatsapp/channel-rules)
interface ChannelRule {
  id: number;
  admin_account_id: string;
  source_jid: string;
  source_name: string;
  target_jid: string;
  target_name: string;
  forward_logic: string;
  block_urls: boolean;
  strip_channel_links: boolean;
  is_active: boolean;
  created_at?: string;
}

let memoryChannelRules: ChannelRule[] = [];
let nextChannelRuleId = 1;

async function ensureChannelRulesTable() {
  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS channel_forwarding_rules (
            id SERIAL PRIMARY KEY,
            admin_account_id VARCHAR(100) DEFAULT 'admin',
            source_jid VARCHAR(255) NOT NULL,
            source_name VARCHAR(255) DEFAULT '',
            target_jid VARCHAR(255) NOT NULL,
            target_name VARCHAR(255) DEFAULT '',
            forward_logic VARCHAR(50) DEFAULT 'all',
            block_urls BOOLEAN DEFAULT false,
            strip_channel_links BOOLEAN DEFAULT true,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
      } catch (err) {
        console.warn('channel_forwarding_rules table creation error:', err);
      }
    }
  }
}

app.all(['/api/admin/channel-rules', '/api/whatsapp/channel-rules'], async (req: Request, res: Response) => {
  await ensureChannelRulesTable();

  // GET: Fetch all channel forwarding rules from channel_forwarding_rules
  if (req.method === 'GET') {
    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          const rulesRes = await pool.query(`
            SELECT id,
                   COALESCE(admin_account_id, 'admin') AS admin_account_id,
                   source_jid,
                   COALESCE(NULLIF(source_name, ''), source_jid) AS source_name,
                   target_jid,
                   COALESCE(NULLIF(target_name, ''), target_jid) AS target_name,
                   COALESCE(NULLIF(forward_logic, ''), 'all') AS forward_logic,
                   COALESCE(block_urls, false) AS block_urls,
                   COALESCE(strip_channel_links, true) AS strip_channel_links,
                   COALESCE(is_active, true) AS is_active,
                   COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '') AS created_at
            FROM channel_forwarding_rules
            ORDER BY id DESC
          `);
          return res.json({
            status: 'success',
            rules: rulesRes.rows
          });
        } catch (err: any) {
          console.warn('channel_forwarding_rules DB fetch error:', err);
        }
      }
    }

    return res.json({
      status: 'success',
      rules: memoryChannelRules
    });
  }

  // POST: Create a new channel rule in channel_forwarding_rules
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const adminAccountId = String(body?.admin_account_id || 'admin').trim();
    let sourceJid = String(body?.source_jid || '').trim();
    const sourceName = String(body?.source_name || sourceJid).trim();
    let targetJid = String(body?.target_jid || '').trim();
    const targetName = String(body?.target_name || targetJid).trim();
    const forwardLogic = String(body?.forward_logic || 'all').trim().toLowerCase();
    const blockUrls = Boolean(body?.block_urls);
    const stripLinks = body?.strip_channel_links !== undefined ? Boolean(body.strip_channel_links) : true;

    if (!sourceJid || !targetJid) {
      return res.status(400).json({ status: 'error', message: 'Source and Target channels are required' });
    }
    if (!sourceJid.includes('@')) sourceJid = `${sourceJid}@newsletter`;
    if (!targetJid.includes('@')) targetJid = `${targetJid}@newsletter`;

    if (sourceJid === targetJid) {
      return res.status(400).json({ status: 'error', message: 'Source and Target channel cannot be identical' });
    }

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          const insertRes = await pool.query(
            `INSERT INTO channel_forwarding_rules (admin_account_id, source_jid, source_name, target_jid, target_name, forward_logic, block_urls, strip_channel_links, is_active, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
             RETURNING *`,
            [adminAccountId, sourceJid, sourceName, targetJid, targetName, forwardLogic, blockUrls, stripLinks]
          );

          // Also persist source & target in newsletters table so dropdowns stay updated
          await pool.query(
            `INSERT INTO newsletters (username, jid, name, role) VALUES ($1, $2, $3, 'SUBSCRIBER') ON CONFLICT (username, jid) DO NOTHING`,
            [adminAccountId, sourceJid, sourceName]
          ).catch(() => {});
          await pool.query(
            `INSERT INTO newsletters (username, jid, name, role) VALUES ($1, $2, $3, 'OWNER') ON CONFLICT (username, jid) DO UPDATE SET name = EXCLUDED.name, role = 'OWNER'`,
            [adminAccountId, targetJid, targetName]
          ).catch(() => {});

          return res.json({
            status: 'success',
            message: 'Channel forwarding rule added successfully!',
            rule: insertRes.rows[0]
          });
        } catch (err: any) {
          return res.status(500).json({ status: 'error', message: err?.message || 'DB error adding rule' });
        }
      }
    }

    const newRule: ChannelRule = {
      id: nextChannelRuleId++,
      admin_account_id: adminAccountId,
      source_jid: sourceJid,
      source_name: sourceName,
      target_jid: targetJid,
      target_name: targetName,
      forward_logic: forwardLogic,
      block_urls: blockUrls,
      strip_channel_links: stripLinks,
      is_active: true,
      created_at: new Date().toISOString()
    };
    memoryChannelRules.unshift(newRule);

    return res.json({
      status: 'success',
      message: 'Channel forwarding rule added successfully!',
      rule: newRule
    });
  }

  // PUT: Update an existing rule in channel_forwarding_rules
  if (req.method === 'PUT') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const id = parseInt(body?.id, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Valid rule ID is required' });
    }

    let sourceJid = String(body?.source_jid || '').trim();
    const sourceName = String(body?.source_name || sourceJid).trim();
    let targetJid = String(body?.target_jid || '').trim();
    const targetName = String(body?.target_name || targetJid).trim();
    const forwardLogic = String(body?.forward_logic || 'all').trim().toLowerCase();
    const blockUrls = Boolean(body?.block_urls);
    const stripLinks = body?.strip_channel_links !== undefined ? Boolean(body.strip_channel_links) : true;
    const isActive = body?.is_active !== undefined ? Boolean(body.is_active) : true;

    if (!sourceJid || !targetJid) {
      return res.status(400).json({ status: 'error', message: 'Both Source and Target channels are required' });
    }
    if (!sourceJid.includes('@')) sourceJid = `${sourceJid}@newsletter`;
    if (!targetJid.includes('@')) targetJid = `${targetJid}@newsletter`;
    if (sourceJid === targetJid) {
      return res.status(400).json({ status: 'error', message: 'Source and Target channel cannot be identical' });
    }

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          const updateRes = await pool.query(
            `UPDATE channel_forwarding_rules
             SET source_jid = $1, source_name = $2, target_jid = $3, target_name = $4,
                 forward_logic = $5, block_urls = $6, strip_channel_links = $7, is_active = $8
             WHERE id = $9
             RETURNING *`,
            [sourceJid, sourceName, targetJid, targetName, forwardLogic, blockUrls, stripLinks, isActive, id]
          );

          if (updateRes.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Rule not found' });
          }

          return res.json({
            status: 'success',
            message: `Forwarding rule #${id} updated successfully!`,
            rule: updateRes.rows[0]
          });
        } catch (err: any) {
          return res.status(500).json({ status: 'error', message: err?.message || 'DB error updating rule' });
        }
      }
    }

    const rule = memoryChannelRules.find(r => r.id === id);
    if (!rule) {
      return res.status(404).json({ status: 'error', message: 'Rule not found' });
    }

    rule.source_jid = sourceJid;
    rule.source_name = sourceName;
    rule.target_jid = targetJid;
    rule.target_name = targetName;
    rule.forward_logic = forwardLogic;
    rule.block_urls = blockUrls;
    rule.strip_channel_links = stripLinks;
    rule.is_active = isActive;

    return res.json({
      status: 'success',
      message: `Forwarding rule #${id} updated successfully!`,
      rule
    });
  }

  // DELETE: Delete a rule from channel_forwarding_rules
  if (req.method === 'DELETE') {
    let idStr = (req.query.id as string) || '';
    if (!idStr && req.body) {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      if (body && body.id) idStr = String(body.id);
    }

    const id = parseInt(idStr, 10);
    if (!id || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Valid rule ID is required' });
    }

    if (getPool()) {
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(`DELETE FROM channel_forwarding_rules WHERE id = $1`, [id]);
          return res.json({
            status: 'success',
            message: `Forwarding rule #${id} deleted successfully!`
          });
        } catch (err: any) {
          return res.status(500).json({ status: 'error', message: err?.message || 'DB error deleting rule' });
        }
      }
    }

    memoryChannelRules = memoryChannelRules.filter(r => r.id !== id);
    return res.json({
      status: 'success',
      message: `Forwarding rule #${id} deleted successfully!`
    });
  }

  return res.status(405).json({ status: 'error', message: 'Method not allowed' });
});

// 18. TOGGLE CHANNEL RULE (/api/admin/channel-rules/toggle & /api/whatsapp/channel-rules/toggle)
app.post(['/api/admin/channel-rules/toggle', '/api/whatsapp/channel-rules/toggle'], async (req: Request, res: Response) => {
  await ensureChannelRulesTable();

  let idStr = (req.query.id as string) || '';
  if (!idStr && req.body) {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    if (body && body.id) idStr = String(body.id);
  }

  const id = parseInt(idStr, 10);
  if (!id || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'Valid rule ID is required' });
  }

  if (getPool()) {
    const pool = getPool();
    if (pool) {
      try {
        const toggleRes = await pool.query(
          `UPDATE channel_forwarding_rules SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
          [id]
        );
        if (toggleRes.rows.length === 0) {
          return res.status(404).json({ status: 'error', message: 'Rule not found' });
        }
        return res.json({
          status: 'success',
          id,
          is_active: toggleRes.rows[0].is_active,
          message: `Forwarding rule #${id} status toggled!`,
          rule: toggleRes.rows[0]
        });
      } catch (err: any) {
        return res.status(500).json({ status: 'error', message: err?.message || 'DB error toggling rule' });
      }
    }
  }

  const rule = memoryChannelRules.find(r => r.id === id);
  if (!rule) {
    return res.status(404).json({ status: 'error', message: 'Rule not found' });
  }

  rule.is_active = !rule.is_active;
  return res.json({
    status: 'success',
    id,
    is_active: rule.is_active,
    message: `Forwarding rule #${id} status toggled!`,
    rule
  });
});

// 19. CHANNEL-FORWARD COMPATIBILITY ENDPOINTS (/api/channel-forward/*)
app.get('/api/channel-forward/list', async (_req: Request, res: Response) => {
  await ensureChannelRulesTable();
  const pool = getPool();
  if (pool) {
    try {
      const rulesRes = await pool.query(`
        SELECT id,
               COALESCE(NULLIF(source_name, ''), 'Pipeline #' || id::text) AS name,
               source_jid,
               target_jid AS dest_jid,
               COALESCE(is_active, true) AS enabled,
               0 AS forwarded_count
        FROM channel_forwarding_rules
        ORDER BY id DESC
      `);
      return res.json(rulesRes.rows);
    } catch (err) {}
  }
  return res.json([]);
});

app.post(['/api/channel-forward/add', '/api/channel-forward/update'], async (req: Request, res: Response) => {
  await ensureChannelRulesTable();
  const { id, name, source_jid, dest_jid } = req.body || {};
  let sJid = String(source_jid || '').trim();
  let dJid = String(dest_jid || '').trim();
  if (!sJid || !dJid) {
    return res.status(400).json({ error: 'Source and Destination Channel JIDs are required' });
  }
  if (!sJid.includes('@')) sJid = `${sJid}@newsletter`;
  if (!dJid.includes('@')) dJid = `${dJid}@newsletter`;

  const pool = getPool();
  if (pool) {
    try {
      if (id) {
        await pool.query(
          `UPDATE channel_forwarding_rules SET source_name = $1, source_jid = $2, target_jid = $3 WHERE id = $4`,
          [name || sJid, sJid, dJid, Number(id)]
        );
      } else {
        await pool.query(
          `INSERT INTO channel_forwarding_rules (admin_account_id, source_name, source_jid, target_name, target_jid, is_active, created_at)
           VALUES ('admin', $1, $2, $1, $3, true, NOW())`,
          [name || sJid, sJid, dJid]
        );
      }
      return res.json({ status: 'success', success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Database error saving channel rule' });
    }
  }
  return res.json({ status: 'success', success: true });
});

app.post('/api/channel-forward/toggle', async (req: Request, res: Response) => {
  await ensureChannelRulesTable();
  const { id, enabled } = req.body || {};
  const pool = getPool();
  if (pool && id) {
    try {
      await pool.query(
        `UPDATE channel_forwarding_rules SET is_active = $1 WHERE id = $2`,
        [Boolean(enabled), Number(id)]
      );
    } catch (err) {}
  }
  return res.json({ status: 'success', success: true });
});

app.delete('/api/channel-forward/delete', async (req: Request, res: Response) => {
  await ensureChannelRulesTable();
  const id = Number(req.query.id || req.body?.id || 0);
  const pool = getPool();
  if (pool && id > 0) {
    try {
      await pool.query(`DELETE FROM channel_forwarding_rules WHERE id = $1`, [id]);
    } catch (err) {}
  }
  return res.json({ status: 'success', success: true });
});

// --- SERVE PUBLIC ---
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.resolve(process.cwd(), 'public');

// Clean portal routes (with and without .html extension)
app.get(['/admin', '/admin-portal', '/admin-portal.html'], (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'admin-portal.html'));
});

app.get(['/business', '/business-portal', '/business-portal.html', '/dashboard'], (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'business-portal.html'));
});

app.get(['/store', '/storefront', '/storefront.html', '/store/:store_slug', '/storefront/:store_slug'], (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'storefront.html'));
});

// Dynamic tenant storefront route: e.g. /:store_slug (e.g. /gopal_kirana)
app.get('/:store_slug', (req: Request, res: Response, next) => {
  const slug = (req.params.store_slug as string) || '';
  const reserved = [
    'admin', 'admin-portal', 'admin-portal.html',
    'business', 'business-portal', 'business-portal.html', 'dashboard',
    'login', 'index.html', 'api', 'temp_uploads', 'favicon.ico',
    'store', 'storefront', 'storefront.html'
  ];
  if (!slug || reserved.includes(slug.toLowerCase()) || slug.includes('.')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'storefront.html'));
});

app.get(['/', '/index.html', '/login'], (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(express.static(publicDir));

// Fallback to public/index.html
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// START SERVER
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 WaMart Server listening on port ${PORT}`);
  try {
    await initNeonDatabase(memoryUsers);
  } catch (err: any) {
    console.error('Database bootstrap error:', err.message);
  }
});
