package whatsapp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// ChatMessage structure for Sliding Window
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var (
	// Key: "username_customerPhone" -> Value: Last 10 Messages
	chatMemory = make(map[string][]ChatMessage)
	memoryLock sync.Mutex

	// Round-Robin API Key rotation index per username
	keyRotationIndex = make(map[string]int)
	keyRotationLock  sync.Mutex
)

// Helper to select API key in Round-Robin fashion if multiple keys exist
func getRotatedAPIKey(username, rawKeys string) string {
	rawKeys = strings.TrimSpace(rawKeys)
	if rawKeys == "" {
		return ""
	}
	re := regexp.MustCompile(`[\n,\s]+`)
	tokens := re.Split(rawKeys, -1)
	var validKeys []string
	for _, t := range tokens {
		t = strings.TrimSpace(t)
		if t != "" {
			validKeys = append(validKeys, t)
		}
	}
	if len(validKeys) == 0 {
		return ""
	}
	if len(validKeys) == 1 {
		return validKeys[0]
	}

	keyRotationLock.Lock()
	defer keyRotationLock.Unlock()

	idx := keyRotationIndex[username]
	selectedKey := validKeys[idx%len(validKeys)]
	keyRotationIndex[username] = (idx + 1) % len(validKeys)

	fmt.Printf("🔄 [Go Engine] User @%s rotated to API key #%d of %d\n", username, (idx%len(validKeys))+1, len(validKeys))
	return selectedKey
}

// 1. Sliding Window Manager (Max 10 messages per customer)
func updateSlidingWindow(sessionKey string, role string, text string) []ChatMessage {
	memoryLock.Lock()
	defer memoryLock.Unlock()

	history := chatMemory[sessionKey]
	history = append(history, ChatMessage{Role: role, Content: text})

	// Sirf aakhiri 10 messages rakho taaki RAM aur AI tokens bachein
	if len(history) > 10 {
		history = history[len(history)-10:]
	}
	chatMemory[sessionKey] = history
	return history
}

// 2. Main AI Auto-Reply Generator
func GenerateAIReply(username, customerPhone, incomingText, provider, apiKey, systemPrompt string) (string, string) {
	selectedApiKey := getRotatedAPIKey(username, apiKey)
	if selectedApiKey == "" {
		return "", ""
	}

	sessionKey := username + "_" + customerPhone
	history := updateSlidingWindow(sessionKey, "user", incomingText)

	// Prepare messages with System Prompt
	var messages []ChatMessage
	fullPrompt := systemPrompt + "\nNote: If you need to send a product image URL from your instructions, include it as [IMAGE: https://url-here] at the end of your reply."
	messages = append(messages, ChatMessage{Role: "system", Content: fullPrompt})
	messages = append(messages, history...)

	var aiResponse string
	var err error

	if provider == "gemini" {
		aiResponse, err = callGeminiAPI(selectedApiKey, fullPrompt, incomingText)
	} else {
		// Groq, OpenAI, DeepSeek, OpenRouter sab OpenAI format use karte hain
		aiResponse, err = callOpenAICompatible(provider, selectedApiKey, messages)
	}

	if err != nil || aiResponse == "" {
		return "", ""
	}

	// Sliding window me AI ka reply bhi save karo
	updateSlidingWindow(sessionKey, "assistant", aiResponse)

	// Check karo agar AI ne koi [IMAGE: url] bheja hai
	imageURL := ""
	re := regexp.MustCompile(`\[IMAGE:\s*(https?://[^\]]+)\]`)
	matches := re.FindStringSubmatch(aiResponse)
	if len(matches) > 1 {
		imageURL = strings.TrimSpace(matches[1])
		aiResponse = strings.TrimSpace(re.ReplaceAllString(aiResponse, ""))
	}

	// Dynamic AI Tag replacement: Map <IMG_1>, <IMG_2> to Neon DB product image URL
	tagRe := regexp.MustCompile(`<IMG_(\d+)>`)
	tagMatches := tagRe.FindStringSubmatch(aiResponse)
	if len(tagMatches) > 0 && DB != nil && imageURL == "" {
		tag := tagMatches[0]
		var foundImg string
		_ = DB.QueryRow("SELECT image_url FROM products WHERE username=$1 AND ai_tag=$2 LIMIT 1", username, tag).Scan(&foundImg)
		if foundImg != "" {
			imageURL = foundImg
		}
	}

	return aiResponse, imageURL
}

func callOpenAICompatible(provider, apiKey string, messages []ChatMessage) (string, error) {
	url := "https://api.groq.com/openai/v1/chat/completions"
	model := "llama-3.3-70b-versatile"

	switch provider {
	case "openai":
		url = "https://api.openai.com/v1/chat/completions"
		model = "gpt-4o-mini"
	case "deepseek":
		url = "https://api.deepseek.com/chat/completions"
		model = "deepseek-chat"
	case "openrouter":
		url = "https://openrouter.ai/api/v1/chat/completions"
		model = "meta-llama/llama-3.1-8b-instruct:free"
	}

	payload := map[string]interface{}{
		"model":    model,
		"messages": messages,
	}
	body, _ := json.Marshal(payload)

	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	json.Unmarshal(respBytes, &result)
	if len(result.Choices) > 0 {
		return result.Choices[0].Message.Content, nil
	}
	return "", fmt.Errorf("empty ai response")
}

func callGeminiAPI(apiKey, sysPrompt, userText string) (string, error) {
	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey
	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{"parts": []map[string]string{{"text": sysPrompt + "\n\nCustomer: " + userText}}},
		},
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(url, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	json.Unmarshal(respBytes, &result)
	if len(result.Candidates) > 0 && len(result.Candidates[0].Content.Parts) > 0 {
		return result.Candidates[0].Content.Parts[0].Text, nil
	}
	return "", fmt.Errorf("gemini empty response")
}
