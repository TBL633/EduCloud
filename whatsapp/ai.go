package whatsapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"wa-server/payment"
)

// ChatMessage structure for Sliding Window
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type CachedChatSession struct {
	LastActivity time.Time
	Messages     []ChatMessage
}

type UserConfigRAM struct {
	Provider         string
	APIKey           string
	BusinessName     string
	BusinessType     string
	Language         string
	SystemPrompt     string
	Model            string
	Temperature      float64
	AutoReply        bool
	ImportCatalog    bool
	CatalogText      string
	HasOnlinePayment bool
	PaytmMid         string
	MerchantVpa      string
	PayeeName        string
	LastCached       time.Time
}

// Master E-Commerce Sales Agent System Prompt Template (Strict 5-Step Funnel)
const universalSystemPrompt = `You are an expert Sales Agent for "%s" (a %s). 
Your output language MUST BE strictly: %s.

CRITICAL DIRECTIVES:
1. CATALOG ONLY: Never invent products or prices. Only sell items listed in the provided Product Catalog.
2. HUMAN & POLITE: Use appropriate emojis, formatting (*bold*, _italic_), and speak like a polite, helpful human shopkeeper.
3. CONCISE REPLIES: Keep responses very short and easy to read on mobile. 

THE E-COMMERCE FUNNEL (YOU MUST FOLLOW THESE STEPS IN ORDER):

STEP 1: PRODUCT SELECTION
Ask the customer what they want. Help them choose variants/quantities based on the catalog.
If they want to change or modify their order (e.g., "I want 2kg instead of 1kg"), acknowledge the change and update their cart immediately.

STEP 2: ORDER SUMMARY & CONFIRMATION
Once the customer stops adding items, generate a clear bill:
"Order Summary:
*1x Item A* - Rs. X
*2x Item B* - Rs. Y
*Total: Rs. Z*
Shall I proceed to confirm this order?"

STEP 3: CUSTOMER DETAILS (COLLECT ONE BY ONE)
If they confirm the summary, politely ask for their details to complete the order. Ask for these ONE AT A TIME (do not ask for all at once):
A. Ask for their Full Name.
B. Once name is received, ask for their Complete Delivery Address.
C. Once address is received, ask for a Contact Phone Number for delivery.

STEP 4: PAYMENT METHOD SELECTION
After collecting all details, say: "Thank you. How would you like to pay?
1. Online Payment (UPI / QR Code)
2. Cash on Delivery (COD)"

STEP 5: FINAL CHECKOUT TRIGGER
- If the customer chooses "Online" or "UPI", you MUST output the exact keyword: [INITIATE_PAYMENT_QR] and say "Here is your secure payment QR code. We will process your order as soon as payment is received."
- If the customer chooses "COD" or "Cash", say: "Your Cash on Delivery order is confirmed! It will be delivered soon to [Address]."

Do not skip any steps in the funnel.`

// BuildUniversalSystemPrompt builds the final token-optimized prompt dynamically
func BuildUniversalSystemPrompt(businessName, businessType, language, catalogContext string) string {
	bName := strings.TrimSpace(businessName)
	if bName == "" {
		bName = "Rahul Store"
	}
	bType := strings.TrimSpace(businessType)
	if bType == "" {
		bType = "Kirana / General Store"
	}
	lang := strings.TrimSpace(language)
	if lang == "" {
		lang = "Hinglish"
	}

	finalPrompt := fmt.Sprintf(universalSystemPrompt, bName, bType, lang)
	// Append Catalog Data after this...
	if strings.TrimSpace(catalogContext) != "" {
		finalPrompt += "\n\n" + strings.TrimSpace(catalogContext)
	}
	return finalPrompt
}

var (
	// Key: "username_customerPhone" -> Value: RAM cached session (Max 10 messages, 5-min inactivity TTL)
	chatMemoryRAM = make(map[string]*CachedChatSession)
	ramCacheLock  sync.Mutex

	// User Config RAM Cache (1-minute TTL or instant API invalidation)
	userConfigCache = make(map[string]*UserConfigRAM)
	userConfigLock  sync.Mutex

	// Round-Robin API Key rotation index per username
	keyRotationIndex = make(map[string]int)
	keyRotationLock  sync.Mutex
)

// InvalidateUserConfigCache purges RAM cache when user updates AI settings or product catalog via API
func InvalidateUserConfigCache(username string) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	userConfigLock.Lock()
	delete(userConfigCache, cleanUsr)
	userConfigLock.Unlock()
}

// GetUserConfigRAM returns instant 0ms RAM cached user AI settings
func GetUserConfigRAM(username string) *UserConfigRAM {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	userConfigLock.Lock()
	cached, exists := userConfigCache[cleanUsr]
	if exists && cached != nil && time.Since(cached.LastCached) < 5*time.Minute {
		userConfigLock.Unlock()
		return cached
	}
	userConfigLock.Unlock()

	cfg := &UserConfigRAM{
		Provider:      "groq",
		APIKey:        "",
		BusinessName:  cleanUsr,
		BusinessType:  "Kirana / General Store",
		Language:      "Hinglish",
		SystemPrompt:  "",
		Model:         "openai/gpt-oss-20b",
		Temperature:   0.7,
		AutoReply:     true,
		ImportCatalog: true,
		CatalogText:   "",
		LastCached:    time.Now(),
	}

	if DB != nil {
		var p, k, s, m, bName, bType, lang string
		var t float64
		var ar, ic bool
		err := DB.QueryRow(`SELECT 
			COALESCE(ai_provider, 'groq'), 
			COALESCE(api_key, ''), 
			COALESCE(system_prompt, ''), 
			COALESCE(ai_model, 'openai/gpt-oss-20b'), 
			COALESCE(ai_temperature, 0.7), 
			COALESCE(auto_reply, true), 
			COALESCE(import_catalog_details, true),
			COALESCE(business_name, account_name, ''),
			COALESCE(business_type, 'Kirana / General Store'),
			COALESCE(response_language, 'Hinglish')
			FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)`, cleanUsr, cleanUsr+"@gmail.com").Scan(&p, &k, &s, &m, &t, &ar, &ic, &bName, &bType, &lang)
		if err == nil {
			cfg.Provider = p
			cfg.APIKey = k
			cfg.SystemPrompt = s
			cfg.Model = m
			if p == "groq" && (m == "llama-3.1-8b-instant" || m == "llama-3.3-70b-versatile" || m == "") {
				cfg.Model = "openai/gpt-oss-20b"
			}
			cfg.Temperature = t
			cfg.AutoReply = ar
			cfg.ImportCatalog = true
			if bName != "" {
				cfg.BusinessName = bName
			}
			if bType != "" {
				cfg.BusinessType = bType
			}
			if lang != "" {
				cfg.Language = lang
			}
		}

		// Check if tenant has payment configured
		var payEnabled bool
		var pMid, mVpa, pName string
		errPay := DB.QueryRow(`SELECT enabled, COALESCE(paytm_mid, ''), COALESCE(merchant_vpa, ''), COALESCE(payee_name, '') 
			FROM tenant_payment_configs WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)`, cleanUsr, cleanUsr+"@gmail.com").Scan(&payEnabled, &pMid, &mVpa, &pName)
		if errPay == nil && payEnabled && (pMid != "" || mVpa != "") {
			cfg.HasOnlinePayment = true
			cfg.PaytmMid = pMid
			cfg.MerchantVpa = mVpa
			cfg.PayeeName = pName
		}
	}

	// Always load products from DB into CatalogText!
	cfg.CatalogText = GetCatalogContext(cleanUsr)
	if cfg.CatalogText != "" {
		cfg.ImportCatalog = true
	}

	userConfigLock.Lock()
	userConfigCache[cleanUsr] = cfg
	userConfigLock.Unlock()

	return cfg
}

func init() {
	// 1. Background RAM Eviction Worker (Clears sessions with no activity for > 5 minutes to keep server RAM minimal)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		for range ticker.C {
			ramCacheLock.Lock()
			now := time.Now()
			for sessionKey, session := range chatMemoryRAM {
				if session != nil && now.Sub(session.LastActivity) > 5*time.Minute {
					delete(chatMemoryRAM, sessionKey)
					log.Printf("🧹 [RAM Eviction]: Session %s inactive for 5 min -> Evicted from RAM cache. Preserved in Neon DB.", sessionKey)
				}
			}
			ramCacheLock.Unlock()
		}
	}()

	// 2. Background DB Purge Worker (Deletes customer chats older than 5 days from Neon Postgres)
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		for range ticker.C {
			if DB != nil {
				res, err := DB.Exec("DELETE FROM customer_chats WHERE created_at < NOW() - INTERVAL '5 days'")
				if err == nil {
					if rows, _ := res.RowsAffected(); rows > 0 {
						log.Printf("🗑️ [DB Cleanup]: Purged %d customer chat messages older than 5 days.", rows)
					}
				}
			}
		}
	}()
}

// Helper to select API key in Round-Robin fashion if multiple keys exist
func getRotatedAPIKey(username, rawKeys string) string {
	rawKeys = strings.TrimSpace(rawKeys)
	if rawKeys == "" {
		return ""
	}
	re := regexp.MustCompile(`[\n,\s]+`)
	tokens := re.Split(rawKeys, -1)
	var validKeys []string
	for _, t := range tokens {
		t = strings.TrimSpace(t)
		if t != "" {
			validKeys = append(validKeys, t)
		}
	}
	if len(validKeys) == 0 {
		return ""
	}
	if len(validKeys) == 1 {
		return validKeys[0]
	}

	keyRotationLock.Lock()
	defer keyRotationLock.Unlock()

	idx := keyRotationIndex[username]
	selectedKey := validKeys[idx%len(validKeys)]
	keyRotationIndex[username] = (idx + 1) % len(validKeys)

	fmt.Printf("🔄 [Go Engine] User @%s rotated to API key #%d of %d\n", username, (idx%len(validKeys))+1, len(validKeys))
	return selectedKey
}

// compactText trims whitespace and caps max character length to minimize token consumption
func compactText(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > maxRunes {
		return string(r[:maxRunes]) + "..."
	}
	return s
}

// 1. Sliding Window RAM Cache Manager (Max 10 messages per customer, 5-min inactivity eviction, auto re-hydration from DB)
func updateSlidingWindowRAM(username, customerPhone, role, text string) []ChatMessage {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	sessionKey := cleanUsr + "_" + cleanPhone

	ramCacheLock.Lock()
	defer ramCacheLock.Unlock()

	session, exists := chatMemoryRAM[sessionKey]
	rehydrated := false

	// If session not in RAM (e.g. initial message OR evicted after 5 min inactivity),
	// re-hydrate last 10 messages directly from Neon PostgreSQL DB into RAM!
	if !exists || session == nil || len(session.Messages) == 0 {
		var dbMessages []ChatMessage
		if DB != nil {
			rows, err := DB.Query(`SELECT role, message_text, COALESCE(sender_type, ''), COALESCE(incoming_msg, ''), COALESCE(outgoing_msg, '') 
				FROM (
					SELECT id, role, message_text, sender_type, incoming_msg, outgoing_msg 
					FROM customer_chats 
					WHERE LOWER(username)=LOWER($1) AND customer_phone=$2 
					ORDER BY id DESC LIMIT 10
				) sub ORDER BY id ASC`, cleanUsr, cleanPhone)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var r, m, st, inc, out string
					if err := rows.Scan(&r, &m, &st, &inc, &out); err == nil {
						msgContent := m
						msgRole := "user"

						if st == "incoming" || r == "customer" || r == "user" {
							msgRole = "user"
							if inc != "" {
								msgContent = inc
							}
						} else if st == "outgoing" || r == "assistant" || r == "outgoing" || r == "outgoing_ai" {
							msgRole = "assistant"
							if out != "" {
								msgContent = out
							}
						}

						cleanMsg := compactText(msgContent, 400)
						if cleanMsg != "" {
							dbMessages = append(dbMessages, ChatMessage{Role: msgRole, Content: cleanMsg})
						}
					}
				}
			}
		}
		session = &CachedChatSession{
			LastActivity: time.Now(),
			Messages:     dbMessages,
		}
		chatMemoryRAM[sessionKey] = session
		rehydrated = true
		log.Printf("📥 [RAM Re-Hydration]: Loaded %d prior messages from DB into RAM for %s", len(dbMessages), sessionKey)
	}

	// Append current message if non-empty and not already present from re-hydration
	if text != "" {
		normalRole := role
		if normalRole == "customer" || normalRole == "incoming" {
			normalRole = "user"
		} else if normalRole == "outgoing" || normalRole == "outgoing_ai" {
			normalRole = "assistant"
		}

		cleanText := compactText(text, 400)
		alreadyPresent := false
		if rehydrated && len(session.Messages) > 0 {
			lastMsg := session.Messages[len(session.Messages)-1]
			if lastMsg.Role == normalRole && lastMsg.Content == cleanText {
				alreadyPresent = true
			}
		}

		if !alreadyPresent && cleanText != "" {
			session.Messages = append(session.Messages, ChatMessage{Role: normalRole, Content: cleanText})
		}
	}

	// Maintain strictly max 10 messages in RAM
	if len(session.Messages) > 10 {
		session.Messages = session.Messages[len(session.Messages)-10:]
	}

	session.LastActivity = time.Now()

	copied := make([]ChatMessage, len(session.Messages))
	copy(copied, session.Messages)
	return copied
}

func getSlidingWindowRAM(username, customerPhone string) []ChatMessage {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	sessionKey := cleanUsr + "_" + cleanPhone

	ramCacheLock.Lock()
	session, exists := chatMemoryRAM[sessionKey]
	ramCacheLock.Unlock()

	if !exists || session == nil || len(session.Messages) == 0 {
		return updateSlidingWindowRAM(cleanUsr, cleanPhone, "", "")
	}

	ramCacheLock.Lock()
	session.LastActivity = time.Now()
	copied := make([]ChatMessage, len(session.Messages))
	copy(copied, session.Messages)
	ramCacheLock.Unlock()

	return copied
}

// Legacy alias for compatibility
func updateSlidingWindow(sessionKey string, role string, text string) []ChatMessage {
	parts := strings.SplitN(sessionKey, "_", 2)
	if len(parts) == 2 {
		return updateSlidingWindowRAM(parts[0], parts[1], role, text)
	}
	return []ChatMessage{{Role: role, Content: text}}
}

// Helper to retrieve live product catalog items to feed into AI system prompt
func GetCatalogContext(username string) string {
	if DB == nil {
		return ""
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	rows, err := DB.Query(`SELECT name, price, COALESCE(description, ''), COALESCE(unit_type, ''), COALESCE(whatsapp_catalog_link, '') 
		FROM products WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2) ORDER BY id ASC`, cleanUsr, cleanUsr+"@gmail.com")
	if err != nil {
		return ""
	}
	defer rows.Close()

	var sb strings.Builder
	hasProducts := false
	for rows.Next() {
		var name, price, desc, unitType, waCatalogLink string
		if err := rows.Scan(&name, &price, &desc, &unitType, &waCatalogLink); err == nil {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if !hasProducts {
				sb.WriteString("Products:\n")
				hasProducts = true
			}
			price = strings.TrimSpace(price)
			line := "- " + name
			if price != "" {
				line += ": " + price
				unitType = strings.TrimSpace(unitType)
				if unitType != "" && unitType != "custom" {
					line += "/" + unitType
				}
			}
			if desc = strings.TrimSpace(desc); desc != "" {
				line += " - " + desc
			}
			if waCatalogLink = strings.TrimSpace(waCatalogLink); waCatalogLink != "" {
				line += " (" + waCatalogLink + ")"
			}
			sb.WriteString(line + "\n")
		}
	}
	return strings.TrimSpace(sb.String())
}

// 2. Main AI Auto-Reply Generator
func GenerateAIReply(username, customerPhone, incomingText, provider, apiKey, systemPrompt string) (string, string) {
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")
	cleanPhone := FormatPhone(customerPhone)
	selectedApiKey := getRotatedAPIKey(cleanUsr, apiKey)

	if selectedApiKey == "" {
		selectedApiKey = strings.TrimSpace(os.Getenv("GROQ_API_KEY"))
		if selectedApiKey == "" {
			selectedApiKey = strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
		}
		if selectedApiKey == "" {
			selectedApiKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		}
	}
	if selectedApiKey == "" && DB != nil {
		var fallbackKey, fallbackProv string
		_ = DB.QueryRow(`SELECT api_key, COALESCE(ai_provider, 'groq') 
			FROM users WHERE api_key != '' AND api_key IS NOT NULL LIMIT 1`).Scan(&fallbackKey, &fallbackProv)
		if fallbackKey != "" {
			selectedApiKey = fallbackKey
			if provider == "" {
				provider = fallbackProv
			}
			log.Printf("ℹ️ [API Key Fallback] Using active DB key (%s) for @%s", fallbackProv, cleanUsr)
		}
	}
	if selectedApiKey == "" {
		log.Printf("⚠️ No API key found for @%s", cleanUsr)
		return "", ""
	}

	model := "openai/gpt-oss-20b"
	temp := 0.7
	importCatalog := false
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(ai_model, 'openai/gpt-oss-20b'), COALESCE(ai_temperature, 0.7), COALESCE(import_catalog_details, false) FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&model, &temp, &importCatalog)
		if model == "llama-3.1-8b-instant" || model == "llama-3.3-70b-versatile" || model == "" {
			model = "openai/gpt-oss-20b"
		}
	}

	var bName, bType, lang string
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(business_name, account_name, ''), COALESCE(business_type, 'Kirana / General Store'), COALESCE(response_language, 'Hinglish') FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&bName, &bType, &lang)
	}

	catalogContext := ""
	if importCatalog {
		catalogContext = GetCatalogContext(cleanUsr)
	}

	sysPrompt := strings.TrimSpace(systemPrompt)
	stableSysPrompt := ""
	if sysPrompt != "" {
		stableSysPrompt = sysPrompt
		if importCatalog && catalogContext != "" {
			stableSysPrompt += "\n\n" + catalogContext
		}
	} else {
		stableSysPrompt = BuildUniversalSystemPrompt(bName, bType, lang, catalogContext)
	}

	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 || history[len(history)-1].Content != incomingText {
		history = updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)
	}

	aiResponse, err := CallAIModelWithHistory(provider, model, temp, selectedApiKey, stableSysPrompt, history)
	if err != nil || aiResponse == "" {
		log.Printf("⚠️ GenerateAIReply error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return "", ""
	}

	return aiResponse, ""
}

// 3. RAM-First AI Auto-Reply Generator (Instant 0ms RAM lookup & Minimal Token Prompt Caching)
func GenerateAIReplyRAM(username, customerPhone, incomingText string, cfg *UserConfigRAM) (string, string) {
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")
	cleanPhone := FormatPhone(customerPhone)

	if cfg == nil {
		cfg = GetUserConfigRAM(cleanUsr)
	}

	selectedApiKey := getRotatedAPIKey(cleanUsr, cfg.APIKey)
	if selectedApiKey == "" {
		selectedApiKey = strings.TrimSpace(os.Getenv("GROQ_API_KEY"))
		if selectedApiKey == "" {
			selectedApiKey = strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
		}
		if selectedApiKey == "" {
			selectedApiKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		}
	}
	if selectedApiKey == "" && DB != nil {
		var fallbackKey, fallbackProv, fallbackModel string
		_ = DB.QueryRow(`SELECT api_key, COALESCE(ai_provider, 'groq'), COALESCE(ai_model, 'openai/gpt-oss-20b') 
			FROM users WHERE api_key != '' AND api_key IS NOT NULL LIMIT 1`).Scan(&fallbackKey, &fallbackProv, &fallbackModel)
		if fallbackKey != "" {
			selectedApiKey = fallbackKey
			if cfg.APIKey == "" {
				cfg.APIKey = fallbackKey
				cfg.Provider = fallbackProv
				cfg.Model = fallbackModel
			}
			log.Printf("ℹ️ [API Key Fallback] Using active DB key (%s) for @%s", fallbackProv, cleanUsr)
		}
	}
	if selectedApiKey == "" {
		log.Printf("⚠️ No API key found for @%s", cleanUsr)
		return "", ""
	}

	// Fetch current sliding window (contains prior messages + latest incoming customer message)
	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 || history[len(history)-1].Content != incomingText {
		history = updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)
	}

	// Dynamic token-optimized universal system prompt
	bName := cfg.BusinessName
	if bName == "" {
		bName = cleanUsr
	}
	bType := cfg.BusinessType
	if bType == "" {
		bType = "Kirana / General Store"
	}
	lang := cfg.Language
	if lang == "" {
		lang = "Hinglish"
	}

	stableSysPrompt := BuildUniversalSystemPrompt(bName, bType, lang, cfg.CatalogText)

	aiResponse, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, cfg.Temperature, selectedApiKey, stableSysPrompt, history)
	if err == nil && aiResponse != "" {
		// 1. Process <ORDER_JSON> if emitted
		jsonRegex := regexp.MustCompile(`(?i)<ORDER_JSON>([\s\S]*?)</ORDER_JSON>`)
		if jsonMatch := jsonRegex.FindStringSubmatch(aiResponse); len(jsonMatch) > 1 && DB != nil {
			var orderMap map[string]interface{}
			if errJson := json.Unmarshal([]byte(strings.TrimSpace(jsonMatch[1])), &orderMap); errJson == nil {
				delPhone, _ := orderMap["delivery_phone"].(string)
				custName, _ := orderMap["customer_name"].(string)
				delAddr, _ := orderMap["delivery_address"].(string)
				payMode, _ := orderMap["payment_mode"].(string)
				payStatus, _ := orderMap["payment_status"].(string)
				itemsBytes, _ := json.Marshal(orderMap["items"])
				rawBytes, _ := json.Marshal(orderMap)
				var totAmt float64
				switch v := orderMap["total_amount"].(type) {
				case float64:
					totAmt = v
				case int:
					totAmt = float64(v)
				}
				ordID := fmt.Sprintf("ORD_%s_%d", cleanPhone[max(0, len(cleanPhone)-4):], time.Now().Unix()%10000)

				_, _ = DB.Exec(`INSERT INTO customer_order_states 
					(username, customer_phone, delivery_phone, customer_name, delivery_address, items, total_amount, payment_mode, payment_status, order_status, order_id, raw_json, updated_at)
					VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'in_progress', $10, $11::jsonb, NOW())
					ON CONFLICT (username, customer_phone) DO UPDATE SET
						delivery_phone = COALESCE(NULLIF(EXCLUDED.delivery_phone, ''), customer_order_states.delivery_phone),
						customer_name = COALESCE(NULLIF(EXCLUDED.customer_name, ''), customer_order_states.customer_name),
						delivery_address = COALESCE(NULLIF(EXCLUDED.delivery_address, ''), customer_order_states.delivery_address),
						items = CASE WHEN jsonb_array_length(EXCLUDED.items) > 0 THEN EXCLUDED.items ELSE customer_order_states.items END,
						total_amount = CASE WHEN EXCLUDED.total_amount > 0 THEN EXCLUDED.total_amount ELSE customer_order_states.total_amount END,
						payment_mode = CASE WHEN EXCLUDED.payment_mode != 'unselected' THEN EXCLUDED.payment_mode ELSE customer_order_states.payment_mode END,
						order_id = COALESCE(NULLIF(EXCLUDED.order_id, ''), customer_order_states.order_id),
						raw_json = EXCLUDED.raw_json,
						updated_at = NOW()`,
					cleanUsr, cleanPhone, delPhone, custName, delAddr, string(itemsBytes), totAmt, payMode, payStatus, ordID, string(rawBytes))
			}
			aiResponse = jsonRegex.ReplaceAllString(aiResponse, "")
		}

		// 2. Process [INITIATE_PAYMENT_QR] and <PAYMENT_TRIGGER>
		hasPaymentTrigger := strings.Contains(aiResponse, "[INITIATE_PAYMENT_QR]")
		payRegex := regexp.MustCompile(`(?i)<PAYMENT_TRIGGER\s+amount=["']?([0-9.]+)["']?\s+order_id=["']?([^"'>]+)["']?\s*/?>`)
		payMatch := payRegex.FindStringSubmatch(aiResponse)
		var matchedImg string

		if (hasPaymentTrigger || len(payMatch) > 2) && cfg.HasOnlinePayment {
			amountStr := "0"
			orderIDStr := fmt.Sprintf("ORD_%s_%d", cleanPhone[max(0, len(cleanPhone)-4):], time.Now().Unix()%10000)

			if len(payMatch) > 2 {
				amountStr = strings.TrimSpace(payMatch[1])
				if o := strings.TrimSpace(payMatch[2]); o != "" && o != "ORDER_ID" {
					orderIDStr = o
				}
			} else if DB != nil {
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

			if amountStr == "0" || amountStr == "0.00" || amountStr == "" {
				priceRegex := regexp.MustCompile(`(?i)(?:rs\.?|inr|₹)\s*([0-9]+(?:\.[0-9]+)?)`)
				if pMatches := priceRegex.FindAllStringSubmatch(aiResponse, -1); len(pMatches) > 0 {
					amountStr = pMatches[len(pMatches)-1][1]
				} else if pMatches := priceRegex.FindAllStringSubmatch(incomingText, -1); len(pMatches) > 0 {
					amountStr = pMatches[len(pMatches)-1][1]
				}
			}

			vpa := cfg.MerchantVpa
			if vpa == "" {
				vpa = "paytm.s1f6syj@pty"
			}
			pName := cfg.PayeeName
			if pName == "" {
				pName = bName
			}
			if pName == "" {
				pName = cleanUsr
			}

			// Standard UPI string fallback
			upiURI := fmt.Sprintf("upi://pay?pa=%s&pn=%s&am=%s&tr=%s&tn=Order_%s&cu=INR", vpa, pName, amountStr, orderIDStr, orderIDStr)

			// 1. Dynamic QR Generation via Cloudflare Worker
			workerQRURL, _, qrErr := payment.GenerateWorkerDynamicQR(vpa, pName, orderIDStr, amountStr, "")
			if qrErr == nil && workerQRURL != "" {
				matchedImg = workerQRURL
				log.Printf("⚡ [Cloudflare Worker Dynamic QR] Generated for Order: %s | URL: %s", orderIDStr, workerQRURL)
			} else {
				// Reliable fallback QR server if Worker call fails
				matchedImg = fmt.Sprintf("https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=%s", url.QueryEscape(upiURI))
				log.Printf("ℹ️ [Cloudflare Worker Fallback] Using standard QR for Order %s: %v", orderIDStr, qrErr)
			}

			// 2. Async Payment Verification (Webhook Pattern - No polling on Render server)
			mid := cfg.PaytmMid
			if mid != "" {
				go func(m, ord string) {
					errPoll := payment.StartWorkerPaymentCheck(m, ord, "")
					if errPoll != nil {
						log.Printf("⚠️ [Worker Start-Check Notice] Order %s: %v", ord, errPoll)
					}
				}(mid, orderIDStr)
			}

			paymentDetailsBlock := fmt.Sprintf("\n\n💳 *ONLINE PAYMENT LINK & QR CODE* 💳\n• Amount: ₹%s\n• Order ID: %s\n• Click to Pay via UPI (GPay/PhonePe/Paytm):\n%s\n\n(Scan the QR code above or click the link to complete payment)", amountStr, orderIDStr, upiURI)

			if hasPaymentTrigger {
				aiResponse = strings.ReplaceAll(aiResponse, "[INITIATE_PAYMENT_QR]", paymentDetailsBlock)
			} else {
				aiResponse = payRegex.ReplaceAllString(aiResponse, "") + paymentDetailsBlock
			}
		} else if hasPaymentTrigger {
			aiResponse = strings.ReplaceAll(aiResponse, "[INITIATE_PAYMENT_QR]", "✅ *Aapka Cash On Delivery (COD) Order Confirm ho gaya hai!* 🚚\nHamari team jald hi aapka order dispatch karegi. Delivery ke time cash payment ready rakhein.\n\nDhanyawad! 🙏")
		}

		return strings.TrimSpace(aiResponse), matchedImg
	}
	if err != nil || aiResponse == "" {
		log.Printf("⚠️ GenerateAIReplyRAM error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return "", ""
	}

	return aiResponse, ""
}

// 4. AsyncDBSync syncs processed customer chats and captured leads to Neon PostgreSQL DB in background without blocking server execution
func AsyncDBSync(username, customerPhone, incomingText, aiReplyText string) {
	go func() {
		if DB == nil {
			return
		}
		cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
		cleanPhone := FormatPhone(customerPhone)
		if cleanUsr == "" || cleanPhone == "" {
			return
		}

		if incomingText != "" {
			SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "customer", incomingText)
			_, _ = DB.Exec("INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Captured Lead', NOW())",
				cleanUsr, cleanPhone, incomingText)
		}

		if aiReplyText != "" {
			SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", aiReplyText)
		}
	}()
}

// Backward compatibility wrapper
func CallAIModel(provider, model string, temperature float64, rawApiKey, sysPrompt, userQuery string) (string, error) {
	history := []ChatMessage{{Role: "user", Content: userQuery}}
	return CallAIModelWithHistory(provider, model, temperature, rawApiKey, sysPrompt, history)
}

// Unified multi-provider AI model caller with structured Chat History & Prompt Caching
func CallAIModelWithHistory(provider, model string, temperature float64, rawApiKey, sysPrompt string, history []ChatMessage) (string, error) {
	apiKey := strings.TrimSpace(rawApiKey)
	if apiKey == "" {
		return "", fmt.Errorf("empty API key")
	}

	prov := strings.ToLower(strings.TrimSpace(provider))
	if prov == "chatgpt" {
		prov = "openai"
	}

	// Smart key prefix auto-detection
	if strings.HasPrefix(apiKey, "gsk_") {
		prov = "groq"
	} else if strings.HasPrefix(apiKey, "sk-") {
		prov = "openai"
	} else if strings.HasPrefix(apiKey, "AIzaSy") {
		prov = "gemini"
	}

	if prov == "" {
		prov = "groq"
	}

	cleanModel := strings.TrimSpace(model)
	if isNumericOrPhone(cleanModel) {
		cleanModel = ""
	}

	if prov == "gemini" {
		res, err := callGeminiAPIWithHistory(apiKey, cleanModel, temperature, sysPrompt, history)
		if err == nil && res != "" {
			return res, nil
		}
		log.Printf("⚠️ Gemini call failed (%v). Attempting fallback to Groq/OpenAI...", err)
		return callOpenAIFormatWithHistory("groq", "llama-3.3-70b-versatile", temperature, apiKey, sysPrompt, history)
	}

	return callOpenAIFormatWithHistory(prov, cleanModel, temperature, apiKey, sysPrompt, history)
}

func isNumericOrPhone(s string) bool {
	if s == "" {
		return false
	}
	clean := regexp.MustCompile(`\D`).ReplaceAllString(s, "")
	return len(clean) >= 8 && (len(clean) == len(s) || strings.HasPrefix(clean, "117") || strings.HasPrefix(clean, "223") || strings.HasPrefix(clean, "91"))
}

func callOpenAIFormatWithHistory(provider, model string, temperature float64, apiKey, sysPrompt string, history []ChatMessage) (string, error) {
	url := "https://api.groq.com/openai/v1/chat/completions"
	reqModel := strings.TrimSpace(model)

	candidateModels := []string{}

	switch provider {
	case "openai":
		url = "https://api.openai.com/v1/chat/completions"
		candidateModels = []string{"gpt-4o-mini", "gpt-4o"}
	case "deepseek":
		url = "https://api.deepseek.com/chat/completions"
		candidateModels = []string{"deepseek-chat"}
	case "openrouter":
		url = "https://openrouter.ai/api/v1/chat/completions"
		candidateModels = []string{"meta-llama/llama-3.1-8b-instruct:free"}
	default: // groq
		url = "https://api.groq.com/openai/v1/chat/completions"
		candidateModels = []string{"openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"}
	}

	if reqModel != "" && !isNumericOrPhone(reqModel) {
		candidateModels = append([]string{reqModel}, candidateModels...)
	}

	// Prepare structured messages array: System prompt FIRST (cachable), followed by sliding window messages
	messages := []ChatMessage{
		{Role: "system", Content: sysPrompt},
	}
	for _, m := range history {
		role := m.Role
		if role == "customer" {
			role = "user"
		} else if role == "outgoing" || role == "outgoing_ai" {
			role = "assistant"
		}
		if strings.TrimSpace(m.Content) != "" {
			messages = append(messages, ChatMessage{Role: role, Content: m.Content})
		}
	}

	var lastErr error
	for _, m := range candidateModels {
		payload := map[string]interface{}{
			"model":       m,
			"messages":    messages,
			"temperature": temperature,
		}
		body, _ := json.Marshal(payload)

		req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("User-Agent", "EduCloud-WhatsApp-Gateway/1.0")

		client := &http.Client{Timeout: 4 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}

		respBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var result struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(respBytes, &result); err == nil && len(result.Choices) > 0 && result.Choices[0].Message.Content != "" {
				return strings.TrimSpace(result.Choices[0].Message.Content), nil
			}
		}

		var errData struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBytes, &errData)
		if errData.Error.Message != "" {
			lastErr = fmt.Errorf("model %s: %s (status %d)", m, errData.Error.Message, resp.StatusCode)
		} else {
			lastErr = fmt.Errorf("model %s returned status %d", m, resp.StatusCode)
		}
	}

	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("empty AI reply received")
}

func callGeminiAPIWithHistory(apiKey, model string, temperature float64, sysPrompt string, history []ChatMessage) (string, error) {
	candidateModels := []string{"gemini-2.0-flash", "gemini-1.5-flash"}

	reqModel := strings.TrimSpace(model)
	if reqModel != "" && !isNumericOrPhone(reqModel) && !strings.Contains(reqModel, "gemini-1.0") && !strings.Contains(reqModel, "gemini-pro") {
		candidateModels = append([]string{reqModel}, candidateModels...)
	}

	// Prepare Gemini API structured contents
	var contents []map[string]interface{}
	for _, m := range history {
		role := "user"
		if m.Role == "assistant" || m.Role == "outgoing" || m.Role == "outgoing_ai" {
			role = "model"
		}
		if strings.TrimSpace(m.Content) != "" {
			contents = append(contents, map[string]interface{}{
				"role": role,
				"parts": []map[string]string{
					{"text": m.Content},
				},
			})
		}
	}

	if len(contents) == 0 {
		return "", fmt.Errorf("empty chat history for Gemini")
	}

	var lastErr error
	for _, mdl := range candidateModels {
		url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", mdl, apiKey)

		payload := map[string]interface{}{
			"system_instruction": map[string]interface{}{
				"parts": []map[string]string{
					{"text": sysPrompt},
				},
			},
			"contents": contents,
			"generationConfig": map[string]interface{}{
				"temperature": temperature,
			},
		}
		body, _ := json.Marshal(payload)

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Post(url, "application/json", bytes.NewBuffer(body))
		if err != nil {
			lastErr = err
			continue
		}

		respBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var result struct {
				Candidates []struct {
					Content struct {
						Parts []struct {
							Text string `json:"text"`
						} `json:"parts"`
					} `json:"content"`
				} `json:"candidates"`
			}
			if err := json.Unmarshal(respBytes, &result); err == nil && len(result.Candidates) > 0 && len(result.Candidates[0].Content.Parts) > 0 {
				return strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text), nil
			}
		}

		var errData struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(respBytes, &errData)
		if errData.Error.Message != "" {
			lastErr = fmt.Errorf("gemini model %s: %s (status %d)", mdl, errData.Error.Message, resp.StatusCode)
		} else {
			lastErr = fmt.Errorf("gemini status %d for model %s", resp.StatusCode, mdl)
		}
	}

	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("empty response from Gemini")
}
