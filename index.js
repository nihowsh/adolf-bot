import "dotenv/config";
import express from "express";
import Groq from "groq-sdk";
import mongoose from "mongoose";
import {
  Client,
  GatewayIntentBits,
  Partials,
  InteractionType,
  PermissionsBitField
} from "discord.js";

/* ============================================================
   0) EXPRESS (KEEP BOT ALIVE ON RENDER)
============================================================ */
const app = express();
app.get("/", (req, res) => res.send("Adolf bot (fictional) — alive"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Health check active.")
);

/* ============================================================
   1) DATABASE (MongoDB)
============================================================ */
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI not provided!");
  process.exit(1);
}

await mongoose.connect(MONGO_URI, {
  dbName: "adolfbot",
});
console.log("✅ MongoDB connected.");

const userSchema = new mongoose.Schema({
  userId: String,
  longMemory: { type: Array, default: [] },       // permanent facts about the user
  shortMemory: { type: Array, default: [] }       // last 8 messages
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
   3) GROQ SETUP
============================================================ */
const MODEL = "llama-3.1-70b-versatile";
const CLASSIFIER_MODEL = "llama-3.1-70b-versatile";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/* ============================================================
   4) SETTINGS
============================================================ */
const WHITELIST = (process.env.WHITELIST_CHANNELS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const COOLDOWN_MS = 4000;
const cooldownMap = new Map();

function allowedChannel(id) {
  if (WHITELIST.length === 0) return true;
  return WHITELIST.includes(id);
}

function highestRole(member) {
  if (!member || !member.roles) return 0;
  const roles = [...member.roles.cache.values()].map(r => r.position);
  return roles.length ? Math.max(...roles) : 0;
}

function cooldown(userId) {
  const last = cooldownMap.get(userId) || 0;
  return Date.now() - last < COOLDOWN_MS;
}
function setCooldown(userId) {
  cooldownMap.set(userId, Date.now());
}

/* ============================================================
   5) USER MEMORY FUNCTIONS
============================================================ */
async function updateShortTermMemory(userId, message) {
  let memory = await UserMemory.findOne({ userId });

  if (!memory) memory = await UserMemory.create({ userId });

  memory.shortMemory.push(message);
  if (memory.shortMemory.length > 8)
    memory.shortMemory.shift();

  await memory.save();
}

async function getFullMemory(userId) {
  let memory = await UserMemory.findOne({ userId });
  if (!memory)
    memory = await UserMemory.create({ userId });

  return memory;
}

async function addLongTermMemory(userId, fact) {
  const memory = await getFullMemory(userId);
  if (!memory.longMemory.includes(fact)) {
    memory.longMemory.push(fact);
    await memory.save();
  }
}

/* ============================================================
   6) AI CLASSIFIER (INSULT DETECTION)
============================================================ */
async function classifyMessage(text, mentions = []) {
  const instruction = `
Output STRICT JSON ONLY:
{
  "is_insult": boolean,
  "targets": [string],   // "bot" or "user:<ID>"
  "severity": number     // 0-5
}
`;

  try {
    const resp = await groq.chat.completions.create({
      model: CLASSIFIER_MODEL,
      messages: [
        { role: "system", content: instruction },
        {
          role: "user",
          content: `Text: "${text}"
Mentions: ${JSON.stringify(mentions)}`
        }
      ],
      temperature: 0.0,
      max_tokens: 200
    });

    return JSON.parse(resp.choices[0].message.content);
  } catch (err) {
    console.log("Classifier error:", err);
    return {
      is_insult: false,
      targets: [],
      severity: 0
    };
  }
}

/* ============================================================
   7) AI REPLY ENGINE
============================================================ */

async function aiReply(userId, message, botName = "Adolf") {
  const mem = await getFullMemory(userId);

  const longTerm = mem.longMemory.join("\n- ");
  const shortTerm = mem.shortMemory.join("\nUser: ");

  const systemPrompt = `
You are "${botName}", a fictional overdramatic sarcastic dictator.
RULES:
- NEVER reference real historical people or events
- PURELY fictional villain personality
- Dramatic, sarcastic, egotistical, short replies
- Under 120 words
`;

  const userPrompt = `
User said: "${message}"

Long-term memory about this user:
- ${longTerm || "No permanent facts"}

Recent short-term context:
${shortTerm ? "User: " + shortTerm : "No recent conversation"}

Respond in-character. Keep sarcasm, drama, and humor.
`;

  try {
    const resp = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.85,
      max_tokens: 250
    });

    return resp.choices[0].message.content.trim();
  } catch (err) {
    console.log("AI reply error:", err);
    return "My imperial brain coughs… try again later, citizen.";
  }
}

/* ============================================================
   8) READY EVENT
============================================================ */
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
});

/* ============================================================
   9) MESSAGE HANDLER
============================================================ */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    if (!allowedChannel(msg.channel.id)) return;

    if (cooldown(msg.author.id)) return;
    setCooldown(msg.author.id);

    await updateShortTermMemory(msg.author.id, msg.content);

    const content = msg.content;
    const contentLower = content.toLowerCase();
    const mentionIds = [...msg.mentions.users.keys()];

    const classify = await classifyMessage(content, mentionIds);

    const botMember = await msg.guild.members.fetch(client.user.id);
    const botPos = highestRole(botMember);

    // 1) INSULT DIRECTED AT BOT
    if (classify.is_insult && classify.targets.includes("bot")) {
      const reply = await aiReply(msg.author.id, content);
      return msg.reply(reply);
    }

    // 2) INSULT AGAINST USERS
    if (classify.is_insult && classify.targets.length > 0) {
      for (const target of classify.targets) {
        if (target.startsWith("user:")) {
          const uid = target.split(":")[1];
          const member = await msg.guild.members.fetch(uid).catch(() => null);
          if (!member) continue;

          const pos = highestRole(member);

          // Defend if the victim outranks the bot
          if (pos > botPos) {
            const reply = await aiReply(uid, `They insulted you: "${content}"`);
            return msg.channel.send(reply);
          }
        }
      }
      return;
    }

    // 3) @MENTION OF BOT
    const mentionsBot = msg.mentions.has(client.user.id) || contentLower.includes("adolf");

    if (mentionsBot) {
      const reply = await aiReply(msg.author.id, content);
      return msg.reply(reply);
    }

    // 4) PREFIX FUN COMMANDS
    if (!content.startsWith("!")) return;
    const [cmd] = content.toLowerCase().split(" ");

    if (cmd === "!order") {
      return msg.channel.send("Soldier, touch some grass immediately. That is an imperial decree.");
    }

    if (cmd === "!speech") {
      return msg.channel.send("Citizens! Assemble! Today we march against the evil of procrastination!");
    }

    if (cmd === "!remember") {
      const fact = content.split(" ").slice(1).join(" ");
      if (!fact) return msg.reply("What fact do you want me to record, citizen?");
      await addLongTermMemory(msg.author.id, fact);
      return msg.reply("Consider it remembered. Etched into the empire's archives.");
    }

  } catch (err) {
    console.log("Msg handler error:", err);
  }
});

/* ============================================================
   10) LOGIN
============================================================ */
client.login(process.env.TOKEN);
