import dotenv from "dotenv";

dotenv.config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hyphenateNotionId(id32) {
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20, 32)}`;
}

function normalizeNotionDatabaseId(raw) {
  const value = String(raw).trim();
  const fromUrl = value.match(/[a-f0-9]{32}/i);
  if (fromUrl) {
    return hyphenateNotionId(fromUrl[0].toLowerCase());
  }

  const compact = value.replace(/-/g, "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(compact)) {
    return hyphenateNotionId(compact);
  }

  return value;
}

export const config = {
  taskCommandName: "task",
  registerCommandName: "register",
  meCommandName: "me",
  doneCommandName: "done",
  departmentCommandName: "department",
  discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
  discordClientId: requireEnv("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || "",
  notionToken: requireEnv("NOTION_TOKEN"),
  notionDatabaseId: normalizeNotionDatabaseId(requireEnv("NOTION_DATABASE_ID")),
  notionPeopleDatabaseId: normalizeNotionDatabaseId(requireEnv("NOTION_PEOPLE_DATABASE_ID")),
  notionTitleProperty: process.env.NOTION_TITLE_PROPERTY?.trim() || "",
  notionNotesProperty: process.env.NOTION_NOTES_PROPERTY?.trim() || "Notes",
  notionDueDateProperty: process.env.NOTION_DUE_DATE_PROPERTY?.trim() || "Due Date",
  notionAssignedToProperty: process.env.NOTION_ASSIGNED_TO_PROPERTY?.trim() || "Assigned To",
  notionLeadProperty: process.env.NOTION_LEAD_PROPERTY?.trim() || "Lead",
  notionDiscordUserProperty: process.env.NOTION_DISCORD_USER_PROPERTY?.trim() || "Discord User",
  notionStatusProperty: process.env.NOTION_STATUS_PROPERTY?.trim() || "Status",
  notionPeopleTitleProperty: process.env.NOTION_PEOPLE_TITLE_PROPERTY?.trim() || "",
  notionPeopleEmailProperty: process.env.NOTION_PEOPLE_EMAIL_PROPERTY?.trim() || "Notion Email",
  notionPeopleDiscordIdProperty: process.env.NOTION_PEOPLE_DISCORD_ID_PROPERTY?.trim() || "Discord ID",
  defaultTaskStatus: process.env.DEFAULT_TASK_STATUS?.trim() || "Not started",
  pingMessageTemplate:
    process.env.PING_MESSAGE_TEMPLATE?.trim() ||
    "{discordUser}, there is a new task that you need to do: \"{taskName}\" (Due: {dueDate})",
  taskRateLimitWindowMs: parsePositiveInt(process.env.TASK_RATE_LIMIT_WINDOW_MS, 60_000),
  taskRateLimitMaxRequests: parsePositiveInt(process.env.TASK_RATE_LIMIT_MAX_REQUESTS, 5)
};
