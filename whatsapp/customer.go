package whatsapp

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
)

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
		Username: cleanUsr,
		WANumber: cleanPhone,
	}

	query := `SELECT id, username, wa_number, COALESCE(full_name, ''), COALESCE(delivery_address, ''), 
		COALESCE(contact_phone, ''), COALESCE(latitude, 0), COALESCE(longitude, 0), 
		COALESCE(last_order_details, ''), created_at, updated_at 
		FROM customers 
		WHERE LOWER(username)=LOWER($1) AND wa_number=$2 LIMIT 1`

	err := DB.QueryRow(query, cleanUsr, cleanPhone).Scan(
		&cp.ID, &cp.Username, &cp.WANumber, &cp.FullName, &cp.DeliveryAddress,
		&cp.ContactPhone, &cp.Latitude, &cp.Longitude,
		&cp.LastOrderDetails, &cp.CreatedAt, &cp.UpdatedAt,
	)

	if err != nil {
		// Fallback check across all accounts by phone if not found under specific tenant
		fallbackQuery := `SELECT id, username, wa_number, COALESCE(full_name, ''), COALESCE(delivery_address, ''), 
			COALESCE(contact_phone, ''), COALESCE(latitude, 0), COALESCE(longitude, 0), 
			COALESCE(last_order_details, ''), created_at, updated_at 
			FROM customers 
			WHERE wa_number=$1 ORDER BY updated_at DESC LIMIT 1`
		errFallback := DB.QueryRow(fallbackQuery, cleanPhone).Scan(
			&cp.ID, &cp.Username, &cp.WANumber, &cp.FullName, &cp.DeliveryAddress,
			&cp.ContactPhone, &cp.Latitude, &cp.Longitude,
			&cp.LastOrderDetails, &cp.CreatedAt, &cp.UpdatedAt,
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

// GetBusinessLocation fetches business coordinates and max delivery radius from users table
// Defaults: 26.8467, 80.9462 (Lucknow/Central hub) and 15.0 km radius
func GetBusinessLocation(username string) (lat float64, lng float64, maxRadiusKM float64) {
	// Robust defaults
	lat = 26.8467
	lng = 80.9462
	maxRadiusKM = 15.0

	if DB == nil {
		return
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	var dbLat, dbLng, dbRadius sql.NullFloat64
	err := DB.QueryRow(`
		SELECT business_lat, business_lng, max_delivery_radius_km 
		FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1
	`, cleanUsr).Scan(&dbLat, &dbLng, &dbRadius)

	if err == nil {
		if dbLat.Valid && dbLat.Float64 != 0 {
			lat = dbLat.Float64
		}
		if dbLng.Valid && dbLng.Float64 != 0 {
			lng = dbLng.Float64
		}
		if dbRadius.Valid && dbRadius.Float64 > 0 {
			maxRadiusKM = dbRadius.Float64
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

// ResolveOrderAmountAndID resolves the order total amount and order ID for dynamic payment QR generation
func ResolveOrderAmountAndID(username, senderPhone, replyText, incomingText string) (string, string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(senderPhone)

	amountStr := "0"
	orderIDStr := fmt.Sprintf("ORD_%s_%d", cleanPhone[max(0, len(cleanPhone)-4):], time.Now().Unix()%10000)

	// 1. Check customer_order_states first
	if DB != nil {
		var dbOrd string
		var dbAmt float64
		_ = DB.QueryRow("SELECT COALESCE(order_id, ''), COALESCE(total_amount, 0) FROM customer_order_states WHERE username=$1 AND customer_phone=$2 LIMIT 1", cleanUsr, cleanPhone).Scan(&dbOrd, &dbAmt)
		if dbOrd != "" {
			orderIDStr = dbOrd
		}
		if dbAmt > 0 {
			amountStr = fmt.Sprintf("%.2f", dbAmt)
		}
	}

	// 2. Check for Rs. or ₹ or amount in replyText or customer text
	if amountStr == "0" || amountStr == "0.00" || amountStr == "" {
		priceRegex := regexp.MustCompile(`(?i)(?:rs\.?|inr|₹)\s*([0-9]+(?:\.[0-9]+)?)`)
		if pMatches := priceRegex.FindAllStringSubmatch(replyText, -1); len(pMatches) > 0 {
			amountStr = pMatches[len(pMatches)-1][1]
		} else if pMatches := priceRegex.FindAllStringSubmatch(incomingText, -1); len(pMatches) > 0 {
			amountStr = pMatches[len(pMatches)-1][1]
		}
	}

	if amountStr == "0" || amountStr == "0.00" || amountStr == "" {
		amountStr = "10.00"
	}

	return amountStr, orderIDStr
}

