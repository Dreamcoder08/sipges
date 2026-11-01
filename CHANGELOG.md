# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con [SemVer](https://semver.org/lang/es/).

## [1.0.0] - 2026-10-15

Primera versión publicada de SIPGES en TypeScript, desplegada en Vercel desde `main`.

### Plataforma

- Monorepo TypeScript con arquitectura hexagonal: API Hono, SPA React/Vite, contratos Zod compartidos y PostgreSQL con RLS por proyecto (#3, #4, #24).
- Identidad: sesiones, Argon2id, TOTP cifrado, límites de intentos, MFA obligatorio, comprobación de origen y entrada con Google para cuentas invitadas (#5, #12, #35).
- Proyectos y permisos con aislamiento por tenant y exportación por alcance (#7).
- Despliegue gratuito en Vercel con evidencias privadas en Blob (#32, #41).

### Funcionalidad

- 14 módulos de registros con CRUD, auditoría, importación CSV, evidencias, vínculos, historial y vista 360° (#8, #13, #42).
- IRSA, indicadores y analítica estratégica (#9).
- Ontología e inteligencia: búsqueda híbrida, grafo, clasificación, analista y cronología (#42).
- Automatizaciones, notificaciones push e integración por API y MCP (#43).
- Interfaz mobile-first, mapas interactivos con mapa satelital y catastro GEOCATMIN (#37, #45, #46, #47).
- Cada módulo probado de punta a punta en escritorio y teléfono; app más fluida con caché de recursos (#44, #48).
- Tendencia temporal de narrativas por día y categoría; tablas con teléfonos y prioridades en una línea (#49).

### Datos

- Se retiró el caso académico sintético de la base (migración 0019) y del código: solo queda la información real del proyecto (#49).

## Pre-1.0 — Python prototype

Antes de v1.0.0 SIPGES fue un prototipo FastAPI + SQLite (RC 1.3 → 3.0 y v0.4 → v0.5.1). Su historial está resumido en [docs/history/python-prototype.md](docs/history/python-prototype.md); las notas originales se conservan en [`reference/python/history/`](reference/python/history/).

[1.0.0]: https://github.com/Dreamcoder08/sipges/releases/tag/v1.0.0
