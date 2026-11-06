package main

import (
	"embed"
	"log"
	"net/http"
	"os"
	"path"
	"runtime/debug"
	"strings"

	"wa-server/api"
	"wa-server/database"
	"wa-server/payment"
	"wa-server/whatsapp"
)

//go:embed public
var embeddedFS embed.FS

func serveStaticFile(w http.ResponseWriter, r *http.Request, fileName string) {
	cleanName := strings.TrimPrefix(fileName, "/")
	if cleanName == "" {
		cleanName = "index.html"
	}

	// 1. Try disk file first (for active local development)
	diskPath := path.Join("public", cleanName)
	if fi, err := os.Stat(diskPath); err == nil && !fi.IsDir() {
		http.ServeFile(w, r, diskPath)
		return
	}

	// 2. Try embedded filesystem (compiled directly into the binary for 100% reliable Render deployment)
	embedPath := "public/" + cleanName
	data, err := embeddedFS.ReadFile(embedPath)
	if err == nil {
		contentType := "text/html; charset=utf-8"
		ext := strings.ToLower(path.Ext(cleanName))
		switch ext {
		case ".css":
			contentType = "text/css; charset=utf-8"
		case ".js":
			contentType = "application/javascript; charset=utf-8"
		case ".json":
			contentType = "application/json; charset=utf-8"
		case ".png":
			contentType = "image/png"
		case ".jpg", ".jpeg":
			contentType = "image/jpeg"
		case ".svg":
			contentType = "image/svg+xml"
		case ".ico":
			contentType = "image/x-icon"
		case ".webp":
			contentType = "image/webp"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		w.Write(data)
		return
	}

	// 3. Fallback to embedded index.html
	indexData, err := embeddedFS.ReadFile("public/index.html")
	if err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		w.Write(indexData)
		return
	}

	http.NotFound(w, r)
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func main() {
	log.Println("🚀 Starting WaMart Multi-Tenant SaaS & Marketing Gateway...")

	// Aggressive GC tuning for Render Free Tier (512MB RAM constraint)
	// Triggers GC when heap expands by 20% to keep memory < 25MB
	debug.SetGCPercent(20)

	// 1. Initialize Neon Postgres Database
	database.InitDB()
	api.DB = database.DB
	payment.InitPaymentModule(database.DB)
	payment.SetPaymentVerifiedCallback(func(tenantID, orderID, amount, txnID string) {
		whatsapp.TriggerConfirmedPaymentLead(tenantID, "", orderID, amount, txnID)
	})

	// 2. Initialize Whatsmeow Multi-Device Store
	dbURL := database.GetDBURL()
	whatsapp.InitStore(dbURL, database.DB)
	whatsapp.AutoConnectAllSessions()
	whatsapp.StartKeepAliveMonitor()

	// 3. Frontend UI Routes (Multi-file Architecture & Clean URLs)
	adminHandler := func(w http.ResponseWriter, r *http.Request) {
		serveStaticFile(w, r, "admin-portal.html")
	}
	http.HandleFunc("/admin", adminHandler)
	http.HandleFunc("/admin-portal", adminHandler)
	http.HandleFunc("/admin-portal.html", adminHandler)

	businessHandler := func(w http.ResponseWriter, r *http.Request) {
		serveStaticFile(w, r, "business-portal.html")
	}
	http.HandleFunc("/business", businessHandler)
	http.HandleFunc("/business-portal", businessHandler)
	http.HandleFunc("/business-portal.html", businessHandler)
	http.HandleFunc("/dashboard", businessHandler)

	http.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		serveStaticFile(w, r, "index.html")
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reqPath := strings.TrimPrefix(r.URL.Path, "/")
		if reqPath == "" || reqPath == "index.html" {
			serveStaticFile(w, r, "index.html")
			return
		}
		serveStaticFile(w, r, reqPath)
	})

	// 4. API Routes
	http.HandleFunc("/api/db-status", corsMiddleware(api.DBStatusHandler))
	http.HandleFunc("/api/login", corsMiddleware(api.LoginHandler))
	http.HandleFunc("/api/auth/send-otp", corsMiddleware(api.SendOTPHandler))
	http.HandleFunc("/api/auth/verify-otp", corsMiddleware(api.VerifyOTPHandler))
	http.HandleFunc("/api/create-account", corsMiddleware(api.VerifyOTPHandler))

	// WhatsApp Web Session & Pairing Endpoints
	http.HandleFunc("/api/whatsapp/qr", corsMiddleware(api.StatusHandler))
	http.HandleFunc("/api/whatsapp/status", corsMiddleware(api.StatusHandler))
	http.HandleFunc("/api/status", corsMiddleware(api.StatusHandler))

	http.HandleFunc("/api/whatsapp/pair", corsMiddleware(api.PairPhoneHandler))
	http.HandleFunc("/api/pair", corsMiddleware(api.PairPhoneHandler))

	http.HandleFunc("/api/whatsapp/logout", corsMiddleware(api.LogoutWAHandler))
	http.HandleFunc("/api/whatsapp/unpair", corsMiddleware(api.LogoutWAHandler))
	http.HandleFunc("/api/whatsapp/unlink", corsMiddleware(api.LogoutWAHandler))
	http.HandleFunc("/api/whatsapp/disconnect", corsMiddleware(api.LogoutWAHandler))
	http.HandleFunc("/api/logout-wa", corsMiddleware(api.LogoutWAHandler))

	http.HandleFunc("/api/send", corsMiddleware(api.SendHandler))
	http.HandleFunc("/api/bulk", corsMiddleware(api.BulkSendHandler))
	http.HandleFunc("/api/bulk/send", corsMiddleware(api.BulkSendHandler))
	http.HandleFunc("/api/bulk/status", corsMiddleware(api.BulkStatusHandler))
	http.HandleFunc("/api/bulk/upload-temp", corsMiddleware(api.BulkUploadTempHandler))

	// AI Responder Endpoints & Interactive Testing
	http.HandleFunc("/api/ai/settings", corsMiddleware(api.AISettingsHandler))
	http.HandleFunc("/api/ai/test", corsMiddleware(api.AITestHandler))
	http.HandleFunc("/api/ai/test-lead-alert", corsMiddleware(api.TestLeadAlertHandler))

	// Real-Time Customer Chat Endpoints (Zero-DB Taxing via SSE + Sliding Window)
	http.HandleFunc("/api/chats", corsMiddleware(api.ChatsHandler))
	http.HandleFunc("/api/chats/messages", corsMiddleware(api.ChatMessagesHandler))
	http.HandleFunc("/api/chats/send", corsMiddleware(api.ChatSendHandler))
	http.HandleFunc("/api/chat/stream", api.LiveChatSSEHandler)

	http.HandleFunc("/api/media", corsMiddleware(api.MediaCatalogHandler))

	// Business Workspace Endpoints (Zero Fake Data)
	http.HandleFunc("/api/categories", corsMiddleware(api.CategoriesHandler))
	http.HandleFunc("/api/products", corsMiddleware(api.ProductsHandler))
	http.HandleFunc("/api/business/dashboard", corsMiddleware(api.BusinessDashboardHandler))
	http.HandleFunc("/api/leads", corsMiddleware(api.LeadsHandler))
	http.HandleFunc("/api/user/config", corsMiddleware(api.UserConfigHandler))

	// User Profile & Security Endpoints
	http.HandleFunc("/api/user/profile", corsMiddleware(api.UserProfileHandler))
	http.HandleFunc("/api/user/verify-password", corsMiddleware(api.VerifyPasswordHandler))
	http.HandleFunc("/api/user/change-password", corsMiddleware(api.UpdatePasswordHandler))
	http.HandleFunc("/api/user/update-password", corsMiddleware(api.UpdatePasswordHandler))

	// 5. Admin Multi-Account Routes
	http.HandleFunc("/api/admin/dashboard", corsMiddleware(api.AdminDashboardHandler))
	http.HandleFunc("/api/admin/users", corsMiddleware(api.ListUsersHandler))
	http.HandleFunc("/api/admin/create-user", corsMiddleware(api.CreateUserHandler))
	http.HandleFunc("/api/admin/delete-user", corsMiddleware(api.DeleteUserHandler))
	http.HandleFunc("/api/admin/toggle-automation", corsMiddleware(api.ToggleAutomationHandler))
	http.HandleFunc("/api/admin/newsletters", corsMiddleware(api.GetNewslettersHandler))
	http.HandleFunc("/api/admin/channel-forwarder", corsMiddleware(api.AdminChannelForwarderHandler))
	http.HandleFunc("/api/whatsapp/newsletters", corsMiddleware(api.GetNewslettersHandler))
	http.HandleFunc("/api/whatsapp/channel-forwarder", corsMiddleware(api.AdminChannelForwarderHandler))

	// Zero-Fee Paytm Payment Gateway Routes & Cloudflare Worker Webhook
	http.HandleFunc("/api/payment/config", corsMiddleware(payment.ConfigHandler))
	http.HandleFunc("/api/admin/tenant/payment-config", corsMiddleware(payment.ConfigHandler))
	http.HandleFunc("/api/payment/generate-qr", corsMiddleware(payment.GenerateQRHandler))
	http.HandleFunc("/api/payment/verify", corsMiddleware(payment.VerifyHandler))
	http.HandleFunc("/webhook/payment", corsMiddleware(payment.PaymentWebhookHandler))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("✅ Server listening on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
