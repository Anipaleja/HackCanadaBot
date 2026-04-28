import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";

const command = new SlashCommandBuilder()
  .setName(config.taskCommandName)
  .setDescription("Create a task in Notion and ping the Discord assignee.")
  .setDMPermission(false);

const registerCommand = new SlashCommandBuilder()
  .setName(config.registerCommandName)
  .setDescription("Register your Discord account with your Notion email.")
  .addStringOption((option) =>
    option
      .setName("notion_email")
      .setDescription("Your Notion email address")
      .setRequired(true)
  )
  .setDMPermission(false);

const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

async function deployCommands() {
  const body = [command.toJSON(), registerCommand.toJSON()];

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body
    });
    console.log(`Registered /${config.taskCommandName} and /${config.registerCommandName} for guild ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body
  });
  console.log(`Registered global /${config.taskCommandName} and /${config.registerCommandName}`);
}

deployCommands().catch((error) => {
  console.error("Failed to deploy slash commands", error);
  process.exitCode = 1;
});
