import "dotenv/config";
import fetch from "node-fetch";

const CLIENT_ID = process.env.CLIENT_ID;
const TOKEN = process.env.TOKEN;

if (!CLIENT_ID || !TOKEN) {
  console.error("CLIENT_ID and TOKEN must be set in .env");
  process.exit(1);
}

const commands = [
  {
    name: "kick",
    description: "Kick a member from the guild",
    options: [
      { name: "user", description: "User to kick", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false }
    ]
  },
  {
    name: "ban",
    description: "Ban a member from the guild",
    options: [
      { name: "user", description: "User to ban", type: 6, required: true },
      { name: "reason", description: "Reason", type: 3, required: false }
    ]
  },
  {
    name: "timeout",
    description: "Timeout (mute) a member for minutes",
    options: [
      { name: "user", description: "User to timeout", type: 6, required: true },
      { name: "minutes", description: "Duration in minutes", type: 4, required: false }
    ]
  },
  {
    name: "adolf",
    description: "Talk to Adolf (fictional dictator)",
    options: [
      { name: "message", description: "What to say to him", type: 3, required: false }
    ]
  },
  {
    name: "order",
    description: "Adolf gives a dramatic order"
  },
  {
    name: "speech",
    description: "Adolf gives a dramatic speech"
  }
];

(async () => {
  const url = `https://discord.com/api/v10/applications/${CLIENT_ID}/commands`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  if (response.ok) console.log("GLOBAL Slash commands registered successfully!");
  else console.error("Error:", await response.text());
})();

