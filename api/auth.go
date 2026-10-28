package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// DB Status Endpoint for Frontend Badge & Health Check
func DBStatusHandler(w http.ResponseWriter, r *http.Request) {
	if DB == nil {
		respondJSON(w, 200, map[string]interface{}{
			"connected": false,
			"message":   "Running in Standalone / Memory Mode",
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

	loginID := strings.TrimSpace(req.Identifier)
	if loginID == "" {
		loginID = strings.TrimSpace(req.Username)
	}
	if loginID == "" {
		loginID = strings.TrimSpace(req.Email)
	}
	pass := strings.TrimSpace(req.Password)

	if loginID == "" || pass == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter Email / Username and Password."})
		return
	}

	if DB == nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database connection not initialized."})
		return
	}

	var dbID int
	var dbUsername, dbEmail, dbPassword, dbRole, dbUserType, dbAccountName string
	var dbAutoReply, dbAutomationAccess bool
	var dbAIProvider, dbSystemPrompt string

	err := DB.QueryRow(`
		SELECT id, username, COALESCE(email, ''), password, COALESCE(role, 'user'), COALESCE(user_type, 'business_user'), COALESCE(account_name, ''), COALESCE(auto_reply, true), COALESCE(automation_access, true), COALESCE(ai_provider, 'gemini'), COALESCE(system_prompt, '')
		FROM users
		WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`, loginID).
		Scan(&dbID, &dbUsername, &dbEmail, &dbPassword, &dbRole, &dbUserType, &dbAccountName, &dbAutoReply, &dbAutomationAccess, &dbAIProvider, &dbSystemPrompt)

	if err != nil {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Account not found! Please check your email or sign up."})
		return
	}

	err = bcrypt.CompareHashAndPassword([]byte(dbPassword), []byte(pass))
	if err != nil && dbPassword != pass {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Invalid Password. Please verify your credentials."})
		return
	}

	isGlobalAdmin := dbRole == "admin" || strings.ToLower(dbUsername) == "admin" || strings.ToLower(dbEmail) == "admin@eduta.ai"
	targetPortal := "business_portal"
	if isGlobalAdmin {
		targetPortal = "admin_portal"
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":            "success",
		"portal":            targetPortal,
		"role":              dbRole,
		"user_type":         dbUserType,
		"token":             "eduta-token-" + dbUsername,
		"username":          dbUsername,
		"email":             dbEmail,
		"account_name":      dbAccountName,
		"user_id":           dbID,
		"automation_access": dbAutomationAccess,
		"ai_provider":       dbAIProvider,
		"system_prompt":     dbSystemPrompt,
		"auto_reply":        dbAutoReply,
	})
}

// 2. SEND OTP FOR VERIFICATION
func SendOTPHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FullName        string `json:"full_name"`
		Email           string `json:"email"`
		Password        string `json:"password"`
		ConfirmPassword string `json:"confirm_password"`
		AccountName     string `json:"account_name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	fullName := strings.TrimSpace(req.FullName)
	if fullName == "" {
		fullName = strings.TrimSpace(req.AccountName)
	}
	emailInput := strings.ToLower(strings.TrimSpace(req.Email))
	passInput := strings.TrimSpace(req.Password)

	if fullName == "" || emailInput == "" || passInput == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Full Name, Email Address, and Password are required!"})
		return
	}

	if req.ConfirmPassword != "" && passInput != strings.TrimSpace(req.ConfirmPassword) {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Password and Confirm Password do not match!"})
		return
	}

	if len(passInput) < 6 || !regexp.MustCompile(`[A-Z]`).MatchString(passInput) || !regexp.MustCompile(`[0-9]`).MatchString(passInput) || !regexp.MustCompile(`[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]`).MatchString(passInput) {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Password must be at least 6 characters with 1 uppercase letter, 1 number, and 1 special character!"})
		return
	}

	cleanUser := strings.Split(emailInput, "@")[0]
	cleanUser = regexp.MustCompile(`[^a-zA-Z0-9_.]`).ReplaceAllString(cleanUser, "_")

	if DB != nil {
		var exists bool
		_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2))", cleanUser, emailInput).Scan(&exists)
		if exists {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "This Email Address is already registered! Please sign in."})
			return
		}
	}

	otpCode := fmt.Sprintf("%06d", rand.Intn(900000)+100000)
	expiresAt := time.Now().Add(10 * time.Minute)

	if DB != nil {
		_, _ = DB.Exec("DELETE FROM email_verifications WHERE LOWER(email)=LOWER($1)", emailInput)
		_, err := DB.Exec("INSERT INTO email_verifications (email, otp_code, code, expires_at) VALUES ($1, $2, $2, $3)", emailInput, otpCode, expiresAt)
		if err != nil {
			log.Printf("⚠️ OTP insert note: %v", err)
		}
	}

	neonSent, neonMsg := sendNeonAuthOTP(emailInput, fullName, passInput)

	if neonSent {
		respondJSON(w, 200, map[string]interface{}{
			"status":          "success",
			"message":         neonMsg,
			"email":           emailInput,
			"neon_auth_sent": true,
		})
	} else {
		respondJSON(w, 200, map[string]interface{}{
			"status":          "success",
			"message":         fmt.Sprintf("Verification Code: %s (Verification code generated for %s).", otpCode, emailInput),
			"email":           emailInput,
			"otp_code":        otpCode,
			"neon_auth_sent": false,
		})
	}
}

// 3. VERIFY OTP & CREATE ACCOUNT
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

	if emailInput == "" || codeInput == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Email Address and 6-Digit OTP Code are required!"})
		return
	}

	isOtpValid := false

	if DB != nil {
		var storedCode string
		var expiresAt time.Time
		err := DB.QueryRow("SELECT COALESCE(NULLIF(otp_code, ''), NULLIF(code, ''), ''), expires_at FROM email_verifications WHERE LOWER(email)=LOWER($1) ORDER BY id DESC LIMIT 1", emailInput).Scan(&storedCode, &expiresAt)
		if err == nil && storedCode == codeInput && time.Now().Before(expiresAt) {
			isOtpValid = true;
			_, _ = DB.Exec("DELETE FROM email_verifications WHERE LOWER(email)=LOWER($1)", emailInput)
		}
	}

	if !isOtpValid {
		isOtpValid = verifyNeonAuthOTP(emailInput, codeInput)
	}

	if !isOtpValid {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Invalid or expired OTP verification code!"})
		return
	}

	fullName := strings.TrimSpace(req.FullName)
	if fullName == "" {
		fullName = "Business Workspace"
	}
	rawPassword := strings.TrimSpace(req.Password)
	if rawPassword == "" {
		rawPassword = "User@123"
	}

	cleanUser := strings.Split(emailInput, "@")[0]
	cleanUser = regexp.MustCompile(`[^a-zA-Z0-9_.]`).ReplaceAllString(cleanUser, "_")

	if DB != nil {
		var exists bool
		_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=LOWER($1))", cleanUser).Scan(&exists)
		if exists {
			cleanUser = fmt.Sprintf("%s_%d", cleanUser, rand.Intn(900)+100)
		}

		hashedPass, _ := bcrypt.GenerateFromPassword([]byte(rawPassword), 10)
		sysPrompt := fmt.Sprintf("You are an intelligent 24/7 sales & lead qualification WhatsApp bot for %s. Answer inquiries promptly, share pricing and service information, and help capture leads.", fullName)

		var userID int
		err := DB.QueryRow(`INSERT INTO users (username, email, password, role, user_type, account_name, system_prompt, auto_reply, automation_access, status)
			VALUES ($1, $2, $3, 'user', 'business_user', $4, $5, true, true, 'Disconnected') RETURNING id`,
			cleanUser, emailInput, string(hashedPass), fullName, sysPrompt).Scan(&userID)

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to create user account: " + err.Error()})
			return
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":            "success",
			"message":           "Email verified! Account created successfully.",
			"portal":            "business_portal",
			"token":             "eduta-token-" + cleanUser,
			"username":          cleanUser,
			"role":              "user",
			"user_type":         "business_user",
			"account_name":      fullName,
			"user_id":           userID,
			"automation_access": true,
			"ai_provider":       "gemini",
			"system_prompt":     sysPrompt,
			"auto_reply":        true,
		})
		return
	}

	respondJSON(w, 500, map[string]string{"status": "error", "message": "Database connection missing."})
}

// 4. VERIFY CURRENT PASSWORD
func VerifyPasswordHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"current_password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" || req.CurrentPassword == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "verified": false, "message": "Username and current password required"})
		return
	}

	if DB == nil {
		respondJSON(w, 500, map[string]interface{}{"status": "error", "verified": false, "message": "Database not initialized"})
		return
	}

	var storedHash string
	err := DB.QueryRow("SELECT password FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", username).Scan(&storedHash)
	if err != nil {
		respondJSON(w, 404, map[string]interface{}{"status": "error", "verified": false, "message": "User not found"})
		return
	}

	err = bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(req.CurrentPassword))
	if err != nil && storedHash != req.CurrentPassword {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "verified": false, "message": "Current password is incorrect. Please try again."})
		return
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":   "success",
		"verified": true,
		"message":  "Current password verified successfully! You can now set your new password.",
	})
}

// 5. UPDATE PASSWORD
func UpdatePasswordHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username        string `json:"username"`
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" || req.CurrentPassword == "" || req.NewPassword == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "All password fields are required"})
		return
	}

	if len(req.NewPassword) < 6 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "New password must be at least 6 characters long"})
		return
	}

	if DB == nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
		return
	}

	var storedHash string
	err := DB.QueryRow("SELECT password FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", username).Scan(&storedHash)
	if err != nil {
		respondJSON(w, 404, map[string]string{"status": "error", "message": "User account not found"})
		return
	}

	err = bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(req.CurrentPassword))
	if err != nil && storedHash != req.CurrentPassword {
		respondJSON(w, 401, map[string]string{"status": "error", "message": "Current password does not match."})
		return
	}

	hashedNew, _ := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 10)
	_, err = DB.Exec("UPDATE users SET password=$1 WHERE LOWER(username)=LOWER($2)", string(hashedNew), username)
	if err != nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update password in database: " + err.Error()})
		return
	}

	respondJSON(w, 200, map[string]string{
		"status":  "success",
		"message": "Your password has been updated successfully!",
	})
}
