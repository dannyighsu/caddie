import {
  Agent,
  AgentsApi,
  Configuration,
  Message,
  MessageReceiveHook,
  MessagesApi,
  SlackApi,
  SlackConversationIdentity
} from "@aspects-ai/porter-sdk-typescript";
import jwt from "jsonwebtoken";
import { getAppConfig } from "../config/app-config";

let porterClient: PorterClient | null = null;

export class PorterClient {
  private messagesApi: MessagesApi;
  private slackApi: SlackApi;
  private agentsApi: AgentsApi;

  constructor(baseUrl: string, token: string) {
    const config = new Configuration({
      basePath: baseUrl,
      accessToken: () => Promise.resolve(token),
    });
    this.messagesApi = new MessagesApi(config);
    this.slackApi = new SlackApi(config);
    this.agentsApi = new AgentsApi(config);
  }

  async sendToSlackChannel(
    message: Message,
    slackIdentity: SlackConversationIdentity
  ): Promise<Message> {
    return this.messagesApi.createForSlackChannel({
      createForSlackChannelRequest: {
        message,
        slackIdentity,
      },
    });
  }

  async sendToConversation(
    conversationId: string,
    senderId: string,
    message: Message
  ): Promise<Message> {
    return this.messagesApi.messageCreate({
      conversationId,
      senderId,
      message,
    });
  }

  async getMessage(
    conversationId: string,
    messageId: string,
    viewerId?: string
  ): Promise<Message> {
    return this.messagesApi.messageGet({
      conversationId,
      messageId,
      viewerId,
    });
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    message: Message
  ): Promise<Message> {
    return this.messagesApi.messageUpdate({
      conversationId,
      messageId,
      message,
    });
  }

  async findMessageById(messageId: string): Promise<Message> {
    return this.messagesApi.findMessageById({ messageId });
  }

  async getSlackBotToken(teamId: string): Promise<string> {
    const response = await this.slackApi.slackBotTokenGet({ teamId });
    return response.botToken || "";
  }

  // Agent management
  async listAgents(): Promise<Agent[]> {
    return this.agentsApi.agentsGet({});
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.agentsApi.agentsAgentIdGet({ agentId });
  }

  async createAgent(agent: Agent): Promise<Agent> {
    return this.agentsApi.agentsPost({ agent });
  }

  async getMessageReceiveHooks(agentId: string): Promise<MessageReceiveHook[]> {
    return this.agentsApi.agentsAgentIdMessageReceiveHooksGet({ agentId });
  }

  async createMessageReceiveHook(agentId: string, hook: MessageReceiveHook): Promise<MessageReceiveHook> {
    return this.agentsApi.agentsAgentIdMessageReceiveHooksPost({
      agentId,
      messageReceiveHook: hook,
    });
  }
}

function createAdminToken(): string {
  const config = getAppConfig();
  // Match ChatKit's admin token structure:
  // - Signed with ADMIN_TOKEN_KEY using HMAC256
  // - user_claims contains is_admin
  // - issuer is "aspects"
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    identity: "admin",
    user_claims: {
      is_admin: true,
    },
    iat: now,
  };
  return jwt.sign(payload, config.ADMIN_TOKEN_KEY, {
    expiresIn: "365d",
    issuer: "aspects",
  });
}

export function getPorterClient(): PorterClient {
  if (!porterClient) {
    const config = getAppConfig();
    const token = createAdminToken();
    porterClient = new PorterClient(config.CHATKIT_BASE_URL, token);
  }
  return porterClient;
}
