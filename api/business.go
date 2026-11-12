package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"wa-server/whatsapp"
)

func resolveRequestUsername(r *http.Request, fallback string) string {
	u := cleanUsername(r.URL.Query().Get("username"))
	if u != "" {
		return u
	}
	if fallback != "" {
		return cleanUsername(fallback)
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		tok := strings.TrimSpace(authHeader[7:])
		if strings.HasPrefix(tok, "wamart-token-") {
			extracted := cleanUsername(strings.TrimPrefix(tok, "wamart-token-"))
			if extracted != "" {
				return extracted
			}
		}
	}
	return "admin"
}

func formatGoOrderStatus(raw string) string {
	s := strings.ToUpper(strings.TrimSpace(raw))
	if s == "DELIVERED" || s == "COMPLETED" {
		return "Delivered"
	}
	if s == "OUT_FOR_DELIVERY" || s == "OUT FOR DELIVERY" || s == "ON_THE_WAY" || s == "ON THE WAY" {
		return "Out for Delivery"
	}
	if s == "DISPATCHED" || s == "SHIPPED" {
		return "Dispatched"
	}
	if s == "PROCESSING" || s == "PREPARING" || s == "PACKING" {
		return "Processing"
	}
	if s == "CANCELLED" || s == "CANCELED" {
		return "Cancelled"
	}
	return "New"
}

// BUSINESS DASHBOARD STATS (GET /api/business/dashboard & /api/business/dashboard/stats)
func BusinessDashboardHandler(w http.ResponseWriter, r *http.Request) {
	username := resolveRequestUsername(r, "")

	totalChats := 0
	totalProducts := 0
	totalLeads := 0
	leadsToday := 0
	aiRepliesToday := 0
	waConnected := false
	waJID := ""
	storeName := username
	storeSlug := username
	deliveryRadiusKm := 15.0
	freeDeliveryThreshold := 499.0
	operatingHours := "09:00 AM - 09:00 PM"

	grossSalesToday := 0.0
	grossSalesYesterday := 0.0
	totalOrdersToday := 0
	webOrdersToday := 0
	whatsappOrdersToday := 0
	upiCollectedAmount := 0.0
	codPendingAmount := 0.0

	now := time.Now()
	sevenDayLabels := make([]string, 7)
	sevenDayKeys := make([]string, 7)
	sevenDaySales := make([]float64, 7)
	sevenDayOrders := make([]int, 7)
	dayIndexMap := make(map[string]int)

	for i := 6; i >= 0; i-- {
		d := now.AddDate(0, 0, -i)
		idx := 6 - i
		key := d.Format("2006-01-02")
		sevenDayKeys[idx] = key
		sevenDayLabels[idx] = d.Format("Mon, 02 Jan")
		dayIndexMap[key] = idx
	}

	webOrders7d := 0
	whatsappOrders7d := 0
	webRevenue7d := 0.0
	whatsappRevenue7d := 0.0

	recentOrders := make([]map[string]interface{}, 0)
	lowStockItems := make([]map[string]interface{}, 0)

	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(DISTINCT customer_phone) FROM customer_chats WHERE LOWER(username)=LOWER($1)", username).Scan(&totalChats)
		_ = DB.QueryRow("SELECT COUNT(*) FROM customer_chats WHERE LOWER(username)=LOWER($1) AND (LOWER(role) IN ('assistant','ai','bot') OR LOWER(sender_type) IN ('ai','bot')) AND created_at >= CURRENT_DATE", username).Scan(&aiRepliesToday)
		_ = DB.QueryRow("SELECT COUNT(*) FROM products WHERE LOWER(username)=LOWER($1)", username).Scan(&totalProducts)
		_ = DB.QueryRow("SELECT COUNT(*) FROM leads WHERE LOWER(username)=LOWER($1) AND status != 'Captured Lead'", username).Scan(&totalLeads)
		_ = DB.QueryRow("SELECT COUNT(*) FROM leads WHERE LOWER(username)=LOWER($1) AND created_at >= CURRENT_DATE", username).Scan(&leadsToday)

		var statusStr string
		_ = DB.QueryRow(`SELECT COALESCE(NULLIF(store_name, ''), NULLIF(account_name, ''), username),
			COALESCE(NULLIF(store_slug, ''), username),
			COALESCE(delivery_radius_km, max_delivery_radius_km, 15),
			COALESCE(free_delivery_threshold, 499),
			COALESCE(status, 'Disconnected'),
			COALESCE(wa_jid, ''),
			COALESCE(NULLIF(operating_hours, ''), '09:00 AM - 09:00 PM')
			FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(store_slug)=LOWER($1) LIMIT 1`, username).
			Scan(&storeName, &storeSlug, &deliveryRadiusKm, &freeDeliveryThreshold, &statusStr, &waJID, &operatingHours)
		if statusStr == "Connected" || waJID != "" {
			waConnected = true
		}

		// Low stock items
		lsRows, lsErr := DB.Query(`SELECT id, name, COALESCE(sku, ''), COALESCE(category, 'General'), COALESCE(in_stock, true), COALESCE(stock_quantity, 50), COALESCE(low_stock_threshold, 5), COALESCE(sale_price, 0)
			FROM products
			WHERE LOWER(username)=LOWER($1) AND (COALESCE(in_stock, true) = false OR COALESCE(stock_quantity, 50) <= COALESCE(low_stock_threshold, 5))
			ORDER BY COALESCE(in_stock, true) ASC, COALESCE(stock_quantity, 50) ASC LIMIT 5`, username)
		if lsErr == nil {
			defer lsRows.Close()
			for lsRows.Next() {
				var id, stockQty, threshold int
				var name, sku, cat string
				var inStock bool
				var salePrice float64
				if err := lsRows.Scan(&id, &name, &sku, &cat, &inStock, &stockQty, &threshold, &salePrice); err == nil {
					if sku == "" {
						sku = fmt.Sprintf("SKU-%04d", id)
					}
					if !inStock {
						stockQty = 0
					}
					lowStockItems = append(lowStockItems, map[string]interface{}{
						"id":                  id,
						"name":                name,
						"sku":                 sku,
						"category":            cat,
						"in_stock":            inStock,
						"stock_quantity":      stockQty,
						"low_stock_threshold": threshold,
						"price":               salePrice,
					})
				}
			}
		}

		// Orders analytics
		oRows, oErr := DB.Query(`SELECT id, COALESCE(order_id, ''), COALESCE(jid, ''), COALESCE(customer_phone, ''), COALESCE(customer_name, ''), COALESCE(delivery_phone, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, 'COD'), COALESCE(payment_status, 'PENDING'), COALESCE(order_status, 'NEW'), COALESCE(created_at, NOW())
			FROM orders
			WHERE LOWER(tenant_id)=LOWER($1) OR LOWER(tenant_id)=LOWER($2)
			ORDER BY created_at DESC LIMIT 200`, username, storeSlug)
		if oErr == nil {
			defer oRows.Close()
			todayKey := now.Format("2006-01-02")
			yesterdayKey := now.AddDate(0, 0, -1).Format("2006-01-02")

			for oRows.Next() {
				var id int
				var orderID, jid, custPhone, custName, delPhone, delAddr, itemsJSON, payMode, payStatus, ordStatus string
				var totalAmt float64
				var createdAt time.Time
				if err := oRows.Scan(&id, &orderID, &jid, &custPhone, &custName, &delPhone, &delAddr, &itemsJSON, &totalAmt, &payMode, &payStatus, &ordStatus, &createdAt); err == nil {
					if orderID == "" {
						orderID = fmt.Sprintf("ORD-%d", id)
					}
					dateKey := createdAt.Format("2006-01-02")
					upperOID := strings.ToUpper(orderID)
					upperPayMode := strings.ToUpper(payMode)
					upperPayStatus := strings.ToUpper(payStatus)
					isWA := strings.HasPrefix(upperOID, "WA") || strings.Contains(upperPayMode, "WHATSAPP") || (jid != "" && !strings.HasPrefix(upperOID, "WEB"))
					source := "Web"
					if isWA {
						source = "WhatsApp"
					}

					if dateKey == todayKey {
						grossSalesToday += totalAmt
						totalOrdersToday++
						if isWA {
							whatsappOrdersToday++
						} else {
							webOrdersToday++
						}
					} else if dateKey == yesterdayKey {
						grossSalesYesterday += totalAmt
					}

					if upperPayStatus == "PAID" || upperPayStatus == "SUCCESS" || upperPayStatus == "COMPLETED" {
						upiCollectedAmount += totalAmt
					} else {
						codPendingAmount += totalAmt
					}

					if idx, ok := dayIndexMap[dateKey]; ok {
						sevenDaySales[idx] += totalAmt
						sevenDayOrders[idx]++
						if isWA {
							whatsappOrders7d++
							whatsappRevenue7d += totalAmt
						} else {
							webOrders7d++
							webRevenue7d += totalAmt
						}
					}

					if len(recentOrders) < 10 {
						var parsedItems []map[string]interface{}
						_ = json.Unmarshal([]byte(itemsJSON), &parsedItems)
						summaryParts := make([]string, 0, len(parsedItems))
						for _, it := range parsedItems {
							n, _ := it["name"].(string)
							if n == "" {
								n, _ = it["product_name"].(string)
							}
							if n == "" {
								n = "Item"
							}
							summaryParts = append(summaryParts, n)
						}
						itemsSummary := "Catalog Order"
						if len(summaryParts) > 0 {
							itemsSummary = strings.Join(summaryParts, ", ")
						}
						if custName == "" {
							custName = "Walk-in / WhatsApp Customer"
						}
						if custPhone == "" {
							custPhone = delPhone
						}
						payLabel := "COD"
						if strings.Contains(upperPayMode, "UPI") || strings.Contains(upperPayMode, "ONLINE") {
							payLabel = "UPI QR"
						}
						payBadge := "Pending"
						if upperPayStatus == "PAID" || upperPayStatus == "SUCCESS" || upperPayStatus == "COMPLETED" {
							payBadge = "Paid"
						}
						recentOrders = append(recentOrders, map[string]interface{}{
							"id":               id,
							"order_id":         orderID,
							"customer_name":    custName,
							"customer_phone":   custPhone,
							"delivery_address": delAddr,
							"items":            parsedItems,
							"items_summary":    itemsSummary,
							"amount":           totalAmt,
							"total_amount":     totalAmt,
							"source":           source,
							"payment_method":   payLabel,
							"payment_mode":     payMode,
							"payment_status":   payBadge,
							"order_status":     formatGoOrderStatus(ordStatus),
							"created_at":       createdAt.Format(time.RFC3339),
						})
					}
				}
			}
		}
	}

	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		waConnected = true
		if client.Store.ID != nil {
			waJID = client.Store.ID.User
		}
	}

	salesGrowthPct := 0.0
	if grossSalesYesterday > 0 {
		salesGrowthPct = ((grossSalesToday - grossSalesYesterday) / grossSalesYesterday) * 100.0
	} else if grossSalesToday > 0 {
		salesGrowthPct = 100.0
	}

	if leadsToday == 0 {
		leadsToday = totalLeads
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":   "success",
		"username": username,
		"store_profile": map[string]interface{}{
			"store_name":              storeName,
			"store_slug":              storeSlug,
			"delivery_radius_km":      deliveryRadiusKm,
			"free_delivery_threshold": freeDeliveryThreshold,
			"wa_connected":            waConnected,
			"wa_jid":                  waJID,
			"operating_hours":         operatingHours,
		},
		"kpis": map[string]interface{}{
			"gross_sales_today":           grossSalesToday,
			"gross_sales_yesterday":       grossSalesYesterday,
			"sales_growth_pct":            salesGrowthPct,
			"total_orders_today":          totalOrdersToday,
			"web_orders_today":            webOrdersToday,
			"whatsapp_orders_today":       whatsappOrdersToday,
			"upi_collected_amount":        upiCollectedAmount,
			"cod_pending_amount":          codPendingAmount,
			"leads_captured_today":        leadsToday,
			"messages_auto_replied_today": aiRepliesToday,
		},
		"charts": map[string]interface{}{
			"seven_day_labels": sevenDayLabels,
			"seven_day_sales":  sevenDaySales,
			"seven_day_orders": sevenDayOrders,
			"source_split": map[string]interface{}{
				"web_orders":       webOrders7d,
				"whatsapp_orders":  whatsappOrders7d,
				"web_revenue":      webRevenue7d,
				"whatsapp_revenue": whatsappRevenue7d,
			},
		},
		"recent_orders":   recentOrders,
		"low_stock_items": lowStockItems,
		"total_chats":     totalChats,
		"total_products":  totalProducts,
		"total_leads":     totalLeads,
		"leads_captured":  totalLeads,
		"wa_connected":    waConnected,
		"wa_jid":          waJID,
	})
}

// UPDATE ORDER STATUS (POST /api/business/orders/status)
func BusinessOrderStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" && r.Method != "PUT" {
		respondJSON(w, 405, map[string]string{"status": "error", "message": "Method not allowed"})
		return
	}
	var req struct {
		Username      string `json:"username"`
		OrderID       string `json:"order_id"`
		OrderStatus   string `json:"order_status"`
		Status        string `json:"status"`
		PaymentStatus string `json:"payment_status"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	username := resolveRequestUsername(r, req.Username)
	orderID := strings.TrimSpace(req.OrderID)
	rawStatus := strings.TrimSpace(req.OrderStatus)
	if rawStatus == "" {
		rawStatus = strings.TrimSpace(req.Status)
	}
	if rawStatus == "" {
		rawStatus = "DISPATCHED"
	}
	newStatus := whatsapp.NormalizeOrderStatus(rawStatus)
	payStatus := strings.ToUpper(strings.TrimSpace(req.PaymentStatus))
	if newStatus == "DELIVERED" && payStatus == "" {
		payStatus = "PAID"
	}

	if orderID == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "order_id is required"})
		return
	}
	if DB == nil {
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Database not connected"})
		return
	}

	if payStatus != "" {
		_, _ = DB.Exec(`UPDATE orders SET order_status=$1, payment_status=$2, updated_at=NOW() WHERE LOWER(order_id)=LOWER($3) AND (LOWER(tenant_id)=LOWER($4) OR $4='admin')`, newStatus, payStatus, orderID, username)
		_, _ = DB.Exec(`UPDATE customer_order_states SET order_status=$1, payment_status=$2, updated_at=NOW() WHERE LOWER(order_id)=LOWER($3) AND (LOWER(username)=LOWER($4) OR LOWER(tenant_id)=LOWER($4) OR $4='admin')`, newStatus, payStatus, orderID, username)
	} else {
		_, _ = DB.Exec(`UPDATE orders SET order_status=$1, updated_at=NOW() WHERE LOWER(order_id)=LOWER($2) AND (LOWER(tenant_id)=LOWER($3) OR $3='admin')`, newStatus, orderID, username)
		_, _ = DB.Exec(`UPDATE customer_order_states SET order_status=$1, updated_at=NOW() WHERE LOWER(order_id)=LOWER($2) AND (LOWER(username)=LOWER($3) OR LOWER(tenant_id)=LOWER($3) OR $3='admin')`, newStatus, orderID, username)
	}

	// Automatically trigger WhatsApp notification via whatsmeow when status changes to Dispatched, Out for Delivery, or Delivered
	if newStatus == "DISPATCHED" || newStatus == "OUT_FOR_DELIVERY" || newStatus == "DELIVERED" || newStatus == "PROCESSING" {
		go func(tID, oID, st string) {
			_ = whatsapp.SendOrderStatusUpdateWhatsApp(tID, "", "", oID, st)
		}(username, orderID, newStatus)
	}

	label := formatGoOrderStatus(newStatus)
	respondJSON(w, 200, map[string]interface{}{
		"status":            "success",
		"order_id":          orderID,
		"order_status":      label,
		"raw_order_status":  newStatus,
		"whatsapp_notified": newStatus == "DISPATCHED" || newStatus == "OUT_FOR_DELIVERY" || newStatus == "DELIVERED",
		"message":           "Order " + orderID + " updated to " + label + " & WhatsApp notification triggered",
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
				(SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(c.username) AND (p.category_id=c.id OR LOWER(TRIM(COALESCE(p.category, '')))=LOWER(TRIM(c.category_name)) OR LOWER(TRIM(COALESCE(p.sub_category, '')))=LOWER(TRIM(c.category_name))))
				FROM categories c WHERE LOWER(c.username)=LOWER($1) ORDER BY COALESCE(c.parent_id, 0) ASC, c.id ASC`, username)

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

	if r.Method == "POST" || r.Method == "PUT" {
		var req struct {
			ID               int    `json:"id"`
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
			if req.ID > 0 {
				var oldName string
				_ = DB.QueryRow(`SELECT COALESCE(category_name, '') FROM categories WHERE id=$1 AND LOWER(username)=LOWER($2)`, req.ID, username).Scan(&oldName)

				_, err := DB.Exec(`UPDATE categories SET category_name=$1, category_image_url=$2, parent_id=$3, parent_name=$4 WHERE id=$5 AND LOWER(username)=LOWER($6)`,
					catName, imgURL, req.ParentID, pName, req.ID, username)
				if err != nil {
					respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update category: " + err.Error()})
					return
				}
				if oldName != "" && oldName != catName {
					_, _ = DB.Exec(`UPDATE categories SET parent_name=$1 WHERE LOWER(username)=LOWER($2) AND LOWER(parent_name)=LOWER($3)`, catName, username, oldName)
					_, _ = DB.Exec(`UPDATE products SET category=$1 WHERE LOWER(username)=LOWER($2) AND LOWER(category)=LOWER($3)`, catName, username, oldName)
					_, _ = DB.Exec(`UPDATE products SET sub_category=$1 WHERE LOWER(username)=LOWER($2) AND LOWER(sub_category)=LOWER($3)`, catName, username, oldName)
				}
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{
					"status":             "success",
					"id":                 req.ID,
					"category_name":      catName,
					"category_image_url": imgURL,
					"parent_id":          req.ParentID,
					"parent_name":        pName,
					"message":            "Category updated successfully!",
				})
				return
			}

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
			SKU                 string      `json:"sku"`
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
			InStock             bool        `json:"in_stock"`
			StockQuantity       int         `json:"stock_quantity"`
			LowStockThreshold   int         `json:"low_stock_threshold"`
		}

		var items []ProductItem

		if DB != nil {
			rows, err := DB.Query(`SELECT id, COALESCE(category_id, 0), name, COALESCE(sku, ''), price, COALESCE(description, ''), COALESCE(item_type, 'product'), COALESCE(unit_type, 'custom'), COALESCE(variants::text, '[]'), COALESCE(whatsapp_catalog_link, ''), COALESCE(image_url, ''), COALESCE(category, ''), COALESCE(in_stock, true), COALESCE(mrp, 0), COALESCE(sale_price, 0), COALESCE(product_image_url, ''), COALESCE(images::text, '[]'), COALESCE(sub_category, ''), COALESCE(sub_category_id, 0), COALESCE(stock_quantity, 50), COALESCE(low_stock_threshold, 5)
				FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, username)

			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var item ProductItem
					var variantsStr string
					var imagesStr string
					if err := rows.Scan(&item.ID, &item.CategoryID, &item.Name, &item.SKU, &item.Price, &item.Description, &item.ItemType, &item.UnitType, &variantsStr, &item.WhatsAppCatalogLink, &item.ImageURL, &item.Category, &item.InStock, &item.MRP, &item.SalePrice, &item.ProductImageURL, &imagesStr, &item.SubCategory, &item.SubCategoryID, &item.StockQuantity, &item.LowStockThreshold); err == nil {
						item.CategoryName = item.Category
						item.Details = item.Description
						item.WhatsAppURL = item.WhatsAppCatalogLink
						if item.SKU == "" {
							item.SKU = fmt.Sprintf("SKU-%04d", item.ID)
						}
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

		respondJSON(w, 200, map[string]interface{}{"status": "success", "products": items})
		return
	}

	if r.Method == "POST" || r.Method == "PUT" {
		var req struct {
			ID                  int         `json:"id"`
			Username            string      `json:"username"`
			CategoryID          int         `json:"category_id"`
			Category            string      `json:"category"`
			CategoryName        string      `json:"category_name"`
			SubCategory         string      `json:"sub_category"`
			SubCategoryID       int         `json:"sub_category_id"`
			Name                string      `json:"name"`
			SKU                 string      `json:"sku"`
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
			StockQuantity       *int        `json:"stock_quantity"`
			LowStockThreshold   *int        `json:"low_stock_threshold"`
			StockDelta          *int        `json:"stock_delta"`
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

		// Support direct toggle in_stock or stock_quantity/stock_delta if req.ID > 0 and req.Name is empty
		if req.ID > 0 && strings.TrimSpace(req.Name) == "" {
			if DB != nil {
				if req.StockDelta != nil {
					var newQty int
					var newInStock bool
					err := DB.QueryRow(`UPDATE products SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) + $1), in_stock = CASE WHEN GREATEST(0, COALESCE(stock_quantity, 0) + $1) > 0 THEN true ELSE false END WHERE id = $2 AND LOWER(username) = LOWER($3) RETURNING stock_quantity, in_stock`, *req.StockDelta, req.ID, username).Scan(&newQty, &newInStock)
					if err != nil {
						respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to adjust stock quantity: " + err.Error()})
						return
					}
					whatsapp.InvalidateUserConfigCache(username)
					respondJSON(w, 200, map[string]interface{}{"status": "success", "stock_quantity": newQty, "in_stock": newInStock, "message": "Stock quantity updated"})
					return
				}
				if req.StockQuantity != nil {
					qty := *req.StockQuantity
					if qty < 0 {
						qty = 0
					}
					autoStock := qty > 0
					if req.InStock != nil {
						autoStock = *req.InStock
					}
					_, err := DB.Exec(`UPDATE products SET stock_quantity = $1, in_stock = $2 WHERE id = $3 AND LOWER(username) = LOWER($4)`, qty, autoStock, req.ID, username)
					if err != nil {
						respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to set stock quantity: " + err.Error()})
						return
					}
					whatsapp.InvalidateUserConfigCache(username)
					respondJSON(w, 200, map[string]interface{}{"status": "success", "stock_quantity": qty, "in_stock": autoStock, "message": "Stock quantity updated"})
					return
				}
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
		subCatName := strings.TrimSpace(req.SubCategory)
		cleanSku := strings.TrimSpace(req.SKU)

		stockQtyVal := 50
		if req.StockQuantity != nil {
			stockQtyVal = *req.StockQuantity
			if stockQtyVal < 0 {
				stockQtyVal = 0
			}
		}
		lowStockVal := 5
		if req.LowStockThreshold != nil {
			lowStockVal = *req.LowStockThreshold
			if lowStockVal < 0 {
				lowStockVal = 0
			}
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
				_, err := DB.Exec(`UPDATE products SET category_id=$1, category=$2, sub_category=$3, sub_category_id=$4, name=$5, sku=$6, description=$7, mrp=$8, sale_price=$9, price=$10, item_type=$11, unit_type=$12, variants=$13::jsonb, whatsapp_catalog_link=$14, image_url=$15, product_image_url=$15, in_stock=$16, images=$17::jsonb, stock_quantity=$18, low_stock_threshold=$19 WHERE id=$20 AND LOWER(username)=LOWER($21)`,
					req.CategoryID, catName, subCatName, req.SubCategoryID, req.Name, cleanSku, descStr, mrpVal, salePriceVal, priceStr, itemType, unitType, variantsStr, waLink, imgURL, inStockVal, imagesJSON, stockQtyVal, lowStockVal, req.ID, username)
				if err != nil {
					respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update product in database: " + err.Error()})
					return
				}
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{"status": "success", "id": req.ID, "image_url": imgURL, "images": images, "message": "Product updated successfully!"})
				return
			}

			var newID int
			err := DB.QueryRow(`INSERT INTO products (username, category_id, category, sub_category, sub_category_id, name, sku, description, mrp, sale_price, price, item_type, unit_type, variants, whatsapp_catalog_link, image_url, product_image_url, in_stock, images, stock_quantity, low_stock_threshold)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $16, $17, $18::jsonb, $19, $20) RETURNING id`,
				username, req.CategoryID, catName, subCatName, req.SubCategoryID, req.Name, cleanSku, descStr, mrpVal, salePriceVal, priceStr, itemType, unitType, variantsStr, waLink, imgURL, inStockVal, imagesJSON, stockQtyVal, lowStockVal).Scan(&newID)

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

			// Iterate through images array and issue HTTP DELETE calls to Cloudflare Worker
			httpClient := &http.Client{Timeout: 10 * time.Second}
			for _, rawImgURL := range deletedImages {
				cleanImg := strings.TrimSpace(rawImgURL)
				if cleanImg == "" {
					continue
				}
				cleanPath := cleanImg
				if idx := strings.Index(cleanImg, ".workers.dev/"); idx != -1 {
					cleanPath = cleanImg[idx+len(".workers.dev/"):]
				} else if strings.HasPrefix(cleanImg, "http://") || strings.HasPrefix(cleanImg, "https://") {
					if parsedURL, err := url.Parse(cleanImg); err == nil {
						cleanPath = strings.TrimPrefix(parsedURL.Path, "/")
					}
				}
				if cleanPath != "" {
					workerDelURL := fmt.Sprintf("https://wamart-cloudflare.rkmtech633.workers.dev/delete?path=%s", url.QueryEscape(cleanPath))
					req, errReq := http.NewRequest("DELETE", workerDelURL, nil)
					if errReq == nil {
						resp, errDo := httpClient.Do(req)
						if errDo == nil {
							_ = resp.Body.Close()
						}
					}
				}
			}

			_, err := DB.Exec("DELETE FROM products WHERE id=$1 AND LOWER(username)=LOWER($2)", idStr, username)
			if err == nil {
				whatsapp.InvalidateUserConfigCache(username)
				respondJSON(w, 200, map[string]interface{}{"status": "success", "message": "Product and associated R2 storage media deleted successfully", "deleted_images": deletedImages})
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
