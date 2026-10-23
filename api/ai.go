package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"wa-server/whatsapp"
)

// AI RESPONDER SETTINGS & PROMPT CONFIGURATION (GET / POST /api/ai/settings)
func AISettingsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		username := cleanUsername(r.URL.Query().Get("username"))
		if username == "" {
			username = "admin"
		}

		var provider, apiKey, sysPrompt, aiModel, notifPhone string
		var temp float64
		var autoReply, importCatalogDetails bool
		importCatalogDetails = true

		if DB != nil {
			_ = DB.QueryRow(`SELECT COALESCE(ai_provider, 'gemini'), COALESCE(api_key, ''), COALESCE(system_prompt, ''), COALESCE(auto_reply, true), COALESCE(ai_model, ''), COALESCE(ai_temperature, 0.7), COALESCE(notification_phone, ''), COALESCE(import_catalog_details, true)
				FROM users WHERE LOWER(username)=LOWER($1)`, username).
				Scan(&provider, &apiKey, &sysPrompt, &autoReply, &aiModel, &temp, &notifPhone, &importCatalogDetails)
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":                 "success",
			"platform":               provider,
			"ai_provider":            provider,
			"api_key":                apiKey,
			"system_prompt":          sysPrompt,
			"auto_reply":             autoReply,
			"model":                  aiModel,
			"ai_model":               aiModel,
			"temperature":            temp,
			"ai_temperature":         temp,
			"notification_phone":     notifPhone,
			"import_catalog_details": importCatalogDetails,
		})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username             string  `json:"username"`
			AIProvider           string  `json:"ai_provider"`
			Platform             string  `json:"platform"`
			APIKey               string  `json:"api_key"`
			SystemPrompt         string  `json:"system_prompt"`
			AutoReply            bool    `json:"auto_reply"`
			AIModel              string  `json:"ai_model"`
			Model                string  `json:"model"`
			AITemperature        float64 `json:"ai_temperature"`
			Temperature          float64 `json:"temperature"`
			NotificationPhone    string  `json:"notification_phone"`
			ImportCatalogDetails bool    `json:"import_catalog_details"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		username := cleanUsername(req.Username)
		if username == "" {
			username = "admin"
		}

		provider := req.AIProvider
		if provider == "" {
			provider = req.Platform
		}
		if provider == "" {
			provider = "gemini"
		}

		modelName := req.AIModel
		if modelName == "" {
			modelName = req.Model
		}

		tempVal := req.AITemperature
		if tempVal == 0 && req.Temperature != 0 {
			tempVal = req.Temperature
		}

		if DB != nil {
			_, err := DB.Exec(`UPDATE users SET 
				ai_provider=$1, api_key=$2, system_prompt=$3, auto_reply=$4, ai_model=$5, ai_temperature=$6, notification_phone=$7, import_catalog_details=$8
				WHERE LOWER(username)=LOWER($9)`,
				provider, req.APIKey, req.SystemPrompt, req.AutoReply, modelName, tempVal, req.NotificationPhone, req.ImportCatalogDetails, username)

			if err != nil {
				respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update AI settings in database: " + err.Error()})
				return
			}
		}

		// Purge RAM cache so updated settings take effect immediately
		whatsapp.InvalidateUserConfigCache(username)

		respondJSON(w, 200, map[string]string{
			"status":  "success",
			"message": "AI Auto-Responder settings saved successfully!",
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// AI PLAYGROUND SIMULATOR (POST /api/ai/test)
func AITestHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username     string  `json:"username"`
		Query        string  `json:"query"`
		Provider     string  `json:"provider"`
		APIKey       string  `json:"api_key"`
		SystemPrompt string  `json:"system_prompt"`
		Model        string  `json:"model"`
		Temperature  float64 `json:"temperature"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" {
		username = "admin"
	}

	if req.Query == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Customer Query text is required."})
		return
	}

	reply, imageURL := whatsapp.GenerateAIReply(username, "playground_tester", req.Query, req.Provider, req.APIKey, req.SystemPrompt)

	if reply == "" {
		reply = fmt.Sprintf("Hello! Thank you for contacting us. I am your 24/7 AI assistant. Regarding '%s', our team will assist you shortly!", req.Query)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":    "success",
		"reply":     reply,
		"image_url": imageURL,
	})
}

// TEST LEAD NOTIFICATION ALERT DISPATCH (POST /api/ai/test-lead-alert)
func TestLeadAlertHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username          string `json:"username"`
		NotificationPhone string `json:"notification_phone"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	username := cleanUsername(req.Username)
	if username == "" {
		username = "admin"
	}

	targetPhone := strings.TrimSpace(req.NotificationPhone)
	if targetPhone != "" && DB != nil {
		_, _ = DB.Exec("UPDATE users SET notification_phone=$1 WHERE LOWER(username)=LOWER($2)", targetPhone, username)
	}
	if targetPhone == "" && DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(notification_phone, phone, '') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&targetPhone)
	}

	cleanPhone := whatsapp.FormatPhone(targetPhone)
	if cleanPhone == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "Please enter a valid notification WhatsApp number with country code."})
		return
	}

	alertText := fmt.Sprintf("🚨 *TEST LEAD ALERT DISPATCH* 🚨\n\n• Account: @%s\n• Target: +%s\n• Engine: EduCloud Go WhatsApp Gateway\n• Time: %s\n\n✅ If you received this, your automated lead capture notification is fully operational!",
		username, cleanPhone, time.Now().Format("02 Jan 15:04:05"))

	whatsapp.PushToLiveChat(username, cleanPhone, alertText, "lead_alert")

	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		_ = whatsapp.SendMessage(client, cleanPhone, alertText)
	}

	if DB != nil {
		_, _ = DB.Exec("INSERT INTO leads (username, customer_phone, inquiry_text, status, created_at) VALUES ($1, $2, $3, 'Test Lead Alert', NOW())",
			username, cleanPhone, "Test Lead Alert Dispatched")
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":             "success",
		"message":            fmt.Sprintf("Test alert dispatched to +%s! Check WhatsApp and Live Chat.", cleanPhone),
		"notification_phone": cleanPhone,
	})
}
