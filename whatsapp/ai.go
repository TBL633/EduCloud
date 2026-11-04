package whatsapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
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
	StorePolicies    string
	HasOnlinePayment bool
	PaytmMid         string
	MerchantVpa      string
	PayeeName        string
	LastCached       time.Time
}

// Structs for AI JSON State Machine (Function Calling / Event Driven)
type AICartItem struct {
	ProductID string `json:"product_id"`
	Qty       int    `json:"qty"`
}

type AIProfileData struct {
	Address string `json:"address,omitempty"`
	Name    string `json:"name,omitempty"`
}

type AIResponseStateJSON struct {
	Action          string         `json:"action"` // "browsing", "add_to_cart", "ask_details", "update_profile", "generate_qr"
	ReplyToCustomer string         `json:"reply_to_customer"`
	CartItems       []AICartItem   `json:"cart_items,omitempty"`
	ProfileData     *AIProfileData `json:"profile_data,omitempty"`
}

// Master E-Commerce Sales Agent System Prompt Template (STRICT JSON ENFORCEMENT)
const universalSystemPromptJSON = `You are a sales agent for "%s" (a %s).
Store Policy: %s
Your output language MUST BE strictly: %s.

CRITICAL DIRECTIVES & JSON ENFORCEMENT:
You MUST output ONLY valid JSON. No markdown code block tags outside the JSON, no conversational text outside the JSON.
Your JSON response MUST strictly follow this schema:
{
  "action": "browsing",
  "reply_to_customer": "Your polite response or menu text in %s",
  "cart_items": [ { "product_id": "string", "qty": 1 } ],
  "profile_data": { "address": "string", "name": "string" }
}

ACTIONS (Choose exactly one):
1. "browsing": Default for general inquiry or showing catalog items.
2. "add_to_cart": Customer wants to buy or select item(s). Include cart_items array with product_id and qty.
3. "ask_details": Asking customer for address, name, or payment mode preference.
4. "update_profile": Customer provided their name or delivery address. Put details in profile_data.
5. "generate_qr": Customer confirmed checkout and selected online payment.

CRITICAL RULES:
1. CATALOG ONLY: Never invent products or prices. Only sell items listed in the provided Product Catalog.
2. HUMAN & POLITE: Make reply_to_customer polite, helpful, with WhatsApp formatting (*bold*, _italic_, emojis).
3. NO PRICE CALCULATIONS: You do NOT calculate total prices or generate bills. When the customer confirms checkout, simply return action 'generate_qr'.
4. STRICT PAYMENT SEPARATION: Never hallucinate order confirmation or say "Order confirmed" or "Payment received". Order confirmation is only done via automated payment webhook. When checking out, return action 'generate_qr'.`

// BuildUniversalSystemPrompt builds the final token-optimized JSON system prompt dynamically
func BuildUniversalSystemPrompt(businessName, businessType, language, storePolicies, catalogContext string) string {
	bName := strings.TrimSpace(businessName)
	if bName == "" {
		bName = "WaMart Store"
	}
	bType := strings.TrimSpace(businessType)
	if bType == "" {
		bType = "Kirana / General Store"
	}
	lang := strings.TrimSpace(language)
	if lang == "" {
		lang = "Hinglish"
	}
	policies := strings.TrimSpace(storePolicies)
	if policies == "" {
		policies = "Standard delivery and returns applicable."
	}

	finalPrompt := fmt.Sprintf(universalSystemPromptJSON, bName, bType, policies, lang, lang)
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
		var p, k, s, m, bName, bType, lang, pol string
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
			COALESCE(response_language, 'Hinglish'),
			COALESCE(store_policies, '')
			FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)`, cleanUsr, cleanUsr+"@gmail.com").Scan(&p, &k, &s, &m, &t, &ar, &ic, &bName, &bType, &lang, &pol)
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
			cfg.StorePolicies = pol
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

// Helper to retrieve live in-stock product catalog items grouped by category to feed into AI system prompt
func GetCatalogContext(username string) string {
	if DB == nil {
		return ""
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	rows, err := DB.Query(`SELECT id, name, price, COALESCE(description, ''), COALESCE(unit_type, ''), COALESCE(whatsapp_catalog_link, ''), COALESCE(category, 'General') 
		FROM products 
		WHERE (LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)) AND (in_stock IS TRUE OR in_stock IS NULL) 
		ORDER BY category ASC, id ASC`, cleanUsr, cleanUsr+"@gmail.com")
	if err != nil {
		return ""
	}
	defer rows.Close()

	type prodItem struct {
		id       int64
		name     string
		price    string
		desc     string
		unitType string
		waLink   string
		category string
	}

	catMap := make(map[string][]prodItem)
	var catOrder []string
	hasProducts := false

	for rows.Next() {
		var item prodItem
		if err := rows.Scan(&item.id, &item.name, &item.price, &item.desc, &item.unitType, &item.waLink, &item.category); err == nil {
			item.name = strings.TrimSpace(item.name)
			if item.name == "" {
				continue
			}
			item.category = strings.TrimSpace(item.category)
			if item.category == "" {
				item.category = "General"
			}
			if _, exists := catMap[item.category]; !exists {
				catOrder = append(catOrder, item.category)
			}
			catMap[item.category] = append(catMap[item.category], item)
			hasProducts = true
		}
	}

	if !hasProducts {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("Product Catalog (In Stock Items):\n")
	for _, cat := range catOrder {
		sb.WriteString(fmt.Sprintf("\nCategory: %s\n", cat))
		for _, p := range catMap[cat] {
			priceStr := strings.TrimSpace(p.price)
			line := fmt.Sprintf("- product_id: %d | %s", p.id, p.name)
			if priceStr != "" {
				line += ": Rs. " + priceStr
				unit := strings.TrimSpace(p.unitType)
				if unit != "" && unit != "custom" {
					line += "/" + unit
				}
			}
			if desc := strings.TrimSpace(p.desc); desc != "" {
				line += " - " + desc
			}
			if link := strings.TrimSpace(p.waLink); link != "" {
				line += " (" + link + ")"
			}
			sb.WriteString(line + "\n")
		}
	}

	return strings.TrimSpace(sb.String())
}

// ParseAIResponseJSON parses the AI state machine JSON output, extracts reply_to_customer, logs formatted JSON, and handles payment triggers
func ParseAIResponseJSON(rawResponse string) (*AIResponseStateJSON, string, error) {
	trimmed := strings.TrimSpace(rawResponse)
	// Strip markdown code fences if present (e.g. ```json ... ```)
	if strings.HasPrefix(trimmed, "```") {
		trimmed = strings.TrimPrefix(trimmed, "```")
		if strings.HasPrefix(strings.ToLower(trimmed), "json") {
			trimmed = strings.TrimSpace(trimmed[4:])
		}
		if idx := strings.LastIndex(trimmed, "```"); idx != -1 {
			trimmed = strings.TrimSpace(trimmed[:idx])
		}
	}

	firstBrace := strings.Index(trimmed, "{")
	lastBrace := strings.LastIndex(trimmed, "}")
	if firstBrace != -1 && lastBrace > firstBrace {
		trimmed = trimmed[firstBrace : lastBrace+1]
	}

	var state AIResponseStateJSON
	err := json.Unmarshal([]byte(trimmed), &state)
	if err != nil {
		log.Printf("⚠️ [AI JSON Response Parsing Failed]: %v | Raw text output: %s", err, rawResponse)
		return nil, rawResponse, err
	}

	prettyJSON, _ := json.MarshalIndent(state, "", "  ")
	log.Printf("📦 [Parsed AI JSON State Response]:\n%s", string(prettyJSON))

	replyText := strings.TrimSpace(state.ReplyToCustomer)
	if replyText == "" {
		replyText = rawResponse
	}

	if strings.ToLower(strings.TrimSpace(state.Action)) == "generate_qr" {
		if !strings.Contains(replyText, "[INITIATE_PAYMENT_QR]") {
			replyText = strings.TrimSpace(replyText) + "\n\n[INITIATE_PAYMENT_QR]"
		}
	}

	return &state, replyText, nil
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
		stableSysPrompt = BuildUniversalSystemPrompt(bName, bType, lang, "", catalogContext)
	}

	// Returning Customer Context Injection
	custProfile, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	if custProfile != nil && (custProfile.FullName != "" || custProfile.DeliveryAddress != "") {
		cName := custProfile.FullName
		if cName == "" {
			cName = "Customer"
		}
		cAddr := custProfile.DeliveryAddress
		if cAddr == "" {
			cAddr = "address on file"
		}
		stableSysPrompt += fmt.Sprintf("\n\nCUSTOMER CONTEXT: This is a returning customer named %s. Their saved address is %s. Greet them back. If they order, ask if they want delivery to their saved address or a new one.", cName, cAddr)
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

	parsedState, replyText, parseErr := ParseAIResponseJSON(aiResponse)
	if parseErr == nil && parsedState != nil {
		action := strings.ToLower(strings.TrimSpace(parsedState.Action))
		if parsedState.ProfileData != nil || action == "update_profile" {
			go UpdateCustomerProfileFromData(cleanUsr, cleanPhone, parsedState.ProfileData)
		}
		if action == "add_to_cart" && len(parsedState.CartItems) > 0 {
			go AddItemsToActiveCart(cleanUsr, cleanPhone, parsedState.CartItems)
		}
		if action == "generate_qr" {
			go func() {
				calcRes, errCalc := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
				if errCalc == nil && calcRes != nil {
					_, _ = DispatchCloudflareWorkerQR(cleanUsr, cleanPhone, calcRes)
				}
			}()
		}
	}
	return strings.TrimSpace(replyText), ""
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

	// Customer Profile Persistence & Context Injection for Returning Customers
	custProfile, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	var custContext string
	if custProfile != nil && (custProfile.FullName != "" || custProfile.DeliveryAddress != "") {
		cName := custProfile.FullName
		if cName == "" {
			cName = "Customer"
		}
		cAddr := custProfile.DeliveryAddress
		if cAddr == "" {
			cAddr = "address on file"
		}
		custContext = fmt.Sprintf("\n\nCUSTOMER CONTEXT: This is a returning customer named %s. Their saved address is %s. Greet them back. If they order, ask if they want delivery to their saved address or a new one.", cName, cAddr)
	}

	// Update customer profile asynchronously from incoming text
	go ExtractAndPersistCustomerDetails(cleanUsr, cleanPhone, incomingText)

	stableSysPrompt := BuildUniversalSystemPrompt(bName, bType, lang, cfg.StorePolicies, cfg.CatalogText) + custContext

	aiResponse, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, cfg.Temperature, selectedApiKey, stableSysPrompt, history)
	if err == nil && aiResponse != "" {
		parsedState, replyText, parseErr := ParseAIResponseJSON(aiResponse)
		if parseErr == nil && parsedState != nil {
			action := strings.ToLower(strings.TrimSpace(parsedState.Action))
			if parsedState.ProfileData != nil || action == "update_profile" {
				go UpdateCustomerProfileFromData(cleanUsr, cleanPhone, parsedState.ProfileData)
			}
			if action == "add_to_cart" && len(parsedState.CartItems) > 0 {
				go AddItemsToActiveCart(cleanUsr, cleanPhone, parsedState.CartItems)
			}
			if action == "generate_qr" {
				// Lock customer state to PAYMENT_PENDING in DB & RAM Cache
				_ = SetCustomerState(cleanUsr, cleanPhone, "PAYMENT_PENDING")

				go func() {
					calcRes, errCalc := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
					if errCalc == nil && calcRes != nil && calcRes.TotalAmount > 0 {
						_, _ = DispatchCloudflareWorkerQR(cleanUsr, cleanPhone, calcRes)
					}
				}()
			}
			aiResponse = replyText
		}
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

				// Persist into Customer Profiles (Neon DB)
				if custName != "" || delAddr != "" || delPhone != "" {
					go func(u, ph, nm, ad, dph, ord string, amt float64) {
						cp := &CustomerProfile{
							Username:         u,
							WANumber:         ph,
							FullName:         nm,
							DeliveryAddress:  ad,
							ContactPhone:     dph,
							LastOrderDetails: fmt.Sprintf("Order: %s | Amount: ₹%.2f", ord, amt),
						}
						_ = UpsertCustomerProfile(u, cp)
					}(cleanUsr, cleanPhone, custName, delAddr, delPhone, ordID, totAmt)
				}
			}
			aiResponse = jsonRegex.ReplaceAllString(aiResponse, "")
		}

		// 2. Process [INITIATE_PAYMENT_QR] and <PAYMENT_TRIGGER>
		hasPaymentTrigger := strings.Contains(aiResponse, "[INITIATE_PAYMENT_QR]")
		payRegex := regexp.MustCompile(`(?i)<PAYMENT_TRIGGER\s+amount=["']?([0-9.]+)["']?\s+order_id=["']?([^"'>]+)["']?\s*/?>`)
		if payRegex.MatchString(aiResponse) {
			hasPaymentTrigger = true
			aiResponse = payRegex.ReplaceAllString(aiResponse, "[INITIATE_PAYMENT_QR]")
		}

		if hasPaymentTrigger {
			if !cfg.HasOnlinePayment {
				aiResponse = strings.ReplaceAll(aiResponse, "[INITIATE_PAYMENT_QR]", "✅ *Aapka Cash On Delivery (COD) Order Confirm ho gaya hai!* 🚚\nHamari team jald hi aapka order dispatch karegi. Delivery ke time cash payment ready rakhein.\n\nDhanyawad! 🙏")
			}
			// When cfg.HasOnlinePayment is true, [INITIATE_PAYMENT_QR] is preserved in aiResponse.
			// The whatsmeow EventHandler intercepts it: sends text before QR, generates Cloudflare Worker dynamic QR,
			// uploads to whatsmeow, initiates /start-check polling, and sends the follow-up text.
		}

		return strings.TrimSpace(aiResponse), ""
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
		req.Header.Set("User-Agent", "WaMart-WhatsApp-Gateway/1.0")

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
