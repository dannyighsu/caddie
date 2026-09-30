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
  /** Whether the bot user is in the channel. */
  isMember: boolean;
  isArchived: boolean;
  /**
   * Whether `chat.postMessage` will accept a post here. Membership alone
   * doesn't decide it: a token with `chat:write.public` can post to any public
   * channel it hasn't joined. Archived channels accept nothing.
   */
  canPost: boolean;
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
  /** `scopes` is the token's granted OAuth scopes, from the x-oauth-scopes header. */
  response_metadata?: { next_cursor?: string; scopes?: string[] };
}

/** The scope that lets a bot post to a public channel without joining it. */
export const PUBLIC_POST_SCOPE = "chat:write.public";

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

export function toChannelSummary(
  raw: RawSlackChannel,
  canPostPublic = false,
): SlackChannelSummary | null {
  // A channel with no id is unusable (nothing to post to) and one with no name
  // is unidentifiable, so both are dropped rather than surfaced half-formed.
  if (!raw.id || !raw.name) return null;
  const isPrivate = !!raw.is_private;
  const isMember = !!raw.is_member;
  const isArchived = !!raw.is_archived;
  return {
    id: raw.id,
    name: raw.name,
    isPrivate,
    isMember,
    isArchived,
    canPost: !isArchived && (isMember || (!isPrivate && canPostPublic)),
    ...(typeof raw.num_members === "number" && { numMembers: raw.num_members }),
    ...(raw.topic?.value && { topic: raw.topic.value }),
    ...(raw.purpose?.value && { purpose: raw.purpose.value }),
  };
}

/**
 * Walk every page of a `conversations.list` cursor, mapping and filtering as we
 * go. Postable channels sort first, then alphabetically within each group.
 * Whether public channels are postable without membership is read from the
 * scopes Slack reports on the first page.
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
  let canPostPublic = false;

  pageLoop: while (pages < MAX_PAGES) {
    const page = await fetchPage(cursor);
    pages++;
    if (pages === 1) {
      canPostPublic = !!page.response_metadata?.scopes?.includes(PUBLIC_POST_SCOPE);
    }

    for (const raw of page.channels ?? []) {
      const channel = toChannelSummary(raw, canPostPublic);
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
    a.canPost === b.canPost ? a.name.localeCompare(b.name) : a.canPost ? -1 : 1,
  );

  return { channels, truncated };
}
