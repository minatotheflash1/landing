require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const geoip = require('geoip-lite');

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
                title TEXT,
                thumbnail TEXT,
                ad_link TEXT,
                content_link TEXT,
                views INT DEFAULT 0,
                clicks INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS views INT DEFAULT 0;").catch(()=>{"ignore"});
        await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS clicks INT DEFAULT 0;").catch(()=>{"ignore"});
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("DB Setup Error:", err);
    }
};
setupDB();

// Telegram Bot Setup
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Memory to store user steps temporarily
const userStates = {};

// Helper function to determine image source securely
const getImgSrc = (thumbnail) => {
    if (!thumbnail) return '';
    if (thumbnail.startsWith('http://') || thumbnail.startsWith('https://')) {
        return thumbnail;
    }
    return `/image/${thumbnail}`;
};

// Admin UI - Main Menu
const sendMainMenu = (chatId) => {
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Add New Post", callback_data: "add_post" }],
                [{ text: "Manage Posts", callback_data: "manage_posts" }, { text: "Total Stats", callback_data: "total_stats" }],
                [{ text: "Ping Status", callback_data: "ping" }]
            ]
        }
    };
    bot.sendMessage(chatId, "Admin Dashboard\nSelect an option below, Boss:", options);
};

// Start Command
bot.onText(/\/start/, (msg) => {
    delete userStates[msg.chat.id]; 
    sendMainMenu(msg.chat.id);
});

// Step 1: Trigger Add Post
bot.onText(/\/addpost/, (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = { step: 'AWAITING_THUMBNAIL' };
    bot.sendMessage(chatId, "Step 1: Movie er chobi upload (photo send) korun ba thumbnail URL send korun:");
});

// Handle Interactive Messages for Bot (Accepts both photo and text)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    if (!userStates[chatId]) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const state = userStates[chatId];

    if (state.step === 'AWAITING_THUMBNAIL') {
        if (msg.photo && msg.photo.length > 0) {
            // User uploaded a direct picture file
            const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
            state.thumbnail = photo.file_id;
        } else if (msg.text) {
            // User pasted a text URL instead
            state.thumbnail = msg.text.trim();
        } else {
            return bot.sendMessage(chatId, "Boss, doya kore ekta chobi upload korun ba text akare thumbnail URL send korun.");
        }

        state.step = 'AWAITING_AD_LINK';
        bot.sendMessage(chatId, "Step 2: Thumbnail chobi peyechi. Ekhon apnar Adsterra link send korun:");
    } 
    else if (state.step === 'AWAITING_AD_LINK') {
        if (!msg.text) return bot.sendMessage(chatId, "Doya kore text akare Adsterra link send korun.");
        state.adLink = msg.text.trim();
        state.step = 'AWAITING_CONTENT_LINK';
        bot.sendMessage(chatId, "Step 3: Adsterra link peyechi. Ekhon main movie link upload korun:");
    } 
    else if (state.step === 'AWAITING_CONTENT_LINK') {
        if (!msg.text) return bot.sendMessage(chatId, "Doya kore text akare main movie link send korun.");
        state.contentLink = msg.text.trim();
        bot.sendMessage(chatId, "Shob data peyechi. DeepSeek theke cinematic title generate kora hocche, ektu opekkha korun...");

        try {
            const aiResponse = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "user", content: "Generate a catchy, SEO-friendly movie title or streaming headline for a trending video (Max 6 words). Do not use quotes." }]
            }, {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
            });

            const title = aiResponse.data.choices[0].message.content.trim();

            const dbResult = await pool.query(
                "INSERT INTO posts (title, thumbnail, ad_link, content_link) VALUES ($1, $2, $3, $4) RETURNING id",
                [title, state.thumbnail, state.adLink, state.contentLink]
            );

            const postId = dbResult.rows[0].id;
            const postUrl = `${process.env.WEBSITE_URL}/post/${postId}`;
            
            bot.sendMessage(chatId, `Post Live!\n\nTitle: ${title}\nLink: ${postUrl}`);
            
            delete userStates[chatId];
            sendMainMenu(chatId);

        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "Error! DeepSeek Key ba URL check korun. Operational state cancel kora holo.");
            delete userStates[chatId];
        }
    }
});

// Handle Button Clicks
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;

    if (data === "ping") {
        const start = Date.now();
        await pool.query("SELECT 1"); 
        const ms = Date.now() - start;
        bot.sendMessage(chatId, `Pong!\nServer is active.\nDatabase Latency: ${ms}ms`);
    
    } else if (data === "add_post") {
        userStates[chatId] = { step: 'AWAITING_THUMBNAIL' };
        bot.sendMessage(chatId, "Step 1: Movie er chobi upload (photo send) korun ba thumbnail URL send korun:");
    
    } else if (data === "total_stats") {
        const result = await pool.query("SELECT COUNT(id) as total_posts, SUM(views) as total_views, SUM(clicks) as total_clicks FROM posts");
        const stats = result.rows[0];
        bot.sendMessage(chatId, `Overall Statistics\n\nTotal Movies: ${stats.total_posts}\nTotal Views: ${stats.total_views || 0}\nTotal Clicks: ${stats.total_clicks || 0}`);

    } else if (data === "manage_posts") {
        const result = await pool.query("SELECT id, title FROM posts ORDER BY id DESC LIMIT 5");
        if (result.rows.length === 0) return bot.sendMessage(chatId, "No posts available.");

        let inline_keyboard = result.rows.map(post => [
            { text: `Del ID:${post.id}`, callback_data: `del_${post.id}` },
            { text: `Stats (ID:${post.id})`, callback_data: `stat_${post.id}` }
        ]);
        
        bot.sendMessage(chatId, "Latest 5 Movies", { reply_markup: { inline_keyboard } });

    } else if (data.startsWith("del_")) {
        const id = data.split("_")[1];
        await pool.query("DELETE FROM posts WHERE id = $1", [id]);
        bot.sendMessage(chatId, `Post ID ${id} deleted successfully.`);
        
    } else if (data.startsWith("stat_")) {
        const id = data.split("_")[1];
        const result = await pool.query("SELECT title, views, clicks FROM posts WHERE id = $1", [id]);
        if(result.rows.length > 0) {
            const p = result.rows[0];
            bot.sendMessage(chatId, `Stats for ID: ${id}\nTitle: ${p.title}\nViews: ${p.views}\nClicks: ${p.clicks}`);
        }
    }
    bot.answerCallbackQuery(callbackQuery.id);
});

// --- COMMON UI CSS & TEMPLATE ---
const getHeader = (title) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        :root { --bg: #141414; --card-bg: #2f2f2f; --primary: #e50914; --text: #ffffff; --text-muted: #aaaaaa; }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
        body { background-color: var(--bg); color: var(--text); padding-bottom: 50px; }
        
        .navbar { display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; background: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent); position: sticky; top: 0; z-index: 100; }
        .logo { font-size: 24px; font-weight: bold; color: var(--primary); text-decoration: none; text-transform: uppercase; letter-spacing: 2px; }
        .search-container { display: flex; }
        .search-input { padding: 10px 15px; border: 1px solid #333; background: rgba(0,0,0,0.7); color: white; border-radius: 4px 0 0 4px; outline: none; width: 250px; }
        .search-btn { padding: 10px 20px; background: var(--primary); color: white; border: none; border-radius: 0 4px 4px 0; cursor: pointer; font-weight: bold; }
        .search-btn:hover { background: #b20710; }

        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .section-title { font-size: 20px; font-weight: bold; margin-bottom: 20px; color: #e5e5e5; border-left: 4px solid var(--primary); padding-left: 10px; }

        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; }
        .movie-card { background: var(--card-bg); border-radius: 8px; overflow: hidden; transition: transform 0.3s ease; position: relative; cursor: pointer; }
        .movie-card:hover { transform: scale(1.05); z-index: 10; box-shadow: 0 10px 20px rgba(0,0,0,0.8); }
        .card-img { width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; }
        .card-overlay { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.9)); padding: 20px 10px 10px; opacity: 0; transition: opacity 0.3s; }
        .movie-card:hover .card-overlay { opacity: 1; }
        .card-title { font-size: 14px; font-weight: bold; margin-bottom: 10px; }
        .card-link { display: inline-block; padding: 8px 15px; background: var(--primary); color: white; text-decoration: none; border-radius: 4px; font-size: 12px; font-weight: bold; width: 100%; text-align: center; }

        .hero { position: relative; height: 60vh; background-size: cover; background-position: center; display: flex; align-items: flex-end; padding: 40px; }
        .hero-fade { position: absolute; bottom: 0; left: 0; right: 0; height: 100%; background: linear-gradient(to top, var(--bg) 0%, transparent 100%); }
        .hero-content { position: relative; z-index: 2; max-width: 600px; }
        .hero-title { font-size: 3rem; margin-bottom: 15px; text-shadow: 2px 2px 4px rgba(0,0,0,0.8); font-weight: 800; }
        .hero-btn { display: inline-block; padding: 12px 30px; background: white; color: black; text-decoration: none; font-weight: bold; border-radius: 4px; font-size: 1.1rem; margin-right: 10px; transition: background 0.2s; }
        .hero-btn:hover { background: #e5e5e5; }
        
        .player-container { background: #000; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; border: 1px solid #333; }
        .player-container img { max-width: 100%; max-height: 400px; object-fit: contain; border-radius: 4px; margin-bottom: 20px; }
        .watch-btn { display: inline-block; padding: 15px 40px; background: var(--primary); color: white; text-decoration: none; font-size: 18px; border-radius: 4px; font-weight: bold; margin: 10px; transition: background 0.3s; }
        .watch-btn:hover { background: #b20710; }
        .alt-btn { background: rgba(109, 109, 110, 0.7); }
        .alt-btn:hover { background: rgba(109, 109, 110, 0.9); }
        .meta-data { color: var(--text-muted); font-size: 14px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #333; }

        @media (max-width: 768px) {
            .navbar { flex-direction: column; gap: 15px; padding: 15px; }
            .search-input { width: 100%; }
            .hero-title { font-size: 2rem; }
            .hero { height: 40vh; padding: 20px; }
        }
    </style>
</head>
<body>
    <nav class="navbar">
        <a href="/" class="logo">AURA STREAM</a>
        <form action="/" method="GET" class="search-container">
            <input type="text" name="q" class="search-input" placeholder="Search movies, shows..." required>
            <button type="submit" class="search-btn">Search</button>
        </form>
    </nav>
`;

const getFooter = () => `</body></html>`;

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

        let heroHtml = '';
        if (posts.length > 0 && !searchQuery) {
            const featured = posts[0];
            heroHtml = `
                <div class="hero" style="background-image: url('${getImgSrc(featured.thumbnail)}');">
                    <div class="hero-fade"></div>
                    <div class="hero-content">
                        <h1 class="hero-title">${featured.title}</h1>
                        <a href="/post/${featured.id}" class="hero-btn">Play Now</a>
                    </div>
                </div>
            `;
        }

        let postsHtml = posts.map(post => `
            <div class="movie-card" onclick="window.location.href='/post/${post.id}'">
                <img src="${getImgSrc(post.thumbnail)}" alt="poster" class="card-img">
                <div class="card-overlay">
                    <div class="card-title">${post.title}</div>
                    <a href="/post/${post.id}" class="card-link">Watch</a>
                </div>
            </div>
        `).join('');

        let contentTitle = searchQuery ? `Search Results for "${searchQuery}"` : "Recently Added";
        let emptyState = posts.length === 0 ? '<p style="color: #666; text-align: center; width: 100%; padding: 40px 0;">No content available matching your request. Please add content via Bot.</p>' : '';

        let adScript = '';
        if (posts.length > 0) {
            adScript = `
                <script>
                    const homeAdUrl = "/out/latest?type=ad";
                    if (!sessionStorage.getItem('home_auto_redirect')) {
                        sessionStorage.setItem('home_auto_redirect', 'true');
                        window.location.href = homeAdUrl;
                    }
                    document.addEventListener('click', function(e) {
                        if (!sessionStorage.getItem('home_click_ad')) {
                            sessionStorage.setItem('home_click_ad', 'true');
                            window.open(homeAdUrl, '_blank');
                        }
                    }, true);
                </script>
            `;
        }

        const html = `
            ${getHeader('Aura Stream - Watch High Quality')}
            ${heroHtml}
            <div class="container">
                <h2 class="section-title">${contentTitle}</h2>
                <div class="grid">
                    ${postsHtml}
                </div>
                ${emptyState}
            </div>
            ${adScript}
            ${getFooter()}
        `;
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

app.get('/post/:id', async (req, res) => {
    const { id } = req.params;
    
    pool.query("UPDATE posts SET views = views + 1 WHERE id = $1", [id]).catch(err => console.error(err));

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const geo = geoip.lookup(ip);
    const country = geo ? geo.country : 'Unknown';
    
    let languageMessage = "Please select a server to begin streaming.";
    if (country === 'BD' || country === 'IN') languageMessage = "Streaming shuru korte nicher theke server select korun.";

    try {
        const result = await pool.query("SELECT * FROM posts WHERE id = $1", [id]);
        if (result.rows.length === 0) return res.status(404).send("Content not found");
        const post = result.rows[0];
        
        const html = `
            ${getHeader(post.title)}
            <div class="container">
                <div class="player-container">
                    <h1 style="margin-bottom: 20px; font-size: 2rem;">${post.title}</h1>
                    <img src="${getImgSrc(post.thumbnail)}" alt="Backdrop">
                    <p style="margin-bottom: 20px; color: #ccc;">${languageMessage}</p>
                    
                    <div>
                        <a href="/out/${post.id}?type=ad" target="_blank" class="watch-btn">
                            Server 1 (High Quality)
                        </a>
                        <a href="/out/${post.id}?type=content" target="_blank" class="watch-btn alt-btn">
                            Server 2 (Standard)
                        </a>
                    </div>
                    
                    <div class="meta-data">
                        Available in region: ${country} | Total Views: ${post.views}
                    </div>
                </div>
            </div>

            <script>
                const postAdUrl = "/out/${post.id}?type=ad";
                if (!sessionStorage.getItem('post_auto_redirect_${post.id}')) {
                    sessionStorage.setItem('post_auto_redirect_${post.id}', 'true');
                    window.location.href = postAdUrl;
                }
                document.addEventListener('click', function(e) {
                    if (!sessionStorage.getItem('post_click_ad_${post.id}')) {
                        sessionStorage.setItem('post_click_ad_${post.id}', 'true');
                        window.open(postAdUrl, '_blank');
                    }
                }, true);
            </script>

            ${getFooter()}
        `;
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// SECURE PROXY ROUTE FOR DIRECT UPLOADED IMAGES
app.get('/image/:file_id', async (req, res) => {
    const { file_id } = req.params;
    try {
        const fileLink = await bot.getFileLink(file_id);
        const response = await axios({
            url: fileLink,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(res);
    } catch (err) {
        console.error("Image Fetch Error:", err);
        res.status(404).send("Image not found");
    }
});

app.get('/out/:id', async (req, res) => {
    const { id } = req.params;
    const type = req.query.type;
    
    try {
        let result;
        if (id === 'latest') {
            result = await pool.query("SELECT id, ad_link, content_link FROM posts ORDER BY id DESC LIMIT 1");
        } else {
            result = await pool.query("SELECT ad_link, content_link FROM posts WHERE id = $1", [id]);
        }

        if (result.rows.length > 0) {
            const post = result.rows[0];
            
            if (id !== 'latest') {
                await pool.query("UPDATE posts SET clicks = clicks + 1 WHERE id = $1", [id]).catch(err => console.error(err));
            } else {
                await pool.query("UPDATE posts SET clicks = clicks + 1 WHERE id = $1", [post.id]).catch(err => console.error(err));
            }
            
            const redirectUrl = type === 'ad' ? post.ad_link : post.content_link;
            res.redirect(redirectUrl);
        } else {
            res.status(404).send("Link not found");
        }
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
