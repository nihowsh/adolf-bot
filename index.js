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
   ========================= */
const COMMANDS = [
  // moderation-like commands (manual)
  {
    name: "kick", description: "Kick a member (requires permission)", options: [
      { name: "user", type: 6, description: "User to kick", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "ban", description: "Ban a member (requires permission)", options: [
      { name: "user", type: 6, description: "User to ban", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "timeout", description: "Timeout a member (requires permission)", options: [
      { name: "user", type: 6, description: "User to timeout", required: true },
      { name: "minutes", type: 4, description: "Minutes (default 10)", required: false }
    ]
  },
  // toy commands
  { name: "order", description: "Receive a tyrant's order" },
  { name: "speech", description: "Hear a tyrant-style speech" },
  { name: "adolf", description: "Talk to Adolf", options: [{ name: "message", type: 3, description: "Message", required: true }] },

  // whitelist commands
  { name: "whitelist_add", description: "Add a channel to Adolf whitelist (owner/admin/Commander/SupremeLeader)", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_remove", description: "Remove a channel from Adolf whitelist", options: [{ name: "channel", type: 7, description: "Channel", required: true }] },
  { name: "whitelist_list", description: "List whitelisted channels" },

  // memory commands
  { name: "memory_add", description: "Add a long-term memory about a user", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Fact to remember", required: true }] },
  { name: "memory_forget", description: "Remove a specific memory from a user", options: [{ name: "user", type: 6, description: "User", required: false }, { name: "fact", type: 3, description: "Exact fact to remove", required: true }] },
  { name: "memory_forgetall", description: "Remove all memories for a user", options: [{ name: "user", type: 6, description: "User", required: false }] },
  { name: "memory_show", description: "Show long-term memory for a user", options: [{ name: "user", type: 6, description: "User", required: false }] },

  // permissions (owner only)
  { name: "permissions_setroles", description: "Set Commander and Supreme Leader roles (OWNER ONLY)", options: [{ name: "commander", type: 8, description: "Commander role", required: false }, { name: "supreme", type: 8, description: "Supreme Leader role", required: false }] },
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
   Utilities: guild config, memory, ignore
   ========================= */
async function getGuildConfig(guildId) {
  let cfg = await GuildConfig.findOne({ guildId });
  if (!cfg) {
    cfg = await GuildConfig.create({ guildId, whitelist: WHITELIST_CHANNELS ? WHITELIST_CHANNELS.split(",").map(s => s.trim()).filter(Boolean) : [], commanderRoleId: null, supremeRoleId: null });
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
   (strict, no quotes, no self-supreme)
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
  "Supreme Leader <@ID>" (substitute ID properly).
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
`;

async function aiReplyInCharacter({ content, authorId, superiorUserId = null }) {
  const mem = await ensureUserMemory(authorId);
  const userPrompt = `
User message: "${content}"
Long-term memory: ${mem.longMemory.length ? mem.longMemory.join(" | ") : "none"}
Short-term memory: ${mem.shortMemory.join(" | ") || "none"}
${superiorUserId ? `superior_user_id: ${superiorUserId}` : ""}
Respond in-character as Adolf following the system rules strictly.
`;
  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "system", content: ADOLF_SYSTEM }, { role: "user", content: userPrompt }],
      temperature: 0.82,
      max_tokens: 240
    });
    let out = resp.choices?.[0]?.message?.content || "";
    // defensive cleanup: strip full-message quotes if model slipped
    out = out.replace(/^\s*["'`]+/, "").replace(/["'`]+\s*$/, "").trim();
    return out || "My imperial voice falters… try again, citizen.";
  } catch (err) {
    console.error("AI error:", err);
    return "My imperial brain coughs… try again later, citizen.";
  }
}

/* =========================
   Auto long-term memory heuristics (conservative)
   - detects "I am X", "My name is X", "I live in X", "I work as X", "I like X"
   - will add fact if it seems new
   ========================= */
function extractPersonalFact(text) {
  const low = text.toLowerCase();
  // small patterns — keep conservative
  const m1 = low.match(/\b(i am|i'm)\s+([A-Za-z0-9 _-]{2,40})/i);
  if (m1) return `is ${m1[2].trim()}`;
  const m2 = low.match(/\bmy name is\s+([A-Za-z0-9 _-]{2,40})/i);
  if (m2) return `name is ${m2[1].trim()}`;
  const m3 = low.match(/\b(i live in|i'm from|i am from)\s+([A-Za-z0-9 ,\-]{2,60})/i);
  if (m3) return `from ${m3[2].trim()}`;
  const m4 = low.match(/\b(i work as|i'm a|i am a)\s+([A-Za-z0-9 _-]{2,60})/i);
  if (m4) return `works as ${m4[2].trim()}`;
  const m5 = low.match(/\b(i like|i love)\s+([A-Za-z0-9 _-]{2,60})/i);
  if (m5) return `likes ${m5[2].trim()}`;
  return null;
}

/* =========================
   Annoyance / ignore heuristics (rare triggers)
   - spam burst (last N shortMessages from same user)
   - repeated exact messages (recent)
   - poke phrases
   - nitpicking/backtalk detector
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
  const recent = mem.shortMemory.slice(-12);
  let count = 0;
  const patterns = ["you're wrong", "no you", "but", "actually", "that's wrong", "stop acting", "not like this", "fix your"];
  for (const s of recent) {
    const idx = s.indexOf(": ");
    if (idx < 0) continue;
    const text = s.slice(idx + 2).toLowerCase();
    if (patterns.some(p => text.includes(p))) count++;
  }
  return count >= 3;
}

/* =========================
   Permission checks helpers
   - owner override
   - check Supreme Leader role
   - check Commander role or Admin
   ========================= */
async function isGuildOwner(member) { return member.id === member.guild.ownerId; }
function hasAdmin(member) { return member.permissions?.has(PermissionFlagsBits.Administrator); }
async function hasSupremeRole(member, cfg) {
  if (!cfg?.supremeRoleId) return false;
  return member.roles.cache.has(cfg.supremeRoleId);
}
async function hasCommanderRole(member, cfg) {
  if (!cfg?.commanderRoleId) return false;
  return member.roles.cache.has(cfg.commanderRoleId);
}

/* =========================
   Event: ready
   ========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
  await registerCommands();
});

/* Helper: get superior mentioned id if any (role higher than bot) */
async function getSuperiorMentionedId(guild, mentionIds) {
  try {
    const botMember = await guild.members.fetch(client.user.id);
    for (const mid of mentionIds) {
      const m = await guild.members.fetch(mid).catch(()=>null);
      if (!m) continue;
      if (rolePosition(m) > rolePosition(botMember)) return mid;
    }
  } catch (e) {}
  return null;
}

/* =========================
   Interaction (slash commands) handler
   ========================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type !== InteractionType.ApplicationCommand) return;
    const guild = interaction.guild;
    const invoker = interaction.member;
    const invUser = interaction.user;

    const cfg = guild ? await getGuildConfig(guild.id) : null;

    // helper perms: owner, supreme, commander/admin
    const owner = invoker.id === (guild ? guild.ownerId : null);
    const isAdmin = hasAdmin(invoker);
    const isSupreme = guild ? (await hasSupremeRole(invoker, cfg)) : false;
    const isCommander = guild ? (await hasCommanderRole(invoker, cfg)) : false;
    const commanderLike = isCommander || isAdmin;

    /* ------------------ moderation commands ------------------ */
    if (["kick","ban","timeout"].includes(interaction.commandName)) {
      const target = interaction.options.getMember("user");
      if (!target) return interaction.reply({ content: "Cannot find that member.", ephemeral: true });

      // Only Supreme Leader or Owner can perform destructive actions OR members with Kick/Ban perms (we'll require Supreme/Owner)
      if (!(owner || isSupreme)) {
        return interaction.reply({ content: "You lack authority to perform that action. Only the owner or Supreme Leader may.", ephemeral: true });
      }

      const botMember = await guild.members.fetch(client.user.id).catch(()=>null);
      const botPos = rolePosition(botMember);
      const targetPos = rolePosition(target);
      if (botPos <= targetPos) return interaction.reply({ content: "I cannot act on that member — their role is higher than mine.", ephemeral: true });

      const reason = interaction.options.getString("reason") || "No reason provided.";
      if (interaction.commandName === "kick") {
        await target.kick(reason).catch(()=>{});
        return interaction.reply({ content: `A boot for <@${target.id}>.` });
      } else if (interaction.commandName === "ban") {
        await target.ban({ reason }).catch(()=>{});
        return interaction.reply({ content: `<@${target.id}> has been exiled.` });
      } else {
        const minutes = interaction.options.getInteger("minutes") || 10;
        await target.timeout(minutes * 60000, reason).catch(()=>{});
        return interaction.reply({ content: `<@${target.id}> has been silenced for ${minutes} minute(s).` });
      }
    }

    /* ------------------ toy commands ------------------ */
    if (interaction.commandName === "order") {
      const arr = ["Drink water immediately. Civilization depends on reliability.","Finish one task. Do it with speed and pride.","Step outside. Touch grass. Your mind will clear; mine did not ask permission."];
      return interaction.reply({ content: arr[Math.floor(Math.random()*arr.length)] });
    }
    if (interaction.commandName === "speech") {
      return interaction.reply({ content: "Citizens of the Verse — hear me. Today we cut through distraction like steel through mist." });
    }
    if (interaction.commandName === "adolf") {
      const text = interaction.options.getString("message");
      const mentionIds = [...(interaction.options.getString("message").match(/<@!?(\d+)>/g) || [])].map(s=>s.replace(/\D/g,"")).filter(Boolean);
      const superiorId = await getSuperiorMentionedId(guild, mentionIds);
      const reply = await aiReplyInCharacter({ content: text, authorId: interaction.user.id, superiorUserId: superiorId });
      return interaction.reply({ content: reply });
    }

    /* ------------------ whitelist commands ------------------ */
    if (interaction.commandName === "whitelist_add") {
      // only Owner or Supreme Leader or Commander/Admin (we allow Commander and Admin to add/remove per your change)
      if (!(owner || isSupreme || commanderLike)) return interaction.reply({ content: "You lack permission to modify the whitelist.", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
      if (!ch || ch.type !== 0 && ch.type !== undefined) { /* channel type check tolerant */ }
      const gcfg = await getGuildConfig(guild.id);
      if (gcfg.whitelist.includes(ch.id)) return interaction.reply({ content: "Channel already whitelisted.", ephemeral: true });
      gcfg.whitelist.push(ch.id);
      await gcfg.save();
      return interaction.reply({ content: `Channel <#${ch.id}> added to Adolf whitelist.` });
    }
    if (interaction.commandName === "whitelist_remove") {
      if (!(owner || isSupreme || commanderLike)) return interaction.reply({ content: "You lack permission to modify the whitelist.", ephemeral: true });
      const ch = interaction.options.getChannel("channel");
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

    /* ------------------ memory commands ------------------ */
    if (interaction.commandName === "memory_add") {
      // Only Owner or Supreme Leader can add
      if (!(owner || isSupreme)) return interaction.reply({ content: "Only Owner or Supreme Leader may add memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (mem.longMemory.includes(fact)) return interaction.reply({ content: "Fact already recorded.", ephemeral: true });
      mem.longMemory.push(fact);
      await mem.save();
      return interaction.reply({ content: `Recorded fact for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forget") {
      // Only Owner or Supreme Leader can remove specific fact
      if (!(owner || isSupreme)) return interaction.reply({ content: "Only Owner or Supreme Leader may remove memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const fact = interaction.options.getString("fact");
      const mem = await ensureUserMemory(target.user.id);
      if (!mem.longMemory.includes(fact)) return interaction.reply({ content: "That fact not found.", ephemeral: true });
      mem.longMemory = mem.longMemory.filter(f => f !== fact);
      await mem.save();
      return interaction.reply({ content: `Removed specified fact for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_forgetall") {
      // Only Owner or Supreme Leader can wipe
      if (!(owner || isSupreme)) return interaction.reply({ content: "Only Owner or Supreme Leader may clear memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      mem.longMemory = [];
      await mem.save();
      return interaction.reply({ content: `Cleared all memories for <@${target.user.id}>.` });
    }
    if (interaction.commandName === "memory_show") {
      // Allowed: Owner, Supreme Leader, Commander, Admins; Commander/Admins only read (can't change)
      if (!(owner || isSupreme || commanderLike)) return interaction.reply({ content: "You lack permission to view memories.", ephemeral: true });
      const target = interaction.options.getMember("user") || interaction.member;
      const mem = await ensureUserMemory(target.user.id);
      const lines = mem.longMemory.length ? mem.longMemory.map((f,i) => `${i+1}. ${f}`).join("\n") : "No long-term facts.";
      return interaction.reply({ content: `Memory for <@${target.user.id}>:\n${lines}` });
    }

    /* ------------------ permission role configuration ------------------ */
    if (interaction.commandName === "permissions_setroles") {
      // OWNER ONLY
      if (!owner) return interaction.reply({ content: "Only server owner can set these roles.", ephemeral: true });
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
   Message handler (mentions, classify, ignore, auto-memory)
   ========================= */
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.bot) return;

    const guild = msg.guild;
    const cfg = await getGuildConfig(guild.id);
    // whitelist check (if whitelist non-empty, only those channels allowed)
    if (cfg.whitelist && cfg.whitelist.length && !cfg.whitelist.includes(msg.channel.id)) return;

    // cooldown
    if (onCooldown(msg.author.id)) return;
    setCooldown(msg.author.id);

    // persistent ignore check
    if (await isIgnored(msg.author.id)) {
      // do not ignore supremeroles
      const botMember = await guild.members.fetch(client.user.id).catch(()=>null);
      const authorMember = await guild.members.fetch(msg.author.id).catch(()=>null);
      const cfg = await getGuildConfig(guild.id);
      const isSup = authorMember && cfg.supremeRoleId && authorMember.roles.cache.has(cfg.supremeRoleId);
      if (!isSup) return; // silently ignore
      // else continue if supreme leader
    }

    // store short memory
    await addShortMemory(msg.author.id, `${msg.author.username}: ${msg.content}`);

    // auto long-term memory heuristic
    const possibleFact = extractPersonalFact(msg.content);
    if (possibleFact) {
      const mem = await ensureUserMemory(msg.author.id);
      // only add if non-trivial and not already known
      if (!mem.longMemory.some(f => f.toLowerCase() === possibleFact.toLowerCase())) {
        // we add conservatively and silently (Adolf may occasionally announce)
        mem.longMemory.push(possibleFact);
        await mem.save();
        // Rarely notify the user (low chance). We'll not notify to avoid spam.
        // If you'd like Adolf to announce, we could have a small message; for now it's silent.
      }
    }

    // classify message for insults
    const mentionIds = [...msg.mentions.users.keys()];
    const classification = await classifyMessage(msg.content, mentionIds);

    // fetch members & superior mention
    const botMember = await guild.members.fetch(client.user.id).catch(()=>null);
    const mentionSuperiorId = await getSuperiorMentionedId(guild, mentionIds);

    // determine role flags for author (for ignore override)
    const authorMember = await guild.members.fetch(msg.author.id).catch(()=>null);
    const cfgCurrent = await getGuildConfig(guild.id);
    const isAuthorSupreme = authorMember && cfgCurrent.supremeRoleId && authorMember.roles.cache.has(cfgCurrent.supremeRoleId);
    const isAuthorCommander = authorMember && cfgCurrent.commanderRoleId && authorMember.roles.cache.has(cfgCurrent.commanderRoleId);
    const isAuthorAdmin = authorMember && hasAdmin(authorMember);

    /* -------------------------
       Annoyance detection -> declare ignore (rare)
       ------------------------- */
    const mem = await ensureUserMemory(msg.author.id);
    // spam burst heuristic: last 6 shortMemory entries belong to this username
    const lastShortNames = mem.shortMemory.slice(-6).map(s => { const idx = s.indexOf(": "); return idx >= 0 ? s.slice(0, idx) : s; });
    const spamBurst = lastShortNames.length >= 5 && lastShortNames.every(n => n === msg.author.username);
    const repeated = repeatedRecentMessages(mem, 2);
    const poke = simplePokeCheck(msg.content);
    const nitpick = nitpickDetector(mem);

    if ((spamBurst || repeated || poke || nitpick) && !isAuthorSupreme) {
      // set persistent ignore for 15 minutes
      await setIgnore(msg.author.id, 15);
      const lines = [
        "Pathetic. I will ignore lowly citizens like you. I refuse to waste my time on insects.",
        "Enough. I will ignore you now. A tyrant of the Verse does not waste his breath on bottom-rank peasants.",
        "Silence. I hereby place you under ignore. My time is far too valuable for trivial creatures like you.",
        "Begone. I will ignore you — the Verse has no space for your constant whining."
      ];
      // random rude line but "ignore" lowercase (as requested)
      const announce = lines[Math.floor(Math.random()*lines.length)];
      await msg.reply(announce);
      return;
    }

    /* -------------------------
       Insult handling
       ------------------------- */
    if (classification.is_insult && classification.targets.includes("bot")) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id, superiorUserId: mentionSuperiorId });
      return msg.reply(reply);
    }

    if (classification.is_insult && classification.targets.length > 0) {
      for (const t of classification.targets) {
        if (!t.startsWith("user:")) continue;
        const uid = t.split(":")[1];
        const targetMember = await guild.members.fetch(uid).catch(()=>null);
        if (!targetMember) continue;
        if (botMember && rolePosition(targetMember) > rolePosition(botMember)) {
          // defend superior (speech only)
          const reply = await aiReplyInCharacter({ content: `You insulted Supreme Leader <@${uid}>: ${msg.content}`, authorId: uid, superiorUserId: uid });
          await msg.channel.send(reply);
          return;
        } else {
          const reply = await aiReplyInCharacter({ content: `You insulted <@${uid}>: ${msg.content}`, authorId: msg.author.id });
          return msg.channel.send(reply);
        }
      }
    }

    // direct mention or name appear -> AI reply
    const mentioned = msg.mentions.has(client.user.id) || msg.content.toLowerCase().includes("adolf");
    if (mentioned) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id, superiorUserId: mentionSuperiorId });
      return msg.reply(reply);
    }

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

/* =========================
   Start up: login
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


