import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ─── LLM Config ──────────────────────────────────────────────────────────────
// Primary: Claude Haiku (paid, ~$0.007/PR)
// Fallback: Gemini 2.5 Flash (free tier, 250 req/day)
const LLM = {
    claude: {
        available: !!ANTHROPIC_API_KEY,
        label: "Claude Haiku",
    },
    gemini: {
        available: !!GEMINI_API_KEY,
        label: "Gemini 2.5 Flash (free)",
    },
};

const REPOS = [
    { owner: "PalisadoesFoundation", repo: "talawa-admin" },
    { owner: "PalisadoesFoundation", repo: "talawa-api" },
];

// ─── 1. Fetch Latest Merged PR ───────────────────────────────────────────────

async function checkNotionDuplicate(repo, prNumber) {
    console.log(`🔍 Checking for duplicate: [${repo}] #${prNumber}...`);

    const url = `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            filter: {
                and: [
                    {
                        property: "Name",
                        title: {
                            contains: `[${repo}] #${prNumber}`
                        }
                    }
                ]
            }
        })
    });

    const data = await res.json();

    if (data.results && data.results.length > 0) {
        console.log(`⚠️  Duplicate found: [${repo}] #${prNumber} already exists in Notion`);
        return true;
    }

    console.log(`✅ No duplicate found for [${repo}] #${prNumber}`);
    return false;
}

async function fetchLatestMergedPR() {
    console.log("\n🔍 Fetching your latest merged PR (robust search)...\n");

    const query =
  `is:pr is:merged author:${process.env.GITHUB_USERNAME} ` +
  `repo:PalisadoesFoundation/talawa-api ` +
  `repo:PalisadoesFoundation/talawa-admin ` +
  `sort:updated-desc`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(
        query
    )}&per_page=20`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
        },
    });

    const data = await res.json();

    if (!data.items || data.items.length === 0) {
        console.log("❌ No merged PRs found for your username.");
        process.exit(1);
    }

    // Iterate through PRs → skip duplicates
    for (const item of data.items) {
        const prApiUrl = item.pull_request.url;

        // Fetch full PR details
        const prRes = await fetch(prApiUrl, {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
            },
        });

        const pr = await prRes.json();

        const repoName = pr.base.repo.name;

        console.log(`\n✅ Found PR: [${repoName}] #${pr.number} — ${pr.title}`);
        console.log(`   Merged at: ${new Date(pr.merged_at).toLocaleString()}`);

        // Check Notion duplicate
        const isDuplicate = await checkNotionDuplicate(repoName, pr.number);

        if (isDuplicate) {
            console.log("⏭️  Already processed, checking next...");
            continue;
        }

        console.log(`🎯 Processing new PR: [${repoName}] #${pr.number}\n`);

        // Fetch diff
        const diffRes = await fetch(pr.url, {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github.diff",
            },
        });

        const diff = await diffRes.text();

        return {
            repo: repoName,
            number: pr.number,
            title: pr.title,
            description: pr.body || "No description provided.",
            url: pr.html_url,
            mergedAt: pr.merged_at,
            diff: diff.slice(0, 6000),
        };
    }

    console.log("\n⚠️ All recent PRs already documented.");
    process.exit(0);
}

// ─── 2. Generate Notes via LLM (Claude → Gemini fallback) ────────────────────

function buildPrompt(pr) {
    return `
You are a senior software engineer helping a developer document their open source contributions.

Analyze the following merged Pull Request and generate structured notes for study, interviews, and resume building.

---
Repo: ${pr.repo}
PR #${pr.number}: ${pr.title}
Description: ${pr.description}
Diff (truncated):
${pr.diff}
---

CRITICAL: Return ONLY a valid JSON object. Do not wrap in markdown code blocks. Do not add code block markers. Start your response with { and end with }.

Return a JSON object with exactly these fields:

{
  "problem_solved": "2-3 sentences explaining what problem this PR fixes or what feature it adds. Keep descriptions concise to avoid truncation.",
  "technical_summary": "Bullet points of the key technical changes made (what files, what logic, what patterns). Be concise.",
  "concepts_learned": ["Short concept 1", "Short concept 2", "Short concept 3"],
  "code_review_notes": "What a senior engineer would say reviewing this PR. Keep under 200 words.",
  "interview_story": "A STAR format story for interviews about this PR. Keep to 100-150 words, conversational.",
  "interview_questions": ["Question 1?", "Question 2?", "Question 3?"],
  "resume_bullet": "One strong resume bullet starting with an action verb, max 2 lines"
}

IMPORTANT formatting rules:
- concepts_learned: Keep each concept short (under 50 chars), no commas, no parentheses
- All fields must be strings or arrays as specified above
- Ensure all strings are properly escaped. Keep responses concise to avoid truncation.
`;
}

function parseJSON(raw) {
    console.log("🔧 Parsing LLM response...");
    console.log("Raw length:", raw.length);

    try {
        return JSON.parse(raw.trim());
    } catch (firstError) {
        console.log("⚠️  Initial JSON parse failed, trying to fix...");

        // More aggressive code block removal
        let cleanedRaw = raw
            .replace(/^```\w*\s*/gm, '') // Remove opening code blocks (```json, ```javascript, etc.)
            .replace(/```\s*$/gm, '')    // Remove closing code blocks
            .replace(/^`{3,}\w*\s*/gm, '') // Handle triple+ backticks
            .replace(/`{3,}\s*$/gm, '')     // Handle triple+ backticks at end
            .trim();

        console.log("After code block removal - length:", cleanedRaw.length);
        console.log("Starts with:", cleanedRaw.substring(0, 50));
        console.log("Ends with:", cleanedRaw.substring(Math.max(0, cleanedRaw.length - 50)));

        // Try parsing the cleaned response
        try {
            return JSON.parse(cleanedRaw);
        } catch (secondError) {

            // Try extracting JSON from the response
            const match = cleanedRaw.match(/\{[\s\S]*\}/);
            if (!match) {
                console.log("No JSON match found in:", cleanedRaw.substring(0, 200));
                throw new Error("No JSON object found in LLM response");
            }

            let jsonStr = match[0];
            console.log("Extracted JSON length:", jsonStr.length);

            try {
                // First attempt with extracted JSON
                return JSON.parse(jsonStr);
            } catch (thirdError) {
                console.log("⚠️  Attempting to fix malformed JSON...");

                // Try to fix common JSON issues
                try {
                    // Fix unterminated strings by closing them properly
                    jsonStr = jsonStr.replace(/("(?:[^"\\]|\\.)*)"?(?=\s*[,}\]])/g, (match, p1) => {
                        if (!p1.endsWith('"')) {
                            return p1 + '"';
                        }
                        return match;
                    });

                    // Fix missing closing braces/brackets
                    let openBraces = 0;
                    let openBrackets = 0;
                    for (let char of jsonStr) {
                        if (char === '{') openBraces++;
                        if (char === '}') openBraces--;
                        if (char === '[') openBrackets++;
                        if (char === ']') openBrackets--;
                    }

                    // Add missing closing characters
                    jsonStr += '}'.repeat(Math.max(0, openBraces));
                    jsonStr += ']'.repeat(Math.max(0, openBrackets));

                    console.log("Final JSON attempt length:", jsonStr.length);
                    return JSON.parse(jsonStr);
                } catch (fourthError) {
                    console.error("Raw response:", raw.substring(0, 300) + "...");
                    console.error("Cleaned response:", cleanedRaw.substring(0, 300) + "...");
                    console.error("Extracted JSON:", jsonStr.substring(0, 300) + "...");
                    throw new Error(`Could not parse JSON from LLM response. Final error: ${fourthError.message}`);
                }
            }
        }
    }
}

async function generateViaClaude(prompt) {
    console.log("🤖 Trying Claude Haiku (primary)...");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    const data = await res.json();
    if (data.error) throw new Error(`Claude error: ${data.error.message}`);
    return parseJSON(data.content[0].text);
}

async function generateViaGemini(prompt) {
    console.log("🔁 Falling back to Gemini 2.5 Flash (free tier)...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: 2500, // Increased from 1500
                temperature: 0.1,       // Lower temperature for more consistent JSON
                topP: 0.8,
                candidateCount: 1
            },
        }),
    });

    const data = await res.json();

    if (data.error) {
        console.error("Gemini API Error:", data.error);
        throw new Error(`Gemini error: ${data.error.message}`);
    }

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        console.error("Unexpected Gemini response structure:", JSON.stringify(data, null, 2));
        throw new Error("Gemini returned unexpected response structure");
    }

    const raw = data.candidates[0].content.parts[0].text;
    console.log("📝 Raw Gemini response (first 300 chars):", raw.substring(0, 300) + "...");
    console.log("📝 Raw Gemini response (last 300 chars):", "..." + raw.substring(Math.max(0, raw.length - 300)));

    return parseJSON(raw);
}

async function generateNotes(pr) {
    const prompt = buildPrompt(pr);

    // Try Claude first (if key is set)
    if (LLM.claude.available) {
        try {
            const notes = await generateViaClaude(prompt);
            console.log("✅ Claude generated notes successfully.\n");
            return notes;
        } catch (err) {
            console.warn(`⚠️  Claude failed: ${err.message}`);
            console.warn("   Switching to Gemini fallback...\n");
        }
    } else {
        console.log("ℹ️  No Claude API key found — skipping to Gemini.\n");
    }

    // Fallback to Gemini 2.5 Flash (free tier)
    if (LLM.gemini.available) {
        try {
            const notes = await generateViaGemini(prompt);
            console.log("✅ Gemini 2.5 Flash generated notes successfully.\n");
            return notes;
        } catch (err) {
            throw new Error(`Gemini also failed: ${err.message}`);
        }
    }

    throw new Error(
        "❌ No LLM available. Set ANTHROPIC_API_KEY and/or GEMINI_API_KEY in your .env file."
    );
}

// ─── 3. Push to Notion ───────────────────────────────────────────────────────

function normalizeNotes(notes) {
    // Ensure string fields are actually strings (convert arrays to strings if needed)
    const normalized = { ...notes };

    const stringFields = ['problem_solved', 'technical_summary', 'code_review_notes', 'interview_story', 'resume_bullet'];
    for (const field of stringFields) {
        if (Array.isArray(normalized[field])) {
            if (field === 'technical_summary') {
                // Convert array to bullet points
                normalized[field] = normalized[field].map(item => `• ${item}`).join('\n');
            } else {
                // Join with spaces for other fields
                normalized[field] = normalized[field].join(' ');
            }
        }
    }

    // Ensure array fields are actually arrays
    if (!Array.isArray(notes.concepts_learned)) {
        normalized.concepts_learned = [notes.concepts_learned];
    }
    if (!Array.isArray(notes.interview_questions)) {
        normalized.interview_questions = [notes.interview_questions];
    }

    // Clean up concepts for Notion multi_select (no commas allowed, max 100 chars)
    normalized.concepts_learned = normalized.concepts_learned
        .map(concept => {
            // Remove commas and other problematic characters
            let cleaned = concept
                .replace(/,/g, ' -')                    // Replace commas with dashes
                .replace(/[();]/g, '')                  // Remove parentheses and semicolons
                .replace(/\s+/g, ' ')                   // Normalize whitespace
                .trim();
            
            // Truncate if too long (Notion multi_select has limits)
            if (cleaned.length > 100) {
                cleaned = cleaned.substring(0, 97) + '...';
            }
            
            return cleaned;
        })
        .filter(concept => concept && concept.length > 0); // Remove empty concepts

    return normalized;
}

async function pushToNotion(pr, notes) {
    console.log("📝 Pushing to Notion...\n");

    // Normalize the data structure
    const normalizedNotes = normalizeNotes(notes);

    const body = {
        parent: { database_id: NOTION_DATABASE_ID },
        icon: { emoji: "🚀" },
        properties: {
            Name: {
                title: [{ text: { content: `[${pr.repo}] #${pr.number} — ${pr.title}` } }],
            },
            Repo: {
                select: { name: pr.repo },
            },
            "PR URL": {
                url: pr.url,
            },
            "Merged At": {
                date: { start: pr.mergedAt },
            },
            Concepts: {
                multi_select: normalizedNotes.concepts_learned.map((c) => ({ name: c })),
            },
            "Resume Bullet": {
                rich_text: [{ text: { content: normalizedNotes.resume_bullet } }],
            },
        },
        children: [
            block("heading_2", "🧩 Problem Solved"),
            block("paragraph", normalizedNotes.problem_solved),

            block("heading_2", "⚙️ Technical Summary"),
            block("paragraph", normalizedNotes.technical_summary),

            block("heading_2", "🔍 Code Review Notes"),
            block("paragraph", normalizedNotes.code_review_notes),

            block("heading_2", "🎤 Interview Story (STAR Format)"),
            block("paragraph", normalizedNotes.interview_story),

            block("heading_2", "❓ Likely Interview Questions"),
            ...normalizedNotes.interview_questions.map((q) => bulletBlock(q)),

            block("heading_2", "📄 Resume Bullet"),
            block("quote", normalizedNotes.resume_bullet),
        ],
    };

    const res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.id) {
        console.log(`✅ Notion page created: https://notion.so/${data.id.replace(/-/g, "")}\n`);
    } else {
        console.error("❌ Notion error:", JSON.stringify(data, null, 2));
    }
}

function block(type, text) {
    return {
        object: "block",
        type,
        [type]: {
            rich_text: [{ type: "text", text: { content: text } }],
        },
    };
}

function bulletBlock(text) {
    return {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: text } }],
        },
    };
}

// ─── 4. Print Summary to Terminal ────────────────────────────────────────────

function printSummary(notes) {
    console.log("━".repeat(60));
    console.log("📋 GENERATED NOTES SUMMARY");
    console.log("━".repeat(60));
    console.log("\n🧩 Problem Solved:\n", notes.problem_solved);
    console.log("\n💡 Concepts Learned:\n", notes.concepts_learned.join(", "));
    console.log("\n🎤 Interview Story:\n", notes.interview_story);
    console.log("\n📄 Resume Bullet:\n", notes.resume_bullet);
    console.log("\n" + "━".repeat(60));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    try {
        const pr = await fetchLatestMergedPR();
        const notes = await generateNotes(pr);
        printSummary(notes);
        await pushToNotion(pr, notes);
        console.log("🎉 All done! Check your Notion database.\n");
    } catch (err) {
        console.error("❌ Error:", err.message);
    }
})();