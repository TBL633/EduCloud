package api

import (
	"encoding/json"
	"fmt"
	"log"
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

		var provider, apiKey, sysPrompt, aiModel, notifPhone, bName, bType, lang, pMid, pVpa, policies string
		var temp float64
		var autoReply, importCatalogDetails bool
		importCatalogDetails = true

		if DB != nil {
			_ = DB.QueryRow(`SELECT 
				COALESCE(ai_provider, 'gemini'), 
				COALESCE(api_key, ''), 
				COALESCE(system_prompt, ''), 
				COALESCE(auto_reply, true), 
				COALESCE(ai_model, ''), 
				COALESCE(ai_temperature, 0.7), 
				COALESCE(notification_phone, ''), 
				COALESCE(import_catalog_details, true),
				COALESCE(business_name, account_name, ''),
				COALESCE(business_type, 'Kirana / General Store'),
				COALESCE(response_language, 'Hinglish'),
				COALESCE(paytm_mid, ''),
				COALESCE(paytm_vpa, ''),
				COALESCE(store_policies, '')
				FROM users WHERE LOWER(username)=LOWER($1)`, username).
				Scan(&provider, &apiKey, &sysPrompt, &autoReply, &aiModel, &temp, &notifPhone, &importCatalogDetails, &bName, &bType, &lang, &pMid, &pVpa, &policies)
		}

		if bName == "" {
			bName = username
		}
		if bType == "" {
			bType = "Kirana / General Store"
		}
		if lang == "" {
			lang = "Hinglish"
		}

		respondJSON(w, 200, map[string]interface{}{
			"status":                 "success",
			"business_name":          bName,
			"business_type":          bType,
			"response_language":      lang,
			"language":               lang,
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
			"paytm_mid":              pMid,
			"paytm_vpa":              pVpa,
			"store_policies":         policies,
		})
		return
	}

	if r.Method == "POST" {
		var req struct {
			Username             string  `json:"username"`
			BusinessName         string  `json:"business_name"`
			BusinessType         string  `json:"business_type"`
			ResponseLanguage     string  `json:"response_language"`
			Language             string  `json:"language"`
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
			PaytmMid             string  `json:"paytm_mid"`
			PaytmVpa             string  `json:"paytm_vpa"`
			StorePolicies        string  `json:"store_policies"`
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

		bName := strings.TrimSpace(req.BusinessName)
		bType := strings.TrimSpace(req.BusinessType)
		if bType == "" {
			bType = "Kirana / General Store"
		}
		lang := strings.TrimSpace(req.ResponseLanguage)
		if lang == "" {
			lang = strings.TrimSpace(req.Language)
		}
		if lang == "" {
			lang = "Hinglish"
		}

		paytmMid := strings.TrimSpace(req.PaytmMid)
		paytmVpa := strings.TrimSpace(req.PaytmVpa)
		policies := strings.TrimSpace(req.StorePolicies)

		if DB != nil {
			_, err := DB.Exec(`UPDATE users SET 
				ai_provider=$1, api_key=$2, business_name=$3, business_type=$4, response_language=$5, auto_reply=$6, ai_model=$7, ai_temperature=$8, notification_phone=$9, import_catalog_details=$10,
				paytm_mid=$11, paytm_vpa=$12, store_policies=$13
				WHERE LOWER(username)=LOWER($14)`,
				provider, req.APIKey, bName, bType, lang, req.AutoReply, modelName, tempVal, req.NotificationPhone, req.ImportCatalogDetails, paytmMid, paytmVpa, policies, username)

			if err != nil {
				respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to update AI settings in database: " + err.Error()})
				return
			}

			// Upsert tenant_payment_configs if paytm fields are provided
			if paytmMid != "" || paytmVpa != "" {
				payEnabled := paytmMid != "" || paytmVpa != ""
				_, _ = DB.Exec(`INSERT INTO tenant_payment_configs (username, enabled, paytm_mid, merchant_vpa, payee_name, updated_at)
					VALUES ($1, $2, $3, $4, $5, NOW())
					ON CONFLICT (username) DO UPDATE SET
						enabled = EXCLUDED.enabled,
						paytm_mid = COALESCE(NULLIF(EXCLUDED.paytm_mid, ''), tenant_payment_configs.paytm_mid),
						merchant_vpa = COALESCE(NULLIF(EXCLUDED.merchant_vpa, ''), tenant_payment_configs.merchant_vpa),
						updated_at = NOW()`,
					username, payEnabled, paytmMid, paytmVpa, bName)
			}
		}

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
		Username         string  `json:"username"`
		Query            string  `json:"query"`
		BusinessName     string  `json:"business_name"`
		BusinessType     string  `json:"business_type"`
		ResponseLanguage string  `json:"response_language"`
		Language         string  `json:"language"`
		Provider         string  `json:"provider"`
		APIKey           string  `json:"api_key"`
		SystemPrompt     string  `json:"system_prompt"`
		Model            string  `json:"model"`
		Temperature      float64 `json:"temperature"`
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

	bName := strings.TrimSpace(req.BusinessName)
	bType := strings.TrimSpace(req.BusinessType)
	lang := strings.TrimSpace(req.ResponseLanguage)
	if lang == "" {
		lang = strings.TrimSpace(req.Language)
	}

	catalogContext := whatsapp.GetCatalogContext(username)
	customPrompt := strings.TrimSpace(req.SystemPrompt)
	if customPrompt == "" {
		var policies string
		if bName == "" && DB != nil {
			_ = DB.QueryRow("SELECT COALESCE(business_name, account_name, ''), COALESCE(business_type, 'Kirana / General Store'), COALESCE(response_language, 'Hinglish'), COALESCE(store_policies, '') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&bName, &bType, &lang, &policies)
		}
		customPrompt = whatsapp.BuildUniversalSystemPrompt(bName, bType, lang, policies, catalogContext)
	}

	reply, imageURL := whatsapp.GenerateAIReply(username, "playground_tester", req.Query, req.Provider, req.APIKey, customPrompt)

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

	alertText := fmt.Sprintf("🚨 *TEST LEAD ALERT DISPATCH* 🚨\n\n• Account: @%s\n• Target: +%s\n• Engine: WaMart Go WhatsApp Gateway\n• Time: %s\n\n✅ If you received this, your automated lead capture notification is fully operational!",
		username, cleanPhone, time.Now().Format("02 Jan 15:04:05"))

	whatsapp.PushToLiveChat(username, cleanPhone, alertText, "lead_alert")

	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.IsLoggedIn() {
		_ = whatsapp.EnsureConnected(client)
		err := whatsapp.SendMessage(client, cleanPhone, alertText)
		if err != nil {
			log.Printf("⚠️ [Test Lead Alert] SendMessage error to +%s: %v", cleanPhone, err)
		} else {
			log.Printf("✅ [Test Lead Alert] Successfully delivered test alert to +%s", cleanPhone)
		}
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
