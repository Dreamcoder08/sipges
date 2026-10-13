// Formulario de acceso. Archivo externo para cumplir la CSP (sin JavaScript en línea).
document.querySelector('#f').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await fetch('/login', {method: 'POST', body: new FormData(e.target)});
  if (r.ok) location.href = '/';
  else document.querySelector('#error').textContent = r.status === 429
    ? 'Demasiados intentos fallidos. Espere unos minutos e intente de nuevo.'
    : 'Credenciales inválidas o acceso inhabilitado';
});
