import {
  getHadamardBridgeSessionMessages,
  listHadamardBridgeSessions,
} from 'actoviq-agent-sdk';

const [latestSession] = await listHadamardBridgeSessions({ limit: 1 });

if (!latestSession) {
  console.log('No Hadamard Runtime sessions were found.');
  process.exit(0);
}

const messages = await getHadamardBridgeSessionMessages(latestSession.sessionId);

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
