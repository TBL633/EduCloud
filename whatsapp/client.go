package whatsapp

import (
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
	"strings"
	"sync"
	"time"

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
)

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

// Multi-tenant WhatsApp Client: Load from Neon Postgres using saved wa_jid or create new
func GetOrCreateClient(username string) *whatsmeow.Client {
	ClientsLock.Lock()
	defer ClientsLock.Unlock()

	if c, exists := ActiveClients[username]; exists {
		return c
	}

	// Lazy initialize StoreContainer if not yet ready
	if StoreContainer == nil {
		InitStore("", DB)
	}

	if StoreContainer == nil {
		log.Printf("⚠️ StoreContainer is nil; cannot create WhatsApp client for @%s", username)
		return nil
	}

	var deviceStore *store.Device
	var savedJID string
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(wa_jid, '') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&savedJID)
	}

	// 1. If user previously paired, retrieve their exact session from Neon PostgreSQL sqlstore
	if savedJID != "" {
		cleanSaved := strings.Split(strings.Split(savedJID, "@")[0], ".")[0]
		cleanSaved = strings.TrimSpace(cleanSaved)

		allDevices, err := StoreContainer.GetAllDevices(context.Background())
		if err == nil {
			for _, dev := range allDevices {
				if dev != nil && dev.ID != nil {
					cleanDevUser := strings.Split(strings.Split(dev.ID.User, "@")[0], ".")[0]
					cleanDevUser = strings.TrimSpace(cleanDevUser)
					if cleanDevUser != "" && (cleanDevUser == cleanSaved || dev.ID.User == savedJID || dev.ID.String() == savedJID) {
						deviceStore = dev
						break
					}
				}
			}
		}
	}

	// 2. Strict User Isolation: New unlinked device allocation for this user
	// Every user gets their own dedicated device; NEVER borrow or inherit another customer's WhatsApp device!
	if deviceStore == nil {
		deviceStore = StoreContainer.NewDevice()
	}

	// Low-RAM logger: suppresses noisy traces (<2MB RAM per WhatsApp instance)
	clientLog := waLog.Stdout("Client-"+username, "ERROR", false)
	client := whatsmeow.NewClient(deviceStore, clientLog)

	// Incoming Messages & Events Listener
	client.AddEventHandler(func(evt interface{}) {
		handleWhatsAppEvents(username, client, evt)
	})

	ActiveClients[username] = client

	if client.Store.ID == nil {
		qrChan, err := client.GetQRChannel(context.Background())
		if err == nil {
			go func() {
				for evt := range qrChan {
					if evt.Event == "code" {
						ClientsLock.Lock()
						QRChannelMap[username] = evt.Code
						ClientsLock.Unlock()
					} else if evt.Event == "success" {
						ClientsLock.Lock()
						QRChannelMap[username] = ""
						ClientsLock.Unlock()
						if client.Store.ID != nil && DB != nil {
							jidUser := client.Store.ID.User
							_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected' WHERE LOWER(username)=LOWER($2)", jidUser, username)
						}
					}
				}
			}()
		}
		ConnectWithAutoRetry(client, username)
	} else {
		ConnectWithAutoRetry(client, username)
		if DB != nil && client.Store.ID != nil {
			jidUser := client.Store.ID.User
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected' WHERE LOWER(username)=LOWER($2)", jidUser, username)
		}
	}

	return client
}


// DisconnectAndUnlinkClient cleanly logs out, disconnects, erases device session from sqlstore, and clears memory
func DisconnectAndUnlinkClient(username string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	ClientsLock.Lock()
	defer ClientsLock.Unlock()

	client, exists := ActiveClients[cleanUsr]
	if exists && client != nil {
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
			if err == nil && client.IsConnected() {
				log.Printf("✅ WhatsApp WebSocket connected successfully for @%s (Attempt %d)", username, attempt)
				// Send immediate PresenceAvailable so WhatsApp server knows device is Online and routes messages in 0ms!
				_ = client.SendPresence(types.PresenceAvailable)
				if DB != nil && client.Store != nil && client.Store.ID != nil {
					jidUser := client.Store.ID.User
					_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected' WHERE LOWER(username)=LOWER($2)", jidUser, username)
				}
				return
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
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")

	ClientsLock.Lock()
	client, exists := ActiveClients[cleanUsr]
	existingCode := QRChannelMap[cleanUsr]
	ClientsLock.Unlock()

	if exists && client != nil {
		if client.IsLoggedIn() {
			return ""
		}
		if existingCode != "" {
			return existingCode
		}
		// Reset unlinked client so GetQRChannel can be requested cleanly
		client.Disconnect()
		if client.Store != nil && client.Store.ID == nil {
			_ = client.Store.Delete(context.Background())
		}
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
				if client.Store.ID != nil && DB != nil {
					jidUser := client.Store.ID.User
					_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=NOW() WHERE LOWER(username)=LOWER($2)", jidUser, cleanUsr)
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
	req.Header.Set("User-Agent", "EduCloud-WhatsApp-Bot/1.0 (Location-Resolver)")

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

// CheckAndProcessLead determines if incoming message represents a product purchase or order, saves it as a lead, and dispatches automated WhatsApp alert to notification_phone
func CheckAndProcessLead(username string, client *whatsmeow.Client, senderPhone string, msgText string, msg *waE2E.Message) {
	if DB == nil || senderPhone == "" || strings.TrimSpace(msgText) == "" {
		return
	}

	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	isLead := false
	leadStatus := ""
	leadDetails := ""

	// Chat-based Purchase or Order Intent
	// Only consider as lead if customer clearly expressed intent to buy, order, pay, book, or COD
	lower := strings.ToLower(msgText)
	orderPhrases := []string{
		"order kardo", "order karna", "order place", "confirm order", "order now",
		"kharidna hai", "lena hai", "buy now", "want to buy", "i want to buy",
		"purchase", "booking karna", "book kardo", "cod chahiye", "cash on delivery",
		"payment done", "payment kar diya", "paid", "advance payment", "deliver kardo",
		"place order", "send invoice", "bill send karo", "mujhe order karna hai",
	}
	for _, kw := range orderPhrases {
		if strings.Contains(lower, kw) {
			isLead = true
			leadStatus = "Purchase Request"
			leadDetails = msgText
			break
		}
	}

	if !isLead {
		return
	}

	// Persist to leads table in DB
	var leadID int
	err := DB.QueryRow(`INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at)
		VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
		cleanUsr, senderPhone, leadDetails, leadStatus).Scan(&leadID)
	if err != nil {
		log.Printf("⚠️ Error inserting captured lead into DB: %v", err)
	} else {
		log.Printf("🎯 [Lead Captured #%d] +%s (@%s) -> %s", leadID, senderPhone, cleanUsr, leadStatus)
	}

	// Dispatch Automated WhatsApp Lead Alert directly to the notification_phone configured in AI Responder
	go dispatchLeadAlertWhatsApp(cleanUsr, client, senderPhone, leadDetails, leadStatus)
}

// dispatchLeadAlertWhatsApp sends immediate notification to the configured notification_phone in AI Responder settings
func dispatchLeadAlertWhatsApp(username string, client *whatsmeow.Client, customerPhone, details, status string) {
	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	var notifPhone string
	_ = DB.QueryRow("SELECT COALESCE(notification_phone, '') FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&notifPhone)

	notifPhone = strings.TrimSpace(notifPhone)
	if notifPhone == "" {
		log.Printf("ℹ️ [Lead Alert] No notification_phone configured for @%s in AI Responder. Skipping WhatsApp alert dispatch.", cleanUsr)
		return
	}

	targetPhone := FormatPhone(notifPhone)
	if targetPhone == "" || len(targetPhone) < 10 {
		log.Printf("⚠️ [Lead Alert] Invalid notification_phone (+%s) for @%s", notifPhone, cleanUsr)
		return
	}

	// Avoid notifying the customer themselves if customerPhone == targetPhone
	if targetPhone == customerPhone {
		return
	}

	activeClient := client
	if activeClient == nil || !activeClient.IsLoggedIn() {
		activeClient = GetOrCreateClient(cleanUsr)
	}

	cleanCustomer := FormatPhone(customerPhone)
	locTime := time.Now().Format("02 Jan 15:04")

	alertMsg := fmt.Sprintf("🛍️ *NEW LEAD / ORDER RECEIVED!* 🛍️\n\n"+
		"• *Account*: @%s\n"+
		"• *Customer Phone*: +%s\n"+
		"• *Status*: %s\n"+
		"• *Time*: %s\n\n"+
		"📦 *Order / Product Details*:\n%s\n\n"+
		"📲 *Chat with Customer directly*:\nhttps://wa.me/%s",
		cleanUsr, cleanCustomer, status, locTime, details, cleanCustomer)

	// Dispatch SSE event for web portal
	PushToLiveChat(cleanUsr, targetPhone, alertMsg, "lead_alert")

	if activeClient != nil && activeClient.IsLoggedIn() {
		err := SendMessage(activeClient, targetPhone, alertMsg)
		if err != nil {
			log.Printf("⚠️ [Lead Alert] Failed to send WhatsApp lead alert to +%s: %v", targetPhone, err)
		} else {
			log.Printf("✅ [Lead Alert] Successfully delivered WhatsApp lead alert to +%s for customer +%s", targetPhone, cleanCustomer)
		}
	} else {
		log.Printf("⚠️ [Lead Alert] WhatsApp client for @%s is not logged in; alert logged to Live Chat stream.", cleanUsr)
	}
}

// Incoming Message Handler (Client-side Chat + AI Auto-Reply)
func handleWhatsAppEvents(username string, client *whatsmeow.Client, evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		if v.Info.IsFromMe || v.Info.IsGroup {
			return
		}

		if v.Info.Sender.Server == "newsletter" || v.Info.Chat.Server == "newsletter" || v.Info.Chat.Server == "broadcast" {
			return // Ignore newsletters, channels, status broadcasts
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

		senderPhone := ResolveRealPhoneNumber(client, v.Info.Sender, v.Info.Chat)
		if senderPhone == "" || len(senderPhone) < 8 || strings.HasPrefix(senderPhone, "120363") {
			return // Ignore invalid or broadcast JIDs
		}

		// 2. Ignore incoming media messages (Photo, Video, Audio, Sticker, Doc, Contact, Catalog) without reply
		if isMediaMessage(v.Message) {
			log.Printf("🚫 Incoming message from +%s (@%s) contains media or catalog. Ignored without reply as requested.", senderPhone, username)
			return
		}

		msgText := extractMessageText(username, client, v.Message)
		if msgText == "" {
			return
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

			cfg := GetUserConfigRAM(username)

			if cfg != nil && cfg.AutoReply {
				activeClient := client
				if activeClient == nil || !activeClient.IsLoggedIn() {
					activeClient = GetOrCreateClient(username)
				}

				// Continuous WhatsApp Typing Loop: pulses every 1.5s so WhatsApp NEVER hides the "typing..." logo until final delivery!
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

						// Immediate typing indicator
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

				// Generate AI reply instantly from RAM sliding window and cached system prompt
				replyText, imgURL := GenerateAIReplyRAM(username, senderPhone, msgText, cfg)

				var deliveredReply string

				if imgURL != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendImageReplyFromURL(activeClient, senderPhone, imgURL, replyText, v.Info.ID, v.Info.Sender, v.Message)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI image reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("⚡ AI image reply delivered to +%s (as native WhatsApp reply)", senderPhone)
					}
					deliveredReply = "[Image Sent] " + replyText
				} else if replyText != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendReplyMessage(activeClient, senderPhone, replyText, v.Info.ID, v.Info.Sender, v.Message)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI text reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("⚡ Ultra-Fast AI reply delivered to +%s (as native WhatsApp reply): %s", senderPhone, replyText)
					}
					deliveredReply = replyText
				}

				// STOP continuous typing indicator ONLY AFTER message is dispatched to WhatsApp!
				stopTypingFunc()

				if deliveredReply != "" {
					PushToLiveChat(username, senderPhone, deliveredReply, "outgoing_ai")
					go func() {
						SaveCustomerChatAndPrune(username, senderPhone, "assistant", deliveredReply)
					}()
				}
			}
		}()

	case *events.Disconnected:
		log.Printf("⚠️ WebSocket disconnected for @%s. Triggering auto-reconnect retry loop...", username)
		ConnectWithAutoRetry(client, username)

	case *events.LoggedOut:
		fmt.Printf("⚠️ User @%s unlinked from phone. Auto-cleaning WhatsApp session details...\n", username)
		ClientsLock.Lock()
		delete(ActiveClients, username)
		delete(QRChannelMap, username)
		ClientsLock.Unlock()

		if client != nil {
			client.Disconnect()
			if client.Store != nil {
				_ = client.Store.Delete(context.Background())
			}
		}

		if DB != nil {
			// Only clear WhatsApp device details from DB; keep the registered user account intact!
			_, _ = DB.Exec("UPDATE users SET wa_jid='', status='Disconnected' WHERE username=$1", username)
		}

		PushToLiveChat(username, "", "WhatsApp session was unlinked from phone.", "session_unlinked")

	case *events.Connected:
		if client != nil {
			_ = client.SendPresence(types.PresenceAvailable)
		}
		if client != nil && client.Store.ID != nil && DB != nil {
			jidStr := client.Store.ID.User
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=COALESCE(linked_at, NOW()) WHERE LOWER(username)=LOWER($2)", jidStr, username)
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp session connected successfully", "session_connected")
		}

	case *events.PairSuccess:
		if client != nil {
			_ = client.SendPresence(types.PresenceAvailable)
		}
		if client != nil && client.Store.ID != nil && DB != nil {
			jidStr := client.Store.ID.User
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=NOW() WHERE LOWER(username)=LOWER($2)", jidStr, username)
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp paired successfully", "session_connected")
		}
	}
}

// AutoConnectAllSessions initializes and connects all saved WhatsApp clients on boot
func AutoConnectAllSessions() {
	if DB == nil {
		return
	}
	rows, err := DB.Query("SELECT DISTINCT username FROM users WHERE status='Connected' AND wa_jid!=''")
	if err != nil {
		return
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err == nil && username != "" {
			go func(usr string) {
				c := GetOrCreateClient(usr)
				if c != nil && c.IsLoggedIn() && !c.IsConnected() {
					ConnectWithAutoRetry(c, usr)
				}
			}(username)
			count++
		}
	}
	if count > 0 {
		log.Printf("⚡ [WhatsApp Gateway] Auto-initialized %d active WhatsApp account sessions on boot.", count)
	}
}

// StartKeepAliveMonitor checks active clients every 10 seconds and re-establishes broken WebSockets
func StartKeepAliveMonitor() {
	go func() {
		ticker := time.NewTicker(10 * time.Second)
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
				} else if client != nil && client.IsConnected() {
					// Keep device active/online so incoming messages never suffer push delay
					_ = client.SendPresence(types.PresenceAvailable)
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


// SendReplyMessage sends an AI text reply natively quoting the customer's incoming message in WhatsApp
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
	if quotedID != "" && quotedMsg != nil {
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
