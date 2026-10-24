package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"wa-server/whatsapp"
)

// REAL CUSTOMER CONVERSATION LIST (GET /api/chats)
func ChatsHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	type Conversation struct {
		CustomerPhone string `json:"customer_phone"`
		LastMessage   string `json:"last_message"`
		LastRole      string `json:"last_role"`
		LastTime      string `json:"last_time"`
		TotalCount    int    `json:"total_count"`
	}

	var conversations []Conversation

	if DB != nil {
		rows, err := DB.Query(`
			SELECT customer_phone, 
			       COALESCE((SELECT message_text FROM customer_chats c2 WHERE LOWER(c2.username)=LOWER(c1.username) AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), ''),
			       COALESCE((SELECT role FROM customer_chats c2 WHERE LOWER(c2.username)=LOWER(c1.username) AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), 'customer'),
			       COALESCE((SELECT TO_CHAR(created_at, 'HH24:MI') FROM customer_chats c2 WHERE LOWER(c2.username)=LOWER(c1.username) AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), 'Recent'),
			       COUNT(*)
			FROM customer_chats c1
			WHERE LOWER(username)=LOWER($1) 
			  AND LENGTH(customer_phone) >= 8
			  AND LENGTH(customer_phone) <= 20
			GROUP BY customer_phone, username
			ORDER BY MAX(id) DESC LIMIT 50`, username)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var conv Conversation
				if err := rows.Scan(&conv.CustomerPhone, &conv.LastMessage, &conv.LastRole, &conv.LastTime, &conv.TotalCount); err == nil {
					conversations = append(conversations, conv)
				}
			}
		}
	}

	if conversations == nil {
		conversations = []Conversation{}
	}

	respondJSON(w, 200, map[string]interface{}{"conversations": conversations})
}

// GET REAL LAST 10 MESSAGES FOR SPECIFIC CUSTOMER (GET /api/chats/messages)
func ChatMessagesHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	if username == "" {
		username = "admin"
	}

	cleanPhone := whatsapp.FormatPhone(phone)
	if cleanPhone == "" {
		respondJSON(w, 200, map[string]interface{}{"messages": []interface{}{}})
		return
	}

	type ChatMsgItem struct {
		ID   int    `json:"id"`
		Role string `json:"role"`
		Text string `json:"text"`
		Time string `json:"time"`
	}

	var messages []ChatMsgItem

	if DB != nil {
		rows, err := DB.Query(`SELECT id, role, message_text, COALESCE(TO_CHAR(created_at, 'HH24:MI'), 'Recent')
			FROM (
				SELECT id, role, message_text, created_at 
				FROM customer_chats 
				WHERE LOWER(username)=LOWER($1) AND customer_phone=$2
				ORDER BY id DESC LIMIT 10
			) sub ORDER BY id ASC`, username, cleanPhone)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var m ChatMsgItem
				if err := rows.Scan(&m.ID, &m.Role, &m.Text, &m.Time); err == nil {
					messages = append(messages, m)
				}
			}
		}
	}

	if messages == nil {
		messages = []ChatMsgItem{}
	}

	respondJSON(w, 200, map[string]interface{}{"messages": messages})
}

// SEND OUTGOING MESSAGE FROM LIVE CHAT UI (POST /api/chats/send)
func ChatSendHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
		Message  string `json:"message"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" {
		username = "admin"
	}

	cleanPhone := whatsapp.FormatPhone(req.Phone)
	cleanMsg := strings.TrimSpace(req.Message)

	if cleanPhone == "" || cleanMsg == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Phone number and message text required"})
		return
	}

	// 1. Record in DB with 10-message sliding window pruning
	whatsapp.SaveCustomerChatAndPrune(username, cleanPhone, "assistant", cleanMsg)

	// 2. Push to Live Chat SSE
	whatsapp.PushToLiveChat(username, cleanPhone, cleanMsg, "outgoing")

	// 3. Send over WhatsApp if device linked
	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		_ = whatsapp.SendMessage(client, cleanPhone, cleanMsg)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":  "success",
		"message": "Message sent and recorded in customer chat history.",
	})
}

// LIVE CHAT REAL-TIME SSE STREAM (GET /api/chat/stream)
func LiveChatSSEHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported!", http.StatusInternalServerError)
		return
	}

	messageChan := make(chan map[string]string, 10)

	whatsapp.StreamLock.Lock()
	whatsapp.LiveChatStreams[username] = messageChan
	whatsapp.StreamLock.Unlock()

	defer func() {
		whatsapp.StreamLock.Lock()
		delete(whatsapp.LiveChatStreams, username)
		whatsapp.StreamLock.Unlock()
	}()

	// Send initial ping
	fmt.Fprintf(w, "data: {\"type\": \"connected\", \"username\": \"%s\"}\n\n", username)
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-messageChan:
			if !ok {
				return
			}
			dataBytes, _ := json.Marshal(msg)
			fmt.Fprintf(w, "data: %s\n\n", string(dataBytes))
			flusher.Flush()
		}
	}
}
