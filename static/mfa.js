// Alta del autenticador TOTP. Archivo externo para cumplir la CSP (sin JavaScript en línea).
fetch('/system/auth/totp/setup', {method: 'POST'}).then(r => r.json()).then(d => {
  document.querySelector('#secret').textContent = d.secret;
  document.querySelector('#uri').textContent = d.otpauth_uri;
});
document.querySelector('#f').addEventListener('submit', async e => {
  e.preventDefault();
  const code = new FormData(e.target).get('code');
  const r = await fetch('/system/auth/totp/enable', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code})
  });
  if (r.ok) location.href = '/';
  else document.querySelector('#error').textContent = 'Código incorrecto. Verifique la hora del dispositivo e intente de nuevo.';
});
