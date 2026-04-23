import crypto from "node:crypto";
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown
} from "discord.js";
import { config } from "./config.js";
import { createTaskPage } from "./notion.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
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

function createPendingTaskForm(requesterId, discordUserId) {
  cleanupExpiredForms();

  const token = crypto.randomUUID();
  pendingTaskForms.set(token, {
    requesterId,
    discordUserId,
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

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
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

async function handleTaskSlashCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used inside a Discord server.",
      ephemeral: true
    });
    return;
  }

  const discordUser = interaction.options.getUser("discord_user", true);
  const pendingToken = createPendingTaskForm(interaction.user.id, discordUser.id);

  const modal = new ModalBuilder().setCustomId(`task-modal:${pendingToken}`).setTitle("Add Task");
  const taskInput = new TextInputBuilder()
    .setCustomId("task_name")
    .setLabel("Task")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Summarize the task")
    .setMinLength(3)
    .setMaxLength(200)
    .setRequired(true);

  const notesInput = new TextInputBuilder()
    .setCustomId("notes")
    .setLabel("Notes")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Add details")
    .setMaxLength(1800)
    .setRequired(false);

  const dueDateInput = new TextInputBuilder()
    .setCustomId("due_date")
    .setLabel("Due Date")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("YYYY-MM-DD")
    .setMaxLength(30)
    .setRequired(true);

  const assignedToInput = new TextInputBuilder()
    .setCustomId("assigned_to")
    .setLabel("Assigned To")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Optional Notion assignee text")
    .setMaxLength(200)
    .setRequired(false);

  const leadInput = new TextInputBuilder()
    .setCustomId("lead")
    .setLabel("Lead")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Who owns completion")
    .setMaxLength(200)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(taskInput),
    new ActionRowBuilder().addComponents(notesInput),
    new ActionRowBuilder().addComponents(dueDateInput),
    new ActionRowBuilder().addComponents(assignedToInput),
    new ActionRowBuilder().addComponents(leadInput)
  );

  await interaction.showModal(modal);
}

async function handleTaskModal(interaction) {
  const token = interaction.customId.replace("task-modal:", "");
  const pending = consumePendingTaskForm(token, interaction.user.id);
  if (!pending) {
    await interaction.reply({
      content: "This task form expired. Run /task again.",
      ephemeral: true
    });
    return;
  }

  const rateLimitResult = isRateLimited(interaction.user.id);
  if (rateLimitResult.limited) {
    const retryAfterSeconds = Math.ceil(rateLimitResult.retryAfterMs / 1000);
    await interaction.reply({
      content: `Rate limit hit. Try again in about ${retryAfterSeconds}s.`,
      ephemeral: true
    });
    return;
  }

  const taskName = interaction.fields.getTextInputValue("task_name").trim();
  const notes = interaction.fields.getTextInputValue("notes").trim();
  const dueDateRaw = interaction.fields.getTextInputValue("due_date").trim();
  const assignedTo = interaction.fields.getTextInputValue("assigned_to").trim();
  const lead = interaction.fields.getTextInputValue("lead").trim();

  const dueDate = normalizeDateInput(dueDateRaw);
  if (!dueDate) {
    await interaction.reply({
      content: "Due Date is invalid. Use YYYY-MM-DD (example: 2026-04-30).",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const notionResult = await createTaskPage({
      taskName,
      notes,
      dueDate,
      assignedTo,
      lead,
      discordUserTag: `<@${pending.discordUserId}>`
    });

    let pingWarning = "";
    if (interaction.channel?.isTextBased()) {
      const pingMessage = formatPingMessage({
        discordUserId: pending.discordUserId,
        taskName,
        dueDate,
        lead
      });

      await interaction.channel.send({
        content: pingMessage,
        allowedMentions: {
          parse: [],
          users: [pending.discordUserId],
          roles: []
        }
      });
    } else {
      pingWarning = "Could not send the ping in this channel type.";
    }

    const summaryLines = [
      `Task created successfully: ${notionResult.pageUrl}`,
      `Pinged Discord user: <@${pending.discordUserId}>`
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
        await interaction.followUp({ content: fallbackMessage, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: fallbackMessage, ephemeral: true }).catch(() => {});
      }
    }
  }
});

client.login(config.discordBotToken);
