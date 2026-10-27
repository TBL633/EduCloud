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
	Provider      string
	APIKey        string
	SystemPrompt  string
	Model         string
	Temperature   float64
	AutoReply     bool
	ImportCatalog bool
	CatalogText   string
	LastCached    time.Time
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
		SystemPrompt:  "",
		Model:         "openai/gpt-oss-20b",
		Temperature:   0.7,
		AutoReply:     true,
		ImportCatalog: false,
		CatalogText:   "",
		LastCached:    time.Now(),
	}

	if DB != nil {
		var p, k, s, m string
		var t float64
		var ar, ic bool
		err := DB.QueryRow(`SELECT 
			COALESCE(ai_provider, 'groq'), 
			COALESCE(api_key, ''), 
			COALESCE(system_prompt, ''), 
			COALESCE(ai_model, 'openai/gpt-oss-20b'), 
			COALESCE(ai_temperature, 0.7), 
			COALESCE(auto_reply, true), 
			COALESCE(import_catalog_details, false) 
			FROM users WHERE LOWER(username)=LOWER($1)`, cleanUsr).Scan(&p, &k, &s, &m, &t, &ar, &ic)
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
			cfg.ImportCatalog = false // Catalog messages ignored & catalog removed as requested
		}
	}

	cfg.CatalogText = ""

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
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")
	rows, err := DB.Query(`SELECT name, price, COALESCE(description, ''), COALESCE(unit_type, ''), COALESCE(whatsapp_catalog_link, '') 
		FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, cleanUsr)
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

	model := "llama-3.1-8b-instant"
	temp := 0.7
	importCatalog := true
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(ai_model, 'llama-3.1-8b-instant'), COALESCE(ai_temperature, 0.7), COALESCE(import_catalog_details, true) FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&model, &temp, &importCatalog)
	}

	sysPrompt := strings.TrimSpace(systemPrompt)
	if sysPrompt == "" {
		sysPrompt = fmt.Sprintf("Assistant for @%s.", cleanUsr)
	}

	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 || history[len(history)-1].Content != incomingText {
		history = updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)
	}

	catalogContext := ""
	if importCatalog {
		catalogContext = GetCatalogContext(cleanUsr)
	}
	stableSysPrompt := sysPrompt
	if importCatalog && catalogContext != "" {
		stableSysPrompt += "\n\n" + catalogContext
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
	if selectedApiKey == "" {
		log.Printf("⚠️ No API key found for @%s", cleanUsr)
		return "", ""
	}

	sysPrompt := strings.TrimSpace(cfg.SystemPrompt)
	if sysPrompt == "" {
		sysPrompt = fmt.Sprintf("Assistant for @%s.", cleanUsr)
	}

	// Fetch current sliding window (contains prior messages + latest incoming customer message)
	history := getSlidingWindowRAM(cleanUsr, cleanPhone)
	if len(history) == 0 || history[len(history)-1].Content != incomingText {
		history = updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)
	}

	stableSysPrompt := sysPrompt
	if cfg.ImportCatalog && cfg.CatalogText != "" {
		stableSysPrompt += "\n\n" + cfg.CatalogText
	}

	aiResponse, err := CallAIModelWithHistory(cfg.Provider, cfg.Model, cfg.Temperature, selectedApiKey, stableSysPrompt, history)
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
