package whatsapp

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
)

// GenerateMagicLinkToken generates a secure 24-byte hex token, saves it to magic_links table with 24h expiration,
// and returns the full store URL with the auth_token parameter.
func GenerateMagicLinkToken(tenantID, jid string) (string, string, error) {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tenantID), "@"))
	cleanJID := strings.TrimSpace(jid)
	if cleanJID == "" {
		return "", "", fmt.Errorf("jid is required")
	}

	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", "", fmt.Errorf("crypto rand error: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)
	expiresAt := time.Now().Add(24 * time.Hour)

	storeSlug := cleanUsr
	storeName := "WaMart Store"

	if DB != nil {
		_ = DB.QueryRow(`
			SELECT COALESCE(NULLIF(store_slug, ''), username),
			       COALESCE(NULLIF(business_name, ''), account_name, username)
			FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1
		`, cleanUsr).Scan(&storeSlug, &storeName)

		_, err := DB.Exec(`
			INSERT INTO magic_links (token, jid, tenant_id, expires_at, is_used)
			VALUES ($1, $2, $3, $4, false)
		`, token, cleanJID, cleanUsr, expiresAt)
		if err != nil {
			log.Printf("⚠️ [Magic Link] DB insert note: %v", err)
		}
	}

	baseURL := os.Getenv("APP_URL")
	if baseURL == "" {
		baseURL = os.Getenv("RENDER_EXTERNAL_URL")
	}
	if baseURL == "" {
		baseURL = "https://wamaart.com"
	}
	baseURL = strings.TrimRight(baseURL, "/")

	storeURL := fmt.Sprintf("%s/%s?auth_token=%s", baseURL, storeSlug, token)
	return token, storeURL, nil
}

// ExecuteGenerateStoreLinkHand generates the customer's personalized omnichannel magic link
// and sends it to their WhatsApp chat with an engaging invitation.
func ExecuteGenerateStoreLinkHand(client *whatsmeow.Client, username, customerPhone string) error {
	cleanUsr := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(username), "@"))
	cleanPhone := FormatPhone(customerPhone)
	if cleanPhone == "" {
		return fmt.Errorf("empty customer phone")
	}

	jid := cleanPhone + "@s.whatsapp.net"
	_, storeURL, err := GenerateMagicLinkToken(cleanUsr, jid)
	if err != nil {
		return err
	}

	storeName := "WaMart Store"
	if DB != nil {
		_ = DB.QueryRow(`
			SELECT COALESCE(NULLIF(business_name, ''), account_name, username)
			FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1
		`, cleanUsr).Scan(&storeName)
	}

	msgText := fmt.Sprintf(
		"🛍️ *VISUAL STOREFRONT & ONLINE CATALOG* ✨\n\n"+
			"Namaste! Aap humare store *%s* ka digital catalog website par dekh sakte hain.\n\n"+
			"👉 *Apna Personal Store Kholein:*\n%s\n\n"+
			"✨ *Auto-Login Active:* Is link se aapka cart, WhatsApp profile aur address turant sync ho jayenge! Kripya click karke shopping karein.\n\n"+
			"_Koi bhi sawal ho toh yahan bejheejhak likhein!_ 🙏🚚",
		storeName, storeURL,
	)

	if client != nil && client.IsLoggedIn() {
		err := SendMessage(client, cleanPhone, msgText)
		if err == nil {
			go SaveCustomerChatAndPrune(cleanUsr, cleanPhone, "assistant", msgText)
		}
		return err
	}
	return nil
}
