import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import * as msgpackParser from 'socket.io-msgpack-parser';
import { config } from './config';
import { migrate } from './db';
import { GameServer } from './game/GameServer';
import { startCleanupJob } from './retention';
import { createApiRouter } from './routes';
import { guardSockets, httpsOnly } from './security';
import { SocialServer } from './social/SocialServer';

// last line of defence: one forgotten promise must not take every running match down with the process
process.on('unhandledRejection', (err) => console.error('[server] lỗi bất đồng bộ chưa được xử lý', err));

await migrate();
startCleanupJob();

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(httpsOnly);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.clientOrigins }));
app.use(express.json({ limit: '16kb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // binary msgpack frames: snapshots are ~30% smaller than JSON; the client must use the same parser
  parser: msgpackParser,
  cors: { origin: config.clientOrigins },
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 10_000,
  pingTimeout: 8_000,
});
// registered before GameServer so connection limits run ahead of token checks
guardSockets(io);
const game = new GameServer(io);
game.setHooks(new SocialServer(io, game));

app.use('/api', createApiRouter(game));
app.get('/api/health', (_req, res) => {
  res.json(config.production ? { ok: true } : { ok: true, ...game.stats() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Không tìm thấy.' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại sau.' });
});

httpServer.listen(config.port, () => {
  console.log(`Máy chủ game đang chạy tại http://localhost:${config.port}`);
});
