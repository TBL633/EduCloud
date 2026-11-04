package payment

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
)

// PaymentConfig holds zero-fee Paytm Soundbox & UPI gateway settings per tenant
type PaymentConfig struct {
	TenantID      string `json:"tenant_id"`
	Username      string `json:"username"`
	Enabled       bool   `json:"enabled"`
	MerchantPhone string `json:"merchant_phone"`
	MerchantVPA   string `json:"merchant_vpa"`
	PaytmMID      string `json:"paytm_mid"`
	PayeeName     string `json:"payee_name"`
}

// PaytmStatusResponse represents the JSON response from Paytm's order status endpoint
type PaytmStatusResponse struct {
	OrderID     string `json:"ORDERID"`
	MID         string `json:"MID"`
	TxnID       string `json:"TXNID"`
	TxnAmount   string `json:"TXNAMOUNT"`
	Status      string `json:"STATUS"` // e.g. "TXN_SUCCESS", "TXN_FAILURE", "PENDING"
	RespCode    string `json:"RESPCODE"`
	RespMsg     string `json:"RESPMSG"`
	BankTxnID   string `json:"BANKTXNID"`
	TxnDate     string `json:"TXNDATE"`
	PaymentMode string `json:"PAYMENTMODE"`
}

// In-Memory thread-safe payment config cache for 512MB RAM performance (0ms lookup)
var (
	onPaymentVerifiedCallback func(tenantID, orderID, amount, txnID string)
	onWebhookPaymentReceived  func(orderID, status, amount string) error
)

// SetPaymentVerifiedCallback registers the function to call when payment is confirmed
func SetPaymentVerifiedCallback(fn func(tenantID, orderID, amount, txnID string)) {
	onPaymentVerifiedCallback = fn
}

// SetWebhookPaymentReceivedCallback registers an optional handler for webhook processing
func SetWebhookPaymentReceivedCallback(fn func(orderID, status, amount string) error) {
	onWebhookPaymentReceived = fn
}

// WorkerQRRequest is the payload sent to Cloudflare Worker to generate dynamic QR
type WorkerQRRequest struct {
	VPA       string `json:"vpa"`
	Name      string `json:"name"`
	OrderID   string `json:"orderId"`
	Amount    string `json:"amount"`
	CloudName string `json:"cloudName"`
}

// WorkerQRResponse represents response from Cloudflare Worker /generate
type WorkerQRResponse struct {
	Status   string `json:"status,omitempty"`
	ImageURL string `json:"imageUrl"`
	Error    string `json:"error,omitempty"`
}

// WorkerStartCheckRequest is the payload sent to Cloudflare Worker to begin async polling
type WorkerStartCheckRequest struct {
	MID        string `json:"mid"`
	OrderID    string `json:"orderId"`
	WebhookURL string `json:"webhookUrl"`
}

// PaymentWebhookPayload is the JSON payload received at /webhook/payment from Cloudflare Worker
type PaymentWebhookPayload struct {
	OrderID string `json:"orderId"`
	Status  string `json:"status"`
	Amount  string `json:"amount"`
}

var (
	configCacheLock sync.RWMutex
	configCacheMap  = make(map[string]PaymentConfig)
	globalDB        *sql.DB
)

// InitPaymentModule registers DB instance and ensures schema table exists
func InitPaymentModule(db *sql.DB) {
	globalDB = db
	if db != nil {
		_, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS tenant_payment_configs (
				username VARCHAR(100) PRIMARY KEY,
				enabled BOOLEAN DEFAULT FALSE,
				merchant_phone VARCHAR(20) DEFAULT '',
				merchant_vpa VARCHAR(100) DEFAULT '',
				paytm_mid VARCHAR(100) DEFAULT '',
				payee_name VARCHAR(100) DEFAULT '',
				updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
			);
		`)
		if err == nil {
			// Load all tenant payment configs into RAM cache on boot
			rows, err := db.Query("SELECT username, enabled, merchant_phone, merchant_vpa, paytm_mid, payee_name FROM tenant_payment_configs")
			if err == nil {
				defer rows.Close()
				configCacheLock.Lock()
				for rows.Next() {
					var cfg PaymentConfig
					_ = rows.Scan(&cfg.Username, &cfg.Enabled, &cfg.MerchantPhone, &cfg.MerchantVPA, &cfg.PaytmMID, &cfg.PayeeName)
					cfg.TenantID = cfg.Username
					configCacheMap[strings.ToLower(cfg.Username)] = cfg
				}
				configCacheLock.Unlock()
			}
		}
	}
}

// GenerateUPIString builds the standard NPCI UPI URI string
func GenerateUPIString(config PaymentConfig, amount float64, orderId string) string {
	vpa := strings.TrimSpace(config.MerchantVPA)
	payeeName := strings.TrimSpace(config.PayeeName)
	if payeeName == "" {
		payeeName = strings.TrimSpace(config.Username)
	}
	if payeeName == "" {
		payeeName = "WaMart Merchant"
	}

	formattedAmount := fmt.Sprintf("%.2f", amount)
	cleanOrderID := strings.TrimSpace(orderId)

	// Standard NPCI UPI URI Format:
	// upi://pay?pa=<vpa>&pn=<payeeName>&am=<amount>&tr=<orderId>&tn=Order_<orderId>&cu=INR
	v := url.Values{}
	v.Set("pa", vpa)
	v.Set("pn", payeeName)
	v.Set("am", formattedAmount)
	v.Set("tr", cleanOrderID)
	v.Set("tn", "Order "+cleanOrderID)
	v.Set("cu", "INR")

	return "upi://pay?" + v.Encode()
}

// GenerateQRCodeBytes generates in-memory PNG QR code bytes using skip2/go-qrcode
// Zero disk I/O, ultra-low memory footprint for 512MB RAM Render instance
func GenerateQRCodeBytes(upiString string) ([]byte, error) {
	if strings.TrimSpace(upiString) == "" {
		return nil, fmt.Errorf("empty UPI URI string")
	}
	// 256x256 size with Medium error correction level
	pngBytes, err := qrcode.Encode(upiString, qrcode.Medium, 256)
	if err != nil {
		return nil, fmt.Errorf("failed to generate QR code bytes: %w", err)
	}
	return pngBytes, nil
}

// VerifyPaytmPayment makes a single lazy-triggered HTTP GET request to Paytm Soundbox status API
// Do NOT use background goroutine polling. This is lazy-triggered by chat input or button click.
func VerifyPaytmPayment(mid string, orderId string) (*PaytmStatusResponse, error) {
	cleanMID := strings.TrimSpace(mid)
	cleanOrderID := strings.TrimSpace(orderId)

	if cleanMID == "" || cleanOrderID == "" {
		return nil, fmt.Errorf("paytm MID and OrderID are required for status verification")
	}

	// Payload expected by Paytm Soundbox Status Endpoint:
	// {"MID":"<mid>","ORDERID":"<orderId>"}
	payloadMap := map[string]string{
		"MID":     cleanMID,
		"ORDERID": cleanOrderID,
	}

	jsonBytes, err := json.Marshal(payloadMap)
	if err != nil {
		return nil, fmt.Errorf("failed to encode Paytm verification payload: %w", err)
	}

	// URL encode the JsonData parameter
	statusURL := fmt.Sprintf("https://securegw.paytm.in/order/status?JsonData=%s", url.QueryEscape(string(jsonBytes)))

	// Single lightweight HTTP GET request with 8-second timeout
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), "GET", statusURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to build Paytm verification request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "WaMart-PaytmVerifier/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("paytm status HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1024*64)) // 64KB max reader limit for RAM safety
	if err != nil {
		return nil, fmt.Errorf("failed to read Paytm status response body: %w", err)
	}

	var statusResp PaytmStatusResponse
	if err := json.Unmarshal(bodyBytes, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse Paytm response JSON (%s): %w", string(bodyBytes), err)
	}

	return &statusResp, nil
}

// SavePaymentConfig persists config to RAM cache and Neon PostgreSQL database
func SavePaymentConfig(cfg PaymentConfig) error {
	cleanUsr := strings.ToLower(strings.TrimSpace(cfg.TenantID))
	if cleanUsr == "" {
		cleanUsr = strings.ToLower(strings.TrimSpace(cfg.Username))
	}
	if cleanUsr == "" {
		return fmt.Errorf("tenant username is required")
	}

	cfg.TenantID = cleanUsr
	cfg.Username = cleanUsr

	// Update RAM cache immediately (0ms latency)
	configCacheLock.Lock()
	configCacheMap[cleanUsr] = cfg
	configCacheLock.Unlock()

	// Asynchronous DB Persistence
	if globalDB != nil {
		go func(c PaymentConfig) {
			query := `
				INSERT INTO tenant_payment_configs (username, enabled, merchant_phone, merchant_vpa, paytm_mid, payee_name, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, NOW())
				ON CONFLICT (username) DO UPDATE SET
					enabled = EXCLUDED.enabled,
					merchant_phone = EXCLUDED.merchant_phone,
					merchant_vpa = EXCLUDED.merchant_vpa,
					paytm_mid = EXCLUDED.paytm_mid,
					payee_name = EXCLUDED.payee_name,
					updated_at = NOW();
			`
			_, _ = globalDB.Exec(query, c.Username, c.Enabled, c.MerchantPhone, c.MerchantVPA, c.PaytmMID, c.PayeeName)
		}(cfg)
	}

	return nil
}

// GetPaymentConfig fetches payment configuration for a given tenant (from RAM or DB)
func GetPaymentConfig(tenantUsername string) PaymentConfig {
	cleanUsr := strings.ToLower(strings.TrimSpace(tenantUsername))

	// 1. RAM Cache lookup (0ms)
	configCacheLock.RLock()
	cfg, exists := configCacheMap[cleanUsr]
	configCacheLock.RUnlock()

	if exists {
		return cfg
	}

	// 2. DB fallback if not in cache
	if globalDB != nil {
		var c PaymentConfig
		err := globalDB.QueryRow(`
			SELECT username, enabled, merchant_phone, merchant_vpa, paytm_mid, payee_name 
			FROM tenant_payment_configs WHERE LOWER(username) = LOWER($1)
		`, cleanUsr).Scan(&c.Username, &c.Enabled, &c.MerchantPhone, &c.MerchantVPA, &c.PaytmMID, &c.PayeeName)
		if err == nil {
			c.TenantID = c.Username
			configCacheLock.Lock()
			configCacheMap[cleanUsr] = c
			configCacheLock.Unlock()
			return c
		}
	}

	return PaymentConfig{
		TenantID: cleanUsr,
		Username: cleanUsr,
		Enabled:  false,
	}
}

// HTTP API Handlers for WaMart Multi-Tenant SaaS Integration

// ConfigHandler handles GET and POST requests for tenant payment setup
func ConfigHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method == "GET" {
		tenantID := r.URL.Query().Get("tenant_id")
		if tenantID == "" {
			tenantID = r.URL.Query().Get("username")
		}
		if tenantID == "" {
			http.Error(w, `{"error":"tenant_id query param required"}`, http.StatusBadRequest)
			return
		}
		cfg := GetPaymentConfig(tenantID)
		_ = json.NewEncoder(w).Encode(cfg)
		return
	}

	if r.Method == "POST" {
		var req PaymentConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid json body"}`, http.StatusBadRequest)
			return
		}
		if err := SavePaymentConfig(req); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "success",
			"message": "Paytm payment configuration saved successfully.",
			"config":  GetPaymentConfig(req.TenantID),
		})
		return
	}

	http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
}

// VerifyHandler handles single lazy-triggered payment status check
func VerifyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TenantID string `json:"tenant_id"`
		MID      string `json:"mid"`
		OrderID  string `json:"order_id"`
	}

	_ = json.NewDecoder(r.Body).Decode(&req)

	mid := strings.TrimSpace(req.MID)
	orderID := strings.TrimSpace(req.OrderID)

	// Fallback MID from tenant config if omitted in request
	if mid == "" && req.TenantID != "" {
		cfg := GetPaymentConfig(req.TenantID)
		mid = cfg.PaytmMID
	}

	if mid == "" || orderID == "" {
		http.Error(w, `{"error":"paytm MID and order_id required"}`, http.StatusBadRequest)
		return
	}

	statusResp, err := VerifyPaytmPayment(mid, orderID)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":   "error",
			"message":  err.Error(),
			"verified": false,
		})
		return
	}

	isSuccess := statusResp.Status == "TXN_SUCCESS"
	if isSuccess && onPaymentVerifiedCallback != nil {
		tenantUser := req.TenantID
		if tenantUser == "" {
			tenantUser = "admin"
		}
		go onPaymentVerifiedCallback(tenantUser, req.OrderID, statusResp.TxnAmount, statusResp.TxnID)
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "success",
		"verified": isSuccess,
		"details":  statusResp,
	})
}

// GenerateQRHandler generates UPI URI and base64 PNG QR code
func GenerateQRHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TenantID  string  `json:"tenant_id"`
		Username  string  `json:"username"`
		Amount    float64 `json:"amount"`
		OrderID   string  `json:"order_id"`
		PayeeName string  `json:"payee_name"`
	}

	_ = json.NewDecoder(r.Body).Decode(&req)
	tenantUser := req.TenantID
	if tenantUser == "" {
		tenantUser = req.Username
	}

	cfg := GetPaymentConfig(tenantUser)
	if !cfg.Enabled {
		http.Error(w, `{"error":"payment gateway disabled for this tenant"}`, http.StatusBadRequest)
		return
	}

	if req.PayeeName != "" {
		cfg.PayeeName = req.PayeeName
	}

	upiURI := GenerateUPIString(cfg, req.Amount, req.OrderID)
	qrBytes, err := GenerateQRCodeBytes(upiURI)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"qr generation failed: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	base64QR := "data:image/png;base64," + base64.StdEncoding.EncodeToString(qrBytes)

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "success",
		"upi_uri":    upiURI,
		"qr_code":    base64QR,
		"amount":     req.Amount,
		"order_id":   req.OrderID,
		"paytm_mid":  cfg.PaytmMID,
		"merchant":   cfg.MerchantVPA,
	})
}

// GetAppWebhookURL determines the full public URL for receiving payment webhooks
func GetAppWebhookURL() string {
	renderURL := strings.TrimSpace(os.Getenv("RENDER_EXTERNAL_URL"))
	if renderURL != "" && !strings.Contains(renderURL, "localhost") && !strings.Contains(renderURL, "127.0.0.1") {
		return strings.TrimSuffix(renderURL, "/") + "/webhook/payment"
	}
	appURL := strings.TrimSpace(os.Getenv("APP_URL"))
	if appURL != "" && !strings.Contains(appURL, "localhost") && !strings.Contains(appURL, "127.0.0.1") {
		return strings.TrimSuffix(appURL, "/") + "/webhook/payment"
	}
	baseURL := strings.TrimSpace(os.Getenv("BASE_URL"))
	if baseURL != "" && !strings.Contains(baseURL, "localhost") && !strings.Contains(baseURL, "127.0.0.1") {
		return strings.TrimSuffix(baseURL, "/") + "/webhook/payment"
	}
	return "https://wamart.onrender.com/webhook/payment"
}

// GenerateWorkerDynamicQR calls the Cloudflare Worker to dynamically generate a branded QR code
// Endpoint: https://wamart.rkmtech633.workers.dev/generate
// Payload: {"vpa": "...", "name": "...", "orderId": "...", "amount": "...", "cloudName": "..."}
// Returns the image URL and the downloaded byte array for whatsmeow media upload
func GenerateWorkerDynamicQR(vpa, name, orderID, amount, cloudName string) (string, []byte, error) {
	cleanVPA := strings.TrimSpace(vpa)
	cleanName := strings.TrimSpace(name)
	cleanOrderID := strings.TrimSpace(orderID)
	cleanAmount := strings.TrimSpace(amount)
	cleanCloud := strings.TrimSpace(cloudName)

	if cleanCloud == "" {
		cleanCloud = strings.TrimSpace(os.Getenv("CLOUDINARY_CLOUD_NAME"))
		if cleanCloud == "" {
			cleanCloud = strings.TrimSpace(os.Getenv("CLOUDINARY_NAME"))
		}
		if cleanCloud == "" {
			cleanCloud = "hq67khm3"
		}
	}

	reqBody := WorkerQRRequest{
		VPA:       cleanVPA,
		Name:      cleanName,
		OrderID:   cleanOrderID,
		Amount:    cleanAmount,
		CloudName: cleanCloud,
	}

	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", nil, fmt.Errorf("failed to encode worker qr request: %w", err)
	}

	upiURI := fmt.Sprintf("upi://pay?pa=%s&pn=%s&am=%s&tr=%s&tn=Order_%s&cu=INR", cleanVPA, cleanName, cleanAmount, cleanOrderID, cleanOrderID)

	// Pre-construct exact Cloudinary dynamic QR URL as per specification:
	// https://res.cloudinary.com/hq67khm3/image/upload/l_fetch:{base64QrUrl}/w_450,h_450,y_-120/fl_layer_apply/v1793634745/WaMart.jpg
	qrAPIURL := fmt.Sprintf("https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=%s", url.QueryEscape(upiURI))
	base64QrUrl := base64.StdEncoding.EncodeToString([]byte(qrAPIURL))
	exactCloudinaryURL := fmt.Sprintf("https://res.cloudinary.com/%s/image/upload/l_fetch:%s/w_450,h_450,y_-120/fl_layer_apply/v1793634745/WaMart.jpg", cleanCloud, base64QrUrl)

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), "POST", "https://wamart.rkmtech633.workers.dev/generate", bytes.NewReader(jsonBytes))
	if err != nil {
		return generateReliableFallbackQR(upiURI)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "WaMart-PaymentWorkerClient/1.0")

	resp, err := client.Do(req)
	var imageURL string
	if err == nil && resp.StatusCode == http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, errRead := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		if errRead == nil {
			var qrResp WorkerQRResponse
			if errJson := json.Unmarshal(bodyBytes, &qrResp); errJson == nil && qrResp.ImageURL != "" {
				imageURL = strings.TrimSpace(qrResp.ImageURL)
			} else {
				var rawMap map[string]interface{}
				if errMap := json.Unmarshal(bodyBytes, &rawMap); errMap == nil {
					if u, ok := rawMap["imageUrl"].(string); ok && u != "" {
						imageURL = strings.TrimSpace(u)
					}
				}
			}
		}
	} else if resp != nil {
		resp.Body.Close()
	}

	// Ensure exact Cloudinary asset path: /v1793634745/WaMart.jpg instead of obsolete /WaMart.png
	if imageURL != "" && strings.Contains(imageURL, "/WaMart.png") {
		imageURL = strings.Replace(imageURL, "/WaMart.png", "/v1793634745/WaMart.jpg", 1)
	}
	if imageURL == "" {
		imageURL = exactCloudinaryURL
	}

	// Download image as byte array to verify and send via whatsmeow
	imgResp, err := client.Get(imageURL)
	if err != nil {
		log.Printf("⚠️ [Worker QR Warning] Failed to download image from %s: %v. Using fallback QR.", imageURL, err)
		return generateReliableFallbackQR(upiURI)
	}
	defer imgResp.Body.Close()

	if imgResp.StatusCode != http.StatusOK {
		log.Printf("⚠️ [Worker QR Warning] Worker image URL (%s) returned HTTP %d (Cloudinary asset missing). Using fallback QR.", imageURL, imgResp.StatusCode)
		return generateReliableFallbackQR(upiURI)
	}

	imgBytes, err := io.ReadAll(io.LimitReader(imgResp.Body, 1024*1024*8)) // 8MB limit
	if err != nil || len(imgBytes) < 50 {
		return generateReliableFallbackQR(upiURI)
	}

	// Validate magic bytes to ensure it's a real image and not an HTML error document
	isValidImage := bytes.HasPrefix(imgBytes, []byte("\x89PNG")) || bytes.HasPrefix(imgBytes, []byte("\xff\xd8")) || bytes.HasPrefix(imgBytes, []byte("RIFF")) || bytes.HasPrefix(imgBytes, []byte("GIF8"))
	if !isValidImage {
		log.Printf("⚠️ [Worker QR Warning] Downloaded file from %s is not a valid image format. Using fallback QR.", imageURL)
		return generateReliableFallbackQR(upiURI)
	}

	return imageURL, imgBytes, nil
}

// generateReliableFallbackQR produces a guaranteed valid QR image from high-availability local generator or remote server
func generateReliableFallbackQR(upiURI string) (string, []byte, error) {
	// 1. In-memory zero-network generation: skip2/go-qrcode (100% reliable, zero external downtime risk, 0ms latency)
	localBytes, localErr := qrcode.Encode(upiURI, qrcode.Medium, 400)
	if localErr == nil && len(localBytes) > 50 && bytes.HasPrefix(localBytes, []byte("\x89PNG")) {
		base64Data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(localBytes)
		return base64Data, localBytes, nil
	}

	// 2. Remote fallback if local encoder has any error
	fallbackURL := fmt.Sprintf("https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=%s", url.QueryEscape(upiURI))
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fallbackURL)
	if err == nil && resp.StatusCode == http.StatusOK {
		defer resp.Body.Close()
		bytesData, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024*1024*2))
		if readErr == nil && len(bytesData) > 50 && bytes.HasPrefix(bytesData, []byte("\x89PNG")) {
			return fallbackURL, bytesData, nil
		}
	}

	return "", nil, fmt.Errorf("failed to generate fallback QR image: %v", localErr)
}

// StartWorkerPaymentCheck sends an asynchronous request to the Cloudflare Worker to offload Paytm polling
// Endpoint: https://wamart.rkmtech633.workers.dev/start-check
// Payload: {"mid": "...", "orderId": "...", "webhookUrl": "..."}
func StartWorkerPaymentCheck(mid, orderID, webhookURL string) error {
	cleanMID := strings.TrimSpace(mid)
	cleanOrderID := strings.TrimSpace(orderID)
	cleanWebhook := strings.TrimSpace(webhookURL)
	if cleanWebhook == "" || strings.Contains(cleanWebhook, "localhost") || strings.Contains(cleanWebhook, "127.0.0.1") {
		cleanWebhook = GetAppWebhookURL()
	}

	if cleanMID == "" || cleanOrderID == "" {
		return fmt.Errorf("mid and orderId are required for start-check")
	}

	reqBody := WorkerStartCheckRequest{
		MID:        cleanMID,
		OrderID:    cleanOrderID,
		WebhookURL: cleanWebhook,
	}

	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("failed to encode start-check request: %w", err)
	}

	fmt.Println("🚀 [Cloudflare Worker Poll] Dispatching start-check with live Webhook URL:", cleanWebhook, "for Order:", cleanOrderID)
	fmt.Println("📡 Dispatching StartWorkerPaymentCheck payload to Worker:", string(jsonBytes))

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), "POST", "https://wamart.rkmtech633.workers.dev/start-check", bytes.NewReader(jsonBytes))
	if err != nil {
		return fmt.Errorf("failed to build start-check request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "WaMart-PaymentWorkerClient/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("start-check request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*64))
	log.Printf("📡 [Cloudflare Worker Poll Initiated] Order: %s | Status: %d | Webhook: %s | Resp: %s", cleanOrderID, resp.StatusCode, cleanWebhook, string(bodyBytes))
	return nil
}

// PaymentWebhookHandler receives asynchronous payment confirmation callbacks from Cloudflare Worker
// Endpoint: POST /webhook/payment
// Payload: {"orderId": "...", "status": "SUCCESS", "amount": "..."}
func PaymentWebhookHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 1024*128))
	if err != nil {
		http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
		return
	}

	var rawMap map[string]interface{}
	_ = json.Unmarshal(bodyBytes, &rawMap)

	var payload PaymentWebhookPayload
	_ = json.Unmarshal(bodyBytes, &payload)

	// User requested exact diagnostic logging
	log.Printf("WEBHOOK RECEIVED: %+v", payload)
	log.Printf("🔔 [Payment Webhook Received Raw Payload]: %s", string(bodyBytes))

	orderID := strings.TrimSpace(payload.OrderID)
	status := strings.ToUpper(strings.TrimSpace(payload.Status))
	amount := strings.TrimSpace(payload.Amount)

	// Robust case-insensitive fallback parsing
	for k, v := range rawMap {
		kLower := strings.ToLower(k)
		strVal := strings.TrimSpace(fmt.Sprintf("%v", v))
		if (kLower == "orderid" || kLower == "order_id" || kLower == "ord_id" || kLower == "order") && orderID == "" {
			orderID = strVal
		}
		if (kLower == "status" || kLower == "payment_status" || kLower == "result" || kLower == "txn_status") && status == "" {
			status = strings.ToUpper(strVal)
		}
		if (kLower == "amount" || kLower == "txnamount" || kLower == "total_amount" || kLower == "total") && amount == "" {
			amount = strVal
		}
	}

	fmt.Printf("🔔 [Payment Webhook Received] OrderID: %s | Status: %s | Amount: %s\n", orderID, status, amount)

	if orderID == "" {
		http.Error(w, `{"error":"orderId is required"}`, http.StatusBadRequest)
		return
	}

	isSuccess := status == "SUCCESS" || status == "TXN_SUCCESS" || status == "PAID" || status == "COMPLETED" || status == "CONFIRMED"

	var username, customerPhone string
	var totalAmount float64

	// Update Neon DB
	if globalDB != nil {
		// 1. Fetch current order info by order_id (case-insensitive exact)
		_ = globalDB.QueryRow(`
			SELECT username, customer_phone, total_amount 
			FROM customer_order_states WHERE LOWER(order_id) = LOWER($1) LIMIT 1
		`, orderID).Scan(&username, &customerPhone, &totalAmount)

		// 2. Partial match fallback
		if username == "" || customerPhone == "" {
			_ = globalDB.QueryRow(`
				SELECT username, customer_phone, total_amount 
				FROM customer_order_states 
				WHERE order_id LIKE '%' || $1 || '%' OR $1 LIKE '%' || order_id || '%' 
				ORDER BY updated_at DESC LIMIT 1
			`, orderID).Scan(&username, &customerPhone, &totalAmount)
		}

		// 3. Fallback resolution if exact order_id row wasn't found (matching 4-digit phone suffix)
		if (username == "" || customerPhone == "") && strings.HasPrefix(orderID, "ORD_") {
			parts := strings.Split(orderID, "_")
			if len(parts) >= 2 {
				phoneSuffix := parts[1]
				_ = globalDB.QueryRow(`
					SELECT username, wa_number 
					FROM customers 
					WHERE wa_number LIKE '%' || $1 AND payment_status = 'PENDING' 
					ORDER BY updated_at DESC LIMIT 1
				`, phoneSuffix).Scan(&username, &customerPhone)
			}
		}

		// 4. Fallback to latest customer waiting in PENDING
		if username == "" || customerPhone == "" {
			_ = globalDB.QueryRow(`
				SELECT username, wa_number 
				FROM customers 
				WHERE payment_status = 'PENDING' 
				ORDER BY updated_at DESC LIMIT 1
			`).Scan(&username, &customerPhone)
		}

		if isSuccess {
			// 2. Mark order as paid & confirmed in customer_order_states
			_, err = globalDB.Exec(`
				UPDATE customer_order_states 
				SET payment_status = 'paid', order_status = 'confirmed', updated_at = NOW() 
				WHERE LOWER(order_id) = LOWER($1)
			`, orderID)
			if err != nil {
				log.Printf("⚠️ Error updating customer_order_states for %s: %v", orderID, err)
			}

			// 3. Unlock State: Set customer state to ORDER_CONFIRMED, payment_status to PAID in customers & active_carts
			if username != "" && customerPhone != "" {
				_, _ = globalDB.Exec(`
					UPDATE customers 
					SET current_state = 'ORDER_CONFIRMED', payment_status = 'PAID', updated_at = NOW() 
					WHERE (LOWER(username) = LOWER($1) OR LOWER(username) = LOWER($1) || '@gmail.com') AND wa_number = $2
				`, username, customerPhone)

				_, _ = globalDB.Exec(`
					UPDATE active_carts 
					SET payment_status = 'PAID' 
					WHERE (LOWER(username) = LOWER($1) OR LOWER(username) = LOWER($1) || '@gmail.com') AND customer_phone = $2
				`, username, customerPhone)

				_, _ = globalDB.Exec(`
					DELETE FROM active_carts 
					WHERE (LOWER(username) = LOWER($1) OR LOWER(username) = LOWER($1) || '@gmail.com') AND customer_phone = $2
				`, username, customerPhone)
				log.Printf("🔓 [State Unlocked on Webhook SUCCESS]: @%s (+%s) -> ORDER_CONFIRMED & payment_status = PAID", username, customerPhone)
			}

			if customerPhone != "" && username == "" {
				_, _ = globalDB.Exec(`
					UPDATE customers 
					SET current_state = 'ORDER_CONFIRMED', payment_status = 'PAID', updated_at = NOW() 
					WHERE wa_number = $1
				`, customerPhone)
				_, _ = globalDB.Exec(`
					UPDATE active_carts 
					SET payment_status = 'PAID' 
					WHERE customer_phone = $1
				`, customerPhone)
				_, _ = globalDB.Exec(`
					DELETE FROM active_carts 
					WHERE customer_phone = $1
				`, customerPhone)
			}

			// 4. Insert into leads table
			if username != "" {
				leadInquiry := fmt.Sprintf("Order %s | Amount: ₹%s | Cloudflare Worker Async Verified", orderID, amount)
				_, _ = globalDB.Exec(`
					INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at)
					VALUES ($1, $2, $3, 'Confirmed Paid (Paytm Cloudflare Worker)', NOW())
				`, username, customerPhone, leadInquiry)
			}
		}
	}

	if amount == "" && totalAmount > 0 {
		amount = fmt.Sprintf("%.2f", totalAmount)
	}

	// Trigger registered callback (instant whatsmeow message to customer & lead alert to merchant)
	if isSuccess && onPaymentVerifiedCallback != nil {
		tenantUser := username
		if tenantUser == "" {
			tenantUser = "admin"
		}
		go onPaymentVerifiedCallback(tenantUser, orderID, amount, "WORKER_VERIFIED")
	}

	if isSuccess && onWebhookPaymentReceived != nil {
		go func() {
			_ = onWebhookPaymentReceived(orderID, status, amount)
		}()
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "ok",
		"received": true,
		"orderId":  orderID,
		"verified": isSuccess,
	})
}

