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

// Helper: Format Link (Matches your HTML logic)
const formatLink = (title, rawUrl) => {
    let finalUrl = rawUrl;

    // 1. Fix the m3u8 index pattern (e.g., 123_456.m3u8 -> index_1.m3u8)
    if (/\/(\d+)_(\d+)\.m3u8$/.test(finalUrl)) {
        finalUrl = finalUrl.replace(/\/(\d+)_(\d+)\.m3u8$/, "/index_1.m3u8");
    }

    // 2. Add Player Prefix if it is an m3u8
    if (finalUrl && finalUrl.includes('.m3u8')) {
        finalUrl = `https://smarterz.netlify.app/player?url=${encodeURIComponent(finalUrl)}`;
    }

    return finalUrl;
};

// ==========================================
// 3. CORE LOGIC
// ==========================================

/**
 * Main Flow Controller
 * recurses automatically if a section is empty to find the next available content.
 */
const handleContentFlow = async (ctx, batchId, subjectIndex, typeIndex, offset) => {
    try {
        // --- A. FETCH SUBJECTS ---
        const subRes = await axios.get(getApiUrl(`/batches/${batchId}`));
        const subjects = subRes.data.data || [];

        // Stop if we went past the last subject
        if (subjectIndex >= subjects.length) {
            return ctx.reply("🎉 **All Caught Up!**\nNo more pending items in this batch.", { parse_mode: 'Markdown' });
        }

        const currentSubject = subjects[subjectIndex];
        const currentType = CONTENT_TYPES[typeIndex]; // 'lectures', 'notes', or 'dpps'

        // --- B. FETCH CONTENT ---
        const contentUrl = getApiUrl(`/${batchId}/subjects/${currentSubject.id}/${currentType}`);
        let allItems = [];
        
        try {
            const contentRes = await axios.get(contentUrl);
            allItems = contentRes.data.data || [];
        } catch (err) {
            console.log(`Error fetching ${currentType} for ${currentSubject.name}, skipping...`);
        }

        // --- C. FILTER COMPLETED ITEMS ---
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, `completed_items`));
        const completedMap = snapshot.exists() ? snapshot.val() : {};
        
        const pendingItems = allItems.filter(item => !completedMap[item.id]);

        // --- D. CHECK IF EMPTY ---
        // If no items in this specific section (e.g., Subject 1 Notes), AUTO-SKIP to next
        if (pendingItems.length === 0) {
            // Determine next state
            let nextTypeIdx = typeIndex + 1;
            let nextSubIdx = subjectIndex;

            // If we finished DPPs (index 2), move to next Subject and reset type to Lectures (0)
            if (nextTypeIdx >= CONTENT_TYPES.length) {
                nextTypeIdx = 0;
                nextSubIdx++;
            }

            // RECURSIVE CALL (Skip empty section immediately)
            return handleContentFlow(ctx, batchId, nextSubIdx, nextTypeIdx, 0);
        }

        // --- E. PREPARE BATCH TO SEND ---
        // If we have items, slice them based on offset
        const itemsToSend = pendingItems.slice(offset, offset + 5);

        // If offset is high but we ran out of items (e.g., clicked "Load More" but only 1 left and we sent it)
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

        // --- F. SEND HEADER (Only on first load of this section) ---
        if (offset === 0) {
            const icon = typeIndex === 0 ? '📺' : (typeIndex === 1 ? '📄' : '📝');
            await ctx.reply(`**${currentSubject.name}**\n${icon} ${currentType.toUpperCase()} (${pendingItems.length} pending)`, { parse_mode: 'Markdown' });
        }

        // --- G. SEND MESSAGES ---
        for (const item of itemsToSend) {
            const title = item.title || item.name || 'Untitled';
            const rawUrl = item.url || item.originalUrl || item.baseUrl;
            const finalLink = formatLink(title, rawUrl);

            await ctx.reply(
                `📌 **${title}**\n\n🔗 [Click to Open](${finalLink})`,
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
        
        // 1. "Load More" (If there are more items in THIS specific list)
        if (pendingItems.length > offset + 5) {
            buttons.push(Markup.button.callback(
                `⬇️ Load More (${currentType})`, 
                `FLOW_${batchId}_${subjectIndex}_${typeIndex}_${offset + 5}`
            ));
        }

        // 2. "Next Section" (Calculate what the next button actually does)
        let nextT = typeIndex + 1;
        let nextS = subjectIndex;
        let btnLabel = "";

        if (nextT < CONTENT_TYPES.length) {
            // Still in same subject, next type
            btnLabel = `➡️ Next: ${CONTENT_TYPES[nextT]}`;
        } else {
            // Move to next subject
            nextT = 0;
            nextS = subjectIndex + 1;
            btnLabel = `⏭️ Next Subject`;
        }

        // Only show "Next" button if we haven't exhausted all subjects
        if (nextS < subjects.length) {
            buttons.push(Markup.button.callback(btnLabel, `FLOW_${batchId}_${nextS}_${nextT}_0`));
        }

        await ctx.reply("👇 Actions:", Markup.inlineKeyboard([buttons]));

    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ Network error. Please try clicking the button again.");
    }
};

// ==========================================
// 4. BOT ACTIONS
// ==========================================

bot.start(async (ctx) => {
    ctx.reply("👋 **Smarterz Bot**\nFetching your batches...", { parse_mode: 'Markdown' });
    try {
        const res = await axios.get(getApiUrl('/batches'));
        const batches = res.data.data || [];
        
        // Create a grid of buttons (2 per row)
        const buttons = [];
        for(let i=0; i<batches.length; i+=2) {
            const row = [];
            row.push(Markup.button.callback(batches[i].name, `INIT_${batches[i].id}`));
            if(batches[i+1]) row.push(Markup.button.callback(batches[i+1].name, `INIT_${batches[i+1].id}`));
            buttons.push(row);
        }
        
        ctx.reply('Select a Batch:', Markup.inlineKeyboard(buttons));
    } catch (e) {
        ctx.reply("❌ Error fetching batches.");
    }
});

// START BATCH: Sub 0, Type 0 (Lectures), Offset 0
bot.action(/^INIT_(\w+)$/, (ctx) => {
    const batchId = ctx.match[1];
    ctx.answerCbQuery("Starting Batch...");
    handleContentFlow(ctx, batchId, 0, 0, 0);
});

// NAVIGATE FLOW: Batch, SubIdx, TypeIdx, Offset
bot.action(/^FLOW_(\w+)_(\d+)_(\d+)_(\d+)$/, (ctx) => {
    const [_, batchId, sIdx, tIdx, off] = ctx.match;
    ctx.answerCbQuery("Loading...");
    ctx.deleteMessage().catch(()=>{}); // Clean up previous menu
    handleContentFlow(ctx, batchId, parseInt(sIdx), parseInt(tIdx), parseInt(off));
});

// MARK DONE
bot.action(/^DONE_(.+)$/, async (ctx) => {
    const itemId = ctx.match[1];
    try {
        // Save to Firebase
        await set(ref(db, 'completed_items/' + itemId), true);
        
        // Visual Feedback: Remove Button & Add "Completed" text
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n✅ **COMPLETED**`, 
            { parse_mode: 'Markdown' } // Remove keyboard (buttons)
        );
        ctx.answerCbQuery("Marked as done!");
    } catch (e) {
        console.error(e);
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
