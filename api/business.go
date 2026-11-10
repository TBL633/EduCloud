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
		_ = DB.QueryRow("SELECT COUNT(*) FROM leads WHERE LOWER(username)=LOWER($1) AND status != 'Captured Lead'", username).Scan(&totalLeads)

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
		"leads_captured": totalLeads,
		"wa_connected":   waConnected,
		"wa_jid":         waJID,
	})
}

// CATEGORIES MANAGEMENT HANDLER (GET / POST / DELETE /api/categories)
func CategoriesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		username := cleanUsername(r.URL.Query().Get("username"))
		if username == "" {
			username = "admin"
		}

		type CategoryItem struct {
			ID               int    `json:"id"`
			CategoryName     string `json:"category_name"`
			Name             string `json:"name"`
			CategoryImageURL string `json:"category_image_url"`
			ParentID         int    `json:"parent_id"`
			ParentName       string `json:"parent_name"`
			ProductCount     int    `json:"product_count"`
		}

		var categories []CategoryItem

		if DB != nil {
			rows, err := DB.Query(`SELECT c.id, c.category_name, COALESCE(c.category_image_url, ''), COALESCE(c.parent_id, 0), COALESCE(c.parent_name, ''),
				(SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(c.username) AND (p.category_id=c.id OR LOWER(TRIM(p.category))=LOWER(TRIM(c.category_name))))
				FROM categories c WHERE LOWER(c.username)=LOWER($1) ORDER BY c.id ASC`, username)

			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var item CategoryItem
					if err := rows.Scan(&item.ID, &item.CategoryName, &item.CategoryImageURL, &item.ParentID, &item.ParentName, &item.ProductCount); err == nil {
						item.Name = item.CategoryName
						categories = append(categories, item)
					}
				}
			}
		}

		if categories == nil {
			categories = []CategoryItem{}
		}

		respondJSON(w, 200, map[string]interface{}{"status": "success", "categories": categories})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username         string `json:"username"`
			CategoryName     string `json:"category_name"`
			Name             string `json:"name"`
			CategoryImageURL string `json:"category_image_url"`
			ParentID         int    `json:"parent_id"`
			ParentName       string `json:"parent_name"`
			ParentCategory   string `json:"parent_category"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		catName := strings.TrimSpace(req.CategoryName)
		if catName == "" {
			catName = strings.TrimSpace(req.Name)
		}
		if catName == "" {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Category Name is required!"})
			return
		}

		imgURL := strings.TrimSpace(req.CategoryImageURL)
		pName := strings.TrimSpace(req.ParentName)
		if pName == "" {
			pName = strings.TrimSpace(req.ParentCategory)
		}

		if DB != nil {
			var newID int
			err := DB.QueryRow(`INSERT INTO categories (username, category_name, category_image_url, parent_id, parent_name)
				VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (username, category_name) DO UPDATE SET
					category_image_url = CASE WHEN EXCLUDED.category_image_url != '' THEN EXCLUDED.category_image_url ELSE categories.category_image_url END,
					parent_id = EXCLUDED.parent_id,
					parent_name = EXCLUDED.parent_name
				RETURNING id`, username, catName, imgURL, req.ParentID, pName).Scan(&newID)

			if err != nil {
				respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to save category in database: " + err.Error()})
				return
			}

			whatsapp.InvalidateUserConfigCache(username)

			respondJSON(w, 200, map[string]interface{}{
				"status":             "success",
				"id":                 newID,
				"category_name":      catName,
				"category_image_url": imgURL,
				"parent_id":          req.ParentID,
				"parent_name":        pName,
				"message":            "Category saved successfully!",
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
			_, err := DB.Exec("DELETE FROM categories WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
			if err == nil {
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]string{"status": "success", "message": "Category deleted from database"})
				return
			}
		}

		respondJSON(w, 400, map[string]string{"status": "error", "message": "Unable to delete category"})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
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
			CategoryID          int         `json:"category_id"`
			Category            string      `json:"category"`
			CategoryName        string      `json:"category_name"`
			SubCategory         string      `json:"sub_category"`
			SubCategoryID       int         `json:"sub_category_id"`
			Name                string      `json:"name"`
			Price               string      `json:"price"`
			MRP                 float64     `json:"mrp"`
			SalePrice           float64     `json:"sale_price"`
			Description         string      `json:"description"`
			ItemType            string      `json:"item_type"`
			UnitType            string      `json:"unit_type"`
			Variants            interface{} `json:"variants"`
			WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
			WhatsAppURL         string      `json:"whatsapp_url"`
			ImageURL            string      `json:"image_url"`
			ProductImageURL     string      `json:"product_image_url"`
			Images              []string    `json:"images"`
			InStock             bool        `json:"in_stock"`
		}

		var items []ProductItem

		if DB != nil {
			rows, err := DB.Query(`SELECT id, COALESCE(category_id, 0), name, price, COALESCE(description, ''), COALESCE(item_type, 'product'), COALESCE(unit_type, 'custom'), COALESCE(variants::text, '[]'), COALESCE(whatsapp_catalog_link, ''), COALESCE(image_url, ''), COALESCE(category, ''), COALESCE(in_stock, true), COALESCE(mrp, 0), COALESCE(sale_price, 0), COALESCE(product_image_url, ''), COALESCE(images::text, '[]'), COALESCE(sub_category, ''), COALESCE(sub_category_id, 0)
				FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)

			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var item ProductItem
					var variantsStr string
					var imagesStr string
					if err := rows.Scan(&item.ID, &item.CategoryID, &item.Name, &item.Price, &item.Description, &item.ItemType, &item.UnitType, &variantsStr, &item.WhatsAppCatalogLink, &item.ImageURL, &item.Category, &item.InStock, &item.MRP, &item.SalePrice, &item.ProductImageURL, &imagesStr, &item.SubCategory, &item.SubCategoryID); err == nil {
						item.CategoryName = item.Category
						item.WhatsAppURL = item.WhatsAppCatalogLink
						_ = json.Unmarshal([]byte(imagesStr), &item.Images)
						if item.Images == nil {
							item.Images = []string{}
						}
						if len(item.Images) == 0 && item.ProductImageURL != "" {
							item.Images = []string{item.ProductImageURL}
						} else if len(item.Images) == 0 && item.ImageURL != "" {
							item.Images = []string{item.ImageURL}
						}

						if len(item.Images) > 0 {
							item.ProductImageURL = item.Images[0]
							item.ImageURL = item.Images[0]
						}

						if item.SalePrice > 0 && (item.Price == "" || item.Price == "Standard Pricing") {
							item.Price = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(item.Price, "₹", ""), "Rs.", ""))
						}
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

	if r.Method == "POST" || r.Method == "PUT" {
		var req struct {
			ID                  int         `json:"id"`
			Username            string      `json:"username"`
			CategoryID          int         `json:"category_id"`
			Category            string      `json:"category"`
			CategoryName        string      `json:"category_name"`
			Name                string      `json:"name"`
			Price               string      `json:"price"`
			MRP                 float64     `json:"mrp"`
			SalePrice           float64     `json:"sale_price"`
			Description         string      `json:"description"`
			Details             string      `json:"details"`
			ItemType            string      `json:"item_type"`
			UnitType            string      `json:"unit_type"`
			Variants            interface{} `json:"variants"`
			WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
			WhatsAppURL         string      `json:"whatsapp_url"`
			ImageURL            string      `json:"image_url"`
			ProductImageURL     string      `json:"product_image_url"`
			Images              []string    `json:"images"`
			InStock             *bool       `json:"in_stock"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		inStockVal := true
		if req.InStock != nil {
			inStockVal = *req.InStock
		}

		// Support direct toggle in_stock if req.ID > 0 and req.Name is empty
		if req.ID > 0 && strings.TrimSpace(req.Name) == "" {
			if DB != nil {
				_, err := DB.Exec(`UPDATE products SET in_stock = $1 WHERE id = $2 AND LOWER(username) = LOWER($3)`, inStockVal, req.ID, username)
				if err != nil {
					respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update stock status: " + err.Error()})
					return
				}
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{"status": "success", "message": "Stock status updated"})
				return
			}
		}

		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" {
			respondJSON(w, 400, map[string]string{"status": "error", "message": "Product Name is compulsory!"})
			return
		}

		catName := strings.TrimSpace(req.CategoryName)
		if catName == "" {
			catName = strings.TrimSpace(req.Category)
		}

		images := req.Images
		if images == nil {
			images = []string{}
		}

		imgURL := strings.TrimSpace(req.ProductImageURL)
		if imgURL == "" {
			imgURL = strings.TrimSpace(req.ImageURL)
		}

		if len(images) > 0 {
			imgURL = images[0]
		} else if imgURL != "" {
			images = []string{imgURL}
		}

		// Ensure max 3 images
		if len(images) > 3 {
			images = images[:3]
		}

		imagesBytes, _ := json.Marshal(images)
		imagesJSON := string(imagesBytes)

		waLink := strings.TrimSpace(req.WhatsAppCatalogLink)
		if waLink == "" {
			waLink = strings.TrimSpace(req.WhatsAppURL)
		}

		salePriceVal := req.SalePrice
		mrpVal := req.MRP

		priceStr := strings.TrimSpace(req.Price)
		if priceStr == "" && salePriceVal > 0 {
			priceStr = fmt.Sprintf("₹%.2f", salePriceVal)
		}
		if priceStr == "" {
			if salePriceVal > 0 {
				priceStr = fmt.Sprintf("₹%.2f", salePriceVal)
			} else if waLink != "" {
				priceStr = "WhatsApp Catalog Item"
			} else {
				priceStr = "0"
			}
		}

		descStr := strings.TrimSpace(req.Description)
		if descStr == "" {
			descStr = strings.TrimSpace(req.Details)
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
			if req.ID > 0 {
				_, err := DB.Exec(`UPDATE products SET category_id=$1, category=$2, name=$3, description=$4, mrp=$5, sale_price=$6, price=$7, item_type=$8, unit_type=$9, variants=$10::jsonb, whatsapp_catalog_link=$11, image_url=$12, product_image_url=$12, in_stock=$13, images=$14::jsonb WHERE id=$15 AND LOWER(username)=LOWER($16)`,
					req.CategoryID, catName, req.Name, descStr, mrpVal, salePriceVal, priceStr, itemType, unitType, variantsStr, waLink, imgURL, inStockVal, imagesJSON, req.ID, username)
				if err != nil {
					respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update product in database: " + err.Error()})
					return
				}
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{"status": "success", "id": req.ID, "image_url": imgURL, "images": images, "message": "Product updated successfully!"})
				return
			}

			var newID int
			err := DB.QueryRow(`INSERT INTO products (username, category_id, category, name, description, mrp, sale_price, price, item_type, unit_type, variants, whatsapp_catalog_link, image_url, product_image_url, in_stock, images)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $13, $14, $15::jsonb) RETURNING id`,
				username, req.CategoryID, catName, req.Name, descStr, mrpVal, salePriceVal, priceStr, itemType, unitType, variantsStr, waLink, imgURL, inStockVal, imagesJSON).Scan(&newID)

			if err != nil {
				respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to save product in database: " + err.Error()})
				return
			}

			whatsapp.InvalidateUserConfigCache(username)

			respondJSON(w, 200, map[string]interface{}{
				"status":    "success",
				"id":        newID,
				"image_url": imgURL,
				"images":    images,
				"message":   "Product saved to catalog and Neon PostgreSQL database!",
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
			var imagesStr string
			var imgURL string
			_ = DB.QueryRow("SELECT COALESCE(images::text, '[]'), COALESCE(image_url, '') FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username).Scan(&imagesStr, &imgURL)

			var deletedImages []string
			_ = json.Unmarshal([]byte(imagesStr), &deletedImages)
			if len(deletedImages) == 0 && imgURL != "" {
				deletedImages = append(deletedImages, imgURL)
			}

			_, err := DB.Exec("DELETE FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
			if err == nil {
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{"status": "success", "message": "Product deleted from database", "deleted_images": deletedImages})
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
		rows, err := DB.Query(`SELECT id, COALESCE(customer_phone, ''), COALESCE(inquiry_text, ''), COALESCE(status, 'Order Placed'), COALESCE(TO_CHAR(created_at, 'DD Mon HH24:MI'), 'Recent')
			FROM leads WHERE LOWER(username)=LOWER($1) AND status != 'Captured Lead' AND LENGTH(customer_phone) >= 10 AND LENGTH(customer_phone) <= 13 AND customer_phone NOT LIKE '117%' AND customer_phone NOT LIKE '223%' ORDER BY id DESC LIMIT 50`, username)

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

	var email, accountName, userType, phone, notificationPhone, waJid, statusStr, fullAddress, localArea string
	var latVal, lngVal, maxRadVal, freeRadVal, delChargeVal float64
	var autoReply, automationAccess, reqLoc bool

	if DB != nil {
		_ = DB.QueryRow(`SELECT COALESCE(email, ''), COALESCE(account_name, ''), COALESCE(user_type, 'business_user'), COALESCE(phone, ''), COALESCE(notification_phone, ''), COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected'), COALESCE(auto_reply, true), COALESCE(automation_access, true), COALESCE(full_address, ''), COALESCE(local_area, ''), COALESCE(latitude, 0.0), COALESCE(longitude, 0.0), COALESCE(max_delivery_radius_km, 15.0), COALESCE(free_delivery_radius_km, 3.0), COALESCE(delivery_charge_amount, 40.0), COALESCE(require_customer_location, false)
			FROM users WHERE LOWER(username)=LOWER($1)`, username).
			Scan(&email, &accountName, &userType, &phone, &notificationPhone, &waJid, &statusStr, &autoReply, &automationAccess, &fullAddress, &localArea, &latVal, &lngVal, &maxRadVal, &freeRadVal, &delChargeVal, &reqLoc)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":                    "success",
		"username":                  username,
		"email":                     email,
		"account_name":              accountName,
		"user_type":                 userType,
		"phone":                     phone,
		"notification_phone":        notificationPhone,
		"wa_jid":                    waJid,
		"wa_status":                 statusStr,
		"auto_reply":                autoReply,
		"automation_access":         automationAccess,
		"full_address":              fullAddress,
		"local_area":                localArea,
		"latitude":                  latVal,
		"longitude":                 lngVal,
		"max_delivery_radius_km":    maxRadVal,
		"free_delivery_radius_km":   freeRadVal,
		"delivery_charge_amount":    delChargeVal,
		"require_customer_location": reqLoc,
	})
}

// MEDIA CATALOG ALIAS (GET /api/media)
func MediaCatalogHandler(w http.ResponseWriter, r *http.Request) {
	ProductsHandler(w, r)
}
