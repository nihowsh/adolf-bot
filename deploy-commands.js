// deploy-commands.js
import "dotenv/config";
import { REST, Routes } from "discord.js";

const { TOKEN, CLIENT_ID } = process.env;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID in environment.");
  process.exit(1);
}

/* ============================================
   GLOBAL Slash Commands for all servers
   ============================================ */
const COMMANDS = [
  {
    name: "kick",
    description: "Kick a member",
    options: [
      { name: "user", type: 6, description: "User to kick", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      { name: "user", type: 6, description: "User to ban", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      { name: "user", type: 6, description: "User to timeout", required: true },
      { name: "minutes", type: 4, description: "Minutes", required: false }
    ]
  },

  { name: "order", description: "Receive a tyrant-style order" },
  { name: "speech", description: "Hear a tyrant-style speech" },

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

  {
    name: "memory_add",
    description: "Add long-term memory",
    options: [
      { name: "user", type: 6, description: "User", required: false },
      { name: "fact", type: 3, description: "Fact", required: true }
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
    description: "Clear all memories for a user",
    options: [
      { name: "user", type: 6, description: "User", required: false }
    ]
  },
  {
    name: "memory_show",
    description: "Show long-term memories of a user",
    options: [
      { name: "user", type: 6, description: "User", required: false }
    ]
  },

  {
    name: "permissions_setroles",
    description: "Set Commander / Supreme Leader roles",
    options: [
      { name: "commander", type: 8, description: "Commander role", required: false },
      { name: "supreme", type: 8, description: "Supreme role", required: false }
    ]
  },
  {
    name: "permissions_show",
    description: "Show configured permission roles"
  }
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("🌍 Deploying GLOBAL commands...");

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: COMMANDS }
    );

    console.log("✅ Global commands deployed successfully!");
    console.log("⏳ They will appear in 1–30 minutes (Discord cache).");
  } catch (err) {
    console.error("❌ Error deploying commands:");
    console.error(err);
  }
})();



