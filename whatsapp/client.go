package whatsapp

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"math/rand"
	"net/http"
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
		return
	}
	dbLog := waLog.Stdout("WhatsAppStore", "ERROR", false)
	var err error
	StoreContainer, err = sqlstore.New(context.Background(), "postgres", dbURL, dbLog)
	if err != nil {
		fmt.Println("WhatsApp Store Error:", err.Error())
	}
}

// Multi-tenant WhatsApp Client: Load from Neon Postgres using saved wa_jid or create new
func GetOrCreateClient(username string) *whatsmeow.Client {
	ClientsLock.Lock()
	defer ClientsLock.Unlock()

	if c, exists := ActiveClients[username]; exists {
		return c
	}

	if StoreContainer == nil {
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
		qrChan, _ := client.GetQRChannel(context.Background())
		_ = client.Connect()
		go func() {
			for evt := range qrChan {
				if evt.Event == "code" {
					QRChannelMap[username] = evt.Code
				} else if evt.Event == "success" {
					QRChannelMap[username] = ""
					if client.Store.ID != nil && DB != nil {
						jidUser := client.Store.ID.User
						_, _ = DB.Exec("UPDATE users SET wa_jid=$1, status='Connected' WHERE LOWER(username)=LOWER($2)", jidUser, username)
					}
				}
			}
		}()
	} else {
		_ = client.Connect()
		if DB != nil && client.Store.ID != nil {
			_, _ = DB.Exec("UPDATE users SET status='Connected' WHERE LOWER(username)=LOWER($1)", username)
		}
	}

	return client
}

// Incoming Message Handler (Client-side Chat + AI Auto-Reply)
func handleWhatsAppEvents(username string, client *whatsmeow.Client, evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		if v.Info.IsFromMe || v.Info.IsGroup {
			return
		}

		senderPhone := v.Info.Sender.User
		msgText := v.Message.GetConversation()
		if msgText == "" && v.Message.ExtendedTextMessage != nil {
			msgText = v.Message.ExtendedTextMessage.GetText()
		}
		if msgText == "" {
			return
		}

		// 1. ZERO-LOAD LIVE CHAT: Push directly to browser
		PushToLiveChat(username, senderPhone, msgText, "incoming")

		// 2. RECORD REAL CAPTURED LEAD IN NEON POSTGRESQL
		if DB != nil {
			_, _ = DB.Exec("INSERT INTO leads (username, customer_phone, inquiry_text, status) VALUES ($1, $2, $3, 'Captured')",
				username, senderPhone, msgText)
		}

		// 3. AI AUTO-REPLY CHECK
		go func() {
			if DB == nil {
				return
			}
			var provider, apiKey, sysPrompt string
			var autoReply bool
			err := DB.QueryRow("SELECT ai_provider, api_key, system_prompt, auto_reply FROM users WHERE username=$1", username).
				Scan(&provider, &apiKey, &sysPrompt, &autoReply)

			if err == nil && autoReply && apiKey != "" {
				replyText, imgURL := GenerateAIReply(username, senderPhone, msgText, provider, apiKey, sysPrompt)
				if imgURL != "" {
					_ = SendImageFromURL(client, senderPhone, imgURL, replyText)
					PushToLiveChat(username, senderPhone, "[Image Sent] "+replyText, "outgoing_ai")
				} else if replyText != "" {
					_ = SendMessage(client, senderPhone, replyText)
					PushToLiveChat(username, senderPhone, replyText, "outgoing_ai")
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
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, status='Connected' WHERE username=$2", jidStr, username)
			QRChannelMap[username] = ""
			PushToLiveChat(username, jidStr, "WhatsApp session connected successfully", "session_connected")
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
	targetJID := types.NewJID(phone, types.DefaultUserServer)
	msg := &waE2E.Message{Conversation: proto.String(message)}
	_, err := client.SendMessage(context.Background(), targetJID, msg)
	return err
}

// 2. Image URL (Neon Bucket) Se Photo + Caption Bhejna
func SendImageFromURL(client *whatsmeow.Client, phone, imageURL, caption string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}

	// Neon Storage ya URL se image bytes download karna
	resp, err := http.Get(imageURL)
	if err != nil {
		return fmt.Errorf("image download failed: %v", err)
	}
	defer resp.Body.Close()

	imgBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	// WhatsApp Server par encrypt karke upload karna
	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}

	mimeType := http.DetectContentType(imgBytes)
	targetJID := types.NewJID(phone, types.DefaultUserServer)

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
