package api

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"time"

	"wa-server/whatsapp"
)

// SINGLE MESSAGE / IMAGE SEND (External API + Manual Live Chat Reply)
func SendHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
		Message  string `json:"message"`
		ImageURL string `json:"image_url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	if req.Username == "" {
		req.Username = r.FormValue("username")
	}
	req.Username = cleanUsername(req.Username)
	if req.Username == "" {
		req.Username = "admin"
	}

	if req.Phone == "" {
		req.Phone = r.URL.Query().Get("phone")
	}
	if req.Phone == "" {
		req.Phone = r.FormValue("phone")
	}

	if req.Message == "" {
		req.Message = r.URL.Query().Get("message")
	}
	if req.Message == "" {
		req.Message = r.FormValue("message")
	}

	if req.ImageURL == "" {
		req.ImageURL = r.URL.Query().Get("image_url")
	}
	if req.ImageURL == "" {
		req.ImageURL = r.URL.Query().Get("media_url")
	}
	if req.ImageURL == "" {
		req.ImageURL = r.FormValue("image_url")
	}

	client := whatsapp.GetOrCreateClient(req.Username)
	var err error
	if client != nil {
		if req.ImageURL != "" {
			err = whatsapp.SendImageFromURL(client, req.Phone, req.ImageURL, req.Message)
		} else if req.Message != "" {
			err = whatsapp.SendMessage(client, req.Phone, req.Message)
		}

		if err != nil {
			respondJSON(w, 500, map[string]string{"status": "error", "message": err.Error()})
			return
		}
	}

	whatsapp.SaveCustomerChatAndPrune(req.Username, req.Phone, "assistant", req.Message)
	whatsapp.PushToLiveChat(req.Username, req.Phone, req.Message, "outgoing_manual")
	respondJSON(w, 200, map[string]string{"status": "success", "message": "Message Sent!"})
}

// BULK CAMPAIGN SENDER (Handles /api/bulk and /api/bulk/send)
func BulkSendHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var rawBody map[string]interface{}
	bodyBytes, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(bodyBytes, &rawBody)

	username, _ := rawBody["username"].(string)
	if username == "" {
		username = r.URL.Query().Get("username")
	}
	username = cleanUsername(username)
	if username == "" {
		username = "admin"
	}

	message, _ := rawBody["message"].(string)
	imageURL, _ := rawBody["image_url"].(string)
	useAntiBan := true
	if ab, ok := rawBody["anti_ban"].(bool); ok {
		useAntiBan = ab
	} else if ab, ok := rawBody["use_anti_ban"].(bool); ok {
		useAntiBan = ab
	}

	var phoneList []string
	if phoneStr, ok := rawBody["phones"].(string); ok {
		re := regexp.MustCompile(`[\r\n,;]+`)
		tokens := re.Split(phoneStr, -1)
		for _, t := range tokens {
			clean := whatsapp.FormatPhone(t)
			if len(clean) >= 8 && len(clean) <= 15 && !strings.HasPrefix(clean, "120363") {
				phoneList = append(phoneList, clean)
			}
		}
	} else if phoneArr, ok := rawBody["phones"].([]interface{}); ok {
		for _, item := range phoneArr {
			if s, ok := item.(string); ok {
				clean := whatsapp.FormatPhone(s)
				if len(clean) >= 8 && len(clean) <= 15 && !strings.HasPrefix(clean, "120363") {
					phoneList = append(phoneList, clean)
				}
			}
		}
	}

	if len(phoneList) == 0 {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "No valid target phone numbers provided."})
		return
	}

	client := whatsapp.GetOrCreateClient(username)
	if client == nil || !client.IsLoggedIn() {
		respondJSON(w, 400, map[string]string{
			"status":  "error",
			"message": "WhatsApp device is not connected. Please connect WhatsApp via QR code or 8-digit pairing code before launching bulk campaigns.",
		})
		return
	}

	campaignID := fmt.Sprintf("camp_%d_%d", time.Now().Unix(), rand.Intn(1000))

	if DB != nil {
		_, _ = DB.Exec(`INSERT INTO campaigns (id, username, message, image_url, use_anti_ban, status, total_count, sent_count, failed_count, start_time)
			VALUES ($1, $2, $3, $4, $5, 'running', $6, 0, 0, NOW())`,
			campaignID, username, message, imageURL, useAntiBan, len(phoneList))
	}

	// Launch async campaign worker
	go func() {
		sentCount := 0
		failedCount := 0

		for i, p := range phoneList {
			if useAntiBan && i > 0 {
				delay := time.Duration(rand.Intn(5)+3) * time.Second
				time.Sleep(delay)
			}

			_ = whatsapp.EnsureConnected(client)

			var sendErr error
			if imageURL != "" {
				sendErr = whatsapp.SendImageFromURL(client, p, imageURL, message)
			} else {
				sendErr = whatsapp.SendMessage(client, p, message)
			}

			logStatus := "sent"
			note := ""
			if sendErr != nil {
				failedCount++
				logStatus = "failed"
				note = sendErr.Error()
			} else {
				sentCount++
				whatsapp.SaveCustomerChatAndPrune(username, p, "assistant", message)
				whatsapp.PushToLiveChat(username, p, message, "outgoing_bulk")
			}

			if DB != nil {
				_, _ = DB.Exec("INSERT INTO campaign_logs (campaign_id, phone, status, note, created_at) VALUES ($1, $2, $3, $4, NOW())",
					campaignID, p, logStatus, note)
				_, _ = DB.Exec("UPDATE campaigns SET sent_count=$1, failed_count=$2 WHERE id=$3",
					sentCount, failedCount, campaignID)
			}
		}

		if DB != nil {
			_, _ = DB.Exec("UPDATE campaigns SET status='completed', end_time=NOW() WHERE id=$1", campaignID)
		}
	}()

	respondJSON(w, 200, map[string]interface{}{
		"status":      "success",
		"campaign_id": campaignID,
		"message":     fmt.Sprintf("Broadcast campaign launched for %d numbers!", len(phoneList)),
		"total":       len(phoneList),
		"queued":      len(phoneList),
	})
}

// BULK CAMPAIGN LOGS & STATUS
func BulkStatusHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	type LogItem struct {
		CampaignID string `json:"campaign_id"`
		Phone      string `json:"phone"`
		Status     string `json:"status"`
		Note       string `json:"note"`
		Time       string `json:"time"`
	}

	var logs []LogItem

	if DB != nil {
		rows, err := DB.Query(`SELECT c.campaign_id, c.phone, c.status, COALESCE(c.note, ''), COALESCE(TO_CHAR(c.created_at, 'DD Mon HH24:MI'), 'Recent')
			FROM campaign_logs c
			JOIN campaigns camp ON camp.id = c.campaign_id
			WHERE LOWER(camp.username)=LOWER($1) AND LENGTH(c.phone) <= 15 AND c.phone NOT LIKE '120363%'
			ORDER BY c.id DESC LIMIT 50`, username)

		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item LogItem
				if err := rows.Scan(&item.CampaignID, &item.Phone, &item.Status, &item.Note, &item.Time); err == nil {
					logs = append(logs, item)
				}
			}
		}
	}

	if logs == nil {
		logs = []LogItem{}
	}

	respondJSON(w, 200, map[string]interface{}{"logs": logs})
}

// TEMPORARY MEDIA UPLOADER FOR BULK BROADCASTS
func BulkUploadTempHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		DataURL  string `json:"data_url"`
		Filename string `json:"filename"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.DataURL == "" {
		respondJSON(w, 400, map[string]string{"status": "error", "message": "No media data URL provided."})
		return
	}

	fn := req.Filename
	if fn == "" {
		fn = "broadcast.jpg"
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":    "success",
		"file_url":  req.DataURL,
		"file_path": fn,
		"message":   "Temporary image loaded for broadcast campaign.",
	})
}
