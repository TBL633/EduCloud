package main

import (
	"log"
	"net/http"
	"os"

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

	// 1. Initialize Neon Postgres Database
	database.InitDB()
	api.DB = database.DB

	// 2. Initialize Whatsmeow Multi-Device Store
	dbURL := os.Getenv("DATABASE_URL")
	whatsapp.InitStore(dbURL, database.DB)

	// 3. Frontend UI Routes (Multi-file Architecture)
	http.HandleFunc("/admin-portal.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "public/admin-portal.html")
	})
	http.HandleFunc("/business-portal.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "public/business-portal.html")
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "public/index.html")
	})

	// 4. API Routes
	http.HandleFunc("/api/login", corsMiddleware(api.LoginHandler))
	http.HandleFunc("/api/status", corsMiddleware(api.StatusHandler))
	http.HandleFunc("/api/pair", corsMiddleware(api.PairPhoneHandler))
	http.HandleFunc("/api/logout-wa", corsMiddleware(api.LogoutWAHandler))
	http.HandleFunc("/api/send", corsMiddleware(api.SendHandler))
	http.HandleFunc("/api/bulk", corsMiddleware(api.BulkSendHandler))
	http.HandleFunc("/api/ai/settings", corsMiddleware(api.SaveAISettingsHandler))
	http.HandleFunc("/api/media", corsMiddleware(api.MediaCatalogHandler))
	http.HandleFunc("/api/chat/stream", api.LiveChatSSEHandler)

	// Neon Object Database & Storage Routes
	http.HandleFunc("/api/storage/neon/upload", corsMiddleware(api.UploadNeonMediaHandler))
	http.HandleFunc("/api/storage/neon/file/", corsMiddleware(api.ServeNeonMediaHandler))

	// Business Workspace Endpoints (Zero Fake Data)
	http.HandleFunc("/api/products", corsMiddleware(api.ProductsHandler))
	http.HandleFunc("/api/business/dashboard", corsMiddleware(api.BusinessDashboardHandler))
	http.HandleFunc("/api/leads", corsMiddleware(api.LeadsHandler))
	http.HandleFunc("/api/user/config", corsMiddleware(api.UserConfigHandler))

	// 5. Admin Multi-Account Routes
	http.HandleFunc("/api/admin/users", corsMiddleware(api.ListUsersHandler))
	http.HandleFunc("/api/admin/create-user", corsMiddleware(api.CreateUserHandler))
	http.HandleFunc("/api/admin/delete-user", corsMiddleware(api.DeleteUserHandler))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("✅ Server listening on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
