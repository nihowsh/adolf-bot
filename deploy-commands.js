import "dotenv/config";
import fetch from "node-fetch";

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.TOKEN;

if (!CLIENT_ID || !GUILD_ID || !TOKEN) {
  console.error("CLIENT_ID, GUILD_ID and TOKEN must be set in .env");
  process.exit(1);
}

const commands = [
  {
    name: "kick",
    description: "Kick a member from the guild",
    options: [{ name: "user", description: "User to kick", type: 6, required: true }]
  },
  {
    name: "ban",
    description: "Ban a member from the guild",
    options: [{ name: "user", description: "User to ban", type: 6, required: true }]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      { name: "user", type: 6, description: "User to timeout", required: true },
      { name: "minutes", type: 4, description: "Minutes", required: false }
    ]
  },
  { name: "order", description: "Adolf gives you an order" },
  { name: "speech", description: "Adolf gives a speech" },
  {
    name: "adolf",
    description: "Talk to Adolf",
    options: [{ name: "message", type: 3, description: "What to say to him", required: false }]
  }
];

(async () => {
  const url = `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  if (r.ok) console.log("Slash commands registered.");
  else console.log("Error:", await r.text());
})();
