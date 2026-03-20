# MergeScribe (PR → Notion Autopilot)

One command after merge to drop polished PR notes straight into Notion. Claude Haiku is the primary LLM; Gemini 2.5 Flash is the free fallback.

---

## What it captures per PR

- Problem solved (plain English)
- Technical summary (what changed and how)
- Code review notes (senior engineer voice)
- Interview story (STAR, ready to tell)
- Likely interview questions
- Resume bullet (action verb, impact-focused)

---

## One-time setup (≈15 min)

### 1) Clone and install

```bash
git clone <this-repo> pr-to-notion
cd pr-to-notion
npm install
cp .env.example .env
```

### 2) GitHub token

1. https://github.com/settings/tokens → **Generate new token (classic)**
2. Scope: `repo` (read is enough)
3. Put token in `.env` as `GITHUB_TOKEN`
4. Set `GITHUB_USERNAME` to your handle

### 3) Anthropic API key (Claude)

1. https://console.anthropic.com → add ~$5 credit
2. Create an API key → set `ANTHROPIC_API_KEY`

### 4) Notion setup

**Create integration**
1. https://www.notion.so/my-integrations → **New integration** (e.g., "PR Notes")
2. Copy the Internal Integration Token → set `NOTION_API_KEY`

**Create database**
1. New Notion page → **Database (Full page)**
2. Properties:
   - `Name` (Title)
   - `Repo` (Select)
   - `PR URL` (URL)
   - `Merged At` (Date)
   - `Concepts` (Multi-select)
   - `Resume Bullet` (Text)
3. Connect the integration via **... → Connections**
4. Grab the database ID from the URL (`https://notion.so/YOUR_DATABASE_ID?v=...`)
5. Set `NOTION_DATABASE_ID` to that ID (just the UUID)

### 5) Optional: Gemini fallback

If you want the free backup model, create a Gemini API key and set `GEMINI_API_KEY`.

---

## Usage

After merging any PR in Talawa-Admin or Talawa-API:

```bash
npm run sync
```

Takes ~15 seconds. Output logs the summary and the Notion page link.

---

## Cost snapshot

| Service | Cost |
|---|---|
| GitHub Token | Free |
| Notion API | Free |
| Claude API | ~$0.007 per PR |
| Gemini (fallback) | Free tier (250 req/day) |
| **Monthly (20 PRs)** | **~$0.14** |
