const fs = require("fs");
let content = fs.readFileSync("whatsapp/client.go", "utf8");

// 1. Replace the AI reply delivery block in handleWhatsAppEvents
const oldDelivery = `\t\t\t\tvar deliveredReply string

\t\t\t\t// Format reply with top italic blockquote: > _"customer message"_
\t\t\t\tformattedWhatsAppReply := formatQuotedWhatsAppMessage(msgText, replyText)

\t\t\t\tif imgURL != "" && activeClient != nil && activeClient.IsLoggedIn() {
\t\t\t\t\tsendErr := SendImageFromURL(activeClient, senderPhone, imgURL, formattedWhatsAppReply)
\t\t\t\t\tif sendErr != nil {
\t\t\t\t\t\tlog.Printf("⚠️ Error sending AI image reply to +%s: %v", senderPhone, sendErr)
\t\t\t\t\t} else {
\t\t\t\t\t\tlog.Printf("⚡ AI image reply delivered to +%s", senderPhone)
\t\t\t\t\t}
\t\t\t\t\tdeliveredReply = "[Image Sent] " + formattedWhatsAppReply
\t\t\t\t} else if replyText != "" && activeClient != nil && activeClient.IsLoggedIn() {
\t\t\t\t\tsendErr := SendMessage(activeClient, senderPhone, formattedWhatsAppReply)
\t\t\t\t\tif sendErr != nil {
\t\t\t\t\t\tlog.Printf("⚠️ Error sending AI text reply to +%s: %v", senderPhone, sendErr)
\t\t\t\t\t} else {
\t\t\t\t\t\tlog.Printf("⚡ Ultra-Fast AI reply delivered to +%s: %s", senderPhone, formattedWhatsAppReply)
\t\t\t\t\t}
\t\t\t\t\tdeliveredReply = formattedWhatsAppReply
\t\t\t\t}`;

const newDelivery = `\t\t\t\tvar deliveredReply string

\t\t\t\tif imgURL != "" && activeClient != nil && activeClient.IsLoggedIn() {
\t\t\t\t\tsendErr := SendImageReplyFromURL(activeClient, senderPhone, imgURL, replyText, v.Info.ID, v.Info.Sender, v.Message)
\t\t\t\t\tif sendErr != nil {
\t\t\t\t\t\tlog.Printf("⚠️ Error sending AI image reply to +%s: %v", senderPhone, sendErr)
\t\t\t\t\t} else {
\t\t\t\t\t\tlog.Printf("⚡ AI image reply delivered to +%s (as native WhatsApp reply)", senderPhone)
\t\t\t\t\t}
\t\t\t\t\tdeliveredReply = "[Image Sent] " + replyText
\t\t\t\t} else if replyText != "" && activeClient != nil && activeClient.IsLoggedIn() {
\t\t\t\t\tsendErr := SendReplyMessage(activeClient, senderPhone, replyText, v.Info.ID, v.Info.Sender, v.Message)
\t\t\t\t\tif sendErr != nil {
\t\t\t\t\t\tlog.Printf("⚠️ Error sending AI text reply to +%s: %v", senderPhone, sendErr)
\t\t\t\t\t} else {
\t\t\t\t\t\tlog.Printf("⚡ Ultra-Fast AI reply delivered to +%s (as native WhatsApp reply): %s", senderPhone, replyText)
\t\t\t\t\t}
\t\t\t\t\tdeliveredReply = replyText
\t\t\t\t}`;

if (!content.includes(oldDelivery)) {
    console.error("oldDelivery block not found!");
    process.exit(1);
}
content = content.replace(oldDelivery, newDelivery);

// 2. Add SendReplyMessage and SendImageReplyFromURL
const sendReplyCode = `
// SendReplyMessage sends an AI text reply natively quoting the customer's incoming message in WhatsApp
func SendReplyMessage(client *whatsmeow.Client, phone string, replyText string, quotedID types.MessageID, quotedSender types.JID, quotedMsg *waE2E.Message) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}
	if err := EnsureConnected(client); err != nil {
		return err
	}

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()

	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	var msg *waE2E.Message
	if quotedID != "" && quotedMsg != nil {
		participantJID := quotedSender.ToNonAD().String()
		msg = &waE2E.Message{
			ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text: proto.String(replyText),
				ContextInfo: &waE2E.ContextInfo{
					StanzaID:      proto.String(string(quotedID)),
					Participant:   proto.String(participantJID),
					QuotedMessage: quotedMsg,
				},
			},
		}
	} else {
		msg = &waE2E.Message{Conversation: proto.String(replyText)}
	}

	_, err := client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if targetJID.Server == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}

// SendImageReplyFromURL sends an image with caption natively quoting the customer's incoming message in WhatsApp
func SendImageReplyFromURL(client *whatsmeow.Client, phone, imageURL, caption string, quotedID types.MessageID, quotedSender types.JID, quotedMsg *waE2E.Message) error {
	if client == nil || !client.IsLoggedIn() {
		return fmt.Errorf("whatsapp connected nahi hai")
	}
	cleanPhone := FormatPhone(phone)
	if len(cleanPhone) < 8 {
		return fmt.Errorf("invalid phone number: %s", phone)
	}
	if err := EnsureConnected(client); err != nil {
		return err
	}
	var imgBytes []byte
	var err error
	imageURL = strings.TrimSpace(imageURL)
	if strings.HasPrefix(imageURL, "data:image/") {
		parts := strings.SplitN(imageURL, ",", 2)
		if len(parts) == 2 {
			imgBytes, err = base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return fmt.Errorf("failed to decode base64 image: %v", err)
			}
		}
	} else if strings.HasPrefix(imageURL, "http://") || strings.HasPrefix(imageURL, "https://") {
		clientHttp := &http.Client{Timeout: 20 * time.Second}
		resp, fetchErr := clientHttp.Get(imageURL)
		if fetchErr != nil {
			return fmt.Errorf("image download failed: %v", fetchErr)
		}
		defer resp.Body.Close()
		imgBytes, err = io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
	} else {
		return fmt.Errorf("unsupported image format or empty URL")
	}
	if len(imgBytes) == 0 {
		return fmt.Errorf("empty image payload")
	}
	uploaded, err := client.Upload(context.Background(), imgBytes, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("whatsapp media upload failed: %v", err)
	}
	mimeType := http.DetectContentType(imgBytes)

	lidCacheLock.RLock()
	targetJID, hasTargetJID := phoneToJID[cleanPhone]
	if !hasTargetJID {
		targetJID, hasTargetJID = phoneToJID[phone]
	}
	lidCacheLock.RUnlock()
	primaryServer := types.DefaultUserServer
	if !hasTargetJID {
		if strings.HasPrefix(cleanPhone, "117") || strings.HasPrefix(cleanPhone, "223") || strings.HasPrefix(cleanPhone, "100") {
			primaryServer = "lid"
		}
		targetJID = types.NewJID(cleanPhone, primaryServer)
	}

	imageMsg := &waE2E.ImageMessage{
		Caption:       proto.String(caption),
		URL:           proto.String(uploaded.URL),
		DirectPath:    proto.String(uploaded.DirectPath),
		MediaKey:      uploaded.MediaKey,
		Mimetype:      proto.String(mimeType),
		FileEncSHA256: uploaded.FileEncSHA256,
		FileSHA256:    uploaded.FileSHA256,
		FileLength:    proto.Uint64(uint64(len(imgBytes))),
	}
	if quotedID != "" && quotedMsg != nil {
		imageMsg.ContextInfo = &waE2E.ContextInfo{
			StanzaID:      proto.String(string(quotedID)),
			Participant:   proto.String(quotedSender.ToNonAD().String()),
			QuotedMessage: quotedMsg,
		}
	}

	msg := &waE2E.Message{ImageMessage: imageMsg}
	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil && (strings.Contains(err.Error(), "no LID found") || strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid recipient")) {
		altServer := "lid"
		if primaryServer == "lid" {
			altServer = types.DefaultUserServer
		}
		targetJID = types.NewJID(cleanPhone, altServer)
		_, err = client.SendMessage(context.Background(), targetJID, msg)
	}
	return err
}
`;

// Insert SendReplyMessage and SendImageReplyFromURL before SendMessage
const sendMarker = "// 1. Text Message Bhejna (Supports both Standard PN and LID JIDs with fallback)";
if (!content.includes(sendMarker)) {
    console.error("sendMarker not found!");
    process.exit(1);
}
content = content.replace(sendMarker, sendReplyCode + "\n" + sendMarker);

fs.writeFileSync("whatsapp/client.go", content, "utf8");
console.log("Successfully updated whatsapp/client.go with native reply functions and handlers!");
