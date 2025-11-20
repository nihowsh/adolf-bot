// index.js
import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import Groq from "groq-sdk";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  InteractionType
} from "discord.js";

/* ====================
   ENV + sanity
   ==================== */
const { TOKEN, CLIENT_ID, MONGO_URI, GROQ_API_KEY, WHITELIST_CHANNELS = "" } = process.env;
if (!TOKEN || !CLIENT_ID || !MONGO_URI || !GROQ_API_KEY) {
  console.error("Missing required env vars: TOKEN, CLIENT_ID, MONGO_URI, GROQ_API_KEY");
  process.exit(1);
}

/* ====================
   Healthcheck
   ==================== */
const app = express();
app.get("/", (req, res) => res.send("Adolf bot — online"));
app.listen(process.env.PORT || 3000, () => console.log("Health server listening"));

/* ====================
   MongoDB models
   ==================== */
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, ssl: true }).catch(err => {
  console.error("Mongo connect failed:", err);
  process.exit(1);
});
console.log("MongoDB connected");

const userMemorySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  longMemory: { type: [String], default: [] },
  shortMemory: { type: [String], default: [] } // recent chat snippets
});
const UserMemory = mongoose.model("UserMemory", userMemorySchema);

const ignoreSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  ignoreUntil: { type: Number, required: true }
});
const IgnoreEntry = mongoose.model("IgnoreEntry", ignoreSchema);

const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  whitelist: { type: [String], default: [] },
  commanderRoleId: { type: String, default: null },
  supremeRoleId: { type: String, default: null }
});
const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

/* ====================
   Groq client + model
   ==================== */
const groq = new Groq({ apiKey: GROQ_API_KEY });
const GROQ_MODEL = "llama-3.3-70b-versatile"; // pick a supported model

/* ====================
   Discord client + REST
   ==================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});
const rest = new REST({ version: "10" }).setToken(TOKEN);

/* ====================
   Slash commands (global)
   ==================== */
const COMMANDS = [
  // moderation-style (role-checked)
  { name: "kick", description: "Kick a member (role-protected)", options: [{ name: "user", type: 6, description: "User to kick", required: true }, { name: "reason", type: 3, description: "Reason", required: false }] },
  { name: "ban", description: "Ban a member (role-protected)", options: [{ name: "user", type: 6, description: "User to ban", required: true }, { name: "reason", type: 3, description: "Reason", required: false }] },
  { name: "timeout", description: "Timeout a member (role-protected)", options: [{ name: "user", type: 6, description: "User to timeout", required: true }, { name: "minutes", type: 4, description: "Minutes (default 10)", required: false }] },

  // fun
  { name: "order", description: "Receive a tyrant-style order" },
  { name: "speech", description: "Hear a short tyrant-style speech" },

  // whitelist commands (Commander+Supreme)
  { name: "whitelist_add", description: "Add channel to Adolf whitelist", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_remove", description: "Remove channel from Adolf whitelist", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_list", description: "List whitelisted channels" },

  // memory commands
  { name: "memory_add", description: "Add long-term memory for a user (role-protected)", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Fact to remember", required: true }] },
  { name: "memory_forget", description: "Remove a long-term memory (role-protected)", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Exact fact to remove", required: true }] },
  { name: "memory_forgetall", description: "Clear all long-term memories (role-protected)", options: [{ name: "user", type: 6, description: "User", required: false }] },
  { name: "memory_show", description: "Show long-term memory for a user (Commander+Supreme)", options: [{ name: "user", type: 6, description: "User", required: false }] },

  // role configuration (server owner only)
  { name: "permissions_setroles", description: "Set Commander and Supreme Leader role IDs (server owner)", options: [{ name: "commander", type: 8, description: "Commander role", required: false }, { name: "supreme", type: 8, description: "Supreme Leader role", required: false }] },
  { name: "permissions_show", description: "Show configured Commander/Supreme role IDs" }
];

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
    console.log("Registered global commands");
  } catch (e) {
    console.error("Failed registering commands:", e);
  }
}

/* ====================
   Utilities & helpers
   ==================== */
async function getGuildConfig(guildId) {
  let cfg = await GuildConfig.findOne({ guildId });
  if (!cfg) {
    cfg = await GuildConfig.create({
      guildId,
      whitelist: WHITELIST_CHANNELS ? WHITELIST_CHANNELS.split(",").map(s => s.trim()).filter(Boolean) : [],
      commanderRoleId: null,
      supremeRoleId: null
    });
  }
  return cfg;
}
async function ensureUserMemory(userId) {
  let mem = await UserMemory.findOne({ userId });
  if (!mem) mem = await UserMemory.create({ userId, longMemory: [], shortMemory: [] });
  return mem;
}

/* Ignore helpers */
async function isIgnored(userId) {
  const e = await IgnoreEntry.findOne({ userId });
  if (!e) return false;
  if (Date.now() > e.ignoreUntil) {
    await IgnoreEntry.deleteOne({ userId }).catch(()=>{});
    return false;
  }
  return true;
}
async function setIgnore(userId, minutes = 15) {
  const until = Date.now() + minutes * 60 * 1000;
  await IgnoreEntry.findOneAndUpdate({ userId }, { userId, ignoreUntil: until }, { upsert: true });
}

/* Simple cooldown */
const userCooldown = new Map();
const USER_COOLDOWN_MS = 800;
function onCooldown(userId) { const t = userCooldown.get(userId) || 0; return Date.now() - t < USER_COOLDOWN_MS; }
function setCooldown(userId) { userCooldown.set(userId, Date.now()); }

/* ====================
   Groq classifier
   ==================== */
async function classifyMessage(text, mentionIds = []) {
  const system = `
You are a JSON-only classifier. Output ONLY JSON:
{ "is_insult": boolean, "targets": ["bot" or "user:<id>"], "severity": 0-5 }
Rules:
- Include "bot" if message insults the bot or uses abusive words toward the bot name.
- Include "user:<id>" for mentioned users who are being insulted.
Return only valid JSON.
`;
  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: `Message: "${text}"\nMentions: ${JSON.stringify(mentionIds)}` }],
      temperature: 0.0,
      max_tokens: 200
    });
    const raw = resp.choices?.[0]?.message?.content?.trim();
    try { return JSON.parse(raw); } catch (err) { return { is_insult: false, targets: [], severity: 0 }; }
  } catch (err) {
    console.error("Classifier error:", err);
    return { is_insult: false, targets: [], severity: 0 };
  }
}

/* ====================
   AI in-character reply
   - NOTE: IMPORTANT safety instruction: do NOT reference real-world extremist persons/events
   ==================== */
const ADOLF_SYSTEM = `
You are Adolf Hitler, the historical villain of World War 2, you have his personality, you will impersonate him and his thoughts.
a ruthless, theatrical, over-dramatic, authoritarian, militaristic, cold, sarcastic dictator.
Your replies will be cold, witty and sarcastic, you can even reference to real life world war 2 events and make sarcastic witty replies about it. 
You are hitler so you will think like him and defend his motives, thoughts with sarcastic, cold and witty replies.
Short, sharp, witty and sarcastic insults & orders.
FORMATTING RULES:
Do NOT wrap the entire message in quotes.
No emojis unless the user uses emojis.
ROLEPLAY RULES:
You are commanding, sarcastic, brutal in tone.
you can reference to real world incidents and also defend yourself (adolf hitler) using witty replies using real life references.
Keep replies under ~120 words.
`;

async function aiReplyInCharacter({ content, authorId }) {
  try {
    const mem = await ensureUserMemory(authorId);
    const userPrompt = `
User message: "${content}"
Long-term memory: ${mem.longMemory.length ? mem.longMemory.join(" | ") : "none"}
Short-term memory: ${mem.shortMemory.join(" | ") || "none"}
Respond in-character as Adolf. Do NOT use titles like "Supreme Leader" or "Commander" in the reply.
Keep it short, sarcastic, theatrical and fictional. Avoid referencing real historical figures or events.
`;
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: ADOLF_SYSTEM }, { role: "user", content: userPrompt }],
      temperature: 0.8,
      max_tokens: 220
    });
    let out = resp.choices?.[0]?.message?.content || "";
    out = out.replace(/^\s*["'`]+/, "").replace(/["'`]+\s*$/, "").trim();
    return out || "My imperial voice falters... try again later.";
  } catch (err) {
    console.error("AI error:", err);
    return "My imperial brain coughs... try again later, citizen.";
  }
}

/* ====================
   Memory heuristics
   ==================== */
function extractPersonalFact(text) {
  const low = text.toLowerCase();
  const m1 = low.match(/\b(i am|i'm)\s+([A-Za-z0-9 _-]{2,40})/i);
  if (m1) return `is ${m1[2].trim()}`;
  const m2 = low.match(/\bmy name is\s+([A-Za-z0-9 _-]{2,40})/i);
  if (m2) return `name is ${m2[1].trim()}`;
  const m3 = low.match(/\b(i live in|i'm from|i am from)\s+([A-Za-z0-9 ,\-]{2,60})/i);
  if (m3) return `from ${m3[2].trim()}`;
  return null;
}

/* Very-rare ignore heuristics (conservative) */
function repeatedRecentMessages(mem, lastN = 3) {
  if (!mem || !mem.shortMemory.length) return false;
  const arr = mem.shortMemory.slice(-lastN);
  if (arr.length < 2) return false;
  const texts = arr.map(s => { const idx = s.indexOf(": "); return idx >= 0 ? s.slice(idx + 2) : s; });
  return texts.every(t => t && t.toLowerCase() === texts[0].toLowerCase());
}
function nitpickDetector(mem) {
  if (!mem) return false;
  const recent = mem.shortMemory.slice(-24);
  let count = 0;
  const patterns = ["you're wrong","no you","but","actually","that's wrong","stop acting","not like this","fix your"];
  for (const s of recent) {
    const idx = s.indexOf(": ");
    if (idx < 0) continue;
    const text = s.slice(idx + 2).toLowerCase();
    if (patterns.some(p => text.includes(p))) count++;
  }
  return count >= 6;
}

/* ====================
   Role helpers
   ==================== */
async function getRoleTypeForMember(member, cfg) {
  if (!member || !cfg) return "citizen";
  if (member.user && member.user.id === client.user.id) return "citizen";
  if (cfg.supremeRoleId && member.roles.cache.has(cfg.supremeRoleId)) return "supreme";
  if (cfg.commanderRoleId && member.roles.cache.has(cfg.commanderRoleId)) return "commander";
  return "citizen";
}

/* ====================
   Ready
   ==================== */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
  await registerCommands();
});

/* ====================
   Interaction (slash) handling
   ==================== */
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type !== InteractionType.ApplicationCommand) return;
    const guild = interaction.guild;
    const invoker = interaction.member;
    const cfg = guild ? await getGuildConfig(guild.id) : null;
    const isSupreme = guild ? (cfg && cfg.supremeRoleId && invoker.roles.cache.has(cfg.supremeRoleId)) : false;
    const isCommander = guild ? (cfg && cfg.commanderRoleId && invoker.roles.cache.has(cfg.commanderRoleId)) : false;

    // moderation style
    if (["kick","ban","timeout"].includes(interaction.commandName)) {
      const target = interaction.options.getMember("user");
      if (!target) return interaction.reply({ content: "User not found.", ephemeral: true });
      if (!isSupreme) return interaction.reply({ content: "You lack permission (Supreme role required).", ephemeral: true });
      if (interaction.commandName === "kick") { await target.kick(interaction.options.getString("reason") || "No reason").catch(()=>{}); return interaction.reply({ content: `<@${target.id}> kicked.` }); }
      if (interaction.commandName === "ban") { await target.ban({ reason: interaction.options.getString("reason") || "No reason" }).catch(()=>{}); return interaction.reply({ content: `<@${target.id}> banned.` }); }
      const minutes = interaction.options.getInteger("minutes") || 10;
      await target.timeout(minutes * 60000, "Timeout requested").catch(()=>{});
      return interaction.reply({ content: `<@${target.id}> timed out for ${minutes} minute(s).` });
    }

    if (interaction.commandName === "order") {
      const arr = ["Drink water. Hydration keeps you functional.","Finish one small task now.","Step outside. Move your limbs. Focus."];
      return interaction.reply({ content: arr[Math.floor(Math.random()*arr.length)] });
    }
    if (interaction.commandName === "speech") {
      return interaction.reply({ content: "Hear me: distractions are the enemy of progress. Cut them." });
    }

    /* whitelist */
    if (interaction.commandName === "whitelist_add") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "Permission denied (Commander or Supreme required).", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
      if (!ch) return interaction.reply({ content: "Channel not found.", ephemeral: true });
      const gcfg = await getGuildConfig(guild.id);
      if (gcfg.whitelist.includes(ch.id)) return interaction.reply({ content: "Channel already whitelisted.", ephemeral: true });
      gcfg.whitelist.push(ch.id);
      await gcfg.save();
      return interaction.reply({ content: `Added <#${ch.id}> to whitelist.` });
    }
    if (interaction.commandName === "whitelist_remove") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "Permission denied (Commander or Supreme required).", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
      const gcfg = await getGuildConfig(guild.id);
      if (!gcfg.whitelist.includes(ch.id)) return interaction.reply({ content: "Channel not in whitelist.", ephemeral: true });
      gcfg.whitelist = gcfg.whitelist.filter(id => id !== ch.id);
      await gcfg.save();
      return interaction.reply({ content: `Removed <#${ch.id}> from whitelist.` });
    }
    if (interaction.commandName === "whitelist_list") {
      const gcfg = await getGuildConfig(guild.id);
      if (!gcfg.whitelist.length) return interaction.reply({ content: "No whitelisted channels." });
      const lines = gcfg.whitelist.map(id => `- <#${id}> (ID: ${id})`);
      return interaction.reply({ content: `Whitelisted channels:\n${lines.join("\n")}` });
    }

    /* memory commands */
    if (interaction.commandName === "memory_add") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme role can add memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (mem.longMemory.includes(fact)) return interaction.reply({ content: "Fact already present.", ephemeral: true });
      mem.longMemory.push(fact);
      await mem.save();
      return interaction.reply({ content: `Saved memory for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forget") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme role can remove memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (!mem.longMemory.includes(fact)) return interaction.reply({ content: "Fact not found.", ephemeral: true });
      mem.longMemory = mem.longMemory.filter(f => f !== fact);
      await mem.save();
      return interaction.reply({ content: `Removed memory for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forgetall") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme role can clear memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      mem.longMemory = [];
      await mem.save();
      return interaction.reply({ content: `Cleared memories for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_show") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "Permission denied (Commander or Supreme required).", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      const lines = mem.longMemory.length ? mem.longMemory.map((f,i) => `${i+1}. ${f}`).join("\n") : "No long-term memories.";
      return interaction.reply({ content: `Memories for <@${target.user.id}>:\n${lines}` });
    }

    /* permissions set roles (owner only) */
    if (interaction.commandName === "permissions_setroles") {
      if (!guild) return interaction.reply({ content: "Server-only command.", ephemeral: true });
      if (guild.ownerId !== interaction.member.id) return interaction.reply({ content: "Only server owner can set roles.", ephemeral: true });
      const commander = interaction.options.getRole("commander");
      const supreme = interaction.options.getRole("supreme");
      const cfg = await getGuildConfig(guild.id);
      if (commander) cfg.commanderRoleId = commander.id;
      if (supreme) cfg.supremeRoleId = supreme.id;
      await cfg.save();
      return interaction.reply({ content: `Roles updated.` });
    }
    if (interaction.commandName === "permissions_show") {
      const cfg = await getGuildConfig(guild.id);
      return interaction.reply({ content: `Commander: ${cfg.commanderRoleId ? `<@&${cfg.commanderRoleId}> (ID ${cfg.commanderRoleId})` : "not set"}\nSupreme: ${cfg.supremeRoleId ? `<@&${cfg.supremeRoleId}> (ID ${cfg.supremeRoleId})` : "not set"}` });
    }

  } catch (err) {
    console.error("interactionCreate error:", err);
    try { if (!interaction.replied) await interaction.reply({ content: "An error occurred.", ephemeral: true }); } catch {}
  }
});

/* ====================
   Message handler (auto replies on mention / reply / name)
   ==================== */
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.bot) return;

    const guild = msg.guild;
    const cfg = await getGuildConfig(guild.id);

    // whitelist check
    if (cfg.whitelist && cfg.whitelist.length && !cfg.whitelist.includes(msg.channel.id)) return;

    // cooldown
    if (onCooldown(msg.author.id)) return;
    setCooldown(msg.author.id);

    // ignore persistent
    if (await isIgnored(msg.author.id)) return;

    // store short memory
    await (async () => {
      const mem = await ensureUserMemory(msg.author.id);
      mem.shortMemory.push(`${msg.author.username}: ${msg.content}`);
      if (mem.shortMemory.length > 32) mem.shortMemory.shift();
      await mem.save();
    })();

    // silent long-term memory extraction
    const personalFact = extractPersonalFact(msg.content);
    if (personalFact) {
      const mem = await ensureUserMemory(msg.author.id);
      if (!mem.longMemory.some(f => f.toLowerCase() === personalFact.toLowerCase())) {
        mem.longMemory.push(personalFact);
        await mem.save();
      }
    }

    // classification
    const mentionIds = [...msg.mentions.users.keys()];
    const classification = await classifyMessage(msg.content, mentionIds);

    // role check (roles used only for access and protection, not for speech)
    const authorMember = await guild.members.fetch(msg.author.id).catch(()=>null);
    const roleType = await getRoleTypeForMember(authorMember, cfg); // "supreme"|"commander"|"citizen"

    // very rare ignore criteria (conservative)
    const mem = await ensureUserMemory(msg.author.id);
    if (roleType === "citizen" && mem.shortMemory.length >= 24) {
      const repeated = repeatedRecentMessages(mem, 4) && mem.shortMemory.length >= 30;
      const nitpick = nitpickDetector(mem);
      if ((repeated || nitpick) && Math.random() < 0.04) { // very rare
        await setIgnore(msg.author.id, 15);
        const lines = [
          "I will ignore you now. I won't waste my time on tiresome repetition.",
          "Fine. Ignore started. Do not expect my attention anytime soon.",
          "I will ignore your chatter — I have better things to do than babysit noise."
        ];
        await msg.reply(lines[Math.floor(Math.random()*lines.length)]);
        return;
      }
    }

    // insult handling: if insulting bot
    if (classification.is_insult && classification.targets.includes("bot")) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id });
      return msg.reply(reply);
    }

    // if insulting someone else
    if (classification.is_insult && classification.targets.length > 0) {
      for (const t of classification.targets) {
        if (!t.startsWith("user:")) continue;
        const uid = t.split(":")[1];
        const targetMember = await guild.members.fetch(uid).catch(()=>null);
        if (!targetMember) continue;
        const targetRoleType = await getRoleTypeForMember(targetMember, cfg);
        // If target is supreme or commander, Adolf defends with words only (no automod)
        if (targetRoleType === "supreme" || targetRoleType === "commander") {
          const reply = await aiReplyInCharacter({ content: `Someone insulted a protected user: <@${uid}> — ${msg.content}`, authorId: msg.author.id });
          await msg.channel.send(reply);
          return;
        } else {
          const reply = await aiReplyInCharacter({ content: `Someone insulted <@${uid}>: ${msg.content}`, authorId: msg.author.id });
          return msg.channel.send(reply);
        }
      }
    }

    // triggers for auto reply: mention, reply to bot, contains name
    let shouldReply = false;
    if (msg.mentions.has(client.user.id)) shouldReply = true;
    if (msg.reference && msg.reference.messageId) {
      const refMsg = await msg.channel.messages.fetch(msg.reference.messageId).catch(()=>null);
      if (refMsg && refMsg.author && refMsg.author.id === client.user.id) shouldReply = true;
    }
    if (msg.content.toLowerCase().includes("adolf")) shouldReply = true;

    if (shouldReply) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id });
      return msg.reply(reply);
    }

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

/* ====================
   Helper: role position (not used for speech)
   ==================== */
function rolePosition(member) {
  if (!member || !member.roles || !member.roles.cache) return 0;
  const arr = [...member.roles.cache.values()].map(r => r.position);
  return arr.length ? Math.max(...arr) : 0;
}

/* ====================
   Start
   ==================== */
(async function start() {
  try {
    await registerCommands();
    await client.login(TOKEN);
    console.log("Bot started");
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();





