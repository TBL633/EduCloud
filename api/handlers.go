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
	"regexp"
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

func cleanUsername(u string) string {
	u = strings.TrimSpace(u)
	u = strings.TrimPrefix(u, "@")
	return u
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

	cleanId := cleanUsername(loginId)

	if loginId == "" || req.Password == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter Email / Username and Password."})
		return
	}

	if DB == nil {
		// Fallback for Zero-Config Embedded Mode
		if (strings.EqualFold(cleanId, "admin") || strings.EqualFold(loginId, "admin@example.com") || strings.EqualFold(loginId, "admin@eduta.ai")) && req.Password == "admin123" {
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
		FROM users WHERE LOWER(username)=$1 OR LOWER(email)=$2`, strings.ToLower(cleanId), strings.ToLower(loginId)).
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
		Email       string `json:"email"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		AccountName string `json:"account_name"`
		UserType    string `json:"user_type"`
		Role        string `json:"role"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" && req.Email != "" {
		req.Username = strings.Split(req.Email, "@")[0]
	}

	if req.Username == "" || req.Password == "" {
		respondJSON(w, 400, map[string]string{"error": "Username/Email and Password are required!"})
		return
	}

	if req.UserType == "" {
		req.UserType = "business_user"
	}
	if req.Role == "" {
		req.Role = "user"
	}
	if req.AccountName == "" {
		req.AccountName = req.Username
	}

	if DB == nil {
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Account Created (In-Memory)!"})
		return
	}

	// Ensure unique username if already exists
	finalUsername := req.Username
	var exists bool
	_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=$1)", finalUsername).Scan(&exists)
	if exists {
		finalUsername = fmt.Sprintf("%s_%d", req.Username, rand.Intn(900)+100)
	}

	hashedPass, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 10)
	_, err := DB.Exec(`INSERT INTO users (username, email, password, role, user_type, account_name, automation_access, auto_reply, created_at) 
		VALUES ($1, $2, $3, $4, $5, $6, true, true, NOW())`,
		finalUsername, req.Email, string(hashedPass), req.Role, req.UserType, req.AccountName)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Database error creating tenant: " + err.Error()})
		return
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":   "success",
		"message":  "Tenant Account Created Successfully!",
		"username": finalUsername,
	})
}

// 3. ADMIN: LIST ALL ACCOUNTS
func ListUsersHandler(w http.ResponseWriter, r *http.Request) {
	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"users": []map[string]interface{}{
				{"id": 1, "username": "admin", "email": "admin@eduta.ai", "account_name": "Admin", "role": "admin", "user_type": "admin", "wa_jid": "", "auto_reply": false, "automation_access": true, "status": "Disconnected"},
			},
		})
		return
	}

	rows, err := DB.Query(`SELECT id, username, COALESCE(email, ''), COALESCE(account_name, username), COALESCE(role, 'user'), 
		COALESCE(user_type, 'business_user'), COALESCE(phone, ''), COALESCE(wa_jid, ''), 
		COALESCE(automation_access, true), COALESCE(auto_reply, true), COALESCE(status, 'Disconnected') 
		FROM users ORDER BY id ASC`)
	if err != nil {
		log.Printf("⚠️ ListUsersHandler query error: %v", err)
		respondJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	var users []map[string]interface{}
	for rows.Next() {
		var id int
		var u, email, accName, role, userType, phone, jid, status string
		var autoAccess, autoReply bool
		scanErr := rows.Scan(&id, &u, &email, &accName, &role, &userType, &phone, &jid, &autoAccess, &autoReply, &status)
		if scanErr != nil {
			log.Printf("⚠️ ListUsersHandler scan error: %v", scanErr)
			continue
		}

		connStatus := status
		if c, ok := whatsapp.ActiveClients[u]; ok && c.IsConnected() && c.IsLoggedIn() {
			connStatus = "Connected"
		}

		users = append(users, map[string]interface{}{
			"id":                id,
			"username":          u,
			"email":             email,
			"account_name":      accName,
			"role":              role,
			"user_type":         userType,
			"phone":             phone,
			"wa_jid":            jid,
			"automation_access": autoAccess,
			"auto_reply":        autoReply,
			"status":            connStatus,
		})
	}
	respondJSON(w, 200, map[string]interface{}{"users": users})
}

// 3B. ADMIN DASHBOARD OVERVIEW METRICS
func AdminDashboardHandler(w http.ResponseWriter, r *http.Request) {
	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"metrics": map[string]interface{}{
				"totalUsers":     1,
				"connectedUsers": 0,
			},
		})
		return
	}

	var totalUsers, connectedUsers int
	_ = DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&totalUsers)
	_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE status='Connected' OR (wa_jid != '' AND wa_jid IS NOT NULL)").Scan(&connectedUsers)

	respondJSON(w, 200, map[string]interface{}{
		"metrics": map[string]interface{}{
			"totalUsers":     totalUsers,
			"connectedUsers": connectedUsers,
		},
	})
}

// 3C. ADMIN: TOGGLE USER AUTOMATION ACCESS
func ToggleAutomationHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		respondJSON(w, 400, map[string]string{"error": "Username required"})
		return
	}

	if DB != nil {
		_, _ = DB.Exec(`UPDATE users SET automation_access = NOT COALESCE(automation_access, true) WHERE LOWER(username)=LOWER($1)`, req.Username)
	}

	respondJSON(w, 200, map[string]string{"status": "success", "message": "Automation access toggled"})
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
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	client := whatsapp.GetOrCreateClient(username)
	status := "Disconnected"
	jid := ""

	if client != nil && client.IsLoggedIn() {
		status = "Connected"
		if client.Store.ID != nil {
			jid = client.Store.ID.User
		}
	} else {
		// Not logged in: provide QR code
		qrCode := whatsapp.QRChannelMap[username]
		if qrCode == "" {
			qrCode = whatsapp.GetOrGenerateQR(username)
		}
		if qrCode != "" {
			status = "QR_Ready"
		}
	}

	// Only fallback to DB if client has a persistent device store ID
	if status == "Disconnected" && client != nil && client.Store.ID != nil && DB != nil {
		var savedJID, savedStatus string
		_ = DB.QueryRow("SELECT COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&savedJID, &savedStatus)
		if savedJID != "" && savedStatus == "Connected" {
			status = "Connected"
			jid = savedJID
		}
	}

	qrCode := whatsapp.QRChannelMap[username]
	endpoint := "https://" + r.Host + "/api/send"
	respondJSON(w, 200, map[string]interface{}{
		"status":    status,
		"qr":        qrCode,
		"jid":       jid,
		"connected": status == "Connected",
		"endpoint":  endpoint,
		"username":  username,
	})
}

// 6. PHONE PAIRING CODE API (8-DIGIT PAIRING CODE)
func PairPhoneHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	req.Username = cleanUsername(req.Username)
	if req.Username == "" {
		req.Username = "admin"
	}

	cleanPhone := whatsapp.FormatPhone(req.Phone)
	if cleanPhone == "" {
		respondJSON(w, 400, map[string]string{
			"status":  "error",
			"message": "Phone number is required",
		})
		return
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

	// Ensure client is connected to WhatsApp WebSocket before calling PairPhone
	if !client.IsConnected() {
		_ = client.Connect()
		for i := 0; i < 25; i++ {
			if client.IsConnected() {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	code, err := client.PairPhone(context.Background(), cleanPhone, true, whatsmeow.PairClientChrome, "Chrome (Windows)")
	if err != nil {
		log.Printf("⚠️ [Pair Error for %s]: %v", req.Username, err)
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to generate pairing code: " + err.Error()})
		return
	}
	respondJSON(w, 200, map[string]interface{}{
		"status":  "success",
		"code":    code,
		"phone":   cleanPhone,
		"message": "Pairing code generated! Enter this code in WhatsApp -> Linked Devices -> Link with phone number.",
	})
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

// 9. BULK CAMPAIGN SENDER (Handles /api/bulk and /api/bulk/send)
func BulkSendHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var rawBody map[string]interface{}
	bodyBytes, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(bodyBytes, &rawBody)

	username, _ := rawBody["username"].(string)
	if username == "" {
		username = r.URL.Query().Get("username")
	}
	username = cleanUsername(username)
	if username == "" {
		username = "admin"
	}

	message, _ := rawBody["message"].(string)
	imageURL, _ := rawBody["image_url"].(string)
	useAntiBan := true
	if ab, ok := rawBody["anti_ban"].(bool); ok {
		useAntiBan = ab
	} else if ab, ok := rawBody["use_anti_ban"].(bool); ok {
		useAntiBan = ab
	}

	// Extract phones from rawBody["phones"] which could be string or array
	var phoneList []string
	if phoneStr, ok := rawBody["phones"].(string); ok {
		re := regexp.MustCompile(`[\r\n,;]+`)
		tokens := re.Split(phoneStr, -1)
		for _, t := range tokens {
			clean := whatsapp.FormatPhone(t)
			if len(clean) >= 8 {
				phoneList = append(phoneList, clean)
			}
		}
	} else if phoneArr, ok := rawBody["phones"].([]interface{}); ok {
		for _, item := range phoneArr {
			if s, ok := item.(string); ok {
				clean := whatsapp.FormatPhone(s)
				if len(clean) >= 8 {
					phoneList = append(phoneList, clean)
				}
			}
		}
	}

	if len(phoneList) == 0 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "No valid recipient phone numbers provided!"})
		return
	}

	client := whatsapp.GetOrCreateClient(username)
	if client == nil || !client.IsLoggedIn() {
		respondJSON(w, 400, map[string]string{
			"status":  "error",
			"message": "WhatsApp device is not linked for @" + username + ". Please scan the QR code or pair via 8-digit code first.",
		})
		return
	}

	campaignID := fmt.Sprintf("camp_%s_%d", username, time.Now().Unix())
	if DB != nil {
		_, _ = DB.Exec(`INSERT INTO campaigns (id, username, message, image_url, use_anti_ban, status, total_count, sent_count, failed_count, start_time)
			VALUES ($1, $2, $3, $4, $5, 'running', $6, 0, 0, NOW())`,
			campaignID, username, message, imageURL, useAntiBan, len(phoneList))
	}

	// Dispatch in background goroutine
	go func() {
		sentCount := 0
		failedCount := 0
		for idx, p := range phoneList {
			if useAntiBan && idx > 0 {
				delay := time.Duration(rand.Intn(5)+4) * time.Second
				time.Sleep(delay)
			}
			var sendErr error
			if imageURL != "" {
				sendErr = whatsapp.SendImageFromURL(client, p, imageURL, message)
			} else {
				sendErr = whatsapp.SendMessage(client, p, message)
			}
			st := "sent"
			if sendErr != nil {
				st = "failed"
				failedCount++
			} else {
				sentCount++
			}
			if DB != nil {
				_, _ = DB.Exec(`INSERT INTO campaign_logs (campaign_id, phone, status, note, created_at) VALUES ($1, $2, $3, $4, NOW())`,
					campaignID, p, st, message)
			}
			whatsapp.PushToLiveChat(username, p, fmt.Sprintf("[Bulk %s] %s", st, message), "outgoing_manual")
		}
		if DB != nil {
			_, _ = DB.Exec(`UPDATE campaigns SET status='completed', sent_count=$1, failed_count=$2, end_time=NOW() WHERE id=$3`,
				sentCount, failedCount, campaignID)
		}
	}()

	respondJSON(w, 200, map[string]interface{}{
		"status":      "success",
		"message":     fmt.Sprintf("Bulk campaign launched for %d contacts in background!", len(phoneList)),
		"campaign_id": campaignID,
		"count":       len(phoneList),
	})
}

// 9B. BULK CAMPAIGN LOGS & STATUS (GET /api/bulk/status)
func BulkStatusHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	var logs []map[string]interface{}
	if DB != nil {
		rows, err := DB.Query(`SELECT l.phone, l.status, COALESCE(TO_CHAR(l.created_at, 'HH24:MI:SS'), 'Just now')
			FROM campaign_logs l
			JOIN campaigns c ON l.campaign_id = c.id
			WHERE LOWER(c.username)=LOWER($1)
			ORDER BY l.id DESC LIMIT 50`, username)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var phone, status, ts string
				if err := rows.Scan(&phone, &status, &ts); err == nil {
					logs = append(logs, map[string]interface{}{
						"phone":     phone,
						"status":    status,
						"timestamp": ts,
					})
				}
			}
		}
	}
	respondJSON(w, 200, map[string]interface{}{
		"status":      "success",
		"recent_logs": logs,
		"campaign":    map[string]interface{}{"logs": logs},
	})
}

// 10. AI SETTINGS HANDLER (GET & POST /api/ai/settings)
func AISettingsHandler(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "admin"
	}

	if r.Method == "GET" {
		if DB == nil {
			respondJSON(w, 200, map[string]interface{}{
				"platform":           "Groq",
				"model":              "llama-3.3-70b-versatile",
				"temperature":        0.7,
				"api_key":            "",
				"system_prompt":      "You are a helpful WhatsApp AI assistant for our business.",
				"notification_phone": "",
				"auto_reply":         true,
			})
			return
		}

		var provider, model, apiKey, prompt, notifPhone string
		var temp float64
		var autoReply bool

		err := DB.QueryRow(`SELECT COALESCE(ai_provider, 'Groq'), COALESCE(ai_model, 'llama-3.3-70b-versatile'),
			COALESCE(ai_temperature, 0.7), COALESCE(api_key, ''), COALESCE(system_prompt, ''),
			COALESCE(notification_phone, ''), COALESCE(auto_reply, true)
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&provider, &model, &temp, &apiKey, &prompt, &notifPhone, &autoReply)

		if err != nil {
			respondJSON(w, 200, map[string]interface{}{
				"platform":           "Groq",
				"model":              "llama-3.3-70b-versatile",
				"temperature":        0.7,
				"api_key":            "",
				"system_prompt":      "You are a helpful WhatsApp AI assistant.",
				"notification_phone": "",
				"auto_reply":         true,
			})
			return
		}

		respondJSON(w, 200, map[string]interface{}{
			"platform":           provider,
			"ai_provider":        provider,
			"model":              model,
			"ai_model":           model,
			"temperature":        temp,
			"ai_temperature":    temp,
			"api_key":            apiKey,
			"system_prompt":      prompt,
			"notification_phone": notifPhone,
			"auto_reply":         autoReply,
		})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username          string   `json:"username"`
			Platform          string   `json:"platform"`
			AIProvider        string   `json:"ai_provider"`
			Model             string   `json:"model"`
			AIModel           string   `json:"ai_model"`
			Temperature       *float64 `json:"temperature"`
			AITemperature     *float64 `json:"ai_temperature"`
			APIKey            string   `json:"api_key"`
			SystemPrompt      string   `json:"system_prompt"`
			NotificationPhone string   `json:"notification_phone"`
			AutoReply         *bool    `json:"auto_reply"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		targetUser := req.Username
		if targetUser == "" {
			targetUser = username
		}

		prov := req.Platform
		if prov == "" {
			prov = req.AIProvider
		}
		if prov == "" {
			prov = "Groq"
		}

		mdl := req.Model
		if mdl == "" {
			mdl = req.AIModel
		}
		if mdl == "" {
			mdl = "llama-3.3-70b-versatile"
		}

		tempVal := 0.7
		if req.Temperature != nil {
			tempVal = *req.Temperature
		} else if req.AITemperature != nil {
			tempVal = *req.AITemperature
		}

		autoReplyVal := true
		if req.AutoReply != nil {
			autoReplyVal = *req.AutoReply
		}

		if DB != nil {
			_, err := DB.Exec(`UPDATE users SET ai_provider=$1, ai_model=$2, ai_temperature=$3, api_key=$4, system_prompt=$5, notification_phone=$6, auto_reply=$7 WHERE LOWER(username)=LOWER($8)`,
				prov, mdl, tempVal, req.APIKey, req.SystemPrompt, req.NotificationPhone, autoReplyVal, targetUser)
			if err != nil {
				respondJSON(w, 500, map[string]string{"error": "Database error saving AI settings: " + err.Error()})
				return
			}
		}

		respondJSON(w, 200, map[string]string{
			"status":  "success",
			"message": "AI Lead Responder configuration saved successfully in Neon DB!",
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// 10B. AI TEST SIMULATION HANDLER (POST /api/ai/test)
func AITestHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username     string   `json:"username"`
		Query        string   `json:"query"`
		Prompt       string   `json:"prompt"`
		Platform     string   `json:"platform"`
		AIProvider   string   `json:"ai_provider"`
		Model        string   `json:"model"`
		Temperature  *float64 `json:"temperature"`
		APIKey       string   `json:"api_key"`
		SystemPrompt string   `json:"system_prompt"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	userQuery := strings.TrimSpace(req.Query)
	if userQuery == "" {
		userQuery = strings.TrimSpace(req.Prompt)
	}
	if userQuery == "" {
		respondJSON(w, 400, map[string]string{"error": "Please provide a customer question to test."})
		return
	}

	username := cleanUsername(req.Username)
	if username == "" {
		username = "admin"
	}

	provider := req.Platform
	if provider == "" {
		provider = req.AIProvider
	}
	model := req.Model
	apiKey := strings.TrimSpace(req.APIKey)
	sysPrompt := req.SystemPrompt
	tempVal := 0.7
	if req.Temperature != nil {
		tempVal = *req.Temperature
	}

	// Fallback to DB if apiKey or settings not passed from form
	if (apiKey == "" || provider == "") && DB != nil {
		var dbProv, dbModel, dbKey, dbPrompt string
		var dbTemp float64
		_ = DB.QueryRow("SELECT COALESCE(ai_provider, 'Groq'), COALESCE(ai_model, 'llama-3.3-70b-versatile'), COALESCE(ai_temperature, 0.7), COALESCE(api_key, ''), COALESCE(system_prompt, '') FROM users WHERE LOWER(username)=LOWER($1)", username).
			Scan(&dbProv, &dbModel, &dbTemp, &dbKey, &dbPrompt)
		if provider == "" {
			provider = dbProv
		}
		if model == "" {
			model = dbModel
		}
		if apiKey == "" {
			apiKey = dbKey
		}
		if sysPrompt == "" {
			sysPrompt = dbPrompt
		}
		if req.Temperature == nil {
			tempVal = dbTemp
		}
	}

	if apiKey == "" {
		respondJSON(w, 400, map[string]string{
			"error": "No API key configured! Please enter your " + provider + " API key above and click Save Configuration.",
		})
		return
	}

	// Inject Live Catalog & Knowledge base into prompt
	catalogContext := whatsapp.GetCatalogContext(username)
	fullSystemPrompt := sysPrompt + catalogContext + "\n\nYou are answering an inbound WhatsApp customer inquiry. Format pricing in rupees (₹), keep answers concise, helpful, and professional."

	reply, err := whatsapp.CallAIModel(provider, model, tempVal, apiKey, fullSystemPrompt, userQuery)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "AI Provider Error: " + err.Error()})
		return
	}

	// Check if reply references an image tag <IMG_N> or [IMAGE: url]
	imageURL := ""
	reTag := regexp.MustCompile(`<IMG_\d+>`)
	matchTag := reTag.FindString(reply)
	if matchTag != "" && DB != nil {
		var imgUrl, imgData string
		_ = DB.QueryRow("SELECT COALESCE(image_url, ''), COALESCE(image_data, '') FROM products WHERE LOWER(username)=LOWER($1) AND ai_tag=$2 LIMIT 1", username, matchTag).Scan(&imgUrl, &imgData)
		if imgUrl != "" {
			imageURL = imgUrl
		} else if imgData != "" {
			imageURL = imgData
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":      "success",
		"reply":       reply,
		"image_url":   imageURL,
		"model_used":  model,
		"provider":    provider,
		"catalog_fed": catalogContext != "",
	})
}

// 10C. USER PROFILE HANDLER (GET /api/user/profile)
func UserProfileHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"username":     username,
			"account_name": username + " Workspace",
			"email":        username + "@eduta.ai",
			"phone":        "",
			"role":         "business_user",
			"user_type":    "business_user",
			"status":       "Disconnected",
			"ai_provider":  "gemini",
			"ai_model":     "gemini-1.5-flash",
			"created_at":   time.Now().Format("02 Jan 2006"),
		})
		return
	}

	var id int
	var u, email, accName, role, userType, phone, jid, aiProvider, aiModel, status, createdAt string
	var autoReply, autoAccess bool

	err := DB.QueryRow(`SELECT id, username, COALESCE(email, ''), COALESCE(account_name, username),
		COALESCE(role, 'business_user'), COALESCE(user_type, 'business_user'), COALESCE(phone, ''),
		COALESCE(wa_jid, ''), COALESCE(ai_provider, 'gemini'), COALESCE(ai_model, 'gemini-1.5-flash'),
		COALESCE(auto_reply, true), COALESCE(automation_access, true), COALESCE(status, 'Disconnected'),
		COALESCE(TO_CHAR(created_at, 'DD Mon YYYY'), 'Active')
		FROM users WHERE LOWER(username)=LOWER($1)`, username).
		Scan(&id, &u, &email, &accName, &role, &userType, &phone, &jid, &aiProvider, &aiModel, &autoReply, &autoAccess, &status, &createdAt)

	if err != nil {
		respondJSON(w, 404, map[string]string{"error": "User profile not found"})
		return
	}

	// Check live connection state
	if c, ok := whatsapp.ActiveClients[u]; ok && c.IsConnected() && c.IsLoggedIn() {
		status = "Connected"
	}

	respondJSON(w, 200, map[string]interface{}{
		"id":                id,
		"username":          u,
		"account_name":      accName,
		"email":             email,
		"phone":             phone,
		"wa_jid":            jid,
		"role":              role,
		"user_type":         userType,
		"status":            status,
		"wa_status":         status,
		"ai_provider":       aiProvider,
		"ai_model":          aiModel,
		"auto_reply":        autoReply,
		"automation_access": autoAccess,
		"created_at":        createdAt,
	})
}

// 10D. VERIFY CURRENT PASSWORD HANDLER (POST /api/user/verify-password)
func VerifyPasswordHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"current_password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" || req.CurrentPassword == "" {
		respondJSON(w, 400, map[string]string{"error": "Username and current password required"})
		return
	}

	if DB == nil {
		if req.CurrentPassword == "admin123" {
			respondJSON(w, 200, map[string]interface{}{"status": "success", "valid": true, "message": "Password verified"})
			return
		}
		respondJSON(w, 401, map[string]string{"error": "Incorrect password"})
		return
	}

	var hashedPass string
	err := DB.QueryRow("SELECT password FROM users WHERE LOWER(username)=LOWER($1)", req.Username).Scan(&hashedPass)
	if err != nil {
		respondJSON(w, 404, map[string]string{"error": "User not found"})
		return
	}

	match := (req.CurrentPassword == hashedPass) || (bcrypt.CompareHashAndPassword([]byte(hashedPass), []byte(req.CurrentPassword)) == nil)
	if !match {
		respondJSON(w, 401, map[string]string{"error": "Current password does not match records"})
		return
	}

	respondJSON(w, 200, map[string]interface{}{"status": "success", "valid": true, "message": "Current password confirmed!"})
}

// 10E. UPDATE PASSWORD HANDLER (POST /api/user/update-password)
func UpdatePasswordHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" || req.NewPassword == "" {
		respondJSON(w, 400, map[string]string{"error": "Username and new password are required"})
		return
	}
	if len(req.NewPassword) < 6 {
		respondJSON(w, 400, map[string]string{"error": "New password must be at least 6 characters"})
		return
	}

	if DB == nil {
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Password updated successfully!"})
		return
	}

	// Verify current password if provided
	if req.CurrentPassword != "" {
		var hashedPass string
		err := DB.QueryRow("SELECT password FROM users WHERE LOWER(username)=LOWER($1)", req.Username).Scan(&hashedPass)
		if err == nil {
			match := (req.CurrentPassword == hashedPass) || (bcrypt.CompareHashAndPassword([]byte(hashedPass), []byte(req.CurrentPassword)) == nil)
			if !match {
				respondJSON(w, 401, map[string]string{"error": "Current password is incorrect"})
				return
			}
		}
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 10)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Encryption error"})
		return
	}

	_, err = DB.Exec("UPDATE users SET password=$1 WHERE LOWER(username)=LOWER($2)", string(newHash), req.Username)
	if err != nil {
		respondJSON(w, 500, map[string]string{"error": "Database error updating password: " + err.Error()})
		return
	}

	respondJSON(w, 200, map[string]string{"status": "success", "message": "Account password updated successfully!"})
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

// 15. PRODUCT CATALOG HANDLER (GET, POST, DELETE - WITH AUTO-TAGS <IMG_N> & IMAGE STORAGE)
func ProductsHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	if r.Method == "GET" {
		if DB == nil {
			respondJSON(w, 200, map[string]interface{}{"products": []interface{}{}})
			return
		}

		rows, err := DB.Query(`SELECT id, 
			COALESCE(name, ''), 
			COALESCE(price, ''), 
			COALESCE(description, ''), 
			COALESCE(item_type, 'product'), 
			COALESCE(unit_type, 'custom'), 
			COALESCE(variants::text, '[]'),
			COALESCE(ai_tag, ''),
			COALESCE(image_url, ''),
			COALESCE(image_data, '')
			FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)
		if err != nil {
			// Fallback without image columns if legacy table
			rows, err = DB.Query(`SELECT id, 
				COALESCE(name, ''), 
				COALESCE(price, ''), 
				COALESCE(description, ''), 
				COALESCE(item_type, 'product'), 
				COALESCE(unit_type, 'custom'), 
				COALESCE(variants::text, '[]'),
				COALESCE(ai_tag, ''),
				''::text, ''::text
				FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)
			if err != nil {
				log.Printf("⚠️ ProductsHandler GET query error for @%s: %v", username, err)
				respondJSON(w, 200, map[string]interface{}{"products": []interface{}{}})
				return
			}
		}
		defer rows.Close()

		var products []map[string]interface{}
		for rows.Next() {
			var id int
			var name, price, desc, itemType, unitType, variantsJSON, aiTag, imgUrl, imgData string
			if err := rows.Scan(&id, &name, &price, &desc, &itemType, &unitType, &variantsJSON, &aiTag, &imgUrl, &imgData); err == nil {
				var parsedVariants []map[string]interface{}
				_ = json.Unmarshal([]byte(variantsJSON), &parsedVariants)

				displayImg := imgUrl
				if displayImg == "" && imgData != "" {
					displayImg = imgData
				}

				products = append(products, map[string]interface{}{
					"id":         id,
					"name":       name,
					"price":      price,
					"details":    desc,
					"item_type":  itemType,
					"unit_type":  unitType,
					"variants":   parsedVariants,
					"ai_tag":     aiTag,
					"image_url":  displayImg,
					"image_data": imgData,
				})
			} else {
				log.Printf("⚠️ ProductsHandler row scan error: %v", err)
			}
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
			AITag       string                   `json:"ai_tag"`
			ImageURL    string                   `json:"image_url"`
			ImageData   string                   `json:"image_data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		req.Username = cleanUsername(req.Username)
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
		if req.ImageURL == "" && req.ImageData != "" {
			req.ImageURL = req.ImageData
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

		// Auto-assign <IMG_N> tag if not specified
		if req.AITag == "" {
			var existingCount int
			_ = DB.QueryRow("SELECT COUNT(*) FROM products WHERE LOWER(username)=LOWER($1)", req.Username).Scan(&existingCount)
			req.AITag = fmt.Sprintf("<IMG_%d>", existingCount+1)
		}

		var newID int
		// Try inserting with all columns
		err := DB.QueryRow(`INSERT INTO products (username, name, price, description, item_type, unit_type, variants, ai_tag, image_url, image_data)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING id`,
			req.Username, req.Name, req.Price, req.Description, req.ItemType, req.UnitType, variantsStr, req.AITag, req.ImageURL, req.ImageData).Scan(&newID)

		if err != nil {
			// Fallback if variants is TEXT or columns missing
			err = DB.QueryRow(`INSERT INTO products (username, name, price, description, item_type, unit_type, variants, ai_tag)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
				req.Username, req.Name, req.Price, req.Description, req.ItemType, req.UnitType, variantsStr, req.AITag).Scan(&newID)
		}

		if err != nil {
			respondJSON(w, 500, map[string]string{"error": "Database error: " + err.Error()})
			return
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Item added to Neon DB Catalog!",
			"product": map[string]interface{}{
				"id":         newID,
				"name":       req.Name,
				"price":      req.Price,
				"details":    req.Description,
				"item_type":  req.ItemType,
				"unit_type":  req.UnitType,
				"variants":   req.Variants,
				"ai_tag":     req.AITag,
				"image_url":  req.ImageURL,
				"image_data": req.ImageData,
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
			if username == "admin" {
				_, _ = DB.Exec("DELETE FROM products WHERE id=$1", idStr)
			} else {
				_, _ = DB.Exec("DELETE FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
			}
		}
		respondJSON(w, 200, map[string]string{"status": "success", "message": "Product deleted"})
		return
	}
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

// 19. BULK UPLOAD TEMP IMAGE HANDLER (POST /api/bulk/upload-temp)
func BulkUploadTempHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Filename string `json:"filename"`
		DataURL  string `json:"data_url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.DataURL == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "No image data provided"})
		return
	}

	fn := req.Filename
	if fn == "" {
		fn = "broadcast.jpg"
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":    "success",
		"file_url":  req.DataURL,
		"file_path": fn,
		"message":   "Temporary image loaded for broadcast campaign.",
	})
}

// 20. TEST LEAD NOTIFICATION ALERT DISPATCH (POST /api/ai/test-lead-alert)
func TestLeadAlertHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username          string `json:"username"`
		NotificationPhone string `json:"notification_phone"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := req.Username
	if username == "" {
		username = "admin"
	}

	targetPhone := strings.TrimSpace(req.NotificationPhone)
	if targetPhone == "" && DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(notification_phone, phone, '') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&targetPhone)
	}

	cleanPhone := regexp.MustCompile(`\D`).ReplaceAllString(targetPhone, "")
	if len(cleanPhone) < 8 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter a valid notification WhatsApp number with country code."})
		return
	}

	alertText := fmt.Sprintf("🚨 *TEST LEAD ALERT DISPATCH* 🚨\n\n• Account: @%s\n• Target: +%s\n• Engine: EduCloud Go WhatsApp Gateway\n• Time: %s\n\n✅ If you received this, your automated lead capture notification is fully operational!",
		username, cleanPhone, time.Now().Format("02 Jan 15:04:05"))

	// Push to Live Chat SSE
	whatsapp.PushToLiveChat(username, cleanPhone, alertText, "lead_alert")

	// If WhatsApp client is connected, send real message
	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		_ = whatsapp.SendMessage(client, cleanPhone, alertText)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":             "success",
		"message":            fmt.Sprintf("Test alert dispatched to +%s! Check WhatsApp and Live Chat.", cleanPhone),
		"notification_phone": cleanPhone,
	})
}

// 21. REAL CUSTOMER CONVERSATION LIST (GET /api/chats)
func ChatsHandler(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
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
			       COALESCE((SELECT message_text FROM customer_chats c2 WHERE c2.username=c1.username AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), ''),
			       COALESCE((SELECT role FROM customer_chats c2 WHERE c2.username=c1.username AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), 'customer'),
			       COALESCE((SELECT TO_CHAR(created_at, 'HH24:MI') FROM customer_chats c2 WHERE c2.username=c1.username AND c2.customer_phone=c1.customer_phone ORDER BY id DESC LIMIT 1), 'Recent'),
			       COUNT(*)
			FROM customer_chats c1
			WHERE LOWER(username)=LOWER($1)
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

// 22. GET REAL LAST 10 MESSAGES FOR SPECIFIC CUSTOMER (GET /api/chats/messages)
func ChatMessagesHandler(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	phone := strings.TrimSpace(r.URL.Query().Get("phone"))
	if username == "" {
		username = "admin"
	}

	cleanPhone := regexp.MustCompile(`\D`).ReplaceAllString(phone, "")
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
				ORDER BY id DESC LIMIT 15
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

// 23. SEND OUTGOING MESSAGE FROM LIVE CHAT UI (POST /api/chats/send)
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

	if req.Username == "" {
		req.Username = "admin"
	}

	cleanPhone := regexp.MustCompile(`\D`).ReplaceAllString(req.Phone, "")
	cleanMsg := strings.TrimSpace(req.Message)

	if cleanPhone == "" || cleanMsg == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Phone number and message text required"})
		return
	}

	// 1. Record in DB
	if DB != nil {
		_, _ = DB.Exec(`INSERT INTO customer_chats (username, customer_phone, role, message_text, created_at)
			VALUES ($1, $2, 'assistant', $3, NOW())`, req.Username, cleanPhone, cleanMsg)
	}

	// 2. Push to Live Chat SSE
	whatsapp.PushToLiveChat(req.Username, cleanPhone, cleanMsg, "outgoing")

	// 3. Send over WhatsApp if device linked
	client := whatsapp.GetOrCreateClient(req.Username)
	if client != nil && client.IsLoggedIn() {
		_ = whatsapp.SendMessage(client, cleanPhone, cleanMsg)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":  "success",
		"message": "Message sent and recorded in customer chat history.",
	})
}

