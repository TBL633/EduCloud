package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

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
	totalMediaItems := 0
	totalOrders := 0
	totalGMV := 0.0
	todayOrders := 0
	todayGMV := 0.0
	totalLeads := 0
	totalChats := 0
	activeChannelRules := 0

	now := time.Now()
	sevenDayLabels := make([]string, 7)
	sevenDayGMV := make([]float64, 7)
	sevenDayOrders := make([]int, 7)
	dayMap := make(map[string]int)
	for i := 6; i >= 0; i-- {
		d := now.AddDate(0, 0, -i)
		idx := 6 - i
		key := d.Format("2006-01-02")
		sevenDayLabels[idx] = d.Format("Mon, 02 Jan")
		dayMap[key] = idx
	}

	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE LOWER(username) != 'admin'").Scan(&totalUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE (status='Connected' OR (wa_jid IS NOT NULL AND wa_jid != '')) AND LOWER(username) != 'admin'").Scan(&connectedUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE automation_access=true AND LOWER(username) != 'admin'").Scan(&automationEnabled)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE auto_reply=true AND LOWER(username) != 'admin'").Scan(&autoReplyUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='library_owner' AND LOWER(username) != 'admin'").Scan(&libraryOwners)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='business_user' AND LOWER(username) != 'admin'").Scan(&businessUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM products").Scan(&totalMediaItems)
		_ = DB.QueryRow("SELECT COUNT(*) FROM leads").Scan(&totalLeads)
		_ = DB.QueryRow("SELECT COUNT(DISTINCT customer_phone) FROM customer_chats").Scan(&totalChats)
		_ = DB.QueryRow("SELECT COUNT(*) FROM channel_forwarding_rules WHERE is_active=true").Scan(&activeChannelRules)
		_ = DB.QueryRow(`SELECT COUNT(*), COALESCE(SUM(total_amount), 0), COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE), COALESCE(SUM(total_amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) FROM orders`).
			Scan(&totalOrders, &totalGMV, &todayOrders, &todayGMV)

		rows, err := DB.Query(`SELECT COALESCE(total_amount, 0), COALESCE(created_at, NOW()) FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var amt float64
				var created time.Time
				if err := rows.Scan(&amt, &created); err == nil {
					if idx, ok := dayMap[created.Format("2006-01-02")]; ok {
						sevenDayGMV[idx] += amt
						sevenDayOrders[idx]++
					}
				}
			}
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status": "success",
		"metrics": map[string]interface{}{
			"totalUsers":             totalUsers,
			"connectedUsers":         connectedUsers,
			"disconnectedUsers":      totalUsers - connectedUsers,
			"automationEnabledUsers": automationEnabled,
			"autoReplyUsers":         autoReplyUsers,
			"libraryOwnersCount":     libraryOwners,
			"businessUsersCount":     businessUsers,
			"totalMediaItems":        totalMediaItems,
			"totalOrders":            totalOrders,
			"totalGMV":               totalGMV,
			"todayOrders":            todayOrders,
			"todayGMV":               todayGMV,
			"totalLeads":             totalLeads,
			"totalChats":             totalChats,
			"activeChannelRules":     activeChannelRules,
		},
		"charts": map[string]interface{}{
			"seven_day_labels": sevenDayLabels,
			"seven_day_gmv":    sevenDayGMV,
			"seven_day_orders": sevenDayOrders,
		},
	})
}

// ADMIN LIST ALL USERS & CATEGORIZED TENANTS
func ListUsersHandler(w http.ResponseWriter, r *http.Request) {
	type UserItem struct {
		ID                  int     `json:"id"`
		Username            string  `json:"username"`
		StoreSlug           string  `json:"store_slug"`
		Email               string  `json:"email"`
		Role                string  `json:"role"`
		UserType            string  `json:"user_type"`
		AccountName         string  `json:"account_name"`
		FullName            string  `json:"full_name"`
		Phone               string  `json:"phone"`
		WAJID               string  `json:"wa_jid"`
		Status              string  `json:"status"`
		AutomationAccess    bool    `json:"automation_access"`
		IsAutomated         bool    `json:"is_automated"`
		AutoReply           bool    `json:"auto_reply"`
		StoreOpenStatus     bool    `json:"store_open_status"`
		PaytmVPA            string  `json:"paytm_vpa"`
		PaytmMID            string  `json:"paytm_mid"`
		MaxDeliveryRadiusKM float64 `json:"max_delivery_radius_km"`
		AIProvider          string  `json:"ai_provider"`
		ProductsCount       int     `json:"products_count"`
		LeadsCount          int     `json:"leads_count"`
		OrdersCount         int     `json:"orders_count"`
		RevenueTotal        float64 `json:"revenue_total"`
		CreatedAt           string  `json:"created_at"`
	}

	var users []UserItem

	if DB != nil {
		rows, err := DB.Query(`SELECT u.id, u.username, COALESCE(u.store_slug, u.username), COALESCE(u.email, ''), COALESCE(u.role, 'user'), COALESCE(u.user_type, 'business_user'), COALESCE(u.account_name, u.username), COALESCE(u.phone, ''), COALESCE(u.wa_jid, ''), COALESCE(u.status, 'Disconnected'), COALESCE(u.automation_access, true), COALESCE(u.auto_reply, true), COALESCE(u.store_open_status, true), COALESCE(u.paytm_vpa, ''), COALESCE(u.paytm_mid, ''), COALESCE(u.max_delivery_radius_km, 15.0), COALESCE(u.ai_provider, 'Groq'),
			(SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(u.username)),
			(SELECT COUNT(*) FROM leads l WHERE LOWER(l.username)=LOWER(u.username)),
			(SELECT COUNT(*) FROM orders o WHERE LOWER(o.tenant_id)=LOWER(u.username) OR LOWER(o.tenant_id)=LOWER(COALESCE(u.store_slug, u.username))),
			(SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o WHERE LOWER(o.tenant_id)=LOWER(u.username) OR LOWER(o.tenant_id)=LOWER(COALESCE(u.store_slug, u.username))),
			COALESCE(TO_CHAR(u.created_at, 'DD Mon YYYY'), 'Recent')
			FROM users u WHERE LOWER(u.username) != 'admin' ORDER BY u.id ASC`)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var u UserItem
				if err := rows.Scan(&u.ID, &u.Username, &u.StoreSlug, &u.Email, &u.Role, &u.UserType, &u.AccountName, &u.Phone, &u.WAJID, &u.Status, &u.AutomationAccess, &u.AutoReply, &u.StoreOpenStatus, &u.PaytmVPA, &u.PaytmMID, &u.MaxDeliveryRadiusKM, &u.AIProvider, &u.ProductsCount, &u.LeadsCount, &u.OrdersCount, &u.RevenueTotal, &u.CreatedAt); err == nil {
					u.FullName = u.AccountName
					u.IsAutomated = u.AutomationAccess
					if u.WAJID != "" {
						u.Status = "Connected"
					}
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

// ADMIN TOGGLE AUTO-REPLY
func ToggleAutoReplyHandler(w http.ResponseWriter, r *http.Request) {
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
		if err := DB.QueryRow("SELECT COALESCE(auto_reply, true) FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&current); err == nil {
			newStatus := !current
			_, _ = DB.Exec("UPDATE users SET auto_reply=$1 WHERE LOWER(username)=LOWER($2)", newStatus, username)
			respondJSON(w, 200, map[string]interface{}{
				"status":     "success",
				"auto_reply": newStatus,
				"message":    fmt.Sprintf("AI Auto-Reply for @%s updated!", username),
			})
			return
		}
	}
	respondJSON(w, 400, map[string]string{"status": "error", "message": "User not found"})
}

// ADMIN UPDATE USER / PASSWORD RESET
func UpdateUserHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" && r.Method != "PUT" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Username            string  `json:"username"`
		AccountName         string  `json:"account_name"`
		Email               string  `json:"email"`
		Phone               string  `json:"phone"`
		UserType            string  `json:"user_type"`
		StoreSlug           string  `json:"store_slug"`
		NewPassword         string  `json:"new_password"`
		AutomationAccess    *bool   `json:"automation_access"`
		AutoReply           *bool   `json:"auto_reply"`
		StoreOpenStatus     *bool   `json:"store_open_status"`
		MaxDeliveryRadiusKM float64 `json:"max_delivery_radius_km"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	username := cleanUsername(req.Username)
	if username == "" || DB == nil {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Valid username is required"})
		return
	}
	radius := req.MaxDeliveryRadiusKM
	if radius <= 0 {
		radius = 15.0
	}
	_, _ = DB.Exec(`UPDATE users SET
		account_name = COALESCE(NULLIF($1, ''), account_name),
		business_name = COALESCE(NULLIF($1, ''), business_name),
		email = COALESCE(NULLIF($2, ''), email),
		phone = COALESCE($3, phone),
		user_type = COALESCE(NULLIF($4, ''), user_type),
		store_slug = COALESCE(NULLIF($5, ''), store_slug),
		max_delivery_radius_km = $6,
		delivery_radius_km = $6
		WHERE LOWER(username)=LOWER($7)`,
		strings.TrimSpace(req.AccountName), strings.TrimSpace(req.Email), strings.TrimSpace(req.Phone), strings.TrimSpace(req.UserType), strings.TrimSpace(req.StoreSlug), radius, username)

	if req.AutomationAccess != nil {
		_, _ = DB.Exec("UPDATE users SET automation_access=$1 WHERE LOWER(username)=LOWER($2)", *req.AutomationAccess, username)
	}
	if req.AutoReply != nil {
		_, _ = DB.Exec("UPDATE users SET auto_reply=$1 WHERE LOWER(username)=LOWER($2)", *req.AutoReply, username)
	}
	if req.StoreOpenStatus != nil {
		_, _ = DB.Exec("UPDATE users SET store_open_status=$1 WHERE LOWER(username)=LOWER($2)", *req.StoreOpenStatus, username)
	}
	if len(strings.TrimSpace(req.NewPassword)) >= 4 {
		_, _ = DB.Exec("UPDATE users SET password=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.NewPassword), username)
	}
	respondJSON(w, 200, map[string]string{"status": "success", "message": fmt.Sprintf("Tenant @%s updated!", username)})
}

// ADMIN GLOBAL ORDERS & LEADS MONITOR (GET /api/admin/orders)
func AdminOrdersHandler(w http.ResponseWriter, r *http.Request) {
	tenant := cleanUsername(r.URL.Query().Get("tenant"))
	orders := make([]map[string]interface{}, 0)
	leads := make([]map[string]interface{}, 0)

	if DB != nil {
		oRows, err := DB.Query(`SELECT id, COALESCE(order_id, ''), COALESCE(jid, ''), COALESCE(customer_phone, ''), COALESCE(tenant_id, 'admin'), COALESCE(customer_name, 'Customer'), COALESCE(delivery_phone, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, 'COD'), COALESCE(payment_status, 'PENDING'), COALESCE(order_status, 'NEW'), COALESCE(created_at, NOW())
			FROM orders WHERE ($1 = '' OR LOWER(tenant_id)=LOWER($1)) ORDER BY created_at DESC LIMIT 100`, tenant)
		if err == nil {
			defer oRows.Close()
			for oRows.Next() {
				var id int
				var oid, jid, cPhone, tID, cName, dPhone, dAddr, itemsJSON, pMode, pStat, oStat string
				var amt float64
				var created time.Time
				if err := oRows.Scan(&id, &oid, &jid, &cPhone, &tID, &cName, &dPhone, &dAddr, &itemsJSON, &amt, &pMode, &pStat, &oStat, &created); err == nil {
					if oid == "" {
						oid = fmt.Sprintf("ORD-%d", id)
					}
					isWA := strings.HasPrefix(strings.ToUpper(oid), "WA") || strings.Contains(strings.ToUpper(pMode), "WHATSAPP") || (jid != "" && !strings.HasPrefix(strings.ToUpper(oid), "WEB"))
					source := "Web"
					if isWA {
						source = "WhatsApp"
					}
					payStatusLabel := "Pending"
					if strings.ToUpper(pStat) == "PAID" {
						payStatusLabel = "Paid"
					}
					orders = append(orders, map[string]interface{}{
						"id":               id,
						"order_id":         oid,
						"tenant_id":        tID,
						"customer_name":    cName,
						"customer_phone":   cPhone,
						"delivery_address": dAddr,
						"items_summary":    "Catalog Order",
						"total_amount":     amt,
						"source":           source,
						"payment_mode":     pMode,
						"payment_status":   payStatusLabel,
						"order_status":     formatGoOrderStatus(oStat),
						"created_at":       created.Format(time.RFC3339),
					})
				}
			}
		}

		lRows, lErr := DB.Query(`SELECT id, COALESCE(username, 'admin'), COALESCE(customer_phone, ''), COALESCE(inquiry_text, ''), COALESCE(status, 'Captured'), COALESCE(created_at, NOW())
			FROM leads WHERE ($1 = '' OR LOWER(username)=LOWER($1)) ORDER BY id DESC LIMIT 50`, tenant)
		if lErr == nil {
			defer lRows.Close()
			for lRows.Next() {
				var id int
				var u, phone, inq, st string
				var created time.Time
				if err := lRows.Scan(&id, &u, &phone, &inq, &st, &created); err == nil {
					leads = append(leads, map[string]interface{}{
						"id":             id,
						"username":       u,
						"customer_phone": phone,
						"inquiry_text":   inq,
						"status":         st,
						"created_at":     created.Format(time.RFC3339),
					})
				}
			}
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status": "success",
		"orders": orders,
		"leads":  leads,
	})
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
			AccountName             string      `json:"account_name"`
			Email                   string      `json:"email"`
			Phone                   string      `json:"phone"`
			BusinessName            string      `json:"business_name"`
			BusinessType            string      `json:"business_type"`
			NotificationPhone       string      `json:"notification_phone"`
			AIProvider              string      `json:"ai_provider"`
			AIModel                 string      `json:"ai_model"`
			FullAddress             string      `json:"full_address"`
			LocalArea               string      `json:"local_area"`
			StoreSlug               string      `json:"store_slug"`
			LogoURL                 *string     `json:"logo_url"`
			BannerURL               *string     `json:"banner_url"`
			PromotionalBanners      interface{} `json:"promotional_banners"`
			Tagline                 string      `json:"tagline"`
			ThemeColor              string      `json:"theme_color"`
			AnnouncementBar         *string     `json:"announcement_bar"`
			MinOrderAmount          interface{} `json:"min_order_amount"`
			PackagingCharge         interface{} `json:"packaging_charge"`
			AllowCOD                *bool       `json:"allow_cod"`
			PaytmVPA                *string     `json:"paytm_vpa"`
			PaytmMID                *string     `json:"paytm_mid"`
			SocialInstagram         string      `json:"social_instagram"`
			SocialFacebook          string      `json:"social_facebook"`
			SocialWhatsApp          string      `json:"social_whatsapp"`
			GSTINNumber             string      `json:"gstin_number"`
			PrivacyPolicy           string      `json:"privacy_policy"`
			TermsConditions         string      `json:"terms_conditions"`
			RefundPolicy            string      `json:"refund_policy"`
			ShippingPolicy          string      `json:"shipping_policy"`
			Latitude                interface{} `json:"latitude"`
			Longitude               interface{} `json:"longitude"`
			MaxDeliveryRadiusKM     interface{} `json:"max_delivery_radius_km"`
			FreeDeliveryRadiusKM    interface{} `json:"free_delivery_radius_km"`
			DeliveryChargeAmount    interface{} `json:"delivery_charge_amount"`
			MinFreeDeliveryOrder    interface{} `json:"min_free_delivery_order"`
			StoreOpenStatus         *bool       `json:"store_open_status"`
			OperatingHours          string      `json:"operating_hours"`
			DeliveryModes           interface{} `json:"delivery_modes"`
			CustomDomain            string      `json:"custom_domain"`
			DomainStatus            string      `json:"domain_status"`
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
		minFreeOrderVal := parseCoordinateVal(req.MinFreeDeliveryOrder)
		minOrderVal := parseCoordinateVal(req.MinOrderAmount)
		pkgChargeVal := parseCoordinateVal(req.PackagingCharge)

		cleanSlug := strings.ToLower(strings.TrimSpace(req.StoreSlug))
		cleanSlug = regexp.MustCompile(`[^a-z0-9_]+`).ReplaceAllString(cleanSlug, "_")
		cleanSlug = strings.Trim(cleanSlug, "_")

		if DB != nil {
			if req.AccountName != "" {
				_, _ = DB.Exec("UPDATE users SET account_name=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.AccountName), username)
			}
			if req.Email != "" {
				_, _ = DB.Exec("UPDATE users SET email=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.Email), username)
			}
			if req.Phone != "" {
				_, _ = DB.Exec("UPDATE users SET phone=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimPrefix(strings.TrimSpace(req.Phone), "+"), username)
			}
			if req.BusinessName != "" {
				_, _ = DB.Exec("UPDATE users SET business_name=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.BusinessName), username)
			}
			if req.BusinessType != "" {
				_, _ = DB.Exec("UPDATE users SET business_type=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.BusinessType), username)
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
			if req.StoreOpenStatus != nil {
				_, _ = DB.Exec("UPDATE users SET store_open_status=$1 WHERE LOWER(username)=LOWER($2)", *req.StoreOpenStatus, username)
			}
			if req.AllowCOD != nil {
				_, _ = DB.Exec("UPDATE users SET allow_cod=$1 WHERE LOWER(username)=LOWER($2)", *req.AllowCOD, username)
			}
			if req.AnnouncementBar != nil {
				_, _ = DB.Exec("UPDATE users SET announcement_bar=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(*req.AnnouncementBar), username)
			}
			if req.PaytmVPA != nil {
				_, _ = DB.Exec("UPDATE users SET paytm_vpa=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(*req.PaytmVPA), username)
			}
			if req.PaytmMID != nil {
				_, _ = DB.Exec("UPDATE users SET paytm_mid=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(*req.PaytmMID), username)
			}
			if req.MinOrderAmount != nil {
				_, _ = DB.Exec("UPDATE users SET min_order_amount=$1 WHERE LOWER(username)=LOWER($2)", minOrderVal, username)
			}
			if req.PackagingCharge != nil {
				_, _ = DB.Exec("UPDATE users SET packaging_charge=$1 WHERE LOWER(username)=LOWER($2)", pkgChargeVal, username)
			}
			if cleanSlug != "" {
				_, _ = DB.Exec("UPDATE users SET store_slug=$1 WHERE LOWER(username)=LOWER($2)", cleanSlug, username)
			}
			if req.LogoURL != nil {
				_, _ = DB.Exec("UPDATE users SET logo_url=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(*req.LogoURL), username)
			}
			if req.BannerURL != nil {
				_, _ = DB.Exec("UPDATE users SET banner_url=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(*req.BannerURL), username)
			}
			if req.PromotionalBanners != nil {
				bannersBytes, errPB := json.Marshal(req.PromotionalBanners)
				if errPB == nil {
					_, _ = DB.Exec("UPDATE users SET promotional_banners=$1::jsonb WHERE LOWER(username)=LOWER($2)", string(bannersBytes), username)
					_, _ = DB.Exec("UPDATE business_profiles SET promotional_banners=$1::jsonb WHERE LOWER(username)=LOWER($2)", string(bannersBytes), username)
					var bList []map[string]interface{}
					if json.Unmarshal(bannersBytes, &bList) == nil && len(bList) > 0 {
						if firstImg, ok := bList[0]["image_url"].(string); ok && firstImg != "" {
							_, _ = DB.Exec("UPDATE users SET banner_url=$1 WHERE LOWER(username)=LOWER($2)", firstImg, username)
						}
					}
				}
			}
			if req.DeliveryModes != nil {
				modesBytes, errDM := json.Marshal(req.DeliveryModes)
				if errDM == nil {
					_, _ = DB.Exec("UPDATE users SET delivery_modes=$1::jsonb WHERE LOWER(username)=LOWER($2)", string(modesBytes), username)
				}
			}
			if req.Tagline != "" {
				_, _ = DB.Exec("UPDATE users SET tagline=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.Tagline), username)
			}
			if req.ThemeColor != "" {
				_, _ = DB.Exec("UPDATE users SET theme_color=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.ThemeColor), username)
			}
			if req.SocialInstagram != "" || req.SocialFacebook != "" || req.SocialWhatsApp != "" {
				_, _ = DB.Exec("UPDATE users SET social_instagram=$1, social_facebook=$2, social_whatsapp=$3 WHERE LOWER(username)=LOWER($4)", strings.TrimSpace(req.SocialInstagram), strings.TrimSpace(req.SocialFacebook), strings.TrimSpace(req.SocialWhatsApp), username)
			}
			if req.GSTINNumber != "" {
				_, _ = DB.Exec("UPDATE users SET gstin_number=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.GSTINNumber), username)
			}
			if req.PrivacyPolicy != "" {
				_, _ = DB.Exec("UPDATE users SET privacy_policy=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.PrivacyPolicy), username)
			}
			if req.TermsConditions != "" {
				_, _ = DB.Exec("UPDATE users SET terms_conditions=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.TermsConditions), username)
			}
			if req.RefundPolicy != "" {
				_, _ = DB.Exec("UPDATE users SET refund_policy=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.RefundPolicy), username)
			}
			if req.ShippingPolicy != "" {
				_, _ = DB.Exec("UPDATE users SET shipping_policy=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.ShippingPolicy), username)
			}
			if req.OperatingHours != "" {
				_, _ = DB.Exec("UPDATE users SET operating_hours=$1 WHERE LOWER(username)=LOWER($2)", strings.TrimSpace(req.OperatingHours), username)
			}
			if req.CustomDomain != "" {
				cleanDomain := strings.ToLower(strings.TrimSpace(req.CustomDomain))
				cleanDomain = strings.TrimPrefix(cleanDomain, "https://")
				cleanDomain = strings.TrimPrefix(cleanDomain, "http://")
				cleanDomain = strings.TrimSuffix(cleanDomain, "/")
				domStat := req.DomainStatus
				if domStat == "" {
					domStat = "pending_dns"
				}
				_, _ = DB.Exec("UPDATE users SET custom_domain=$1, domain_status=$2 WHERE LOWER(username)=LOWER($3)", cleanDomain, domStat, username)
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
				delivery_charge_amount = CASE WHEN $7 >= 0 THEN $7 ELSE delivery_charge_amount END,
				min_free_delivery_order = CASE WHEN $8 >= 0 THEN $8 ELSE min_free_delivery_order END
				WHERE LOWER(username)=LOWER($9)`, strings.TrimSpace(req.FullAddress), strings.TrimSpace(req.LocalArea), latVal, lngVal, maxRadVal, freeRadVal, delChargeVal, minFreeOrderVal, username)

			whatsapp.InvalidateUserConfigCache(username)
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":                    "success",
			"message":                   "Store management settings saved successfully!",
			"full_address":              req.FullAddress,
			"local_area":                req.LocalArea,
			"store_slug":                cleanSlug,
			"tagline":                   req.Tagline,
			"latitude":                  latVal,
			"longitude":                 lngVal,
			"max_delivery_radius_km":    maxRadVal,
			"free_delivery_radius_km":   freeRadVal,
			"delivery_charge_amount":    delChargeVal,
			"min_free_delivery_order":   minFreeOrderVal,
			"require_customer_location": req.RequireCustomerLocation,
			"store_open_status":         req.StoreOpenStatus,
			"custom_domain":             req.CustomDomain,
		})
		return
	}

	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	var email, accountName, bName, bType, userType, phone, notificationPhone, waJid, statusStr, aiProvider, aiModel, createdAt, fullAddress, localArea string
	var storeSlug, logoURL, bannerURL, tagline, bannersJSON string
	var themeColor, announcementBar, paytmVPA, paytmMID, socialInsta, socialFb, socialWa, gstinNum, privacyPol, termsCond, refundPol, shippingPol, opHours, deliveryModesJSON, customDomain, domainStatus string
	var latVal, lngVal, maxRadVal, freeRadVal, delChargeVal, minFreeOrder, minOrderAmt, pkgCharge float64
	var autoReply, automationAccess, reqLoc, storeOpen, allowCOD bool

	if DB != nil {
		err := DB.QueryRow(`SELECT 
			COALESCE(email, ''), COALESCE(account_name, ''), COALESCE(business_name, account_name, ''), COALESCE(business_type, 'Kirana / General Store'), COALESCE(user_type, 'business_user'), 
			COALESCE(phone, ''), COALESCE(notification_phone, ''), COALESCE(wa_jid, ''), 
			COALESCE(status, 'Disconnected'), COALESCE(auto_reply, true), COALESCE(automation_access, true), 
			COALESCE(ai_provider, 'gemini'), COALESCE(ai_model, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY'), 'Active'),
			COALESCE(full_address, ''), COALESCE(local_area, ''), COALESCE(latitude, 0.0), COALESCE(longitude, 0.0),
			COALESCE(max_delivery_radius_km, 15.0), COALESCE(free_delivery_radius_km, 3.0), COALESCE(delivery_charge_amount, 40.0), COALESCE(require_customer_location, false),
			COALESCE(store_slug, username), COALESCE(logo_url, ''), COALESCE(banner_url, ''), COALESCE(tagline, ''),
			COALESCE(promotional_banners::text, '[]'),
			COALESCE(theme_color, 'emerald'), COALESCE(announcement_bar, ''), COALESCE(min_order_amount, 0.0), COALESCE(packaging_charge, 0.0), COALESCE(allow_cod, true), COALESCE(paytm_vpa, ''), COALESCE(paytm_mid, ''),
			COALESCE(social_instagram, ''), COALESCE(social_facebook, ''), COALESCE(social_whatsapp, ''),
			COALESCE(gstin_number, ''), COALESCE(privacy_policy, ''), COALESCE(terms_conditions, ''), COALESCE(refund_policy, ''), COALESCE(shipping_policy, ''),
			COALESCE(min_free_delivery_order, 0.0), COALESCE(store_open_status, true), COALESCE(operating_hours, '9:00 AM - 10:00 PM'),
			COALESCE(delivery_modes::text, '["doorstep", "pickup"]'), COALESCE(custom_domain, ''), COALESCE(domain_status, 'not_configured')
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&email, &accountName, &bName, &bType, &userType, &phone, &notificationPhone, &waJid, &statusStr, &autoReply, &automationAccess, &aiProvider, &aiModel, &createdAt, &fullAddress, &localArea, &latVal, &lngVal, &maxRadVal, &freeRadVal, &delChargeVal, &reqLoc, &storeSlug, &logoURL, &bannerURL, &tagline, &bannersJSON, &themeColor, &announcementBar, &minOrderAmt, &pkgCharge, &allowCOD, &paytmVPA, &paytmMID, &socialInsta, &socialFb, &socialWa, &gstinNum, &privacyPol, &termsCond, &refundPol, &shippingPol, &minFreeOrder, &storeOpen, &opHours, &deliveryModesJSON, &customDomain, &domainStatus)

		if err == nil {
			if storeSlug == "" {
				storeSlug = username
			}

			var parsedBanners []interface{}
			if errJSON := json.Unmarshal([]byte(bannersJSON), &parsedBanners); errJSON != nil || len(parsedBanners) == 0 {
				if bannerURL != "" {
					parsedBanners = []interface{}{
						map[string]interface{}{
							"image_url":   bannerURL,
							"target_link": "",
						},
					}
				} else {
					parsedBanners = []interface{}{}
				}
			}

			var parsedModes []interface{}
			_ = json.Unmarshal([]byte(deliveryModesJSON), &parsedModes)

			respondJSON(w, 200, map[string]interface{}{
				"status":                    "success",
				"username":                  username,
				"email":                     email,
				"account_name":              accountName,
				"business_name":             bName,
				"business_type":             bType,
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
				"min_free_delivery_order":   minFreeOrder,
				"require_customer_location": reqLoc,
				"store_open_status":         storeOpen,
				"operating_hours":           opHours,
				"delivery_modes":            parsedModes,
				"store_slug":                storeSlug,
				"logo_url":                  logoURL,
				"banner_url":                bannerURL,
				"promotional_banners":       parsedBanners,
				"tagline":                   tagline,
				"theme_color":               themeColor,
				"announcement_bar":          announcementBar,
				"min_order_amount":          minOrderAmt,
				"packaging_charge":          pkgCharge,
				"allow_cod":                 allowCOD,
				"paytm_vpa":                 paytmVPA,
				"paytm_mid":                 paytmMID,
				"social_instagram":          socialInsta,
				"social_facebook":           socialFb,
				"social_whatsapp":           socialWa,
				"gstin_number":              gstinNum,
				"privacy_policy":            privacyPol,
				"terms_conditions":          termsCond,
				"refund_policy":             refundPol,
				"shipping_policy":           shippingPol,
				"custom_domain":             customDomain,
				"domain_status":             domainStatus,
			})
			return
		}
	}

	respondJSON(w, 404, map[string]string{"status": "error", "message": "User profile not found"})
}

// MEDIA IMAGE CLEAR HANDLER: DELETE or POST /api/media/image (Sets image_url to null/empty in DB)
func MediaImageClearHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" && r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Type     string `json:"type"` // "product", "logo", "banner"
		ID       int    `json:"id"`
		Username string `json:"username"`
		Index    int    `json:"index"` // for promotional_banners
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	if req.Type == "" {
		req.Type = r.URL.Query().Get("type")
	}
	username := cleanUsername(req.Username)
	if username == "" {
		username = "admin"
	}

	if DB == nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
		return
	}

	switch strings.ToLower(req.Type) {
	case "product":
		if req.ID > 0 {
			_, _ = DB.Exec(`UPDATE products SET image_url = '', product_image_url = '' WHERE id = $1 AND LOWER(username) = LOWER($2)`, req.ID, username)
		}
	case "logo":
		_, _ = DB.Exec(`UPDATE users SET logo_url = '' WHERE LOWER(username) = LOWER($1)`, username)
	case "banner":
		var curBannersJSON string
		_ = DB.QueryRow(`SELECT COALESCE(promotional_banners::text, '[]') FROM users WHERE LOWER(username) = LOWER($1)`, username).Scan(&curBannersJSON)
		var bList []map[string]interface{}
		if json.Unmarshal([]byte(curBannersJSON), &bList) == nil && len(bList) > 0 {
			if req.Index >= 0 && req.Index < len(bList) {
				bList = append(bList[:req.Index], bList[req.Index+1:]...)
				updatedBytes, _ := json.Marshal(bList)
				_, _ = DB.Exec(`UPDATE users SET promotional_banners = $1::jsonb WHERE LOWER(username) = LOWER($2)`, string(updatedBytes), username)
				_, _ = DB.Exec(`UPDATE business_profiles SET promotional_banners = $1::jsonb WHERE LOWER(username) = LOWER($2)`, string(updatedBytes), username)
			}
			if len(bList) == 0 {
				_, _ = DB.Exec(`UPDATE users SET banner_url = '' WHERE LOWER(username) = LOWER($1)`, username)
			} else {
				if firstImg, ok := bList[0]["image_url"].(string); ok {
					_, _ = DB.Exec(`UPDATE users SET banner_url = $1 WHERE LOWER(username) = LOWER($2)`, firstImg, username)
				}
			}
		} else {
			_, _ = DB.Exec(`UPDATE users SET banner_url = '' WHERE LOWER(username) = LOWER($1)`, username)
		}
	}

	whatsapp.InvalidateUserConfigCache(username)
	respondJSON(w, 200, map[string]interface{}{
		"status":  "success",
		"message": "Image reference cleared from database",
	})
}

// BULK STORE DELETION: DELETE /api/admin/store/:tenant_slug
func AdminStoreDeleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" && r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract slug from URL or query parameter
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	if slug == "" {
		slug = strings.TrimSpace(r.URL.Query().Get("tenant_slug"))
	}
	if slug == "" {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 4 { // /api/admin/store/{tenant_slug}
			slug = strings.TrimSpace(parts[3])
		}
	}

	if slug == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Tenant slug is required"})
		return
	}

	if DB == nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
		return
	}

	// Find tenant details
	var username, storeSlug string
	err := DB.QueryRow(`SELECT username, COALESCE(store_slug, username) FROM users WHERE LOWER(store_slug) = LOWER($1) OR LOWER(username) = LOWER($1) LIMIT 1`, slug).Scan(&username, &storeSlug)
	if err != nil {
		respondJSON(w, 404, map[string]string{"status": "error", "message": "Store not found for slug: " + slug})
		return
	}

	// 1. Cascading Relational Deletions across all tenant tables
	_, _ = DB.Exec(`DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM orders WHERE LOWER(tenant_id) = LOWER($1) OR LOWER(username) = LOWER($1))`, username)
	_, _ = DB.Exec(`DELETE FROM orders WHERE LOWER(tenant_id) = LOWER($1) OR LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM customer_order_states WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM active_carts WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM products WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM categories WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM leads WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM customer_chats WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM customers WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM campaigns WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM campaign_logs WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM tenant_whatsapp_sessions WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM channel_forwarding_rules WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM magic_links WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM business_profiles WHERE LOWER(username) = LOWER($1)`, username)
	_, _ = DB.Exec(`DELETE FROM users WHERE LOWER(username) = LOWER($1)`, username)

	whatsapp.InvalidateUserConfigCache(username)

	// 2. Background Goroutine: Request Cloudflare Worker to delete all R2 media folder prefixed with tenantSlug/ and username/
	go func(targetSlug, targetUser string) {
		httpClient := &http.Client{Timeout: 30 * time.Second}
		prefixes := []string{targetSlug, targetUser}
		for _, p := range prefixes {
			if p == "" {
				continue
			}
			workerURL := fmt.Sprintf("https://wamart-cloudflare.rkmtech633.workers.dev/delete-folder?prefix=%s/", url.QueryEscape(p))
			req, errReq := http.NewRequest("DELETE", workerURL, nil)
			if errReq == nil {
				resp, errDo := httpClient.Do(req)
				if errDo == nil {
					_ = resp.Body.Close()
				}
			}
		}
	}(storeSlug, username)

	respondJSON(w, 200, map[string]interface{}{
		"status":      "success",
		"message":     fmt.Sprintf("Store '%s' and all associated data permanently deleted", slug),
		"tenant_slug": storeSlug,
		"username":    username,
	})
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
