import { Client } from "@notionhq/client";
import { getOAuthCredential } from "../db/oauth-repository";
import { getAppConfig } from "../config/app-config";
import {
  PageObjectResponse,
  DatabaseObjectResponse,
  QueryDatabaseResponse,
} from "@notionhq/client/build/src/api-endpoints";

export interface NotionTask {
  id: string;
  title: string;
  status?: string;
  dueDate?: string;
  priority?: string;
  url: string;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEdited: string;
}

async function getNotionClient(): Promise<Client | null> {
  const config = getAppConfig();

  // First, check for internal integration token in config
  if (config.NOTION_INTERNAL_TOKEN) {
    return new Client({
      auth: config.NOTION_INTERNAL_TOKEN,
    });
  }

  // Fall back to OAuth credentials from database
  const creds = await getOAuthCredential("notion");
  if (!creds) {
    console.error("[Notion] No Notion credentials found (neither internal token nor OAuth)");
    return null;
  }

  return new Client({
    auth: creds.access_token,
  });
}

export async function searchPages(query: string): Promise<NotionPage[]> {
  const notion = await getNotionClient();
  if (!notion) return [];

  try {
    const response = await notion.search({
      query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 10,
    });

    return response.results
      .filter((r): r is PageObjectResponse => r.object === "page")
      .map((page) => ({
        id: page.id,
        title: getPageTitle(page),
        url: page.url,
        lastEdited: page.last_edited_time,
      }));
  } catch (error) {
    console.error("[Notion] Error searching pages:", error);
    return [];
  }
}

/**
 * Fetch ALL pages accessible by the internal integration token.
 * Used for baseline context injection into agent prompt.
 * This function paginates through all results to ensure complete coverage.
 */
export async function getAllAccessiblePages(): Promise<NotionPage[]> {
  const notion = await getNotionClient();
  if (!notion) return [];

  const allPages: NotionPage[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  try {
    while (hasMore) {
      const response = await notion.search({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        start_cursor: startCursor,
      });

      allPages.push(...response.results
        .filter((r): r is PageObjectResponse => r.object === "page")
        .map((page) => ({
          id: page.id,
          title: getPageTitle(page),
          url: page.url,
          lastEdited: page.last_edited_time,
        })));

      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    }

    console.log(`[Notion] Fetched ${allPages.length} accessible pages`);
    return allPages;
  } catch (error) {
    console.error("[Notion] Error fetching all accessible pages:", error);
    return allPages; // Return what we got before the error
  }
}

/**
 * Legacy function - fetches limited number of recent pages
 * @deprecated Use getAllAccessiblePages() for complete context
 */
export async function getRecentPages(limit: number = 10): Promise<NotionPage[]> {
  const notion = await getNotionClient();
  if (!notion) return [];

  try {
    const response = await notion.search({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: limit,
    });

    return response.results
      .filter((r): r is PageObjectResponse => r.object === "page")
      .map((page) => ({
        id: page.id,
        title: getPageTitle(page),
        url: page.url,
        lastEdited: page.last_edited_time,
      }));
  } catch (error) {
    console.error("[Notion] Error fetching recent pages:", error);
    return [];
  }
}

export async function getDatabases(): Promise<DatabaseObjectResponse[]> {
  const notion = await getNotionClient();
  if (!notion) return [];

  try {
    const response = await notion.search({
      filter: { property: "object", value: "database" },
      page_size: 20,
    });

    return response.results.filter(
      (r): r is DatabaseObjectResponse => r.object === "database"
    );
  } catch (error) {
    console.error("[Notion] Error fetching databases:", error);
    return [];
  }
}

export async function getTasksFromDatabase(
  databaseId: string
): Promise<NotionTask[]> {
  const notion = await getNotionClient();
  if (!notion) return [];

  try {
    const response: QueryDatabaseResponse = await notion.databases.query({
      database_id: databaseId,
      page_size: 50,
    });

    return response.results
      .filter((r): r is PageObjectResponse => r.object === "page")
      .map((page) => parseTaskFromPage(page));
  } catch (error) {
    console.error("[Notion] Error fetching tasks from database:", error);
    return [];
  }
}

function getPageTitle(page: PageObjectResponse): string {
  const titleProp = Object.values(page.properties).find(
    (prop) => prop.type === "title"
  );

  if (titleProp && titleProp.type === "title" && titleProp.title.length > 0) {
    return titleProp.title.map((t) => t.plain_text).join("");
  }

  return "Untitled";
}

function parseTaskFromPage(page: PageObjectResponse): NotionTask {
  const task: NotionTask = {
    id: page.id,
    title: getPageTitle(page),
    url: page.url,
  };

  // Try to extract common task properties
  for (const [key, prop] of Object.entries(page.properties)) {
    const lowerKey = key.toLowerCase();

    if (prop.type === "status" && (lowerKey.includes("status") || lowerKey === "state")) {
      task.status = prop.status?.name;
    }

    if (prop.type === "select" && lowerKey.includes("status")) {
      task.status = prop.select?.name;
    }

    if (prop.type === "date" && (lowerKey.includes("due") || lowerKey.includes("date"))) {
      task.dueDate = prop.date?.start;
    }

    if (prop.type === "select" && lowerKey.includes("priority")) {
      task.priority = prop.select?.name;
    }
  }

  return task;
}

export function formatTasksForPrompt(tasks: NotionTask[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }

  return tasks
    .map((task) => {
      let line = `- ${task.title}`;
      if (task.status) {
        line += ` [${task.status}]`;
      }
      if (task.dueDate) {
        const due = new Date(task.dueDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        line += ` (due: ${due})`;
      }
      if (task.priority) {
        line += ` - ${task.priority}`;
      }
      return line;
    })
    .join("\n");
}

export function formatPagesForPrompt(pages: NotionPage[]): string {
  if (pages.length === 0) {
    return "No recent pages.";
  }

  return pages
    .map((page) => {
      const edited = new Date(page.lastEdited).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      return `- ${page.title} (edited: ${edited})`;
    })
    .join("\n");
}
