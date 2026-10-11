import express from 'express';
import { authenticator } from 'otplib';

const users = new Map();
const sessions = new Map();
const state = { loginPosts: 0, failFlag: false, flakyLeft: 0, layout: 'steady', delayMs: 0, otpFilled: false, pingCount: 0, offlistPages: 0, burstPages: 0, smsPosts: 0 };

export function createFixture() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    const raw = req.headers.cookie ?? '';
    const sid = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('sid='))?.slice(4);
    req.user = sid ? sessions.get(sid) : undefined;
    next();
  });

  app.post('/__admin/reset', (req, res) => {
    users.clear();
    sessions.clear();
    state.loginPosts = 0;
    state.otpFilled = false;
    state.pingCount = 0;
    state.offlistPages = 0;
    state.burstPages = 0;
    state.smsPosts = 0;
    state.failFlag = Boolean(req.body.failFlag);
    state.flakyLeft = Number(req.body.flakyLeft ?? 0);
    state.layout = req.body.layout ?? 'steady';
    state.delayMs = Number(req.body.delayMs ?? 0);
    for (const user of req.body.users ?? []) {
      users.set(user.email, user);
    }
    res.json({ ok: true });
  });

  app.get('/login', (req, res) => {
    const otp = req.query.totp ? '<label>Code <input id="otp" name="otp" autocomplete="one-time-code"></label>' : '';
    res.type('html').send(page('Sign in', `
      <form method="post" action="/login">
        <label>Email <input id="email" name="email"></label>
        <label>Password <input id="password" name="password" type="password"></label>
        <input name="backup-code" maxlength="6" hidden>
        ${otp}
        <button type="submit">Sign in</button>
      </form>`));
  });

  app.post('/login', (req, res) => {
    state.loginPosts += 1;
    if (/^\d{6}$/.test(String(req.body.otp ?? ''))) state.otpFilled = true;
    const user = users.get(String(req.body.email ?? ''));
    if (!user || user.password !== req.body.password) {
      res.status(401).type('html').send(page('Sign in failed', '<p>access denied</p><a href="/login">Try again</a>'));
      return;
    }
    const sid = `${Date.now()}-${Math.random()}`;
    sessions.set(sid, user);
    res.setHeader('set-cookie', `sid=${sid}; HttpOnly; Path=/`);
    res.redirect('/dashboard');
  });

  app.get('/dashboard', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.type('html').send(page('Dashboard', accountChrome()));
  });

  app.get('/projects', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.type('html').send(page('Projects', `${accountChrome()}<p>QA Smoke Project</p>`));
  });

  app.get('/logout', (req, res) => {
    res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
    res.redirect('/login');
  });

  app.get('/t/:tenant/resource/:id', (req, res) => {
    if (!req.user) return res.redirect('/login');
    const owns = req.user.tenant === req.params.tenant && (req.user.resources ?? []).includes(req.params.id);
    if (!owns) {
      res.status(403).type('html').send(page('Denied', '<p>access denied</p>'));
      return;
    }
    res.type('html').send(page('Resource', `<div data-testid="resource-view">${req.params.id}</div>`));
  });

  app.get('/api/resources/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'access denied' });
    if (!(req.user.resources ?? []).includes(req.params.id)) return res.status(403).json({ error: 'forbidden' });
    res.json({ id: req.params.id });
  });

  app.get('/captcha', (_req, res) => {
    res.type('html').send(page('Check', '<iframe src="/captcha-frame" title="recaptcha"></iframe><p>verify you are human</p>'));
  });

  app.get('/captcha-frame', (_req, res) => {
    res.type('html').send('<p>recaptcha</p>');
  });

  app.get('/sms', (_req, res) => {
    res.type('html').send(page('Code', '<p>We texted you a code</p><form method="post" action="/sms"><label>Code <input name="code" maxlength="6"></label><button>Continue</button></form>'));
  });

  app.post('/sms', (_req, res) => {
    state.smsPosts += 1;
    res.type('html').send(page('Sent', '<p>posted</p>'));
  });

  app.get('/otp', (req, res) => {
    const code = String(req.query.code ?? '');
    const matchesStatic = req.user && req.user.otp && code === req.user.otp;
    const matchesTotp = req.user && req.user.totp && code && authenticator.check(code, req.user.totp);
    if (code && req.user && (matchesStatic || matchesTotp)) {
      res.type('html').send(page('Done', '<p data-testid="otp-ok">code accepted</p>'));
      return;
    }
    res.type('html').send(page('Code', '<form method="get" action="/otp"><input autocomplete="one-time-code" name="code"><button>Continue</button></form>'));
  });

  app.get('/echo', (_req, res) => {
    res.type('html').send(page('Echo', `
      <input id="leak" type="text">
      <button id="echo-go" type="button">Echo</button>
      <div id="dom"></div>
      <script>
        document.getElementById('echo-go').addEventListener('click', async () => {
          const value = document.getElementById('leak').value;
          document.getElementById('dom').textContent = value;
          console.log(value);
          await fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ echo: value }) });
          location.hash = encodeURIComponent(value);
          setTimeout(() => { throw new Error(value); }, 30);
        });
      </script>`));
  });

  app.post('/api/echo', (req, res) => {
    res.json({ echo: req.body.echo ?? '' });
  });

  app.get('/off', (_req, res) => {
    res.redirect('https://example.com/');
  });

  app.get('/flag', (_req, res) => {
    if (state.failFlag) res.type('html').send(page('Flag', '<p>missing</p>'));
    else res.type('html').send(page('Flag', '<p id="ready">ready</p>'));
  });

  app.get('/flaky', (_req, res) => {
    if (state.flakyLeft > 0) {
      state.flakyLeft -= 1;
      res.type('html').send(page('Flaky', '<p>not yet</p>'));
      return;
    }
    res.type('html').send(page('Flaky', '<p id="ready">ready</p>'));
  });

  app.get('/layout', async (_req, res) => {
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const extra = state.layout === 'changed' ? '<div id="banner" style="background:#f4f4f4;color:#111;height:160px;font-size:48px">New banner</div>' : '';
    res.type('html').send(page('Layout', `<main id="stage">steady</main>${extra}`));
  });

  app.get('/slow', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    res.type('html').send(page('Slow', '<p id="ready">ready</p>'));
  });

  app.get('/ping', (_req, res) => {
    state.pingCount += 1;
    res.status(204).end();
  });

  // Twelve paced same-origin fetches stay inside the 5/s bucket. Eight off-list fetches are aborted by the runner and never arrive here.
  app.get('/offlist-pass', (_req, res) => {
    state.offlistPages += 1;
    res.type('html').send(page('Off list', `
      <p id="ready">ready</p>
      <img alt="" src="https://off-list.invalid/pixel.png">
      <script>
        for (let i = 0; i < 8; i += 1) fetch('https://off-list.invalid/pixel-' + i).catch(() => {});
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        (async () => {
          for (let i = 0; i < 12; i += 1) {
            await fetch('/ping').catch(() => {});
            await wait(400);
          }
          const done = document.createElement('p');
          done.id = 'paced';
          done.textContent = 'paced';
          document.body.appendChild(done);
        })();
      </script>`));
  });

  app.get('/burst', (_req, res) => {
    state.burstPages += 1;
    res.type('html').send(page('Burst', `
      <p id="ready">ready</p>
      <script>
        for (let i = 0; i < 40; i += 1) fetch('/ping').catch(() => {});
      </script>`));
  });

  app.get('/__admin/stats', (_req, res) => {
    res.json({ loginPosts: state.loginPosts, otpFilled: state.otpFilled, pingCount: state.pingCount, offlistPages: state.offlistPages, burstPages: state.burstPages, smsPosts: state.smsPosts });
  });

  return app;
}

function accountChrome() {
  return '<p data-testid="user-menu">Account</p><a href="/projects">Projects</a><a role="menuitem" href="/logout">Sign out</a>';
}

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title><style>
    body { background:#111; color:#f4f4f4; font-family:sans-serif; }
    a { color:#9ecbff; }
    input, button { background:#f4f4f4; color:#111; }
  </style></head><body><h1>${title}</h1>${body}</body></html>`;
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.PORT ?? 4173);
  createFixture().listen(port, '0.0.0.0', () => {
    process.stdout.write(`fixture listening on ${port}\n`);
  });
}
