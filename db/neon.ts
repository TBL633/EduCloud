import pg from 'pg';

const { Pool } = pg;

export interface User {
  id: number;
  username: string;
  email: string;
  password?: string;
  role: string;
  user_type: string;
  account_name: string;
  phone?: string;
  notification_phone?: string;
  wa_jid?: string;
  ai_provider?: string;
  ai_model?: string;
  model?: string;
  ai_temperature?: number;
  temperature?: number;
  api_key?: string;
  business_name?: string;
  business_type?: string;
  response_language?: string;
  store_policies?: string;
  system_prompt?: string;
  auto_reply?: boolean;
  automation_access?: boolean;
  status?: string;
  qr?: string;
  created_at?: string;
}

let pool: pg.Pool | null = null;
let dbConnected = false;

export function getPool(): pg.Pool | null {
  return pool;
}

export function isDbConnected(): boolean {
  return dbConnected;
}

export function getDbStatus() {
  return {
    connected: dbConnected,
    hasPool: Boolean(pool)
  };
}

export async function initNeonDatabase(memoryUsers?: Map<string, User>): Promise<boolean> {
  const rawUrl = (
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    'postgresql://neondb_owner:npg_NZblI4q5KayW@ep-rapid-paper-b3sxbxll-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'
  ).trim();

  const dbUrl = rawUrl
    .replace(/[?&]channel_binding=require/g, '')
    .replace(/\?&/, '?');

  try {
    pool = new Pool({
      connectionString: dbUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      ssl: { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    client.release();
    dbConnected = true;
    console.log('✅ Connected to Neon PostgreSQL database pool');

    // Clean up any legacy seeded mock newsletters from database
    try {
      await pool.query(`
        DELETE FROM newsletters 
        WHERE jid IN (
          '120363000000000001@newsletter',
          '120363000000000002@newsletter',
          '120363000000000003@newsletter'
        )
      `);
    } catch {}

    // Ensure full inventory management & store management columns exist on categories, products, users, and business_profiles tables
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          category_name VARCHAR(255) NOT NULL,
          category_image_url TEXT DEFAULT '',
          parent_id INT DEFAULT 0,
          parent_name TEXT DEFAULT '',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(username, category_name)
        );
        ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INT DEFAULT 0;
        ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_name TEXT DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sub_category TEXT DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sub_category_id INT DEFAULT 0;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INT DEFAULT 100;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INT DEFAULT 5;

        CREATE TABLE IF NOT EXISTS business_profiles (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE,
          tenant_slug VARCHAR(100) DEFAULT '',
          promotional_banners JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS promotional_banners JSONB DEFAULT '[]'::jsonb;

        ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'Kirana / General Store';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS store_slug VARCHAR(100) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS promotional_banners JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS tagline TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_color VARCHAR(50) DEFAULT 'emerald';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS announcement_bar TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS min_order_amount DOUBLE PRECISION DEFAULT 0.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS packaging_charge DOUBLE PRECISION DEFAULT 0.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_cod BOOLEAN DEFAULT true;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS paytm_vpa VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS paytm_mid VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS social_instagram VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS social_facebook VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS social_whatsapp VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS full_address TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS local_area TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION DEFAULT 0.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION DEFAULT 0.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS business_lat DOUBLE PRECISION DEFAULT 26.8467;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS business_lng DOUBLE PRECISION DEFAULT 80.9462;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS gstin_number VARCHAR(100) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_conditions TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS refund_policy TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_policy TEXT DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS max_delivery_radius_km DOUBLE PRECISION DEFAULT 15.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS free_delivery_radius_km DOUBLE PRECISION DEFAULT 3.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_charge_amount DOUBLE PRECISION DEFAULT 40.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS min_free_delivery_order DOUBLE PRECISION DEFAULT 499.0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS require_customer_location BOOLEAN DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS store_open_status BOOLEAN DEFAULT true;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS operating_hours VARCHAR(255) DEFAULT '9:00 AM - 10:00 PM';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_modes JSONB DEFAULT '["doorstep", "pickup"]'::jsonb;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255) DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS domain_status VARCHAR(50) DEFAULT 'not_configured';
      `);
    } catch (migErr) {
      console.warn('Notice running inventory & store schema migration:', migErr);
    }

    // Hydrate memoryUsers from Neon DB users table
    if (memoryUsers) {
      try {
        const res = await pool.query(`SELECT * FROM users ORDER BY id ASC`);
        for (const r of res.rows) {
          if (r.username) {
            memoryUsers.set(String(r.username).toLowerCase(), {
              id: r.id,
              username: r.username,
              email: r.email || '',
              password: r.password || '',
              role: r.role || 'user',
              user_type: r.user_type || 'business_user',
              account_name: r.account_name || r.business_name || r.username,
              phone: r.phone || '',
              notification_phone: r.notification_phone || '',
              wa_jid: r.wa_jid || '',
              ai_provider: r.ai_provider || 'gemini',
              ai_model: r.ai_model || 'gemini-1.5-flash',
              model: r.ai_model || 'gemini-1.5-flash',
              ai_temperature: r.ai_temperature ? parseFloat(r.ai_temperature) : 0.7,
              temperature: r.ai_temperature ? parseFloat(r.ai_temperature) : 0.7,
              api_key: r.api_key || '',
              business_name: r.business_name || r.account_name || '',
              business_type: r.business_type || 'Kirana / General Store',
              response_language: r.response_language || 'Hinglish',
              store_policies: r.store_policies || '',
              system_prompt: r.system_prompt || '',
              auto_reply: r.auto_reply !== false,
              automation_access: r.automation_access !== false,
              status: r.status || (r.wa_jid ? 'Connected' : 'Disconnected'),
              qr: r.qr || '',
              created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
            });
          }
        }
      } catch (err) {
        console.warn('Notice hydrating users from Neon DB:', err);
      }
    }

    return true;
  } catch (err) {
    console.warn('⚠️ Could not connect to Neon PostgreSQL pool, running in fallback mode:', err);
    dbConnected = false;
    return false;
  }
}

export async function findUserByIdentifier(identifier: string, memoryUsers?: Map<string, User>): Promise<User | null> {
  const cleanId = (identifier || '').trim().toLowerCase();
  if (!cleanId) return null;

  if (pool) {
    try {
      const res = await pool.query(
        `SELECT id, username, email, password, role, user_type, account_name, phone, notification_phone, wa_jid, ai_provider, ai_model, ai_temperature, api_key, business_name, business_type, response_language, store_policies, system_prompt, auto_reply, automation_access, status, qr, created_at 
         FROM users 
         WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1) 
         LIMIT 1`,
        [cleanId]
      );
      if (res.rows.length > 0) {
        const u = res.rows[0] as User;
        if (memoryUsers && u.username) {
          memoryUsers.set(u.username.toLowerCase(), u);
        }
        return u;
      }
    } catch (err) {
      console.warn('findUserByIdentifier DB query error:', err);
    }
  }

  if (memoryUsers) {
    for (const u of memoryUsers.values()) {
      if (u.username.toLowerCase() === cleanId || (u.email && u.email.toLowerCase() === cleanId)) {
        return u;
      }
    }
  }
  return null;
}

export async function saveUserToNeon(userData: Partial<User>): Promise<User | null> {
  if (!pool) return null;
  try {
    const {
      username,
      email = '',
      password = '',
      role = 'user',
      user_type = 'business_user',
      account_name = '',
      phone = '',
      notification_phone = '',
      ai_provider = 'gemini',
      api_key = '',
      system_prompt = '',
      auto_reply = true,
      automation_access = true
    } = userData;

    const res = await pool.query(
      `INSERT INTO users (username, email, password, role, user_type, account_name, phone, notification_phone, ai_provider, api_key, system_prompt, auto_reply, automation_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password = CASE WHEN EXCLUDED.password != '' THEN EXCLUDED.password ELSE users.password END,
         role = EXCLUDED.role,
         user_type = EXCLUDED.user_type,
         account_name = EXCLUDED.account_name,
         phone = EXCLUDED.phone,
         notification_phone = EXCLUDED.notification_phone,
         ai_provider = EXCLUDED.ai_provider,
         api_key = EXCLUDED.api_key,
         system_prompt = EXCLUDED.system_prompt,
         auto_reply = EXCLUDED.auto_reply,
         automation_access = EXCLUDED.automation_access
       RETURNING *`,
      [username, email, password, role, user_type, account_name, phone, notification_phone, ai_provider, api_key, system_prompt, auto_reply, automation_access]
    );

    return res.rows[0] as User;
  } catch (err) {
    console.error('saveUserToNeon error:', err);
    return null;
  }
}

export async function updateUserAutomationInNeon(
  username: string,
  updates: boolean | { auto_reply?: boolean; automation_access?: boolean; ai_provider?: string; api_key?: string; system_prompt?: string }
): Promise<boolean> {
  if (!pool) return false;
  try {
    if (typeof updates === 'boolean') {
      await pool.query(
        `UPDATE users SET automation_access = $1 WHERE LOWER(username) = LOWER($2)`,
        [updates, username]
      );
      return true;
    }

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.auto_reply !== undefined) {
      fields.push(`auto_reply = $${idx++}`);
      values.push(updates.auto_reply);
    }
    if (updates.automation_access !== undefined) {
      fields.push(`automation_access = $${idx++}`);
      values.push(updates.automation_access);
    }
    if (updates.ai_provider !== undefined) {
      fields.push(`ai_provider = $${idx++}`);
      values.push(updates.ai_provider);
    }
    if (updates.api_key !== undefined) {
      fields.push(`api_key = $${idx++}`);
      values.push(updates.api_key);
    }
    if (updates.system_prompt !== undefined) {
      fields.push(`system_prompt = $${idx++}`);
      values.push(updates.system_prompt);
    }

    if (fields.length === 0) return true;

    values.push(username);
    const query = `UPDATE users SET ${fields.join(', ')} WHERE LOWER(username) = LOWER($${idx})`;
    await pool.query(query, values);
    return true;
  } catch (err) {
    console.error('updateUserAutomationInNeon error:', err);
    return false;
  }
}

export async function deleteUserFromNeon(username: string): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(`DELETE FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
    return true;
  } catch (err) {
    console.error('deleteUserFromNeon error:', err);
    return false;
  }
}

export async function unpairWhatsAppFromNeon(username: string): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(`UPDATE users SET status = 'Disconnected', qr = '', wa_jid = '' WHERE LOWER(username) = LOWER($1)`, [username]);
    await pool.query(`DELETE FROM tenant_whatsapp_sessions WHERE LOWER(username) = LOWER($1)`, [username]);
    return true;
  } catch (err) {
    console.error('unpairWhatsAppFromNeon error:', err);
    return false;
  }
}

export async function recordCustomerChat(username: string, customerPhone: string, role: string, messageText: string): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO customer_chats (username, customer_phone, role, message_text)
       VALUES ($1, $2, $3, $4)`,
      [username, customerPhone, role, messageText]
    );
  } catch (err) {
    console.error('recordCustomerChat error:', err);
  }
}

export async function getLast10Chats(username: string, customerPhone: string): Promise<Array<{ id: number; role: string; message_text: string; created_at: string }>> {
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT id, role, message_text, created_at
       FROM customer_chats
       WHERE LOWER(username) = LOWER($1) AND customer_phone = $2
       ORDER BY id DESC
       LIMIT 10`,
      [username, customerPhone]
    );
    return res.rows.reverse();
  } catch (err) {
    console.error('getLast10Chats error:', err);
    return [];
  }
}

export async function getCustomerConversations(username: string): Promise<Array<{ customer_phone: string; last_message: string; last_role: string; last_time: string; updated_at: string; total_count: number }>> {
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT customer_phone,
              message_text as last_message,
              role as last_role,
              created_at as last_time,
              created_at as updated_at,
              CAST(cnt AS INT) as total_count
       FROM (
         SELECT customer_phone, message_text, role, created_at,
                ROW_NUMBER() OVER (PARTITION BY customer_phone ORDER BY id DESC) as rn,
                COUNT(*) OVER (PARTITION BY customer_phone) as cnt
         FROM customer_chats
         WHERE LOWER(username) = LOWER($1)
       ) t
       WHERE rn = 1
       ORDER BY created_at DESC`,
      [username]
    );
    return res.rows;
  } catch (err) {
    console.error('getCustomerConversations error:', err);
    return [];
  }
}

export async function updateUserPasswordInNeon(username: string, newPasswordHash: string): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(`UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2)`, [newPasswordHash, username]);
    return true;
  } catch (err) {
    console.error('updateUserPasswordInNeon error:', err);
    return false;
  }
}

export async function saveOtpToNeon(email: string, otpCode: string, expiresAt: Date): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO email_verifications (email, otp_code, expires_at) VALUES ($1, $2, $3)`,
      [email.toLowerCase(), otpCode, expiresAt]
    );
    return true;
  } catch (err) {
    console.error('saveOtpToNeon error:', err);
    return false;
  }
}

export async function verifyOtpInNeon(email: string, otpCode: string): Promise<boolean> {
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT id FROM email_verifications 
       WHERE LOWER(email) = LOWER($1) AND otp_code = $2 AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [email, otpCode]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('verifyOtpInNeon error:', err);
    return false;
  }
}
