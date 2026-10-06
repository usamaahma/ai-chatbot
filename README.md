# Sire Printing — Custom Chatbot (Embeddable AI Avatar Sales Assistant)

An avatar chat widget you drop onto any website with one `<script>` tag (like
Tawk.to). Visitors talk to the **Sire Printing assistant** — an animated avatar
with **voice in and voice out** — to spec and place custom printing and packaging
orders. Every conversation and every completed order is stored in **MongoDB**,
and you review them from a password-protected **admin dashboard**.

```
Visitor's website  ──<script src=".../widget.js">──►  floating chat bubble
                                                          │  (opens an iframe)
                                                          ▼
                                   Your server  ──►  Google Gemini (free tier)
                                        │
                                        ├─►  MongoDB  (conversations + orders)
                                        └─►  /admin dashboard  (you)
```

- **Avatar:** an AI-generated face of a man who doesn't exist (`public/avatar-csr.jpg`) that **lip-syncs to the voice**: `public/talking-head.js` draws it on a canvas and opens and closes the mouth letter by letter as the words are spoken (re-synced on each word). The voice prefers a male browser voice (e.g. "Google UK English Male", "Microsoft Guy", "Daniel"), falling back to a lowered pitch. If you replace the photo, re-measure the mouth coordinates in the `FACE` block at the top of `talking-head.js`.
- **Voice:** browser Web Speech API — speech‑to‑text + text‑to‑speech, free, in the visitor's browser. Two modes: **push‑to‑talk** (mic button) and **hands‑free call mode** (phone button — it listens, replies, and auto‑listens again like ChatGPT voice; tap the avatar to interrupt). Best support in Chrome/Edge; degrades to text elsewhere.
- **AI:** Google Gemini (`gemini-flash-lite-latest` + fallback chain) via `@google/genai` — free API key, no credit card. Persona: a named agent (`AGENT_NAME`, default "Zack") at Sire Printing.
- **Pre-chat gate:** before a *new* conversation's first message, the widget asks for name (optional), email (**required**), phone (optional) via `POST /api/identify`. Returning visitors (existing conversation in `localStorage`) skip it. Visitors can also tap "Skip, just start chatting."
- **Orders & leads:** Gemini calls `submit_quote_request` when a visitor agrees to receive an emailed price quote, or `show_lead_form` to pop a short **callback form** (name, email, phone) mid-conversation. All three capture paths (pre-chat gate, callback form, header button) land in MongoDB and show in the dashboard.
- **Backend:** Node.js + Express + `@google/genai` + Mongoose.

---

## Folder structure

```
packaging-chatbot/
├── package.json                 # root convenience scripts
├── README.md
└── backend/
    ├── server.js                # local / VPS entry: connect DB, then listen
    ├── api/index.js             # Vercel entry: serves the same app as a serverless function
    ├── vercel.json              # Vercel config (static public/, everything else -> api/)
    ├── scripts/ensure-db.sh     # starts local MongoDB before `npm run dev`
    ├── ecosystem.config.js      # pm2 process file
    ├── .env.example             # copy to .env
    ├── deploy/
    │   └── nginx.conf.example   # reverse proxy + TLS
    ├── src/
    │   ├── app.js               # Express app: API + widget + chat UI + admin
    │   ├── db.js                # Mongoose connection (shared, lazy - serverless friendly)
    │   ├── util.js              # shared helpers (clientIp)
    │   ├── systemPrompt.js      # Zack's sales playbook (from real chats) + submit_quote_request / show_lead_form schemas
    │   ├── llm.js               # Gemini call + function-calling loop
    │   ├── models/
    │   │   ├── Conversation.js  # includes visitor.{name,email,phone} once identified
    │   │   ├── Order.js
    │   │   └── Lead.js          # source: 'prechat' | 'manual'
    │   └── routes/
    │       ├── chat.js          # POST /api/chat      (public, rate-limited)
    │       ├── lead.js          # POST /api/lead       (callback form)
    │       │                    # POST /api/identify   (pre-chat gate)
    │       └── admin.js         # /api/admin/*        (Bearer-token auth)
    └── public/
        ├── widget.js            # the embeddable loader (Shadow DOM, no deps)
        ├── chat.html/.css/.js   # the avatar chat UI (loaded in the iframe)
        ├── talking-head.js      # lip-syncs the avatar photo to the speech
        ├── avatar-csr.jpg       # the agent's photo (AI-generated face)
        ├── admin.html           # the dashboard (self-contained)
        └── demo.html            # a demo "customer site" for local testing
```

> (Stop any `npm run dev` running inside it first, then remove the folder.)

---

## 1. Prerequisites

| Need | How |
|---|---|
| **Node.js 18+** | already installed |
| **Google Gemini API key** (free, no card) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → sign in with a Google account → **Create API key** |
| **MongoDB** | Local (a running `mongod` on `27017`) for testing, **or** a free MongoDB Atlas M0 cluster for production |

### Gemini free tier

Gemini's free tier meters requests **per model per day**. Newer full models are
stingy (e.g. `gemini-3.6-flash` = only 20/day); **"lite" models are far more
generous** (~1,000/day). So the app uses `GEMINI_MODEL=gemini-flash-lite-latest`
and falls through `GEMINI_FALLBACK_MODELS` when a model's daily quota runs out —
each model is a separate bucket, so the chain multiplies the free headroom to a
few thousand requests/day. Enough for a demo and modest live traffic. For a busy
site, enable pay-as-you-go in Google AI Studio (flash-lite is ~$0.10 per 1M input
tokens — a few dollars a month for most sites).

### MongoDB Atlas setup (only when going live — 5 min)

1. Create a free **M0** cluster.
2. **Database Access** → add a database user (username + password).
3. **Network Access** → add your server's public IP (or `0.0.0.0/0` to allow anywhere while testing).
4. **Database → Connect → Drivers** → copy the connection string. It looks like:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/sireprinting?retryWrites=true&w=majority`
   (add `/sireprinting` before the `?` to name the database).

---

## 2. Configure

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env`:

```ini
PORT=5000
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-flash-lite-latest
GEMINI_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-flash-latest,gemini-3.1-flash-lite
MONGODB_URI=mongodb://127.0.0.1:27017/sireprinting   # local; use mongodb+srv://... for Atlas
PUBLIC_URL=http://localhost:5000                     # your real HTTPS URL once deployed
ADMIN_TOKEN=a-long-random-string-you-invent
ALLOWED_FRAME_ORIGINS=*                              # or: https://site-a.com,https://site-b.com
WIDGET_TITLE=Sire Printing
WIDGET_ACCENT=#4f46e5
```

---

## 3. Run locally

```bash
npm run dev        # from backend/  (or: npm run dev  from the repo root)
```

- Test page with the widget: **http://localhost:5000/demo**
- Admin dashboard: **http://localhost:5000/admin** (log in with `ADMIN_TOKEN`)
- Health check: **http://localhost:5000/api/health**

Voice needs `https://` **or** `localhost` — `localhost` counts as secure, so mic + speech work in local dev on Chrome/Edge.

---

## 4a. Deploy to Vercel

The `backend/` folder is ready for Vercel: static files in `public/` are served
by Vercel's CDN and every other request (`/api/*`, `/chat`, `/admin`, `/demo`) goes
to one serverless function (`api/index.js`) running the same Express app. The
database connects on the first request and is reused.

1. **MongoDB Atlas** (local MongoDB can't be used): create the cluster as in
   section 1 and, under Network Access, allow `0.0.0.0/0` - Vercel has no fixed IPs.
2. **Create the project** - either:
   - CLI: `npm i -g vercel`, then `cd backend && vercel` and answer the prompts, or
   - Dashboard: import the Git repo and set **Root Directory = `backend`**.
   Framework preset: **Other** (vercel.json already sets this). No build command.
3. **Environment variables** (Project -> Settings -> Environment Variables), same
   names as `.env`: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`,
   `MONGODB_URI` (Atlas), `ADMIN_TOKEN`, `PUBLIC_URL` (your Vercel / custom domain URL),
   `ALLOWED_FRAME_ORIGINS`, `WIDGET_TITLE`, `WIDGET_ACCENT`, `AGENT_NAME`, `SALES_EMAIL`.
   Don't set `PORT`. Your local `.env` is never uploaded (`.vercelignore`).
4. Deploy (`vercel --prod`, or push to the production branch), then open
   `https://<your-app>.vercel.app/demo` and `/admin` to check.

Notes: the per-IP rate limits are kept in memory, so on Vercel each running
instance counts separately (looser limits). The function may run up to 60 s
(`vercel.json`); a normal reply takes 1-5 s.

## 4b. Deploy to your VPS

On an Ubuntu server with Node 18+ installed:

```bash
# 1. get the code onto the server (git clone / scp), then:
cd packaging-chatbot/backend
npm ci --omit=dev
cp .env.example .env && nano .env        # fill in real values, set PUBLIC_URL

# 2. run it under pm2
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup                   # run the command pm2 prints

# 3. reverse proxy + HTTPS
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/sireprinting-chatbot
sudo nano /etc/nginx/sites-available/sireprinting-chatbot     # set server_name
sudo ln -s /etc/nginx/sites-available/sireprinting-chatbot /etc/nginx/sites-enabled/
sudo certbot --nginx -d chat.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

Point the DNS `A` record for `chat.yourdomain.com` at the server **before**
running certbot. After deploy, set `PUBLIC_URL=https://chat.yourdomain.com` in
`.env` and `pm2 restart sireprinting-chatbot`.

Updating later: `git pull && npm ci --omit=dev && pm2 restart sireprinting-chatbot`.

---

## 5. Embed on any website

Paste this once, just before `</body>`:

```html
<script src="https://chat.yourdomain.com/widget.js"
        data-sireprinting-id="default"
        data-title="Sire Printing"
        data-accent="#4f46e5"
        data-position="br"
        async></script>
```

| Attribute | Purpose | Default |
|---|---|---|
| `data-sireprinting-id` | Label stored on every conversation/order from this site (use per-client) | `default` |
| `data-title` | Name shown in the header | `Sire Printing` |
| `data-accent` | Hex accent colour | `#4f46e5` |
| `data-position` | `br` (bottom-right) or `bl` (bottom-left) | `br` |
| `data-greeting` | Override the first message | built-in |

Open/close it from your own UI:

```html
<button onclick="SirePrinting.open()">Get a quote</button>
```

The widget renders inside a **Shadow DOM + iframe**, so it never clashes with the
host site's CSS or JavaScript.

---

## 6. How orders and leads are captured

**Quote request (chat)** — modelled on real Sire Printing live chats:
1. The widget greets based on the page the visitor is on ("Looking for donut boxes?"). The agent replies in short, multi-bubble messages.
2. It asks one thing at a time: box size (or works it out from the product: what goes inside, how many per box, standard sizes), quantity, name/email/phone (email is enough; details from the pre-chat form aren't asked again), design ready or not, then one or two product details (closure, kraft vs cardstock, inserts, base color, gloss/matte).
3. "Let me get the price for you" → "Is it okay for you if I email you the official price quote?"
4. When the visitor says yes, Gemini calls `submit_quote_request` → an `Order` is written (status `new`). A later spec change in the same chat updates that order instead of creating a duplicate.
5. It appears in **/admin → Orders** (status `new → contacted → quoted → won / lost`, transcript viewable). The agent never quotes exact prices; your team emails the official quote.
6. Visitors can't upload files in the widget, so the agent asks them to email artwork to `SALES_EMAIL` (default `zack@sireprinting.com`).

**Quick callback (form):**
- The visitor clicks the document icon in the widget header, **or** the assistant calls `show_lead_form` when someone just wants a human to call them.
- A short form (name, email, phone, message) submits to `POST /api/lead` → a `Lead` is written (`source: "manual"`).
- It appears in **/admin → Leads** (status `new → contacted → qualified → won / lost`).

**Pre-chat gate (every new conversation):**
- Before the first message of a brand-new conversation, the widget shows a form: name (optional), email (**required**), phone (optional) — or the visitor can tap "Skip, just start chatting."
- On submit, `POST /api/identify` creates the `Conversation` with the visitor's identity attached and writes a matching `Lead` (`source: "prechat"`).
- Returning visitors (an existing conversation already saved in their browser) never see it again.

Tune the assistant's behaviour, products, required fields, and when it offers the form in
[backend/src/systemPrompt.js](backend/src/systemPrompt.js).

---

## API reference

### `POST /api/chat` (public, 30 req / 5 min / IP)

```jsonc
// request
{ "conversationId": "abc123…" /* omit on first message */,
  "message": "I need 500 mailer boxes",
  "siteId": "default" }

// response
{ "conversationId": "abc123…",
  "reply": "Great — what are the internal dimensions?",
  "order": null,          /* or { "id": "<orderId>" } when an order was just saved */
  "showLeadForm": false } /* true → the widget opens the callback form */
```

### `POST /api/lead` (public, 10 req / 10 min / IP)

```jsonc
{ "name": "Bob Smith", "email": "bob@acme.com", "phone": "0300...",
  "message": "optional", "conversationId": "abc123…" /* optional */,
  "siteId": "default" }
// → 201 { "ok": true, "id": "<leadId>" }   (needs name + at least one of email/phone)
```

### `POST /api/identify` (public, 10 req / 10 min / IP) — the pre-chat gate

```jsonc
{ "name": "Ali Raza" /* optional */, "email": "ali@acme.com" /* required */,
  "phone": "0300..." /* optional */, "siteId": "default" }
// → 201 { "conversationId": "abc123…" }   (pass this into every /api/chat call that follows)
```

### `GET /api/admin/*` (header `Authorization: Bearer <ADMIN_TOKEN>`)

| Route | Description |
|---|---|
| `GET /api/admin/stats` | counts (conversations, orders, leads) |
| `GET /api/admin/orders?status=new` · `PATCH /api/admin/orders/:id` | list / update order status |
| `GET /api/admin/leads?status=new` · `PATCH /api/admin/leads/:id` | list / update lead status |
| `GET /api/admin/conversations` | list conversations |
| `GET /api/admin/conversations/:publicId` | full transcript + linked orders + leads |

---

## Notes & limits

- **Rate/quota:** the chat endpoint is rate-limited per IP (30 / 5 min) and each conversation is capped at 40 messages. If you hit Gemini's free-tier limit the widget shows "getting a lot of messages, try again in a minute".
- **Voice** is browser-native: great on Chrome/Edge desktop & Android, partial on Safari, absent on Firefox (chat still works by typing). No cost, no API keys.
- **`ALLOWED_FRAME_ORIGINS`:** lock this to your real domains for production instead of `*`.
- Roman Urdu is supported in text; spoken output uses whatever voice the visitor's browser has (usually an English voice reading the Latin text).
