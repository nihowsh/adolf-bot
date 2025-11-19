import "dotenv/config";
import { REST, Routes } from "discord.js";

const commands = [
  {
    name: "kick",
    description: "Kick a member",
    options: [
      {
        name: "user",
        description: "Who to kick",
        type: 6,
        required: true,
      },
      {
        name: "reason",
        description: "Reason",
        type: 3,
        required: false,
      }
    ]
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      {
        name: "user",
        type: 6,
        description: "Who to ban",
        required: true,
      },
      {
        name: "reason",
        description: "Reason",
        type: 3,
        required: false,
      }
    ]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [
      {
        name: "user",
        type: 6,
        description: "Who to timeout",
        required: true,
      },
      {
        name: "minutes",
        description: "Duration in minutes",
        type: 4,
        required: false,
      }
    ]
  },
  {
    name: "order",
    description: "Receive an imperial order"
  },
  {
    name: "speech",
    description: "Hear a dictator-style speech"
  },
  {
    name: "adolf",
    description: "Talk to Adolf",
    options: [
      {
        name: "message",
        type: 3,
        description: "Your message",
        required: true
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

async function main() {
  try {
    console.log("Deploying commands globally…");

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log("Slash commands deployed globally.");
  } catch (err) {
    console.log(err);
  }
}
main();
