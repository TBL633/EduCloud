package whatsapp

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// GenerateThermalReceiptPDF generates a dynamic thermal-printer style (80mm width) receipt PDF directly in a memory buffer.
// Zero load on server, zero disk I/O, no headless browser needed.
func GenerateThermalReceiptPDF(orderID string, db *sql.DB) (*bytes.Buffer, error) {
	if db == nil {
		db = DB
	}

	cleanOrderID := strings.TrimSpace(orderID)

	var tenantUsername, custPhone, custName, custAddress, itemsJSON, payMode, payStatus, ordStatus, createdAtStr string
	var totalAmt float64

	// 1. First query orders table for specific order details
	if db != nil && cleanOrderID != "" {
		err := db.QueryRow(`
			SELECT COALESCE(tenant_id, ''), COALESCE(customer_phone, ''), COALESCE(customer_name, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, ''), COALESCE(payment_status, ''), COALESCE(order_status, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '')
			FROM orders
			WHERE LOWER(order_id) = LOWER($1) OR order_id LIKE '%' || $1
			ORDER BY created_at DESC LIMIT 1
		`, cleanOrderID).Scan(&tenantUsername, &custPhone, &custName, &custAddress, &itemsJSON, &totalAmt, &payMode, &payStatus, &ordStatus, &createdAtStr)
		if err != nil && tenantUsername == "" {
			// Query customer_order_states as secondary source
			_ = db.QueryRow(`
				SELECT COALESCE(username, ''), COALESCE(customer_phone, ''), COALESCE(customer_name, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, ''), COALESCE(payment_status, ''), COALESCE(order_status, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '')
				FROM customer_order_states
				WHERE LOWER(order_id) = LOWER($1) OR order_id LIKE '%' || $1
				ORDER BY updated_at DESC LIMIT 1
			`, cleanOrderID).Scan(&tenantUsername, &custPhone, &custName, &custAddress, &itemsJSON, &totalAmt, &payMode, &payStatus, &ordStatus, &createdAtStr)
		}
	}

	// Fallback query if orderID was empty or not matched
	if (tenantUsername == "" || itemsJSON == "[]" || itemsJSON == "") && db != nil {
		err := db.QueryRow(`
			SELECT COALESCE(tenant_id, ''), COALESCE(customer_phone, ''), COALESCE(customer_name, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, ''), COALESCE(payment_status, ''), COALESCE(order_id, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '')
			FROM orders
			ORDER BY created_at DESC LIMIT 1
		`).Scan(&tenantUsername, &custPhone, &custName, &custAddress, &itemsJSON, &totalAmt, &payMode, &payStatus, &cleanOrderID, &createdAtStr)
		if err != nil {
			_ = db.QueryRow(`
				SELECT COALESCE(username, ''), COALESCE(customer_phone, ''), COALESCE(customer_name, ''), COALESCE(delivery_address, ''), COALESCE(items::text, '[]'), COALESCE(total_amount, 0), COALESCE(payment_mode, ''), COALESCE(payment_status, ''), COALESCE(order_id, ''), COALESCE(TO_CHAR(created_at, 'DD Mon YYYY HH24:MI'), '')
				FROM customer_order_states
				ORDER BY updated_at DESC LIMIT 1
			`).Scan(&tenantUsername, &custPhone, &custName, &custAddress, &itemsJSON, &totalAmt, &payMode, &payStatus, &cleanOrderID, &createdAtStr)
		}
	}

	if cleanOrderID == "" {
		cleanOrderID = fmt.Sprintf("ORD-%d", time.Now().Unix()%100000)
	}
	if createdAtStr == "" {
		createdAtStr = time.Now().Format("02 Jan 2006 15:04")
	}

	// 2. Query Tenant Business details from users table
	var bName, bPhone string
	if db != nil && tenantUsername != "" {
		_ = db.QueryRow(`
			SELECT COALESCE(NULLIF(business_name, ''), NULLIF(account_name, ''), username), COALESCE(notification_phone, phone, '')
			FROM users
			WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
			LIMIT 1
		`, tenantUsername).Scan(&bName, &bPhone)
	}
	if bName == "" {
		bName = "WaMart Store"
	}

	// 3. Parse Item details
	type pdfItem struct {
		Name  string
		Qty   int
		Price float64
	}
	var itemList []pdfItem

	if itemsJSON != "" && itemsJSON != "[]" {
		var rawItems []CartItemDetail
		if errUnm := json.Unmarshal([]byte(itemsJSON), &rawItems); errUnm == nil && len(rawItems) > 0 {
			for _, it := range rawItems {
				q := it.Qty
				if q <= 0 {
					q = it.Quantity
				}
				if q <= 0 {
					q = 1
				}
				pName := strings.TrimSpace(it.ProductName)
				if pName == "" {
					pName = "Item"
				}
				itemList = append(itemList, pdfItem{
					Name:  pName,
					Qty:   q,
					Price: it.LineTotal,
				})
			}
		}
	}

	// Fallback if items list is empty
	if len(itemList) == 0 {
		itemList = append(itemList, pdfItem{
			Name:  "Order Items Package",
			Qty:   1,
			Price: totalAmt,
		})
	}

	// Calculate Total if totalAmt is 0
	if totalAmt <= 0 {
		for _, it := range itemList {
			totalAmt += it.Price
		}
	}

	// 4. Calculate dynamic thermal paper height (80mm width standard roll)
	pageHeight := 95.0 + float64(len(itemList))*9.0
	if pageHeight < 110.0 {
		pageHeight = 110.0
	}

	// 5. Initialize gofpdf with 80mm Custom Width
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           gofpdf.SizeType{Wd: 80, Ht: pageHeight},
	})

	pdf.SetMargins(4, 4, 4)
	pdf.SetAutoPageBreak(false, 0)
	pdf.AddPage()

	// Header: TENANT BUSINESS DETAILS (DO NOT put WaMart at top!)
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(72, 6, bName, "", 1, "C", false, 0, "")

	if bPhone != "" {
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(72, 4, "Ph: +"+bPhone, "", 1, "C", false, 0, "")
	}

	// Top Divider
	pdf.SetFont("Arial", "", 8)
	pdf.Ln(2)
	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")

	// Meta Information
	pdf.SetFont("Arial", "B", 9)
	pdf.CellFormat(72, 4, "OFFICIAL ORDER RECEIPT", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(72, 4, fmt.Sprintf("Order ID: #%s", cleanOrderID), "", 1, "L", false, 0, "")
	pdf.CellFormat(72, 4, fmt.Sprintf("Date: %s", createdAtStr), "", 1, "L", false, 0, "")

	if custName != "" && custName != "Customer" {
		pdf.CellFormat(72, 4, fmt.Sprintf("Customer: %s", custName), "", 1, "L", false, 0, "")
	}
	if custPhone != "" {
		pdf.CellFormat(72, 4, fmt.Sprintf("Phone: +%s", custPhone), "", 1, "L", false, 0, "")
	}
	if custAddress != "" {
		pdf.MultiCell(72, 4, fmt.Sprintf("Address: %s", custAddress), "", "L", false)
	}

	// Items Header Divider
	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(46, 4, "QTY x ITEM", "", 0, "L", false, 0, "")
	pdf.CellFormat(26, 4, "PRICE", "", 1, "R", false, 0, "")
	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")

	// Items Loop
	pdf.SetFont("Arial", "", 8)
	for _, it := range itemList {
		itemStr := fmt.Sprintf("%dx %s", it.Qty, it.Name)
		if len(itemStr) > 28 {
			itemStr = itemStr[:26] + ".."
		}
		pdf.CellFormat(46, 4.5, itemStr, "", 0, "L", false, 0, "")
		pdf.CellFormat(26, 4.5, fmt.Sprintf("Rs. %.2f", it.Price), "", 1, "R", false, 0, "")
	}

	// Totals Section
	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(46, 4, "Subtotal:", "", 0, "L", false, 0, "")
	pdf.CellFormat(26, 4, fmt.Sprintf("Rs. %.2f", totalAmt), "", 1, "R", false, 0, "")

	pdf.CellFormat(46, 4, "Delivery Fee:", "", 0, "L", false, 0, "")
	pdf.CellFormat(26, 4, "Rs. 0.00", "", 1, "R", false, 0, "")

	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 9)
	pdf.CellFormat(46, 5, "TOTAL AMOUNT:", "", 0, "L", false, 0, "")
	pdf.CellFormat(26, 5, fmt.Sprintf("Rs. %.2f", totalAmt), "", 1, "R", false, 0, "")

	// Status Formatting
	pdf.Ln(1)
	cleanStatus := strings.ToLower(payStatus)
	cleanMode := strings.ToLower(payMode)

	isPaid := strings.Contains(cleanStatus, "paid") || cleanMode == "online" || cleanMode == "upi" || cleanMode == "qr"
	statusText := "Status: CASH ON DELIVERY"
	if isPaid {
		statusText = "Status: PAID (Online)"
	}

	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(72, 5, statusText, "", 1, "C", false, 0, "")

	// Footer: Powered by WaMart (Platform Branding)
	pdf.Ln(2)
	pdf.CellFormat(72, 3, "--------------------------------------------------", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "I", 7)
	pdf.CellFormat(72, 4, "Thank you for your order!", "", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(72, 4, "Powered by WaMart", "", 1, "C", false, 0, "")

	var buf bytes.Buffer
	err := pdf.Output(&buf)
	if err != nil {
		return nil, fmt.Errorf("pdf generation failed: %w", err)
	}

	return &buf, nil
}

// SendPDFReceiptHand generates the thermal receipt PDF in RAM and delivers it as a WhatsApp DocumentMessage
func SendPDFReceiptHand(client *whatsmeow.Client, username, customerPhone, orderID string) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp client is disconnected")
	}

	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	cleanOrdID := strings.TrimSpace(orderID)

	if cleanOrdID == "" {
		cleanOrdID = GetCustomerCurrentOrderID(cleanUsr, cleanPhone)
	}

	// 1. Generate Thermal Receipt PDF directly in memory buffer (Zero disk IO)
	pdfBuf, err := GenerateThermalReceiptPDF(cleanOrdID, DB)
	if err != nil {
		log.Printf("⚠️ [Thermal PDF Hand] PDF generation error for +%s (Order: %s): %v", cleanPhone, cleanOrdID, err)
		return err
	}

	if pdfBuf == nil || pdfBuf.Len() == 0 {
		return fmt.Errorf("generated PDF buffer is empty")
	}

	// 2. Upload PDF buffer directly to WhatsApp
	uploaded, errUp := client.Upload(context.Background(), pdfBuf.Bytes(), whatsmeow.MediaDocument)
	if errUp != nil {
		log.Printf("⚠️ [Thermal PDF Hand] WhatsApp upload error for +%s: %v", cleanPhone, errUp)
		return fmt.Errorf("whatsapp media upload failed: %w", errUp)
	}

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[customerPhone]
	}
	lidCacheLock.RUnlock()

	if !hasTargetJID {
		primaryServer := types.DefaultUserServer
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	dispID := cleanOrdID
	dispID = strings.TrimPrefix(dispID, "#")
	if dispID == "" {
		dispID = "Order"
	}

	// 3. Construct DocumentMessage
	docMsg := &waE2E.Message{
		DocumentMessage: &waE2E.DocumentMessage{
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      proto.String("application/pdf"),
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    proto.Uint64(uint64(pdfBuf.Len())),
			Title:         proto.String("Order Receipt #" + dispID),
			FileName:      proto.String("Receipt_" + dispID + ".pdf"),
		},
	}

	// 4. Deliver DocumentMessage via whatsmeow
	_, errSend := client.SendMessage(context.Background(), targetJID, docMsg)
	if errSend != nil {
		log.Printf("⚠️ [Thermal PDF Hand] SendMessage error for +%s: %v", cleanPhone, errSend)
		return errSend
	}

	log.Printf("📄 [Thermal PDF Hand] Receipt_%s.pdf successfully delivered to +%s", dispID, cleanPhone)
	return nil
}

// TriggerWebOrderConfirmationPush sends formatted text confirmation and thermal PDF receipt to the customer's WhatsApp upon web checkout
func TriggerWebOrderConfirmationPush(tenantUsername, customerPhoneOrJID, orderID string, totalAmount float64) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tenantUsername), "@"))
	cleanPhone := FormatPhone(customerPhoneOrJID)
	cleanOrdID := strings.TrimSpace(orderID)

	// 1. Locate active WhatsApp client instance
	client, exists := ActiveClients[cleanUsr]
	if !exists || client == nil || !client.IsLoggedIn() {
		client, exists = ActiveClients["admin"]
	}
	if !exists || client == nil || !client.IsLoggedIn() {
		for _, c := range ActiveClients {
			if c != nil && c.IsLoggedIn() {
				client = c
				break
			}
		}
	}

	if client == nil || !client.IsLoggedIn() {
		log.Printf("⚠️ [Web Checkout Push] No logged-in WhatsApp client available for tenant @%s; push queued", cleanUsr)
		return fmt.Errorf("no logged-in WhatsApp client available")
	}

	// 2. Send active push notification text
	confMsg := fmt.Sprintf("🎉 *Order Received!* Your web order #%s for ₹%.2f has been successfully placed. We are processing it now.", cleanOrdID, totalAmount)
	if err := SendMessage(client, cleanPhone, confMsg); err != nil {
		log.Printf("⚠️ [Web Checkout Push] Text message error for +%s: %v", cleanPhone, err)
	} else {
		log.Printf("📲 [Web Checkout Push] Text confirmation delivered to +%s for order #%s", cleanPhone, cleanOrdID)
		go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", confMsg)
	}

	// 3. Immediately generate thermal receipt PDF and send as DocumentMessage in same thread
	time.Sleep(300 * time.Millisecond)
	if errPdf := SendPDFReceiptHand(client, cleanUsr, cleanPhone, cleanOrdID); errPdf != nil {
		log.Printf("⚠️ [Web Checkout Push] PDF delivery error for +%s: %v", cleanPhone, errPdf)
		return errPdf
	}

	log.Printf("📄 [Web Checkout Push] Thermal PDF receipt successfully delivered to +%s for order #%s", cleanPhone, cleanOrdID)
	return nil
}

