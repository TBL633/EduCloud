import pg from 'pg';
import bcrypt from 'bcryptjs';

export interface User {
  id: number;
  username: string;
  password: string;
  role: 'admin' | 'user';
  user_type: 'library_owner' | 'business_user' | 'admin';
  account_name: string;
  phone?: string;
  notification_phone?: string;
  email?: string;
  wa_jid: string;
  ai_provider: string;
  model?: string;
  temperature?: number;
  api_key: string;
  system_prompt: string;
  auto_reply: boolean;
  automation_access: boolean;
  status: 'Connected' | 'QR_Ready' | 'Disconnected';
  qr: string;
  created_at: string;
}

const { Pool } = pg;

export interface DbStatus {
  connected: boolean;
  engine: string;
  host: string;
  totalUsers: number;
  hasEnvVar: boolean;
  message: string;
}

let pool: pg.Pool | null = null;
let isConnected = false;
let dbHost = 'Local / Fallback Cache';
let statusMessage = 'Neon DB ready. Set DATABASE_URL in .env to connect live Neon PostgreSQL.';

export function getPool(): pg.Pool | null {
  return pool;
}

export function isDbConnected(): boolean {
  return isConnected;
}

export async function getDbStatus(): Promise<DbStatus> {
  let count = 0;
  if (pool && isConnected) {
    try {
      const res = await pool.query('SELECT COUNT(*) FROM users');
      count = parseInt(res.rows[0].count, 10);
    } catch {}
  }

  return {
    connected: isConnected,
    engine: isConnected ? 'Neon Cloud PostgreSQL' : 'Memory Cache (Neon Ready)',
    host: dbHost,
    totalUsers: count,
    hasEnvVar: Boolean(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL),
    message: statusMessage
  };
}

export async function initNeonDatabase(memoryUsers: Map<string, User>): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || '';

  if (!dbUrl) {
    console.log('⚡ [Database] DATABASE_URL not set. Running in resilient memory mode with full Neon DB schema compatibility.');
    isConnected = false;
    dbHost = 'In-Memory (Awaiting DATABASE_URL)';
    statusMessage = 'Neon DB Schema Active (In-Memory Fallback)';
    return;
  }

  try {
    try {
      const parsedUrl = new URL(dbUrl);
      dbHost = parsedUrl.host || 'Neon Cloud PostgreSQL';
    } catch {
      dbHost = 'Neon Cloud PostgreSQL';
    }

    // Sanitize connection string for node-postgres (strip channel_binding if present as pg driver handles TLS directly)
    const cleanUrl = dbUrl.replace(/([?&])channel_binding=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');

    pool = new Pool({
      connectionString: cleanUrl,
      ssl: {
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 5000
    });

    // Test connection
    const client = await pool.connect();
    const versionRes = await client.query('SELECT version()');
    console.log('✅ [Neon DB] Connected successfully to:', versionRes.rows[0]?.version?.substring(0, 40));
    client.release();
    isConnected = true;
    statusMessage = `Connected to Neon PostgreSQL (${dbHost})`;

    // Initialize Schema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(150),
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        user_type VARCHAR(50) DEFAULT 'business_user',
        account_name VARCHAR(255) DEFAULT '',
        phone VARCHAR(50) DEFAULT '',
        notification_phone VARCHAR(50) DEFAULT '',
        wa_jid VARCHAR(100) DEFAULT '',
        ai_provider VARCHAR(50) DEFAULT 'gemini',
        api_key TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        auto_reply BOOLEAN DEFAULT true,
        automation_access BOOLEAN DEFAULT true,
        status VARCHAR(50) DEFAULT 'QR_Ready',
        qr TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(50) DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        price VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        ai_tag VARCHAR(50) DEFAULT '',
        item_type VARCHAR(50) DEFAULT 'product',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_leads_username_lower ON leads(LOWER(username));
    `);
    try { await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_tag VARCHAR(50) DEFAULT '';`); } catch (e) {}
    try { await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'product';`); } catch (e) {}
    try { await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) DEFAULT 'custom';`); } catch (e) {}
    try { await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb;`); } catch (e) {}
    try { await pool.query(`ALTER TABLE products DROP COLUMN IF EXISTS image_url;`); } catch (e) {}
    try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_username_lower ON products(LOWER(username));`); } catch (e) {}
    try { await pool.query(`DROP TABLE IF EXISTS neon_media_objects CASCADE;`); } catch (e) {}
    try { await pool.query(`DROP TABLE IF EXISTS user_media CASCADE;`); } catch (e) {}

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(50) NOT NULL,
        inquiry_text TEXT DEFAULT '',
        status VARCHAR(50) DEFAULT 'Captured',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Customer WhatsApp Chat Memory (Strict 10 messages per customer phone)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_chats (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(50) NOT NULL,
        role VARCHAR(20) NOT NULL,
        message_text TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_chats_user_phone ON customer_chats(username, customer_phone, id DESC);
    `);

    // Tenant Payment Configs table (Paytm Gateway)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_payment_configs (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        enabled BOOLEAN DEFAULT false,
        merchant_phone VARCHAR(50) DEFAULT '',
        merchant_vpa VARCHAR(100) DEFAULT '',
        paytm_mid VARCHAR(100) DEFAULT '',
        payee_name VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Campaign Bulk Message Logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_logs (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        recipients_count INT DEFAULT 0,
        message_text TEXT DEFAULT '',
        status VARCHAR(50) DEFAULT 'Sent',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaign_logs(LOWER(username));
    `);

    // Email OTP Verifications table (Neon Auth)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp_code VARCHAR(20) DEFAULT '',
        code VARCHAR(20) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes'
      );
      ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS otp_code VARCHAR(20) DEFAULT '';
      ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS code VARCHAR(20) DEFAULT '';
      ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes';
      CREATE INDEX IF NOT EXISTS idx_email_verif ON email_verifications(LOWER(email), expires_at DESC);
    `);

    // Ensure default master admin exists
    const adminCheck = await pool.query('SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1', ['admin']);
    if (adminCheck.rows.length === 0) {
      const hashedAdminPass = bcrypt.hashSync('admin123', 10);
      await pool.query(
        `INSERT INTO users (username, email, password, role, user_type, account_name, automation_access)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['admin', 'admin@eduta.ai', hashedAdminPass, 'admin', 'admin', 'Master Admin Account', true]
      );
      console.log('👑 [Neon DB] Master Admin user seeded in Neon database.');
    }

    // Only seed Master Admin if not present; never re-create deleted tenants!

    // Sync from Neon DB into memoryUsers
    const allUsers = await pool.query('SELECT * FROM users ORDER BY id ASC');
    for (const row of allUsers.rows) {
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
        status: (row.status as any) || 'QR_Ready',
        qr: row.qr || '',
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      });
    }
    console.log(`⚡ [Neon DB] Synchronized ${allUsers.rows.length} accounts from Neon database.`);

  } catch (err: any) {
    console.warn('⚠️ [Neon DB] Connection failed, falling back to local memory store:', err.message);
    isConnected = false;
    statusMessage = `Neon connection error: ${err.message}. Local storage active.`;
  }
}

export async function findUserByIdentifier(identifier: string, memoryUsers: Map<string, User>): Promise<User | undefined> {
  const clean = identifier.trim().toLowerCase();

  // Try Neon DB query first if connected
  if (pool && isConnected) {
    try {
      const res = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1',
        [clean]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const user: User = {
          id: row.id,
          username: row.username,
          email: row.email || '',
          password: row.password,
          role: row.role,
          user_type: row.user_type,
          account_name: row.account_name || `${row.username} Account`,
          phone: row.phone || '',
          wa_jid: row.wa_jid || '',
          ai_provider: row.ai_provider || 'gemini',
          api_key: row.api_key || '',
          system_prompt: row.system_prompt || '',
          auto_reply: Boolean(row.auto_reply),
          automation_access: Boolean(row.automation_access),
          status: row.status || 'QR_Ready',
          qr: row.qr || '',
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
        };
        memoryUsers.set(user.username.toLowerCase(), user);
        return user;
      }
    } catch (err: any) {
      console.error('Neon DB query error:', err.message);
    }
  }

  // Fallback to memory
  return Array.from(memoryUsers.values()).find(
    u => u.username.toLowerCase() === clean || (u.email && u.email.toLowerCase() === clean)
  );
}

export async function saveUserToNeon(user: User): Promise<void> {
  if (!pool || !isConnected) return;
  try {
    await pool.query(
      `INSERT INTO users (username, email, password, role, user_type, account_name, phone, wa_jid, ai_provider, api_key, system_prompt, auto_reply, automation_access, status, qr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password = EXCLUDED.password,
         role = EXCLUDED.role,
         user_type = EXCLUDED.user_type,
         account_name = EXCLUDED.account_name,
         phone = EXCLUDED.phone,
         wa_jid = EXCLUDED.wa_jid,
         system_prompt = EXCLUDED.system_prompt,
         auto_reply = EXCLUDED.auto_reply,
         automation_access = EXCLUDED.automation_access,
         status = EXCLUDED.status,
         qr = EXCLUDED.qr`,
      [
        user.username,
        user.email || '',
        user.password,
        user.role,
        user.user_type,
        user.account_name,
        user.phone || '',
        user.wa_jid || '',
        user.ai_provider || 'gemini',
        user.api_key || '',
        user.system_prompt || '',
        user.auto_reply,
        user.automation_access,
        user.status,
        user.qr || ''
      ]
    );
  } catch (err: any) {
    console.error('Failed to save user to Neon DB:', err.message);
  }
}

export async function updateUserAutomationInNeon(username: string, access: boolean): Promise<void> {
  if (!pool || !isConnected) return;
  try {
    await pool.query('UPDATE users SET automation_access = $1 WHERE LOWER(username) = $2', [access, username.toLowerCase()]);
  } catch (err: any) {
    console.error('Failed to update automation access in Neon DB:', err.message);
  }
}

export async function deleteUserFromNeon(username: string): Promise<void> {
  if (!pool || !isConnected) return;
  const clean = username.toLowerCase();
  try {
    // Delete all tenant products, leads, chats, and account from database
    await pool.query('DELETE FROM products WHERE LOWER(username) = $1', [clean]);
    await pool.query('DELETE FROM leads WHERE LOWER(username) = $1', [clean]);
    await pool.query('DELETE FROM customer_chats WHERE LOWER(username) = $1', [clean]);
    await pool.query('DELETE FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1', [clean]);
    console.log(`🗑️ [Neon DB] Completely wiped all database records for tenant @${clean}`);
  } catch (err: any) {
    console.error('Failed to delete tenant from Neon DB:', err.message);
  }
}

export async function unpairWhatsAppFromNeon(username: string): Promise<void> {
  if (!pool || !isConnected) return;
  const clean = username.toLowerCase();
  try {
    // Only clear WhatsApp session details from DB, keep user account intact
    await pool.query("UPDATE users SET wa_jid = '', phone = '', qr = '', status = 'Disconnected', linked_at = NULL WHERE LOWER(username) = $1", [clean]);
    console.log(`📱 [Neon DB] WhatsApp session wiped for @${clean}, user account kept active.`);
  } catch (err: any) {
    console.error('Failed to unpair WhatsApp in Neon DB:', err.message);
  }
}

// Purge chats with no activity for 5 days from Neon DB
export async function cleanupInactiveChatsInNeon(): Promise<number> {
  if (!pool || !isConnected) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM customer_chats WHERE created_at < NOW() - INTERVAL '5 days'`
    );
    const count = res.rowCount || 0;
    if (count > 0) {
      console.log(`🧹 [Neon DB] Purged ${count} inactive customer chat records older than 5 days.`);
    }
    return count;
  } catch (err: any) {
    console.error('Failed to cleanup 5-day inactive chats in Neon DB:', err.message);
    return 0;
  }
}

// Record a customer chat and enforce strict 10-message sliding window per customer phone
export async function recordCustomerChat(
  username: string,
  customerPhone: string,
  role: 'customer' | 'assistant',
  messageText: string
): Promise<void> {
  if (!pool || !isConnected) return;
  const cleanUser = username.toLowerCase();
  const cleanPhone = customerPhone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 13 || cleanPhone.startsWith('117') || cleanPhone.startsWith('223') || !messageText) return;

  try {
    // 1. Insert chat message
    await pool.query(
      `INSERT INTO customer_chats (username, customer_phone, role, message_text)
       VALUES ($1, $2, $3, $4)`,
      [cleanUser, cleanPhone, role, messageText]
    );

    // 2. Strict sliding window: delete anything older than last 10 messages for this customer phone
    await pool.query(
      `DELETE FROM customer_chats
       WHERE LOWER(username) = $1 AND customer_phone = $2 AND id NOT IN (
         SELECT id FROM customer_chats
         WHERE LOWER(username) = $1 AND customer_phone = $2
         ORDER BY id DESC
         LIMIT 10
       )`,
      [cleanUser, cleanPhone]
    );

    // 3. Trigger 5-day inactivity cleanup
    await cleanupInactiveChatsInNeon();
  } catch (err: any) {
    console.error('Failed to record customer chat in Neon DB:', err.message);
  }
}

// Get the last 10 chat messages for a specific customer phone (chronological order for AI context)
export async function getLast10Chats(
  username: string,
  customerPhone: string
): Promise<Array<{ id: number; role: string; message_text: string; created_at: string }>> {
  if (!pool || !isConnected) return [];
  const cleanUser = username.toLowerCase();
  const cleanPhone = customerPhone.replace(/\D/g, '');
  try {
    // Trigger 5-day inactivity cleanup
    await cleanupInactiveChatsInNeon();

    const res = await pool.query(
      `SELECT id, role, message_text, created_at
       FROM customer_chats
       WHERE LOWER(username) = $1 AND customer_phone = $2
       ORDER BY id ASC
       LIMIT 10`,
      [cleanUser, cleanPhone]
    );
    return res.rows.map(r => ({
      id: r.id,
      role: r.role,
      message_text: r.message_text,
      created_at: new Date(r.created_at).toISOString()
    }));
  } catch (err: any) {
    console.error('Failed to get last 10 chats from Neon DB:', err.message);
    return [];
  }
}

// Get list of active customer conversations for a tenant (most recent first)
export async function getCustomerConversations(
  username: string
): Promise<Array<{ customer_phone: string; last_message: string; last_role: string; last_time: string; total_count: number }>> {
  if (!pool || !isConnected) return [];
  const cleanUser = username.toLowerCase();
  try {
    // Trigger 5-day inactivity cleanup
    await cleanupInactiveChatsInNeon();

    const res = await pool.query(
      `SELECT customer_phone,
              (SELECT message_text FROM customer_chats c2 WHERE c2.username = c.username AND c2.customer_phone = c.customer_phone ORDER BY c2.id DESC LIMIT 1) as last_message,
              (SELECT role FROM customer_chats c2 WHERE c2.username = c.username AND c2.customer_phone = c.customer_phone ORDER BY c2.id DESC LIMIT 1) as last_role,
              MAX(created_at) as last_time,
              COUNT(*) as total_count
       FROM customer_chats c
       WHERE LOWER(username) = $1 
         AND LENGTH(customer_phone) >= 10 
         AND LENGTH(customer_phone) <= 13 
         AND customer_phone NOT LIKE '117%' 
         AND customer_phone NOT LIKE '223%' 
         AND customer_phone NOT LIKE '120363%'
       GROUP BY customer_phone, username
       ORDER BY MAX(created_at) DESC
       LIMIT 50`,
      [cleanUser]
    );
    return res.rows.map(r => ({
      customer_phone: r.customer_phone,
      last_message: r.last_message || '',
      last_role: r.last_role || 'customer',
      last_time: new Date(r.last_time).toISOString(),
      total_count: parseInt(r.total_count, 10)
    }));
  } catch (err: any) {
    console.error('Failed to get customer conversations from Neon DB:', err.message);
    return [];
  }
}

// Update password in Neon DB
export async function updateUserPasswordInNeon(username: string, passwordHash: string): Promise<boolean> {
  if (!pool || !isConnected) return false;
  const cleanUser = username.toLowerCase();
  try {
    const res = await pool.query('UPDATE users SET password = $1 WHERE LOWER(username) = $2', [passwordHash, cleanUser]);
    return (res.rowCount ?? 0) > 0;
  } catch (err: any) {
    console.error('Failed to update password in Neon DB:', err.message);
    return false;
  }
}

// Save OTP Code to Neon DB
export async function saveOtpToNeon(email: string, otpCode: string, expiresAt: Date): Promise<void> {
  if (!pool || !isConnected) return;
  const cleanEmail = email.trim().toLowerCase();
  try {
    await pool.query('DELETE FROM email_verifications WHERE LOWER(email) = $1', [cleanEmail]);
    await pool.query(
      'INSERT INTO email_verifications (email, otp_code, code, expires_at) VALUES ($1, $2, $2, $3)',
      [cleanEmail, otpCode, expiresAt]
    );
    console.log(`✉️ [Neon Auth] Saved 6-digit OTP verification code for ${cleanEmail}`);
  } catch (err: any) {
    console.error('Failed to save OTP to Neon DB:', err.message);
  }
}

// Verify OTP Code in Neon DB
export async function verifyOtpInNeon(email: string, otpCode: string): Promise<boolean> {
  if (!pool || !isConnected) return false;
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = otpCode.trim();
  try {
    const res = await pool.query(
      `SELECT id FROM email_verifications 
       WHERE LOWER(email) = $1 AND (otp_code = $2 OR code = $2) AND expires_at > NOW() 
       ORDER BY id DESC LIMIT 1`,
      [cleanEmail, cleanCode]
    );
    if (res.rows.length > 0) {
      await pool.query('DELETE FROM email_verifications WHERE LOWER(email) = $1', [cleanEmail]);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error('Failed to verify OTP in Neon DB:', err.message);
    return false;
  }
}
