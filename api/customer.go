package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"wa-server/payment"
	"wa-server/whatsapp"
)

var (
	sessionSecretKey = []byte("wamart_omnichannel_secret_2026")
	memoryCartStore  = make(map[string]map[string]interface{})
	memCartLock      sync.RWMutex
)

type CustomerClaims struct {
	JID      string `json:"jid"`
	TenantID string `json:"tenant_id"`
	Phone    string `json:"phone"`
	Exp      int64  `json:"exp"`
}

// signCustomerToken generates an HMAC-SHA256 authenticated token
func signCustomerToken(jid, tenantID, phone string) string {
	claims := CustomerClaims{
		JID:      jid,
		TenantID: tenantID,
		Phone:    phone,
		Exp:      time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	claimsBytes, _ := json.Marshal(claims)
	b64Claims := hex.EncodeToString(claimsBytes)

	h := hmac.New(sha256.New, sessionSecretKey)
	h.Write([]byte(b64Claims))
	sig := hex.EncodeToString(h.Sum(nil))

	return fmt.Sprintf("%s.%s", b64Claims, sig)
}

// verifyCustomerToken validates the HMAC-SHA256 signature
func verifyCustomerToken(token string) (*CustomerClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid token format")
	}

	b64Claims, sig := parts[0], parts[1]
	h := hmac.New(sha256.New, sessionSecretKey)
	h.Write([]byte(b64Claims))
	expectedSig := hex.EncodeToString(h.Sum(nil))

	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return nil, fmt.Errorf("invalid token signature")
	}

	claimsBytes, err := hex.DecodeString(b64Claims)
	if err != nil {
		return nil, fmt.Errorf("invalid token encoding")
	}

	var claims CustomerClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return nil, fmt.Errorf("invalid token claims")
	}

	if claims.Exp < time.Now().Unix() {
		return nil, fmt.Errorf("token expired")
	}

	return &claims, nil
}

// extractCustomerFromRequest parses token from Authorization header or cookie
func extractCustomerFromRequest(r *http.Request) *CustomerClaims {
	authHeader := r.Header.Get("Authorization")
	var token string
	if strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimPrefix(authHeader, "Bearer ")
	} else if cookie, err := r.Cookie("wamart_cust_token"); err == nil && cookie.Value != "" {
		token = cookie.Value
	} else {
		token = r.URL.Query().Get("token")
		if token == "" {
			token = r.URL.Query().Get("auth_token")
		}
	}

	if token == "" {
		return nil
	}

	claims, err := verifyCustomerToken(strings.TrimSpace(token))
	if err != nil {
		return nil
	}
	return claims
}

// VerifyMagicTokenHandler handles POST /api/auth/verify-token & /api/customer/verify-token
func VerifyMagicTokenHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" && r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var token string
	if r.Method == "POST" {
		var body struct {
			Token     string `json:"token"`
			AuthToken string `json:"auth_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		token = body.Token
		if token == "" {
			token = body.AuthToken
		}
	}
	if token == "" {
		token = r.URL.Query().Get("token")
		if token == "" {
			token = r.URL.Query().Get("auth_token")
		}
	}
	token = strings.TrimSpace(token)
	if token == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Magic link token is required"})
		return
	}

	if DB == nil {
		respondJSON(w, 500, map[string]interface{}{"status": "error", "message": "Database unavailable"})
		return
	}

	var jid, tenantID string
	var expiresAt time.Time
	var isUsed bool

	err := DB.QueryRow(`SELECT jid, tenant_id, expires_at, is_used FROM magic_links WHERE token = $1 LIMIT 1`, token).Scan(&jid, &tenantID, &expiresAt, &isUsed)
	if err != nil {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "message": "Invalid magic link token"})
		return
	}

	if expiresAt.Before(time.Now()) {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "message": "Magic link token has expired"})
		return
	}

	// Mark as used
	_, _ = DB.Exec(`UPDATE magic_links SET is_used = true WHERE token = $1`, token)

	reg := regexp.MustCompile(`\D`)
	cleanPhone := reg.ReplaceAllString(strings.Split(jid, "@")[0], "")

	sessionToken := signCustomerToken(jid, tenantID, cleanPhone)

	// Fetch pre-filled customer details from DB
	customerData := map[string]interface{}{
		"name":             "",
		"whatsapp_number":  cleanPhone,
		"delivery_phone":   cleanPhone,
		"delivery_address": "",
		"jid":              jid,
		"tenant_id":        tenantID,
	}

	var name, waNum, delPhone, delAddr string
	err = DB.QueryRow(`SELECT 
		COALESCE(NULLIF(name, ''), NULLIF(full_name, ''), NULLIF(saved_name, ''), ''),
		COALESCE(NULLIF(whatsapp_number, ''), NULLIF(wa_number, ''), $1),
		COALESCE(NULLIF(delivery_phone, ''), NULLIF(contact_phone, ''), $1),
		COALESCE(NULLIF(delivery_address, ''), NULLIF(saved_address, ''), '')
		FROM customers 
		WHERE (jid = $2 OR wa_number = $1) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))
		ORDER BY updated_at DESC LIMIT 1`, cleanPhone, jid, tenantID).Scan(&name, &waNum, &delPhone, &delAddr)

	if err == nil {
		customerData["name"] = name
		customerData["whatsapp_number"] = waNum
		customerData["delivery_phone"] = delPhone
		customerData["delivery_address"] = delAddr
	} else {
		// Fallback to customer_order_states
		_ = DB.QueryRow(`SELECT COALESCE(customer_name, ''), COALESCE(delivery_phone, ''), COALESCE(delivery_address, '')
			FROM customer_order_states WHERE (customer_phone = $1 OR customer_phone = $2) AND LOWER(username)=LOWER($3)
			ORDER BY updated_at DESC LIMIT 1`, cleanPhone, jid, tenantID).Scan(&name, &delPhone, &delAddr)
		customerData["name"] = name
		if delPhone != "" {
			customerData["delivery_phone"] = delPhone
		}
		customerData["delivery_address"] = delAddr
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "wamart_cust_token",
		Value:    sessionToken,
		Path:     "/",
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	respondJSON(w, 200, map[string]interface{}{
		"status":    "success",
		"token":     sessionToken,
		"jid":       jid,
		"tenant_id": tenantID,
		"customer":  customerData,
	})
}

// CustomerProfileHandler handles GET & PUT /api/customer/profile
func CustomerProfileHandler(w http.ResponseWriter, r *http.Request) {
	claims := extractCustomerFromRequest(r)
	if claims == nil {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "message": "Authentication required"})
		return
	}

	cleanPhone := claims.Phone
	if cleanPhone == "" {
		reg := regexp.MustCompile(`\D`)
		cleanPhone = reg.ReplaceAllString(strings.Split(claims.JID, "@")[0], "")
	}

	if r.Method == "GET" {
		customerData := map[string]interface{}{
			"jid":              claims.JID,
			"tenant_id":        claims.TenantID,
			"name":             "",
			"whatsapp_number":  cleanPhone,
			"delivery_phone":   cleanPhone,
			"delivery_address": "",
		}

		if DB != nil {
			var name, waNum, delPhone, delAddr string
			err := DB.QueryRow(`SELECT 
				COALESCE(NULLIF(name, ''), NULLIF(full_name, ''), NULLIF(saved_name, ''), ''),
				COALESCE(NULLIF(whatsapp_number, ''), NULLIF(wa_number, ''), $1),
				COALESCE(NULLIF(delivery_phone, ''), NULLIF(contact_phone, ''), $1),
				COALESCE(NULLIF(delivery_address, ''), NULLIF(saved_address, ''), '')
				FROM customers 
				WHERE (jid = $2 OR wa_number = $1) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))
				ORDER BY updated_at DESC LIMIT 1`, cleanPhone, claims.JID, claims.TenantID).Scan(&name, &waNum, &delPhone, &delAddr)

			if err == nil {
				customerData["name"] = name
				customerData["whatsapp_number"] = waNum
				customerData["delivery_phone"] = delPhone
				customerData["delivery_address"] = delAddr
			}
		}

		respondJSON(w, 200, map[string]interface{}{"status": "success", "customer": customerData})
		return
	}

	if r.Method == "PUT" || r.Method == "POST" {
		var body struct {
			Name            string `json:"name"`
			DeliveryPhone   string `json:"delivery_phone"`
			DeliveryAddress string `json:"delivery_address"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Invalid JSON body"})
			return
		}

		body.Name = strings.TrimSpace(body.Name)
		body.DeliveryPhone = strings.TrimSpace(body.DeliveryPhone)
		body.DeliveryAddress = strings.TrimSpace(body.DeliveryAddress)

		if body.DeliveryPhone == "" {
			body.DeliveryPhone = cleanPhone
		}

		if DB != nil {
			// Update customers table
			_, _ = DB.Exec(`INSERT INTO customers (jid, tenant_id, name, whatsapp_number, delivery_phone, delivery_address, username, wa_number, full_name, saved_address, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $2, $4, $3, $6, NOW())
				ON CONFLICT (jid) DO UPDATE SET
					tenant_id = EXCLUDED.tenant_id,
					name = EXCLUDED.name,
					whatsapp_number = EXCLUDED.whatsapp_number,
					delivery_phone = EXCLUDED.delivery_phone,
					delivery_address = EXCLUDED.delivery_address,
					full_name = EXCLUDED.name,
					saved_address = EXCLUDED.delivery_address,
					updated_at = NOW()`,
				claims.JID, claims.TenantID, body.Name, cleanPhone, body.DeliveryPhone, body.DeliveryAddress)

			// Also sync into customer_order_states
			_, _ = DB.Exec(`INSERT INTO customer_order_states (jid, tenant_id, username, customer_phone, customer_name, delivery_phone, delivery_address, updated_at)
				VALUES ($1, $2, $2, $3, $4, $5, $6, NOW())
				ON CONFLICT (username, customer_phone) DO UPDATE SET
					customer_name = EXCLUDED.customer_name,
					delivery_phone = EXCLUDED.delivery_phone,
					delivery_address = EXCLUDED.delivery_address,
					jid = EXCLUDED.jid,
					tenant_id = EXCLUDED.tenant_id,
					updated_at = NOW()`,
				claims.JID, claims.TenantID, cleanPhone, body.Name, body.DeliveryPhone, body.DeliveryAddress)
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Profile updated successfully",
			"customer": map[string]interface{}{
				"jid":              claims.JID,
				"tenant_id":        claims.TenantID,
				"name":             body.Name,
				"whatsapp_number":  cleanPhone,
				"delivery_phone":   body.DeliveryPhone,
				"delivery_address": body.DeliveryAddress,
			},
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// CustomerOrdersHandler handles GET /api/customer/orders (Strictly returns last 5 customer orders from DB)
func CustomerOrdersHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := extractCustomerFromRequest(r)
	if claims == nil {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "message": "Authentication required"})
		return
	}

	cleanPhone := claims.Phone
	if cleanPhone == "" {
		reg := regexp.MustCompile(`\D`)
		cleanPhone = reg.ReplaceAllString(strings.Split(claims.JID, "@")[0], "")
	}

	seenOrderIDs := make(map[string]bool)
	orders := make([]map[string]interface{}, 0)

	if DB != nil {
		rows, err := DB.Query(`SELECT 
			order_id, 
			COALESCE(total_amount, 0), 
			COALESCE(payment_mode, 'COD'), 
			COALESCE(payment_status, 'PENDING'), 
			COALESCE(order_status, 'CONFIRMED'), 
			COALESCE(items, '[]'), 
			COALESCE(delivery_address, ''),
			created_at
			FROM orders
			WHERE jid = $1 OR customer_phone = $2 OR delivery_phone = $2
			ORDER BY created_at DESC LIMIT 5`, claims.JID, cleanPhone)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var orderID, payMode, payStatus, ordStatus, itemsStr, delAddr string
				var totalAmt float64
				var createdAt time.Time
				if err := rows.Scan(&orderID, &totalAmt, &payMode, &payStatus, &ordStatus, &itemsStr, &delAddr, &createdAt); err == nil {
					var parsedItems interface{}
					if err := json.Unmarshal([]byte(itemsStr), &parsedItems); err != nil {
						parsedItems = itemsStr
					}
					seenOrderIDs[strings.ToLower(orderID)] = true
					orders = append(orders, map[string]interface{}{
						"order_id":         orderID,
						"total_amount":     totalAmt,
						"payment_mode":     payMode,
						"payment_status":   payStatus,
						"order_status":     ordStatus,
						"items":            parsedItems,
						"delivery_address": delAddr,
						"created_at":       createdAt.Format(time.RFC3339),
					})
				}
			}
		}

		// Fallback/backfill from customer_order_states if fewer than 5 orders found
		if len(orders) < 5 {
			limitNeeded := 5 - len(orders)
			stRows, stErr := DB.Query(`SELECT 
				order_id, 
				COALESCE(total_amount, 0), 
				COALESCE(payment_mode, 'COD'), 
				COALESCE(payment_status, 'PENDING'), 
				COALESCE(order_status, 'CONFIRMED'), 
				COALESCE(items::text, '[]'), 
				COALESCE(delivery_address, ''),
				updated_at
				FROM customer_order_states
				WHERE jid = $1 OR customer_phone = $2 OR delivery_phone = $2
				ORDER BY updated_at DESC LIMIT $3`, claims.JID, cleanPhone, limitNeeded)

			if stErr == nil {
				defer stRows.Close()
				for stRows.Next() {
					var orderID, payMode, payStatus, ordStatus, itemsStr, delAddr string
					var totalAmt float64
					var updatedAt time.Time
					if err := stRows.Scan(&orderID, &totalAmt, &payMode, &payStatus, &ordStatus, &itemsStr, &delAddr, &updatedAt); err == nil && orderID != "" {
						if !seenOrderIDs[strings.ToLower(orderID)] {
							var parsedItems interface{}
							if err := json.Unmarshal([]byte(itemsStr), &parsedItems); err != nil {
								parsedItems = itemsStr
							}
							seenOrderIDs[strings.ToLower(orderID)] = true
							orders = append(orders, map[string]interface{}{
								"order_id":         orderID,
								"total_amount":     totalAmt,
								"payment_mode":     payMode,
								"payment_status":   payStatus,
								"order_status":     ordStatus,
								"items":            parsedItems,
								"delivery_address": delAddr,
								"created_at":       updatedAt.Format(time.RFC3339),
							})
						}
					}
				}
			}
		}
	}

	respondJSON(w, 200, map[string]interface{}{
		"status": "success",
		"orders": orders,
		"count":  len(orders),
	})
}

// CustomerCartHandler handles GET & POST /api/customer/cart
func CustomerCartHandler(w http.ResponseWriter, r *http.Request) {
	claims := extractCustomerFromRequest(r)
	if claims == nil {
		respondJSON(w, 401, map[string]interface{}{"status": "error", "message": "Authentication required"})
		return
	}

	cleanPhone := claims.Phone
	if cleanPhone == "" {
		reg := regexp.MustCompile(`\D`)
		cleanPhone = reg.ReplaceAllString(strings.Split(claims.JID, "@")[0], "")
	}

	cartKey := fmt.Sprintf("%s:%s", claims.TenantID, cleanPhone)

	if r.Method == "GET" {
		var cartData interface{}
		if DB != nil {
			var rawCart string
			err := DB.QueryRow(`SELECT COALESCE(items, '[]') FROM active_carts 
				WHERE (jid = $1 OR customer_phone = $2) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))
				ORDER BY updated_at DESC LIMIT 1`, claims.JID, cleanPhone, claims.TenantID).Scan(&rawCart)
			if err == nil && rawCart != "" {
				_ = json.Unmarshal([]byte(rawCart), &cartData)
			}
		}

		if cartData == nil {
			memCartLock.RLock()
			cartData = memoryCartStore[cartKey]
			memCartLock.RUnlock()
		}

		if cartData == nil {
			cartData = make([]interface{}, 0)
		}

		respondJSON(w, 200, map[string]interface{}{
			"status": "success",
			"cart":   cartData,
		})
		return
	}

	if r.Method == "POST" {
		var body struct {
			Cart interface{} `json:"cart"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Invalid JSON body"})
			return
		}

		cartBytes, _ := json.Marshal(body.Cart)

		if DB != nil {
			_, _ = DB.Exec(`INSERT INTO active_carts (jid, tenant_id, username, customer_phone, items, updated_at)
				VALUES ($1, $2, $2, $3, $4, NOW())
				ON CONFLICT (username, customer_phone) DO UPDATE SET
					items = EXCLUDED.items,
					jid = EXCLUDED.jid,
					tenant_id = EXCLUDED.tenant_id,
					updated_at = NOW()`,
				claims.JID, claims.TenantID, cleanPhone, string(cartBytes))
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":  "success",
			"message": "Cart synced successfully",
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// CheckoutOrderHandler handles POST /api/orders/checkout & /api/customer/checkout
func CheckoutOrderHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var reqBody struct {
		AuthToken       string      `json:"auth_token"`
		JID             string      `json:"jid"`
		TenantID        string      `json:"tenant_id"`
		CustomerName    string      `json:"customer_name"`
		CustomerPhone   string      `json:"customer_phone"`
		DeliveryPhone   string      `json:"delivery_phone"`
		DeliveryAddress string      `json:"delivery_address"`
		PaymentMode     string      `json:"payment_mode"`
		Items           interface{} `json:"items"`
		Subtotal        float64     `json:"subtotal"`
		DeliveryFee     float64     `json:"delivery_fee"`
		TotalAmount     float64     `json:"total_amount"`
	}

	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Invalid JSON payload"})
		return
	}

	claims := extractCustomerFromRequest(r)
	if claims != nil {
		if reqBody.JID == "" {
			reqBody.JID = claims.JID
		}
		if reqBody.TenantID == "" {
			reqBody.TenantID = claims.TenantID
		}
		if reqBody.CustomerPhone == "" {
			reqBody.CustomerPhone = claims.Phone
		}
	}

	reqBody.CustomerName = strings.TrimSpace(reqBody.CustomerName)
	reqBody.DeliveryAddress = strings.TrimSpace(reqBody.DeliveryAddress)
	if reqBody.CustomerPhone == "" {
		reqBody.CustomerPhone = reqBody.DeliveryPhone
	}
	reg := regexp.MustCompile(`\D`)
	cleanPhone := reg.ReplaceAllString(reqBody.CustomerPhone, "")

	if reqBody.CustomerName == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Customer name is required for order confirmation."})
		return
	}
	if cleanPhone == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "WhatsApp phone number is required to receive receipt."})
		return
	}
	if reqBody.DeliveryAddress == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "Delivery address & landmark is required."})
		return
	}

	if reqBody.JID == "" {
		reqBody.JID = cleanPhone + "@s.whatsapp.net"
	}
	if reqBody.TenantID == "" {
		reqBody.TenantID = "admin"
	}
	if reqBody.PaymentMode == "" {
		reqBody.PaymentMode = "COD"
	}

	// Normalize items to []whatsapp.CartItem
	itemsBytes, _ := json.Marshal(reqBody.Items)
	var rawItems []map[string]interface{}
	_ = json.Unmarshal(itemsBytes, &rawItems)

	cartItems := make([]whatsapp.CartItem, 0, len(rawItems))
	for _, itm := range rawItems {
		idVal := itm["id"]
		pID, _ := itm["product_id"].(string)
		name, _ := itm["name"].(string)
		var price float64
		if p, ok := itm["price"].(float64); ok {
			price = p
		} else if pStr, ok := itm["price"].(string); ok {
			_, _ = fmt.Sscanf(pStr, "%f", &price)
		}
		var qty int = 1
		if q, ok := itm["qty"].(float64); ok && q > 0 {
			qty = int(q)
		}
		variant, _ := itm["selectedVariant"].(string)

		cartItems = append(cartItems, whatsapp.CartItem{
			ID:              idVal,
			ProductID:       pID,
			Name:            name,
			Price:           price,
			Qty:             qty,
			SelectedVariant: variant,
		})
	}

	deliveryDetails := whatsapp.DeliveryInfo{
		CustomerName:    reqBody.CustomerName,
		DeliveryPhone:   cleanPhone,
		DeliveryAddress: reqBody.DeliveryAddress,
		PaymentMode:     reqBody.PaymentMode,
		Subtotal:        reqBody.Subtotal,
		DeliveryFee:     reqBody.DeliveryFee,
		TotalAmount:     reqBody.TotalAmount,
	}

	// Call Centralized Order Processing Function
	orderID, err := whatsapp.ProcessAndConfirmOrder(r.Context(), DB, nil, reqBody.JID, reqBody.TenantID, cartItems, deliveryDetails)
	if err != nil {
		log.Printf("⚠️ [Checkout Order Handler] ProcessAndConfirmOrder error: %v", err)
		respondJSON(w, 500, map[string]interface{}{"status": "error", "message": "Failed to process order"})
		return
	}

	isOnline := strings.ToUpper(strings.TrimSpace(reqBody.PaymentMode)) == "ONLINE"

	if isOnline {
		if DB != nil {
			_, _ = DB.Exec(`UPDATE orders SET payment_status = 'PENDING_PAYMENT', order_status = 'PENDING_PAYMENT' WHERE order_id = $1`, orderID)
			_, _ = DB.Exec(`UPDATE customer_order_states SET payment_status = 'PENDING_PAYMENT', order_status = 'PENDING_PAYMENT' WHERE order_id = $1`, orderID)
		}

		payConfig := payment.GetPaymentConfig(reqBody.TenantID)
		upiURI := payment.GenerateUPIString(payConfig, deliveryDetails.TotalAmount, orderID)
		qrURL := fmt.Sprintf("https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=%s", url.QueryEscape(upiURI))

		// Dispatch detached zero-blocking background Goroutine payment polling loop
		go whatsapp.PollPaymentStatusBackground(context.Background(), DB, nil, reqBody.JID, reqBody.TenantID, orderID)

		respondJSON(w, 200, map[string]interface{}{
			"status":         "success",
			"message":        "Order created. Please scan UPI QR code to complete payment.",
			"order_id":       orderID,
			"payment_mode":   "ONLINE",
			"payment_status": "PENDING_PAYMENT",
			"order_status":   "PENDING_PAYMENT",
			"total_amount":   deliveryDetails.TotalAmount,
			"qr_url":         qrURL,
			"qr_image_url":   qrURL,
			"upi_uri":        upiURI,
			"order": map[string]interface{}{
				"order_id":         orderID,
				"jid":              reqBody.JID,
				"customer_name":    reqBody.CustomerName,
				"customer_phone":   cleanPhone,
				"delivery_address": reqBody.DeliveryAddress,
				"items":            cartItems,
				"total_amount":     deliveryDetails.TotalAmount,
				"payment_mode":     "ONLINE",
				"payment_status":   "PENDING_PAYMENT",
				"order_status":     "PENDING_PAYMENT",
				"created_at":       time.Now().Format(time.RFC3339),
			},
		})
		return
	}

	// Default COD flow: Trigger Centralized WhatsApp Notification asynchronously
	go func() {
		_ = whatsapp.SendOrderConfirmationWhatsApp(nil, reqBody.JID, orderID)
	}()

	respondJSON(w, 200, map[string]interface{}{
		"status":       "success",
		"message":      "Order Placed Successfully! We've sent the confirmation and receipt to your WhatsApp.",
		"order_id":     orderID,
		"total_amount": deliveryDetails.TotalAmount,
		"order": map[string]interface{}{
			"order_id":         orderID,
			"jid":              reqBody.JID,
			"customer_name":    reqBody.CustomerName,
			"customer_phone":   cleanPhone,
			"delivery_address": reqBody.DeliveryAddress,
			"items":            cartItems,
			"total_amount":     deliveryDetails.TotalAmount,
			"payment_mode":     reqBody.PaymentMode,
			"payment_status":   "PENDING",
			"order_status":     "CONFIRMED",
			"created_at":       time.Now().Format(time.RFC3339),
		},
	})
}

// OrderStatusHandler handles GET /api/orders/status & GET /api/orders/status/:orderId
func OrderStatusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	orderID := strings.TrimSpace(r.URL.Query().Get("order_id"))
	if orderID == "" {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 3 && parts[0] == "api" && parts[1] == "orders" && parts[2] == "status" {
			if len(parts) >= 4 {
				orderID = strings.TrimSpace(parts[3])
			}
		}
	}

	if orderID == "" {
		respondJSON(w, 400, map[string]interface{}{"status": "error", "message": "order_id parameter is required"})
		return
	}

	var paymentStatus, orderStatus, tenantID string
	var totalAmt float64

	if DB != nil {
		err := DB.QueryRow(`
			SELECT COALESCE(payment_status, 'PENDING'), COALESCE(order_status, 'CONFIRMED'), COALESCE(total_amount, 0), COALESCE(tenant_id, 'admin')
			FROM orders WHERE LOWER(order_id) = LOWER($1) LIMIT 1
		`, orderID).Scan(&paymentStatus, &orderStatus, &totalAmt, &tenantID)

		if err != nil {
			_ = DB.QueryRow(`
				SELECT COALESCE(payment_status, 'unpaid'), COALESCE(order_status, 'in_progress'), COALESCE(total_amount, 0), COALESCE(username, 'admin')
				FROM customer_order_states WHERE LOWER(order_id) = LOWER($1) LIMIT 1
			`, orderID).Scan(&paymentStatus, &orderStatus, &totalAmt, &tenantID)
		}
	}

	normPayStatus := strings.ToUpper(strings.TrimSpace(paymentStatus))
	isPaid := normPayStatus == "PAID" || normPayStatus == "SUCCESS" || normPayStatus == "TXN_SUCCESS" || normPayStatus == "COMPLETED"

	respondJSON(w, 200, map[string]interface{}{
		"status":         "success",
		"order_id":       orderID,
		"payment_status": normPayStatus,
		"order_status":   orderStatus,
		"total_amount":   totalAmt,
		"paid":           isPaid,
	})
}

