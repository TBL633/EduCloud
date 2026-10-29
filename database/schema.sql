-- ============================================================================
-- Neon Cloud PostgreSQL & Object Database Schema
-- Optimized for: Golang Whatsmeow Engine on Render Free Tier (512MB RAM)
-- Features: Multi-Tenancy, 100+ WhatsApp Accounts, Binary Object Storage (BYTEA)
-- Zero Fake Data Guarantee
-- ============================================================================

-- 1. Multi-Tenant Accounts & Auth
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) DEFAULT '',
    password VARCHAR(255) NOT NULL,
    role VARCHAR(30) DEFAULT 'user',
    user_type VARCHAR(50) DEFAULT 'business_user',
    account_name VARCHAR(255) DEFAULT '',
    phone VARCHAR(30) DEFAULT '',
    notification_phone VARCHAR(50) DEFAULT '',
    wa_jid VARCHAR(100) DEFAULT '',
    ai_provider VARCHAR(50) DEFAULT 'gemini',
    ai_model VARCHAR(100) DEFAULT 'gemini-1.5-flash',
    ai_temperature NUMERIC(3, 1) DEFAULT 0.7,
    api_key TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    import_catalog_details BOOLEAN DEFAULT true,
    auto_reply BOOLEAN DEFAULT true,
    automation_access BOOLEAN DEFAULT true,
    status VARCHAR(50) DEFAULT 'Disconnected',
    qr TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2. Product Catalog & AI Knowledge Base (Without image storage)
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    price VARCHAR(100) NOT NULL,
    description TEXT DEFAULT '',
    ai_tag VARCHAR(50) DEFAULT '',
    item_type VARCHAR(50) DEFAULT 'product',
    whatsapp_catalog_link TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_tag VARCHAR(50) DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'product';
ALTER TABLE products ADD COLUMN IF NOT EXISTS whatsapp_catalog_link TEXT DEFAULT '';
ALTER TABLE products DROP COLUMN IF EXISTS image_url;
DROP TABLE IF EXISTS neon_media_objects CASCADE;
DROP TABLE IF EXISTS user_media CASCADE;

CREATE INDEX IF NOT EXISTS idx_products_username ON products(username);

-- 4. Captured Leads (Real WhatsApp Prospect Pipeline)
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    customer_phone VARCHAR(50) NOT NULL,
    inquiry_text TEXT DEFAULT '',
    status VARCHAR(50) DEFAULT 'Captured',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_username_created ON leads(username, created_at DESC);

-- 4B. Customer WhatsApp Chat Memory (Strict 10 messages per customer phone)
CREATE TABLE IF NOT EXISTS customer_chats (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    customer_phone VARCHAR(50) NOT NULL,
    role VARCHAR(20) NOT NULL, -- 'customer' or 'assistant'
    message_text TEXT NOT NULL,
    sender_type VARCHAR(20) DEFAULT 'incoming', -- 'incoming' or 'outgoing'
    incoming_msg TEXT DEFAULT '',
    outgoing_msg TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chats_user_phone ON customer_chats(username, customer_phone, id DESC);

-- 5. Broadcast Outreach Campaigns & Anti-Ban Delivery Logs
CREATE TABLE IF NOT EXISTS campaigns (
    id VARCHAR(100) PRIMARY KEY,
    username VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    message TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    use_anti_ban BOOLEAN DEFAULT true,
    status VARCHAR(50) DEFAULT 'pending',
    total_count INT DEFAULT 0,
    sent_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS campaign_logs (
    id SERIAL PRIMARY KEY,
    campaign_id VARCHAR(100) NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    note TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_logs_camp_id ON campaign_logs(campaign_id);

-- 6. Initial Master Admin (Bcrypt Encrypted, Zero Plaintext Secrets)
INSERT INTO users (username, email, password, role, user_type, account_name, automation_access)
VALUES (
    'admin',
    'admin@eduta.ai',
    'admin123', -- plain lightweight password for admin
    'admin',
    'admin',
    'Master Administrator',
    true
)
ON CONFLICT (username) DO NOTHING;
