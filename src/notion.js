import { Client } from "@notionhq/client";
import { config } from "./config.js";

const notion = new Client({ auth: config.notionToken });

const DATABASE_CACHE_TTL_MS = 5 * 60_000;
let cachedDatabase = null;
let cachedAtMs = 0;

function toRichText(content) {
  return [
    {
      type: "text",
      text: {
        content: content.slice(0, 2000)
      }
    }
  ];
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function getProperty(schema, propertyName) {
  if (!propertyName) {
    return null;
  }
  return schema[propertyName] ?? null;
}

function setTextLikeProperty({ properties, schema, propertyName, value, warnings }) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  const property = getProperty(schema, propertyName);
  if (!property) {
    warnings.push(`Notion property "${propertyName}" was not found. Skipped value "${normalized}".`);
    return false;
  }

  switch (property.type) {
    case "rich_text":
      properties[propertyName] = { rich_text: toRichText(normalized) };
      return true;
    case "title":
      properties[propertyName] = { title: toRichText(normalized) };
      return true;
    case "url":
      properties[propertyName] = { url: normalized };
      return true;
    case "email":
      properties[propertyName] = { email: normalized };
      return true;
    case "phone_number":
      properties[propertyName] = { phone_number: normalized };
      return true;
    case "select": {
      const selectOptions = property.select.options.map((option) => option.name);
      if (!selectOptions.includes(normalized)) {
        warnings.push(
          `Select value "${normalized}" does not exist in "${propertyName}" options (${selectOptions.join(", ")}).`
        );
        return false;
      }
      properties[propertyName] = { select: { name: normalized } };
      return true;
    }
    case "status": {
      const statusOptions = property.status.options.map((option) => option.name);
      if (!statusOptions.includes(normalized)) {
        warnings.push(
          `Status value "${normalized}" does not exist in "${propertyName}" options (${statusOptions.join(", ")}).`
        );
        return false;
      }
      properties[propertyName] = { status: { name: normalized } };
      return true;
    }
    case "multi_select": {
      const values = normalized
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (values.length === 0) {
        return false;
      }
      properties[propertyName] = {
        multi_select: values.map((entry) => ({ name: entry }))
      };
      return true;
    }
    default:
      warnings.push(`Property "${propertyName}" has unsupported type "${property.type}" for text input.`);
      return false;
  }
}

function setDueDateProperty({ properties, schema, propertyName, dueDate, warnings }) {
  const normalizedDate = normalizeText(dueDate);
  if (!normalizedDate) {
    return false;
  }

  const property = getProperty(schema, propertyName);
  if (!property) {
    warnings.push(`Notion property "${propertyName}" was not found. Skipped due date "${normalizedDate}".`);
    return false;
  }

  if (property.type === "date") {
    properties[propertyName] = {
      date: {
        start: normalizedDate
      }
    };
    return true;
  }

  return setTextLikeProperty({
    properties,
    schema,
    propertyName,
    value: normalizedDate,
    warnings
  });
}

function setDefaultStatus({ properties, schema, warnings }) {
  const statusValue = normalizeText(config.defaultTaskStatus);
  if (!statusValue) {
    return;
  }

  const property = getProperty(schema, config.notionStatusProperty);
  if (!property) {
    warnings.push(`Notion property "${config.notionStatusProperty}" was not found. Default status was skipped.`);
    return;
  }

  if (property.type === "status") {
    const options = property.status.options.map((option) => option.name);
    if (options.includes(statusValue)) {
      properties[config.notionStatusProperty] = { status: { name: statusValue } };
    } else {
      warnings.push(
        `Default status "${statusValue}" is not configured in "${config.notionStatusProperty}" options (${options.join(
          ", "
        )}).`
      );
    }
    return;
  }

  if (property.type === "select") {
    const options = property.select.options.map((option) => option.name);
    if (options.includes(statusValue)) {
      properties[config.notionStatusProperty] = { select: { name: statusValue } };
    } else {
      warnings.push(
        `Default select value "${statusValue}" is not configured in "${config.notionStatusProperty}" options (${options.join(
          ", "
        )}).`
      );
    }
    return;
  }

  warnings.push(
    `Property "${config.notionStatusProperty}" is type "${property.type}" and cannot be set with default status text.`
  );
}

function getTitlePropertyName(schema) {
  if (config.notionTitleProperty && schema[config.notionTitleProperty]?.type === "title") {
    return config.notionTitleProperty;
  }

  return Object.keys(schema).find((propertyName) => schema[propertyName].type === "title");
}

async function getDatabase() {
  if (cachedDatabase && Date.now() - cachedAtMs < DATABASE_CACHE_TTL_MS) {
    return cachedDatabase;
  }

  const database = await notion.databases.retrieve({
    database_id: config.notionDatabaseId
  });
  cachedDatabase = database;
  cachedAtMs = Date.now();
  return database;
}

export async function createTaskPage(taskInput) {
  const database = await getDatabase();
  const schema = database.properties;
  const warnings = [];
  const properties = {};

  const titlePropertyName = getTitlePropertyName(schema);
  if (!titlePropertyName) {
    throw new Error("Could not find a title property in the Notion database.");
  }

  properties[titlePropertyName] = {
    title: toRichText(normalizeText(taskInput.taskName))
  };

  const usedNotesProperty = setTextLikeProperty({
    properties,
    schema,
    propertyName: config.notionNotesProperty,
    value: taskInput.notes,
    warnings
  });

  setDueDateProperty({
    properties,
    schema,
    propertyName: config.notionDueDateProperty,
    dueDate: taskInput.dueDate,
    warnings
  });

  setTextLikeProperty({
    properties,
    schema,
    propertyName: config.notionAssignedToProperty,
    value: taskInput.assignedTo,
    warnings
  });

  setTextLikeProperty({
    properties,
    schema,
    propertyName: config.notionLeadProperty,
    value: taskInput.lead,
    warnings
  });

  setTextLikeProperty({
    properties,
    schema,
    propertyName: config.notionDiscordUserProperty,
    value: taskInput.discordUserTag,
    warnings
  });

  setDefaultStatus({ properties, schema, warnings });

  const children = [];
  if (!usedNotesProperty && normalizeText(taskInput.notes)) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: toRichText(normalizeText(taskInput.notes))
      }
    });
  }

  const page = await notion.pages.create({
    parent: {
      database_id: config.notionDatabaseId
    },
    properties,
    ...(children.length > 0 ? { children } : {})
  });

  return {
    pageId: page.id,
    pageUrl: page.url,
    warnings
  };
}
