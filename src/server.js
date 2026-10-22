import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from '../admin/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(compression());

app.use('/admin', admin);
app.get('/', (req, res) => res.redirect(302, '/admin/'));
// The page asks for /styles.css and /app.js as absolute paths.
app.use(express.static(path.join(here, '..', 'public'), { index: false }));

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.use((req, res) => res.status(404).json({ err: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ err: err.message });
});

app.listen(PORT, () => console.log(`Nuvio setup listening on :${PORT} (admin at /admin)`));
