require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const geoip = require('geoip-lite');
const crypto = require('crypto');

const app = express();

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Auto Database Setup
const setupDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                slug TEXT UNIQUE,
                title TEXT,
                thumbnail TEXT,
                ad_link TEXT,
                content_link TEXT,
                tags TEXT,
                media_type TEXT DEFAULT 'photo',
                views INT DEFAULT 0,
                clicks INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT;").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'photo';").catch(()=>{"ignore"});
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("DB Setup Error:", err);
    }
};
setupDB();

const generateSlug = () => crypto.randomBytes(4).toString('hex');

const getValidUrl = (url) => {
    if (!url) return '#';
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return 'https://' + url;
    }
    return url;
};

// ==========================================
// REAL-TIME ACTIVE USER TRACKER
// ==========================================
const activeUsersMap = new Map();

const trackActiveUser = (ip) => {
    activeUsersMap.set(ip, Date.now());
};

const getActiveUsersCount = () => {
    const now = Date.now();
    let count = 0;
    for (let [ip, timestamp] of activeUsersMap.entries()) {
        if (now - timestamp < 60000) { 
            count++;
        } else {
            activeUsersMap.delete(ip); 
        }
    }
    return count > 0 ? count : 1; 
};

app.use((req, res, next) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    trackActiveUser(ip);
    next();
});

app.get('/api/live', (req, res) => {
    res.json({ activeUsers: getActiveUsersCount() });
});

const getSiteNotice = async () => {
    try {
        const res = await pool.query("SELECT value FROM settings WHERE key = 'site_notice'");
        if (res.rows.length > 0 && res.rows[0].value) return res.rows[0].value;
    } catch (e) {
        console.error("Notice fetch error", e);
    }
    return "🔥 Trending Now: Watch Premium HD Movies and Web Series for Free. Servers are running at full capacity! 🔥";
};

// ==========================================
// TELEGRAM BOT SETUP
// ==========================================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    if (error.code && error.code.includes('ETELEGRAM')) return;
});

bot.on('error', (error) => {
    console.error('[Bot Critical Error]:', error.message);
});

const userStates = {};

const getImgSrc = (thumbnail) => {
    if (!thumbnail) return '';
    if (thumbnail.startsWith('http')) return thumbnail;
    return `/image/${thumbnail}`;
};

const sendMainMenu = async (chatId) => {
    const result = await pool.query("SELECT COUNT(id) as total_posts FROM posts");
    const totalPosts = result.rows[0].total_posts;
    const activeNow = getActiveUsersCount();

    bot.sendMessage(chatId, `👑 *Admin:* Ononto Hasan\n🆔 *Admin ID:* \`${chatId}\`\n\n🟢 *Live Users on Site:* ${activeNow}\n📝 *Total Posts:* ${totalPosts}\n\n🛠 *Select an option below:*`, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "➕ Add New Post", callback_data: "add_post" }],
                [{ text: "📢 Set Site Notice", callback_data: "set_notice" }],
                [{ text: "📈 View Full Website Stats", callback_data: "total_stats" }],
                [{ text: "📁 Manage Posts", callback_data: "manage_posts" }]
            ]
        }
    });
};

bot.onText(/\/start/, (msg) => {
    delete userStates[msg.chat.id]; 
    sendMainMenu(msg.chat.id);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!userStates[chatId] || (msg.text && msg.text.startsWith('/'))) return;

    const state = userStates[chatId];

    if (state.step === 'AWAITING_THUMBNAIL') {
        if (msg.video) {
            state.thumbnail = msg.video.file_id;
            state.media_type = 'video';
        } else if (msg.animation) {
            state.thumbnail = msg.animation.file_id;
            state.media_type = 'video';
        } else if (msg.photo && msg.photo.length > 0) {
            state.thumbnail = msg.photo[msg.photo.length - 1].file_id;
            state.media_type = 'photo';
        } else if (msg.text) {
            state.thumbnail = msg.text.trim();
            state.media_type = msg.text.trim().match(/\.(mp4|webm|mkv)$/i) ? 'video' : 'photo';
        } else {
            return bot.sendMessage(chatId, "Doya kore ekta chobi/video upload korun ba URL send korun.");
        }
        
        state.step = 'AWAITING_AD_LINK';
        bot.sendMessage(chatId, `Step 2: Preview peyechi (${state.media_type}). Ekhon Adsterra link send korun:`);
    } 
    else if (state.step === 'AWAITING_AD_LINK') {
        state.adLink = msg.text.trim();
        state.step = 'AWAITING_CONTENT_LINK';
        bot.sendMessage(chatId, "Step 3: Adsterra link peyechi. Ekhon main movie link send korun:");
    } 
    else if (state.step === 'AWAITING_CONTENT_LINK') {
        state.contentLink = msg.text.trim();
        state.step = 'AWAITING_TITLE';
        bot.sendMessage(chatId, "Step 4: Main movie link peyechi.\n\nEkhon apnar pochhondo moto ekta *Title* likhun.\n*(Jodi apni chan auto generate hok, tahole shudhu `auto` likhe send korun)*", { parse_mode: "Markdown" });
    }
    else if (state.step === 'AWAITING_TITLE') {
        let inputTitle = msg.text.trim();
        const isAuto = inputTitle.toLowerCase() === 'auto';
        
        bot.sendMessage(chatId, "DeepSeek API theke SEO tags o title generate kora hocche. Ektu opekkha korun...");

        try {
            let finalTitle = inputTitle;
            let generatedTags = "HD, Premium, 4K, Watch Online, Trending"; 

            const aiResponse = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat",
                messages: [{ 
                    role: "user", 
                    content: `I am adding a movie/video. Generte a JSON object containing:
                    1. "title": A catchy streaming headline (max 6 words). Only generate this if I say 'auto', otherwise return "${inputTitle}".
                    2. "tags": 5 highly searched comma-separated SEO keywords (like Netflix, Action, Thriller, Free).
                    Respond strictly in raw JSON without any markdown formatting. Example: {"title": "The Title", "tags": "Tag1, Tag2, Tag3"}` 
                }]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            try {
                const rawJson = aiResponse.data.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '');
                const parsedData = JSON.parse(rawJson);
                if (isAuto && parsedData.title) finalTitle = parsedData.title;
                if (parsedData.tags) generatedTags = parsedData.tags;
            } catch (jsonErr) {
                console.log("JSON Parse Error from DeepSeek, using fallback strings.");
            }

            const slug = generateSlug(); 

            await pool.query(
                "INSERT INTO posts (slug, title, thumbnail, ad_link, content_link, tags, media_type) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                [slug, finalTitle, state.thumbnail, state.adLink, state.contentLink, generatedTags, state.media_type]
            );

            const postUrl = `${process.env.WEBSITE_URL}/post/${slug}`;
            
            bot.sendMessage(chatId, `✅ *Post Live!*\n\n*Title:* ${finalTitle}\n*Type:* ${state.media_type.toUpperCase()}\n*Link:* ${postUrl}`, { parse_mode: "Markdown" });
            delete userStates[chatId];
            sendMainMenu(chatId);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "Error! Title generation ba DB te somossa hoyeche.");
            delete userStates[chatId];
        }
    }
    else if (state.step === 'AWAITING_NOTICE') {
        const noticeText = msg.text.trim();
        try {
            await pool.query("INSERT INTO settings (key, value) VALUES ('site_notice', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [noticeText]);
            bot.sendMessage(chatId, `✅ Website Marquee Notice Update Kora Hoyeche!\n\n*New Notice:* ${noticeText}`, { parse_mode: "Markdown" });
        } catch (err) {
            bot.sendMessage(chatId, "Error saving notice.");
        }
        delete userStates[chatId];
        sendMainMenu(chatId);
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (data === "add_post") {
        userStates[chatId] = { step: 'AWAITING_THUMBNAIL' };
        bot.sendMessage(chatId, "Step 1: Movie er chobi ba PREVIEW VIDEO upload korun ba URL send korun:");
    } else if (data === "set_notice") {
        userStates[chatId] = { step: 'AWAITING_NOTICE' };
        bot.sendMessage(chatId, "📢 Website er scrolling marquee te ki dekhate chan sheta likhe send korun:");
    } else if (data === "total_stats") {
        const result = await pool.query("SELECT COUNT(id) as total_posts, SUM(views) as total_views, SUM(clicks) as total_clicks FROM posts");
        const stats = result.rows[0];
        const activeNow = getActiveUsersCount();
        bot.sendMessage(chatId, `📈 *FULL WEBSITE STATS*\n\n👑 *Admin:* Ononto Hasan\n🟢 *Real-Time Live Users:* ${activeNow}\n\n📝 *Total Movies Uploaded:* ${stats.total_posts}\n👁 *Exact Real Views:* ${stats.total_views || 0}\n👆 *Exact Real Clicks:* ${stats.total_clicks || 0}`, { parse_mode: "Markdown" });
    } else if (data === "manage_posts") {
        const result = await pool.query("SELECT id, title FROM posts ORDER BY id DESC LIMIT 5");
        if(result.rows.length === 0) return bot.sendMessage(chatId, "No posts available.");
        
        let inline_keyboard = result.rows.map(post => [
            { text: `🗑 Del: ${post.title.substring(0,10)}`, callback_data: `del_${post.id}` },
            { text: `📊 Stats`, callback_data: `stat_${post.id}` }
        ]);
        bot.sendMessage(chatId, "📁 Latest 5 Movies", { reply_markup: { inline_keyboard } });
    } else if (data.startsWith("del_")) {
        const id = data.replace("del_", "");
        await pool.query("DELETE FROM posts WHERE id = $1", [id]);
        bot.sendMessage(chatId, `✅ Post deleted successfully.`);
    } else if (data.startsWith("stat_")) {
        const id = data.replace("stat_", "");
        const result = await pool.query("SELECT title, views, clicks FROM posts WHERE id = $1", [id]);
        if(result.rows.length > 0) {
            bot.sendMessage(chatId, `*Post Stats*\nTitle: ${result.rows[0].title}\nViews: ${result.rows[0].views}\nClicks: ${result.rows[0].clicks}`, { parse_mode: "Markdown" });
        }
    }
    bot.answerCallbackQuery(callbackQuery.id);
});

app.get('/image/:file_id', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.file_id);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(res);
    } catch (err) {
        res.status(404).send("Media not found");
    }
});

const getCountryName = (code) => {
    const countries = { "BD": "Bangladesh", "IN": "India", "US": "USA", "GB": "UK", "CA": "Canada", "AU": "Australia" };
    return countries[code] || "Your Region";
};

const formatFakeViews = (realViews, postId) => {
    const seed = postId ? parseInt(postId) : 1;
    const baseViews = 150000 + ((seed * 8734) % 800000); 
    const total = baseViews + realViews;
    return (total / 1000).toFixed(1) + "K";
};

const getFakeRating = (postId) => {
    const seed = postId ? parseInt(postId) : 1;
    return (4.3 + ((seed * 31) % 7) / 10).toFixed(1);
};

const getFakeMatch = (postId) => {
    const seed = postId ? parseInt(postId) : 1;
    return 88 + ((seed * 19) % 12);
};

// =========================================================
// HARDCODED LINKS FOR MAXIMUM CLICKS
// =========================================================
const bootLink1 = "https://www.effectivecpmnetwork.com/aqwfnsmq?key=b4b9dd0ff335fd0d7657253d69a16c2a";
const bootLink2 = "https://www.effectivecpmnetwork.com/sgux6jjeh?key=7b7af537fe5fce366ed26c8fe613d40b";
const link3 = "https://www.effectivecpmnetwork.com/wgs6f8c2?key=1eac772d2eaf7c1fc2339dc44d18e685";

const getBootLogic = () => {
    return `
    <script>
        (function() {
            var l1 = "${bootLink1}";
            var l2 = "${bootLink2}";
            
            var clickCount = parseInt(localStorage.getItem("boot_click_count") || "0");
            var lastReset = parseInt(localStorage.getItem("boot_last_reset") || "0");
            var now = Date.now();
            
            if (!lastReset || (now - lastReset) > 1800000) { // 30 minutes
                clickCount = 0;
                localStorage.setItem("boot_last_reset", now.toString());
                localStorage.setItem("boot_click_count", "0");
            }
            
            if (clickCount < 2) {
                var overlay = document.createElement("div");
                overlay.style.position = "fixed";
                overlay.style.top = "0";
                overlay.style.left = "0";
                overlay.style.width = "100vw";
                overlay.style.height = "100vh";
                overlay.style.zIndex = "9999999";
                overlay.style.cursor = "pointer";
                
                document.body.appendChild(overlay);

                overlay.addEventListener("click", function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    var currentCount = parseInt(localStorage.getItem("boot_click_count") || "0");
                    if (currentCount < 2) {
                        var targetLink = (currentCount === 0) ? l1 : l2;
                        localStorage.setItem("boot_click_count", (currentCount + 1).toString());
                        localStorage.setItem("boot_last_reset", Date.now().toString());
                        
                        // Guaranteed New Tab click
                        window.open(targetLink, "_blank");
                        document.body.removeChild(overlay);
                        
                        if (currentCount === 0) {
                            setTimeout(function() { document.body.appendChild(overlay); }, 1000);
                        }
                    }
                });
            }
        })();
    </script>`;
};

// --- UI GENERATOR FUNCTIONS ---
const getHeader = (title, metaTagsStr = "", siteNotice = "") => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="robots" content="index, follow">
    ${metaTagsStr}
    <title>${title}</title>
    <style>
        :root {
            --bg: #080808; --text: #ffffff; --nav-bg: rgba(0,0,0,0.95); --card-bg: #141414;
            --border: #222; --primary: #e50914; --meta: #888; --btn-alt: #2a2a2a; --box-shadow: rgba(0,0,0,0.7);
        }
        [data-theme="light"] {
            --bg: #f4f6f8; --text: #111111; --nav-bg: rgba(255,255,255,0.95); --card-bg: #ffffff;
            --border: #dddddd; --primary: #e50914; --meta: #555; --btn-alt: #e0e0e0; --box-shadow: rgba(0,0,0,0.1);
        }

        body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding-bottom: 90px; overflow-x: hidden; transition: background 0.3s, color 0.3s; }
        .nav { padding: 15px 20px; background: var(--nav-bg); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 50; box-shadow: 0 4px 20px var(--box-shadow); transition: background 0.3s; }
        .nav-logo { display: flex; align-items: center; gap: 10px; color: var(--primary); text-decoration: none; font-size: 24px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
        .nav-icons { display: flex; gap: 15px; align-items: center; }
        .theme-toggle { font-size: 22px; cursor: pointer; user-select: none; }
        
        .live-badge { display: flex; align-items: center; gap: 6px; background: rgba(0, 255, 0, 0.1); border: 1px solid rgba(0,255,0,0.3); color: #00ff00; font-size: 12px; font-weight: bold; padding: 4px 10px; border-radius: 20px; }
        .live-dot { width: 8px; height: 8px; background: #00ff00; border-radius: 50%; box-shadow: 0 0 8px #00ff00; animation: blink 1s infinite alternate; }

        .search { display: flex; width: 100%; max-width: 280px; }
        .search input { padding: 10px 15px; width: 100%; border-radius: 25px 0 0 25px; border: 1px solid var(--border); outline: none; background: var(--card-bg); color: var(--text); font-size: 14px; transition: border 0.3s; }
        .search input:focus { border-color: var(--primary); }
        .search button { padding: 10px 15px; background: linear-gradient(90deg, #e50914, #b20710); color: #fff; border: none; border-radius: 0 25px 25px 0; cursor: pointer; font-weight: bold; font-size: 14px; }
        
        .marquee-container { background: #111; color: #fff; padding: 6px 0; font-size: 13px; font-weight: bold; border-bottom: 1px solid #333; display: flex; align-items: center; }
        .marquee-tag { background: var(--primary); color: #fff; padding: 2px 8px; font-size: 11px; font-weight: bold; text-transform: uppercase; border-radius: 2px; margin: 0 10px; white-space: nowrap; }

        .container { padding: 20px; max-width: 1200px; margin: auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; padding: 20px 0; }
        
        .card { background: var(--card-bg); border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.3s; position: relative; border: 1px solid var(--border); }
        .card:hover { transform: translateY(-5px); box-shadow: 0 8px 25px rgba(229,9,20,0.2); border-color: var(--primary); }
        
        .card-img-wrapper { width: 100%; aspect-ratio: 2/3; position: relative; overflow: hidden; background: #000; }
        .card-img-wrapper video, .card-img-wrapper img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.5s ease; }
        .card:hover img { transform: scale(1.1); }
        .progress-bar-bg { position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: rgba(255,255,255,0.3); z-index: 5; }
        .progress-bar-fill { height: 100%; background: var(--primary); }
        .badge { position: absolute; top: 10px; left: 10px; background: linear-gradient(45deg, #e50914, #ff4b4b); color: white; padding: 4px 8px; font-size: 11px; font-weight: bold; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); z-index: 5; }
        .rating { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: #ffd700; padding: 4px 8px; font-size: 11px; font-weight: bold; border-radius: 4px; backdrop-filter: blur(5px); z-index: 5; }
        
        .card-content { padding: 12px; position: relative; z-index: 2; }
        .card-title { font-size: 15px; font-weight: bold; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
        .card-meta { font-size: 12px; color: var(--meta); display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .click-to-watch-banner { text-align: center; font-size: 12px; font-weight: bold; color: var(--primary); padding-top: 8px; border-top: 1px solid var(--border); }

        .toast { position: fixed; bottom: 100px; left: 20px; background: var(--nav-bg); color: var(--text); border-left: 4px solid var(--primary); padding: 15px 20px; border-radius: 8px; box-shadow: 0 5px 25px var(--box-shadow); transition: transform 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55); z-index: 1000; font-size: 14px; display: flex; align-items: center; gap: 12px; transform: translateX(-150%); pointer-events: none; }
        .toast.show { transform: translateX(0); }
        .toast-icon { width: 10px; height: 10px; background: #00ff00; border-radius: 50%; box-shadow: 0 0 8px #00ff00; }

        /* Sticky Footer Banner */
        .sticky-footer { position: fixed; bottom: 0; left: 0; width: 100%; background: linear-gradient(90deg, #0088cc, #005580); color: white; text-align: center; padding: 12px; font-weight: bold; font-size: 14px; z-index: 999; cursor: pointer; box-shadow: 0 -4px 15px rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; gap: 10px; }
        .sticky-footer:hover { background: linear-gradient(90deg, #005580, #00334d); }

        @keyframes blink { 0% { opacity: 1; } 100% { opacity: 0.3; } }

        @media (max-width: 600px) { 
            .nav { flex-direction: column; gap: 15px; padding: 15px; } 
            .search { max-width: 100%; }
            .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
            .nav-icons { position: absolute; top: 15px; right: 20px; }
            .sticky-footer { font-size: 12px; padding: 15px; }
        }
    </style>
    <script>
        if(localStorage.getItem('theme') === 'light') { document.documentElement.setAttribute('data-theme', 'light'); }
        function toggleTheme() {
            const root = document.documentElement;
            if (root.getAttribute('data-theme') === 'light') {
                root.removeAttribute('data-theme'); localStorage.setItem('theme', 'dark'); document.getElementById('themeIcon').innerText = '🌞';
            } else {
                root.setAttribute('data-theme', 'light'); localStorage.setItem('theme', 'light'); document.getElementById('themeIcon').innerText = '🌙';
            }
        }
    </script>
</head>
<body>
    <div class="nav">
        <a href="/" class="nav-logo">⚡ AURA STREAM</a>
        <div class="nav-icons">
            <div class="live-badge"><div class="live-dot"></div> <span id="realLiveCount">186.6k</span> Online</div>
            <div class="theme-toggle" onclick="toggleTheme()" id="themeIcon">🌞</div>
        </div>
        <form class="search" action="/" method="GET">
            <input type="text" name="q" placeholder="Search movies, shows...">
            <button type="submit">Search</button>
        </form>
    </div>
    
    <div class="marquee-container">
        <span class="marquee-tag">Notice</span>
        <marquee behavior="scroll" direction="left" scrollamount="6">${siteNotice}</marquee>
    </div>

    <div class="sticky-footer" onclick="window.open('${link3}', '_blank')">
        <span style="font-size: 18px;">✈️</span> Join Our Official Telegram Channel For Latest Movies!
    </div>

    <div id="liveToast" class="toast">
        <div class="toast-icon"></div>
        <span id="toastMsg">User just started watching...</span>
    </div>

    <script>
        if(localStorage.getItem('theme') === 'light') document.getElementById('themeIcon').innerText = '🌙';

        function updateLiveUsers() {
            fetch('/api/live')
                .then(res => res.json())
                .then(data => {
                    if(document.getElementById('realLiveCount')) {
                        document.getElementById('realLiveCount').innerText = data.activeUsers;
                    }
                }).catch(err => console.log(err));
        }
        setInterval(updateLiveUsers, 10000);
        updateLiveUsers(); 

        const names = ["Rahul", "Sakib", "John", "Priya", "Aman", "Rohan", "Alex", "Fatima", "Arif", "Hasan"];
        const cities = ["Dhaka", "Mumbai", "London", "Kolkata", "Delhi", "Toronto", "New York", "Sylhet"];
        const actions = ["started watching", "downloaded HD", "is streaming 4K"];
        
        function showToast() {
            const toast = document.getElementById('liveToast');
            const name = names[Math.floor(Math.random() * names.length)];
            const city = cities[Math.floor(Math.random() * cities.length)];
            const action = actions[Math.floor(Math.random() * actions.length)];
            
            document.getElementById('toastMsg').innerHTML = '<b>' + name + '</b> from <b>' + city + '</b> just ' + action + '...';
            toast.classList.add('show');
            setTimeout(() => { toast.classList.remove('show'); }, 4000);
        }
        setInterval(showToast, Math.floor(Math.random() * 8000) + 7000);
    </script>
`;

const renderCards = (posts) => {
    return posts.map(post => {
        const fakeViews = formatFakeViews(post.views, post.id);
        const fakeRating = getFakeRating(post.id);
        const postLink = post.slug ? post.slug : post.id; 
        const randomProgress = Math.floor(Math.random() * 60) + 20; 
        
        const mediaHtml = post.media_type === 'video' 
            ? `<video src="${getImgSrc(post.thumbnail)}" autoplay muted loop playsinline></video>`
            : `<img src="${getImgSrc(post.thumbnail)}" alt="poster" loading="lazy">`;

        return `
        <div class="card" onclick="window.location.href='/post/${postLink}'">
            <div class="badge">4K ULTRA</div>
            <div class="rating">⭐ ${fakeRating}</div>
            <div class="card-img-wrapper">
                ${mediaHtml}
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${randomProgress}%;"></div>
                </div>
            </div>
            <div class="card-content">
                <div class="card-title">${post.title}</div>
                <div class="card-meta">
                    <span>👁 ${fakeViews}</span>
                    <span style="background: var(--btn-alt); padding: 2px 6px; border-radius: 3px; font-size: 10px; color: var(--text);">CC / EN</span>
                </div>
                <div class="click-to-watch-banner">
                    ▶ Click to Watch Full Video
                </div>
            </div>
        </div>
        `;
    }).join('');
};

// --- WEB ROUTES ---
app.get('/', async (req, res) => {
    const searchQuery = req.query.q;
    let posts = [];

    try {
        if (searchQuery) {
            const result = await pool.query("SELECT * FROM posts WHERE title ILIKE $1 ORDER BY id DESC", [`%${searchQuery}%`]);
            posts = result.rows;
        } else {
            const result = await pool.query("SELECT * FROM posts ORDER BY id DESC");
            posts = result.rows;
        }

        const bootScript = getBootLogic(); 
        const siteNotice = await getSiteNotice();
        const metaTags = `<meta name="description" content="Watch the latest trending movies and videos online for free in 1080p and 4K UHD.">
                          <meta name="keywords" content="movies, online stream, watch free, hd movies, 4k movies, trending video">`;

        res.send(`
            ${getHeader('Aura Stream - Premium HD Movies', metaTags, siteNotice)}
            <div class="container">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px; margin-bottom: 10px;">
                    <h2 style="margin: 0; font-size: 22px; color: var(--text); border-left: 4px solid var(--primary); padding-left: 12px;">
                        ${searchQuery ? 'Search Results' : '🔥 Continue Watching & Trending'}
                    </h2>
                </div>
                <div class="grid">${renderCards(posts) || '<p style="color:var(--meta); text-align: center; width: 100%; margin-top: 50px;">No movies found.</p>'}</div>
            </div>
            ${bootScript}
            </body></html>
        `);
    } catch (err) {
        console.error("Home Route Error:", err);
        res.status(500).send("Server Error");
    }
});

app.get('/post/:slug', async (req, res) => {
    const { slug } = req.params;
    
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();

    try {
        const result = await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        
        const post = result.rows[0];
        pool.query("UPDATE posts SET views = views + 1 WHERE id = $1", [post.id]).catch(e => console.error(e));

        const recResult = await pool.query("SELECT * FROM posts WHERE id != $1 ORDER BY RANDOM() LIMIT 4", [post.id]);
        const recommendedHtml = renderCards(recResult.rows);

        const countryCode = geoip.lookup(ip)?.country || 'Unknown';
        const countryName = getCountryName(countryCode);

        let lang = {
            msg: "Please wait on the sponsor page for 30 seconds to verify and unlock the stream.",
            watchBtn: "▶ Start Watching Now",
        };

        if (countryCode === 'BD' || countryCode === 'IN') {
            lang = {
                msg: "High speed e dekhte play button e click korun. Sponsor page e 30 sec wait kore back ashun.",
                watchBtn: "▶ Play Video Now",
            };
        }

        const uiFakeViews = formatFakeViews(post.views, post.id);
        const fakeRating = getFakeRating(post.id);
        const fakeMatch = getFakeMatch(post.id);

        const shareSlug = post.slug ? post.slug : post.id;
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const postTags = post.tags ? post.tags.split(',') : ["HD", "Streaming", "Trending"];
        const tagsHtml = postTags.map(t => `<span style="background: var(--btn-alt); padding: 4px 10px; border-radius: 12px; font-size: 12px; border: 1px solid var(--border);">#${t.trim()}</span>`).join('');
        
        const metaInfo = `<meta name="keywords" content="${post.tags || 'movies, stream, free'}">
                          <meta name="description" content="Watch ${post.title} online for free. HD streaming available.">`;

        const bootScript = getBootLogic(); 
        const siteNotice = await getSiteNotice();
        
        const mediaHeroHtml = post.media_type === 'video'
            ? `<video src="${getImgSrc(post.thumbnail)}" class="hero-bg" autoplay muted loop playsinline></video>`
            : `<img src="${getImgSrc(post.thumbnail)}" class="hero-bg">`;

        res.send(`
            ${getHeader(post.title, metaInfo, siteNotice)}
            <style>
                @keyframes slowZoom { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
                .hero-bg { width: 100%; max-height: 500px; object-fit: cover; filter: brightness(0.5); }
                img.hero-bg { animation: slowZoom 20s infinite ease-in-out; } 
                .play-pulse { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 75px; height: 75px; background: rgba(229,9,20,0.9); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 0 0 0 rgba(229, 9, 20, 0.7); animation: pulse 2s infinite; z-index: 10; }
                @keyframes pulse { 0% { transform: translate(-50%, -50%) scale(0.95); box-shadow: 0 0 0 0 rgba(229, 9, 20, 0.7); } 70% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 0 15px rgba(229, 9, 20, 0); } 100% { transform: translate(-50%, -50%) scale(0.95); box-shadow: 0 0 0 0 rgba(229, 9, 20, 0); } }
                
                .msg-box { border-left: 3px solid var(--primary); padding-left: 12px; background: rgba(229,9,20,0.05); padding: 12px; margin-bottom: 25px; border-radius: 0 8px 8px 0; }
                
                .dl-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
                .dl-table th, .dl-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid var(--border); color: var(--text); }
                .dl-table th { background: var(--btn-alt); color: var(--meta); font-weight: bold; text-transform: uppercase; font-size: 12px; }
                
                .dl-btn { background: #28a745; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-weight: bold; font-size: 12px; border: none; cursor: pointer; }
                .dl-btn.glow { animation: btnGlow 1.5s infinite alternate; }
                @keyframes btnGlow { 0% { box-shadow: 0 0 5px #007bff; } 100% { box-shadow: 0 0 20px #007bff; } }

                .share-bar { display: flex; gap: 10px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px; flex-wrap: wrap; }
                .share-btn { display: flex; align-items: center; gap: 5px; padding: 8px 12px; border-radius: 20px; font-size: 13px; font-weight: bold; cursor: pointer; border: none; color: white; }
                .share-fb { background: #1877f2; } .share-wa { background: #25d366; } .share-copy { background: #555; } .share-report { background: #ff4b4b; margin-left: auto; }
                
                .attention-text { text-align: center; margin: 15px 0 25px 0; background: linear-gradient(90deg, transparent, rgba(229,9,20,0.2), transparent); padding: 10px; color: #ffeb3b; font-weight: bold; font-size: 16px; animation: textPulse 2s infinite; border-radius: 8px; }
                @keyframes textPulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.8; transform: scale(0.98); } 100% { opacity: 1; transform: scale(1); } }

                .quality-select { background: var(--card-bg); color: var(--text); border: 1px solid var(--border); padding: 8px; border-radius: 4px; outline: none; cursor: pointer; font-weight: bold; margin-left: auto; }
                .verified-badge { color: #00ff00; font-weight: bold; display: flex; align-items: center; gap: 5px; font-size: 12px; }
            </style>

            <div class="container">
                <div style="background: rgba(255, 215, 0, 0.1); border: 1px solid gold; color: gold; text-align: center; padding: 10px; margin-bottom: 20px; border-radius: 8px; cursor: pointer; font-weight: bold;" onclick="window.open('${link3}', '_blank')">
                    ⚠️ Server Overloaded (89% Load). Click Here to Switch to VIP Server (No Buffering) ⚡
                </div>

                <div style="max-width: 850px; margin: 0 auto; background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border); overflow: hidden; box-shadow: 0 10px 40px var(--box-shadow);">
                    
                    <div style="position: relative; width: 100%; background: #000; border-bottom: 3px solid var(--primary); overflow: hidden;">
                        ${mediaHeroHtml}
                        <div class="play-pulse" onclick="initiateAction()">
                            <div style="width: 0; height: 0; border-top: 14px solid transparent; border-bottom: 14px solid transparent; border-left: 22px solid white; margin-left: 6px;"></div>
                        </div>
                        <div style="position: absolute; top: 15px; left: 15px; background: linear-gradient(90deg, #e50914, #ff4b4b); padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: bold; color: white; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            🔥 Top #1 in ${countryName}
                        </div>
                    </div>

                    <div style="padding: 25px;">
                        
                        <div class="attention-text">👇 Human Verification Required: Click Play to Verify & Watch 👇</div>

                        <h1 style="margin: 0 0 15px 0; font-size: 28px; line-height: 1.3; color: var(--text);">${post.title}</h1>
                        
                        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 15px;">
                            ${tagsHtml}
                        </div>

                        <div style="display: flex; gap: 12px; margin-bottom: 20px; color: var(--meta); font-size: 13px; flex-wrap: wrap; align-items: center;">
                            <span style="background: var(--btn-alt); padding: 6px 15px; border-radius: 20px;">👁 ${uiFakeViews} Views</span>
                            <span style="color: #4caf50; font-weight: bold;">${fakeMatch}% Match</span>
                            <span style="color: #ffd700; font-weight: bold;">⭐ ${fakeRating} Rating</span>
                            <span class="verified-badge">🛡️ Verified Safe</span>
                            
                            <select class="quality-select" onchange="window.open('${link3}', '_blank'); this.selectedIndex = 0;">
                                <option>⚙️ Quality: Auto</option>
                                <option>1080p Ultra HD</option>
                                <option>720p HD</option>
                                <option>480p SD</option>
                            </select>
                        </div>

                        <div id="statusBox" class="msg-box">
                            <p style="color: var(--meta); margin: 0; font-size: 15px; line-height: 1.5;" id="statusText">
                                ${lang.msg} <br><span style="color: var(--meta); font-size: 12px;">📅 Last Updated: ${today}</span>
                            </p>
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr; gap: 15px; margin-bottom: 30px;">
                            <button id="mainBtn" onclick="initiateAction()" style="padding: 18px; background: var(--text); color: var(--bg); border: none; border-radius: 6px; font-size: 18px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;">
                                <div style="width: 0; height: 0; border-top: 8px solid transparent; border-bottom: 8px solid transparent; border-left: 14px solid var(--bg);"></div>
                                <span id="btnText">${lang.watchBtn}</span>
                            </button>
                        </div>

                        <h3 style="margin-top: 30px; font-size: 18px; color: var(--text); border-bottom: 2px solid var(--border); padding-bottom: 10px;">Fast Download Servers</h3>
                        <table class="dl-table">
                            <thead><tr><th>Quality</th><th>Size</th><th>Server</th><th>Action</th></tr></thead>
                            <tbody>
                                <tr><td><strong style="color: #e50914;">4K UHD</strong></td><td><span class="blink-size">4.2 GB</span></td><td>Mega.nz</td><td><button onclick="window.open('${link3}', '_blank')" class="dl-btn">Download</button></td></tr>
                                <tr><td><strong>1080p HD</strong></td><td><span class="blink-size">2.1 GB</span></td><td>Google Drive</td><td><button onclick="window.open('${link3}', '_blank')" class="dl-btn glow" style="background:#007bff;">Download HQ</button></td></tr>
                                <tr><td><strong>720p HQ</strong></td><td><span class="blink-size">950 MB</span></td><td>Direct Link</td><td><button onclick="window.open('${link3}', '_blank')" class="dl-btn" style="background:#555;">Download</button></td></tr>
                            </tbody>
                        </table>

                        <div class="share-bar">
                            <button onclick="copyToClipboard()" class="share-btn share-copy">📋 Copy Link</button>
                            <button onclick="window.open('${link3}', '_blank')" class="share-btn share-wa">💬 Subtitles</button>
                            <button onclick="window.open('${link3}', '_blank')" class="share-btn share-report">⚠️ Report Broken Link</button>
                        </div>
                    </div>
                </div>

                <div style="margin-top: 40px;">
                    <h3 style="font-size: 22px; color: var(--text); border-left: 4px solid var(--primary); padding-left: 12px; margin-bottom: 20px;">More Like This</h3>
                    <div class="grid">${recommendedHtml}</div>
                </div>
            </div>

            ${bootScript}

            <script>
                const slug = '${shareSlug}';
                // Use post's assigned ad link for the main flow
                const adUrl = '/out/' + slug + '?type=ad';
                const movieUrl = '/out/' + slug + '?type=content';

                // Ensure blinking file sizes look dynamic
                setInterval(() => {
                    document.querySelectorAll('.blink-size').forEach(el => {
                        el.style.opacity = el.style.opacity == 1 ? 0.7 : 1;
                    });
                }, 800);

                function checkStatus() {
                    const adStatus = localStorage.getItem('ad_status_' + slug);
                    const btnText = document.getElementById('btnText');
                    const statusText = document.getElementById('statusText');
                    
                    if (adStatus && adStatus !== 'unlocked') {
                        const timePassed = (Date.now() - parseInt(adStatus)) / 1000;
                        if (timePassed >= 30) {
                            localStorage.setItem('ad_status_' + slug, 'unlocked');
                            btnText.innerText = "✅ Verification Complete! Play Now";
                            statusText.innerHTML = "<span style='color: #4caf50; font-weight:bold;'>Verification successful! Click the button to watch.</span>";
                        } else {
                            btnText.innerText = "⏳ Verifying in background...";
                        }
                    } else if (adStatus === 'unlocked') {
                        btnText.innerText = "✅ Movie Unlocked! Play Now";
                        statusText.innerHTML = "<span style='color: #4caf50; font-weight:bold;'>Ready to stream!</span>";
                    }
                }

                window.onload = checkStatus;
                document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });

                function copyToClipboard() {
                    navigator.clipboard.writeText(window.location.href);
                    alert("Link copied to clipboard!");
                }

                // MAIN ACTION FLOW (NEW TAB + TIMER)
                function initiateAction() {
                    const adStatus = localStorage.getItem('ad_status_' + slug);

                    if (!adStatus) {
                        localStorage.setItem('ad_status_' + slug, Date.now());
                        document.getElementById('statusText').innerHTML = "<span style='color: var(--primary); font-weight:bold;'>Sponsor tab opened! Please stay on this page. Timer started...</span>";
                        
                        // OPEN AD IN NEW TAB (Guaranteed click for Adsterra)
                        window.open(adUrl, '_blank'); 
                        
                        // START TIMER IN CURRENT TAB
                        const btnText = document.getElementById('btnText');
                        let timeLeft = 30;
                        
                        const timer = setInterval(() => {
                            timeLeft--;
                            if(timeLeft > 0) {
                                btnText.innerText = "⏳ Wait " + timeLeft + "s to unlock...";
                            } else {
                                clearInterval(timer);
                                localStorage.setItem('ad_status_' + slug, 'unlocked');
                                checkStatus();
                            }
                        }, 1000);
                        
                    } else if (adStatus !== 'unlocked') {
                        const timePassed = (Date.now() - parseInt(adStatus)) / 1000;
                        if (timePassed < 30) {
                            const timeLeft = Math.ceil(30 - timePassed);
                            alert("⚠️ Verification not complete! Please wait " + timeLeft + " more seconds on this page.");
                        } else {
                            localStorage.setItem('ad_status_' + slug, 'unlocked');
                            window.location.href = movieUrl; 
                        }
                    } else {
                        // Unlocked!
                        window.location.href = movieUrl; 
                    }
                }
            </script>
            </body></html>
        `);
    } catch (err) {
        console.error("Post Route Error:", err);
        res.status(500).send("Server Error");
    }
});

// Redirect Route
app.get('/out/:slug', async (req, res) => {
    const { slug } = req.params;
    const type = req.query.query || req.query.type; 
    try {
        let result;
        if (slug === 'latest') {
            result = await pool.query("SELECT * FROM posts ORDER BY id DESC LIMIT 1");
        } else {
            result = await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        }
        
        if (result.rows.length > 0) {
            const post = result.rows[0];
            await pool.query("UPDATE posts SET clicks = clicks + 1 WHERE id = $1", [post.id]);
            
            const targetUrl = type === 'ad' ? post.ad_link : post.content_link;
            res.redirect(getValidUrl(targetUrl));
        } else {
            res.status(404).send("Link not found");
        }
    } catch (err) {
        console.error("Out Route Error:", err);
        res.status(500).send("Server Error");
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Server is running'));
