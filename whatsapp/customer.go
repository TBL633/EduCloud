package whatsapp

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	"wa-server/payment"
)

// CustomerProfile represents persistent profile details for a WhatsApp customer
// CustomerProfile represents persistent profile details for a WhatsApp customer
type CustomerProfile struct {
	ID               int       `json:"id"`
	Username         string    `json:"username"`
	WANumber         string    `json:"wa_number"`
	FullName         string    `json:"full_name"`
	DeliveryAddress  string    `json:"delivery_address"`
	ContactPhone     string    `json:"contact_phone"`
	Latitude         float64   `json:"latitude"`
	Longitude        float64   `json:"longitude"`
	LastOrderDetails string    `json:"last_order_details"`
	CurrentState     string    `json:"current_state"`  // "chatting", "PAYMENT_PENDING", "ORDER_CONFIRMED"
	PaymentStatus    string    `json:"payment_status"` // "UNPAID", "PENDING", "PAID", "CANCELLED"
	CurrentOrderID   string    `json:"current_order_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

var (
	// In-memory cache for customer profiles: "username_waNumber" -> *CustomerProfile
	customerCache     = make(map[string]*CustomerProfile)
	customerCacheLock sync.RWMutex
)

// GetCustomerProfile retrieves customer profile from 0ms RAM cache or Neon DB
func GetCustomerProfile(username, waNumber string) (*CustomerProfile, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(waNumber)
	if cleanPhone == "" {
		return nil, fmt.Errorf("empty customer phone number")
	}

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.RLock()
	cached, found := customerCache[cacheKey]
	customerCacheLock.RUnlock()
	if found && cached != nil {
		return cached, nil
	}

	if DB == nil {
		return nil, nil
	}

	cp := &CustomerProfile{
		Username:      cleanUsr,
		WANumber:      cleanPhone,
		CurrentState:  "chatting",
		PaymentStatus: "UNPAID",
	}

	query := `SELECT id, username, wa_number, COALESCE(full_name, ''), COALESCE(delivery_address, ''), 
		COALESCE(contact_phone, ''), COALESCE(latitude, 0), COALESCE(longitude, 0), 
		COALESCE(last_order_details, ''), COALESCE(NULLIF(current_state, ''), 'chatting'), 
		COALESCE(NULLIF(payment_status, ''), 'UNPAID'), COALESCE(NULLIF(current_order_id, ''), ''), created_at, updated_at 
		FROM customers 
		WHERE LOWER(username)=LOWER($1) AND wa_number=$2 LIMIT 1`

	err := DB.QueryRow(query, cleanUsr, cleanPhone).Scan(
		&cp.ID, &cp.Username, &cp.WANumber, &cp.FullName, &cp.DeliveryAddress,
		&cp.ContactPhone, &cp.Latitude, &cp.Longitude,
		&cp.LastOrderDetails, &cp.CurrentState, &cp.PaymentStatus, &cp.CurrentOrderID, &cp.CreatedAt, &cp.UpdatedAt,
	)

	if err != nil {
		// Fallback check across all accounts by phone if not found under specific tenant
		fallbackQuery := `SELECT id, username, wa_number, COALESCE(full_name, ''), COALESCE(delivery_address, ''), 
			COALESCE(contact_phone, ''), COALESCE(latitude, 0), COALESCE(longitude, 0), 
			COALESCE(last_order_details, ''), COALESCE(NULLIF(current_state, ''), 'chatting'), 
			COALESCE(NULLIF(payment_status, ''), 'UNPAID'), COALESCE(NULLIF(current_order_id, ''), ''), created_at, updated_at 
			FROM customers 
			WHERE wa_number=$1 ORDER BY updated_at DESC LIMIT 1`
		errFallback := DB.QueryRow(fallbackQuery, cleanPhone).Scan(
			&cp.ID, &cp.Username, &cp.WANumber, &cp.FullName, &cp.DeliveryAddress,
			&cp.ContactPhone, &cp.Latitude, &cp.Longitude,
			&cp.LastOrderDetails, &cp.CurrentState, &cp.PaymentStatus, &cp.CurrentOrderID, &cp.CreatedAt, &cp.UpdatedAt,
		)
		if errFallback != nil {
			return nil, nil
		}
	}

	customerCacheLock.Lock()
	customerCache[cacheKey] = cp
	customerCacheLock.Unlock()

	return cp, nil
}

// GetCustomerState retrieves customer's current state (default: "chatting")
func GetCustomerState(username, customerPhone string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return "chatting"
	}
	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.RLock()
	cached, found := customerCache[cacheKey]
	customerCacheLock.RUnlock()
	if found && cached != nil && cached.CurrentState != "" {
		return cached.CurrentState
	}

	if DB == nil {
		return "chatting"
	}

	var state string
	err := DB.QueryRow(`SELECT COALESCE(NULLIF(current_state, ''), 'chatting') FROM customers WHERE LOWER(username)=LOWER($1) AND wa_number=$2 LIMIT 1`, cleanUsr, cleanPhone).Scan(&state)
	if err != nil || state == "" {
		return "chatting"
	}

	customerCacheLock.Lock()
	if cached != nil {
		cached.CurrentState = state
	}
	customerCacheLock.Unlock()

	return state
}

// SetCustomerState updates the customer's current_state in DB and in-memory cache
func SetCustomerState(username, customerPhone, state string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone")
	}
	if state == "" {
		state = "chatting"
	}

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.Lock()
	if cached, found := customerCache[cacheKey]; found && cached != nil {
		cached.CurrentState = state
	} else {
		customerCache[cacheKey] = &CustomerProfile{
			Username:     cleanUsr,
			WANumber:     cleanPhone,
			CurrentState: state,
			UpdatedAt:    time.Now(),
		}
	}
	customerCacheLock.Unlock()

	if DB == nil {
		return nil
	}

	query := `INSERT INTO customers (username, wa_number, current_state, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (username, wa_number) DO UPDATE SET
			current_state = EXCLUDED.current_state,
			updated_at = NOW()`
	_, err := DB.Exec(query, cleanUsr, cleanPhone, state)
	if err != nil {
		log.Printf("⚠️ SetCustomerState error for @%s (+%s -> %s): %v", cleanUsr, cleanPhone, state, err)
		return err
	}
	log.Printf("🔒 [Customer State Locked/Updated]: @%s (+%s) -> '%s'", cleanUsr, cleanPhone, state)
	return nil
}

// GetCustomerPaymentStatus retrieves customer's current payment_status (default: "UNPAID")
func GetCustomerPaymentStatus(username, customerPhone string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return "UNPAID"
	}
	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.RLock()
	cached, found := customerCache[cacheKey]
	customerCacheLock.RUnlock()
	if found && cached != nil && cached.PaymentStatus != "" {
		return cached.PaymentStatus
	}

	if DB == nil {
		return "UNPAID"
	}

	var status string
	err := DB.QueryRow(`SELECT COALESCE(NULLIF(payment_status, ''), 'UNPAID') FROM customers WHERE LOWER(username)=LOWER($1) AND wa_number=$2 LIMIT 1`, cleanUsr, cleanPhone).Scan(&status)
	if err != nil || status == "" {
		// Fallback check active_carts or customer_order_states
		_ = DB.QueryRow(`SELECT COALESCE(NULLIF(payment_status, ''), 'UNPAID') FROM active_carts WHERE LOWER(username)=LOWER($1) AND customer_phone=$2 LIMIT 1`, cleanUsr, cleanPhone).Scan(&status)
		if status == "" {
			return "UNPAID"
		}
	}

	customerCacheLock.Lock()
	if cached != nil {
		cached.PaymentStatus = status
	}
	customerCacheLock.Unlock()

	return status
}

// SetCustomerPaymentStatus updates customer's payment_status in customers, active_carts, and RAM cache
func SetCustomerPaymentStatus(username, customerPhone, status string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone")
	}
	if status == "" {
		status = "UNPAID"
	}

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.Lock()
	if cached, found := customerCache[cacheKey]; found && cached != nil {
		cached.PaymentStatus = status
	} else {
		customerCache[cacheKey] = &CustomerProfile{
			Username:      cleanUsr,
			WANumber:      cleanPhone,
			CurrentState:  "chatting",
			PaymentStatus: status,
			UpdatedAt:     time.Now(),
		}
	}
	customerCacheLock.Unlock()

	if DB == nil {
		return nil
	}

	// Update customers table
	_, err := DB.Exec(`INSERT INTO customers (username, wa_number, payment_status, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (username, wa_number) DO UPDATE SET
			payment_status = EXCLUDED.payment_status,
			updated_at = NOW()`, cleanUsr, cleanPhone, status)
	if err != nil {
		log.Printf("⚠️ SetCustomerPaymentStatus DB error for @%s (+%s -> %s): %v", cleanUsr, cleanPhone, status, err)
	}

	// Update active_carts table payment_status column
	_, _ = DB.Exec(`UPDATE active_carts SET payment_status = $1 WHERE LOWER(username)=LOWER($2) AND customer_phone=$3`, status, cleanUsr, cleanPhone)

	// Update customer_order_states
	_, _ = DB.Exec(`UPDATE customer_order_states SET payment_status = $1, updated_at = NOW() WHERE LOWER(username)=LOWER($2) AND customer_phone=$3`, strings.ToLower(status), cleanUsr, cleanPhone)

	log.Printf("🔒 [Payment Status Updated]: @%s (+%s) -> '%s'", cleanUsr, cleanPhone, status)
	return nil
}

// GetCustomerCurrentOrderID retrieves the saved Order ID for the current pending order (or empty string)
func GetCustomerCurrentOrderID(username, customerPhone string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return ""
	}
	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.RLock()
	cached, found := customerCache[cacheKey]
	customerCacheLock.RUnlock()
	if found && cached != nil && cached.CurrentOrderID != "" {
		return cached.CurrentOrderID
	}

	if DB == nil {
		return ""
	}

	var ordID string
	err := DB.QueryRow(`SELECT COALESCE(NULLIF(current_order_id, ''), '') FROM customers WHERE (LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($1)||'@gmail.com') AND wa_number=$2 LIMIT 1`, cleanUsr, cleanPhone).Scan(&ordID)
	if err != nil || ordID == "" {
		// Fallback query across all customers by phone
		_ = DB.QueryRow(`SELECT COALESCE(NULLIF(current_order_id, ''), '') FROM customers WHERE wa_number=$1 AND current_order_id != '' ORDER BY updated_at DESC LIMIT 1`, cleanPhone).Scan(&ordID)
	}
	if ordID == "" {
		_ = DB.QueryRow(`SELECT COALESCE(NULLIF(current_order_id, ''), '') FROM active_carts WHERE customer_phone=$1 AND current_order_id != '' LIMIT 1`, cleanPhone).Scan(&ordID)
	}
	if ordID == "" {
		_ = DB.QueryRow(`SELECT COALESCE(NULLIF(order_id, ''), '') FROM customer_order_states WHERE customer_phone=$1 AND payment_status != 'paid' ORDER BY updated_at DESC LIMIT 1`, cleanPhone).Scan(&ordID)
	}

	if ordID != "" {
		customerCacheLock.Lock()
		if cached != nil {
			cached.CurrentOrderID = ordID
		}
		customerCacheLock.Unlock()
	}

	return ordID
}

// SetCustomerCurrentOrderID updates customer's current_order_id in RAM cache, customers, active_carts, and customer_order_states
func SetCustomerCurrentOrderID(username, customerPhone, orderID string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone")
	}

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.Lock()
	if cached, found := customerCache[cacheKey]; found && cached != nil {
		cached.CurrentOrderID = orderID
	} else {
		customerCache[cacheKey] = &CustomerProfile{
			Username:       cleanUsr,
			WANumber:       cleanPhone,
			CurrentState:   "chatting",
			CurrentOrderID: orderID,
			UpdatedAt:      time.Now(),
		}
	}
	customerCacheLock.Unlock()

	if DB == nil {
		return nil
	}

	// Update customers table
	_, _ = DB.Exec(`INSERT INTO customers (username, wa_number, current_order_id, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (username, wa_number) DO UPDATE SET
			current_order_id = EXCLUDED.current_order_id,
			updated_at = NOW()`, cleanUsr, cleanPhone, orderID)

	// Update active_carts table
	_, _ = DB.Exec(`UPDATE active_carts SET current_order_id = $1 WHERE customer_phone = $2 OR customer_phone LIKE '%' || $2`, orderID, cleanPhone)

	// Update customer_order_states table
	if orderID != "" {
		_, _ = DB.Exec(`UPDATE customer_order_states SET order_id = $1, updated_at = NOW() WHERE customer_phone = $2 OR customer_phone LIKE '%' || $2`, orderID, cleanPhone)
	}

	log.Printf("📌 [Saved Customer Order ID]: @%s (+%s) -> '%s'", cleanUsr, cleanPhone, orderID)
	return nil
}

// ClearActiveCart removes active cart items for a customer and resets current_order_id
func ClearActiveCart(username, customerPhone string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return nil
	}

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.Lock()
	if cached, found := customerCache[cacheKey]; found && cached != nil {
		cached.CurrentOrderID = ""
	}
	customerCacheLock.Unlock()

	if DB != nil {
		// Strictly delete active_carts by customer_phone across all tenant sessions
		_, err := DB.Exec("DELETE FROM active_carts WHERE customer_phone=$1 OR customer_phone LIKE '%' || $1 OR (LOWER(username)=LOWER($2) AND customer_phone=$1)", cleanPhone, cleanUsr)
		if err != nil {
			log.Printf("⚠️ ClearActiveCart error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		}
		// Clear current_order_id in customers table
		_, _ = DB.Exec("UPDATE customers SET current_order_id = '', updated_at = NOW() WHERE wa_number=$1 OR wa_number LIKE '%' || $1", cleanPhone)
	}
	log.Printf("🛒 [Active Cart & Order ID Strictly Cleared]: Customer +%s (@%s)", cleanPhone, cleanUsr)
	return nil
}


// UpsertCustomerProfile stores or updates customer details in Neon DB and updates RAM cache
func UpsertCustomerProfile(username string, profile *CustomerProfile) error {
	if profile == nil {
		return nil
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(profile.WANumber)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone number")
	}

	profile.Username = cleanUsr
	profile.WANumber = cleanPhone
	profile.UpdatedAt = time.Now()

	cacheKey := cleanUsr + "_" + cleanPhone
	customerCacheLock.Lock()
	existing, exists := customerCache[cacheKey]
	if exists && existing != nil {
		if profile.FullName == "" {
			profile.FullName = existing.FullName
		}
		if profile.DeliveryAddress == "" {
			profile.DeliveryAddress = existing.DeliveryAddress
		}
		if profile.ContactPhone == "" {
			profile.ContactPhone = existing.ContactPhone
		}
		if profile.Latitude == 0 {
			profile.Latitude = existing.Latitude
		}
		if profile.Longitude == 0 {
			profile.Longitude = existing.Longitude
		}
		if profile.LastOrderDetails == "" {
			profile.LastOrderDetails = existing.LastOrderDetails
		}
	}
	customerCache[cacheKey] = profile
	customerCacheLock.Unlock()

	if DB == nil {
		return nil
	}

	upsertSQL := `
		INSERT INTO customers (username, wa_number, full_name, delivery_address, contact_phone, latitude, longitude, last_order_details, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
		ON CONFLICT (username, wa_number) DO UPDATE SET
			full_name = CASE WHEN EXCLUDED.full_name != '' THEN EXCLUDED.full_name ELSE customers.full_name END,
			delivery_address = CASE WHEN EXCLUDED.delivery_address != '' THEN EXCLUDED.delivery_address ELSE customers.delivery_address END,
			contact_phone = CASE WHEN EXCLUDED.contact_phone != '' THEN EXCLUDED.contact_phone ELSE customers.contact_phone END,
			latitude = CASE WHEN EXCLUDED.latitude != 0 THEN EXCLUDED.latitude ELSE customers.latitude END,
			longitude = CASE WHEN EXCLUDED.longitude != 0 THEN EXCLUDED.longitude ELSE customers.longitude END,
			last_order_details = CASE WHEN EXCLUDED.last_order_details != '' THEN EXCLUDED.last_order_details ELSE customers.last_order_details END,
			updated_at = NOW();
	`

	_, err := DB.Exec(upsertSQL,
		cleanUsr, cleanPhone,
		strings.TrimSpace(profile.FullName),
		strings.TrimSpace(profile.DeliveryAddress),
		strings.TrimSpace(profile.ContactPhone),
		profile.Latitude,
		profile.Longitude,
		strings.TrimSpace(profile.LastOrderDetails),
	)

	if err != nil {
		log.Printf("⚠️ UpsertCustomerProfile error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return err
	}

	return nil
}

// UpdateCustomerCoordinates saves GPS location coordinates and address into customer profile
func UpdateCustomerCoordinates(username, waNumber string, lat, lng float64, address string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(waNumber)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone number")
	}

	cp, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	if cp == nil {
		cp = &CustomerProfile{
			Username: cleanUsr,
			WANumber: cleanPhone,
		}
	}
	cp.Latitude = lat
	cp.Longitude = lng
	if address != "" && (cp.DeliveryAddress == "" || strings.HasPrefix(cp.DeliveryAddress, "Location / Area:") || !strings.Contains(cp.DeliveryAddress, address)) {
		cp.DeliveryAddress = address
	}

	return UpsertCustomerProfile(cleanUsr, cp)
}

// CalculateDistance computes great-circle distance between two GPS coordinates in kilometers
// Pure Go implementation using Haversine formula (Earth radius R = 6371.0 km) - Zero external network calls
func CalculateDistance(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0 // Earth radius in kilometers

	dLat := (lat2 - lat1) * (math.Pi / 180.0)
	dLon := (lon2 - lon1) * (math.Pi / 180.0)

	rLat1 := lat1 * (math.Pi / 180.0)
	rLat2 := lat2 * (math.Pi / 180.0)

	a := math.Sin(dLat/2.0)*math.Sin(dLat/2.0) +
		math.Cos(rLat1)*math.Cos(rLat2)*math.Sin(dLon/2.0)*math.Sin(dLon/2.0)

	c := 2.0 * math.Atan2(math.Sqrt(a), math.Sqrt(1.0-a))
	return R * c
}

// GetBusinessLocation fetches business coordinates and delivery logistics parameters from users table
// Defaults: 26.8467, 80.9462 (Lucknow/Central hub), 15.0 km max radius, 3.0 km free radius, ₹40 fee
func GetBusinessLocation(username string) (lat float64, lng float64, maxRadiusKM float64, freeRadiusKM float64, deliveryCharge float64, requireLocation bool) {
	// Robust defaults
	lat = 26.8467
	lng = 80.9462
	maxRadiusKM = 15.0
	freeRadiusKM = 3.0
	deliveryCharge = 40.0
	requireLocation = false

	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	var dbLat, dbLng, dbLat2, dbLng2, dbRadius, dbFreeRadius, dbCharge sql.NullFloat64
	var dbReqLoc sql.NullBool
	err := DB.QueryRow(`
		SELECT COALESCE(business_lat, 0), COALESCE(business_lng, 0), COALESCE(latitude, 0), COALESCE(longitude, 0), 
		       COALESCE(max_delivery_radius_km, 15.0), COALESCE(free_delivery_radius_km, 3.0), 
		       COALESCE(delivery_charge_amount, 40.0), COALESCE(require_customer_location, false)
		FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1
	`, cleanUsr).Scan(&dbLat, &dbLng, &dbLat2, &dbLng2, &dbRadius, &dbFreeRadius, &dbCharge, &dbReqLoc)

	if err == nil {
		if dbLat.Valid && dbLat.Float64 != 0 {
			lat = dbLat.Float64
		} else if dbLat2.Valid && dbLat2.Float64 != 0 {
			lat = dbLat2.Float64
		}
		if dbLng.Valid && dbLng.Float64 != 0 {
			lng = dbLng.Float64
		} else if dbLng2.Valid && dbLng2.Float64 != 0 {
			lng = dbLng2.Float64
		}
		if dbRadius.Valid && dbRadius.Float64 > 0 {
			maxRadiusKM = dbRadius.Float64
		}
		if dbFreeRadius.Valid && dbFreeRadius.Float64 >= 0 {
			freeRadiusKM = dbFreeRadius.Float64
		}
		if dbCharge.Valid && dbCharge.Float64 >= 0 {
			deliveryCharge = dbCharge.Float64
		}
		if dbReqLoc.Valid {
			requireLocation = dbReqLoc.Bool
		}
	}
	return
}

// ExtractAndPersistCustomerDetails inspects customer messages during conversation and extracts info
func ExtractAndPersistCustomerDetails(username, phone, text string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(phone)
	if cleanPhone == "" || strings.TrimSpace(text) == "" {
		return
	}

	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)

	// Ignore commands or generic affirmations
	if lower == "hi" || lower == "hello" || lower == "namaste" || lower == "yes" || lower == "ha" || lower == "haan" || lower == "ok" || lower == "done" {
		return
	}

	cp, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	if cp == nil {
		cp = &CustomerProfile{
			Username: cleanUsr,
			WANumber: cleanPhone,
		}
	}

	updated := false

	// Check for 10-digit Indian mobile number
	phoneRegex := regexp.MustCompile(`\b[6-9]\d{9}\b`)
	if match := phoneRegex.FindString(trimmed); match != "" && match != cleanPhone {
		if cp.ContactPhone != match {
			cp.ContactPhone = match
			updated = true
		}
	}

	// Address heuristics: phrases like "address:", "flat no", "sector", "house no", "pincode", "near"
	if strings.Contains(lower, "address") || strings.Contains(lower, "near ") || strings.Contains(lower, "road") ||
		strings.Contains(lower, "sector") || strings.Contains(lower, "gali") || strings.Contains(lower, "colony") ||
		strings.Contains(lower, "house") || strings.Contains(lower, "flat") || strings.Contains(lower, "nagar") {
		cleanAddr := trimmed
		if idx := strings.Index(lower, "address:"); idx != -1 {
			cleanAddr = strings.TrimSpace(trimmed[idx+8:])
		} else if idx := strings.Index(lower, "address is:"); idx != -1 {
			cleanAddr = strings.TrimSpace(trimmed[idx+11:])
		} else if idx := strings.Index(lower, "mera address hai"); idx != -1 {
			cleanAddr = strings.TrimSpace(trimmed[idx+16:])
		}
		if len(cleanAddr) >= 8 && cp.DeliveryAddress != cleanAddr {
			cp.DeliveryAddress = cleanAddr
			updated = true
		}
	}

	// Name heuristics: phrases like "name:", "naam:", "mera naam", "i am"
	if strings.Contains(lower, "name:") || strings.Contains(lower, "naam:") || strings.Contains(lower, "mera naam") {
		cleanName := ""
		if idx := strings.Index(lower, "name:"); idx != -1 {
			cleanName = strings.TrimSpace(trimmed[idx+5:])
		} else if idx := strings.Index(lower, "naam:"); idx != -1 {
			cleanName = strings.TrimSpace(trimmed[idx+5:])
		} else if idx := strings.Index(lower, "mera naam"); idx != -1 {
			cleanName = strings.TrimSpace(trimmed[idx+9:])
		}
		if len(cleanName) >= 2 && len(cleanName) <= 50 && cp.FullName != cleanName {
			cp.FullName = cleanName
			updated = true
		}
	}

	if updated {
		_ = UpsertCustomerProfile(cleanUsr, cp)
	}
}

type CartItemDetail struct {
	ProductID   string  `json:"product_id"`
	ProductName string  `json:"product_name"`
	UnitPrice   float64 `json:"unit_price"`
	Qty         int     `json:"qty"`
	Quantity    int     `json:"quantity,omitempty"`
	LineTotal   float64 `json:"line_total"`
}

type CartCalculationResult struct {
	Username      string           `json:"username"`
	CustomerPhone string           `json:"customer_phone"`
	TotalAmount   float64          `json:"total_amount"`
	PaytmMid      string           `json:"paytm_mid"`
	PaytmVpa      string           `json:"paytm_vpa"`
	PayeeName     string           `json:"payee_name"`
	OrderID       string           `json:"order_id"`
	Items         []CartItemDetail `json:"items"`
	ItemCount     int              `json:"item_count"`
}

// UpdateCustomerProfileFromData updates customer profile with saved_name, saved_address, and contact_phone
func UpdateCustomerProfileFromData(username, customerPhone string, profile *AIProfileData) error {
	if profile == nil {
		return nil
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone number")
	}

	name := strings.TrimSpace(profile.Name)
	addr := strings.TrimSpace(profile.Address)
	contactNum := strings.TrimSpace(profile.ContactNumber)
	if name == "" && addr == "" && contactNum == "" {
		return nil
	}

	cp, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	if cp == nil {
		cp = &CustomerProfile{
			Username: cleanUsr,
			WANumber: cleanPhone,
		}
	}
	if name != "" {
		cp.FullName = name
	}
	if addr != "" {
		cp.DeliveryAddress = addr
	}
	if contactNum != "" {
		cp.ContactPhone = contactNum
	}
	_ = UpsertCustomerProfile(cleanUsr, cp)

	if DB == nil {
		return nil
	}

	query := `INSERT INTO customers (username, wa_number, full_name, saved_name, delivery_address, saved_address, contact_phone, updated_at)
		VALUES ($1, $2, $3, $3, $4, $4, $5, NOW())
		ON CONFLICT (username, wa_number) DO UPDATE SET
			full_name = CASE WHEN EXCLUDED.full_name != '' THEN EXCLUDED.full_name ELSE customers.full_name END,
			saved_name = CASE WHEN EXCLUDED.saved_name != '' THEN EXCLUDED.saved_name ELSE customers.saved_name END,
			delivery_address = CASE WHEN EXCLUDED.delivery_address != '' THEN EXCLUDED.delivery_address ELSE customers.delivery_address END,
			saved_address = CASE WHEN EXCLUDED.saved_address != '' THEN EXCLUDED.saved_address ELSE customers.saved_address END,
			contact_phone = CASE WHEN EXCLUDED.contact_phone != '' THEN EXCLUDED.contact_phone ELSE customers.contact_phone END,
			updated_at = NOW()`
	_, err := DB.Exec(query, cleanUsr, cleanPhone, name, addr, contactNum)
	if err != nil {
		log.Printf("⚠️ UpdateCustomerProfileFromData error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return err
	}

	log.Printf("👤 [Customer Profile Updated]: @%s (+%s) | Name: %s | Address: %s | Contact: %s", cleanUsr, cleanPhone, name, addr, contactNum)
	return nil
}

// AddItemsToActiveCart inserts customer selected items into active_carts DB table
func AddItemsToActiveCart(username, customerPhone string, cartItems []AICartItem) error {
	if DB == nil || len(cartItems) == 0 {
		return nil
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone number")
	}

	// Purge stale or previous session items if order was confirmed, paid, cancelled, or older than 1 hour
	_, _ = DB.Exec(`DELETE FROM active_carts 
		WHERE (customer_phone = $1 OR customer_phone LIKE '%' || $1)
		  AND (updated_at < NOW() - INTERVAL '1 hour' OR payment_status IN ('PAID', 'CANCELLED', 'CONFIRMED'))`, cleanPhone)

	if cp, _ := GetCustomerProfile(cleanUsr, cleanPhone); cp != nil {
		if cp.CurrentState == "ORDER_CONFIRMED" || cp.PaymentStatus == "PAID" || cp.PaymentStatus == "CANCELLED" {
			_ = ClearActiveCart(cleanUsr, cleanPhone)
			_ = SetCustomerState(cleanUsr, cleanPhone, "chatting")
			_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "BROWSING")
		}
	}

	for _, item := range cartItems {
		pID := strings.TrimSpace(item.ProductID)
		if pID == "" {
			continue
		}
		qty := item.Qty
		if qty <= 0 {
			qty = 1
		}

		// STRICT OVERWRITE: Set qty = EXCLUDED.qty instead of accumulating (+ EXCLUDED.qty)
		// This strictly prevents repeating AI turns from compounding the quantity (e.g. 1 -> 2 -> 3 -> 4 -> 5)
		query := `INSERT INTO active_carts (username, customer_phone, product_id, qty, payment_status, updated_at)
			VALUES ($1, $2, $3, $4, 'UNPAID', NOW())
			ON CONFLICT (username, customer_phone, product_id) DO UPDATE SET
				qty = EXCLUDED.qty,
				payment_status = 'UNPAID',
				updated_at = NOW()`
		_, err := DB.Exec(query, cleanUsr, cleanPhone, pID, qty)
		if err != nil {
			log.Printf("⚠️ AddItemsToActiveCart error for @%s (+%s, Item: %s): %v", cleanUsr, cleanPhone, pID, err)
		} else {
			log.Printf("🛒 [Active Cart Updated]: @%s (+%s) | Product ID: %s | Qty: %d", cleanUsr, cleanPhone, pID, qty)
		}
	}
	return nil
}

// FetchRealBusinessPaymentCredentials strictly retrieves real merchant Paytm credentials from the database.
// Completely eliminates fake placeholder fallbacks. Returns an error if credentials are missing.
func FetchRealBusinessPaymentCredentials(cleanUsr, cleanPhone string) (mid string, vpa string, payeeName string, err error) {
	if DB == nil {
		return "", "", "", fmt.Errorf("database not initialized")
	}

	cleanUsr = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(cleanUsr), "@"))

	// 1. Check users table by exact username, email, and email prefix
	if cleanUsr != "" {
		errQuery := DB.QueryRow(`
			SELECT COALESCE(paytm_mid, ''), COALESCE(paytm_vpa, ''), COALESCE(business_name, account_name, username) 
			FROM users 
			WHERE (LOWER(username) = LOWER($1) 
			   OR LOWER(email) = LOWER($1) 
			   OR LOWER(username) = LOWER($1) || '@gmail.com' 
			   OR LOWER(email) LIKE LOWER($1) || '@%' 
			   OR split_part(LOWER(email), '@', 1) = LOWER($1)
			   OR LOWER(account_name) = LOWER($1))
			  AND TRIM(COALESCE(paytm_mid, '')) != '' 
			  AND TRIM(COALESCE(paytm_vpa, '')) != ''
			LIMIT 1
		`, cleanUsr).Scan(&mid, &vpa, &payeeName)
		if errQuery == nil && mid != "" && vpa != "" {
			return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
		}

		// 2. Check tenant_payment_configs
		errPay := DB.QueryRow(`
			SELECT COALESCE(paytm_mid, ''), COALESCE(merchant_vpa, ''), COALESCE(payee_name, username) 
			FROM tenant_payment_configs 
			WHERE (LOWER(username) = LOWER($1) 
			   OR LOWER(username) = LOWER($1) || '@gmail.com' 
			   OR split_part(LOWER(username), '@', 1) = LOWER($1))
			  AND TRIM(COALESCE(paytm_mid, '')) != '' 
			  AND TRIM(COALESCE(merchant_vpa, '')) != ''
			LIMIT 1
		`, cleanUsr).Scan(&mid, &vpa, &payeeName)
		if errPay == nil && mid != "" && vpa != "" {
			return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
		}
	}

	// 3. Match against connected WhatsApp device phone from active client
	client := GetOrCreateClient(cleanUsr)
	if client != nil && client.Store != nil && client.Store.ID != nil && client.Store.ID.User != "" {
		devUser := client.Store.ID.User
		devPhone := FormatPhone(devUser)
		if devPhone != "" {
			errQuery := DB.QueryRow(`
				SELECT COALESCE(paytm_mid, ''), COALESCE(paytm_vpa, ''), COALESCE(business_name, account_name, username) 
				FROM users 
				WHERE (phone LIKE '%' || $1 OR wa_jid LIKE '%' || $1 || '%')
				  AND TRIM(COALESCE(paytm_mid, '')) != '' 
				  AND TRIM(COALESCE(paytm_vpa, '')) != ''
				LIMIT 1
			`, devPhone).Scan(&mid, &vpa, &payeeName)
			if errQuery == nil && mid != "" && vpa != "" {
				return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
			}

			errQuery2 := DB.QueryRow(`
				SELECT COALESCE(u.paytm_mid, ''), COALESCE(u.paytm_vpa, ''), COALESCE(u.business_name, u.account_name, u.username)
				FROM tenant_whatsapp_sessions s
				JOIN users u ON LOWER(u.username) = LOWER(s.username) OR LOWER(u.email) = LOWER(s.username)
				WHERE (s.phone LIKE '%' || $1 OR s.device_jid LIKE '%' || $1 || '%')
				  AND TRIM(COALESCE(u.paytm_mid, '')) != '' 
				  AND TRIM(COALESCE(u.paytm_vpa, '')) != ''
				LIMIT 1
			`, devPhone).Scan(&mid, &vpa, &payeeName)
			if errQuery2 == nil && mid != "" && vpa != "" {
				return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
			}
		}
	}

	// 0. Check instant RAM User Config Cache
	if ramCfg := GetUserConfigRAM(cleanUsr); ramCfg != nil {
		if strings.TrimSpace(ramCfg.PaytmMid) != "" && strings.TrimSpace(ramCfg.MerchantVpa) != "" {
			pName := strings.TrimSpace(ramCfg.BusinessName)
			if pName == "" {
				pName = cleanUsr
			}
			return strings.TrimSpace(ramCfg.PaytmMid), strings.TrimSpace(ramCfg.MerchantVpa), pName, nil
		}
	}

	// 4. Query the registered business account that holds active payment credentials in users table
	errAny := DB.QueryRow(`
		SELECT COALESCE(paytm_mid, ''), COALESCE(paytm_vpa, ''), COALESCE(business_name, account_name, username) 
		FROM users 
		WHERE TRIM(COALESCE(paytm_mid, '')) != '' AND TRIM(COALESCE(paytm_vpa, '')) != ''
		ORDER BY (CASE WHEN LOWER(role) != 'admin' THEN 0 ELSE 1 END), id DESC
		LIMIT 1
	`).Scan(&mid, &vpa, &payeeName)
	if errAny == nil && mid != "" && vpa != "" {
		return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
	}

	// 5. Query tenant_payment_configs for any configured credentials (sorted by updated_at)
	errAnyT := DB.QueryRow(`
		SELECT COALESCE(paytm_mid, ''), COALESCE(merchant_vpa, ''), COALESCE(payee_name, username) 
		FROM tenant_payment_configs 
		WHERE TRIM(COALESCE(paytm_mid, '')) != '' AND TRIM(COALESCE(merchant_vpa, '')) != ''
		ORDER BY updated_at DESC
		LIMIT 1
	`).Scan(&mid, &vpa, &payeeName)
	if errAnyT == nil && mid != "" && vpa != "" {
		return strings.TrimSpace(mid), strings.TrimSpace(vpa), strings.TrimSpace(payeeName), nil
	}

	// 6. Check payment package in-memory config
	pCfg := payment.GetPaymentConfig(cleanUsr)
	if strings.TrimSpace(pCfg.PaytmMID) != "" && strings.TrimSpace(pCfg.MerchantVPA) != "" {
		pName := strings.TrimSpace(pCfg.PayeeName)
		if pName == "" {
			pName = cleanUsr
		}
		return strings.TrimSpace(pCfg.PaytmMID), strings.TrimSpace(pCfg.MerchantVPA), pName, nil
	}

	// STRICTLY ZERO PLACEHOLDERS: Return error if credentials missing
	return "", "", "", fmt.Errorf("no real merchant Paytm credentials (MID/VPA) found in database for account '%s'", cleanUsr)
}

// CalculateCartTotalAndFetchCredentials executes the Math Engine: queries active_carts, joins products to calculate REAL total, fetches paytm credentials, and logs to console
func CalculateCartTotalAndFetchCredentials(username, customerPhone string) (*CartCalculationResult, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)

	res := &CartCalculationResult{
		Username:      cleanUsr,
		CustomerPhone: cleanPhone,
		Items:         []CartItemDetail{},
	}

	if DB == nil {
		return res, fmt.Errorf("database connection not available")
	}

	// Query active_carts strictly for this customer number in the CURRENT interaction loop (last 1 hour)
	query := `SELECT DISTINCT ON (c.product_id) 
		c.product_id, c.qty, COALESCE(p.name, 'Product #' || c.product_id), 
		COALESCE(p.sale_price, 0), COALESCE(p.price, '0'), COALESCE(p.mrp, 0)
		FROM active_carts c 
		LEFT JOIN products p ON (
			CAST(c.product_id AS TEXT) = CAST(p.id AS TEXT) 
			OR LOWER(TRIM(p.name)) = LOWER(TRIM(c.product_id))
		)
		WHERE (c.customer_phone = $1 OR c.customer_phone LIKE '%' || $1)
		  AND (c.payment_status IS NULL OR c.payment_status = 'UNPAID' OR c.payment_status = 'PENDING' OR c.payment_status = 'BROWSING')
		  AND c.updated_at >= NOW() - INTERVAL '1 hour'
		ORDER BY c.product_id, c.updated_at DESC`

	rows, err := DB.Query(query, cleanPhone)
	if err != nil {
		log.Printf("⚠️ Math Engine Query Error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return res, err
	}
	defer rows.Close()

	var calculatedTotal float64 = 0
	var itemCount int = 0
	numRegex := regexp.MustCompile(`[0-9]+(?:\.[0-9]+)?`)

	for rows.Next() {
		var pID, pName, priceStr string
		var salePrice, mrp float64
		var qty int
		if err := rows.Scan(&pID, &qty, &pName, &salePrice, &priceStr, &mrp); err == nil {
			unitPrice := 0.0
			if salePrice > 0 {
				unitPrice = salePrice
			} else if mrp > 0 {
				unitPrice = mrp
			} else if match := numRegex.FindString(priceStr); match != "" {
				fmt.Sscanf(match, "%f", &unitPrice)
			}
			lineTotal := unitPrice * float64(qty)
			calculatedTotal += lineTotal
			itemCount += qty

			res.Items = append(res.Items, CartItemDetail{
				ProductID:   pID,
				ProductName: pName,
				UnitPrice:   unitPrice,
				Qty:         qty,
				Quantity:    qty,
				LineTotal:   lineTotal,
			})
		}
	}

	res.TotalAmount = calculatedTotal
	res.ItemCount = itemCount

	// Fetch STRICTLY REAL Paytm Credentials from DB (Zero placeholder fallback!)
	pMid, pVpa, bName, credErr := FetchRealBusinessPaymentCredentials(cleanUsr, cleanPhone)
	if credErr != nil {
		log.Printf("⚠️ [Math Engine Credential Notice]: %v", credErr)
	}

	res.PaytmMid = strings.TrimSpace(pMid)
	res.PaytmVpa = strings.TrimSpace(pVpa)
	res.PayeeName = strings.TrimSpace(bName)

	// Reuse existing saved current_order_id if present, otherwise generate a new one EXACTLY ONCE
	ordID := GetCustomerCurrentOrderID(cleanUsr, cleanPhone)
	if ordID == "" {
		ordID = fmt.Sprintf("ORD%d", time.Now().UnixNano())
		_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, ordID)
	}
	res.OrderID = ordID

	log.Printf("🧮 [MATH ENGINE CALCULATION SUCCESS]:")
	log.Printf("   • Account: @%s | Customer: +%s | Order: %s", cleanUsr, cleanPhone, res.OrderID)
	log.Printf("   • Real Total Amount: ₹%.2f (%d items strictly in current active loop)", res.TotalAmount, res.ItemCount)
	log.Printf("   • Items Breakdown: %+v", res.Items)
	log.Printf("   • Real Credentials from DB: MID = '%s' | VPA = '%s' | Payee Name = '%s'", res.PaytmMid, res.PaytmVpa, res.PayeeName)

	// Save calculated state to customer_order_states
	if (len(res.Items) > 0 || res.TotalAmount > 0) && DB != nil {
		itemsJSON, _ := json.Marshal(res.Items)
		_, _ = DB.Exec(`INSERT INTO customer_order_states 
			(username, customer_phone, items, total_amount, payment_mode, payment_status, order_status, order_id, updated_at)
			VALUES ($1, $2, $3::jsonb, $4, 'online', 'unpaid', 'in_progress', $5, NOW())
			ON CONFLICT (username, customer_phone) DO UPDATE SET
				items = EXCLUDED.items,
				total_amount = EXCLUDED.total_amount,
				payment_mode = 'online',
				order_id = EXCLUDED.order_id,
				updated_at = NOW()`,
			cleanUsr, cleanPhone, string(itemsJSON), res.TotalAmount, ordID)
	}

	return res, nil
}

// ResolveOrderAmountAndID resolves the exact order total amount and order ID for dynamic payment QR generation
func ResolveOrderAmountAndID(username, senderPhone, replyText, incomingText string) (string, string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	savedOrdID := GetCustomerCurrentOrderID(cleanUsr, cleanPhone)

	// 1. Math Engine calculation strictly from active_carts
	calcRes, err := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
	if err == nil && calcRes != nil && calcRes.TotalAmount > 0 {
		amountStr := fmt.Sprintf("%.2f", calcRes.TotalAmount)
		orderIDStr := calcRes.OrderID
		if orderIDStr == "" {
			orderIDStr = savedOrdID
		}
		if orderIDStr == "" {
			orderIDStr = fmt.Sprintf("ORD%d", time.Now().UnixNano())
			_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, orderIDStr)
		}
		log.Printf("🧮 [ResolveOrderAmountAndID Math Engine Success]: Real Total ₹%s for Order %s (@%s, +%s)", amountStr, orderIDStr, cleanUsr, cleanPhone)
		return amountStr, orderIDStr
	}

	// 2. Check customer_order_states second if cart was cleared or pre-calculated
	if DB != nil {
		var dbOrd string
		var dbAmt float64
		_ = DB.QueryRow("SELECT COALESCE(order_id, ''), COALESCE(total_amount, 0) FROM customer_order_states WHERE (LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($1)||'@gmail.com') AND customer_phone=$2 AND payment_status != 'paid' ORDER BY updated_at DESC LIMIT 1", cleanUsr, cleanPhone).Scan(&dbOrd, &dbAmt)
		if dbAmt > 0 {
			if dbOrd == "" {
				dbOrd = savedOrdID
			}
			if dbOrd == "" {
				dbOrd = fmt.Sprintf("ORD%d", time.Now().UnixNano())
				_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, dbOrd)
			}
			return fmt.Sprintf("%.2f", dbAmt), dbOrd
		}
	}

	if savedOrdID == "" {
		savedOrdID = fmt.Sprintf("ORD%d", time.Now().UnixNano())
		_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, savedOrdID)
	}
	return "0.00", savedOrdID
}

// DispatchCloudflareWorkerQR triggers Cloudflare Worker /generate, delivers QR image via whatsmeow, and calls /start-check
func DispatchCloudflareWorkerQR(username, customerPhone string, calcRes *CartCalculationResult) (string, error) {
	if calcRes == nil {
		return "", fmt.Errorf("calcRes is nil")
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)

	if calcRes.TotalAmount <= 0 {
		log.Printf("⚠️ [DispatchCloudflareWorkerQR] Total amount is ₹0 for @%s (+%s). Cannot generate payment QR for empty cart.", cleanUsr, cleanPhone)
		return "", fmt.Errorf("cart total is ₹0")
	}

	vpa := strings.TrimSpace(calcRes.PaytmVpa)
	pMid := strings.TrimSpace(calcRes.PaytmMid)
	if vpa == "" || pMid == "" {
		log.Printf("❌ [DispatchCloudflareWorkerQR] Aborted: Real Paytm MID or VPA missing in DB for @%s. Placeholders strictly prohibited.", cleanUsr)
		return "", fmt.Errorf("real merchant Paytm MID and VPA must be configured in database")
	}

	ordID := calcRes.OrderID
	if ordID == "" {
		ordID = GetCustomerCurrentOrderID(cleanUsr, cleanPhone)
	}
	if ordID == "" {
		ordID = fmt.Sprintf("ORD%d", time.Now().UnixNano())
		calcRes.OrderID = ordID
	}

	// STRICT STATE LOCK: Lock customer state to PAYMENT_PENDING, payment_status to PENDING, and current_order_id in DB & Cache immediately!
	_ = SetCustomerState(cleanUsr, cleanPhone, "PAYMENT_PENDING")
	_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "PENDING")
	_ = SetCustomerCurrentOrderID(cleanUsr, cleanPhone, ordID)

	amtStr := fmt.Sprintf("%.2f", calcRes.TotalAmount)
	payee := strings.TrimSpace(calcRes.PayeeName)
	if payee == "" {
		payee = "WaMart Store"
	}

	cloudName := "hq67khm3" // Fixed correct Cloudinary Cloud Name as requested

	// 1. POST request to Cloudflare Worker /generate URL with EXACT calculated amount
	qrURL, imgBytes, err := payment.GenerateWorkerDynamicQR(vpa, payee, ordID, amtStr, cloudName)
	if err != nil {
		log.Printf("⚠️ [Cloudflare Worker QR Error]: %v", err)
		return "", err
	}

	log.Printf("⚡ [Cloudflare Worker Dynamic QR Generated] Order: %s | Real Amount: ₹%s | URL: %s | Bytes: %d", ordID, amtStr, qrURL, len(imgBytes))

	// 2. Send ImageMessage via whatsmeow using static thumbnail
	client := GetOrCreateClient(cleanUsr)

	if client != nil && client.IsLoggedIn() {
		_ = EnsureConnected(client)
		caption := fmt.Sprintf("📱 *Scan & Pay via UPI / Paytm*\n\n• Order ID: *%s*\n• Total Amount: *₹%s*\n• Payee: *%s*\n\n_Payment hone par aapka order automatic confirm ho jayega!_ 🙏\n_(Order cancel karne ke liye 'Cancel' type karein)_", ordID, amtStr, payee)
		errSend := SendImageFromURL(client, cleanPhone, qrURL, caption)
		if errSend != nil {
			log.Printf("⚠️ Error delivering Worker QR image to +%s: %v", cleanPhone, errSend)
		} else {
			log.Printf("⚡ [Cloudflare Worker QR Image Delivered] to +%s", cleanPhone)
			PushToLiveChat(cleanUsr, cleanPhone, caption, "outgoing_ai")
		}
	}

	// 3. Immediately trigger Worker's /start-check endpoint for background polling
	webhookURL := payment.GetAppWebhookURL()
	fmt.Println("🚀 [Cloudflare Worker Poll] Dispatching start-check with live Webhook URL:", webhookURL, "for Order:", ordID)
	go func() {
		errCheck := payment.StartWorkerPaymentCheck(pMid, ordID, webhookURL)
		if errCheck != nil {
			log.Printf("⚠️ [Worker Start-Check Error] for %s: %v", ordID, errCheck)
		}
	}()

	return qrURL, nil
}

