const $ = (id) => document.getElementById(id);
const input = $('url');
const message = $('message');
let defaultUrl = '';

function say(text, isError) {
  message.textContent = text;
  message.classList.toggle('error', !!isError);
}

function busy(on) {
  for (const id of ['url', 'save', 'default']) $(id).disabled = on;
}

window.laytekz.state().then((state) => {
  if (!state) return;
  defaultUrl = state.defaultUrl;
  input.value = state.current;
  input.select();
  say(`Currently connected to ${state.current}.`);
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  busy(true);
  say(`Checking ${input.value.trim() || 'the address'}…`);
  const result = await window.laytekz.action('save', input.value);
  busy(false);
  if (result && !result.ok) {
    say(result.error, true);
    input.focus();
  }
});

$('default').addEventListener('click', () => {
  input.value = defaultUrl;
  say('');
  input.focus();
});

$('cancel').addEventListener('click', () => window.laytekz.action('cancel'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.laytekz.action('cancel');
});
