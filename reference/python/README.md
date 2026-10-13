# Referencia Python congelada

Estos archivos conservan el comportamiento y el esquema SQLite empleados para comprobar la paridad y probar el migrador con datos sintéticos. No forman parte del runtime TypeScript ni del despliegue actual. Los archivos `Procfile`, `render.yaml` y `docs/` son históricos.

Desde la raíz del repositorio:

```bash
python -m venv /tmp/mascli-reference-venv
/tmp/mascli-reference-venv/bin/pip install -r reference/python/requirements-test.txt
PYTHONPATH=reference/python /tmp/mascli-reference-venv/bin/python -m pytest -q reference/python/tests
```

Las pruebas redirigen los recursos a directorios temporales. No arranques esta referencia sobre datos reales ni copies `data/seed.json` o bases de datos operativas.
