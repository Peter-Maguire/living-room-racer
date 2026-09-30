// Start scripted opponents against a running local server, to play against or
// to watch items in action:
//   node scripts/run-bots.mjs [--port 3001] [--count 2]
import { startBot } from './bot.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const port = arg('port', 3001);
const count = arg('count', 2);
const names = ['BotAce', 'BotBolt', 'BotCleo', 'BotDash'];
for (let i = 0; i < count; i++) {
  startBot(names[i % names.length], 8 + i * 1.5, 'http://localhost:' + port);
}
console.log(count + ' bot(s) connected to port ' + port + '. Ctrl+C to stop.');
