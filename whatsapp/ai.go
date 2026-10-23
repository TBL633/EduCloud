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

var (
	// Key: "username_customerPhone" -> Value: RAM cached session (Max 10 messages, 5-min inactivity TTL)
	chatMemoryRAM = make(map[string]*CachedChatSession)
	ramCacheLock  sync.Mutex

	// Round-Robin API Key rotation index per username
	keyRotationIndex = make(map[string]int)
	keyRotationLock  sync.Mutex
)

func init() {
	// 1. Background RAM Eviction Worker (Clears sessions with no activity for > 5 minutes)
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

// 1. Sliding Window RAM Cache Manager (Max 10 messages per customer, 5-min inactivity eviction, auto re-hydration from DB)
func updateSlidingWindowRAM(username, customerPhone, role, text string) []ChatMessage {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	sessionKey := cleanUsr + "_" + cleanPhone

	ramCacheLock.Lock()
	defer ramCacheLock.Unlock()

	session, exists := chatMemoryRAM[sessionKey]

	// If session not in RAM (e.g. initial message OR evicted after 5 min inactivity),
	// re-hydrate last 10 messages directly from Neon PostgreSQL DB into RAM!
	if !exists || session == nil || len(session.Messages) == 0 {
		var dbMessages []ChatMessage
		if DB != nil {
			rows, err := DB.Query(`SELECT role, message_text 
				FROM (
					SELECT id, role, message_text 
					FROM customer_chats 
					WHERE LOWER(username)=LOWER($1) AND customer_phone=$2 
					ORDER BY id DESC LIMIT 10
				) sub ORDER BY id ASC`, cleanUsr, cleanPhone)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var r, m string
					if err := rows.Scan(&r, &m); err == nil {
						if r == "customer" {
							r = "user"
						} else if r == "assistant" || r == "outgoing" || r == "outgoing_ai" {
							r = "assistant"
						}
						dbMessages = append(dbMessages, ChatMessage{Role: r, Content: m})
					}
				}
			}
		}
		session = &CachedChatSession{
			LastActivity: time.Now(),
			Messages:     dbMessages,
		}
		chatMemoryRAM[sessionKey] = session
		log.Printf("📥 [RAM Re-Hydration]: Loaded %d prior messages from DB into RAM for %s", len(dbMessages), sessionKey)
	}

	// Append current message if non-empty
	if text != "" {
		normalRole := role
		if normalRole == "customer" {
			normalRole = "user"
		} else if normalRole == "outgoing" || normalRole == "outgoing_ai" {
			normalRole = "assistant"
		}
		session.Messages = append(session.Messages, ChatMessage{Role: normalRole, Content: text})
	}

	// Maintain strictly max 10 messages in RAM
	if len(session.Messages) > 10 {
		session.Messages = session.Messages[len(session.Messages)-10:]
	}

	// Update last activity timestamp to reset 5-minute inactivity timer
	session.LastActivity = time.Now()

	copied := make([]ChatMessage, len(session.Messages))
	copy(copied, session.Messages)
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
	rows, err := DB.Query(`SELECT name, price, COALESCE(description, ''), COALESCE(unit_type, 'custom'), COALESCE(whatsapp_catalog_link, '') 
		FROM products WHERE LOWER(username)=LOWER($1) ORDER BY id ASC`, cleanUsr)
	if err != nil {
		return ""
	}
	defer rows.Close()

	var sb strings.Builder
	sb.WriteString("\n\n=== LIVE BUSINESS PRODUCT CATALOG & PRICING ===\n")
	count := 0
	for rows.Next() {
		var name, price, desc, unitType, waCatalogLink string
		if err := rows.Scan(&name, &price, &desc, &unitType, &waCatalogLink); err == nil {
			count++
			linkStr := ""
			if waCatalogLink != "" {
				linkStr = fmt.Sprintf(" [WhatsApp Catalog Link: %s]", waCatalogLink)
			}
			sb.WriteString(fmt.Sprintf("%d. %s (Price: %s) [Unit: %s]%s - Details: %s\n", count, name, price, unitType, linkStr, desc))
		}
	}
	if count == 0 {
		return ""
	}
	sb.WriteString("=== END OF PRODUCT CATALOG (Use this exact pricing and details when customers ask.) ===\n")
	return sb.String()
}

// 2. Main AI Auto-Reply Generator
func GenerateAIReply(username, customerPhone, incomingText, provider, apiKey, systemPrompt string) (string, string) {
	cleanUsr := strings.TrimPrefix(strings.TrimSpace(username), "@")
	cleanPhone := FormatPhone(customerPhone)
	selectedApiKey := getRotatedAPIKey(cleanUsr, apiKey)

	// Fallback to environment variables if no user API key configured
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
		log.Printf("⚠️ No API key found for @%s (neither user configured nor environment variable set)", cleanUsr)
		return "", ""
	}

	model := "llama-3.3-70b-versatile"
	temp := 0.7
	importCatalog := true
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(ai_model, 'llama-3.3-70b-versatile'), COALESCE(ai_temperature, 0.7), COALESCE(import_catalog_details, true) FROM users WHERE LOWER(username)=LOWER($1)", cleanUsr).Scan(&model, &temp, &importCatalog)
	}

	if strings.TrimSpace(systemPrompt) == "" {
		systemPrompt = fmt.Sprintf("You are the 24/7 AI assistant for account @%s. Answer customer questions, provide pricing and product catalog information politely, and assist them in placing orders or getting help.", cleanUsr)
	}

	// Re-hydrate / Update RAM sliding window (Max 10 messages, 5-min inactivity eviction)
	history := updateSlidingWindowRAM(cleanUsr, cleanPhone, "user", incomingText)

	catalogContext := ""
	if importCatalog {
		catalogContext = GetCatalogContext(cleanUsr)
	}
	fullPrompt := systemPrompt + catalogContext + "\n\nYou are answering an inbound WhatsApp customer inquiry. Format pricing in rupees (₹), keep answers concise, helpful, and professional."

	// Build conversation history for AI model
	var lastUserMsg string
	var contextBuilder strings.Builder
	contextBuilder.WriteString(fullPrompt)
	contextBuilder.WriteString("\n\n=== RECENT CHAT HISTORY (LAST 10 MESSAGES) ===\n")
	for _, m := range history {
		if m.Role == "user" {
			contextBuilder.WriteString(fmt.Sprintf("Customer: %s\n", m.Content))
			lastUserMsg = m.Content
		} else {
			contextBuilder.WriteString(fmt.Sprintf("Assistant: %s\n", m.Content))
		}
	}
	contextBuilder.WriteString("=== END RECENT HISTORY ===\nAnswer the customer's latest query accurately:")

	if lastUserMsg == "" {
		lastUserMsg = incomingText
	}

	aiResponse, err := CallAIModel(provider, model, temp, selectedApiKey, contextBuilder.String(), lastUserMsg)
	if err != nil || aiResponse == "" {
		log.Printf("⚠️ GenerateAIReply error for @%s (+%s): %v", cleanUsr, cleanPhone, err)
		return "", ""
	}

	// Save AI reply in RAM sliding window
	_ = updateSlidingWindowRAM(cleanUsr, cleanPhone, "assistant", aiResponse)

	return aiResponse, ""
}

// Unified multi-provider AI model caller (Groq, Gemini, OpenAI, DeepSeek, OpenRouter)
func CallAIModel(provider, model string, temperature float64, rawApiKey, sysPrompt, userQuery string) (string, error) {
	apiKey := strings.TrimSpace(rawApiKey)
	if apiKey == "" {
		return "", fmt.Errorf("empty API key")
	}

	prov := strings.ToLower(strings.TrimSpace(provider))
	if prov == "chatgpt" {
		prov = "openai"
	}

	// Smart key prefix auto-detection to prevent provider mismatches
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

	// Sanitize model parameter: if purely numeric (e.g. phone number saved in model column) or invalid, clear it
	cleanModel := strings.TrimSpace(model)
	if isNumericOrPhone(cleanModel) {
		cleanModel = ""
	}

	if prov == "gemini" {
		res, err := callGeminiAPIWithModel(apiKey, cleanModel, temperature, sysPrompt, userQuery)
		if err == nil && res != "" {
			return res, nil
		}
		// If Gemini failed with key gsk_ or model mismatch, fallback to Groq if possible
		log.Printf("⚠️ Gemini call failed (%v). Attempting fallback to Groq/OpenAI...", err)
		return callOpenAIFormat("groq", "llama-3.3-70b-versatile", temperature, apiKey, sysPrompt, userQuery)
	}

	return callOpenAIFormat(prov, cleanModel, temperature, apiKey, sysPrompt, userQuery)
}

func isNumericOrPhone(s string) bool {
	if s == "" {
		return false
	}
	clean := regexp.MustCompile(`\D`).ReplaceAllString(s, "")
	return len(clean) >= 8 && (len(clean) == len(s) || strings.HasPrefix(clean, "117") || strings.HasPrefix(clean, "223") || strings.HasPrefix(clean, "91"))
}

func callOpenAIFormat(provider, model string, temperature float64, apiKey, sysPrompt, userQuery string) (string, error) {
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
		candidateModels = []string{"llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"}
	}

	if reqModel != "" && !isNumericOrPhone(reqModel) {
		// Prepend requested model to candidate list
		candidateModels = append([]string{reqModel}, candidateModels...)
	}

	var lastErr error
	for _, m := range candidateModels {
		messages := []ChatMessage{
			{Role: "system", Content: sysPrompt},
			{Role: "user", Content: userQuery},
		}

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

		client := &http.Client{Timeout: 10 * time.Second}
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

func callGeminiAPIWithModel(apiKey, model string, temperature float64, sysPrompt, userText string) (string, error) {
	// Candidate models list in priority order to handle deprecated/renamed models gracefully
	candidateModels := []string{"gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"}

	reqModel := strings.TrimSpace(model)
	if reqModel != "" && !isNumericOrPhone(reqModel) && !strings.Contains(reqModel, "gemini-1.0") && !strings.Contains(reqModel, "gemini-pro") {
		candidateModels = append([]string{reqModel}, candidateModels...)
	}

	var lastErr error
	for _, mdl := range candidateModels {
		url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", mdl, apiKey)

		payload := map[string]interface{}{
			"contents": []map[string]interface{}{
				{"role": "user", "parts": []map[string]string{{"text": sysPrompt + "\n\nCustomer Inquiry: " + userText}}},
			},
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
