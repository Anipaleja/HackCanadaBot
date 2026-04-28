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

const meCommand = new SlashCommandBuilder()
  .setName(config.meCommandName)
  .setDescription("View tasks assigned to me.")
  .setDMPermission(false);

const doneCommand = new SlashCommandBuilder()
  .setName(config.doneCommandName)
  .setDescription("Mark a task as done by number.")
  .addIntegerOption((option) =>
    option
      .setName("number")
      .setDescription("Task number from /me listing")
      .setRequired(true)
  )
  .setDMPermission(false);

const departmentCommand = new SlashCommandBuilder()
  .setName(config.departmentCommandName)
  .setDescription("View tasks where I'm the lead (incomplete/not canceled).")
  .setDMPermission(false);

const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

async function deployCommands() {
  const body = [command.toJSON(), registerCommand.toJSON(), meCommand.toJSON(), doneCommand.toJSON(), departmentCommand.toJSON()];

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body
    });
    console.log(`Registered 5 commands for guild ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body
  });
  console.log(`Registered 5 commands globally`);
}

deployCommands().catch((error) => {
  console.error("Failed to deploy slash commands", error);
  process.exitCode = 1;
});
