// deploy-commands.js
import "dotenv/config";
import { REST, Routes } from "discord.js";

/*
  Make sure these ENV variables exist:
  - TOKEN
  - CLIENT_ID
*/

const { TOKEN, CLIENT_ID } = process.env;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID in environment.");
  process.exit(1);
}

/* ============================
   Slash Commands (GLOBAL)
   ============================ */
const COMMANDS = [
  // moderation
  {
    name: "kick",
    description: "Kick a member",
    options: [
      { name: "user", type: 6, description: "Member", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      { name: "user", type: 6, description: "Member", required: true },
      { name: "reason", type: 3, description: "Reason", required: false }
    ]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      { name: "user", type: 6, description: "Member", required: true },
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
    options: [{ name: "channel", type: 7, description: "Channel", required: true }]
  },
  {
    name: "whitelist_remove",
    description: "Remove a channel from whitelist",
    options: [{ name: "channel", type: 7, description: "Channel", required: true }]
  },
  { name: "whitelist_list", description: "List whitelisted channels" },

  // memory
  {
    name: "memory_add",
    description: "Add long-term memory",
    options: [
      { name: "user", type: 6, description: "User", required: false },
      { name: "fact", type: 3, description: "Fact to store", required: true }
    ]
  },
  {
    name: "memory_forget",
    description: "Delete a long-term memory",
    options: [
      { name: "user", type: 6, description: "User", required: false },
      { name: "fact", type: 3, description: "Exact fact to remove", required: true }
    ]
  },
  {
    name: "memory_forgetall",
    description: "Clear all long-term memories",
    options: [{ name: "user", type: 6, description: "User", required: false }]
  },
  {
    name: "memory_show",
    description: "Show someone's long-term memories",
    options: [{ name: "user", type: 6, description: "User", required: false }]
  },

  // permission roles
  {
    name: "permissions_setroles",
    description: "Set Commander & Supreme Leader roles (owner only)",
    options: [
      { name: "commander", type: 8, description: "Commander role", required: false },
      { name: "supreme", type: 8, description: "Supreme role", required: false }
    ]
  },
  { name: "permissions_show", description: "Show configured roles" }
];

/* ============================
   DEPLOY
   ============================ */
const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("⚙️  Refreshing global slash commands...");

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: COMMANDS }
    );

    console.log("✅ Slash commands deployed successfully!");
  } catch (err) {
    console.error("❌ Error deploying commands:");
    console.error(err);
  }
})();

