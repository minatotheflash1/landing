require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const geoip = require('geoip-lite');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); 
app.use(cors());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: "Too many requests from this IP, please try again later."
});
app.use(limiter);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000
});

let exactTotalVisits = 0;

// Auto icon assign for platforms
const gcIcons = {
    "Google Play": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d0/Google_Play_Arrow_logo.svg/512px-Google_Play_Arrow_logo.svg.png",
    "Amazon": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Amazon_logo.svg/512px-Amazon_logo.svg.png",
    "UniPin": "https://play-lh.googleusercontent.com/Qh0XoNioS5K7zZ_9oY70IebZl_q42-sJ2-3jS_P_b_I7xO_b9_m-R_G_z_vP_i_C_g=w240-h480-rw",
    "Apple Pay": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Apple_Pay_logo.svg/512px-Apple_Pay_logo.svg.png",
    "Steam": "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png",
    "Roblox": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Roblox_player_icon_black.svg/512px-Roblox_player_icon_black.svg.png",
    "PlayStation": "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/PlayStation_logo.svg/512px-PlayStation_logo.svg.png",
    "Xbox": "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/Xbox_one_logo.svg/512px-Xbox_one_logo.svg.png"
};

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
        // Upgrade tables dynamically
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT;").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'photo';").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'anime';").catch(()=>{"ignore"});
        
        await pool.query("INSERT INTO settings (key, value) VALUES ('total_visits', '0') ON CONFLICT DO NOTHING").catch(()=>{"ignore"});
        
        const visitRes = await pool.query("SELECT value FROM settings WHERE key = 'total_visits'");
        if(visitRes.rows.length > 0) exactTotalVisits = parseInt(visitRes.rows[0].value) || 0;

        console.log("Database initialized and polished successfully.");
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

const AD_POPUNDER = `<script src="https://watchingprefecture.com/8b/68/3d/8b683d2f51d3f07afad4fe0599539b5b.js"></script>`;
const AD_SOCIAL_BAR = `<script src="https://watchingprefecture.com/97/65/84/9765849a19d69df50b6273f7a2477c7c.js"></script>`;
const AD_NATIVE_BANNER = `<script async="async" data-cfasync="false" src="https://watchingprefecture.com/f8e4e7aac8b848ebc1897089138e92ae/invoke.js"></script><div id="container-f8e4e7aac8b848ebc1897089138e92ae"></div>`;

const bootLink1 = "https://watchingprefecture.com/frdcc5tt?key=eb74a3263961d6a2dd0b1af92384fab6";
const link3 = "https://watchingprefecture.com/narj94mqa7?key=e1d970186b27618a729bae48455d4f53";

const activeUsersMap = new Map();

const trackActiveUser = (ip) => {
    activeUsersMap.set(ip, Date.now());
};

const getActiveUsersCount = () => {
    const now = Date.now();
    let count = 0;
    for (let [ip, timestamp] of activeUsersMap.entries()) {
        if (now - timestamp < 60000) { count++; } 
        else { activeUsersMap.delete(ip); }
    }
    return count > 0 ? count : 1; 
};

app.use((req, res, next) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    
    if (!activeUsersMap.has(ip)) {
        exactTotalVisits++;
        pool.query("UPDATE settings SET value = $1 WHERE key = 'total_visits'", [exactTotalVisits.toString()]).catch(()=>{});
    }
    
    trackActiveUser(ip);
    next();
});

const getSiteNotice = async () => {
    try {
        const res = await pool.query("SELECT value FROM settings WHERE key = 'site_notice'");
        if (res.rows.length > 0 && res.rows[0].value) return res.rows[0].value;
    } catch (e) {}
    return "Watch Premium Subbed and Dubbed Anime for Free. VIP Servers running!";
};

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    if (error.code && error.code.includes('ETELEGRAM')) return;
});

const userStates = {};

const getImgSrc = (thumbnail) => {
    if (!thumbnail) return '';
    if (thumbnail.startsWith('http')) return thumbnail;
    return `/image/${thumbnail}`;
};

const sendMainMenu = async (chatId) => {
    const postRes = await pool.query("SELECT COUNT(id) as total_posts, SUM(clicks) as total_clicks FROM posts");
    const totalPosts = postRes.rows[0].total_posts || 0;
    const totalClicks = postRes.rows[0].total_clicks || 0;
    const activeNow = getActiveUsersCount();

    const menuMessage = 
        `[System Executive Dashboard]\n` +
        `------------------------\n` +
        `Admin ID: ${chatId}\n\n` +
        `Live Active Users: ${activeNow}\n` +
        `Exact Site Visits: ${exactTotalVisits.toLocaleString()}\n` +
        `Exact Total Clicks: ${totalClicks.toLocaleString()}\n` +
        `Total Published Posts: ${totalPosts}\n` +
        `------------------------\n` +
        `Select an option below. Type /cancel anytime to reset state:`;

    bot.sendMessage(chatId, menuMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "▶️ Add New Anime / Episode", callback_data: "add_post" }],
                [{ text: "🎁 Add Giftcard Code(s)", callback_data: "add_giftcard" }],
                [{ text: "Set Scrolling Site Notice", callback_data: "set_notice" }],
                [{ text: "Detailed Global Website Stats", callback_data: "total_stats" }],
                [{ text: "Manage Library Posts", callback_data: "manage_posts" }, { text: "Hard Reset Stats", callback_data: "reset_stats" }]
            ]
        }
    });
};

bot.onText(/\/start/, (msg) => {
    delete userStates[msg.chat.id]; 
    sendMainMenu(msg.chat.id);
});

bot.onText(/\/cancel/, (msg) => {
    if (userStates[msg.chat.id]) {
        delete userStates[msg.chat.id];
        bot.sendMessage(msg.chat.id, "Action cancelled. State reset successfully. Type /start to open menu.");
    } else {
        bot.sendMessage(msg.chat.id, "No active action to cancel. Type /start to open menu.");
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!userStates[chatId] || (msg.text && msg.text.startsWith('/'))) return;

    const state = userStates[chatId];

    // Anime Upload Flow
    if (state.step === 'AWAITING_THUMBNAIL') {
        if (msg.video) { state.thumbnail = msg.video.file_id; state.media_type = 'video'; } 
        else if (msg.animation) { state.thumbnail = msg.animation.file_id; state.media_type = 'video'; } 
        else if (msg.photo && msg.photo.length > 0) { state.thumbnail = msg.photo[msg.photo.length - 1].file_id; state.media_type = 'photo'; } 
        else if (msg.text) { state.thumbnail = msg.text.trim(); state.media_type = msg.text.trim().match(/\.(mp4|webm|mkv)$/i) ? 'video' : 'photo'; } 
        else return bot.sendMessage(chatId, "[Error] Invalid input. Please upload a clear image, video, or URL.");
        
        state.step = 'AWAITING_AD_LINK';
        bot.sendMessage(chatId, `[Step 2/4] Anime Media Registered.\n\nEkhon apnar targeted Adsterra / Sponsor Link ti reply text e send korun:`, { parse_mode: "Markdown" });
    } 
    else if (state.step === 'AWAITING_AD_LINK') {
        state.adLink = msg.text.trim();
        state.step = 'AWAITING_CONTENT_LINK';
        bot.sendMessage(chatId, `[Step 3/4] Ad Link Saved.\n\nEkhon Main Anime / Destination Content Link ti pathan ba video upload korun:`, { parse_mode: "Markdown" });
    } 
    else if (state.step === 'AWAITING_CONTENT_LINK') {
        if (msg.video || msg.document) {
            const fileId = msg.video ? msg.video.file_id : msg.document.file_id;
            state.contentLink = 'TG_VID:' + fileId;
            bot.sendMessage(chatId, "[Success] Direct Telegram Video properly linked.");
        } else if (msg.text) {
            state.contentLink = msg.text.trim();
        } else {
            return bot.sendMessage(chatId, "[Error] Inputs criteria mismatched.");
        }
        
        state.step = 'AWAITING_TITLE';
        bot.sendMessage(chatId, `[Step 4/4] Target Title Initialization.\n\nApnar metadata setup title ti type korun. AI auto genarate korte shudhu 'auto' likhe send korun.`, { parse_mode: "Markdown" });
    }
    else if (state.step === 'AWAITING_TITLE') {
        let inputTitle = msg.text.trim();
        const isAuto = inputTitle.toLowerCase() === 'auto';
        bot.sendMessage(chatId, "[System] DeepSeek AI is processing High CPM SEO keywords and titles...", { parse_mode: "Markdown" });

        try {
            let finalTitle = inputTitle;
            let generatedTags = "Anime, HD, Subbed, Dubbed, Watch Online, High Quality"; 
            
            // 🔥 High CPM DeepSeek Prompt
            const aiResponse = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "user", content: `I am adding an anime/movie to my site. Generate a JSON object: 1. "title": Catchy streaming headline (max 6 words). Only generate if I say 'auto', otherwise return "${inputTitle}". 2. "tags": 10 Highly profitable (High CPM), high search volume SEO keywords separated by commas (mix anime terms with profitable ad terms). Respond strictly in raw JSON without markdown. Example: {"title": "The Title", "tags": "Tag1, Tag2"}` }]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            try {
                const parsedData = JSON.parse(aiResponse.data.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, ''));
                if (isAuto && parsedData.title) finalTitle = parsedData.title;
                if (parsedData.tags) generatedTags = parsedData.tags;
            } catch (e) {}

            const slug = generateSlug(); 
            await pool.query(
                "INSERT INTO posts (slug, title, thumbnail, ad_link, content_link, tags, media_type, category) VALUES ($1, $2, $3, $4, $5, $6, $7, 'anime')",
                [slug, finalTitle, state.thumbnail, state.adLink, state.contentLink, generatedTags, state.media_type]
            );

            // 🔥 Proper GSC indexing link output
            const finalUrl = `https://watchmovie.pro/post/${slug}`;
            const statusReport = `[Anime Deployment Successful]\nHeadline: ${finalTitle}\n\n🔗 *Copy this exact link for Google Search Console (URL Inspection):*\n${finalUrl}`;
            
            bot.sendMessage(chatId, statusReport, { parse_mode: "Markdown" });
            delete userStates[chatId]; sendMainMenu(chatId);
        } catch (error) {
            bot.sendMessage(chatId, "[Critical Error] AI Core pipeline interruption."); delete userStates[chatId];
        }
    }
    
    // Giftcard Upload Flow
    else if (state.step === 'AWAITING_GC_CODES') {
        state.codes = msg.text.trim().split('\n').map(c => c.trim()).filter(c => c !== '');
        if (state.codes.length === 0) return bot.sendMessage(chatId, "Code khuje pawa jayni. Abar try korun:");
        
        state.step = 'AWAITING_GC_AD_LINK';
        bot.sendMessage(chatId, `[Step 2/2] ${state.codes.length} ta code received hoyeche.\n\nEkhon shudhu ekta Adsterra / Direct ad link send korun jeta ei sob code er sathe auto jukto hobe:`, { parse_mode: "Markdown" });
    }
    else if (state.step === 'AWAITING_GC_AD_LINK') {
        const adLink = msg.text.trim();
        bot.sendMessage(chatId, `[System] Processing ${state.codes.length} Giftcard post(s) to the database...`, { parse_mode: "Markdown" });
        
        try {
            const icon = gcIcons[state.platform] || "https://cdn-icons-png.flaticon.com/512/2651/2651082.png";
            // 🔥 High CPM Tags hardcoded for giftcards
            const tags = `${state.platform}, Giftcard, Free, Make Money Online, Crypto, Insurance, Code, Reward, Topup, Generator`;
            
            let generatedLinks = [];
            for (let i = 0; i < state.codes.length; i++) {
                const codeText = state.codes[i];
                const slug = generateSlug();
                const title = `Free ${state.platform} Gift Card Code (Working)`;
                
                await pool.query(
                    "INSERT INTO posts (slug, title, thumbnail, ad_link, content_link, tags, media_type, category) VALUES ($1, $2, $3, $4, $5, $6, 'photo', 'giftcard')",
                    [slug, title, icon, adLink, codeText, tags]
                );
                generatedLinks.push(`https://watchmovie.pro/post/${slug}`);
            }
            
            // Format GSC links for output
            let linksMsg = generatedLinks.slice(0, 10).join("\n");
            if(generatedLinks.length > 10) linksMsg += `\n...and ${generatedLinks.length - 10} more links.`;

            bot.sendMessage(chatId, `[Success] ${state.codes.length} ta Giftcard post ek-sathe live kora hoyeche!\n\n🔗 *Copy links below for Google Search Console (URL Inspection):*\n${linksMsg}`, { parse_mode: "Markdown" });
            delete userStates[chatId]; sendMainMenu(chatId);
        } catch (err) {
            bot.sendMessage(chatId, "[Error] Database e insert korte somosya hoyeche."); delete userStates[chatId];
        }
    }
    
    // Notice Update
    else if (state.step === 'AWAITING_NOTICE') {
        const noticeText = msg.text.trim();
        try {
            await pool.query("INSERT INTO settings (key, value) VALUES ('site_notice', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [noticeText]);
            bot.sendMessage(chatId, `[Success] Site marquee ticker system notification successfully overwritten.`, { parse_mode: "Markdown" });
        } catch (err) {}
        delete userStates[chatId]; sendMainMenu(chatId);
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (data === "add_post") { 
        userStates[chatId] = { step: 'AWAITING_THUMBNAIL' }; 
        bot.sendMessage(chatId, "[Anime Upload Sequence]\nStep 1: Apnar dynamic stream thumbnail upload korun (Supports MP4, GIF, JPEG, PNG):", { parse_mode: "Markdown" }); 
    } 
    else if (data === "add_giftcard") {
        bot.sendMessage(chatId, "Kon platform er Giftcard code add korben select korun:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Google Play", callback_data: "gc_Google Play" }, { text: "Amazon", callback_data: "gc_Amazon" }],
                    [{ text: "UniPin", callback_data: "gc_UniPin" }, { text: "Apple Pay", callback_data: "gc_Apple Pay" }],
                    [{ text: "Steam", callback_data: "gc_Steam" }, { text: "Roblox", callback_data: "gc_Roblox" }],
                    [{ text: "PlayStation", callback_data: "gc_PlayStation" }, { text: "Xbox", callback_data: "gc_Xbox" }]
                ]
            }
        });
    }
    else if (data.startsWith("gc_")) {
        const platform = data.replace("gc_", "");
        userStates[chatId] = { step: 'AWAITING_GC_CODES', platform: platform };
        bot.sendMessage(chatId, `[${platform} Selected]\n\nEbar gift card er code(s) gulo send korun.\n(Ekadhik post korte chaile protita code new line ba enter diye niche niche likhun. Mass upload auto support korbe):`);
    }
    else if (data === "set_notice") { 
        userStates[chatId] = { step: 'AWAITING_NOTICE' }; 
        bot.sendMessage(chatId, "[Global Interactive Marquee Input]\nWebsite system header navigation slider banner text ti ki pathate chan type korun:", { parse_mode: "Markdown" }); 
    } 
    else if (data === "total_stats") {
        const result = await pool.query("SELECT COUNT(id) as total_posts, SUM(views) as total_views, SUM(clicks) as total_clicks FROM posts");
        const panelStats = 
            `[DATABASE DEEP AUDIT ANALYTICS]\n` +
            `------------------------\n` +
            `Live Active Connections: ${getActiveUsersCount()}\n` +
            `Exact Unique Web Traffic: ${exactTotalVisits.toLocaleString()}\n\n` +
            `Total Index Cataloged Posts: ${result.rows[0].total_posts || 0}\n` +
            `Accumulated Structural Views: ${(result.rows[0].total_views || 0).toLocaleString()}\n` +
            `Monetized Verified Clicks: ${(result.rows[0].total_clicks || 0).toLocaleString()}\n` +
            `------------------------`;
        bot.sendMessage(chatId, panelStats, { parse_mode: "Markdown" });
    } 
    else if (data === "manage_posts") {
        const result = await pool.query("SELECT id, title FROM posts ORDER BY id DESC LIMIT 5");
        if(result.rows.length === 0) return bot.sendMessage(chatId, "System directory list is empty.");
        let inline_keyboard = result.rows.map(post => [ { text: `[Delete]: ${post.title.substring(0,14)}...`, callback_data: `del_${post.id}` }, { text: `[Stats]`, callback_data: `stat_${post.id}` } ]);
        bot.sendMessage(chatId, "[Latest 5 System Node Catalog Entries]:", { parse_mode: "Markdown", reply_markup: { inline_keyboard } });
    } 
    else if (data === "reset_stats") {
        await pool.query("UPDATE posts SET views = 0, clicks = 0");
        exactTotalVisits = 0;
        await pool.query("UPDATE settings SET value = '0' WHERE key = 'total_visits'").catch(()=>{});
        bot.sendMessage(chatId, `[System Alert] Operations data wipe successfully committed. Analytics counters rolled back to 0.`);
    } 
    else if (data.startsWith("del_")) { 
        await pool.query("DELETE FROM posts WHERE id = $1", [data.replace("del_", "")]); 
        bot.sendMessage(chatId, `[Success] Post node cleanly purged from data blocks cluster.`); 
    } 
    else if (data.startsWith("stat_")) {
        const result = await pool.query("SELECT title, views, clicks FROM posts WHERE id = $1", [data.replace("stat_", "")]);
        if(result.rows.length > 0) {
            const specificStats = 
                `[ISOLATED TARGET DATA METRICS]\n` +
                `------------------------\n` +
                `Title: ${result.rows[0].title}\n\n` +
                `Unique Raw Views: ${(result.rows[0].views || 0).toLocaleString()}\n` +
                `Monetized Route Clicks: ${(result.rows[0].clicks || 0).toLocaleString()}\n` +
                `------------------------`;
            bot.sendMessage(chatId, specificStats, { parse_mode: "Markdown" });
        }
    }
    bot.answerCallbackQuery(callbackQuery.id);
});

// Favicon Route
app.get('/favicon.ico', (req, res) => {
    const extensions = ['.png', '.jpg', '.jpeg', '.ico'];
    for (let ext of extensions) {
        const filePath = path.join(__dirname, 'icon' + ext);
        if (fs.existsSync(filePath)) {
            return res.sendFile(filePath);
        }
    }
    res.status(204).end(); 
});

app.get('/image/:file_id', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.file_id);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(res);
    } catch (err) { res.status(404).send("Stream block unavailable"); }
});

app.get('/stream/:file_id', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.file_id);
        const headers = req.headers.range ? { Range: req.headers.range } : {};
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream', headers: headers });
        
        if(response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        if(response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if(response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        if(response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        
        res.status(response.status);
        response.data.pipe(res);
    } catch (err) { res.status(500).send("Buffer stream error or exceeded structural file guidelines"); }
});

app.get('/download/:file_id', async (req, res) => {
    try {
        const fileLink = await bot.getFileLink(req.params.file_id);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        res.setHeader('Content-Disposition', 'attachment; filename="AnimeHub_PremiumUltra.mp4"');
        response.data.pipe(res);
    } catch (err) { res.status(500).send("Data bridge download allocation execution error"); }
});

const formatFakeViews = (realViews, postId) => {
    const seed = postId ? parseInt(postId) : 1;
    const baseViews = 50000 + ((seed * 8734) % 40000); 
    const total = baseViews + realViews;
    return (total / 1000).toFixed(1) + "K";
};

const getFakeRating = (postId) => (4.3 + (((postId ? parseInt(postId) : 1) * 31) % 7) / 10).toFixed(1);

const getBootLogic = (targetLink) => {
    return `
    <script>
        (function() {
            var l1 = "${targetLink}";
            var clickCount = parseInt(localStorage.getItem("boot_click_count") || "0");
            var lastReset = parseInt(localStorage.getItem("boot_last_reset") || "0");
            var now = Date.now();
            
            if (!lastReset || (now - lastReset) > 1800000) { 
                clickCount = 0; localStorage.setItem("boot_last_reset", now.toString()); localStorage.setItem("boot_click_count", "0");
            }
            
            if (clickCount < 1) {
                var overlay = document.createElement("div");
                overlay.style.position = "fixed"; overlay.style.top = "0"; overlay.style.left = "0";
                overlay.style.width = "100vw"; overlay.style.height = "100vh"; overlay.style.zIndex = "9999999"; overlay.style.cursor = "pointer";
                document.body.appendChild(overlay);

                overlay.addEventListener("click", function(e) {
                    e.preventDefault(); e.stopPropagation();
                    var currentCount = parseInt(localStorage.getItem("boot_click_count") || "0");
                    if (currentCount < 1) {
                        localStorage.setItem("boot_click_count", "1");
                        localStorage.setItem("boot_last_reset", Date.now().toString());
                        window.open(l1, "_blank"); 
                        document.body.removeChild(overlay);
                    }
                });
            }
        })();
        document.addEventListener('contextmenu', event => event.preventDefault());
        document.onkeydown = function(e) { if(e.keyCode == 123 || (e.ctrlKey && e.shiftKey && (e.keyCode == 73 || e.keyCode == 67 || e.keyCode == 74)) || (e.ctrlKey && e.keyCode == 85)) return false; };
    </script>`;
};

const getHeader = (title, metaTagsStr = "", siteNotice = "", activeTab = "anime") => `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    ${metaTagsStr}
    <title>${title}</title>
    <link rel="icon" href="/favicon.ico">
    ${AD_POPUNDER}
    ${AD_SOCIAL_BAR}
    <style>
        :root {
            --bg: #070709;
            --text: #f3f4f6;
            --nav-bg: rgba(13, 13, 18, 0.85);
            --card-bg: #12121a;
            --border: rgba(255, 255, 255, 0.07);
            --primary: #ff5500;
            --primary-glow: rgba(255, 85, 0, 0.35);
            --meta: #9ca3af;
            --btn-alt: #1f1f2e;
            --card-hover: rgba(255, 85, 0, 0.05);
        }
        [data-theme="light"] {
            --bg: #f9fafb;
            --text: #111827;
            --nav-bg: rgba(255, 255, 255, 0.85);
            --card-bg: #ffffff;
            --border: rgba(0, 0, 0, 0.06);
            --primary: #ff5500;
            --primary-glow: rgba(255, 85, 0, 0.15);
            --meta: #6b7280;
            --btn-alt: #f3f4f6;
            --card-hover: rgba(0, 0, 0, 0.02);
        }
        * { box-sizing: border-box; transition: background 0.3s ease, border-color 0.3s ease; }
        body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; padding-bottom: 90px; overflow-x: hidden; user-select: none; -webkit-tap-highlight-color: transparent; }
        
        .nav { padding: 14px 24px; background: var(--nav-bg); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; flex-wrap: wrap;}
        .nav-logo { display: flex; align-items: center; text-decoration: none; font-size: 24px; font-weight: 900; letter-spacing: -0.5px; }
        .logo-part1 { background: linear-gradient(135deg, #ff7700, #ff3300); color: #fff; padding: 4px 10px; border-radius: 8px; margin-right: 5px; box-shadow: 0 4px 12px rgba(255,51,0,0.3); }
        .logo-part2 { color: var(--text); font-style: italic; }
        
        .giftcard-btn { 
            background: linear-gradient(135deg, #10b981, #059669); color: #fff; padding: 8px 18px; border-radius: 25px; 
            font-weight: 800; font-size: 14px; text-decoration: none; margin-left: 15px; 
            border: 2px solid rgba(16,185,129,0.5); box-shadow: 0 0 15px rgba(16,185,129,0.4); 
            display: flex; align-items: center; gap: 6px; animation: pulseBtn 2s infinite; 
        }
        .giftcard-btn:hover { background: linear-gradient(135deg, #059669, #047857); transform: scale(1.02); }
        
        @keyframes pulseBtn {
            0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.6); }
            70% { box-shadow: 0 0 0 12px rgba(16,185,129,0); }
            100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }

        .nav-icons { display: flex; gap: 16px; align-items: center; margin-left: auto; margin-right: 15px; }
        .theme-toggle { font-size: 14px; font-weight: bold; cursor: pointer; background: var(--btn-alt); padding: 8px 12px; border-radius: 20px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); color: var(--text); }
        .live-badge { display: flex; align-items: center; gap: 8px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); color: #10b981; font-size: 13px; font-weight: 700; padding: 6px 14px; border-radius: 30px; }
        .live-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 10px #10b981; animation: blink 1.2s infinite alternate; }
        
        .search { display: flex; width: 100%; max-width: 320px; position: relative; }
        .search input { padding: 11px 18px; width: 100%; border-radius: 30px; border: 1px solid var(--border); outline: none; background: var(--btn-alt); color: var(--text); font-size: 14px; padding-right: 85px; }
        .search button { position: absolute; right: 4px; top: 4px; bottom: 4px; border-radius: 30px; padding: 0 16px; background: linear-gradient(135deg, #ff6a00, #ff3300); color: #fff; border: none; cursor: pointer; font-weight: bold; font-size: 13px; box-shadow: 0 2px 6px rgba(255,51,0,0.2); }
        
        .marquee-container { background: rgba(255, 85, 0, 0.06); color: var(--text); padding: 8px 0; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--border); display: flex; align-items: center; }
        .marquee-tag { background: var(--primary); color: #fff; padding: 3px 8px; font-size: 11px; font-weight: 800; border-radius: 4px; margin-left: 20px; margin-right: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
        
        .container { padding: 24px; max-width: 1300px; margin: auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; padding: 20px 0; }
        
        .category-filters { display: flex; gap: 12px; margin-bottom: 20px; overflow-x: auto; padding-bottom: 5px; scrollbar-width: none; }
        .category-filters::-webkit-scrollbar { display: none; }
        .filter-btn { padding: 8px 18px; background: var(--btn-alt); color: var(--meta); border-radius: 20px; text-decoration: none; font-size: 14px; font-weight: bold; border: 1px solid var(--border); white-space: nowrap; transition: all 0.3s ease; }
        .filter-btn:hover { background: var(--card-hover); color: var(--text); }
        .filter-btn.active { background: linear-gradient(135deg, #ff6a00, #ff3300); color: #fff; border-color: transparent; box-shadow: 0 4px 10px rgba(255,85,0,0.3); }

        .card { background: var(--card-bg); border-radius: 16px; overflow: hidden; cursor: pointer; border: 1px solid var(--border); position: relative; transform: translateY(0); transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease, border-color 0.25s ease; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .card:hover { transform: translateY(-5px); box-shadow: 0 12px 20px -5px rgba(0,0,0,0.3), 0 0 15px var(--primary-glow); border-color: rgba(255,85,0,0.3); background: var(--card-hover); }
        .card-img-wrapper { width: 100%; aspect-ratio: 2/3; position: relative; background: #000; overflow: hidden; }
        .card-img-wrapper video, .card-img-wrapper img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease; }
        .card:hover .card-img-wrapper img, .card:hover .card-img-wrapper video { transform: scale(1.04); }
        
        .badge { position: absolute; top: 12px; left: 12px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); color: #fff; border: 1px solid rgba(255,255,255,0.15); padding: 4px 8px; font-size: 10px; font-weight: 800; border-radius: 6px; letter-spacing: 0.5px; z-index: 5; }
        .rating { position: absolute; top: 12px; right: 12px; background: rgba(18, 18, 26, 0.8); backdrop-filter: blur(4px); color: #ffb800; border: 1px solid rgba(255,184,0,0.25); padding: 4px 8px; font-size: 11px; font-weight: 700; border-radius: 6px; z-index: 5; display: flex; align-items: center; gap: 3px; }
        
        .card-content { padding: 14px; }
        .card-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
        .card-meta { font-size: 12px; color: var(--meta); display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .card-play-label { text-align: center; font-size: 12px; font-weight: 700; color: var(--primary); padding-top: 10px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: center; gap: 4px; }
        
        .sticky-footer { position: fixed; bottom: 0; left: 0; width: 100%; background: linear-gradient(135deg, #ff6a00, #e62e00); color: white; text-align: center; padding: 14px; font-weight: 700; font-size: 14px; z-index: 9999; cursor: pointer; box-shadow: 0 -4px 20px rgba(0,0,0,0.25); letter-spacing: 0.2px; }
        .pagination { display: flex; justify-content: center; gap: 10px; margin-top: 30px; }
        .page-btn { padding: 10px 20px; background: var(--btn-alt); color: var(--text); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; text-decoration: none; font-weight: bold; }
        .page-btn:hover { background: var(--primary); color: #fff; border-color: var(--primary); }
        
        @keyframes blink { 0% { opacity: 1; } 100% { opacity: 0.4; } }
        
        @media (max-width: 768px) {
            .nav { flex-direction: column; gap: 14px; padding: 16px; }
            .nav-logo { font-size: 22px; width: 100%; justify-content: center; }
            .search { max-width: 100%; width: 100%; }
            .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
            .nav-icons { width: 100%; justify-content: space-between; margin: 0; }
            .container { padding: 14px; }
            .giftcard-btn { margin-left: 0; width: 100%; justify-content: center; font-size: 15px; padding: 10px; }
        }
    </style>
    <script>
        if(localStorage.getItem('theme') === 'light') { document.documentElement.setAttribute('data-theme', 'light'); }
        function toggleTheme() {
            const root = document.documentElement;
            if (root.getAttribute('data-theme') === 'light') { root.removeAttribute('data-theme'); localStorage.setItem('theme', 'dark'); document.getElementById('themeIcon').innerText = '[Light]'; } 
            else { root.setAttribute('data-theme', 'light'); localStorage.setItem('theme', 'light'); document.getElementById('themeIcon').innerText = '[Dark]'; }
        }
    </script>
</head>
<body>
    <div class="nav">
        <a href="/" class="nav-logo"><span class="logo-part1">ANIME</span><span class="logo-part2">HUB</span></a>
        
        <a href="/giftcards" class="giftcard-btn">🎁 Visit MagicGiftcardZone</a>
        
        <div class="nav-icons">
            <div class="live-badge"><div class="live-dot"></div> <span id="realLiveCount">248.7K</span> Online</div>
            <div class="theme-toggle" onclick="toggleTheme()" id="themeIcon">[Light]</div>
        </div>

        <form class="search" action="${activeTab === 'giftcard' ? '/giftcards' : '/'}" method="GET">
            <input type="text" name="q" placeholder="Search ${activeTab === 'giftcard' ? 'gift cards, platforms...' : 'anime, movies, tags...'}">
            <button type="submit">Search</button>
        </form>
    </div>

    <script>
        document.addEventListener("DOMContentLoaded", function() {
            var bait = document.createElement('div');
            bait.innerHTML = ' ';
            bait.className = 'pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links';
            bait.style.position = 'absolute';
            bait.style.width = '10px';
            bait.style.height = '10px';
            bait.style.left = '-9999px';
            bait.style.top = '-9999px';
            document.body.appendChild(bait);
            
            setTimeout(function() {
                var isBlocked = false;
                if (!document.body.contains(bait)) {
                    isBlocked = true;
                } else if (bait.offsetHeight === 0 || bait.clientHeight === 0) {
                    isBlocked = true;
                } else {
                    var style = window.getComputedStyle(bait);
                    if (style.display === 'none' || style.visibility === 'hidden') {
                        isBlocked = true;
                    }
                }
                
                if (isBlocked) {
                    document.documentElement.innerHTML = '<body style="margin:0;padding:0;background:#ffffff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui, sans-serif;color:#111;"><div style="text-align:center;max-width:600px;padding:20px;">' +
                    '<h1 style="font-size:30px;font-weight:900;color:#ff3300;margin-bottom:15px;">Adblocker Detected!</h1>' +
                    '<p style="font-size:18px;line-height:1.6;color:#333;margin-bottom:25px;">Kindly disable your adblocker and refresh the page to proceed. We rely on ads to keep our premium content free for everyone.</p>' +
                    '<button onclick="location.reload()" style="padding:12px 28px;background:#ff5500;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:bold;box-shadow:0 4px 12px rgba(255,85,0,0.3);">I have disabled it, Refresh Page</button>' +
                    '</div></body>';
                } else {
                    bait.remove();
                }
            }, 600);
        });
    </script>

    <div class="marquee-container">
        <span class="marquee-tag">Notice</span>
        <marquee behavior="scroll" direction="left" scrollamount="5">${siteNotice}</marquee>
    </div>
    <div class="sticky-footer" onclick="window.open('${link3}', '_blank')">
        [Click Here] Join Our Telegram Channel For Premium Direct Daily Updates!
    </div>
    <script>
        if(localStorage.getItem('theme') === 'light') document.getElementById('themeIcon').innerText = '[Dark]';
        let baseLiveCount = 248700;
        setInterval(() => {
            baseLiveCount += Math.floor(Math.random() * 31) - 15; 
            document.getElementById('realLiveCount').innerText = (baseLiveCount / 1000).toFixed(1) + "K";
        }, 4000); 
    </script>
`;

const renderCards = (posts, isGiftcard = false) => {
    return posts.map(post => {
        const fakeViews = formatFakeViews(post.views, post.id);
        const mediaHtml = post.media_type === 'video' ? `<video src="${getImgSrc(post.thumbnail)}" autoplay muted loop playsinline></video>` : `<img src="${getImgSrc(post.thumbnail)}" alt="poster" loading="lazy">`;
        
        const badgeLabel = isGiftcard ? "FREE CODE" : "4K UHD";
        const metaLabel = isGiftcard ? "GIFTCARD" : "SUB / DUB";
        const actionLabel = isGiftcard ? "Unlock Code Now" : "Watch Full Quality";

        const viewsOrFreshHtml = isGiftcard 
            ? `<span style="color: #10b981; font-weight: 800; display: flex; align-items: center; gap: 4px;">🔥 Fresh New</span>`
            : `<span>Views: ${fakeViews}</span>`;

        return `
        <div class="card" onclick="window.location.href='/post/${post.slug ? post.slug : post.id}'">
            <div class="badge" ${isGiftcard ? 'style="background: #10b981; border: none;"' : ''}>${badgeLabel}</div>
            <div class="rating">Rating: ${getFakeRating(post.id)}</div>
            <div class="card-img-wrapper" ${isGiftcard ? 'style="background: #fff; padding: 20px;"' : ''}>${mediaHtml}</div>
            <div class="card-content">
                <div class="card-title">${post.title}</div>
                <div class="card-meta">${viewsOrFreshHtml}<span style="background: var(--btn-alt); padding: 3px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; border: 1px solid var(--border); ${isGiftcard ? 'color:#10b981; border-color:#10b981;' : ''}">${metaLabel}</span></div>
                <div class="card-play-label" ${isGiftcard ? 'style="color: #10b981;"' : ''}>${actionLabel}</div>
            </div>
        </div>
        `;
    }).join('');
};

app.get('/', async (req, res) => {
    const searchQuery = req.query.q;
    const sortParam = req.query.sort || 'latest';
    const page = parseInt(req.query.page) || 1;
    const limit = 24;
    const offset = (page - 1) * limit;

    let orderClause = 'ORDER BY id DESC';
    if (sortParam === 'views') orderClause = 'ORDER BY views DESC, id DESC';
    else if (sortParam === 'oldest') orderClause = 'ORDER BY id ASC';

    try {
        let result;
        let totalCountRes;

        if (searchQuery) {
            result = await pool.query(`SELECT * FROM posts WHERE category = 'anime' AND (title ILIKE $1 OR tags ILIKE $1) ${orderClause} LIMIT $2 OFFSET $3`, [`%${searchQuery}%`, limit, offset]);
            totalCountRes = await pool.query("SELECT COUNT(*) FROM posts WHERE category = 'anime' AND (title ILIKE $1 OR tags ILIKE $1)", [`%${searchQuery}%`]);
        } else {
            result = await pool.query(`SELECT * FROM posts WHERE category = 'anime' ${orderClause} LIMIT $1 OFFSET $2`, [limit, offset]);
            totalCountRes = await pool.query("SELECT COUNT(*) FROM posts WHERE category = 'anime'");
        }

        const totalItems = parseInt(totalCountRes.rows[0].count);
        const totalPages = Math.ceil(totalItems / limit);

        const bootScript = getBootLogic(bootLink1);
        const siteNotice = await getSiteNotice();
        const metaTags = `<meta name="description" content="Watch the latest trending anime and movies online for free in 1080p and 4K UHD.">`;

        let paginationHtml = '';
        if (totalPages > 1) {
            const queryParams = `${searchQuery ? '&q=' + searchQuery : ''}&sort=${sortParam}`;
            paginationHtml = `<div class="pagination">`;
            if (page > 1) paginationHtml += `<a href="/?page=${page - 1}${queryParams}" class="page-btn">Previous</a>`;
            if (page < totalPages) paginationHtml += `<a href="/?page=${page + 1}${queryParams}" class="page-btn">Next Page</a>`;
            paginationHtml += `</div>`;
        }

        res.send(`
            ${getHeader('AnimeHub - Premium HD Streaming', metaTags, siteNotice, 'anime')}
            <div class="container">
                <div style="margin: 5px auto 25px auto; text-align: center; min-height: 60px;">${AD_NATIVE_BANNER}</div>
                
                ${searchQuery ? `<h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 800; color: var(--text); border-left: 5px solid var(--primary); padding-left: 14px;">Search Results for "${searchQuery}"</h2>` : `
                <div class="category-filters">
                    <a href="/?sort=latest" class="filter-btn ${sortParam === 'latest' ? 'active' : ''}">Latest Releases</a>
                    <a href="/?sort=views" class="filter-btn ${sortParam === 'views' ? 'active' : ''}">Most Viewed</a>
                    <a href="/?sort=oldest" class="filter-btn ${sortParam === 'oldest' ? 'active' : ''}">Oldest</a>
                </div>`}

                <div class="grid">${renderCards(result.rows, false) || '<p style="color:var(--meta); text-align: center; width: 100%; padding: 40px 0;">No matching posts found.</p>'}</div>
                ${paginationHtml}
            </div>
            ${bootScript}
            </body></html>
        `);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/giftcards', async (req, res) => {
    const searchQuery = req.query.q;
    const sortParam = req.query.sort || 'latest';
    const page = parseInt(req.query.page) || 1;
    const limit = 24;
    const offset = (page - 1) * limit;

    let orderClause = 'ORDER BY id DESC';
    if (sortParam === 'views') orderClause = 'ORDER BY views DESC, id DESC';
    else if (sortParam === 'oldest') orderClause = 'ORDER BY id ASC';

    try {
        let result;
        let totalCountRes;

        if (searchQuery) {
            result = await pool.query(`SELECT * FROM posts WHERE category = 'giftcard' AND (title ILIKE $1 OR tags ILIKE $1) ${orderClause} LIMIT $2 OFFSET $3`, [`%${searchQuery}%`, limit, offset]);
            totalCountRes = await pool.query("SELECT COUNT(*) FROM posts WHERE category = 'giftcard' AND (title ILIKE $1 OR tags ILIKE $1)", [`%${searchQuery}%`]);
        } else {
            result = await pool.query(`SELECT * FROM posts WHERE category = 'giftcard' ${orderClause} LIMIT $1 OFFSET $2`, [limit, offset]);
            totalCountRes = await pool.query("SELECT COUNT(*) FROM posts WHERE category = 'giftcard'");
        }

        const totalItems = parseInt(totalCountRes.rows[0].count);
        const totalPages = Math.ceil(totalItems / limit);

        const bootScript = getBootLogic(link3);
        const siteNotice = await getSiteNotice();
        const metaTags = `<meta name="description" content="Get 100% working free gift card codes for Google Play, Amazon, and more at MagicGiftcardZone.">`;

        let paginationHtml = '';
        if (totalPages > 1) {
            const queryParams = `${searchQuery ? '&q=' + searchQuery : ''}&sort=${sortParam}`;
            paginationHtml = `<div class="pagination">`;
            if (page > 1) paginationHtml += `<a href="/giftcards?page=${page - 1}${queryParams}" class="page-btn">Previous</a>`;
            if (page < totalPages) paginationHtml += `<a href="/giftcards?page=${page + 1}${queryParams}" class="page-btn">Next Page</a>`;
            paginationHtml += `</div>`;
        }

        res.send(`
            ${getHeader('MagicGiftcardZone - Free Codes', metaTags, siteNotice, 'giftcard')}
            <div class="container">
                <div style="margin: 5px auto 25px auto; text-align: center; min-height: 60px;">${AD_NATIVE_BANNER}</div>
                
                <div style="background: linear-gradient(135deg, #10b981, #059669); padding: 30px; border-radius: 16px; text-align: center; margin-bottom: 30px; box-shadow: 0 10px 30px rgba(16,185,129,0.2);">
                    <h1 style="color: white; margin: 0 0 10px 0; font-size: 28px; font-weight: 900;">🎁 Welcome to MagicGiftcardZone</h1>
                    <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 16px;">Claim 100% working, daily updated premium gift card codes entirely for free.</p>
                </div>

                ${searchQuery ? `<h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 800; color: var(--text); border-left: 5px solid #10b981; padding-left: 14px;">Search Results for "${searchQuery}"</h2>` : `
                <div class="category-filters">
                    <a href="/giftcards?sort=latest" class="filter-btn ${sortParam === 'latest' ? 'active' : ''}">Newest Codes</a>
                    <a href="/giftcards?sort=views" class="filter-btn ${sortParam === 'views' ? 'active' : ''}">Most Claimed</a>
                </div>`}

                <div class="grid">${renderCards(result.rows, true) || '<p style="color:var(--meta); text-align: center; width: 100%; padding: 40px 0;">No gift cards available right now. Check back later!</p>'}</div>
                ${paginationHtml}
            </div>
            ${bootScript}
            </body></html>
        `);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/post/:slug', async (req, res) => {
    const { slug } = req.params;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();

    try {
        const result = await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        
        const post = result.rows[0];
        pool.query("UPDATE posts SET views = views + 1 WHERE id = $1", [post.id]).catch(e => {});

        const isGiftCard = post.category === 'giftcard';
        const recResult = await pool.query("SELECT * FROM posts WHERE id != $1 AND category = $2 ORDER BY RANDOM() LIMIT 4", [post.id, post.category]);
        
        const isTgVideo = post.content_link && post.content_link.startsWith('TG_VID:');
        const tgFileId = isTgVideo ? post.content_link.split('TG_VID:')[1] : '';
        const videoStreamUrl = isTgVideo ? `/stream/${tgFileId}` : '';
        const videoDownloadUrl = isTgVideo ? `/download/${tgFileId}` : link3;

        const uiFakeViews = formatFakeViews(post.views, post.id);
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        
        const tagsHtml = (post.tags ? post.tags.split(',') : ["Anime", "HD"]).map(t => `<span style="background: var(--btn-alt); padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); color: var(--meta);">#${t.trim()}</span>`).join('');
        const siteNotice = await getSiteNotice();
        
        const mediaHeroHtml = post.media_type === 'video' 
            ? `<video src="${getImgSrc(post.thumbnail)}" class="hero-bg" autoplay muted loop playsinline></video>` 
            : `<img src="${getImgSrc(post.thumbnail)}" class="hero-bg" ${isGiftCard ? 'style="object-fit: contain; background: white; padding: 20px;"' : ''}>`;

        const seoKeywords = post.tags ? post.tags : "watch anime free, free gift card";
        const seoDescription = isGiftCard ? `Get your free ${post.title}. 100% working codes generated daily.` : `Watch ${post.title} in HD quality. Top streaming platform for ${seoKeywords}.`;
        
        const dynamicMetaTags = `
            <meta name="keywords" content="${seoKeywords}">
            <meta name="description" content="${seoDescription}">
            <meta property="og:title" content="${post.title}">
            <meta property="og:description" content="${seoDescription}">
        `;

        const targetBootLink = isGiftCard ? link3 : bootLink1;

        const viewsStatHtml = isGiftCard 
            ? `<span style="background: rgba(16,185,129,0.1); color: #10b981; padding: 6px 14px; border-radius: 30px; font-weight: bold; border: 1px solid rgba(16,185,129,0.3);">🔥 Fresh New Code</span>`
            : `<span style="background: var(--btn-alt); padding: 6px 14px; border-radius: 30px; font-weight: bold; border: 1px solid var(--border);">Views: ${uiFakeViews}</span>`;

        res.send(`
            ${getHeader(post.title, dynamicMetaTags, siteNotice, isGiftCard ? 'giftcard' : 'anime')}
            <style>
                .hero-bg { width: 100%; max-height: 480px; object-fit: cover; filter: brightness(0.4) cubic-bezier(0.4, 0, 0.2, 1); }
                .play-pulse { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 80px; height: 80px; background: linear-gradient(135deg, ${isGiftCard ? '#10b981, #059669' : '#ff6a00, #ff2200'}); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 10; box-shadow: 0 0 30px ${isGiftCard ? 'rgba(16,185,129,0.6)' : 'rgba(255,85,0,0.6)'}; animation: pulseGlow 1.8s infinite; }
                .msg-box { border-left: 4px solid ${isGiftCard ? '#10b981' : 'var(--primary)'}; background: ${isGiftCard ? 'rgba(16,185,129,0.04)' : 'rgba(255,107,0,0.04)'}; padding: 16px; border-radius: 0 12px 12px 0; margin-bottom: 25px; border-top: 1px solid var(--border); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
                
                #unlockedContentContainer { display: none; width: 100%; padding: 12px 0; }
                video#mainVideoPlayer { width: 100%; max-height: 550px; outline: none; border: 3px solid var(--primary); border-radius: 12px; box-shadow: 0 10px 40px rgba(255, 85, 0, 0.25); }
                
                @keyframes pulseGlow { 0% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 0 0 ${isGiftCard ? 'rgba(16,185,129,0.7)' : 'rgba(255,85,0,0.7)'}; } 70% { transform: translate(-50%, -50%) scale(1.05); box-shadow: 0 0 0 15px rgba(255,85,0,0); } 100% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 0 0 rgba(255,85,0,0); } }
                
                .share-btn { margin-left: 10px; background: var(--btn-alt); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; }
                .share-btn:hover { background: var(--card-hover); }
            </style>

            <div class="container">
                <div style="max-width: 900px; margin: 0 auto; background: var(--card-bg); border-radius: 20px; border: 1px solid var(--border); overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.2);">
                    
                    <div id="heroContainer" style="position: relative; width: 100%; background: #000; border-bottom: 4px solid ${isGiftCard ? '#10b981' : 'var(--primary)'};">
                        ${mediaHeroHtml}
                        <div class="play-pulse" onclick="initiateAction()">
                            ${isGiftCard ? `<span style="color:white; font-size:24px; font-weight:900;">🎁</span>` : `<div style="width: 0; height: 0; border-top: 14px solid transparent; border-bottom: 14px solid transparent; border-left: 24px solid white; margin-left: 6px;"></div>`}
                        </div>
                    </div>

                    <div id="unlockedContentContainer">
                        ${isGiftCard ? `
                        <div style="text-align: center; padding: 40px; background: #1a1a24; border-radius: 12px; border: 2px dashed #10b981; margin: 20px;">
                            <h2 style="color: #10b981; margin-top: 0; font-size:24px;">🎉 Success! Here is your Target Code:</h2>
                            <div style="font-size: 32px; font-weight: 900; color: #fff; letter-spacing: 2px; padding: 20px; background: #000; border-radius: 8px; user-select: all; word-break: break-all; border: 1px solid #10b981; box-shadow: 0 0 20px rgba(16,185,129,0.2);">${post.content_link}</div>
                            <p style="color: var(--meta); font-size: 14px; margin-bottom: 0; margin-top: 15px;">Copy this code and redeem it on the official platform.</p>
                        </div>
                        ` : `
                        <div style="padding: 0 12px 12px 12px;">
                            <video id="mainVideoPlayer" controls controlsList="nodownload">
                                <source src="${videoStreamUrl}" type="video/mp4">
                                Your browser infrastructure layout does not support standard HTML streaming layout elements.
                            </video>
                        </div>
                        `}
                    </div>

                    <div style="padding: 30px;">
                        <h1 style="margin: 0 0 16px 0; font-size: 26px; font-weight: 850; line-height: 1.3; letter-spacing: -0.4px;">${post.title}</h1>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; align-items: center;">
                            ${tagsHtml}
                            <button class="share-btn" onclick="navigator.clipboard.writeText(window.location.href); alert('Link copied to clipboard!');">Copy Share Link</button>
                        </div>
                        
                        <div style="display: flex; gap: 12px; margin-bottom: 24px; color: var(--meta); font-size: 13px; flex-wrap: wrap; align-items: center;">
                            ${viewsStatHtml}
                            <span style="color: #10b981; font-weight: bold; background: rgba(16,185,129,0.08); padding: 4px 10px; border-radius: 6px;">Match Rate: 99%</span>
                            <span style="color: #ffb800; font-weight: bold; background: rgba(255,184,0,0.08); padding: 4px 10px; border-radius: 6px;">Rating: ${getFakeRating(post.id)}</span>
                        </div>

                        <div id="statusBox" class="msg-box">
                            <p style="color: var(--text); margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5;" id="statusText">
                                Verification Lock Active: Please interact with our sponsorship portal for 30 seconds to authenticate your request.<br>
                                <span style="font-size: 12px; color: var(--meta); font-weight: normal; margin-top: 6px; display: inline-block;">Synchronization Node: ${today}</span>
                            </p>
                        </div>
                        
                        <div id="btnContainer" style="margin-bottom: 30px;">
                            <button id="mainBtn" onclick="initiateAction()" style="width: 100%; padding: 16px; background: linear-gradient(135deg, ${isGiftCard ? '#10b981, #059669' : '#ff6a00, #ff3300'}); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 800; cursor: pointer; box-shadow: 0 4px 15px ${isGiftCard ? 'rgba(16,185,129,0.3)' : 'rgba(255,85,0,0.3)'}; transition: transform 0.2s ease;">
                                ${isGiftCard ? "Unseal Gift Card Code" : "Unseal and Initiate Stream Link"}
                            </button>
                        </div>

                        <div style="margin: 30px auto 10px auto; text-align: center;">${AD_NATIVE_BANNER}</div>

                        ${!isGiftCard ? `
                        <h3 style="margin-top: 25px; font-size: 18px; font-weight: 800; border-bottom: 2px solid var(--border); padding-bottom: 12px; letter-spacing: -0.2px;">High-Speed Dedicated Cloud Download Grid</h3>
                        <table class="dl-table" style="width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 15px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border);">
                            <thead><tr><th style="background: var(--btn-alt); color: var(--meta); font-weight: 700; font-size: 13px; padding: 14px 18px; text-transform: uppercase;">Output Quality</th><th style="background: var(--btn-alt); color: var(--meta); font-weight: 700; font-size: 13px; padding: 14px 18px; text-transform: uppercase;">Cloud Node</th><th style="background: var(--btn-alt); color: var(--meta); font-weight: 700; font-size: 13px; padding: 14px 18px; text-transform: uppercase;">Action</th></tr></thead>
                            <tbody>
                                <tr>
                                    <td style="padding: 14px 18px; border-bottom: 1px solid var(--border); color: var(--text);"><strong style="color: var(--primary);">4K Bluray Original</strong></td>
                                    <td style="padding: 14px 18px; border-bottom: 1px solid var(--border); color: var(--text);">VIP HighSpeed</td>
                                    <td style="padding: 14px 18px; border-bottom: 1px solid var(--border);"><button onclick="window.location.href='${videoDownloadUrl}'" style="background: #10b981; color: white; padding: 8px 16px; border-radius: 8px; font-weight: 700; border: none; cursor: pointer;">Download</button></td>
                                </tr>
                            </tbody>
                        </table>
                        ` : ''}
                    </div>
                </div>
                
                <div style="margin-top: 50px; background: var(--card-bg); padding: 25px; border-radius: 20px; border: 1px solid var(--border);">
                    <h3 style="font-size: 22px; font-weight: 900; color: var(--text); border-left: 5px solid ${isGiftCard ? '#10b981' : 'var(--primary)'}; padding-left: 14px; margin-bottom: 24px; display: flex; align-items: center; gap: 8px;">
                        🔥 You May Also Like / More ${isGiftCard ? 'Gift Cards' : 'Anime'}
                    </h3>
                    <div class="grid">${renderCards(recResult.rows, isGiftCard)}</div>
                </div>
            </div>

            ${getBootLogic(targetBootLink)}

            <script>
                const slug = '${post.slug ? post.slug : post.id}';
                const adUrl = '/out/' + slug + '?type=ad';
                const movieUrl = '/out/' + slug + '?type=content';
                const isUploadedVideo = ${isTgVideo};
                const isGiftCardTarget = ${isGiftCard};

                function unlockVideo() {
                    if (isUploadedVideo || isGiftCardTarget) {
                        document.getElementById('heroContainer').style.display = 'none';
                        document.getElementById('statusBox').style.display = 'none';
                        document.getElementById('btnContainer').style.display = 'none';
                        
                        document.getElementById('unlockedContentContainer').style.display = 'block';
                        
                        if (!isGiftCardTarget) {
                            var player = document.getElementById('mainVideoPlayer');
                            player.play();
                        }
                    } else {
                        window.location.href = movieUrl;
                    }
                }

                function checkStatus() {
                    const adStatus = localStorage.getItem('ad_status_' + slug);
                    const btnText = document.getElementById('mainBtn');
                    const statusText = document.getElementById('statusText');
                    
                    if (adStatus && adStatus !== 'unlocked') {
                        const timePassed = (Date.now() - parseInt(adStatus)) / 1000;
                        if (timePassed >= 30) {
                            localStorage.setItem('ad_status_' + slug, 'unlocked');
                            if(btnText) btnText.innerText = "[Success] Pipeline Authenticated. Access Granted.";
                            if(statusText) statusText.innerHTML = "<span style='color: #10b981; font-weight:bold;'>Verification successfully computed. Access parameters granted. Click activation button above.</span>";
                        } else {
                            if(btnText) btnText.innerText = "Synchronizing telemetry data background...";
                        }
                    } else if (adStatus === 'unlocked') {
                        if(btnText) btnText.innerText = "[Success] Active Authorization Unlocked";
                        if(statusText) statusText.innerHTML = "<span style='color: #10b981; font-weight:bold;'>Data bridge completely deployed. System active.</span>";
                        if (isUploadedVideo || isGiftCardTarget) { unlockVideo(); }
                    }
                }

                window.onload = checkStatus;
                document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStatus(); });

                function initiateAction() {
                    const adStatus = localStorage.getItem('ad_status_' + slug);

                    if (!adStatus) {
                        localStorage.setItem('ad_status_' + slug, Date.now());
                        document.getElementById('statusText').innerHTML = "<span style='color: ${isGiftCard ? '#10b981' : 'var(--primary)'}; font-weight:bold;'>Sponsor tab interface launched. Keeping data telemetry synchronized... Do not close background targets.</span>";
                        window.open(adUrl, '_blank'); 
                        
                        const btnText = document.getElementById('mainBtn');
                        let timeLeft = 30;
                        const timer = setInterval(() => {
                            timeLeft--;
                            if(timeLeft > 0) {
                                btnText.innerText = "Processing network allocation (" + timeLeft + "s left)...";
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
                            alert("Authorization failure! You standard interval metric requirement was broken. Reconnect sponsor window node and finalize final " + timeLeft + " seconds remaining.");
                            window.location.href = adUrl; 
                        } else {
                            localStorage.setItem('ad_status_' + slug, 'unlocked');
                            unlockVideo();
                        }
                    } else {
                        unlockVideo();
                    }
                }
            </script>
            </body></html>
        `);
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/out/:slug', async (req, res) => {
    const { slug } = req.params;
    const type = req.query.query || req.query.type; 
    try {
        let result = slug === 'latest' ? await pool.query("SELECT * FROM posts ORDER BY id DESC LIMIT 1") : await pool.query("SELECT * FROM posts WHERE slug = $1 OR id::text = $1", [slug]);
        
        if (result.rows.length > 0) {
            const post = result.rows[0];
            await pool.query("UPDATE posts SET clicks = clicks + 1 WHERE id = $1", [post.id]);
            
            if (type === 'content' && post.content_link.startsWith('TG_VID:')) {
                return res.redirect('/post/' + slug);
            }
            
            res.redirect(getValidUrl(type === 'ad' ? post.ad_link : post.content_link));
        } else res.status(404).send("Link segment registry not found");
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/sitemap.xml', async (req, res) => {
    try {
        const result = await pool.query("SELECT slug FROM posts");
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  <url><loc>https://watchmovie.pro/</loc><priority>1.00</priority></url>
  <url><loc>https://watchmovie.pro/giftcards</loc><priority>1.00</priority></url>
  <url><loc>https://watchmovie.pro/?sort=latest</loc><priority>0.80</priority></url>
  <url><loc>https://watchmovie.pro/?sort=views</loc><priority>0.80</priority></url>`;

        result.rows.forEach(p => { xml += `<url><loc>https://watchmovie.pro/post/${p.slug}</loc><priority>0.80</priority></url>`; });
        xml += '\n</urlset>';
        res.header('Content-Type', 'application/xml'); res.send(xml);
    } catch (e) { res.status(500).send("Sitemap pipeline structural failure"); }
});

app.listen(process.env.PORT || 3000, () => console.log('System operational node successfully initialized.'));
