import { listActoviqBridgeSessions } from 'actoviq-agent-sdk';

const sessions = await listActoviqBridgeSessions({ limit: 10 });

console.log(JSON.stringify(sessions, null, 2));
