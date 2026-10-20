# Ultra-Low RAM (512MB VPS) 100+ WhatsApp Account Automation Engine & Lead Alert Forwarding

High-throughput, lightweight Golang `whatsmeow` WhatsApp automation engine with connection pooling and multi-tenant lead alert forwarding to tenant-configured notification numbers.

## User Review & Critical Decisions

> [!IMPORTANT]
> Confirmed Choices from User Clarification & Selection:
> 1. **Lead Generation Alert Dispatch**: The hosted WhatsApp number will directly dispatch generated customer lead details to the tenant's specified Notification Phone Number (`notification_phone`) via WhatsApp message upon lead capture/qualification.
> 2. **512MB VPS Scaling Architecture**: Direct Golang `whatsmeow` protocol client engine with connection pooling, non-blocking goroutine message handlers, and Neon Serverless PostgreSQL persistence.

- **Notification Setup**: Users (Business & Library Partners) can enter their specific **Notification WhatsApp Number** (`notification_phone`) in the Business Workspace settings to instantly receive lead alerts.
- **Data Footprint**: Pure Golang daemon consumes < 15MB base RAM (compared to Node.js/Puppeteer requiring > 150MB per instance), safely scaling 100+ active sessions within 512MB RAM constraints.

---

## 1. Overview & Core Concept

EduCloud provides a multi-tenant WhatsApp AI automation SaaS optimized for Render/VPS Free Tier (512MB RAM limit). When an inbound customer message arrives on any of the 100+ hosted WhatsApp accounts:
1. **24/7 AI Qualification**: The AI Lead Responder (Groq, Gemini, DeepSeek, ChatGPT) engages with the prospect, quotes from the tenant's product/service catalog, and qualifies the lead.
2. **Lead Generation Logging**: The lead is recorded in the Neon PostgreSQL `leads` table and broadcasted live to the dashboard.
3. **Automated Lead Alert Forwarding**: The system immediately dispatches an alert WhatsApp message containing full prospect details (Customer Phone, Inquiry Summary, Status) from the hosted account to the tenant's configured **Notification Phone Number** (`notification_phone`).

---

## 2. User Experience & Visual Design

### Key User Flows
- **Tenant Notification Phone Configuration**: In `business-portal.html`, under AI Responder / Settings, a dedicated input field allows tenants to specify their **Lead Alert Notification Phone** (e.g. `919876543210`).
- **Live Test Lead Alert Dispatch**: Tenants can trigger a test alert button to verify that lead notifications land directly on their notification WhatsApp device.
- **Lead Capture & Notification Flow**:
  1. Customer messages hosted WhatsApp account $\longrightarrow$ 2. AI model replies & qualifies prospect $\longrightarrow$ 3. Lead saved in Neon DB $\longrightarrow$ 4. System sends automated WhatsApp alert to tenant's `notification_phone`.

### Visual Identity & Theme
- **Theme**: Premium Enterprise Dark (`#0f172a` Slate 900 background, Glassmorphism panels, Emerald Green & Cyan accents).
- **Typography**: Display: `Plus Jakarta Sans`, Body: `DM Sans`, Tabular Numerals: `font-mono tabular-nums`.

---

## 3. Key Product Decisions & Trade-Offs

- **Golang `whatsmeow` Protocol Engine**:
  - *Chosen Approach*: Pure Go web-socket binary protocol engine (`whatsmeow`) instead of heavy headless Chromium browser wrappers.
  - *Why*: Go goroutines and `whatsmeow` require ~2-4MB RAM per session, allowing 100+ concurrent WhatsApp sessions on a 512MB RAM server.
- **Direct WhatsApp Alert Dispatch**:
  - *Chosen Approach*: Send lead alert messages directly from the active `whatsmeow` session to the tenant's `notification_phone`.
  - *Why*: Guarantees instant real-time notification on the tenant's primary mobile device without requiring SMS or paid 3rd party gateways.

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       512MB VPS / RENDER GOLANG DAEMON                      │
│                                                                             │
│  ┌──────────────────────┐   WebSocket/Events   ┌─────────────────────────┐  │
│  │  whatsmeow Engine    │ ────────────────────>│  Incoming Msg Ingest    │  │
│  │  (100+ Sessions)     │                      │  (/api/whatsapp/inc)    │  │
│  └──────────────────────┘                      └────────────┬────────────┘  │
│             ▲                                               │               │
│             │ Send Alert                                    │ Generate      │
│             │                                               ▼ Reply         │
│  ┌──────────┴───────────┐                      ┌─────────────────────────┐  │
│  │ Notification Sender  │<─────────────────────│  AI Auto-Responder      │  │
│  │ (To: notification_p) │  Qualified Lead      │  (Groq/Gemini/DeepSeek) │  │
│  └──────────────────────┘                      └────────────┬────────────┘  │
│                                                             │               │
└─────────────────────────────────────────────────────────────┼───────────────┘
                                                              │ Save Lead
                                                              ▼
                                                 ┌─────────────────────────┐
                                                 │ Neon Cloud PostgreSQL   │
                                                 │ (users.notification_p,  │
                                                 │  leads table)           │
                                                 └─────────────────────────┘
```

### Data Model Updates
- **`users` Table & `memoryUsers`**:
  - Add `notification_phone VARCHAR(50)` to store the tenant's alert phone number.
- **`/api/ai/settings` & `/api/whatsapp/incoming`**:
  - Update settings endpoints to save and load `notification_phone`.
  - When an inbound message results in lead capture, if `user.notification_phone` is present, dispatch lead alert message via `/api/send` or `whatsmeow` engine.
