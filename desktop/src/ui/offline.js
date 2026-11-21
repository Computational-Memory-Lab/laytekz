const $ = (id) => document.getElementById(id);
let state = null;
let ticker = null;

function status() {
  if (!state) return '';
  if (state.checking) return 'Checking…';
  const seconds = Math.ceil((state.nextRetryAt - Date.now()) / 1000);
  return seconds > 0 ? `Trying again in ${seconds} s.` : 'Checking…';
}

function render(next) {
  state = next;
  if (!state) return;
  $('host').textContent = state.host;
  $('reason').textContent = state.reason;
  $('status').textContent = status();
  $('retry').disabled = !!state.checking;
  clearInterval(ticker);
  ticker = setInterval(() => { $('status').textContent = status(); }, 500);
}

window.laytekz.onState(render);
window.laytekz.state().then((initial) => { if (initial && !state) render(initial); });
$('retry').addEventListener('click', () => window.laytekz.action('retry'));
$('change').addEventListener('click', () => window.laytekz.action('change-server'));
