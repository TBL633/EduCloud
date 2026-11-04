package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
)

func main() {
	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	http.ServeFile(w, req, "public/index.html")
	fmt.Println("Status:", w.Code, "Location:", w.Header().Get("Location"), "BodyLen:", w.Body.Len())
}
