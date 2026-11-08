package api

import (
	"encoding/json"
	"net/http"
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

	if slug == "" {
		respondJSON(w, 400, map[string]interface{}{
			"status":  "error",
			"message": "store_slug or username parameter is required",
		})
		return
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
	var username, bName, accName, sSlug, tagline, logoURL, bannerURL, phone, notifPhone, waJid string
	var fullAddress, localArea string
	var maxRad, freeRad, delCharge float64
	var reqLoc, allowCOD bool
	allowCOD = true

	err := DB.QueryRow(`SELECT 
		username, 
		COALESCE(business_name, account_name, username), 
		COALESCE(account_name, ''),
		COALESCE(store_slug, username), 
		COALESCE(tagline, ''), 
		COALESCE(logo_url, ''), 
		COALESCE(banner_url, ''),
		COALESCE(phone, ''),
		COALESCE(notification_phone, ''),
		COALESCE(wa_jid, ''),
		COALESCE(full_address, ''),
		COALESCE(local_area, ''),
		COALESCE(max_delivery_radius_km, 15.0),
		COALESCE(free_delivery_radius_km, 3.0),
		COALESCE(delivery_charge_amount, 40.0),
		COALESCE(require_customer_location, false),
		COALESCE(allow_cod, true)
		FROM users 
		WHERE LOWER(store_slug)=LOWER($1) OR LOWER(username)=LOWER($1)
		LIMIT 1`, cleanSlug).Scan(
		&username, &bName, &accName, &sSlug, &tagline, &logoURL, &bannerURL,
		&phone, &notifPhone, &waJid, &fullAddress, &localArea,
		&maxRad, &freeRad, &delCharge, &reqLoc, &allowCOD,
	)

	if err != nil {
		respondJSON(w, 404, map[string]interface{}{
			"status":  "error",
			"message": "Store not found for slug: " + slug,
		})
		return
	}

	// Determine clean WhatsApp contact phone
	contactPhone := notifPhone
	if contactPhone == "" {
		contactPhone = phone
	}
	if contactPhone == "" && waJid != "" {
		contactPhone = strings.Split(waJid, "@")[0]
		contactPhone = strings.Split(contactPhone, ":")[0]
	}
	// Sanitize to pure digits
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

	tenantInfo := map[string]interface{}{
		"username":                  username,
		"store_name":                bName,
		"store_slug":                sSlug,
		"tagline":                   tagline,
		"logo_url":                  logoURL,
		"banner_url":                bannerURL,
		"whatsapp_number":           contactDigits,
		"full_address":              fullAddress,
		"local_area":                localArea,
		"max_delivery_radius_km":    maxRad,
		"free_delivery_radius_km":   freeRad,
		"delivery_charge_amount":    delCharge,
		"require_customer_location": reqLoc,
		"allow_cod":                 allowCOD,
	}

	// 2. Fetch Active Categories
	type CategoryItem struct {
		ID               int    `json:"id"`
		Name             string `json:"name"`
		CategoryName     string `json:"category_name"`
		CategoryImageURL string `json:"category_image_url"`
		ProductCount     int    `json:"product_count"`
	}

	categories := []CategoryItem{}
	catRows, catErr := DB.Query(`SELECT c.id, c.category_name, COALESCE(c.category_image_url, ''),
		(SELECT COUNT(*) FROM products p WHERE LOWER(p.username)=LOWER(c.username) AND (p.category_id=c.id OR LOWER(TRIM(p.category))=LOWER(TRIM(c.category_name))))
		FROM categories c 
		WHERE LOWER(c.username)=LOWER($1) 
		ORDER BY c.id ASC`, username)
	if catErr == nil {
		defer catRows.Close()
		for catRows.Next() {
			var ci CategoryItem
			if err := catRows.Scan(&ci.ID, &ci.CategoryName, &ci.CategoryImageURL, &ci.ProductCount); err == nil {
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
		Name                string      `json:"name"`
		Price               string      `json:"price"`
		MRP                 float64     `json:"mrp"`
		SalePrice           float64     `json:"sale_price"`
		Description         string      `json:"description"`
		UnitType            string      `json:"unit_type"`
		Variants            interface{} `json:"variants"`
		WhatsAppCatalogLink string      `json:"whatsapp_catalog_link"`
		ImageURL            string      `json:"image_url"`
		InStock             bool        `json:"in_stock"`
	}

	products := []ProductItem{}
	prodRows, prodErr := DB.Query(`SELECT id, COALESCE(category_id, 0), name, price, COALESCE(description, ''), 
		COALESCE(unit_type, 'custom'), COALESCE(variants::text, '[]'), COALESCE(whatsapp_catalog_link, ''), 
		COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), ''), 
		COALESCE(category, 'General'), COALESCE(in_stock, true), COALESCE(mrp, 0), COALESCE(sale_price, 0)
		FROM products 
		WHERE LOWER(username)=LOWER($1) 
		ORDER BY id ASC`, username)

	if prodErr == nil {
		defer prodRows.Close()
		for prodRows.Next() {
			var pi ProductItem
			var variantsStr string
			if err := prodRows.Scan(&pi.ID, &pi.CategoryID, &pi.Name, &pi.Price, &pi.Description, &pi.UnitType, &variantsStr, &pi.WhatsAppCatalogLink, &pi.ImageURL, &pi.Category, &pi.InStock, &pi.MRP, &pi.SalePrice); err == nil {
				pi.CategoryName = pi.Category

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
