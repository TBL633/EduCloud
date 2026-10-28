package payment

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
		payeeName = "EduCloud Merchant"
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
	req.Header.Set("User-Agent", "EduCloud-PaytmVerifier/1.0")

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

// HTTP API Handlers for EduCloud Multi-Tenant SaaS Integration

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
