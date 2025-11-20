// deploy-commands.js
import "dotenv/config";
import { REST, Routes } from "discord.js";

const { TOKEN, CLIENT_ID } = process.env;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID in environment.");
  process.exit(1);
}

/* ============================================
   GLOBAL Slash Commands for the whole bot
   ============================================ */
const COMMANDS = [
  // moderation
  {
    name: "kick",
    description: "Kick a member",
    options: [
      { name: "user", type: 6, description: "Member to kick", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      { name: "user", type: 6, description: "Member to ban", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      { name: "user", type: 6, description: "Member to timeout", required: true },
      { name: "minutes", type: 4, description: "Minutes (default 10)", required: false }
    ]
  },

  // fun
  { name: "order", description: "Receive a tyrant-style order" },
  { name: "speech", description: "Hear a short tyrant-style speech" },

  // whitelist
  {
    name: "whitelist_add",
    description: "Add a channel to whitelist",
    options: [
      { name: "channel", type: 7, description: "Channel", required: true }
    ]
  },
  {
    name: "whitelist_remove",
    description: "Remove a channel from whitelist",
    options: [
      { name: "channel", type: 7, description: "Channel", required: true }
    ]
  },
  { name: "whitelist_list", description: "List all whitelisted channels" },

  // memory
  {
    name: "memory_add",
    description: "Add long-term memory",
    options: [
      { name: "user", type: 6, description: "User", required: false },
      { name: "fact", type: 3, description: "Fact to save", required: true }
    ]
  },
  {
    name: "memory_forget",
    description: "Remove a specific memory",
    options: [
      { name: "user", type: 6, description: "User", required: false },
      { name: "fact", type: 3, description: "Exact fact", required: true }
    ]
  },
  {
    name: "memory_forgetall",
    description: "Delete ALL memories for a user",
    options: [
      { name: "user", type: 6, description: "User", required: false }
    ]
  },
  {
    name: "memory_show",
    description: "Show long-term memories for a user",
    options: [
      { name: "user", type: 6, description: "User", required: false }
    ]
  },

  // permissions
  {
    name: "permissions_setroles",
    description: "Set Commander / Supreme Leader roles",
    options: [
      { name: "commander", type: 8, description: "Commander role", required: false },
      { name: "supreme", type: 8, description: "Supreme role", required: false }
    ]
  },
  { name: "permissions_show", description: "Show configured roles" }
];

/* ============================================
   Deploy global commands
   ============================================ */
const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("🌍 Deploying GLOBAL slash commands...");

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: COMMANDS }
    );

    console.log("✅ Global slash commands deployed successfully!");
    console.log("⏳ Global commands may take 30–60 minutes to appear everywhere.");
  } catch (err) {
    console.error("❌ Deployment error:");
    console.error(err);
  }
})();


