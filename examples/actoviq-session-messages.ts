import {
  getActoviqBridgeSessionMessages,
  listActoviqBridgeSessions,
} from 'actoviq-agent-sdk';

const [latestSession] = await listActoviqBridgeSessions({ limit: 1 });

if (!latestSession) {
  console.log('No Actoviq Runtime sessions were found.');
  process.exit(0);
}

const messages = await getActoviqBridgeSessionMessages(latestSession.sessionId);

console.log(
  JSON.stringify(
    {
      sessionId: latestSession.sessionId,
      summary: latestSession.summary,
      messageCount: messages.length,
      messages,
    },
    null,
    2,
  ),
);
