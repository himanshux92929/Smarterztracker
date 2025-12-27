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
const URL = process.env.RENDER_EXTERNAL_URL; // Render gives this automatically

// Firebase Config (Constructed from Env or hardcoded object if you prefer)
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

// ==========================================
// 2. SETUP
// ==========================================

const app = express(); // Web server for Render
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

// Helper for API URLs
const getUrl = (path) => {
    const target = `${API_HOST}/api${path}`;
    return `${PROXY_BASE}?url=${encodeURIComponent(target)}&referrer=${encodeURIComponent(API_HOST)}`;
};

// ==========================================
// 3. LOGIC CONTROLLER
// ==========================================

/**
 * Core function to fetch data and determine buttons
 * @param {Object} ctx - Telegram Context
 * @param {String} batchId - The ID of the batch
 * @param {Number} subjectIndex - Index of the subject in the array (0, 1, 2...)
 * @param {Number} offset - How many lectures we have already shown for this subject
 */
const handleContentFlow = async (ctx, batchId, subjectIndex, offset) => {
    try {
        // 1. Get Completed Items (to filter them out)
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, `completed_items`));
        const completedMap = snapshot.exists() ? snapshot.val() : {};

        // 2. Fetch All Subjects for this Batch
        const subRes = await axios.get(getUrl(`/batches/${batchId}`));
        const subjects = subRes.data.data || [];

        // Check if we ran out of subjects
        if (subjectIndex >= subjects.length) {
            return ctx.reply("🎉 All subjects in this batch have been checked!");
        }

        const currentSubject = subjects[subjectIndex];
        
        // 3. Fetch Lectures for Current Subject
        // Note: You can add 'notes' or 'dpps' to this logic if desired
        const type = 'lectures';
        const contentRes = await axios.get(getUrl(`/${batchId}/subjects/${currentSubject.id}/${type}`));
        const allItems = contentRes.data.data || [];

        // 4. Filter Pending Items
        const pendingItems = allItems.filter(item => !completedMap[item.id]);

        // 5. Slice the next 5 items based on offset
        const batchToSend = pendingItems.slice(offset, offset + 5);

        // Header Message (Only send if offset is 0, so we don't spam the header on "Load More")
        if (offset === 0) {
            await ctx.reply(`📚 **${currentSubject.name}** (${pendingItems.length} pending)`, { parse_mode: 'Markdown' });
        }

        if (batchToSend.length === 0 && offset === 0) {
            await ctx.reply("No pending lectures here. Moving to next subject...");
            // Recursively call for next subject
            return handleContentFlow(ctx, batchId, subjectIndex + 1, 0);
        }

        // 6. Send the Lectures
        for (const item of batchToSend) {
            const title = item.title || item.name;
            const url = item.url || item.originalUrl;
            await ctx.reply(
                `📝 ${title}\n🔗 ${url}`,
                Markup.inlineKeyboard([
                    Markup.button.callback("✅ Mark Done", `DONE_${item.id}`)
                ])
            );
        }

        // 7. Determine Navigation Buttons
        const navButtons = [];
        const hasMoreInSubject = pendingItems.length > (offset + 5);
        const hasMoreSubjects = subjects.length > (subjectIndex + 1);

        if (hasMoreInSubject) {
            // Button: Load More (Same Subject, Increase Offset)
            navButtons.push(Markup.button.callback("⬇️ Load More (This Subject)", `FLOW_${batchId}_${subjectIndex}_${offset + 5}`));
        }
        
        if (hasMoreSubjects) {
            // Button: Next Subject (Next Index, Reset Offset)
            navButtons.push(Markup.button.callback("➡️ Next Subject", `FLOW_${batchId}_${subjectIndex + 1}_0`));
        }

        if (navButtons.length > 0) {
            await ctx.reply("👇 What next?", Markup.inlineKeyboard([navButtons]));
        } else {
            await ctx.reply("✅ End of this subject. No more subjects left in this batch.");
        }

    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ Error fetching data. API might be unstable.");
    }
};

// ==========================================
// 4. BOT ACTIONS
// ==========================================

bot.start(async (ctx) => {
    ctx.reply("👋 Welcome! Fetching batches...");
    try {
        const res = await axios.get(getUrl('/batches'));
        const batches = res.data.data || [];
        const buttons = batches.map(b => [Markup.button.callback(b.name, `INIT_${b.id}`)]);
        ctx.reply('Select a Batch:', Markup.inlineKeyboard(buttons));
    } catch (e) {
        ctx.reply("Error fetching batches.");
    }
});

// Initial Batch Selection -> Start at Subject 0, Offset 0
bot.action(/^INIT_(\w+)$/, (ctx) => {
    const batchId = ctx.match[1];
    ctx.answerCbQuery("Starting...");
    handleContentFlow(ctx, batchId, 0, 0);
});

// Flow Navigation (Load More / Next Subject)
bot.action(/^FLOW_(\w+)_(\d+)_(\d+)$/, (ctx) => {
    const batchId = ctx.match[1];
    const subIdx = parseInt(ctx.match[2]);
    const off = parseInt(ctx.match[3]);
    
    ctx.answerCbQuery("Loading...");
    // Delete the "What next?" message to clean up chat
    ctx.deleteMessage().catch(() => {}); 
    handleContentFlow(ctx, batchId, subIdx, off);
});

// Mark as Done
bot.action(/^DONE_(.+)$/, async (ctx) => {
    const itemId = ctx.match[1];
    try {
        await set(ref(db, 'completed_items/' + itemId), true);
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ **COMPLETED**`, { parse_mode: 'Markdown' });
        ctx.answerCbQuery("Done!");
    } catch (e) {
        ctx.answerCbQuery("Error saving.");
    }
});

// ==========================================
// 5. SERVER LAUNCH (Web App Mode)
// ==========================================

// Tell Telegram where to send updates (Webhook)
if (process.env.NODE_ENV === 'production') {
    bot.telegram.setWebhook(`${URL}/bot${BOT_TOKEN}`);
    app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`));
} else {
    // Local testing
    bot.launch();
}

app.get('/', (req, res) => {
    res.send('Bot is running properly on Render!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
