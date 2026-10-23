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
	if dbURL != "" && !strings.Contains(dbURL, "sslmode=") {
		if strings.Contains(dbURL, "?") {
			dbURL += "&sslmode=require"
		} else {
			dbURL += "?sslmode=require"
		}
	}

	dbLog := waLog.Stdout("WhatsAppStore", "ERROR", false)
	var err error

	// 1. Primary: Use existing pooled connection if available
	if dbConn != nil {
		StoreContainer = sqlstore.NewWithDB(dbConn, "postgres", dbLog)
		if StoreContainer != nil {
			err = StoreContainer.Upgrade(context.Background())
			if err == nil {
				log.Println("✅ Whatsmeow Store initialized with active PostgreSQL pool!")
				return
			}
			log.Printf("⚠️ StoreContainer.Upgrade notice: %v. Falling back to dedicated connection...", err)
		}
	}

	// 2. Secondary: Open dedicated sqlstore connection with sanitized dbURL
	if dbURL != "" {
		StoreContainer, err = sqlstore.New(context.Background(), "postgres", dbURL, dbLog)
		if err != nil {
			log.Printf("⚠️ Whatsmeow Store connection error: %v", err)
		} else {
			log.Println("✅ Whatsmeow Store initialized with dedicated connection!")
			return
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
		allDevices, err := StoreContainer.GetAllDevices(context.Background())
		if err == nil {
			for _, dev := range allDevices {
				if dev.ID != nil && (dev.ID.User == savedJID || dev.ID.String() == savedJID) {
					deviceStore = dev
					break
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
		go func() {
			if err := client.Connect(); err != nil {
				log.Printf("⚠️ Client connect error for @%s: %v", username, err)
			}
		}()
	} else {
		go func() {
			if err := client.Connect(); err != nil {
				log.Printf("⚠️ Client reconnect error for @%s: %v", username, err)
			}
			if DB != nil && client.Store.ID != nil {
				jidUser := client.Store.ID.User
				_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected' WHERE LOWER(username)=LOWER($2)", jidUser, username)
			}
		}()
	}

	return client
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

// FormatPhone cleans and adds India '91' prefix if 10-digit number is provided
func FormatPhone(phone string) string {
	clean := regexp.MustCompile(`\D`).ReplaceAllString(phone, "")
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

	// 1. Insert chat record into customer_chats table
	_, err := DB.Exec(`INSERT INTO customer_chats (username, customer_phone, role, message_text, created_at)
		VALUES ($1, $2, $3, $4, NOW())`, cleanUsr, cleanPhone, role, messageText)
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
	_ = updateSlidingWindowRAM(cleanUsr, cleanPhone, role, messageText)
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

		senderUser := v.Info.Sender.User
		if senderUser == "" {
			senderUser = v.Info.Chat.User
		}

		senderPhone := FormatPhone(senderUser)
		if len(senderPhone) < 8 || len(senderPhone) > 15 || strings.HasPrefix(senderPhone, "120363") {
			return // Ignore non-mobile newsletter channel JIDs
		}

		msgText := extractMessageText(v.Message)
		if msgText == "" {
			return
		}

		// 1. RECORD IN CUSTOMER CHATS (NOT LEADS!) AND ENFORCE STRICT 10-MESSAGE LIMIT IN DB
		SaveCustomerChatAndPrune(username, senderPhone, "customer", msgText)

		// 2. ZERO-LOAD LIVE CHAT: Push directly to browser via SSE
		PushToLiveChat(username, senderPhone, msgText, "incoming")

		// 3. AI AUTO-REPLY CHECK & LEAD QUALIFICATION DISPATCH
		go func() {
			if DB == nil {
				return
			}
			var provider, apiKey, sysPrompt, notifPhone string
			var autoReply bool
			err := DB.QueryRow("SELECT COALESCE(ai_provider, 'groq'), COALESCE(api_key, ''), COALESCE(system_prompt, ''), COALESCE(auto_reply, true), COALESCE(notification_phone, '') FROM users WHERE LOWER(username)=LOWER($1)", strings.ToLower(username)).
				Scan(&provider, &apiKey, &sysPrompt, &autoReply, &notifPhone)

			// Always save captured lead inquiry directly into Neon Postgres DB
			_, _ = DB.Exec("INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Captured Lead', NOW())",
				username, senderPhone, msgText)

			if err == nil && autoReply {
				activeClient := client
				if activeClient == nil || !activeClient.IsLoggedIn() {
					activeClient = GetOrCreateClient(username)
				}

				replyText, imgURL := GenerateAIReply(username, senderPhone, msgText, provider, apiKey, sysPrompt)
				if imgURL != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendImageFromURL(activeClient, senderPhone, imgURL, replyText)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI image reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("✅ AI image reply sent to +%s", senderPhone)
					}
					SaveCustomerChatAndPrune(username, senderPhone, "assistant", "[Image Sent] "+replyText)
					PushToLiveChat(username, senderPhone, "[Image Sent] "+replyText, "outgoing_ai")
				} else if replyText != "" && activeClient != nil && activeClient.IsLoggedIn() {
					sendErr := SendMessage(activeClient, senderPhone, replyText)
					if sendErr != nil {
						log.Printf("⚠️ Error sending AI text reply to +%s: %v", senderPhone, sendErr)
					} else {
						log.Printf("✅ AI auto-reply sent to +%s: %s", senderPhone, replyText)
					}
					SaveCustomerChatAndPrune(username, senderPhone, "assistant", replyText)
					PushToLiveChat(username, senderPhone, replyText, "outgoing_ai")
				}

				// If Lead Alert Notification Phone is set, dispatch automated alert message!
				cleanNotif := FormatPhone(notifPhone)
				if cleanNotif != "" && activeClient != nil && activeClient.IsLoggedIn() {
					alertText := fmt.Sprintf("🚨 *NEW AI QUALIFIED LEAD ALERT* 🚨\n\n• Account: @%s\n• Customer Phone: +%s\n• Last Message: %s\n• Time: %s",
						username, senderPhone, msgText, time.Now().Format("02 Jan 15:04:05"))
					_ = SendMessage(activeClient, cleanNotif, alertText)
					PushToLiveChat(username, cleanNotif, alertText, "lead_alert")
				}
			}
		}()
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

// 1. Text Message Bhejna
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

	targetJID := types.NewJID(cleanPhone, types.DefaultUserServer)
	msg := &waE2E.Message{Conversation: proto.String(message)}
	_, err := client.SendMessage(context.Background(), targetJID, msg)
	return err
}

// 2. Image URL or Base64 Data URI Se Photo + Caption Bhejna
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
		// Handle Base64 Data URI
		parts := strings.SplitN(imageURL, ",", 2)
		if len(parts) == 2 {
			imgBytes, err = base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return fmt.Errorf("failed to decode base64 image: %v", err)
			}
		}
	} else if strings.HasPrefix(imageURL, "http://") || strings.HasPrefix(imageURL, "https://") {
		// Neon Storage ya URL se image bytes download karna
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

	// WhatsApp Server par encrypt karke upload karna
	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}

	mimeType := http.DetectContentType(imgBytes)
	targetJID := types.NewJID(cleanPhone, types.DefaultUserServer)

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
