package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"go.mau.fi/whatsmeow"
	"golang.org/x/crypto/bcrypt"
	"wa-server/whatsapp"
)

var DB *sql.DB

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// 1. LOGIN API (Admin & SaaS Users)
func LoginHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if DB == nil {
		if req.Username == "admin" && req.Password == "admin123" {
			respondJSON(w, 200, map[string]interface{}{
				"status":        "success",
				"token":         "eduta-token-" + req.Username,
				"username":      req.Username,
				"role":          "admin",
				"user_id":       1,
				"ai_provider":   "groq",
				"api_key":       "",
				"system_prompt": "You are Eduta Library AI manager.",
				"auto_reply":    true,
			})
			return
		}
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Username or Password!"})
		return
	}

	var id int
	var hashPass, role, aiProvider, apiKey, sysPrompt string
	var autoReply bool

	err := DB.QueryRow(`SELECT id, password, role, ai_provider, api_key, system_prompt, auto_reply 
		FROM users WHERE username=$1`, req.Username).
		Scan(&id, &hashPass, &role, &aiProvider, &apiKey, &sysPrompt, &autoReply)

	if err != nil {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Username or Password!"})
		return
	}

	if role == "admin" {
		if req.Password != hashPass {
			respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Admin Password!"})
			return
		}
	} else {
		if err := bcrypt.CompareHashAndPassword([]byte(hashPass), []byte(req.Password)); err != nil {
			respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Password!"})
			return
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":        "success",
		"token":         "eduta-token-" + req.Username,
		"username":      req.Username,
		"role":          role,
		"user_id":       id,
		"ai_provider":   aiProvider,
		"api_key":       apiKey,
		"system_prompt": sysPrompt,
		"auto_reply":    autoReply,
	})
}

// 2. ADMIN: CREATE USER / LIBRARY ACCOUNT
func CreateUserHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" || req.Password == "" {
		respondJSON(w, 400, map[string]string{"error": "Username aur Password dono zaroori hain"})
		return
	}

	if DB == nil {
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Account Created (In-Memory)!"})
		return
	}

	hashedPass, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	_, err := DB.Exec("INSERT INTO users (username, password, role) VALUES ($1, $2, 'user')", req.Username, string(hashedPass))
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Username pehle se maujood hai!"})
		return
	}

	respondJSON(w, 200, map[string]string{"status": "success", "message": "Account Created Successfully!"})
}

// 3. ADMIN: LIST ALL ACCOUNTS
func ListUsersHandler(w http.ResponseWriter, r *http.Request) {
	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"users": []map[string]interface{}{
				{"id": 1, "username": "admin", "role": "admin", "wa_jid": "", "auto_reply": false, "status": "Disconnected"},
			},
		})
		return
	}

	rows, err := DB.Query("SELECT id, username, role, wa_jid, auto_reply FROM users ORDER BY id ASC")
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	var users []map[string]interface{}
	for rows.Next() {
		var id int
		var u, role, jid string
		var auto bool
		rows.Scan(&id, &u, &role, &jid, &auto)

		connStatus := "Offline"
		if c, ok := whatsapp.ActiveClients[u]; ok && c.IsConnected() && c.IsLoggedIn() {
			connStatus = "Connected"
		}

		users = append(users, map[string]interface{}{
			"id":         id,
			"username":   u,
			"role":       role,
			"wa_jid":     jid,
			"auto_reply": auto,
			"status":     connStatus,
		})
	}
	respondJSON(w, 200, map[string]interface{}{"users": users})
}

// 4. ADMIN: DELETE USER
func DeleteUserHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}

	if req.Username == "admin" || req.Username == "" {
		respondJSON(w, 403, map[string]string{"error": "Master Admin delete nahi ho sakta ya username missing hai!"})
		return
	}

	if c, ok := whatsapp.ActiveClients[req.Username]; ok {
		c.Disconnect()
		if c.Store != nil {
			_ = c.Store.Delete(context.Background())
		}
		delete(whatsapp.ActiveClients, req.Username)
		delete(whatsapp.QRChannelMap, req.Username)
	}

	if DB != nil {
		// Completely wipe all associated records from DB
		_, _ = DB.Exec("DELETE FROM products WHERE username=$1", req.Username)
		_, _ = DB.Exec("DELETE FROM leads WHERE username=$1", req.Username)
		_, _ = DB.Exec("DELETE FROM customer_chats WHERE username=$1", req.Username)
		_, _ = DB.Exec("DELETE FROM users WHERE username=$1", req.Username)
	}
	respondJSON(w, 200, map[string]string{"status": "success", "message": "Account and all database records deleted successfully!"})
}

// 5. WHATSAPP STATUS & QR GENERATOR PER USER
func StatusHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	client := whatsapp.GetOrCreateClient(username)
	status := "Disconnected"
	jid := ""

	if client != nil && client.IsConnected() && client.IsLoggedIn() {
		status = "Connected"
		if client.Store.ID != nil {
			jid = client.Store.ID.User
		}
	} else if whatsapp.QRChannelMap[username] != "" {
		status = "QR_Ready"
	}

	endpoint := "https://" + r.Host + "/api/send"
	respondJSON(w, 200, map[string]string{
		"status":   status,
		"qr":       whatsapp.QRChannelMap[username],
		"jid":      jid,
		"endpoint": endpoint,
		"username": username,
	})
}

// 6. PHONE PAIRING CODE API
func PairPhoneHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = "admin"
	}

	client := whatsapp.GetOrCreateClient(req.Username)
	if client == nil {
		respondJSON(w, 503, map[string]string{
			"status":  "error",
			"message": "WhatsMeow client not initialized. Ensure database and WhatsApp store are connected.",
		})
		return
	}
	if client.IsLoggedIn() {
		respondJSON(w, 400, map[string]string{
			"status":  "error",
			"message": "WhatsApp device is already connected",
		})
		return
	}

	code, err := client.PairPhone(context.Background(), req.Phone, true, whatsmeow.PairClientChrome, "Chrome (Windows)")
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	respondJSON(w, 200, map[string]string{"code": code})
}

// 7. LOGOUT / UNPAIR WHATSAPP DEVICE
func LogoutWAHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	if req.Username == "" {
		req.Username = "admin"
	}

	if c, ok := whatsapp.ActiveClients[req.Username]; ok {
		_ = c.Logout(context.Background())
		c.Disconnect()
		if c.Store != nil {
			_ = c.Store.Delete(context.Background())
		}
		delete(whatsapp.ActiveClients, req.Username)
		delete(whatsapp.QRChannelMap, req.Username)
	}
	if DB != nil {
		_, _ = DB.Exec("UPDATE users SET wa_jid='', status='Disconnected', qr='' WHERE username=$1", req.Username)
	}
	respondJSON(w, 200, map[string]string{"status": "success", "message": "WhatsApp unlinked successfully. WhatsApp details cleared from database, user account preserved."})
}

// 8. SINGLE MESSAGE / IMAGE SEND (External API + Manual Live Chat Reply)
func SendHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
		Message  string `json:"message"`
		ImageURL string `json:"image_url"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = "admin"
	}

	client := whatsapp.GetOrCreateClient(req.Username)
	var err error
	if client != nil {
		if req.ImageURL != "" {
			err = whatsapp.SendImageFromURL(client, req.Phone, req.ImageURL, req.Message)
		} else {
			err = whatsapp.SendMessage(client, req.Phone, req.Message)
		}

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": err.Error()})
			return
		}
	}

	whatsapp.PushToLiveChat(req.Username, req.Phone, req.Message, "outgoing_manual")
	respondJSON(w, 200, map[string]string{"status": "success", "message": "Message Sent!"})
}

// 9. BULK CAMPAIGN SENDER (With Anti-Ban & Image Support)
func BulkSendHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username   string   `json:"username"`
		Phones     []string `json:"phones"`
		Message    string   `json:"message"`
		ImageURL   string   `json:"image_url"`
		UseAntiBan bool     `json:"use_anti_ban"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = "admin"
	}

	client := whatsapp.GetOrCreateClient(req.Username)
	if client != nil && !client.IsLoggedIn() {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "WhatsApp connected nahi hai!"})
		return
	}

	// Background goroutine
	go func() {
		if client != nil {
			results := whatsapp.SendBulkMessages(client, req.Phones, req.Message, req.ImageURL, req.UseAntiBan)
			for _, res := range results {
				p, _ := res["phone"].(string)
				st, _ := res["status"].(string)
				whatsapp.PushToLiveChat(req.Username, p, "[Bulk "+st+"] "+req.Message, "outgoing_manual")
			}
		} else {
			for _, p := range req.Phones {
				whatsapp.PushToLiveChat(req.Username, p, "[Bulk Sent] "+req.Message, "outgoing_manual")
			}
		}
	}()

	respondJSON(w, 200, map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Bulk campaign started for %d numbers in background!", len(req.Phones)),
	})
}

// 10. SAVE AI AUTO-REPLY SETTINGS
func SaveAISettingsHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username     string `json:"username"`
		AIProvider   string `json:"ai_provider"`
		APIKey       string `json:"api_key"`
		SystemPrompt string `json:"system_prompt"`
		AutoReply    bool   `json:"auto_reply"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if DB != nil {
		_, err := DB.Exec(`UPDATE users SET ai_provider=$1, api_key=$2, system_prompt=$3, auto_reply=$4 WHERE username=$5`,
			req.AIProvider, req.APIKey, req.SystemPrompt, req.AutoReply, req.Username)

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": err.Error()})
			return
		}
	}
	respondJSON(w, 200, map[string]string{"status": "success", "message": "AI Bot Settings Saved!"})
}

// 11. PRODUCT IMAGE CATALOG (Save & List Neon Bucket URLs)
func MediaCatalogHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Media upload deprecated"})
		return
	}

	respondJSON(w, 200, map[string]interface{}{"media": []interface{}{}})
}

// 12. ZERO-LOAD CLIENT-SIDE LIVE CHAT STREAM (Server-Sent Events)
func LiveChatSSEHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	msgChan := make(chan map[string]string, 20)
	whatsapp.StreamLock.Lock()
	whatsapp.LiveChatStreams[username] = msgChan
	whatsapp.StreamLock.Unlock()

	defer func() {
		whatsapp.StreamLock.Lock()
		delete(whatsapp.LiveChatStreams, username)
		whatsapp.StreamLock.Unlock()
	}()

	// Initial ping
	fmt.Fprintf(w, "data: {\"type\":\"system\",\"text\":\"Live Chat Stream Connected\"}\n\n")
	flusher.Flush()

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case msg := <-msgChan:
			bytes, _ := json.Marshal(msg)
			fmt.Fprintf(w, "data: %s\n\n", string(bytes))
			flusher.Flush()
		}
	}
}

// 13. NEON OBJECT DATABASE: UPLOAD BINARY MEDIA
func UploadNeonMediaHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Max 20MB upload limit to prevent memory bloat on Render 512MB RAM
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	err := r.ParseMultipartForm(20 << 20)
	if err != nil {
		respondJSON(w, 400, map[string]string{"error": "File size exceeds 20MB limit"})
		return
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		respondJSON(w, 400, map[string]string{"error": "Invalid file upload field 'image'"})
		return
	}
	defer file.Close()

	fileBytes, err := io.ReadAll(file)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Failed to read binary data"})
		return
	}

	username := r.FormValue("username")
	if username == "" {
		username = "admin"
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"status":   "success",
			"url":      "/api/storage/neon/file/1",
			"filename": header.Filename,
		})
		return
	}

	var newID int
	err = DB.QueryRow(`INSERT INTO neon_media_objects (username, filename, content_type, size_bytes, data)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username, header.Filename, contentType, int64(len(fileBytes)), fileBytes).Scan(&newID)

	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Neon DB object storage write error: " + err.Error()})
		return
	}

	fileURL := fmt.Sprintf("/api/storage/neon/file/%d", newID)
	respondJSON(w, 200, map[string]interface{}{
		"status":   "success",
		"id":       newID,
		"filename": header.Filename,
		"url":      fileURL,
		"size":     len(fileBytes),
	})
}

// 14. NEON OBJECT DATABASE: STREAM BINARY MEDIA
func ServeNeonMediaHandler(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) == 0 {
		http.NotFound(w, r)
		return
	}
	idStr := parts[len(parts)-1]
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	if DB == nil {
		http.NotFound(w, r)
		return
	}

	var filename, contentType string
	var sizeBytes int64
	var data []byte

	err = DB.QueryRow(`SELECT filename, content_type, size_bytes, data FROM neon_media_objects WHERE id=$1`, id).
		Scan(&filename, &contentType, &sizeBytes, &data)

	if err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(sizeBytes, 10))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// 15. PRODUCT CATALOG HANDLER (GET, POST, DELETE)
func ProductsHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	if r.Method == "GET" {
		if DB == nil {
			respondJSON(w, 200, map[string]interface{}{"products": []interface{}{}})
			return
		}

		rows, err := DB.Query(`SELECT id, name, price, description, ai_tag, COALESCE(item_type, 'product') 
			FROM products WHERE username=$1 ORDER BY id ASC`, username)
		if err != nil {
			respondJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close()

		var products []map[string]interface{}
		idx := 1
		for rows.Next() {
			var id int
			var name, price, desc, tag, itemType string
			rows.Scan(&id, &name, &price, &desc, &tag, &itemType)
			if tag == "" {
				tag = fmt.Sprintf("<ITEM_%d>", idx)
			}
			if itemType == "" {
				itemType = "product"
			}
			products = append(products, map[string]interface{}{
				"id":        id,
				"name":      name,
				"price":     price,
				"details":   desc,
				"tag":       tag,
				"item_type": itemType,
			})
			idx++
		}
		respondJSON(w, 200, map[string]interface{}{"products": products})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username    string `json:"username"`
			Name        string `json:"name"`
			Price       string `json:"price"`
			Description string `json:"description"`
			Details     string `json:"details"`
			ItemType    string `json:"item_type"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Username == "" {
			req.Username = username
		}
		if req.Description == "" && req.Details != "" {
			req.Description = req.Details
		}
		if req.ItemType == "" {
			req.ItemType = "product"
		}

		if req.Name == "" || req.Price == "" {
			respondJSON(w, 400, map[string]string{"error": "Name and Price are required"})
			return
		}

		if DB == nil {
			respondJSON(w, 200, map[string]interface{}{
				"status":  "success",
				"message": "Item saved!",
			})
			return
		}

		var count int
		_ = DB.QueryRow("SELECT COUNT(*) FROM products WHERE username=$1", req.Username).Scan(&count)
		aiTag := fmt.Sprintf("<ITEM_%d>", count+1)

		var newID int
		err := DB.QueryRow(`INSERT INTO products (username, name, price, description, ai_tag, item_type)
			VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			req.Username, req.Name, req.Price, req.Description, aiTag, req.ItemType).Scan(&newID)

		if err != nil {
			respondJSON(w, 500, map[string]string{"error": "Database error: " + err.Error()})
			return
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Item added to Neon DB Catalog!",
			"product": map[string]interface{}{
				"id":        newID,
				"name":      req.Name,
				"price":     req.Price,
				"details":   req.Description,
				"tag":       aiTag,
				"item_type": req.ItemType,
			},
		})
		return
	}

	if r.Method == "DELETE" {
		idStr := r.URL.Query().Get("id")
		if idStr == "" {
			respondJSON(w, 400, map[string]string{"error": "Missing product id"})
			return
		}
		if DB != nil {
			DB.Exec("DELETE FROM products WHERE id=$1 AND username=$2", idStr, username)
		}
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Product deleted"})
		return
	}
}

// 16. BUSINESS DASHBOARD STATS (ZERO FAKE DATA)
func BusinessDashboardHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"activeCampaigns":   0,
			"leadsGenerated":    0,
			"deliveredMessages": 0,
			"aiReplies":         0,
		})
		return
	}

	var activeCampaigns, leadsCount, deliveredCount int
	_ = DB.QueryRow("SELECT COUNT(*) FROM campaigns WHERE username=$1 AND status='active'", username).Scan(&activeCampaigns)
	_ = DB.QueryRow("SELECT COUNT(*) FROM leads WHERE username=$1", username).Scan(&leadsCount)
	_ = DB.QueryRow("SELECT COALESCE(SUM(sent_count), 0) FROM campaigns WHERE username=$1", username).Scan(&deliveredCount)

	respondJSON(w, 200, map[string]interface{}{
		"activeCampaigns":   activeCampaigns,
		"leadsGenerated":    leadsCount,
		"deliveredMessages": deliveredCount,
		"aiReplies":         0,
	})
}

// 17. LEADS HANDLER (REAL PROSPECTS FROM NEON DB)
func LeadsHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{"leads": []interface{}{}})
		return
	}

	rows, err := DB.Query(`SELECT id, customer_phone, inquiry_text, status, created_at 
		FROM leads WHERE username=$1 ORDER BY id DESC LIMIT 100`, username)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	var leads []map[string]interface{}
	for rows.Next() {
		var id int
		var phone, query, status, createdAt string
		rows.Scan(&id, &phone, &query, &status, &createdAt)
		leads = append(leads, map[string]interface{}{
			"id":        id,
			"phone":     phone,
			"query":     query,
			"status":    status,
			"timestamp": createdAt,
		})
	}

	respondJSON(w, 200, map[string]interface{}{"leads": leads})
}

// 18. USER CONFIG HANDLER (ZERO SECRETS RETURNED)
func UserConfigHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"username":     username,
			"role":         "user",
			"status":       "Ready",
			"qr":           "",
			"wa_jid":       "",
			"ai_provider":  "gemini",
			"system_prompt": "",
			"auto_reply":   true,
		})
		return
	}

	var role, userType, accountName, phone, waJid, status, qr, aiProvider, sysPrompt string
	var autoReply bool

	err := DB.QueryRow(`SELECT role, user_type, account_name, phone, wa_jid, status, qr, ai_provider, system_prompt, auto_reply 
		FROM users WHERE username=$1`, username).
		Scan(&role, &userType, &accountName, &phone, &waJid, &status, &qr, &aiProvider, &sysPrompt, &autoReply)

	if err != nil {
		respondJSON(w, 200, map[string]interface{}{
			"username":     username,
			"status":       "Ready",
			"qr":           "",
			"auto_reply":   true,
		})
		return
	}

	respondJSON(w, 200, map[string]interface{}{
		"username":      username,
		"role":          role,
		"user_type":     userType,
		"account_name":  accountName,
		"phone":         phone,
		"wa_jid":        waJid,
		"status":        status,
		"qr":            qr,
		"ai_provider":   aiProvider,
		"system_prompt": sysPrompt,
		"auto_reply":    autoReply,
	})
}

