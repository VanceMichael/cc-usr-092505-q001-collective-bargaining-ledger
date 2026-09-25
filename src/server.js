// 服务启动入口：默认内存运行；设置 BARGAINING_DATA_FILE 后每次写请求落盘。
//   PORT=8080 BARGAINING_DATA_FILE=./data/ledger.json node src/server.js
import { Store } from './store.js';
import { BargainingService } from './service.js';
import { startServer } from './http.js';

const dataFile = process.env.BARGAINING_DATA_FILE || null;
const store = dataFile ? await Store.load(dataFile) : new Store();
const service = new BargainingService(store);

const hooks = dataFile
  ? { afterWrite: () => store.save(dataFile).catch((err) => console.error('落盘失败：', err.message)) }
  : {};

const port = Number(process.env.PORT) || 8080;
const server = await startServer(service, port, hooks);
console.log(`集体协商账本已启动：http://localhost:${port}${dataFile ? `（数据文件 ${dataFile}）` : '（内存模式）'}`);

const shutdown = async () => {
  if (dataFile) await store.save(dataFile).catch(() => {});
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
