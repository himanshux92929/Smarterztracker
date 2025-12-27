const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, child } = require('firebase/database');

// ==========================================
// 1. CONFIGURATION (Env Variables)
// ==========================================

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL; 

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "automateddone.firebaseapp.com",
    databaseURL: "https://automateddone-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "automateddone",
    storageBucket: "automateddone.firebasestorage.app",
    messagingSenderId: "881227012524",
    appId: "1:881227012524:web:8dca369d7f4e63bd384209"
};

const PROXY_BASE = "https://ntxapi.onrender.com/test";
const API_HOST = "https://theeduverse.xyz";
const CONTENT_TYPES = ['lectures', 'notes', 'dpps'];

// ==========================================
// 2. SETUP
// ==========================================

const app = express();
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

// Helper: Proxy URL Generator
const getApiUrl = (path) => {
    const target = `${API_HOST}/api${path}`;
    return `${PROXY_BASE}?url=${encodeURIComponent(target)}&referrer=${encodeURIComponent(API_HOST)}`;
};

// Helper: Format Link
const formatLink = (title, rawUrl) => {
    let finalUrl = rawUrl;
    if (/\/(\d+)_(\d+)\.m3u8$/.test(finalUrl)) {
        finalUrl = finalUrl.replace(/\/(\d+)_(\d+)\.m3u8$/, "/index_1.m3u8");
    }
    if (finalUrl && finalUrl.includes('.m3u8')) {
        finalUrl = `https://smarterz.netlify.app/player?url=${encodeURIComponent(finalUrl)}`;
    }
    return finalUrl;
};

// Helper: Capitalize
const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1);

// ==========================================
// 3. CORE LOGIC
// ==========================================

const handleContentFlow = async (ctx, batchId, subjectIndex, typeIndex, offset) => {
    try {
        // --- A. FETCH SUBJECTS ---
        const subRes = await axios.get(getApiUrl(`/batches/${batchId}`));
        const subjects = subRes.data.data || [];

        // Stop if we went past the last subject
        if (subjectIndex >= subjects.length) {
            await ctx.reply("📜 **Log:** End of Batch. All subjects checked.");
            return ctx.reply("🎉 **All Caught Up!**\nNo more pending items in this batch.", { parse_mode: 'Markdown' });
        }

        const currentSubject = subjects[subjectIndex];
        const currentType = CONTENT_TYPES[typeIndex]; 

        // --- [FEATURE 2] SEND LOG TO USER ---
        // Only send this log if we are starting a new section (offset 0) to avoid spamming on "Load More"
        if (offset === 0) {
            await ctx.reply(`📜 **Log:** Checking **${currentSubject.name}** for *${currentType.toUpperCase()}*...`, { parse_mode: 'Markdown' });
        }

        // --- B. FETCH CONTENT ---
        const contentUrl = getApiUrl(`/${batchId}/subjects/${currentSubject.id}/${currentType}`);
        let allItems = [];
        
        try {
            const contentRes = await axios.get(contentUrl);
            allItems = contentRes.data.data || [];
        } catch (err) {
            console.log(`Error fetching content: ${err.message}`);
        }

        // --- C. FILTER COMPLETED ITEMS ---
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, `completed_items`));
        const completedMap = snapshot.exists() ? snapshot.val() : {};
        
        const pendingItems = allItems.filter(item => !completedMap[item.id]);

        // --- D. CHECK IF EMPTY ---
        if (pendingItems.length === 0) {
            // Log to user that we are skipping
            await ctx.reply(`⚠️ **Log:** No pending ${currentType} in ${currentSubject.name}. Skipping...`, { parse_mode: 'Markdown' });

            // Determine next state
            let nextTypeIdx = typeIndex + 1;
            let nextSubIdx = subjectIndex;

            if (nextTypeIdx >= CONTENT_TYPES.length) {
                nextTypeIdx = 0;
                nextSubIdx++;
            }

            // RECURSIVE CALL
            return handleContentFlow(ctx, batchId, nextSubIdx, nextTypeIdx, 0);
        }

        // --- E. PREPARE BATCH TO SEND ---
        const itemsToSend = pendingItems.slice(offset, offset + 5);

        if (itemsToSend.length === 0) {
             // Logic same as empty: move to next section
            let nextTypeIdx = typeIndex + 1;
            let nextSubIdx = subjectIndex;
            if (nextTypeIdx >= CONTENT_TYPES.length) {
                nextTypeIdx = 0;
                nextSubIdx++;
            }
            return handleContentFlow(ctx, batchId, nextSubIdx, nextTypeIdx, 0);
        }

        // --- F. SEND HEADER ---
        if (offset === 0) {
            const icon = typeIndex === 0 ? '📺' : (typeIndex === 1 ? '📄' : '📝');
            await ctx.reply(`**${currentSubject.name}**\n${icon} ${currentType.toUpperCase()} (${pendingItems.length} pending)`, { parse_mode: 'Markdown' });
        }

        // --- G. SEND MESSAGES ---
        for (const item of itemsToSend) {
            const title = item.title || item.name || 'Untitled';
            const rawUrl = item.url || item.originalUrl || item.baseUrl;
            const finalLink = formatLink(title, rawUrl);
            
            // Format Type Label (e.g. "Lecture")
            const typeLabel = capitalize(currentType).replace(/s$/, '');

            // --- [FEATURE 1] ADD TYPE LINE ---
            await ctx.reply(
                `📌 **${title}**\n📂 **Type:** ${typeLabel}\n\n🔗 [Click to Open](${finalLink})`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        Markup.button.callback("✅ Mark as Done", `DONE_${item.id}`)
                    ])
                }
            );
        }

        // --- H. NAVIGATION BUTTONS ---
        const buttons = [];
        
        // "Load More"
        if (pendingItems.length > offset + 5) {
            buttons.push(Markup.button.callback(
                `⬇️ Load More (${currentType})`, 
                `FLOW_${batchId}_${subjectIndex}_${typeIndex}_${offset + 5}`
            ));
        }

        // "Next Section"
        let nextT = typeIndex + 1;
        let nextS = subjectIndex;
        let btnLabel = "";

        if (nextT < CONTENT_TYPES.length) {
            btnLabel = `➡️ Next: ${CONTENT_TYPES[nextT]}`;
        } else {
            nextT = 0;
            nextS = subjectIndex + 1;
            btnLabel = `⏭️ Next Subject`;
        }

        if (nextS < subjects.length) {
            buttons.push(Markup.button.callback(btnLabel, `FLOW_${batchId}_${nextS}_${nextT}_0`));
        }

        await ctx.reply("👇 Actions:", Markup.inlineKeyboard([buttons]));

    } catch (e) {
        console.error(e);
        ctx.reply(`❌ **Log:** Error occurred: ${e.message}`);
    }
};

// ==========================================
// 4. BOT ACTIONS
// ==========================================

bot.start(async (ctx) => {
    ctx.reply("👋 **Smarterz Bot**\n📜 Log: Fetching batches...", { parse_mode: 'Markdown' });
    try {
        const res = await axios.get(getApiUrl('/batches'));
        const batches = res.data.data || [];
        
        const buttons = [];
        for(let i=0; i<batches.length; i+=2) {
            const row = [];
            row.push(Markup.button.callback(batches[i].name, `INIT_${batches[i].id}`));
            if(batches[i+1]) row.push(Markup.button.callback(batches[i+1].name, `INIT_${batches[i+1].id}`));
            buttons.push(row);
        }
        
        ctx.reply('Select a Batch:', Markup.inlineKeyboard(buttons));
    } catch (e) {
        ctx.reply("❌ Log: Error fetching batches.");
    }
});

bot.action(/^INIT_(\w+)$/, (ctx) => {
    const batchId = ctx.match[1];
    ctx.answerCbQuery("Starting...");
    handleContentFlow(ctx, batchId, 0, 0, 0);
});

bot.action(/^FLOW_(\w+)_(\d+)_(\d+)_(\d+)$/, (ctx) => {
    const [_, batchId, sIdx, tIdx, off] = ctx.match;
    ctx.answerCbQuery("Loading...");
    ctx.deleteMessage().catch(()=>{}); 
    handleContentFlow(ctx, batchId, parseInt(sIdx), parseInt(tIdx), parseInt(off));
});

bot.action(/^DONE_(.+)$/, async (ctx) => {
    const itemId = ctx.match[1];
    try {
        await set(ref(db, 'completed_items/' + itemId), true);
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n✅ **COMPLETED**`, 
            { parse_mode: 'Markdown' }
        );
        ctx.answerCbQuery("Done!");
    } catch (e) {
        ctx.answerCbQuery("Error saving to DB.");
    }
});

// ==========================================
// 5. SERVER START
// ==========================================

if (process.env.NODE_ENV === 'production') {
    bot.telegram.setWebhook(`${URL}/bot${BOT_TOKEN}`);
    app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`));
} else {
    bot.launch();
}

app.get('/', (req, res) => res.send('Bot Status: Online 🟢'));

app.listen(PORT, () => console.log(`Running on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
