package whatsapp

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"wa-server/payment"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var (
	StoreContainer *sqlstore.Container
	ActiveClients  = make(map[string]*whatsmeow.Client)
	QRChannelMap   = make(map[string]string)
	ClientsLock    sync.Mutex
	DB             *sql.DB

	// 0ms In-Memory LID-to-RealPhone & Phone-to-JID Mappings
	lidToPnRAM   = make(map[string]string)
	phoneToJID   = make(map[string]types.JID)
	lidCacheLock sync.RWMutex

	// In-Flight Per-Customer AI Concurrency Lock (prevents overlapping replies until reply delivers)
	customerInFlightMap  = make(map[string]bool)
	customerInFlightLock sync.Mutex

	// Live Chat Listeners (Browser SSE channels per user)
	LiveChatStreams = make(map[string]chan map[string]string)
	StreamLock      sync.Mutex

	// Smart Human-Override: Tracks Message ID -> true when read by human business owner (Read Receipt Race Condition)
	MessageReadByHuman sync.Map

	// Universal Static JPEG Thumbnail (loaded in memory on startup, zero on-the-fly resizing)
	UniversalThumbnail []byte
)

func init() {
	// WaMart Scan & Pay Official Universal Baseline JPEG Thumbnail (~3.8KB, zero CPU runtime overhead)
	const universalThumbnailBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAsICAoIBwsKCQoNDAsNERwSEQ8PESIZGhQcKSQrKigkJyctMkA3LTA9MCcnOEw5PUNFSElIKzZPVU5GVEBHSEX/2wBDAQwNDREPESESEiFFLicuRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUX/wAARCACQAGADASIAAhEBAxEB/8QAHAAAAQUBAQEAAAAAAAAAAAAAAwIEBQYHAAEI/8QAPhAAAgEDAwEFBQMKBgMBAAAAAQIDAAQRBRIhMQYTQVFxFCIzYZEyc4EHFRcjQlJTocHSFiRDk7HwRFSC4f/EABoBAAIDAQEAAAAAAAAAAAAAAAABAgMEBQb/xAAtEQACAgEDAwEFCQAAAAAAAAAAAQIRAwQhMRIUQVETYYGRsQUyUnGhwdHh8P/aAAwDAQACEQMRAD8Ardt1FSUl3FaQb5W9AOpPyqD9rW3X95/AU0kmkuH3ytk+Hy9K9nlypKlyeeWFzdvgLd3cl3KXfgDoo6AVJ22hqywx3T91NcMVXMyKE6AZB5bJPIGMetRCKGdQxwpIBPkKtUJsGM/5xs43Z5nAkE0Y/VMc7h73UYGPka5eqzTxR6oxcvy5/Y34YRe3BXF065e6W2hTv5WXeohO7cMZJH4A/SuXTL1kR1tZSrxNOrbeDGvVvQVKzao1trFjqMfdGeGUt3cLBgEDe6vHH2SR+FSVx2zs5YJbeOzkSESJHAFYBo7bKF0znqSg8+pprJlaT6R9MLe5VIbO4uI5pIYXdIF3ysozsXzPyrprO4t44XmheNZ03xlhjevmPlVyuO29urSSQWs0jtEsLmcDEi96WKtyTgoSvWk2vbi29pt7m5t51khj7sLCRtC97uCYyMjZhefLoaPaZeekOiHqU6GCacsIY3kKKXbaM4Uck+gpcUoHXirNF2xSK7gWP2qCzS0lgKQ7Qys7MQ6jpwCvXyqp5yT16+NX4pzt2qKpxjWzJWCUHxFPFlRVyzAD5moFTxT/AE6y9okEko/VDw/e/wDytkZsxZMUeWyJxzShU92X7LT9otZkspGa2jtxm4Yr7y842geef+DWhD8lehADM18T596v9tcueqx4nTOnHFKStGQUqKPvZAgKqT4scAVr36K9C/i33+6P7a79Fehfxb7/AHR/bVff4vePt5mWRC50q4juB3e/JUAsGHIwc4PTmnQvby9tZY0iswuSrYVVJyPAnw48Kvv+AOyYDE39yu1ip3TqMEZ81+Rr0fk+7KGYw+33PeAhdpnXqf8A5pPVY3u0/kNYZLyUWbVdSiea5kW2AldWkQBSGO3AO3Pyz60wkV9RvZXAhi6ZAICqOn/fWtGXsH2SZmUX92CoBbMoGATgH7PjkfWiH8nvZUMFOoXG44wPaU54z+75ULVY48J/IbxSfkyuSPupGQspI8VOQaRmtg/RXoP8W+/3l/tpS/kt0Jekl7n70f201rsXvI9vIyWCIEgydPKpaGbaK0b9GOiAcTXoPn3q/wBtUXtNoMnZrUhbmTvYZV3xSEYJGcEH5it+m1mHI+iPJkz6aaXUzW7TS7W31e7v4U2T3KIsuOj7c4PrzipKgxfFf0FGry8nbOygcshjUbRlmIUAnHNR51q1W4MBvLQSh9hUufteXrT6frF94P61nepqbTtBeXgjlJgm4Zs92y7jITwcYBxk4B529eaOEItUuq6LGizy3OlBXXvRIWGCD+1ny+dOWu7Abnd7DKEEkkZU5wP+BVBR9jvaaYto8IaKFWSbJ7o7yN2c+LNlemOuTkU2uXMOnSTQTNbyPcq0RUFA65wzRtyT128eHHOafUwo0eSfT7aCSSRtPji6sxIAOTn8eaRJNpiYkdtPGdjhieeoCn0yAKoMKTe03Ld2tuVbYzXCmQSRPgkEnxQsCAAAoJ58KSrRR3Mfscqz3C25/WOhTvUwGIc427QCQPkVzzR1MKNFOuWizCI3tp3hIG3eep6D8cipGKQyKdwwykqQPOsss7ywu7+ymjleFXmSOPvCFV8uqtt9/wB45TyJGfpqNv1l+8NLlAGqr9qOyg7SalYPPcGK2t1feqD33yRwPAdOtWigyfFX0NSxTlCXVHkJJSVM6L4r+go1Bi+K/oKNUHyNAZ+sX3g/rWb6pezv2wnhlZijySW6yS5jg+ypAJXxHugnGTnHArSJ+sX3g/rWcdpLxm13ULVJS8ae6iHuz3btt5O7Pu7j169eMDNPwHkj7y1SAuLSM2wSRil5sLFjtA4Kj3hkKdgAGGzzivbq3gvrCOW8vGkXam/HukuhO1VQjPAyuSM4wCN2afOr2unJax3sECqxgku71nDLIAxDc4AwV908Y48zUJqHcXSX8Mc9zDcTyqs0bAsrDcivvkkJ2t0PHHTBPJpATl5Beade3DWJEkY2TMk4CnI2q+CMgkhcEYO0cimOy406C2tI4zHPdRGa5t5Sf1iqQm0SLxhgSOfEqMAgUXTLsC0msEspLju2klghu1LsICMM2AM4B4CjPXOMrTJ2NtqRhsTNFp0cSyQ2swBEmB9pORyMDPPDeFAD3SNQuBe6aZXgWO6cHuW95VcMvvbhwpyBkA8kjIOa1CDrL94azPTZZBrzSXV0kbT3CPcRsVbfJvCjYF6DaoDZ8do61plv1l+8NPww8hqDJ8VPQ0agyfFX0NKPIM6L4r+go1Bi+K/oKNQ+QQGfrF94P61mmqWbwdotUub1FktDMzHu5dr/AGQwGQfd4BG4fIYzitLn6xfeD+tZ3rMyT65fRoJEm3HYwztTDFdw4xkkeeeh6jl+A8ka5fULORo8FLtAIgvuFINrbNxI94gkgFvJs+BpUtvZ2mrTe1yhIp4JHjliLzxxqoKgebLkgnI4PAwKfaVa/wCcM0ET3N2yBbuSQhhBnpmM8sNoA+fXJPNMrhFbRUN28U2oxxB0kLHgbiMopxjC7sgA8lcnaAaQDx5BcwQtLc3D3D/5hRNC22VyoBiBGCGKknbjADDjg01vZY73TILextkslMbtGJikpROFZI3Y4Cg4yPkMdTTV5bg3d3bXN7I99Hl4RcIqLIu9Ay7ScAnG7IwK6yhjkimtrpo47W6fCGdTKIsFgEXOCo2jxzwSaAJHTbi5XULHUJrgK8cxVgXAB3uI+7KDwGM8cZZetaVb9ZfvDWX6Yb9NZ0+R4TOIGW1meS3Me4F+NrHqAFDDnjauOpB1C36y/eGn4YeQ1Bk+KvoaNQZPip6GlHkGdF8V/QUagxnEjn5Cm1xevDcxxCGSTepOVzwQD8vl/MU3yCHkkfeLjOCCCCPA0yOkWzTGZre1MpbcXNuMk+efOl29205YGKWJk6hxx+B8ai7jtFJB2iTSxaO6kL74J3HKltwGMFRjBOepqcISlsvAVY4ePT7KT2Rktot6qu0WuFYchRxx58fOgpJpAlmZBaqxjKyP7JjK9CCfEeGKfJfmRkU2t2Nx53RcL680jUdTbTljItLq535z7Ou7bjHX1zTS8V9P4IvYbPJpZWMFbeQEFFAtN2BjaRjwG0AH5cUW2OnzSw21s1qXtMmJFtwO6xwdvl1xxR7O+N1/408GV3/rFx18PWkTak0N28QtJ3CjJkUDB4zj5+VDVbNfQUWpboP+bYvaPaO6tu+4HedwN3HTn5U6jj7tSM5JJJPmaY22oNcuqezTx5XcS4GB8utIuNTeCdohZXkuOjxqpVvTmq2yaRKUGT4q+hppBqDyyIptLqLd4yIML6807c5kQ/KhLcGdF8V/QUvYPI/WkRfFf0FFofIITsHkfrXbB5H60qupWMaz3dtbOElfaTyeRwPM0ZdjKGVgVYZBB4NVfW+z9xeatJdMsMsTgbQVZimB5Dz4+lODpEdzpdrp92bjvLfJMkUe0OMHI9Dn6irnGNLf/f1xvRUpSt2ixYX/AKa7aMeP1qrf4bt3C97PqbovAXG3B2kMePPLZ880a37ORTRyxvdX2zaAiyjaq424IH/yB+NLph+L9CVv0LHsHz+tdsHkfrSq6qrJidg8v50iT4iehotCk+Kvoaa5EzxPtSY/dqPvpLpHUW4OCOMLn3s+PHT6ePNSCnaZD5LTbvX8/wCVWQ2dkJcAZpbpLghFUxDH+kzE+fINJhuLvvUWaIbT1KRN/Wl3F1JDFuXBJIA3cAetBXUm7hZGikcEkExJuAx4+f8A01Youroj1K6H0hZY3KAMwBIB8TTQS3q2duzRr37LmUbS2D+FJGpMc/5e6GB4w15+dGAXNvdZYdO5pKLqqC97CI186qw9nGeqsjgj+dOIe+2HvzGWzx3YOMfjQI7x5FJCSJjHDptzmqV2i7bapYdo202z9mgjQqpkuEznIB3ZzwOf5VOGKWR0gc1HdlzuJ7lL+JI1Ji93cNpO7JweccYrpprxZHEaoVz7v6pjx8yDVKi7V65K8i/nLTl2SMuTAMEAZBHvc5+XSpPsV2rvu0KXa3scYeDaRJGuAQc8EefFTlhko3S2Iqaui0wTNIArxyK4HJKELn5Zp032o/Sm3ev5/wAhTkksYz5rmsrW5aij6d2vmsAsV+rTIvAlXlgPIjx/5qx2OuadqZxaSwO5/wBMsVb6Gsrm1F3H6yNT8xxTCS65yqYI6c16PJ9nY57/AHX7uDjYdVliqe6NyK5BBgT5gk0iWWO2hMkyQxRL1Z32qPxNY7D23160hMUN82zGB3ihyvoTULfane6nL3l9dTXDeHeOTj0HQVzuwkpU5bfE39wmrSNbu+3eg2hKiUTkfwFLD68CmB/KdowPFjcn8B/dWXpcKqBWt4nx+02c/wAjSluYxIjG2jAVs+7nn6mre0xpcP5kPbSNN/Sfo/8A6F19F/uocnbjstqMitfaaWYDAaa3D4Hrkms+/OUIklb8328iuQQJckrjyIIoVxfRTxlVsbaFj+1GGB/DJ4pR00PRr4j9q/U1ixn7H6kQLW30hnP7DxqjfRgKsNtZwWkWy0sYIYyc4iXaD8+K+e/WnEV1cImxJ5VT90OQPpQ9E5OlIFnrwbfqOv6fpYPftE0vhFG25j+Hh+NVm67R3urOwz7PAf8ATQ8kfM1n8M0o6SGnySSuuHkYjyJrdh0GOCvl+rMGo1GSW10j/9k="
	decoded, err := base64.StdEncoding.DecodeString(universalThumbnailBase64)
	if err == nil && len(decoded) > 0 {
		UniversalThumbnail = decoded
	}
}

// formatQuotedWhatsAppMessage prepends a clean WhatsApp italic blockquote (> _"..."_) of the customer's message
func formatQuotedWhatsAppMessage(customerMsg, aiReply string) string {
	cleanCustomer := strings.TrimSpace(customerMsg)
	cleanReply := strings.TrimSpace(aiReply)
	if cleanReply == "" {
		return ""
	}
	if cleanCustomer == "" {
		return cleanReply
	}

	// Avoid duplicate blockquotes if already present
	if strings.HasPrefix(cleanReply, ">") {
		return cleanReply
	}

	// If customer sent a catalog order, make the quote block clean and readable
	quoteSnippet := cleanCustomer
	if strings.HasPrefix(cleanCustomer, "[WhatsApp Catalog Order]:") {
		quoteSnippet = strings.TrimPrefix(cleanCustomer, "[WhatsApp Catalog Order]:")
		if idx := strings.Index(quoteSnippet, " | WhatsApp Catalog Link:"); idx != -1 {
			quoteSnippet = quoteSnippet[:idx]
		}
		quoteSnippet = "Catalog Order: " + strings.TrimSpace(quoteSnippet)
	} else if strings.HasPrefix(cleanCustomer, "[WhatsApp Catalog Product Inquiry]:") {
		quoteSnippet = strings.TrimPrefix(cleanCustomer, "[WhatsApp Catalog Product Inquiry]:")
		if idx := strings.Index(quoteSnippet, " | WhatsApp Catalog Link:"); idx != -1 {
			quoteSnippet = quoteSnippet[:idx]
		}
		quoteSnippet = "Catalog Inquiry: " + strings.TrimSpace(quoteSnippet)
	}

	// Flatten newlines into a compact single-line quote snippet
	quoteSnippet = strings.ReplaceAll(quoteSnippet, "\r\n", " ")
	quoteSnippet = strings.ReplaceAll(quoteSnippet, "\n", " ")
	quoteSnippet = strings.Join(strings.Fields(quoteSnippet), " ")

	runes := []rune(quoteSnippet)
	if len(runes) > 95 {
		quoteSnippet = string(runes[:92]) + "..."
	}

	return fmt.Sprintf("> _\"%s\"_\n\n%s", quoteSnippet, cleanReply)
}

// LoadLIDMapCache loads all LID -> Real Phone Number mappings from Neon DB into 0ms RAM
func LoadLIDMapCache() {
	if DB == nil {
		return
	}
	rows, err := DB.Query("SELECT lid, pn FROM whatsmeow_lid_map WHERE pn != ''")
	if err != nil {
		return
	}
	defer rows.Close()

	lidCacheLock.Lock()
	count := 0
	for rows.Next() {
		var lid, pn string
		if err := rows.Scan(&lid, &pn); err == nil && lid != "" && pn != "" {
			lidToPnRAM[lid] = pn
			count++
		}
	}
	lidCacheLock.Unlock()

	if count > 0 {
		log.Printf("⚡ [RAM Cache]: Loaded %d LID-to-RealPhone mappings for instant 0ms number resolution.", count)
	}
}

// GetRealPhoneFromLID resolves a LID (e.g. 117..., 100...) to a real phone number
func GetRealPhoneFromLID(lid string) string {
	cleanLID := regexp.MustCompile(`\D`).ReplaceAllString(lid, "")
	if cleanLID == "" {
		return ""
	}

	lidCacheLock.RLock()
	pn, exists := lidToPnRAM[cleanLID]
	lidCacheLock.RUnlock()

	if exists && pn != "" {
		return FormatPhone(pn)
	}

	// Fallback: Query Neon DB whatsmeow_lid_map directly on cache miss
	if DB != nil {
		var dbPN string
		err := DB.QueryRow("SELECT pn FROM whatsmeow_lid_map WHERE lid = $1 LIMIT 1", cleanLID).Scan(&dbPN)
		if err == nil && dbPN != "" {
			lidCacheLock.Lock()
			lidToPnRAM[cleanLID] = dbPN
			lidCacheLock.Unlock()
			return FormatPhone(dbPN)
		}
	}

	return ""
}

func InitStore(dbURL string, dbConn *sql.DB) {
	DB = dbConn
	if dbURL == "" {
		dbURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
		if dbURL == "" {
			dbURL = strings.TrimSpace(os.Getenv("NEON_DATABASE_URL"))
		}
		if dbURL == "" {
			dbURL = strings.TrimSpace(os.Getenv("POSTGRES_URL"))
		}
	}

	// Direct URL: strip -pooler suffix so Whatsmeow sqlstore connects directly to Neon DB engine
	// bypassing PgBouncer transaction mode which destroys unnamed prepared statements
	directURL := dbURL
	if strings.Contains(directURL, "-pooler.") {
		directURL = strings.ReplaceAll(directURL, "-pooler.", ".")
	}
	if strings.Contains(directURL, "-pooler-") {
		directURL = strings.ReplaceAll(directURL, "-pooler-", "-")
	}
	if directURL != "" && !strings.Contains(directURL, "sslmode=") {
		if strings.Contains(directURL, "?") {
			directURL += "&sslmode=require"
		} else {
			directURL += "?sslmode=require"
		}
	}

	dbLog := waLog.Stdout("WhatsAppStore", "ERROR", false)
	var err error

	// 1. Primary: Use dedicated direct sqlstore connection with optimized pool
	if directURL != "" {
		dedicatedDB, dbErr := sql.Open("postgres", directURL)
		if dbErr == nil && dedicatedDB != nil {
			// Higher connection limit so Whatsmeow cryptographic operations don't queue
			dedicatedDB.SetMaxOpenConns(16)
			dedicatedDB.SetMaxIdleConns(6)
			dedicatedDB.SetConnMaxLifetime(15 * time.Minute)
			dedicatedDB.SetConnMaxIdleTime(3 * time.Minute)

			StoreContainer = sqlstore.NewWithDB(dedicatedDB, "postgres", dbLog)
			if StoreContainer != nil {
				err = StoreContainer.Upgrade(context.Background())
				if err == nil {
					log.Println("✅ Whatsmeow Store initialized with dedicated direct PostgreSQL connection (Pool: 16 Conns)!")
					go LoadLIDMapCache()
					return
				}
				log.Printf("⚠️ StoreContainer.Upgrade notice: %v", err)
			}
		}

		StoreContainer, err = sqlstore.New(context.Background(), "postgres", directURL, dbLog)
		if err == nil && StoreContainer != nil {
			log.Println("✅ Whatsmeow Store initialized with direct PostgreSQL connection string!")
			go LoadLIDMapCache()
			return
		}
		log.Printf("⚠️ Direct Whatsmeow Store connection notice: %v. Trying active pool fallback...", err)
	}

	// 2. Secondary: Use existing pooled connection if available
	if dbConn != nil {
		StoreContainer = sqlstore.NewWithDB(dbConn, "postgres", dbLog)
		if StoreContainer != nil {
			err = StoreContainer.Upgrade(context.Background())
			if err == nil {
				log.Println("✅ Whatsmeow Store initialized with active PostgreSQL pool!")
				go LoadLIDMapCache()
				return
			}
			log.Printf("⚠️ StoreContainer.Upgrade notice: %v", err)
		}
	}

	log.Println("⚠️ Whatsmeow Store: No database URL available.")
}

// SaveSessionToDB persists tenant session to both tenant_whatsapp_sessions and users tables
func SaveSessionToDB(username, deviceJID, phone, pushName string) {
	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if cleanUsr == "" {
		return
	}
	cleanPhone := FormatPhone(phone)
	if cleanPhone == "" {
		cleanPhone = regexp.MustCompile(`\D`).ReplaceAllString(deviceJID, "")
		cleanPhone = strings.Split(cleanPhone, ".")[0]
	}

	go func() {
		// 1. Upsert into tenant_whatsapp_sessions
		sessionQuery := `
			INSERT INTO tenant_whatsapp_sessions (username, device_jid, phone, status, push_name, linked_at, updated_at)
			VALUES ($1, $2, $3, 'Connected', $4, NOW(), NOW())
			ON CONFLICT (username) DO UPDATE SET
				device_jid = EXCLUDED.device_jid,
				phone = COALESCE(NULLIF(EXCLUDED.phone, ''), tenant_whatsapp_sessions.phone),
				status = 'Connected',
				push_name = COALESCE(NULLIF(EXCLUDED.push_name, ''), tenant_whatsapp_sessions.push_name),
				updated_at = NOW();
		`
		_, _ = DB.Exec(sessionQuery, cleanUsr, deviceJID, cleanPhone, pushName)

		// 2. Sync to users table (guarantees backward compatibility and user login profile)
		userQuery := `
			INSERT INTO users (username, email, password, role, user_type, account_name, wa_jid, phone, status, linked_at, created_at)
			VALUES ($1, $1 || '@gmail.com', 'pass123', 'user', 'business_user', $1 || ' Account', $2, $3, 'Connected', NOW(), NOW())
			ON CONFLICT (username) DO UPDATE SET
				wa_jid = EXCLUDED.wa_jid,
				phone = COALESCE(NULLIF(users.phone, ''), EXCLUDED.phone),
				status = 'Connected',
				linked_at = COALESCE(users.linked_at, NOW());
		`
		_, _ = DB.Exec(userQuery, cleanUsr, cleanPhone, cleanPhone)
		_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=COALESCE(linked_at, NOW()) WHERE LOWER(username)=LOWER($2) OR LOWER(email)=LOWER($2)", cleanPhone, cleanUsr)
		log.Printf("💾 [Persistent Session Saved] Device %s (%s) saved for @%s in Neon PostgreSQL.", cleanPhone, deviceJID, cleanUsr)
	}()
}

// FindPairedDeviceForUser searches StoreContainer for an existing paired session for this user
func FindPairedDeviceForUser(username string) *store.Device {
	if StoreContainer == nil {
		return nil
	}

	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	var savedJID, savedPhone, savedDeviceJID string
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(device_jid, ''), COALESCE(phone, '') FROM tenant_whatsapp_sessions WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&savedDeviceJID, &savedPhone)
		_ = DB.QueryRow("SELECT COALESCE(wa_jid, ''), COALESCE(phone, '') FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1)", cleanUsr).Scan(&savedJID, &savedPhone)
	}

	allDevices, err := StoreContainer.GetAllDevices(context.Background())
	if err != nil || len(allDevices) == 0 {
		return nil
	}

	var pairedDevices []*store.Device
	for _, dev := range allDevices {
		if dev != nil && dev.ID != nil && dev.ID.User != "" {
			pairedDevices = append(pairedDevices, dev)
		}
	}

	if len(pairedDevices) == 0 {
		return nil
	}

	// 1. Exact match by saved device JID (e.g. 917706070633.0:12@s.whatsapp.net)
	if savedDeviceJID != "" {
		for _, dev := range pairedDevices {
			if dev.ID.String() == savedDeviceJID {
				return dev
			}
		}
	}

	// 2. Match by normalized phone digits (10-digit mobile suffix)
	targetDigits := regexp.MustCompile(`\D`).ReplaceAllString(savedJID, "")
	if targetDigits == "" {
		targetDigits = regexp.MustCompile(`\D`).ReplaceAllString(savedPhone, "")
	}

	if targetDigits != "" {
		for _, dev := range pairedDevices {
			devUser := dev.ID.User
			devDigits := regexp.MustCompile(`\D`).ReplaceAllString(devUser, "")
			if devUser == savedJID || devDigits == targetDigits {
				return dev
			}
			if len(devDigits) >= 10 && len(targetDigits) >= 10 {
				if devDigits[len(devDigits)-10:] == targetDigits[len(targetDigits)-10:] {
					return dev
				}
			}
		}
	}

	// 3. Fallback: If only 1 paired device exists in PostgreSQL store across the system,
	// bind it to this user so redeploy NEVER leaves the user stranded!
	if len(pairedDevices) == 1 {
		return pairedDevices[0]
	}

	return nil
}

// Multi-tenant WhatsApp Client: Load from Neon Postgres using saved wa_jid or create new
func GetOrCreateClient(username string) *whatsmeow.Client {
	ClientsLock.Lock()
	defer ClientsLock.Unlock()

	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if c, exists := ActiveClients[cleanUsr]; exists && c != nil {
		return c
	}

	// Lazy initialize StoreContainer if not yet ready
	if StoreContainer == nil {
		InitStore("", DB)
	}

	if StoreContainer == nil {
		log.Printf("⚠️ StoreContainer is nil; cannot create WhatsApp client for @%s", cleanUsr)
		return nil
	}

	// 1. Try to find existing paired device for this user from Neon DB sqlstore
	deviceStore := FindPairedDeviceForUser(cleanUsr)

	// 2. If no paired device exists, ONLY THEN allocate a new device
	if deviceStore == nil {
		deviceStore = StoreContainer.NewDevice()
	}

	// 3. Prevent duplicate active client socket conflicts
	if deviceStore != nil && deviceStore.ID != nil {
		for otherUsr, otherClient := range ActiveClients {
			if otherUsr != cleanUsr && otherClient != nil && otherClient.Store != nil && otherClient.Store.ID != nil {
				if otherClient.Store.ID.User == deviceStore.ID.User {
					otherClient.AddEventHandler(func(evt interface{}) {
						handleWhatsAppEvents(cleanUsr, otherClient, evt)
					})
					ActiveClients[cleanUsr] = otherClient
					log.Printf("🔗 Reusing active WhatsApp client connection for @%s (shares device %s with @%s)", cleanUsr, deviceStore.ID.User, otherUsr)
					return otherClient
				}
			}
		}
	}

	// Low-RAM logger: suppresses noisy traces (<2MB RAM per WhatsApp instance)
	clientLog := waLog.Stdout("Client-"+cleanUsr, "ERROR", false)
	client := whatsmeow.NewClient(deviceStore, clientLog)

	// Incoming Messages & Events Listener
	client.AddEventHandler(func(evt interface{}) {
		handleWhatsAppEvents(cleanUsr, client, evt)
	})

	ActiveClients[cleanUsr] = client

	if client.Store.ID == nil {
		qrChan, err := client.GetQRChannel(context.Background())
		if err == nil {
			go func() {
				for evt := range qrChan {
					if evt.Event == "code" {
						ClientsLock.Lock()
						QRChannelMap[cleanUsr] = evt.Code
						ClientsLock.Unlock()
					} else if evt.Event == "success" {
						ClientsLock.Lock()
						QRChannelMap[cleanUsr] = ""
						ClientsLock.Unlock()
						if client.Store.ID != nil {
							SaveSessionToDB(cleanUsr, client.Store.ID.String(), client.Store.ID.User, "")
						}
					}
				}
			}()
		}
		ConnectWithAutoRetry(client, cleanUsr)
	} else {
		ConnectWithAutoRetry(client, cleanUsr)
		if client.Store.ID != nil {
			SaveSessionToDB(cleanUsr, client.Store.ID.String(), client.Store.ID.User, "")
		}
	}

	return client
}

// GetAnyLoggedInClient returns any active logged-in client across sessions
func GetAnyLoggedInClient() *whatsmeow.Client {
	ClientsLock.Lock()
	defer ClientsLock.Unlock()
	for _, c := range ActiveClients {
		if c != nil && c.IsLoggedIn() {
			return c
		}
	}
	return nil
}

// DisconnectAndUnlinkClient cleanly logs out, disconnects, erases device session from sqlstore, and clears memory
func DisconnectAndUnlinkClient(username string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	ClientsLock.Lock()
	defer ClientsLock.Unlock()

	client, exists := ActiveClients[cleanUsr]
	if exists && client != nil {
		isShared := false
		for otherUsr, otherClient := range ActiveClients {
			if otherUsr != cleanUsr && otherClient == client {
				isShared = true
				break
			}
		}

		if !isShared {
			if client.IsConnected() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = client.Logout(ctx)
				cancel()
			}
			client.Disconnect()

			if client.Store != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = client.Store.Delete(ctx)
				cancel()
			}
		} else {
			log.Printf("ℹ️ [WhatsApp Gateway] Connection for @%s is shared with another active tenant; preserving shared WebSocket socket.", cleanUsr)
		}
	}

	delete(ActiveClients, cleanUsr)
	delete(QRChannelMap, cleanUsr)

	// Clean user session in Neon PostgreSQL
	if DB != nil {
		_, _ = DB.Exec("UPDATE users SET wa_jid='', phone='', status='Disconnected', qr='', linked_at=NULL WHERE LOWER(username)=LOWER($1)", cleanUsr)
	}

	log.Printf("🔌 [WhatsApp Gateway] Client @%s unlinked and session erased from database.", cleanUsr)
}

// ConnectWithAutoRetry attempts to connect the WhatsApp client with automatic exponential retries
func ConnectWithAutoRetry(client *whatsmeow.Client, username string) {
	if client == nil {
		return
	}
	if client.IsConnected() {
		return
	}

	go func() {
		for attempt := 1; attempt <= 10; attempt++ {
			if client.IsConnected() {
				log.Printf("✅ WhatsApp WebSocket connected for @%s", username)
				return
			}

			err := client.Connect()
			if err == nil || (err != nil && strings.Contains(err.Error(), "already connected")) {
				for w := 0; w < 15; w++ {
					if client.IsConnected() {
						log.Printf("✅ WhatsApp WebSocket connected successfully for @%s (Attempt %d)", username, attempt)
						_ = client.SendPresence(context.Background(), types.PresenceAvailable)
						if client.Store != nil && client.Store.ID != nil {
							SaveSessionToDB(username, client.Store.ID.String(), client.Store.ID.User, "")
						}
						return
					}
					time.Sleep(200 * time.Millisecond)
				}
			}

			log.Printf("⏳ Connect retry %d/10 for @%s (notice: %v)", attempt, username, err)
			time.Sleep(time.Duration(attempt*2) * time.Second)
		}
	}()
}

// EnsureConnected ensures the WhatsApp WebSocket is actively connected before sending messages
func EnsureConnected(client *whatsmeow.Client) error {
	if client == nil {
		return fmt.Errorf("whatsapp client instance is nil")
	}
	if client.IsConnected() {
		return nil
	}
	_ = client.Connect()
	for i := 0; i < 25; i++ {
		if client.IsConnected() {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	if client.IsConnected() {
		return nil
	}
	return fmt.Errorf("whatsapp connection timeout (websocket connecting)")
}

// ResolveRealPhoneNumber resolves real phone numbers (+91 / global) from Whatsmeow JIDs
func ResolveRealPhoneNumber(client *whatsmeow.Client, senderJID, chatJID types.JID) string {
	// 1. Resolve LID to Real Phone Number using whatsmeow_lid_map (0ms RAM cache)
	if senderJID.Server == "lid" || strings.HasPrefix(senderJID.User, "117") || strings.HasPrefix(senderJID.User, "223") || strings.HasPrefix(senderJID.User, "100") {
		if realPhone := GetRealPhoneFromLID(senderJID.User); realPhone != "" {
			return realPhone
		}
	}
	if chatJID.Server == "lid" || strings.HasPrefix(chatJID.User, "117") || strings.HasPrefix(chatJID.User, "223") || strings.HasPrefix(chatJID.User, "100") {
		if realPhone := GetRealPhoneFromLID(chatJID.User); realPhone != "" {
			return realPhone
		}
	}

	// 2. Try Chat JID if it is a standard phone user server (@s.whatsapp.net or @c.us)
	if (chatJID.Server == types.DefaultUserServer || chatJID.Server == "c.us" || chatJID.Server == "s.whatsapp.net") && chatJID.User != "" {
		clean := regexp.MustCompile(`\D`).ReplaceAllString(chatJID.User, "")
		clean = strings.Split(clean, ".")[0]
		if len(clean) >= 8 && !strings.HasPrefix(clean, "117") && !strings.HasPrefix(clean, "223") {
			return FormatPhone(clean)
		}
	}

	// 3. Try Sender JID if it is a standard phone user server (@s.whatsapp.net or @c.us)
	if (senderJID.Server == types.DefaultUserServer || senderJID.Server == "c.us" || senderJID.Server == "s.whatsapp.net") && senderJID.User != "" {
		clean := regexp.MustCompile(`\D`).ReplaceAllString(senderJID.User, "")
		clean = strings.Split(clean, ".")[0]
		if len(clean) >= 8 && !strings.HasPrefix(clean, "117") && !strings.HasPrefix(clean, "223") {
			return FormatPhone(clean)
		}
	}

	// 4. Fallback: Extract numeric phone digits from chat or sender user ID (handles LID & custom JIDs)
	rawUser := senderJID.User
	if rawUser == "" || senderJID.Server == "lid" || strings.HasPrefix(senderJID.User, "117") || strings.HasPrefix(senderJID.User, "223") {
		if chatJID.User != "" && chatJID.Server != "lid" && !strings.HasPrefix(chatJID.User, "117") && !strings.HasPrefix(chatJID.User, "223") {
			rawUser = chatJID.User
		}
	}
	if rawUser == "" {
		rawUser = chatJID.User
	}

	clean := regexp.MustCompile(`\D`).ReplaceAllString(rawUser, "")
	clean = strings.Split(clean, ".")[0]
	if len(clean) >= 8 {
		return FormatPhone(clean)
	}

	return ""
}

// FormatPhone cleans and adds India '91' prefix if 10-digit number is provided
func FormatPhone(phone string) string {
	clean := regexp.MustCompile(`\D`).ReplaceAllString(phone, "")
	if clean == "" {
		return ""
	}
	clean = strings.Split(clean, ".")[0]
	if len(clean) == 10 && (clean[0] == '6' || clean[0] == '7' || clean[0] == '8' || clean[0] == '9') {
		return "91" + clean
	}
	if len(clean) == 11 && clean[0] == '0' {
		return "91" + clean[1:]
	}
	return clean
}

// RefreshQRChannel / GetOrGenerateQR ensures a fresh QR code is actively being received
func RefreshQRChannel(username string) string {
	return GetOrGenerateQR(username)
}

func GetOrGenerateQR(username string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	ClientsLock.Lock()
	client, exists := ActiveClients[cleanUsr]
	existingCode := QRChannelMap[cleanUsr]
	ClientsLock.Unlock()

	// 1. If client is ALREADY logged in with a paired session, NEVER create a new device or generate a QR code!
	if exists && client != nil && client.Store != nil && client.Store.ID != nil {
		if !client.IsConnected() {
			ConnectWithAutoRetry(client, cleanUsr)
		}
		return ""
	}

	// 2. Check if a paired device session exists in Neon PostgreSQL for this user
	if dev := FindPairedDeviceForUser(cleanUsr); dev != nil && dev.ID != nil {
		log.Printf("📱 [Preserve Session] Found existing paired device (%s) for @%s in DB. Re-attaching instead of generating new QR.", dev.ID.User, cleanUsr)
		c := GetOrCreateClient(cleanUsr)
		if c != nil && !c.IsConnected() {
			ConnectWithAutoRetry(c, cleanUsr)
		}
		return ""
	}

	if existingCode != "" {
		return existingCode
	}

	// Only reset unlinked client
	if exists && client != nil {
		client.Disconnect()
	}

	// Create fresh device store for new QR code pairing
	deviceStore := StoreContainer.NewDevice()
	clientLog := waLog.Stdout("Client-"+cleanUsr, "ERROR", false)
	client = whatsmeow.NewClient(deviceStore, clientLog)

	client.AddEventHandler(func(evt interface{}) {
		handleWhatsAppEvents(cleanUsr, client, evt)
	})

	qrChan, err := client.GetQRChannel(context.Background())
	if err != nil {
		log.Printf("⚠️ GetQRChannel error for @%s: %v", cleanUsr, err)
		return ""
	}

	ClientsLock.Lock()
	ActiveClients[cleanUsr] = client
	QRChannelMap[cleanUsr] = ""
	ClientsLock.Unlock()

	go func() {
		for evt := range qrChan {
			if evt.Event == "code" {
				ClientsLock.Lock()
				QRChannelMap[cleanUsr] = evt.Code
				ClientsLock.Unlock()
			} else if evt.Event == "success" {
				ClientsLock.Lock()
				QRChannelMap[cleanUsr] = ""
				ClientsLock.Unlock()
				if client.Store.ID != nil {
					SaveSessionToDB(cleanUsr, client.Store.ID.String(), client.Store.ID.User, "")
				}
			} else if evt.Event == "timeout" {
				ClientsLock.Lock()
				QRChannelMap[cleanUsr] = ""
				ClientsLock.Unlock()
			}
		}
	}()

	go func() {
		if err := client.Connect(); err != nil {
			log.Printf("⚠️ Client connect error for @%s after QR request: %v", cleanUsr, err)
		}
	}()

	// Wait up to 3 seconds for the first QR code event to arrive over websocket
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		ClientsLock.Lock()
		code := QRChannelMap[cleanUsr]
		ClientsLock.Unlock()
		if code != "" {
			return code
		}
	}

	ClientsLock.Lock()
	code := QRChannelMap[cleanUsr]
	ClientsLock.Unlock()
	return code
}

// SaveCustomerChatAndPrune records incoming/outgoing messages in customer_chats
// and immediately prunes old records in Neon Postgres so only the latest 10 messages per customer exist.
func SaveCustomerChatAndPrune(username, customerPhone, role, messageText string) {
	if DB == nil {
		return
	}
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")
	cleanUsr = strings.ToLower(cleanUsr)
	cleanPhone := FormatPhone(customerPhone)
	messageText = strings.TrimSpace(messageText)

	if cleanUsr == "" || cleanPhone == "" || messageText == "" {
		return
	}

	// Standardize role names: 'customer' for user input, 'assistant' for AI/agent replies
	normalRole := strings.ToLower(role)
	senderType := "incoming"
	incMsg := ""
	outMsg := ""

	if normalRole == "user" || normalRole == "client" || normalRole == "customer" || normalRole == "incoming" {
		normalRole = "customer"
		senderType = "incoming"
		incMsg = messageText
	} else {
		normalRole = "assistant"
		senderType = "outgoing"
		outMsg = messageText
	}

	// 1. Insert chat record into customer_chats table with explicit incoming_msg and outgoing_msg columns per customer phone
	_, err := DB.Exec(`INSERT INTO customer_chats (username, customer_phone, role, message_text, sender_type, incoming_msg, outgoing_msg, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`, cleanUsr, cleanPhone, normalRole, messageText, senderType, incMsg, outMsg)
	if err != nil {
		log.Printf("⚠️ SaveCustomerChat error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
	}

	// 2. Prune DB to strictly retain latest 10 messages per customer phone (Sliding Window in DB)
	_, _ = DB.Exec(`DELETE FROM customer_chats 
		WHERE LOWER(username)=LOWER($1) 
		  AND customer_phone=$2 
		  AND id NOT IN (
			SELECT id FROM customer_chats 
			WHERE LOWER(username)=LOWER($1) AND customer_phone=$2 
			ORDER BY id DESC LIMIT 10
		  )`, cleanUsr, cleanPhone)

	// 3. Sync RAM cache and update last activity timestamp (5-min inactivity timer reset)
	_ = updateSlidingWindowRAM(cleanUsr, cleanPhone, normalRole, messageText)
}

// isMediaMessage detects if an incoming WhatsApp payload contains media or catalog (photo, video, audio, sticker, doc, contact, order, product)
func isMediaMessage(msg *waE2E.Message) bool {
	if msg == nil {
		return false
	}
	if msg.GetImageMessage() != nil ||
		msg.GetVideoMessage() != nil ||
		msg.GetAudioMessage() != nil ||
		msg.GetDocumentMessage() != nil ||
		msg.GetStickerMessage() != nil ||
		msg.GetContactMessage() != nil ||
		msg.GetContactsArrayMessage() != nil ||
		msg.GetOrderMessage() != nil ||
		msg.GetProductMessage() != nil {
		return true
	}
	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return isMediaMessage(ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return isMediaMessage(viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return isMediaMessage(viewOnceV2.GetMessage())
	}
	if edited := msg.GetEditedMessage(); edited != nil && edited.GetMessage() != nil {
		if protoMsg := edited.GetMessage().GetProtocolMessage(); protoMsg != nil && protoMsg.GetEditedMessage() != nil {
			return isMediaMessage(protoMsg.GetEditedMessage())
		}
	}
	return false
}

// extractIncomingImageMessage unwraps any image message from WhatsApp payload (direct, ephemeral, view-once, edited)
func extractIncomingImageMessage(msg *waE2E.Message) *waE2E.ImageMessage {
	if msg == nil {
		return nil
	}
	if img := msg.GetImageMessage(); img != nil {
		return img
	}
	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return extractIncomingImageMessage(ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return extractIncomingImageMessage(viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return extractIncomingImageMessage(viewOnceV2.GetMessage())
	}
	if edited := msg.GetEditedMessage(); edited != nil && edited.GetMessage() != nil {
		if protoMsg := edited.GetMessage().GetProtocolMessage(); protoMsg != nil && protoMsg.GetEditedMessage() != nil {
			return extractIncomingImageMessage(protoMsg.GetEditedMessage())
		}
	}
	return nil
}

// isIncomingImageOrDocument checks if the message is an image or image document (screenshot)
func isIncomingImageOrDocument(msg *waE2E.Message) bool {
	if msg == nil {
		return false
	}
	if extractIncomingImageMessage(msg) != nil {
		return true
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		mime := strings.ToLower(doc.GetMimetype())
		if strings.HasPrefix(mime, "image/") || strings.Contains(mime, "pdf") {
			return true
		}
	}
	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return isIncomingImageOrDocument(ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return isIncomingImageOrDocument(viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return isIncomingImageOrDocument(viewOnceV2.GetMessage())
	}
	return false
}

// isCancellationOrModificationIntent detects natural language expressions of order cancellation, refusal, or item change
func isCancellationOrModificationIntent(text string) bool {
	norm := strings.ToLower(strings.TrimSpace(text))
	if norm == "" {
		return false
	}

	keywords := []string{
		"cancel", "cancellation", "radd", "rad", "badal", "badlo", "badalna",
		"change", "modify", "modification", "remove", "delete", "stop", "abort",
		"nevermind", "dusra", "doosra", "dusre", "dusri", "dobara", "galat",
		"rehnedo", "chhodo", "wapas",
	}
	for _, kw := range keywords {
		if strings.Contains(norm, kw) {
			return true
		}
	}

	phrases := []string{
		"nahi chahiye", "nh chahiye", "nhi chahiye", "nahi lena", "nhi lena",
		"mat bhejo", "mat bhejna", "bhejna mat", "rehne do", "chhod do",
		"nahi mangwana", "phir kabhi", "baad me", "baad mein", "ab nahi",
		"kuch aur", "galti se", "dont want", "don't want", "not interested",
		"no thanks", "stop order", "order cancel", "order radd", "order change",
		"item change", "item badlo", "dusra item",
	}
	for _, p := range phrases {
		if strings.Contains(norm, p) {
			return true
		}
	}

	return false
}

// findCatalogProductMatch looks up product in Neon DB by name to fetch price, description, and whatsapp_catalog_link
func findCatalogProductMatch(username, title string) (string, string, string) {
	if DB == nil || strings.TrimSpace(title) == "" {
		return "", "", ""
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanTitle := strings.TrimSpace(title)

	var price, desc, waCatalogLink string
	err := DB.QueryRow(`SELECT price, COALESCE(description, ''), COALESCE(whatsapp_catalog_link, '') 
		FROM products 
		WHERE LOWER(username)=LOWER($1) AND LOWER(TRIM(name))=LOWER($2) LIMIT 1`, cleanUsr, cleanTitle).Scan(&price, &desc, &waCatalogLink)
	if err != nil {
		_ = DB.QueryRow(`SELECT price, COALESCE(description, ''), COALESCE(whatsapp_catalog_link, '') 
			FROM products 
			WHERE LOWER(username)=LOWER($1) AND (LOWER($2) LIKE '%' || LOWER(TRIM(name)) || '%' OR LOWER(TRIM(name)) LIKE '%' || LOWER($2) || '%') LIMIT 1`, cleanUsr, cleanTitle).Scan(&price, &desc, &waCatalogLink)
	}
	return price, desc, waCatalogLink
}

// Reverse Geocoding API response struct (OpenStreetMap Nominatim)
type NominatimResponse struct {
	DisplayName string `json:"display_name"`
	Address     struct {
		Road          string `json:"road"`
		Neighbourhood string `json:"neighbourhood"`
		Suburb        string `json:"suburb"`
		City          string `json:"city"`
		Town          string `json:"town"`
		Village       string `json:"village"`
		County        string `json:"county"`
		State         string `json:"state"`
		Postcode      string `json:"postcode"`
		Country       string `json:"country"`
	} `json:"address"`
}

var nominatimHTTPClient = &http.Client{
	Timeout: 4 * time.Second,
}

// FetchReverseGeocodeLocation resolves GPS coordinates (lat, lon) to human-readable address & place name via OpenStreetMap Nominatim
func FetchReverseGeocodeLocation(lat, lon float64) (shortPlace string, fullAddress string) {
	if lat == 0 && lon == 0 {
		return "", ""
	}

	apiURL := fmt.Sprintf("https://nominatim.openstreetmap.org/reverse?format=json&lat=%f&lon=%f&zoom=18&addressdetails=1", lat, lon)

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", ""
	}
	// OpenStreetMap requires a distinctive User-Agent header
	req.Header.Set("User-Agent", "WaMart-WhatsApp-Bot/1.0 (Location-Resolver)")

	resp, err := nominatimHTTPClient.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", ""
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", ""
	}

	var geoData NominatimResponse
	if err := json.Unmarshal(body, &geoData); err != nil {
		return "", ""
	}

	if geoData.DisplayName == "" {
		return "", ""
	}

	// Concise short place name for quick display
	short := geoData.Address.City
	if short == "" {
		short = geoData.Address.Town
	}
	if short == "" {
		short = geoData.Address.Neighbourhood
	}
	if short == "" {
		short = geoData.Address.Suburb
	}
	if short == "" {
		short = geoData.Address.Village
	}
	if short == "" {
		short = geoData.Address.Road
	}

	return short, geoData.DisplayName
}

// extractLocationCoords detects if a WhatsApp message contains location or live location coordinates
func extractLocationCoords(msg *waE2E.Message) (float64, float64, bool) {
	if msg == nil {
		return 0, 0, false
	}
	if loc := msg.GetLocationMessage(); loc != nil {
		return loc.GetDegreesLatitude(), loc.GetDegreesLongitude(), true
	}
	if liveLoc := msg.GetLiveLocationMessage(); liveLoc != nil {
		return liveLoc.GetDegreesLatitude(), liveLoc.GetDegreesLongitude(), true
	}
	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return extractLocationCoords(ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return extractLocationCoords(viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return extractLocationCoords(viewOnceV2.GetMessage())
	}
	return 0, 0, false
}

// Helper to extract text or label from any incoming WhatsApp message payload type, including Catalog Orders, Products, and Locations
func extractMessageText(username string, client *whatsmeow.Client, msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}

	// If message is media (photo/video/audio/sticker/doc/contact), return empty so no reply is triggered
	if isMediaMessage(msg) {
		return ""
	}

	if text := msg.GetConversation(); text != "" {
		return text
	}

	if ext := msg.GetExtendedTextMessage(); ext != nil {
		if text := strings.TrimSpace(ext.GetText()); text != "" {
			return text
		}
	}

	// 0. WhatsApp Shared Location (GPS coordinates, landmark, address, Google Maps link, and OpenStreetMap reverse geocoding)
	if loc := msg.GetLocationMessage(); loc != nil {
		lat := loc.GetDegreesLatitude()
		lng := loc.GetDegreesLongitude()
		name := strings.TrimSpace(loc.GetName())
		addr := strings.TrimSpace(loc.GetAddress())
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lng)

		// Case 1: If WhatsApp provided the place name / searched landmark
		// Case 2: If customer sent "Current Location", name & address are empty. Resolve exact name & full address via OpenStreetMap Nominatim!
		if name == "" || addr == "" {
			shortLoc, fullAddr := FetchReverseGeocodeLocation(lat, lng)
			if name == "" && shortLoc != "" {
				name = shortLoc
			}
			if addr == "" && fullAddr != "" {
				addr = fullAddr
			}
		}

		var parts []string
		if name != "" {
			parts = append(parts, fmt.Sprintf("Location / Area: \"%s\"", name))
		}
		if addr != "" {
			parts = append(parts, fmt.Sprintf("Full Address: \"%s\"", addr))
		}
		parts = append(parts, fmt.Sprintf("Coordinates: %.6f, %.6f", lat, lng))
		parts = append(parts, fmt.Sprintf("Google Maps Link: %s", mapsURL))

		return "[Customer Shared Location]: " + strings.Join(parts, " | ")
	}

	if liveLoc := msg.GetLiveLocationMessage(); liveLoc != nil {
		lat := liveLoc.GetDegreesLatitude()
		lng := liveLoc.GetDegreesLongitude()
		mapsURL := fmt.Sprintf("https://maps.google.com/?q=%.6f,%.6f", lat, lng)

		var parts []string
		shortLoc, fullAddr := FetchReverseGeocodeLocation(lat, lng)
		if shortLoc != "" {
			parts = append(parts, fmt.Sprintf("Location / Area: \"%s\"", shortLoc))
		}
		if fullAddr != "" {
			parts = append(parts, fmt.Sprintf("Full Address: \"%s\"", fullAddr))
		}
		parts = append(parts, fmt.Sprintf("Coordinates: %.6f, %.6f", lat, lng))
		parts = append(parts, fmt.Sprintf("Google Maps Link: %s", mapsURL))

		return "[Customer Shared Live Location]: " + strings.Join(parts, " | ")
	}


	// 3. Interactive or List Response
	if listResp := msg.GetListResponseMessage(); listResp != nil {
		title := strings.TrimSpace(listResp.GetTitle())
		desc := strings.TrimSpace(listResp.GetDescription())
		if title != "" && desc != "" {
			return title + " - " + desc
		}
		if title != "" {
			return title
		}
		if desc != "" {
			return desc
		}
	}
	if btnResp := msg.GetButtonsResponseMessage(); btnResp != nil {
		if text := strings.TrimSpace(btnResp.GetSelectedDisplayText()); text != "" {
			return text
		}
		if id := strings.TrimSpace(btnResp.GetSelectedButtonID()); id != "" {
			return id
		}
	}
	if tmplResp := msg.GetTemplateButtonReplyMessage(); tmplResp != nil {
		if text := strings.TrimSpace(tmplResp.GetSelectedDisplayText()); text != "" {
			return text
		}
		if id := strings.TrimSpace(tmplResp.GetSelectedID()); id != "" {
			return id
		}
	}

	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return extractMessageText(username, client, ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return extractMessageText(username, client, viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return extractMessageText(username, client, viewOnceV2.GetMessage())
	}
	if edited := msg.GetEditedMessage(); edited != nil && edited.GetMessage() != nil {
		if protoMsg := edited.GetMessage().GetProtocolMessage(); protoMsg != nil && protoMsg.GetEditedMessage() != nil {
			return extractMessageText(username, client, protoMsg.GetEditedMessage())
		}
	}
	return ""
}

// CheckAndProcessLead qualifies confirmed leads strictly based on customer actions:
// 1. Customer selected Cash on Delivery (COD)
// 2. Customer completed payment / reported UTR/payment confirmation
func CheckAndProcessLead(username string, client *whatsmeow.Client, senderPhone string, msgText string, msg *waE2E.Message) {
	if DB == nil || senderPhone == "" || strings.TrimSpace(msgText) == "" {
		return
	}

	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	lower := strings.ToLower(msgText)

	isCOD := false
	isPrepaid := false
	leadStatus := ""
	leadDetails := msgText

	// 1. CASH ON DELIVERY (COD) DETECTION
	codKeywords := []string{
		"cod", "cash on delivery", "cash-on-delivery", "pay on delivery",
		"cod chahiye", "cod kardo", "cod karna", "cod option", "cod pe",
		"delivery par cash", "delivery pe cash", "cash payment at delivery",
		"cash on delivery chahiye", "cash on delivery kardo", "cod order",
		"cod bhejna", "cod par bhej", "delivery pe dunga", "delivery par dunga",
	}

	for _, kw := range codKeywords {
		if strings.Contains(lower, kw) {
			isCOD = true
			leadStatus = "Confirmed Order (Cash On Delivery - COD)"
			break
		}
	}

	// 2. PAYMENT CONFIRMATION DETECTION (Customer completed payment / UTR reported)
	paidKeywords := []string{
		"payment done", "payment kar diya", "paid successfully", "payment ho gaya",
		"paytm payment done", "upi payment done", "gpay payment done", "phonepe payment done",
		"payment sent", "paise bhej diye", "transfer kar diya", "utr number", "transaction id",
	}

	if !isCOD {
		// Strictly wait for Webhook SUCCESS! Do not trigger fake confirmation if payment is PENDING
		payStatus := GetCustomerPaymentStatus(cleanUsr, senderPhone)
		if strings.EqualFold(payStatus, "PENDING") {
			return
		}
		for _, kw := range paidKeywords {
			if strings.Contains(lower, kw) {
				isPrepaid = true
				leadStatus = "Confirmed Order (Customer Payment Reported)"
				break
			}
		}
	}

	// Strictest Quality Filter: Only trigger Confirmed Lead if COD or Payment verified!
	if !isCOD && !isPrepaid {
		return
	}

	// Persist Confirmed Lead to leads table in DB
	var leadID int
	err := DB.QueryRow(`INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at)
		VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
		cleanUsr, senderPhone, leadDetails, leadStatus).Scan(&leadID)
	if err != nil {
		log.Printf("⚠️ Error inserting confirmed lead into DB: %v", err)
	} else {
		log.Printf("🎯 [Confirmed Lead Captured #%d] +%s (@%s) -> %s", leadID, senderPhone, cleanUsr, leadStatus)
	}

	// Construct High-Priority WhatsApp Lead Alert
	locTime := time.Now().Format("02 Jan 15:04")
	cleanCustomer := FormatPhone(senderPhone)

	paymentMethodStr := "Cash on Delivery (COD) 🚚"
	if isPrepaid {
		paymentMethodStr = "Prepaid Payment Reported by Customer 💳"
	}

	alertMsg := fmt.Sprintf("🚨 *NEW CONFIRMED LEAD ALERT* 🚨\n\n"+
		"• *Account*: @%s\n"+
		"• *Customer*: +%s\n"+
		"• *Payment Method*: %s\n"+
		"• *Status*: %s\n"+
		"• *Time*: %s\n\n"+
		"📦 *Order / Inquiry Message*:\n\"%s\"\n\n"+
		"📲 *Chat with Customer directly*:\nhttps://wa.me/%s\n\n"+
		"WaMart Automated Commerce Gateway",
		cleanUsr, cleanCustomer, paymentMethodStr, leadStatus, locTime, leadDetails, cleanCustomer)

	// Dispatch Automated WhatsApp Lead Alert directly to notification_phone
	go DispatchLeadAlertWhatsAppDirect(cleanUsr, alertMsg)
}

// TriggerConfirmedPaymentLead is called when Paytm Soundbox / Gateway verifies a payment (TXN_SUCCESS)
func TriggerConfirmedPaymentLead(username, customerPhone, orderID, amount, txnID string) {
	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)

	// If customerPhone is not supplied directly, retrieve customer_phone and tenant username from customer_order_states
	if (cleanPhone == "" || cleanUsr == "" || cleanUsr == "admin") && orderID != "" {
		var dbPhone, dbUsr string
		_ = DB.QueryRow(`
			SELECT customer_phone, username 
			FROM customer_order_states WHERE LOWER(order_id) = LOWER($1) LIMIT 1
		`, orderID).Scan(&dbPhone, &dbUsr)
		if dbPhone != "" && cleanPhone == "" {
			cleanPhone = FormatPhone(dbPhone)
		}
		if dbUsr != "" && (cleanUsr == "" || cleanUsr == "admin") {
			cleanUsr = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(dbUsr), "@"))
		}
	}

	if cleanPhone == "" && strings.HasPrefix(orderID, "ORD_") {
		parts := strings.Split(orderID, "_")
		if len(parts) >= 2 {
			phoneSuffix := parts[1]
			var dbPhone, dbUsr string
			_ = DB.QueryRow(`
				SELECT wa_number, username FROM customers 
				WHERE wa_number LIKE '%' || $1 
				ORDER BY updated_at DESC LIMIT 1
			`, phoneSuffix).Scan(&dbPhone, &dbUsr)
			if dbPhone != "" {
				cleanPhone = FormatPhone(dbPhone)
			}
			if dbUsr != "" && (cleanUsr == "" || cleanUsr == "admin") {
				cleanUsr = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(dbUsr), "@"))
			}
		}
	}

	inquiry := fmt.Sprintf("Order %s | Amount: ₹%s | TxnID: %s", orderID, amount, txnID)

	// Insert into leads table as verified paid
	var leadID int
	err := DB.QueryRow(`INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at)
		VALUES ($1, $2, $3, 'Confirmed Paid (Paytm UPI)', NOW()) RETURNING id`,
		cleanUsr, cleanPhone, inquiry).Scan(&leadID)
	if err == nil {
		log.Printf("💰 [Confirmed Paid Lead #%d] +%s (@%s) -> ₹%s (Txn: %s)", leadID, cleanPhone, cleanUsr, amount, txnID)
	}

	locTime := time.Now().Format("02 Jan 15:04")
	alertMsg := fmt.Sprintf("🚨 *CONFIRMED LEAD ALERT (PAYMENT VERIFIED)* 🚨\n\n"+
		"• *Account*: @%s\n"+
		"• *Customer*: +%s\n"+
		"• *Amount Paid*: ₹%s\n"+
		"• *Order ID*: %s\n"+
		"• *Txn ID*: %s\n"+
		"• *Payment Method*: Paytm UPI / Soundbox Verified ✅\n"+
		"• *Status*: Payment Verified & Order Confirmed\n"+
		"• *Time*: %s\n\n"+
		"📲 *Chat with Customer directly*:\nhttps://wa.me/%s\n\n"+
		"WaMart Automated Commerce Gateway",
		cleanUsr, cleanPhone, amount, orderID, txnID, locTime, cleanPhone)

	go DispatchLeadAlertWhatsAppDirect(cleanUsr, alertMsg)

	// Update customer state to ORDER_CONFIRMED, payment_status to PAID, and clear active cart in DB & RAM
	if cleanPhone != "" {
		_ = SetCustomerState(cleanUsr, cleanPhone, "ORDER_CONFIRMED")
		_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "PAID")
		_ = ClearActiveCart(cleanUsr, cleanPhone)
		if DB != nil {
			_, _ = DB.Exec(`DELETE FROM active_carts WHERE customer_phone = $1 OR customer_phone LIKE '%' || $1`, cleanPhone)
		}
	}


	// Send dynamic AI-generated WhatsApp receipt/confirmation to the customer
	if cleanPhone != "" && len(cleanPhone) >= 10 {
		aiPrompt := fmt.Sprintf("Payment of Rs. %s for Order %s was just confirmed via Paytm UPI. Write a joyful, polite WhatsApp order confirmation receipt for the customer with quotes (>) and emojis. Thank them warmly and inform that their order will be prepared and delivered shortly.", amount, orderID)
		customerConfirmMsg, errAI := GenerateAIContextualReply(cleanUsr, cleanPhone, aiPrompt, nil)
		if errAI != nil || customerConfirmMsg == "" {
			customerConfirmMsg = fmt.Sprintf("> 🎉 *ORDER CONFIRMED & PAYMENT RECEIVED* ✅\n> 📦 *Order ID:* %s • 💵 *Amount:* ₹%s\n\nAapka order safaltapurvak confirm ho gaya hai! Hum jald hi delivery karenge. Dhanyawad! 🙏✨🚚", orderID, amount)
		}

		client := GetOrCreateClient(cleanUsr)
		if client == nil || !client.IsLoggedIn() {
			client = GetAnyLoggedInClient()
		}
		if client != nil && client.IsLoggedIn() {
			sendErr := SendMessage(client, cleanPhone, customerConfirmMsg)
			if sendErr != nil {
				log.Printf("⚠️ Error sending payment confirmation to +%s: %v", cleanPhone, sendErr)
			} else {
				log.Printf("⚡ [Whatsmeow Payment Confirmation Delivered] +%s (@%s) -> Order: %s", cleanPhone, cleanUsr, orderID)
				PushToLiveChat(cleanUsr, cleanPhone, customerConfirmMsg, "outgoing_ai")
				go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", customerConfirmMsg)
			}
		}
	}
}

// DispatchLeadAlertWhatsAppDirect sends immediate notification to the configured notification_phone in AI settings
func DispatchLeadAlertWhatsAppDirect(username, alertMsg string) {
	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	// 1. Fetch notification_phone with solid fallback to phone or wa_jid
	var notifPhone string
	_ = DB.QueryRow(`
		SELECT COALESCE(NULLIF(notification_phone, ''), NULLIF(phone, ''), NULLIF(wa_jid, ''), '')
		FROM users WHERE LOWER(username)=LOWER($1)
	`, cleanUsr).Scan(&notifPhone)

	notifPhone = strings.TrimSpace(notifPhone)
	if notifPhone == "" {
		log.Printf("ℹ️ [Lead Alert] No notification_phone configured for @%s. Pushed to Live Chat stream only.", cleanUsr)
		PushToLiveChat(cleanUsr, "", alertMsg, "lead_alert")
		return
	}

	targetPhone := FormatPhone(notifPhone)
	if targetPhone == "" || len(targetPhone) < 10 {
		log.Printf("⚠️ [Lead Alert] Invalid notification_phone (+%s) for @%s", notifPhone, cleanUsr)
		PushToLiveChat(cleanUsr, "", alertMsg, "lead_alert")
		return
	}

	// Always push to live chat stream so the web portal's notification toast and audio trigger
	PushToLiveChat(cleanUsr, targetPhone, alertMsg, "lead_alert")

	// Get active WhatsApp client for this tenant to send the alert message
	activeClient := GetOrCreateClient(cleanUsr)
	if activeClient == nil || !activeClient.IsLoggedIn() {
		log.Printf("⚠️ [Lead Alert] WhatsApp client for @%s is not logged in; cannot send WhatsApp alert to +%s", cleanUsr, targetPhone)
		return
	}

	if err := EnsureConnected(activeClient); err != nil {
		log.Printf("⚠️ [Lead Alert] Could not ensure connection for @%s: %v", cleanUsr, err)
	}

	err := SendMessage(activeClient, targetPhone, alertMsg)
	if err != nil {
		log.Printf("⚠️ [Lead Alert] Failed to send WhatsApp lead alert to +%s: %v", targetPhone, err)
	} else {
		log.Printf("✅ [Lead Alert] Successfully delivered Confirmed Lead WhatsApp alert to +%s for @%s", targetPhone, cleanUsr)
	}
}

// Incoming Message Handler (Client-side Chat + AI Auto-Reply)
func handleWhatsAppEvents(username string, client *whatsmeow.Client, evt interface{}) {
	switch v := evt.(type) {
	case *events.Receipt:
		// Smart Human-Override (Read Receipt Race Condition): Intercept read receipts
		if v.Type == types.ReceiptTypeRead || v.Type == types.ReceiptTypeReadSelf || strings.Contains(string(v.Type), "read") {
			for _, msgID := range v.MessageIDs {
				idStr := string(msgID)
				if idStr != "" {
					MessageReadByHuman.Store(idStr, true)
					log.Printf("👁️ [Human Read Receipt] Message %s marked as read by business owner. AI override active.", idStr)
					// Automatic TTL Garbage Collection after 5 minutes to prevent memory leak
					time.AfterFunc(5*time.Minute, func() {
						MessageReadByHuman.Delete(idStr)
					})
				}
			}
		}

	case *events.Message:
		// 1. Ensure it's a new message from a channel
		sourceJID := v.Info.Chat.String()
		if strings.HasSuffix(sourceJID, "@newsletter") {
			// 2. Prevent infinite loops (do not forward our own messages)
			if v.Info.IsFromMe {
				return
			}

			// 3. Query DB / RAM cache for ACTIVE rules where source_jid == sourceJID
			activeRules := GetActiveRulesForChannel(sourceJID)
			if len(activeRules) == 0 {
				return
			}

			log.Printf("📢 [Channel Router] New post in channel %s. Zero-load forwarding matching %d active rule(s)...", sourceJID, len(activeRules))

			// 4. Granular Forwarding (Filters, URL Blockers, Context Strippers)
			for _, rule := range activeRules {
				targetJID, errParse := types.ParseJID(rule.TargetJID)
				if errParse != nil {
					continue
				}

				msg := v.Message
				if msg == nil {
					continue
				}

				textConv := msg.GetConversation()
				extendedText := msg.GetExtendedTextMessage().GetText()
				imgCaption := msg.GetImageMessage().GetCaption()
				vidCaption := msg.GetVideoMessage().GetCaption()
				docCaption := msg.GetDocumentMessage().GetCaption()

				fullText := textConv + extendedText + imgCaption + vidCaption + docCaption
				hasText := strings.TrimSpace(fullText) != ""
				hasMedia := msg.GetImageMessage() != nil || msg.GetVideoMessage() != nil || msg.GetDocumentMessage() != nil || msg.GetAudioMessage() != nil

				// --- FORWARD LOGIC FILTERS ---
				// Values: all, only_text, text_and_media, only_media
				logic := strings.ToLower(strings.TrimSpace(rule.ForwardLogic))
				if logic == "" {
					logic = "all"
				}

				if logic == "only_text" && !hasText {
					continue
				}
				if logic == "only_media" && !hasMedia {
					continue
				}
				if logic == "text_and_media" && !(hasText || hasMedia) {
					continue
				}

				// --- URL BLOCKER LOGIC ---
				if rule.BlockURLs {
					lowerText := strings.ToLower(fullText)
					if strings.Contains(lowerText, "http://") || strings.Contains(lowerText, "https://") || strings.Contains(lowerText, "www.") {
						log.Printf("🚫 [Channel Router] Rule #%d skipped message containing blocked external URL to %s", rule.ID, rule.TargetName)
						continue
					}
				}

				// --- "VIEW CHANNEL" STRIPPER (CONTEXT CLEANER) ---
				msgToSend := msg
				if rule.StripChannelLinks {
					// Clone message to prevent mutating original payload for other rules
					msgToSend = proto.Clone(msg).(*waE2E.Message)
					if msgToSend.ExtendedTextMessage != nil && msgToSend.ExtendedTextMessage.ContextInfo != nil {
						msgToSend.ExtendedTextMessage.ContextInfo.IsForwarded = proto.Bool(false)
						msgToSend.ExtendedTextMessage.ContextInfo.ForwardingScore = proto.Uint32(0)
					}
					if msgToSend.ImageMessage != nil && msgToSend.ImageMessage.ContextInfo != nil {
						msgToSend.ImageMessage.ContextInfo.IsForwarded = proto.Bool(false)
						msgToSend.ImageMessage.ContextInfo.ForwardingScore = proto.Uint32(0)
					}
					if msgToSend.VideoMessage != nil && msgToSend.VideoMessage.ContextInfo != nil {
						msgToSend.VideoMessage.ContextInfo.IsForwarded = proto.Bool(false)
						msgToSend.VideoMessage.ContextInfo.ForwardingScore = proto.Uint32(0)
					}
					if msgToSend.DocumentMessage != nil && msgToSend.DocumentMessage.ContextInfo != nil {
						msgToSend.DocumentMessage.ContextInfo.IsForwarded = proto.Bool(false)
						msgToSend.DocumentMessage.ContextInfo.ForwardingScore = proto.Uint32(0)
					}
					if msgToSend.AudioMessage != nil && msgToSend.AudioMessage.ContextInfo != nil {
						msgToSend.AudioMessage.ContextInfo.IsForwarded = proto.Bool(false)
						msgToSend.AudioMessage.ContextInfo.ForwardingScore = proto.Uint32(0)
					}
				}

				// Forward the payload directly without server-side media re-encoding
				go func(tJID types.JID, rawMsg *waE2E.Message, rID int, tName string) {
					_, errSend := client.SendMessage(context.Background(), tJID, rawMsg)
					if errSend != nil {
						log.Printf("⚠️ [Channel Router] Rule #%d failed to forward to %s (%s): %v", rID, tName, tJID.String(), errSend)
					} else {
						log.Printf("✅ [Channel Router] Rule #%d successfully forwarded post to %s (%s)", rID, tName, tJID.String())
					}
				}(targetJID, msgToSend, rule.ID, rule.TargetName)
			}
			return // Return here! Channel broadcasts must not enter customer conversational AI pipeline
		}

		if v.Info.IsFromMe || v.Info.IsGroup {
			return
		}

		if v.Info.Sender.Server == "newsletter" || v.Info.Chat.Server == "newsletter" || v.Info.Chat.Server == "broadcast" {
			return // Ignore newsletters, channels, status broadcasts for customer AI workflow
		}

		// 1. INSTANT BLUE TICKS (MarkRead) - Fired IMMEDIATELY upon message packet receipt!
		// Converts Single Tick to Double Blue Tick in <0.1s so customer never waits on single tick!
		if client != nil {
			go func(id types.MessageID, ts time.Time, chat, sender types.JID) {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_ = client.MarkRead(ctx, []types.MessageID{id}, ts, chat, sender)
				if !chat.IsEmpty() && chat != sender {
					_ = client.MarkRead(ctx, []types.MessageID{id}, ts, chat, types.EmptyJID)
				}
			}(v.Info.ID, v.Info.Timestamp, v.Info.Chat, v.Info.Sender)
		}

		// Zero-Delay Smart Human-Override Check (Read Receipt Race Condition)
		if _, isReadByHuman := MessageReadByHuman.Load(string(v.Info.ID)); isReadByHuman {
			log.Printf("👤 Human took over - Skipping AI pipeline for message %s", string(v.Info.ID))
			return
		}

		senderPhone := ResolveRealPhoneNumber(client, v.Info.Sender, v.Info.Chat)
		if senderPhone == "" || len(senderPhone) < 8 || strings.HasPrefix(senderPhone, "120363") {
			return // Ignore invalid or broadcast JIDs
		}

		// Immediate Typing Indicator Feedback (0ms Latency for UX)
		if activeClient := client; activeClient != nil && activeClient.IsLoggedIn() {
			_ = activeClient.SendChatPresence(context.Background(), v.Info.Chat, types.ChatPresenceComposing, types.ChatPresenceMediaText)
			if !v.Info.Sender.IsEmpty() && v.Info.Sender != v.Info.Chat {
				_ = activeClient.SendChatPresence(context.Background(), v.Info.Sender, types.ChatPresenceComposing, types.ChatPresenceMediaText)
			}
		}

		var msgText string
		locLat, locLng, hasLocation := extractLocationCoords(v.Message)
		if hasLocation {
			log.Printf("📍 [Hyperlocal Location Received] +%s (@%s): Lat=%.6f, Lng=%.6f", senderPhone, username, locLat, locLng)

			shortLoc, fullAddr := FetchReverseGeocodeLocation(locLat, locLng)
			resolvedAddr := fullAddr
			if resolvedAddr == "" {
				resolvedAddr = shortLoc
			}
			if resolvedAddr == "" {
				resolvedAddr = fmt.Sprintf("Coordinates: %.6f, %.6f", locLat, locLng)
			}

			// Update customer profile coordinates and address in Neon DB
			_ = UpdateCustomerCoordinates(username, senderPhone, locLat, locLng, resolvedAddr)

			// Validate distance with business coordinates
			busLat, busLng, maxRadius := GetBusinessLocation(username)
			distKM := CalculateDistance(busLat, busLng, locLat, locLng)
			log.Printf("📍 [Delivery Radius Validation] +%s -> Distance: %.2f km (Max Allowed: %.1f km)", senderPhone, distKM, maxRadius)

			if distKM > maxRadius {
				// Distance > MaxRadiusKM: Pass delivery constraint context to AI to reply naturally without hardcoded text
				msgText = fmt.Sprintf("[Customer Shared Location Pin]: %s (Distance: %.1f km). NOTE TO AI: The store's maximum delivery radius is %.1f km. The customer is outside delivery range. Politely and warmly inform them using WhatsApp quotes (>) and emojis that home delivery is not available for this distance, and offer store pickup or counter visit.", resolvedAddr, distKM, maxRadius)
			} else {
				// Distance <= MaxRadiusKM: Feed location acknowledgment into conversation history
				msgText = fmt.Sprintf("[Customer Shared Location Pin]: %s (Distance: %.1f km - within delivery radius). Coordinates: %.6f, %.6f", resolvedAddr, distKM, locLat, locLng)
			}
		} else {
			// Check if customer is in PENDING payment status and sent an image (Payment Screenshot)
			hasScreenshot := isIncomingImageOrDocument(v.Message)
			payStatus := GetCustomerPaymentStatus(username, senderPhone)
			custState := GetCustomerState(username, senderPhone)
			isPending := strings.EqualFold(payStatus, "PENDING") || strings.EqualFold(custState, "PAYMENT_PENDING")

			if hasScreenshot && isPending {
				imgMsg := extractIncomingImageMessage(v.Message)
				if imgMsg != nil && imgMsg.GetCaption() != "" {
					msgText = fmt.Sprintf("[Payment Screenshot]: %s", strings.TrimSpace(imgMsg.GetCaption()))
				} else {
					msgText = "[Payment Screenshot]"
				}
				log.Printf("📸 [Payment Screenshot Received] Customer +%s (@%s) sent screenshot during PENDING state", senderPhone, username)
			} else {
				// 2. Ignore incoming media messages (Photo, Video, Audio, Sticker, Doc, Contact, Catalog) without reply
				if isMediaMessage(v.Message) {
					log.Printf("🚫 Incoming message from +%s (@%s) contains media or catalog. Ignored without reply as requested.", senderPhone, username)
					return
				}

				msgText = extractMessageText(username, client, v.Message)
				if msgText == "" {
					return
				}
			}
		}

		lockKey := username + "_" + senderPhone

		// 3. Concurrency Lock: While reply is in-flight for this customer, ignore incoming messages
		// to maintain polite conversational order and prevent overlapping AI replies
		customerInFlightLock.Lock()
		if customerInFlightMap[lockKey] {
			customerInFlightLock.Unlock()
			log.Printf("⏳ [Customer Concurrency Lock] Inbound message from +%s (@%s) dropped/ignored while previous reply is in-flight: %s", senderPhone, username, msgText)
			return
		}
		customerInFlightMap[lockKey] = true
		customerInFlightLock.Unlock()

		log.Printf("📩 Incoming message received from +%s (@%s): %s", senderPhone, username, msgText)

		// Record exact WhatsApp JID mapping for direct reply delivery
		lidCacheLock.Lock()
		phoneToJID[senderPhone] = v.Info.Sender
		if senderPhone != v.Info.Sender.User {
			phoneToJID[v.Info.Sender.User] = v.Info.Sender
		}
		lidCacheLock.Unlock()

		// 4. RAM-First Processing & Instant Live Chat SSE UI Dispatch (0ms latency)
		_ = updateSlidingWindowRAM(username, senderPhone, "customer", msgText)
		PushToLiveChat(username, senderPhone, msgText, "incoming")

		// 5. Asynchronous Non-Blocking DB Persistence & Lead Qualification
		go func() {
			SaveCustomerChatAndPrune(username, senderPhone, "customer", msgText)
			CheckAndProcessLead(username, client, senderPhone, msgText, v.Message)
		}()

		// 6. Concurrent Ultra-Fast AI Reply Generation with Continuous WhatsApp Typing Loop
		go func() {
			defer func() {
				customerInFlightLock.Lock()
				delete(customerInFlightMap, lockKey)
				customerInFlightLock.Unlock()
			}()

			// Zero-Delay Smart Human-Override Check inside goroutine before calling AI
			if _, isReadByHuman := MessageReadByHuman.Load(string(v.Info.ID)); isReadByHuman {
				log.Printf("👤 Skipping AI - Human is active (Message %s read by business owner)", string(v.Info.ID))
				return
			}

			payStatus := GetCustomerPaymentStatus(username, senderPhone)
			custState := GetCustomerState(username, senderPhone)

			// Screenshot Forwarding Fallback to Business Owner
			incomingImg := extractIncomingImageMessage(v.Message)
			hasScreenshot := incomingImg != nil || isIncomingImageOrDocument(v.Message) || strings.HasPrefix(msgText, "[Payment Screenshot]")

			if hasScreenshot && (strings.EqualFold(payStatus, "PENDING") || strings.EqualFold(custState, "PAYMENT_PENDING")) {
				log.Printf("📸 [Payment Screenshot Received] Customer +%s sent screenshot during PENDING state. Triggering Phase 6: Direct Human Escalation Bypass.", senderPhone)

				orderID := GetCustomerCurrentOrderID(username, senderPhone)
				var totalAmt float64
				calcRes, _ := CalculateCartTotalAndFetchCredentials(username, senderPhone)
				if calcRes != nil && calcRes.TotalAmount > 0 {
					totalAmt = calcRes.TotalAmount
				} else if DB != nil {
					_ = DB.QueryRow(`SELECT COALESCE(total_amount, 0) FROM customer_order_states WHERE customer_phone=$1 ORDER BY updated_at DESC LIMIT 1`, senderPhone).Scan(&totalAmt)
				}
				if orderID == "" {
					orderID = fmt.Sprintf("ORD%d", time.Now().UnixNano())
					_ = SetCustomerCurrentOrderID(username, senderPhone, orderID)
				}

				custProfile, _ := GetCustomerProfile(username, senderPhone)
				custName := senderPhone
				delAddr := "Not provided"
				if custProfile != nil {
					if strings.TrimSpace(custProfile.FullName) != "" {
						custName = strings.TrimSpace(custProfile.FullName)
					}
					if strings.TrimSpace(custProfile.DeliveryAddress) != "" {
						delAddr = strings.TrimSpace(custProfile.DeliveryAddress)
					}
				}

				ownerAlertPhone := GetMerchantAlertPhone(username)
				cleanNotifPhone := FormatPhone(ownerAlertPhone)

				disputeAlert := fmt.Sprintf("🚨 *[PAYMENT SCREENSHOT / DISPUTE ALERT]*\n• Customer: %s (+%s)\n• Address: %s\n• Order ID: %s\n• Cart Total: ₹%.2f\nCustomer sent payment screenshot. Please verify.", custName, senderPhone, delAddr, orderID, totalAmt)

				activeClient := client
				if activeClient == nil || !activeClient.IsLoggedIn() {
					activeClient = GetOrCreateClient(username)
				}

				// 1. Forwards screenshot and cart total to Business Owner's Lead Alert WhatsApp number
				if activeClient != nil && activeClient.IsLoggedIn() && cleanNotifPhone != "" && len(cleanNotifPhone) >= 10 {
					_ = SendMessage(activeClient, cleanNotifPhone, disputeAlert)
					if incomingImg != nil {
						go func(c *whatsmeow.Client, target string, img *waE2E.ImageMessage, ord string) {
							imgBytes, errDown := c.Download(context.Background(), img)
							if errDown == nil && len(imgBytes) > 0 {
								_ = SendImageFromBytes(c, target, imgBytes, fmt.Sprintf("📸 Attached Screenshot from %s (Order #%s)", custName, ord))
								log.Printf("✅ [Screenshot Forwarded] Delivered customer screenshot bytes to business owner +%s", target)
							}
						}(activeClient, cleanNotifPhone, incomingImg, orderID)
					}
				}

				PushToLiveChat(username, senderPhone, disputeAlert, "lead_alert")

				// 2. Dynamic AI reply to customer acknowledging payment screenshot
				cfgSnap := GetUserConfigRAM(username)
				aiPrompt := fmt.Sprintf("Customer (+%s) sent a payment screenshot for Order %s (Total: Rs. %.2f). The screenshot has been forwarded to the store owner for manual verification. Thank the customer warmly with WhatsApp quotes (>) and emojis, acknowledge receipt of their screenshot, and assure them their order will be verified and processed shortly.", senderPhone, orderID, totalAmt)
				userReply, errAI := GenerateAIContextualReply(username, senderPhone, aiPrompt, cfgSnap)
				if errAI != nil || userReply == "" {
					userReply = fmt.Sprintf("> 📸 *PAYMENT SCREENSHOT RECEIVED* 🙏\n> _Order #%s • Amount: ₹%.2f_\n\nAapka screenshot prapt ho gaya hai! Humare store owner ko verify karne ke liye bhej diya gaya hai. Thodi hi der me aapka order confirm ho jayega! Dhanyawad! ✨🚚", orderID, totalAmt)
				}
				if activeClient != nil && activeClient.IsLoggedIn() {
					_ = SendReplyMessage(activeClient, senderPhone, userReply, v.Info.ID, v.Info.Sender, v.Message)
				}
				PushToLiveChat(username, senderPhone, userReply, "outgoing_ai")
				go SaveCustomerChatAndPrune(username, senderPhone, "assistant", userReply)

				// 3. Clears the cart so user isn't stuck forever & keep state as chatting
				_ = SetCustomerState(username, senderPhone, "chatting")
				_ = SetCustomerPaymentStatus(username, senderPhone, "BROWSING")
				_ = SetCustomerCurrentOrderID(username, senderPhone, "")
				_ = ClearActiveCart(username, senderPhone)
				if DB != nil {
					_, _ = DB.Exec(`UPDATE customers SET current_order_id = '', payment_status = 'BROWSING', current_state = 'chatting', updated_at = NOW() WHERE wa_number = $1 OR wa_number LIKE '%' || $1`, senderPhone)
					_, _ = DB.Exec(`DELETE FROM active_carts WHERE customer_phone=$1 OR customer_phone LIKE '%' || $1`, senderPhone)
					_, _ = DB.Exec(`UPDATE customer_order_states SET payment_status = 'disputed_screenshot', order_status = 'escalated_to_human', updated_at = NOW() WHERE customer_phone=$1 AND payment_status != 'paid'`, senderPhone)
				}

				log.Printf("✅ [Phase 6: Human Escalation Bypass Complete] Screenshot forwarded to +%s, user replied, cart cleared for +%s", cleanNotifPhone, senderPhone)
				return // Direct Bypass: DO NOT call AI!
			}

			if strings.EqualFold(custState, "ORDER_CONFIRMED") {
				_ = SetCustomerState(username, senderPhone, "chatting")
				_ = ClearActiveCart(username, senderPhone)
				if DB != nil {
					_, _ = DB.Exec(`DELETE FROM active_carts WHERE customer_phone=$1 OR customer_phone LIKE '%' || $1`, senderPhone)
				}
			}

			// 0. CONTINUOUS AI CONVERSATION (NEVER LOCK CHAT ON HUMAN ESCALATION)
			// Customer continues receiving polite, helpful AI assistance even after store owner has been notified
			if strings.EqualFold(custState, "HUMAN_OVERRIDE") {
				_ = SetCustomerState(username, senderPhone, "chatting")
				log.Printf("🤖 [Continuous AI Active]: Customer +%s continues chatting with AI (owner already alerted).", senderPhone)
			}

			normGreet := strings.ToLower(strings.TrimSpace(msgText))
			if normGreet == "hi" || normGreet == "hello" || normGreet == "namaste" || normGreet == "start" || normGreet == "menu" || normGreet == "new order" {
				_ = ClearActiveCart(username, senderPhone)
				if DB != nil {
					_, _ = DB.Exec(`DELETE FROM active_carts WHERE customer_phone=$1 OR customer_phone LIKE '%' || $1`, senderPhone)
				}
			}

			cfg := GetUserConfigRAM(username)

			if cfg != nil && cfg.AutoReply {
				activeClient := client
				if activeClient == nil || !activeClient.IsLoggedIn() {
					activeClient = GetOrCreateClient(username)
				}

				stopTyping := make(chan struct{})
				var stopOnce sync.Once
				stopTypingFunc := func() {
					stopOnce.Do(func() {
						close(stopTyping)
					})
				}
				defer stopTypingFunc()

				targetChat := v.Info.Chat
				targetSender := v.Info.Sender

				if activeClient != nil {
					go func() {
						ticker := time.NewTicker(1500 * time.Millisecond)
						defer ticker.Stop()

						_ = activeClient.SendChatPresence(context.Background(), targetChat, types.ChatPresenceComposing, types.ChatPresenceMediaText)
						if !targetSender.IsEmpty() && targetSender != targetChat {
							_ = activeClient.SendChatPresence(context.Background(), targetSender, types.ChatPresenceComposing, types.ChatPresenceMediaText)
						}

						for {
							select {
							case <-stopTyping:
								_ = activeClient.SendChatPresence(context.Background(), targetChat, types.ChatPresencePaused, types.ChatPresenceMediaText)
								if !targetSender.IsEmpty() && targetSender != targetChat {
									_ = activeClient.SendChatPresence(context.Background(), targetSender, types.ChatPresencePaused, types.ChatPresenceMediaText)
								}
								return
							case <-ticker.C:
								_ = activeClient.SendChatPresence(context.Background(), targetChat, types.ChatPresenceComposing, types.ChatPresenceMediaText)
								if !targetSender.IsEmpty() && targetSender != targetChat {
									_ = activeClient.SendChatPresence(context.Background(), targetSender, types.ChatPresenceComposing, types.ChatPresenceMediaText)
								}
							}
						}
					}()
				}

				// 1. Generate Agentic AI Multi-Action Response through Octopus Brain
				octopusResp, errAI := GenerateOctopusAIReply(username, senderPhone, msgText, cfg)
				stopTypingFunc()

				if errAI != nil || octopusResp == nil {
					log.Printf("⚠️ [Octopus Brain] Failed to generate AI reply for +%s: %v", senderPhone, errAI)
					fallbackMsg := SafeAIFallbackReply
					if activeClient != nil && activeClient.IsLoggedIn() {
						_ = SendReplyMessage(activeClient, senderPhone, fallbackMsg, v.Info.ID, v.Info.Sender, v.Message)
					}
					PushToLiveChat(username, senderPhone, fallbackMsg, "outgoing_ai")
					go SaveCustomerChatAndPrune(username, senderPhone, "assistant", fallbackMsg)
					return
				}

				// 2. GOLANG EXECUTION ENGINE (HANDLING MULTI-ACTION ARRAYS)
				var executionErr error
				var failedActionName string
				var paymentVerifiedExecuted bool

				for _, act := range octopusResp.Actions {
					hand := strings.ToLower(strings.TrimSpace(act.Hand))
					switch hand {
					case "cancel_order":
						err := ExecuteCancelOrderHand(username, senderPhone)
						if err != nil {
							executionErr = err
							failedActionName = "cancel_order"
							break
						}

					case "update_cart":
						if act.Payload != nil && len(act.Payload.CartItems) > 0 {
							err := ExecuteUpdateCartHand(username, senderPhone, act.Payload.CartItems)
							if err != nil {
								executionErr = err
								failedActionName = "update_cart"
								break
							}
							calcRes, _ := CalculateCartTotalAndFetchCredentials(username, senderPhone)
							if calcRes != nil && calcRes.TotalAmount > 0 {
								totStr := fmt.Sprintf("%.2f", calcRes.TotalAmount)
								octopusResp.AIReplyText = strings.ReplaceAll(octopusResp.AIReplyText, "[Total]", totStr)
								octopusResp.AIReplyText = strings.ReplaceAll(octopusResp.AIReplyText, "[total]", totStr)
								octopusResp.AIReplyText = strings.ReplaceAll(octopusResp.AIReplyText, "{total}", totStr)
							}
						}

					case "extract_profile":
						if act.Payload != nil && act.Payload.Profile != nil {
							// Asynchronous profile extraction for instant AI reply delivery
							go func(prof *AIProfileDataPayload) {
								_ = ExecuteExtractProfileHand(username, senderPhone, prof)
							}(act.Payload.Profile)
						}

					case "send_catalog_images":
						cat := ""
						if act.Payload != nil {
							cat = act.Payload.Category
						}
						err := SendCatalogImagesHand(activeClient, username, senderPhone, cat)
						if err != nil {
							executionErr = err
							failedActionName = "send_catalog_images"
							break
						}

					case "generate_payment_qr":
						err := ExecuteGeneratePaymentQRHand(activeClient, username, senderPhone, cfg, v)
						if err != nil {
							executionErr = err
							failedActionName = "generate_payment_qr"
							break
						}

					case "verify_payment":
						// PHASE 5: Send wait text first, then execute Paytm verification
						waitMsg := strings.TrimSpace(octopusResp.AIReplyText)
						if waitMsg == "" {
							waitMsg = "> ⏳ *VERIFYING PAYMENT STATUS* 🔍\n> _Please wait a moment while we confirm with the bank..._\n\nBina delay ke check kar raha hu, kripya 2 second rukie! 🚀"
						}
						if activeClient != nil && activeClient.IsLoggedIn() {
							_ = SendReplyMessage(activeClient, senderPhone, waitMsg, v.Info.ID, v.Info.Sender, v.Message)
						}
						PushToLiveChat(username, senderPhone, waitMsg, "outgoing_ai")
						go SaveCustomerChatAndPrune(username, senderPhone, "assistant", waitMsg)

						paymentVerifiedExecuted = true
						err := ExecuteVerifyPaymentHand(activeClient, username, senderPhone, cfg, v)
						if err != nil {
							executionErr = err
							failedActionName = "verify_payment"
							break
						}

					case "escalate_to_human":
						custProf, _ := GetCustomerProfile(username, senderPhone)
						custName := ""
						if custProf != nil {
							custName = custProf.FullName
						}
						err := ExecuteEscalateToHumanHand(activeClient, username, senderPhone, custName, v)
						if err != nil {
							executionErr = err
							failedActionName = "escalate_to_human"
							break
						}

					case "chat_only", "":
						// Pure conversational reply
					}

					if executionErr != nil {
						break
					}
				}

				// 3. THE INTERNAL FEEDBACK LOOP (ERROR HANDLING)
				if executionErr != nil {
					log.Printf("⚠️ [Internal Feedback Loop Triggered]: Action '%s' failed for +%s: %v", failedActionName, senderPhone, executionErr)
					apology, errApology := GenerateAIFeedbackApology(username, senderPhone, failedActionName, executionErr.Error(), cfg)
					if errApology == nil && strings.TrimSpace(apology) != "" {
						if activeClient != nil && activeClient.IsLoggedIn() {
							_ = SendReplyMessage(activeClient, senderPhone, apology, v.Info.ID, v.Info.Sender, v.Message)
						}
						PushToLiveChat(username, senderPhone, apology, "outgoing_ai")
						go SaveCustomerChatAndPrune(username, senderPhone, "assistant", apology)
					} else {
						fallbackMsg := "> ⚠️ *STORE ASSISTANT UPDATE* 💬\n> _Kripya ek pal intezar karein._\n\nMaaf kijiye, abhi request process karne me thodi rukawat aayi. Kripya thodi der baad dobara batayein ya humare store se direct sampark karein! 🙏✨"
						if activeClient != nil && activeClient.IsLoggedIn() {
							_ = SendReplyMessage(activeClient, senderPhone, fallbackMsg, v.Info.ID, v.Info.Sender, v.Message)
						}
						PushToLiveChat(username, senderPhone, fallbackMsg, "outgoing_ai")
						go SaveCustomerChatAndPrune(username, senderPhone, "assistant", fallbackMsg)
					}
				} else if !paymentVerifiedExecuted {
					// 4. If all actions executed successfully and verify_payment didn't already send final reply, send context-aware ai_reply_text
					// Strictly sanitize ai_reply_text: strip any leaking actions array, JSON braces, or asterisks
					aiReply := SanitizeAIReplyText(octopusResp.AIReplyText)
					if aiReply == "" || strings.HasPrefix(aiReply, "{") || strings.Contains(aiReply, "*actions*:") || strings.Contains(aiReply, "\"actions\":") {
						aiReply = SafeAIFallbackReply
					}
					if activeClient != nil && activeClient.IsLoggedIn() {
						sendErr := SendReplyMessage(activeClient, senderPhone, aiReply, v.Info.ID, v.Info.Sender, v.Message)
						if sendErr != nil {
							log.Printf("⚠️ Error delivering ai_reply_text to +%s: %v", senderPhone, sendErr)
						} else {
							log.Printf("⚡ [Octopus Brain] Multi-Action reply delivered to +%s: %s", senderPhone, aiReply)
						}
						PushToLiveChat(username, senderPhone, aiReply, "outgoing_ai")
						go SaveCustomerChatAndPrune(username, senderPhone, "assistant", aiReply)
					}
				}
			}
		}()

	case *events.Disconnected:
		log.Printf("⚠️ WebSocket disconnected for @%s. Triggering auto-reconnect retry loop...", username)
		ConnectWithAutoRetry(client, username)

	case *events.LoggedOut:
		fmt.Printf("⚠️ User @%s connection closed or unlinked notice. Reason: %v\n", username, v.Reason)
		ClientsLock.Lock()
		delete(ActiveClients, username)
		delete(QRChannelMap, username)
		ClientsLock.Unlock()

		if client != nil {
			client.Disconnect()
		}

		if DB != nil {
			// Update status only; PRESERVE wa_jid and tenant_whatsapp_sessions so on reboot it can reconnect!
			_, _ = DB.Exec("UPDATE users SET status='Disconnected' WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1)", username)
		}

		PushToLiveChat(username, "", "WhatsApp session disconnected", "session_unlinked")

	case *events.Connected:
		if client != nil {
			_ = client.SendPresence(context.Background(), types.PresenceAvailable)
		}
		if client != nil && client.Store.ID != nil {
			jidStr := client.Store.ID.User
			SaveSessionToDB(username, client.Store.ID.String(), jidStr, "")
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp session connected successfully", "session_connected")
		}

	case *events.PairSuccess:
		if client != nil {
			_ = client.SendPresence(context.Background(), types.PresenceAvailable)
		}
		if client != nil && client.Store.ID != nil {
			jidStr := client.Store.ID.User
			SaveSessionToDB(username, client.Store.ID.String(), jidStr, "")
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp paired successfully", "session_connected")
		}
	}
}

// AutoConnectAllSessions initializes and connects all saved WhatsApp clients on boot
func AutoConnectAllSessions() {
	userMap := make(map[string]bool)

	if DB != nil {
		rows, err := DB.Query("SELECT DISTINCT username FROM users WHERE wa_jid != '' OR phone != ''")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var u string
				if errScan := rows.Scan(&u); errScan == nil && u != "" {
					userMap[strings.ToLower(strings.TrimSpace(u))] = true
				}
			}
		}

		rows2, err2 := DB.Query("SELECT DISTINCT username FROM tenant_whatsapp_sessions WHERE device_jid != ''")
		if err2 == nil {
			defer rows2.Close()
			for rows2.Next() {
				var u string
				if errScan := rows2.Scan(&u); errScan == nil && u != "" {
					userMap[strings.ToLower(strings.TrimSpace(u))] = true
				}
			}
		}
	}

	// Also check StoreContainer directly in case DB rows were wiped
	if StoreContainer != nil {
		allDevs, errDev := StoreContainer.GetAllDevices(context.Background())
		if errDev == nil && len(allDevs) > 0 {
			for _, dev := range allDevs {
				if dev != nil && dev.ID != nil && dev.ID.User != "" {
					log.Printf("📱 [Boot Store Check] Found PostgreSQL persistent device: %s (%s)", dev.ID.User, dev.ID.String())
					if len(userMap) == 0 {
						userMap["admin"] = true
					}
				}
			}
		}
	}

	count := 0
	for usr := range userMap {
		go func(username string) {
			c := GetOrCreateClient(username)
			if c != nil && c.Store != nil && c.Store.ID != nil {
				log.Printf("🚀 [Persistent Session Restored] Auto-connecting WhatsApp for @%s (Device: %s)...", username, c.Store.ID.User)
				ConnectWithAutoRetry(c, username)
			}
		}(usr)
		count++
	}
	if count > 0 {
		log.Printf("⚡ [WhatsApp Gateway] Auto-initialized %d active WhatsApp account sessions on boot.", count)
	}
}

// StartKeepAliveMonitor checks active clients every 45 seconds and re-establishes broken WebSockets
func StartKeepAliveMonitor() {
	go func() {
		ticker := time.NewTicker(45 * time.Second)
		for range ticker.C {
			ClientsLock.Lock()
			var activeUsers []string
			for usr := range ActiveClients {
				activeUsers = append(activeUsers, usr)
			}
			ClientsLock.Unlock()

			for _, usr := range activeUsers {
				ClientsLock.Lock()
				client := ActiveClients[usr]
				ClientsLock.Unlock()

				if client != nil && client.Store != nil && client.Store.ID != nil && !client.IsConnected() {
					log.Printf("🔄 [KeepAlive] Client @%s WebSocket dropped; reconnecting...", usr)
					ConnectWithAutoRetry(client, usr)
				}
			}
		}
	}()
}

func PushToLiveChat(username, phone, text, msgType string) {
	StreamLock.Lock()
	ch, exists := LiveChatStreams[username]
	StreamLock.Unlock()

	if exists {
		select {
		case ch <- map[string]string{
			"phone": phone,
			"text":  text,
			"type":  msgType,
			"time":  time.Now().Format("15:04"),
		}:
		default:
			// Agar browser tab band hai to drop kar do (Zero RAM leak!)
		}
	}
}


// ShouldQuoteMessage determines if quoting the customer's previous message is truly contextually needed.
// Only quotes media (images/documents) or specific reference questions (order #, payment verification).
// Normal greetings, inquiries, and chat turns are delivered cleanly without cluttering quote boxes.
func ShouldQuoteMessage(quotedMsg *waE2E.Message) bool {
	if quotedMsg == nil {
		return false
	}
	// 1. Quoting media (images, documents, video) is helpful
	if quotedMsg.GetImageMessage() != nil || quotedMsg.GetDocumentMessage() != nil || quotedMsg.GetVideoMessage() != nil {
		return true
	}
	// 2. Specific questions directly referencing an order number, transaction, or UTR
	text := strings.ToLower(strings.TrimSpace(quotedMsg.GetConversation() + quotedMsg.GetExtendedTextMessage().GetText()))
	if strings.Contains(text, "order #") || strings.Contains(text, "order id") || strings.Contains(text, "utr") || strings.Contains(text, "txn") {
		return true
	}
	// Standard conversation, greetings, menu, questions ("tum kon ho", "nhi karunga payment", "hi"):
	// DO NOT quote! Keep messages clean and beautiful.
	return false
}

// SendReplyMessage sends an AI text reply, natively quoting only when contextually necessary for clean aesthetics
func SendReplyMessage(client *whatsmeow.Client, phone string, replyText string, quotedID types.MessageID, quotedSender types.JID, quotedMsg *waE2E.Message) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}
	if err := EnsureConnected(client); err != nil {
		return err
	}

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()

	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	var msg *waE2E.Message
	if quotedID != "" && quotedMsg != nil && ShouldQuoteMessage(quotedMsg) {
		participantJID := quotedSender.ToNonAD().String()
		msg = &waE2E.Message{
			ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text: proto.String(replyText),
				ContextInfo: &waE2E.ContextInfo{
					StanzaID:      proto.String(string(quotedID)),
					Participant:   proto.String(participantJID),
					QuotedMessage: quotedMsg,
				},
			},
		}
	} else {
		msg = &waE2E.Message{Conversation: proto.String(replyText)}
	}

	_, err := client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if targetJID.Server == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// SendImageReplyFromURL sends an image with caption natively quoting the customer's incoming message in WhatsApp
func SendImageReplyFromURL(client *whatsmeow.Client, phone, imageURL, caption string, quotedID types.MessageID, quotedSender types.JID, quotedMsg *waE2E.Message) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}
	if err := EnsureConnected(client); err != nil {
		return err
	}
	var imgBytes []byte
	var err error
	imageURL = strings.TrimSpace(imageURL)
	if strings.HasPrefix(imageURL, "data:image/") {
		parts := strings.SplitN(imageURL, ",", 2)
		if len(parts) == 2 {
			imgBytes, err = base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return fmt.Errorf("failed to decode base64 image: %v", err)
			}
		}
	} else if strings.HasPrefix(imageURL, "http://") || strings.HasPrefix(imageURL, "https://") {
		clientHttp := &http.Client{Timeout: 15 * time.Second}
		resp, fetchErr := clientHttp.Get(imageURL)
		if fetchErr != nil {
			return fmt.Errorf("image download failed: %v", fetchErr)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("image URL returned HTTP %d: %s", resp.StatusCode, imageURL)
		}
		imgBytes, err = io.ReadAll(io.LimitReader(resp.Body, 1024*1024*8))
		if err != nil {
			return err
		}
	} else {
		return fmt.Errorf("unsupported image format or empty URL")
	}
	if len(imgBytes) < 50 {
		return fmt.Errorf("empty or too small image payload (%d bytes)", len(imgBytes))
	}

	// Validate magic bytes to prevent uploading corrupted files or HTML error pages
	isValidImage := bytes.HasPrefix(imgBytes, []byte("\x89PNG")) || bytes.HasPrefix(imgBytes, []byte("\xff\xd8")) || bytes.HasPrefix(imgBytes, []byte("RIFF")) || bytes.HasPrefix(imgBytes, []byte("GIF8"))
	if !isValidImage {
		preview := string(imgBytes[:min(30, len(imgBytes))])
		return fmt.Errorf("downloaded content is not a valid image format (starts with: %q)", preview)
	}

	mimeType := http.DetectContentType(imgBytes)
	if !strings.HasPrefix(mimeType, "image/") {
		return fmt.Errorf("invalid image mime type: %s", mimeType)
	}

	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()
	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	imageMsg := &waE2E.ImageMessage{
		Caption:       proto.String(caption),
		URL:           proto.String(uploaded.URL),
		DirectPath:    proto.String(uploaded.DirectPath),
		MediaKey:      uploaded.MediaKey,
		Mimetype:      proto.String(mimeType),
		FileEncSHA256: uploaded.FileEncSHA256,
		FileSHA256:    uploaded.FileSHA256,
		FileLength:    proto.Uint64(uint64(len(imgBytes))),
		JPEGThumbnail: UniversalThumbnail,
	}
	if quotedID != "" && quotedMsg != nil {
		imageMsg.ContextInfo = &waE2E.ContextInfo{
			StanzaID:      proto.String(string(quotedID)),
			Participant:   proto.String(quotedSender.ToNonAD().String()),
			QuotedMessage: quotedMsg,
		}
	}

	msg := &waE2E.Message{ImageMessage: imageMsg}
	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if primaryServer == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// 1. Text Message Bhejna (Supports both Standard PN and LID JIDs with fallback)
func SendMessage(client *whatsmeow.Client, phone string, message string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}

	if err := EnsureConnected(client); err != nil {
		return err
	}

	// 1. Check if we have exact sender JID cached from incoming message
	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()

	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	msg := &waE2E.Message{Conversation: proto.String(message)}
	_, err := client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if targetJID.Server == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// 2. Image URL or Base64 Data URI Se Photo + Caption Bhejna (Supports both Standard PN and LID JIDs)
func SendImageFromURL(client *whatsmeow.Client, phone, imageURL, caption string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}

	if err := EnsureConnected(client); err != nil {
		return err
	}

	var imgBytes []byte
	var err error

	imageURL = strings.TrimSpace(imageURL)
	if strings.HasPrefix(imageURL, "data:image/") {
		parts := strings.SplitN(imageURL, ",", 2)
		if len(parts) == 2 {
			imgBytes, err = base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return fmt.Errorf("failed to decode base64 image: %v", err)
			}
		}
	} else if strings.HasPrefix(imageURL, "http://") || strings.HasPrefix(imageURL, "https://") {
		clientHttp := &http.Client{Timeout: 20 * time.Second}
		resp, fetchErr := clientHttp.Get(imageURL)
		if fetchErr != nil {
			return fmt.Errorf("image download failed: %v", fetchErr)
		}
		defer resp.Body.Close()
		imgBytes, err = io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
	} else {
		return fmt.Errorf("unsupported image format or empty URL")
	}

	if len(imgBytes) == 0 {
		return fmt.Errorf("empty image payload")
	}

	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}

	mimeType := http.DetectContentType(imgBytes)

	// Check exact sender JID
	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()

	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	msg := &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{
			Caption:       proto.String(caption),
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      proto.String(mimeType),
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    proto.Uint64(uint64(len(imgBytes))),
			JPEGThumbnail: UniversalThumbnail,
		},
	}

	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if primaryServer == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// SendImageFromBytes uploads raw image bytes to WhatsApp and delivers to phone with caption
func SendImageFromBytes(client *whatsmeow.Client, phone string, imgBytes []byte, caption string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}
	if len(imgBytes) == 0 {
		return fmt.Errorf("empty image payload")
	}

	if err := EnsureConnected(client); err != nil {
		return err
	}

	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}

	mimeType := http.DetectContentType(imgBytes)
	if !strings.HasPrefix(mimeType, "image/") {
		mimeType = "image/jpeg"
	}

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()

	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	msg := &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{
			Caption:       proto.String(caption),
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      proto.String(mimeType),
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    proto.Uint64(uint64(len(imgBytes))),
			JPEGThumbnail: UniversalThumbnail,
		},
	}

	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if primaryServer == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// 3. Bulk Sender (Text + Optional Image URL + Anti-Ban Delay)
func SendBulkMessages(client *whatsmeow.Client, phones []string, message string, imageURL string, useAntiBan bool) []map[string]interface{} {
	var results []map[string]interface{}

	for i, phone := range phones {
		if useAntiBan && i > 0 {
			delay := time.Duration(rand.Intn(6)+3) * time.Second
			time.Sleep(delay)
		}

		var err error
		if imageURL != "" {
			err = SendImageFromURL(client, phone, imageURL, message)
		} else {
			err = SendMessage(client, phone, message)
		}

		if err != nil {
			results = append(results, map[string]interface{}{"phone": phone, "status": "failed", "error": err.Error()})
		} else {
			results = append(results, map[string]interface{}{"phone": phone, "status": "success"})
		}
	}
	return results
}

func parsePriceToFloat(raw interface{}) float64 {
	if raw == nil {
		return 0.0
	}
	switch v := raw.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case []byte:
		s := strings.TrimSpace(string(v))
		s = strings.ReplaceAll(s, "₹", "")
		s = strings.ReplaceAll(s, ",", "")
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	case string:
		s := strings.TrimSpace(v)
		s = strings.ReplaceAll(s, "₹", "")
		s = strings.ReplaceAll(s, ",", "")
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	default:
		s := fmt.Sprintf("%v", raw)
		s = strings.ReplaceAll(s, "₹", "")
		s = strings.ReplaceAll(s, ",", "")
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	}
}

// SendCatalogImagesHand (Hand: send_catalog_images): queries DB for matching products/categories, downloads image_url, and sends ImageMessages via whatsmeow
func SendCatalogImagesHand(client *whatsmeow.Client, username, customerPhone, category string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp client is disconnected")
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	cleanCat := strings.TrimSpace(category)

	if DB == nil {
		return fmt.Errorf("database connection unavailable")
	}

	type catalogProduct struct {
		Name     string
		Price    float64
		ImageURL string
	}
	var productsList []catalogProduct

	var rows *sql.Rows
	var err error
	if cleanCat != "" && !strings.EqualFold(cleanCat, "all") && !strings.EqualFold(cleanCat, "general") {
		q := `SELECT name, price, COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
			FROM products 
			WHERE (LOWER(username)=$1 OR LOWER(username)=$2) 
			  AND (in_stock IS TRUE OR in_stock IS NULL)
			  AND (LOWER(category) LIKE '%' || LOWER($3) || '%' OR LOWER(name) LIKE '%' || LOWER($3) || '%')
			  AND (COALESCE(image_url, '') != '' OR COALESCE(product_image_url, '') != '')
			ORDER BY id ASC LIMIT 4`
		rows, err = DB.Query(q, cleanUsr, cleanUsr+"@gmail.com", cleanCat)
	}

	if err != nil || rows == nil {
		q := `SELECT name, price, COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
			FROM products 
			WHERE (LOWER(username)=$1 OR LOWER(username)=$2) 
			  AND (in_stock IS TRUE OR in_stock IS NULL)
			  AND (COALESCE(image_url, '') != '' OR COALESCE(product_image_url, '') != '')
			ORDER BY id ASC LIMIT 4`
		rows, err = DB.Query(q, cleanUsr, cleanUsr+"@gmail.com")
	}

	if err != nil {
		return fmt.Errorf("catalog query error: %w", err)
	}

	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var p catalogProduct
			var rawPrice interface{}
			if scanErr := rows.Scan(&p.Name, &rawPrice, &p.ImageURL); scanErr == nil && p.ImageURL != "" {
				p.Price = parsePriceToFloat(rawPrice)
				productsList = append(productsList, p)
			}
		}
	}

	if len(productsList) == 0 {
		// Global fallback: If no images found for specific user filter, query products matching category across the store
		var fbRows *sql.Rows
		var fbErr error
		if cleanCat != "" && !strings.EqualFold(cleanCat, "all") && !strings.EqualFold(cleanCat, "general") {
			fbRows, fbErr = DB.Query(`SELECT name, price, COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
				FROM products 
				WHERE (in_stock IS TRUE OR in_stock IS NULL)
				  AND (LOWER(category) LIKE '%' || LOWER($1) || '%' OR LOWER(name) LIKE '%' || LOWER($1) || '%')
				  AND (COALESCE(image_url, '') != '' OR COALESCE(product_image_url, '') != '')
				ORDER BY id ASC LIMIT 4`, cleanCat)
		} else {
			fbRows, fbErr = DB.Query(`SELECT name, price, COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
				FROM products 
				WHERE (in_stock IS TRUE OR in_stock IS NULL)
				  AND (COALESCE(image_url, '') != '' OR COALESCE(product_image_url, '') != '')
				ORDER BY id ASC LIMIT 4`)
		}
		if fbErr == nil && fbRows != nil {
			defer fbRows.Close()
			for fbRows.Next() {
				var p catalogProduct
				var rawPrice interface{}
				if scanErr := fbRows.Scan(&p.Name, &rawPrice, &p.ImageURL); scanErr == nil && p.ImageURL != "" {
					p.Price = parsePriceToFloat(rawPrice)
					productsList = append(productsList, p)
				}
			}
		}
	}

	if len(productsList) == 0 {
		log.Printf("🐙 [Octopus Hand: send_catalog_images] No products with images found for category '%s'", cleanCat)
		return nil
	}

	for i, prod := range productsList {
		caption := fmt.Sprintf("🛍️ *%s*\n💰 Price: *₹%.2f*", prod.Name, prod.Price)
		if errImg := SendImageFromURL(client, cleanPhone, prod.ImageURL, caption); errImg != nil {
			log.Printf("⚠️ Error sending catalog image for %s to +%s: %v", prod.Name, cleanPhone, errImg)
			return fmt.Errorf("failed to deliver image for %s: %w", prod.Name, errImg)
		}
		if i < len(productsList)-1 {
			time.Sleep(1200 * time.Millisecond)
		}
	}
	log.Printf("🐙 [Octopus Hand: send_catalog_images] Dispatched %d product images to +%s", len(productsList), cleanPhone)
	return nil
}

// ExecuteCancelOrderHand (Hand: cancel_order): clears active cart and resets customer state to chatting/BROWSING
func ExecuteCancelOrderHand(username, senderPhone string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "BROWSING")
	_ = SetCustomerState(cleanUsr, cleanPhone, "chatting")
	_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, "")
	_ = ClearActiveCart(cleanUsr, cleanPhone)

	if DB != nil {
		_, err1 := DB.Exec(`DELETE FROM active_carts WHERE customer_phone=$1 OR customer_phone LIKE '%' || $1`, cleanPhone)
		_, err2 := DB.Exec(`UPDATE customers SET current_order_id = '', payment_status = 'BROWSING', current_state = 'chatting', updated_at = NOW() WHERE wa_number = $1 OR wa_number LIKE '%' || $1`, cleanPhone)
		if err1 != nil {
			return fmt.Errorf("active cart deletion error: %w", err1)
		}
		if err2 != nil {
			return fmt.Errorf("customer state reset error: %w", err2)
		}
	}
	log.Printf("🐙 [Octopus Hand: cancel_order] Order cancelled & cart cleared for +%s.", cleanPhone)
	return nil
}

// ExecuteUpdateCartHand (Hand: update_cart): upserts items into active_carts DB table and calculates exact new total
func ExecuteUpdateCartHand(username, senderPhone string, cartItems []AICartItemPayload) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	var items []AICartItem
	for _, ci := range cartItems {
		items = append(items, AICartItem{ProductID: ci.ID, Qty: int(ci.Qty)})
	}
	err := AddItemsToActiveCart(cleanUsr, cleanPhone, items)
	if err != nil {
		return fmt.Errorf("failed to add items to active cart: %w", err)
	}
	_ = SetCustomerState(cleanUsr, cleanPhone, "CART_ACTIVE")
	calcRes, _ := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
	if calcRes != nil {
		log.Printf("🐙 [Octopus Hand: update_cart] Cart updated for +%s. New Total: ₹%.2f (%d items)", cleanPhone, calcRes.TotalAmount, calcRes.ItemCount)
	}
	return nil
}

// ExecuteExtractProfileHand (Hand: extract_profile): saves profile data (name, address, contact) to customers table
func ExecuteExtractProfileHand(username, senderPhone string, profileData *AIProfileDataPayload) error {
	if profileData == nil {
		return nil
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	addr := strings.TrimSpace(profileData.Address)
	if addr == "" {
		addr = strings.TrimSpace(profileData.DeliveryAddress)
	}
	contact := strings.TrimSpace(profileData.Contact)
	if contact == "" {
		contact = strings.TrimSpace(profileData.DeliveryContact10Digit)
	}
	clean10 := Clean10DigitPhone(contact)

	profile := &AIProfileData{
		Name:          strings.TrimSpace(profileData.Name),
		Address:       addr,
		ContactNumber: clean10,
	}
	err := UpdateCustomerProfileFromData(cleanUsr, cleanPhone, profile)
	if err != nil {
		return fmt.Errorf("failed to save customer profile: %w", err)
	}
	log.Printf("🐙 [Octopus Hand: extract_profile] Profile updated for +%s (Name: %s, Address: %s, Contact: %s)", cleanPhone, profile.Name, profile.Address, profile.ContactNumber)
	return nil
}

// ExecuteGeneratePaymentQRHand (Hand: generate_payment_qr): generates unique Order ID, updates state to PENDING, calls Cloudflare for QR, and sends ImageMessage
func ExecuteGeneratePaymentQRHand(client *whatsmeow.Client, username, senderPhone string, cfg *UserConfigRAM, v *events.Message) error {
	_ = cfg
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp client is disconnected")
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	// 1. DYNAMIC UNIQUE ORDER ID GENERATION (Strictly alphanumeric: ORD + UnixNano)
	newOrderID := fmt.Sprintf("ORD%d", time.Now().UnixNano())

	// 2. Calculate cart total and fetch merchant payment credentials
	calcRes, errCalc := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
	if errCalc != nil || calcRes == nil || calcRes.TotalAmount <= 0 {
		log.Printf("⚠️ [Octopus Hand: generate_qr] Cart total is ₹0 for @%s (+%s)", cleanUsr, cleanPhone)
		return fmt.Errorf("cart is empty or total is ₹0")
	}

	cfgPay := payment.GetPaymentConfig(cleanUsr)
	vpa := strings.TrimSpace(cfgPay.MerchantVPA)
	mid := strings.TrimSpace(cfgPay.PaytmMID)
	if vpa == "" && calcRes.PaytmVpa != "" {
		vpa = calcRes.PaytmVpa
	}
	if mid == "" && calcRes.PaytmMid != "" {
		mid = calcRes.PaytmMid
	}

	if vpa == "" || mid == "" {
		log.Printf("❌ [Octopus Hand: generate_qr] Real Paytm MID or VPA missing for @%s", cleanUsr)
		return fmt.Errorf("merchant Paytm MID or UPI VPA is missing in database")
	}

	payeeName := strings.TrimSpace(cfgPay.PayeeName)
	if payeeName == "" {
		payeeName = calcRes.PayeeName
	}
	if payeeName == "" {
		payeeName = "WaMart Store"
	}

	amtStr := fmt.Sprintf("%.2f", calcRes.TotalAmount)

	// 3. Save NEW Order ID to DB before requesting QR
	_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, newOrderID)
	_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "PENDING")
	_ = SetCustomerState(cleanUsr, cleanPhone, "PAYMENT_PENDING")

	if DB != nil {
		_, _ = DB.Exec(`UPDATE customers SET current_order_id = $1, payment_status = 'PENDING', current_state = 'PAYMENT_PENDING', updated_at = NOW() WHERE wa_number = $2 OR wa_number LIKE '%' || $2`, newOrderID, cleanPhone)
		_, _ = DB.Exec(`UPDATE active_carts SET payment_status = 'PENDING' WHERE customer_phone = $1 OR customer_phone LIKE '%' || $1`, cleanPhone)
		_, _ = DB.Exec(`INSERT INTO customer_order_states (username, customer_phone, order_id, total_amount, payment_status, order_status, updated_at) 
			VALUES ($1, $2, $3, $4, 'pending', 'awaiting_payment', NOW())
			ON CONFLICT (username, customer_phone) DO UPDATE SET 
				order_id = EXCLUDED.order_id,
				total_amount = EXCLUDED.total_amount, 
				payment_status = 'pending',
				order_status = 'awaiting_payment',
				updated_at = NOW()`,
			cleanUsr, cleanPhone, newOrderID, calcRes.TotalAmount)
	}

	// 4. Request Cloudflare Worker /generate URL
	qrURL, _, errQR := payment.GenerateWorkerDynamicQR(vpa, payeeName, newOrderID, amtStr, "hq67khm3")
	if errQR != nil || qrURL == "" {
		log.Printf("⚠️ [Octopus Hand: generate_qr] Worker QR generation failed: %v", errQR)
		return fmt.Errorf("failed to generate payment QR: %w", errQR)
	}

	caption := fmt.Sprintf("📱 *Scan & Pay via UPI / Paytm*\n\n• Order ID: *%s*\n• Total Amount: *₹%s*\n• Payee: *%s*\n\n_Payment complete hone par 'Payment ho gaya' likhein ya confirmation ka intezar karein!_ 🙏", newOrderID, amtStr, payeeName)

	var sendErr error
	if v != nil {
		sendErr = SendImageReplyFromURL(client, cleanPhone, qrURL, caption, v.Info.ID, v.Info.Sender, v.Message)
	} else {
		sendErr = SendImageFromURL(client, cleanPhone, qrURL, caption)
	}
	if sendErr != nil {
		return fmt.Errorf("failed to deliver QR image to customer WhatsApp: %w", sendErr)
	}
	PushToLiveChat(cleanUsr, cleanPhone, caption, "outgoing_ai")

	// 5. Trigger async polling worker check
	go func(oID, mID string) {
		_ = payment.StartWorkerPaymentCheck(mID, oID, payment.GetAppWebhookURL())
	}(newOrderID, mid)

	log.Printf("⚡ [Octopus Hand: generate_qr] Dispatched dynamic QR for Order %s (₹%s) to +%s", newOrderID, amtStr, cleanPhone)
	return nil
}

// ExecuteVerifyPaymentHand (Hand: verify_payment): verifies existing saved Order ID via direct Paytm /order/status POST API
func ExecuteVerifyPaymentHand(client *whatsmeow.Client, username, senderPhone string, cfg *UserConfigRAM, v *events.Message) error {
	_ = cfg
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp client is disconnected")
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	// 1. Fetch existing saved Order ID from DB (DO NOT generate a new one)
	savedOrderID := GetCustomerCurrentOrderID(cleanUsr, cleanPhone)
	if savedOrderID == "" && DB != nil {
		_ = DB.QueryRow(`SELECT COALESCE(current_order_id, '') FROM customers WHERE (wa_number = $1 OR wa_number LIKE '%' || $1) AND payment_status = 'PENDING' LIMIT 1`, cleanPhone).Scan(&savedOrderID)
	}
	if savedOrderID == "" && DB != nil {
		_ = DB.QueryRow(`SELECT COALESCE(order_id, '') FROM customer_order_states WHERE (customer_phone = $1 OR customer_phone LIKE '%' || $1) AND payment_status = 'pending' ORDER BY updated_at DESC LIMIT 1`, cleanPhone).Scan(&savedOrderID)
	}

	if savedOrderID == "" {
		log.Printf("⚠️ [Octopus Hand: verify_payment] No active pending Order ID found for +%s", cleanPhone)
		aiPrompt := "Customer checked payment status, but no active pending order was found in the database. Politely inform them using quotes (>) and emojis that we are checking, and ask them to share their payment screenshot or order details so we can assist immediately."
		failedMsg, errAI := GenerateAIContextualReply(cleanUsr, cleanPhone, aiPrompt, cfg)
		if errAI != nil || failedMsg == "" {
			failedMsg = "> ⏳ *PAYMENT VERIFICATION PENDING* 🔍\n> _Aapka payment status verify kiya ja raha hai._\n\nAbhi bank se payment record match nahi hua hai. Agar aap pay kar chuke hain, toh kripya payment ka *Screenshot* yahan share karein, hum turant confirm kar denge! 🙏✨"
		}
		if v != nil {
			_ = SendReplyMessage(client, cleanPhone, failedMsg, v.Info.ID, v.Info.Sender, v.Message)
		} else {
			_ = SendMessage(client, cleanPhone, failedMsg)
		}
		PushToLiveChat(cleanUsr, cleanPhone, failedMsg, "outgoing_ai")
		go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", failedMsg)
		return nil
	}

	// 2. Fetch Paytm MID
	cfgPay := payment.GetPaymentConfig(cleanUsr)
	mid := strings.TrimSpace(cfgPay.PaytmMID)
	if mid == "" && DB != nil {
		_ = DB.QueryRow(`SELECT COALESCE(paytm_mid, '') FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`, cleanUsr).Scan(&mid)
	}

	if mid == "" {
		log.Printf("❌ [Octopus Hand: verify_payment] Paytm MID missing for @%s", cleanUsr)
		aiPrompt := fmt.Sprintf("Payment verification check for Order %s. The payment is awaiting confirmation. Politely inform the customer using quotes (>) and emojis to share their UPI payment screenshot, and the store owner will verify and confirm their order right away.", savedOrderID)
		failedMsg, errAI := GenerateAIContextualReply(cleanUsr, cleanPhone, aiPrompt, cfg)
		if errAI != nil || failedMsg == "" {
			failedMsg = fmt.Sprintf("> ⏳ *PAYMENT VERIFICATION PENDING* 🔍\n> _Order #%s_\n\nAapka payment abhi bank se confirm nahi hua hai. Agar aap pay kar chuke hain, toh kripya payment ka *Screenshot* yahan share karein, hum turant verify kar denge! 🙏✨", savedOrderID)
		}
		if v != nil {
			_ = SendReplyMessage(client, cleanPhone, failedMsg, v.Info.ID, v.Info.Sender, v.Message)
		} else {
			_ = SendMessage(client, cleanPhone, failedMsg)
		}
		PushToLiveChat(cleanUsr, cleanPhone, failedMsg, "outgoing_ai")
		go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", failedMsg)
		return nil
	}

	// 3. Execute Direct Form-Encoded POST to Paytm /order/status
	statusResp, err := payment.VerifyPaytmPayment(mid, savedOrderID)
	if err != nil || statusResp == nil || statusResp.Status != "TXN_SUCCESS" {
		if err != nil {
			log.Printf("⚠️ [Octopus Hand: verify_payment] Paytm API call error for %s: %v", savedOrderID, err)
		} else {
			log.Printf("⏳ [Octopus Hand: verify_payment] Payment not completed yet for %s (Status: %s)", savedOrderID, statusResp.Status)
		}
		aiPrompt := fmt.Sprintf("Payment verification check for Order %s. The payment status from bank is not successful yet. Politely inform the customer using WhatsApp quotes (>) and emojis that bank confirmation is taking a moment, and ask them to share their payment screenshot or wait a minute while we re-check.", savedOrderID)
		failedMsg, errAI := GenerateAIContextualReply(cleanUsr, cleanPhone, aiPrompt, cfg)
		if errAI != nil || failedMsg == "" {
			failedMsg = fmt.Sprintf("> ⏳ *PAYMENT VERIFICATION PENDING* 🔍\n> _Order #%s_\n\nAapka payment abhi bank se confirm nahi hua hai. Agar aap pay kar chuke hain, toh kripya payment ka *Screenshot* yahan share karein, hum turant verify kar denge! 🙏✨", savedOrderID)
		}
		if v != nil {
			_ = SendReplyMessage(client, cleanPhone, failedMsg, v.Info.ID, v.Info.Sender, v.Message)
		} else {
			_ = SendMessage(client, cleanPhone, failedMsg)
		}
		PushToLiveChat(cleanUsr, cleanPhone, failedMsg, "outgoing_ai")
		go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", failedMsg)
		return nil
	}

	// 4. IF TXN_SUCCESS: Generate AI celebratory confirmation message and update state
	_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "BROWSING")
	_ = SetCustomerState(cleanUsr, cleanPhone, "chatting")
	_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, "")
	_ = ClearActiveCart(cleanUsr, cleanPhone)

	if DB != nil {
		_, _ = DB.Exec(`UPDATE customers SET current_order_id = '', payment_status = 'BROWSING', current_state = 'chatting', updated_at = NOW() WHERE wa_number = $1 OR wa_number LIKE '%' || $1`, cleanPhone)
		_, _ = DB.Exec(`UPDATE active_carts SET payment_status = 'PAID' WHERE customer_phone = $1 OR customer_phone LIKE '%' || $1`, cleanPhone)
		_, _ = DB.Exec(`DELETE FROM active_carts WHERE customer_phone = $1 OR customer_phone LIKE '%' || $1`, cleanPhone)
		_, _ = DB.Exec(`UPDATE customer_order_states SET payment_status = 'paid', order_status = 'confirmed', updated_at = NOW() WHERE LOWER(order_id) = LOWER($1)`, savedOrderID)

		leadInquiry := fmt.Sprintf("Order %s | Amount: ₹%s | TxnID: %s (Direct Paytm API Verified)", savedOrderID, statusResp.TxnAmount, statusResp.TxnID)
		_, _ = DB.Exec(`INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Confirmed Paid (Paytm Direct)', NOW())`, cleanUsr, cleanPhone, leadInquiry)
	}

	aiPrompt := fmt.Sprintf("Payment of Rs. %s for Order %s has been SUCCESSFULLY VERIFIED via Paytm UPI (Txn ID: %s). Write a joyous, celebratory WhatsApp order confirmation message with quotes (>) and emojis. Thank the customer warmly, confirm their order, and assure them that their items will be packed and dispatched for delivery shortly.", statusResp.TxnAmount, savedOrderID, statusResp.TxnID)
	confMsg, errAI := GenerateAIContextualReply(cleanUsr, cleanPhone, aiPrompt, cfg)
	if errAI != nil || confMsg == "" {
		confMsg = fmt.Sprintf("> 🎉 *PAYMENT VERIFIED & ORDER CONFIRMED!* ✅\n> 📦 *Order ID:* %s • 💰 *Amount Paid:* ₹%s\n\nBadhai ho! Aapka payment verify ho gaya hai aur order confirm ho chuka hai. Hamari team jald hi aapka order dispatch karegi! Dhanyawad! 🙏🚚✨", savedOrderID, statusResp.TxnAmount)
	}
	if v != nil {
		_ = SendReplyMessage(client, cleanPhone, confMsg, v.Info.ID, v.Info.Sender, v.Message)
	} else {
		_ = SendMessage(client, cleanPhone, confMsg)
	}
	PushToLiveChat(cleanUsr, cleanPhone, confMsg, "outgoing_ai")
	go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", confMsg)

	// Alert merchant phone if present
	if cfgPay.MerchantPhone != "" {
		merchAlert := fmt.Sprintf("🎉 *New Paid Order Confirmed!*\n\n• Customer: +%s\n• Order ID: %s\n• Amount: ₹%s\n• Txn ID: %s", cleanPhone, savedOrderID, statusResp.TxnAmount, statusResp.TxnID)
		_ = SendMessage(client, cfgPay.MerchantPhone, merchAlert)
	}
	log.Printf("🎉 [Octopus Hand: verify_payment] TXN_SUCCESS for %s (+%s)", savedOrderID, cleanPhone)
	return nil
}

// ExecuteEscalateToHumanHand (Hand: escalate_to_human): sends comprehensive customer, shopping, cart, and problem details to the store owner without locking the customer's chat
func ExecuteEscalateToHumanHand(client *whatsmeow.Client, username, senderPhone, customerName string, v *events.Message) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	// 1. Keep customer active with AI - NEVER LOCK CHAT!
	_ = SetCustomerState(cleanUsr, cleanPhone, "chatting")
	if DB != nil {
		_, _ = DB.Exec(`UPDATE customers SET current_state = 'chatting', updated_at = NOW() WHERE (LOWER(username)=$1 OR LOWER(username)=$2) AND (wa_number = $3 OR wa_number LIKE '%' || $3)`, cleanUsr, cleanUsr+"@gmail.com", cleanPhone)
	}

	// 2. Extract Customer Profile Details
	custProf, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	displayName := strings.TrimSpace(customerName)
	if displayName == "" && custProf != nil && custProf.FullName != "" {
		displayName = custProf.FullName
	}
	if displayName == "" {
		displayName = "Customer"
	}

	addr := ""
	contactNum := ""
	if custProf != nil {
		addr = strings.TrimSpace(custProf.DeliveryAddress)
		contactNum = strings.TrimSpace(custProf.ContactPhone)
	}
	if addr == "" && DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(delivery_address, '') FROM customers WHERE wa_number = $1 OR wa_number LIKE '%' || $1 LIMIT 1", cleanPhone).Scan(&addr)
	}

	// 3. Extract Cart Details
	calcRes, _ := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)

	// 4. Extract Order & Payment Status
	orderIDDisp := GetCustomerCurrentOrderID(cleanUsr, cleanPhone)
	if orderIDDisp == "" {
		orderIDDisp = "None (No active order)"
	}
	payStatusDisp := GetCustomerPaymentStatus(cleanUsr, cleanPhone)
	if payStatusDisp == "" {
		payStatusDisp = "BROWSING"
	}

	// 5. Extract Customer's Problem / Inquiry
	custProblem := ""
	if v != nil && v.Message != nil {
		custProblem = strings.TrimSpace(v.Message.GetConversation() + v.Message.GetExtendedTextMessage().GetText())
	}
	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if custProblem == "" && len(history) > 0 {
		for i := len(history) - 1; i >= 0; i-- {
			if history[i].Role == "user" {
				custProblem = history[i].Content
				break
			}
		}
	}
	if custProblem == "" {
		custProblem = "Store owner assistance requested"
	}

	// 6. Recent Conversation Context (Last 3-4 turns)
	var historyLines []string
	if len(history) > 0 {
		startIdx := 0
		if len(history) > 4 {
			startIdx = len(history) - 4
		}
		for _, m := range history[startIdx:] {
			senderTag := "Customer"
			if m.Role == "assistant" {
				senderTag = "AI"
			}
			cleanC := strings.TrimSpace(m.Content)
			if len(cleanC) > 75 {
				cleanC = cleanC[:72] + "..."
			}
			historyLines = append(historyLines, fmt.Sprintf("• %s: \"%s\"", senderTag, cleanC))
		}
	}

	// 7. Assemble Full Rich Alert Message for the Store Owner
	var b strings.Builder
	b.WriteString("🚨 *DUKAN MALIK ALERT: CUSTOMER ASSISTANCE REQUEST* 🚨\n")
	b.WriteString("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
	b.WriteString("👤 *CUSTOMER DETAILS:*\n")
	b.WriteString(fmt.Sprintf("• *Name:* %s\n", displayName))
	b.WriteString(fmt.Sprintf("• *WhatsApp:* +%s\n", cleanPhone))
	if contactNum != "" && contactNum != cleanPhone {
		b.WriteString(fmt.Sprintf("• *Alt Phone:* %s\n", contactNum))
	}
	if addr != "" {
		b.WriteString(fmt.Sprintf("• *Delivery Address:* %s\n\n", addr))
	} else {
		b.WriteString("• *Delivery Address:* Not provided yet\n\n")
	}

	b.WriteString("🛒 *CART & SHOPPING DETAILS:*\n")
	if calcRes != nil && len(calcRes.Items) > 0 {
		for _, it := range calcRes.Items {
			b.WriteString(fmt.Sprintf("• %s x%d = ₹%.2f\n", it.ProductName, it.Quantity, it.LineTotal))
		}
		b.WriteString(fmt.Sprintf("💰 *Total Cart Value:* ₹%.2f\n\n", calcRes.TotalAmount))
	} else {
		b.WriteString("• Cart is currently empty\n\n")
	}

	b.WriteString("📋 *ORDER STATUS:*\n")
	b.WriteString(fmt.Sprintf("• *Order ID:* %s\n", orderIDDisp))
	b.WriteString(fmt.Sprintf("• *Payment Status:* %s\n\n", payStatusDisp))

	b.WriteString("❓ *CUSTOMER'S PROBLEM / REQUEST:*\n")
	b.WriteString(fmt.Sprintf("\"%s\"\n\n", strings.TrimSpace(custProblem)))

	if len(historyLines) > 0 {
		b.WriteString("💬 *RECENT CHAT CONTEXT:*\n")
		for _, h := range historyLines {
			b.WriteString(fmt.Sprintf("%s\n", h))
		}
		b.WriteString("\n")
	}

	b.WriteString("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
	b.WriteString("👉 *Notice:* Chat lock nahi kiya gaya hai. AI customer ko active rakh kar continue help kar raha hai. Aap chahein toh customer se direct call ya WhatsApp pe baat kar sakte hain.")

	alertMsg := b.String()

	// 8. Deliver Alert to Store Owner's Phone
	ownerAlertPhone := GetMerchantAlertPhone(cleanUsr)
	if ownerAlertPhone != "" && client != nil && client.IsLoggedIn() {
		cleanOwnerPhone := FormatPhone(ownerAlertPhone)
		_ = SendMessage(client, cleanOwnerPhone, alertMsg)
		log.Printf("🚨 [Escalate to Human] Full dossier alert delivered to Store Owner (+%s) for %s (+%s)", cleanOwnerPhone, displayName, cleanPhone)
	} else {
		log.Printf("🚨 [Escalate to Human] No merchant alert phone configured for @%s; escalation saved to live chat.", cleanUsr)
	}

	PushToLiveChat(cleanUsr, cleanPhone, alertMsg, "system_alert")
	return nil
}

// GetMerchantAlertPhone retrieves the business owner's alert phone from users or tenant_payment_configs
func GetMerchantAlertPhone(username string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if DB != nil {
		var notifPhone, userPhone string
		err := DB.QueryRow(`
			SELECT COALESCE(NULLIF(notification_phone, ''), ''), COALESCE(NULLIF(phone, ''), '') 
			FROM users 
			WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)||'@gmail.com'
			LIMIT 1
		`, cleanUsr).Scan(&notifPhone, &userPhone)
		if err == nil {
			if strings.TrimSpace(notifPhone) != "" {
				return strings.TrimSpace(notifPhone)
			}
			if strings.TrimSpace(userPhone) != "" {
				return strings.TrimSpace(userPhone)
			}
		}
	}

	cfg := payment.GetPaymentConfig(cleanUsr)
	if strings.TrimSpace(cfg.MerchantPhone) != "" {
		return strings.TrimSpace(cfg.MerchantPhone)
	}
	return ""
}

// NewsletterItem represents metadata of a WhatsApp channel (newsletter)
type NewsletterItem struct {
	JID             string `json:"jid"`
	Name            string `json:"name"`
	Role            string `json:"role"`
	SubscriberCount int    `json:"subscriber_count,omitempty"`
}

// ChannelForwardingRule represents a persistent rule in channel_forwarding_rules table
type ChannelForwardingRule struct {
	ID                int    `json:"id"`
	AdminAccountID    string `json:"admin_account_id"`
	SourceJID         string `json:"source_jid"`
	SourceName        string `json:"source_name"`
	TargetJID         string `json:"target_jid"`
	TargetName        string `json:"target_name"`
	ForwardLogic      string `json:"forward_logic"`
	BlockURLs         bool   `json:"block_urls"`
	StripChannelLinks bool   `json:"strip_channel_links"`
	IsActive          bool   `json:"is_active"`
	CreatedAt         string `json:"created_at,omitempty"`
}

var (
	channelRulesLock   sync.RWMutex
	channelRulesRAM    []ChannelForwardingRule
	activeTargetsRAM   = make(map[string][]string)               // source_jid -> []target_jid
	activeRulesRAM     = make(map[string][]ChannelForwardingRule) // source_jid -> []ChannelForwardingRule
	channelRulesBooted bool

	// Legacy single-config backwards compatibility
	AdminChannelConfig     AdminChannelForwarderConfig
	AdminChannelConfigLock sync.RWMutex
)

// AdminChannelForwarderConfig holds configuration for single-rule backward compatibility
type AdminChannelForwarderConfig struct {
	SourceChannelJID       string `json:"source_channel_jid"`
	TargetChannelJID       string `json:"target_channel_jid"`
	ChannelForwarderActive bool   `json:"channel_forwarder_active"`
}

// SyncChannelRulesCache loads all rules from database into RAM cache
func SyncChannelRulesCache() []ChannelForwardingRule {
	channelRulesLock.Lock()
	defer channelRulesLock.Unlock()

	var rules []ChannelForwardingRule
	targetsMap := make(map[string][]string)
	rulesMap := make(map[string][]ChannelForwardingRule)

	if DB != nil {
		rows, err := DB.Query(`SELECT id, admin_account_id, source_jid, source_name, target_jid, target_name, COALESCE(forward_logic, 'all'), COALESCE(block_urls, false), COALESCE(strip_channel_links, true), is_active, COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '') FROM channel_forwarding_rules ORDER BY id DESC`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var r ChannelForwardingRule
				if scanErr := rows.Scan(&r.ID, &r.AdminAccountID, &r.SourceJID, &r.SourceName, &r.TargetJID, &r.TargetName, &r.ForwardLogic, &r.BlockURLs, &r.StripChannelLinks, &r.IsActive, &r.CreatedAt); scanErr == nil {
					if r.ForwardLogic == "" {
						r.ForwardLogic = "all"
					}
					rules = append(rules, r)
					if r.IsActive && r.SourceJID != "" && r.TargetJID != "" {
						src := strings.TrimSpace(r.SourceJID)
						tgt := strings.TrimSpace(r.TargetJID)
						targetsMap[src] = append(targetsMap[src], tgt)
						rulesMap[src] = append(rulesMap[src], r)
					}
				}
			}
		}
	}

	if rules == nil {
		rules = []ChannelForwardingRule{}
	}

	channelRulesRAM = rules
	activeTargetsRAM = targetsMap
	activeRulesRAM = rulesMap
	channelRulesBooted = true
	return rules
}

// GetActiveRulesForChannel retrieves all active forwarding rules for a given source channel JID
func GetActiveRulesForChannel(sourceJID string) []ChannelForwardingRule {
	cleanSrc := strings.TrimSpace(sourceJID)
	if cleanSrc == "" {
		return nil
	}

	channelRulesLock.RLock()
	if !channelRulesBooted {
		channelRulesLock.RUnlock()
		SyncChannelRulesCache()
		channelRulesLock.RLock()
	}

	rules := activeRulesRAM[cleanSrc]
	if len(rules) == 0 {
		baseJID := strings.TrimSuffix(cleanSrc, "@newsletter")
		for k, v := range activeRulesRAM {
			if strings.TrimSuffix(k, "@newsletter") == baseJID {
				rules = v
				break
			}
		}
	}
	channelRulesLock.RUnlock()

	// Direct DB fallback if RAM empty
	if len(rules) == 0 && DB != nil {
		rows, err := DB.Query(`SELECT id, admin_account_id, source_jid, source_name, target_jid, target_name, COALESCE(forward_logic, 'all'), COALESCE(block_urls, false), COALESCE(strip_channel_links, true), is_active, COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '') FROM channel_forwarding_rules WHERE (source_jid = $1 OR source_jid LIKE $2) AND is_active = true`, cleanSrc, cleanSrc+"%")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var r ChannelForwardingRule
				if rows.Scan(&r.ID, &r.AdminAccountID, &r.SourceJID, &r.SourceName, &r.TargetJID, &r.TargetName, &r.ForwardLogic, &r.BlockURLs, &r.StripChannelLinks, &r.IsActive, &r.CreatedAt) == nil {
					if r.ForwardLogic == "" {
						r.ForwardLogic = "all"
					}
					rules = append(rules, r)
				}
			}
		}
	}

	return rules
}

// GetActiveTargetsForChannel retrieves all active target channel JIDs for a given source channel JID
func GetActiveTargetsForChannel(sourceJID string) []string {
	cleanSrc := strings.TrimSpace(sourceJID)
	if cleanSrc == "" {
		return nil
	}

	channelRulesLock.RLock()
	if !channelRulesBooted {
		channelRulesLock.RUnlock()
		SyncChannelRulesCache()
		channelRulesLock.RLock()
	}

	targets := activeTargetsRAM[cleanSrc]
	if len(targets) == 0 {
		baseJID := strings.TrimSuffix(cleanSrc, "@newsletter")
		for k, v := range activeTargetsRAM {
			if strings.TrimSuffix(k, "@newsletter") == baseJID {
				targets = v
				break
			}
		}
	}
	channelRulesLock.RUnlock()

	// Direct DB fallback if RAM empty
	if len(targets) == 0 && DB != nil {
		rows, err := DB.Query(`SELECT target_jid FROM channel_forwarding_rules WHERE (source_jid = $1 OR source_jid LIKE $2) AND is_active = true`, cleanSrc, cleanSrc+"%")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var t string
				if rows.Scan(&t) == nil && strings.TrimSpace(t) != "" {
					targets = append(targets, strings.TrimSpace(t))
				}
			}
		}
	}

	return targets
}

// AddChannelForwardingRule persists a new Many-to-Many forwarding rule
func AddChannelForwardingRule(adminID, sourceJID, sourceName, targetJID, targetName, forwardLogic string, blockURLs, stripChannelLinks bool) (*ChannelForwardingRule, error) {
	cleanAdmin := strings.TrimSpace(adminID)
	if cleanAdmin == "" {
		cleanAdmin = "admin"
	}
	cleanSrc := strings.TrimSpace(sourceJID)
	cleanTgt := strings.TrimSpace(targetJID)
	if cleanSrc == "" || cleanTgt == "" {
		return nil, fmt.Errorf("both source and target channel are required")
	}
	if cleanSrc == cleanTgt {
		return nil, fmt.Errorf("source and target channel cannot be identical")
	}

	srcName := strings.TrimSpace(sourceName)
	if srcName == "" {
		srcName = cleanSrc
	}
	tgtName := strings.TrimSpace(targetName)
	if tgtName == "" {
		tgtName = cleanTgt
	}

	cleanLogic := strings.ToLower(strings.TrimSpace(forwardLogic))
	if cleanLogic == "" {
		cleanLogic = "all"
	}

	var newID int
	if DB != nil {
		err := DB.QueryRow(`INSERT INTO channel_forwarding_rules (admin_account_id, source_jid, source_name, target_jid, target_name, forward_logic, block_urls, strip_channel_links, is_active, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW()) RETURNING id`,
			cleanAdmin, cleanSrc, srcName, cleanTgt, tgtName, cleanLogic, blockURLs, stripChannelLinks).Scan(&newID)
		if err != nil {
			return nil, fmt.Errorf("database insert failed: %w", err)
		}
	}

	SyncChannelRulesCache()
	return &ChannelForwardingRule{
		ID:                newID,
		AdminAccountID:    cleanAdmin,
		SourceJID:         cleanSrc,
		SourceName:        srcName,
		TargetJID:         cleanTgt,
		TargetName:        tgtName,
		ForwardLogic:      cleanLogic,
		BlockURLs:         blockURLs,
		StripChannelLinks: stripChannelLinks,
		IsActive:          true,
		CreatedAt:         time.Now().Format("02 Jan 2006 15:04"),
	}, nil
}

// UpdateChannelForwardingRule updates an existing forwarding rule
func UpdateChannelForwardingRule(id int, sourceJID, sourceName, targetJID, targetName, forwardLogic string, blockURLs, stripChannelLinks, isActive bool) (*ChannelForwardingRule, error) {
	if id <= 0 {
		return nil, fmt.Errorf("invalid rule ID")
	}
	cleanSrc := strings.TrimSpace(sourceJID)
	cleanTgt := strings.TrimSpace(targetJID)
	if cleanSrc == "" || cleanTgt == "" {
		return nil, fmt.Errorf("both source and target channel are required")
	}
	if cleanSrc == cleanTgt {
		return nil, fmt.Errorf("source and target channel cannot be identical")
	}

	srcName := strings.TrimSpace(sourceName)
	if srcName == "" {
		srcName = cleanSrc
	}
	tgtName := strings.TrimSpace(targetName)
	if tgtName == "" {
		tgtName = cleanTgt
	}
	cleanLogic := strings.ToLower(strings.TrimSpace(forwardLogic))
	if cleanLogic == "" {
		cleanLogic = "all"
	}

	if DB != nil {
		_, err := DB.Exec(`UPDATE channel_forwarding_rules SET source_jid = $1, source_name = $2, target_jid = $3, target_name = $4, forward_logic = $5, block_urls = $6, strip_channel_links = $7, is_active = $8 WHERE id = $9`,
			cleanSrc, srcName, cleanTgt, tgtName, cleanLogic, blockURLs, stripChannelLinks, isActive, id)
		if err != nil {
			return nil, fmt.Errorf("database update failed: %w", err)
		}
	}
	SyncChannelRulesCache()

	return &ChannelForwardingRule{
		ID:                id,
		SourceJID:         cleanSrc,
		SourceName:        srcName,
		TargetJID:         cleanTgt,
		TargetName:        tgtName,
		ForwardLogic:      cleanLogic,
		BlockURLs:         blockURLs,
		StripChannelLinks: stripChannelLinks,
		IsActive:          isActive,
	}, nil
}

// DeleteChannelForwardingRule deletes a rule by ID
func DeleteChannelForwardingRule(id int) error {
	if DB != nil {
		_, err := DB.Exec(`DELETE FROM channel_forwarding_rules WHERE id = $1`, id)
		if err != nil {
			return fmt.Errorf("database delete failed: %w", err)
		}
	}
	SyncChannelRulesCache()
	return nil
}

// ToggleChannelForwardingRule toggles is_active state of a rule by ID
func ToggleChannelForwardingRule(id int) (bool, error) {
	var newState bool
	if DB != nil {
		err := DB.QueryRow(`UPDATE channel_forwarding_rules SET is_active = NOT is_active WHERE id = $1 RETURNING is_active`, id).Scan(&newState)
		if err != nil {
			return false, fmt.Errorf("database update failed: %w", err)
		}
	}
	SyncChannelRulesCache()
	return newState, nil
}

// LoadAdminChannelConfigFromDB backwards compatibility
func LoadAdminChannelConfigFromDB() AdminChannelForwarderConfig {
	AdminChannelConfigLock.Lock()
	defer AdminChannelConfigLock.Unlock()

	if DB != nil {
		var src, tgt string
		var active bool
		err := DB.QueryRow(`SELECT source_channel_jid, target_channel_jid, channel_forwarder_active FROM admin_channel_forwarder_configs WHERE username = 'admin' LIMIT 1`).Scan(&src, &tgt, &active)
		if err == nil {
			AdminChannelConfig = AdminChannelForwarderConfig{
				SourceChannelJID:       strings.TrimSpace(src),
				TargetChannelJID:       strings.TrimSpace(tgt),
				ChannelForwarderActive: active,
			}
			return AdminChannelConfig
		}
	}
	return AdminChannelConfig
}

// SaveAdminChannelConfigToDB backwards compatibility
func SaveAdminChannelConfigToDB(cfg AdminChannelForwarderConfig) error {
	AdminChannelConfigLock.Lock()
	AdminChannelConfig = cfg
	AdminChannelConfigLock.Unlock()

	if DB != nil {
		go func(c AdminChannelForwarderConfig) {
			_, _ = DB.Exec(`INSERT INTO admin_channel_forwarder_configs (username, source_channel_jid, target_channel_jid, channel_forwarder_active, updated_at)
				VALUES ('admin', $1, $2, $3, NOW())
				ON CONFLICT (username) DO UPDATE SET
					source_channel_jid = EXCLUDED.source_channel_jid,
					target_channel_jid = EXCLUDED.target_channel_jid,
					channel_forwarder_active = EXCLUDED.channel_forwarder_active,
					updated_at = NOW()`,
				c.SourceChannelJID, c.TargetChannelJID, c.ChannelForwarderActive)
		}(cfg)
	}
	return nil
}

func extractNewsletterName(nl *types.NewsletterMetadata) string {
	if nl == nil {
		return "Unknown Channel"
	}
	// 1. Direct field access (ThreadMeta.Name.Text)
	name := strings.TrimSpace(nl.ThreadMeta.Name.Text)
	if name != "" {
		return name
	}
	// 2. JSON tag fallback
	if b, err := json.Marshal(nl); err == nil {
		var m map[string]interface{}
		if err := json.Unmarshal(b, &m); err == nil {
			if tm, ok := m["thread_metadata"].(map[string]interface{}); ok {
				if nm, ok := tm["name"].(map[string]interface{}); ok {
					if txt, ok := nm["text"].(string); ok && strings.TrimSpace(txt) != "" {
						return strings.TrimSpace(txt)
					}
				}
			}
		}
	}
	return "Unknown Channel"
}

func extractNewsletterRole(nl *types.NewsletterMetadata) string {
	if nl == nil {
		return "SUBSCRIBER"
	}
	// 1. Direct field access (ViewerMeta.Role)
	if nl.ViewerMeta != nil {
		r := strings.ToUpper(strings.TrimSpace(string(nl.ViewerMeta.Role)))
		if r != "" {
			return r
		}
	}
	// 2. JSON tag fallback
	if b, err := json.Marshal(nl); err == nil {
		var m map[string]interface{}
		if err := json.Unmarshal(b, &m); err == nil {
			if vm, ok := m["viewer_metadata"].(map[string]interface{}); ok {
				if r, ok := vm["role"].(string); ok && strings.TrimSpace(r) != "" {
					return strings.ToUpper(strings.TrimSpace(r))
				}
			}
		}
	}
	return "SUBSCRIBER"
}

// FetchSubscribedNewsletters calls whatsmeow client.GetSubscribedNewsletters(ctx) for admin client
func FetchSubscribedNewsletters(username string) ([]NewsletterItem, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	if cleanUsr == "" {
		cleanUsr = "admin"
	}

	ClientsLock.Lock()
	client, exists := ActiveClients[cleanUsr]
	if !exists || client == nil || !client.IsLoggedIn() {
		client = ActiveClients["admin"]
	}
	ClientsLock.Unlock()

	if client == nil || !client.IsLoggedIn() {
		return nil, fmt.Errorf("WhatsApp client is disconnected")
	}

	newsletters, err := client.GetSubscribedNewsletters(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to fetch subscribed newsletters: %w", err)
	}

	var items []NewsletterItem
	for _, nl := range newsletters {
		if nl == nil {
			continue
		}

		name := extractNewsletterName(nl)
		role := extractNewsletterRole(nl)
		subCount := nl.ThreadMeta.SubscriberCount

		items = append(items, NewsletterItem{
			JID:             nl.ID.String(),
			Name:            name,
			Role:            role,
			SubscriberCount: subCount,
		})
	}

	if items == nil {
		items = []NewsletterItem{}
	}

	return items, nil
}

