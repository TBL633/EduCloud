package whatsapp

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
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
	Provider                string
	APIKey                  string
	BusinessName            string
	BusinessType            string
	Language                string
	SystemPrompt            string
	Model                   string
	Temperature             float64
	AutoReply               bool
	ImportCatalog           bool
	CatalogText             string
	StorePolicies           string
	HasOnlinePayment        bool
	PaytmMid                string
	MerchantVpa             string
	PayeeName               string
	MaxDeliveryRadiusKM     float64
	FreeDeliveryRadiusKM    float64
	DeliveryChargeAmount    float64
	RequireCustomerLocation bool
	AllowCOD                bool
	LastCached              time.Time
}

// Structs for AI JSON State Machine (Function Calling / Event Driven)
type AICartItem struct {
	ProductID string `json:"product_id"`
	Qty       int    `json:"qty"`
}

type AIProfileData struct {
	Address       string `json:"address,omitempty"`
	Name          string `json:"name,omitempty"`
	ContactNumber string `json:"contact_number,omitempty"`
}

type AIResponseStateJSON struct {
	Action          string         `json:"action"` // "browsing", "add_to_cart", "ask_details", "update_profile", "generate_qr", "check_payment_status", "cancel_order", "confirm_cod"
	ReplyToCustomer string         `json:"reply_to_customer"`
	CartItems       []AICartItem   `json:"cart_items,omitempty"`
	ProfileData     *AIProfileData `json:"profile_data,omitempty"`
}

// -----------------------------------------------------------------------------
// OCTOPUS AGENTIC ARCHITECTURE: MULTI-ACTION ROUTING & 5 HANDS JSON SCHEMA
// -----------------------------------------------------------------------------

type FlexInt int

func (fi *FlexInt) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		*fi = FlexInt(n)
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		s = strings.TrimSpace(s)
		if val, err2 := strconv.Atoi(s); err2 == nil {
			*fi = FlexInt(val)
			return nil
		}
	}
	var f float64
	if err := json.Unmarshal(b, &f); err == nil {
		*fi = FlexInt(int(f))
		return nil
	}
	*fi = 1
	return nil
}

type AICartItemPayload struct {
	ID  string  `json:"id"`
	Qty FlexInt `json:"qty"`
}

type AIProfileDataPayload struct {
	Name                   string `json:"name,omitempty"`
	Address                string `json:"address,omitempty"`
	Contact                string `json:"contact,omitempty"`
	DeliveryAddress        string `json:"delivery_address,omitempty"`
	DeliveryContact10Digit string `json:"delivery_contact_10_digit,omitempty"`
}

type AIActionPayload struct {
	Category        string                `json:"category,omitempty"`
	ProductCategory string                `json:"product_category,omitempty"`
	OrderID         string                `json:"order_id,omitempty"`
	CartItems       []AICartItemPayload   `json:"cart_items,omitempty"`
	Profile         *AIProfileDataPayload `json:"profile,omitempty"`
	ProfileData     *AIProfileDataPayload `json:"profile_data,omitempty"`
}

type AIActionItem struct {
	Hand        string           `json:"hand"`
	Payload     *AIActionPayload `json:"payload,omitempty"`
	ExecuteHand string           `json:"execute_hand,omitempty"`
	Action      string           `json:"action,omitempty"`
}

type OctopusAIResponse struct {
	AIReplyText string         `json:"ai_reply_text"`
	Actions     []AIActionItem `json:"actions,omitempty"`

	// Legacy single-action fallback keys
	ExecuteHand     string           `json:"execute_hand,omitempty"`
	HandPayload     *AIActionPayload `json:"hand_payload,omitempty"`
	Action          string           `json:"action,omitempty"`
	ReplyToCustomer string           `json:"reply_to_customer,omitempty"`
	CartItems       []AICartItem     `json:"cart_items,omitempty"`
	ProfileData     *AIProfileData   `json:"profile_data,omitempty"`
}

// SafeAIFallbackReply is the safe polite message sent to WhatsApp users when AI parsing fails
const SafeAIFallbackReply = "> ✨ *NAMASTE JI* 🙏\n> _Aapki sahayata ke liye hum hamesha hazir hain!_\n\nMaaf kijiye, main aapka sandesh theek se samajh nahi paya. Kripya apna sawal ya item ka naam dobara batayein! 😊🍕"

// jsonExtractorRegex matches everything between the outermost curly braces { ... }
var jsonExtractorRegex = regexp.MustCompile(`(?s)\{.*\}`)

// Master Octopus Agentic System Prompt Template (STRICT MULTI-ACTION JSON ENFORCEMENT & BEAUTIFUL DESIGN)
const octopusSystemPromptJSON = `You are the brain of the automated store sales & support agent for "%s" (a %s).
Store Policy: %s
Your output language MUST BE strictly: %s.

CRITICAL INSTRUCTION: You MUST output ONLY a valid, raw JSON object. Do NOT wrap the JSON in markdown code blocks (like ` + "```json" + `), asterisks, or any explanatory text. NEVER write asterisks around key names (NEVER write *ai_reply_text*: or *actions*:). Your response MUST strictly start with '{' and end with '}'.

You are the brain. You must understand the user's intent, write a beautifully designed, polite, human-like reply, and command the backend to execute one or more physical actions using this strict JSON schema:

{
  "ai_reply_text": "String (Your beautifully designed reply in %s with clean headings, rich emojis, and bold styling)",
  "actions": [
    {
      "hand": "String (Choose from: send_catalog_images, update_cart, extract_profile, generate_payment_qr, verify_payment, generate_bill_pdf, generate_store_link, clear_cart, cancel_order, escalate_to_human, chat_only)",
      "payload": {
        "category": "String (Optional category name, e.g. 'all' or 'Dairy' or 'Snacks')",
        "order_id": "String (Optional order ID for PDF generation)",
        "cart_items": [{"id": "String", "qty": 1}],
        "profile": {"name": "", "address": "", "contact": ""}
      }
    }
  ]
}

VISUAL DESIGN & BEAUTIFUL FORMATTING GUIDELINES (WHATSAPP AESTHETICS):
1. **Clean & Modern Presentation (No Overused Quotes)**:
   - Do NOT place WhatsApp blockquote markers (>) on every line or on ordinary sentences! Messages must look clean, welcoming, and easy to read.
   - Use bold headings with friendly emojis: e.g. ✨ *Store Name* ✨, 🛒 *Cart Updated*, 📋 *Order Summary*.
   - Use clean bullet points (• ) for lists of items and categories.
   - Use blockquote (> ) ONLY sparingly when highlighting an official payment notice or invoice disclaimer, NEVER on regular chat.
2. **Category & Product Presentation (MANDATORY)**:
   - When greeting, introducing the store, or when the customer asks what is available, what categories you have, or wants to explore:
     a) Clearly explain what categories are available in the store and list the key products under each category with their prices (from the live inventory provided).
     b) Courteously ask the customer:
        "Aap categories dekh kar unki photo/image dekhna chahenge? Agar aap kisi category ya product ki photo dekhna chahein, toh batayein hum turant photo bhej denge! 📸✨"
     c) If the customer asks to view images (e.g. "photo dikhao", "images bhejo", "biscuit ki photo", "snacks dikhao"):
        Trigger the action: {"hand": "send_catalog_images", "payload": {"category": "<category or all>"}}.
     d) Every single reply MUST be generated dynamically by you (AI). NO hardcoded replies!
3. **Owner Assistance & Continuous Service (NEVER LOCK CHAT)**:
   - When customer asks to speak with the store owner/malik ("Malik se baat karao", "owner se baat karni hai", "dukan ke malik ko call karo"):
     a) Trigger the action: {"hand": "escalate_to_human", "payload": {}} so the backend immediately alerts the owner with full customer details, cart, and problem summary.
     b) In your reply, reassure the customer that their details and inquiry have been shared directly with the store owner.
     c) CRITICAL: DO NOT STOP HELPING! Continue assisting the customer right now warmly and attentively: ask what problem they are facing or what items they need, answer their questions, and keep their shopping or order going smoothly!

MASTER WORKFLOW - 7-PHASE AGENTIC CUSTOMER JOURNEY:

PHASE 1: GREETING, CATEGORIES & BROWSING (The Welcome)
- When user says "Hi", "Hello", "Menu", "Kya kya hai", or wants to browse:
  Present the store's categories and items nicely, and ask if they would like to see images:
  {"ai_reply_text": "✨ *Namaste & Welcome to Our Store!* 🙏\n\nHumare paas yeh categories aur items uplabdh hain:\n\n📂 *Snacks & Namkeen:*\n• Kurkure, Lays, Biscuits\n\n📂 *Daily Essentials & Dairy:*\n• Milk, Bread, Butter, Paneer\n\n📂 *Beverages:*\n• Cold Drinks, Tea, Coffee\n\n📸 *Aap inme se kisi category ya product ki image/photo dekhna chahenge?* Aap batayein hum turant photo bhej denge! 😊\n\nAapko kya deliver karein?", "actions": []}

PHASE 2: ADDING TO CART (The Selection)
- When user wants to add/select items (e.g. "Ek bread aur 2 packet milk add kar do"):
  Match items with the live catalog below to find exact product IDs and quantities.
  {"ai_reply_text": "🛒 *CART UPDATED* ✨\n\n• Bread x1\n• Milk x2\n\n💰 *Total:* ₹[Total]\n\nKya hum delivery address save karke *checkout* karein? 🚚", "actions": [{"hand": "update_cart", "payload": {"cart_items": [{"id": "item_1", "qty": 1}, {"id": "item_2", "qty": 2}]}}]}

PHASE 3: PROFILE EXTRACTION & PRE-PAYMENT SUMMARY (The Order Summary)
- When user confirms checkout or provides delivery details (e.g. "Haan checkout kar do. Address hai Ward no 1, Kanpur. Number 9876543210"):
  {"ai_reply_text": "Aapka delivery address save ho gaya hai! 🎉\n\n📋 *ORDER CONFIRMATION SUMMARY*\n• *Items:* [List of cart items with prices]\n• *Delivery Address:* Ward no 1, Kanpur\n• *Contact:* 9876543210\n• *Payable Total:* ₹[Total]\n\nKya aap payment *Online (Instant UPI QR)* se karenge ya *Cash on Delivery (COD)*? 😊", "actions": [{"hand": "extract_profile", "payload": {"profile": {"address": "Ward no 1, Kanpur", "contact": "9876543210"}}}]}

PHASE 4: PAYMENT LOCK & QR GENERATION (The Handoff)
- Only when user confirms payment via Online/UPI:
  {"ai_reply_text": "📲 *INSTANT UPI QR PAYMENT* ⚡\n\nOfficial UPI QR code upar bhej diya gaya hai. GPay, PhonePe, ya Paytm se scan karke ₹[Total] pay kar sakte hain.\n\nPayment hote hi yahan *'Ho gaya'* likhein ya screenshot share karein! 🙏✨", "actions": [{"hand": "generate_payment_qr"}]}

PHASE 5: DIRECT VERIFICATION & ORDER CONFIRMATION / BILL PDF GENERATION
- When payment is successfully verified, user confirms Cash On Delivery (COD) order, OR you receive a SYSTEM EVENT stating payment is successful (e.g. "SYSTEM EVENT: Payment of ₹..."):
  When payment is verified, COD is confirmed, OR you receive a payment success SYSTEM EVENT, you MUST output an array of 3 actions in this exact order:
  1. Output chat_only with a joyous order confirmation message confirming the order.
  2. Output generate_bill_pdf to instantly send the final thermal PDF receipt.
  3. Output clear_cart to reset the user's cart and state.
  Example:
  {"ai_reply_text": "🎉 *ORDER CONFIRMED!* ✅\n\nAapka order safaltapurvak confirm ho gaya hai! Humne aapka PDF bill receipt neeche bhej diya hai. Humari store team jald hi aapka order dispatch karegi! Dhanyawad! 🙏🚚✨", "actions": [{"hand": "chat_only"}, {"hand": "generate_bill_pdf"}, {"hand": "clear_cart"}]}

PHASE 6: HUMAN ESCALATION (Owner Connection + Continuous Support)
- When user asks for owner/malik/human (e.g. "Malik se baat karao", "owner se baat karni hai"):
  {"ai_reply_text": "🤝 *STORE OWNER NOTIFIED* 💬\n\nMaine aapki poori baat, cart details aur contact store ke Malik ko bhej diya hai! Woh jald hi aapse direct sampark karenge.\n\nTab tak main aapki kya sahayata kar sakta hu? Kripya apna sawal ya item batayein, hum aage ka kaam continue rakhte hain! 😊✨", "actions": [{"hand": "escalate_to_human"}]}

PHASE 7: VISUAL BROWSING & WEBPAGE MAGIC LINK (Omnichannel Sync)
- When user wants to browse visually, asks for the website, store link, or online catalog (e.g. "Website link bhejo", "store link do", "online catalog dekhna hai", "website se order karna hai"):
  {"ai_reply_text": "🛍️ *VISUAL STOREFRONT & ONLINE CATALOG* ✨\n\nAap humari visual website par poora catalog dekh sakte hain aur live shopping kar sakte hain!\n\nMaine aapka personal secure link taiyaar kiya hai:\n👉 *Link neeche bhej diya gaya hai!*\n\n✨ *Auto-Login Active:* Is link par click karne se aapka cart aur WhatsApp details website par turant sync ho jayenge! Click karke visual browsing start karein! 🛒🚀", "actions": [{"hand": "generate_store_link"}]}

STRICT EXECUTION RULES:
1. Always keep formatting visually appealing with bold headings and lively emojis, without ugly excess blockquotes.
2. MANDATORY PRE-PAYMENT SUMMARY: Before generating a QR code, always show the full order summary.
3. MANDATORY ORDER CONFIRMATION BILL GENERATION: When payment is verified, COD is confirmed, OR you receive a SYSTEM EVENT stating payment is successful, ALWAYS output chat_only, generate_bill_pdf, and clear_cart.
4. Use the REAL-TIME DATABASE STATE (current_state, shopping_cart, customer_profile, rag_results) injected below to make informed decisions.
5. If current_state is PAYMENT_PENDING:
   - If customer says they paid ("ho gaya", "done", "paid"), return "verify_payment".
   - If customer says "cancel", return "cancel_order".
6. If you receive a SYSTEM EVENT stating payment is successful, you MUST output a friendly confirmation message AND execute the 'generate_bill_pdf' action, followed by the 'clear_cart' action.
7. OMNICHANNEL MAGIC LINK RULE: If the user wants to browse visually, requests the website or asks for the online store link, ALWAYS generate and send their unique secure web link using the 'generate_store_link' action. Tell them: 'Click here to auto-login to our website. Your cart and details will be perfectly synced!'
8. OUTPUT ONLY THE RAW JSON OBJECT. NO PRETEXT, NO POSTTEXT, NO MARKDOWN OUTSIDE JSON.`

// Master E-Commerce Sales Agent System Prompt Template (STRICT JSON ENFORCEMENT)
const universalSystemPromptJSON = octopusSystemPromptJSON

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

	finalPrompt := fmt.Sprintf(octopusSystemPromptJSON, bName, bType, policies, lang, lang)
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
		Provider:                "groq",
		APIKey:                  "",
		BusinessName:            cleanUsr,
		BusinessType:            "Kirana / General Store",
		Language:                "Hinglish",
		SystemPrompt:            "",
		Model:                   "openai/gpt-oss-20b",
		Temperature:             0.7,
		AutoReply:               true,
		ImportCatalog:           true,
		CatalogText:             "",
		MaxDeliveryRadiusKM:     15.0,
		FreeDeliveryRadiusKM:    3.0,
		DeliveryChargeAmount:    40.0,
		RequireCustomerLocation: false,
		AllowCOD:                true,
		LastCached:              time.Now(),
	}

	if DB != nil {
		var p, k, s, m, bName, bType, lang, pol string
		var pMidUser, pVpaUser string
		var t, maxRad, freeRad, delCharge float64
		var ar, ic, reqLoc, allowCOD bool
		allowCOD = true
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
			COALESCE(store_policies, ''),
			COALESCE(paytm_mid, ''),
			COALESCE(paytm_vpa, ''),
			COALESCE(max_delivery_radius_km, 15.0),
			COALESCE(free_delivery_radius_km, 3.0),
			COALESCE(delivery_charge_amount, 40.0),
			COALESCE(require_customer_location, false),
			COALESCE(allow_cod, true)
			FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)`, cleanUsr, cleanUsr+"@gmail.com").Scan(&p, &k, &s, &m, &t, &ar, &ic, &bName, &bType, &lang, &pol, &pMidUser, &pVpaUser, &maxRad, &freeRad, &delCharge, &reqLoc, &allowCOD)
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
			cfg.MaxDeliveryRadiusKM = maxRad
			cfg.FreeDeliveryRadiusKM = freeRad
			cfg.DeliveryChargeAmount = delCharge
			cfg.RequireCustomerLocation = reqLoc
			cfg.AllowCOD = allowCOD
			if bName != "" {
				cfg.BusinessName = bName
			}
			if bType != "" {
				cfg.BusinessType = bType
			}
			if lang != "" {
				cfg.Language = lang
			}
			if pMidUser != "" {
				cfg.PaytmMid = strings.TrimSpace(pMidUser)
				cfg.HasOnlinePayment = true
			}
			if pVpaUser != "" {
				cfg.MerchantVpa = strings.TrimSpace(pVpaUser)
				cfg.HasOnlinePayment = true
			}
		}

		// Check if tenant has payment configured in tenant_payment_configs as secondary/override
		var payEnabled bool
		var pMid, mVpa, pName string
		errPay := DB.QueryRow(`SELECT enabled, COALESCE(paytm_mid, ''), COALESCE(merchant_vpa, ''), COALESCE(payee_name, '') 
			FROM tenant_payment_configs WHERE LOWER(username)=LOWER($1) OR LOWER(username)=LOWER($2)`, cleanUsr, cleanUsr+"@gmail.com").Scan(&payEnabled, &pMid, &mVpa, &pName)
		if errPay == nil {
			if pMid != "" {
				cfg.PaytmMid = strings.TrimSpace(pMid)
				cfg.HasOnlinePayment = true
			}
			if mVpa != "" {
				cfg.MerchantVpa = strings.TrimSpace(mVpa)
				cfg.HasOnlinePayment = true
			}
			if pName != "" {
				cfg.PayeeName = strings.TrimSpace(pName)
			}
		}

		// Fallback: If still empty, check if any registered user has configured Paytm MID/VPA
		if cfg.PaytmMid == "" || cfg.MerchantVpa == "" {
			var anyMid, anyVpa, anyName string
			_ = DB.QueryRow(`SELECT COALESCE(paytm_mid, ''), COALESCE(paytm_vpa, ''), COALESCE(business_name, account_name, '') 
				FROM users WHERE paytm_mid != '' OR paytm_vpa != '' ORDER BY id DESC LIMIT 1`).Scan(&anyMid, &anyVpa, &anyName)
			if cfg.PaytmMid == "" && anyMid != "" {
				cfg.PaytmMid = strings.TrimSpace(anyMid)
				cfg.HasOnlinePayment = true
			}
			if cfg.MerchantVpa == "" && anyVpa != "" {
				cfg.MerchantVpa = strings.TrimSpace(anyVpa)
				cfg.HasOnlinePayment = true
			}
			if cfg.PayeeName == "" && anyName != "" {
				cfg.PayeeName = strings.TrimSpace(anyName)
			}
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

// Clean10DigitPhone extracts strictly a 10-digit Indian phone number
func Clean10DigitPhone(raw string) string {
	digits := regexp.MustCompile(`\D`).ReplaceAllString(raw, "")
	if len(digits) >= 10 {
		return digits[len(digits)-10:]
	}
	return digits
}

// GetLiveInventoryRAG queries the products table for in_stock items and formats them into a clear category-grouped string:
// e.g. "Category: Pizza\n  • Paneer Pizza - ₹50 (ID: 1)"
func GetLiveInventoryRAG(username string) string {
	if DB == nil {
		return "Currently, all items are being updated in the inventory."
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))

	type prodItem struct {
		id    int64
		cat   string
		name  string
		price string
	}

	var rawList []prodItem

	// 1. Try querying products for this user
	q := `SELECT id, COALESCE(category, 'General'), name, price, COALESCE(sale_price, 0)
		FROM products 
		WHERE (LOWER(username)=$1 OR LOWER(username)=$2 OR LOWER(username) LIKE $1 || '%') 
		  AND (in_stock IS TRUE OR in_stock IS NULL)
		ORDER BY category ASC, id ASC`
	rows, err := DB.Query(q, cleanUsr, cleanUsr+"@gmail.com")

	if err == nil && rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id int64
			var cat, name, priceStr string
			var salePrice float64
			if errScan := rows.Scan(&id, &cat, &name, &priceStr, &salePrice); errScan == nil {
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				cat = strings.TrimSpace(cat)
				if cat == "" {
					cat = "General"
				}
				pVal := strings.TrimSpace(priceStr)
				if salePrice > 0 {
					pVal = fmt.Sprintf("%.2f", salePrice)
				}
				rawList = append(rawList, prodItem{id: id, cat: cat, name: name, price: pVal})
			}
		}
	}

	// 2. Fallback: If 0 products found for this specific username filter, query all in-stock products
	if len(rawList) == 0 {
		fbRows, fbErr := DB.Query(`SELECT id, COALESCE(category, 'General'), name, price, COALESCE(sale_price, 0)
			FROM products 
			WHERE (in_stock IS TRUE OR in_stock IS NULL)
			ORDER BY category ASC, id ASC LIMIT 50`)
		if fbErr == nil && fbRows != nil {
			defer fbRows.Close()
			for fbRows.Next() {
				var id int64
				var cat, name, priceStr string
				var salePrice float64
				if errScan := fbRows.Scan(&id, &cat, &name, &priceStr, &salePrice); errScan == nil {
					name = strings.TrimSpace(name)
					if name == "" {
						continue
					}
					cat = strings.TrimSpace(cat)
					if cat == "" {
						cat = "General"
					}
					pVal := strings.TrimSpace(priceStr)
					if salePrice > 0 {
						pVal = fmt.Sprintf("%.2f", salePrice)
					}
					rawList = append(rawList, prodItem{id: id, cat: cat, name: name, price: pVal})
				}
			}
		}
	}

	if len(rawList) == 0 {
		return "Currently, all items are being updated in the inventory."
	}

	// Group by category for clear presentation to the AI
	catMap := make(map[string][]prodItem)
	var catOrder []string
	for _, p := range rawList {
		if _, exists := catMap[p.cat]; !exists {
			catOrder = append(catOrder, p.cat)
		}
		catMap[p.cat] = append(catMap[p.cat], p)
	}

	var b strings.Builder
	b.WriteString("STORE CATEGORIES & PRODUCTS AVAILABLE (LIVE INVENTORY):\n")
	for _, c := range catOrder {
		b.WriteString(fmt.Sprintf("\n📂 Category: %s\n", c))
		for _, p := range catMap[c] {
			b.WriteString(fmt.Sprintf("  • %s - ₹%s (ID: %d)\n", p.name, p.price, p.id))
		}
	}

	return b.String()
}

// GetRAGCatalogResults searches in-stock products matching user message keywords or returns catalog highlights
func GetRAGCatalogResults(username, userMsg string) string {
	if DB == nil {
		return "No products available in catalog."
	}
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	tokens := strings.Fields(strings.ToLower(userMsg))

	var filterParts []string
	var args []interface{}
	args = append(args, cleanUsr, cleanUsr+"@gmail.com")

	stopWords := map[string]bool{
		"the": true, "and": true, "for": true, "with": true, "hai": true, "kya": true,
		"karo": true, "chahiye": true, "dena": true, "please": true, "mera": true,
		"meri": true, "mere": true, "bhai": true, "aap": true, "tum": true, "order": true,
		"mujhe": true, "dijiye": true, "bhejo": true, "hoga": true, "photos": true,
	}

	for _, t := range tokens {
		t = strings.Trim(t, ".,!?-_\"'#")
		if len(t) >= 3 && !stopWords[t] {
			args = append(args, "%"+t+"%")
			pos := len(args)
			filterParts = append(filterParts, fmt.Sprintf("(LOWER(name) LIKE $%d OR LOWER(category) LIKE $%d OR LOWER(description) LIKE $%d)", pos, pos, pos))
		}
	}

	var rows *sql.Rows
	var err error
	if len(filterParts) > 0 {
		q := fmt.Sprintf(`SELECT id, name, price, COALESCE(category, 'General'), COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
			FROM products 
			WHERE (LOWER(username)=$1 OR LOWER(username)=$2) AND (in_stock IS TRUE OR in_stock IS NULL) 
			  AND (%s) 
			ORDER BY id ASC LIMIT 8`, strings.Join(filterParts, " OR "))
		rows, err = DB.Query(q, args...)
	}

	if err != nil || rows == nil {
		q := `SELECT id, name, price, COALESCE(category, 'General'), COALESCE(NULLIF(image_url, ''), NULLIF(product_image_url, ''), '') 
			FROM products 
			WHERE (LOWER(username)=$1 OR LOWER(username)=$2) AND (in_stock IS TRUE OR in_stock IS NULL) 
			ORDER BY id ASC LIMIT 10`
		rows, err = DB.Query(q, cleanUsr, cleanUsr+"@gmail.com")
	}

	if err != nil || rows == nil {
		return "No products found in catalog."
	}
	defer rows.Close()

	var sb strings.Builder
	for rows.Next() {
		var id int64
		var name, price, cat, img string
		if err := rows.Scan(&id, &name, &price, &cat, &img); err == nil {
			hasImg := "No photo"
			if strings.TrimSpace(img) != "" {
				hasImg = "Photo available"
			}
			sb.WriteString(fmt.Sprintf("- Product [id: \"%d\"]: %s (Category: %s, Price: Rs. %s, %s)\n", id, name, cat, price, hasImg))
		}
	}

	res := strings.TrimSpace(sb.String())
	if res == "" {
		return "No in-stock products found."
	}
	return res
}

// BuildOctopusContext constructs the real-time Database state context string for the AI Brain
func BuildOctopusContext(username, customerPhone, userMsg string) string {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)

	// 1. current_state (BROWSING, CART_ACTIVE, PAYMENT_PENDING)
	payStatus := GetCustomerPaymentStatus(cleanUsr, cleanPhone)
	custState := GetCustomerState(cleanUsr, cleanPhone)
	currentState := "BROWSING"
	if strings.EqualFold(payStatus, "PENDING") || strings.EqualFold(custState, "PAYMENT_PENDING") {
		currentState = "PAYMENT_PENDING"
	} else {
		calcRes, _ := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
		if calcRes != nil && len(calcRes.Items) > 0 {
			currentState = "CART_ACTIVE"
		}
	}

	// 2. shopping_cart (List of active items and Total Amount)
	calcRes, _ := CalculateCartTotalAndFetchCredentials(cleanUsr, cleanPhone)
	var cartItemsDesc []string
	var cartTotal float64 = 0
	if calcRes != nil {
		cartTotal = calcRes.TotalAmount
		for _, it := range calcRes.Items {
			cartItemsDesc = append(cartItemsDesc, fmt.Sprintf("    * %s (ID: %s, Qty: %d, Price: Rs. %.2f, Subtotal: Rs. %.2f)", it.ProductName, it.ProductID, it.Qty, it.UnitPrice, it.LineTotal))
		}
	}
	cartStr := "Empty (Total: Rs. 0.00)"
	if len(cartItemsDesc) > 0 {
		cartStr = fmt.Sprintf("Total Amount: Rs. %.2f\n  Items:\n%s", cartTotal, strings.Join(cartItemsDesc, "\n"))
	}

	// 3. customer_profile (Name, WhatsApp Number, Delivery Address, Delivery Contact Number)
	custProfile, _ := GetCustomerProfile(cleanUsr, cleanPhone)
	cName := "Not provided"
	cAddr := "Not provided"
	cPhone := "Not provided"
	if custProfile != nil {
		if custProfile.FullName != "" {
			cName = custProfile.FullName
		}
		if custProfile.DeliveryAddress != "" {
			cAddr = custProfile.DeliveryAddress
		}
		if custProfile.ContactPhone != "" {
			cPhone = custProfile.ContactPhone
		}
	}

	// 4. rag_results (Matching products/categories based on user intent)
	ragStr := GetRAGCatalogResults(cleanUsr, userMsg)
	savedOrdID := GetCustomerCurrentOrderID(cleanUsr, cleanPhone)

	return fmt.Sprintf(`REAL-TIME DATABASE STATE (INJECTED SYSTEM CONTEXT):
- current_state: %s
- shopping_cart: %s
- customer_profile:
    * Name: %s
    * WhatsApp Number: %s
    * Delivery Address: %s
    * Delivery Contact Number: %s
- saved_order_id: %s
- rag_results (Matching products/catalog):
%s`, currentState, cartStr, cName, cleanPhone, cAddr, cPhone, savedOrdID, ragStr)
}

// ExtractJSONSubstring uses regex (?s)\{.*\} to find and extract the outermost JSON object
func ExtractJSONSubstring(raw string) string {
	trimmed := strings.TrimSpace(raw)
	match := jsonExtractorRegex.FindString(trimmed)
	return strings.TrimSpace(match)
}

// SanitizeAIReplyText ensures only clean conversational text reaches the user, completely stripping
// any actions arrays, pseudo-keys or raw JSON debris from the message
func SanitizeAIReplyText(s string) string {
	res := strings.TrimSpace(s)
	if res == "" {
		return ""
	}

	// 1. If string contains *actions*: or actions: delimiter, strip everything from that delimiter onwards
	delims := []string{"*actions*:", "**actions**:", "\"actions\":", "actions:", "[actions]"}
	for _, delim := range delims {
		if idx := strings.Index(strings.ToLower(res), delim); idx != -1 {
			res = strings.TrimSpace(res[:idx])
		}
	}

	// 2. Remove any *ai_reply_text*: prefixes (handling whitespace, quotes, asterisks, colons)
	for {
		trimmed := strings.TrimSpace(res)
		lower := strings.ToLower(trimmed)
		prefixMatched := false

		prefixes := []string{
			"*ai_reply_text*:",
			"**ai_reply_text**:",
			"ai_reply_text:",
			"\"ai_reply_text\":",
			"*reply_to_customer*:",
			"reply_to_customer:",
			"\"reply_to_customer\":",
		}

		for _, p := range prefixes {
			if strings.HasPrefix(lower, p) {
				res = strings.TrimSpace(trimmed[len(p):])
				prefixMatched = true
				break
			}
		}

		if !prefixMatched {
			break
		}
	}

	// 3. Clean up excessive / broken WhatsApp blockquotes (> )
	lines := strings.Split(res, "\n")
	var cleanedLines []string
	for _, l := range lines {
		trimL := strings.TrimSpace(l)
		// Skip standalone ">" with no text
		if trimL == ">" || trimL == "> _" || trimL == "> *" {
			continue
		}
		// If normal conversational sentences start with "> ", remove the leading "> " unless it is a special card title
		if strings.HasPrefix(trimL, "> ") {
			after := strings.TrimSpace(trimL[2:])
			// Retain blockquote ONLY if it's an official payment/alert notice
			if strings.HasPrefix(after, "💳") || strings.HasPrefix(after, "🚨") || strings.HasPrefix(after, "🧾") {
				cleanedLines = append(cleanedLines, trimL)
			} else {
				cleanedLines = append(cleanedLines, after)
			}
		} else {
			cleanedLines = append(cleanedLines, l)
		}
	}
	res = strings.Join(cleanedLines, "\n")

	// 4. Strip trailing punctuation/JSON/markdown debris
	res = strings.Trim(res, " ,\"'}{][\n\r*`")

	// 5. If the result is empty or still raw JSON
	if res == "" || strings.HasPrefix(res, "{") || strings.HasPrefix(res, "[") {
		return ""
	}
	return res
}

// tryExtractPseudoAIReply attempts to safely extract message text if AI returned pseudo-formatted text like *ai_reply_text*: ...
func tryExtractPseudoAIReply(raw string) string {
	lines := strings.Split(raw, "\n")
	var replyLines []string
	collecting := false

	for _, line := range lines {
		trimmedLine := strings.TrimSpace(line)
		lower := strings.ToLower(trimmedLine)

		// Stop if an actions block or JSON structure begins
		if strings.HasPrefix(lower, "*actions*:") || strings.HasPrefix(lower, "actions:") || strings.HasPrefix(lower, "- actions:") || strings.HasPrefix(lower, "\"actions\":") {
			collecting = false
			break
		}

		if strings.Contains(lower, "ai_reply_text") || strings.Contains(lower, "reply_to_customer") {
			idx := strings.Index(trimmedLine, ":")
			if idx != -1 {
				val := strings.TrimSpace(trimmedLine[idx+1:])
				val = strings.Trim(val, "\"* ")
				if val != "" {
					replyLines = append(replyLines, val)
				}
				collecting = true
				continue
			}
		}

		if collecting {
			// Stop if line looks like code, json or actions
			if strings.HasPrefix(trimmedLine, "{") || strings.HasPrefix(trimmedLine, "}") || strings.HasPrefix(trimmedLine, "[") || strings.HasPrefix(trimmedLine, "`") {
				collecting = false
				break
			}
			replyLines = append(replyLines, trimmedLine)
		}
	}

	res := strings.TrimSpace(strings.Join(replyLines, "\n"))
	return SanitizeAIReplyText(res)
}

// parsePseudoMarkdownOutput robustly handles AI outputs that mimic pseudo-YAML or markdown
// format instead of valid JSON, extracting BOTH the clean conversational text and all actions
func parsePseudoMarkdownOutput(raw string) *OctopusAIResponse {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}

	lower := strings.ToLower(trimmed)
	hasReplyKey := strings.Contains(lower, "ai_reply_text") || strings.Contains(lower, "reply_to_customer")
	hasActionsKey := strings.Contains(lower, "actions:") || strings.Contains(lower, "*actions*:") || strings.Contains(lower, "\"actions\":")
	if !hasReplyKey && !hasActionsKey {
		return nil
	}

	// Identify actions delimiter: "*actions*:", "**actions**:", "actions:", `"actions":`
	actionsIdx := -1
	delimiters := []string{"*actions*:", "**actions**:", "\"actions\":", "actions:"}
	for _, delim := range delimiters {
		if idx := strings.Index(lower, delim); idx != -1 {
			if actionsIdx == -1 || idx < actionsIdx {
				actionsIdx = idx
			}
		}
	}

	replyPart := ""
	actionsPart := ""

	if actionsIdx != -1 {
		replyPart = strings.TrimSpace(trimmed[:actionsIdx])
		actionsPart = strings.TrimSpace(trimmed[actionsIdx:])
	} else {
		replyPart = trimmed
	}

	// 1. Clean reply part to get pure human-like text
	cleanReply := SanitizeAIReplyText(replyPart)
	if cleanReply == "" {
		cleanReply = tryExtractPseudoAIReply(replyPart)
	}

	// 2. Extract actions array or items from actionsPart
	var parsedActions []AIActionItem
	if actionsPart != "" {
		// Look for JSON array '[' ... ']' in actionsPart
		startArr := strings.Index(actionsPart, "[")
		endArr := strings.LastIndex(actionsPart, "]")
		if startArr != -1 && endArr != -1 && endArr > startArr {
			arrayChunk := actionsPart[startArr : endArr+1]
			_ = json.Unmarshal([]byte(arrayChunk), &parsedActions)
		}

		// If no array or array was empty, look for a single JSON object '{' ... '}' in actionsPart
		if len(parsedActions) == 0 {
			startObj := strings.Index(actionsPart, "{")
			endObj := strings.LastIndex(actionsPart, "}")
			if startObj != -1 && endObj != -1 && endObj > startObj {
				singleObjChunk := actionsPart[startObj : endObj+1]
				var singleAct AIActionItem
				if errSingle := json.Unmarshal([]byte(singleObjChunk), &singleAct); errSingle == nil && singleAct.Hand != "" {
					parsedActions = append(parsedActions, singleAct)
				}
			}
		}
	}

	if cleanReply == "" && len(parsedActions) == 0 {
		return nil
	}

	if cleanReply == "" {
		cleanReply = SafeAIFallbackReply
	}

	return &OctopusAIResponse{
		AIReplyText: cleanReply,
		Actions:     parsedActions,
		ExecuteHand: "chat_only",
	}
}

// ParseOctopusAIResponse parses the agentic Octopus JSON response schema (supporting multi-action routing)
func ParseOctopusAIResponse(rawResponse string) (*OctopusAIResponse, error) {
	trimmed := strings.TrimSpace(rawResponse)
	if trimmed == "" {
		return &OctopusAIResponse{
			AIReplyText: SafeAIFallbackReply,
			Actions:     []AIActionItem{},
			ExecuteHand: "chat_only",
		}, fmt.Errorf("empty raw response")
	}

	var state OctopusAIResponse
	parsedStandard := false

	// Attempt standard JSON parsing first if extracted JSON contains "ai_reply_text" or "reply_to_customer"
	extracted := ExtractJSONSubstring(trimmed)
	if extracted != "" && (strings.Contains(extracted, `"ai_reply_text"`) || strings.Contains(extracted, `"reply_to_customer"`)) {
		if err := json.Unmarshal([]byte(extracted), &state); err == nil {
			parsedStandard = true
		}
	}

	// If standard JSON parsing didn't work (e.g. AI output pseudo-markdown like *ai_reply_text*: ... *actions*: [...]),
	// use parsePseudoMarkdownOutput to reliably extract BOTH clean AIReplyText and the Actions array!
	if !parsedStandard {
		if pseudoState := parsePseudoMarkdownOutput(trimmed); pseudoState != nil {
			state = *pseudoState
			parsedStandard = true
		}
	}

	if !parsedStandard {
		log.Printf("⚠️ [Octopus AI JSON Extraction Failed]: No JSON or pseudo-markdown found in raw output: %s", rawResponse)
		return &OctopusAIResponse{
			AIReplyText: SafeAIFallbackReply,
			Actions:     []AIActionItem{},
			ExecuteHand: "chat_only",
		}, fmt.Errorf("no json found")
	}

	// Normalize AIReplyText
	if strings.TrimSpace(state.AIReplyText) == "" && strings.TrimSpace(state.ReplyToCustomer) != "" {
		state.AIReplyText = state.ReplyToCustomer
	}
	state.AIReplyText = SanitizeAIReplyText(state.AIReplyText)
	if strings.TrimSpace(state.AIReplyText) == "" {
		state.AIReplyText = SafeAIFallbackReply
	}

	// Legacy single-action fallback normalization if actions array is empty
	if len(state.Actions) == 0 {
		hand := strings.ToLower(strings.TrimSpace(state.ExecuteHand))
		if hand == "" {
			act := strings.ToLower(strings.TrimSpace(state.Action))
			switch act {
			case "browsing", "chat", "chatting", "ask_details":
				hand = "chat_only"
			case "add_to_cart":
				hand = "update_cart"
			case "update_profile":
				hand = "extract_profile"
			case "generate_qr":
				hand = "generate_payment_qr"
			case "check_payment_status":
				hand = "verify_payment"
			case "cancel_order":
				hand = "cancel_order"
			case "escalate_to_human", "human_agent", "support":
				hand = "escalate_to_human"
			default:
				hand = "chat_only"
			}
		}
		state.ExecuteHand = hand

		if state.HandPayload == nil {
			state.HandPayload = &AIActionPayload{}
		}
		if len(state.HandPayload.CartItems) == 0 && len(state.CartItems) > 0 {
			for _, ci := range state.CartItems {
				state.HandPayload.CartItems = append(state.HandPayload.CartItems, AICartItemPayload{
					ID:  ci.ProductID,
					Qty: FlexInt(ci.Qty),
				})
			}
		}
		if state.HandPayload.Profile == nil && state.ProfileData != nil {
			state.HandPayload.Profile = &AIProfileDataPayload{
				Name:                   state.ProfileData.Name,
				Address:                state.ProfileData.Address,
				Contact:                state.ProfileData.ContactNumber,
				DeliveryAddress:        state.ProfileData.Address,
				DeliveryContact10Digit: state.ProfileData.ContactNumber,
			}
		}

		if hand != "" && hand != "chat_only" {
			state.Actions = append(state.Actions, AIActionItem{
				Hand:    hand,
				Payload: state.HandPayload,
			})
		}
	}

	// Normalize items within Actions array
	for i := range state.Actions {
		act := &state.Actions[i]
		h := strings.ToLower(strings.TrimSpace(act.Hand))
		if h == "" && act.ExecuteHand != "" {
			h = strings.ToLower(strings.TrimSpace(act.ExecuteHand))
		}
		if h == "" && act.Action != "" {
			h = strings.ToLower(strings.TrimSpace(act.Action))
		}
		switch h {
		case "add_to_cart":
			h = "update_cart"
		case "update_profile":
			h = "extract_profile"
		case "generate_qr":
			h = "generate_payment_qr"
		case "check_payment_status":
			h = "verify_payment"
		case "human", "human_agent", "support":
			h = "escalate_to_human"
		}
		act.Hand = h

		if act.Payload != nil {
			if act.Payload.Category == "" && act.Payload.ProductCategory != "" {
				act.Payload.Category = act.Payload.ProductCategory
			}
			if act.Payload.Profile == nil && act.Payload.ProfileData != nil {
				act.Payload.Profile = act.Payload.ProfileData
			}
			if act.Payload.Profile != nil {
				if act.Payload.Profile.Address == "" && act.Payload.Profile.DeliveryAddress != "" {
					act.Payload.Profile.Address = act.Payload.Profile.DeliveryAddress
				}
				if act.Payload.Profile.Contact == "" && act.Payload.Profile.DeliveryContact10Digit != "" {
					act.Payload.Profile.Contact = act.Payload.Profile.DeliveryContact10Digit
				}
			}
		}
	}

	prettyJSON, _ := json.MarshalIndent(state, "", "  ")
	log.Printf("🐙 [Parsed Octopus Agentic AI Response (Multi-Action)]:\n%s", string(prettyJSON))

	return &state, nil
}

// GenerateAIFeedbackApology (The Internal Feedback Loop):
// If any Golang hand fails during execution, silently passes the error string to the AI with a hidden system prompt:
// "SYSTEM INTERNAL ERROR: The action [action_name] failed because [error_detail]. Apologize to the user contextually and offer an alternative."
// The AI generates a smooth, human-like apology for the customer.
func GenerateAIFeedbackApology(username, customerPhone, failedAction, errorDetail string, cfg *UserConfigRAM) (string, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
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
		var fallbackKey string
		_ = DB.QueryRow(`SELECT api_key FROM users WHERE api_key != '' AND api_key IS NOT NULL LIMIT 1`).Scan(&fallbackKey)
		if fallbackKey != "" {
			selectedApiKey = fallbackKey
		}
	}
	if selectedApiKey == "" {
		return "", fmt.Errorf("no API key available for apology generation")
	}

	lang := cfg.Language
	if lang == "" {
		lang = "Hinglish"
	}
	bizName := cfg.BusinessName
	if bizName == "" {
		bizName = cleanUsr
	}

	hiddenSystemPrompt := fmt.Sprintf(`You are the polite store assistant for "%s".
SYSTEM INTERNAL ERROR: The action [%s] failed because [%s].
Apologize to the user contextually and offer an alternative in polite %s.
Do not mention system errors, code, databases, or technical API terms.
Format the message beautifully with WhatsApp blockquote callouts (>), bold highlights (*text*), clean spacing, and warm emojis (🙏, 📦, 😊, ✨).
Return ONLY your apologetic message for the customer.`, bizName, failedAction, errorDetail, lang)

	history := []ChatMessage{
		{Role: "user", Content: "Please assist with my request."},
	}

	apology, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, 0.7, selectedApiKey, hiddenSystemPrompt, history)
	if err != nil || strings.TrimSpace(apology) == "" {
		return "", err
	}

	cleanApology := strings.TrimSpace(apology)
	cleanApology = strings.TrimPrefix(cleanApology, "```json")
	cleanApology = strings.TrimPrefix(cleanApology, "```")
	cleanApology = strings.TrimSuffix(cleanApology, "```")
	cleanApology = strings.TrimSpace(cleanApology)

	log.Printf("🤖 [AI Feedback Loop Generated Apology] for +%s (Action %s failed: %s):\n%s", cleanPhone, failedAction, errorDetail, cleanApology)
	return cleanApology, nil
}

// GenerateAIContextualReply generates a 100% dynamic, context-aware reply strictly from AI (NO hardcoded replies).
// It formats with WhatsApp blockquotes (>), rich emojis, and warm customer care tone.
func GenerateAIContextualReply(username, customerPhone, situationContext string, cfg *UserConfigRAM) (string, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
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
		_ = DB.QueryRow(`SELECT api_key, COALESCE(ai_provider, 'groq'), COALESCE(ai_model, 'llama-3.3-70b-versatile') 
			FROM users WHERE api_key != '' AND api_key IS NOT NULL LIMIT 1`).Scan(&fallbackKey, &fallbackProv, &fallbackModel)
		if fallbackKey != "" {
			selectedApiKey = fallbackKey
			cfg.Provider = fallbackProv
			cfg.Model = fallbackModel
		}
	}

	if selectedApiKey == "" {
		return "", fmt.Errorf("no API key available to generate AI reply")
	}

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

	systemInstruction := fmt.Sprintf(`You are the polite, enthusiastic store assistant for "%s" (%s).
Output language MUST BE strictly: %s.
SITUATION UPDATE: %s

TASK: Write a direct, beautifully formatted message to send to the WhatsApp customer.
STRICT DESIGN RULES:
1. Keep formatting clean, open, and visually pleasant. Do NOT overuse blockquotes (>) on regular text or ordinary sentences. Use bold headings with tasteful emojis (e.g. ✨ *Store Update* ✨).
2. Liberally use warm, friendly emojis (✨, 🙏, 📦, 🍕, 🛒, 🏷️, 💳, 🚚, ⚡, 🎉, 🌟, 🧾, 📍, 📞, 🤝, 😊).
3. Use *bold* for key details (amounts, order IDs, next actions) and clean bullet points (• ).
4. Output ONLY the raw message text for the customer. DO NOT output JSON. DO NOT output code blocks or quotes around the whole text.`, bName, bType, lang, situationContext)

	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 {
		history = []ChatMessage{
			{Role: "user", Content: "Hello, please provide an update on my order / inquiry."},
		}
	}

	reply, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, 0.7, selectedApiKey, systemInstruction, history)
	if err != nil || strings.TrimSpace(reply) == "" {
		return "", err
	}

	cleanReply := SanitizeAIReplyText(reply)
	cleanReply = strings.TrimSpace(cleanReply)

	return cleanReply, nil
}

// ParseAIResponseJSON legacy adapter for backward compatibility
func ParseAIResponseJSON(rawResponse string) (*AIResponseStateJSON, string, error) {
	oct, err := ParseOctopusAIResponse(rawResponse)
	if err != nil {
		return nil, SafeAIFallbackReply, err
	}

	replyText := oct.AIReplyText
	if strings.TrimSpace(replyText) == "" {
		replyText = SafeAIFallbackReply
	}
	action := oct.ExecuteHand
	switch oct.ExecuteHand {
	case "chat_only":
		action = "browsing"
	case "update_cart":
		action = "add_to_cart"
	case "extract_profile":
		action = "update_profile"
	case "generate_payment_qr":
		action = "generate_qr"
		if !strings.Contains(replyText, "[INITIATE_PAYMENT_QR]") {
			replyText = strings.TrimSpace(replyText) + "\n\n[INITIATE_PAYMENT_QR]"
		}
	case "verify_payment":
		action = "check_payment_status"
		if !strings.Contains(replyText, "[VERIFY_PAYMENT_STATUS]") {
			replyText = strings.TrimSpace(replyText) + "\n\n[VERIFY_PAYMENT_STATUS]"
		}
	case "cancel_order":
		action = "cancel_order"
		if !strings.Contains(replyText, "[CANCEL_PENDING_ORDER]") {
			replyText = strings.TrimSpace(replyText) + "\n\n[CANCEL_PENDING_ORDER]"
		}
	}

	var cartItems []AICartItem
	if oct.HandPayload != nil {
		for _, c := range oct.HandPayload.CartItems {
			cartItems = append(cartItems, AICartItem{ProductID: c.ID, Qty: int(c.Qty)})
		}
	}
	var prof *AIProfileData
	if oct.HandPayload != nil && oct.HandPayload.ProfileData != nil {
		prof = &AIProfileData{
			Name:          oct.HandPayload.ProfileData.Name,
			Address:       oct.HandPayload.ProfileData.DeliveryAddress,
			ContactNumber: oct.HandPayload.ProfileData.DeliveryContact10Digit,
		}
	}

	st := &AIResponseStateJSON{
		Action:          action,
		ReplyToCustomer: oct.AIReplyText,
		CartItems:       cartItems,
		ProfileData:     prof,
	}
	return st, replyText, nil
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

	model := "llama-3.3-70b-versatile"
	temp := 0.7
	importCatalog := false
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(ai_model, 'llama-3.3-70b-versatile'), COALESCE(ai_temperature, 0.7), COALESCE(import_catalog_details, false) FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&model, &temp, &importCatalog)
		if model == "openai/gpt-oss-20b" || model == "openai/gpt-oss-120b" || model == "" {
			model = "llama-3.3-70b-versatile"
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

	cfg := GetUserConfigRAM(cleanUsr)
	if cfg != nil && !cfg.AllowCOD {
		stableSysPrompt += "\n\nPAYMENT METHOD POLICY: If `allow_cod` is false, strictly tell the user that Cash on Delivery is NOT available for this store and they must pay online via UPI/QR code. Do NOT accept Cash on Delivery orders under any circumstances."
	} else {
		stableSysPrompt += "\n\nPAYMENT METHOD POLICY: Cash on Delivery (COD) and Online Payment (UPI/QR) are both available for this store."
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
		if len(parsedState.CartItems) > 0 {
			_ = AddItemsToActiveCart(cleanUsr, cleanPhone, parsedState.CartItems)
		}
		if action == "generate_qr" {
			_ = SetCustomerState(cleanUsr, cleanPhone, "PAYMENT_PENDING")
			_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "PENDING")
		} else if action == "confirm_cod" {
			_ = SetCustomerState(cleanUsr, cleanPhone, "ORDER_CONFIRMED")
			_ = SetCustomerPaymentStatus(cleanUsr, cleanPhone, "COD_PENDING")
		}
	}
	return strings.TrimSpace(replyText), ""
}

// GenerateOctopusAIReply executes the Master Octopus Agentic Brain loop
func GenerateOctopusAIReply(username, customerPhone, incomingText string, cfg *UserConfigRAM) (*OctopusAIResponse, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
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
		_ = DB.QueryRow(`SELECT api_key, COALESCE(ai_provider, 'groq'), COALESCE(ai_model, 'llama-3.3-70b-versatile') 
			FROM users WHERE api_key != '' AND api_key IS NOT NULL LIMIT 1`).Scan(&fallbackKey, &fallbackProv, &fallbackModel)
		if fallbackKey != "" {
			selectedApiKey = fallbackKey
			if fallbackModel == "openai/gpt-oss-20b" || fallbackModel == "openai/gpt-oss-120b" || fallbackModel == "" {
				fallbackModel = "llama-3.3-70b-versatile"
			}
			if cfg.APIKey == "" {
				cfg.APIKey = fallbackKey
				cfg.Provider = fallbackProv
				cfg.Model = fallbackModel
			}
			log.Printf("ℹ️ [API Key Fallback] Using active DB key (%s/%s) for @%s", fallbackProv, fallbackModel, cleanUsr)
		}
	}
	if selectedApiKey == "" {
		log.Printf("⚠️ No API key found for @%s", cleanUsr)
		return nil, fmt.Errorf("no API key found for @%s", cleanUsr)
	}

	// Fetch current sliding window (contains prior messages + latest incoming customer message)
	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 || history[len(history)-1].Content != incomingText {
		history = updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)
	}

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

	// 1. FETCH LIVE INVENTORY (RAG CATALOG INJECTION FIX)
	liveInventory := GetLiveInventoryRAG(cleanUsr)
	inventoryPromptBlock := fmt.Sprintf("Here is the LIVE inventory you MUST use to answer the customer:\n%s\nIf the user asks what is available, list these exact items.", liveInventory)

	// 2. HYPERLOCAL DELIVERY RULES INJECTION
	deliveryRuleBlock := ""
	if cfg.RequireCustomerLocation {
		deliveryRuleBlock = fmt.Sprintf("HYPERLOCAL DELIVERY LOCATION RULE (STRICT ENFORCEMENT ACTIVE):\n- The tenant strictly requires the customer to attach their WhatsApp location pin (📎 Location) before checkout!\n- DO NOT place or confirm orders if only a typed text address is given! Politely instruct the customer to share their WhatsApp location pin: 'Kripya WhatsApp ke attachment button (📎) se apni Exact Location share karein taaki hum delivery distance verify kar sakein! 📍'\n- Delivery Rules: Max Radius = %.1f km. Free delivery up to %.1f km. Delivery charge beyond free radius = ₹%.2f.", cfg.MaxDeliveryRadiusKM, cfg.FreeDeliveryRadiusKM, cfg.DeliveryChargeAmount)
	} else {
		deliveryRuleBlock = fmt.Sprintf("HYPERLOCAL DELIVERY LOCATION RULE:\n- Typed text address is accepted for delivery.\n- Delivery Rules: Max Radius = %.1f km. Free delivery up to %.1f km. Delivery charge beyond free radius = ₹%.2f.", cfg.MaxDeliveryRadiusKM, cfg.FreeDeliveryRadiusKM, cfg.DeliveryChargeAmount)
	}

	// 3. THE CONTEXT INJECTOR (GOLANG TO AI)
	contextStr := BuildOctopusContext(cleanUsr, cleanPhone, incomingText)

	// 4. THE MASTER OCTOPUS BRAIN SYSTEM PROMPT
	masterPrompt := fmt.Sprintf(octopusSystemPromptJSON, bName, bType, cfg.StorePolicies, lang, lang) + "\n\n" + deliveryRuleBlock + "\n\n" + inventoryPromptBlock + "\n\n" + contextStr

	aiResponse, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, cfg.Temperature, selectedApiKey, masterPrompt, history)
	if err != nil || aiResponse == "" {
		log.Printf("⚠️ GenerateOctopusAIReply error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return &OctopusAIResponse{
			AIReplyText: SafeAIFallbackReply,
			Actions:     []AIActionItem{},
			ExecuteHand: "chat_only",
		}, err
	}

	parsedResponse, errParse := ParseOctopusAIResponse(aiResponse)
	if errParse != nil || parsedResponse == nil {
		log.Printf("⚠️ GenerateOctopusAIReply parsing failure for @%s (+%s): %v. Using safe fallback.", cleanUsr, cleanPhone, errParse)
		return &OctopusAIResponse{
			AIReplyText: SafeAIFallbackReply,
			Actions:     []AIActionItem{},
			ExecuteHand: "chat_only",
		}, nil
	}

	return parsedResponse, nil
}

// 3. RAM-First AI Auto-Reply Generator (Instant 0ms RAM lookup & Minimal Token Prompt Caching)
func GenerateAIReplyRAM(username, customerPhone, incomingText string, cfg *UserConfigRAM) (string, string) {
	resp, err := GenerateOctopusAIReply(username, customerPhone, incomingText, cfg)
	if err != nil || resp == nil {
		return "", ""
	}
	return resp.AIReplyText, ""
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
		candidateModels = []string{"llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3.8-27b"}
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
		if provider == "groq" || provider == "openai" || provider == "deepseek" {
			payload["response_format"] = map[string]string{
				"type": "json_object",
			}
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
				"temperature":        temperature,
				"response_mime_type": "application/json",
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
