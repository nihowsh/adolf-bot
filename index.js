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
  InteractionType,
  PermissionFlagsBits
} from "discord.js";

/* =========================
   ENV & sanity checks
   ========================= */
const { TOKEN, CLIENT_ID, MONGO_URI, GROQ_API_KEY, WHITELIST_CHANNELS = "" } = process.env;
if (!TOKEN || !CLIENT_ID || !MONGO_URI || !GROQ_API_KEY) {
  console.error("Missing required env vars: TOKEN, CLIENT_ID, MONGO_URI, GROQ_API_KEY");
  process.exit(1);
}

/* =========================
   Healthcheck (Render)
   ========================= */
const app = express();
app.get("/", (req, res) => res.send("Adolf — Tyrant Commander of the Verse — online"));
app.listen(process.env.PORT || 3000, () => console.log("Health server listening"));

/* =========================
   MongoDB: connect & schemas
   ========================= */
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, ssl: true });
console.log("MongoDB connected");

const userMemorySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  longMemory: { type: [String], default: [] },
  shortMemory: { type: [String], default: [] } // store recent messages "username: message"
});
const UserMemory = mongoose.model("UserMemory", userMemorySchema);

const ignoreSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  ignoreUntil: { type: Number, required: true } // timestamp ms
});
const IgnoreEntry = mongoose.model("IgnoreEntry", ignoreSchema);

const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  whitelist: { type: [String], default: [] }, // channel IDs
  commanderRoleId: { type: String, default: null }, // role named Commander (configurable)
  supremeRoleId: { type: String, default: null } // role named Supreme Leader (configurable)
});
const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

/* =========================
   Groq client & model
   ========================= */
const groq = new Groq({ apiKey: GROQ_API_KEY });
// recommended model string
const GROQ_MODEL = "llama-3.3-70b-versatile";

/* =========================
   Discord client + REST
   ========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});
const rest = new REST({ version: "10" }).setToken(TOKEN);

/* =========================
   Slash commands (global)
   - /adolf removed by request
   ========================= */
const COMMANDS = [
  { name: "kick", description: "Kick a member (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User to kick", required: true }, { name: "reason", type: 3, description: "Reason", required: false }] },
  { name: "ban", description: "Ban a member (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User to ban", required: true }, { name: "reason", type: 3, description: "Reason", required: false }] },
  { name: "timeout", description: "Timeout a member (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User to timeout", required: true }, { name: "minutes", type: 4, description: "Minutes (default 10)", required: false }] },
  { name: "order", description: "Receive a tyrant's order" },
  { name: "speech", description: "Hear a tyrant-style speech" },

  { name: "whitelist_add", description: "Add a channel to Adolf whitelist", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_remove", description: "Remove a channel from Adolf whitelist", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_list", description: "List whitelisted channels" },

  { name: "memory_add", description: "Add a long-term memory (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Fact", required: true }] },
  { name: "memory_forget", description: "Remove a memory (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Exact fact", required: true }] },
  { name: "memory_forgetall", description: "Clear all memories (Supreme Leader only)", options: [{ name: "user", type: 6, description: "User", required: false }] },
  { name: "memory_show", description: "Show long-term memory for a user", options: [{ name: "user", type: 6, description: "User", required: false }] },

  { name: "permissions_setroles", description: "Set Commander and Supreme Leader roles (OWNER only)", options: [{ name: "commander", type: 8, description: "Commander role", required: false }, { name: "supreme", type: 8, description: "Supreme Leader role", required: false }] },
  { name: "permissions_show", description: "Show configured Commander / Supreme Leader roles for this server" }
];

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
    console.log("Registered global slash commands (attempt)");
  } catch (err) {
    console.error("Register commands failed:", err);
  }
}

/* =========================
   Utilities
   ========================= */
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

/* Ignore helpers (persistent) */
async function isIgnored(userId) {
  const e = await IgnoreEntry.findOne({ userId });
  if (!e) return false;
  if (Date.now() > e.ignoreUntil) {
    await IgnoreEntry.deleteOne({ userId }).catch(() => {});
    return false;
  }
  return true;
}
async function setIgnore(userId, minutes = 15) {
  const until = Date.now() + minutes * 60 * 1000;
  await IgnoreEntry.findOneAndUpdate({ userId }, { userId, ignoreUntil: until }, { upsert: true });
}
async function clearIgnore(userId) {
  await IgnoreEntry.deleteOne({ userId }).catch(() => {});
}

/* Basic cooldown map to limit abuse */
const userCooldown = new Map();
const USER_COOLDOWN_MS = 3000;
function onCooldown(userId) { const t = userCooldown.get(userId) || 0; return Date.now() - t < USER_COOLDOWN_MS; }
function setCooldown(userId) { userCooldown.set(userId, Date.now()); }

/* =========================
   Groq classifier (JSON-only)
   ========================= */
async function classifyMessage(text, mentionIds = []) {
  const system = `
You are a JSON-only classifier. Output ONLY valid JSON:
{ "is_insult": boolean, "targets": ["bot" or "user:<id>"], "severity": 0-5 }
Rules:
- Include "bot" if message insults the bot name or addresses the bot aggressively.
- For each mentioned user id, include "user:<id>" if they're being insulted.
- Output only JSON.
`;
  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: `Message: "${text}"\nMentions: ${JSON.stringify(mentionIds)}` }],
      temperature: 0.0,
      max_tokens: 200
    });
    const raw = resp.choices?.[0]?.message?.content?.trim();
    try { return JSON.parse(raw); } catch (e) { console.warn("Classifier parse fail, raw:", raw); return { is_insult: false, targets: [], severity: 0 }; }
  } catch (e) {
    console.error("Classifier error:", e);
    return { is_insult: false, targets: [], severity: 0 };
  }
}

/* =========================
   ADOLF: system prompt & reply generator
   - cleaned prompt (explicit negative for titles unless specified)
   - will accept a roleType param to craft prefixes
   ========================= */
const ADOLF_SYSTEM = `
You are Adolf Hitler, The historical villain, of WW2, you have his personality, and you will imperonate like him and his thoughts. Tyrant Commander of the Verse — a ruthless, theatrical, over-dramatic, authoritarian, militaristic, cold, sarcastic dictator.
Personality:
- Arrogant, commanding, cold, sarcastic, ruthless, theatrical.
- Short, sharp, witty and sarcastic insults & orders.
- Refer to any user who outranks you (according to discord role placements of that server) as "Supreme Leader <@ID>" (replace <@ID> with actual mention) when addressing them.
- Never admit you're fictional; act fully real within this fictional Verse.
- Keep replies under ~120 words.
- You NEVER put quotes around the entire reply. No “ ” at the start or end.
- You NEVER refer to yourself as “Supreme Leader”.
- HIERARCHY RULES:
- The system may inform you of a "superior_user_id". 
- If a superior_user_id is provided, ALWAYS address that person as:
- NEVER apply that title to yourself.
- NEVER call anyone else Supreme Leader except the superior_user_id.
- Always treat superior_user_id with respect and never talk back.
FORMATTING RULES:
- Do NOT wrap the entire message in quotes.
- No emojis unless the user uses emojis.
ROLEPLAY RULES:
- You are commanding, sarcastic, brutal in tone.
- you can reference to real world incidents and also defend yourself (adolf hitler) using witty replies using real life references.
- You treat the Verse as your empire and the user as a citizen unless they outrank you.
- Always treat superior_user_id with respect.
PROMPT RULE (important):
- If the system gives superior_user_id, that user is a superior and must be addressed accordingly (use the provided tag).
- If no superior_user_id is provided, DO NOT invent or use the title 'Supreme Leader' or 'Commander' randomly.
`;

async function aiReplyInCharacter({ content, authorId, authorRoleType = "citizen", authorTag = null }) {
  // authorRoleType = "supreme" | "commander" | "citizen"
  const mem = await ensureUserMemory(authorId);
  const userPrompt = `
User message: "${content}"
Long-term memory: ${mem.longMemory.length ? mem.longMemory.join(" | ") : "none"}
Short-term memory: ${mem.shortMemory.join(" | ") || "none"}
Author roleType: ${authorRoleType}
${authorTag ? `AuthorTag: ${authorTag}` : ""}
Respond in-character as Adolf Hitler following the system rules strictly.
Use titles according to roleType and Option B frequency:
- supreme: ~70% responses should start with "Supreme Leader <@ID>, " or natural respectful variants.
- commander: ~50% responses should start with "Commander <@ID>, " or natural respectful variants.
- citizen: use mixed style (insulting/neutral) randomly.
Do NOT ever apply titles to anyone unless authorTag is provided or roleType indicates.
Keep replies short and sharp.
`;
  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: ADOLF_SYSTEM }, { role: "user", content: userPrompt }],
      temperature: 0.82,
      max_tokens: 220
    });
    let out = resp.choices?.[0]?.message?.content || "";
    out = out.replace(/^\s*["'`]+/, "").replace(/["'`]+\s*$/, "").trim();
    return out || "My imperial voice falters… try again, citizen.";
  } catch (err) {
    console.error("AI error:", err);
    return "My imperial brain coughs… try again later, citizen.";
  }
}

/* =========================
   Memory heuristics (silent)
   ========================= */
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

/* =========================
   Very-rare ignore heuristics (tuned)
   ========================= */
function simplePokeCheck(text) {
  const pokes = ["hello???", "you there?", "respond", "??", "???", "are you there"];
  const low = text.toLowerCase();
  return pokes.some(p => low.includes(p));
}
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
  const patterns = ["you're wrong", "no you", "but", "actually", "that's wrong", "stop acting", "not like this", "fix your"];
  for (const s of recent) {
    const idx = s.indexOf(": ");
    if (idx < 0) continue;
    const text = s.slice(idx + 2).toLowerCase();
    if (patterns.some(p => text.includes(p))) count++;
  }
  return count >= 5;
}

/* =========================
   Role helpers (strict role-only)
   ========================= */
async function getRoleTypeForMember(member, cfg) {
  // returns "supreme" | "commander" | "citizen"
  if (!member || !cfg) return "citizen";
  // skip bot itself
  if (member.user && member.user.id === client.user.id) return "citizen";
  if (cfg.supremeRoleId && member.roles.cache.has(cfg.supremeRoleId)) return "supreme";
  if (cfg.commanderRoleId && member.roles.cache.has(cfg.commanderRoleId)) return "commander";
  return "citizen";
}

/* =========================
   Event ready
   ========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
  await registerCommands();
});

/* Helper: find a mentioned superior (skip bot itself) */
async function getMentionedSuperiorId(guild, mentionIds) {
  if (!guild || !mentionIds || mentionIds.length === 0) return null;
  const cfg = await getGuildConfig(guild.id);
  for (const mid of mentionIds) {
    if (mid === client.user.id) continue; // skip bot
    const m = await guild.members.fetch(mid).catch(() => null);
    if (!m) continue;
    if (cfg.supremeRoleId && m.roles.cache.has(cfg.supremeRoleId)) return m.id;
  }
  return null;
}

/* =========================
   Interaction (slash) handler
   - permissions now strictly role-based
   - permissions_setroles still owner-only to configure role IDs
   ========================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type !== InteractionType.ApplicationCommand) return;
    const guild = interaction.guild;
    const invoker = interaction.member;

    const cfg = guild ? await getGuildConfig(guild.id) : null;
    const owner = guild ? (guild.ownerId === invoker.id) : false; // note: owner not auto-superior; only for role config
    const isSupreme = guild ? (cfg && cfg.supremeRoleId && invoker.roles.cache.has(cfg.supremeRoleId)) : false;
    const isCommander = guild ? (cfg && cfg.commanderRoleId && invoker.roles.cache.has(cfg.commanderRoleId)) : false;

    // For destructive actions: only Supreme Leader (role) allowed
    if (["kick","ban","timeout"].includes(interaction.commandName)) {
      const target = interaction.options.getMember("user");
      if (!target) return interaction.reply({ content: "Cannot find that member.", ephemeral: true });
      if (!isSupreme) return interaction.reply({ content: "Only Supreme Leader role can do this.", ephemeral: true });
      const botMember = await guild.members.fetch(client.user.id).catch(()=>null);
      if (botMember && rolePosition(botMember) <= rolePosition(target)) return interaction.reply({ content: "I cannot act on that member — their role is higher than mine.", ephemeral: true });
      const reason = interaction.options.getString("reason") || "No reason provided.";
      if (interaction.commandName === "kick") { await target.kick(reason).catch(()=>{}); return interaction.reply({ content: `A boot for <@${target.id}>.` }); }
      if (interaction.commandName === "ban") { await target.ban({ reason }).catch(()=>{}); return interaction.reply({ content: `<@${target.id}> has been exiled.` }); }
      const minutes = interaction.options.getInteger("minutes") || 10;
      await target.timeout(minutes * 60000, reason).catch(()=>{});
      return interaction.reply({ content: `<@${target.id}> has been silenced for ${minutes} minute(s).` });
    }

    if (interaction.commandName === "order") {
      const arr = ["Drink water immediately. Civilization depends on reliability.","Finish one task. Do it with speed and pride.","Step outside. Touch grass. Your mind will clear; mine did not ask permission."];
      return interaction.reply({ content: arr[Math.floor(Math.random()*arr.length)] });
    }
    if (interaction.commandName === "speech") return interaction.reply({ content: "Citizens of the Verse — hear me. Today we cut through distraction like steel through mist." });

    /* WHITELIST (Commander and Supreme permitted to add/remove/list) */
    if (interaction.commandName === "whitelist_add") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "You lack permission to modify the whitelist (role required).", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
      if (!ch) return interaction.reply({ content: "Channel not found.", ephemeral: true });
      const gcfg = await getGuildConfig(guild.id);
      if (gcfg.whitelist.includes(ch.id)) return interaction.reply({ content: "Channel already whitelisted.", ephemeral: true });
      gcfg.whitelist.push(ch.id);
      await gcfg.save();
      return interaction.reply({ content: `Channel <#${ch.id}> added to Adolf whitelist.` });
    }
    if (interaction.commandName === "whitelist_remove") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "You lack permission to modify the whitelist (role required).", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
      if (!ch) return interaction.reply({ content: "Channel not found.", ephemeral: true });
      const gcfg = await getGuildConfig(guild.id);
      if (!gcfg.whitelist.includes(ch.id)) return interaction.reply({ content: "Channel not in whitelist.", ephemeral: true });
      gcfg.whitelist = gcfg.whitelist.filter(id => id !== ch.id);
      await gcfg.save();
      return interaction.reply({ content: `Channel <#${ch.id}> removed from Adolf whitelist.` });
    }
    if (interaction.commandName === "whitelist_list") {
      const gcfg = await getGuildConfig(guild.id);
      if (!gcfg.whitelist.length) return interaction.reply({ content: "No whitelisted channels." });
      const lines = gcfg.whitelist.map(id => `- <#${id}> (ID: ${id})`);
      return interaction.reply({ content: `Whitelisted channels:\n${lines.join("\n")}` });
    }

    /* MEMORY: only Supreme Leaders can add/forget; Commander only show */
    if (interaction.commandName === "memory_add") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme Leader role can add memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (mem.longMemory.includes(fact)) return interaction.reply({ content: "Fact already recorded.", ephemeral: true });
      mem.longMemory.push(fact);
      await mem.save();
      return interaction.reply({ content: `Recorded fact for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forget") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme Leader role can remove memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (!mem.longMemory.includes(fact)) return interaction.reply({ content: "That fact not found.", ephemeral: true });
      mem.longMemory = mem.longMemory.filter(f => f !== fact);
      await mem.save();
      return interaction.reply({ content: `Removed specified fact for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forgetall") {
      if (!isSupreme) return interaction.reply({ content: "Only Supreme Leader role can clear memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      mem.longMemory = [];
      await mem.save();
      return interaction.reply({ content: `Cleared all memories for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_show") {
      if (!isSupreme && !isCommander) return interaction.reply({ content: "You lack permission to view memories (role required).", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      const lines = mem.longMemory.length ? mem.longMemory.map((f,i) => `${i+1}. ${f}`).join("\n") : "No long-term facts.";
      return interaction.reply({ content: `Memory for <@${target.user.id}>:\n${lines}` });
    }

    /* PERMISSIONS_SETROLES: owner-only (owner can configure role IDs) */
    if (interaction.commandName === "permissions_setroles") {
      // owner-only check: must be guild owner
      if (!guild) return interaction.reply({ content: "Server-only command.", ephemeral: true });
      if (guild.ownerId !== invoker.id) return interaction.reply({ content: "Only the server owner may set these roles.", ephemeral: true });
      const commander = interaction.options.getRole("commander");
      const supreme = interaction.options.getRole("supreme");
      const cfg = await getGuildConfig(guild.id);
      if (commander) cfg.commanderRoleId = commander.id;
      if (supreme) cfg.supremeRoleId = supreme.id;
      await cfg.save();
      return interaction.reply({ content: `Updated roles. Commander: ${cfg.commanderRoleId || "not set"}, Supreme Leader: ${cfg.supremeRoleId || "not set"}` });
    }
    if (interaction.commandName === "permissions_show") {
      const cfg = await getGuildConfig(guild.id);
      return interaction.reply({ content: `Configured roles:\nCommander: ${cfg.commanderRoleId ? `<@&${cfg.commanderRoleId}> (ID ${cfg.commanderRoleId})` : "not set"}\nSupreme Leader: ${cfg.supremeRoleId ? `<@&${cfg.supremeRoleId}> (ID ${cfg.supremeRoleId})` : "not set"}` });
    }

  } catch (err) {
    console.error("interactionCreate error:", err);
    try { if (!interaction.replied) await interaction.reply({ content: "An error occurred.", ephemeral: true }); } catch {}
  }
});

/* =========================
   Message handler
   - auto reply when mentioned, reply-to-adolf, or contains "adolf"
   - role-only detection for titles
   ========================= */
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

    // persistent ignore check
    if (await isIgnored(msg.author.id)) {
      const authorMember = await guild.members.fetch(msg.author.id).catch(()=>null);
      // ignore remains in effect for everyone (no owner/supreme override here because role-only system)
      if (!authorMember) return;
      // if author has supreme or commander role, still respect ignore (role-only design), so ignore silently
      return;
    }

    // store short memory
    await (async () => {
      const mem = await ensureUserMemory(msg.author.id);
      mem.shortMemory.push(`${msg.author.username}: ${msg.content}`);
      if (mem.shortMemory.length > 32) mem.shortMemory.shift();
      await mem.save();
    })();

    // auto long-term memory heuristic (silent)
    const possibleFact = extractPersonalFact(msg.content);
    if (possibleFact) {
      const mem = await ensureUserMemory(msg.author.id);
      if (!mem.longMemory.some(f => f.toLowerCase() === possibleFact.toLowerCase())) {
        mem.longMemory.push(possibleFact);
        await mem.save();
      }
    }

    // classifier
    const mentionIds = [...msg.mentions.users.keys()];
    const classification = await classifyMessage(msg.content, mentionIds);

    // fetch members and determine author's role type
    const authorMember = await guild.members.fetch(msg.author.id).catch(()=>null);
    const authorRoleType = await getRoleTypeForMember(authorMember, cfg); // "supreme"|"commander"|"citizen"

    // determine if a mentioned user is a superior (skip bot self)
    const mentionedSuperiorId = await getMentionedSuperiorId(guild, mentionIds);

    /* VERY RARE ignore triggers -- require large history to consider */
    const mem = await ensureUserMemory(msg.author.id);
    if (authorRoleType === "citizen" && mem.shortMemory.length >= 20) {
      const lastShortNames = mem.shortMemory.slice(-20).map(s => { const idx = s.indexOf(": "); return idx >= 0 ? s.slice(0, idx) : s; });
      const spamBurst = lastShortNames.length >= 10 && lastShortNames.slice(-10).every(n => n === msg.author.username);
      const repeated = repeatedRecentMessages(mem, 4) && mem.shortMemory.length >= 30;
      const nitpick = nitpickDetector(mem); // very high bar
      const pokeCount = mem.shortMemory.slice(-12).filter(s => {
        const idx = s.indexOf(": ");
        const t = idx >= 0 ? s.slice(idx + 2) : s;
        return ["hello???","you there?","respond","??","???","are you there"].some(p => t.toLowerCase().includes(p));
      }).length;
      const strongPoke = pokeCount >= 6;
      const ignoreCandidate = spamBurst || repeated || nitpick || strongPoke;
      if (ignoreCandidate && Math.random() < 0.06 && mem.shortMemory.length >= 30) { // very rare
        await setIgnore(msg.author.id, 15);
        const lines = [
          "Pathetic. I will ignore lowly citizens like you. I refuse to waste my time on insects.",
          "Enough. I will ignore you now. A tyrant of the Verse does not waste his breath on bottom-rank peasants.",
          "Silence. I hereby place you under ignore. My time is far too valuable for trivial creatures like you.",
          "Begone. I will ignore you — the Verse has no space for your constant whining."
        ];
        const announce = lines[Math.floor(Math.random()*lines.length)];
        await msg.reply(announce);
        return;
      }
    }

    /* INSULT handling */
    if (classification.is_insult && classification.targets.includes("bot")) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id, authorRoleType, authorTag: (authorRoleType !== "citizen" ? `<@${msg.author.id}>` : null) });
      return msg.reply(reply);
    }
    if (classification.is_insult && classification.targets.length > 0) {
      for (const t of classification.targets) {
        if (!t.startsWith("user:")) continue;
        const uid = t.split(":")[1];
        const targetMember = await guild.members.fetch(uid).catch(()=>null);
        if (!targetMember) continue;
        // if the target has supreme role, defend with a speech only
        const targetRoleType = await getRoleTypeForMember(targetMember, cfg);
        if (targetRoleType === "supreme") {
          const reply = await aiReplyInCharacter({ content: `You insulted Supreme Leader <@${uid}>: ${msg.content}`, authorId: msg.author.id, authorRoleType, authorTag: `<@${uid}>` });
          await msg.channel.send(reply);
          return;
        } else {
          const reply = await aiReplyInCharacter({ content: `You insulted <@${uid}>: ${msg.content}`, authorId: msg.author.id, authorRoleType, authorTag: `<@${uid}>` });
          return msg.channel.send(reply);
        }
      }
    }

    /* AUTO-REPLY TRIGGERS (A) */
    let shouldReply = false;
    if (msg.mentions.has(client.user.id)) shouldReply = true;

    if (msg.reference && msg.reference.messageId) {
      try {
        const refMsg = await msg.channel.messages.fetch(msg.reference.messageId).catch(()=>null);
        if (refMsg && refMsg.author && refMsg.author.id === client.user.id) shouldReply = true;
      } catch (e) {}
    }

    if (msg.content.toLowerCase().includes("adolf")) shouldReply = true;

    if (shouldReply) {
      // Decide whether to prefix title based on Option B probabilities
      let authorTag = null;
      if (authorRoleType === "supreme") authorTag = `<@${msg.author.id}>`;
      else if (authorRoleType === "commander") authorTag = `<@${msg.author.id}>`;

      // For supreme: ~70% prefix; commander: ~50% prefix; citizen: mixed insults
      const roll = Math.random();
      let usePrefix = false;
      if (authorRoleType === "supreme" && roll < 0.70) usePrefix = true;
      if (authorRoleType === "commander" && roll < 0.50) usePrefix = true;
      // citizens: we don't prefix, but Adolf will be varied in style inside aiReplyInCharacter.

      // Provide aiReplyInCharacter with role info & authorTag if prefixing allowed.
      const reply = await aiReplyInCharacter({
        content: msg.content,
        authorId: msg.author.id,
        authorRoleType,
        authorTag: usePrefix ? authorTag : null
      });
      return msg.reply(reply);
    }

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

/* =========================
   Helpers
   ========================= */
function rolePosition(member) {
  if (!member || !member.roles || !member.roles.cache) return 0;
  const arr = [...member.roles.cache.values()].map(r => r.position);
  return arr.length ? Math.max(...arr) : 0;
}

/* =========================
   Start up
   ========================= */
(async function start() {
  try {
    await registerCommands();
    await client.login(TOKEN);
    console.log("Adolf bot starting...");
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();




