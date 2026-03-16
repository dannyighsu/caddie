import { getDueCheckIns, markCheckInTriggered, markCheckInCompleted } from "../clients/redis-client";
import { getAgentExecutionService } from "../services/agent-execution-service";
import { getMessagingService } from "../services/messaging-service";
import { getDefaultSlackChannel } from "../db/settings-repository";

const POLL_INTERVAL_MS = 60 * 1000; // Poll every 60 seconds

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

async function processCheckIns() {
  if (isRunning) {
    console.log("[Scheduler] Already processing, skipping...");
    return;
  }

  isRunning = true;

  try {
    const dueCheckIns = await getDueCheckIns();

    if (dueCheckIns.length === 0) {
      return;
    }

    console.log(`[Scheduler] Processing ${dueCheckIns.length} due check-in(s)`);

    // Get the default Slack channel for sending check-in messages
    const defaultSlackChannel = await getDefaultSlackChannel();
    if (!defaultSlackChannel) {
      console.warn("[Scheduler] No default Slack channel configured - check-in messages will not be sent");
    }

    for (const checkIn of dueCheckIns) {
      try {
        console.log(`[Scheduler] Running check-in for user: ${checkIn.userId}`);

        // Mark as triggered (removes from queue)
        await markCheckInTriggered(checkIn.userId, checkIn.scheduledTime);

        const agentService = getAgentExecutionService();
        const result = await agentService.executeCheckIn(checkIn.userId);

        // Send check-in result to Slack if configured
        if (result.success && result.messages.length > 0 && defaultSlackChannel) {
          const messagingService = getMessagingService();

          // Send the assistant's response to Slack
          for (const msg of result.messages) {
            if (msg.role === "assistant" && msg.content) {
              await messagingService.sendToSlackWithIdentity(msg.content, defaultSlackChannel);
              console.log(`[Scheduler] Sent check-in message to Slack channel: ${defaultSlackChannel.channelId}`);
            }
          }
        } else if (!result.success) {
          console.error(`[Scheduler] Check-in failed for user ${checkIn.userId}:`, result.error);
        }

        // Mark as completed
        await markCheckInCompleted(checkIn.userId, checkIn.scheduledTime);

        console.log(`[Scheduler] Completed check-in for user: ${checkIn.userId}`);
      } catch (error) {
        console.error(`[Scheduler] Failed check-in for user ${checkIn.userId}:`, error);
      }
    }
  } catch (error) {
    console.error("[Scheduler] Error polling for check-ins:", error);
  } finally {
    isRunning = false;
  }
}

export function startScheduler() {
  if (intervalId) {
    console.log("[Scheduler] Already started");
    return;
  }

  console.log(`[Scheduler] Starting polling scheduler (interval: ${POLL_INTERVAL_MS}ms)`);

  // Run immediately on start
  processCheckIns();

  // Then poll at interval
  intervalId = setInterval(processCheckIns, POLL_INTERVAL_MS);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[Scheduler] Stopped");
  }
}
