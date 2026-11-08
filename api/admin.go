package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

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

		hashedPass := []byte(pass)
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
		_, _ = DB.Exec("DELETE FROM tenant_whatsapp_sessions WHERE LOWER(username)=LOWER($1)", req.Username)
		_, _ = DB.Exec("DELETE FROM users WHERE LOWER(username)=LOWER($1)", req.Username)
	}

	respondJSON(w, 200, map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Tenant account @%s and all associated records permanently deleted!", req.Username),
	})
}

// USER PROFILE DETAILS HANDLER (GET / POST / PUT /api/user/profile & /api/admin/profile)
func UserProfileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" || r.Method == "PUT" {
		var req struct {
			Username                string      `json:"username"`
			BusinessName            string      `json:"business_name"`
			NotificationPhone       string      `json:"notification_phone"`
			AIProvider              string      `json:"ai_provider"`
			AIModel                 string      `json:"ai_model"`
			FullAddress             string      `json:"full_address"`
			LocalArea               string      `json:"local_area"`
			StoreSlug               string      `json:"store_slug"`
			LogoURL                 string      `json:"logo_url"`
			BannerURL               string      `json:"banner_url"`
			Tagline                 string      `json:"tagline"`
			Latitude                interface{} `json:"latitude"`
			Longitude               interface{} `json:"longitude"`
			MaxDeliveryRadiusKM     interface{} `json:"max_delivery_radius_km"`
			FreeDeliveryRadiusKM    interface{} `json:"free_delivery_radius_km"`
			DeliveryChargeAmount    interface{} `json:"delivery_charge_amount"`
			RequireCustomerLocation *bool       `json:"require_customer_location"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		latVal := parseCoordinateVal(req.Latitude)
		lngVal := parseCoordinateVal(req.Longitude)
		maxRadVal := parseCoordinateVal(req.MaxDeliveryRadiusKM)
		freeRadVal := parseCoordinateVal(req.FreeDeliveryRadiusKM)
		delChargeVal := parseCoordinateVal(req.DeliveryChargeAmount)

		cleanSlug := strings.ToLower(strings.TrimSpace(req.StoreSlug))
		cleanSlug = regexp.MustCompile(`[^a-z0-9_]+`).ReplaceAllString(cleanSlug, "_")
		cleanSlug = strings.Trim(cleanSlug, "_")

		if DB != nil {
			if req.BusinessName != "" {
				_, _ = DB.Exec("UPDATE users SET business_name=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.BusinessName), username)
			}
			if req.NotificationPhone != "" {
				_, _ = DB.Exec("UPDATE users SET notification_phone=$1 WHERE LOWER(username)=LOWER($2)", req.NotificationPhone, username)
			}
			if req.AIModel != "" {
				_, _ = DB.Exec("UPDATE users SET ai_model=$1 WHERE LOWER(username)=LOWER($2)", req.AIModel, username)
			}
			if req.AIProvider != "" {
				_, _ = DB.Exec("UPDATE users SET ai_provider=$1 WHERE LOWER(username)=LOWER($2)", req.AIProvider, username)
			}
			if req.RequireCustomerLocation != nil {
				_, _ = DB.Exec("UPDATE users SET require_customer_location=$1 WHERE LOWER(username)=LOWER($2)", *req.RequireCustomerLocation, username)
			}
			if cleanSlug != "" {
				_, _ = DB.Exec("UPDATE users SET store_slug=$1 WHERE LOWER(username)=LOWER($2)", cleanSlug, username)
			}
			if req.LogoURL != "" {
				_, _ = DB.Exec("UPDATE users SET logo_url=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.LogoURL), username)
			}
			if req.BannerURL != "" {
				_, _ = DB.Exec("UPDATE users SET banner_url=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.BannerURL), username)
			}
			if req.Tagline != "" {
				_, _ = DB.Exec("UPDATE users SET tagline=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.Tagline), username)
			}
			_, _ = DB.Exec(`UPDATE users SET 
				full_address = CASE WHEN $1 != '' THEN $1 ELSE full_address END,
				local_area = CASE WHEN $2 != '' THEN $2 ELSE local_area END,
				latitude = CASE WHEN $3 != 0 THEN $3 ELSE latitude END,
				longitude = CASE WHEN $4 != 0 THEN $4 ELSE longitude END,
				business_lat = CASE WHEN $3 != 0 THEN $3 ELSE business_lat END,
				business_lng = CASE WHEN $4 != 0 THEN $4 ELSE business_lng END,
				max_delivery_radius_km = CASE WHEN $5 > 0 THEN $5 ELSE max_delivery_radius_km END,
				free_delivery_radius_km = CASE WHEN $6 >= 0 THEN $6 ELSE free_delivery_radius_km END,
				delivery_charge_amount = CASE WHEN $7 >= 0 THEN $7 ELSE delivery_charge_amount END
				WHERE LOWER(username)=LOWER($8)`, strings.TrimSpace(req.FullAddress), strings.TrimSpace(req.LocalArea), latVal, lngVal, maxRadVal, freeRadVal, delChargeVal, username)

			whatsapp.InvalidateUserConfigCache(username)
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":                    "success",
			"message":                   "User profile, storefront, and delivery settings updated successfully!",
			"full_address":              req.FullAddress,
			"local_area":                req.LocalArea,
			"store_slug":                cleanSlug,
			"logo_url":                  req.LogoURL,
			"banner_url":                req.BannerURL,
			"tagline":                   req.Tagline,
			"latitude":                  latVal,
			"longitude":                 lngVal,
			"max_delivery_radius_km":    maxRadVal,
			"free_delivery_radius_km":   freeRadVal,
			"delivery_charge_amount":    delChargeVal,
			"require_customer_location": req.RequireCustomerLocation,
		})
		return
	}

	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	var email, accountName, bName, userType, phone, notificationPhone, waJid, statusStr, aiProvider, aiModel, createdAt, fullAddress, localArea string
	var storeSlug, logoURL, bannerURL, tagline string
	var latVal, lngVal, maxRadVal, freeRadVal, delChargeVal float64
	var autoReply, automationAccess, reqLoc bool

	if DB != nil {
		err := DB.QueryRow(`SELECT 
			COALESCE(email, ''), COALESCE(account_name, ''), COALESCE(business_name, account_name, ''), COALESCE(user_type, 'business_user'), 
			COALESCE(phone, ''), COALESCE(notification_phone, ''), COALESCE(wa_jid, ''), 
			COALESCE(status, 'Disconnected'), COALESCE(auto_reply, true), COALESCE(automation_access, true), 
			COALESCE(ai_provider, 'gemini'), COALESCE(ai_model, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY'), 'Active'),
			COALESCE(full_address, ''), COALESCE(local_area, ''), COALESCE(latitude, 0.0), COALESCE(longitude, 0.0),
			COALESCE(max_delivery_radius_km, 15.0), COALESCE(free_delivery_radius_km, 3.0), COALESCE(delivery_charge_amount, 40.0), COALESCE(require_customer_location, false),
			COALESCE(store_slug, username), COALESCE(logo_url, ''), COALESCE(banner_url, ''), COALESCE(tagline, '')
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&email, &accountName, &bName, &userType, &phone, &notificationPhone, &waJid, &statusStr, &autoReply, &automationAccess, &aiProvider, &aiModel, &createdAt, &fullAddress, &localArea, &latVal, &lngVal, &maxRadVal, &freeRadVal, &delChargeVal, &reqLoc, &storeSlug, &logoURL, &bannerURL, &tagline)

		if err == nil {
			if storeSlug == "" {
				storeSlug = username
			}
			respondJSON(w, 200, map[string]interface{}{
				"status":                    "success",
				"username":                  username,
				"email":                     email,
				"account_name":              accountName,
				"business_name":             bName,
				"user_type":                 userType,
				"phone":                     phone,
				"notification_phone":        notificationPhone,
				"wa_jid":                    waJid,
				"wa_status":                 statusStr,
				"auto_reply":                autoReply,
				"automation_access":         automationAccess,
				"ai_provider":               aiProvider,
				"ai_model":                  aiModel,
				"created_at":                createdAt,
				"full_address":              fullAddress,
				"local_area":                localArea,
				"latitude":                  latVal,
				"longitude":                 lngVal,
				"max_delivery_radius_km":    maxRadVal,
				"free_delivery_radius_km":   freeRadVal,
				"delivery_charge_amount":    delChargeVal,
				"require_customer_location": reqLoc,
				"store_slug":                storeSlug,
				"logo_url":                  logoURL,
				"banner_url":                bannerURL,
				"tagline":                   tagline,
			})
			return
		}
	}

	respondJSON(w, 404, map[string]string{"status": "error", "message": "User profile not found"})
}

func parseCoordinateVal(val interface{}) float64 {
	if val == nil {
		return 0.0
	}
	switch v := val.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		s := strings.TrimSpace(v)
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	}
	return 0.0
}

// ADMIN GET SUBSCRIBED NEWSLETTERS / CHANNELS API
// Strictly returns JSON array: [{"jid": "12036...@newsletter", "name": "Aaj Tak News", "role": "ADMIN"}, ...]
func GetNewslettersHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	newsletters, err := whatsapp.FetchSubscribedNewsletters(username)
	if err != nil {
		respondJSON(w, 200, []whatsapp.NewsletterItem{})
		return
	}

	if newsletters == nil {
		newsletters = []whatsapp.NewsletterItem{}
	}

	respondJSON(w, 200, newsletters)
}

// ADMIN CHANNEL RULES HANDLER (GET, POST, DELETE)
// Enables One-to-One, One-to-Many, Many-to-One, and Many-to-Many channel routing
func ChannelRulesHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		rules := whatsapp.SyncChannelRulesCache()
		if rules == nil {
			rules = []whatsapp.ChannelForwardingRule{}
		}
		respondJSON(w, 200, map[string]interface{}{
			"status": "success",
			"rules":  rules,
		})
	case "POST":
		var req struct {
			AdminAccountID    string `json:"admin_account_id"`
			SourceJID         string `json:"source_jid"`
			SourceName        string `json:"source_name"`
			TargetJID         string `json:"target_jid"`
			TargetName        string `json:"target_name"`
			ForwardLogic      string `json:"forward_logic"`
			BlockURLs         bool   `json:"block_urls"`
			StripChannelLinks *bool  `json:"strip_channel_links"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Invalid JSON payload"})
			return
		}
		if req.SourceJID == "" || req.TargetJID == "" {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Source and Target channels are required"})
			return
		}
		stripLinks := true
		if req.StripChannelLinks != nil {
			stripLinks = *req.StripChannelLinks
		}
		rule, err := whatsapp.AddChannelForwardingRule(req.AdminAccountID, req.SourceJID, req.SourceName, req.TargetJID, req.TargetName, req.ForwardLogic, req.BlockURLs, stripLinks)
		if err != nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": err.Error()})
			return
		}
		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Channel forwarding rule added successfully!",
			"rule":    rule,
		})
	case "PUT":
		var req struct {
			ID                int    `json:"id"`
			SourceJID         string `json:"source_jid"`
			SourceName        string `json:"source_name"`
			TargetJID         string `json:"target_jid"`
			TargetName        string `json:"target_name"`
			ForwardLogic      string `json:"forward_logic"`
			BlockURLs         bool   `json:"block_urls"`
			StripChannelLinks *bool  `json:"strip_channel_links"`
			IsActive          *bool  `json:"is_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Invalid JSON payload"})
			return
		}
		if req.ID <= 0 {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Valid rule ID is required"})
			return
		}
		stripLinks := true
		if req.StripChannelLinks != nil {
			stripLinks = *req.StripChannelLinks
		}
		isActive := true
		if req.IsActive != nil {
			isActive = *req.IsActive
		}
		rule, err := whatsapp.UpdateChannelForwardingRule(req.ID, req.SourceJID, req.SourceName, req.TargetJID, req.TargetName, req.ForwardLogic, req.BlockURLs, stripLinks, isActive)
		if err != nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": err.Error()})
			return
		}
		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": fmt.Sprintf("Forwarding rule #%d updated successfully!", req.ID),
			"rule":    rule,
		})
	case "DELETE":
		idStr := r.URL.Query().Get("id")
		if idStr == "" {
			var body struct {
				ID int `json:"id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.ID > 0 {
				idStr = strconv.Itoa(body.ID)
			}
		}
		id, err := strconv.Atoi(idStr)
		if err != nil || id <= 0 {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Valid rule ID is required"})
			return
		}
		if err := whatsapp.DeleteChannelForwardingRule(id); err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": err.Error()})
			return
		}
		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": fmt.Sprintf("Forwarding rule #%d deleted successfully!", id),
		})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// TOGGLE CHANNEL RULE HANDLER
func ToggleChannelRuleHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		var body struct {
			ID int `json:"id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.ID > 0 {
			idStr = strconv.Itoa(body.ID)
		}
	}
	id, err := strconv.Atoi(idStr)
	if err != nil || id <= 0 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Valid rule ID is required"})
		return
	}
	newState, err := whatsapp.ToggleChannelForwardingRule(id)
	if err != nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": err.Error()})
		return
	}
	respondJSON(w, 200, map[string]interface{}{
		"status":    "success",
		"id":        id,
		"is_active": newState,
		"message":   fmt.Sprintf("Rule #%d status updated!", id),
	})
}

// ADMIN CHANNEL FORWARDER CONFIG HANDLER (GET & POST) - Backward compatibility
func AdminChannelForwarderHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		cfg := whatsapp.LoadAdminChannelConfigFromDB()
		respondJSON(w, 200, map[string]interface{}{
			"status":                 "success",
			"source_channel_jid":       cfg.SourceChannelJID,
			"target_channel_jid":       cfg.TargetChannelJID,
			"channel_forwarder_active": cfg.ChannelForwarderActive,
			"config":                 cfg,
		})
		return
	}

	if r.Method == "POST" {
		var req struct {
			SourceChannelJID       string `json:"source_channel_jid"`
			TargetChannelJID       string `json:"target_channel_jid"`
			ChannelForwarderActive bool   `json:"channel_forwarder_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Invalid JSON body"})
			return
		}

		cfg := whatsapp.AdminChannelForwarderConfig{
			SourceChannelJID:       strings.TrimSpace(req.SourceChannelJID),
			TargetChannelJID:       strings.TrimSpace(req.TargetChannelJID),
			ChannelForwarderActive: req.ChannelForwarderActive,
		}

		if err := whatsapp.SaveAdminChannelConfigToDB(cfg); err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to save configuration: " + err.Error()})
			return
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Automated channel forwarder configuration saved successfully!",
			"config":  cfg,
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}
