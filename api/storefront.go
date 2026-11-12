package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// StorefrontHandler serves dynamic tenant branding, categories, and live products
// Endpoint: GET /api/storefront?slug=... or GET /api/storefront/{store_slug}
func StorefrontHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	if slug == "" {
		// Try parsing from URL path /api/storefront/{slug}
		pathParts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(pathParts) >= 3 && pathParts[0] == "api" && pathParts[1] == "storefront" {
			slug = strings.TrimSpace(pathParts[2])
		}
	}

	if slug == "" {
		slug = strings.TrimSpace(r.URL.Query().Get("username"))
	}

	cleanSlug := strings.ToLower(slug)

	if DB == nil {
		respondJSON(w, 500, map[string]interface{}{
			"status":  "error",
			"message": "Database connection unavailable",
		})
		return
	}

	// 1. Fetch Tenant Profile & Branding
	var username, bName, bType, accName, sSlug, tagline, themeColor, annBar, logoURL, bannerURL, phone, notifPhone, waJid, bannersJSON string
	var fullAddress, localArea, gstin, privPol, termsPol, refundPol, shipPol, opHours, delModesJSON, paytmVPA, paytmMID string
	var socialIG, socialFB, socialWA string
	var lat, lng, maxRad, freeRad, delCharge, minFreeOrder, minOrderAmt, packCharge float64
	var reqLoc, storeOpen, allowCOD bool
	storeOpen = true
	allowCOD = true

	selectCols := `SELECT 
		username, 
		COALESCE(business_name, account_name, username), 
		COALESCE(business_type, 'Kirana / General Store'),
		COALESCE(account_name, ''),
		COALESCE(store_slug, username), 
		COALESCE(tagline, ''), 
		COALESCE(theme_color, 'emerald'),
		COALESCE(announcement_bar, ''),
		COALESCE(logo_url, ''), 
		COALESCE(banner_url, ''),
		COALESCE(promotional_banners::text, '[]'),
		COALESCE(phone, ''),
		COALESCE(notification_phone, ''),
		COALESCE(wa_jid, ''),
		COALESCE(full_address, ''),
		COALESCE(local_area, ''),
		COALESCE(latitude, 0),
		COALESCE(longitude, 0),
		COALESCE(gstin_number, ''),
		COALESCE(privacy_policy, ''),
		COALESCE(terms_conditions, ''),
		COALESCE(refund_policy, ''),
		COALESCE(shipping_policy, ''),
		COALESCE(social_instagram, ''),
		COALESCE(social_facebook, ''),
		COALESCE(social_whatsapp, ''),
		COALESCE(max_delivery_radius_km, 15.0),
		COALESCE(free_delivery_radius_km, 3.0),
		COALESCE(delivery_charge_amount, 40.0),
		COALESCE(min_free_delivery_order, 499.0),
		COALESCE(min_order_amount, 0.0),
		COALESCE(packaging_charge, 0.0),
		COALESCE(require_customer_location, false),
		COALESCE(store_open_status, true),
		COALESCE(operating_hours, '9:00 AM - 10:00 PM'),
		COALESCE(delivery_modes::text, '["doorstep","pickup"]'),
		COALESCE(allow_cod, true),
		COALESCE(paytm_vpa, ''),
		COALESCE(paytm_mid, '')
		FROM users `

	var err error
	if cleanSlug != "" && cleanSlug != "default" && cleanSlug != "store" {
		err = DB.QueryRow(selectCols+`WHERE LOWER(store_slug)=LOWER($1) OR LOWER(username)=LOWER($1) OR LOWER(custom_domain)=LOWER($1) LIMIT 1`, cleanSlug).Scan(
			&username, &bName, &bType, &accName, &sSlug, &tagline, &themeColor, &annBar, &logoURL, &bannerURL, &bannersJSON,
			&phone, &notifPhone, &waJid, &fullAddress, &localArea, &lat, &lng,
			&gstin, &privPol, &termsPol, &refundPol, &shipPol, &socialIG, &socialFB, &socialWA,
			&maxRad, &freeRad, &delCharge, &minFreeOrder, &minOrderAmt, &packCharge,
			&reqLoc, &storeOpen, &opHours, &delModesJSON, &allowCOD, &paytmVPA, &paytmMID,
		)
		if err == nil && cleanSlug == "admin" {
			var adminProdCount int
			_ = DB.QueryRow(`SELECT COUNT(*) FROM products WHERE LOWER(username)=LOWER($1)`, username).Scan(&adminProdCount)
			if adminProdCount == 0 {
				username = ""
			}
		}
	}

	if (err != nil || username == "") && (cleanSlug == "" || cleanSlug == "admin" || cleanSlug == "default" || cleanSlug == "store") {
		err = DB.QueryRow(selectCols + `ORDER BY (SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(users.username)) DESC, CASE WHEN (logo_url != '' OR banner_url != '' OR business_name != '' OR wa_jid != '') THEN 0 ELSE 1 END, id DESC LIMIT 1`).Scan(
			&username, &bName, &bType, &accName, &sSlug, &tagline, &themeColor, &annBar, &logoURL, &bannerURL, &bannersJSON,
			&phone, &notifPhone, &waJid, &fullAddress, &localArea, &lat, &lng,
			&gstin, &privPol, &termsPol, &refundPol, &shipPol, &socialIG, &socialFB, &socialWA,
			&maxRad, &freeRad, &delCharge, &minFreeOrder, &minOrderAmt, &packCharge,
			&reqLoc, &storeOpen, &opHours, &delModesJSON, &allowCOD, &paytmVPA, &paytmMID,
		)
	}

	if err != nil || username == "" {
		respondJSON(w, 404, map[string]interface{}{
			"status":  "error",
			"message": "Store not found for slug: " + slug,
		})
		return
	}

	// Determine clean WhatsApp contact phone
	contactPhone := socialWA
	if contactPhone == "" {
		contactPhone = notifPhone
	}
	if contactPhone == "" {
		contactPhone = phone
	}
	if contactPhone == "" && waJid != "" {
		contactPhone = strings.Split(waJid, "@")[0]
		contactPhone = strings.Split(contactPhone, ":")[0]
	}
	contactDigits := regexp.MustCompile(`\D`).ReplaceAllString(contactPhone, "")

	if sSlug == "" {
		sSlug = username
	}
	if bName == "" {
		bName = accName
	}
	if bName == "" {
		bName = username
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

	var parsedModes []string
	if errModes := json.Unmarshal([]byte(delModesJSON), &parsedModes); errModes != nil || len(parsedModes) == 0 {
		parsedModes = []string{"doorstep", "pickup"}
	}

	tenantInfo := map[string]interface{}{
		"username":                  username,
		"store_name":                bName,
		"business_type":             bType,
		"store_slug":                sSlug,
		"tagline":                   tagline,
		"theme_color":               themeColor,
		"announcement_bar":          annBar,
		"logo_url":                  logoURL,
		"banner_url":                bannerURL,
		"promotional_banners":       parsedBanners,
		"whatsapp_number":           contactDigits,
		"social_instagram":          socialIG,
		"social_facebook":           socialFB,
		"social_whatsapp":           contactDigits,
		"full_address":              fullAddress,
		"local_area":                localArea,
		"latitude":                  lat,
		"longitude":                 lng,
		"gstin_number":              gstin,
		"privacy_policy":            privPol,
		"terms_conditions":          termsPol,
		"refund_policy":             refundPol,
		"shipping_policy":           shipPol,
		"max_delivery_radius_km":    maxRad,
		"free_delivery_radius_km":   freeRad,
		"delivery_charge_amount":    delCharge,
		"min_free_delivery_order":   minFreeOrder,
		"min_order_amount":          minOrderAmt,
		"packaging_charge":          packCharge,
		"require_customer_location": reqLoc,
		"store_open_status":         storeOpen,
		"operating_hours":           opHours,
		"delivery_modes":            parsedModes,
		"allow_cod":                 allowCOD,
		"paytm_vpa":                 paytmVPA,
		"paytm_mid":                 paytmMID,
	}

	// 2. Fetch Active Categories
	type CategoryItem struct {
		ID               int    `json:"id"`
		Name             string `json:"name"`
		CategoryName     string `json:"category_name"`
		CategoryImageURL string `json:"category_image_url"`
		ParentID         int    `json:"parent_id"`
		ParentName       string `json:"parent_name"`
		ProductCount     int    `json:"product_count"`
	}

	categories := []CategoryItem{}
	catRows, catErr := DB.Query(`SELECT c.id, c.category_name, COALESCE(c.category_image_url, ''),
		COALESCE(c.parent_id, 0), COALESCE(c.parent_name, ''),
		(SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(c.username) AND (p.category_id=c.id OR LOWER(TRIM(COALESCE(p.category, '')))=LOWER(TRIM(c.category_name)) OR LOWER(TRIM(COALESCE(p.sub_category, '')))=LOWER(TRIM(c.category_name))))
		FROM categories c 
		WHERE LOWER(c.username)=LOWER($1) 
		ORDER BY COALESCE(c.parent_id, 0) ASC, c.id ASC`, username)
	if catErr == nil {
		defer catRows.Close()
		for catRows.Next() {
			var ci CategoryItem
			if err := catRows.Scan(&ci.ID, &ci.CategoryName, &ci.CategoryImageURL, &ci.ParentID, &ci.ParentName, &ci.ProductCount); err == nil {
				ci.Name = ci.CategoryName
				categories = append(categories, ci)
			}
		}
	}

	// 3. Fetch Active Products
	type ProductItem struct {
		ID                  int         `json:"id"`
		CategoryID          int         `json:"category_id"`
		Category            string      `json:"category"`
		CategoryName        string      `json:"category_name"`
		SubCategory         string      `json:"sub_category"`
		SubCategoryID       int         `json:"sub_category_id"`
		ItemType            string      `json:"item_type"`
		Name                string      `json:"name"`
		SKU                 string      `json:"sku"`
		SKUCode             string      `json:"sku_code"`
		Price               string      `json:"price"`
		MRP                 float64     `json:"mrp"`
		SalePrice           float64     `json:"sale_price"`
		Description         string      `json:"description"`
		UnitType            string      `json:"unit_type"`
		Variants            interface{} `json:"variants"`
		WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
		ImageURL            string      `json:"image_url"`
		ThumbURL            string      `json:"thumb_url"`
		Images              []string    `json:"images"`
		InStock             bool        `json:"in_stock"`
		StockQuantity       int         `json:"stock_quantity"`
		LowStockThreshold   int         `json:"low_stock_threshold"`
	}

	products := []ProductItem{}
	prodRows, prodErr := DB.Query(`SELECT id, COALESCE(category_id, 0), name, COALESCE(sku, ''), COALESCE(price, '₹0'), COALESCE(description, ''), 
		COALESCE(unit_type, 'custom'), COALESCE(variants::text, '[]'), COALESCE(whatsapp_catalog_link, ''), 
		COALESCE(NULLIF(product_image_url, ''), NULLIF(image_url, ''), ''), 
		COALESCE(category, 'General'), COALESCE(sub_category, ''), COALESCE(sub_category_id, 0), COALESCE(item_type, 'product'),
		COALESCE(in_stock, true), COALESCE(mrp, 0), COALESCE(sale_price, 0),
		COALESCE(images::text, '[]'),
		COALESCE(stock_quantity, 50),
		COALESCE(low_stock_threshold, 5)
		FROM products 
		WHERE LOWER(username)=LOWER($1) 
		ORDER BY id ASC`, username)

	if prodErr == nil {
		defer prodRows.Close()
		for prodRows.Next() {
			var pi ProductItem
			var variantsStr string
			var imagesStr string
			if err := prodRows.Scan(&pi.ID, &pi.CategoryID, &pi.Name, &pi.SKU, &pi.Price, &pi.Description, &pi.UnitType, &variantsStr, &pi.WhatsAppCatalogLink, &pi.ImageURL, &pi.Category, &pi.SubCategory, &pi.SubCategoryID, &pi.ItemType, &pi.InStock, &pi.MRP, &pi.SalePrice, &imagesStr, &pi.StockQuantity, &pi.LowStockThreshold); err == nil {
				pi.CategoryName = pi.Category
				if pi.SKU == "" {
					pi.SKU = fmt.Sprintf("SKU-%04d", pi.ID)
				}
				pi.SKUCode = pi.SKU
				_ = json.Unmarshal([]byte(imagesStr), &pi.Images)
				if pi.Images == nil {
					pi.Images = []string{}
				}
				if len(pi.Images) == 0 && pi.ImageURL != "" {
					pi.Images = []string{pi.ImageURL}
				}
				if len(pi.Images) > 0 && pi.ImageURL == "" {
					pi.ImageURL = pi.Images[0]
				}
				pi.ThumbURL = pi.ImageURL
				if pi.StockQuantity <= 0 {
					pi.InStock = false
				}

				var parsedVariants interface{}
				if json.Unmarshal([]byte(variantsStr), &parsedVariants) == nil {
					pi.Variants = parsedVariants
				} else {
					pi.Variants = []interface{}{}
				}
				products = append(products, pi)
			}
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":     "success",
		"allow_cod":  allowCOD,
		"tenant":     tenantInfo,
		"categories": categories,
		"products":   products,
	})
}
