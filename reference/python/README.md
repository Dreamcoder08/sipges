# Referencia Python congelada

Estos archivos conservan el comportamiento y el esquema SQLite empleados para comprobar la paridad y probar el migrador con datos sintéticos. No forman parte del runtime TypeScript ni del despliegue actual. Los archivos `Procfile`, `render.yaml` y `docs/` son históricos.

Desde la raíz del repositorio:

```bash
python -m venv /tmp/sipges-reference-venv
/tmp/sipges-reference-venv/bin/pip install -r reference/python/requirements-test.txt
PYTHONPATH=reference/python /tmp/sipges-reference-venv/bin/python -m pytest -q reference/python/tests
```

Las pruebas redirigen los recursos a directorios temporales. No arranques esta referencia sobre datos reales ni copies `data/seed.json` o bases de datos operativas.

## Lanzadores locales

Los lanzadores `start_sipges.sh`, `start_sipges.bat`, `iniciar_sipges_final.sh` e `INICIAR_SIPGES_FINAL.bat` arrancan `app:app` con uvicorn en `127.0.0.1:8000`; se ejecutan desde este directorio y asignan `SIPGES_COOKIE_SECURE=0` solo si la variable está ausente ([cookies seguras](../../docs/secure-cookies.md)).

## Historial del prototipo

Notas de versión, resultados de prueba y especificaciones del prototipo (RC 1.7 → 3.0, v0.4 → v0.5.1) están en [`history/`](history/) y [`docs/`](docs/). Resumen en [docs/history/python-prototype.md](../../docs/history/python-prototype.md).
