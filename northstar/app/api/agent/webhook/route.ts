import { getAppConfig } from "@/lib/config/app-config";
import { AgentMessage, getAgentExecutionService } from "@/lib/services/agent-execution-service";
import { getMessagingService } from "@/lib/services/messaging-service";
import {
  Conversation,
  Message,
  MessageContentItemContentTypeEnum,
  MessageDeliveredEvent,
  SlackConversationIdentity,
  TextMessageContent
} from "@aspects-ai/porter-sdk-typescript";
import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";

interface JWTClaims {
  identity?: string;
  sub?: string;
  user_claims?: {
    is_admin?: boolean;
  };
  iss?: string;
}

function validateJWT(request: NextRequest): { valid: boolean; claims?: JWTClaims; error?: string; isAdmin?: boolean } {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, error: "Missing or invalid Authorization header" };
  }

  const token = authHeader.substring(7);
  const config = getAppConfig();

  try {
    // ChatKit signs admin tokens with ADMIN_TOKEN_KEY using HMAC256
    const decoded = jwt.verify(token, config.ADMIN_TOKEN_KEY, {
      issuer: "aspects",
    }) as JWTClaims;

    // Admin status is nested under user_claims
    const isAdmin = decoded.user_claims?.is_admin === true;

    return { valid: true, claims: decoded, isAdmin };
  } catch (err) {
    return { valid: false, error: `Invalid token: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

function extractTextFromMessage(message: Message): string {
  const textContents = message.messageContents?.filter(
    (content): content is TextMessageContent =>
      content.contentType === MessageContentItemContentTypeEnum.Text
  );

  return textContents?.map(tc => tc.bodyText).join("\n") || "";
}

function parseSlackIdentityFromExternalId(externalId: string): SlackConversationIdentity | null {
  // externalId is a JSON string: {"appId":"...","channelId":"...","teamId":"..."}
  try {
    const parsed = JSON.parse(externalId) as SlackConversationIdentity;
    if (parsed.teamId && parsed.channelId && parsed.appId) {
      return parsed;
    }
    return null;
  } catch {
    console.error("[Webhook] Failed to parse Slack identity from externalId:", externalId);
    return null;
  }
}

function findAgentParticipant(conversation: Conversation): string | null {
  // Find the agent participant in the conversation
  const agentParticipant = conversation.participants?.find(
    p => p.participantType === "agent"
  );
  return agentParticipant?.id || null;
}

function isMessageFromAgent(senderId: string, conversation: Conversation): boolean {
  // Check if the sender is an agent participant
  const participant = conversation.participants?.find(p => p.id === senderId);
  return participant?.participantType === "agent";
}

export async function POST(request: NextRequest) {
  // Validate JWT (signed by ChatKit with ADMIN_TOKEN_KEY)
  const { valid, isAdmin, error } = validateJWT(request);
  if (!valid) {
    console.error("[Webhook] JWT validation failed:", error);
    return NextResponse.json({ error }, { status: 401 });
  }

  // Require admin access
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Parse the MessageDeliveredEvent
  const messageEvent: MessageDeliveredEvent = await request.json();
  const { conversation, messageId, senderId, shouldReply, systemInstructions, referenceText } = messageEvent;

  // Find the agent participant in this conversation (for sending replies)
  const agentParticipantId = findAgentParticipant(conversation);

  console.log(`[Webhook] Received message ${messageId} from ${senderId} in conversation ${conversation.id}`);
  console.log(`[Webhook] shouldReply: ${shouldReply}, agentParticipantId: ${agentParticipantId}`);

  // If ChatKit says we shouldn't reply, respect that
  if (!shouldReply) {
    console.log("[Webhook] Skipping reply as shouldReply is false");
    return NextResponse.json({ success: true, skipped: true, reason: "shouldReply=false" });
  }

  // Don't respond to our own messages (check if sender is an agent)
  if (isMessageFromAgent(senderId, conversation)) {
    console.log("[Webhook] Skipping message from agent");
    return NextResponse.json({ success: true, skipped: true, reason: "agent_message" });
  }

  // Convert conversation messages to agent messages format
  // Messages are sorted latest to earliest, so reverse them
  const conversationMessages = [...conversation.messages].reverse();
  const incomingMessages: AgentMessage[] = conversationMessages.map(msg => {
    const isFromAgent = isMessageFromAgent(msg.senderId, conversation);
    const textContent = extractTextFromMessage(msg);

    return {
      role: isFromAgent ? "assistant" as const : "user" as const,
      content: textContent,
    };
  }).filter(msg => msg.content.trim() !== "");

  // Add system instructions and reference text if provided
  let additionalContext = "";
  if (systemInstructions) {
    additionalContext += `\n\nSystem Instructions: ${systemInstructions}`;
  }
  if (referenceText) {
    additionalContext += `\n\nReference Information: ${referenceText}`;
  }

  if (additionalContext && incomingMessages.length > 0) {
    // Prepend context to the first user message
    const firstUserMsgIndex = incomingMessages.findIndex(m => m.role === "user");
    if (firstUserMsgIndex >= 0) {
      incomingMessages[firstUserMsgIndex].content =
        additionalContext.trim() + "\n\n" + incomingMessages[firstUserMsgIndex].content;
    }
  }

  // Execute agent with the conversation context
  const agentService = getAgentExecutionService();
  const result = await agentService.executeCheckIn("default", incomingMessages);

  if (!result.success) {
    console.error("[Webhook] Agent execution failed:", result.error);
    return NextResponse.json(
      { error: result.error },
      { status: 500 }
    );
  }

  // Find the last assistant response
  const lastAssistantMessage = result.messages
    .filter(m => m.role === "assistant")
    .pop();

  if (!lastAssistantMessage) {
    console.log("[Webhook] No assistant response generated");
    return NextResponse.json({ success: true, responded: false });
  }

  // Send response back via messaging service
  const messagingService = getMessagingService();

  // Check if this is a Slack conversation
  const externalIdentity = conversation.externalMediumIdentity;
  if (externalIdentity?.mediumType === "slack") {
    const slackIdentity = parseSlackIdentityFromExternalId(externalIdentity.externalId);
    if (slackIdentity) {
      await messagingService.sendToSlackWithIdentity(
        lastAssistantMessage.content,
        slackIdentity
      );
    } else {
      console.error("[Webhook] Could not parse Slack identity from externalId:", externalIdentity.externalId);
    }
  } else {
    // Generic conversation reply - need agent participant ID
    if (!agentParticipantId) {
      console.error("[Webhook] No agent participant found in conversation");
      return NextResponse.json(
        { error: "No agent participant found in conversation" },
        { status: 500 }
      );
    }
    await messagingService.replyToConversation(
      conversation.id,
      lastAssistantMessage.content,
      agentParticipantId
    );
  }

  return NextResponse.json({
    success: true,
    responded: true,
    conversationId: conversation.id,
  });
}
