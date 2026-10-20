# EdutaAI Multi-Tenant WhatsApp Marketing & Automation Platform

Comprehensive architecture plan to restore the Golang + `whatsmeow` microservice files for Render/production deployment, while maintaining the active Node.js gateway on port 3000 for instant interactive preview in AI Studio, with Neon PostgreSQL persistence and AI lead-gen bots.

## User Review & Critical Decisions

> [!IMPORTANT]
> The original Go + `whatsmeow` source code has been reconstructed and will be fully restored into the repository (`main.go`, `go.mod`, `api/handlers.go`, `database/db.go`, `whatsapp/client.go`, `whatsapp/ai.go`, `render.yaml`) so your Render deployment and architecture are 100% preserved. Simultaneously, the Node.js server (`server.ts`) will continue running on port 3000 to keep the AI Studio live preview dashboard fully interactive and responsive.

- **Dual Architecture Strategy**: 
  - **Production/Render**: Direct Golang executable with `whatsmeow` connecting directly to WhatsApp Multi-Device WebSockets, using Neon PostgreSQL.
  - **AI Studio Preview**: Node.js Express server running on port 3000 (`0.0.0.0`) providing zero-latency live preview, Server-Sent Events (SSE) live chat, bulk sender simulation with anti-ban delay, and real AI auto-reply via Google Gemini.
- **Database Persistence**: Hybrid driver supporting real Neon PostgreSQL via `DATABASE_URL` when provided, with seamless in-memory fallback for local sandboxed environments.

---

## 1. Overview & Core Concept

**EdutaAI** is a multi-tenant WhatsApp marketing, automation, and AI gateway designed for educational institutions, libraries, and SaaS businesses.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        EdutaAI Cloud Dashboard                         │
│   (Device Link · Live Chat SSE · Bulk Sender · Catalog · AI Bot)      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
           ┌────────────────────────┴────────────────────────┐
           ▼                                                 ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│  AI Studio Preview Gateway   │              │   Render Production Engine   │
│   (Node.js Express Server)   │              │    (Golang + whatsmeow)      │
│  - Port 3000 / SSE Streams   │              │  - Native Multi-Device WA    │
│  - Gemini AI Auto-Reply      │              │  - Direct WA WebSockets      │
│  - Anti-Ban Bulk Engine      │              │  - Render Web Service        │
└──────────────┬───────────────┘              └──────────────┬───────────────┘
               │                                             │
               └──────────────────────┬──────────────────────┘
                                      ▼
                        ┌───────────────────────────┐
                        │ Neon Serverless Postgres  │
                        │  (Users & Media Catalog)  │
                        └───────────────────────────┘
```

- **Target Audience**: Library owners, coaching institutes, educational organizations, and marketing agencies.
- **Key Value**: Low server footprint (runs on 512MB RAM), zero-load client-side live chat via SSE, humanized anti-ban bulk campaigns, and context-aware AI chatbot responses with automatic product image injection.

---

## 2. User Experience & Dashboard Workflow

### Key User Flows
1. **Master Admin Authentication**:
   - Admin logs into workspace using credentials (`admin / admin123`).
   - Navigates to **Admin: Manage Users** to provision unique client accounts (e.g., `lib_kanpur_1`).
   - Ability to switch the active instance directly from the sidebar or user table to manage any client's WhatsApp session.
2. **Device Connection & QR / Pair Code**:
   - Method 1: Scan real-time generated WhatsApp QR Code on the device.
   - Method 2: Request 8-digit phone pairing code (`XXXX-XXXX`) without camera scanning.
   - Real-time status badge indicates connection state (`Connected`, `QR Ready`, or `Disconnected`).
3. **Client-Side Live Chat (Zero Server Load)**:
   - Server pushes incoming customer inquiries via Server-Sent Events (SSE).
   - Chat history resides in browser local storage to eliminate server RAM and database bloat.
   - Real-time manual reply box and instant customer inbound simulation to test AI replies.
4. **Anti-Ban Bulk Campaign Sender**:
   - Target phone numbers input (one per line, with country code).
   - Campaign message text with optional product image URL from Neon Object Storage.
   - Smart Anti-Ban mode inserts randomized human-like delays (3 to 8 seconds) between dispatches.
5. **AI Lead-Gen & Auto-Reply Bot**:
   - Choice of AI provider: Google Gemini (Gemini 1.5 Flash), Groq (Llama-3.3-70B), OpenAI, DeepSeek, or OpenRouter.
   - 10-message sliding window in memory prevents context loss while preserving token economy.
   - Automatic detection of `[IMAGE: https://...]` tags to deliver product images to customers.
6. **Product Image Catalog**:
   - Manage and store public image URLs (Neon Storage or CDN).
   - 1-click "Copy AI Tag" or "Use in Bulk Campaign" shortcuts.

### Visual Design & Styling
- **Aesthetic Direction**: High-density professional SaaS control panel in dark slate and crisp white.
- **Typography**: Plus Jakarta Sans for clean typography, paired with monospace tabular numerals for timestamps, phone numbers, and pairing codes.
- **Feedback & Notifications**: Non-blocking toast alerts replacing native browser alert boxes for sandboxed iframe compatibility.

---

## 3. Key Architectural Decisions & Implementation Steps

### Step 1: Restore Complete Go Backend for Production
Restore all original Go files with exact business logic, package imports, and Render deployment specification:
- `/go.mod`: Module definition with `go.mau.fi/whatsmeow`, `lib/pq`, `golang.org/x/crypto/bcrypt`.
- `/main.go`: HTTP server entry point with CORS middleware, Neon DB init, whatsmeow store init, and API routing.
- `/database/db.go`: Neon PostgreSQL initialization, table migrations (`users`, `user_media`), and default admin seeding.
- `/whatsapp/client.go`: Multi-tenant whatsmeow client manager, event handler, message/image dispatcher, anti-ban bulk sender.
- `/whatsapp/ai.go`: Sliding-window memory buffer and multi-provider AI auto-reply engine.
- `/api/handlers.go`: All 12 REST & SSE endpoints.
- `/render.yaml`: Render blueprint with build and start commands.

### Step 2: Enhance Active Preview Gateway (`server.ts`)
Ensure the Node.js preview server seamlessly mirrors all Go backend APIs:
- PostgreSQL client (`pg`) support when `DATABASE_URL` is set, with automatic fallback to in-memory store.
- Gemini API integration powered by `@google/genai` or direct Gemini REST endpoint.
- Support for inbound message testing (`/api/simulate-incoming`) so the user can test their AI prompt and live chat in real time.
- Correct headers, CORS, and SSE streaming.

### Step 3: Frontend Polish & Verification
- Verify that `public/index.html` connects properly to the backend.
- Ensure all interactive tabs (Connect, Live Chat, Bulk, Catalog, AI Bot, Admin Users) have active event handlers and smooth transitions.
- Verify compilation with `compile_applet`.

---

## 4. Verification Plan

### Automated Build & Compilation
- Run `compile_applet` to verify that Node.js TypeScript compilation passes cleanly.
- Verify that `package.json` scripts (`dev`, `build`, `start`) are properly configured.

### Manual Verification Flows
1. **Authentication Flow**: Log in as `admin` / `admin123`.
2. **Device Link Simulation**: Verify QR code display and 8-digit pairing code generation.
3. **AI Bot Configuration**: Save system prompt and toggle auto-reply.
4. **Live Chat & Inbound Simulation**: Test sending a message, simulate an inbound customer message, and verify AI auto-reply.
5. **Multi-User Admin**: Create a new client account, switch active instance, and verify isolated settings.
