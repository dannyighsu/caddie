import { agentName } from "@/lib/agent-name";
import OutreachView from "./outreach-view";

export default function OutreachPage() {
  return <OutreachView agentName={agentName()} />;
}
