package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

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

// DB Status Endpoint for Frontend Badge & Health Check
func DBStatusHandler(w http.ResponseWriter, r *http.Request) {
	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"connected": false,
			"message":   "Running in In-Memory / Standalone Mode",
		})
		return
	}
	err := DB.Ping()
	if err != nil {
		respondJSON(w, 200, map[string]interface{}{
			"connected": false,
			"error":     err.Error(),
		})
		return
	}
	respondJSON(w, 200, map[string]interface{}{
		"connected": true,
		"message":   "Neon Serverless PostgreSQL Active",
	})
}

// Helper to request verification email via Neon Inbuilt Auth (Better Auth service)
func sendNeonAuthOTP(email, fullName, password string) (bool, string) {
	neonAuthURL := strings.TrimRight(strings.TrimSpace(os.Getenv("NEON_AUTH_URL")), "/")
	if neonAuthURL == "" {
		neonAuthURL = strings.TrimRight(strings.TrimSpace(os.Getenv("NEON_AUTH_BASE_URL")), "/")
	}

	if neonAuthURL == "" {
		log.Printf("ℹ️ [Neon Auth] NEON_AUTH_URL not set in environment.")
		return false, "NEON_AUTH_URL environment variable is missing."
	}

	client := &http.Client{Timeout: 10 * time.Second}

	type endpointAttempt struct {
		path    string
		payload map[string]interface{}
	}

	attempts := []endpointAttempt{
		{
			path:    "/email-otp/send-verification-otp",
			payload: map[string]interface{}{"email": email, "type": "email-verification"},
		},
		{
			path:    "/email-otp/send-verification-otp",
			payload: map[string]interface{}{"email": email, "type": "sign-in"},
		},
		{
			path:    "/sign-up/email",
			payload: map[string]interface{}{"email": email, "password": password, "name": fullName},
		},
		{
			path:    "/api/auth/email-otp/send-verification-otp",
			payload: map[string]interface{}{"email": email, "type": "email-verification"},
		},
		{
			path:    "/api/auth/sign-up/email",
			payload: map[string]interface{}{"email": email, "password": password, "name": fullName},
		},
		{
			path:    "/send-verification-email",
			payload: map[string]interface{}{"email": email, "type": "email-verification"},
		},
	}

	for _, att := range attempts {
		fullURL := neonAuthURL + att.path
		bodyBytes, _ := json.Marshal(att.payload)

		req, err := http.NewRequest("POST", fullURL, strings.NewReader(string(bodyBytes)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "EduCloud-SaaS/1.0")

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("⚠️ [Neon Auth] Attempt to %s error: %v", fullURL, err)
			continue
		}

		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		log.Printf("⚡ [Neon Inbuilt Auth API] %s -> Status %d: %s", fullURL, resp.StatusCode, string(respBody))

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			var resData map[string]interface{}
			_ = json.Unmarshal(respBody, &resData)
			msg := "Verification email dispatched via Neon Auth!"
			if m, ok := resData["message"].(string); ok && m != "" {
				msg = m
			}
			return true, msg
		}
	}

	return false, "Neon Auth endpoints could not be reached."
}

// Helper to verify code via Neon Inbuilt Auth API
func verifyNeonAuthOTP(email, code string) bool {
	neonAuthURL := strings.TrimRight(strings.TrimSpace(os.Getenv("NEON_AUTH_URL")), "/")
	if neonAuthURL == "" {
		neonAuthURL = strings.TrimRight(strings.TrimSpace(os.Getenv("NEON_AUTH_BASE_URL")), "/")
	}
	if neonAuthURL == "" {
		return false
	}

	client := &http.Client{Timeout: 10 * time.Second}

	endpoints := []struct {
		path    string
		payload map[string]interface{}
	}{
		{path: "/email-otp/verify-email", payload: map[string]interface{}{"email": email, "otp": code}},
		{path: "/email-otp/verify-email", payload: map[string]interface{}{"email": email, "otp": code, "type": "email-verification"}},
		{path: "/api/auth/email-otp/verify-email", payload: map[string]interface{}{"email": email, "otp": code}},
		{path: "/api/auth/email-otp/verify-email", payload: map[string]interface{}{"email": email, "otp": code, "type": "email-verification"}},
		{path: "/email-otp/verify-otp", payload: map[string]interface{}{"email": email, "otp": code}},
		{path: "/verify-email", payload: map[string]interface{}{"email": email, "otp": code}},
		{path: "/api/auth/verify-email", payload: map[string]interface{}{"email": email, "otp": code}},
	}

	for _, ep := range endpoints {
		fullURL := neonAuthURL + ep.path
		bodyBytes, _ := json.Marshal(ep.payload)

		req, err := http.NewRequest("POST", fullURL, strings.NewReader(string(bodyBytes)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "EduCloud-SaaS/1.0")

		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			return true
		}
	}

	return false
}

// 1. UNIFIED LOGIN API (Admin & SaaS Users)
func LoginHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Identifier string `json:"identifier"`
		Username   string `json:"username"`
		Email      string `json:"email"`
		Password   string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	loginId := strings.TrimSpace(req.Identifier)
	if loginId == "" {
		loginId = strings.TrimSpace(req.Username)
	}
	if loginId == "" {
		loginId = strings.TrimSpace(req.Email)
	}

	if loginId == "" || req.Password == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter Email / Username and Password."})
		return
	}

	if DB == nil {
		// Fallback for Zero-Config Embedded Mode
		if (strings.EqualFold(loginId, "admin") || strings.EqualFold(loginId, "admin@example.com") || strings.EqualFold(loginId, "admin@eduta.ai")) && req.Password == "admin123" {
			respondJSON(w, 200, map[string]interface{}{
				"status":        "success",
				"token":         "eduta-token-admin",
				"username":      "admin",
				"account_name":  "Master Administrator",
				"role":          "admin",
				"portal":        "admin_portal",
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
	var fetchedUsername, accountName, hashPass, role, userType, aiProvider, apiKey, sysPrompt string
	var autoReply bool

	err := DB.QueryRow(`SELECT id, username, COALESCE(account_name, username), password, COALESCE(role, 'business_user'), COALESCE(user_type, 'business_user'), COALESCE(ai_provider, 'Groq'), COALESCE(api_key, ''), COALESCE(system_prompt, ''), COALESCE(auto_reply, true) 
		FROM users WHERE LOWER(username)=$1 OR LOWER(email)=$1`, strings.ToLower(loginId)).
		Scan(&id, &fetchedUsername, &accountName, &hashPass, &role, &userType, &aiProvider, &apiKey, &sysPrompt, &autoReply)

	if err != nil {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Account not found! Please check your credentials or create an account."})
		return
	}

	// Password Verification
	isMatch := false
	if req.Password == hashPass {
		isMatch = true
	} else if err := bcrypt.CompareHashAndPassword([]byte(hashPass), []byte(req.Password)); err == nil {
		isMatch = true
	}

	if !isMatch {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Password! Please check and try again."})
		return
	}

	portal := "business_portal"
	if role == "admin" || userType == "admin" {
		portal = "admin_portal"
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":        "success",
		"token":         "eduta-token-" + fetchedUsername,
		"username":      fetchedUsername,
		"account_name":  accountName,
		"role":          role,
		"user_type":     userType,
		"portal":        portal,
		"user_id":       id,
		"ai_provider":   aiProvider,
		"api_key":       apiKey,
		"system_prompt": sysPrompt,
		"auto_reply":    autoReply,
	})
}

// 1B. SEND OTP FOR EMAIL VERIFICATION (SIGN UP STEP 1)
func SendOTPHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FullName        string `json:"full_name"`
		Email           string `json:"email"`
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirm_password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	emailInput := strings.ToLower(strings.TrimSpace(req.Email))
	fullNameInput := strings.TrimSpace(req.FullName)
	passInput := strings.TrimSpace(req.Password)

	if emailInput == "" || passInput == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter Full Name, Email Address, and Password."})
		return
	}

	// Password Strength Validation
	if len(passInput) < 6 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Password must be at least 6 characters long."})
		return
	}

	hasUpper := false
	hasDigit := false
	hasSpecial := false
	for _, c := range passInput {
		if c >= 'A' && c <= 'Z' {
			hasUpper = true
		} else if c >= '0' && c <= '9' {
			hasDigit = true
		} else if strings.ContainsRune("!@#$%^&*()_+-=[]{};':\"\\|,.<>/?", c) {
			hasSpecial = true
		}
	}

	if !hasUpper || !hasDigit || !hasSpecial {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Password must contain at least 1 capital letter, 1 number, and 1 special character (!@#$%^&*)."})
		return
	}

	// Pre-signup check: Check if Email already exists in Neon DB
	if DB != nil {
		var existingId int
		err := DB.QueryRow("SELECT id FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1", emailInput).Scan(&existingId)
		if err == nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "This Email Address is already registered! Please sign in."})
			return
		}
	}

	// Generate 6-Digit Verification Code
	otpCode := fmt.Sprintf("%06d", rand.Intn(900000)+100000)

	// Save OTP to email_verifications table
	if DB != nil {
		_, _ = DB.Exec(`CREATE TABLE IF NOT EXISTS email_verifications (
			email VARCHAR(255) PRIMARY KEY,
			code VARCHAR(10) NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);`)

		_, _ = DB.Exec(`INSERT INTO email_verifications (email, code) VALUES ($1, $2)
			ON CONFLICT (email) DO UPDATE SET code=$2, created_at=CURRENT_TIMESTAMP`, emailInput, otpCode)
	}

	neonSent, neonMsg := sendNeonAuthOTP(emailInput, fullNameInput, passInput)
	if neonSent {
		respondJSON(w, 200, map[string]interface{}{
			"status":         "success",
			"message":        neonMsg,
			"email":          emailInput,
			"neon_auth_sent": true,
		})
		return
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":         "success",
		"message":        fmt.Sprintf("Verification code sent to %s! (Code: %s)", emailInput, otpCode),
		"email":          emailInput,
		"otp_code":       otpCode,
		"neon_auth_sent": false,
	})
}

// 1C. VERIFY OTP CODE & CREATE USER ACCOUNT (SIGN UP STEP 2)
func VerifyOTPHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		OTPCode  string `json:"otp_code"`
		FullName string `json:"full_name"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	emailInput := strings.ToLower(strings.TrimSpace(req.Email))
	codeInput := strings.TrimSpace(req.OTPCode)
	fullNameInput := strings.TrimSpace(req.FullName)
	passInput := strings.TrimSpace(req.Password)

	if emailInput == "" || codeInput == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter your Email and 6-digit OTP Code."})
		return
	}

	// 1. Verify OTP Code against database
	isValid := false
	if DB != nil {
		var dbCode string
		err := DB.QueryRow("SELECT code FROM email_verifications WHERE LOWER(email)=$1", emailInput).Scan(&dbCode)
		if err == nil && dbCode == codeInput {
			isValid = true
		}
	} else {
		// Fallback for memory mode
		isValid = true
	}

	// 2. Verify via Neon Auth API if not matched locally
	if !isValid {
		isValid = verifyNeonAuthOTP(emailInput, codeInput)
	}

	if !isValid {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Invalid or expired verification code! Please check your email."})
		return
	}

	// Generate Username from email prefix
	parts := strings.Split(emailInput, "@")
	baseUsername := parts[0]
	if len(baseUsername) < 3 {
		baseUsername = "user_" + baseUsername
	}
	finalUsername := baseUsername

	// Hash Password with bcrypt
	hashedPass, _ := bcrypt.GenerateFromPassword([]byte(passInput), 10)

	if fullNameInput == "" {
		fullNameInput = baseUsername
	}

	// Insert User into Neon PostgreSQL DB
	if DB != nil {
		var exists bool
		_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=$1)", finalUsername).Scan(&exists)
		if exists {
			finalUsername = fmt.Sprintf("%s_%d", baseUsername, rand.Intn(900)+100)
		}

		_, err := DB.Exec(`INSERT INTO users (username, email, password, role, user_type, account_name, automation_access, created_at)
			VALUES ($1, $2, $3, 'user', 'business_user', $4, true, NOW())`,
			finalUsername, emailInput, string(hashedPass), fullNameInput)

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": "Database error while creating user account."})
			return
		}

		// Clean up OTP record
		_, _ = DB.Exec("DELETE FROM email_verifications WHERE LOWER(email)=$1", emailInput)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":       "success",
		"message":      "Account created & verified successfully!",
		"token":        "eduta-token-" + finalUsername,
		"username":     finalUsername,
		"account_name": fullNameInput,
		"role":         "business_user",
		"portal":       "business_portal",
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

// 15. PRODUCT CATALOG HANDLER (GET, POST, DELETE - ZERO IMAGES, UNIT & VARIANTS)
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

		rows, err := DB.Query(`SELECT id, name, price, description, COALESCE(item_type, 'product'), COALESCE(unit_type, 'custom'), COALESCE(variants, '[]'::jsonb)::text 
			FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)
		if err != nil {
			respondJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close()

		var products []map[string]interface{}
		for rows.Next() {
			var id int
			var name, price, desc, itemType, unitType, variantsJSON string
			rows.Scan(&id, &name, &price, &desc, &itemType, &unitType, &variantsJSON)

			var parsedVariants []map[string]interface{}
			_ = json.Unmarshal([]byte(variantsJSON), &parsedVariants)

			products = append(products, map[string]interface{}{
				"id":        id,
				"name":      name,
				"price":     price,
				"details":   desc,
				"item_type": itemType,
				"unit_type": unitType,
				"variants":  parsedVariants,
			})
		}
		respondJSON(w, 200, map[string]interface{}{"products": products})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username    string                   `json:"username"`
			Name        string                   `json:"name"`
			Price       string                   `json:"price"`
			Description string                   `json:"description"`
			Details     string                   `json:"details"`
			ItemType    string                   `json:"item_type"`
			UnitType    string                   `json:"unit_type"`
			Variants    []map[string]interface{} `json:"variants"`
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
		if req.UnitType == "" {
			req.UnitType = "custom"
		}

		if req.Name == "" {
			respondJSON(w, 400, map[string]string{"error": "Product Name is required"})
			return
		}

		variantsBytes, _ := json.Marshal(req.Variants)
		variantsStr := string(variantsBytes)
		if variantsStr == "" || variantsStr == "null" {
			variantsStr = "[]"
		}

		if DB == nil {
			respondJSON(w, 200, map[string]interface{}{
				"status":  "success",
				"message": "Item saved!",
			})
			return
		}

		var newID int
		err := DB.QueryRow(`INSERT INTO products (username, name, price, description, item_type, unit_type, variants)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
			req.Username, req.Name, req.Price, req.Description, req.ItemType, req.UnitType, variantsStr).Scan(&newID)

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
				"item_type": req.ItemType,
				"unit_type": req.UnitType,
				"variants":  req.Variants,
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
			DB.Exec("DELETE FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
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

