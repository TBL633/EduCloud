package whatsapp

import (
	"strings"
	"testing"
)

func TestParseOctopusAIResponse_ValidJSON(t *testing.T) {
	input := `{"ai_reply_text": "Namaste! Aapka swagat hai 🙏", "actions": []}`
	res, err := ParseOctopusAIResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.AIReplyText != "Namaste! Aapka swagat hai 🙏" {
		t.Errorf("expected reply text 'Namaste! Aapka swagat hai 🙏', got: '%s'", res.AIReplyText)
	}
}

func TestParseOctopusAIResponse_MarkdownCodeBlock(t *testing.T) {
	input := "```json\n{\n  \"ai_reply_text\": \"Order cancelled!\",\n  \"actions\": [{\"hand\": \"cancel_order\"}]\n}\n```"
	res, err := ParseOctopusAIResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.AIReplyText != "Order cancelled!" {
		t.Errorf("expected 'Order cancelled!', got '%s'", res.AIReplyText)
	}
	if len(res.Actions) != 1 || res.Actions[0].Hand != "cancel_order" {
		t.Errorf("expected 1 cancel_order action, got: %+v", res.Actions)
	}
}

func TestParseOctopusAIResponse_PreambleAndPostamble(t *testing.T) {
	input := "Here is your response:\n```json\n{\"ai_reply_text\": \"All good!\", \"actions\": []}\n```\nHope that helps!"
	res, err := ParseOctopusAIResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.AIReplyText != "All good!" {
		t.Errorf("expected 'All good!', got '%s'", res.AIReplyText)
	}
}

func TestParseOctopusAIResponse_PseudoFormattedText(t *testing.T) {
	// Tests AI returning pseudo-formatted text with *ai_reply_text*: and *actions*: []
	input := "*ai_reply_text*: Hello! How can I help you today?\n*actions*: []"
	res, _ := ParseOctopusAIResponse(input)
	if res.AIReplyText != "Hello! How can I help you today?" {
		t.Errorf("expected extracted reply without actions, got: '%s'", res.AIReplyText)
	}
	if strings.Contains(res.AIReplyText, "actions") || strings.Contains(res.AIReplyText, "*ai_reply_text*:") {
		t.Errorf("leaked actions or asterisks in reply: '%s'", res.AIReplyText)
	}
}

func TestParseOctopusAIResponse_CompletelyBrokenText(t *testing.T) {
	input := "gibberish 12345 !@#$%^&*()"
	res, err := ParseOctopusAIResponse(input)
	if err == nil {
		t.Logf("Expected parsing error for unparseable input: %v", err)
	}
	if res.AIReplyText != SafeAIFallbackReply {
		t.Errorf("expected fallback reply '%s', got '%s'", SafeAIFallbackReply, res.AIReplyText)
	}
}

func TestParseOctopusAIResponse_EmptyAIReplyText(t *testing.T) {
	input := `{"ai_reply_text": "", "actions": []}`
	res, err := ParseOctopusAIResponse(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.AIReplyText != SafeAIFallbackReply {
		t.Errorf("expected fallback reply for empty reply text, got '%s'", res.AIReplyText)
	}
}

func TestSanitizeAIReplyText(t *testing.T) {
	raw := "*ai_reply_text*: \"Namaste! Aapka order confirm ho gaya hai.\" *actions*: [{\"hand\": \"none\"}]"
	clean := SanitizeAIReplyText(raw)
	if clean != "Namaste! Aapka order confirm ho gaya hai." {
		t.Errorf("expected cleaned text without actions or asterisks, got: '%s'", clean)
	}
}

func TestParseOctopusAIResponse_ExactScreenshotCase(t *testing.T) {
	input := `*ai_reply_text*:
ज़रूर! 🍕 नीचे पिज़्ज़ा कैटेगरी की तस्वीरें भेज रहा हूँ। यदि आपको किसी विशेष पिज़्ज़ा की जानकारी या ऑर्डर करना हो तो बताइए। 🙏

*actions*: [
  {
    "hand": "send_catalog_images",
    "payload": {
      "category": "Pizza"
    }
  }
]`
	res, err := ParseOctopusAIResponse(input)
	if err != nil {
		t.Fatalf("unexpected error parsing screenshot output: %v", err)
	}
	expectedText := "ज़रूर! 🍕 नीचे पिज़्ज़ा कैटेगरी की तस्वीरें भेज रहा हूँ। यदि आपको किसी विशेष पिज़्ज़ा की जानकारी या ऑर्डर करना हो तो बताइए। 🙏"
	if res.AIReplyText != expectedText {
		t.Errorf("expected clean reply text '%s', got: '%s'", expectedText, res.AIReplyText)
	}
	if strings.Contains(res.AIReplyText, "*ai_reply_text*:") || strings.Contains(res.AIReplyText, "actions") {
		t.Errorf("leaked debris in reply text: '%s'", res.AIReplyText)
	}
	if len(res.Actions) != 1 {
		t.Fatalf("expected exactly 1 action extracted, got %d", len(res.Actions))
	}
	if res.Actions[0].Hand != "send_catalog_images" {
		t.Errorf("expected hand 'send_catalog_images', got: '%s'", res.Actions[0].Hand)
	}
	if res.Actions[0].Payload == nil || res.Actions[0].Payload.Category != "Pizza" {
		t.Errorf("expected category 'Pizza', got: %+v", res.Actions[0].Payload)
	}
}

