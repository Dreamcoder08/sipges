import type {
  ApiKeyOut,
  AuthorizedSourcesCatalog,
  AutomationOverview,
  AutomationRuntimeState,
  ChannelKind,
  GeographyCatalogue,
  MediaMonitorState,
  PushConfig,
} from '@sipges/contracts';
import type { z } from 'zod';
import { describeRule } from '../api.ts';

export type Kind = 'connector' | 'skill' | 'scheduled';
export type Status = 'ok' | 'pause' | 'auth' | 'down' | 'available';

/** Management UI a card opens inside the page; `link` cards open the screen that owns them. */
export type Panel = 'rules' | 'channels' | 'keys' | 'runtime' | 'defensoria' | 'media' | 'info';

export type Entry = {
  id: string;
  kind: Kind;
  direction?: 'Entrante' | 'Saliente';
  name: string;
  description: string;
  /** Integrado ships with SIPGES; Personalizado was created by the team for this project. */
  trust: 'integrated' | 'custom';
  status: Status;
  mine: boolean;
  warning?: string;
  /** Honest qualifier shown next to the type, e.g. a skill that is a built-in screen today. */
  note?: string;
  open: { panel: Panel } | { href: string };
  action: string;
};

export const SYNTHETIC_WARNING = 'Datos sintéticos hasta aprobar política de datos (Ley 29733)';

export const KIND_LABELS: Record<Kind, string> = {
  connector: 'Conector',
  skill: 'Skill',
  scheduled: 'Programada',
};

export const TRUST_LABELS = { integrated: 'Integrado', custom: 'Personalizado' } as const;

export const statusLabel = (entry: Pick<Entry, 'kind' | 'status'>) => {
  if (entry.status === 'available') return 'Disponible';
  if (entry.status === 'auth') return 'Requiere autorización';
  if (entry.status === 'down') return 'No disponible';
  if (entry.kind === 'connector') return entry.status === 'ok' ? 'Conectado' : 'Pausado';
  return entry.status === 'ok' ? 'Activa' : 'Pausada';
};

/** What each configured channel kind is called on a card. */
export const CHANNEL_NAMES: Record<ChannelKind, string> = {
  webhook: 'Webhook firmado',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  gchat: 'Google Chat',
  telegram: 'Telegram',
  email: 'Correo electrónico',
};

const CHANNEL_DESCRIPTIONS: Record<ChannelKind, string> = {
  webhook: 'Envía los avisos de las reglas a un sistema propio, n8n, Zapier o Make, con firma.',
  slack: 'Envía los avisos de las reglas a un canal de Slack.',
  teams: 'Envía los avisos de las reglas a un flujo de Microsoft Teams.',
  discord: 'Envía los avisos de las reglas a un canal de Discord.',
  gchat: 'Envía los avisos de las reglas a un espacio de Google Chat.',
  telegram: 'Envía los avisos de las reglas a un chat o canal de Telegram.',
  email: 'Envía los avisos de las reglas por correo con Resend.',
};

const RULE_TEMPLATES = [
  {
    name: 'Evaluar narrativas registradas',
    description:
      'Plantilla: evalúa cada narrativa nueva o actualizada y deja la señal pendiente de verificación.',
  },
  {
    name: 'Avisar señales de prioridad alta',
    description: 'Plantilla: avisa en la bandeja cuando llega una señal de prioridad alta.',
  },
] as const;

/** The analysis capabilities that exist today; each one is a built-in screen, not a Claude skill. */
const SKILLS = [
  {
    name: 'Informe estratégico',
    href: '/estrategia',
    description:
      'Hallazgos, riesgos y recomendaciones del proyecto a partir de los registros vinculados.',
  },
  {
    name: 'Análisis situacional',
    href: '/situacion',
    description:
      'Resume una situación: actores, demandas, compromisos y qué cambió desde la última revisión.',
  },
  {
    name: 'Lecciones territoriales',
    href: '/lecciones',
    description: 'Lecciones aprendidas del territorio, para preparar reuniones y mesas de diálogo.',
  },
  {
    name: 'Resumen de registro (briefing)',
    href: '/registros',
    description:
      'Briefing de un registro con sus vínculos y fuentes citadas; se abre desde la ficha de cada registro.',
  },
] as const;

/** What each source returned; `undefined` means it is still loading or could not be read. */
export type Sources = {
  overview?: AutomationOverview | undefined;
  media?: MediaMonitorState | undefined;
  defensoria?: z.infer<typeof AuthorizedSourcesCatalog> | undefined;
  geography?: GeographyCatalogue | undefined;
  keys?: readonly ApiKeyOut[] | undefined;
  runtime?: z.infer<typeof AutomationRuntimeState> | undefined;
  push?: PushConfig | undefined;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const connectors = ({ media, defensoria, geography, keys, push, overview }: Sources): Entry[] => {
  const entries: Entry[] = [];
  if (media) {
    const active = media.feeds.filter((feed) => feed.enabled).length;
    const failing = media.feeds.filter((feed) => feed.last_poll_error).length;
    const mine = media.feeds.length > 0;
    entries.push({
      id: 'media',
      kind: 'connector',
      direction: 'Entrante',
      name: 'Medios RSS',
      description:
        'Lee feeds RSS o Atom públicos de medios y crea narrativas pendientes de verificación.' +
        (mine
          ? ` ${plural(media.feeds.length, 'fuente configurada', 'fuentes configuradas')}` +
            (failing
              ? `, ${plural(failing, 'con error de lectura', 'con error de lectura')}.`
              : '.')
          : ''),
      trust: 'integrated',
      status: !mine ? 'available' : active > 0 ? 'ok' : 'pause',
      mine,
      open: { panel: 'media' },
      action: mine ? 'Gestionar' : 'Añadir',
    });
  }
  if (defensoria) {
    const { state } = defensoria;
    const mine = state.enabled || state.updated_at !== null;
    entries.push({
      id: 'defensoria',
      kind: 'connector',
      direction: 'Entrante',
      name: 'Defensoría del Pueblo',
      description:
        'Publicaciones oficiales de conflictos sociales, con nota de autorización; se importan como narrativas pendientes.' +
        (state.last_poll_error ? ` Último error: ${state.last_poll_error}` : ''),
      trust: 'integrated',
      status: !mine ? 'available' : state.enabled ? 'ok' : 'pause',
      mine,
      open: { panel: 'defensoria' },
      action: mine ? 'Gestionar' : 'Añadir',
    });
  }
  if (geography) {
    entries.push({
      id: 'geocatmin',
      kind: 'connector',
      direction: 'Entrante',
      name: 'GEOCATMIN INGEMMET',
      description:
        'Servicios públicos de concesiones mineras para el mapa territorial y la superposición con el territorio.',
      trust: 'integrated',
      status: geography.status === 'verified' ? 'ok' : 'down',
      mine: true,
      open: { href: '/mapa' },
      action: 'Abrir mapa',
    });
  }
  if (keys) {
    const live = keys.filter((key) => !key.revoked_at);
    const writers = live.filter((key) => key.access === 'write');
    entries.push({
      id: 'mcp',
      kind: 'connector',
      direction: 'Saliente',
      name: 'Claude vía MCP',
      description:
        'Servidor MCP de SIPGES: Claude y otros agentes consultan registros, vínculos y briefings con una clave de API del proyecto.' +
        (live.length ? ` ${plural(live.length, 'clave activa', 'claves activas')}.` : ''),
      trust: 'integrated',
      status: live.length ? 'ok' : 'auth',
      mine: true,
      warning: SYNTHETIC_WARNING,
      open: { panel: 'keys' },
      action: live.length ? 'Gestionar' : 'Autorizar',
    });
    entries.push({
      id: 'ingest',
      kind: 'connector',
      direction: 'Entrante',
      name: 'Webhook de ingesta',
      description:
        'Sistemas externos (n8n, Zapier, Make) envían registros a SIPGES con una clave de escritura.' +
        (writers.length
          ? ` ${plural(writers.length, 'clave de escritura', 'claves de escritura')}.`
          : ''),
      trust: 'custom',
      status: writers.length ? 'ok' : 'available',
      mine: writers.length > 0,
      open: { panel: 'keys' },
      action: writers.length ? 'Gestionar' : 'Añadir',
    });
  }
  if (overview) {
    for (const channel of overview.channels) {
      entries.push({
        id: `channel-${channel.id}`,
        kind: 'connector',
        direction: 'Saliente',
        name: channel.name,
        description: `${CHANNEL_NAMES[channel.kind]} · ${channel.target_hint}. Recibe los avisos de las reglas.`,
        trust: 'custom',
        status: 'ok',
        mine: true,
        open: { panel: 'channels' },
        action: 'Gestionar',
      });
    }
    for (const kind of Object.keys(CHANNEL_NAMES) as ChannelKind[]) {
      if (overview.channels.some((channel) => channel.kind === kind)) continue;
      entries.push({
        id: `channel-kind-${kind}`,
        kind: 'connector',
        direction: 'Saliente',
        name: CHANNEL_NAMES[kind],
        description: CHANNEL_DESCRIPTIONS[kind],
        trust: 'integrated',
        status: 'available',
        mine: false,
        open: { panel: 'channels' },
        action: 'Añadir',
      });
    }
  }
  if (push) {
    entries.push({
      id: 'push',
      kind: 'connector',
      direction: 'Saliente',
      name: 'Notificaciones push',
      description: push.enabled
        ? 'Avisos al dispositivo de quien los activó en Configuración › Notificaciones.'
        : 'Avisos al dispositivo; no están configurados en este servidor.',
      trust: 'integrated',
      status: push.enabled ? 'ok' : 'pause',
      mine: true,
      open: { panel: 'info' },
      action: 'Ver detalle',
    });
  }
  return entries;
};

const skills = (): Entry[] =>
  SKILLS.map((skill) => ({
    id: `skill-${skill.href}`,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    trust: 'integrated',
    status: 'ok',
    mine: true,
    note: 'Pantalla integrada',
    open: { href: skill.href },
    action: 'Abrir',
  }));

const scheduled = ({ overview, runtime }: Sources): Entry[] => {
  const entries: Entry[] = [];
  if (overview) {
    for (const rule of overview.rules) {
      entries.push({
        id: `rule-${rule.id}`,
        kind: 'scheduled',
        name: rule.name,
        description: describeRule(rule, overview),
        trust: 'custom',
        status: rule.enabled ? 'ok' : 'pause',
        mine: true,
        open: { panel: 'rules' },
        action: 'Gestionar',
      });
    }
    for (const template of RULE_TEMPLATES) {
      if (overview.rules.some((rule) => rule.name === template.name)) continue;
      entries.push({
        id: `template-${template.name}`,
        kind: 'scheduled',
        name: template.name,
        description: template.description,
        trust: 'integrated',
        status: 'available',
        mine: false,
        open: { panel: 'rules' },
        action: 'Añadir',
      });
    }
  }
  if (runtime) {
    entries.push({
      id: 'runtime',
      kind: 'scheduled',
      name: 'Procesamiento de reglas',
      description:
        runtime.cron_configured && runtime.cron_schedule
          ? `Reglas al guardar registros y revisión de respaldo ${runtime.cron_schedule} (UTC).`
          : 'Reglas al guardar registros; sin programador diario verificado en este servidor.',
      trust: 'integrated',
      status: runtime.event_processing ? 'ok' : 'pause',
      mine: true,
      open: { panel: 'runtime' },
      action: 'Ver estado',
    });
  }
  return entries;
};

/** Every card the page can show, from what the existing APIs return. */
export const buildCatalog = (sources: Sources): Entry[] => [
  ...connectors(sources),
  ...skills(),
  ...scheduled(sources),
];

export const SECTIONS = [
  {
    kind: 'connector',
    direction: 'Entrante',
    title: 'Conectores entrantes',
    sub: 'traen datos a SIPGES',
  },
  {
    kind: 'connector',
    direction: 'Saliente',
    title: 'Conectores salientes',
    sub: 'sacan datos o avisos',
  },
  { kind: 'skill', title: 'Skills', sub: 'capacidades de análisis sobre tus registros' },
  { kind: 'scheduled', title: 'Programadas', sub: 'automatizaciones existentes' },
] as const satisfies readonly {
  kind: Kind;
  direction?: 'Entrante' | 'Saliente';
  title: string;
  sub: string;
}[];

export const FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'connector', label: 'Conectores' },
  { value: 'skill', label: 'Skills' },
  { value: 'scheduled', label: 'Programadas' },
] as const;

export type Filter = (typeof FILTERS)[number]['value'];
