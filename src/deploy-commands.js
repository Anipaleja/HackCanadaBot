import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";

const command = new SlashCommandBuilder()
  .setName(config.taskCommandName)
  .setDescription("Create a task in Notion and ping the Discord assignee.")
  .addUserOption((option) =>
    option
      .setName("discord_user")
      .setDescription("Discord user to ping when the task is created")
      .setRequired(true)
  )
  .setDMPermission(false);

const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

async function deployCommands() {
  const body = [command.toJSON()];

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body
    });
    console.log(`Registered /${config.taskCommandName} for guild ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body
  });
  console.log(`Registered global /${config.taskCommandName}`);
}

deployCommands().catch((error) => {
  console.error("Failed to deploy slash commands", error);
  process.exitCode = 1;
});
