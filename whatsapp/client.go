package whatsapp

import (
	"context"
	"database/sql"
	"encoding/base64"
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

	// Live Chat Listeners (Browser SSE channels per user)
	LiveChatStreams = make(map[string]chan map[string]string)
	StreamLock      sync.Mutex
)

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

	// 1. Primary: Use dedicated direct sqlstore connection
	if directURL != "" {
		dedicatedDB, dbErr := sql.Open("postgres", directURL)
		if dbErr == nil && dedicatedDB != nil {
			dedicatedDB.SetMaxOpenConns(6)
			dedicatedDB.SetMaxIdleConns(2)
			dedicatedDB.SetConnMaxLifetime(10 * time.Minute)
			dedicatedDB.SetConnMaxIdleTime(2 * time.Minute)

			StoreContainer = sqlstore.NewWithDB(dedicatedDB, "postgres", dbLog)
			if StoreContainer != nil {
				err = StoreContainer.Upgrade(context.Background())
				if err == nil {
					log.Println("✅ Whatsmeow Store initialized with dedicated direct PostgreSQL connection!")
					return
				}
				log.Printf("⚠️ StoreContainer.Upgrade notice: %v", err)
			}
		}

		StoreContainer, err = sqlstore.New(context.Background(), "postgres", directURL, dbLog)
		if err == nil && StoreContainer != nil {
			log.Println("✅ Whatsmeow Store initialized with direct PostgreSQL connection string!")
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

	// 2. Admin fallback if first device exists
	if deviceStore == nil && username == "admin" {
		dev, err := StoreContainer.GetFirstDevice(context.Background())
		if err == nil && dev != nil {
			deviceStore = dev
		}
	}

	// 3. New device allocation
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
	// 1. Try Chat JID if it is a standard phone user server (@s.whatsapp.net or @c.us)
	if (chatJID.Server == types.DefaultUserServer || chatJID.Server == "c.us" || chatJID.Server == "s.whatsapp.net") && chatJID.User != "" {
		clean := regexp.MustCompile(`\D`).ReplaceAllString(chatJID.User, "")
		clean = strings.Split(clean, ".")[0]
		if len(clean) >= 8 {
			return FormatPhone(clean)
		}
	}

	// 2. Try Sender JID if it is a standard phone user server (@s.whatsapp.net or @c.us)
	if (senderJID.Server == types.DefaultUserServer || senderJID.Server == "c.us" || senderJID.Server == "s.whatsapp.net") && senderJID.User != "" {
		clean := regexp.MustCompile(`\D`).ReplaceAllString(senderJID.User, "")
		clean = strings.Split(clean, ".")[0]
		if len(clean) >= 8 {
			return FormatPhone(clean)
		}
	}

	// 3. Fallback: Extract numeric phone digits from chat or sender user ID (handles LID & custom JIDs)
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
	if normalRole == "user" || normalRole == "client" {
		normalRole = "customer"
	} else if normalRole == "outgoing" || normalRole == "outgoing_ai" || normalRole == "assistant" {
		normalRole = "assistant"
	}

	// 1. Insert chat record into customer_chats table with explicit customer_phone
	_, err := DB.Exec(`INSERT INTO customer_chats (username, customer_phone, role, message_text, created_at)
		VALUES ($1, $2, $3, $4, NOW())`, cleanUsr, cleanPhone, normalRole, messageText)
	if err != nil {
		log.Printf("⚠️ SaveCustomerChat error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
	}

	// 2. Prune DB to strictly retain last 10 messages per customer (Sliding Window in DB)
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

// Helper to extract text or label from any incoming WhatsApp message payload type
func extractMessageText(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if text := msg.GetConversation(); text != "" {
		return text
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil && ext.GetText() != "" {
		return ext.GetText()
	}
	if img := msg.GetImageMessage(); img != nil {
		if img.GetCaption() != "" {
			return img.GetCaption()
		}
		return "[Photo received]"
	}
	if vid := msg.GetVideoMessage(); vid != nil {
		if vid.GetCaption() != "" {
			return vid.GetCaption()
		}
		return "[Video received]"
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		if doc.GetCaption() != "" {
			return doc.GetCaption()
		}
		if doc.GetTitle() != "" {
			return "[Document received: " + doc.GetTitle() + "]"
		}
		return "[Document received]"
	}
	if audio := msg.GetAudioMessage(); audio != nil {
		return "[Voice message received]"
	}
	if sticker := msg.GetStickerMessage(); sticker != nil {
		return "[Sticker received]"
	}
	if loc := msg.GetLocationMessage(); loc != nil {
		return "[Location shared]"
	}
	if ephem := msg.GetEphemeralMessage(); ephem != nil && ephem.GetMessage() != nil {
		return extractMessageText(ephem.GetMessage())
	}
	if viewOnce := msg.GetViewOnceMessage(); viewOnce != nil && viewOnce.GetMessage() != nil {
		return extractMessageText(viewOnce.GetMessage())
	}
	if viewOnceV2 := msg.GetViewOnceMessageV2(); viewOnceV2 != nil && viewOnceV2.GetMessage() != nil {
		return extractMessageText(viewOnceV2.GetMessage())
	}
	if edited := msg.GetEditedMessage(); edited != nil && edited.GetMessage() != nil {
		if protoMsg := edited.GetMessage().GetProtocolMessage(); protoMsg != nil && protoMsg.GetEditedMessage() != nil {
			return extractMessageText(protoMsg.GetEditedMessage())
		}
	}
	return ""
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

		senderPhone := ResolveRealPhoneNumber(client, v.Info.Sender, v.Info.Chat)
		if senderPhone == "" || len(senderPhone) < 8 || strings.HasPrefix(senderPhone, "120363") {
			return // Ignore invalid or broadcast JIDs
		}

		msgText := extractMessageText(v.Message)
		if msgText == "" {
			return
		}

		log.Printf("📩 Incoming message received from +%s (@%s): %s", senderPhone, username, msgText)

		// Auto-mark message as read on WhatsApp so blue ticks appear and connection stays active
		if client != nil {
			go func() {
				_ = client.MarkRead(context.Background(), []types.MessageID{v.Info.ID}, v.Info.Timestamp, v.Info.Chat, v.Info.Sender)
			}()
		}

		// 1. SAVE RECEIVED CUSTOMER MESSAGE TO DB IMMEDIATELY
		SaveCustomerChatAndPrune(username, senderPhone, "customer", msgText)
		if DB != nil {
			_, _ = DB.Exec("INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Captured Lead', NOW())",
				username, senderPhone, msgText)
		}

		// 2. PUSH RECEIVED MESSAGE TO LIVE CHAT SSE UI INSTANTLY
		PushToLiveChat(username, senderPhone, msgText, "incoming")

		// Concurrent Ultra-Fast AI Reply Generation & Delivery Pipeline
		go func() {
			// FETCH USER AI CONFIGURATION FROM INSTANT RAM CACHE
			cfg := GetUserConfigRAM(username)

			if cfg != nil && cfg.AutoReply {
				activeClient := client
				if activeClient == nil || !activeClient.IsLoggedIn() {
					activeClient = GetOrCreateClient(username)
				}

				// 3. GENERATE AI REPLY INSTANTLY IN SERVER RAM
				replyText, imgURL := GenerateAIReplyRAM(username, senderPhone, msgText, cfg)

				var deliveredReply string

				if imgURL != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendImageFromURL(activeClient, senderPhone, imgURL, replyText)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI image reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("⚡ AI image reply delivered to +%s", senderPhone)
					}
					deliveredReply = "[Image Sent] " + replyText
				} else if replyText != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendMessage(activeClient, senderPhone, replyText)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI text reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("⚡ Ultra-Fast AI reply delivered to +%s: %s", senderPhone, replyText)
					}
					deliveredReply = replyText
				}

				if deliveredReply != "" {
					// 4. WHEN REPLY IS DELIVERED TO CUSTOMER -> SAVE AI REPLY TO DB & PUSH TO LIVE CHAT UI
					SaveCustomerChatAndPrune(username, senderPhone, "assistant", deliveredReply)
					PushToLiveChat(username, senderPhone, deliveredReply, "outgoing_ai")
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
		if client != nil && client.Store.ID != nil && DB != nil {
			jidStr := client.Store.ID.User
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=COALESCE(linked_at, NOW()) WHERE LOWER(username)=LOWER($2)", jidStr, username)
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp session connected successfully", "session_connected")
		}

	case *events.PairSuccess:
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
	rows, err := DB.Query("SELECT DISTINCT username FROM users WHERE status='Connected' OR wa_jid!=''")
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

	primaryServer := types.DefaultUserServer
	if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") {
		primaryServer = "lid"
	}

	targetJID := types.NewJID(cleanPhone, primaryServer)
	msg := &waE2E.Message{Conversation: proto.String(message)}
	_, err := client.SendMessage(context.Background(), targetJID, msg)
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

	primaryServer := types.DefaultUserServer
	if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") {
		primaryServer = "lid"
	}

	targetJID := types.NewJID(cleanPhone, primaryServer)

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
