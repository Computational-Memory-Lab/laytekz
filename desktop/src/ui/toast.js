const $ = (id) => document.getElementById(id);
let current = null;

function render(state) {
  current = state;
  if (!state) return;
  document.body.className = `toast ${state.tone === 'error' ? 'error' : ''}`;
  $('message').textContent = state.message;
  $('spinner').hidden = state.tone !== 'progress';
  $('dismiss').hidden = !state.dismissible;
  const actions = $('actions');
  actions.replaceChildren(...state.actions.map((action) => {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.dataset.testid = `toast-action-${action.id}`;
    if (action.primary) button.className = 'primary';
    button.addEventListener('click', () => window.laytekz.action('action', action.id));
    return button;
  }));
  reportHeight();
}

function reportHeight() {
  requestAnimationFrame(() => window.laytekz.action('resize', $('row').getBoundingClientRect().height));
}

new ResizeObserver(reportHeight).observe($('row'));
window.laytekz.onState(render);
window.laytekz.state().then((initial) => { if (initial && !current) render(initial); });
$('dismiss').addEventListener('click', () => window.laytekz.action('dismiss'));
