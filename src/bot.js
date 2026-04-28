import crypto from "node:crypto";
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown
} from "discord.js";
import * as chrono from "chrono-node";
import { config } from "./config.js";
import { createTaskPage, getPersonEmailByDiscordId, upsertPersonMapping } from "./notion.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const pendingTaskForms = new Map();
const formTtlMs = 10 * 60_000;

const submissionRateByUser = new Map();

function cleanupExpiredForms() {
  const now = Date.now();
  for (const [token, pending] of pendingTaskForms.entries()) {
    if (pending.expiresAtMs <= now) {
      pendingTaskForms.delete(token);
    }
  }
}

function createPendingTaskForm(requesterId) {
  cleanupExpiredForms();

  const token = crypto.randomUUID();
  pendingTaskForms.set(token, {
    requesterId,
    expiresAtMs: Date.now() + formTtlMs
  });
  return token;
}

function consumePendingTaskForm(token, requesterId) {
  cleanupExpiredForms();

  const pending = pendingTaskForms.get(token);
  if (!pending) {
    return null;
  }
  pendingTaskForms.delete(token);

  if (pending.requesterId !== requesterId) {
    return null;
  }

  return pending;
}

function isRateLimited(userId) {
  const now = Date.now();
  const windowMs = config.taskRateLimitWindowMs;
  const maxRequests = config.taskRateLimitMaxRequests;

  const activeEntries = (submissionRateByUser.get(userId) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (activeEntries.length >= maxRequests) {
    submissionRateByUser.set(userId, activeEntries);
    const retryAfterMs = windowMs - (now - activeEntries[0]);
    return {
      limited: true,
      retryAfterMs
    };
  }

  activeEntries.push(now);
  submissionRateByUser.set(userId, activeEntries);
  return {
    limited: false,
    retryAfterMs: 0
  };
}

function normalizeDateInput(rawDate) {
  const input = String(rawDate ?? "").trim();
  if (!input) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }

  const parsed = chrono.parseDate(input, new Date(), { forwardDate: true });
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function formatPingMessage({ discordUserId, taskName, dueDate, lead }) {
  const safeTaskName = escapeMarkdown(String(taskName ?? "")).replace(/@/g, "@\u200b");
  const safeLead = escapeMarkdown(String(lead ?? "")).replace(/@/g, "@\u200b");
  const replacementMap = {
    discordUser: `<@${discordUserId}>`,
    taskName: safeTaskName,
    dueDate,
    lead: safeLead
  };

  let rendered = config.pingMessageTemplate;
  for (const [key, value] of Object.entries(replacementMap)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }

  return rendered;
}

function normalizeEmailInput(rawEmail) {
  const email = String(rawEmail ?? "").trim();
  if (!email) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}

function normalizeDiscordUserInput(rawValue) {
  const input = String(rawValue ?? "").trim();
  if (!input) {
    return null;
  }

  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  if (/^\d{17,20}$/.test(input)) {
    return input;
  }

  return input.replace(/^@/, "");
}

async function resolveDiscordMember(interaction, rawValue) {
  const input = normalizeDiscordUserInput(rawValue);
  if (!input || !interaction.guild) {
    return null;
  }

  const exactIdMatch = input.match(/^\d{17,20}$/);
  if (exactIdMatch) {
    const fetchedMember = await interaction.guild.members.fetch(input).catch(() => null);
    if (fetchedMember) {
      return fetchedMember;
    }
  }

  const cachedMembers = interaction.guild.members.cache;
  const normalizedInput = input.toLowerCase();
  const matches = cachedMembers.filter((member) => {
    const candidates = [member.displayName, member.user.username, member.user.globalName ?? ""]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return candidates.includes(normalizedInput);
  });

  if (matches.size === 1) {
    return matches.first();
  }

  if (matches.size > 1) {
    throw new Error(`Multiple Discord members match "${rawValue}". Use a mention or user ID.`);
  }

  await interaction.guild.members.fetch().catch(() => null);
  const refreshedMatches = interaction.guild.members.cache.filter((member) => {
    const candidates = [member.displayName, member.user.username, member.user.globalName ?? ""]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return candidates.includes(normalizedInput);
  });

  if (refreshedMatches.size === 1) {
    return refreshedMatches.first();
  }

  if (refreshedMatches.size > 1) {
    throw new Error(`Multiple Discord members match "${rawValue}". Use a mention or user ID.`);
  }

  return null;
}

async function handleRegisterSlashCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used inside a Discord server.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const notionEmail = normalizeEmailInput(interaction.options.getString("notion_email", true));
  if (!notionEmail) {
    await interaction.reply({
      content: "Please provide a valid email address.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const mappingResult = await upsertPersonMapping({
    discordUserId: interaction.user.id,
    discordUserName: interaction.member?.displayName ?? interaction.user.username,
    notionEmail
  });

  await interaction.reply({
    content: [
      `Registered organizer: ${interaction.member?.displayName ?? interaction.user.username}`,
      `Discord ID: ${interaction.user.id}`,
      `Notion email: ${notionEmail}`,
      `Saved to people database: ${mappingResult.pageUrl}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

async function handleTaskSlashCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used inside a Discord server.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const pendingToken = createPendingTaskForm(interaction.user.id);

  const modal = new ModalBuilder().setCustomId(`task-modal:${pendingToken}`).setTitle("Add Task");
  const discordTagInput = new TextInputBuilder()
    .setCustomId("discord_tag")
    .setLabel("Discord Tag / User ID")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("@name, mention, or user ID")
    .setMinLength(2)
    .setMaxLength(100)
    .setRequired(true);
  const taskInput = new TextInputBuilder()
    .setCustomId("task_name")
    .setLabel("Task")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Summarize the task")
    .setMinLength(3)
    .setMaxLength(200)
    .setRequired(true);

  const notesInput = new TextInputBuilder()
    .setCustomId("task_desc")
    .setLabel("Task Description")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Add details")
    .setMaxLength(1800)
    .setRequired(true);

  const dueDateInput = new TextInputBuilder()
    .setCustomId("due_date")
    .setLabel("Due Date")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Tomorrow, Apr 5, next Friday")
    .setMaxLength(80)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(discordTagInput),
    new ActionRowBuilder().addComponents(taskInput),
    new ActionRowBuilder().addComponents(notesInput),
    new ActionRowBuilder().addComponents(dueDateInput)
  );

  await interaction.showModal(modal);
}

async function handleTaskModal(interaction) {
  const token = interaction.customId.replace("task-modal:", "");
  const pending = consumePendingTaskForm(token, interaction.user.id);
  if (!pending) {
    await interaction.reply({
      content: "This task form expired. Run /task again.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const rateLimitResult = isRateLimited(interaction.user.id);
  if (rateLimitResult.limited) {
    const retryAfterSeconds = Math.ceil(rateLimitResult.retryAfterMs / 1000);
    await interaction.reply({
      content: `Rate limit hit. Try again in about ${retryAfterSeconds}s.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const rawDiscordTag = interaction.fields.getTextInputValue("discord_tag").trim();
  const taskName = interaction.fields.getTextInputValue("task_name").trim();
  const taskDescription = interaction.fields.getTextInputValue("task_desc").trim();
  const dueDateRaw = interaction.fields.getTextInputValue("due_date").trim();

  const dueDate = normalizeDateInput(dueDateRaw);
  if (!dueDate) {
    await interaction.reply({
      content: "Due Date is invalid. Try values like tomorrow, next Friday, Apr 5, or 2026-04-05.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let assigneeMember;
  try {
    assigneeMember = await resolveDiscordMember(interaction, rawDiscordTag);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.editReply({
      content: message,
    });
    return;
  }

  if (!assigneeMember) {
    await interaction.editReply({
      content: `Could not find a Discord member matching "${rawDiscordTag}". Use a mention or exact user ID.`,
    });
    return;
  }

  const assigneeEmail = await getPersonEmailByDiscordId(assigneeMember.id);
  if (!assigneeEmail) {
    await interaction.editReply({
      content: `No Notion email is registered for ${assigneeMember.displayName}. Ask them to run /register first.`,
    });
    return;
  }

  const creatorEmail = await getPersonEmailByDiscordId(interaction.user.id);
  if (!creatorEmail) {
    await interaction.editReply({
      content: "Your Discord account is not registered yet. Run /register first so I can look up your Notion email.",
    });
    return;
  }

  try {
    const notionResult = await createTaskPage({
      taskName,
      notes: taskDescription,
      dueDate,
      assignedTo: assigneeEmail,
      lead: creatorEmail,
      discordUserTag: `<@${assigneeMember.id}>`
    });

    let pingWarning = "";
    if (interaction.channel?.isTextBased()) {
      const pingMessage = formatPingMessage({
        discordUserId: assigneeMember.id,
        taskName,
        dueDate,
        lead: creatorEmail
      });

      await interaction.channel.send({
        content: pingMessage,
        allowedMentions: {
          parse: [],
          users: [assigneeMember.id],
          roles: []
        }
      });
    } else {
      pingWarning = "Could not send the ping in this channel type.";
    }

    const summaryLines = [
      `Task created successfully: ${notionResult.pageUrl}`,
      `Pinged Discord user: <@${assigneeMember.id}>`
    ];

    if (pingWarning) {
      summaryLines.push(pingWarning);
    }

    if (notionResult.warnings.length > 0) {
      summaryLines.push(`Notion mapping notes: ${notionResult.warnings.join(" | ")}`);
    }

    await interaction.editReply({
      content: summaryLines.join("\n")
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await interaction.editReply({
      content: `Failed to create task: ${message}`
    });
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === config.registerCommandName) {
      await handleRegisterSlashCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === config.taskCommandName) {
      await handleTaskSlashCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("task-modal:")) {
      await handleTaskModal(interaction);
    }
  } catch (error) {
    console.error("Unhandled interaction error", error);
    const fallbackMessage = "Something went wrong while handling that request.";

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: fallbackMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: fallbackMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

client.login(config.discordBotToken);
