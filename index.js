import "dotenv/config";
import express from "express";
import Groq from "groq-sdk";
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  InteractionType
} from "discord.js";

// ---------- CONFIG ----------
const MODEL_SMART = "llama-3.1-70b-versatile"; // smarter personality model
const CLASSIFY_MODEL = "llama-3.1-70b-versatile"; // same model used for classification (fine for accuracy)

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY not set in env");
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ---------- EXPRESS (healthcheck for Render) ----------
const app = express();
app.get("/", (req, res) => res.send("Adolf bot (fictional) — alive"));
app.listen(process.env.PORT || 3000, () => console.log("Health server OK"));

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ---------- SETTINGS ----------
const WHITELIST = (process.env.WHITELIST_CHANNELS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const COOLDOWN_MS = 4000; // per-user cooldown to avoid spam / double replies
const userLastReply = new Map(); // userId -> timestamp

function isAllowedChannel(id) {
  if (WHITELIST.length === 0) return true;
  return WHITELIST.includes(String(id));
}

// ---------- UTILS ----------
function randomLine(type, user) {
  const L = {
    sarcastic: [
      `Oh wow, such eloquence from ${user}. Truly Shakespeare would be jealous.`,
      `Your insult has been noted and filed under "cute attempts", ${user}.`,
      `I tremble… not. Outstanding effort though, ${user}.`,
      `Fierce words! I’ll alert the empire’s PR team to this masterpiece by ${user}.`
    ],
    mention: [
      `Citizen ${user}, you called upon your Supreme Commander. Speak swiftly.`,
      `${user}, state your business before I lose interest.`,
      `Adolf acknowledges ${user}. Proceed.`
    ],
    defend: [
      `How dare you insult ${user}! Respect must be maintained in my realm.`,
      `${user} is under my protection — show decency or face my theatrical displeasure.`,
      `You will not speak ill of ${user} in my presence. That is a decree.`
    ],
    refuse_insult_protected: [
      `I cannot insult ${user} — they outrank my authority. I remain dignified.`,
      `That member is beyond my insult jurisdiction. I will not stoop to it.`
    ],
    kick: [
      `${user} has been KICKED. May they contemplate their choices.`,
      `A firm boot ensures ${user} is elsewhere now.`
    ],
    ban: [
      `${user} has been BANNED from my fictional empire.`,
      `${user} has been exiled — and not in the fun way.`
    ],
    timeout: [
      `${user} has been silenced temporarily to reflect on their poor taste.`,
      `${user} will meditate in quiet for a short while.`
    ]
  };
  const arr = L[type] || ["..."];
  return arr[Math.floor(Math.random() * arr.length)];
}

function highestRolePosition(member) {
  if (!member || !member.roles || !member.roles.cache) return 0;
  const positions = member.roles.cache.map(r => r.position);
  return positions.length ? Math.max(...positions) : 0;
}

function inCooldown(userId) {
  const last = userLastReply.get(userId) || 0;
  return Date.now() - last < COOLDOWN_MS;
}
function setCooldown(userId) {
  userLastReply.set(userId, Date.now());
}

// ---------- GROQ: CLASSIFIER ----------
// We ask Groq to return strict JSON with fields:
// { "is_insult": true/false, "targets": ["bot"|"user:<ID>"], "insults_bot": true/false, "severity": 0-5 }
// IMPORTANT: instruct model to ONLY output valid JSON.
async function classifyMessage(messageText, mentionIds = []) {
  const sys = `
You are an unbiased message classifier. Output STRICT JSON only (no prose).
Schema:
{
  "is_insult": boolean,             // whether the message contains insults or abusive language directed at any person
  "targets": [ string ],            // list of targets: "bot" or "user:<USERID>" or "group"
  "insults_bot": boolean,           // true if insults are directed at the bot specifically
  "severity": number                // severity 0-5 (0 = mild / joking, 5 = severe / hateful)
}
Use the mention IDs provided when identifying "user:<USERID>" targets. If message targets multiple users, include them all.
Do NOT reference real-world historical people. Do not produce any extra text. Output only JSON.
`;
  // create context where we pass mention IDs to the assistant as well
  const userContent = `MESSAGE: '''${messageText.replace(/\n/g, " ")}'''
MENTIONS: ${JSON.stringify(mentionIds)}`;

  try {
    const resp = await groq.chat.completions.create({
      model: CLASSIFY_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userContent }
      ],
      max_tokens: 200,
      temperature: 0.0 // deterministic classification
    });

    const raw = resp.choices?.[0]?.message?.content?.trim();
    if (!raw) return { is_insult: false, targets: [], insults_bot: false, severity: 0 };

    // Try parse JSON safely
    try {
      const json = JSON.parse(raw);
      return {
        is_insult: !!json.is_insult,
        targets: Array.isArray(json.targets) ? json.targets : [],
        insults_bot: !!json.insults_bot,
        severity: typeof json.severity === "number" ? json.severity : 0
      };
    } catch (err) {
      console.warn("Classifier returned non-JSON, fallback to keyword (rare):", raw);
      // fallback: simple keyword scan
      const low = messageText.toLowerCase();
      const key = ["idiot","stupid","dumb","useless","trash","suck","loser"].some(k => low.includes(k));
      return { is_insult: key, targets: [], insults_bot: low.includes("adolf"), insults_bot: key && low.includes("adolf"), severity: key ? 2 : 0 };
    }
  } catch (e) {
    console.error("Classification API error:", e);
    // On API error, be conservative: don't assume insult
    return { is_insult: false, targets: [], insults_bot: false, severity: 0 };
  }
}

// ---------- GROQ: CHARACTER REPLY ----------
async function aiReplyInCharacter(promptText) {
  const systemPrompt = `
You are "Adolf", a fictional overdramatic sarcastic dictator personality for a Discord bot.
You are STRICTLY fictional: do NOT reference real historical people, events, or ideologies.
PERSONALITY:
- Sarcastic, pompous, dramatic, humorous threats
- Use short, punchy lines (under 120 words)
- Call users "citizen", "soldier", "minion" occasionally
- Never mention Hitler, WWII, or real extremist content
- Stay in-character, comedic villain energy only
`;
  try {
    const resp = await groq.chat.completions.create({
      model: MODEL_SMART,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptText }
      ],
      max_tokens: 220,
      temperature: 0.85
    });

    return resp.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("AI reply error:", err);
    return null;
  }
}

// ---------- READY ----------
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Trimming my mustache ✂️");
});

// ---------- SLASH COMMANDS (manual moderation + fun) ----------
client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;
  const guild = interaction.guild;
  const invoker = interaction.member;

  const botMember = await guild.members.fetch(client.user.id).catch(() => null);
  const botPos = highestRolePosition(botMember);

  if (["kick","ban","timeout"].includes(commandName)) {
    const target = interaction.options.getMember("user");
    if (!target) return interaction.reply({ content: "Cannot find that member.", ephemeral: true });

    const targetPos = highestRolePosition(target);
    const invokerPos = highestRolePosition(invoker);

    if (invokerPos <= targetPos && interaction.user.id !== guild.ownerId) {
      return interaction.reply({ content: "You cannot moderate a member with equal/higher role.", ephemeral: true });
    }
    if (botPos <= targetPos) {
      return interaction.reply({ content: "I cannot act on that member — their role is higher than mine.", ephemeral: true });
    }

    const reason = interaction.options.getString("reason") || "No reason provided.";
    const minutes = interaction.options.getInteger("minutes") || 10;

    try {
      if (commandName === "kick") {
        await target.kick(reason).catch(() => {});
        return interaction.reply({ content: randomLine("kick", `<@${target.id}>`) });
      } else if (commandName === "ban") {
        await target.ban({ reason }).catch(() => {});
        return interaction.reply({ content: randomLine("ban", `<@${target.id}>`) });
      } else if (commandName === "timeout") {
        const ms = minutes * 60 * 1000;
        await target.timeout(ms, reason).catch(() => {});
        return interaction.reply({ content: randomLine("timeout", `<@${target.id}>`) });
      }
    } catch (e) {
      console.error("Moderation error:", e);
      return interaction.reply({ content: "Action failed. Check my permissions and role position.", ephemeral: true });
    }
  }

  // fun slash commands
  if (commandName === "order") {
    return interaction.reply({ content: randomLine("mention", `<@${interaction.user.id}>`) });
  }
  if (commandName === "speech") {
    return interaction.reply({ content: "Citizens! Gather! Today we conquer the greatest enemy: procrastination!" });
  }
  if (commandName === "adolf") {
    const text = interaction.options.getString("message") || "You summoned me.";
    const replyText = await aiReplyInCharacter(text);
    return interaction.reply({ content: replyText || "My imperial brain is quiet for now." });
  }
});

// ---------- MESSAGE HANDLER ----------
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!isAllowedChannel(msg.channel.id)) return;
    if (!msg.guild) return;

    // cooldown per-user to prevent spamming and excessive API calls
    if (inCooldown(msg.author.id)) return;
    setCooldown(msg.author.id);

    const guild = msg.guild;
    const botMember = await guild.members.fetch(client.user.id).catch(() => null);
    const botPos = highestRolePosition(botMember);

    const content = msg.content;
    const contentLower = content.toLowerCase();

    // gather mention IDs so classifier can detect targeted users precisely
    const mentionIds = [];
    for (const [id, m] of msg.mentions.members) mentionIds.push(id);

    // Use Groq classifier
    const classification = await classifyMessage(content, mentionIds);
    // classification => { is_insult, targets, insults_bot, severity }

    // If message insults the bot specifically
    if (classification.is_insult && classification.insults_bot) {
      // Reply sarcastically (AI or canned)
      // Use AI for better lines
      const aiLine = await aiReplyInCharacter(`User <@${msg.author.id}> wrote: "${content}"\nRespond in-character sarcastically to the user, short reply.`);
      return msg.reply(aiLine || randomLine("sarcastic", `<@${msg.author.id}>`));
    }

    // If message insults other users / mentions targets
    if (classification.is_insult && classification.targets.length > 0) {
      // For each target reported by classifier
      for (const t of classification.targets) {
        if (t === "bot") continue; // bot-handled above
        // expecting format "user:<ID>"
        if (t.startsWith("user:")) {
          const uid = t.split(":")[1];
          const mentionedMember = await guild.members.fetch(uid).catch(() => null);
          if (!mentionedMember) continue;

          const targetPos = highestRolePosition(mentionedMember);

          // If target outranks bot => defend (speak only)
          if (targetPos > botPos) {
            const defendLine = await aiReplyInCharacter(`Defend <@${uid}> from the insult: "${content}". Respond as Adolf, protect them, be dramatic but do not punish.`);
            // use AI defend line or fallback canned
            await msg.channel.send(defendLine || randomLine("defend", `<@${uid}>`));
          } else {
            // target not protected: Adolf stays out to avoid spam (policy you set)
            // Optionally, we could still reply lightly; current behavior: ignore.
          }
        } else if (t === "group") {
          // Generic group-directed insults — if bot mentioned or there are many mentions, respond once
          const defendLine = await aiReplyInCharacter(`A group was insulted in this message: "${content}". Respond as Adolf, be dramatic but do not punish.`);
          await msg.channel.send(defendLine || randomLine("defend", "<everyone>"));
        }
      }
      return; // handled insults case
    }

    // If bot is mentioned politely (non-insult) -> in-character AI reply
    const mentionsBot = msg.mentions.has(client.user.id) || contentLower.includes("adolf");
    if (mentionsBot && !classification.is_insult) {
      const prompt = `User <@${msg.author.id}> says: "${content}". Reply in-character as Adolf, sarcastic and dramatic, short.`;
      const replyText = await aiReplyInCharacter(prompt);
      return msg.reply(replyText || randomLine("mention", `<@${msg.author.id}>`));
    }

    // Prefix fun commands (non-moderation)
    if (!content.startsWith("!")) return;
    const parts = content.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "!order") {
      const orders = [
        "Drink water immediately! Hydration strengthens the empire!",
        "Stop scrolling and finish your tasks! NOW!",
        "Touch grass, soldier. That’s an order."
      ];
      return msg.channel.send(orders[Math.floor(Math.random() * orders.length)]);
    }

    if (cmd === "!speech") {
      return msg.channel.send("Citizens! Gather! Today we march against the greatest enemy of productivity… LAZINESS!");
    }

    if (cmd === "!insult") {
      const user = msg.mentions.users.first();
      if (!user) return msg.reply("Whom shall I insult, citizen?");
      const member = msg.mentions.members.first();
      const memberPos = highestRolePosition(member);
      if (memberPos > botPos) {
        return msg.reply(randomLine("refuse_insult_protected", `<@${member.id}>`));
      }
      const insults = [
        `${user}, you resemble a malfunctioning USB cable.`,
        `${user}, your IQ is buffering… please wait.`,
        `${user}, even my dictatorship can't fix your face.`
      ];
      return msg.channel.send(insults[Math.floor(Math.random() * insults.length)]);
    }

  } catch (err) {
    console.error("Message handler error:", err);
  }
});

// ---------- LOGIN ----------
client.login(process.env.TOKEN);

