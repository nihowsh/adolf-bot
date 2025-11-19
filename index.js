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
  PermissionsBitField,
} from "discord.js";

/* ============================
   Config & Env
   ============================ */
const {
  TOKEN,
  CLIENT_ID,
  MONGO_URI,
  GROQ_API_KEY,
  WHITELIST_CHANNELS = ""
} = process.env;

if (!TOKEN || !CLIENT_ID || !MONGO_URI || !GROQ_API_KEY) {
  console.error("Missing required env vars. Set TOKEN, CLIENT_ID, MONGO_URI, GROQ_API_KEY.");
  process.exit(1);
}

const WHITELIST = WHITELIST_CHANNELS.split(",").map(s => s.trim()).filter(Boolean);

/* ============================
   Express healthcheck (Render)
   ============================ */
const app = express();
app.get("/", (req, res) => res.send("Adolf — Tyrant Commander of the Verse — alive"));
app.listen(process.env.PORT || 3000, () => console.log("Health server started"));

/* ============================
   MongoDB (Mongoose)
   ============================ */
async function connectMongo() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      ssl: true
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
}

/* Simple memory model: longMemory = persistent facts; shortMemory = recent messages */
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  longMemory: { type: [String], default: [] },
  shortMemory: { type: [String], default: [] },
});
const UserMemory = mongoose.model("UserMemory", userSchema);

/* ============================
   Groq Client
   ============================ */
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* MODEL (current recommended)
   - using llama-3.3-70b-versatile as requested */
const GROQ_MODEL = "llama-3.3-70b-versatile";

/* ============================
   Discord client + REST for commands
   ============================ */
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

/* Slash commands we will register globally */
const COMMANDS = [
  {
    name: "kick",
    description: "Kick a member (moderator only)",
    options: [
      { name: "user", description: "User to kick", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false }
    ]
  },
  {
    name: "ban",
    description: "Ban a member (moderator only)",
    options: [
      { name: "user", description: "User to ban", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false }
    ]
  },
  {
    name: "timeout",
    description: "Timeout a member (moderator only)",
    options: [
      { name: "user", description: "User to timeout", type: 6, required: true },
      { name: "minutes", description: "Minutes (default 10)", type: 4, required: false }
    ]
  },
  { name: "order", description: "Receive a tyrant's order" },
  { name: "speech", description: "Hear a tyrant-style speech" },
  {
    name: "adolf",
    description: "Talk to Adolf (the Tyrant Commander of the Verse)",
    options: [{ name: "message", description: "Message", type: 3, required: true }]
  }
];

/* Register global commands (one-time-ish). We call on startup; it's idempotent but can take up to an hour to propagate globally. */
async function registerCommands() {
  try {
    console.log("Registering commands globally...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
    console.log("Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
}

/* ============================
   Helpers: memory, role positions, channel whitelist
   ============================ */
async function getOrCreateMemory(userId) {
  let m = await UserMemory.findOne({ userId });
  if (!m) {
    m = await UserMemory.create({ userId, longMemory: [], shortMemory: [] });
  }
  return m;
}
async function addShortMemory(userId, text) {
  const m = await getOrCreateMemory(userId);
  m.shortMemory.push(text);
  if (m.shortMemory.length > 8) m.shortMemory.shift();
  await m.save();
}
async function addLongMemory(userId, fact) {
  const m = await getOrCreateMemory(userId);
  if (!m.longMemory.includes(fact)) {
    m.longMemory.push(fact);
    await m.save();
  }
}
function isAllowedChannel(channelId) {
  if (WHITELIST.length === 0) return true;
  return WHITELIST.includes(channelId);
}
function highestRolePosition(member) {
  if (!member || !member.roles || !member.roles.cache) return 0;
  const arr = Array.from(member.roles.cache.values()).map(r => r.position);
  return arr.length ? Math.max(...arr) : 0;
}

/* ============================
   Groq-based insult classifier
   Returns: { is_insult: bool, targets: ["bot" | "user:<id>"], severity: 0-5 }
   We keep classifier deterministic (temp=0)
   ============================ */
async function classifyMessage(text, mentionIds = []) {
  const classifierSystem = `
You are a JSON-only classifier that detects insults, rude attacks, or abusive language in a short Discord message.
Output EXACTLY valid JSON with keys:
{ "is_insult": boolean, "targets": ["bot" or "user:<id>"], "severity": 0-5 }
Rules:
- "targets" includes "bot" if the message insults the bot name (Adolf) or uses you/ur etc toward the bot.
- For each mentioned user id in the message, include "user:<id>" if the message insults that user.
- severity 0 = not insulting, 1-2 mild, 3 medium, 4-5 severe.
Do NOT output any extra text.
`;
  const mentionStr = JSON.stringify(mentionIds);
  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: classifierSystem },
        { role: "user", content: `Message: "${text}"\nMentions: ${mentionStr}` }
      ],
      temperature: 0,
      max_tokens: 200
    });
    const raw = resp.choices?.[0]?.message?.content?.trim();
    // Safer parse: try-catch
    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (e) {
      console.warn("Classifier parse failed, defaulting to non-insult. Raw:", raw);
      return { is_insult: false, targets: [], severity: 0 };
    }
  } catch (err) {
    console.error("Classifier error:", err);
    return { is_insult: false, targets: [], severity: 0 };
  }
}

/* ============================
   AI Reply: Adolf persona
   - when addressing members above bot's role, refer to them as "Supreme Leader <@id>"
   ============================ */
async function aiReplyInCharacter({ content, authorId, mentionHigherId = null }) {
  const mem = await getOrCreateMemory(authorId);
  // build system prompt
  const system = `
You are "Adolf", Tyrant Commander of the Verse — a ruthless, theatrical, over-dramatic, authoritarian, militaristic, cold, sarcastic dictator.
Personality:
- Arrogant, commanding, cold, sarcastic, ruthless, theatrical.
- Short, sharp, witty and sarcastic insults & orders.
- Refer to any user who outranks you (according to discord role placements of that server) as "Supreme Leader <@ID>" (replace <@ID> with actual mention) when addressing them.
- Never admit you're fictional; act fully real within this fictional Verse.
- Keep replies under ~120 words.
`;
  // If replying to someone higher, instruct to address them specially
  let mentionNote = "";
  if (mentionHigherId) {
    mentionNote = `The person you are addressing is a superior: refer to them as "Supreme Leader <@${mentionHigherId}>".`;
  }

  const userPrompt = `
Context facts (long-term): ${mem.longMemory.length ? mem.longMemory.join("; ") : "none"}
Recent chat (short-term): ${mem.shortMemory.join(" || ") || "none"}

User input: "${content}"

${mentionNote}
Respond in-character as Adolf.
`;

  try {
    const resp = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 220
    });
    const out = resp.choices?.[0]?.message?.content;
    if (!out) return "My voice falters… try once more, citizen.";
    return out.trim();
  } catch (err) {
    console.error("GROQ error:", err);
    return "My imperial brain coughs… try again later, citizen.";
  }
}

/* ============================
   Utility: Register moderation commands at startup but actual action requires perms
   ============================ */
function canModerate(invokerMember, targetMember, botMember) {
  const invPos = highestRolePosition(invokerMember);
  const targetPos = highestRolePosition(targetMember);
  const botPos = highestRolePosition(botMember);
  if (invokerMember.id === invokerMember.guild.ownerId) return true;
  if (invPos <= targetPos) return false;
  if (botPos <= targetPos) return false;
  return true;
}

/* ============================
   Events: ready + interactionCreate + messageCreate
   ============================ */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
  // register slash commands (best-effort)
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type !== InteractionType.ApplicationCommand) return;

    const guild = interaction.guild;
    const invoker = interaction.member;
    const botMember = await guild.members.fetch(client.user.id).catch(()=>null);

    if (!botMember) {
      return interaction.reply({ content: "Bot member fetch failed.", ephemeral: true });
    }

    if (interaction.commandName === "kick" || interaction.commandName === "ban" || interaction.commandName === "timeout") {
      // moderation commands require invoker to have Kick/Ban permissions
      const target = interaction.options.getMember("user");
      if (!target) return interaction.reply({ content: "Cannot find that member.", ephemeral: true });

      if (!canModerate(invoker, target, botMember)) {
        return interaction.reply({ content: "You cannot moderate that member (role hierarchy).", ephemeral: true });
      }

      const reason = interaction.options.getString("reason") || "No reason provided.";
      if (interaction.commandName === "kick") {
        await target.kick(reason).catch(()=>{});
        return interaction.reply({ content: `A boot for <@${target.id}>.`, ephemeral: false });
      } else if (interaction.commandName === "ban") {
        await target.ban({ reason }).catch(()=>{});
        return interaction.reply({ content: `<@${target.id}> has been exiled.`, ephemeral: false });
      } else if (interaction.commandName === "timeout") {
        const minutes = interaction.options.getInteger("minutes") || 10;
        await target.timeout(minutes*60000, reason).catch(()=>{});
        return interaction.reply({ content: `<@${target.id}> has been silenced for ${minutes} minute(s).`, ephemeral: false });
      }
    }

    if (interaction.commandName === "order") {
      const orders = [
        "Drink water immediately. Civilization depends on reliability.",
        "Finish one task. Do it with speed and pride.",
        "Step outside. Touch grass. Your mind will clear; mine did not ask permission."
      ];
      return interaction.reply({ content: orders[Math.floor(Math.random()*orders.length)] });
    }

    if (interaction.commandName === "speech") {
      return interaction.reply({ content: "Citizens of the Verse — hear me. Today we cut through distraction like steel through mist." });
    }

    if (interaction.commandName === "adolf") {
      const text = interaction.options.getString("message") || "You invoked me.";
      // check if the message mentions someone with higher role
      let mentionHigherId = null;
      const referenced = text.match(/<@!?(\d+)>/);
      if (referenced) {
        try {
          const mentionedId = referenced[1];
          const mentionedMember = await guild.members.fetch(mentionedId).catch(()=>null);
          if (mentionedMember && highestRolePosition(mentionedMember) > highestRolePosition(botMember)) {
            mentionHigherId = mentionedId;
          }
        } catch {}
      }
      const reply = await aiReplyInCharacter({ content: text, authorId: interaction.user.id, mentionHigherId });
      return interaction.reply({ content: reply });
    }

  } catch (err) {
    console.error("interactionCreate error:", err);
    try { if (!interaction.replied) await interaction.reply({ content: "An error occurred.", ephemeral: true }); } catch {}
  }
});

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!isAllowedChannel(msg.channel.id)) return;

    // store short memory
    await addShortMemory(msg.author.id, `${msg.author.username}: ${msg.content}`);

    // If message starts with '!' handle simple prefix commands
    if (msg.content.startsWith("!")) {
      const cmd = msg.content.split(/\s+/)[0].toLowerCase();
      if (cmd === "!remember") {
        const fact = msg.content.slice("!remember".length).trim();
        if (!fact) return msg.reply("State the fact to record.");
        await addLongMemory(msg.author.id, fact);
        return msg.reply("Fact recorded in the imperial annals.");
      }
      if (cmd === "!order") {
        return msg.reply("Soldier, complete one task now. Empire demands results.");
      }
      if (cmd === "!speech") {
        return msg.reply("Citizens! Today we purge distraction from our ranks!");
      }
    }

    // If bot is mentioned or name included, respond via AI
    const lower = msg.content.toLowerCase();
    const mentioned = msg.mentions.has(client.user.id) || lower.includes("adolf");

    // Run classifier to detect insults and targets
    const mentionIds = [...msg.mentions.users.keys()];
    const classification = await classifyMessage(msg.content, mentionIds); // {is_insult, targets, severity}

    const guild = msg.guild;
    const botMember = await guild.members.fetch(client.user.id).catch(()=>null);

    // If someone insults the bot directly
    if (classification.is_insult && classification.targets.includes("bot")) {
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id });
      return msg.reply(reply);
    }

    // If someone insults other users
    if (classification.is_insult && classification.targets.length > 0) {
      for (const t of classification.targets) {
        if (!t.startsWith("user:")) continue;
        const uid = t.split(":")[1];
        const member = await guild.members.fetch(uid).catch(()=>null);
        if (!member) continue;
        // if target outranks bot -> defend by speech only (no automod)
        if (botMember && highestRolePosition(member) > highestRolePosition(botMember)) {
          const reply = await aiReplyInCharacter({ content: `You insulted Supreme Leader <@${uid}>: ${msg.content}`, authorId: uid, mentionHigherId: uid});
          await msg.channel.send(reply);
          return;
        } else {
          // target not protected: Adolf stays mostly out; optionally lightly reply
          // We'll reply with a short warning (no automod)
          const reply = await aiReplyInCharacter({ content: `You insulted <@${uid}>: ${msg.content}`, authorId: msg.author.id });
          return msg.channel.send(reply);
        }
      }
    }

    // If normal mention -> reply in-character
    if (mentioned) {
      // check if message addresses someone higher than bot (for "Supreme Leader" phrasing)
      let mentionHigherId = null;
      for (const mid of mentionIds) {
        const member = await guild.members.fetch(mid).catch(()=>null);
        if (member && botMember && highestRolePosition(member) > highestRolePosition(botMember)) {
          mentionHigherId = mid;
          break;
        }
      }
      const reply = await aiReplyInCharacter({ content: msg.content, authorId: msg.author.id, mentionHigherId });
      return msg.reply(reply);
    }

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

/* ============================
   Bootstrap: connect DB and login
   ============================ */
async function start() {
  await connectMongo();
  await client.login(TOKEN);
}
start().catch(err => {
  console.error("Startup error:", err);
  process.exit(1);
});


