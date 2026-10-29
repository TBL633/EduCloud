package database

import (
	"database/sql"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"golang.org/x/crypto/bcrypt"
)

var DB *sql.DB

// GetDBURL returns the resolved Neon/PostgreSQL connection string with sslmode=require
func GetDBURL() string {
	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dbURL == "" {
		dbURL = strings.TrimSpace(os.Getenv("NEON_DATABASE_URL"))
	}
	if dbURL == "" {
		dbURL = strings.TrimSpace(os.Getenv("POSTGRES_URL"))
	}
	if dbURL == "" {
		dbURL = strings.TrimSpace(os.Getenv("DATABASE_PUBLIC_URL"))
	}
	if dbURL != "" {
		// Strip PgBouncer pooler suffix to bypass transaction pooling prepared statement errors in lib/pq
		if strings.Contains(dbURL, "-pooler.") {
			dbURL = strings.ReplaceAll(dbURL, "-pooler.", ".")
		}
		if strings.Contains(dbURL, "-pooler-") {
			dbURL = strings.ReplaceAll(dbURL, "-pooler-", "-")
		}
		if !strings.Contains(dbURL, "sslmode=") {
			if strings.Contains(dbURL, "?") {
				dbURL += "&sslmode=require"
			} else {
				dbURL += "?sslmode=require"
			}
		}
	}
	return dbURL
}

// InitDB initializes a memory-optimized Neon PostgreSQL connection pool
// Specifically configured for Render 512MB RAM free tier hosting 100+ WhatsApp accounts
func InitDB() {
	dbURL := GetDBURL()

	if dbURL == "" {
		log.Println("⚡ Running in Zero-Config Embedded Mode (Awaiting DATABASE_URL for Neon DB)")
		return
	}

	var err error
	DB, err = sql.Open("postgres", dbURL)
	if err != nil {
		log.Printf("⚠️ Notice: Database open error: %v", err)
		return
	}

	// =========================================================================
	// MEMORY-CONSTRAINED CONNECTION POOL TUNING (RENDER 512MB RAM OPTIMIZATION)
	// =========================================================================
	// With 100+ WhatsApp client routines, database connections must be strictly bounded.
	// PgBouncer pooler mode on Neon handles query multiplexing.
	DB.SetMaxOpenConns(8)                      // Max 8 active TCP connections to Neon
	DB.SetMaxIdleConns(3)                      // Max 3 idle connections in pool to save RAM
	DB.SetConnMaxLifetime(10 * time.Minute)    // Recycle connections periodically
	DB.SetConnMaxIdleTime(2 * time.Minute)     // Close idle connections quickly to free heap

	// Retry ping up to 3 times to allow Neon Serverless cold compute to wake up
	pingSuccess := false
	for attempt := 1; attempt <= 3; attempt++ {
		if err = DB.Ping(); err == nil {
			pingSuccess = true
			break
		}
		log.Printf("⏳ Neon DB cold-start ping attempt %d/3: %v", attempt, err)
		time.Sleep(1 * time.Second)
	}

	if pingSuccess {
		log.Println("✅ Neon Cloud PostgreSQL & Object Database Connected Successfully (Pool: Max 8 Conns)")
	} else {
		log.Println("⚠️ Neon DB ping pending/cold start. Keeping DB connection pool open for async query wake-up.")
	}

	// Auto-Migrate Core Tables
	migrateSchema()
}

func migrateSchema() {
	if DB == nil {
		return
	}

	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
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
			auto_reply BOOLEAN DEFAULT true,
			automation_access BOOLEAN DEFAULT true,
			status VARCHAR(50) DEFAULT 'Disconnected',
			qr TEXT DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(50) DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type VARCHAR(50) DEFAULT 'business_user';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_name VARCHAR(255) DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Disconnected';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS qr TEXT DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_jid VARCHAR(100) DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(50) DEFAULT 'gemini';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_model VARCHAR(100) DEFAULT 'gemini-1.5-flash';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_temperature NUMERIC(3, 1) DEFAULT 0.7;`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT '';`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS import_catalog_details BOOLEAN DEFAULT true;`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_reply BOOLEAN DEFAULT true;`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS automation_access BOOLEAN DEFAULT true;`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;`,
		`CREATE TABLE IF NOT EXISTS email_verifications (
			id SERIAL PRIMARY KEY,
			email VARCHAR(255) NOT NULL,
			otp_code VARCHAR(20) DEFAULT '',
			code VARCHAR(20) DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes'
		);`,
		`ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS otp_code VARCHAR(20) DEFAULT '';`,
		`ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS code VARCHAR(20) DEFAULT '';`,
		`ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes';`,
		`CREATE TABLE IF NOT EXISTS products (
			id SERIAL PRIMARY KEY,
			username VARCHAR(100) NOT NULL,
			name VARCHAR(255) NOT NULL,
			price VARCHAR(100) NOT NULL,
			description TEXT DEFAULT '',
			ai_tag VARCHAR(50) DEFAULT '',
			item_type VARCHAR(50) DEFAULT 'product',
			unit_type VARCHAR(50) DEFAULT 'custom',
			variants JSONB DEFAULT '[]'::jsonb,
			whatsapp_catalog_link TEXT DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_tag VARCHAR(50) DEFAULT '';`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'product';`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(50) DEFAULT 'custom';`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb;`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS whatsapp_catalog_link TEXT DEFAULT '';`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';`,
		`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data TEXT DEFAULT '';`,
		`CREATE TABLE IF NOT EXISTS customer_chats (
			id SERIAL PRIMARY KEY,
			username VARCHAR(100) NOT NULL,
			customer_phone VARCHAR(50) NOT NULL,
			role VARCHAR(50) NOT NULL,
			message_text TEXT NOT NULL,
			sender_type VARCHAR(20) DEFAULT 'incoming',
			incoming_msg TEXT DEFAULT '',
			outgoing_msg TEXT DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`,
		`ALTER TABLE customer_chats ADD COLUMN IF NOT EXISTS sender_type VARCHAR(20) DEFAULT 'incoming';`,
		`ALTER TABLE customer_chats ADD COLUMN IF NOT EXISTS incoming_msg TEXT DEFAULT '';`,
		`ALTER TABLE customer_chats ADD COLUMN IF NOT EXISTS outgoing_msg TEXT DEFAULT '';`,
		`CREATE INDEX IF NOT EXISTS idx_chats_usr_ph ON customer_chats(username, customer_phone, id DESC);`,
		`CREATE TABLE IF NOT EXISTS leads (
			id SERIAL PRIMARY KEY,
			username VARCHAR(100) NOT NULL,
			customer_phone VARCHAR(50) NOT NULL,
			inquiry_text TEXT DEFAULT '',
			status VARCHAR(50) DEFAULT 'Captured',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS campaigns (
			id VARCHAR(100) PRIMARY KEY,
			username VARCHAR(100) NOT NULL,
			message TEXT NOT NULL,
			image_url TEXT DEFAULT '',
			use_anti_ban BOOLEAN DEFAULT true,
			status VARCHAR(50) DEFAULT 'pending',
			total_count INT DEFAULT 0,
			sent_count INT DEFAULT 0,
			failed_count INT DEFAULT 0,
			start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			end_time TIMESTAMP WITH TIME ZONE
		);`,
		`CREATE TABLE IF NOT EXISTS campaign_logs (
			id SERIAL PRIMARY KEY,
			campaign_id VARCHAR(100) NOT NULL,
			phone VARCHAR(50) NOT NULL,
			status VARCHAR(50) NOT NULL,
			note TEXT DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_products_usr ON products(username);`,
		`CREATE INDEX IF NOT EXISTS idx_leads_usr ON leads(username);`,
	}

	for _, q := range queries {
		if _, err := DB.Exec(q); err != nil {
			log.Printf("Schema exec note: %v", err)
		}
	}

	createDefaultAdmin()
}

func createDefaultAdmin() {
	if DB == nil {
		return
	}
	adminUser := "admin"

	var exists bool
	_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE username=$1)", adminUser).Scan(&exists)
	if !exists {
		hashedPass := []byte("admin123")
		_, err := DB.Exec(`INSERT INTO users (username, email, password, role, user_type, account_name, automation_access)
			VALUES ($1, $2, $3, 'admin', 'admin', 'Master Administrator', true)`,
			adminUser, "admin@eduta.ai", string(hashedPass))
		if err == nil {
			log.Println("👑 Master Admin initialized in Neon DB.")
		}
	}
}
