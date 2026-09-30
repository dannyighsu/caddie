/**
 * Slack channel listing — pagination, filtering, and the shape the agent sees.
 *
 * Kept separate from lib/slack.ts so the paging and filtering logic can be
 * tested without the Slack SDK, the database, or the harness roster in scope.
 */

/** A Slack channel as the agent sees it. */
export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  /**
   * Whether the bot user is in the channel. This is the field that actually
   * decides whether a post will succeed — a public channel the bot has never
   * been invited to still fails on `chat.postMessage`.
   */
  isMember: boolean;
  isArchived: boolean;
  numMembers?: number;
  topic?: string;
  purpose?: string;
}

/** The subset of a `conversations.list` channel object we read. */
export interface RawSlackChannel {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

/** One `conversations.list` response page. */
export interface ConversationsListPage {
  channels?: RawSlackChannel[];
  response_metadata?: { next_cursor?: string };
}

export interface ListChannelsOptions {
  /** Case-insensitive substring match on the channel name. */
  nameFilter?: string;
  /** Include archived channels. Off by default — you can't post to them. */
  includeArchived?: boolean;
  /** Cap on channels returned after filtering. */
  limit?: number;
}

/** Hard cap on pages followed, so a pathological cursor can't hang a run. */
export const MAX_PAGES = 20;
export const DEFAULT_LIMIT = 200;

export function toChannelSummary(raw: RawSlackChannel): SlackChannelSummary | null {
  // A channel with no id is unusable (nothing to post to) and one with no name
  // is unidentifiable, so both are dropped rather than surfaced half-formed.
  if (!raw.id || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    isPrivate: !!raw.is_private,
    isMember: !!raw.is_member,
    isArchived: !!raw.is_archived,
    ...(typeof raw.num_members === "number" && { numMembers: raw.num_members }),
    ...(raw.topic?.value && { topic: raw.topic.value }),
    ...(raw.purpose?.value && { purpose: raw.purpose.value }),
  };
}

/**
 * Walk every page of a `conversations.list` cursor, mapping and filtering as we
 * go. Channels the bot belongs to sort first — those are the postable ones — and
 * alphabetically within each group.
 *
 * `truncated` is true when at least one matching channel was dropped, either
 * because `limit` filled up or because the cursor ran past MAX_PAGES. Callers
 * should pass it on so a caller looking for a channel that isn't in the list
 * knows whether "absent" means "doesn't exist".
 */
export async function collectChannels(
  fetchPage: (cursor?: string) => Promise<ConversationsListPage>,
  options: ListChannelsOptions = {},
): Promise<{ channels: SlackChannelSummary[]; truncated: boolean }> {
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const needle = options.nameFilter?.trim().toLowerCase();

  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;
  let truncated = false;
  let pages = 0;

  pageLoop: while (pages < MAX_PAGES) {
    const page = await fetchPage(cursor);
    pages++;

    for (const raw of page.channels ?? []) {
      const channel = toChannelSummary(raw);
      if (!channel) continue;
      if (channel.isArchived && !options.includeArchived) continue;
      if (needle && !channel.name.toLowerCase().includes(needle)) continue;
      if (channels.length >= limit) {
        truncated = true;
        break pageLoop;
      }
      channels.push(channel);
    }

    cursor = page.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  }

  channels.sort((a, b) =>
    a.isMember === b.isMember ? a.name.localeCompare(b.name) : a.isMember ? -1 : 1,
  );

  return { channels, truncated };
}
