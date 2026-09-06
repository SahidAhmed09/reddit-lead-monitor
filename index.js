// Polls Reddit's public JSON search (no auth needed) for new hiring/freelance/
// dev/AI-automation posts and pushes a Telegram alert the moment a match appears.

const fs = require("fs");
const path = require("path");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000);
const STATE_FILE = path.join(__dirname, "seen.json");
const MAX_SEEN_IDS = 3000;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars. Set them in Render's dashboard.");
  process.exit(1);
}

// Subreddits where "hiring a dev / freelancer / AI automation help" posts actually show up.
const SUBREDDITS = [
  "forhire",
  "freelance_forhire",
  "slavelabour",
  "jobbit",
  "WebDeveloperJobs",
  "remotejs",
  "webdev",
  "webdesign",
  "SideProject",
  "Entrepreneur",
  "smallbusiness",
  "SaaS",
  "startups",
  "automation",
  "AI_Agents",
  "n8n",
];

// Broad phrase list covering hiring / looking-for-dev / website-dev / AI-automation asks.
const KEYWORD_PATTERNS = [
  /\bhiring\b/i,
  /\[hiring\]/i,
  /looking for a?\s*(developer|programmer|freelancer|dev)\b/i,
  /need(ed)? a?\s*(developer|programmer|freelancer|dev)\b/i,
  /seeking a?\s*(developer|programmer|freelancer)\b/i,
  /looking to hire/i,
  /want to hire/i,
  /freelance(r)?\s*(developer|needed|wanted)/i,
  /(web|website|app)\s*developer\s*(needed|wanted)/i,
  /need(ed)? a?\s*(website|web ?site|landing page|web app)\b/i,
  /build (me |us )?(a|an|my|our)\s*(website|app|site|mvp|saas|bot|automation)/i,
  /can someone build/i,
  /looking for someone to build/i,
  /looking for someone to (automate|develop|code|program)/i,
  /need help (automating|with automation)/i,
  /\bai\s*automation\b/i,
  /\bai\s*agent\s*(developer|builder|freelancer)\b/i,
  /need (an? )?ai (integration|agent|automation|workflow)/i,
  /automation (expert|specialist|freelancer|consultant) needed/i,
  /n8n (expert|freelancer|developer) needed/i,
  /looking for a?\s*no-?code\s*(developer|expert|freelancer)/i,
];

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { seenIds: new Set(parsed.seenIds || []) };
  } catch {
    return { seenIds: new Set() };
  }
}

function saveState(state) {
  const seenIdsArr = Array.from(state.seenIds).slice(-MAX_SEEN_IDS);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ seenIds: seenIdsArr }), "utf8");
}

function matchesKeywords(title, selftext) {
  const text = `${title}\n${selftext || ""}`;
  return KEYWORD_PATTERNS.some((re) => re.test(text));
}

async function fetchNewPosts(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=25`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "reddit-lead-monitor:v1.0 (by /u/Spiritual-Spring366)",
    },
  });
  if (!res.ok) {
    throw new Error(`r/${subreddit} -> HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json.data && json.data.children ? json.data.children : []).map((c) => c.data);
}

async function sendTelegramAlert(post) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const permalink = `https://www.reddit.com${post.permalink}`;
  const posted = new Date(post.created_utc * 1000).toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const text =
    `🔔 New lead — r/${post.subreddit}\n` +
    `${post.title}\n\n` +
    `Posted: ${posted} IST\n` +
    `${permalink}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Telegram send failed: HTTP ${res.status} ${body}`);
  }
}

async function pollOnce(state) {
  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchNewPosts(subreddit);
      for (const post of posts) {
        if (state.seenIds.has(post.id)) continue;
        state.seenIds.add(post.id);
        if (matchesKeywords(post.title, post.selftext)) {
          console.log(`Match: r/${subreddit} — ${post.title}`);
          await sendTelegramAlert(post);
        }
      }
    } catch (err) {
      console.error(`Error polling r/${subreddit}:`, err.message);
    }
    // small stagger to stay well under Reddit's unauthenticated rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }
  saveState(state);
}

async function main() {
  const state = loadState();
  console.log(`Reddit lead monitor started. Watching ${SUBREDDITS.length} subreddits every ${POLL_INTERVAL_MS / 1000}s.`);

  // On first run ever, seed seenIds without alerting so we don't blast old posts.
  const isFirstRun = state.seenIds.size === 0;
  if (isFirstRun) {
    console.log("First run — seeding seen posts without alerting.");
    for (const subreddit of SUBREDDITS) {
      try {
        const posts = await fetchNewPosts(subreddit);
        posts.forEach((p) => state.seenIds.add(p.id));
      } catch (err) {
        console.error(`Error seeding r/${subreddit}:`, err.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    saveState(state);
  }

  await pollOnce(state);
  setInterval(() => pollOnce(state).catch((e) => console.error("Poll cycle failed:", e)), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
