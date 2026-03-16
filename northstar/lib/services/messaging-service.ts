import {
  Message,
  MessageContentItemContentTypeEnum,
  SlackConversationIdentity,
  TextMessageContent,
} from "@aspects-ai/porter-sdk-typescript";
import { v4 as uuidv4 } from "uuid";
import { getPorterClient } from "../clients/porter-client";
import { getAppConfig } from "../config/app-config";

export interface SendMessageOptions {
  conversationId?: string;
  senderId?: string;
  slackIdentity?: SlackConversationIdentity;
}

export class MessagingService {
  private porterClient = getPorterClient();

  async sendTextMessage(
    text: string,
    options: SendMessageOptions
  ): Promise<Message | null> {
    const messageContent: TextMessageContent = {
      contentType: MessageContentItemContentTypeEnum.Text,
      bodyText: text,
    };

    const message: Message = {
      id: uuidv4(),
      conversationId: options.conversationId || "",
      messageContents: [messageContent],
      senderId: options.senderId || "northstar-agent",
      inferenceMetadatas: [],
      createdAt: new Date(),
    };

    if (options.slackIdentity) {
      return this.porterClient.sendToSlackChannel(message, options.slackIdentity);
    } else if (options.conversationId && options.senderId) {
      return this.porterClient.sendToConversation(
        options.conversationId,
        options.senderId,
        message
      );
    }

    console.error("[MessagingService] No valid destination provided");
    return null;
  }

  async sendToSlackWithIdentity(text: string, slackIdentity: SlackConversationIdentity): Promise<Message | null> {
    if (!slackIdentity.teamId || !slackIdentity.channelId || !slackIdentity.appId) {
      console.error("[MessagingService] Incomplete Slack identity:", slackIdentity);
      return null;
    }

    return this.sendTextMessage(text, { slackIdentity });
  }

  async sendToSlack(text: string, channelId: string, teamId?: string): Promise<Message | null> {
    const config = getAppConfig();

    // Get team ID from parameter or config
    const resolvedTeamId = teamId || config.SLACK_TEAM_ID;

    if (!resolvedTeamId) {
      console.error("[MessagingService] No Slack team ID available - provide teamId parameter or set SLACK_TEAM_ID");
      return null;
    }

    if (!config.SLACK_APP_ID) {
      console.error("[MessagingService] SLACK_APP_ID not configured");
      return null;
    }

    return this.sendTextMessage(text, {
      slackIdentity: {
        teamId: resolvedTeamId,
        channelId,
        appId: config.SLACK_APP_ID,
      },
    });
  }

  async replyToConversation(
    conversationId: string,
    text: string,
    senderId: string = "northstar-agent"
  ): Promise<Message | null> {
    return this.sendTextMessage(text, {
      conversationId,
      senderId,
    });
  }
}

let messagingServiceInstance: MessagingService | null = null;

export function getMessagingService(): MessagingService {
  if (!messagingServiceInstance) {
    messagingServiceInstance = new MessagingService();
  }
  return messagingServiceInstance;
}
