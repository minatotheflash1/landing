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
                views INT DEFAULT 0,
                clicks INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;").catch(()=>{"ignore"});
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("DB Setup Error:", err);
    }
};
setupDB();

const generateSlug = () => crypto.randomBytes(4).toString('hex');

// Telegram Bot Setup
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const userStates = {};

const getImgSrc = (thumbnail) => {
    if (!thumbnail) return '';
    if (thumbnail.startsWith('http')) return thumbnail;
    return `/image/${thumbnail}`;
};

const sendMainMenu = (chatId) => {
    bot.sendMessage(chatId, "🛠 *Admin Dashboard*\nSelect an option below, Boss:", {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "➕ Add New Post", callback_data: "add_post" }],
                [{ text: "📁 Manage Posts", callback_data: "manage_posts" }, { text: "📊 Total Stats", callback_data: "total_stats" }]
            ]
        }
    });
};

bot.onText(/\/start/, (msg) => {
    delete userStates[msg.chat.id]; 
    sendMainMenu(msg.chat.id);
});

bot.onText(/\/addpost/, (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = { step: 'AWAITING_THUMBNAIL' };
    bot.sendMessage(chatId, "Step 1: Movie er chobi upload (photo send) korun ba thumbnail URL send korun:");
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!userStates[chatId] || (msg.text && msg.text.startsWith('/'))) return;

    const state = userStates[chatId];

    if (state.step === 'AWAITING_THUMBNAIL') {
        if (msg.photo && msg.photo.length > 0) {
            state.thumbnail = msg.photo[msg.photo.length - 1].file_id;
        } else if (msg.text) {
            state.thumbnail = msg.text.trim();
        } else {
            return bot.sendMessage(chatId, "Doya kore ekta chobi upload korun ba URL send korun.");
        }
        state.step = 'AWAITING_AD_LINK';
        bot.sendMessage(chatId, "Step 2: Thumbnail peyechi. Ekhon Adsterra link send korun:");
    } 
    else if (state.step === 'AWAITING_AD_LINK') {
        state.adLink = msg.text.trim();
        state.step = 'AWAITING_CONTENT_LINK';
        bot.sendMessage(chatId, "Step 3: Adsterra link peyechi. Ekhon main movie link send korun:");
    } 
    else if (state.step === 'AWAITING_CONTENT_LINK') {
        state.contentLink = msg.text.trim();
        state.step = 'AWAITING_TITLE';
        bot.sendMessage(chatId, "Step 4: Main movie link peyechi.\n\nEkhon apnar pochhondo moto ekta *Title* likhun.\n*(Jodi apni chan DeepSeek AI theke auto generate hok, tahole shudhu `auto` likhe send korun)*", { parse_mode: "Markdown" });
    }
    else if (state.step === 'AWAITING_TITLE') {
        let title = msg.text.trim();
        const isAuto = title.toLowerCase() === 'auto';
        
        bot.sendMessage(chatId, isAuto ? "DeepSeek theke auto title generate kora hocche..." : "Processing your post...");

        try {
            if (isAuto) {
                const aiResponse = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                    model: "deepseek-chat",
                    messages: [{ role: "user", content: "Generate a catchy movie title or streaming headline for a trending video (Max 6 words). Do not use quotes." }]
                }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

                title = aiResponse.data.choices[0].message.content.trim();
            }

            const slug = generateSlug(); 

            await pool.query(
                "INSERT INTO posts (slug, title, thumbnail, ad_link, content_link) VALUES ($1, $2, $3, $4, $5)",
                [slug, title, state.thumbnail, state.adLink, state.contentLink]
            );

            const postUrl = `${process.env.WEBSITE_URL}/post/${slug}`;
            
            bot.sendMessage(chatId, `✅ *Post Live!*\n\n*Title:* ${title}\n*Link:* ${postUrl}`, { parse_mode: "Markdown" });
            delete userStates[chatId];
            sendMainMenu(chatId);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "Error! Title generation ba DB te somossa hoyeche.");
            delete userStates[chatId];
        }
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (data === "add_post") {
        userStates[chatId] = { step: 'AWAITING_THUMBNAIL' };
        bot.sendMessage(chatId, "Step 1: Movie er chobi upload korun ba URL send korun:");
    } else if (data === "total_stats") {
        const result = await pool.query("SELECT COUNT(id) as total_posts, SUM(views) as total_views, SUM(clicks) as total_clicks FROM posts");
        const stats = result.rows[0];
        bot.sendMessage(chatId, `📊 *REAL Statistics*\n\nTotal Movies: ${stats.total_posts}\nExact Views: ${stats.total_views || 0}\nExact Clicks: ${stats.total_clicks || 0}`, { parse_mode: "Markdown" });
    } else if (data === "manage_posts") {
        const result = await pool.query("SELECT slug, title FROM posts ORDER BY id DESC LIMIT 5");
        if(result.rows.length === 0) return bot.sendMessage(chatId, "No posts available.");
        
        let inline_keyboard = result.rows.map(post => [
            { text: `🗑 Del: ${post.title.substring(0,10)}`, callback_data: `del_${post.slug}` },
            { text: `📊 Stats`, callback_data: `stat_${post.slug}` }
        ]);
        bot.sendMessage(chatId, "📁 Latest 5 Movies", { reply_markup: { inline_keyboard } });
    } else if (data.startsWith("del_")) {
        const slug = data.replace("del_", "");
        await pool.query("DELETE FROM posts WHERE slug = $1", [slug]);
        bot.sendMessage(chatId, `✅ Post deleted successfully.`);
    } else if (data.startsWith("stat_")) {
        const slug = data.replace("stat_", "");
        const result = await pool.query("SELECT title, views, clicks FROM posts WHERE slug = $1", [slug]);
        if(result.rows.length > 0) {
            bot.sendMessage(chatId, `*Stats*\nTitle: ${result.rows[0].title}\nViews: ${result.rows[0].views}\nClicks: ${result.rows[0].clicks}`, { parse_mode: "Markdown" });
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
        res.status(404).send("Image not found");
    }
});

// Helper for Country Name
const getCountryName = (code) => {
    const countries = { "BD": "Bangladesh", "IN": "India", "US": "USA", "GB": "UK" };
    return countries[code] || "Your Region";
};

// --- UI GENERATOR FUNCTIONS ---
const formatFakeViews = (realViews) => {
    const baseViews = 312400; 
    const total = baseViews + realViews;
    return (total / 1000).toFixed(1) + "K";
};

const getHeader = (title) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title}</title>
    <style>
        body { margin: 0; background: #080808; color: #fff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding-bottom: 70px; overflow-x: hidden; }
        .nav { padding: 15px 20px; background: rgba(0,0,0,0.95); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #222; position: sticky; top: 0; z-index: 50; box-shadow: 0 4px 20px rgba(0,0,0,0.7); }
        .nav-logo { display: flex; align-items: center; gap: 10px; color: #e50914; text-decoration: none; font-size: 24px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
        .nav-icons { display: flex; gap: 15px; align-items: center; }
        
        /* Fake Cast Icon */
        .cast-icon { width: 24px; height: 24px; border: 2px solid #ccc; border-radius: 4px; position: relative; cursor: pointer; }
        .cast-icon::after { content: ''; position: absolute; bottom: 2px; left: 2px; width: 8px; height: 8px; border-left: 2px solid #ccc; border-bottom: 2px solid #ccc; border-radius: 0 0 0 100%; }
        .cast-icon::before { content: ''; position: absolute; bottom: 2px; left: 2px; width: 14px; height: 14px; border-left: 2px solid #ccc; border-bottom: 2px solid #ccc; border-radius: 0 0 0 100%; }

        .search { display: flex; width: 100%; max-width: 280px; }
        .search input { padding: 10px 15px; width: 100%; border-radius: 25px 0 0 25px; border: 1px solid #333; outline: none; background: #1a1a1a; color: white; font-size: 14px; transition: border 0.3s; }
        .search input:focus { border-color: #e50914; }
        .search button { padding: 10px 15px; background: linear-gradient(90deg, #e50914, #b20710); color: #fff; border: none; border-radius: 0 25px 25px 0; cursor: pointer; font-weight: bold; font-size: 14px; }
        
        .container { padding: 20px; max-width: 1200px; margin: auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; padding: 20px 0; }
        
        .card { background: #141414; border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.3s; position: relative; border: 1px solid #2a2a2a; }
        .card:hover { transform: translateY(-5px); box-shadow: 0 8px 25px rgba(229,9,20,0.2); border-color: #e50914; }
        
        .card-img-wrapper { width: 100%; aspect-ratio: 2/3; position: relative; overflow: hidden; }
        .card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.5s ease; }
        .card:hover img { transform: scale(1.1); }
        
        /* Progress Bar (Continue Watching feel) */
        .progress-bar-bg { position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: rgba(255,255,255,0.3); }
        .progress-bar-fill { height: 100%; background: #e50914; }
        
        .badge { position: absolute; top: 10px; left: 10px; background: linear-gradient(45deg, #e50914, #ff4b4b); color: white; padding: 4px 8px; font-size: 11px; font-weight: bold; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); z-index: 2; }
        
        .card-content { padding: 15px; position: relative; z-index: 2; }
        .card-title { font-size: 15px; font-weight: bold; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f1f1f1; }
        .card-meta { font-size: 12px; color: #888; display: flex; justify-content: space-between; align-items: center; }

        .toast { position: fixed; bottom: -100px; left: 20px; background: rgba(0,0,0,0.95); border-left: 4px solid #e50914; padding: 15px 20px; border-radius: 8px; box-shadow: 0 5px 25px rgba(0,0,0,0.8); transition: bottom 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55); z-index: 1000; font-size: 14px; display: flex; align-items: center; gap: 12px; }
        .toast.show { bottom: 20px; }
        .toast-icon { width: 10px; height: 10px; background: #00ff00; border-radius: 50%; box-shadow: 0 0 8px #00ff00; }

        @media (max-width: 600px) { 
            .nav { flex-direction: column; gap: 15px; padding: 15px; } 
            .nav-icons { display: none; }
            .search { max-width: 100%; }
            .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
            .toast { left: 10px; right: 10px; text-align: center; justify-content: center; }
        }
    </style>
</head>
<body>
    <div class="nav">
        <a href="/" class="nav-logo">⚡ AURA STREAM</a>
        <div class="nav-icons">
            <div class="cast-icon"></div>
        </div>
        <form class="search" action="/" method="GET">
            <input type="text" name="q" placeholder="Search movies, shows...">
            <button type="submit">Search</button>
        </form>
    </div>
    
    <div id="liveToast" class="toast">
        <div class="toast-icon"></div>
        <span id="toastMsg">User just started watching...</span>
    </div>

    <script>
        const names = ["Rahul", "Sakib", "John", "Priya", "Aman", "Rohan", "Alex", "Fatima", "Arif", "Hasan"];
        const cities = ["Dhaka", "Mumbai", "London", "Kolkata", "Delhi", "Toronto", "New York", "Sylhet"];
        const actions = ["started watching", "downloaded HD", "is streaming 4K"];
        
        function showToast() {
            const toast = document.getElementById('liveToast');
            const name = names[Math.floor(Math.random() * names.length)];
            const city = cities[Math.floor(Math.random() * cities.length)];
            const action = actions[Math.floor(Math.random() * actions.length)];
            
            document.getElementById('toastMsg').innerHTML = \`<b>\${name}</b> from <b>\${city}</b> just \${action}...\`;
            
            toast.classList.add('show');
            setTimeout(() => { toast.classList.remove('show'); }, 4000);
        }
        setInterval(showToast, Math.floor(Math.random() * 8000) + 7000);
    </script>
`;

const renderCards = (posts) => {
    return posts.map(post => {
        const fakeViews = formatFakeViews(post.views);
        const postLink = post.slug ? post.slug : post.id; 
        const randomProgress = Math.floor(Math.random() * 60) + 20; 
        
        return \`
        <div class="card" onclick="window.location.href='/post/\${postLink}'">
            <div class="badge">4K ULTRA</div>
            <div class="card-img-wrapper">
                <img src="\${getImgSrc(post.thumbnail)}" alt="poster" loading="lazy">
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: \${randomProgress}%;"></div>
                </div>
            </div>
            <div class="card-content">
                <div class="card-title">\${post.title}</div>
                <div class="card-meta">
                    <span>👁 \${fakeViews}</span>
                    <span style="background: #333; padding: 2px 6px; border-radius: 3px; font-size: 10px; color: #fff;">CC / EN</span>
                </div>
            </div>
        </div>
        \`;
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

        res.send(`
            ${getHeader('Aura Stream - Premium HD Movies')}
            <div class="container">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px;">
                    <h2 style="margin: 0; font-size: 22px; color: #fff; border-left: 4px solid #e50914; padding-left: 12px;">
                        ${searchQuery ? 'Search Results' : '🔥 Continue Watching & Trending'}
                    </h2>
                </div>
                <div class="grid">${renderCards(posts) || '<p style="color:#666; text-align: center; width: 100%; margin-top: 50px;">No movies found.</p>'}</div>
            </div>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

app.get('/post/:slug', async (req, res) => {
    const { slug } = req.params;
    
    try {
        const result = await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        
        const post = result.rows[0];
        pool.query("UPDATE posts SET views = views + 1 WHERE id = $1", [post.id]).catch(e => console.error(e));

        const recResult = await pool.query("SELECT * FROM posts WHERE id != $1 ORDER BY RANDOM() LIMIT 4", [post.id]);
        const recommendedHtml = renderCards(recResult.rows);

        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
        const countryCode = geoip.lookup(ip)?.country || 'Unknown';
        const countryName = getCountryName(countryCode);

        let lang = {
            msg: "Choose a secure server below to start streaming immediately.",
            modalTitle: "Sponsor Verification",
            modalDesc: "To unlock the high-speed server and remove ads, a sponsor page has opened in a new tab. Please wait 30 seconds.",
            watchBtn: "▶ Play Movie (Resume)",
            dlBtn: "⬇ Download Quality",
            waitText: "Authenticating Stream...",
            secText: "seconds",
            unlockBtn: "✅ Stream Unlocked! Play Now"
        };

        if (countryCode === 'BD' || countryCode === 'IN') {
            lang = {
                msg: "High speed e buffering chara dekhte nicher theke play korun.",
                modalTitle: "Human Verification",
                modalDesc: "Movie ti unlock korar jonno notun tab e sponsor page e 30 second wait korun. Ei page theke ber hoben na.",
                watchBtn: "▶ Ekhani Play Korun",
                dlBtn: "⬇ Download Korun",
                waitText: "Server Connect Hocche...",
                secText: "second",
                unlockBtn: "✅ Video Ready! Play Korun"
            };
        }

        const uiFakeViews = formatFakeViews(post.views);
        const shareSlug = post.slug ? post.slug : post.id;
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        res.send(`
            ${getHeader(post.title)}
            <style>
                @keyframes slowZoom {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); }
                }
                .hero-bg {
                    width: 100%; max-height: 500px; object-fit: cover; filter: brightness(0.5); 
                    animation: slowZoom 20s infinite ease-in-out;
                }
                .play-pulse {
                    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                    width: 75px; height: 75px; background: rgba(229,9,20,0.9); border-radius: 50%; 
                    display: flex; align-items: center; justify-content: center; cursor: pointer; 
                    box-shadow: 0 0 0 0 rgba(229, 9, 20, 0.7); animation: pulse 2s infinite; z-index: 10;
                }
                @keyframes pulse {
                    0% { transform: translate(-50%, -50%) scale(0.95); box-shadow: 0 0 0 0 rgba(229, 9, 20, 0.7); }
                    70% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 0 15px rgba(229, 9, 20, 0); }
                    100% { transform: translate(-50%, -50%) scale(0.95); box-shadow: 0 0 0 0 rgba(229, 9, 20, 0); }
                }
            </style>

            <div class="container">
                <div style="max-width: 850px; margin: 0 auto; background: #111; border-radius: 12px; border: 1px solid #222; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.8);">
                    
                    <div style="position: relative; width: 100%; background: #000; border-bottom: 3px solid #e50914; overflow: hidden;">
                        <img src="${getImgSrc(post.thumbnail)}" class="hero-bg">
                        
                        <div class="play-pulse" onclick="playMovie('${shareSlug}')">
                            <div style="width: 0; height: 0; border-top: 14px solid transparent; border-bottom: 14px solid transparent; border-left: 22px solid white; margin-left: 6px;"></div>
                        </div>

                        <div style="position: absolute; top: 15px; left: 15px; background: linear-gradient(90deg, #e50914, #ff4b4b); padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: bold; color: white; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            🔥 Top #1 in ${countryName}
                        </div>
                    </div>

                    <div style="padding: 25px;">
                        <h1 style="margin: 0 0 15px 0; font-size: 28px; line-height: 1.3; color: #fff;">${post.title}</h1>
                        
                        <div style="display: flex; gap: 12px; margin-bottom: 20px; color: #ccc; font-size: 13px; flex-wrap: wrap; align-items: center;">
                            <span style="background: #222; padding: 6px 15px; border-radius: 20px;">👁 ${uiFakeViews} Views</span>
                            <span style="color: #4caf50; font-weight: bold;">98% Match</span>
                            <span style="border: 1px solid #666; padding: 2px 6px; border-radius: 3px;">1080p HD</span>
                            <span style="border: 1px solid #666; padding: 2px 6px; border-radius: 3px;">CC / Audio: EN, HI, BN</span>
                        </div>

                        <p style="color: #999; margin-bottom: 25px; font-size: 15px; line-height: 1.5; border-left: 3px solid #e50914; padding-left: 12px; background: rgba(229,9,20,0.05); padding: 12px;">
                            ${lang.msg} <br><span style="color: #666; font-size: 12px;">📅 Last Updated: ${today}</span>
                        </p>
                        
                        <div style="display: grid; grid-template-columns: 1fr; gap: 15px; margin-bottom: 20px;">
                            <button onclick="playMovie('${shareSlug}')" style="padding: 18px; background: white; color: black; border: none; border-radius: 6px; font-size: 18px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;">
                                <div style="width: 0; height: 0; border-top: 8px solid transparent; border-bottom: 8px solid transparent; border-left: 14px solid black;"></div>
                                ${lang.watchBtn}
                            </button>
                            <button onclick="playMovie('${shareSlug}')" style="padding: 16px; background: #2a2a2a; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer;">
                                ${lang.dlBtn}
                            </button>
                        </div>
                    </div>
                </div>

                <div style="margin-top: 40px;">
                    <h3 style="font-size: 22px; color: #fff; border-left: 4px solid #e50914; padding-left: 12px; margin-bottom: 20px;">More Like This</h3>
                    <div class="grid">${recommendedHtml}</div>
                </div>
            </div>

            <div id="adModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 9999; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box;">
                <div style="background: #111; padding: 35px; border-radius: 16px; width: 100%; max-width: 420px; text-align: center; border: 1px solid #333; box-shadow: 0 10px 40px rgba(229,9,20,0.4);">
                    <div style="width: 55px; height: 55px; border: 4px solid #e50914; border-top: 4px solid transparent; border-radius: 50%; margin: 0 auto 20px auto; animation: spin 1s linear infinite;"></div>
                    <h2 style="color: #fff; margin-bottom: 12px; font-size: 22px;">${lang.modalTitle}</h2>
                    <p style="color: #aaa; font-size: 15px; margin-bottom: 25px; line-height: 1.5;">${lang.modalDesc}</p>
                    
                    <div id="timerText" style="font-size: 16px; color: #ccc; margin-bottom: 25px; background: #1a1a1a; padding: 20px; border-radius: 10px; border: 1px solid #333;">
                        ${lang.waitText} <br><span id="countdown" style="color: #e50914; font-size: 38px; font-weight: bold; display: inline-block; margin-top: 10px;">30</span>
                    </div>
                    
                    <button id="unlockBtn" style="display: none; width: 100%; padding: 18px; background: linear-gradient(90deg, #28a745, #218838); color: white; border: none; border-radius: 10px; font-size: 18px; font-weight: bold; cursor: pointer; box-shadow: 0 5px 15px rgba(40,167,69,0.3);">
                        ${lang.unlockBtn}
                    </button>
                </div>
            </div>

            <style>
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>

            <script>
                const slug = '${shareSlug}';
                const adUrl = '/out/' + slug + '?type=ad';
                const movieUrl = '/out/' + slug + '?type=content';

                document.addEventListener('click', function(e) {
                    if(!localStorage.getItem('page_clicked_' + slug) && !e.target.closest('#adModal')) {
                        localStorage.setItem('page_clicked_' + slug, 'true');
                        let newTab = window.open(adUrl, '_blank'); 
                        if(newTab) window.focus(); 
                    }
                });

                function playMovie(slug) {
                    const adSeen = localStorage.getItem('ad_seen_' + slug);

                    if (!adSeen) {
                        document.getElementById('adModal').style.display = 'flex';
                        
                        let newTab = window.open(adUrl, '_blank');
                        if(newTab) window.focus(); 

                        localStorage.setItem('ad_seen_' + slug, 'true');
                        
                        let timeLeft = 30;
                        const counterEl = document.getElementById('countdown');
                        const timerText = document.getElementById('timerText');
                        const unlockBtn = document.getElementById('unlockBtn');
                        
                        const timer = setInterval(() => {
                            timeLeft--;
                            if(timeLeft > 0) {
                                counterEl.innerText = timeLeft;
                            } else {
                                clearInterval(timer);
                                timerText.style.display = 'none';
                                document.querySelector('.fa-spinner')?.remove(); 
                                unlockBtn.style.display = 'block';
                                
                                unlockBtn.onclick = function() {
                                    window.location.href = movieUrl;
                                }
                            }
                        }, 1000);
                    } else {
                        window.location.href = movieUrl;
                    }
                }
            </script>
            </body></html>
        `);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error");
    }
});

app.get('/out/:slug', async (req, res) => {
    const { slug } = req.params;
    const type = req.query.type;
    try {
        const result = await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        if (result.rows.length > 0) {
            const post = result.rows[0];
            await pool.query("UPDATE posts SET clicks = clicks + 1 WHERE id = $1", [post.id]);
            res.redirect(type === 'ad' ? post.ad_link : post.content_link);
        } else {
            res.status(404).send("Link not found");
        }
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Server is running'));
