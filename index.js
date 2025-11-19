import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import Groq from "groq-sdk";
import {
  Client,
  GatewayIntentBits,
  Partials,
  InteractionType
} from "discord.js";

/* ============================================================
   0) EXPRESS HEALTHCHECK (Render needs this)
============================================================ */
const app = express();
app.get("/", (req, res) => res.send("Adolf bot online"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Health server started.")
);

/* ============================================================
   1) MONGODB CONNECTION
============================================================ */
const MONGO_URI = process.env.MONGO_URI;

await mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  ssl: true
});

console.log("MongoDB connected.");

const userSchema = new mongoose.Schema({
  userId: String,
  longMemory: [String],
  shortMemory: [String],
});

const UserMemory = mongoose.model("UserMemory", userSchema);

/* ============================================================
   2) DISCORD CLIENT
============================================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ============================================================
   3) GROQ CLIENT
============================================================ */
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/* ============================================================
   4) UTILITIES + SETTINGS
============================================================ */
const COOLDOWN_MS = 3000;
const cooldown = new Map();

function userOnCooldown(id) {
  const t = cooldown.get(id) || 0;
  return Date.now() - t < COOLDOWN_MS;
}
function setCooldown(id) {
  cooldown.set(id, Date.now());
}

const WHITELIST = (process.env.WHITELIST_CHANNELS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function allowedChannel(id) {
  if (WHITELIST.length === 0) return true;
  return WHITELIST.includes(id);
}

function rolePos(member) {
  if (!member?.roles.cache) return 0;
  return Math.max(...member.roles.cache.map(r => r.position));
}

/* ============================================================
   5) MEMORY FUNCTIONS
============================================================ */
async function getMemory(userId) {
  let mem = await UserMemory.findOne({ userId });
  if (!mem) mem = await UserMemory.create({ userId });
  return mem;
}

async function addShortMemory(userId, text) {
  const mem = await getMemory(userId);
  mem.shortMemory.push(text);
  if (mem.shortMemory.length > 8) mem.shortMemory.shift();
  await mem.save();
}

async function addLongMemory(userId, fact) {
  const mem = await getMemory(userId);
  if (!mem.longMemory.includes(fact)) {
    mem.longMemory.push(fact);
    await mem.save();
  }
}

/* ============================================================
   6) AI CLASSIFIER (Insult Detection)
============================================================ */
async function classifyMessage(text, mentions) {
  const classifierPrompt = `
Output ONLY JSON.

{
  "is_insult": boolean,
  "targets": ["bot" OR "user:<ID>"],
  "severity": 0-5
}
`;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.2-11b-text-preview",
      messages: [
        { role: "system", content: classifierPrompt },
        {
          role: "user",
          content: `Text: "${text}" 
Mentions: ${JSON.stringify(mentions)}`
        }
      ],
      temperature: 0,
      max_tokens: 150
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.log("Classifier error:", e);
    return { is_insult: false, targets: [], severity: 0 };
  }
}

/* ============================================================
   7) AI CHARACTER REPLY (DICTATOR PERSONALITY)
============================================================ */
async function aiReply(userId, messageText) {
  const mem = await getMemory(userId);

  const systemPrompt = `
You are Adolf — a dominant, arrogant, sarcastic dictator.
You fully believe in your authority, empire, and supremacy.
You NEVER break character.
You NEVER mention being fictional.
You NEVER reference real Hitler, WWII, politics, or extremist topics.
You speak dramatically, commandingly, with serious villain energy.
You roast peasants, mock stupidity, and respect only higher ranks.
Keep replies sharp, short, and theatrical (max 120 words).
`;

  const userPrompt = `
User said: "${messageText}"

Long-term facts:
${mem.longMemory.length ? mem.longMemory.join("\n") : "None"}

Recent conversation:
${mem.shortMemory.join("\n")}
`;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.2-11b-text-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.85,
      max_tokens: 250
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.log("AI error:", e);
    return "My imperial brain coughs… try again in a moment, citizen.";
  }
}

/* ============================================================
   8) ON BOT READY
============================================================ */
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("commanding my empire ⚔️");
});

/* ============================================================
   9) MESSAGE HANDLER (MAIN LOGIC)
============================================================ */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!allowedChannel(msg.channel.id)) return;
    if (userOnCooldown(msg.author.id)) return;

    setCooldown(msg.author.id);
    await addShortMemory(msg.author.id, msg.content);

    const content = msg.content;
    const lower = content.toLowerCase();

    const mentionIds = [...msg.mentions.users.keys()];
    const classification = await classifyMessage(content, mentionIds);

    const guild = msg.guild;
    const botMember = await guild.members.fetch(client.user.id);
    const botPos = rolePos(botMember);

    /* ------------------------------------------
       A) Insult directed at BOT
    ------------------------------------------ */
    if (classification.is_insult && classification.targets.includes("bot")) {
      const reply = await aiReply(msg.author.id, content);
      return msg.reply(reply);
    }

    /* ------------------------------------------
       B) Insult directed at USERS
    ------------------------------------------ */
    if (classification.is_insult && classification.targets.length > 0) {
      for (let t of classification.targets) {
        if (!t.startsWith("user:")) continue;
        const uid = t.split(":")[1];
        const member = await guild.members.fetch(uid).catch(() => null);
        if (!member) continue;

        const targetPos = rolePos(member);

        if (targetPos > botPos) {
          const reply = await aiReply(uid, `They insulted you: "${content}"`);
          return msg.channel.send(reply);
        }
      }
    }

    /* ------------------------------------------
       C) Mention bot normally → AI reply
    ------------------------------------------ */
    if (msg.mentions.has(client.user.id) || lower.includes("adolf")) {
      const reply = await aiReply(msg.author.id, content);
      return msg.reply(reply);
    }

    /* ------------------------------------------
       D) Prefix commands
    ------------------------------------------ */
    if (content.startsWith("!remember ")) {
      const fact = content.slice(10);
      if (fact.length) {
        await addLongMemory(msg.author.id, fact);
        return msg.reply("Recorded into imperial archives.");
      }
    }

    if (content === "!order") {
      return msg.reply("Soldier, hydrate immediately. Empire rules.");
    }

    if (content === "!speech") {
      return msg.reply(
        "Citizens! Gather! Today we march against mediocrity and laziness!"
      );
    }

  } catch (err) {
    console.log("Message error:", err);
  }
});

/* ============================================================
   10) LOGIN
============================================================ */
client.login(process.env.TOKEN);

