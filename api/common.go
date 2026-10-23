package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

var DB *sql.DB

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

func cleanUsername(u string) string {
	u = strings.TrimSpace(u)
	u = strings.TrimPrefix(u, "@")
	return strings.ToLower(u)
}
