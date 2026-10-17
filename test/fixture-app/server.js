import express from 'express';
import { authenticator } from 'otplib';

const users = new Map();
const sessions = new Map();
const state = { loginPosts: 0, failFlag: false, flakyLeft: 0, layout: 'steady', delayMs: 0, otpFilled: false, pingCount: 0, offlistPages: 0, burstPages: 0, smsPosts: 0, assetHits: 0, busyHits: 0, spaLogins: 0, storePassword: '', emailCode: '' };

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
    state.assetHits = 0;
    state.busyHits = 0;
    state.spaLogins = 0;
    state.storePassword = String(req.body.storePassword ?? '');
    state.emailCode = String(req.body.emailCode ?? '');
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

  // Planted accessibility faults: an image with no description, a field with no label, a button
  // with no name, and text too faint to read.
  app.get('/a11y', (_req, res) => {
    res.type('html').send(page('Accessibility', `
      <main>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40">
        <input id="nameless">
        <button id="silent"></button>
        <p class="faint" style="color:#222;background:#111">Faint words</p>
      </main>`));
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

  // Forty requests at once. The runner paces them. Every one must still arrive.
  app.get('/burst', (_req, res) => {
    state.burstPages += 1;
    res.type('html').send(page('Burst', `
      <p id="ready">ready</p>
      <script>
        Promise.all(Array.from({ length: 40 }, () => fetch('/ping').then((response) => response.status))).then((codes) => {
          const id = codes.every((code) => code === 204) ? 'all' : 'dropped';
          document.body.insertAdjacentHTML('beforeend', '<p id="' + id + '">' + id + '</p>');
        }, () => document.body.insertAdjacentHTML('beforeend', '<p id="dropped">dropped</p>'));
      </script>`));
  });

  // A single-page app sign-in. The form posts JSON with fetch, the app changes the URL with
  // history.pushState, and the dashboard renders late. No full page navigation happens.
  app.get(['/spa', '/spa/dashboard'], (_req, res) => {
    res.type('html').send(page('App', `
      <div id="app"></div>
      <script>
        const app = document.getElementById('app');
        const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function showDashboard() {
          app.innerHTML = '<p>Loading</p>';
          await later(700);
          app.innerHTML = '<p data-testid="user-menu">Account</p><p>QA Smoke Project</p>';
        }
        function showLogin() {
          app.innerHTML = '<form id="f"><label>Email <input id="email" name="email"></label><label>Password <input id="password" name="password" type="password"></label><button type="submit">Sign in</button></form>';
          document.getElementById('f').addEventListener('submit', async (event) => {
            event.preventDefault();
            const response = await fetch('/api/spa-login', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }),
            });
            if (!response.ok) {
              app.insertAdjacentHTML('beforeend', '<p>access denied</p>');
              return;
            }
            history.pushState({}, '', '/spa/dashboard');
            await showDashboard();
          });
        }
        if (location.pathname === '/spa/dashboard' && document.cookie.includes('spa=1')) showDashboard();
        else showLogin();
      </script>`));
  });

  app.post('/api/spa-login', async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const user = users.get(String(req.body.email ?? ''));
    if (!user || user.password !== req.body.password) return res.status(401).json({ error: 'access denied' });
    state.spaLogins += 1;
    res.setHeader('set-cookie', 'spa=1; Path=/');
    res.json({ ok: true });
  });

  // A page like a real site: 65 same-origin resources, an invisible reCAPTCHA v3 badge, a
  // Turnstile script that never shows a widget, and a promo-code field with maxlength 6.
  // #ready appears only when every image and script loaded.
  app.get('/heavy', (_req, res) => {
    const images = Array.from({ length: 50 }, (_, index) => `<img alt="" width="8" height="8" src="/asset/img-${index}.svg">`).join('');
    const scripts = Array.from({ length: 10 }, (_, index) => `<script src="/asset/lib-${index}.js"></script>`).join('');
    const styles = Array.from({ length: 5 }, (_, index) => `<link rel="stylesheet" href="/asset/style-${index}.css">`).join('');
    res.type('html').send(`<!doctype html><html><head><title>Heavy</title>${styles}${scripts}
      <script src="https://www.google.com/recaptcha/api.js?render=site-key" async></script>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script></head><body>
      <h1>Heavy</h1>${images}
      <div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:0"><iframe title="reCAPTCHA" src="/captcha-frame?size=invisible" width="256" height="60"></iframe></div>
      <div class="cf-turnstile" data-size="invisible" style="width:0;height:0"></div>
      <label>Promo code <input name="promoCode" maxlength="6"></label>
      <script>
        window.addEventListener('load', () => {
          const loaded = [...document.images].filter((image) => image.complete && image.naturalWidth > 0).length;
          const ok = loaded === 50 && window.libsLoaded === 10;
          document.body.insertAdjacentHTML('beforeend', ok ? '<p id="ready">ready</p>' : '<p id="broken">broken ' + loaded + ' ' + window.libsLoaded + '</p>');
        });
      </script>
      </body></html>`);
  });

  app.get('/asset/:name', (req, res) => {
    state.assetHits += 1;
    const name = req.params.name;
    if (name.endsWith('.svg')) return res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#9ecbff"/></svg>');
    if (name.endsWith('.js')) return res.type('application/javascript').send('window.libsLoaded = (window.libsLoaded || 0) + 1;');
    if (name.endsWith('.css')) return res.type('text/css').send('h1 { letter-spacing: 0.01em; }');
    return res.status(404).end();
  });

  // A site that is overloaded: every API call answers 429.
  app.get('/overload', (_req, res) => {
    res.type('html').send(page('Busy', `
      <p id="ready">ready</p>
      <script>
        (async () => {
          for (let i = 0; i < 12; i += 1) await fetch('/busy').catch(() => {});
          document.body.insertAdjacentHTML('beforeend', '<p id="done">done</p>');
        })();
      </script>`));
  });

  app.get('/busy', (_req, res) => {
    state.busyHits += 1;
    res.status(429).set('retry-after', '1').end();
  });

  app.get('/store-password', (_req, res) => {
    res.type('html').send(page('Store', '<form method="post" action="/password"><p>Enter store password</p><label>Password <input type="password" name="password"></label><button type="submit">Enter</button></form>'));
  });

  app.post('/password', (req, res) => {
    if (req.body.password && req.body.password === state.storePassword) {
      res.type('html').send(page('Catalogue', '<p data-testid="store-open">store open</p>'));
      return;
    }
    res.status(401).type('html').send(page('Store', '<p>wrong password</p>'));
  });

  app.get('/pay-frame', (_req, res) => {
    res.type('html').send('<form><label>Card number <input name="cardnumber" autocomplete="cc-number"></label><label>Expiry <input name="exp" autocomplete="cc-exp"></label><label>CVC <input name="cvc" autocomplete="cc-csc"></label></form>');
  });

  app.get('/pay', (_req, res) => {
    res.type('html').send(page('Pay', `<iframe src="/pay-frame" title="card payment"></iframe><button id="pay-now" type="button">Pay</button><p id="pay-result">waiting</p>
<script>
document.getElementById('pay-now').addEventListener('click', () => {
  const doc = document.querySelector('iframe').contentDocument;
  const number = doc.querySelector('[name=cardnumber]').value;
  const exp = doc.querySelector('[name=exp]').value;
  const cvc = doc.querySelector('[name=cvc]').value;
  document.getElementById('pay-result').textContent = number === '4242424242424242' && exp === '12 / 34' && cvc === '123' ? 'card accepted' : 'card refused';
});
</script>`));
  });

  app.get('/keys', (_req, res) => {
    res.type('html').send(page('Keys', `<button id="one">One</button><button id="two">Two</button><p id="focus">focused none</p><p id="size">width 0</p>
<script>
function showSize() { document.getElementById('size').textContent = 'width ' + window.innerWidth; }
showSize();
window.addEventListener('resize', showSize);
document.addEventListener('focusin', (event) => { document.getElementById('focus').textContent = 'focused ' + (event.target.id || 'body'); });
</script>`));
  });

  app.get('/emailed-code', (_req, res) => {
    res.type('html').send(page('Code', '<p>We emailed you a code</p><form method="post" action="/emailed-code"><label>Code <input name="code" autocomplete="one-time-code" maxlength="6"></label><button type="submit">Continue</button></form>'));
  });

  app.post('/emailed-code', (req, res) => {
    if (req.body.code && req.body.code === state.emailCode) {
      res.type('html').send(page('Account', '<p data-testid="signed-in">signed in</p>'));
      return;
    }
    res.status(401).type('html').send(page('Code', '<p>wrong code</p>'));
  });

  app.get('/__admin/stats', (_req, res) => {
    res.json({ loginPosts: state.loginPosts, otpFilled: state.otpFilled, pingCount: state.pingCount, offlistPages: state.offlistPages, burstPages: state.burstPages, smsPosts: state.smsPosts, assetHits: state.assetHits, busyHits: state.busyHits, spaLogins: state.spaLogins });
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
