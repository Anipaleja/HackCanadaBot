# Notion Task + Discord Ping Bot

This bot lets you run `/task` in Discord, fill a task form, create a page in your Notion task database, and automatically ping the chosen Discord user.

<img width="167" height="176" alt="Screenshot 2026-04-22 at 9 21 48 PM" src="https://github.com/user-attachments/assets/8241582d-2f43-4ffa-a6d5-e962ff726e33" />


## What It Does

- Adds a Discord slash command: `/task`
- Requires selecting a `discord_user` up front (this is the user that gets pinged)
- Opens a modal with fields:
  - Task
  - Notes
  - Due Date
  - Assigned To
  - Lead
- Creates a new Notion database page
- Sends a channel message pinging the selected Discord user

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

1. In Discord, run `/task`
2. Choose `discord_user`
3. Fill the modal fields
4. Submit
5. Bot creates Notion page and posts a ping message like:

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
