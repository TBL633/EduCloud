package main

import (
	"log"
	"net/http"
	"os"
	"runtime/debug"

	"wa-server/api"
	"wa-server/database"
	"wa-server/whatsapp"
)

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
	log.Println("🚀 Starting EdutaAI Multi-Tenant SaaS & Marketing Gateway...")

	// Aggressive GC tuning for Render Free Tier (512MB RAM constraint)
	// Triggers GC when heap expands by 20% to keep memory < 25MB
	debug.SetGCPercent(20)

	// 1. Initialize Neon Postgres Database
	database.InitDB()
	api.DB = database.DB

	// 2. Initialize Whatsmeow Multi-Device Store
	dbURL := database.GetDBURL()
	whatsapp.InitStore(dbURL, database.DB)

	// 3. Frontend UI Routes (Multi-file Architecture)
	http.HandleFunc("/admin-portal.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "public/admin-portal.html")
	})
	http.HandleFunc("/business-portal.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "public/business-portal.html")
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		filePath := "public" + r.URL.Path
		if r.URL.Path != "/" {
			if _, err := os.Stat(filePath); err == nil {
				http.ServeFile(w, r, filePath)
				return
			}
		}
		http.ServeFile(w, r, "public/index.html")
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

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("✅ Server listening on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
