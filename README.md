# Notion Task + Discord Ping Bot

This bot lets you run `/task` in Discord, fill a task form, create a page in your Notion task database, and automatically ping the chosen Discord user.

## What It Does

- Adds Discord slash commands: `/task` and `/register`
- `/task` asks for the assignee, task name, task description, due date, and then resolves both people through the Notion people database
- `/register` stores the current Discord user ID with their Notion email in the Notion people database
- Creates a new Notion database page
- Sends a channel message pinging the selected Discord user
- Lets organizers register their Discord ID with a Notion email

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your env file:

   ```bash
   cp .env.example .env
   ```

3. Fill `.env`:

- `DISCORD_BOT_TOKEN`: Discord bot token
- `DISCORD_CLIENT_ID`: Application client ID
- `DISCORD_GUILD_ID`: Recommended for fast command registration in one server
- `NOTION_TOKEN`: Notion integration token
- `NOTION_DATABASE_ID`: Database ID (from URL or plain ID)
- `NOTION_PEOPLE_DATABASE_ID`: Database ID for the people lookup database

For your provided URL, the database ID is:

- `2225d88c3a2180539b4cddb7352a4356`

## Run

1. Register slash command:

   ```bash
   npm run deploy:commands
   ```

2. Start bot:

   ```bash
   npm start
   ```

## Command Flow

### `/register`

1. In Discord, run `/register`
2. Enter your Notion email
3. Bot saves your Discord ID and email into the people database and replies with an ephemeral confirmation message

### `/task`

1. In Discord, run `/task`
2. Enter the assignee Discord tag or user ID
3. Fill in the task name, description, and a friendly due date like `tomorrow`, `next Friday`, or `2026-04-05`
4. Submit
5. Bot looks up the assignee and creator emails from the people database, creates the Notion task, and posts a ping message like:

Note: Discord does not expose a native calendar picker in this modal flow, so due dates are parsed from natural-language input.

If you want assignee lookup by name instead of ID, enable the Server Members Intent for the bot in the Discord developer portal.

   ```text
   @discordUser, there is a new task that you need to do: "Task Name" (Due: 2026-04-25)
   ```

## Security Notes

- Secrets are loaded from `.env` only.
- `.env` is gitignored.
- The bot uses a basic per-user rate limit for task submissions.
- Mentions are locked to only the selected `discord_user` to prevent mass-mention abuse.

## Notion Property Mapping

Default property names are configured in `.env.example` and can be overridden:

- `NOTION_NOTES_PROPERTY=Notes`
- `NOTION_DUE_DATE_PROPERTY=Due Date`
- `NOTION_ASSIGNED_TO_PROPERTY=Assigned To`
- `NOTION_LEAD_PROPERTY=Lead`
- `NOTION_DISCORD_USER_PROPERTY=Discord User`
- `NOTION_STATUS_PROPERTY=Status`

If a property is missing or type-mismatched, the bot still creates the task and returns a warning in the ephemeral Discord response.