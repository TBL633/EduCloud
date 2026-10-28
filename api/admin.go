package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"wa-server/whatsapp"
)

// ADMIN COMPREHENSIVE DASHBOARD OVERVIEW
func AdminDashboardHandler(w http.ResponseWriter, r *http.Request) {
	totalUsers := 0
	connectedUsers := 0
	automationEnabled := 0
	autoReplyUsers := 0
	libraryOwners := 0
	businessUsers := 0

	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE LOWER(username) != 'admin'").Scan(&totalUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE status='Connected' AND wa_jid != '' AND LOWER(username) != 'admin'").Scan(&connectedUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE automation_access=true AND LOWER(username) != 'admin'").Scan(&automationEnabled)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE auto_reply=true AND LOWER(username) != 'admin'").Scan(&autoReplyUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='library_owner' AND LOWER(username) != 'admin'").Scan(&libraryOwners)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='business_user' AND LOWER(username) != 'admin'").Scan(&businessUsers)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status": "success",
		"metrics": map[string]interface{}{
			"totalUsers":              totalUsers,
			"connectedUsers":          connectedUsers,
			"disconnectedUsers":       totalUsers - connectedUsers,
			"automationEnabledUsers":  automationEnabled,
			"autoReplyUsers":          autoReplyUsers,
			"libraryOwnersCount":      libraryOwners,
			"businessUsersCount":      businessUsers,
		},
	})
}

// ADMIN LIST ALL USERS & CATEGORIZED TENANTS
func ListUsersHandler(w http.ResponseWriter, r *http.Request) {
	type UserItem struct {
		ID               int    `json:"id"`
		Username         string `json:"username"`
		Email            string `json:"email"`
		Role             string `json:"role"`
		UserType         string `json:"user_type"`
		AccountName      string `json:"account_name"`
		Phone            string `json:"phone"`
		WAJID            string `json:"wa_jid"`
		Status           string `json:"status"`
		AutomationAccess bool   `json:"automation_access"`
		AutoReply        bool   `json:"auto_reply"`
		CreatedAt        string `json:"created_at"`
	}

	var users []UserItem

	if DB != nil {
		rows, err := DB.Query(`SELECT id, username, COALESCE(email, ''), COALESCE(role, 'user'), COALESCE(user_type, 'business_user'), COALESCE(account_name, ''), COALESCE(phone, ''), COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected'), COALESCE(automation_access, true), COALESCE(auto_reply, true), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY'), 'Recent')
			FROM users ORDER BY id ASC`)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var u UserItem
				if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.UserType, &u.AccountName, &u.Phone, &u.WAJID, &u.Status, &u.AutomationAccess, &u.AutoReply, &u.CreatedAt); err == nil {
					users = append(users, u)
				}
			}
		}
	}

	if users == nil {
		users = []UserItem{}
	}

	respondJSON(w, 200, map[string]interface{}{"users": users})
}

// ADMIN CREATE USER / TENANT
func CreateUserHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username         string `json:"username"`
		Email            string `json:"email"`
		Password         string `json:"password"`
		AccountName      string `json:"account_name"`
		UserType         string `json:"user_type"`
		AutomationAccess bool   `json:"automation_access"`
		Phone            string `json:"phone"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	rawEmail := strings.ToLower(strings.TrimSpace(req.Email))
	if rawEmail == "" {
		rawEmail = strings.ToLower(strings.TrimSpace(req.Username))
	}
	pass := strings.TrimSpace(req.Password)

	if rawEmail == "" || pass == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Email Address and Password are required"})
		return
	}

	cleanUser := strings.Split(rawEmail, "@")[0]
	cleanUser = strings.ToLower(cleanUser)

	if DB != nil {
		var exists bool
		_ = DB.QueryRow("SELECT EXISTS(SELECT 1 FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2))", cleanUser, rawEmail).Scan(&exists)
		if exists {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Account with this Email / Username already exists!"})
			return
		}

		userType := req.UserType
		if userType == "" {
			userType = "business_user"
		}
		accountName := req.AccountName
		if accountName == "" {
			accountName = fmt.Sprintf("%s Account", cleanUser)
		}

		hashedPass, _ := bcrypt.GenerateFromPassword([]byte(pass), 10)
		sysPrompt := fmt.Sprintf("You are the 24/7 automated WhatsApp assistant for %s. Answer inquiries, share pricing, and capture leads.", accountName)

		_, err := DB.Exec(`INSERT INTO users (username, email, password, role, user_type, account_name, phone, system_prompt, auto_reply, automation_access, status)
			VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, true, $8, 'Disconnected')`,
			cleanUser, rawEmail, string(hashedPass), userType, accountName, req.Phone, sysPrompt, req.AutomationAccess)

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to create user in database: " + err.Error()})
			return
		}

		respondJSON(w, 200, map[string]string{
			"status":  "success",
			"message": fmt.Sprintf("Account @%s created successfully!", cleanUser),
		})
		return
	}

	respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
}

// ADMIN TOGGLE AUTOMATION ACCESS
func ToggleAutomationHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Username is required"})
		return
	}

	if DB != nil {
		var current bool
		err := DB.QueryRow("SELECT COALESCE(automation_access, true) FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&current)
		if err == nil {
			newStatus := !current
			_, _ = DB.Exec("UPDATE users SET automation_access=$1 WHERE LOWER(username)=LOWER($2)", newStatus, username)
			respondJSON(w, 200, map[string]interface{}{
				"status":            "success",
				"automation_access": newStatus,
				"message":           fmt.Sprintf("Automation access for @%s updated!", username),
			})
			return
		}
	}

	respondJSON(w, 400, map[string]string{"status": "error", "message": "User not found"})
}

// ADMIN DELETE TENANT ACCOUNT
func DeleteUserHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	req.Username = cleanUsername(req.Username)

	if req.Username == "" || req.Username == "admin" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Cannot delete master administrator account!"})
		return
	}

	if c, ok := whatsapp.ActiveClients[req.Username]; ok {
		c.Disconnect()
		if c.Store != nil {
			_ = c.Store.Delete(r.Context())
		}
		delete(whatsapp.ActiveClients, req.Username)
		delete(whatsapp.QRChannelMap, req.Username)
	}

	if DB != nil {
		_, _ = DB.Exec("DELETE FROM products WHERE LOWER(username)=LOWER($1)", req.Username)
		_, _ = DB.Exec("DELETE FROM leads WHERE LOWER(username)=LOWER($1)", req.Username)
		_, _ = DB.Exec("DELETE FROM customer_chats WHERE LOWER(username)=LOWER($1)", req.Username)
		_, _ = DB.Exec("DELETE FROM users WHERE LOWER(username)=LOWER($1)", req.Username)
	}

	respondJSON(w, 200, map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Tenant account @%s and all associated records permanently deleted!", req.Username),
	})
}

// USER PROFILE DETAILS HANDLER
func UserProfileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var req struct {
			Username          string `json:"username"`
			NotificationPhone string `json:"notification_phone"`
			AIProvider        string `json:"ai_provider"`
			AIModel           string `json:"ai_model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		if DB != nil {
			if req.NotificationPhone != "" {
				_, _ = DB.Exec("UPDATE users SET notification_phone=$1 WHERE LOWER(username)=LOWER($2)", req.NotificationPhone, username)
			}
			if req.AIModel != "" {
				_, _ = DB.Exec("UPDATE users SET ai_model=$1 WHERE LOWER(username)=LOWER($2)", req.AIModel, username)
			}
			if req.AIProvider != "" {
				_, _ = DB.Exec("UPDATE users SET ai_provider=$1 WHERE LOWER(username)=LOWER($2)", req.AIProvider, username)
			}
		}

		respondJSON(w, 200, map[string]string{
			"status":  "success",
			"message": "User profile updated successfully!",
		})
		return
	}

	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	var email, accountName, userType, phone, notificationPhone, waJid, statusStr, aiProvider, aiModel, createdAt string
	var autoReply, automationAccess bool

	if DB != nil {
		err := DB.QueryRow(`SELECT COALESCE(email, ''), COALESCE(account_name, ''), COALESCE(user_type, 'business_user'), COALESCE(phone, ''), COALESCE(notification_phone, ''), COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected'), COALESCE(auto_reply, true), COALESCE(automation_access, true), COALESCE(ai_provider, 'gemini'), COALESCE(ai_model, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY'), 'Active')
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&email, &accountName, &userType, &phone, &notificationPhone, &waJid, &statusStr, &autoReply, &automationAccess, &aiProvider, &aiModel, &createdAt)

		if err == nil {
			respondJSON(w, 200, map[string]interface{}{
				"status":             "success",
				"username":           username,
				"email":              email,
				"account_name":       accountName,
				"user_type":          userType,
				"phone":              phone,
				"notification_phone": notificationPhone,
				"wa_jid":             waJid,
				"wa_status":          statusStr,
				"auto_reply":         autoReply,
				"automation_access":  automationAccess,
				"ai_provider":        aiProvider,
				"ai_model":           aiModel,
				"created_at":         createdAt,
			})
			return
		}
	}

	respondJSON(w, 404, map[string]string{"status": "error", "message": "User profile not found"})
}
