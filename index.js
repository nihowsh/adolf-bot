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

// ---------- EXPRESS (healthcheck for Render) ----------
const app = express();
app.get("/", (req, res) => res.send("Adolf bot (fictional) — alive"));
app.listen(process.env.PORT || 3000, () => console.log("Health server OK"));

// ---------- DISCORD & GROQ SETUP ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ---------- CONFIG ----------
const WHITELIST = (process.env.WHITELIST_CHANNELS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const INSULT_KEYWORDS = ["idiot", "stupid", "dumb", "useless", "trash", "suck", "loser"];
// Note: keep keywords conservative to reduce false positives

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
    ],
    refuse_insult_protected: [
      `I cannot insult ${user} — they outrank my authority. I remain dignified.`,
      `That member is beyond my insult jurisdiction. I will not stoop to it.`
    ]
  };
  const arr = L[type] || ["..."];
  return arr[Math.floor(Math.random() * arr.length)];
}

// highest role position helper (returns 0 if none)
function highestRolePosition(member) {
  if (!member || !member.roles || !member.roles.cache) return 0;
  const positions = member.roles.cache.map(r => r.position);
  return positions.length ? Math.max(...positions) : 0;
}

// ---------- AI: in-character reply using GROQ ----------
async function aiReplyInCharacter(context, forcedText = null) {
  try {
    const promptText = (forcedText || (context.content || "")).replace(/<@!?(\d+)>/g, "").trim() || "You were mentioned.";
    const resp = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      messages: [
        {
          role: "system",
          content: `
You are "Adolf", a fictional overdramatic dictator personality for a Discord bot.
You are strictly fictional: do NOT reference real historical people, events, or ideologies.
PERSONALITY:
- Sarcastic, pompous, dramatic, humorous threats
- Keep replies short (<120 words)
- Never reference Hitler, WWII, or real extremist content
- Always stay in-character as a comedic villain
`
        },
        { role: "user", content: promptText }
      ],
      max_tokens: 200,
      temperature: 0.8
    });

    const out = resp.choices?.[0]?.message?.content?.trim();
    return out || "The empire contemplates... nothing to say.";
  } catch (err) {
    console.error("GROQ error:", err);
    return "My imperial brain coughs. Try again in a moment.";
  }
}

// ---------- READY ----------
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Ruling a fictional empire ⚔️");
});

// ---------- INTERACTION (slash commands: manual moderation + fun) ----------
client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;
  const guild = interaction.guild;
  const invoker = interaction.member;

  // get bot member and positions
  const botMember = await guild.members.fetch(client.user.id).catch(() => null);
  const botPos = highestRolePosition(botMember);

  // MODERATION SLASH COMMANDS (manual) - note: these run only when a moderator triggers them
  if (commandName === "kick" || commandName === "ban" || commandName === "timeout") {
    const target = interaction.options.getMember("user");
    if (!target) return interaction.reply({ content: "Cannot find that member.", ephemeral: true });

    const targetPos = highestRolePosition(target);
    const invokerPos = highestRolePosition(invoker);

    // permission hierarchy checks (standard)
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

  // FUN slash commands (non-moderation)
  if (commandName === "order") {
    return interaction.reply({ content: randomLine("mention", `<@${interaction.user.id}>`) });
  }
  if (commandName === "speech") {
    return interaction.reply({ content: "Citizens! Gather! Today we conquer the greatest enemy: procrastination!" });
  }
  if (commandName === "adolf") {
    const text = interaction.options.getString("message") || "You summoned me.";
    const replyText = await aiReplyInCharacter({ content: text }, text);
    return interaction.reply({ content: replyText });
  }
});

// ---------- MESSAGE HANDLER (mentions, insult detection, defend logic, prefix fun commands) ----------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!isAllowedChannel(msg.channel.id)) return;
  if (!msg.guild) return;

  const guild = msg.guild;
  const botMember = await guild.members.fetch(client.user.id).catch(() => null);
  const botPos = highestRolePosition(botMember);

  const contentLower = msg.content.toLowerCase();
  const mentionsBot = msg.mentions.has(client.user.id) || contentLower.includes("adolf");

  // 1) Direct insult toward bot (mention or name + insult keywords) -> sarcastic reply only
  if (mentionsBot && INSULT_KEYWORDS.some(k => contentLower.includes(k))) {
    return msg.reply(randomLine("sarcastic", `<@${msg.author.id}>`));
  }

  // 2) Someone insults another member (contains mention(s) + insult keyword)
  if (msg.mentions.members.size > 0 && INSULT_KEYWORDS.some(k => contentLower.includes(k))) {
    for (const [id, mentionedMember] of msg.mentions.members) {
      const targetPos = highestRolePosition(mentionedMember);
      // If target is protected (their role is higher than bot) -> defend them (talk only)
      if (targetPos > botPos) {
        await msg.channel.send(randomLine("defend", `<@${mentionedMember.id}>`));
        // NO automod: do NOT timeout/ban/kick. Only speak.
      } else {
        // Target not protected: Adolf stays out (no automod, no reply) OR optionally reply defending lightly
        // We'll choose to stay out to avoid spam.
      }
    }
    return;
  }

  // 3) Polite mention -> AI reply in-character
  if (msg.mentions.has(client.user.id) && !INSULT_KEYWORDS.some(k => contentLower.includes(k))) {
    const replyText = await aiReplyInCharacter(msg);
    return msg.reply(replyText);
  }

  // 4) Prefix fun commands (non-moderation)
  if (!msg.content.startsWith("!")) return;
  const parts = msg.content.trim().split(/\s+/);
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
    // Respect hierarchy: don't insult members with role higher than bot
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
});

// ---------- LOGIN ----------
client.login(process.env.TOKEN);
