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
- **AI:** Google Gemini (`gemini-flash-lite-latest` + fallback chain) via `@google/genai` — free API key, no credit card. Persona: a named agent (`AGENT_NAME`, default "Sire") at Sire Printing.
- **No form up front:** the assistant collects the box specs first and asks for name, phone and email only at the end, for the quote.
- **Orders & leads:** Gemini calls `submit_quote_request` once it has the specs and an email, and `save_contact_details` whenever the visitor shares contact details. Both are checked on the server: nothing is saved unless the visitor actually typed it.
- **Privacy:** emails and phone numbers are replaced with placeholders (`[EMAIL_1]`, `[PHONE_1]`) before a conversation is sent to Gemini and restored on the server (`src/redact.js`). Each website gets a chat privacy notice at `/privacy?siteId=...`, linked from the chat footer.
- **Returning visitors:** widget.js keeps a random visitor ID on the customer's site. Back within `RESUME_HOURS` (12), the visitor sees and continues their earlier chat; later, a new chat starts and the assistant remembers who they are and what they asked.
- **Needs attention:** chats where the visitor asked for a person, complained, the assistant couldn't answer or kept misunderstanding, or the visitor left without an email are listed first in the admin panel.
- **Email alerts:** new leads, quote requests and "wants a person" chats are emailed to the website's alert emails (any SMTP mailbox, `src/notify.js`).
- **Multiple websites:** each registered website has its own chatbot, branding, training and embed code (section 5b).
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
    │   ├── app.js               # Express app: API + widget + chat UI + admin + /privacy
    │   ├── db.js                # Mongoose connection (shared, lazy - serverless friendly)
    │   ├── util.js              # shared helpers (clientIp)
    │   ├── systemPrompt.js      # the sales playbook (from real chats) + tool schemas, filled in per website
    │   ├── llm.js               # Gemini call + tool loop (quote, contact, request_human, flag_unanswered)
    │   ├── redact.js            # hides emails / phone numbers from Gemini, restores them on the server
    │   ├── companies.js         # per-website profiles (Sire Printing = "default")
    │   ├── learn.js             # trains a chatbot by reading its website
    │   ├── escalations.js       # "Needs attention": raising entries + idle-chat sweep
    │   ├── notify.js            # email alerts over SMTP
    │   ├── models/
    │   │   ├── Company.js       # one per registered website
    │   │   ├── Conversation.js  # messages, visitor identity, visitorKey, previous chat
    │   │   ├── Escalation.js    # "Needs attention" entries
    │   │   ├── Order.js         # quote requests
    │   │   └── Lead.js          # source: 'chat' | 'manual' (callback form) | 'prechat' (legacy)
    │   └── routes/
    │       ├── chat.js          # POST /api/chat, POST /api/resume (public, rate-limited)
    │       ├── lead.js          # POST /api/lead (callback form), /api/identify (legacy)
    │       ├── site.js          # GET /api/site/:siteId (branding)
    │       ├── privacy.js       # GET /privacy?siteId=... (chat privacy notice)
    │       └── admin.js         # /api/admin/* (Bearer-token auth)
    └── public/
        ├── widget.js            # the embeddable loader (Shadow DOM, no deps)
        ├── chat.html/.css/.js   # the avatar chat UI (loaded in the iframe)
        ├── talking-head.js      # lip-syncs the avatar photo to the speech
        ├── avatar-csr.jpg       # the agent's photo (AI-generated face)
        ├── admin.html           # the dashboard (self-contained)
        └── demo.html            # a demo "customer site" for local testing
```

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

## 4. Before you deploy (checklist)

- [ ] **`ADMIN_TOKEN`**: a new long random value, 24+ characters (`openssl rand -base64 32`).
      In production the server **refuses to start** with a missing, example or short token.
- [ ] **`MONGODB_URI`**: the Atlas URI (with `/sireprinting` before the `?`), and the server's
      IP (or `0.0.0.0/0` for Vercel) allowed under Atlas -> Network Access.
- [ ] **`PUBLIC_URL`**: the real `https://` address, no trailing slash (used in alert emails).
- [ ] **`GEMINI_API_KEY`** set; **`SMTP_*`** and **`ALERT_EMAILS`** set if you want email alerts.
- [ ] **`ALLOWED_FRAME_ORIGINS`**: `*` works; for tighter security list the sites that embed the widget.
- [ ] After deploy: open `/api/health`, `/demo` (send a test message), and sign in at `/admin`.
- [ ] Check the logs for `Config warning:` / `Config error:` lines (`pm2 logs`, or Vercel -> Logs).

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
   `ALLOWED_FRAME_ORIGINS`, `WIDGET_TITLE`, `WIDGET_ACCENT`, `AGENT_NAME`, `SALES_EMAIL`,
   and for email alerts `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAILS`
   (optional: `ALERT_FROM`, `RESUME_HOURS`, `ESCALATION_IDLE_MINUTES`).
   Don't set `PORT`. Your local `.env` is never uploaded (`.vercelignore`).
4. Deploy (`vercel --prod`, or push to the production branch), then open
   `https://<your-app>.vercel.app/demo` and `/admin` to check.

Notes: the per-IP rate limits are kept in memory, so on Vercel each running
instance counts separately (looser limits). The function may run up to 60 s
(`vercel.json`); a normal reply takes 1-5 s.

## 4b. Deploy to your VPS

On an Ubuntu server with Node 20 or newer installed:

```bash
# 1. get the code onto the server (git clone / scp), then:
cd packaging-chatbot/backend
npm ci --omit=dev
cp .env.example .env && nano .env        # fill in real values, set PUBLIC_URL, SMTP_* for alerts

# 2. run it under pm2
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup                   # run the command pm2 prints

# 3. reverse proxy + HTTPS
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/sireprinting-chatbot
sudo nano /etc/nginx/sites-available/sireprinting-chatbot     # set server_name
sudo ln -s /etc/nginx/sites-available/sireprinting-chatbot /etc/nginx/sites-enabled/
sudo certbot --nginx -d bot.sireprinting.co.uk
sudo nginx -t && sudo systemctl reload nginx
```

Point the DNS `A` record for `bot.sireprinting.co.uk` at the server **before**
running certbot. After deploy, set `PUBLIC_URL=https://bot.sireprinting.co.uk` in
`.env` and `pm2 restart sireprinting-chatbot`.

Updating later: `git pull && npm ci --omit=dev && pm2 restart sireprinting-chatbot`.

---

## 5. Embed on any website

Paste this once, just before `</body>`:

```html
<script src="https://bot.sireprinting.co.uk/widget.js"
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

## 5a. Dashboard and logins

Open `/admin` and sign in.

- **Main admin:** username `admin` (or `SUPER_ADMIN_USERNAME`), password = `ADMIN_TOKEN` from `.env`. Sees every website and manages websites and logins.
- **Website logins:** in **Logins → Create login**, pick a website, a username (an email works) and a password, then share the details shown. That person sees only their own website's overview, needs-attention inbox, conversations, leads, quote requests and "My chatbot" settings, and can change their own password. Reset, disable or delete logins from the same page; deleting a website removes its logins.

Sessions are httpOnly cookies (14 days) stored hashed in the `sessions` collection; passwords are hashed with scrypt.

### Avatars

Each website picks its chatbot's face in **Websites → Edit → Chatbot avatar**: one of the built-in avatars (Classic, Navy suit, Light grey suit, Beard) or an uploaded photo. For an upload, click the two mouth corners on the photo so the lips move in the right place; the live preview shows the result.

Built-in avatars are AI-generated portraits (not real people) in `public/avatars/`, listed with their measured mouth corners in `src/avatars.js`. To add one, put a square photo there, measure its mouth corners at 620 px, and add a row.

## 5b. Multiple websites (one chatbot each, tawk.to style)

Every website gets its own chatbot, trained on its own details, from the admin panel:

1. Open `/admin` → **Websites & chatbots** → **+ Register a new website**.
2. Fill in the chatbot name, company name, website (required), and optionally phone,
   email, address, the email for design files, a color, a short "about", and extra
   facts (turnaround, shipping, minimum order... one per line).
3. Leave **"Read the website now"** ticked: the server reads the home page plus up to
   7 useful inner pages (about, FAQ, shipping, products...) and Gemini turns them into a
   short fact sheet. Review or edit it later with **Edit**; **Re-train** reads the site again.
4. Copy the one-line **Embed code** and paste it before `</body>` on that website:
   `<script src="https://<your-server>/widget.js" data-id="<siteId>" async></script>`

The widget and chat window load the company's name, chatbot name and color from
`GET /api/site/<siteId>`, and each chat is answered with that company's facts.
Leads, orders and conversations are tagged with the siteId; use the website
dropdown in the admin header to filter. Sire Printing is the built-in company
`default` (the old `data-sireprinting-id` attribute and the old `demo` id still work).
Test any chatbot at `/demo?id=<siteId>`.

## 6. How orders, leads and "needs attention" work

**Quote request (chat):**
1. The widget greets based on the page the visitor is on ("Looking for donut boxes?").
2. The assistant asks one thing at a time: box type, all three dimensions (or a standard size), quantity, design ready or not (if ready: email the file to the website's design-files email), then one or two product details.
3. Last, it asks for name, phone number and email for the quote (email alone is fine).
4. With the specs and an email it calls `submit_quote_request` → an `Order` (status `new`), shown in **/admin → Orders**, plus an email alert. A later spec change in the same chat updates that order.
5. The assistant never quotes prices; the team emails the official quote.

**Leads:** contact details shared in the chat become a `Lead` (`source: "chat"`); the callback form behind the document icon in the chat header posts to `POST /api/lead` (`source: "manual"`). Both email an alert.

**Needs attention** (`Escalation` model, `src/escalations.js`):

| Reason | Raised when | Email alert |
|---|---|---|
| Wants a person | Assistant calls `request_human` | Yes |
| Complaint | Assistant calls `flag_unanswered` with `kind: complaint` | Yes |
| Couldn't answer | Assistant calls `flag_unanswered` (it said "the team will confirm") | No |
| Kept misunderstanding | Two "Sorry, I didn't catch that" replies in a row | No |
| Chatbot failed | Every Gemini model timed out or errored | No |
| Left without email | 4+ visitor messages, no email, quiet for `ESCALATION_IDLE_MINUTES` (30) | No |

The idle check runs every 5 minutes on a long-running server and whenever the admin panel loads. Resolve or dismiss entries in **/admin → Needs attention**.

Tune the assistant in [backend/src/systemPrompt.js](backend/src/systemPrompt.js); per-website facts live in the admin panel.

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

### `POST /api/resume` (public)
`{ siteId, visitorKey }` → `{ conversationId, messages[], returning, visitorName }`. Returns the visitor's chat if it was active within `RESUME_HOURS`; otherwise `conversationId: null`.

### `GET /api/site/:siteId` (public)
Branding for the widget and chat window: company name, chatbot name, color.

### `GET /privacy?siteId=...` (public)
The chat privacy notice for that website.

### `GET /api/admin/escalations?status=open|resolved|dismissed`, `PATCH /api/admin/escalations/:id`
The "Needs attention" inbox (admin token required).

### `POST /api/identify` (public, 10 req / 10 min / IP) — legacy pre-chat gate, no longer used by the widget

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
