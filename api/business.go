package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"wa-server/whatsapp"
)

// BUSINESS DASHBOARD STATS
func BusinessDashboardHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	totalChats := 0
	totalProducts := 0
	totalLeads := 0
	waConnected := false
	waJID := ""

	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(DISTINCT customer_phone) FROM customer_chats WHERE LOWER(username)=LOWER($1)", username).Scan(&totalChats)
		_ = DB.QueryRow("SELECT COUNT(*) FROM products WHERE LOWER(username)=LOWER($1)", username).Scan(&totalProducts)
		_ = DB.QueryRow("SELECT COUNT(*) FROM leads WHERE LOWER(username)=LOWER($1)", username).Scan(&totalLeads)

		var statusStr string
		_ = DB.QueryRow("SELECT COALESCE(status, 'Disconnected'), COALESCE(wa_jid, '') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&statusStr, &waJID)
		if statusStr == "Connected" || waJID != "" {
			waConnected = true
		}
	}

	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		waConnected = true
		if client.Store.ID != nil {
			waJID = client.Store.ID.User
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":         "success",
		"total_chats":    totalChats,
		"total_products": totalProducts,
		"total_leads":    totalLeads,
		"wa_connected":   waConnected,
		"wa_jid":         waJID,
	})
}

// PRODUCT & SERVICE CATALOG HANDLER (GET / POST / DELETE /api/products)
func ProductsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		username := cleanUsername(r.URL.Query().Get("username"))
		if username == "" {
			username = "admin"
		}

		type ProductItem struct {
			ID                  int         `json:"id"`
			Name                string      `json:"name"`
			Price               string      `json:"price"`
			Description         string      `json:"description"`
			ItemType            string      `json:"item_type"`
			UnitType            string      `json:"unit_type"`
			Variants            interface{} `json:"variants"`
			WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
		}

		var items []ProductItem

		if DB != nil {
			rows, err := DB.Query(`SELECT id, name, price, COALESCE(description, ''), COALESCE(item_type, 'product'), COALESCE(unit_type, 'custom'), COALESCE(variants::text, '[]'), COALESCE(whatsapp_catalog_link, '')
				FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)

			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var item ProductItem
					var variantsStr string
					if err := rows.Scan(&item.ID, &item.Name, &item.Price, &item.Description, &item.ItemType, &item.UnitType, &variantsStr, &item.WhatsAppCatalogLink); err == nil {
						var parsedVariants interface{}
						if json.Unmarshal([]byte(variantsStr), &parsedVariants) == nil {
							item.Variants = parsedVariants
						} else {
							item.Variants = []interface{}{}
						}
						items = append(items, item)
					}
				}
			}
		}

		if items == nil {
			items = []ProductItem{}
		}

		respondJSON(w, 200, map[string]interface{}{"products": items})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username            string      `json:"username"`
			Name                string      `json:"name"`
			Price               string      `json:"price"`
			Description         string      `json:"description"`
			ItemType            string      `json:"item_type"`
			UnitType            string      `json:"unit_type"`
			Variants            interface{} `json:"variants"`
			WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Product Name is compulsory!"})
			return
		}

		priceStr := strings.TrimSpace(req.Price)
		if priceStr == "" {
			if strings.TrimSpace(req.WhatsAppCatalogLink) != "" {
				priceStr = "WhatsApp Catalog Item"
			} else {
				respondJSON(w, 400, map[string]string{"status": "error", "message": "Product Price or WhatsApp Catalog Link is required!"})
				return
			}
		}

		variantsBytes, _ := json.Marshal(req.Variants)
		variantsStr := string(variantsBytes)
		if variantsStr == "" || variantsStr == "null" {
			variantsStr = "[]"
		}

		itemType := req.ItemType
		if itemType == "" {
			itemType = "product"
		}
		unitType := req.UnitType
		if unitType == "" {
			unitType = "custom"
		}

		if DB != nil {
			var newID int
			err := DB.QueryRow(`INSERT INTO products (username, name, price, description, item_type, unit_type, variants, whatsapp_catalog_link)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
				username, req.Name, priceStr, req.Description, itemType, unitType, variantsStr, req.WhatsAppCatalogLink).Scan(&newID)

			if err != nil {
				respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to save product in database: " + err.Error()})
				return
			}

			respondJSON(w, 200, map[string]interface{}{
				"status":  "success",
				"id":      newID,
				"message": "Product saved to catalog and Neon PostgreSQL database!",
			})
			return
		}

		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
		return
	}

	if r.Method == "DELETE" {
		idStr := r.URL.Query().Get("id")
		username := cleanUsername(r.URL.Query().Get("username"))

		if idStr != "" && DB != nil {
			_, err := DB.Exec("DELETE FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
			if err == nil {
				respondJSON(w, 200, map[string]string{"status": "success", "message": "Product deleted from database"})
				return
			}
		}

		respondJSON(w, 400, map[string]string{"status": "error", "message": "Unable to delete product"})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// CAPTURED LEADS LIST (GET /api/leads)
func LeadsHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	type LeadItem struct {
		ID            int    `json:"id"`
		CustomerPhone string `json:"customer_phone"`
		InquiryText   string `json:"inquiry_text"`
		Status        string `json:"status"`
		CreatedAt     string `json:"created_at"`
	}

	var leads []LeadItem

	if DB != nil {
		rows, err := DB.Query(`SELECT id, COALESCE(customer_phone, ''), COALESCE(inquiry_text, ''), COALESCE(status, 'Captured'), COALESCE(TO_CHAR(created_at, 'DD Mon HH24:MI'), 'Recent')
			FROM leads WHERE LOWER(username)=LOWER($1) ORDER BY id DESC LIMIT 50`, username)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item LeadItem
				if err := rows.Scan(&item.ID, &item.CustomerPhone, &item.InquiryText, &item.Status, &item.CreatedAt); err == nil {
					leads = append(leads, item)
				}
			}
		}
	}

	if leads == nil {
		leads = []LeadItem{}
	}

	respondJSON(w, 200, map[string]interface{}{"leads": leads})
}

// USER CONFIGURATION (GET /api/user/config)
func UserConfigHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	var email, accountName, userType, phone, notificationPhone, waJid, statusStr string
	var autoReply, automationAccess bool

	if DB != nil {
		_ = DB.QueryRow(`SELECT COALESCE(email, ''), COALESCE(account_name, ''), COALESCE(user_type, 'business_user'), COALESCE(phone, ''), COALESCE(notification_phone, ''), COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected'), COALESCE(auto_reply, true), COALESCE(automation_access, true)
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&email, &accountName, &userType, &phone, &notificationPhone, &waJid, &statusStr, &autoReply, &automationAccess)
	}

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
	})
}

// MEDIA CATALOG ALIAS (GET /api/media)
func MediaCatalogHandler(w http.ResponseWriter, r *http.Request) {
	ProductsHandler(w, r)
}
