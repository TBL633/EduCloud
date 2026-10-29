package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"go.mau.fi/whatsmeow"
	"wa-server/whatsapp"
)

// WHATSAPP STATUS & QR GENERATOR PER USER
func StatusHandler(w http.ResponseWriter, r *http.Request) {
	username := cleanUsername(r.URL.Query().Get("username"))
	if username == "" {
		username = "admin"
	}

	var savedJID, savedStatus string
	if DB != nil {
		_ = DB.QueryRow("SELECT COALESCE(wa_jid, ''), COALESCE(status, 'Disconnected') FROM users WHERE LOWER(username)=LOWER($1)", username).Scan(&savedJID, &savedStatus)
	}

	status := "Disconnected"
	jid := ""

	client := whatsapp.GetOrCreateClient(username)
	if client != nil && client.Store.ID != nil && client.IsLoggedIn() {
		status = "Connected"
		jid = client.Store.ID.User
		if jid == "" {
			jid = savedJID
		}
		// Self-heal Neon DB if DB row was wiped, dropped or out of sync!
		if DB != nil {
			upsertQuery := `
				INSERT INTO users (username, email, password, role, user_type, account_name, wa_jid, phone, status, linked_at, created_at)
				VALUES ($1::VARCHAR, $1::VARCHAR || '@gmail.com', 'pass123', 'user', 'business_user', $1::VARCHAR || ' Account', $2::VARCHAR, $2::VARCHAR, 'Connected', NOW(), NOW())
				ON CONFLICT (username) DO UPDATE SET
					wa_jid = EXCLUDED.wa_jid,
					phone = COALESCE(NULLIF(users.phone, ''), EXCLUDED.phone),
					status = 'Connected',
					linked_at = COALESCE(users.linked_at, NOW());
			`
			_, _ = DB.Exec(upsertQuery, username, jid)
			_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=COALESCE(NULLIF(phone, ''), $1), status='Connected', linked_at=NOW() WHERE LOWER(username)=LOWER($2) OR LOWER(email)=LOWER($2)", jid, username)
		}
	} else if savedJID != "" && savedStatus == "Connected" {
		status = "Connected"
		jid = savedJID
	}

	qrCode := ""
	if status != "Connected" {
		qrCode = whatsapp.QRChannelMap[username]
		if qrCode == "" {
			qrCode = whatsapp.GetOrGenerateQR(username)
		}
		if qrCode != "" {
			status = "QR_Ready"
		}
	}

	endpoint := "https://" + r.Host + "/api/send"
	respondJSON(w, 200, map[string]interface{}{
		"status":    status,
		"qr":        qrCode,
		"jid":       jid,
		"connected": status == "Connected",
		"endpoint":  endpoint,
		"username":  username,
	})
}

// PHONE PAIRING CODE API (8-DIGIT PAIRING CODE)
func PairPhoneHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Phone    string `json:"phone"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	req.Username = cleanUsername(req.Username)
	if req.Username == "" {
		req.Username = "admin"
	}

	cleanPhone := whatsapp.FormatPhone(req.Phone)
	if cleanPhone == "" {
		respondJSON(w, 400, map[string]string{
			"status":  "error",
			"message": "Phone number is required",
		})
		return
	}

	client := whatsapp.GetOrCreateClient(req.Username)
	if client == nil {
		respondJSON(w, 503, map[string]string{
			"status":  "error",
			"message": "WhatsMeow client not initialized. Ensure database and WhatsApp store are connected.",
		})
		return
	}

	// Ensure client is connected to WhatsApp WebSocket before calling PairPhone
	if !client.IsConnected() {
		_ = client.Connect()
		for i := 0; i < 25; i++ {
			if client.IsConnected() {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	code, err := client.PairPhone(context.Background(), cleanPhone, true, whatsmeow.PairClientChrome, "Chrome (Windows)")
	if err != nil {
		log.Printf("⚠️ [Pair Error for %s]: %v", req.Username, err)
		respondJSON(w, 500, map[string]string{"status": "error", "message": "Failed to generate pairing code: " + err.Error()})
		return
	}

	if DB != nil {
		_, _ = DB.Exec("UPDATE users SET wa_jid=$1, phone=$1, status='Connected', linked_at=NOW() WHERE LOWER(username)=LOWER($2)", cleanPhone, req.Username)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status":  "success",
		"code":    code,
		"phone":   cleanPhone,
		"message": "Pairing code generated! Enter this code in WhatsApp -> Linked Devices -> Link with phone number.",
	})
}

// LOGOUT / UNPAIR WHATSAPP DEVICE
func LogoutWAHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Username == "" {
		req.Username = r.URL.Query().Get("username")
	}
	if req.Username == "" {
		req.Username = "admin"
	}
	req.Username = cleanUsername(req.Username)

	// Cleanly disconnect, logout, and erase device session
	whatsapp.DisconnectAndUnlinkClient(req.Username)

	if DB != nil {
		_, _ = DB.Exec("UPDATE users SET wa_jid='', phone='', status='Disconnected', qr='', linked_at=NULL WHERE LOWER(username)=LOWER($1)", req.Username)
	}

	whatsapp.PushToLiveChat(req.Username, "", "WhatsApp session unlinked from phone", "session_unlinked")

	respondJSON(w, 200, map[string]string{"status": "success", "message": "WhatsApp unlinked successfully. WhatsApp details cleared from database, user account preserved."})
}
