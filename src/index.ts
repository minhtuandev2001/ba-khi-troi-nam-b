import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config } from './config';
import { migrate } from './db';
import { GameServer } from './game/GameServer';
import { createApiRouter } from './routes';

await migrate();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.clientOrigins }));
app.use(express.json({ limit: '16kb' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigins },
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 10_000,
  pingTimeout: 8_000,
});
const game = new GameServer(io);

app.use('/api', createApiRouter(game));
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ...game.stats() });
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
