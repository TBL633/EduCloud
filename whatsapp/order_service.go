package whatsapp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
)

type CartItem struct {
	ID              interface{} `json:"id"`
	ProductID       string      `json:"product_id,omitempty"`
	Name            string      `json:"name"`
	Price           float64     `json:"price"`
	Qty             int         `json:"qty"`
	SelectedVariant string      `json:"selectedVariant,omitempty"`
}

type DeliveryInfo struct {
	CustomerName    string  `json:"customer_name"`
	DeliveryPhone   string  `json:"delivery_phone"`
	DeliveryAddress string  `json:"delivery_address"`
	PaymentMode     string  `json:"payment_mode"`
	Subtotal        float64 `json:"subtotal,omitempty"`
	DeliveryFee     float64 `json:"delivery_fee,omitempty"`
	TotalAmount     float64 `json:"total_amount,omitempty"`
}

// ProcessAndConfirmOrder handles centralized order creation:
// 1. Calculates final totals (subtotal, delivery fee).
// 2. Inserts order into orders table.
// 3. Inserts items into order_items table.
// 4. Upserts customer_order_states & customers tables.
// 5. Clears active cart for jid / customer_phone.
// 6. Returns generated orderID.
func ProcessAndConfirmOrder(ctx context.Context, db *sql.DB, waClient *whatsmeow.Client, jid string, tenantID string, cartItems []CartItem, deliveryDetails DeliveryInfo) (string, error) {
	if db == nil {
		db = DB
	}

	cleanTenantID := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tenantID), "@"))
	if cleanTenantID == "" {
		cleanTenantID = "admin"
	}

	cleanJID := strings.TrimSpace(jid)
	cleanPhone := ""
	if strings.Contains(cleanJID, "@") {
		cleanPhone = FormatPhone(strings.Split(cleanJID, "@")[0])
	}
	if cleanPhone == "" && deliveryDetails.DeliveryPhone != "" {
		cleanPhone = FormatPhone(deliveryDetails.DeliveryPhone)
	}
	if cleanJID == "" && cleanPhone != "" {
		cleanJID = cleanPhone + "@s.whatsapp.net"
	}
	if cleanPhone == "" && cleanJID != "" {
		reg := regexp.MustCompile(`\D`)
		cleanPhone = reg.ReplaceAllString(strings.Split(cleanJID, "@")[0], "")
	}

	custName := strings.TrimSpace(deliveryDetails.CustomerName)
	custAddress := strings.TrimSpace(deliveryDetails.DeliveryAddress)
	payMode := strings.TrimSpace(deliveryDetails.PaymentMode)
	if payMode == "" {
		payMode = "COD"
	}

	// If cartItems is empty, fetch pending items from active_carts
	if len(cartItems) == 0 && db != nil {
		rows, err := db.Query(`
			SELECT COALESCE(product_id, id::text, ''), COALESCE(qty, 1)
			FROM active_carts
			WHERE (customer_phone = $1 OR jid = $2) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))
		`, cleanPhone, cleanJID, cleanTenantID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pid string
				var q int
				if err := rows.Scan(&pid, &q); err == nil && pid != "" {
					pName := pid
					var pPrice float64
					_ = db.QueryRow(`SELECT name, COALESCE(sale_price, price::numeric, 0) FROM products WHERE id::text = $1 OR name = $1 LIMIT 1`, pid).Scan(&pName, &pPrice)
					cartItems = append(cartItems, CartItem{
						ID:        pid,
						ProductID: pid,
						Name:      pName,
						Price:     pPrice,
						Qty:       q,
					})
				}
			}
		}
	}

	// 1. Calculate final totals
	var calculatedSubtotal float64
	for _, itm := range cartItems {
		q := itm.Qty
		if q <= 0 {
			q = 1
		}
		calculatedSubtotal += itm.Price * float64(q)
	}

	if calculatedSubtotal <= 0 && deliveryDetails.Subtotal > 0 {
		calculatedSubtotal = deliveryDetails.Subtotal
	}

	finalDeliveryFee := deliveryDetails.DeliveryFee
	finalTotal := calculatedSubtotal + finalDeliveryFee
	if finalTotal <= 0 && deliveryDetails.TotalAmount > 0 {
		finalTotal = deliveryDetails.TotalAmount
	}

	orderID := fmt.Sprintf("ORD-%d-%04d", time.Now().Unix()%1000000, time.Now().Nanosecond()%10000)

	itemsBytes, _ := json.Marshal(cartItems)
	itemsJSON := string(itemsBytes)

	if db != nil {
		// Ensure order_items table exists
		_, _ = db.Exec(`
			CREATE TABLE IF NOT EXISTS order_items (
				id SERIAL PRIMARY KEY,
				order_id VARCHAR(100) NOT NULL,
				tenant_id VARCHAR(100) NOT NULL DEFAULT '',
				product_id VARCHAR(100) DEFAULT '',
				product_name VARCHAR(255) NOT NULL,
				price NUMERIC(10, 2) DEFAULT 0,
				qty INT DEFAULT 1,
				selected_variant VARCHAR(100) DEFAULT '',
				created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			);
		`)

		// 2. Insert into orders table
		_, err := db.Exec(`
			INSERT INTO orders 
			(order_id, jid, customer_phone, tenant_id, customer_name, delivery_phone, delivery_address, items, total_amount, payment_mode, payment_status, order_status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', 'CONFIRMED', NOW(), NOW())
			ON CONFLICT (order_id) DO UPDATE SET updated_at = NOW()
		`, orderID, cleanJID, cleanPhone, cleanTenantID, custName, cleanPhone, custAddress, itemsJSON, finalTotal, payMode)
		if err != nil {
			log.Printf("⚠️ [Order Service] Insert orders note: %v", err)
		}

		// 3. Insert items into order_items table
		for _, itm := range cartItems {
			prodID := itm.ProductID
			if prodID == "" && itm.ID != nil {
				prodID = fmt.Sprintf("%v", itm.ID)
			}
			pName := itm.Name
			if pName == "" {
				pName = "Catalog Product"
			}
			q := itm.Qty
			if q <= 0 {
				q = 1
			}
			_, _ = db.Exec(`
				INSERT INTO order_items (order_id, tenant_id, product_id, product_name, price, qty, selected_variant, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
			`, orderID, cleanTenantID, prodID, pName, itm.Price, q, itm.SelectedVariant)
		}

		// Upsert into customer_order_states table for state tracking & receipt generation
		_, _ = db.Exec(`
			INSERT INTO customer_order_states 
			(username, customer_phone, jid, tenant_id, customer_name, delivery_phone, delivery_address, items, total_amount, order_id, payment_mode, payment_status, order_status, updated_at)
			VALUES ($1, $2, $3, $1, $4, $2, $5, $6, $7, $8, $9, 'PENDING', 'CONFIRMED', NOW())
			ON CONFLICT (username, customer_phone) DO UPDATE SET
				customer_name = EXCLUDED.customer_name,
				delivery_phone = EXCLUDED.delivery_phone,
				delivery_address = EXCLUDED.delivery_address,
				items = EXCLUDED.items,
				total_amount = EXCLUDED.total_amount,
				order_id = EXCLUDED.order_id,
				payment_mode = EXCLUDED.payment_mode,
				payment_status = EXCLUDED.payment_status,
				order_status = EXCLUDED.order_status,
				jid = EXCLUDED.jid,
				tenant_id = EXCLUDED.tenant_id,
				updated_at = NOW()
		`, cleanTenantID, cleanPhone, cleanJID, custName, custAddress, itemsJSON, finalTotal, orderID, payMode)

		// 4. Clear active cart for jid / customer_phone
		_ = ClearActiveCart(cleanTenantID, cleanPhone)
		_, _ = db.Exec(`
			DELETE FROM active_carts 
			WHERE (customer_phone = $1 OR jid = $2) AND (tenant_id = $3 OR LOWER(username) = LOWER($3))
		`, cleanPhone, cleanJID, cleanTenantID)

		// 5. Update customers table profile info
		if custName != "" || custAddress != "" {
			_, _ = db.Exec(`
				INSERT INTO customers (username, tenant_id, jid, wa_number, whatsapp_number, full_name, name, contact_phone, delivery_phone, delivery_address, saved_address, updated_at)
				VALUES ($1, $1, $2, $3, $3, $4, $4, $3, $3, $5, $5, NOW())
				ON CONFLICT (username, wa_number) DO UPDATE SET
					name = EXCLUDED.name,
					full_name = EXCLUDED.full_name,
					delivery_phone = EXCLUDED.delivery_phone,
					delivery_address = EXCLUDED.delivery_address,
					saved_address = EXCLUDED.saved_address,
					updated_at = NOW()
			`, cleanTenantID, cleanJID, cleanPhone, custName, custAddress)
		}
	}

	log.Printf("🛍️ [Order Service] Order #%s successfully processed for JID: %s (Total: ₹%.2f)", orderID, cleanJID, finalTotal)
	return orderID, nil
}

// SendOrderConfirmationWhatsApp is the SINGLE centralized function for constructing order confirmation notifications and sending thermal PDF receipts.
func SendOrderConfirmationWhatsApp(waClient *whatsmeow.Client, jid string, orderID string) error {
	cleanJID := strings.TrimSpace(jid)
	reg := regexp.MustCompile(`\D`)
	cleanPhone := FormatPhone(reg.ReplaceAllString(strings.Split(cleanJID, "@")[0], ""))
	cleanOrdID := strings.TrimSpace(orderID)

	var totalAmt float64
	var tenantID string = "admin"

	// Fetch order details from DB if needed
	if DB != nil {
		if cleanOrdID != "" {
			_ = DB.QueryRow(`
				SELECT COALESCE(total_amount, 0), COALESCE(tenant_id, 'admin')
				FROM orders WHERE LOWER(order_id) = LOWER($1) LIMIT 1
			`, cleanOrdID).Scan(&totalAmt, &tenantID)
		}
		if cleanOrdID == "" || totalAmt <= 0 {
			_ = DB.QueryRow(`
				SELECT COALESCE(order_id, ''), COALESCE(total_amount, 0), COALESCE(tenant_id, 'admin')
				FROM orders WHERE (customer_phone = $1 OR jid = $2) ORDER BY created_at DESC LIMIT 1
			`, cleanPhone, cleanJID).Scan(&cleanOrdID, &totalAmt, &tenantID)
		}
	}

	if cleanOrdID == "" {
		cleanOrdID = fmt.Sprintf("ORD-%d", time.Now().Unix()%100000)
	}

	// 1. Locate active WhatsApp client instance
	client := waClient
	if client == nil || !client.IsLoggedIn() {
		if c, exists := ActiveClients[tenantID]; exists && c != nil && c.IsLoggedIn() {
			client = c
		} else if c, exists := ActiveClients["admin"]; exists && c != nil && c.IsLoggedIn() {
			client = c
		} else {
			for _, c := range ActiveClients {
				if c != nil && c.IsLoggedIn() {
					client = c
					break
				}
			}
		}
	}

	if client == nil || !client.IsLoggedIn() {
		log.Printf("⚠️ [WhatsApp Notification] No active whatsmeow client for +%s (Order: #%s)", cleanPhone, cleanOrdID)
		return fmt.Errorf("no logged-in whatsapp client available")
	}

	// 2. Centralized Order Confirmation Message Construction (Single Source of Truth)
	confMsg := fmt.Sprintf(
		"🎉 *Order Confirmed!* Your order #%s for ₹%.2f has been successfully placed. We are preparing it for delivery now. Thank you for shopping with us! 🚚✨",
		cleanOrdID, totalAmt,
	)

	// Send formatted text notification
	if err := SendMessage(client, cleanPhone, confMsg); err != nil {
		log.Printf("⚠️ [WhatsApp Notification] Text message error for +%s: %v", cleanPhone, err)
	} else {
		log.Printf("📲 [WhatsApp Notification] Text confirmation delivered to +%s for order #%s", cleanPhone, cleanOrdID)
		go SaveCustomerChatAndPrune(tenantID, cleanPhone, "assistant", confMsg)
	}

	// 3. Generate and deliver dynamic thermal PDF receipt directly to customer JID
	time.Sleep(200 * time.Millisecond)
	if errPdf := SendPDFReceiptHand(client, tenantID, cleanPhone, cleanOrdID); errPdf != nil {
		log.Printf("⚠️ [WhatsApp Notification] PDF receipt error for +%s: %v", cleanPhone, errPdf)
		return errPdf
	}

	log.Printf("📄 [WhatsApp Notification] Thermal PDF receipt delivered to +%s for order #%s", cleanPhone, cleanOrdID)
	return nil
}
