import { Client } from "@notionhq/client";
import { config } from "./config.js";

const notion = new Client({ auth: config.notionToken });

const DATABASE_CACHE_TTL_MS = 5 * 60_000;
const cachedDatabases = new Map();

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

function readTextPropertyValue(property) {
  if (!property) {
    return "";
  }

  switch (property.type) {
    case "title":
      return property.title.map((entry) => entry.plain_text).join("");
    case "rich_text":
      return property.rich_text.map((entry) => entry.plain_text).join("");
    case "email":
      return property.email ?? "";
    case "phone_number":
      return property.phone_number ?? "";
    case "url":
      return property.url ?? "";
    case "select":
      return property.select?.name ?? "";
    case "status":
      return property.status?.name ?? "";
    default:
      return "";
  }
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

function getTitlePropertyNameForSchema(schema, explicitPropertyName) {
  if (explicitPropertyName && schema[explicitPropertyName]?.type === "title") {
    return explicitPropertyName;
  }

  return Object.keys(schema).find((propertyName) => schema[propertyName].type === "title");
}

function buildExactTextFilter(propertyName, property, value) {
  switch (property.type) {
    case "title":
      return { [propertyName]: { title: { equals: value } } };
    case "rich_text":
      return { [propertyName]: { rich_text: { equals: value } } };
    case "email":
      return { [propertyName]: { email: { equals: value } } };
    case "phone_number":
      return { [propertyName]: { phone_number: { equals: value } } };
    case "url":
      return { [propertyName]: { url: { equals: value } } };
    case "select":
      return { [propertyName]: { select: { equals: value } } };
    case "status":
      return { [propertyName]: { status: { equals: value } } };
    default:
      return null;
  }
}

async function getDatabase(databaseId) {
  const cached = cachedDatabases.get(databaseId);
  if (cached && Date.now() - cached.cachedAtMs < DATABASE_CACHE_TTL_MS) {
    return cached.database;
  }

  const database = await notion.databases.retrieve({
    database_id: databaseId
  });
  cachedDatabases.set(databaseId, {
    database,
    cachedAtMs: Date.now()
  });
  return database;
}

async function queryPersonByDiscordId(discordUserId) {
  const database = await getDatabase(config.notionPeopleDatabaseId);
  const schema = database.properties;
  const propertyName = config.notionPeopleDiscordIdProperty;
  const property = getProperty(schema, propertyName);
  if (!property) {
    throw new Error(`Notion people property "${propertyName}" was not found.`);
  }

  const filter = buildExactTextFilter(propertyName, property, discordUserId);
  if (!filter) {
    throw new Error(`Notion people property "${propertyName}" must be a text-like property.`);
  }

  const result = await notion.databases.query({
    database_id: config.notionPeopleDatabaseId,
    filter
  });

  return {
    schema,
    page: result.results[0] ?? null
  };
}

function setPageProperty({ properties, schema, propertyName, value, warnings }) {
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
    case "title":
      properties[propertyName] = { title: toRichText(normalized) };
      return true;
    case "rich_text":
      properties[propertyName] = { rich_text: toRichText(normalized) };
      return true;
    case "email":
      properties[propertyName] = { email: normalized };
      return true;
    case "phone_number":
      properties[propertyName] = { phone_number: normalized };
      return true;
    case "url":
      properties[propertyName] = { url: normalized };
      return true;
    default:
      warnings.push(`Property "${propertyName}" has unsupported type "${property.type}" for text input.`);
      return false;
  }
}

export async function upsertPersonMapping({ discordUserId, discordUserName, notionEmail }) {
  const database = await getDatabase(config.notionPeopleDatabaseId);
  const schema = database.properties;
  const warnings = [];
  const properties = {};

  const titlePropertyName = getTitlePropertyNameForSchema(schema, config.notionPeopleTitleProperty);
  if (!titlePropertyName) {
    throw new Error("Could not find a title property in the Notion people database.");
  }

  setPageProperty({
    properties,
    schema,
    propertyName: titlePropertyName,
    value: discordUserName,
    warnings
  });

  setPageProperty({
    properties,
    schema,
    propertyName: config.notionPeopleDiscordIdProperty,
    value: discordUserId,
    warnings
  });

  setPageProperty({
    properties,
    schema,
    propertyName: config.notionPeopleEmailProperty,
    value: notionEmail,
    warnings
  });

  const existing = await queryPersonByDiscordId(discordUserId);
  const page = existing.page;

  if (page) {
    await notion.pages.update({
      page_id: page.id,
      properties
    });
    return {
      pageId: page.id,
      pageUrl: page.url,
      warnings
    };
  }

  const createdPage = await notion.pages.create({
    parent: {
      database_id: config.notionPeopleDatabaseId
    },
    properties
  });

  return {
    pageId: createdPage.id,
    pageUrl: createdPage.url,
    warnings
  };
}

export async function getPersonEmailByDiscordId(discordUserId) {
  const result = await queryPersonByDiscordId(discordUserId);
  if (!result.page) {
    return null;
  }

  const emailProperty = result.schema[config.notionPeopleEmailProperty];
  if (!emailProperty) {
    throw new Error(`Notion people property "${config.notionPeopleEmailProperty}" was not found.`);
  }

  const email = readTextPropertyValue(result.page.properties[config.notionPeopleEmailProperty]);
  return email || null;
}

export async function queryTasksByAssignedEmail(assignedEmail) {
  const database = await getDatabase(config.notionDatabaseId);
  const schema = database.properties;
  const propertyName = config.notionAssignedToProperty;
  const property = getProperty(schema, propertyName);
  if (!property) {
    throw new Error(`Notion task property "${propertyName}" was not found.`);
  }

  const filter = buildExactTextFilter(propertyName, property, assignedEmail);
  if (!filter) {
    throw new Error(`Notion task property "${propertyName}" must be a text-like property.`);
  }

  const result = await notion.databases.query({
    database_id: config.notionDatabaseId,
    filter,
    sorts: [{ property: config.notionDueDateProperty, direction: "ascending" }]
  });

  return result.results.map((page) => ({
    pageId: page.id,
    pageUrl: page.url,
    taskName: readTextPropertyValue(page.properties[getTitlePropertyName(schema)] || {}),
    description: readTextPropertyValue(page.properties[config.notionNotesProperty] || {}),
    dueDate: readTextPropertyValue(page.properties[config.notionDueDateProperty] || {}),
    assignedTo: readTextPropertyValue(page.properties[config.notionAssignedToProperty] || {}),
    lead: readTextPropertyValue(page.properties[config.notionLeadProperty] || {}),
    status: readTextPropertyValue(page.properties[config.notionStatusProperty] || {})
  }));
}

export async function queryTasksByLeadEmail(leadEmail, excludeStatuses = ["Done", "Canceled"]) {
  const database = await getDatabase(config.notionDatabaseId);
  const schema = database.properties;
  const propertyName = config.notionLeadProperty;
  const statusPropertyName = config.notionStatusProperty;
  const property = getProperty(schema, propertyName);
  const statusProperty = getProperty(schema, statusPropertyName);

  if (!property) {
    throw new Error(`Notion task property "${propertyName}" was not found.`);
  }
  if (!statusProperty) {
    throw new Error(`Notion task property "${statusPropertyName}" was not found.`);
  }

  const leadFilter = buildExactTextFilter(propertyName, property, leadEmail);
  if (!leadFilter) {
    throw new Error(`Notion task property "${propertyName}" must be a text-like property.`);
  }

  const excludeFilters = excludeStatuses.map((status) => ({
    property: statusPropertyName,
    status: { does_not_equal: status }
  }));

  const filter = {
    and: [leadFilter, ...excludeFilters]
  };

  const result = await notion.databases.query({
    database_id: config.notionDatabaseId,
    filter,
    sorts: [{ property: config.notionDueDateProperty, direction: "ascending" }]
  });

  return result.results.map((page) => ({
    pageId: page.id,
    pageUrl: page.url,
    taskName: readTextPropertyValue(page.properties[getTitlePropertyName(schema)] || {}),
    description: readTextPropertyValue(page.properties[config.notionNotesProperty] || {}),
    dueDate: readTextPropertyValue(page.properties[config.notionDueDateProperty] || {}),
    assignedTo: readTextPropertyValue(page.properties[config.notionAssignedToProperty] || {}),
    lead: readTextPropertyValue(page.properties[config.notionLeadProperty] || {}),
    status: readTextPropertyValue(page.properties[config.notionStatusProperty] || {})
  }));
}

export async function updateTaskStatus(pageId, newStatus) {
  const database = await getDatabase(config.notionDatabaseId);
  const schema = database.properties;
  const propertyName = config.notionStatusProperty;
  const property = getProperty(schema, propertyName);

  if (!property) {
    throw new Error(`Notion task property "${propertyName}" was not found.`);
  }

  const properties = {};
  if (property.type === "status") {
    properties[propertyName] = { status: { name: newStatus } };
  } else if (property.type === "select") {
    properties[propertyName] = { select: { name: newStatus } };
  } else {
    throw new Error(`Notion task property "${propertyName}" type "${property.type}" does not support status updates.`);
  }

  const page = await notion.pages.update({
    page_id: pageId,
    properties
  });

  return {
    pageId: page.id,
    pageUrl: page.url
  };
}

export async function createTaskPage(taskInput) {
  const database = await getDatabase(config.notionDatabaseId);
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
